// SPDX-License-Identifier: MIT
/** frontend/test/reglages/habillage.test.ts — habillage de la page : classes du body sans retouche inutile, mémoire du navigateur, et le script d'avant le premier rendu du cœur qui la relit (même forme). */
import { nextTick, ref } from "vue";
import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCRIPT_HABILLAGE } from "../../../apps/core/src/interface/pages";
import { creerApparence } from "../../src/features/reglages/apparence";
import {
  avecFeuilles,
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
  for (const l of document.head.querySelectorAll("link[data-habillage]")) l.remove();
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

/** Fin de chargement des liens posés (happy-dom ne charge ni feuille ni police) : une feuille chargée a son `sheet`. */
function charges(): void {
  for (const l of document.head.querySelectorAll<HTMLLinkElement>("link[data-habillage]")) {
    if (l.rel === "stylesheet" && !l.sheet)
      Object.defineProperty(l, "sheet", { value: { disabled: false }, configurable: true });
    l.dispatchEvent(new Event("load"));
  }
}

/** Classes posées par le script du cœur sur un body vierge, et le HTML qu'il écrit, placé juste après le modèle (début) ou en fin de tête (fin). */
function rejouerScript(
  sombreSysteme = false,
  ou: "debut" | "fin" = "debut",
): { classes: string[]; ecrit: string[] } {
  document.body.className = "";
  const ecrit: string[] = [];
  const ajoutes: Element[] = [];
  let modele = document.getElementById("elpis-habillages");
  if (!modele) {
    modele = document.createElement("template");
    modele.id = "elpis-habillages";
    document.head.append(modele);
    ajoutes.push(modele);
  }
  const ici = document.createElement("script");
  if (ou === "debut") modele.after(ici);
  else {
    const avant = document.createElement("meta");
    document.head.append(avant, ici);
    ajoutes.push(avant);
  }
  ajoutes.push(ici);
  vi.spyOn(document, "currentScript", "get").mockReturnValue(ici);
  vi.spyOn(document, "write").mockImplementation((...html: string[]) => void ecrit.push(html.join("")));
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: sombreSysteme } as MediaQueryList);
  new Function(SCRIPT_HABILLAGE)();
  for (const e of ajoutes) e.remove();
  return { classes: [...document.body.classList].sort(), ecrit };
}

describe("poserHabillage", () => {
  it("pose skin, palette, sombre et surface ; retire ceux d'avant", async () => {
    document.body.className = "h-full elpis-skin-elpis elpis-palette-argile";
    await poserHabillage(TERMINAL);
    expect([...document.body.classList].sort()).toEqual(
      ["elpis-app-dark", "elpis-dark-surface", "elpis-skin-terminal", "h-full"].sort(),
    );
    await poserHabillage({ ...TERMINAL, id: "emeraude", mode: "light", sombre: false, base: true });
    expect([...document.body.classList].sort()).toEqual(
      ["elpis-dark-surface", "elpis-skin-emeraude", "h-full"].sort(),
    );
    await poserHabillage({ ...TERMINAL, id: "perso:mon-style", palette: "x y", sombre: false });
    expect(document.body.className).toBe("h-full elpis-skin-perso");
  });

  it("le même habillage reposé ne touche pas au body (aucun recalcul de style)", async () => {
    await poserHabillage({ ...TERMINAL, palette: "nuit" });
    const mutations: MutationRecord[] = [];
    const obs = new MutationObserver((m) => mutations.push(...m));
    obs.observe(document.body, { attributes: true });
    await poserHabillage({ ...TERMINAL, palette: "nuit" });
    await Promise.resolve();
    obs.disconnect();
    expect(mutations).toEqual([]);
  });

  it("feuille d'un skin servi : liée pour l'actif, retirée au retour", async () => {
    await poserHabillage({ ...TERMINAL, id: "perso:x", feuilles: ["/api/skins/perso/x/skin.css?v=1"] });
    expect(document.getElementById("elpis-plugin-skin")?.getAttribute("href")).toBe(
      "/api/skins/perso/x/skin.css?v=1",
    );
    await poserHabillage(TERMINAL);
    expect(document.getElementById("elpis-plugin-skin")).toBeNull();
  });
});

