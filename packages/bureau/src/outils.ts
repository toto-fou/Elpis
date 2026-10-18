// SPDX-License-Identifier: MIT
/** packages/bureau/src/outils.ts — primitives `*_core` de desktop_tools : capture, observation (arbre a11y ⊕ vision, mémos dHash), action, OCR, lancement, écrans ; partagées par les routes du Studio et le rejeu. */
import { writeFile } from "node:fs/promises";

import {
  arrondiEntierPy,
  arrondiPy,
  casefoldPy,
  copieDict,
  ErreurPython,
  estDict,
  floatPy,
  getPy,
  intPy,
  iterExige,
  longueurPy,
  lowerPy,
  ouPy as ou,
  poserCle,
  sansAccentsPy,
  splitPy,
  stripPy,
  strPy,
  texteOu,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import { journal } from "@elpis/http";
import { tokenUrlsafe } from "@elpis/securite";

import { agentReq, noTargetErr, ok, resolveTarget } from "./agent";
import type { Cible } from "./agent";
import { detect, promptText, readText } from "./detection";
import type { ElementVision } from "./detection";
import { b64decodePy, cropForRegion, frameSig, pngSize, stripDataUrl } from "./image";
import { err } from "./ports";
import type { PrimitivesBureau } from "./ports";
import { checkExpect, hamHex, ReplayAborted, waitStable } from "./rejeu";
import {
  ambiguousQueryCandidates,
  assignStableIds,
  desktopFramePath,
  ensureScreensDir,
  getScreenDims,
  pruneFrames,
  registerDesktopFrameOwner,
  registerDesktopObservation,
  resolveElement,
  resolveElementImpl,
  sequencePy,
  setScreenDims,
  validatePoint,
} from "./session";

const log = journal("desktop");

/** `float(os.environ.get(nom, defaut) or repli)` lu au chargement, comme les globales du module Python. */
function flottantEnv(nom: string, defaut: string, repli: number): number {
  const v = process.env[nom] ?? defaut;
  return v ? floatPy(v) : repli;
}

/** Mémos et plafonds de l'observation ; modifiables par les tests comme les globales Python. */
export const REGLAGES_BUREAU = {
  sigSameObs: 2,
  visionMemoTtlS: flottantEnv("DESKTOP_VISION_MEMO_TTL_S", "1.5", 1.5),
  visionPromptMemoTtlS: flottantEnv("DESKTOP_VISION_PROMPT_MEMO_TTL_S", "3.0", 3.0),
  a11yMemoTtlS: flottantEnv("DESKTOP_A11Y_MEMO_TTL_S", "1.0", 0),
  memoCap: 64,
  uiTreeMaxNodes: 400,
};

type Memo = { sig: string; ts: number; elements?: unknown[]; vision?: ElementVision[]; cible?: string };
const memoA11y = new Map<string, Memo>();
const memoVision = new Map<string, Memo>();
const memoVisionPrompt = new Map<string, Memo>();

const maintenant = (): number => Date.now() / 1000;

/** Vide les mémos d'observation (tests). */
export function reinitialiserMemosBureau(): void {
  memoA11y.clear();
  memoVision.clear();
  memoVisionPrompt.clear();
}

/** `_norm_scope` : "" → `DESKTOP_OBSERVE_SCOPE`, inconnu → `focus`. */
export function normScope(scope: unknown): string {
  const s =
    lowerPy(stripPy(veritePy(scope) ? strPy(scope) : "")) ||
    (veritePy(config.DESKTOP_OBSERVE_SCOPE) ? strPy(config.DESKTOP_OBSERVE_SCOPE) : "focus");
  return s === "focus" || s === "monitor" || s === "desktop" ? s : "focus";
}

/** `_memo_put` : écrit puis, au-delà du plafond, purge les entrées franchement expirées (ttl×4) puis les plus vieilles. */
export function memoPut(
  d: Map<string, Memo>,
  cle: string,
  rec: Memo,
  ttl: number,
  cap = REGLAGES_BUREAU.memoCap,
): void {
  d.set(cle, rec);
  if (d.size <= cap) return;
  if (ttl > 0) {
    const t = maintenant();
    for (const [k, v] of [...d]) if (t - v.ts > ttl * 4) d.delete(k);
  }
  if (d.size > cap)
    for (const [k] of [...d].sort((a, b) => a[1].ts - b[1].ts).slice(0, d.size - cap)) d.delete(k);
}

/** `_invalidate_a11y_memo` : après une action mutante, arbres (toutes portées) et boxes vision de la cible sont périmés. */
export function invalidateA11yMemo(cible: string): void {
  memoA11y.delete(cible);
  for (const k of [...memoA11y.keys()]) if (k.startsWith(`${cible}::`)) memoA11y.delete(k);
  memoVision.delete(cible);
  for (const [k, v] of [...memoVisionPrompt]) if (v.cible === cible) memoVisionPrompt.delete(k);
}

type Capture = [Uint8Array, number, number];

/** `_grab` : capture de l'agent → `[octets, largeur, hauteur]`, ou l'`err()` de l'agent. */
export async function grab(cible: Cible, fmt: string | null = null): Promise<Dict | Capture> {
  const format = fmt || config.DESKTOP_SCREENSHOT_FORMAT || "png";
  const shot = await agentReq(cible, "/screenshot", {
    format,
    quality: intPy(config.DESKTOP_SCREENSHOT_QUALITY),
  });
  if (veritePy(getPy(shot, "error"))) return shot;
  let img = getPy(shot, "image");
  if (!veritePy(img)) img = getPy(shot, "image_b64");
  if (!veritePy(img)) img = getPy(shot, "png");
  if (!veritePy(img))
    return err("no_screenshot", "control-agent did not return an image", {
      fix: "check the agent's screenshot backend (Wayland may need grim/portal)",
    });
  let png: Uint8Array;
  try {
    if (typeof img !== "string")
      throw new ErreurPython("TypeError", "argument should be a bytes-like object");
    png = b64decodePy(stripDataUrl(img));
  } catch {
    return err("bad_screenshot", "control-agent image was not valid base64");
  }
  let w = intPy(veritePy(getPy(shot, "width")) ? getPy(shot, "width") : 0);
  let h = intPy(veritePy(getPy(shot, "height")) ? getPy(shot, "height") : 0);
  if (!w || !h) [w, h] = pngSize(png);
  return [png, w, h];
}

/** `_save_frame` : trame écrite dans le dossier partagé sous un jeton opaque, propriété enregistrée, vieilles trames élaguées. */
export async function saveFrame(png: Uint8Array, owner: string): Promise<string> {
  const jeton = tokenUrlsafe(16);
  await ensureScreensDir();
  try {
    await writeFile(desktopFramePath(jeton), png);
  } catch (e) {
    log.warn(`[desktop] frame save failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (owner) await registerDesktopFrameOwner(jeton, owner);
  await pruneFrames();
  return jeton;
}

/** `grab_core` : capture brute → signature, sans détection (sonde la moins chère, attentes du rejeu). */
export async function grabCore(username: string, target = ""): Promise<Dict> {
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  const g = await grab(cible);
  if (!Array.isArray(g)) return g;
  const [png, w, h] = g;
  setScreenDims(username, cible.name, w, h);
  return ok({ target: cible.name, img_w: w, img_h: h, sig: await frameSig(png) });
}

/** `_element_importance` : auto_id (3) + libellé (2) + vision (1), pour la troncature. */
export function elementImportance(e: unknown): number {
  let score = 0;
  if (stripPy(strPy(veritePy(getPy(e, "auto_id")) ? getPy(e, "auto_id") : ""))) score += 3;
  const libelle = veritePy(getPy(e, "label")) ? getPy(e, "label") : getPy(e, "name");
  if (stripPy(strPy(veritePy(libelle) ? libelle : ""))) score += 2;
  if (getPy(e, "source") !== "a11y") score += 1;
  return score;
}

/** `_iou` de deux boîtes x1,y1,x2,y2. */
export function iou(a: readonly number[], b: readonly number[]): number {
  const [ax1, ay1, ax2, ay2] = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0];
  const [bx1, by1, bx2, by2] = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0];
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const inter = iw * ih;
  if (!(inter > 0)) return 0;
  const union =
    Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1) + Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1) - inter;
  return union > 0 ? inter / union : 0;
}

/** `_action_hint` : verbe primaire d'après les control patterns et le rôle (`toggle`, `select`, `expand`, `set`, sinon ""). */
export function actionHint(role: unknown, patterns: unknown): string {
  const p = new Set(iterExige(veritePy(patterns) ? patterns : []).map((x) => lowerPy(stripPy(strPy(x)))));
  const r = lowerPy(stripPy(strPy(veritePy(role) ? role : "")));
  if (p.has("toggle") || ["checkbox", "togglebutton", "switch"].includes(r)) return "toggle";
  if (p.has("selectionitem") || ["listitem", "tabitem", "radiobutton", "menuitemradio"].includes(r))
    return "select";
  if (p.has("expandcollapse") && ["combobox", "menuitem", "treeitem", "splitbutton", "button"].includes(r))
    return "expand";
  if (
    p.has("value") &&
    ["edit", "textbox", "document", "spinner", "spinbutton", "slider", "combobox"].includes(r)
  )
    return "set";
  return "";
}

const texteOuVide = (v: unknown): string => texteOu(v, "");

/** `_merge_elements` : nœuds a11y (sémantique) ⊕ détections vision (couverture) ; l'a11y gagne au recouvrement (IoU ≥ 0,55). */
export function mergeElements(a11y: unknown, vision: readonly unknown[]): Dict[] {
  const fusion: Dict[] = [];
  for (const e of iterExige(ou(a11y, []))) {
    const rect = ou(getPy(e, "rect"), getPy(e, "box"));
    if (!Array.isArray(rect) || rect.length < 4) continue;
    const r = rect.slice(0, 4).map(floatPy) as [number, number, number, number];
    const boite =
      veritePy(getPy(e, "box")) && !veritePy(getPy(e, "rect")) ? r : [r[0], r[1], r[0] + r[2], r[1] + r[3]];
    if ((boite[2] ?? 0) - (boite[0] ?? 0) < 2 || (boite[3] ?? 0) - (boite[1] ?? 0) < 2) continue;
    fusion.push({
      box: boite,
      role: texteOuVide(getPy(e, "role")),
      name: texteOuVide(getPy(e, "name")),
      auto_id: texteOuVide(getPy(e, "auto_id")),
      runtime_id: texteOuVide(getPy(e, "runtime_id")),
      class_name: texteOuVide(getPy(e, "class_name")),
      depth: intPy(ou(getPy(e, "depth"), 0)),
      value: getPy(e, "value"),
      states: ou(getPy(e, "states"), []),
      patterns: ou(getPy(e, "patterns"), []),
      source: "a11y",
      confidence: 1.0,
    });
  }
  const utilises = new Set<number>();
  for (const [i, v] of (vision ?? []).entries()) {
    const vb = getPy(v, "box");
    if (!Array.isArray(vb) || vb.length < 4) continue;
    const vf = vb.map(floatPy);
    let meilleur: Dict | null = null;
    let meilleurIou = 0;
    for (const o of fusion) {
      const j = iou(vf, o["box"] as number[]);
      if (j > meilleurIou) [meilleur, meilleurIou] = [o, j];
    }
    if (meilleur !== null && meilleurIou >= 0.55) {
      meilleur["source"] = "merged";
      if (!veritePy(meilleur["name"])) {
        meilleur["name"] = texteOuVide(getPy(v, "label"));
        meilleur["name_from_vision"] = true;
      }
      meilleur["confidence"] = Math.max(
        floatPy(ou(meilleur["confidence"], 0)),
        floatPy(ou(getPy(v, "confidence"), 0)),
      );
      utilises.add(i);
    }
  }
  for (const [i, v] of (vision ?? []).entries()) {
    if (utilises.has(i)) continue;
    const vb = getPy(v, "box");
    if (!Array.isArray(vb) || vb.length < 4) continue;
    fusion.push({
      box: vb.slice(0, 4).map(floatPy),
      role: "",
      name: texteOuVide(getPy(v, "label")),
      auto_id: "",
      runtime_id: "",
      class_name: "",
      depth: 0,
      value: null,
      states: [],
      patterns: [],
      source: "vision",
      confidence: floatPy(ou(getPy(v, "confidence"), 0)),
    });
  }
  return fusion.map((e, k) => {
    const b = e["box"] as number[];
    const [b0, b1, b2, b3] = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0];
    const rec: Dict = {
      id: `el_${k + 1}`,
      label: ou(ou(e["name"], e["role"]), "element"),
      role: e["role"],
      auto_id: e["auto_id"],
      runtime_id: e["runtime_id"],
      class_name: e["class_name"],
      depth: intPy(ou(e["depth"], 0)),
      box: [arrondiEntierPy(b0), arrondiEntierPy(b1), arrondiEntierPy(b2), arrondiEntierPy(b3)],
      center: [arrondiEntierPy((b0 + b2) / 2), arrondiEntierPy((b1 + b3) / 2)],
      value: e["value"],
      states: ou(e["states"], []),
      patterns: ou(e["patterns"], []),
      do: actionHint(e["role"], e["patterns"]),
      source: e["source"],
      confidence: versFlottantPy(arrondiPy(floatPy(ou(e["confidence"], 0)), 3)),
    };
    if (!veritePy(e["name"]) || veritePy(e["name_from_vision"])) {
      rec["unnamed"] = true;
      if (veritePy(e["name_from_vision"])) rec["label_source"] = "vision";
    }
    return rec;
  });
}

/** Corps de `/ui_tree` : plafond de nœuds, portée, éventail élargi au-delà du défaut. */
function corpsArbre(plafond: number, scope: string): Dict {
  const corps: Dict = { max_nodes: plafond, scope };
  if (plafond > REGLAGES_BUREAU.uiTreeMaxNodes)
    corps["fanout"] = Math.max(80, Math.min(400, Math.floor(plafond / 5)));
  return corps;
}

export type OptionsObserve = {
  prompt?: string;
  use_vision?: boolean;
  use_tree?: boolean;
  max_elements?: number;
  scope?: string;
  persist_frame?: boolean;
  max_nodes?: number;
};

/** `observe_core` : capture → vision ⊕ arbre a11y → éléments annotés aux ids stables, inscrits pour l'action ; mémos dHash. */
export async function observeCore(username: string, target = "", o: OptionsObserve = {}): Promise<Dict> {
  const prompt = o.prompt ?? "";
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  const scope = normScope(o.scope ?? "");
  const g = await grab(cible);
  if (!Array.isArray(g)) return g;
  const png = g[0];
  let [w, h] = [g[1], g[2]];
  const sig = await frameSig(png);
  let a11y: unknown[] = [];
  const plafond = intPy(o.max_nodes ?? 0) || REGLAGES_BUREAU.uiTreeMaxNodes;
  let arbreTronque = false;
  if (o.use_tree ?? true) {
    const cle =
      `${cible.name}::${scope}` + (plafond !== REGLAGES_BUREAU.uiTreeMaxNodes ? `::${plafond}` : "");
    const memo = memoA11y.get(cle);
    const ttl = REGLAGES_BUREAU.a11yMemoTtlS;
    if (
      ttl > 0 &&
      memo &&
      maintenant() - memo.ts < ttl &&
      hamHex(memo.sig, sig) <= REGLAGES_BUREAU.sigSameObs
    )
      a11y = memo.elements ?? [];
    else {
      const arbre = await agentReq(cible, "/ui_tree", corpsArbre(plafond, scope));
      if (!veritePy(getPy(arbre, "error"))) {
        const els = getPy(arbre, "elements");
        if (Array.isArray(els)) a11y = els;
      }
      memoPut(memoA11y, cle, { sig, elements: a11y, ts: maintenant() }, ttl);
    }
    arbreTronque = a11y.length >= plafond && plafond > 0;
  }
  let vision: ElementVision[] = [];
  let erreurVision = "";
  const seuil = intPy(config.VISION_A11Y_SKIP_MIN || 0);
  const a11yRiche = seuil > 0 && !prompt && a11y.length >= seuil;
  if ((o.use_vision ?? true) && config.VISION_ENDPOINT_URL && !a11yRiche) {
    const [d, cle, ttl, cap] = prompt
      ? [memoVisionPrompt, JSON.stringify([cible.name, prompt]), REGLAGES_BUREAU.visionPromptMemoTtlS, 32]
      : [memoVision, cible.name, REGLAGES_BUREAU.visionMemoTtlS, REGLAGES_BUREAU.memoCap];
    const pm = d.get(cle);
    if (ttl > 0 && pm && maintenant() - pm.ts < ttl && hamHex(pm.sig, sig) <= REGLAGES_BUREAU.sigSameObs)
      vision = pm.vision ?? [];
    else {
      const r = await detect(png, {
        endpoint: config.VISION_ENDPOINT_URL,
        fmt: config.VISION_FORMAT,
        prompt: prompt || config.VISION_PROMPT,
        model: config.VISION_MODEL,
        responseMap: config.VISION_RESPONSE_MAP,
        timeout: config.VISION_TIMEOUT_SEC,
        nativeW: w,
        nativeH: h,
        passes: config.VISION_PASSES,
      });
      vision = r.elements;
      erreurVision = r.erreur;
      if (vision.length > 0) memoPut(d, cle, { sig, vision, ts: maintenant(), cible: cible.name }, ttl, cap);
    }
    if (vision.length === 0) erreurVision = erreurVision || "0 élément renvoyé";
    else erreurVision = "";
  }
  let elements: unknown[] = mergeElements(a11y, vision);
  const total = elements.length;
  let tronque = false;
  const maxElements = o.max_elements ?? 0;
  if (Number.isInteger(maxElements) && maxElements > 0 && maxElements < elements.length) {
    elements = elements
      .map((e, i) => [elementImportance(e), i, e] as const)
      .sort((a, b) => b[0] - a[0] || a[1] - b[1])
      .slice(0, maxElements)
      .map((x) => x[2]);
    tronque = true;
  }
  const jeton = (o.persist_frame ?? true) ? await saveFrame(png, username) : null;
  elements = assignStableIds(username, cible.name, elements);
  registerDesktopObservation(username, cible.name, elements);
  setScreenDims(username, cible.name, w, h);
  if (!w || !h) {
    const [w2, h2] = pngSize(png);
    [w, h] = [w || w2, h || h2];
  }
  let note: string | null = null;
  if (elements.length === 0 && !config.VISION_ENDPOINT_URL && a11y.length === 0)
    note =
      "no detection endpoint configured and no accessibility tree — " +
      "set an endpoint in Admin → Vision & Desktop, or act by raw x,y";
  else if (erreurVision) note = `annotation vision KO : ${erreurVision}`;
  if (tronque) {
    const t = `${total} elements detected, ${elements.length} shown (most actionable) — narrow with prompt= or scroll`;
    note = note ? `${note} · ${t}` : t;
  }
  if (arbreTronque) {
    const c = `arbre a11y tronqué à ${a11y.length} nœuds (plafond atteint) : des éléments profonds peuvent manquer`;
    note = note ? `${note} · ${c}` : c;
  }
  return ok({
    target: cible.name,
    img_w: w,
    img_h: h,
    sig,
    count: elements.length,
    total,
    truncated: tronque,
    elements,
    frame_token: jeton,
    vision_used: vision.length > 0,
    tree_used: a11y.length > 0,
    note,
    tree_nodes: a11y.length,
    tree_capped: arbreTronque,
  });
}

/** `_chat_element_cap` : plafond d'éléments du chemin chat (`max_elements_chat` > 0, sinon `max_elements`). */
export function chatElementCap(): number {
  const chat = intPy(config.DESKTOP_MAX_ELEMENTS_CHAT || 0);
  return chat > 0 ? chat : intPy(config.DESKTOP_MAX_ELEMENTS || 0);
}

/** `probe_tree_core` : arbre a11y seul (ni capture, ni vision, ni trame, ni mémo) → mêmes éléments et ids qu'`observe_core`. */
export async function probeTreeCore(username: string, target = "", scope = "", maxNodes = 0): Promise<Dict> {
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  const portee = normScope(scope);
  const plafond = intPy(maxNodes || 0) || REGLAGES_BUREAU.uiTreeMaxNodes;
  const arbre = await agentReq(cible, "/ui_tree", corpsArbre(plafond, portee));
  if (veritePy(getPy(arbre, "error"))) return arbre;
  const brut = getPy(arbre, "elements");
  const a11y = Array.isArray(brut) ? brut : [];
  const w = intPy(ou(getPy(ou(arbre, {}), "width"), 0));
  const h = intPy(ou(getPy(ou(arbre, {}), "height"), 0));
  let elements: unknown[] = mergeElements(a11y, []);
  elements = assignStableIds(username, cible.name, elements);
  registerDesktopObservation(username, cible.name, elements);
  if (w && h) setScreenDims(username, cible.name, w, h);
  return ok({
    target: cible.name,
    img_w: w,
    img_h: h,
    count: elements.length,
    elements,
    tree_used: a11y.length > 0,
    frame_token: null,
    tree_nodes: a11y.length,
    tree_capped: a11y.length >= plafond && plafond > 0,
  });
}

/** `read_text_core` : OCR du texte affiché ; zone fournie > élément observé > requête localisée par la vision > plein écran. */
export async function readTextCore(
  username: string,
  target = "",
  query = "",
  elementId = "",
  region: unknown = null,
): Promise<Dict> {
  if (!config.VISION_ENDPOINT_URL)
    return err("no_vision_endpoint", "no annotation/vision endpoint configured", {
      fix: "set a multimodal LLM endpoint in Admin → Vision & Desktop",
    });
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  const g = await grab(cible, "png");
  if (!Array.isArray(g)) return g;
  const [png, w, h] = g;
  let boite: unknown[] | null = null;
  let zone: unknown = "plein écran";
  if (Array.isArray(region) && region.length >= 4) {
    boite = region.slice(0, 4).map(floatPy);
    zone = "zone fournie";
  } else if (elementId) {
    const el = await resolveElement(username, cible.name, { element_id: elementId });
    if (veritePy(el) && Array.isArray(getPy(el, "box"))) {
      boite = getPy(el, "box") as unknown[];
      zone = ou(getPy(el, "label"), elementId);
    }
  } else if (query) {
    const trouves = await detect(png, {
      endpoint: config.VISION_ENDPOINT_URL,
      fmt: config.VISION_FORMAT,
      prompt: query,
      model: config.VISION_MODEL,
      responseMap: config.VISION_RESPONSE_MAP,
      timeout: config.VISION_TIMEOUT_SEC,
      nativeW: w,
      nativeH: h,
      passes: 1,
    });
    const premier = trouves.elements[0];
    if (premier !== undefined && Array.isArray(premier.box)) {
      boite = premier.box;
      zone = ou(premier.label, query);
    }
  }
  const image = boite !== null && boite.length > 0 ? await cropForRegion(png, boite) : png;
  const lu = await readText(image, {
    endpoint: config.VISION_ENDPOINT_URL,
    model: config.VISION_MODEL,
    instruction: promptText("VISION_READ"),
    timeout: config.VISION_TIMEOUT_SEC,
  });
  if (lu.texte === null)
    return err("read_failed", `lecture du texte KO : ${lu.erreur || "?"}`, {
      fix: "check the vision endpoint (is the multimodal model reachable?)",
    });
  return ok({
    target: cible.name,
    region: zone,
    box: boite !== null && boite.length > 0 ? boite.map(intPy) : null,
    text: lu.texte,
    chars: longueurPy(lu.texte),
  });
}

/** Ops sémantiques : l'agent re-cible le contrôle (auto_id/name) au moment d'agir et l'actionne par son pattern UIA. */
export const SEMANTIC_OPS: ReadonlySet<string> = new Set([
  "invoke",
  "set_value",
  "toggle",
  "check",
  "uncheck",
  "select",
  "expand",
  "collapse",
  "scroll_into_view",
]);
const ELEMENT_OPS: ReadonlySet<string> = new Set([
  "toggle",
  "check",
  "uncheck",
  "select",
  "expand",
  "collapse",
  "scroll_into_view",
]);
const OPS_POINT: ReadonlySet<string> = new Set([
  "click",
  "left_click",
  "double_click",
  "right_click",
  "triple_click",
  "middle_click",
  "move",
  "drag",
]);
const OPS_CLIC: ReadonlySet<string> = new Set([
  "click",
  "left_click",
  "double_click",
  "right_click",
  "triple_click",
  "middle_click",
]);
const OPS_VALIDES = [
  "click",
  "double_click",
  "triple_click",
  "right_click",
  "middle_click",
  "invoke",
  "set_value",
  "toggle",
  "check",
  "uncheck",
  "select",
  "expand",
  "collapse",
  "scroll_into_view",
  "type",
  "key",
  "paste",
  "copy",
  "scroll",
  "move",
  "drag",
];

/** Arguments nommés d'`act_core` et leurs défauts Python. */
const DEFAUTS_ACT: Dict = {
  op: "",
  element_id: "",
  query: "",
  auto_id: "",
  name: "",
  control_type: "",
  x: null,
  y: null,
  x2: null,
  y2: null,
  text: "",
  keys: "",
  button: "left",
  clicks: 1,
  dy: 0,
  modifiers: "",
  settle_ms: 0,
  observe_after: true,
  semantic_click: false,
  expect_sig: "",
  return_elements: false,
};

const estNone = (v: unknown): boolean => v === null || v === undefined;

/** `"\n" in s` / `len(s)` d'un argument texte (TypeError hors texte, comme Python). */
function texteArg(v: unknown, nom: string): string {
  if (typeof v === "string") return v;
  throw new ErreurPython("TypeError", `argument '${nom}' must be str`);
}

/** `int(c[0]), int(c[1])` du centre d'un élément s'il en a deux composantes. */
function centreDe(el: unknown): [number, number] | null {
  const c = sequencePy(ou(getPy(el, "center"), []));
  return c.n >= 2 ? [intPy(c.at(0)), intPy(c.at(1))] : null;
}

/** `act_core` : UNE action sur la cible (chat, clic du Studio, rejeu : même chemin) ; coordonnées > élément observé > erreur. */
export async function actCore(username: string, target: string, kw: Dict): Promise<Dict> {
  const a = (k: string): unknown => (Object.hasOwn(kw, k) ? kw[k] : DEFAUTS_ACT[k]);
  const [elementId, query, autoId, name, controlType] = [
    a("element_id"),
    a("query"),
    a("auto_id"),
    a("name"),
    a("control_type"),
  ];
  const [x, y, x2, y2, text, keys, button] = [
    a("x"),
    a("y"),
    a("x2"),
    a("y2"),
    a("text"),
    a("keys"),
    a("button"),
  ];
  const [clicks, dy, modifiers, settleMs] = [a("clicks"), a("dy"), a("modifiers"), a("settle_ms")];
  const semanticClick = veritePy(a("semantic_click"));
  const expectSig = a("expect_sig");
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  const brut = a("op");
  const op = veritePy(brut) ? lowerPy(stripPy(texteArg(brut, "op"))) : "";
  if (
    semanticClick &&
    veritePy(query) &&
    !(veritePy(elementId) || veritePy(autoId)) &&
    estNone(x) &&
    estNone(y)
  ) {
    const amb = await ambiguousQueryCandidates(username, cible.name, query);
    if (veritePy(amb))
      return err(
        "need_disambiguation",
        `« ${strPy(query)} » correspond à ${(amb ?? []).length} éléments distincts`,
        {
          fix: "pass the exact element_id from a desktop_observe",
          nextAction: `desktop_act(op="${op || "click"}", element_id="el_N")`,
          candidates: (amb ?? []).slice(0, 8).map((e) => ({
            id: getPy(e, "id"),
            label: ou(ou(getPy(e, "label"), getPy(e, "name")), ""),
            role: ou(getPy(e, "role"), ""),
          })),
        },
      );
  }
  let point: [number, number] | null = null;
  let resolu: unknown = null;
  let resoluPar = "";
  if (!estNone(x) && !estNone(y)) {
    point = [intPy(x), intPy(y)];
    resoluPar = "coords";
  } else if (SEMANTIC_OPS.has(op)) point = null;
  else if (veritePy(elementId) || veritePy(query) || veritePy(autoId)) {
    const [el, par] = await resolveElementImpl(username, cible.name, {
      element_id: veritePy(elementId) ? elementId : null,
      query: veritePy(query) ? query : null,
      auto_id: veritePy(autoId) ? autoId : null,
    });
    resoluPar = par;
    if (!veritePy(el))
      return err(
        "element_not_found",
        `no observed element matches id='${strPy(elementId)}' query='${strPy(query)}'`,
        {
          fix: "call desktop_observe first, then pass an id from its result",
          nextAction: "desktop_observe(target=...)",
        },
      );
    resolu = el;
    point = centreDe(el) ?? point;
  }
  const besoinPoint = OPS_POINT.has(op);
  if (besoinPoint && !point)
    return err("need_point", `'${op}' needs element_id, query, or x,y`, {
      fix: "pass element_id from desktop_observe, or explicit x,y",
      nextAction: "desktop_observe()",
    });
  if (point !== null) {
    const vp = validatePoint(point, getScreenDims(username, cible.name));
    if (vp === null)
      return err("point_out_of_bounds", `(${point[0]},${point[1]}) is outside the captured screen`, {
        fix: "re-observe (the screen may have moved/resized), then act on an element id",
      });
    point = vp;
  }
  const seuilPerime = intPy(config.DESKTOP_STALE_FRAME_HAM || 0);
  if (veritePy(expectSig) && resoluPar === "coords" && besoinPoint && seuilPerime > 0) {
    const cur = await grab(cible);
    if (Array.isArray(cur)) {
      const [curPng, cw, ch] = cur;
      const curSig = await frameSig(curPng);
      if (curSig && hamHex(curSig, expectSig) >= seuilPerime)
        return err(
          "stale_frame",
          "l'écran a changé depuis la capture affichée — la cible a " +
            "peut-être bougé ; le stage a été rafraîchi, vise à nouveau",
          {
            fix: "re-click the element on the refreshed capture",
            target: cible.name,
            frame_token: await saveFrame(curPng, username),
            sig: curSig,
            img_w: cw,
            img_h: ch,
          },
        );
    }
  }
  let sigAvant = "";
  if (semanticClick && (op === "type" || op === "paste")) {
    const t = texteArg(text, "text");
    if (t.includes("\n") || longueurPy(t) >= 24) {
      const gb = await grab(cible);
      if (Array.isArray(gb)) sigAvant = await frameSig(gb[0]);
    }
  }
  let texteCopie: unknown;
  let r: Dict;
  const avecPoint = (corps: Dict, p: [number, number] | null): Dict => {
    if (p !== null) [corps["x"], corps["y"]] = p;
    return corps;
  };
  if (op === "invoke") {
    if (!(veritePy(autoId) || veritePy(name) || point))
      return err("need_target", "invoke needs auto_id/name or x,y", {
        fix: "pass auto_id from desktop_observe, or explicit x,y",
        nextAction: "desktop_observe()",
      });
    r = await agentReq(
      cible,
      "/invoke",
      avecPoint(
        { auto_id: autoId, name, control_type: controlType, button, clicks: intPy(ou(clicks, 1)) },
        point,
      ),
    );
  } else if (op === "set_value") {
    if (!veritePy(text)) return err("need_text", "set_value needs `text`", { fix: 'pass text="..."' });
    let [aid, nm, ct, svPoint] = [autoId, name, controlType, point];
    if (!(veritePy(aid) || veritePy(nm)) && (veritePy(elementId) || veritePy(query))) {
      const [el, par] = await resolveElementImpl(username, cible.name, {
        element_id: veritePy(elementId) ? elementId : null,
        query: veritePy(query) ? query : null,
      });
      resoluPar = par;
      if (veritePy(el)) {
        aid = texteOuVide(getPy(el, "auto_id"));
        if (!(veritePy(getPy(el, "unnamed")) || getPy(el, "label_source") === "vision"))
          nm = texteOuVide(ou(getPy(el, "label"), getPy(el, "name")));
        ct = texteOuVide(getPy(el, "role"));
        if (svPoint === null) svPoint = centreDe(el);
      }
    }
    if (!(veritePy(aid) || veritePy(nm) || svPoint))
      return err("need_target", "set_value needs auto_id/name or element_id/query", {
        fix: "pass auto_id or an element_id from desktop_observe",
        nextAction: "desktop_observe()",
      });
    r = await agentReq(
      cible,
      "/set_value",
      avecPoint({ auto_id: aid, name: nm, control_type: ct, text }, svPoint),
    );
  } else if (OPS_CLIC.has(op)) {
    const aid = texteOuVide(getPy(ou(resolu, {}), "auto_id"));
    const nm = texteOuVide(ou(getPy(ou(resolu, {}), "label"), getPy(ou(resolu, {}), "name")));
    const simpleGauche =
      (op === "click" || op === "left_click") && button === "left" && intPy(ou(clicks, 1)) === 1;
    const p = point as [number, number];
    if (semanticClick && simpleGauche && (aid || nm))
      r = await agentReq(
        cible,
        "/element",
        avecPoint(
          {
            action: "click",
            auto_id: aid,
            name: nm,
            control_type: texteOuVide(getPy(ou(resolu, {}), "role")),
            button: "left",
            clicks: 1,
          },
          point,
        ),
      );
    else {
      const bouton = op === "right_click" ? "right" : op === "middle_click" ? "middle" : button;
      const n = op === "triple_click" ? 3 : op === "double_click" ? 2 : intPy(ou(clicks, 1));
      r = await agentReq(cible, "/click", { x: p[0], y: p[1], button: bouton, clicks: n, modifiers });
    }
  } else if (op === "type") {
    if (!veritePy(text)) return err("need_text", "type needs `text`", { fix: 'pass text="..."' });
    r = await agentReq(cible, "/type", { text });
  } else if (op === "key" || op === "hotkey" || op === "press") {
    const combo = ou(keys, text);
    if (!veritePy(combo))
      return err("need_keys", "key needs `keys`", { fix: 'pass keys="ctrl+s" or keys="enter"' });
    r = await agentReq(cible, "/key", { keys: combo });
  } else if (op === "paste") {
    if (veritePy(text)) {
      r = await agentReq(cible, "/clipboard_set", { text });
      if (veritePy(getPy(r, "error"))) return r;
    }
    r = await agentReq(cible, "/key", { keys: "ctrl+v" });
  } else if (op === "copy") {
    r = await agentReq(cible, "/key", { keys: "ctrl+c" });
    if (!veritePy(getPy(r, "error"))) {
      const cb = await agentReq(cible, "/clipboard_get", {});
      if (!veritePy(getPy(cb, "error"))) texteCopie = getPy(cb, "text", "");
    }
  } else if (op === "scroll") {
    const [px, py] = point ?? [null, null];
    r = await agentReq(cible, "/scroll", { x: px, y: py, dy: intPy(ou(dy, 0)) });
  } else if (op === "move") {
    const p = point as [number, number];
    r = await agentReq(cible, "/move", { x: p[0], y: p[1] });
  } else if (op === "drag") {
    if (estNone(x2) || estNone(y2))
      return err("need_drag_end", "drag needs x2,y2 (end point)", {
        fix: "pass x2,y2; start comes from element_id/query/x,y",
      });
    const p = point as [number, number];
    r = await agentReq(cible, "/drag", { x1: p[0], y1: p[1], x2: intPy(x2), y2: intPy(y2), modifiers });
  } else if (ELEMENT_OPS.has(op)) {
    let [aid, nm, ct, pt] = [autoId, name, controlType, point];
    if (veritePy(elementId) || veritePy(query) || veritePy(autoId)) {
      const [el, par] = await resolveElementImpl(username, cible.name, {
        element_id: veritePy(elementId) ? elementId : null,
        query: veritePy(query) ? query : null,
        auto_id: veritePy(autoId) ? autoId : null,
      });
      resoluPar = par;
      if (veritePy(el)) {
        aid = ou(aid, texteOuVide(getPy(el, "auto_id")));
        nm = ou(nm, texteOuVide(ou(getPy(el, "label"), getPy(el, "name"))));
        ct = ou(ct, texteOuVide(getPy(el, "role")));
        if (pt === null) pt = centreDe(el);
      }
    }
    if (!(veritePy(aid) || veritePy(nm) || pt))
      return err("need_target", `'${op}' needs element_id/query/auto_id or x,y`, {
        fix: "pass an id from desktop_observe, or explicit x,y",
        nextAction: "desktop_observe()",
      });
    r = await agentReq(
      cible,
      "/element",
      avecPoint(
        { action: op, auto_id: aid, name: nm, control_type: ct, text, button, clicks: intPy(ou(clicks, 1)) },
        pt,
      ),
    );
  } else return err("bad_op", `unknown op '${op}'`, { valid_choices: OPS_VALIDES });

  if (veritePy(getPy(r, "error"))) {
    if (SEMANTIC_OPS.has(op) && !veritePy(getPy(r, "fix"))) {
      r = copieDict(r);
      poserCle(
        r,
        "fix",
        "ce contrôle n'expose peut-être pas ce pattern — réessaie " +
          'en clic simple op="click" sur son element_id, ou ' +
          "desktop_observe puis cible par auto_id",
      );
      poserCle(r, "next_action", "desktop_observe()");
    }
    return r;
  }
  invalidateA11yMemo(cible.name);
  const resultat: Dict = { op, target: cible.name };
  if (point) resultat["point"] = [point[0], point[1]];
  if (!estNone(getPy(r, "cursor"))) resultat["mouse"] = r["cursor"];
  if (!estNone(texteCopie)) resultat["text"] = texteCopie;
  if (veritePy(getPy(r, "method"))) {
    resultat["method"] = r["method"];
    if (
      r["method"] === "coords" &&
      (SEMANTIC_OPS.has(op) || (semanticClick && (op === "click" || op === "left_click")))
    )
      resultat["note"] =
        "actionné en clic-coordonnées (pas de control pattern " +
        "a11y sur cette cible — p.ex. Linux/AT-SPI ou élément vision)";
  }
  if (resoluPar) resultat["resolved_by"] = resoluPar;
  if (veritePy(settleMs) && floatPy(settleMs) > 0 && op !== "copy") {
    const attendu = await (async () =>
      waitStable(username, cible.name, {
        timeoutMs: intPy(settleMs),
        quietMs: intPy(config.DESKTOP_ACT_SETTLE_QUIET_MS),
        pollMs: intPy(config.DESKTOP_ACT_SETTLE_POLL_MS),
      }))().catch(() => null);
    if (attendu !== null) resultat["settle_ms"] = attendu;
  }
  if (veritePy(a("return_elements")) && op !== "copy") {
    const obs = await observeCore(username, cible.name, {
      use_vision: false,
      use_tree: true,
      max_elements: chatElementCap(),
    });
    if (!veritePy(getPy(obs, "error")))
      for (const k of ["elements", "count", "total", "truncated", "frame_token", "img_w", "img_h", "sig"])
        if (Object.hasOwn(obs, k)) resultat[k] = obs[k];
  } else if (veritePy(a("observe_after"))) {
    const g = await grab(cible);
    if (Array.isArray(g)) {
      const [png, w, h] = g;
      resultat["frame_token"] = await saveFrame(png, username);
      [resultat["img_w"], resultat["img_h"]] = [w, h];
      resultat["sig"] = await frameSig(png);
    }
  }
  if (sigAvant && veritePy(resultat["sig"]) && hamHex(sigAvant, resultat["sig"]) === 0)
    return err(
      "type_no_effect",
      "le texte a été émis mais l'écran n'a pas changé — la frappe n'a " +
        "probablement pas atterri (zone de saisie non focalisée ou fenêtre " +
        "en arrière-plan)",
      {
        fix:
          'clique d\'abord dans la zone de saisie (desktop_act op="click" ' +
          'sur son element_id), ou cible le champ par op="set_value", ' +
          "puis réessaie",
        nextAction: "desktop_observe()",
        target: cible.name,
        frame_token: resultat["frame_token"] ?? null,
        sig: resultat["sig"] ?? null,
        img_w: resultat["img_w"] ?? null,
        img_h: resultat["img_h"] ?? null,
      },
    );
  return ok(resultat);
}

/** Noms d'applications courants (FR + EN, accents pliés) → exécutable ou URI canonique sous Windows. */
const ALIAS_WIN: Readonly<Record<string, string>> = {
  calc: "calc.exe",
  calculator: "calc.exe",
  calculatrice: "calc.exe",
  notepad: "notepad.exe",
  "bloc-notes": "notepad.exe",
  "bloc notes": "notepad.exe",
  blocnotes: "notepad.exe",
  paint: "mspaint.exe",
  dessin: "mspaint.exe",
  wordpad: "write.exe",
  write: "write.exe",
  explorer: "explorer.exe",
  explorateur: "explorer.exe",
  "explorateur de fichiers": "explorer.exe",
  files: "explorer.exe",
  cmd: "cmd.exe",
  "invite de commandes": "cmd.exe",
  "command prompt": "cmd.exe",
  powershell: "powershell.exe",
  terminal: "wt.exe",
  settings: "ms-settings:",
  parametres: "ms-settings:",
  reglages: "ms-settings:",
  "control panel": "control.exe",
  "panneau de configuration": "control.exe",
  "task manager": "taskmgr.exe",
  "gestionnaire des taches": "taskmgr.exe",
  regedit: "regedit.exe",
  "registry editor": "regedit.exe",
  "editeur du registre": "regedit.exe",
  "character map": "charmap.exe",
  "table des caracteres": "charmap.exe",
  "snipping tool": "snippingtool.exe",
  "outil capture": "snippingtool.exe",
  store: "ms-windows-store:",
  "microsoft store": "ms-windows-store:",
  edge: "msedge.exe",
  navigateur: "msedge.exe",
  "device manager": "devmgmt.msc",
  "gestionnaire de peripheriques": "devmgmt.msc",
  services: "services.msc",
  "disk management": "diskmgmt.msc",
  "gestion des disques": "diskmgmt.msc",
  photos: "ms-photos:",
};
const EXT_LANCABLES = [".exe", ".lnk", ".bat", ".cmd", ".msc", ".cpl", ".com"];

/** `_norm_app_name` : casefold, NFKD sans marques combinantes, blancs compactés. */
export function normAppName(app: unknown): string {
  return splitPy(sansAccentsPy(casefoldPy(stripPy(texteOuVide(app))))).join(" ");
}

/** `_resolve_app_target` : nom amical → cible lançable sous Windows (`[cible, note]`), inchangé ailleurs. */
export function resolveAppTarget(app: unknown, osName: string): [string, string] {
  const brut = stripPy(texteOuVide(app));
  if (lowerPy(stripPy(osName || "")) !== "windows") return [brut, ""];
  const cle = normAppName(brut);
  if (Object.hasOwn(ALIAS_WIN, cle)) {
    const canon = ALIAS_WIN[cle] ?? "";
    return [canon, canon === brut ? "" : `« ${brut} » → ${canon}`];
  }
  const bas = lowerPy(brut);
  const resolvable =
    brut.includes("\\") ||
    brut.includes("/") ||
    brut.includes(":") ||
    EXT_LANCABLES.some((x) => bas.endsWith(x));
  if (resolvable || !brut) return [brut, ""];
  return [`${brut}.exe`, `« ${brut} » → ${brut}.exe`];
}

/** `launch_core` : lance un programme sur la cible et attend son initialisation (côté agent) ; fenêtre apparue + trame fraîche. */
export async function launchCore(
  username: string,
  target = "",
  o: { app?: string; args?: string; timeout_ms?: unknown } = {},
): Promise<Dict> {
  const app = o.app ?? "";
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  if (!app) return err("need_app", "launch needs `app` (chemin/raccourci/uri)");
  let resolue: string;
  try {
    [resolue] = resolveAppTarget(app, strPy(cible.os ?? ""));
  } catch {
    resolue = app;
  }
  const to = Math.max(1000, intPy(ou(o.timeout_ms, 15000)));
  const r = await agentReq(
    cible,
    "/launch",
    { target: resolue, args: o.args ?? "", timeout_ms: to },
    "POST",
    Math.max(20, Math.floor((2 * to) / 1000) + 15),
  );
  if (veritePy(getPy(r, "error"))) return r;
  const sortie: Dict = { target: cible.name, requested_app: app };
  if (resolue !== app) sortie["resolved"] = resolue;
  for (const k of ["launched", "found", "title", "class_name", "auto_id", "interaction_state"])
    if (Object.hasOwn(r, k)) sortie[k] = r[k];
  if (veritePy(getPy(r, "error_detail"))) sortie["error_detail"] = r["error_detail"];
  if (sortie["found"] === false)
    sortie["hint"] =
      `lancé mais aucune nouvelle fenêtre détectée dans ${to} ms — ` +
      "l'appli est peut-être déjà ouverte ou son activation est " +
      'lente ; confirme avec desktop_wait(kind="window_ready", ' +
      "title_re=…) ou desktop_observe.";
  const g = await grab(cible);
  if (Array.isArray(g)) {
    const [png, w, h] = g;
    sortie["frame_token"] = await saveFrame(png, username);
    [sortie["img_w"], sortie["img_h"]] = [w, h];
    sortie["sig"] = await frameSig(png);
  }
  return ok(sortie);
}

/** `wait_window_core` : attend (côté agent) qu'une fenêtre corresponde et soit prête à l'interaction. */
export async function waitWindowCore(
  username: string,
  target = "",
  o: {
    title_re?: unknown;
    auto_id?: unknown;
    class_name?: unknown;
    ready?: unknown;
    timeout_ms?: unknown;
  } = {},
): Promise<Dict> {
  const [titre, aid, classe] = [o.title_re ?? "", o.auto_id ?? "", o.class_name ?? ""];
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  if (!(veritePy(titre) || veritePy(aid) || veritePy(classe)))
    return err("need_matcher", "wait_window needs title_re/auto_id/class_name");
  const to = Math.max(1000, intPy(ou(o.timeout_ms, 15000)));
  const r = await agentReq(
    cible,
    "/wait_window",
    { title_re: titre, auto_id: aid, class_name: classe, ready: veritePy(o.ready ?? true), timeout_ms: to },
    "POST",
    Math.max(20, Math.floor(to / 1000) + 5),
  );
  if (veritePy(getPy(r, "error"))) return r;
  return ok({
    target: cible.name,
    found: veritePy(getPy(r, "found")),
    interaction_state: ou(getPy(r, "interaction_state"), ""),
    title: ou(getPy(r, "title"), ""),
    auto_id: ou(getPy(r, "auto_id"), ""),
  });
}

/** `list_monitors_core` : écrans de la cible et écran capturé courant. */
export async function listMonitorsCore(username: string, target = ""): Promise<Dict> {
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  const r = await agentReq(cible, "/monitors", null, "GET", 8);
  if (veritePy(getPy(r, "error"))) return r;
  return ok({
    target: cible.name,
    monitors: ou(getPy(r, "monitors"), []),
    selected: getPy(r, "selected", 1),
  });
}

/** `select_monitor_core` : écran capturé et piloté sur la cible (persistant côté agent). */
export async function selectMonitorCore(username: string, target = "", monitor: unknown = 1): Promise<Dict> {
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  let idx: number;
  try {
    idx = intPy(monitor);
  } catch (e) {
    if (!(e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))) throw e;
    idx = 1;
  }
  const r = await agentReq(cible, "/select_monitor", { monitor: idx });
  if (veritePy(getPy(r, "error"))) return r;
  return ok({ target: cible.name, selected: getPy(r, "selected", idx) });
}

/** Défaut d'un argument nommé de Python : seul l'argument omis le prend (un `None` explicite reste `None`). */
const omis = (v: unknown, defaut: unknown): unknown => (v === undefined ? defaut : v);

/** `run_command_core` : commande sur la cible par l'agent, au contrat d'execute_shell (`ok` = code de retour nul, sorties en dernier). */
export async function runCommandCore(
  username: string,
  target = "",
  o: { command?: unknown; shell?: unknown; cwd?: unknown; timeout_sec?: unknown; max_output?: unknown } = {},
): Promise<Dict> {
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  const cmd = strPy(ou(o.command, ""));
  if (!stripPy(cmd)) return err("need_command", "run_command needs a non-empty `command`");
  const [shell, cwd] = [omis(o.shell, "powershell"), omis(o.cwd, "")];
  const to = Math.max(1, Math.min(600, intPy(ou(o.timeout_sec, 120))));
  const mx = Math.max(0, intPy(ou(omis(o.max_output, 20000), 0)));
  const r = await agentReq(
    cible,
    "/run_command",
    { command: cmd, shell, cwd, timeout_ms: to * 1000, max_output: mx },
    "POST",
    to + 30,
  );
  if (veritePy(getPy(r, "error"))) return r;
  const rc = intPy(getPy(r, "returncode", -1));
  const sortie: Dict = {
    ok: rc === 0,
    cmd,
    cwd,
    returncode: rc,
    truncated: veritePy(getPy(r, "truncated")),
    duration_ms: intPy(getPy(r, "duration_ms", 0)),
    executor: `desktop.${cible.name}.${strPy(ou(getPy(r, "shell"), shell))}`,
  };
  if (veritePy(getPy(r, "timed_out"))) {
    sortie["ok"] = false;
    sortie["error"] = "timeout";
    sortie["hint"] = `exceeded timeout_sec=${to}s on ${cible.name}; narrow the command or raise timeout_sec`;
  }
  sortie["stdout"] = strPy(getPy(r, "stdout", ""));
  sortie["stderr"] = strPy(getPy(r, "stderr", ""));
  return sortie;
}

export type OptionsAttente = {
  kind?: string;
  query?: string;
  text?: string;
  value?: string;
  state?: string;
  role?: string;
  auto_id?: string;
  title_re?: string;
  op?: string;
  count?: number;
  match?: boolean;
  timeout_ms?: number;
};

/** `wait_core` : attend une condition d'UI (attentes étagées du rejeu : dHash, a11y, OCR, UIA), puis trame fraîche. */
export async function waitCore(username: string, target = "", o: OptionsAttente = {}): Promise<Dict> {
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  const kind = lowerPy(stripPy(o.kind || "stable"));
  const [query, text, value, state] = [o.query ?? "", o.text ?? "", o.value ?? "", o.state ?? ""];
  const attente: Dict = { kind, match: veritePy(o.match ?? false) };
  if (kind === "element" || kind === "element_gone") attente["query"] = query;
  else if (kind === "text" || kind === "text_gone") attente["query"] = text || query;
  else if (kind === "value" || kind === "value_gone") Object.assign(attente, { query, expected: value });
  else if (kind === "state") Object.assign(attente, { query, state });
  else if (kind === "count")
    Object.assign(attente, { query, role: o.role ?? "", op: o.op ?? "==", count: o.count ?? 0 });
  else if (kind === "window_ready")
    Object.assign(attente, { query: o.title_re || query, anchor: { auto_id: o.auto_id ?? "" } });
  let verdict: [boolean, number, string];
  try {
    verdict = await checkExpect(username, cible.name, attente, intPy(o.timeout_ms || 8000));
  } catch (e) {
    if (e instanceof ReplayAborted) throw e;
    return err("wait_failed", `wait '${kind}' failed: ${e instanceof Error ? e.message : strPy(e)}`);
  }
  const sortie: Dict = {
    target: cible.name,
    kind,
    satisfied: verdict[0],
    waited_ms: intPy(verdict[1]),
    detail: verdict[2],
  };
  const g = await grab(cible);
  if (Array.isArray(g)) {
    const [png, w, h] = g;
    sortie["frame_token"] = await saveFrame(png, username);
    [sortie["img_w"], sortie["img_h"]] = [w, h];
    sortie["sig"] = await frameSig(png);
  }
  return ok(sortie);
}

/** `list_windows_core` : fenêtres de premier niveau de la cible (titre, état, premier plan), sans sous-arbre. */
export async function listWindowsCore(username: string, target = ""): Promise<Dict> {
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  const r = await agentReq(cible, "/windows", null, "GET");
  if (veritePy(getPy(r, "error"))) return r;
  const fenetres: Dict[] = [];
  for (const w of iterExige(ou(getPy(r, "windows"), []))) {
    if (!estDict(w)) continue;
    fenetres.push({
      id: strPy(getPy(w, "hwnd")),
      title: ou(getPy(w, "title"), ""),
      state: ou(getPy(w, "state"), "normal"),
      is_foreground: veritePy(getPy(w, "is_foreground")),
    });
  }
  return ok({ target: cible.name, windows: fenetres, count: fenetres.length });
}

/** `window_action_core` : agit sur une fenêtre par son hwnd (activate, focus, minimize, maximize, restore, close) ; mémo a11y invalidé. */
export async function windowActionCore(
  username: string,
  target = "",
  action: unknown = "activate",
  windowId: unknown = "",
): Promise<Dict> {
  const cible = await resolveTarget(target, username);
  if (!cible) return noTargetErr();
  let hwnd: number;
  try {
    hwnd = intPy(ou(stripPy(strPy(windowId)), 0));
  } catch (e) {
    if (!(e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))) throw e;
    hwnd = 0;
  }
  if (!hwnd) return err("bad_window", "window_id (hwnd) requis — lister via desktop_windows");
  const geste = strPy(ou(action, "activate"));
  const r = await agentReq(cible, "/window_action", { action: geste, hwnd });
  if (veritePy(getPy(r, "error"))) return r;
  invalidateA11yMemo(cible.name);
  const extra: Dict = {};
  for (const k of ["method", "foregrounded", "note"]) {
    const v = getPy(r, k);
    if (v !== null && v !== undefined) extra[k] = v;
  }
  return ok({ target: cible.name, action: geste, window_id: strPy(hwnd), ...extra });
}

/** Primitives branchées sur l'agent (port de B1-19c, installé par `composer`). */
export const PRIMITIVES_AGENT: PrimitivesBureau = {
  grab: (username, target) => grabCore(username, target),
  probeTree: (username, target) => probeTreeCore(username, target),
  observe: (username, target, o) => observeCore(username, target, o),
  act: (username, target, kw) => actCore(username, target, kw),
  readText: (username, target, o) => readTextCore(username, target, "", o.element_id ?? ""),
  launch: (username, target, o) => launchCore(username, target, o),
  waitWindow: (username, target, o) => waitWindowCore(username, target, o),
};
