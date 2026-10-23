// SPDX-License-Identifier: MIT
/** packages/bureau/src/detection.ts — annotation d'une capture par un détecteur dédié (OmniParser, Florence-2, GroundingDINO…) ou un LLM multimodal ; boîtes en pixels natifs. */
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  arrondiEntierPy,
  arrondiPy,
  BLANC_PY,
  ErreurPython,
  estDict,
  exigerDict,
  floatPy,
  FlottantPy,
  intPy,
  iterPy,
  lire,
  lowerPy,
  maxPy,
  minPy,
  ouPy as ou,
  poserCle,
  prefixePy,
  pyJsonLoads,
  reprPy,
  rstripPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { racineDepot } from "@elpis/config";
import { journal } from "@elpis/http";

import { imagesBureau } from "./ports";
import {
  corpsJsonRequests,
  ErreurRequests,
  jsonReponse,
  multipartRequests,
  posterUndici,
  texteReponse,
  validerEntetes,
  validerUrl,
  verifierSchema,
} from "./requetes";
import type { FichierRequests, Poster, ReponsePost } from "./requetes";

const log = journal("detect");

const largeurEnv = process.env["APP_DETECT_MAX_WIDTH"] ?? "1920";
/** Largeur la plus grande envoyée au détecteur (au-delà, la capture est réduite). */
export const DETECT_MAX_WIDTH = Math.max(320, veritePy(largeurEnv) ? intPy(largeurEnv) : 1920);

const OMNIPARSER: Dict = {
  items: ["parsed_content_list", "elements", "items", "data", "result"],
  box: ["bbox", "box", "bounding_box", "coordinates"],
  label: ["content", "label", "text", "type", "name"],
  score: ["score", "confidence", "prob", "probability"],
  arrays: { box: ["bboxes", "boxes"], label: ["labels", "contents"], score: ["scores", "logits"] },
  box_format: "xyxy",
  coords: "auto",
};
const FLORENCE: Dict = {
  items: ["detections", "items", "data"],
  box: ["bbox", "box"],
  label: ["label", "text", "content"],
  score: ["score", "confidence"],
  arrays: { box: ["bboxes", "boxes"], label: ["labels"], score: ["scores"] },
  box_format: "xyxy",
  coords: "pixel",
};
const GROUNDING_DINO: Dict = {
  items: ["detections", "predictions", "objects", "data"],
  box: ["box", "bbox", "xyxy"],
  label: ["label", "phrase", "text", "name"],
  score: ["score", "confidence", "logit"],
  arrays: { box: ["boxes", "bboxes"], label: ["labels", "phrases"], score: ["scores", "logits"] },
  box_format: "xyxy",
  coords: "auto",
};
const LOCATE_ANYTHING: Dict = {
  items: ["detections", "objects", "results", "boxes", "data"],
  box: ["bbox", "box", "rect", "xyxy"],
  label: ["label", "name", "class", "category", "text"],
  score: ["score", "confidence", "prob"],
  arrays: {
    box: ["boxes", "bboxes"],
    label: ["labels", "classes", "names"],
    score: ["scores", "confidences"],
  },
  box_format: "xyxy",
  coords: "auto",
};

/** Préréglages par format (alias de la console compris) : clés où chercher éléments, boîtes, libellés et scores. */
export const PRESETS: Readonly<Record<string, Dict>> = {
  omniparser: OMNIPARSER,
  florence: FLORENCE,
  "grounding-dino": GROUNDING_DINO,
  "nvidia-locate-anything": LOCATE_ANYTHING,
  nvidia: LOCATE_ANYTHING,
  "locate-anything": LOCATE_ANYTHING,
  "florence-2": FLORENCE,
  groundingdino: GROUNDING_DINO,
};

/** Formats servis par un LLM multimodal (`/v1/chat/completions`) plutôt que par un détecteur. */
export const LLM_FORMATS: ReadonlySet<string> = new Set(["llm-chat", "llm", "openai-chat", "vlm"]);

export const LLM_BASE_PROMPT =
  "You are a UI grounding engine. Detect every distinct INTERACTIVE element " +
  "visible in this screenshot — buttons, icons, text fields, checkboxes, menu " +
  "items, list rows, taskbar items, and the clock. Give each one its OWN box " +
  "and its real visible label; include small and unlabeled icons. Do NOT return " +
  "whole regions or containers (no single box for a desktop area, a window, or " +
  "the taskbar) — box the individual widgets inside them. Never invent a regular " +
  "grid and never repeat the same element. Return ONLY a JSON array (no prose, " +
  "no markdown fence) where each item is " +
  '{"label": "<short name>", "box": [x1, y1, x2, y2]} ' +
  "with INTEGER PIXEL coordinates relative to this exact image (origin at the " +
  "top-left, x to the right, y downward, x1<x2, y1<y2). Use each element's real " +
  "visible text as its label, in whatever language it appears on screen.";
