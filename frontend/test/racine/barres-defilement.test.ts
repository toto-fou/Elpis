// SPDX-License-Identifier: MIT
/** frontend/test/racine/barres-defilement.test.ts — barres de défilement discrètes : marque d'une seconde après un défilement ; règles CSS. */
import fs from "node:fs";
import path from "node:path";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLE_CHROME } from "../../src/app/racine/domaine";
import ChromeApp from "../../src/components/racine/ChromeApp.vue";
import { demonter, etat, monter } from "../chat/page/montage";

afterEach(() => {
  demonter();
  vi.useRealTimers();
});

const chrome = () =>
  etat({
    systemAlert: "",
    announcerText: "",
    announcerAssertive: false,
    toasts: [],
    modalState: { isOpen: false },
    contextMenu: { isOpen: false, x: 0, y: 0, type: "", item: null },
  });

function defiler(): HTMLElement {
  monter(ChromeApp, [[CLE_CHROME as InjectionKey<object>, chrome()]]);
  const zone = document.createElement("div");
  document.body.appendChild(zone);
  zone.dispatchEvent(new Event("scroll"));
  return zone;
}

describe("barres de défilement discrètes", () => {
  it("la zone qui défile porte .elpis-defile pendant une seconde, relancée à chaque défilement", () => {
    vi.useFakeTimers();
    const zone = defiler();
    expect(zone.classList.contains("elpis-defile")).toBe(true);
    vi.advanceTimersByTime(800);
    zone.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(800);
    expect(zone.classList.contains("elpis-defile")).toBe(true);
    vi.advanceTimersByTime(300);
    expect(zone.classList.contains("elpis-defile")).toBe(false);
  });

  it("règles CSS : transparentes au repos, visibles au survol, au focus et au défilement, gouttière stable", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../css/style.css"), "utf8");
    const bloc = css.slice(css.indexOf("/* Barres de défilement discrètes"));
    expect(bloc).toContain("* { scrollbar-width: thin; scrollbar-color: transparent transparent; }");
    expect(bloc).toContain(":is(:hover, :focus-within, .elpis-defile)");
    expect(bloc).toContain("scrollbar-gutter: stable");
    const regles = bloc.split("\n").filter((l) => l.includes("{"));
    expect(regles.length).toBe(4);
  });
});
