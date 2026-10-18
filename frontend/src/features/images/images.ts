// SPDX-License-Identifier: MIT
/** frontend/src/features/images/images.ts — mode « Images » du chat : options du composeur, statut du moteur, préférences du compte, visionneuse et galerie. */
import { computed, nextTick, reactive, ref, watch } from "vue";
import type { Ref } from "vue";

import type { ApiImages, StatutMoteurImages } from "./api.ts";
import {
  IMAGE_BASE_RATIOS,
  IMAGE_RATIOS_ALL,
  analyserTaille,
  imageBaseRatio,
  imageFileName,
  imageFlipRatio,
  imageFmtSec,
  imageIsPortrait,
  imagePickFixed,
  imageRatioName,
  imageRequestLabel,
  imageSizeFor,
  imageSizeLabel,
  imageInitialProgress,
  isImageMessage,
  normalizeImagePrefs,
  ratioParts,
} from "./formats.ts";
import type { DemandeImage, PreferencesImages } from "./formats.ts";
import { definirApiImages } from "./partage.ts";
import type { ImageAffichee, InfosVisionneuse } from "./partage.ts";

export interface OptionsToast {
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
  onExpire?: () => unknown;
}

export interface PieceJointeImage {
  isImage?: boolean;
  [cle: string]: unknown;
}

export interface ReglagesImages {
  image_ready?: boolean;
  image_enabled?: boolean;
  image_prefs?: PreferencesImages | Record<string, unknown>;
  [cle: string]: unknown;
}

export interface RefsImages {
  settings: Ref<ReglagesImages>;
  isStreaming?: Ref<boolean>;
  attachedFiles?: Ref<PieceJointeImage[]>;
  currentChatId?: Ref<string | null>;
}

export interface CtxImages {
  showToast(message: string, type?: string, options?: OptionsToast): void;
  focusInput?: () => void;
  openChat?: (id: string) => unknown;
}

export interface OptionsImage {
  ratio: string;
  side: number;
  n: number;
  enhance: boolean;
  fixed: string;
  custom: boolean;
  cw: number;
  ch: number;
  seed: string | number;
  negative_prompt: string;
  steps: string | number;
  strength: number;
}

export interface VisionneuseImage {
  items: ImageAffichee[];
  idx: number;
  prompt: string;
  revised: string;
  meta: { model?: string; duration_s?: number } | null;
}

export interface GalerieImages {
  filter: "all" | "chat";
  items: ImageAffichee[];
  next: number | null;
  total: number;
  keep: number;
  loading: boolean;
  done: boolean;
  error: string;
}

const PAGE_GALERIE = 48;

interface PanierGlobal {
  __elpisImageDeletes?: Set<string>;
  __elpisImageDeleteFlush?: boolean;
}

/** Suppressions en attente, envoyées au déchargement de la page (`keepalive`) ; partagées par toutes les instances. */
function suppressionsEnAttente(): Set<string> {
  if (typeof window === "undefined") return new Set<string>();
  const w = window as unknown as PanierGlobal;
  const ensemble = (w.__elpisImageDeletes ??= new Set<string>());
  if (!w.__elpisImageDeleteFlush) {
    w.__elpisImageDeleteFlush = true;
    window.addEventListener("pagehide", () => {
      for (const id of ensemble) {
        try {
          void fetch(`/api/images/${encodeURIComponent(id)}`, {
            method: "DELETE",
            credentials: "same-origin",
            keepalive: true,
          }).catch(() => undefined);
        } catch {
          /* déchargement : rien à rattraper */
        }
      }
      ensemble.clear();
    });
  }
  return ensemble;
}