export const LLM_EDGE_PROMPT =
  "You are a UI grounding engine. In this desktop screenshot, list ONLY the " +
  "individual items inside the bar along the BOTTOM edge of the screen: the " +
  "launcher/Start button, EVERY application icon (including small unlabeled " +
  "colored squares), each notification-area (system tray) icon, and the clock. " +
  "Do NOT return the bar itself. Return ONLY a JSON array of " +
  '{"label": "<short name>", "box": [x1, y1, x2, y2]} ' +
  "with INTEGER PIXEL coordinates relative to this exact image (origin at the " +
  "top-left).";
export const LLM_QUERY_PROMPT =
  "You are a UI grounding engine. Find and box every element that matches this " +
  "request: {query}. Box ONLY elements that are ACTUALLY VISIBLE in the image; " +
  "never invent a regular grid and never repeat the same element. Use each " +
  "element's real visible label. Return ONLY a JSON array (no prose, no markdown " +
  "fence) where each item is " +
  '{"label": "<short name>", "box": [x1, y1, x2, y2]} ' +
  "with INTEGER PIXEL coordinates relative to this exact image (origin at the " +
  "top-left, x1<x2, y1<y2).";
export const LLM_READ_PROMPT =
  "Read and transcribe ALL the visible text in this image, exactly as shown, " +
  "preserving the reading order and line breaks. Do not translate, summarize, or " +
  "add any comment. If there is no readable text, reply exactly: (no text).";

/** Prompts éditables en console (`system_prompts/VISION_*.md`) et leur repli embarqué. */
export const PROMPT_FILES: Readonly<Record<string, string>> = {
  VISION_DETECT: LLM_BASE_PROMPT,
  VISION_DETECT_EDGE: LLM_EDGE_PROMPT,
  VISION_DETECT_QUERY: LLM_QUERY_PROMPT,
  VISION_READ: LLM_READ_PROMPT,
};

const cachePrompts = new Map<string, [number, string]>();

/** `system_prompts/<categorie>.md` relu si sa date change ; vide, absent ou illisible : repli embarqué. */
export function promptText(categorie: string): string {
  const repli = Object.hasOwn(PROMPT_FILES, categorie) ? (PROMPT_FILES[categorie] ?? "") : "";
  try {
    const chemin = join(racineDepot(), "system_prompts", `${categorie}.md`);
    const mtime = statSync(chemin).mtimeMs;
    const connu = cachePrompts.get(categorie);
    if (connu !== undefined && connu[0] === mtime) return connu[1];
    const brut = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(chemin));
    const texte = stripPy(brut.replace(/\r\n?/g, "\n"));
    if (!texte) return repli;
    cachePrompts.set(categorie, [mtime, texte]);
    return texte;
  } catch {
    return repli;
  }
}

/** Élément annoté, en pixels de la capture native. */
export type ElementVision = {
  label: string;
  box: number[];
  center: number[];
  confidence: number;
  source: "vision";
};

/** Résultat d'une détection ; `erreur` porte le diagnostic (le `last_error()` de Python, propre à cet appel). */
export type ResultatDetection = { elements: ElementVision[]; erreur: string };

/** Taille native (PNG, JPEG ou WEBP lus sur l'en-tête) ; `[0, 0]` si illisible. */
export function nativeSize(png: Uint8Array): [number, number] {
  const t = imagesBureau().dimensions(png);
  return t === null ? [0, 0] : [t[0], t[1]];
}

/** MIME d'après les octets magiques : JPEG si `\xff\xd8`, PNG sinon. */
export function sniffMime(data: Uint8Array): string {
  return data.length >= 2 && data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg" : "image/png";
}

function dataUrl(octets: Uint8Array): string {
  return `data:${sniffMime(octets)};base64,${Buffer.from(octets).toString("base64")}`;
}

