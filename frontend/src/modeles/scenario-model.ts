// SPDX-License-Identifier: MIT
/** frontend/src/modeles/scenario-model.ts — modèle pur d'un scénario de test desktop : pas reproductible, ancres, attentes, arbre d'éléments. */

export interface ElementUi {
  id?: string | number | null;
  label?: string;
  role?: string;
  name?: string | null;
  unnamed?: boolean;
  auto_id?: string;
  source?: string;
  depth?: number;
  box?: number[];
  center?: number[];
  patterns?: string[];
  states?: string[];
  query?: string;
  [cle: string]: unknown;
}

export interface Ancre {
  id?: string | number | null;
  label?: string;
  role?: string;
  query?: string;
  path?: string;
  auto_id?: string;
  source?: string;
  ambiguous?: boolean;
  near?: string;
  side?: string;
  image?: string;
  window?: string;
  rel?: number[];
  center?: number[];
  x?: number;
  y?: number;
  [cle: string]: unknown;
}

export interface ArgsAction {
  text?: string;
  keys?: string;
  modifiers?: unknown;
  app?: string;
  target?: string;
  button?: string;
  clicks?: number | string;
  dy?: number | string;
  x?: number | string | null;
  y?: number | string | null;
  x2?: number | string | null;
  y2?: number | string | null;
  op?: string;
  element_id?: string | number | null;
  query?: string;
  [cle: string]: unknown;
}

export interface Attente {
  kind?: string;
  query?: string;
  anchor?: Ancre;
  cmp?: string;
  match?: unknown;
  expected?: string;
  state?: string;
  role?: string;
  op?: string;
  count?: number;
  [cle: string]: unknown;
}

export interface PasScenario {
  op: string;
  anchor: Ancre;
  args: ArgsAction;
  assert?: { type: string };
  expect?: Attente;
  sigBefore?: string;
  sigAfter?: string;
  [cle: string]: unknown;
}

export interface LigneArbre {
  el: ElementUi;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

export interface Couche {
  index: number;
  id: string | number | null | undefined;
  label: string;
  role: string;
  box: number[] | null | undefined;
  count: number;
}

export interface AuditLigne {
  id: ElementUi["id"];
  role: string;
  missing: string;
  volatile: boolean;
  path: string;
  near: string;
  box: number[] | undefined;
}

export interface Audit {
  interactive: number;
  rows: AuditLigne[];
  unnamed: number;
}

type Elements = readonly (ElementUi | null | undefined)[] | null | undefined;

export const ANCHOR_FIELDS = ["id", "label", "role", "source", "box", "center", "auto_id"];
export const INTERACTIVE_ROLES = [
  "button",
  "checkbox",
  "radiobutton",
  "edit",
  "combobox",
  "listitem",
  "tab",
  "tabitem",
  "menuitem",
  "slider",
  "hyperlink",
  "spinner",
  "treeitem",
  "splitbutton",
];
export const EXPECT_KINDS = [
  "element",
  "element_gone",
  "text",
  "text_gone",
  "appear",
  "window_ready",
  "value",
  "value_gone",
  "state",
  "count",
  "stable",
  "none",
];
const WINDOW_ROLES = ["window", "dialog", "frame", "document", "pane", "panel"];
const MIN_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 300000;
const DEFAULT_TIMEOUT_MS = 30000;

const liste = (elements: Elements): ElementUi[] => (elements ?? []).filter((e): e is ElementUi => !!e);

/** Nom réel d'un élément : un libellé fabriqué depuis le rôle n'identifie rien. */
export function realName(el: ElementUi | null | undefined): string {
  if (!el) return "";
  if (el.unnamed) return "";
  if (el.name !== undefined && el.name !== null) return String(el.name);
  const label = String(el.label || "");
  if (label && el.role && label === String(el.role)) return "";
  if (label === "element") return "";
  return label;
}

/** auto_id volatil « view_N » d'un moteur Chromium/WebView2 : jamais une identité fiable. */
export function volatileId(id: unknown): boolean {
  return !!id && /^view_\d+$/i.test(String(id));
}

const inTree = (el: ElementUi | null | undefined): el is ElementUi => !!el && el.source !== "vision";
const depthOf = (el: ElementUi | null | undefined): number => Number((el && el.depth) || 0);

function idx(elements: readonly (ElementUi | null | undefined)[], el: ElementUi | null | undefined): number {
  if (!el) return -1;
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (e === el || (e && el.id !== undefined && e.id === el.id)) return i;
  }
  return -1;
}

