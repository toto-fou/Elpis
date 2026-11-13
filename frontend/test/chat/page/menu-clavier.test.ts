// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/menu-clavier.test.ts — clavier des menus : flèche haut hors de la liste vers la dernière entrée, flèche bas vers la première, entrées désactivées sautées, boucle et Début / Fin. */
import { afterEach, describe, expect, it } from "vitest";

import { naviguerMenu } from "../../../src/features/chat/page/menu-clavier";

afterEach(() => {
  document.body.innerHTML = "";
});

function menu(): { m: HTMLElement; noms: () => string } {
  document.body.innerHTML = `<button id="dehors">x</button><div role="menu">
    <button role="menuitem">a</button><button role="menuitem" disabled>b</button>
    <button role="menuitemradio">c</button><button role="menuitem">d</button></div>`;
  const m = document.querySelector('[role="menu"]') as HTMLElement;
  return { m, noms: () => (document.activeElement as HTMLElement).textContent ?? "" };
}

const touche = (m: HTMLElement, key: string): boolean =>
  naviguerMenu(new KeyboardEvent("keydown", { key }), m);

describe("naviguerMenu", () => {
  it("hors de la liste : flèche haut va à la dernière entrée, flèche bas à la première", () => {
    const { m, noms } = menu();
    (document.getElementById("dehors") as HTMLElement).focus();
    expect(touche(m, "ArrowUp")).toBe(true);
    expect(noms()).toBe("d");
    (document.getElementById("dehors") as HTMLElement).focus();
    touche(m, "ArrowDown");
    expect(noms()).toBe("a");
  });

  it("entrée désactivée sautée ; boucle aux deux bouts ; Début et Fin", () => {
    const { m, noms } = menu();
    touche(m, "ArrowDown");
    touche(m, "ArrowDown");
    expect(noms()).toBe("c");
    touche(m, "ArrowUp");
    expect(noms()).toBe("a");
    touche(m, "ArrowUp");
    expect(noms()).toBe("d");
    touche(m, "Home");
    expect(noms()).toBe("a");
    touche(m, "End");
    expect(noms()).toBe("d");
  });
});
