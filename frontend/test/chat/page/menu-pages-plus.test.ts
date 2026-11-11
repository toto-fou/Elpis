// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/menu-pages-plus.test.ts — sous-menu « Plus » du volet latéral : pages selon les droits (Bibliothèque sous RAG), page active, position à droite du volet. */
import { describe, expect, it } from "vitest";

import { pagePlusActive, pagesPlus, positionPlus } from "../../../src/features/chat/page/menu-pages-plus";

describe("sous-menu « Plus »", () => {
  it("RAG avec le droit RAG, Bibliothèque avec les images, Agents avec les sous-agents, Remote code avec opencode, Studio toujours, dans cet ordre", () => {
    const vues = (rag: boolean, images: boolean, opencode: boolean, agents = false) =>
      pagesPlus({ rag, images, opencode, agents }).map((p) => p.vue);
    expect(vues(true, true, true, true)).toEqual(["rag", "bibliotheque", "studio", "agents", "code"]);
    expect(vues(true, true, true)).toEqual(["rag", "bibliotheque", "studio", "code"]);
    expect(vues(true, false, true)).toEqual(["rag", "studio", "code"]);
    expect(vues(false, true, true)).toEqual(["bibliotheque", "studio", "code"]);
    expect(vues(true, false, false)).toEqual(["rag", "studio"]);
    expect(vues(false, false, false, true)).toEqual(["studio", "agents"]);
    expect(vues(false, false, false)).toEqual(["studio"]);
  });

  it("page active : seulement une page visible du sous-menu", () => {
    const toutes = pagesPlus({ rag: true, images: true, opencode: true, agents: true });
    expect(pagePlusActive("rag", toutes)?.libelle).toBe("RAG");
    expect(pagePlusActive("agents", toutes)?.icone).toBe("ph-robot");
    expect(pagePlusActive("routines", toutes)).toBeNull();
    expect(
      pagePlusActive("rag", pagesPlus({ rag: false, images: true, opencode: true, agents: true })),
    ).toBeNull();
  });

  it("à droite du volet, aligné sur le déclencheur, jamais hors de la fenêtre", () => {
    expect(positionPlus(300, 260, 110, 900)).toEqual({ left: 266, top: 295 });
    expect(positionPlus(850, 48, 110, 900)).toEqual({ left: 54, top: 782 });
    expect(positionPlus(2, 48, 110, 900).top).toBe(8);
  });
});