function inBox(box: unknown, pt: readonly number[] | null | undefined): boolean {
  return (
    Array.isArray(box) &&
    box.length === 4 &&
    !!pt &&
    pt.length >= 2 &&
    (pt[0] as number) >= box[0] &&
    (pt[0] as number) <= box[2] &&
    (pt[1] as number) >= box[1] &&
    (pt[1] as number) <= box[3]
  );
}

function centerOf(el: ElementUi | null | undefined): number[] | null {
  if (el && Array.isArray(el.center) && el.center.length >= 2) return el.center;
  const b = el && el.box;
  return Array.isArray(b) && b.length === 4
    ? [((b[0] ?? 0) + (b[2] ?? 0)) / 2, ((b[1] ?? 0) + (b[3] ?? 0)) / 2]
    : null;
}

export function elementParent(elements: Elements, el: ElementUi | null | undefined): ElementUi | null {
  const els = elements ?? [];
  const i = idx(els, el);
  if (i < 0 || !inTree(el)) return null;
  const d = depthOf(el);
  for (let j = i - 1; j >= 0; j--) {
    const e = els[j];
    if (!inTree(e)) continue;
    if (depthOf(e) < d) return e;
  }
  return null;
}

/** Ancêtres, racine en premier (sans l'élément lui-même). */
export function elementAncestors(elements: Elements, el: ElementUi | null | undefined): ElementUi[] {
  const out: ElementUi[] = [];
  let p = elementParent(elements, el);
  let guard = 0;
  while (p && guard++ < 64) {
    out.unshift(p);
    p = elementParent(elements, p);
  }
  return out;
}

export function elementChildren(elements: Elements, el: ElementUi | null | undefined): ElementUi[] {
  const els = elements ?? [];
  const i = idx(els, el);
  if (i < 0 || !inTree(el)) return [];
  const d = depthOf(el);
  const out: ElementUi[] = [];
  let runMin = Infinity;
  for (let j = i + 1; j < els.length; j++) {
    const e = els[j];
    if (!inTree(e)) continue;
    const dj = depthOf(e);
    if (dj <= d) break;
    if (dj <= runMin) out.push(e);
    if (dj < runMin) runMin = dj;
  }
  return out;
}

export function elementRoots(elements: Elements): ElementUi[] {
  const els = elements ?? [];
  const out: ElementUi[] = [];
  for (const e of els) if (inTree(e) && elementParent(els, e) === null) out.push(e);
  return out;
}

export function elementDescendants(elements: Elements, el: ElementUi | null | undefined): ElementUi[] {
  const els = elements ?? [];
  const i = idx(els, el);
  const out: ElementUi[] = [];
  if (i < 0 || !inTree(el)) return out;
  const d = depthOf(el);
  for (let j = i + 1; j < els.length; j++) {
    const e = els[j];
    if (!inTree(e)) continue;
    if (depthOf(e) <= d) break;
    out.push(e);
  }
  return out;
}

const norm = (s: unknown): string =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Un nom (+ rôle) porté par plusieurs éléments du frame : le chemin tranche. */
export function isAmbiguous(elements: Elements, el: ElementUi | null | undefined): boolean {
  const nm = norm(realName(el));
  const role = norm(el && el.role);
  if (!nm) return false;
  let n = 0;
  for (const e of elements ?? []) if (norm(realName(e)) === nm && norm(e && e.role) === role) n++;
  return n > 1;
}

function uniqueAid(elements: Elements, el: ElementUi | null | undefined): boolean {
  if (!el || !el.auto_id || volatileId(el.auto_id) || String(el.auto_id).indexOf("/") >= 0) return false;
  let n = 0;
  for (const e of elements ?? []) if (e && e.auto_id === el.auto_id && ++n > 1) return false;
  return true;
}

function anchorSeg(el: ElementUi, elements: Elements): string {
  if (uniqueAid(elements, el)) return "#" + el.auto_id;
  return (el.role ? String(el.role) + ":" : "") + realName(el);
}

function anchorable(elements: Elements, el: ElementUi | null | undefined): boolean {
  if (!el) return false;
  const nm = realName(el);
  return !!(uniqueAid(elements, el) || (nm && nm.indexOf("/") < 0 && !isAmbiguous(elements, el)));
}

