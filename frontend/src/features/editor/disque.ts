// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/disque.ts — synchronisation des onglets avec le disque du bac : base (mtime, sha256, format) de chaque onglet, sondage des modifications externes (`/check-mtimes`), rechargement, bandeaux de conflit et de copie de l'assistant. */
import { computed, nextTick, reactive, ref } from "vue";
import type { ComputedRef, Ref } from "vue";

import { lireJson, schemaVerification } from "./schemas-bac";
import type { Perime } from "./schemas-bac";

type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

export interface LectureDisque {
  binary?: boolean;
  text?: string;
  eol?: string | null;
  bom?: boolean;
  lossy?: boolean;
}

export interface FormatDisque {
  bom: boolean;
  eol: string | null;
  lossy: boolean;
}

export interface ConflitDisque {
  mtime: number | null | undefined;
  missing: boolean;
}

export interface CopieAssistant {
  content: string;
  [cle: string]: unknown;
}

export interface Bandeau {
  kind: "stash" | "missing" | "disk" | "encoding";
  path: string;
}

export interface ModeleTexte {
  getValue(): string;
  getEOL(): string;
  pushEOL(eol: number): void;
}

interface Onglet {
  path: string;
}

export interface RefsDisque<Mo extends ModeleTexte = ModeleTexte> {
  openTabs: Ref<Onglet[]>;
  activeTabPath: Ref<string | null>;
  isEditorDirty: Ref<boolean>;
  isDiffView: Ref<boolean>;
  readonly diffBase: Ref<string>;
  readOnlyTabs: Ref<Set<string>>;
  diskConflicts: Ref<Record<string, ConflitDisque>>;
  assistantStash: Ref<Record<string, CopieAssistant>>;
  user: Ref<unknown>;
  showEditor: Ref<boolean>;
  readonly modeles: { ok(chemin: string): boolean; table: Record<string, Mo> };
  readonly originalFileContent: Record<string, string | undefined>;
}

export interface CtxDisque {
  fetchAuth: FetchAuth;
  showToast(message: string, type?: string): void;
  openConfirm(titre: string, texte: string, danger?: boolean, ok?: string): Promise<boolean>;
}

export interface RappelsDisque<Mo extends ModeleTexte = ModeleTexte> {
  url(endpoint: string): string;
  finsDeLigne(): { LF: number; CRLF: number };
  enregistrementEnCours(chemin: string): boolean;
  fluxActif(chemin: string): boolean;
  estModifie(chemin: string): boolean;
  modeVue(chemin: string): string;
  lireTexte(res: Response): Promise<LectureDisque>;
  editionMinimale(modele: Mo, ancien: string, nouveau: string): unknown;
  fermerOnglet(chemin: string, ev: null, force: boolean): unknown;
  ouvrirOffice(chemin: string, opts: { force: boolean }): unknown;
  ouvrirFichier(chemin: string, force: boolean): unknown;
  appliquerLectureSeule(): void;
  majDiff(): void;
  rafraichirModifies(): void;
  rafraichirScm(chemin: string): void;
  comparer(chemin: string, texte: string, base: string): void;
  enregistrer(opts: { path: string; force: boolean }): Promise<unknown>;
  mettreEnPage(): void;
  gitAutoRefresh(): void;
  chargerQuota(): unknown;
}

/** Identité disque déjà traitée par chemin : sha256, sinon mtime (ou l'état « missing », « not_file »…). */
type CleDisque = string | number | null | undefined;

const SONDAGE_MS = 30_000;
const GROS_FICHIER = 20 * 1024 * 1024;

/** mtime de la version disque lue dans `X-Mtime`, sinon null. */
export function mtimeDe(res: Response | null): number | null {
  try {
    const mt = res?.headers.get("X-Mtime");
    return mt ? parseFloat(mt) : null;
  } catch {
    return null;
  }
}

