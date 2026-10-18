// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/import-sandbox.ts — import de fichiers et dossiers dans le bac : pré-contrôle d'espace, lots multipart, gros fichiers par morceaux, progression annulable, imports en file. */
import { ref } from "vue";

import type { GestionnaireSession } from "../auth/session";
import { envoyerXhr } from "../../platform/http/xhr";
import type { ControleXhr, ReponseXhr } from "../../platform/http/xhr";
import { depotDejaTraite } from "../../utils/depot";
import { cheminsGlisses } from "./arbre";
import type { FetchAuth } from "./etat";
import { brancherImporteur } from "./importeur";

export interface ProgressionImport {
  active: boolean;
  phase: "prepare" | "upload";
  pct: number;
  files_done: number;
  total_files: number;
  current_file: string;
  skipped: number;
}

interface FichierChemin {
  file: File;
  path: string;
}

interface ElementImport {
  file: File;
  rel: string;
}

interface ControleImport extends ControleXhr {
  id: string;
  cancelled: boolean;
  xhr: XMLHttpRequest | null;
  fetchAbort: AbortController | null;
}

type ListeImport = readonly File[] | readonly FichierChemin[];

/** Ce que l'import lit de l'éditeur, absent tant qu'il n'est pas monté. */
export interface EditeurImport {
  loadSandboxFiles?(): unknown;
  checkExternalModsSoon?(delai: number): unknown;
  moveItem(source: string, dossier: string): unknown;
}

export interface DependancesImport {
  readonly session: GestionnaireSession;
  readonly fetchAuth: FetchAuth;
  showToast(message: string, type?: string): void;
  handleSessionExpired(): void;
  editeur(): EditeurImport | null;
}

const MORCEAU = 8 * 1024 * 1024;
const LOT_OCTETS = 12 * 1024 * 1024;
const LOT_FICHIERS = 40;
const PETIT_MAX = 8 * 1024 * 1024;
// Même borne que le serveur (pré-contrôle) : au-delà, seule la taille totale part.
const PRECONTROLE_MAX = 20000;

const nombre = (v: unknown): number => Number(v) || 0;

/** « 12,4 Go » pour les messages de refus du pré-contrôle. */
export function formaterOctets(n: unknown): string {
  const v = Math.max(0, Number(n) || 0);
  const unites: readonly [number, string][] = [
    [1073741824, "Go"],
    [1048576, "Mo"],
    [1024, "Ko"],
  ];
  for (const [taille, nom] of unites) {
    if (v >= taille) return (v / taille).toFixed(1).replace(".", ",").replace(/,0$/, "") + " " + nom;
  }
  return String(v) + " o";
}

const progressionVide = (): ProgressionImport => ({
  active: false,
  phase: "upload",
  pct: 0,
  files_done: 0,
  total_files: 0,
  current_file: "",
  skipped: 0,
});

function estListeChemins(liste: ListeImport): liste is readonly FichierChemin[] {
  const premier = liste[0] as FichierChemin | File | undefined;
  return !!premier && "file" in premier && premier.file instanceof Blob;
}