function seg(el: ElementUi, siblings: readonly ElementUi[]): string {
  const role = String(el.role || "") || "element";
  let n = 0;
  let k = 0;
  for (const s of siblings) {
    if (String((s && s.role) || "") === String(el.role || "")) {
      n++;
      if (s === el || s.id === el.id) k = n;
    }
  }
  return role + "[" + (k || 1) + "]";
}

/** Chemin structurel « <ancre>/role[n]/… » d'un élément ; vide hors arbre. */
export function elementPath(elements: Elements, el: ElementUi | null | undefined): string {
  const els = elements ?? [];
  if (!inTree(el) || idx(els, el) < 0) return "";
  if (anchorable(els, el)) return anchorSeg(el, els);
  const chain = elementAncestors(els, el).concat([el]);
  let start = -1;
  for (let i = chain.length - 2; i >= 0; i--) {
    if (anchorable(els, chain[i])) {
      start = i;
      break;
    }
  }
  const segs: string[] = [];
  if (start >= 0) segs.push(anchorSeg(chain[start] as ElementUi, els));
  else {
    segs.push(seg(chain[0] as ElementUi, elementRoots(els)));
    start = 0;
  }
  for (let j = start + 1; j < chain.length; j++) {
    segs.push(seg(chain[j] as ElementUi, elementChildren(els, chain[j - 1] as ElementUi)));
  }
  return segs.join("/");
}

export interface SegmentChemin {
  auto_id?: string;
  role?: string;
  name?: string;
  n?: number;
}

/** Un pas de chemin vers {auto_id} | {role, name} | {name} | {role, n}. */
export function parsePathSeg(brut: unknown): SegmentChemin | null {
  const s = String(brut || "").trim();
  if (!s) return null;
  if (s.charAt(0) === "#") return { auto_id: s.slice(1) };
  const m = /^([a-z_]+)\[(\d+)\]$/i.exec(s);
  if (m) return { role: (m[1] ?? "").toLowerCase(), n: parseInt(m[2] ?? "", 10) || 1 };
  const c = s.indexOf(":");
  if (c > 0 && /^[a-z_]+$/i.test(s.slice(0, c)))
    return { role: s.slice(0, c).toLowerCase(), name: s.slice(c + 1) };
  return { name: s };
}

function matchSeg(
  el: ElementUi | null | undefined,
  p: SegmentChemin | null,
  siblings: readonly ElementUi[],
): boolean {
  if (!el || !p) return false;
  if (p.auto_id !== undefined) return String(el.auto_id || "") === p.auto_id;
  if (p.name !== undefined) {
    if (p.role && norm(el.role) !== p.role) return false;
    return norm(realName(el)) === norm(p.name);
  }
  if (norm(el.role) !== p.role) return false;
  let k = 0;
  for (const s of siblings) {
    if (norm(s.role) === p.role) {
      k++;
      if (s === el) return k === p.n;
    }
  }
  return false;
}

/** Résout un chemin dans la liste (strict, ou relâché : ancre puis N-ième descendant de ce rôle). */
export function resolvePath(elements: Elements, path: unknown, relaxed: boolean = true): ElementUi | null {
  const els = elements ?? [];
  const segs = String(path || "")
    .split("/")
    .map(parsePathSeg)
    .filter((s): s is SegmentChemin => !!s);
  const first = segs[0];
  if (!first) return null;
  const pool =
    first.n !== undefined && first.auto_id === undefined && first.name === undefined
      ? elementRoots(els)
      : liste(els).filter(inTree);
  let anchor: ElementUi | null = null;
  for (const p of pool) {
    if (matchSeg(p, first, pool)) {
      anchor = p;
      break;
    }
  }
  if (!anchor && relaxed && first.auto_id) {
    const tail = first.auto_id.split(".").pop() ?? "";
    for (const p of pool) {
      const aid = String(p.auto_id || "");
      if (aid === tail || aid.slice(-(tail.length + 1)) === "." + tail) {
        anchor = p;
        break;
      }
    }
  }
  let cur: ElementUi | null = anchor;
  for (let s = 1; cur && s < segs.length; s++) {
    const kids = elementChildren(els, cur);
    let next: ElementUi | null = null;
    for (const k of kids) {
      if (matchSeg(k, segs[s] ?? null, kids)) {
        next = k;
        break;
      }
    }
    cur = next;
  }
  if (cur || !relaxed || !anchor || segs.length < 2) return cur || null;
  const last = segs[segs.length - 1] as SegmentChemin;
  const sub = elementDescendants(els, anchor);
  if (last.n !== undefined) {
    const same = sub.filter((e) => norm(e.role) === last.role);
    return last.n > 0 && last.n <= same.length ? (same[last.n - 1] ?? null) : null;
  }
  for (const e of sub) if (matchSeg(e, last, sub)) return e;
  return null;
}