/** sha256 hexadécimal lu dans `X-Sha256`, sinon null. */
export function shaDe(res: Response | null): string | null {
  try {
    const h = res?.headers.get("X-Sha256");
    return h && /^[0-9a-f]{64}$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

function nomDe(chemin: string): string {
  return chemin.split("/").pop() ?? chemin;
}

export function setupEditorDisk<Mo extends ModeleTexte>(
  refs: RefsDisque<Mo>,
  ctx: CtxDisque,
  r: RappelsDisque<Mo>,
) {
  const { showToast, fetchAuth, openConfirm } = ctx;
  const { openTabs, activeTabPath, isEditorDirty, isDiffView, diskConflicts, assistantStash } = refs;

  const fileMtimes = ref<Record<string, number>>({});
  const fileShas: Record<string, string> = Object.create(null) as Record<string, string>;
  const fileFormats = reactive<Record<string, FormatDisque>>({});
  const _handledDiskMtime: Record<string, CleDisque> = Object.create(null) as Record<string, CleDisque>;
  let minuterieSondage: ReturnType<typeof setInterval> | null = null;
  let minuterieBientot: ReturnType<typeof setTimeout> | null = null;

  function _mapSet<T>(cible: Ref<Record<string, T>>, chemin: string, valeur: T | null): void {
    const suivant = { ...cible.value };
    if (valeur == null) delete suivant[chemin];
    else suivant[chemin] = valeur;
    cible.value = suivant;
  }

  function _setBaseMtime(chemin: string, mtime: unknown): void {
    if (!chemin) return;
    if (typeof mtime === "number" && Number.isFinite(mtime)) fileMtimes.value[chemin] = mtime;
    else delete fileMtimes.value[chemin];
  }
  function _setBase(chemin: string, mtime: number | null | undefined, sha: string | null | undefined): void {
    _setBaseMtime(chemin, mtime);
    if (sha) fileShas[chemin] = sha;
    else delete fileShas[chemin];
    if (sha || mtime != null) _handledDiskMtime[chemin] = sha || (mtime as number);
  }
  function _dropBase(chemin: string): void {
    delete fileMtimes.value[chemin];
    delete fileShas[chemin];
    delete fileFormats[chemin];
    delete _handledDiskMtime[chemin];
  }
  /** Format disque de l'onglet ; un décodage avec perte passe l'onglet en lecture seule (sinon U+FFFD serait enregistré). */
  function _setFormat(chemin: string, lu: LectureDisque | null | undefined): void {
    if (!lu) return;
    fileFormats[chemin] = { bom: !!lu.bom, eol: lu.eol || null, lossy: !!lu.lossy };
    if (lu.lossy) {
      refs.readOnlyTabs.value.add(chemin);
      if (activeTabPath.value === chemin) r.appliquerLectureSeule();
    }
  }
  /** Aligne la fin de ligne du modèle sur celle du disque (`pushEOL` : annulable). */
  function _syncModelEol(modele: ModeleTexte | null | undefined, eol: string | null | undefined): void {
    if (!modele || (eol !== "lf" && eol !== "crlf")) return;
    try {
      const fins = r.finsDeLigne();
      const voulu = eol === "crlf" ? fins.CRLF : fins.LF;
      const courant = modele.getEOL() === "\r\n" ? fins.CRLF : fins.LF;
      if (courant !== voulu) modele.pushEOL(voulu);
    } catch {
      /* modèle libéré */
    }
  }
  /** Le modèle reflète exactement la version disque décrite : référence, base de précondition, format, conflit levé. */
  function _adoptDisk(
    chemin: string,
    disque: LectureDisque & { mtime?: number | null; sha?: string | null },
  ): void {
    const m = refs.modeles.table[chemin];
    if (m && refs.modeles.ok(chemin)) refs.originalFileContent[chemin] = m.getValue();
    _setBase(chemin, disque.mtime, disque.sha);
    _setFormat(chemin, disque);
    _mapSet(diskConflicts, chemin, null);
  }

  async function _checkExternalMods(): Promise<void> {
    // Un enregistrement en vol ou un flux de l'assistant exclut l'onglet : sa base date d'avant.
    const chemins = openTabs.value
      .map((t) => t.path)
      .filter(
        (p) =>
          (fileMtimes.value[p] !== undefined || fileShas[p]) &&
          !r.enregistrementEnCours(p) &&
          !r.fluxActif(p),
      );
    if (chemins.length === 0) return;
    try {
      const res = await fetchAuth(
        "/api/sandbox/check-mtimes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: chemins.map((p) => {
              const mt = fileMtimes.value[p];
              const f: { path: string; mtime: number; sha256?: string } = {
                path: p,
                mtime: typeof mt === "number" ? mt : -1,
              };
              const sha = fileShas[p];
              if (sha) f.sha256 = sha;
              return f;
            }),
          }),
        },
        true,
      );
      if (!res || !res.ok) return;
      const data = await lireJson(res, schemaVerification);
      if (!data) return;
      const fermes: string[] = [];
      for (const item of data.stale) {
        // Même contenu, date seule changée : la base avance en silence.
        if (item.sha256 && fileShas[item.path] && item.sha256 === fileShas[item.path]) {
          _setBase(item.path, item.new_mtime, item.sha256);
          continue;
        }
        const cle = item.missing
          ? "missing"
          : item.not_file
            ? "not_file"
            : item.unreadable
              ? "unreadable"
              : item.sha256 || item.new_mtime;
        if (_handledDiskMtime[item.path] === cle) continue;
        _handledDiskMtime[item.path] = cle;
        _handleExternalMod(item, fermes);
      }
      if (fermes.length) {
        showToast(
          fermes.length === 1
            ? `« ${fermes[0]} » n'existe plus sur le disque : onglet fermé`
            : `${fermes.length} fichiers n'existent plus sur le disque : onglets fermés`,
          "info",
        );
      }
    } catch {
      /* silencieux */
    }
  }

  /** Vérification regroupée « bientôt » (après une commande shell, une action Git, une rafale du terminal). */
  function checkExternalModsSoon(delai?: number | null): void {
    if (minuterieBientot) clearTimeout(minuterieBientot);
    minuterieBientot = setTimeout(
      () => {
        minuterieBientot = null;
        void _checkExternalMods();
      },
      delai == null ? 400 : delai,
    );
  }

  function _handleExternalMod(item: Perime, fermes: string[] | null): void {
    const nom = nomDe(item.path);
    if (item.missing || item.not_file) {
      // Onglet modifié : bandeau (Enregistrer recréera) ; onglet propre : fermé.
      if (r.estModifie(item.path)) {
        _mapSet(diskConflicts, item.path, { mtime: null, missing: true });
      } else {
        void r.fermerOnglet(item.path, null, true);
        if (fermes) fermes.push(nom);
        else showToast(`« ${nom} » n'existe plus sur le disque : onglet fermé`, "info");
      }
      return;
    }
    if (item.unreadable) {
      showToast(`« ${nom} » n'est plus lisible (droits) : enregistrement impossible`, "error");
      return;
    }
    const mode = r.modeVue(item.path);
    if (mode === "office") {
      _setBase(item.path, item.new_mtime, item.sha256 || null);
      if (activeTabPath.value === item.path) void r.ouvrirOffice(item.path, { force: true });
      return;
    }
    if (mode === "image" || mode === "hex") {
      _setBase(item.path, item.new_mtime, item.sha256 || null);
      if (activeTabPath.value === item.path) void r.ouvrirFichier(item.path, true);
      return;
    }
    if (mode !== "monaco") return;
    // Onglet modifié ou gros fichier : bandeau ; onglet propre : rechargement silencieux.
    if (r.estModifie(item.path) || (item.size ?? 0) > GROS_FICHIER) {
      _mapSet(diskConflicts, item.path, { mtime: item.new_mtime, missing: false });
    } else {
      void _reloadFromDisk(item.path, { quiet: true });
    }
  }

  /** Recharge un onglet texte depuis le disque par édition minimale, sans changer l'onglet actif ; vrai si le modèle reflète le disque. */
  async function _reloadFromDisk(chemin: string, opts?: { quiet?: boolean }): Promise<boolean> {
    const o = opts || {};
    if (!refs.modeles.ok(chemin) || r.fluxActif(chemin)) return false;
    // Silencieux : un onglet devenu modifié pendant le téléchargement n'est pas écrasé.
    const etaitModifie = r.estModifie(chemin);
    try {
      const res = await fetchAuth(r.url("download?path=") + encodeURIComponent(chemin), {}, true);
      if (!res || !res.ok) {
        if (!o.quiet) showToast("Rechargement impossible", "error");
        return false;
      }
      const mt = mtimeDe(res);
      const sha = shaDe(res);
      const lu = await r.lireTexte(res);
      if (lu.binary || !refs.modeles.ok(chemin) || r.fluxActif(chemin)) return false;
      if (o.quiet && !etaitModifie && r.estModifie(chemin)) {
        _mapSet(diskConflicts, chemin, { mtime: mt, missing: false });
        if (mt != null) _handledDiskMtime[chemin] = sha || mt;
        return false;
      }
      const modele = refs.modeles.table[chemin] as Mo;
      _syncModelEol(modele, lu.eol);
      const courant = modele.getValue();
      const texte = lu.text ?? "";
      if (courant !== texte) r.editionMinimale(modele, courant, texte);
      _adoptDisk(chemin, { ...lu, mtime: mt, sha });
      if (activeTabPath.value === chemin) {
        isEditorDirty.value = false;
        if (isDiffView.value) r.majDiff();
      }
      r.rafraichirModifies();
      r.rafraichirScm(chemin);
      return true;
    } catch {
      if (!o.quiet) showToast("Rechargement impossible", "error");
      return false;
    }
  }

  /** Contenu disque actuel pour une comparaison ; chaîne vide si absent, null si illisible. */
  async function _fetchDiskText(chemin: string): Promise<string | null> {
    try {
      const res = await fetchAuth(r.url("download?path=") + encodeURIComponent(chemin), {}, true);
      if (!res || !res.ok) return res && res.status === 404 ? "" : null;
      const lu = await r.lireTexte(res);
      return lu.binary ? null : (lu.text ?? "");
    } catch {
      return null;
    }
  }

  async function conflictReload(chemin?: string | null): Promise<void> {
    const p = chemin || activeTabPath.value;
    if (!p) return;
    if (r.estModifie(p)) {
      const ok = await openConfirm(
        "Recharger depuis le disque ?",
        "Vos modifications non enregistrées de « " + nomDe(p) + " » seront remplacées.",
        true,
        "Recharger",
      );
      if (!ok) return;
    }
    if (isDiffView.value && activeTabPath.value === p) isDiffView.value = false;
    await _reloadFromDisk(p);
  }
  async function conflictCompare(chemin?: string | null): Promise<void> {
    const p = chemin || activeTabPath.value;
    if (!p) return;
    const disque = await _fetchDiskText(p);
    if (disque === null) {
      showToast("Version disque illisible", "error");
      return;
    }
    r.comparer(p, disque, "disk");
  }
  async function conflictOverwrite(chemin?: string | null): Promise<void> {
    const p = chemin || activeTabPath.value;
    if (!p) return;
    await r.enregistrer({ path: p, force: true });
    // Conflit tranché : la comparaison avec l'ancienne version disque n'a plus d'objet.
    if (
      !diskConflicts.value[p] &&
      isDiffView.value &&
      refs.diffBase.value === "disk" &&
      activeTabPath.value === p
    ) {
      isDiffView.value = false;
      refs.diffBase.value = "saved";
      void nextTick(() => r.mettreEnPage());
    }
  }
  function conflictDismiss(chemin?: string | null): void {
    const p = chemin || activeTabPath.value;
    if (p) _mapSet(diskConflicts, p, null);
  }

  function stashRestore(chemin?: string | null): void {
    const p = chemin || activeTabPath.value;
    if (!p) return;
    const copie = assistantStash.value[p];
    const modele = refs.modeles.table[p];
    if (!copie || !modele || !refs.modeles.ok(p)) {
      _mapSet(assistantStash, p, null);
      return;
    }
    r.editionMinimale(modele, modele.getValue(), copie.content);
    _mapSet(assistantStash, p, null);
    if (activeTabPath.value === p) isEditorDirty.value = r.estModifie(p);
    if (isDiffView.value && activeTabPath.value === p) isDiffView.value = false;
    r.rafraichirModifies();
    showToast("Vos modifications sont restaurées (non enregistrées)");
  }
  function stashCompare(chemin?: string | null): void {
    const p = chemin || activeTabPath.value;
    const copie = p ? assistantStash.value[p] : undefined;
    if (!p || !copie) return;
    r.comparer(p, copie.content, "stash");
  }
  function stashDismiss(chemin?: string | null): void {
    const p = chemin || activeTabPath.value;
    if (p) _mapSet(assistantStash, p, null);
    if (isDiffView.value && refs.diffBase.value === "stash") isDiffView.value = false;
  }

  /** Bandeau de l'onglet actif, le plus urgent d'abord. */
  const activeBanner: ComputedRef<Bandeau | null> = computed(() => {
    const p = activeTabPath.value;
    if (!p) return null;
    if (assistantStash.value[p]) return { kind: "stash", path: p };
    const c = diskConflicts.value[p];
    if (c) return { kind: c.missing ? "missing" : "disk", path: p };
    if (fileFormats[p]?.lossy) return { kind: "encoding", path: p };
    return null;
  });

  function _stopMtimeChecks(): void {
    if (minuterieSondage) {
      clearInterval(minuterieSondage);
      minuterieSondage = null;
    }
  }
  /** Sondage périodique (30 s), seulement quand la page est visible. */
  function _startMtimeChecks(): void {
    _stopMtimeChecks();
    minuterieSondage = setInterval(() => {
      if (document.visibilityState === "visible") void _checkExternalMods();
    }, SONDAGE_MS);
  }

  // Retour sur la fenêtre (fichier touché depuis un terminal) : vérification immédiate, connecté seulement.
  const auFocus = (): void => {
    if (!refs.user.value) return;
    void _checkExternalMods();
    if (refs.showEditor.value) r.gitAutoRefresh();
    if (refs.showEditor.value) void r.chargerQuota();
  };
  window.addEventListener("focus", auFocus);

  /** Arrête sondage, vérification différée et écoute du focus. */
  function libererDisque(): void {
    _stopMtimeChecks();
    if (minuterieBientot) clearTimeout(minuterieBientot);
    minuterieBientot = null;
    window.removeEventListener("focus", auFocus);
  }

  return {
    fileMtimes,
    fileShas,
    fileFormats,
    _handledDiskMtime,
    _mapSet,
    _mtimeOf: mtimeDe,
    _shaOf: shaDe,
    _setBaseMtime,
    _setBase,
    _dropBase,
    _setFormat,
    _syncModelEol,
    _adoptDisk,
    _checkExternalMods,
    checkExternalModsSoon,
    _handleExternalMod,
    _reloadFromDisk,
    _fetchDiskText,
    conflictReload,
    conflictCompare,
    conflictOverwrite,
    conflictDismiss,
    stashRestore,
    stashCompare,
    stashDismiss,
    activeBanner,
    _startMtimeChecks,
    _stopMtimeChecks,
    libererDisque,
  };
}
