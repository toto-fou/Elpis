// SPDX-License-Identifier: MIT
/** frontend/test/editor/feuille-skin.test.ts — feuille d'éditeur du skin : liée une fois, remplacée après chargement, retirée à la demande, dernière demande gagnante. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chargerFeuilleEditeur } from "../../src/features/editor/feuille-skin";

const liens = (): HTMLElement[] => Array.from(document.head.querySelectorAll<HTMLElement>("[href]"));
const signaler = (l: HTMLElement | undefined, type = "load"): void => {
  const gestionnaire = (l as unknown as Record<string, unknown> | undefined)?.[`on${type}`];
  if (typeof gestionnaire === "function") (gestionnaire as () => void)();
};

// Élément inerte à la place d'un vrai <link> : le chargement ne se résout qu'au signal du test.
beforeEach(() => {
  const creer = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(() => creer("div"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await chargerFeuilleEditeur("");
  document.head.innerHTML = "";
});

describe("feuille d'éditeur", () => {
  it("se résout une fois la feuille chargée, et pose son identifiant", async () => {
    let finie = false;
    const p = chargerFeuilleEditeur("/a.css").then(() => {
      finie = true;
    });
    await Promise.resolve();
    expect(finie).toBe(false);
    signaler(liens()[0]);
    await p;
    expect(finie).toBe(true);
    expect(document.getElementById("elpis-skin-editeur")?.getAttribute("href")).toBe("/a.css");
  });

  it("la même feuille n'est pas rechargée", async () => {
    const p = chargerFeuilleEditeur("/a.css");
    signaler(liens()[0]);
    await p;
    await chargerFeuilleEditeur("/a.css");
    expect(liens()).toHaveLength(1);
  });

  it("l'ancienne reste jusqu'au chargement de la nouvelle", async () => {
    const a = chargerFeuilleEditeur("/a.css");
    signaler(liens()[0]);
    await a;
    const b = chargerFeuilleEditeur("/b.css");
    expect(liens()).toHaveLength(2);
    signaler(liens()[1]);
    await b;
    expect(liens().map((l) => l.getAttribute("href"))).toEqual(["/b.css"]);
  });

  it("deux demandes rapprochées : seule la dernière reste", async () => {
    const a = chargerFeuilleEditeur("/a.css");
    const b = chargerFeuilleEditeur("/b.css");
    const [la, lb] = liens();
    signaler(lb);
    signaler(la);
    await Promise.all([a, b]);
    expect(liens().map((l) => l.getAttribute("href"))).toEqual(["/b.css"]);
    expect(lb?.id).toBe("elpis-skin-editeur");
  });

  it("feuille en échec : la promesse se résout quand même ; vide : retirée", async () => {
    const a = chargerFeuilleEditeur("/absente.css");
    signaler(liens()[0], "error");
    await a;
    await chargerFeuilleEditeur("");
    expect(document.getElementById("elpis-skin-editeur")).toBeNull();
  });
});