/** Libellé nommé le plus proche (même parent d'abord, puis géométrie) et son côté. */
export function nearestLabel(
  elements: Elements,
  el: ElementUi | null | undefined,
): { label: string; side: string } | null {
  const c = centerOf(el);
  if (!c) return null;
  const parent = elementParent(elements, el);
  const pools: ElementUi[][] = [];
  if (parent) pools.push(elementChildren(elements, parent));
  pools.push(liste(elements).filter(inTree));
  for (const pool of pools) {
    let best: { label: string; dx: number; dy: number } | null = null;
    let bestD = Infinity;
    for (const e of pool) {
      if (e === el || !inTree(e)) continue;
      const nm = realName(e);
      if (!nm || nm.length > 60) continue;
      const ec = centerOf(e);
      if (!ec) continue;
      const dx = (c[0] ?? 0) - (ec[0] ?? 0);
      const dy = (c[1] ?? 0) - (ec[1] ?? 0);
      const d = Math.sqrt(dx * dx + dy * dy) + Math.abs(dy);
      if (d < bestD) {
        bestD = d;
        best = { label: nm, dx, dy };
      }
    }
    if (best && bestD < 600) {
      const side =
        Math.abs(best.dx) >= Math.abs(best.dy)
          ? best.dx > 0
            ? "right"
            : "left"
          : best.dy > 0
            ? "below"
            : "above";
      return { label: best.label, side };
    }
  }
  return null;
}

/** Fenêtre (racine) de l'élément et position relative de son centre dans son rectangle. */
export function windowAnchor(
  elements: Elements,
  el: ElementUi | null | undefined,
): { window: string; rel: [number, number] } | null {
  const anc = elementAncestors(elements, el);
  const root = anc.length ? (anc[0] as ElementUi) : null;
  if (!root || !Array.isArray(root.box) || root.box.length !== 4) return null;
  const c = centerOf(el);
  if (!c) return null;
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = root.box;
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return null;
  const ident = root.auto_id ? "#" + root.auto_id : realName(root);
  if (!ident) return null;
  return {
    window: ident,
    rel: [
      Math.round((((c[0] ?? 0) - x1) / w) * 1000) / 1000,
      Math.round((((c[1] ?? 0) - y1) / h) * 1000) / 1000,
    ],
  };
}

function buildAnchor(el: ElementUi, elements: Elements): Ancre {
  const a: Ancre = {};
  for (const k of ANCHOR_FIELDS) {
    if (k === "label") continue;
    const v = el[k];
    if (v !== undefined && v !== null && v !== "") a[k] = v;
  }
  const nm = realName(el);
  if (nm) a.label = nm;
  if (elements && elements.length) {
    const p = elementPath(elements, el);
    if (p) a.path = p;
    if (nm && isAmbiguous(elements, el)) a["ambiguous"] = true;
    if (!nm && !el.auto_id) {
      const nb = nearestLabel(elements, el);
      if (nb) {
        a["near"] = nb.label;
        a["side"] = nb.side;
      }
    }
    const w = windowAnchor(elements, el);
    if (w) {
      a["window"] = w.window;
      a["rel"] = w.rel;
    }
  }
  if (a["auto_id"] && volatileId(a["auto_id"])) {
    a["volatile_id"] = true;
    if (nm || a.path) delete a["auto_id"];
  }
  if (a["auto_id"] && elements && elements.length) {
    let same = 0;
    for (const e of elements) if (e && e.auto_id === a["auto_id"]) same++;
    if (same > 1) {
      a["shared_id"] = true;
      if (nm || a.path) delete a["auto_id"];
    }
  }
  return a;
}

export function anchorFromElement(el: ElementUi | null | undefined, elements?: Elements): Ancre {
  return buildAnchor(el || {}, elements);
}

