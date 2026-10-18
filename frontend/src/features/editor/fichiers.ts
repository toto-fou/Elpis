// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/fichiers.ts — fichiers du bac pour l'explorateur de l'éditeur : arbre, quota, création, renommage, déplacement, suppression, recherche, remplacement, import et instantanés (porté de `editor/_sandbox_fs.js`). */
import { computed, ref, watch } from "vue";
import type { Ref } from "vue";

import { lireNdjson } from "../../platform/streams/ndjson";
import { arbre as arbreDeLaPage } from "./arbre";
import { importeur } from "./importeur";
import {
  detailErreur,
  lireJson,
  schemaArbre,
  schemaEvenementInstantane,
  schemaGrep,
  schemaInstantanes,
  schemaQuota,
  schemaRechercheNoms,
  schemaRemplacement,
} from "./schemas-bac";
import type { EvenementInstantane, InstantaneBac, NoeudArbre } from "./schemas-bac";

type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;
type Toast = (message: string, type?: string) => void;
interface Choix {
  id: string;
  label: string;
  tone: string;
}

export interface CtxFichiers {
  showToast: Toast;
  fetchAuth: FetchAuth;
  openConfirm(
    titre: string,
    texte: string,
    danger?: boolean,
    ok?: string,
    annuler?: string,
  ): Promise<boolean>;
  openPrompt(titre: string, valeur: string, indice?: string): Promise<string | null | undefined>;
  openChoice?: (titre: string, texte: string, choix: Choix[]) => Promise<string | null | undefined>;
}

interface EditeurMonaco {
  revealPositionInCenter(p: { lineNumber: number; column: number }): void;
  setPosition(p: { lineNumber: number; column: number }): void;
  focus(): void;
}

export interface Onglet {
  path: string;
  name: string;
  [cle: string]: unknown;
}

export interface RefsFichiers {
  sandboxFiles: Ref<NoeudArbre[]>;
  sandboxQuota: Ref<unknown>;
  isLoadingFiles: Ref<boolean>;
  sandboxSearch: Ref<string>;
  sandboxSearchMode: Ref<string>;
  sandboxSearchResults: Ref<ResultatRecherche[]>;
  isSearchingSandbox: Ref<boolean>;
  sandboxFileInput: Ref<HTMLInputElement | null>;
  sandboxFolderInput: Ref<HTMLInputElement | null>;
  showImportMenu: Ref<boolean>;
  openTabs: Ref<Onglet[]>;
  activeTabPath: Ref<string | null>;
  editorFilePath?: Ref<string | null>;
  models: Record<string, unknown>;
  originalFileContent: Record<string, string | undefined>;
  monacoRef: { instance: EditeurMonaco | null };
  showHiddenFiles?: Ref<boolean>;
}

export interface RappelsFichiers {
  _sbUrl?: (e: string) => string;
  openFile?: (path: string, force?: boolean) => Promise<unknown>;
  closeTab?: (path: string, ev: unknown, force?: boolean) => Promise<unknown> | unknown;
  _migrateModel?: (de: string, vers: string) => void;
  _gitAutoRefresh?: () => void;
  isSpecialPath?: (path: string) => boolean;
  isPathDirty?: (path: string) => boolean;
  onFilesReplaced?: (paths: string[]) => Promise<unknown> | unknown;
  setBaseMtime?: (path: string, mtime: number) => void;
  onPathsMoved?: (de: string, vers: string) => void;
  beforeJump?: () => void;
}

export interface ResultatRecherche {
  path: string;
  line?: number | null;
  col?: number | null;
  pre?: string;
  hit?: string;
  post?: string;
  type?: string;
  name?: string;
  [cle: string]: unknown;
}

interface ApercuRemplacement {
  total: number | undefined;
  truncated: boolean;
  files: Array<{
    path: string;
    count: number;
    dirty: boolean;
    on: boolean;
    samples?: Array<{ line: number; before: string; after: string }>;
    [cle: string]: unknown;
  }>;
}

interface Progression {
  pct: number;
  files_done: number;
  total_files: number;
  bytes_done: number;
  total_bytes: number;
  current_file: string;
  phase: string;
}

const PROGRESSION_VIDE: Progression = {
  pct: 0,
  files_done: 0,
  total_files: 0,
  bytes_done: 0,
  total_bytes: 0,
  current_file: "",
  phase: "",
};

const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } } as const;

function sansErreur(fn: () => unknown): void {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch(() => undefined);
  } catch {
    /* rappel de l'éditeur : son échec n'interrompt pas l'opération de fichiers */
  }
}

