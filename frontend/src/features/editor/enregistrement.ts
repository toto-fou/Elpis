// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/enregistrement.ts — enregistrement des onglets (retard automatique, précondition disque, refus 409/412/503 et fenêtre de conflit), « Tout enregistrer », formatage et lint Python (ruff), historique de la session (comparer, restaurer). */
import { nextTick, ref } from "vue";
import type { Ref } from "vue";

import { decoderTexte } from "./lecture";
import { editionMinimale } from "./ecriture-modele";
import type { CtxEditeur, EtatEditeur, Modele } from "./etat";
import { poserDans } from "./etat";
import type { ReglagesEditeur } from "./instances";
import type { LiensEditeur, OptionsEnregistrement, ServicesEditeur } from "./liens";
import type { Instantane, OptionsSauvegarde } from "./sauvegarde";
import {
  lireJson,
  schemaEnregistrement,
  schemaEntreeHistorique,
  schemaErreur,
  schemaFormatage,
  schemaLint,
  schemaRefusEnregistrement,
  schemaSessionHistorique,
} from "./schemas-bac";
import type { EntreeHistorique, SessionHistorique, VersionHistorique } from "./schemas-bac";

const urlBac = (endpoint: string): string => "/api/sandbox/" + endpoint;
const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } } as const;
const DELAIS_AUTO: Readonly<Record<string, number>> = {
  off: 0,
  "30s": 30_000,
  "1min": 60_000,
  "2min": 120_000,
  on_blur: 0,
};

export const HISTORY_SOURCES: Readonly<Record<string, string>> = {
  editor: "Vous",
  assistant: "Assistant",
  replace: "Remplacer",
  upload: "Import",
  restore: "Restauration",
  git: "Git",
  shell: "Commande",
  other: "Externe",
};

type DetailConflit = { mtime?: number | null; missing?: boolean };

export async function sha256Hex(texte: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texte));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Motif d'indisponibilité d'une version de l'historique, ou null. */
export function erreurVersion(v: Partial<VersionHistorique> | null | undefined): string | null {
  if (!v) return "Version introuvable";
  if (v.too_big) return "Version trop volumineuse pour être gardée";
  if (v.unknown) return "Contenu non relevé (modifié par une commande)";
  if (!v.exists) return "Le fichier n'existait pas à ce moment";
  if (!v.sha) return "Version indisponible";
  return null;
}