/** Audit d'accessibilité : contrôles interactifs sans nom ni auto_id stable. */
export function a11yAudit(elements?: Elements): Audit {
  const els = elements ?? [];
  const rows: AuditLigne[] = [];
  let interactive = 0;
  for (const e of els) {
    if (!inTree(e)) continue;
    const role = String(e.role || "").toLowerCase();
    if (INTERACTIVE_ROLES.indexOf(role) < 0) continue;
    interactive++;
    const nm = realName(e);
    const stableAid = !!(e.auto_id && !volatileId(e.auto_id));
    if (nm && stableAid) continue;
    const nb = nearestLabel(els, e);
    rows.push({
      id: e.id,
      role,
      missing: !nm && !stableAid ? "nom et auto_id" : !nm ? "nom" : "auto_id",
      volatile: !!(e.auto_id && volatileId(e.auto_id)),
      path: elementPath(els, e),
      near: nb ? nb.label : "",
      box: e.box,
    });
  }
  return { interactive, rows, unnamed: rows.filter((r) => r.missing !== "auto_id").length };
}

export function a11yAuditCsv(audit?: Audit | null): string {
  const out = ["rôle;manque;chemin;voisin;x1;y1;x2;y2"];
  for (const r of (audit && audit.rows) || []) {
    const b: readonly (number | string)[] = r.box || ["", "", "", ""];
    out.push(
      [r.role, r.missing, r.path, r.near, b[0], b[1], b[2], b[3]]
        .map((v) => String(v == null ? "" : v).replace(/;/g, ","))
        .join(";"),
    );
  }
  return out.join("\n");
}

/** Arguments d'action conservés (les défauts sont omis pour un pas propre). */
export function pickActionArgs(entree?: ArgsAction | null): ArgsAction {
  const args = entree || {};
  const out: ArgsAction = {};
  for (const k of ["text", "keys", "modifiers", "app"]) {
    if (args[k]) out[k] = args[k];
  }
  if (args.button && args.button !== "left") out.button = args.button;
  if (args.clicks && Number(args.clicks) > 1) out.clicks = Number(args.clicks);
  if (typeof args.dy === "number" && args.dy !== 0) out.dy = args.dy;
  else if (args.dy && Number(args.dy) !== 0) out.dy = Number(args.dy);
  if (args.x2 !== undefined && args.x2 !== null && args.y2 !== undefined && args.y2 !== null) {
    out.x2 = Number(args.x2);
    out.y2 = Number(args.y2);
  }
  return out;
}

/** Attente inférée de l'opération (launch : fenêtre prête), sinon null (stable implicite). */
export function inferDefaultExpect(op: string): Attente | null {
  if (op === "launch") return { kind: "window_ready", query: "" };
  return null;
}

export interface EntreeAct {
  [cle: string]: unknown;
  args?: ArgsAction | null;
  elements?: Elements;
  op?: string;
}

export function scenarioStepFromAct(entree?: EntreeAct | null): PasScenario {
  const input = entree || {};
  const args = input.args || {};
  const elements = input.elements || [];
  const op = args.op || input.op || "click";
  let anchor: Ancre | null = null;
  if (args.element_id) {
    for (const e of elements) {
      if (e && String(e.id) === String(args.element_id)) {
        anchor = buildAnchor(e, elements);
        break;
      }
    }
  }
  if (!anchor && args.query) anchor = { query: String(args.query) };
  if (!anchor && args.x !== undefined && args.x !== null && args.y !== undefined && args.y !== null) {
    anchor = { x: Number(args.x), y: Number(args.y) };
  }
  if (!anchor && args.element_id) anchor = { id: args.element_id, lost: true };
  if (!anchor) anchor = {};
  const step: PasScenario = { op, anchor, args: pickActionArgs(args), assert: { type: "action_ok" } };
  const ex = inferDefaultExpect(op);
  if (ex) step.expect = ex;
  return step;
}

/** Un clic sur une case devient check/uncheck selon l'état avant le clic (le script vise un état). */
function toggleOp(op: string, el: ElementUi | null | undefined): string {
  if (op !== "click" || !el) return op;
  const role = String(el.role || "").toLowerCase();
  const pats = Array.isArray(el.patterns) ? el.patterns : [];
  const itemRole =
    ["treeitem", "listitem", "dataitem", "menuitem", "tabitem", "radiobutton"].indexOf(role) >= 0;
  const toggle =
    role === "checkbox" || (pats.indexOf("toggle") >= 0 && pats.indexOf("selectionitem") < 0 && !itemRole);
  if (!toggle) return op;
  const states = (el.states || []).map((x) => String(x).toLowerCase());
  return states.indexOf("checked") >= 0 ? "uncheck" : "check";
}