/** Valeur de la première clé présente et non nulle. */
function premier(obj: unknown, noms: readonly unknown[]): unknown {
  if (!estDict(obj)) return null;
  for (const n of noms) {
    if (typeof n !== "string") continue;
    const v = lire(obj, n);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Liste d'éléments (dicts) sous l'une des `cles`, en descendant les enveloppes sur trois niveaux. */
export function findListOfDicts(charge: unknown, cles: readonly unknown[], profondeur = 0): unknown[] | null {
  if (profondeur > 3 || charge === null || charge === undefined) return null;
  if (Array.isArray(charge)) return charge.length > 0 && estDict(charge[0]) ? charge : null;
  if (estDict(charge)) {
    for (const k of cles) {
      const v = typeof k === "string" ? lire(charge, k) : undefined;
      if (Array.isArray(v) && v.length > 0 && estDict(v[0])) return v;
    }
    for (const v of Object.values(charge)) {
      if (!estDict(v) && !Array.isArray(v)) continue;
      const trouve = findListOfDicts(v, cles, profondeur + 1);
      if (trouve !== null && trouve.length > 0) return trouve;
    }
  }
  return null;
}

/** Tableau parallèle (Florence : `bboxes`, `labels`…) sous l'une des `cles`. */
export function findArray(charge: unknown, cles: readonly unknown[], profondeur = 0): unknown[] | null {
  if (profondeur > 3 || charge === null || charge === undefined || !estDict(charge)) return null;
  for (const k of cles) {
    const v = typeof k === "string" ? lire(charge, k) : undefined;
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(charge)) {
    if (!estDict(v) && !Array.isArray(v)) continue;
    const trouve = findArray(v, cles, profondeur + 1);
    if (trouve !== null) return trouve;
  }
  return null;
}

const JEUX_BOITE = [
  ["x1", "y1", "x2", "y2"],
  ["left", "top", "right", "bottom"],
  ["x", "y", "w", "h"],
  ["x", "y", "width", "height"],
] as const;

function erreurConversion(e: unknown): boolean {
  return e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError");
}

/** Boîte brute → 4 flottants (dict nommé ou liste) ; un dict aux valeurs invalides lève comme `float()`. */
export function coerceBox(brute: unknown): number[] | null {
  if (estDict(brute)) {
    for (const jeu of JEUX_BOITE)
      if (jeu.every((k) => Object.hasOwn(brute, k))) return jeu.map((k) => floatPy(brute[k]));
    return null;
  }
  if (Array.isArray(brute) && brute.length >= 4) {
    try {
      return brute.slice(0, 4).map(floatPy);
    } catch (e) {
      if (erreurConversion(e)) return null;
      throw e;
    }
  }
  return null;
}

/** `int(round(x))` : NaN et infinis lèvent comme Python. */
function entierArrondi(x: number): number {
  if (Number.isNaN(x)) throw new ErreurPython("ValueError", "cannot convert float NaN to integer");
  if (!Number.isFinite(x))
    throw new ErreurPython("OverflowError", "cannot convert float infinity to integer");
  return arrondiEntierPy(x);
}

/** Boîte (format, normalisée ou en pixels envoyés) → `[x1, y1, x2, y2]` entiers en pixels natifs, bornés ; `null` si dégénérée. */
export function toXyxyNative(
  boite: readonly number[],
  format: string,
  coords: string,
  sentW: number,
  sentH: number,
  nativeW: number,
  nativeH: number,
): number[] | null {
  const [a = 0, b = 0, c = 0, d = 0] = boite;
  let [x1, y1, x2, y2] =
    format === "xywh"
      ? [a, b, a + c, b + d]
      : format === "cxcywh"
        ? [a - c / 2, b - d / 2, a + c / 2, b + d / 2]
        : [a, b, c, d];
  const norm =
    coords === "norm" ||
    (coords === "auto" && maxPy(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) <= 1.5);
  if (norm) {
    if (nativeW <= 0 || nativeH <= 0) return null;
    [x1, x2] = [x1 * nativeW, x2 * nativeW];
    [y1, y2] = [y1 * nativeH, y2 * nativeH];
  } else if (sentW && nativeW && sentW !== nativeW) {
    const sx = nativeW / sentW;
    const sy = nativeH / (sentH || sentW);
    [x1, x2, y1, y2] = [x1 * sx, x2 * sx, y1 * sy, y2 * sy];
  }
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  if (nativeW) [x1, x2] = [maxPy(0, minPy(nativeW, x1)), maxPy(0, minPy(nativeW, x2))];
  if (nativeH) [y1, y2] = [maxPy(0, minPy(nativeH, y1)), maxPy(0, minPy(nativeH, y2))];
  if (x2 - x1 < 1 || y2 - y1 < 1) return null;
  return [entierArrondi(x1), entierArrondi(y1), entierArrondi(x2), entierArrondi(y2)];
}

export function labelOf(item: unknown, cles: readonly unknown[]): string {
  let v = premier(item, cles);
  if (estDict(v)) v = ou(ou(lire(v, "text") ?? null, lire(v, "name") ?? null), lire(v, "label") ?? null);
  return v !== null && v !== undefined ? stripPy(strPy(v)) : "element";
}

export function scoreOf(item: unknown, cles: readonly unknown[]): number {
  try {
    return arrondiPy(floatPy(premier(item, cles)), 3);
  } catch (e) {
    if (erreurConversion(e)) return 0;
    throw e;
  }
}

/** Adresse de base, `…/v1` ou route complète → `…/v1/chat/completions`. */
export function chatCompletionsUrl(endpoint: string | null | undefined): string {
  const url = rstripPy(endpoint || "", "/");
  if (url.includes("/chat/completions")) return url;
  if (url.endsWith("/v1")) return url + "/chat/completions";
  return url + "/v1/chat/completions";
}

const THINK = /<think>[\s\S]*?<\/think>/g;
const FENCE_JSON = /```(?:json)?/g;

/** Tableau JSON d'une réponse de LLM (bloc `<think>`, clôtures markdown et texte autour tolérés). */
export function extractJsonArray(texte: unknown): unknown[] | null {
  if (typeof texte !== "string" || !stripPy(texte)) return null;
  const t = texte.replace(THINK, "").replace(FENCE_JSON, "");
  const debut = t.indexOf("[");
  const fin = t.lastIndexOf("]");
  if (debut === -1 || fin <= debut) return null;
  let v: unknown;
  try {
    v = pyJsonLoads(t.slice(debut, fin + 1));
  } catch {
    return null;
  }
  return Array.isArray(v) ? v : null;
}

const B = BLANC_PY;
const NOMBRE = "(\\p{Nd}+(?:\\.\\p{Nd}+)?)";
const PAIRE = `\\(?${B}*${NOMBRE}${B}*,${B}*${NOMBRE}${B}*\\)?`;
const BALISES = [
  new RegExp(
    `(?:<\\|object_ref_start\\|>(?<label>[\\s\\S]*?)<\\|object_ref_end\\|>${B}*)?<\\|box_start\\|>${B}*${PAIRE}${B}*,${B}*${PAIRE}${B}*<\\|box_end\\|>`,
    "gu",
  ),
  new RegExp(
    `(?:<ref>(?<label>[\\s\\S]*?)<\\/ref>${B}*)?<box>${B}*${PAIRE}${B}*,${B}*${PAIRE}${B}*<\\/box>`,
    "gu",
  ),
];

/** Repli : boîtes balisées des VL (`<box>(x1,y1),(x2,y2)</box>`, 0–1000) → fractions 0–1. */
export function extractTagItems(texte: unknown): Dict[] {
  if (typeof texte !== "string" || !texte) return [];
  const items: Dict[] = [];
  for (const motif of BALISES) {
    for (const m of texte.matchAll(motif)) {
      let boite: number[];
      try {
        boite = [m[2], m[3], m[4], m[5]].map((g) => floatPy(g) / 1000);
      } catch (e) {
        if (erreurConversion(e)) continue;
        throw e;
      }
      items.push({ label: stripPy(m.groups?.["label"] ?? "") || "element", box: boite });
    }
    if (items.length > 0) break;
  }
  return items;
}

export function iouXyxy(a: readonly number[], b: readonly number[]): number {
  const [a0 = 0, a1 = 0, a2 = 0, a3 = 0] = a;
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = b;
  const inter =
    Math.max(0, Math.min(a2, b2) - Math.max(a0, b0)) * Math.max(0, Math.min(a3, b3) - Math.max(a1, b1));
  if (inter <= 0) return 0;
  const union = (a2 - a0) * (a3 - a1) + (b2 - b0) * (b3 - b1) - inter;
  return union > 0 ? inter / union : 0;
}

/** `float(v)` réussit-il ? */
export function isNum(v: unknown): boolean {
  try {
    floatPy(v);
    return true;
  } catch (e) {
    if (erreurConversion(e)) return false;
    throw e;
  }
}

function element(label: string, xyxy: number[], confiance: number): ElementVision {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = xyxy;
  return {
    label,
    box: xyxy,
    center: [Math.floor((x1 + x2) / 2), Math.floor((y1 + y2) / 2)],
    confidence: confiance,
    source: "vision",
  };
}

type Appel = { poster: Poster; signal?: AbortSignal; erreur: string };

/** `requests.post` : validations dans l'ordre de requests (URL, en-têtes, schéma), puis transport. */
async function envoyer(
  c: Appel,
  url: string,
  corps: { corps: Uint8Array; typeContenu: string },
  entetes: Readonly<Record<string, string>>,
  delai: number,
): Promise<ReponsePost> {
  const propre = validerUrl(url);
  validerEntetes(entetes);
  verifierSchema(propre);
  return c.poster({
    url: propre,
    corps: corps.corps,
    typeContenu: corps.typeContenu,
    entetes,
    delai,
    signal: c.signal,
  });
}

function json(v: unknown): { corps: Uint8Array; typeContenu: string } {
  return { corps: corpsJsonRequests(v), typeContenu: "application/json" };
}

/** Message d'erreur d'un serveur compatible OpenAI (`error.message` ou `error`), sinon début du corps. */
function detailErreur(r: ReponsePost): string {
  try {
    const j = jsonReponse(r);
    const err = lire(exigerDict(j), "error") ?? null;
    if (estDict(err)) {
      const m = lire(err, "message");
      if (typeof m !== "string")
        throw new ErreurPython("AttributeError", "'NoneType' object has no attribute 'strip'");
      return stripPy(m);
    }
    return stripPy(strPy(veritePy(err) ? err : ""));
  } catch {
    return prefixePy(stripPy(texteReponse(r)), 160);
  }
}

/** `payload["choices"][0]["message"]["content"]` ; `null` là où Python lève (KeyError, IndexError, TypeError). */
function contenuChat(p: unknown): { contenu: unknown } | null {
  if (!estDict(p) || !Object.hasOwn(p, "choices")) return null;
  const choix = p["choices"];
  if (!Array.isArray(choix) || choix.length === 0) return null;
  const c0 = choix[0];
  if (!estDict(c0) || !Object.hasOwn(c0, "message")) return null;
  const msg = c0["message"];
  if (!estDict(msg) || !Object.hasOwn(msg, "content")) return null;
  return { contenu: msg["content"] };
}

/** `" ".join(p.get("text", "") for p in content if isinstance(p, dict))`. */
function joindreParties(parties: readonly unknown[]): string {
  const morceaux: string[] = [];
  for (const p of parties) {
    if (!estDict(p)) continue;
    const t = Object.hasOwn(p, "text") ? p["text"] : "";
    if (typeof t !== "string")
      throw new ErreurPython(
        "TypeError",
        `sequence item ${morceaux.length}: expected str instance, ${nomType(t)} found`,
      );
    morceaux.push(t);
  }
  return morceaux.join(" ");
}

function nomType(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "bigint") return "int";
  if (v instanceof FlottantPy) return "float";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  return Array.isArray(v) ? "list" : "dict";
}

type Dimensions = { sentW: number; sentH: number; nativeW: number; nativeH: number };

/** Une requête chat/completions → éléments natifs ; `null` = échec dur (diagnostic posé), `[]` = aucune boîte. */
async function passeLlm(
  c: Appel,
  png: Uint8Array,
  consigne: string,
  o: { url: string; model: string; entetes: Record<string, string>; timeout: number } & Dimensions,
): Promise<ElementVision[] | null> {
  const corps: Dict = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: consigne },
          { type: "image_url", image_url: { url: dataUrl(png) } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 3000,
    stream: false,
  };
  if (o.model) corps["model"] = o.model;
  let r: ReponsePost;
  try {
    r = await envoyer(c, o.url, json(corps), o.entetes, o.timeout);
  } catch (e) {
    if (!(e instanceof ErreurRequests)) throw e;
    log.warn(`llm : request to ${o.url} failed: ${e.message}`);
    c.erreur = `endpoint LLM injoignable (${e.name})`;
    return null;
  }
  if (r.statut !== 200) {
    log.warn(`llm : ${o.url} returned ${r.statut}: ${prefixePy(texteReponse(r), 300)}`);
    const detail = detailErreur(r);
    c.erreur = `endpoint LLM → HTTP ${r.statut}` + (detail ? ` : ${prefixePy(detail, 200)}` : "");
    return null;
  }
  let lu: { contenu: unknown } | null;
  try {
    lu = contenuChat(jsonReponse(r));
  } catch {
    lu = null;
  }
  if (lu === null) {
    log.warn(`llm : unexpected response shape from ${o.url}: ${prefixePy(texteReponse(r), 300)}`);
    c.erreur = "réponse LLM inattendue (pas un chat/completions ?)";
    return null;
  }
  const contenu = Array.isArray(lu.contenu) ? joindreParties(lu.contenu) : lu.contenu;
  const items = extractJsonArray(contenu);
  const balises = items !== null && items.length > 0 ? [] : extractTagItems(contenu);
  if ((items === null || items.length === 0) && balises.length === 0) {
    log.info(
      `llm : no boxes in this pass (model=${o.model || "?"}). Sample=${prefixePy(strPy(contenu), 200)}`,
    );
    return [];
  }
  const elements: ElementVision[] = [];
  for (const it of items ?? []) {
    if (!estDict(it)) continue;
    const brute = coerceBox(premier(it, ["box", "bbox", "bbox_2d", "box_2d", "coordinates"]));
    if (brute === null) continue;
    const xyxy = toXyxyNative(brute, "xyxy", "auto", o.sentW, o.sentH, o.nativeW, o.nativeH);
    if (xyxy === null) continue;
    elements.push(
      element(labelOf(it, ["label", "name", "text", "content"]), xyxy, scoreOf(it, ["confidence", "score"])),
    );
  }
  for (const it of balises) {
    const xyxy = toXyxyNative(it["box"] as number[], "xyxy", "norm", o.sentW, o.sentH, o.nativeW, o.nativeH);
    if (xyxy === null) continue;
    elements.push(element(it["label"] as string, xyxy, 0));
  }
  return elements;
}

/** LLM multimodal : requête ciblée en une passe, sinon balayage plein écran puis barre système, fusionnés par IoU. */
async function detecterLlm(
  c: Appel,
  png: Uint8Array,
  o: {
    endpoint: string;
    model: string;
    prompt: string;
    entetes: Record<string, string>;
    timeout: number;
    passes: number;
  } & Dimensions,
): Promise<ElementVision[]> {
  const url = chatCompletionsUrl(o.endpoint);
  const commun = {
    url,
    model: o.model,
    entetes: o.entetes,
    timeout: o.timeout,
    sentW: o.sentW,
    sentH: o.sentH,
    nativeW: o.nativeW,
    nativeH: o.nativeH,
  };
  const requete = stripPy(o.prompt || "");
  let elements: ElementVision[];
  if (requete) {
    const gabarit = promptText("VISION_DETECT_QUERY");
    const consigne = gabarit.includes("{query}")
      ? gabarit.split("{query}").join(requete)
      : gabarit + `\nRequest: ${requete}`;
    const premiere = await passeLlm(c, png, consigne, commun);
    if (premiere === null) return [];
    elements = premiere;
  } else {
    const premiere = await passeLlm(c, png, promptText("VISION_DETECT"), commun);
    if (premiere === null) return [];
    elements = premiere;
    if (o.passes >= 2) {
      const seconde = await passeLlm(c, png, promptText("VISION_DETECT_EDGE"), commun);
      for (const el of seconde ?? [])
        if (elements.every((k) => iouXyxy(el.box, k.box) < 0.5)) elements.push(el);
    }
  }
  if (elements.length > 0) {
    c.erreur = "";
    log.info(
      `llm : ${url} → ${elements.length} elements (native ${o.nativeW}x${o.nativeH}, ${Math.max(1, o.passes)} passe(s))`,
    );
  } else if (!c.erreur) {
    log.warn(`llm : 0 box exploitable depuis ${url}`);
    c.erreur = "le modèle n'a renvoyé aucune box exploitable (ni JSON, ni tags <box>)";
  }
  return elements;
}

export type OptionsDetection = {
  endpoint: string;
  fmt?: string | null;
  prompt?: string;
  model?: string;
  authHeader?: string;
  authToken?: string;
  responseMap?: unknown;
  timeout?: number;
  nativeW?: number;
  nativeH?: number;
  passes?: number;
  signal?: AbortSignal;
  poster?: Poster;
};

function valeurOu(d: Dict, cle: string, defaut: unknown): unknown {
  return Object.hasOwn(d, cle) ? d[cle] : defaut;
}

/** `list(x)` : liste, texte (caractères) ou clés d'un dict ; TypeError sinon. */
function listePy(v: unknown): unknown[] {
  const it = iterPy(v);
  if (it === null) throw new ErreurPython("TypeError", `'${nomType(v)}' object is not iterable`);
  return [...it];
}

/** Capture → éléments annotés en pixels natifs ; jamais d'exception réseau (diagnostic dans `erreur`). */
export async function detect(png: Uint8Array, o: OptionsDetection): Promise<ResultatDetection> {
  const c: Appel = { poster: o.poster ?? posterUndici, signal: o.signal, erreur: "" };
  if (!o.endpoint || png.length === 0) return { elements: [], erreur: "" };
  let nativeW = o.nativeW ?? 0;
  let nativeH = o.nativeH ?? 0;
  if (!nativeW || !nativeH) [nativeW, nativeH] = nativeSize(png);
  const { octets: envoye, largeur: sentW } = await imagesBureau().reduireLargeur(
    png,
    DETECT_MAX_WIDTH,
    nativeW,
  );
  const sentH = nativeW && sentW ? Math.trunc(nativeH * (sentW / nativeW)) : nativeH;
  const entete = o.authHeader ?? "Authorization";
  const entetes: Record<string, string> =
    o.authToken && entete ? Object.fromEntries([[entete, o.authToken]]) : {};
  const timeout = o.timeout ?? 30;
  const fmt = o.fmt === undefined ? "omniparser" : o.fmt;
  const prompt = o.prompt ?? "";
  const dims = { sentW, sentH, nativeW, nativeH };
  if (LLM_FORMATS.has(lowerPy(stripPy(fmt ?? "")))) {
    const elements = await detecterLlm(c, envoye, {
      endpoint: o.endpoint,
      model: o.model ?? "",
      prompt,
      entetes,
      timeout,
      passes: o.passes ?? 2,
      ...dims,
    });
    return { elements, erreur: c.erreur };
  }
  const preset = PRESETS[lowerPy(stripPy(fmt ?? ""))] ?? OMNIPARSER;
  const spec: Dict = { ...preset };
  if (veritePy(o.responseMap) && estDict(o.responseMap))
    for (const [k, v] of Object.entries(o.responseMap)) poserCle(spec, k, v);
  const mode = lowerPy(strPy(valeurOu(spec, "request_mode", "json")));
  const champImage = strPy(valeurOu(spec, "image_field", "image"));
  let r: ReponsePost;
  try {
    let corps: { corps: Uint8Array; typeContenu: string };
    if (mode === "multipart") {
      const champ = valeurOu(spec, "file_field", "file");
      const fichier: FichierRequests = {
        champ: strPy(champ),
        nom: "screenshot.png",
        type: "image/png",
        data: envoye,
      };
      corps = multipartRequests(prompt ? [["prompt", prompt]] : [], [fichier]);
    } else {
      const charge: Dict = {};
      poserCle(charge, champImage, dataUrl(envoye));
      if (prompt) {
        poserCle(charge, "prompt", prompt);
        poserCle(charge, "text", prompt);
      }
      corps = json(charge);
    }
    r = await envoyer(c, o.endpoint, corps, entetes, timeout);
  } catch (e) {
    if (!(e instanceof ErreurRequests)) throw e;
    log.warn(`request to ${o.endpoint} failed: ${e.message}`);
    return { elements: [], erreur: `endpoint injoignable (${e.name})` };
  }
  if (r.statut !== 200) {
    log.warn(`endpoint ${o.endpoint} returned ${r.statut}: ${prefixePy(texteReponse(r), 300)}`);
    return {
      elements: [],
      erreur: `endpoint → HTTP ${r.statut} — un serveur llama.cpp se configure avec le format « LLM multimodal », pas un format détecteur dédié`,
    };
  }
  let charge: unknown;
  try {
    charge = jsonReponse(r);
  } catch {
    log.warn(`non-JSON response from ${o.endpoint}`);
    return { elements: [], erreur: "réponse non-JSON de l'endpoint" };
  }
  const format = lowerPy(strPy(valeurOu(spec, "box_format", "xyxy")));
  const coords = lowerPy(strPy(valeurOu(spec, "coords", "auto")));
  const elements: ElementVision[] = [];
  const items = findListOfDicts(charge, listePy(valeurOu(spec, "items", [])));
  if (items !== null && items.length > 0) {
    for (const it of items) {
      const brute = coerceBox(premier(it, listePy(valeurOu(spec, "box", []))));
      if (brute === null) continue;
      const xyxy = toXyxyNative(brute, format, coords, sentW, sentH, nativeW, nativeH);
      if (xyxy === null) continue;
      elements.push(
        element(
          labelOf(it, listePy(valeurOu(spec, "label", []))),
          xyxy,
          scoreOf(it, listePy(valeurOu(spec, "score", []))),
        ),
      );
    }
  } else {
    const tableaux = exigerDict(ou(valeurOu(spec, "arrays", {}), {}));
    const boites = findArray(charge, listePy(valeurOu(tableaux, "box", []))) ?? [];
    const libelles = findArray(charge, listePy(valeurOu(tableaux, "label", []))) ?? [];
    const scores = findArray(charge, listePy(valeurOu(tableaux, "score", []))) ?? [];
    boites.forEach((brut, i) => {
      const boite = coerceBox(brut);
      if (boite === null) return;
      const xyxy = toXyxyNative(boite, format, coords, sentW, sentH, nativeW, nativeH);
      if (xyxy === null) return;
      const lab = i < libelles.length ? libelles[i] : "element";
      const score = i < scores.length && isNum(scores[i]) ? arrondiPy(floatPy(scores[i]), 3) : 0;
      elements.push(
        element(lab !== null && lab !== undefined ? stripPy(strPy(lab)) : "element", xyxy, score),
      );
    });
  }
  if (elements.length === 0) {
    const cles = estDict(charge) ? reprPy(Object.keys(charge)) : nomType(charge);
    log.warn(`no boxes parsed from ${o.endpoint} (format=${strPy(fmt)}). Top-level=${cles}`);
    return {
      elements,
      erreur: `réponse 200 mais aucune box parsée (format=${strPy(fmt)}, clés=${cles}) — voir vision.response_map`,
    };
  }
  log.info(`${o.endpoint} → ${elements.length} elements (native ${nativeW}x${nativeH})`);
  return { elements, erreur: "" };
}

export type OptionsLecture = {
  endpoint: string;
  model?: string;
  instruction?: string;
  authHeader?: string;
  authToken?: string;
  timeout?: number;
  signal?: AbortSignal;
  poster?: Poster;
};

/** OCR par LLM multimodal : texte visible (`""` si « (no text) »), `null` sur échec dur avec le diagnostic. */
export async function readText(
  png: Uint8Array,
  o: OptionsLecture,
): Promise<{ texte: string | null; erreur: string }> {
  const c: Appel = { poster: o.poster ?? posterUndici, signal: o.signal, erreur: "" };
  if (!o.endpoint || png.length === 0) return { texte: null, erreur: "endpoint vision non configuré" };
  const url = chatCompletionsUrl(o.endpoint);
  const consigne = stripPy(o.instruction || "") || LLM_READ_PROMPT;
  const entete = o.authHeader ?? "Authorization";
  const entetes: Record<string, string> =
    o.authToken && entete ? Object.fromEntries([[entete, o.authToken]]) : {};
  const corps: Dict = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: consigne },
          { type: "image_url", image_url: { url: dataUrl(png) } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 2000,
    stream: false,
  };
  if (o.model) corps["model"] = o.model;
  let r: ReponsePost;
  try {
    r = await envoyer(c, url, json(corps), entetes, o.timeout ?? 60);
  } catch (e) {
    if (!(e instanceof ErreurRequests)) throw e;
    log.warn(`lecture : request to ${url} failed: ${e.message}`);
    return { texte: null, erreur: `endpoint LLM injoignable (${e.name})` };
  }
  if (r.statut !== 200) {
    const detail = detailErreur(r);
    return {
      texte: null,
      erreur: `endpoint LLM → HTTP ${r.statut}` + (detail ? ` : ${prefixePy(detail, 200)}` : ""),
    };
  }
  let lu: { contenu: unknown } | null;
  try {
    lu = contenuChat(jsonReponse(r));
  } catch {
    lu = null;
  }
  if (lu === null) return { texte: null, erreur: "réponse LLM inattendue (pas un chat/completions ?)" };
  const brut = Array.isArray(lu.contenu) ? joindreParties(lu.contenu) : lu.contenu;
  let texte = stripPy(strPy(brut).replace(THINK, ""));
  if (texte.startsWith("```")) texte = stripPy(texte.replace(/^```[a-zA-Z]*\n?|\n?```$/g, ""));
  return { texte: texte === "(no text)" ? "" : texte, erreur: "" };
}