describe("mémoire du navigateur", () => {
  it("gardée à chaque pose, relue telle quelle ; réglages de départ qui en découlent", async () => {
    expect(lireMemoire()).toBeNull();
    expect(reglagesHabillage()).toEqual({
      skin: "elpis",
      skin_palette: "",
      dark_mode: false,
      dark_mode_auto: false,
    });
    const f = "/api/skins/perso/f/skin.css?v=1";
    await poserHabillage({ ...TERMINAL, palette: "nuit", mode: "system", base: true, feuilles: [f] });
    expect(lireMemoire()).toEqual({ id: "terminal", p: "nuit", m: "system", b: true, f: [f] });
    expect(reglagesHabillage()).toEqual({
      skin: "terminal",
      skin_palette: "nuit",
      dark_mode: false,
      dark_mode_auto: true,
    });
  });

  it("valeur illisible ou stockage refusé : aucune mémoire, rien ne casse", async () => {
    localStorage.setItem(CLE_HABILLAGE, "{pas du json");
    expect(lireMemoire()).toBeNull();
    const servie = "/api/skins/x/skin.css?v=3a";
    localStorage.setItem(
      CLE_HABILLAGE,
      JSON.stringify({ id: "elpis", m: "rose", f: [1, "/a.css", "https://ailleurs/x.css", servie] }),
    );
    expect(lireMemoire()).toEqual({ id: "elpis", p: "", m: "light", b: false, f: [servie] });
    refuserStockage();
    expect(lireMemoire()).toBeNull();
    await expect(poserHabillage(TERMINAL)).resolves.toBeUndefined();
    expect(document.body.classList.contains("elpis-skin-terminal")).toBe(true);
  });
});