export interface EntreeDirecte {
  [cle: string]: unknown;
  element?: ElementUi | null;
  op?: string;
  elements?: Elements;
  args?: ArgsAction | null;
}

export function scenarioStepFromDirect(entree?: EntreeDirecte | null): PasScenario {
  const input = entree || {};
  const el = input.element || {};
  const op = toggleOp(input.op || "click", el);
  const step: PasScenario = {
    op,
    anchor: buildAnchor(el, input.elements || []),
    args: pickActionArgs(input.args || {}),
    assert: { type: "action_ok" },
  };
  if (op === "double_click" || Number((input.args || {}).clicks) === 2) step.expect = { kind: "stable" };
  return step;
}

/** Le résultat d'un outil (chaîne JSON ou objet) est-il un succès ? */
export function resultOk(result: unknown): boolean {
  if (result == null) return false;
  let obj: unknown = result;
  if (typeof result === "string") {
    try {
      obj = JSON.parse(result);
    } catch {
      return !/"(ok)"\s*:\s*false|"error"/.test(result);
    }
  }
  if (obj && typeof obj === "object") {
    const o = obj as { ok?: unknown; error?: unknown };
    if (o.ok === false) return false;
    if (o.error) return false;
    return true;
  }
  return true;
}

export function summarizeStep(step?: Partial<PasScenario> | null): string {
  if (!step) return "";
  const op = step.op || "?";
  const a = step.anchor || {};
  const who =
    a.label ||
    a.query ||
    (a.id ? "#" + a.id : null) ||
    (a["x"] !== undefined ? "(" + String(a["x"]) + "," + String(a["y"]) + ")" : "");
  const args = step.args || {};
  if (op === "type" || op === "paste") return op + " « " + (args.text || "") + " »";
  if (op === "key") return "key " + (args.keys || "");
  if (op === "scroll") return "scroll " + (args.dy || 0);
  if (op === "drag") return "drag → (" + String(args.x2) + "," + String(args.y2) + ")";
  if (op === "launch") return "lancer " + (args.app || args.target || "");
  return op + (who ? " « " + who + " »" : "");
}

/** Distance de Hamming entre deux signatures hex ; 64 si on ne peut pas conclure. */
export function hamming(a?: string | null, b?: string | null): number {
  if (!a || !b || a.length !== b.length) return 64;
  let x: bigint;
  try {
    x = BigInt("0x" + a) ^ BigInt("0x" + b);
  } catch {
    return 64;
  }
  let c = 0;
  while (x > 0n) {
    c += Number(x & 1n);
    x >>= 1n;
  }
  return c;
}

/** L'action a-t-elle eu un effet visible ? 'changed' | 'none' | 'unknown'. */
export function frameEffect(
  before?: string | null,
  after?: string | null,
  threshold?: number | null,
): "changed" | "none" | "unknown" {
  const seuil = threshold == null ? 6 : threshold;
  if (!before || !after) return "unknown";
  return hamming(before, after) > seuil ? "changed" : "none";
}

/** Élague les allers-retours : un état déjà vu referme la boucle de pas qui l'a quitté. */
export function pruneCycles<T extends Partial<PasScenario>>(
  entree?: readonly T[] | null,
  threshold?: number | null,
): T[] {
  const seuil = threshold == null ? 6 : threshold;
  const steps = entree || [];
  if (!steps.length) return [];
  const kept: T[] = [];
  const states: string[] = [(steps[0] as T).sigBefore || ""];
  for (const step of steps) {
    const after = step.sigAfter || "";
    let backTo = -1;
    if (after) {
      for (let i = 0; i < states.length; i++) {
        if (states[i] && hamming(states[i], after) <= seuil) {
          backTo = i;
          break;
        }
      }
    }
    if (backTo >= 0) {
      kept.length = backTo;
      states.length = backTo + 1;
    } else {
      kept.push(step);
      states.push(after);
    }
  }
  return kept;
}

export function isWindowRole(role: unknown): boolean {
  return WINDOW_ROLES.indexOf(String(role || "").toLowerCase()) >= 0;
}

export function clampTimeout(ms: unknown): number {
  const v = Number(ms);
  if (!isFinite(v)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(v)));
}

function elKey(el: ElementUi): string {
  const label = ((el && el.label) || "").trim().toLowerCase();
  const role = ((el && el.role) || "").toLowerCase();
  return label ? label + "\u0001" + role : "#" + ((el && el.id) || "");
}