function copieSecours(t: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = t;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok: boolean;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/** Tab boucle sur les contrôles de la fenêtre (visionneuse, galerie). */
function boucleTab(e: KeyboardEvent, selecteur: string, visibles: boolean): void {
  const racine = e.currentTarget as HTMLElement | null;
  let liste = racine ? Array.from(racine.querySelectorAll<HTMLElement>(selecteur)) : [];
  if (visibles) liste = liste.filter((el) => el.offsetParent !== null);
  if (!liste.length) {
    if (visibles) e.preventDefault();
    return;
  }
  const i = liste.indexOf(document.activeElement as HTMLElement);
  let suivant = e.shiftKey ? i - 1 : i + 1;
  if (i < 0) suivant = e.shiftKey ? liste.length - 1 : 0;
  if (suivant < 0) suivant = liste.length - 1;
  if (suivant >= liste.length) suivant = 0;
  e.preventDefault();
  liste[suivant]?.focus();
}

export function creerImages(api: ApiImages, refs: RefsImages, ctx: CtxImages) {
  const { settings, isStreaming, attachedFiles, currentChatId } = refs;
  const { showToast } = ctx;

  const imageMode = ref(false);
  const imageStatus = ref<StatutMoteurImages | null>(null);
  const imagePop = ref("");
  const imageOpts = reactive<OptionsImage>({
    ratio: "1:1",
    side: 1024,
    n: 1,
    enhance: false,
    fixed: "",
    custom: false,
    cw: 1024,
    ch: 1024,
    seed: "",
    negative_prompt: "",
    steps: "",
    strength: 0.75,
  });
  const imageEditRef = ref<{ id: string; url: string; thumb_url: string } | null>(null);
  const imageViewer = ref<VisionneuseImage | null>(null);
  const etat = reactive<Record<string, string>>({});

  const imageAvailable = computed(() => {
    const s = settings.value || {};
    return !!s.image_ready && s.image_enabled !== false;
  });
  const imageSeedSet = computed(() => {
    const v = parseInt(String(imageOpts.seed).trim(), 10);
    return Number.isFinite(v) && v >= 0;
  });

  let statutLuA = 0;
  let prefsAppliquees = false;
  async function loadImageStatus(force?: boolean): Promise<StatutMoteurImages | null> {
    if (!force && imageStatus.value && Date.now() - statutLuA < 30000) return imageStatus.value;
    const st = await api.statut();
    if (st) {
      imageStatus.value = st;
      statutLuA = Date.now();
      if (!prefsAppliquees) {
        appliquerPrefs(st.prefs || (settings.value || {}).image_prefs);
        prefsAppliquees = true;
      }
    }
    return imageStatus.value;
  }

  function appliquerPrefs(p: unknown): void {
    const n = normalizeImagePrefs(p, imageStatus.value);
    imageOpts.ratio = n.ratio;
    imageOpts.side = n.side;
    imageOpts.n = n.n;
    imageOpts.enhance = n.enhance;
    const st: Partial<StatutMoteurImages> = imageStatus.value ?? {};
    if (st.size_policy === "fixed") imageOpts.fixed = imagePickFixed(st.sizes, n.ratio, n.side);
  }

  function prefsCourantes(): PreferencesImages {
    return { ratio: imageOpts.ratio, side: imageOpts.side, n: imageOpts.n, enhance: !!imageOpts.enhance };
  }

  let minuteriePrefs: ReturnType<typeof setTimeout> | null = null;
  function sauverPrefs(): void {
    const p = prefsCourantes();
    if (settings.value) settings.value.image_prefs = p;
    if (minuteriePrefs) clearTimeout(minuteriePrefs);
    minuteriePrefs = setTimeout(() => {
      minuteriePrefs = null;
      void api.enregistrerPreferences(p);
    }, 600);
  }

  watch(
    () => JSON.stringify((settings.value || {}).image_prefs || null),
    (v, avant) => {
      if (v === avant || v === "null") return;
      const p = (settings.value || {}).image_prefs;
      if (JSON.stringify(prefsCourantes()) === JSON.stringify(normalizeImagePrefs(p, imageStatus.value)))
        return;
      appliquerPrefs(p);
    },
  );
  watch(
    () => [!!(settings.value || {}).image_ready, (settings.value || {}).image_enabled !== false] as const,
    ([pret, coche]) => {
      if (pret && coche) void loadImageStatus(true);
      else if (imageMode.value) closeImageMode();
    },
  );

  const imageBaseRatios = computed(() => {
    const st: Partial<StatutMoteurImages> = imageStatus.value ?? {};
    const permis = st.ratios && st.ratios.length ? st.ratios : IMAGE_RATIOS_ALL;
    return IMAGE_BASE_RATIOS.filter((r) => permis.indexOf(r) >= 0 || permis.indexOf(imageFlipRatio(r)) >= 0);
  });
  const imageSides = computed(() => {
    const st: Partial<StatutMoteurImages> = imageStatus.value ?? {};
    const max = Number(st.max_side) || 2048;
    return (st.sides || []).filter((s) => s <= max);
  });
  const imageMaxN = computed(() => Math.max(1, Number((imageStatus.value || {}).max_n) || 1));
  const imageFeatures = computed(() => (imageStatus.value || {}).features || {});
  const imageFixedSizes = computed<unknown[]>(() => {
    const st: Partial<StatutMoteurImages> = imageStatus.value ?? {};
    return st.size_policy === "fixed" ? st.sizes || [] : [];
  });

  const pas = (): number => Number((imageStatus.value || {}).step) || 64;
  const maxSide = (): number => Number((imageStatus.value || {}).max_side) || 2048;

  /** Dimensions de la prochaine demande. */
  function imageSize(over?: { ratio?: string | null; n?: number | null }): { w: number; h: number } {
    const o = over || {};
    if (imageFixedSizes.value.length) {
      const choix =
        (o.ratio ? imagePickFixed(imageFixedSizes.value, o.ratio, imageOpts.side) : "") ||
        imageOpts.fixed ||
        imagePickFixed(imageFixedSizes.value, imageOpts.ratio, imageOpts.side);
      return analyserTaille(choix) || { w: 1024, h: 1024 };
    }
    if (imageOpts.custom && !o.ratio) {
      const p = pas();
      const mx = maxSide();
      const arr = (v: number): number => Math.min(mx, Math.max(p, Math.round((Number(v) || 1024) / p) * p));
      return { w: arr(imageOpts.cw), h: arr(imageOpts.ch) };
    }
    return imageSizeFor(o.ratio || imageOpts.ratio, Math.min(imageOpts.side, maxSide()), pas());
  }

  /** Vignette CSS d'un ratio (boîte de 14 px au plus). */
  function ratioBox(ratio: string): { width: string; height: string } {
    const p = ratioParts(ratio) || [1, 1];
    const k = 14 / Math.max(p[0], p[1]);
    return {
      width: `${Math.max(5, Math.round(p[0] * k))}px`,
      height: `${Math.max(5, Math.round(p[1] * k))}px`,
    };
  }

  function imageFormatLabel(): string {
    if (imageFixedSizes.value.length) {
      const d = imageSize();
      return `${d.w}×${d.h}`;
    }
    if (imageOpts.custom) return "Libre";
    return imageRatioName(imageOpts.ratio);
  }

  function repererTailleFixe(): void {
    if (imageFixedSizes.value.length)
      imageOpts.fixed = imagePickFixed(imageFixedSizes.value, imageOpts.ratio, imageOpts.side);
  }

  function setImageRatio(r: string): void {
    const base = imageBaseRatio(r);
    imageOpts.ratio = imageIsPortrait(imageOpts.ratio) && base !== "1:1" ? imageFlipRatio(base) : base;
    imageOpts.custom = false;
    repererTailleFixe();
    imagePop.value = "";
    sauverPrefs();
  }
  function flipImageRatio(): void {
    if (imageOpts.custom) {
      const w = imageOpts.cw;
      imageOpts.cw = imageOpts.ch;
      imageOpts.ch = w;
      return;
    }
    if (imageOpts.ratio === "1:1") return;
    imageOpts.ratio = imageFlipRatio(imageOpts.ratio);
    repererTailleFixe();
    sauverPrefs();
  }
  function setImageSide(v: unknown): void {
    const n = parseInt(String(v), 10);
    if (!n) return;
    imageOpts.side = n;
    sauverPrefs();
  }
  function setImageFixed(size: string): void {
    const d = analyserTaille(size);
    if (!d) return;
    imageOpts.fixed = `${d.w}x${d.h}`;
    let best = imageOpts.ratio;
    let ecart = Infinity;
    for (const r of IMAGE_RATIOS_ALL) {
      const p = ratioParts(r);
      if (!p) continue;
      const e = Math.abs(Math.log(d.w / d.h / (p[0] / p[1])));
      if (e < ecart) {
        ecart = e;
        best = r;
      }
    }
    imageOpts.ratio = best;
    imageOpts.side = Math.max(d.w, d.h);
    sauverPrefs();
  }
  function setImageN(v: unknown): void {
    imageOpts.n = Math.max(1, Math.min(parseInt(String(v), 10) || 1, imageMaxN.value));
    sauverPrefs();
  }
  function toggleImageEnhance(): void {
    imageOpts.enhance = !imageOpts.enhance;
    sauverPrefs();
  }
  function setImageCustom(on: boolean): void {
    if (on && !imageOpts.custom) {
      const d = imageSize();
      imageOpts.cw = d.w;
      imageOpts.ch = d.h;
    }
    imageOpts.custom = !!on;
  }
  function clearImageSeed(): void {
    imageOpts.seed = "";
  }

  function prefsFormulaire(): Record<string, unknown> {
    const s = settings.value || {};
    if (!s.image_prefs || typeof s.image_prefs !== "object") s.image_prefs = prefsCourantes();
    return s.image_prefs as Record<string, unknown>;
  }
  function setPrefRatio(r: string): void {
    const p = prefsFormulaire();
    const base = imageBaseRatio(r);
    p["ratio"] = imageIsPortrait(p["ratio"]) && base !== "1:1" ? imageFlipRatio(base) : base;
  }
  function flipPrefRatio(): void {
    const p = prefsFormulaire();
    if (p["ratio"] && p["ratio"] !== "1:1") p["ratio"] = imageFlipRatio(p["ratio"]);
  }
  function toggleImagePop(nom: string): void {
    imagePop.value = imagePop.value === nom ? "" : nom;
  }

  async function toggleImageMode(on?: boolean): Promise<boolean> {
    const suivant = on === undefined ? !imageMode.value : !!on;
    if (suivant) {
      const st = await loadImageStatus();
      if (!st || !st.available) {
        showToast(
          st && st.ready ? "Images désactivées dans vos Paramètres." : "Aucun moteur d’images disponible.",
          "info",
        );
        imageMode.value = false;
        return false;
      }
      if (imageOpts.n > imageMaxN.value) imageOpts.n = imageMaxN.value;
    } else {
      imageEditRef.value = null;
    }
    imageMode.value = suivant;
    imagePop.value = "";
    if (suivant && ctx.focusInput) ctx.focusInput();
    return suivant;
  }

  function closeImageMode(): void {
    imageMode.value = false;
    imagePop.value = "";
    imageEditRef.value = null;
  }

  /** Échap : ferme le popover, sinon quitte le mode quand le champ est vide et a le focus ; vrai si la touche est prise. */
  function imageEscape(champVide: boolean, focusSaisie: boolean): boolean {
    if (imagePop.value) {
      imagePop.value = "";
      return true;
    }
    if (imageMode.value && champVide && focusSaisie) {
      closeImageMode();
      return true;
    }
    return false;
  }

  if (attachedFiles) {
    watch(
      () => attachedFiles.value.length,
      (n, avant) => {
        if (!imageMode.value || !(n > (avant || 0))) return;
        const liste = attachedFiles.value;
        const images = liste.filter((f) => f && f.isImage);
        if (images.length !== liste.length || images.length > 1) {
          const derniere = images[images.length - 1];
          attachedFiles.value = derniere ? [derniere] : [];
          showToast("Mode Images : une seule image jointe, celle à modifier.", "info");
        }
        if (attachedFiles.value.length) imageEditRef.value = null;
      },
    );
  }

  async function editGeneratedImage(r: ImageAffichee | null | undefined): Promise<void> {
    if (!r || !r.id) return;
    if (!imageMode.value && !(await toggleImageMode(true))) return;
    if (attachedFiles && attachedFiles.value.length) {
      attachedFiles.value = [];
      showToast("Pièce jointe retirée : l'image à modifier la remplace.", "info");
    }
    imageEditRef.value = { id: r.id, url: r.url || `/api/images/${r.id}`, thumb_url: r.thumb_url || "" };
    if (ctx.focusInput) ctx.focusInput();
  }
  function clearImageEditRef(): void {
    imageEditRef.value = null;
  }

  /** Options du message à envoyer (`image_request`) ; `over` : format et nombre propres à cette demande (commande /image). */
  function buildImageRequest(
    withSource?: boolean,
    over?: { ratio?: string | null; n?: number | null },
  ): DemandeImage {
    const o = over || {};
    const st: Partial<StatutMoteurImages> = imageStatus.value ?? {};
    const f = st.features || {};
    const req: DemandeImage = {
      n: Math.max(1, Math.min(parseInt(String(o.n || imageOpts.n), 10) || 1, imageMaxN.value)),
    };
    const d = imageSize(o);
    req.size = `${d.w}x${d.h}`;
    if (!imageFixedSizes.value.length && (o.ratio || !imageOpts.custom)) {
      req.ratio = o.ratio || imageOpts.ratio;
      req.side = Math.max(d.w, d.h);
    }
    if (imageOpts.enhance && st.enhance_enabled !== false) req.enhance = true;
    if (imageEditRef.value) req.ref_image_id = imageEditRef.value.id;
    if (f.strength && (imageEditRef.value || withSource)) {
      const v = Number(imageOpts.strength);
      if (v >= 0.05 && v <= 1) req.strength = Math.round(v * 100) / 100;
    }
    if (f.seed && imageSeedSet.value) req.seed = parseInt(String(imageOpts.seed).trim(), 10);
    if (f.steps) {
      const s = parseInt(String(imageOpts.steps).trim(), 10);
      if (Number.isFinite(s) && s > 0) req.steps = s;
    }
    if (f.negative) {
      const neg = String(imageOpts.negative_prompt || "").trim();
      if (neg) req.negative_prompt = neg;
    }
    return req;
  }

  /** Largeur, hauteur et nombre d'une demande (tuile d'erreur après rechargement). */
  function imageReqDims(req: DemandeImage | null | undefined): { w: number; h: number; n: number } {
    const d = analyserTaille(req && req.size) || { w: 1024, h: 1024 };
    return { w: d.w, h: d.h, n: Math.max(1, Number(req && req.n) || 1) };
  }

  function imageCellState(id: string): string {
    return etat[id] || "";
  }
  function markImageExpired(id: string): void {
    if (!id || etat[id]) return;
    etat[id] = "expired";
  }
  function downloadImage(r: ImageAffichee | null | undefined, prompt?: string): void {
    if (!r || !r.url || etat[r.id]) return;
    const a = document.createElement("a");
    a.href = r.url;
    a.download = imageFileName(r, prompt);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const enAttente = suppressionsEnAttente();

  /** Suppression annulable : l'image disparaît tout de suite, le DELETE ne part qu'à l'expiration du toast (5 s). */
  function removeImage(r: ImageAffichee | null | undefined): void {
    if (!r || !r.id || etat[r.id]) return;
    const id = r.id;
    etat[id] = "pending";
    enAttente.add(id);
    if (imageViewer.value) viewerApresRetrait(id);
    showToast("Image supprimée.", "info", {
      duration: 5000,
      actionLabel: "Annuler",
      onAction: () => {
        enAttente.delete(id);
        if (etat[id] === "pending") delete etat[id];
      },
      onExpire: async () => {
        enAttente.delete(id);
        if (etat[id] !== "pending") return;
        const res = await api.supprimer(id);
        if (res === "echec") {
          delete etat[id];
          showToast("Suppression impossible.", "error");
        } else etat[id] = "deleted";
      },
    });
  }

  async function copyImageText(texte: unknown): Promise<void> {
    const t = String(texte || "").trim();
    if (!t) return;
    let ok = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(t);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) ok = copieSecours(t);
    showToast(ok ? "Description copiée." : "Copie impossible.", ok ? undefined : "error");
  }

  let retourVisionneuse: HTMLElement | null = null;
  function openImageViewer(
    items: readonly ImageAffichee[] | null | undefined,
    idx: number,
    info?: InfosVisionneuse,
  ): void {
    const tous = items || [];
    const liste = tous.filter((r) => r && r.id && !etat[r.id]);
    if (!liste.length) return;
    const cible = tous[Number(idx) || 0];
    let i = cible ? liste.findIndex((r) => r.id === cible.id) : 0;
    if (i < 0) i = 0;
    const inf = info || {};
    retourVisionneuse = (document.activeElement as HTMLElement | null) || null;
    imageViewer.value = {
      items: liste,
      idx: i,
      prompt: inf.prompt || "",
      revised: inf.revised || "",
      meta: inf.meta || null,
    };
    void nextTick(() => {
      const el = document.querySelector<HTMLElement>("[data-image-viewer]");
      if (el && el.focus) el.focus();
    });
  }
  function closeImageViewer(): void {
    imageViewer.value = null;
    const el = retourVisionneuse;
    retourVisionneuse = null;
    try {
      if (el && el.focus) el.focus();
    } catch {
      /* élément retiré du DOM */
    }
  }
  function imageViewerStep(delta: number): void {
    const v = imageViewer.value;
    if (!v || v.items.length < 2) return;
    const n = v.items.length;
    imageViewer.value = Object.assign({}, v, { idx: (v.idx + delta + n) % n });
  }
  function viewerApresRetrait(id: string): void {
    const v = imageViewer.value;
    if (!v) return;
    const restes = v.items.filter((r) => r.id !== id && !etat[r.id]);
    if (!restes.length) {
      closeImageViewer();
      return;
    }
    imageViewer.value = Object.assign({}, v, { items: restes, idx: Math.min(v.idx, restes.length - 1) });
  }
  const imageViewerCurrent = computed(() => {
    const v = imageViewer.value;
    return v ? (v.items[v.idx] ?? null) : null;
  });
  const imageViewerPrompt = computed(() => {
    const v = imageViewer.value;
    const r = imageViewerCurrent.value;
    if (!v || !r) return "";
    return r.prompt || v.revised || v.prompt || "";
  });
  const imageViewerNamePrompt = computed(() => {
    const v = imageViewer.value;
    const r = imageViewerCurrent.value;
    if (!v || !r) return "";
    return r.prompt || v.prompt || v.revised || "";
  });
  const imageViewerInfo = computed(() => {
    const v = imageViewer.value;
    const r = imageViewerCurrent.value;
    if (!v || !r) return "";
    const m = v.meta || {};
    const parts: string[] = [];
    if (r.model || m.model) parts.push(String(r.model || m.model));
    if (r.width && r.height) parts.push(imageSizeLabel({ w: r.width, h: r.height }));
    if (r.seed !== undefined && r.seed !== null) parts.push(`graine ${r.seed}`);
    if (Number(m.duration_s) > 0) parts.push(imageFmtSec(m.duration_s));
    return parts.join(" · ");
  });
  function imageViewerKeydown(e: KeyboardEvent): void {
    if (!imageViewer.value) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      imageViewerStep(-1);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      imageViewerStep(1);
      return;
    }
    if (e.key !== "Tab") return;
    boucleTab(e, "button:not([disabled])", false);
  }

  const imageGallery = ref<GalerieImages | null>(null);
  let sequenceGalerie = 0;
  let retourGalerie: HTMLElement | null = null;
  async function loadMoreGallery(): Promise<void> {
    const g = imageGallery.value;
    if (!g || g.loading || g.done) return;
    const seq = sequenceGalerie;
    imageGallery.value = Object.assign({}, g, { loading: true, error: "" });
    const chat =
      g.filter === "chat" && currentChatId && currentChatId.value ? String(currentChatId.value) : null;
    const res = await api.galerie({ limite: PAGE_GALERIE, avant: g.next, chat });
    if (seq !== sequenceGalerie || !imageGallery.value) return;
    const cur = imageGallery.value;
    if (!res) {
      imageGallery.value = Object.assign({}, cur, { loading: false, error: "Galerie indisponible." });
      return;
    }
    const items = cur.items.concat((res.items || []).filter((it) => it && it.id));
    const next = res.next_before === null || res.next_before === undefined ? null : res.next_before;
    imageGallery.value = Object.assign({}, cur, {
      items,
      next,
      done: next === null,
      loading: false,
      total: Number(res.total) || items.length,
      keep: Number(res.keep) || 0,
    });
  }
  async function openImageGallery(filtre?: string): Promise<void> {
    sequenceGalerie++;
    if (!imageGallery.value) retourGalerie = (document.activeElement as HTMLElement | null) || null;
    imageGallery.value = {
      filter: filtre === "chat" ? "chat" : "all",
      items: [],
      next: null,
      total: 0,
      keep: 0,
      loading: false,
      done: false,
      error: "",
    };
    void nextTick(() => {
      const el = document.querySelector<HTMLElement>("[data-image-gallery]");
      if (el && el.focus) el.focus();
    });
    await loadMoreGallery();
  }
  function setGalleryFilter(filtre: "all" | "chat"): void {
    const g = imageGallery.value;
    if (!g || g.filter === filtre) return;
    if (filtre === "chat" && !(currentChatId && currentChatId.value)) return;
    void openImageGallery(filtre);
  }
  function closeImageGallery(): void {
    sequenceGalerie++;
    imageGallery.value = null;
    const el = retourGalerie;
    retourGalerie = null;
    try {
      if (el && el.focus) el.focus();
    } catch {
      /* élément retiré du DOM */
    }
  }
  function imageGalleryKeydown(e: KeyboardEvent | null | undefined): void {
    if (!e || e.key !== "Tab" || imageViewer.value) return;
    boucleTab(
      e,
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      true,
    );
  }
  function onGalleryScroll(e: Event | null | undefined): void {
    const el = e && (e.target as HTMLElement | null);
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 240) void loadMoreGallery();
  }
  function openGalleryItem(i: number): void {
    const g = imageGallery.value;
    if (g) openImageViewer(g.items, i, {});
  }
  function openImageChat(chatId: string | null | undefined): void {
    if (!chatId) return;
    imageViewer.value = null;
    closeImageGallery();
    if (ctx.openChat) void ctx.openChat(chatId);
  }

  const canEdit = computed(() => imageAvailable.value && !(isStreaming && isStreaming.value));
  definirApiImages({
    state: etat,
    canEdit,
    openViewer: openImageViewer,
    edit: (r) => void editGeneratedImage(r),
    download: downloadImage,
    remove: removeImage,
    markExpired: markImageExpired,
    copyText: (t) => void copyImageText(t),
  });

  return {
    imageMode,
    imageStatus,
    imagePop,
    imageOpts,
    imageEditRef,
    imageAvailable,
    imageSeedSet,
    imageBaseRatios,
    imageSides,
    imageMaxN,
    imageFeatures,
    imageFixedSizes,
    loadImageStatus,
    toggleImageMode,
    closeImageMode,
    imageEscape,
    toggleImagePop,
    imageSize,
    ratioBox,
    imageFormatLabel,
    imageIsPortrait,
    imageBaseRatio,
    imageFlipRatio,
    setImageRatio,
    flipImageRatio,
    setImageSide,
    setImageFixed,
    setImageN,
    toggleImageEnhance,
    setImageCustom,
    clearImageSeed,
    setPrefRatio,
    flipPrefRatio,
    editGeneratedImage,
    clearImageEditRef,
    buildImageRequest,
    imageReqDims,
    imageRequestLabel,
    imageSizeLabel,
    isImageMessage,
    imageInitialProgress,
    markImageExpired,
    imageCellState,
    downloadImage,
    removeImage,
    copyImageText,
    imageViewer,
    imageViewerCurrent,
    imageViewerInfo,
    imageViewerPrompt,
    imageViewerNamePrompt,
    imageGallery,
    openImageGallery,
    loadMoreGallery,
    setGalleryFilter,
    closeImageGallery,
    onGalleryScroll,
    openGalleryItem,
    openImageChat,
    imageGalleryKeydown,
    openImageViewer,
    closeImageViewer,
    imageViewerStep,
    imageViewerKeydown,
    imageCanEdit: canEdit,
  };
}

export type SurfaceImages = ReturnType<typeof creerImages>;