export function creerImportSandbox(dep: DependancesImport) {
  const explorerDragOver = ref(false);
  const uploadProgress = ref<ProgressionImport>(progressionVide());
  let minuterieSortie: ReturnType<typeof setTimeout> | null = null;
  let enCours: ControleImport | null = null;
  let epoque = 0;
  let file: Promise<unknown> = Promise.resolve();
  let sequenceMasquage = 0;

  const maj = (p: Partial<ProgressionImport>): void => {
    uploadProgress.value = { ...uploadProgress.value, ...p };
  };

  function onExplorerDragOver(): void {
    explorerDragOver.value = true;
    if (minuterieSortie) {
      clearTimeout(minuterieSortie);
      minuterieSortie = null;
    }
  }

  function onExplorerDragLeave(): void {
    minuterieSortie = setTimeout(() => {
      explorerDragOver.value = false;
    }, 100);
  }

  /** Annule l'import en cours et ceux en file ; les fichiers déjà écrits restent. */
  function cancelSandboxUpload(): void {
    epoque++;
    const ctl = enCours;
    if (!ctl || ctl.cancelled) return;
    ctl.cancelled = true;
    try {
      ctl.xhr?.abort();
    } catch {
      /* envoi déjà fini */
    }
    try {
      ctl.fetchAbort?.abort();
    } catch {
      /* pré-contrôle déjà fini */
    }
  }

  // Supprime le `.part` d'un fichier interrompu, une seconde fois 2,5 s plus tard (morceau traité après l'abandon).
  function supprimerMorceaux(rel: string, id: string): void {
    const url =
      "/api/sandbox/upload-chunk?path=" + encodeURIComponent(rel) + "&upload_id=" + encodeURIComponent(id);
    const go = (): void => void dep.fetchAuth(url, { method: "DELETE" }, true);
    go();
    setTimeout(go, 2500);
  }

  const envoyer = (
    url: string,
    corps: XMLHttpRequestBodyInit,
    progression: (charge: number) => void,
    ctl: ControleImport,
  ): Promise<ReponseXhr> => envoyerXhr(dep.session, url, corps, progression, ctl);

  async function envoyerParMorceaux(
    url: string,
    fichier: File,
    rel: string,
    progression: (fait: number) => void,
    ctl: ControleImport,
  ): Promise<ReponseXhr> {
    const taille = fichier.size || 0;
    const total = Math.max(1, Math.ceil(taille / MORCEAU));
    for (let idx = 0; idx < total; idx++) {
      const debut = idx * MORCEAU;
      const fin = Math.min(debut + MORCEAU, taille);
      const cible =
        url +
        "?path=" +
        encodeURIComponent(rel) +
        "&index=" +
        String(idx) +
        "&total=" +
        String(total) +
        "&size=" +
        String(taille) +
        "&upload_id=" +
        encodeURIComponent(ctl.id);
      const r = await envoyer(cible, fichier.slice(debut, fin), (charge) => progression(debut + charge), ctl);
      if (!r.ok) {
        if (r.status !== 401) supprimerMorceaux(rel, ctl.id);
        return r;
      }
    }
    return { ok: true, status: 200, data: { done: true } };
  }

  /** Pré-contrôle d'espace : tout l'import ou rien ; route absente ou injoignable = accepté (le serveur reste l'autorité). */
  async function preControler(
    items: readonly ElementImport[],
    totalOctets: number,
    ctl: ControleImport,
  ): Promise<{ fits: boolean; message?: string }> {
    const corps = {
      total_bytes: totalOctets,
      files:
        items.length <= PRECONTROLE_MAX ? items.map((it) => ({ path: it.rel, size: it.file.size || 0 })) : [],
    };
    ctl.fetchAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    let res: Response | null;
    try {
      res = await dep.fetchAuth(
        "/api/sandbox/upload-precheck",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(corps),
          signal: ctl.fetchAbort?.signal,
        },
        true,
      );
    } catch {
      res = null;
    }
    ctl.fetchAbort = null;
    if (!res?.ok) return { fits: true };
    let d: Record<string, unknown>;
    try {
      const brut: unknown = await res.json();
      if (!brut || typeof brut !== "object") return { fits: true };
      d = brut as Record<string, unknown>;
    } catch {
      return { fits: true };
    }
    if (d["fits"] !== false) return { fits: true };
    const borne =
      d["reason"] === "remaining"
        ? "espace restant " + formaterOctets(d["allowed_bytes"])
        : "limite d'un import " + formaterOctets(d["allowed_bytes"]) + " (" + String(d["max_pct"]) + " %)";
    return {
      fits: false,
      message: "Import impossible : " + formaterOctets(d["needed_bytes"]) + " à importer, " + borne,
    };
  }

  function masquerBarre(delaiMs: number): void {
    const seq = ++sequenceMasquage;
    const masquer = (): void => {
      if (seq !== sequenceMasquage) return;
      maj({ active: false });
    };
    if (!delaiMs) masquer();
    else setTimeout(masquer, delaiMs);
  }

  // Les imports sont sérialisés : deux dépôts simultanés ne se partagent pas la barre de progression.
  function enFile(preparer: (ctl: ControleImport) => ListeImport | Promise<ListeImport>, dossier: string) {
    const ep = epoque;
    const run = file.then(() => {
      if (ep !== epoque) return undefined;
      return executer(preparer, dossier);
    });
    file = run.catch(() => undefined);
    return run;
  }

  function uploadFilesToSandbox(entree: FileList | readonly File[] | null | undefined, dossier: string) {
    if (!entree) return Promise.resolve();
    // Copie immédiate : le clic suivant sur « Importer » vide la FileList de l'<input>.
    const copie = Array.from(entree);
    if (copie.length === 0) return Promise.resolve();
    return enFile(() => copie, dossier);
  }

  function uploadDroppedEntries(entrees: readonly FileSystemEntry[] | null | undefined, dossier: string) {
    const liste = Array.from(entrees ?? []);
    if (liste.length === 0) return Promise.resolve();
    return enFile((ctl) => collecterEntrees(liste, ctl), dossier);
  }

  async function executer(
    preparer: (ctl: ControleImport) => ListeImport | Promise<ListeImport>,
    dossier: string,
  ): Promise<void> {
    const ctl: ControleImport = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      cancelled: false,
      xhr: null,
      fetchAbort: null,
    };
    enCours = ctl;
    ++sequenceMasquage;
    uploadProgress.value = { ...progressionVide(), active: true, phase: "prepare", current_file: "Analyse" };
    try {
      const liste = await preparer(ctl);
      if (ctl.cancelled) {
        masquerBarre(0);
        dep.showToast("Import annulé", "info");
        return;
      }
      await importer(liste, dossier, ctl);
    } finally {
      if (enCours === ctl) enCours = null;
    }
  }

  function rafraichirEditeur(): void {
    const ed = dep.editeur();
    if (ed?.loadSandboxFiles) void ed.loadSandboxFiles();
    if (ed?.checkExternalModsSoon) void ed.checkExternalModsSoon(0);
  }

  async function importer(liste: ListeImport, dossier: string, ctl: ControleImport): Promise<void> {
    if (liste.length === 0) {
      masquerBarre(0);
      return;
    }
    const items: ElementImport[] = estListeChemins(liste)
      ? liste.map((x) => ({ file: x.file, rel: (dossier ? dossier + "/" : "") + (x.path || x.file.name) }))
      : liste.map((f) => ({
          file: f,
          rel: (dossier ? dossier + "/" : "") + (f.webkitRelativePath || f.name),
        }));

    let totalOctets = 0;
    const petits: ElementImport[] = [];
    const gros: ElementImport[] = [];
    for (const it of items) {
      const t = it.file.size || 0;
      totalOctets += t;
      (t > PETIT_MAX ? gros : petits).push(it);
    }

    maj({ phase: "prepare", total_files: items.length, current_file: "Vérification de l'espace" });
    const pre = await preControler(items, totalOctets, ctl);
    if (ctl.cancelled) {
      masquerBarre(0);
      dep.showToast("Import annulé", "info");
      return;
    }
    if (!pre.fits) {
      masquerBarre(0);
      dep.showToast(pre.message ?? "Import impossible", "error");
      return;
    }

    uploadProgress.value = { ...progressionVide(), active: true, phase: "upload", total_files: items.length };
    let octetsAvant = 0;
    let enregistres = 0;
    let ignores = 0;
    let sans401 = true;
    let quota = false;
    const pourcentage = (fait: number): void => {
      if (totalOctets <= 0) return;
      maj({ pct: Math.min(99, Math.round((fait / totalOctets) * 100)) });
    };
    const compteurs = (): void =>
      maj({
        files_done: Math.min(enregistres + ignores, items.length),
        skipped: ignores,
        pct: totalOctets > 0 ? Math.min(99, Math.round((octetsAvant / totalOctets) * 100)) : 99,
      });
    const arret = (): boolean => !sans401 || quota || ctl.cancelled;

    const lots: ElementImport[][] = [];
    let courant: ElementImport[] = [];
    let octetsCourant = 0;
    for (const it of petits) {
      const t = it.file.size || 0;
      if (courant.length && (octetsCourant + t > LOT_OCTETS || courant.length >= LOT_FICHIERS)) {
        lots.push(courant);
        courant = [];
        octetsCourant = 0;
      }
      courant.push(it);
      octetsCourant += t;
    }
    if (courant.length) lots.push(courant);

    for (const lot of lots) {
      if (arret()) break;
      const fd = new FormData();
      let octetsLot = 0;
      for (const it of lot) {
        fd.append("files", it.file);
        fd.append("paths", it.rel);
        octetsLot += it.file.size || 0;
      }
      maj({ current_file: lot[0]?.rel ?? "" });
      const avant = octetsAvant;
      const r = await envoyer(
        "/api/sandbox/upload",
        fd,
        (charge) => pourcentage(avant + Math.min(charge, octetsLot)),
        ctl,
      );
      if (r.aborted) break;
      octetsAvant += octetsLot;
      if (r.status === 401) {
        sans401 = false;
        break;
      }
      const data = r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : null;
      if (r.ok && data) {
        enregistres += nombre(data["saved"]);
        const sautes = Array.isArray(data["skipped"]) ? (data["skipped"] as unknown[]) : [];
        ignores += sautes.length;
        // Quota plein sur un lot : 200 avec les refus dans `skipped`, les lots suivants ne partent plus.
        if (sautes.some((x) => !!x && (x as { reason?: unknown }).reason === "quota_exceeded")) quota = true;
      } else {
        ignores += lot.length;
      }
      compteurs();
    }

    for (const g of gros) {
      if (arret()) break;
      const octets = g.file.size || 0;
      maj({ current_file: g.rel });
      const avant = octetsAvant;
      const r = await envoyerParMorceaux(
        "/api/sandbox/upload-chunk",
        g.file,
        g.rel,
        (fait) => pourcentage(avant + fait),
        ctl,
      );
      if (r.aborted) break;
      octetsAvant += octets;
      if (r.status === 401) {
        sans401 = false;
        break;
      }
      if (r.ok) enregistres += 1;
      else {
        ignores += 1;
        if (r.status === 413) quota = true;
      }
      compteurs();
    }

    if (!sans401) {
      masquerBarre(0);
      dep.handleSessionExpired();
      return;
    }
    if (ctl.cancelled) {
      masquerBarre(0);
      rafraichirEditeur();
      dep.showToast("Import annulé — " + String(enregistres) + " fichier(s) déjà importé(s)", "info");
      return;
    }
    maj({ pct: 100 });
    masquerBarre(600);
    rafraichirEditeur();
    if (enregistres === 0) {
      dep.showToast(
        quota ? "Quota sandbox dépassé — import refusé" : "Échec de l'import (0 fichier)",
        "error",
      );
    } else if (ignores > 0 || quota) {
      const nonEnvoyes = items.length - enregistres - ignores;
      dep.showToast(
        String(enregistres) +
          " fichier(s) importé(s), " +
          String(ignores + Math.max(0, nonEnvoyes)) +
          " ignoré(s)" +
          (quota ? " (quota dépassé)" : ""),
        "error",
      );
    } else {
      dep.showToast(String(enregistres) + " fichier(s) importé(s)");
    }
  }

  /** Parcours récursif des entrées déposées (l'arborescence est gardée) ; un import annulé l'arrête. */
  function collecterEntrees(
    entrees: readonly FileSystemEntry[],
    ctl: ControleImport,
  ): Promise<FichierChemin[]> {
    const out: FichierChemin[] = [];
    let dernierAffiche = 0;
    const afficher = (): void => {
      if (out.length - dernierAffiche < 50) return;
      dernierAffiche = out.length;
      maj({ total_files: out.length });
    };
    const lire = (entree: FileSystemEntry, prefixe: string): Promise<void> =>
      new Promise((resolve) => {
        if (ctl.cancelled) {
          resolve();
          return;
        }
        if (entree.isFile) {
          (entree as FileSystemFileEntry).file(
            (f) => {
              out.push({ file: f, path: prefixe + entree.name });
              afficher();
              resolve();
            },
            () => resolve(),
          );
        } else if (entree.isDirectory) {
          const lecteur = (entree as FileSystemDirectoryEntry).createReader();
          let enfants: FileSystemEntry[] = [];
          const lot = (): void => {
            if (ctl.cancelled) {
              resolve();
              return;
            }
            lecteur.readEntries(
              (paquet) => {
                if (!paquet.length) {
                  void Promise.all(enfants.map((c) => lire(c, prefixe + entree.name + "/"))).then(() =>
                    resolve(),
                  );
                  return;
                }
                enfants = enfants.concat(paquet);
                lot();
              },
              () => resolve(),
            );
          };
          lot();
        } else resolve();
      });
    return Promise.all(entrees.map((e) => lire(e, ""))).then(() => out);
  }

  /** Dépôt sur le fond de l'explorateur : dossiers du bureau, fichiers plats, ou chemins internes ramenés à la racine. */
  function handleExplorerDrop(event: DragEvent): void {
    explorerDragOver.value = false;
    if (depotDejaTraite(200)) return;
    const dt = event.dataTransfer;
    if (!dt) return;
    // Entrées lues tout de suite : le DataTransfer est invalidé au retour du gestionnaire.
    const entrees: FileSystemEntry[] = [];
    if (dt.items?.length && typeof DataTransferItem !== "undefined") {
      for (const it of dt.items) {
        if (it.kind !== "file") continue;
        const e = it.webkitGetAsEntry?.();
        if (e) entrees.push(e);
      }
    }
    if (entrees.length) {
      void uploadDroppedEntries(entrees, "");
      return;
    }
    if (dt.files?.length) {
      void uploadFilesToSandbox(dt.files, "");
      return;
    }
    const ed = dep.editeur();
    for (const p of cheminsGlisses(dt)) if (p && p.indexOf("/") > 0) void ed?.moveItem(p, "");
  }

  function finDeGlisser(): void {
    explorerDragOver.value = false;
  }

  brancherImporteur({ fichiers: uploadFilesToSandbox, entrees: uploadDroppedEntries });

  return {
    explorerDragOver,
    uploadProgress,
    onExplorerDragOver,
    onExplorerDragLeave,
    cancelSandboxUpload,
    uploadFilesToSandbox,
    handleExplorerDrop,
    finDeGlisser,
  };
}

export type ImportSandbox = ReturnType<typeof creerImportSandbox>;