function area(el: ElementUi): number {
  const b = el && el.box;
  if (!b || b.length < 4) return 0;
  return Math.max(0, (b[2] ?? 0) - (b[0] ?? 0)) * Math.max(0, (b[3] ?? 0) - (b[1] ?? 0));
}

/** Éléments apparus (triés par surface décroissante) et disparus entre deux observations. */
export function diffElements(
  before?: readonly ElementUi[] | null,
  after?: readonly ElementUi[] | null,
): { added: ElementUi[]; removed: ElementUi[] } {
  const b = before || [];
  const a = after || [];
  const bk: Record<string, boolean> = {};
  const ak: Record<string, boolean> = {};
  for (const e of b) bk[elKey(e)] = true;
  for (const e of a) ak[elKey(e)] = true;
  const added = a.filter((e) => !bk[elKey(e)]);
  const removed = b.filter((e) => !ak[elKey(e)]);
  added.sort((x, y) => area(y) - area(x));
  return { added, removed };
}

export function defaultExpect(): Attente {
  return { kind: "stable" };
}

export function expectFromElement(entree: ElementUi | null | undefined, present?: boolean): Attente {
  const el = entree || {};
  return {
    kind: present === false ? "element_gone" : "element",
    query: el.label || el.query || "",
    anchor: { label: el.label, role: el.role, box: el.box, center: el.center, source: el.source },
  };
}

function fmtMs(ms: unknown): string {
  const s = Math.round(clampTimeout(ms) / 1000);
  return s >= 60 ? Math.round(s / 6) / 10 + " min" : s + " s";
}

function cmpLabel(expect: Attente | null | undefined): string {
  const c = (expect && expect.cmp) || (expect && expect.match ? "regex" : "partiel");
  return c === "exact" ? " (exact)" : c === "regex" ? " (regex)" : "";
}

/** Résumé lisible de l'attente (badge UI, journal de rejeu). */
export function summarizeExpect(entree?: Attente | null, timeoutMs?: unknown): string {
  const expect = entree || {};
  const t = fmtMs(timeoutMs);
  const q = expect.query || (expect.anchor && (expect.anchor.label || expect.anchor.query)) || "";
  switch (expect.kind) {
    case "element":
      return "attend « " + q + " » · " + t;
    case "element_gone":
      return "« " + q + " » disparaît · " + t;
    case "text":
      return "texte « " + q + " »" + cmpLabel(expect) + " · " + t;
    case "text_gone":
      return "texte « " + q + " » disparaît" + cmpLabel(expect) + " · " + t;
    case "appear":
      return "nouvelle fenêtre/élément · " + t;
    case "window_ready":
      return "fenêtre prête" + (q ? " « " + q + " »" : "") + " · " + t;
    case "value":
      return "champ « " + q + " » = « " + (expect.expected || "") + " »" + cmpLabel(expect) + " · " + t;
    case "value_gone":
      return "champ « " + q + " » ≠ « " + (expect.expected || "") + " »" + cmpLabel(expect) + " · " + t;
    case "state":
      return "« " + q + " » est " + (expect.state || "?") + " · " + t;
    case "count":
      return (
        "compte « " +
        (q || expect.role || "*") +
        " » " +
        (expect.op || "==") +
        " " +
        (expect.count || 0) +
        " · " +
        t
      );
    case "pause":
      return "pause · " + t;
    case "none":
      return "aucune vérification";
    default:
      return "écran stable · " + t;
  }
}

/** Fraction de pixels dont la luminance diffère de plus de `threshold` entre deux frames de même taille. */
export function pixelDiffRatio(
  a?: ArrayLike<number> | null,
  b?: ArrayLike<number> | null,
  threshold?: number | null,
): number {
  const seuil = threshold == null ? 16 : threshold;
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > seuil) changed++;
  }
  return changed / a.length;
}