describe("script d'avant le premier rendu (apps/core/src/interface/pages.ts)", () => {
  it("rien en mémoire : Elpis clair", () => {
    expect(rejouerScript()).toEqual({ classes: ["elpis-skin-elpis"], ecrit: [] });
  });

  it("relit ce que poserHabillage garde : mêmes classes", async () => {
    for (const h of [
      TERMINAL,
      { ...TERMINAL, id: "elpis", palette: "argile", mode: "light", sombre: false } as const,
      { ...TERMINAL, id: "emeraude", mode: "light", sombre: false, base: true } as const,
      { ...TERMINAL, id: "", mode: "dark" } as const,
    ]) {
      await poserHabillage(h);
      const attendues = [...document.body.classList].sort();
      expect(rejouerScript().classes).toEqual(attendues);
    }
  });

  it("suivre le système : sombre selon la préférence du poste", async () => {
    await poserHabillage({ ...TERMINAL, mode: "system", sombre: false });
    expect(rejouerScript(false).classes).toEqual(["elpis-skin-terminal"]);
    expect(rejouerScript(true).classes).toEqual([
      "elpis-app-dark",
      "elpis-dark-surface",
      "elpis-skin-terminal",
    ]);
  });

  it("habillage personnel : classe perso et feuille du compte ; une URL hors /api/skins n'est pas écrite", async () => {
    const url = "/api/skins/perso/mon-style/skin.css?v=3a9f";
    await poserHabillage({
      ...TERMINAL,
      id: "perso:mon-style",
      mode: "light",
      sombre: false,
      feuilles: [url],
    });
    expect(rejouerScript()).toEqual({ classes: ["elpis-skin-perso"], ecrit: [] });
    expect(rejouerScript(false, "fin")).toEqual({
      classes: [],
      ecrit: [`<link rel="stylesheet" id="elpis-plugin-skin" data-habillage href="${url}">`],
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

describe("feuilles de l'habillage actif seulement (modèle de la page)", () => {
  const V = "?v=B1";
  beforeEach(() => {
    document.head.insertAdjacentHTML(
      "beforeend",
      `<link rel="stylesheet" href="static/css/style.css${V}">` +
        '<template id="elpis-habillages">' +
        `<link rel="stylesheet" href="static/css/skins/elpis/skin.css${V}" data-habillage="elpis">` +
        '<link rel="preload" href="static/css/skins/terminal/polices/jb.woff2" as="font" type="font/woff2" crossorigin data-habillage="terminal">' +
        `<link rel="stylesheet" href="static/css/skins/terminal/polices.css${V}" data-habillage="terminal">` +
        `<link rel="stylesheet" href="static/css/skins/terminal/skin.css${V}" data-habillage="terminal">` +
        "</template>" +
        `<link rel="stylesheet" href="static/css/style.tailwind.css${V}">`,
    );
  });
  afterEach(() => {
    document.head.innerHTML = "";
  });
  const poses = (): string[] =>
    [...document.head.querySelectorAll("link[data-habillage]")].map((l) => l.getAttribute("href") ?? "");

  it("charge les feuilles et la police du skin entre style.css et Tailwind, puis bascule les classes", async () => {
    document.body.className = "elpis-skin-elpis";
    const fin = poserHabillage(TERMINAL);
    await Promise.resolve();
    expect(document.body.className).toBe("elpis-skin-elpis");
    expect(poses().sort()).toEqual(
      [
        `static/css/skins/terminal/polices.css${V}`,
        `static/css/skins/terminal/skin.css${V}`,
        "static/css/skins/terminal/polices/jb.woff2",
      ].sort(),
    );
    const ordre = [...document.head.children].map((e) => e.getAttribute("href") ?? e.id);
    expect(ordre.indexOf("elpis-habillages")).toBeLessThan(
      ordre.indexOf(`static/css/skins/terminal/skin.css${V}`),
    );
    expect(ordre.indexOf(`static/css/skins/terminal/skin.css${V}`)).toBeLessThan(
      ordre.indexOf(`static/css/style.tailwind.css${V}`),
    );
    charges();
    await fin;
    expect(document.body.classList.contains("elpis-skin-terminal")).toBe(true);
  });

  it("deux choix rapprochés : le dernier l'emporte", async () => {
    const a = poserHabillage(TERMINAL);
    const b = poserHabillage({ ...TERMINAL, id: "elpis", sombre: false, mode: "light" });
    charges();
    await Promise.all([a, b]);
    expect(document.body.className).toBe("elpis-skin-elpis");
  });

  it("feuilles déjà posées : bascule immédiate, aucune en double", async () => {
    const a = poserHabillage(TERMINAL);
    charges();
    await a;
    const b = poserHabillage({ ...TERMINAL, id: "elpis" });
    charges();
    await b;
    const n = poses().length;
    void poserHabillage(TERMINAL);
    expect(document.body.classList.contains("elpis-skin-terminal")).toBe(true);
    expect(poses()).toHaveLength(n);
  });

  it("feuille servie : marquée elpis-plugin-skin, retirée au retour à un intégré", async () => {
    const url = "/api/skins/perso/x/skin.css?v=1";
    await poserHabillage({ ...TERMINAL, id: "perso:x", feuilles: [url] });
    expect(document.getElementById("elpis-plugin-skin")?.getAttribute("href")).toBe(url);
    const retour = poserHabillage(TERMINAL);
    charges();
    await retour;
    expect(document.getElementById("elpis-plugin-skin")).toBeNull();
    expect(poses()).not.toContain(url);
  });

  it("feuille servie : en fin de tête, après Tailwind", async () => {
    await poserHabillage({ ...TERMINAL, id: "perso:x", feuilles: ["/api/skins/perso/x/skin.css?v=1"] });
    expect(document.head.lastElementChild?.getAttribute("href")).toBe("/api/skins/perso/x/skin.css?v=1");
  });

  it("feuille en échec : un nouveau lien la retente à la bascule suivante", async () => {
    const elpis = { ...TERMINAL, id: "elpis", sombre: false, mode: "light" } as const;
    await poserHabillage(elpis);
    const echec = document.head.querySelector(`link[href="static/css/skins/elpis/skin.css${V}"]`);
    await poserHabillage({ ...elpis, palette: "argile" });
    const liens = document.head.querySelectorAll(`link[href="static/css/skins/elpis/skin.css${V}"]`);
    expect(liens).toHaveLength(1);
    expect(liens[0]).not.toBe(echec);
    expect(echec?.isConnected).toBe(false);
  });

  it("avecFeuilles : lit une fois les feuilles d'un skin chargées, sans changer d'habillage", async () => {
    document.body.className = "elpis-skin-elpis";
    const lecture = avecFeuilles("terminal", () => poses().length);
    charges();
    const lu = await lecture;
    expect(lu).toBe(3);
    expect(document.body.className).toBe("elpis-skin-elpis");
  });

  it("script du cœur : écrit les liens du modèle pour le skin gardé", async () => {
    const pose = poserHabillage(TERMINAL);
    charges();
    await pose;
    const { ecrit } = rejouerScript();
    expect(ecrit.map((h) => /href="([^"]+)"/.exec(h)?.[1])).toEqual([
      "static/css/skins/terminal/polices/jb.woff2",
      `static/css/skins/terminal/polices.css${V}`,
      `static/css/skins/terminal/skin.css${V}`,
    ]);
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