/** Explorateur du bac : arbre, quota, fichiers et dossiers (création, renommage, suppression, téléchargement, déplacement). */
export function setupEditorSandboxFs(refs: RefsFichiers, ctx: CtxFichiers, rappels: RappelsFichiers = {}) {
  const {
    sandboxFiles,
    sandboxQuota,
    isLoadingFiles,
    sandboxSearch,
    sandboxSearchMode,
    sandboxSearchResults,
    isSearchingSandbox,
    sandboxFileInput,
    sandboxFolderInput,
    showImportMenu,
    openTabs,
    activeTabPath,
    models,
    originalFileContent,
    monacoRef,
    showHiddenFiles,
  } = refs;
  const { showToast, fetchAuth, openConfirm, openPrompt } = ctx;
  const sbUrl = rappels._sbUrl ?? ((e: string) => "/api/sandbox/" + e);
  const openFile = rappels.openFile ?? (() => Promise.resolve());
  const closeTab = rappels.closeTab ?? (() => undefined);
  const migrateModel = rappels._migrateModel ?? (() => undefined);
  const gitAutoRefresh = rappels._gitAutoRefresh ?? (() => undefined);
  const isSpecialPath = rappels.isSpecialPath ?? (() => false);
  const isPathDirty = rappels.isPathDirty ?? (() => false);
  const onFilesReplaced = rappels.onFilesReplaced ?? (() => undefined);
  const onPathsMoved = rappels.onPathsMoved ?? (() => undefined);
  const arbre = arbreDeLaPage;
  const cache = (): boolean => !!showHiddenFiles?.value;

  function parcourir(visiter: (n: NoeudArbre) => boolean | void, depuis = sandboxFiles.value): void {
    const pile = [...depuis].reverse();
    while (pile.length) {
      const n = pile.pop();
      if (!n) continue;
      const descendre = visiter(n);
      if (descendre === true && n.children) pile.push(...[...n.children].reverse());
    }
  }

  function filesUnder(path: string): string[] {
    const out: string[] = [];
    parcourir((n) => {
      if (n.path === path || n.path.startsWith(path + "/")) {
        if (n.type === "file") out.push(n.path);
        return true;
      }
      return n.type === "folder" && path.startsWith(n.path + "/");
    });
    return out;
  }

  function trouver(path: string): NoeudArbre | null {
    let trouve: NoeudArbre | null = null;
    parcourir((n) => {
      if (trouve) return false;
      if (n.path === path) {
        trouve = n;
        return false;
      }
      return n.type === "folder" && path.startsWith(n.path + "/");
    });
    return trouve;
  }

  // ==============================================================
  //  Arbre et quota
  // ==============================================================

  const treeTruncated: Ref<{ max: number } | null> = ref(null);

  // Appels concurrents fusionnés : un chargement en vol et au plus un rechargement final.
  let arbreEnVol: Promise<void> | null = null;
  let arbreEncore = false;
  function loadSandboxFiles(): Promise<void> {
    if (arbreEnVol) {
      arbreEncore = true;
      return arbreEnVol;
    }
    arbreEnVol = (async () => {
      try {
        do {
          arbreEncore = false;
          await chargerArbreUneFois();
        } while (arbreEncore);
      } finally {
        arbreEnVol = null;
      }
    })();
    return arbreEnVol;
  }

  async function chargerArbreUneFois(): Promise<void> {
    isLoadingFiles.value = true;
    try {
      const url = cache() ? sbUrl("tree") + "?include_hidden=1" : sbUrl("tree");
      const res = await fetchAuth(url, {}, true);
      if (res && res.ok) {
        const data = await lireJson(res, schemaArbre);
        if (data) {
          sandboxFiles.value = data.items ?? [];
          treeTruncated.value = data.truncated ? { max: data.max_entries ?? 0 } : null;
        }
      }
    } catch {
      /* arbre gardé tel quel */
    } finally {
      isLoadingFiles.value = false;
    }
    scheduleQuotaRefresh();
  }

  function toggleHiddenFiles(): void {
    if (!showHiddenFiles) return;
    showHiddenFiles.value = !showHiddenFiles.value;
    try {
      localStorage.setItem("elpis.showHiddenFiles", showHiddenFiles.value ? "1" : "0");
    } catch {
      /* stockage indisponible */
    }
    void loadSandboxFiles();
  }

  let minuterieQuota: ReturnType<typeof setTimeout> | null = null;
  async function loadSandboxQuota(): Promise<void> {
    try {
      const res = await fetchAuth(sbUrl("quota"), {}, true);
      if (res && res.ok) {
        const q = await lireJson(res, schemaQuota);
        if (q) sandboxQuota.value = q;
      }
    } catch {
      /* quota gardé tel quel */
    }
  }

  /** Rafraîchissement du quota après une opération (600 ms, appels rapprochés fondus). */
  function scheduleQuotaRefresh(): void {
    if (minuterieQuota) clearTimeout(minuterieQuota);
    minuterieQuota = setTimeout(() => {
      minuterieQuota = null;
      void loadSandboxQuota();
    }, 600);
  }

  // ==============================================================
  //  Opérations sur les fichiers
  // ==============================================================

  async function downloadFile(path: string): Promise<void> {
    const cibles = arbre().targetsFor(path);
    if (cibles.length <= 1) {
      window.open(sbUrl("download?path=") + encodeURIComponent(path), "_blank");
      return;
    }
    const files: string[] = [];
    cibles.forEach((p) =>
      filesUnder(p).forEach((f) => {
        if (!files.includes(f)) files.push(f);
      }),
    );
    if (!files.length) {
      showToast("Rien à télécharger", "error");
      return;
    }
    try {
      const res = await fetchAuth(sbUrl("download-multi"), {
        ...JSON_POST,
        body: JSON.stringify({ paths: files }),
      });
      if (!res || !res.ok) {
        showToast(await detailErreur(res, "Téléchargement impossible"), "error");
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "sandbox-" + files.length + "-fichiers.zip";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  async function demanderNom(parent: unknown, quoi: "dossier" | "fichier"): Promise<string | null> {
    const p = typeof parent === "string" ? parent : "";
    const label = p
      ? `Nouveau ${quoi} dans ${p}/`
      : quoi === "dossier"
        ? "Nouveau dossier"
        : "Nouveau fichier";
    const indice = p ? `nom du ${quoi}` : quoi === "dossier" ? "ex: src/utils" : "ex: main.py";
    const name = await openPrompt(label, "", indice);
    if (!name || !name.trim()) return null;
    return p ? p + "/" + name.trim() : name.trim();
  }

  async function createFolder(parentPath?: unknown): Promise<void> {
    const fullPath = await demanderNom(parentPath, "dossier");
    if (!fullPath) return;
    try {
      const res = await fetchAuth(sbUrl("mkdir"), { ...JSON_POST, body: JSON.stringify({ path: fullPath }) });
      if (res && res.ok) {
        showToast("Dossier créé");
        void loadSandboxFiles();
      } else showToast("Erreur création dossier", "error");
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  async function createFile(parentPath?: unknown): Promise<void> {
    const fullPath = await demanderNom(parentPath, "fichier");
    if (!fullPath) return;
    try {
      // `if_absent` : un nom déjà pris n'est jamais vidé.
      const res = await fetchAuth(sbUrl("save"), {
        ...JSON_POST,
        body: JSON.stringify({ path: fullPath, content: "", if_absent: true }),
      });
      if (res && res.status === 409) {
        const choice = ctx.openChoice
          ? await ctx.openChoice("Ce fichier existe déjà", fullPath, [
              { id: "open", label: "Ouvrir", tone: "primary" },
            ])
          : null;
        if (choice === "open") await openFile(fullPath, true);
        return;
      }
      if (res && res.ok) {
        showToast("Fichier créé");
        await loadSandboxFiles();
        await openFile(fullPath, true);
      } else showToast("Erreur création fichier", "error");
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  /** Modèles, contenus de référence, onglets et onglet actif suivent un renommage ou un déplacement. */
  function migrerChemins(oldPath: string, newPath: string, newName: string, tolerant: boolean): void {
    const sous = (p: string): boolean => p === oldPath || p.startsWith(oldPath + "/");
    const versNouveau = (p: string): string =>
      p === oldPath ? newPath : newPath + p.substring(oldPath.length);
    for (const p of Object.keys(models).filter(sous)) {
      const migre = versNouveau(p);
      if (tolerant) sansErreur(() => migrateModel(p, migre));
      else migrateModel(p, migre);
      if (originalFileContent[p] !== undefined) {
        originalFileContent[migre] = originalFileContent[p];
        delete originalFileContent[p];
      }
    }
    sansErreur(() => onPathsMoved(oldPath, newPath));
    openTabs.value = openTabs.value.map((t) => {
      if (t.path === oldPath) return { ...t, path: newPath, name: newName };
      if (t.path.startsWith(oldPath + "/")) {
        const np = versNouveau(t.path);
        return { ...t, path: np, name: np.split("/").pop() ?? np };
      }
      return t;
    });
    const actif = activeTabPath.value;
    if (actif && sous(actif)) activeTabPath.value = versNouveau(actif);
  }

  async function messageDetail(res: Response | null, repli: string): Promise<string> {
    if (!res) throw new Error("réseau");
    return detailErreur(res, repli);
  }

  // Déplacements en file (un par élément d'une sélection glissée) ; un doublon rapproché est ignoré.
  let chaineDeplacements: Promise<void> = Promise.resolve();
  let dernierDeplacement = { cle: "", a: 0 };
  function moveItem(oldPath: string, newParentPath?: string | null): Promise<void> {
    if (!oldPath) return chaineDeplacements;
    const cle = oldPath + "\u0000" + (newParentPath || "");
    if (dernierDeplacement.cle === cle && Date.now() - dernierDeplacement.a < 1500) return chaineDeplacements;
    dernierDeplacement = { cle, a: Date.now() };
    chaineDeplacements = chaineDeplacements
      .then(() => deplacerUn(oldPath, newParentPath))
      .catch(() => undefined);
    return chaineDeplacements;
  }

  async function deplacerUn(oldPath: string, newParentPath?: string | null): Promise<void> {
    const fileName = oldPath.split("/").pop() ?? oldPath;
    const newPath = newParentPath ? newParentPath + "/" + fileName : fileName;
    if (oldPath === newPath) return;
    try {
      const res = await fetchAuth(sbUrl("rename"), {
        ...JSON_POST,
        body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
      });
      if (res && res.ok) {
        showToast("Déplacé vers " + (newParentPath || "/"));
        gitAutoRefresh();
        migrerChemins(oldPath, newPath, fileName, false);
      } else {
        showToast(await messageDetail(res, "Déplacement impossible (nom déjà utilisé ?)"), "error");
      }
      await loadSandboxFiles();
    } catch {
      showToast("Erreur réseau", "error");
      await loadSandboxFiles();
    }
  }

  async function renameItem(oldPath: string): Promise<void> {
    // Le nom seul est demandé (jamais le chemin complet) : le parent est reconstruit.
    const oldBase = oldPath.split("/").pop() ?? oldPath;
    const parent = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
    const saisi = await openPrompt("Renommer", oldBase, "nouveau nom");
    if (!saisi) return;
    const newName = saisi.trim();
    if (!newName || newName === oldBase) return;
    if (newName.includes("/") || newName.includes("\\")) {
      showToast("Le nom ne peut pas contenir « / » — utilisez le drag-and-drop pour déplacer", "error");
      return;
    }
    const newPath = parent ? parent + "/" + newName : newName;
    // Visualiseurs (image, hex, Office, binaire) : fermeture puis réouverture, leurs états ne migrent pas.
    const special = isSpecialPath(newPath) || isSpecialPath(oldPath);
    try {
      const res = await fetchAuth(sbUrl("rename"), {
        ...JSON_POST,
        body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
      });
      if (res && res.ok) {
        showToast("Renommé !");
        gitAutoRefresh();
        if (special) {
          if (openTabs.value.some((t) => t.path === oldPath)) {
            try {
              await closeTab(oldPath, null, !isPathDirty(oldPath));
            } catch {
              /* onglet déjà fermé */
            }
            try {
              await openFile(newPath, true);
            } catch {
              /* réouverture best-effort */
            }
          }
          await loadSandboxFiles();
          return;
        }
        // Migration en place du modèle (curseur, défilement, état modifié) ; la pile d'annulation repart de zéro.
        migrerChemins(oldPath, newPath, newName, true);
        await loadSandboxFiles();
      } else {
        showToast(await messageDetail(res, "Erreur renommage"), "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  async function deleteFile(path: string): Promise<void> {
    const cibles = arbre().targetsFor(path);
    if (!cibles.length) return;
    const confirme =
      cibles.length > 1
        ? await openConfirm("Supprimer " + cibles.length + " éléments ?", cibles.join("\n"), true)
        : await openConfirm("Supprimer ?", path, true);
    if (!confirme) return;
    const racines = cibles.filter((t) => !cibles.some((o) => o !== t && t.startsWith(o + "/")));
    // Onglets fermés avant les requêtes, sans confirmation (perte acceptée), dossiers compris.
    for (const cible of racines) {
      const condamnes = openTabs.value
        .map((t) => t.path)
        .filter((p) => p === cible || p.startsWith(cible + "/"));
      for (const p of condamnes) {
        try {
          await closeTab(p, null, true);
        } catch {
          /* onglet déjà fermé */
        }
      }
    }
    let echecs = 0;
    let suivant = 0;
    const ouvrier = async (): Promise<void> => {
      while (suivant < racines.length) {
        const cible = racines[suivant++] ?? "";
        try {
          const res = await fetchAuth(sbUrl("delete?path=") + encodeURIComponent(cible), {
            method: "DELETE",
          });
          if (!res || !res.ok) echecs++;
        } catch {
          echecs++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, racines.length) }, ouvrier));
    arbre().clearSelection();
    await loadSandboxFiles();
    gitAutoRefresh();
    if (echecs)
      showToast(
        echecs === racines.length ? "Erreur suppression" : echecs + " élément(s) non supprimé(s)",
        "error",
      );
    else showToast(cibles.length > 1 ? cibles.length + " éléments supprimés" : "Supprimé");
  }

  function nomCopie(path: string, n: number): string {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const base = path.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    return dir + stem + " copie" + (n > 1 ? " " + n : "") + ext;
  }

  async function duplicateItem(path: string): Promise<void> {
    if (!path) return;
    let n = 1;
    let dst = nomCopie(path, 1);
    while (trouver(dst) && n < 100) {
      n++;
      dst = nomCopie(path, n);
    }
    const dossier = trouver(path)?.type === "folder";
    try {
      const res = await fetchAuth(sbUrl("copy"), { ...JSON_POST, body: JSON.stringify({ src: path, dst }) });
      if (!res || !res.ok) {
        showToast(await detailErreur(res, "Copie impossible"), "error");
        return;
      }
      await loadSandboxFiles();
      gitAutoRefresh();
      arbre().reveal(dst);
      arbre().select(dst, "single");
      if (!dossier) await openFile(dst, true);
      showToast("Copie créée : " + (dst.split("/").pop() ?? dst));
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  // ==============================================================
  //  Recherche et remplacement
  // ==============================================================

  const searchCase = ref(false);
  const searchRegex = ref(false);
  const searchGlob = ref("");
  const searchTruncated = ref(false);
  const searchError = ref("");
  const showReplace = ref(false);
  const replaceText = ref("");
  const replacePreview: Ref<ApercuRemplacement | null> = ref(null);
  const replaceBusy = ref(false);
  let minuterieRecherche: ReturnType<typeof setTimeout> | undefined;
  // Jeton d'obsolescence : une réponse lente arrivée après une plus récente est ignorée.
  let sequenceRecherche = 0;

  async function rechercher(val: string, mode: string): Promise<void> {
    if (!val || !val.trim()) {
      sequenceRecherche++;
      sandboxSearchResults.value = [];
      isSearchingSandbox.value = false;
      return;
    }
    const seq = ++sequenceRecherche;
    isSearchingSandbox.value = true;
    searchError.value = "";
    replacePreview.value = null;
    try {
      if (mode === "content") {
        const res = await fetchAuth(
          sbUrl("grep"),
          {
            ...JSON_POST,
            body: JSON.stringify({
              query: val,
              regex: searchRegex.value,
              case_sensitive: searchCase.value,
              glob: (searchGlob.value || "").trim(),
              include_hidden: cache(),
            }),
          },
          true,
        );
        if (seq !== sequenceRecherche) return;
        const d = res && res.ok ? await lireJson(res, schemaGrep) : null;
        if (seq !== sequenceRecherche) return;
        if (d) {
          searchTruncated.value = !!d.truncated;
          sandboxSearchResults.value = (d.matches ?? []).map((m) => ({
            path: m.path,
            line: m.line,
            col: m.col,
            preview: m.snippet,
            pre: m.snippet.slice(0, m.match_start),
            hit: m.snippet.slice(m.match_start, m.match_end),
            post: m.snippet.slice(m.match_end),
          }));
        } else {
          sandboxSearchResults.value = [];
          searchError.value =
            res && res.ok ? "Recherche impossible" : await detailErreur(res, "Recherche impossible");
        }
        return;
      }
      const res = await fetchAuth(
        sbUrl("search?q=") + encodeURIComponent(val.trim()) + "&mode=" + mode,
        {},
        true,
      );
      if (seq !== sequenceRecherche) return;
      if (res && res.ok) {
        const d = await lireJson(res, schemaRechercheNoms);
        if (seq === sequenceRecherche && d) sandboxSearchResults.value = d.items ?? [];
      }
    } catch {
      /* résultats gardés */
    } finally {
      if (seq === sequenceRecherche) isSearchingSandbox.value = false;
    }
  }

  const relancerContenu = (): void => {
    if (sandboxSearch.value.trim() && sandboxSearchMode.value === "content")
      void rechercher(sandboxSearch.value, "content");
  };
  watch([searchCase, searchRegex], relancerContenu);
  let minuterieGlob: ReturnType<typeof setTimeout> | undefined;
  watch(searchGlob, () => {
    clearTimeout(minuterieGlob);
    minuterieGlob = setTimeout(relancerContenu, 350);
  });

  const searchResultGroups = computed(() => {
    const groupes: Array<{ path: string; items: ResultatRecherche[] }> = [];
    const index = new Map<string, { path: string; items: ResultatRecherche[] }>();
    for (const r of sandboxSearchResults.value) {
      if (!r || r.line == null) continue;
      let g = index.get(r.path);
      if (!g) {
        g = { path: r.path, items: [] };
        index.set(r.path, g);
        groupes.push(g);
      }
      g.items.push(r);
    }
    return groupes;
  });

  function corpsRemplacement(extra: Record<string, unknown>): string {
    return JSON.stringify({
      query: sandboxSearch.value,
      replacement: replaceText.value,
      regex: searchRegex.value,
      case_sensitive: searchCase.value,
      glob: (searchGlob.value || "").trim(),
      include_hidden: cache(),
      ...extra,
    });
  }

  async function previewReplace(): Promise<void> {
    if (!sandboxSearch.value || replaceBusy.value) return;
    replaceBusy.value = true;
    try {
      const res = await fetchAuth(sbUrl("replace"), {
        ...JSON_POST,
        body: corpsRemplacement({ dry_run: true }),
      });
      if (!res || !res.ok) {
        showToast(await detailErreur(res, "Aperçu impossible"), "error");
        return;
      }
      const d = await lireJson(res, schemaRemplacement);
      if (!d) {
        showToast("Aperçu impossible", "error");
        return;
      }
      // Un onglet ouvert ET modifié est exclu : le réécrire créerait un conflit avec le travail en cours.
      replacePreview.value = {
        total: d.total,
        truncated: !!d.truncated,
        files: (d.files ?? []).map((f) => ({ ...f, dirty: !!isPathDirty(f.path), on: !isPathDirty(f.path) })),
      };
      if (!replacePreview.value.files.length) showToast("Aucune occurrence", "info");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      replaceBusy.value = false;
    }
  }

  const replaceSelectedCount = computed(() => {
    const p = replacePreview.value;
    if (!p) return 0;
    return p.files.filter((f) => f.on).reduce((n, f) => n + f.count, 0);
  });

  async function applyReplace(): Promise<void> {
    const p = replacePreview.value;
    if (!p || replaceBusy.value) return;
    // `dirty` relu au moment d'appliquer : un onglet modifié depuis l'aperçu est exclu.
    const choisis = (): string[] =>
      p.files.filter((f) => f.on && !f.dirty && !isPathDirty(f.path)).map((f) => f.path);
    if (!choisis().length) {
      showToast("Aucun fichier à modifier (onglets modifiés exclus)", "info");
      return;
    }
    let paths = choisis();
    const ok = await openConfirm(
      "Remplacer dans " + paths.length + " fichier(s) ?",
      replaceSelectedCount.value +
        " occurrence(s) de « " +
        sandboxSearch.value +
        " » → « " +
        replaceText.value +
        " ».",
      true,
      "Remplacer",
    );
    if (!ok) return;
    paths = choisis();
    if (!paths.length) return;
    replaceBusy.value = true;
    try {
      const res = await fetchAuth(sbUrl("replace"), { ...JSON_POST, body: corpsRemplacement({ paths }) });
      if (!res || !res.ok) {
        showToast(await detailErreur(res, "Remplacement impossible"), "error");
        return;
      }
      const d = await lireJson(res, schemaRemplacement);
      if (!d) {
        showToast("Réponse illisible", "error");
        return;
      }
      const fichiers = d.files;
      await onFilesReplaced(fichiers.map((f) => f.path));
      replacePreview.value = null;
      const ignores = d.skipped.length;
      if (d.failed) {
        showToast(
          "Remplacement interrompu sur « " +
            d.failed.path +
            " » : " +
            String(d.failed.error) +
            " (" +
            fichiers.length +
            " fichier(s) déjà modifié(s))",
          "error",
        );
      } else {
        showToast(
          String(d.total) +
            " remplacement(s) dans " +
            fichiers.length +
            " fichier(s)" +
            (ignores ? " · " + ignores + " ignoré(s)" : ""),
          ignores ? "warning" : undefined,
        );
      }
      gitAutoRefresh();
      void rechercher(sandboxSearch.value, "content");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      replaceBusy.value = false;
    }
  }

  watch(sandboxSearch, (val) => {
    clearTimeout(minuterieRecherche);
    if (!val || !val.trim()) {
      sequenceRecherche++;
      sandboxSearchResults.value = [];
      isSearchingSandbox.value = false;
      return;
    }
    isSearchingSandbox.value = true;
    minuterieRecherche = setTimeout(() => void rechercher(val, sandboxSearchMode.value), 350);
  });
  watch(sandboxSearchMode, () => {
    // Bascule Contenu/Nom : les deux modes n'ont pas la même forme, résultats purgés et retard annulé.
    clearTimeout(minuterieRecherche);
    sequenceRecherche++;
    sandboxSearchResults.value = [];
    if (sandboxSearch.value.trim()) void rechercher(sandboxSearch.value, sandboxSearchMode.value);
  });

  const filteredFilesList = computed(() => {
    const q = (sandboxSearch.value || "").trim().toLowerCase();
    if (!q) return [];
    const resultats: NoeudArbre[] = [];
    parcourir((n) => {
      if (n.name.toLowerCase().includes(q)) resultats.push(n);
      return n.type === "folder";
    });
    return resultats;
  });

  function openFileAtLine(path: string, line?: number | null, col?: number | null): Promise<void> {
    rappels.beforeJump?.();
    return openFile(path, false).then(() => {
      // Un visualiseur n'a pas de lignes : ne pas voler le focus au profit d'un Monaco caché.
      if (!line || !monacoRef.instance || isSpecialPath(path)) return;
      setTimeout(() => {
        const ed = monacoRef.instance;
        if (!ed) return;
        try {
          const pos = { lineNumber: line, column: col || 1 };
          ed.revealPositionInCenter(pos);
          ed.setPosition(pos);
          ed.focus();
        } catch {
          /* modèle remplacé entre-temps */
        }
      }, 150);
    });
  }

  // ==============================================================
  //  Import (fichiers et dossiers)
  // ==============================================================

  function triggerSandboxImport(type?: string): void {
    showImportMenu.value = false;
    const cible =
      type === "folder" && sandboxFolderInput.value ? sandboxFolderInput.value : sandboxFileInput.value;
    if (!cible) return;
    cible.value = "";
    cible.click();
  }

  /** Délègue à l'importeur de la page : pré-contrôle d'espace, lots, progression annulable. */
  async function handleSandboxImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const files = input?.files;
    if (!files || files.length === 0) return;
    try {
      await importeur()?.fichiers(files, "");
    } catch {
      showToast("Erreur réseau", "error");
    }
    if (input) input.value = "";
    if (sandboxFileInput.value) sandboxFileInput.value.value = "";
  }

  // ==============================================================
  //  Instantanés du bac (archive complète et restauration, flux NDJSON)
  // ==============================================================

  const snapshots: Ref<InstantaneBac[]> = ref([]);
  const snapshotsMax = ref(10);
  const snapshotBusy: Ref<"idle" | "create" | "restore"> = ref("idle");
  const snapshotProgress: Ref<Progression> = ref({ ...PROGRESSION_VIDE });
  const showSnapshotPanel = ref(false);
  const snapshotName = ref("");
  // Restauration interrompue côté serveur : { snap_id, ts } ou null.
  const restoreIncomplete: Ref<{ ts?: number | undefined; [cle: string]: unknown } | null> = ref(null);

  function remettreProgression(): void {
    snapshotProgress.value = { ...PROGRESSION_VIDE };
  }

  async function loadSnapshots(): Promise<void> {
    try {
      const res = await fetchAuth("/api/sandbox/snapshots", {}, true);
      if (res && res.ok) {
        const data = await lireJson(res, schemaInstantanes);
        if (!data) return;
        snapshots.value = data.items ?? [];
        snapshotsMax.value = data.max || 10;
        restoreIncomplete.value = data.last_restore_incomplete ?? null;
      }
    } catch {
      /* liste gardée */
    }
  }

  async function dismissRestoreIncomplete(): Promise<void> {
    const avant = restoreIncomplete.value;
    restoreIncomplete.value = null;
    try {
      const res = await fetchAuth("/api/sandbox/snapshots/restore-marker", { method: "DELETE" });
      if (!res || !res.ok) {
        restoreIncomplete.value = avant;
        showToast("Impossible d'effacer l'alerte", "error");
      }
    } catch {
      restoreIncomplete.value = avant;
      showToast("Erreur réseau", "error");
    }
  }

  function restoreIncompleteWhen(): string {
    const ts = restoreIncomplete.value?.ts;
    if (!ts) return "";
    try {
      return new Date(ts * 1000).toLocaleString("fr-FR");
    } catch {
      return "";
    }
  }

  function appliquerProgression(evt: EvenementInstantane): void {
    const p = snapshotProgress.value;
    const nombre = (v: unknown, repli: number): number => (typeof v === "number" ? v : repli);
    const texte = (v: unknown): string => (typeof v === "string" ? v : "");
    if (evt.event === "start") {
      snapshotProgress.value = {
        ...PROGRESSION_VIDE,
        total_files: nombre(evt["total_files"], 0),
        total_bytes: nombre(evt["total_bytes"], 0),
        phase: texte(evt["phase"]),
      };
    } else if (evt.event === "phase") {
      snapshotProgress.value = { ...p, phase: texte(evt["phase"]) };
    } else if (evt.event === "progress") {
      // `current_file` est instantané (effacé s'il manque), la phase dure (gardée).
      snapshotProgress.value = {
        pct: nombre(evt["pct"], p.pct),
        files_done: nombre(evt["files_done"], p.files_done),
        total_files: nombre(evt["total_files"], p.total_files),
        bytes_done: nombre(evt["bytes_done"], p.bytes_done),
        total_bytes: nombre(evt["total_bytes"], p.total_bytes),
        current_file: texte(evt["current_file"]),
        phase: texte(evt["phase"]) || p.phase,
      };
    }
  }

  /** Flux de progression d'une création ou d'une restauration ; rend le dernier événement et le message d'erreur. */
  async function suivreFlux(
    res: Response,
  ): Promise<{ dernier: EvenementInstantane | null; erreur: string | null }> {
    let dernier: EvenementInstantane | null = null;
    let erreur: string | null = null;
    if (!res.body) return { dernier, erreur };
    for await (const brut of lireNdjson(res.body, { surLigneInvalide: () => undefined })) {
      const r = schemaEvenementInstantane.safeParse(brut);
      if (!r.success) continue;
      appliquerProgression(r.data);
      dernier = r.data;
      if (r.data.event === "error") erreur = r.data.message;
    }
    return { dernier, erreur };
  }

  async function executerInstantane(
    mode: "create" | "restore",
    url: string,
    init: RequestInit,
    echec: string,
  ): Promise<EvenementInstantane | null> {
    snapshotBusy.value = mode;
    remettreProgression();
    let issue: { dernier: EvenementInstantane | null; erreur: string | null };
    try {
      const res = await fetchAuth(url, init);
      if (!res || !res.ok) {
        showToast(echec, "error");
        return null;
      }
      issue = await suivreFlux(res);
    } catch (e) {
      issue = { dernier: null, erreur: (e instanceof Error && e.message) || "Erreur réseau" };
    } finally {
      snapshotBusy.value = "idle";
    }
    if (issue.erreur) {
      showToast(issue.erreur, "error");
      return null;
    }
    return issue.dernier?.event === "done" ? issue.dernier : null;
  }

  async function createSnapshot(): Promise<void> {
    if (snapshotBusy.value !== "idle") return;
    const name = (snapshotName.value || "").trim();
    const fin = await executerInstantane(
      "create",
      "/api/sandbox/snapshots/create",
      { ...JSON_POST, body: JSON.stringify({ name }) },
      "Erreur création snapshot",
    );
    if (!fin) return;
    snapshotName.value = "";
    showToast("Snapshot créée");
    await loadSnapshots();
    remettreProgression();
  }

  async function deleteSnapshot(snapId: string): Promise<void> {
    const confirme = await openConfirm("Supprimer cette snapshot ?", "Cette action est irréversible.", true);
    if (!confirme) return;
    try {
      const res = await fetchAuth("/api/sandbox/snapshots/" + encodeURIComponent(snapId), {
        method: "DELETE",
      });
      if (res && res.ok) {
        showToast("Snapshot supprimée");
        await loadSnapshots();
      } else showToast("Erreur suppression", "error");
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  async function restoreSnapshot(snapId: string, snapName?: string): Promise<void> {
    if (snapshotBusy.value !== "idle") return;
    const confirme = await openConfirm(
      "Restaurer cette snapshot ?",
      'Tous les fichiers actuels de votre sandbox seront remplacés par ceux de "' +
        (snapName || "cette snapshot") +
        '". Les onglets ouverts seront fermés.',
      true,
      "Restaurer",
      "Annuler",
    );
    if (!confirme) return;
    // Onglets modifiés : restauration refusée tant qu'ils ne sont ni enregistrés ni fermés.
    const modifies = openTabs.value.map((t) => t.path).filter((p) => isPathDirty(p));
    if (modifies.length) {
      showToast(
        "Enregistrez ou fermez d'abord les onglets modifiés : " +
          modifies.map((p) => p.split("/").pop()).join(", "),
        "error",
      );
      return;
    }
    // Fermeture forcée et séquentielle (la perte est déjà acceptée) avant de toucher au disque.
    for (const p of openTabs.value.map((t) => t.path)) {
      try {
        await closeTab(p, null, true);
      } catch {
        /* onglet déjà fermé */
      }
    }
    const fin = await executerInstantane(
      "restore",
      "/api/sandbox/snapshots/" + encodeURIComponent(snapId) + "/restore",
      { method: "POST" },
      "Erreur restore",
    );
    if (!fin) return;
    const n = fin.event === "done" ? (fin.conflicts ?? 0) : 0;
    if (fin.event === "done" && n > 0) {
      const noms = (fin.conflict_paths ?? []).slice(0, 3).join(" ; ");
      showToast(`Sandbox restaurée, ${n} entrée(s) à vérifier${noms ? " : " + noms : ""}`, "warning");
    } else showToast("Sandbox restaurée");
    await loadSandboxFiles();
    sansErreur(gitAutoRefresh);
    remettreProgression();
  }

  function toggleSnapshotPanel(): void {
    const suivant = !showSnapshotPanel.value;
    showSnapshotPanel.value = suivant;
    if (suivant) void loadSnapshots();
  }

  return {
    loadSandboxFiles,
    treeTruncated,
    toggleHiddenFiles,
    loadSandboxQuota,
    scheduleQuotaRefresh,
    downloadFile,
    createFolder,
    createFile,
    moveItem,
    renameItem,
    deleteFile,
    filteredFilesList,
    openFileAtLine,
    searchCase,
    searchRegex,
    searchGlob,
    searchTruncated,
    searchError,
    searchResultGroups,
    showReplace,
    replaceText,
    replacePreview,
    replaceBusy,
    replaceSelectedCount,
    previewReplace,
    applyReplace,
    duplicateItem,
    triggerSandboxImport,
    handleSandboxImport,
    snapshots,
    snapshotsMax,
    snapshotBusy,
    snapshotProgress,
    showSnapshotPanel,
    snapshotName,
    loadSnapshots,
    createSnapshot,
    restoreSnapshot,
    deleteSnapshot,
    toggleSnapshotPanel,
    restoreIncomplete,
    dismissRestoreIncomplete,
    restoreIncompleteWhen,
  };
}