/** Liste plate (pré-ordre + depth) en lignes visibles d'un arbre repliable ; recherche à plat si `filter`. */
export function elementTreeRows(
  elements?: readonly ElementUi[] | null,
  collapsed?: Record<string, boolean> | null,
  filter?: unknown,
): LigneArbre[] {
  const els = elements || [];
  const repli = collapsed || {};
  const f = String(filter || "")
    .trim()
    .toLowerCase();
  const rows: LigneArbre[] = [];
  if (f) {
    for (const e of els) {
      const hay = ((e.label || "") + " " + (e.role || "") + " " + (e.auto_id || "")).toLowerCase();
      if (hay.indexOf(f) >= 0) rows.push({ el: e, depth: 0, hasChildren: false, collapsed: false });
    }
    return rows;
  }
  let hideBelow = -1;
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as ElementUi;
    const depth = Number(el.depth || 0);
    if (hideBelow >= 0 && depth > hideBelow) continue;
    hideBelow = -1;
    const nextDepth = i + 1 < els.length ? Number((els[i + 1] as ElementUi).depth || 0) : -1;
    const hasChildren = nextDepth > depth;
    const isCollapsed = hasChildren && !!repli[String(el.id)];
    rows.push({ el, depth, hasChildren, collapsed: isCollapsed });
    if (isCollapsed) hideBelow = depth;
  }
  return rows;
}

/** L'élément le plus profond sous un point : le plus petit qui le contient, puis le plus profond. */
export function deepestAt(elements: Elements, point: readonly number[]): ElementUi | null {
  let best: ElementUi | null = null;
  let bestA = Infinity;
  for (const el of elements ?? []) {
    const b = el && el.box;
    if (!el || !b || b.length < 4 || !inBox(b, point)) continue;
    const a = Math.max(0, (b[2] ?? 0) - (b[0] ?? 0)) * Math.max(0, (b[3] ?? 0) - (b[1] ?? 0));
    if (a < bestA || (a === bestA && best && depthOf(el) > depthOf(best))) {
      best = el;
      bestA = a;
    }
  }
  return best;
}

/** Plans : chaque racine (depth 0, hors vision) ouvre un plan ; les boxes de vision rejoignent le plan qui contient leur centre. */
export function elementLayers(elements?: Elements): { layers: Couche[]; layerOf: Record<string, number> } {
  const els = elements ?? [];
  const layers: Couche[] = [];
  const layerOf: Record<string, number> = {};
  const orphans: ElementUi[] = [];
  let current = 0;
  for (const el of els) {
    if (!el) continue;
    const isRoot = Number(el.depth || 0) === 0 && el.source !== "vision";
    if (isRoot) {
      current = layers.length + 1;
      layers.push({
        index: current,
        id: el.id,
        label: el.label || el.role || "plan " + current,
        role: el.role || "",
        box: el.box,
        count: 0,
      });
    }
    if (el.source === "vision" || !current) {
      orphans.push(el);
      continue;
    }
    layerOf[String(el.id)] = current;
    (layers[current - 1] as Couche).count++;
  }
  for (const el of orphans) {
    const c = centerOf(el);
    let hit = 0;
    for (const l of layers) {
      if (inBox(l.box, c)) {
        hit = l.index;
        break;
      }
    }
    if (!hit) {
      if (!layers.length)
        layers.push({ index: 1, id: null, label: "sans fenêtre", role: "", box: null, count: 0 });
      hit = 1;
    }
    layerOf[String(el.id)] = hit;
    (layers[hit - 1] as Couche).count++;
  }
  return { layers, layerOf };
}

/** Filtre par plans actifs (vide = tous) et par profondeur maximale (0 = toutes ; la vision passe toujours). */
export function filterByLayers(
  elements?: Elements,
  on?: Record<string, boolean> | null,
  depthMax?: number | null,
  layerOf?: Record<string, number> | null,
): ElementUi[] {
  const els = elements ?? [];
  const keys = on ? Object.keys(on).filter((k) => on[k]) : [];
  const lo = layerOf || elementLayers(els).layerOf;
  const dm = Number(depthMax || 0);
  return liste(els).filter((el) => {
    if (keys.length && !(on && on[String(lo[String(el.id)])])) return false;
    if (dm > 0 && el.source !== "vision" && Number(el.depth || 0) > dm - 1) return false;
    return true;
  });
}

export function layerOrdinal(index: number): string {
  return index === 1 ? "1er plan" : index + "e plan";
}

/** Une box est visible si elle chevauche le cadre [0,0,W,H] ; dimensions inconnues : oui. */
export function boxOnScreen(box: unknown, W?: number, H?: number): boolean {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => typeof n === "number" && isFinite(n)))
    return false;
  if (!W || !H) return true;
  return (box[2] as number) > 0 && (box[3] as number) > 0 && (box[0] as number) < W && (box[1] as number) < H;
}
