// SPDX-License-Identifier: MIT
/** frontend/test/reglages/habillage.test.ts — habillage de la page : classes du body sans retouche inutile, mémoire du navigateur, et le script d'avant le premier rendu du cœur qui la relit (même forme). */
import { nextTick, ref } from "vue";
import * as Vue from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SCRIPT_HABILLAGE } from "../../../apps/core/src/interface/pages";
import { creerApparence } from "../../src/features/reglages/apparence";
import {
  CLE_HABILLAGE,
  lireMemoire,
  poserHabillage,
  reglagesHabillage,
} from "../../src/features/reglages/habillage";
import type { Habillage } from "../../src/features/reglages/habillage";
import type { CtxReglages, ReglagesApp, VueReglages } from "../../src/features/reglages/types";
import { json } from "../aides";

const TERMINAL: Habillage = {
  id: "terminal",
  palette: "",
  mode: "dark",
  sombre: true,
  base: false,
  feuilles: [],
};

afterEach(() => {
  document.body.className = "";
  document.getElementById("elpis-plugin-skin")?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Stockage du navigateur refusé (navigation privée stricte, données de site bloquées). */
function refuserStockage(): void {
  const refus = (): never => {
    throw new DOMException("refusé", "SecurityError");
  };
  vi.stubGlobal("localStorage", { getItem: refus, setItem: refus });
}

/** Classes posées par le script du cœur sur un body vierge, et le HTML qu'il écrit dans la page. */
function rejouerScript(sombreSysteme = false): { classes: string[]; ecrit: string[] } {
  document.body.className = "";
  const ecrit: string[] = [];
  vi.spyOn(document, "write").mockImplementation((...html: string[]) => void ecrit.push(html.join("")));
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: sombreSysteme } as MediaQueryList);
  new Function(SCRIPT_HABILLAGE)();
  return { classes: [...document.body.classList].sort(), ecrit };
}

describe("poserHabillage", () => {
  it("pose skin, palette, sombre et surface ; retire ceux d'avant", () => {
    document.body.className = "h-full elpis-skin-elpis elpis-palette-argile";
    poserHabillage(TERMINAL);
    expect([...document.body.classList].sort()).toEqual(
      ["elpis-app-dark", "elpis-dark-surface", "elpis-skin-terminal", "h-full"].sort(),
    );
    poserHabillage({ ...TERMINAL, id: "emeraude", mode: "light", sombre: false, base: true });
    expect([...document.body.classList].sort()).toEqual(
      ["elpis-dark-surface", "elpis-skin-emeraude", "h-full"].sort(),
    );
    poserHabillage({ ...TERMINAL, id: "perso:mon-style", palette: "x y", sombre: false });
    expect(document.body.className).toBe("h-full elpis-skin-perso");
  });

  it("le même habillage reposé ne touche pas au body (aucun recalcul de style)", async () => {
    poserHabillage({ ...TERMINAL, palette: "nuit" });
    const mutations: MutationRecord[] = [];
    const obs = new MutationObserver((m) => mutations.push(...m));
    obs.observe(document.body, { attributes: true });
    poserHabillage({ ...TERMINAL, palette: "nuit" });
    await Promise.resolve();
    obs.disconnect();
    expect(mutations).toEqual([]);
  });

  it("feuille d'un skin servi : liée pour l'actif, retirée au retour", () => {
    poserHabillage({ ...TERMINAL, id: "perso:x", feuilles: ["/api/skins/perso/x/skin.css?v=1"] });
    expect(document.getElementById("elpis-plugin-skin")?.getAttribute("href")).toBe(
      "/api/skins/perso/x/skin.css?v=1",
    );
    poserHabillage(TERMINAL);
    expect(document.getElementById("elpis-plugin-skin")).toBeNull();
  });
});

describe("mémoire du navigateur", () => {
  it("gardée à chaque pose, relue telle quelle ; réglages de départ qui en découlent", () => {
    expect(lireMemoire()).toBeNull();
    expect(reglagesHabillage()).toEqual({
      skin: "elpis",
      skin_palette: "",
      dark_mode: false,
      dark_mode_auto: false,
    });
    poserHabillage({ ...TERMINAL, palette: "nuit", mode: "system", base: true, feuilles: ["/f.css"] });
    expect(lireMemoire()).toEqual({ id: "terminal", p: "nuit", m: "system", b: true, f: ["/f.css"] });
    expect(reglagesHabillage()).toEqual({
      skin: "terminal",
      skin_palette: "nuit",
      dark_mode: false,
      dark_mode_auto: true,
    });
  });

  it("valeur illisible ou stockage refusé : aucune mémoire, rien ne casse", () => {
    localStorage.setItem(CLE_HABILLAGE, "{pas du json");
    expect(lireMemoire()).toBeNull();
    localStorage.setItem(CLE_HABILLAGE, JSON.stringify({ id: "elpis", m: "rose", f: [1, "/a.css"] }));
    expect(lireMemoire()).toEqual({ id: "elpis", p: "", m: "light", b: false, f: ["/a.css"] });
    refuserStockage();
    expect(lireMemoire()).toBeNull();
    expect(() => poserHabillage(TERMINAL)).not.toThrow();
    expect(document.body.classList.contains("elpis-skin-terminal")).toBe(true);
  });
});

