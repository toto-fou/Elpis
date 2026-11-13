// SPDX-License-Identifier: MIT
/** frontend/test/studio/audit-indexe.test.ts — audit d'accessibilité, chemins, voisins et ancres lus dans l'index : sorties identiques aux parcours linéaires sur des arbres tirés au hasard. */
import { describe, expect, it } from "vitest";

import * as M from "../../src/modeles/scenario-model";
import type { ElementUi } from "../../src/modeles/scenario-model";
import * as R from "./scenario-reference";

const ROLES = ["window", "pane", "group", "button", "Button", "text", "edit", "link", "list", "listitem"];
const ROLES2 = ["checkbox", "menuitem", "tab", "image", "combobox", "treeitem", "hyperlink", ""];
const NOMS = ["", "", "", "OK", "ok ", " OK", "Annuler", "Fermer", "Fichier/Ouvrir", "Menu", "x".repeat(70)];

/** Arbre UIA tiré au hasard : sauts de profondeur, noms ambigus, auto_id volatils ou partagés, vision, identifiants en double ou absents, même objet deux fois, trous. */
function arbre(n: number, graine: number, ancres = 0.1): (ElementUi | null)[] {
  let s = graine;
  const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(t: readonly T[]): T => t[Math.floor(rnd() * t.length)] as T;
  const els: (ElementUi | null)[] = [];
  let depth = 0;
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (i > 0)
      depth = r < 0.4 ? depth + 1 : r < 0.5 ? depth + 3 : r < 0.75 ? depth : Math.max(0, depth - 4 * rnd());
    depth = Math.round(depth);
    const role = i === 0 ? "window" : pick(rnd() < 0.5 ? ROLES : ROLES2);
    const nm = pick(NOMS);
    const x = Math.floor(rnd() * 1800);
    const y = Math.floor(rnd() * 1000);
    const w = 20 + Math.floor(rnd() * 300);
    const h = 10 + Math.floor(rnd() * 60);
    const e: ElementUi = {
      id: "e" + i,
      role,
      label: nm || role,
      depth,
      box: [x, y, x + w, y + h],
      source: "uia",
    };
    e.center = [x + w / 2, y + h / 2];
    const a = rnd();
    e.auto_id =
      a < 0.55
        ? "view_" + i
        : a < 0.65
          ? "btn" + (i % 7)
          : a < 0.7
            ? "a/b" + i
            : a < 0.7 + ancres
              ? "id" + i
              : "";
    const v = rnd();
    if (v < 0.04) e.source = "vision";
    if (v > 0.97) e.id = "e" + Math.floor(rnd() * Math.max(1, i));
    else if (v > 0.955) delete e.id;
    else if (v > 0.945) e.id = null;
    if (v > 0.5 && v < 0.53) e.name = nm ? nm.toUpperCase() : null;
    if (v > 0.53 && v < 0.55) e.unnamed = true;
    if (v > 0.55 && v < 0.57) delete e.center;
    if (v > 0.57 && v < 0.58) {
      delete e.center;
      delete e.box;
    }
    if (v > 0.58 && v < 0.59) e.depth = String(depth) as unknown as number;
    els.push(e);
  }
  if (n > 10) {
    els.splice(Math.floor(n / 2), 0, els[3] ?? null);
    els.splice(Math.floor(n / 3), 0, null);
  }
  return els;
}

const elementsDe = (els: (ElementUi | null)[]): ElementUi[] => els.filter((e): e is ElementUi => !!e);

describe("index des éléments : mêmes sorties que les parcours linéaires", () => {
  it.each([
    [50, 1],
    [50, 2],
    [50, 3],
    [500, 4],
    [500, 5],
    [2000, 6, 0.3],
  ])("audit, %i éléments (graine %i)", (n, graine, ancres?: number) => {
    const els = arbre(n, graine, ancres);
    const attendu = R.a11yAudit(els);
    expect(attendu.rows.length).toBeGreaterThan(n / 10);
    expect(M.a11yAudit(els)).toEqual(attendu);
    expect(M.a11yAuditResume(els)).toEqual({
      interactive: attendu.interactive,
      rows: attendu.rows.length,
      unnamed: attendu.unnamed,
    });
  });

  it.each([
    [50, 7],
    [50, 8],
    [150, 9],
  ])(
    "ancres, chemins, voisins, parents et enfants de chaque élément, %i éléments (graine %i)",
    (n, graine) => {
      const els = arbre(n, graine);
      const ix = M.indexerElements(els);
      for (const el of elementsDe(els)) {
        const proxy = { ...el };
        for (const cible of [el, proxy]) {
          expect(M.anchorFromElement(cible, els)).toEqual(R.anchorFromElement(cible, els));
          expect(M.anchorFromElement(cible, els, ix)).toEqual(R.anchorFromElement(cible, els));
          expect(M.elementParent(els, cible, ix)).toBe(R.elementParent(els, cible));
          expect(M.elementChildren(els, cible, ix)).toEqual(R.elementChildren(els, cible));
          expect(M.elementDescendants(els, cible, ix)).toEqual(R.elementDescendants(els, cible));
          expect(M.nearestLabel(els, cible, ix)).toEqual(R.nearestLabel(els, cible));
        }
        const chemin = R.elementPath(els, el);
        expect(M.resolvePath(els, chemin)).toBe(R.resolvePath(els, chemin));
        expect(M.resolvePath(els, chemin, false)).toBe(R.resolvePath(els, chemin, false));
      }
      expect(M.elementRoots(els)).toEqual(R.elementRoots(els));
    },
  );

  it("profondeurs illisibles et identifiants NaN : mêmes parents, enfants et chemins", () => {
    const els = arbre(80, 10);
    (els[5] as ElementUi).depth = "abc" as unknown as number;
    (els[9] as ElementUi).depth = Infinity;
    (els[12] as ElementUi).id = NaN;
    (els[20] as ElementUi).depth = -1;
    for (const el of elementsDe(els)) {
      expect(M.elementParent(els, el)).toBe(R.elementParent(els, el));
      expect(M.elementChildren(els, el)).toEqual(R.elementChildren(els, el));
      expect(M.elementPath(els, el)).toBe(R.elementPath(els, el));
    }
    expect(M.a11yAudit(els)).toEqual(R.a11yAudit(els));
  });

  it("2 000 éléments sans ancre sur les ancêtres : l'audit tient en quelques dizaines de millisecondes", () => {
    const els = arbre(2000, 11, 0);
    M.a11yAudit(els);
    const t0 = performance.now();
    const audit = M.a11yAudit(els);
    expect(performance.now() - t0).toBeLessThan(400);
    expect(audit.rows.length).toBeGreaterThan(500);
  });
});
