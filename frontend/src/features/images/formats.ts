// SPDX-License-Identifier: MIT
/** frontend/src/features/images/formats.ts — fonctions pures de la génération d'images : champs d'un message, formats, tailles, commande /image, libellés de progression et d'erreur. */

/** Statut du moteur tel que lu par les fonctions pures (champs optionnels : le statut peut manquer). */
export interface StatutImages {
  ratios?: readonly string[];
  sides?: readonly number[];
  max_side?: number;
  default_side?: number;
  max_n?: number;
  enhance_enabled?: boolean;
  [cle: string]: unknown;
}

export interface PreferencesImages {
  ratio: string;
  side: number;
  n: number;
  enhance: boolean;
}

export interface DemandeImage {
  size?: string;
  n?: number;
  ratio?: string;
  side?: number;
  seed?: number;
  enhance?: boolean;
  ref_image_id?: string;
  strength?: number;
  steps?: number;
  negative_prompt?: string;
  [cle: string]: unknown;
}

export interface ProgressionImage {
  state?: string;
  queue_position?: number | null;
  elapsed_s?: number;
  eta_s?: number | null;
  pct?: number | null;
  pct_real?: boolean;
  width?: number;
  height?: number;
  n?: number;
  preview?: string;
  [cle: string]: unknown;
}

export interface ReferenceImage {
  id?: string;
  seed?: number | string | null;
  mime?: string;
  [cle: string]: unknown;
}

export interface CommandeImage {
  prompt: string;
  ratio: string | null;
  n: number | null;
  error: string;
}

/** Champs d'image d'un message : une seule liste pour la persistance, la réhydratation et l'instantané de session. */
export const IMAGE_MSG_KEYS: readonly string[] = Object.freeze([
  "image_request",
  "generated_images",
  "tool_images",
  "revised_prompt",
  "image_meta",
  "image_error",
]);

export const IMAGE_RATIOS_ALL: readonly string[] = Object.freeze([
  "1:1",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
  "21:9",
  "9:21",
]);

/** Les cinq formats du composeur ; l'orientation se bascule à part. */
export const IMAGE_BASE_RATIOS: readonly string[] = Object.freeze(["1:1", "4:3", "3:2", "16:9", "21:9"]);

const ALIAS_RATIOS: Readonly<Record<string, string>> = Object.freeze({
  carré: "1:1",
  carre: "1:1",
  portrait: "2:3",
  paysage: "3:2",
});

const TEXTES_ERREUR: Readonly<Record<string, string>> = Object.freeze({
  unavailable: "Moteur d’images indisponible",
  forbidden: "Images non autorisées pour ce compte",
  invalid: "Demande invalide",
  timeout: "Délai dépassé",
  busy: "Moteur occupé",
  refused: "Demande refusée par le moteur",
  engine: "Erreur du moteur d’images",
  cancelled: "Génération interrompue",
  too_large: "Image trop lourde",
  enhance: "Enrichir indisponible",
});

type MessageImage = Record<string, unknown> & { role?: unknown };

/** Recopie les champs d'image non vides de `src` dans `dst`. */
export function copyImageFields(src: unknown, dst?: Record<string, unknown>): Record<string, unknown> {
  const out = dst || {};
  if (!src || typeof src !== "object") return out;
  const lu = src as Record<string, unknown>;
  for (const k of IMAGE_MSG_KEYS) {
    const v = lu[k];
    if (v === undefined || v === null || v === "" || v === false) continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

/** Message produit (ou en cours de production) par le moteur d'images. */
export function isImageMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as MessageImage & {
    _imageTurn?: unknown;
    generated_images?: unknown[];
    image_error?: unknown;
    tool_images?: unknown[];
  };
  return !!(
    m._imageTurn ||
    (m.generated_images && m.generated_images.length) ||
    (m.image_error && m.role === "assistant" && !(m.tool_images && m.tool_images.length))
  );
}

function partiesRatio(ratio: unknown): [number, number] | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(ratio || "").trim());
  if (!m || !+(m[1] ?? 0) || !+(m[2] ?? 0)) return null;
  return [+(m[1] ?? 0), +(m[2] ?? 0)];
}

export function ratioParts(ratio: unknown): [number, number] | null {
  return partiesRatio(ratio);
}

export function imageRatioName(ratio: unknown): string {
  return ratio === "1:1" ? "Carré" : String(ratio || "");
}

export function imageIsPortrait(ratio: unknown): boolean {
  const p = partiesRatio(ratio);
  return !!(p && p[1] > p[0]);
}

export function imageFlipRatio(ratio: unknown): string {
  const p = partiesRatio(ratio);
  return p ? `${p[1]}:${p[0]}` : "1:1";
}

/** Forme « paysage » d'un ratio (celle du bouton qui le représente). */
export function imageBaseRatio(ratio: unknown): string {
  const p = partiesRatio(ratio);
  if (!p) return "1:1";
  return p[0] >= p[1] ? `${p[0]}:${p[1]}` : `${p[1]}:${p[0]}`;
}