describe("script d'avant le premier rendu (apps/core/src/interface/pages.ts)", () => {
  it("rien en mémoire : Elpis clair", () => {
    expect(rejouerScript()).toEqual({ classes: ["elpis-skin-elpis"], ecrit: [] });
  });

  it("relit ce que poserHabillage garde : mêmes classes", () => {
    for (const h of [
      TERMINAL,
      { ...TERMINAL, id: "elpis", palette: "argile", mode: "light", sombre: false } as const,
      { ...TERMINAL, id: "emeraude", mode: "light", sombre: false, base: true } as const,
      { ...TERMINAL, id: "", mode: "dark" } as const,
    ]) {
      poserHabillage(h);
      const attendues = [...document.body.classList].sort();
      expect(rejouerScript().classes).toEqual(attendues);
    }
  });

  it("suivre le système : sombre selon la préférence du poste", () => {
    poserHabillage({ ...TERMINAL, mode: "system", sombre: false });
    expect(rejouerScript(false).classes).toEqual(["elpis-skin-terminal"]);
    expect(rejouerScript(true).classes).toEqual([
      "elpis-app-dark",
      "elpis-dark-surface",
      "elpis-skin-terminal",
    ]);
  });

  it("habillage personnel : classe perso et feuille du compte ; une URL hors /api/skins n'est pas écrite", () => {
    const url = "/api/skins/perso/mon-style/skin.css?v=3a9f";
    poserHabillage({ ...TERMINAL, id: "perso:mon-style", mode: "light", sombre: false, feuilles: [url] });
    expect(rejouerScript()).toEqual({
      classes: ["elpis-skin-perso"],
      ecrit: [`<link rel="stylesheet" id="elpis-plugin-skin" href="${url}">`],
    });
    localStorage.setItem(
      CLE_HABILLAGE,
      JSON.stringify({ id: "x", f: ['/api/skins/a"><script>.css', "https://ailleurs/skin.css"] }),
    );
    expect(rejouerScript()).toEqual({ classes: ["elpis-skin-x"], ecrit: [] });
  });

  it("stockage refusé : Elpis clair, sans erreur", () => {
    refuserStockage();
    expect(rejouerScript().classes).toEqual(["elpis-skin-elpis"]);
  });
});

describe("creerApparence : l'habillage gardé tient jusqu'aux réglages", () => {
  async function monter(memoire: object, skin: string) {
    localStorage.setItem(CLE_HABILLAGE, JSON.stringify(memoire));
    const settings = ref({ ...reglagesHabillage(), skin } as unknown as ReglagesApp);
    const ctx = {
      fetchAuth: async (url: string) =>
        url === "/api/skins"
          ? json({
              skins: [
                { id: "elpis", label: "Elpis", desc: "", builtin: true, sw: [] },
                { id: "emeraude", label: "Émeraude", desc: "", builtin: true, darkBase: true, sw: [] },
              ],
              default: "elpis",
            })
          : null,
    } as unknown as CtxReglages;
    const a = creerApparence(Vue as unknown as VueReglages, settings, ctx, {} as never);
    await nextTick();
    return { a, settings };
  }

  it("base sombre d'un skin pas encore listé, puis liste et réglages identiques : body intouché", async () => {
    const { a, settings } = await monter({ id: "emeraude", m: "light", b: true }, "emeraude");
    expect(document.body.className).toBe("elpis-skin-emeraude elpis-dark-surface");
    const mutations: MutationRecord[] = [];
    const obs = new MutationObserver((m) => mutations.push(...m));
    obs.observe(document.body, { attributes: true });
    await a.loadAppSkins();
    settings.value = { ...settings.value, dark_mode: false, dark_mode_auto: false, skin_palette: "" };
    await nextTick();
    obs.disconnect();
    expect(mutations).toEqual([]);
  });

  it("autre compte : ses réglages remplacent l'habillage gardé", async () => {
    const { settings } = await monter({ id: "emeraude", m: "dark", b: true }, "emeraude");
    settings.value = { ...settings.value, skin: "elpis", dark_mode: false, dark_mode_auto: false };
    await nextTick();
    expect(document.body.className).toBe("elpis-skin-elpis");
    expect(lireMemoire()).toMatchObject({ id: "elpis", m: "light", b: false });
  });
});