export function heureHistorique(ts: number | null | undefined): string {
  if (!ts) return "";
  try {
    return new Date(ts * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function setupEditorSave(
  e: EtatEditeur,
  s: ServicesEditeur,
  l: LiensEditeur,
  ctx: CtxEditeur,
  settings: Ref<ReglagesEditeur>,
  invaliderConteneur: () => void,
) {
  const { activeTabPath, originalFileContent, isEditorDirty, diskConflicts, assistantStash, monacoRef } = e;
  const { models, vis, disque } = s;
  const { showToast, fetchAuth } = ctx;
  const modelOk = (p: string | null | undefined): boolean => !!p && s.modeles.ok(p);

  // Version monotone par modèle : un modèle recréé ne repart jamais sous une version déjà écrite.
  const epoques = new WeakMap<Modele, number>();
  let epoqueSuivante = 1;
  function versionModele(m: Modele): number {
    let base = epoques.get(m);
    if (base === undefined) {
      base = epoqueSuivante++ * 1e9;
      epoques.set(m, base);
    }
    return base + m.getVersionId();
  }
  function lireInstantane(chemin: string): Instantane | null {
    const m = models[chemin];
    return m && modelOk(chemin) ? { texte: m.getValue(), version: versionModele(m) } : null;
  }

  const delaiAuto = (): number => DELAIS_AUTO[settings.value?.editor_auto_save || "off"] || 0;
  /** Retard du panneau gauche (chemin figé à la frappe) ; 'off' et 'on_blur' n'en posent pas. */
  function _scheduleAutoSave(): void {
    s.sauvegarde.planifier("left", activeTabPath.value ?? "", delaiAuto());
  }
  function _scheduleAutoSaveRight(): void {
    const p = e.splitTabPath.value;
    if (!p) {
      s.sauvegarde.annulerRetard("right");
      return;
    }
    s.sauvegarde.planifier("right", p, delaiAuto());
  }

  let gardeChemin: string | null = null;
  // Conflit 412 présenté après libération du verrou d'écriture (sinon « Écraser » restait inopérant).
  const conflitsAPresenter = new Map<string, DetailConflit>();

  /** Chemin figé à l'appel ; une écriture en vol par fichier, un geste explicite tombé pendant le vol repart avec le contenu le plus récent. */
  async function saveEditorContent(opts?: OptionsEnregistrement): Promise<void> {
    const silent = !!opts?.silent;
    const force = !!opts?.force;
    if (!activeTabPath.value && !opts?.path) return;
    if (l.isStreamActive(opts?.path || activeTabPath.value)) {
      if (!silent) showToast("Écriture en cours sur ce fichier : sauvegarde refusée", "info");
      return;
    }
    const chemin = opts?.path || activeTabPath.value || "";
    if (vis.officeIsViewerPath(chemin)) {
      if (!silent) showToast("Lecture seule", "info");
      return;
    }
    if (vis._isReadOnlyTab(chemin)) {
      if (!silent) {
        const pourquoi =
          vis._resolveFileViewMode(chemin) === "docx"
            ? "Fichier en lecture seule (.docx) — sauvegarde refusée"
            : disque.fileFormats[chemin]?.lossy
              ? "Encodage non UTF-8 : lecture seule (l'enregistrement corromprait les accents)"
              : vis._binaryRefused.has(chemin)
                ? "Fichier binaire sur disque — sauvegarde refusée"
                : "Onglet en lecture seule (consultation d'un diff de commit) — rechargez le fichier depuis l'arborescence pour rééditer";
        showToast(pourquoi, "error");
      }
      return;
    }
    if (!modelOk(chemin)) {
      if (!silent) showToast("Modèle non disponible", "error");
      return;
    }
    gardeChemin = chemin;
    let issue: Promise<unknown>;
    try {
      const o: OptionsSauvegarde = opts?.source
        ? { silencieux: silent, force, source: opts.source }
        : { silencieux: silent, force };
      issue = s.sauvegarde.sauvegarder(chemin, o);
    } finally {
      gardeChemin = null;
    }
    await issue;
    const det = conflitsAPresenter.get(chemin);
    if (det) {
      conflitsAPresenter.delete(chemin);
      await presenterConflit(chemin, det);
    }
  }

  /** Garde des reprises : une écriture en file repasse par les refus de saveEditorContent. */
  function _saveRefused(chemin: string, silent: boolean): boolean {
    if (l.isStreamActive(chemin)) {
      if (!silent) showToast("Écriture en cours sur ce fichier : sauvegarde refusée", "info");
      return true;
    }
    return vis.officeIsViewerPath(chemin) || vis._isReadOnlyTab(chemin) || !modelOk(chemin);
  }

  /** POST /save d'un contenu lu par le service de sauvegarde ; vrai si le disque l'a reçu. */
  async function _writeEditorContent(
    chemin: string,
    contenu: string,
    o: OptionsSauvegarde,
  ): Promise<boolean> {
    const silent = !!o.silencieux;
    const force = !!o.force;
    if (gardeChemin !== chemin && _saveRefused(chemin, silent)) return false;
    if (silent && !force && diskConflicts.value[chemin]) return false;
    const base = disque.fileMtimes.value[chemin];
    const format = disque.fileFormats[chemin];
    const corps: Record<string, unknown> = { path: chemin, content: format?.bom ? "﻿" + contenu : contenu };
    if (o.source) corps["source"] = o.source;
    else if (e.restorePending.has(chemin)) corps["source"] = "restore";
    if (!force) {
      if (disque.fileShas[chemin]) corps["expected_sha256"] = disque.fileShas[chemin];
      else if (typeof base === "number") corps["expected_mtime"] = base;
    }
    try {
      const res = await fetchAuth(urlBac("save"), { ...JSON_POST, body: JSON.stringify(corps) });
      if (res && res.ok) {
        const rep = await lireJson(res.clone(), schemaEnregistrement);
        const mtime = rep?.mtime ?? null;
        let sha = rep?.sha256 ?? null;
        originalFileContent[chemin] = contenu;
        l.scheduleDirtyRefresh();
        const encoreModifie = modelOk(chemin) && models[chemin]?.getValue() !== contenu;
        if (chemin === activeTabPath.value) {
          isEditorDirty.value = encoreModifie;
          if (e.isDiffView.value) l.updateDiffView();
        }
        if (!silent)
          showToast(
            encoreModifie ? "Sauvegardé — modifications plus récentes à enregistrer" : "Sauvegardé !",
          );
        s.apercu.refreshPreview();
        l.scheduleLint(chemin, contenu);
        s.git._gitAutoRefresh();
        if (!sha) {
          try {
            sha = await sha256Hex(String(corps["content"]));
          } catch {
            sha = null;
          }
        }
        disque._setBase(chemin, mtime, sha);
        e.restorePending.delete(chemin);
        poserDans(diskConflicts, chemin, null);
        if (s.git.explorerTab.value === "history") void loadHistorySession();
        poserDans(assistantStash, chemin, null);
        l.scheduleScmRefresh(chemin);
        s.fs.scheduleQuotaRefresh();
        return true;
      }
      if (!res) {
        if (!silent) showToast("Non enregistré — le contenu reste dans l'onglet", "error");
      } else if (res.status === 503) {
        invaliderConteneur();
        showToast(
          "Environnement sandbox indisponible — redémarrage en cours, réessayez dans quelques instants (le fichier reste ouvert, rien n'est perdu)",
          "error",
        );
      } else if (res.status === 412) {
        const det = (await lireJson(res, schemaRefusEnregistrement))?.detail;
        const d = det && typeof det === "object" ? det : {};
        if (d.unreadable) {
          showToast(
            "« " +
              (chemin.split("/").pop() ?? chemin) +
              " » n'est plus lisible (droits) : enregistrement refusé",
            "error",
          );
          return false;
        }
        poserDans(diskConflicts, chemin, { mtime: d.mtime ?? null, missing: !!d.missing });
        if (!silent) conflitsAPresenter.set(chemin, d);
      } else if (res.status === 409) {
        const det = (await lireJson(res, schemaRefusEnregistrement))?.detail;
        if (det && typeof det === "object" && (det.code === "is_dir" || det.code === "not_dir")) {
          poserDans(diskConflicts, chemin, { mtime: null, missing: true });
          showToast(
            "« " +
              (chemin.split("/").pop() ?? chemin) +
              " » : " +
              (det.code === "is_dir"
                ? "c'est désormais un dossier sur le disque"
                : "un dossier parent est devenu un fichier") +
              " — enregistrement refusé",
            "error",
          );
          return false;
        }
        if (det && typeof det === "object" && det.code === "exists") {
          showToast(det.message || "Un fichier porte déjà ce nom", "error");
          return false;
        }
        vis._binaryRefused.add(chemin);
        vis.readOnlyTabs.value.add(chemin);
        if (activeTabPath.value === chemin) vis._applyActiveReadOnly();
        showToast((typeof det === "string" && det) || "Fichier binaire : sauvegarde refusée", "error");
      } else {
        const det = (await lireJson(res, schemaErreur))?.detail;
        showToast((typeof det === "string" && det) || "Erreur sauvegarde", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
    return false;
  }

  async function presenterConflit(chemin: string, det: DetailConflit): Promise<void> {
    if (!ctx.openChoice) return;
    const nom = chemin.split("/").pop() ?? chemin;
    const absent = !!det.missing;
    const choix = await ctx.openChoice(
      absent ? "« " + nom + " » a été supprimé du disque" : "« " + nom + " » a changé sur le disque",
      absent
        ? "Enregistrer recréera le fichier avec le contenu de l'onglet."
        : "Une autre modification (terminal, assistant, git…) a eu lieu depuis son ouverture.",
      absent
        ? [{ id: "overwrite", label: "Recréer", tone: "primary" }]
        : [
            { id: "reload", label: "Recharger", tone: "neutral" },
            { id: "compare", label: "Comparer", tone: "neutral" },
            { id: "overwrite", label: "Écraser", tone: "danger" },
          ],
    );
    if (choix === "overwrite") await saveEditorContent({ path: chemin, force: true });
    else if (choix === "compare") await disque.conflictCompare(chemin);
    else if (choix === "reload") await disque._reloadFromDisk(chemin);
  }

  /** « Tout enregistrer » (menu « + », Ctrl+Alt+S) : cause nommée pour chaque fichier resté modifié. */
  async function saveAllTabs(): Promise<void> {
    e.showEditorMore.value = false;
    l.closeTabCtxMenu();
    const modifies = e.openTabs.value
      .map((t) => t.path)
      .filter((p) => l.tabIsDirty(p) && !vis.officeIsViewerPath(p));
    if (!modifies.length) {
      showToast("Rien à enregistrer");
      return;
    }
    for (const p of modifies) {
      try {
        await saveEditorContent({ path: p, silent: true });
      } catch {
        /* cause affichée plus bas */
      }
    }
    const restants = modifies.filter((p) => l.tabIsDirty(p));
    if (!restants.length) {
      showToast(modifies.length + " fichier(s) enregistré(s)");
      return;
    }
    const pourquoi = (p: string): string => {
      const c = diskConflicts.value[p];
      if (c) return c.missing ? "supprimé du disque" : "modifié sur le disque";
      if (vis._isReadOnlyTab(p)) return "lecture seule";
      return "erreur";
    };
    showToast(
      restants.length +
        " fichier(s) non enregistré(s) : " +
        restants.map((p) => (p.split("/").pop() ?? p) + " (" + pourquoi(p) + ")").join(", "),
      "error",
    );
    const premierConflit = restants.find((p) => diskConflicts.value[p]);
    if (premierConflit && activeTabPath.value !== premierConflit) void l.switchTab(premierConflit);
  }

  /** « Formater le document » en Python : `ruff format` côté serveur ; une erreur de syntaxe laisse le document intact. */
  async function _formatPython(
    m: Modele,
  ): Promise<Array<{ range: ReturnType<Modele["getFullModelRange"]>; text: string }>> {
    if (!m || m.isDisposed()) return [];
    const chemin = Object.keys(models).find((k) => models[k] === m) || "file.py";
    try {
      const res = await fetchAuth(
        urlBac("format"),
        { ...JSON_POST, body: JSON.stringify({ content: m.getValue(), filename: chemin.split("/").pop() }) },
        true,
      );
      if (!res || !res.ok) {
        let message = "Formatage impossible";
        if (res) {
          const det = (await lireJson(res, schemaErreur))?.detail;
          if (typeof det === "string") message = det;
        }
        showToast(message, "error");
        return [];
      }
      const d = await lireJson(res, schemaFormatage);
      if (typeof d?.content !== "string" || d.content === m.getValue()) return [];
      return [{ range: m.getFullModelRange(), text: d.content }];
    } catch {
      showToast("Formatage impossible", "error");
      return [];
    }
  }

  async function lintCurrentFile(chemin: string, code: string): Promise<void> {
    const monaco = window.monaco;
    if (!chemin || !chemin.endsWith(".py")) {
      const m = models[chemin];
      if (monaco && m) monaco.editor.setModelMarkers(m, "ruff", []);
      return;
    }
    try {
      const res = await fetchAuth(urlBac("lint"), {
        ...JSON_POST,
        body: JSON.stringify({ content: code, filename: chemin.split("/").pop() }),
      });
      if (!res || !res.ok) return;
      const d = await lireJson(res, schemaLint);
      const m = models[chemin];
      if (!window.monaco || !m || m.isDisposed()) return;
      window.monaco.editor.setModelMarkers(
        m,
        "ruff",
        (d?.diagnostics ?? []).map((x) => ({
          startLineNumber: x.row,
          startColumn: x.col,
          endLineNumber: x.end_row,
          endColumn: x.end_col + 1,
          message: `[${String(x.code)}] ${x.message}`,
          severity: x.severity,
          source: "ruff",
        })),
      );
    } catch {
      /* lint indisponible */
    }
  }

  let minuterieLint: ReturnType<typeof setTimeout> | null = null;
  /** Lint retardé (800 ms) ; sans `code`, le contenu est lu au tir (pas à chaque frappe). */
  function scheduleLint(chemin: string, code?: string): void {
    if (minuterieLint) clearTimeout(minuterieLint);
    minuterieLint = setTimeout(() => {
      minuterieLint = null;
      if (!monacoRef.instance) return;
      const texte =
        typeof code === "string" ? code : modelOk(chemin) ? (models[chemin]?.getValue() ?? "") : "";
      void lintCurrentFile(chemin, texte);
    }, 800);
  }

  // Historique de la session : tout ce qui a été écrit, comparé à l'original (état avant la première modification).
  const historySession = ref<SessionHistorique | null>(null);
  const historyEntries = ref<Record<string, EntreeHistorique | "loading">>({});
  const historyLoading = ref(false);
  const textesHistorique = new Map<string, string>();

  async function loadHistorySession(): Promise<void> {
    historyLoading.value = true;
    try {
      const res = await fetchAuth("/api/sandbox/history", {}, true);
      if (res && res.ok) historySession.value = await lireJson(res, schemaSessionHistorique);
      for (const p of Object.keys(historyEntries.value)) void lireEntree(p);
    } catch {
      /* historique indisponible */
    } finally {
      historyLoading.value = false;
    }
  }
  function openHistoryPanel(): void {
    e.showEditorMore.value = false;
    s.git.explorerTab.value = "history";
    e.showExplorer.value = true;
    void loadHistorySession();
  }
  async function lireEntree(chemin: string): Promise<EntreeHistorique | null> {
    try {
      const res = await fetchAuth("/api/sandbox/history/file?path=" + encodeURIComponent(chemin), {}, true);
      const entree = res && res.ok ? await lireJson(res, schemaEntreeHistorique) : null;
      if (!entree) {
        poserDans(historyEntries, chemin, null);
        return null;
      }
      entree.versions = entree.versions.slice().reverse();
      poserDans(historyEntries, chemin, entree);
      return entree;
    } catch {
      poserDans(historyEntries, chemin, null);
      return null;
    }
  }
  function toggleHistoryFile(chemin: string): void {
    if (historyEntries.value[chemin]) {
      poserDans(historyEntries, chemin, null);
      return;
    }
    poserDans(historyEntries, chemin, "loading");
    void lireEntree(chemin);
  }
  async function texteVersion(sha: string): Promise<string | null> {
    const connu = textesHistorique.get(sha);
    if (connu !== undefined) return connu;
    const res = await fetchAuth("/api/sandbox/history/blob?sha=" + encodeURIComponent(sha), {}, true);
    if (!res || !res.ok) return null;
    const dec = decoderTexte(new Uint8Array(await res.arrayBuffer()));
    if (textesHistorique.size > 64) textesHistorique.clear();
    textesHistorique.set(sha, dec.text);
    return dec.text;
  }
  const ouvert = (p: string): boolean => e.openTabs.value.some((t) => t.path === p);
  const entreeConnue = (p: string): EntreeHistorique | null => {
    const v = historyEntries.value[p];
    return v && v !== "loading" ? v : null;
  };
  async function historyCompare(chemin: string, v: VersionHistorique): Promise<void> {
    const err = erreurVersion(v);
    if (err || !v.sha) {
      showToast(err || "Version indisponible", "info");
      return;
    }
    const texte = await texteVersion(v.sha);
    if (texte === null) {
      showToast("Version illisible", "error");
      return;
    }
    if (entreeConnue(chemin)?.current?.exists === false && !ouvert(chemin)) {
      showToast("Fichier supprimé : restaurez une version pour le comparer", "info");
      return;
    }
    if (!ouvert(chemin)) await l.openFile(chemin, true, { quiet: true });
    l.showDiffForMessage(chemin, texte, "history");
  }
  async function historyRestore(chemin: string, v: VersionHistorique): Promise<void> {
    const err = erreurVersion(v);
    if (err || !v.sha) {
      showToast(err || "Version indisponible", "info");
      return;
    }
    const texte = await texteVersion(v.sha);
    if (texte === null) {
      showToast("Version illisible", "error");
      return;
    }
    if (entreeConnue(chemin)?.current?.exists === false && !ouvert(chemin)) {
      // Fichier supprimé depuis : recréé tel quel, jamais par-dessus un fichier réapparu (`if_absent`).
      const res = await fetchAuth(urlBac("save"), {
        ...JSON_POST,
        body: JSON.stringify({ path: chemin, content: texte, if_absent: true, source: "restore" }),
      });
      if (res && res.ok) {
        showToast("« " + (chemin.split("/").pop() ?? chemin) + " » recréé");
        void s.fs.loadSandboxFiles();
        await l.openFile(chemin, true);
        void loadHistorySession();
      } else if (res) {
        const det = (await lireJson(res, schemaRefusEnregistrement))?.detail;
        showToast((typeof det === "string" ? det : det?.message) || "Restauration impossible", "error");
      }
      return;
    }
    if (!ouvert(chemin) || !modelOk(chemin)) await l.openFile(chemin, true, { quiet: true });
    const m = models[chemin];
    if (!m || !modelOk(chemin)) {
      showToast("Fichier non ouvrable", "error");
      return;
    }
    if (vis._isReadOnlyTab(chemin)) {
      showToast("Onglet en lecture seule", "error");
      return;
    }
    if (m.getValue() !== texte) editionMinimale(m, m.getValue(), texte);
    e.restorePending.add(chemin);
    if (activeTabPath.value !== chemin) await l.switchTab(chemin);
    isEditorDirty.value = l.tabIsDirty(chemin);
    l.scheduleDirtyRefresh();
    showToast("Version restaurée dans l'onglet — Ctrl+S pour l'enregistrer (annulable par Ctrl+Z)");
  }
  /** « Diff depuis l'original » : l'onglet actif comparé à son état du début de session. */
  async function toggleOriginalDiff(): Promise<void> {
    e.showEditorMore.value = false;
    const chemin = activeTabPath.value;
    if (!chemin) return;
    if (e.isDiffView.value && e.diffBase.value === "history") {
      e.isDiffView.value = false;
      e.diffBase.value = "saved";
      void nextTick(() => l.robustLayout());
      return;
    }
    const entree = await lireEntree(chemin);
    if (!entree) {
      showToast("Aucune modification de ce fichier dans la session", "info");
      return;
    }
    await historyCompare(chemin, entree.original);
  }

  return {
    lireInstantane,
    _scheduleAutoSave,
    _scheduleAutoSaveRight,
    saveEditorContent,
    _writeEditorContent,
    saveAllTabs,
    _formatPython,
    lintCurrentFile,
    scheduleLint,
    historySession,
    historyEntries,
    historyLoading,
    HISTORY_SOURCES,
    loadHistorySession,
    openHistoryPanel,
    toggleHistoryFile,
    historyCompare,
    historyRestore,
    historyTime: heureHistorique,
    toggleOriginalDiff,
    libererEnregistrement(): void {
      if (minuterieLint) clearTimeout(minuterieLint);
      minuterieLint = null;
    },
  };
}