/** Dimensions d'un ratio pour un plus grand côté, au pas `step`. */
export function imageSizeFor(ratio: unknown, side: unknown, step?: unknown): { w: number; h: number } {
  const pas = Number(step) > 0 ? Number(step) : 64;
  const cote = Number(side) > 0 ? Number(side) : 1024;
  const p = partiesRatio(ratio) || [1, 1];
  const arrondi = (v: number): number => Math.max(pas, Math.round(v / pas) * pas);
  return p[0] >= p[1]
    ? { w: arrondi(cote), h: arrondi((cote * p[1]) / p[0]) }
    : { w: arrondi((cote * p[0]) / p[1]), h: arrondi(cote) };
}

export function analyserTaille(size: unknown): { w: number; h: number } | null {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(
    String(size || "")
      .trim()
      .toLowerCase(),
  );
  return m ? { w: +(m[1] ?? 0), h: +(m[2] ?? 0) } : null;
}

/** Taille fixe (politique `fixed`) la plus proche d'un ratio et d'un côté. */
export function imagePickFixed(
  sizes: readonly unknown[] | null | undefined,
  ratio: unknown,
  side: unknown,
): string {
  const liste = (sizes || []).map(analyserTaille).filter((s): s is { w: number; h: number } => s !== null);
  const premiere = liste[0];
  if (!premiere) return "";
  const p = partiesRatio(ratio) || [1, 1];
  const cible = Math.log(p[0] / p[1]);
  const cote = Number(side) || 1024;
  let best = premiere;
  let score = Infinity;
  for (const s of liste) {
    const d = Math.abs(Math.log(s.w / s.h) - cible) * 10000 + Math.abs(Math.max(s.w, s.h) - cote);
    if (d < score) {
      score = d;
      best = s;
    }
  }
  return `${best.w}x${best.h}`;
}

/** Boîte d'une image dans le fil : même taille pour la tuile en cours et l'image finale. */
export function imageCellStyle(w: unknown, h: unknown, n: unknown): { width: string; aspectRatio: string } {
  const W = Number(w) > 0 ? Number(w) : 1;
  const H = Number(h) > 0 ? Number(h) : 1;
  const boite = (Number(n) || 1) > 1 ? 208 : 360;
  const k = boite / Math.max(W, H);
  return { width: `${Math.round(W * k)}px`, aspectRatio: `${W} / ${H}` };
}

/** Préférences du compte ramenées à ce que le moteur permet. */
export function normalizeImagePrefs(
  prefs: unknown,
  status: StatutImages | null | undefined,
): PreferencesImages {
  const st = status || {};
  const p = (prefs && typeof prefs === "object" ? prefs : {}) as Partial<
    Record<keyof PreferencesImages, unknown>
  >;
  const ratios = st.ratios && st.ratios.length ? st.ratios : IMAGE_RATIOS_ALL;
  const ratio =
    typeof p.ratio === "string" && ratios.indexOf(p.ratio) >= 0
      ? p.ratio
      : ratios.indexOf("1:1") >= 0
        ? "1:1"
        : (ratios[0] ?? "1:1");
  const maxSide = Number(st.max_side) || 2048;
  const sides = st.sides && st.sides.length ? st.sides.filter((s) => s <= maxSide) : [];
  let side = Number(p.side) || Number(st.default_side) || 1024;
  if (sides.length && sides.indexOf(side) < 0) {
    const dessous = sides.filter((s) => s <= side);
    side = dessous.length ? Math.max(...dessous) : Math.min(...sides);
  }
  side = Math.min(side, maxSide);
  const maxN = Math.max(1, Number(st.max_n) || 1);
  const n = Math.max(1, Math.min(parseInt(String(p.n), 10) || 1, maxN));
  const enhance = !!p.enhance && st.enhance_enabled !== false;
  return { ratio, side, n, enhance };
}

/** `/image [ratio] [xN] description` → description, ratio, nombre et erreur éventuelle. */
export function parseImageCommand(raw: unknown, status?: StatutImages | null): CommandeImage {
  const st = status || {};
  const ratios = st.ratios && st.ratios.length ? st.ratios : IMAGE_RATIOS_ALL;
  const out: CommandeImage = { prompt: "", ratio: null, n: null, error: "" };
  let reste = String(raw || "").replace(/^\s+/, "");
  for (let k = 0; k < 2; k++) {
    let m = /^(\d{1,2}:\d{1,2}|carr[ée]|portrait|paysage)(?=\s|$)\s*/i.exec(reste);
    if (m && !out.ratio) {
      const brut = (m[1] ?? "").toLowerCase();
      const r = ALIAS_RATIOS[brut] || brut;
      if (ratios.indexOf(r) < 0) {
        out.error = `Format non proposé : ${m[1] ?? ""}`;
        return out;
      }
      out.ratio = r;
      reste = reste.slice(m[0].length);
      continue;
    }
    m = /^[x×](\d{1,2})(?=\s|$)\s*/i.exec(reste);
    if (m && out.n === null) {
      const plafond = Math.max(1, Number(st.max_n) || 8);
      out.n = Math.max(1, Math.min(parseInt(m[1] ?? "", 10) || 1, plafond));
      reste = reste.slice(m[0].length);
      continue;
    }
    break;
  }
  out.prompt = reste.trim();
  return out;
}

