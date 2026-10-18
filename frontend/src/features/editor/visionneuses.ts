// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/visionneuses.ts — visionneuses de l'éditeur sans modèle Monaco : mode d'affichage par fichier, image, hexadécimal, lecture seule, aperçus Office et PDF (`/office/prepare`, passe complète suivie, grille xlsx par morceaux). */
import { computed, ref, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import { schemaErreurApi, schemaReponsePreparerApercu } from "@elpis/contracts";
import type { z } from "zod";

import {
  errorLabel,
  isViewerMode,
  officeKind,
  parseContentRange,
  viewModeForPath,
} from "../../utils/office-model";
import type { GenreOffice, ModeVue } from "../../utils/office-model";
import { lireTete, vidageHex } from "./lecture";
import type { LigneHex } from "./lecture";

type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

type Preparation = z.infer<typeof schemaReponsePreparerApercu>;
type PagesApercu = NonNullable<Preparation["pages"]>;
type GrilleApercu = NonNullable<Preparation["grid"]>;

export interface DocOffice {
  status: "loading" | "ready" | "error";
  kind: string | null | undefined;
  view: string | null | undefined;
  spin: boolean;
  startedAt?: number;
  key: string | null | undefined;
  pdfUrl: string | null | undefined;
  pages: PagesApercu | null;
  grid: GrilleApercu | null;
  has: Record<string, unknown>;
  error: { code: string; message: string } | null;
  reloadSeq: number;
}

export interface DonneesHex {
  bytes: Uint8Array;
  path: string;
  size: number;
}

interface EditeurLectureSeule {
  updateOptions(o: { readOnly: boolean }): void;
}

interface Onglet {
  path: string;
}

export interface RefsVisionneuses {
  openTabs: Ref<Onglet[]>;
  activeTabPath: Ref<string | null>;
  settings: Ref<{ enable_editor?: boolean; auto_open_editor_on_write?: boolean; [cle: string]: unknown }>;
  showEditor: Ref<boolean>;
  features?: Ref<{ office_preview?: boolean; [cle: string]: unknown } | null | undefined> | undefined;
  readonly monacoRef: { instance: EditeurLectureSeule | null };
}

export interface CtxVisionneuses {
  fetchAuth: FetchAuth;
  showToast(message: string, type?: string): void;
}

export interface RappelsVisionneuses {
  url(endpoint: string): string;
  fermerOnglet(chemin: string, ev: null, force: boolean): unknown;
  ouvrirFichier(chemin: string, force: boolean): Promise<unknown>;
  poserMtime(chemin: string, mtime: unknown): void;
  canonique(chemin: string): string;
}

const SPIN_MS = 400;
const TRANSITOIRES = ["busy", "timeout", "network", "changed"];
const SUIVI_PDF_MS = 2500;
const SUIVI_PDF_MAX = 120;

function avec(r: Ref<Set<string>>, x: string): void {
  if (r.value.has(x)) return;
  const s = new Set(r.value);
  s.add(x);
  r.value = s;
}
function sans(r: Ref<Set<string>>, x: string): void {
  if (!r.value.has(x)) return;
  const s = new Set(r.value);
  s.delete(x);
  r.value = s;
}

/** Préparation lue d'une réponse de succès, ou le `detail` d'une réponse d'erreur. */
type LecturePreparation = { data: Preparation; detail?: undefined } | { data: null; detail: unknown };

async function lirePreparation(res: Response | null): Promise<LecturePreparation> {
  if (!res) return { data: null, detail: undefined };
  try {
    const brut: unknown = await res.json();
    const r = schemaReponsePreparerApercu.safeParse(brut);
    if (r.success) return { data: r.data };
    return { data: null, detail: schemaErreurApi.safeParse(brut).data?.detail };
  } catch {
    return { data: null, detail: undefined };
  }
}

export function setupEditorViewers(refs: RefsVisionneuses, ctx: CtxVisionneuses, r: RappelsVisionneuses) {
  const { fetchAuth, showToast } = ctx;
  const { openTabs, activeTabPath } = refs;

  const binaryPaths = ref<Set<string>>(new Set());
  const officeTextFallback = ref<Set<string>>(new Set());
  const imageViewerPath = ref("");
  const hexViewerData = ref<DonneesHex | null>(null);
  const hexViewerLoading = ref(false);
  const readOnlyTabs = ref<Set<string>>(new Set());
  const _binaryRefused = new Set<string>();

  function _officeFeatureOn(): boolean {
    const f = refs.features?.value;
    return !f || f.office_preview !== false;
  }
  function _resolveFileViewMode(chemin: string | null | undefined): ModeVue {
    return viewModeForPath(chemin ?? "", {
      officeEnabled: _officeFeatureOn(),
      binaryPaths: binaryPaths.value,
      textFallback: officeTextFallback.value,
    });
  }
  const activeFileViewMode = computed(() => _resolveFileViewMode(activeTabPath.value));
  const activeIsViewer = computed(() => isViewerMode(activeFileViewMode.value));
  function officeIsViewerPath(chemin: string | null | undefined): boolean {
    return !!chemin && isViewerMode(_resolveFileViewMode(chemin));
  }

  function _isReadOnlyTab(chemin: string | null | undefined): boolean {
    return !!chemin && readOnlyTabs.value.has(chemin);
  }
  /** Réapplique `readOnly` à l'onglet actif après une mutation de `readOnlyTabs`. */
  function _applyActiveReadOnly(): void {
    const ed = refs.monacoRef.instance;
    if (!ed) return;
    try {
      ed.updateOptions({ readOnly: _isReadOnlyTab(activeTabPath.value) });
    } catch {
      /* éditeur libéré */
    }
  }
  watch(activeTabPath, () => _applyActiveReadOnly());

  const hexViewerLines: ComputedRef<LigneHex[]> = computed(() =>
    hexViewerData.value?.bytes ? vidageHex(hexViewerData.value.bytes, 4096) : [],
  );
  // Séquence et onglet actif : une lecture lente ne s'affiche jamais dans un autre onglet.
  let hexSeq = 0;
  /** 4 premiers Ko (Range), taille totale lue dans Content-Range. */
  async function _openHex(chemin: string): Promise<void> {
    const seq = ++hexSeq;
    hexViewerLoading.value = true;
    try {
      const res = await fetchAuth(r.url("download?path=") + encodeURIComponent(chemin), {
        headers: { Range: "bytes=0-4095" },
      });
      if (res && res.ok) {
        const plage = parseContentRange(res.headers.get("Content-Range"));
        const octets = await lireTete(res, 4096);
        let taille = plage && plage.total != null ? plage.total : null;
        if (taille == null && res.status === 200)
          taille = Number(res.headers.get("Content-Length")) || octets.length;
        if (seq === hexSeq && activeTabPath.value === chemin) {
          hexViewerData.value = {
            bytes: octets,
            path: chemin,
            size: taille == null ? octets.length : taille,
          };
        }
      } else if (seq === hexSeq) {
        showToast("Lecture binaire échouée", "error");
      }
    } catch {
      if (seq === hexSeq) showToast("Erreur lecture binaire", "error");
    } finally {
      if (seq === hexSeq) hexViewerLoading.value = false;
    }
  }

  // Aperçus Office : une requête par onglet (AbortController + séquence), aperçu prêt gardé pendant la revalidation.
  const officeDocs = ref<Record<string, DocOffice>>({});
  const officeNow = ref(Date.now());
  const controles: Record<
    string,
    { ac: AbortController; seq: number; spin: ReturnType<typeof setTimeout> | null }
  > = Object.create(null) as Record<
    string,
    { ac: AbortController; seq: number; spin: ReturnType<typeof setTimeout> | null }
  >;
  const suivisPdf: Record<string, { key: string; n: number; timer: ReturnType<typeof setTimeout> | null }> =
    Object.create(null) as Record<
      string,
      { key: string; n: number; timer: ReturnType<typeof setTimeout> | null }
    >;
  let seqOffice = 0;
  let horloge: ReturnType<typeof setInterval> | null = null;

  const officeActive = computed<DocOffice | null>(() => {
    const p = activeTabPath.value;
    if (!p || activeFileViewMode.value !== "office") return null;
    return officeDocs.value[p] ?? null;
  });

  /** Horloge « Conversion… N s » : ne tourne que pendant un chargement long. */
  function synchroniserHorloge(): void {
    const tourne = Object.values(officeDocs.value).some((e) => e.status === "loading" && e.spin);
    if (tourne && !horloge) {
      officeNow.value = Date.now();
      horloge = setInterval(() => {
        officeNow.value = Date.now();
      }, 1000);
    } else if (!tourne && horloge) {
      clearInterval(horloge);
      horloge = null;
    }
  }
  function poser(chemin: string, entree: DocOffice | null): void {
    const suivant = { ...officeDocs.value };
    if (entree) suivant[chemin] = entree;
    else delete suivant[chemin];
    officeDocs.value = suivant;
    synchroniserHorloge();
  }
  function _officeAbort(chemin: string): void {
    const c = controles[chemin];
    if (!c) return;
    if (c.spin) clearTimeout(c.spin);
    delete controles[chemin];
    c.ac.abort();
  }
  function arreterSuiviPdf(chemin: string): void {
    const s = suivisPdf[chemin];
    if (s?.timer) clearTimeout(s.timer);
    delete suivisPdf[chemin];
  }
  function _officeForget(chemin: string): void {
    _officeAbort(chemin);
    arreterSuiviPdf(chemin);
    if (officeDocs.value[chemin]) poser(chemin, null);
  }
  function _officeResetAll(): void {
    Object.keys(controles).forEach(_officeAbort);
    Object.keys(suivisPdf).forEach(arreterSuiviPdf);
    officeDocs.value = {};
    synchroniserHorloge();
  }

  function preparer(chemin: string, vue: string, signal?: AbortSignal): Promise<Response | null> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: chemin, view: vue }),
    };
    if (signal) init.signal = signal;
    return fetchAuth(r.url("office/prepare"), init, true);
  }

  /** Document lourd : les premières pages arrivent d'abord, le manifeste est relu jusqu'à la version complète. */
  function suivrePdfComplet(chemin: string, cle: string): void {
    if (suivisPdf[chemin]?.key === cle) return;
    arreterSuiviPdf(chemin);
    const suivi: { key: string; n: number; timer: ReturnType<typeof setTimeout> | null } = {
      key: cle,
      n: 0,
      timer: null,
    };
    suivisPdf[chemin] = suivi;
    const tic = async (): Promise<void> => {
      suivi.timer = null;
      const doc = officeDocs.value[chemin];
      if (!doc || doc.key !== cle || doc.view !== "pages" || !openTabs.value.some((t) => t.path === chemin)) {
        arreterSuiviPdf(chemin);
        return;
      }
      if (++suivi.n > SUIVI_PDF_MAX) {
        arreterSuiviPdf(chemin);
        return;
      }
      let data: Preparation | null = null;
      try {
        const res = await preparer(chemin, "pages");
        if (res && res.ok) data = (await lirePreparation(res)).data;
      } catch {
        data = null;
      }
      const cur = officeDocs.value[chemin];
      if (!cur || cur.key !== cle || suivisPdf[chemin] !== suivi) {
        if (suivisPdf[chemin] === suivi) arreterSuiviPdf(chemin);
        return;
      }
      if (data?.pages && data.key === cle && !data.pages.partial) {
        poser(chemin, { ...cur, pages: data.pages, pdfUrl: data.pages.url });
        arreterSuiviPdf(chemin);
        return;
      }
      suivi.timer = setTimeout(() => void tic(), SUIVI_PDF_MS);
    };
    suivi.timer = setTimeout(() => void tic(), SUIVI_PDF_MS);
  }

  async function officeOpen(
    chemin: string,
    opts?: { view?: string; force?: boolean; reload?: boolean },
  ): Promise<void> {
    const o = opts || {};
    const genre: GenreOffice | null = officeKind(chemin);
    if (!chemin || !genre) return;
    const prec = officeDocs.value[chemin] ?? null;
    const vue = o.view || prec?.view || (genre === "xlsx" ? "grid" : "pages");
    _officeAbort(chemin);
    const ctl = {
      ac: new AbortController(),
      seq: ++seqOffice,
      spin: null as ReturnType<typeof setTimeout> | null,
    };
    controles[chemin] = ctl;
    const garderPret = !!(prec && prec.status === "ready" && prec.view === vue);
    if (!garderPret) {
      poser(chemin, {
        status: "loading",
        kind: genre,
        view: vue,
        spin: false,
        startedAt: Date.now(),
        key: null,
        pdfUrl: null,
        pages: null,
        grid: null,
        has: prec?.has ?? {},
        error: null,
        reloadSeq: prec ? prec.reloadSeq : 0,
      });
      ctl.spin = setTimeout(() => {
        const cur = officeDocs.value[chemin];
        if (controles[chemin] === ctl && cur && cur.status === "loading")
          poser(chemin, { ...cur, spin: true });
      }, SPIN_MS);
    }
    let res: Response | null;
    try {
      res = await preparer(chemin, vue, ctl.ac.signal);
    } catch {
      res = null;
    }
    const { data, detail } = await lirePreparation(res);
    // Abandonnée (onglet fermé, changement de vue, déconnexion) ou supplantée.
    if (controles[chemin] !== ctl || ctl.ac.signal.aborted) return;
    if (ctl.spin) clearTimeout(ctl.spin);
    delete controles[chemin];
    if (!openTabs.value.some((t) => t.path === chemin)) {
      poser(chemin, null);
      return;
    }
    const cur = officeDocs.value[chemin] ?? null;
    if (res && res.ok && data && data.key) {
      try {
        r.poserMtime(chemin, data.mtime);
      } catch {
        /* base optionnelle */
      }
      const meme = !!(cur && cur.status === "ready" && cur.key === data.key && cur.view === data.view);
      if (meme && !o.reload) return;
      poser(chemin, {
        status: "ready",
        kind: data.kind,
        view: data.view,
        spin: false,
        key: data.key,
        has: data.has ?? {},
        pdfUrl: data.pages ? data.pages.url : null,
        pages: data.pages ?? null,
        grid: data.grid ?? null,
        error: null,
        reloadSeq: (cur ? cur.reloadSeq : 0) + (o.reload ? 1 : 0),
      });
      if (data.pages?.partial) suivrePdfComplet(chemin, data.key);
      return;
    }
    const objet =
      detail && typeof detail === "object" ? (detail as { code?: unknown; message?: unknown }) : null;
    let code = typeof objet?.code === "string" ? objet.code : "";
    const message = typeof objet?.message === "string" ? objet.message : "";
    if (!res) code = "network";
    else if (!code) code = res.status === 404 ? "not_found" : "failed";
    if (code === "not_found") {
      showToast("Fichier introuvable : " + (chemin.split("/").pop() ?? chemin), "error");
      void r.fermerOnglet(chemin, null, true);
      return;
    }
    // Revalidation en échec passager : l'aperçu affiché reste.
    if (cur && cur.status === "ready" && TRANSITOIRES.includes(code)) return;
    poser(chemin, {
      status: "error",
      kind: genre,
      view: vue,
      spin: false,
      key: null,
      pdfUrl: null,
      pages: null,
      grid: null,
      has: cur?.has ?? {},
      error: { code, message: message || errorLabel(code) },
      reloadSeq: cur ? cur.reloadSeq : 0,
    });
  }

  function officeSetView(vue: string): void {
    const p = activeTabPath.value;
    if (p && officeActive.value && officeActive.value.view !== vue) void officeOpen(p, { view: vue });
  }
  function officeReload(): void {
    const p = activeTabPath.value;
    if (p) void officeOpen(p, { force: true, reload: true });
  }
  /** Repli texte d'un docx quand LibreOffice manque. */
  function officeUseText(): void {
    const p = activeTabPath.value;
    if (!p || officeKind(p) !== "docx") return;
    _officeForget(p);
    avec(officeTextFallback, p);
    void r.ouvrirFichier(p, true);
  }

  /** Taille réelle de la feuille annoncée par les en-têtes d'un morceau, appliquée au document affiché. */
  function appliquerTailleFeuille(cle: string, feuille: number, entetes: Headers): void {
    const lignes = parseInt(entetes.get("X-Office-Rows") || "", 10);
    const colonnes = parseInt(entetes.get("X-Office-Cols") || "", 10);
    if (!Number.isFinite(lignes) || lignes <= 0) return;
    const p = activeTabPath.value;
    const doc = p ? officeDocs.value[p] : null;
    if (!p || !doc || doc.key !== cle || !doc.grid) return;
    const feuilles = doc.grid.sheets;
    const f = feuilles[feuille];
    if (!f || (f.rows === lignes && (!Number.isFinite(colonnes) || f.cols === colonnes))) return;
    const suivantes = feuilles.slice();
    suivantes[feuille] = {
      ...f,
      rows: lignes,
      cols: Number.isFinite(colonnes) && colonnes > 0 ? Math.max(colonnes, f.cols || 0) : f.cols,
    };
    poser(p, { ...doc, grid: { ...doc.grid, sheets: suivantes } });
  }

  /** Morceau de grille xlsx (appelé par GrilleOffice) ; un 404 (cache serveur élagué) reprépare l'onglet actif. */
  async function officeFetchChunk(
    cle: string,
    feuille: number,
    morceau: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const res = await fetchAuth(
      r.url("office/sheet/" + cle + "/" + feuille + "/" + morceau),
      { signal },
      true,
    );
    if (res && res.ok) {
      appliquerTailleFeuille(cle, feuille, res.headers);
      return res.json();
    }
    if (res && res.status === 404) {
      const p = activeTabPath.value;
      if (p && !signal.aborted) void officeOpen(p, { force: true });
    }
    throw new Error("office-chunk");
  }

  /** Un outil a écrit un fichier affiché par une visionneuse : l'aperçu est rafraîchi au lieu d'injecter le contenu. */
  async function editorRefreshViewer(chemin: string): Promise<void> {
    const p = r.canonique(chemin);
    if (!p || !refs.settings.value.enable_editor) return;
    if (openTabs.value.some((t) => t.path === p)) {
      if (activeTabPath.value === p) await r.ouvrirFichier(p, true);
      return;
    }
    if (!refs.showEditor.value && refs.settings.value.auto_open_editor_on_write === false) return;
    await r.ouvrirFichier(p, true);
  }

  /** Oublie l'état de visionneuse d'un onglet fermé. */
  function oublierVisionneuse(chemin: string): void {
    if (imageViewerPath.value && imageViewerPath.value.includes(encodeURIComponent(chemin)))
      imageViewerPath.value = "";
    if (hexViewerData.value && hexViewerData.value.path === chemin) hexViewerData.value = null;
    _officeForget(chemin);
    sans(binaryPaths, chemin);
    sans(officeTextFallback, chemin);
    _binaryRefused.delete(chemin);
  }

  // Filet : un onglet retiré autrement que par closeTab ne laisse ni requête en vol, ni aperçu, ni marque binaire.
  watch(
    () => openTabs.value.map((t) => t.path).join("\n"),
    () => {
      const ouverts = new Set(openTabs.value.map((t) => t.path));
      Object.keys(controles).forEach((p) => {
        if (!ouverts.has(p)) _officeAbort(p);
      });
      Object.keys(officeDocs.value).forEach((p) => {
        if (!ouverts.has(p)) _officeForget(p);
      });
      for (const s of [binaryPaths, officeTextFallback]) {
        if ([...s.value].some((p) => !ouverts.has(p)))
          s.value = new Set([...s.value].filter((p) => ouverts.has(p)));
      }
      _binaryRefused.forEach((p) => {
        if (!ouverts.has(p)) _binaryRefused.delete(p);
      });
    },
  );

  /** Déconnexion et libération : requêtes en vol, aperçus, marques binaires, octets hexadécimaux (rien ne passe au compte suivant). */
  function _resetViewersState(): void {
    _officeResetAll();
    binaryPaths.value = new Set();
    officeTextFallback.value = new Set();
    _binaryRefused.clear();
    hexSeq++;
    hexViewerData.value = null;
    hexViewerLoading.value = false;
    imageViewerPath.value = "";
  }

  return {
    binaryPaths,
    officeTextFallback,
    _binaryRefused,
    _resolveFileViewMode,
    activeFileViewMode,
    activeIsViewer,
    officeIsViewerPath,
    _setWith: avec,
    _setWithout: sans,
    imageViewerPath,
    hexViewerData,
    hexViewerLoading,
    hexViewerLines,
    readOnlyTabs,
    _isReadOnlyTab,
    _applyActiveReadOnly,
    _openHex,
    officeDocs,
    officeNow,
    officeActive,
    officeOpen,
    officeSetView,
    officeReload,
    officeUseText,
    officeFetchChunk,
    editorRefreshViewer,
    oublierVisionneuse,
    _officeForget,
    _resetViewersState,
  };
}
