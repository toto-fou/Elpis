// SPDX-License-Identifier: MIT
/** frontend/test/studio/scenario-reference.ts — chemins, voisins, ancres et audit d'accessibilité du modèle de scénario en parcours linéaires : référence des sorties de l'index. */
import {
  ANCHOR_FIELDS,
  INTERACTIVE_ROLES,
  parsePathSeg,
  realName,
  volatileId,
} from "../../src/modeles/scenario-model";
import type { Ancre, Audit, AuditLigne, ElementUi, SegmentChemin } from "../../src/modeles/scenario-model";

type Elements = readonly (ElementUi | null | undefined)[] | null | undefined;

const liste = (elements: Elements): ElementUi[] => (elements ?? []).filter((e): e is ElementUi => !!e);
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