/** Nom de fichier commun : `<description>-<graine>.<ext>`, l'id court à défaut de graine. */
export function imageFileName(ref: ReferenceImage | null | undefined, prompt: unknown): string {
  const r = ref || {};
  let base = String(prompt || "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (!base) base = "image";
  const etiquette =
    r.seed !== undefined && r.seed !== null && r.seed !== ""
      ? String(r.seed)
      : String(r.id || "").slice(0, 8);
  const mime = String(r.mime || "image/png").toLowerCase();
  const ext =
    mime.indexOf("jpeg") >= 0 || mime.indexOf("jpg") >= 0
      ? "jpg"
      : mime.indexOf("webp") >= 0
        ? "webp"
        : "png";
  return `${base}${etiquette ? `-${etiquette}` : ""}.${ext}`;
}

/** « Variantes » : même demande, graine tirée à nouveau par le moteur. */
export function imageVariantRequest(req: DemandeImage | null | undefined): DemandeImage {
  const r: DemandeImage = Object.assign({}, req || {});
  delete r.seed;
  return r;
}

/** `"1024x576"` → `"16:9 · 1024×576"` (nom du ratio s'il est proposé). */
export function imageSizeLabel(size: unknown): string {
  const d = size && typeof size === "object" ? (size as { w: number; h: number }) : analyserTaille(size);
  if (!d) return "";
  let nom = "";
  for (const r of IMAGE_RATIOS_ALL) {
    const p = partiesRatio(r);
    if (!p) continue;
    const v = p[0] / p[1];
    if (Math.abs(d.w / d.h - v) < 0.05 * v) {
      nom = imageRatioName(r);
      break;
    }
  }
  return `${nom ? `${nom} · ` : ""}${d.w}×${d.h}`;
}

/** Ligne sous la bulle utilisateur : « 16:9 · 1024×576 · ×2 · graine 42 ». */
export function imageRequestLabel(req: DemandeImage | null | undefined): string {
  if (!req) return "";
  const parts: string[] = [];
  const sz = imageSizeLabel(req.size);
  if (sz) parts.push(sz);
  if (req.n !== undefined && req.n > 1) parts.push(`×${req.n}`);
  if (req.seed !== undefined && req.seed !== null) parts.push(`graine ${req.seed}`);
  if (req.ref_image_id || req.strength !== undefined) parts.push("modification");
  if (req.enhance) parts.push("enrichie");
  return parts.join(" · ");
}

export function imageFmtSec(s: unknown): string {
  const n = Math.max(0, Math.round(Number(s) || 0));
  if (n < 60) return `${n} s`;
  return `${Math.floor(n / 60)} min ${String(n % 60).padStart(2, "0")} s`;
}

/** Libellé visible de la tuile ; seul un avancement publié par le moteur (`pct_real`) s'affiche en %. */
export function imageProgressText(p: ProgressionImage | null | undefined, elapsed?: number | null): string {
  const pr = p || {};
  const ecoule = elapsed === undefined || elapsed === null ? pr.elapsed_s || 0 : elapsed;
  if (pr.state === "queued") {
    const q = Number(pr.queue_position) || 0;
    return q > 0 ? `En file · ${q}${q === 1 ? "re" : "e"}` : "En file";
  }
  if (pr.state === "waiting") return "En attente d’un créneau";
  if (pr.state === "enhancing") return "Description en cours";
  if (pr.pct_real && typeof pr.pct === "number") {
    return `Génération · ${Math.max(0, Math.min(100, Math.round(pr.pct)))} %`;
  }
  const eta = Number(pr.eta_s) || 0;
  return `Génération · ${imageFmtSec(ecoule)}${eta > 0 ? ` / ≈${imageFmtSec(eta)}` : ""}`;
}

export function imageErrorText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err !== "object") return TEXTES_ERREUR["engine"] ?? "";
  const e = err as { message?: unknown; code?: unknown };
  return String(e.message || TEXTES_ERREUR[String(e.code)] || TEXTES_ERREUR["engine"]);
}

/** Tuile affichée dès l'envoi, au format demandé (avant le premier événement). */
export function imageInitialProgress(req: DemandeImage | null | undefined): ProgressionImage {
  const d = analyserTaille(req && req.size) || { w: 1024, h: 1024 };
  return {
    state: "queued",
    queue_position: null,
    elapsed_s: 0,
    eta_s: null,
    pct: null,
    pct_real: false,
    width: d.w,
    height: d.h,
    n: Math.max(1, Number(req && req.n) || 1),
  };
}
