// SPDX-License-Identifier: MIT
/** frontend/test/reglages/apparence-perso.test.ts — un id `perso:<id>` pose la classe elpis-skin-perso et lie la feuille du compte (mécanisme des skins importés). */
import { nextTick, ref } from "vue";
import * as Vue from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { EVT_SKINS_PERSO } from "../../src/features/reglages/skins-perso";

import { classeSkin, creerApparence } from "../../src/features/reglages/apparence";
import type { SkinApp } from "../../src/features/reglages/apparence";
import type { CtxReglages, ReglagesApp, VueReglages } from "../../src/features/reglages/types";
import { json } from "../aides";

const PERSO: SkinApp = {
  id: "perso:mon-style",
  label: "Mon style",
  desc: "",
  builtin: false,
  perso: true,
  darkBase: true,
  sw: ["#000", "#111", "#0af"],
  css_url: "/api/skins/perso/mon-style/skin.css?v=1",
};

afterEach(() => {
  document.body.className = "";
  document.getElementById("elpis-plugin-skin")?.remove();
});

let appels: string[] = [];
let confirmer = true;

function monter(skin: string) {
  const settings = ref({ skin } as unknown as ReglagesApp);
  appels = [];
  const ctx = {
    showToast: () => undefined,
    openConfirm: async () => confirmer,
    fetchAuth: async (url: string, init?: RequestInit) => {
      appels.push((init?.method ?? "GET") + " " + url);
      if (url.startsWith("/api/skins/perso") && init?.method === "DELETE") return json({ ok: true });
      if (url === "/api/skins/perso") return json({ skins: [], max: 7 });
      return url === "/api/skins"
        ? json({
            skins: [{ id: "elpis", label: "Elpis", desc: "", builtin: true, sw: [] }, PERSO],
            default: "elpis",
            mascottes: [],
          })
        : null;
    },
  } as unknown as CtxReglages;
  const persistance = { persistKeys: async () => true } as never;
  const a = creerApparence(Vue as unknown as VueReglages, settings, ctx, persistance);
  return { a, settings };
}

describe("palette d'un skin dans apparence.ts", () => {
  it("pose la classe de palette, la retire au retour, ignore une valeur hors du motif", async () => {
    const { settings } = monter("elpis");
    settings.value.skin_palette = "argile";
    await nextTick();
    expect(document.body.classList.contains("elpis-palette-argile")).toBe(true);
    settings.value.skin_palette = "";
    await nextTick();
    expect([...document.body.classList].some((c) => c.startsWith("elpis-palette-"))).toBe(false);
    settings.value.skin_palette = "x y<z>";
    await nextTick();
    expect([...document.body.classList].some((c) => c.startsWith("elpis-palette-"))).toBe(false);
  });

  it("setAppSkin oublie la palette d'un autre skin, garde celle du même", async () => {
    const { settings, a } = monter("elpis");
    await a.loadAppSkins();
    settings.value.skin_palette = "argile";
    expect(await a.setAppSkin("elpis")).toBe(true);
    expect(settings.value.skin_palette).toBe("argile");
    expect(await a.setAppSkin("perso:mon-style")).toBe(true);
    expect(settings.value.skin_palette).toBe("");
  });

  it("changer d'habillage oublie la palette de l'ancien", async () => {
    const { settings, a } = monter("elpis");
    settings.value.skin_palette = "argile";
    await nextTick();
    a.choisirHabillage("emeraude");
    await nextTick();
    expect(settings.value).toMatchObject({ skin: "emeraude", skin_palette: "" });
    expect(document.body.classList.contains("elpis-palette-argile")).toBe(false);
  });
});

describe("habillage personnel dans apparence.ts", () => {
  it("classeSkin : perso:<id> devient perso, les autres restent tels quels", () => {
    expect(classeSkin("perso:mon-style")).toBe("perso");
    expect(classeSkin("elpis")).toBe("elpis");
    expect(classeSkin("")).toBe("");
  });

  it("applique la classe elpis-skin-perso et la feuille du compte, puis les retire au retour", async () => {
    const { a, settings } = monter("perso:mon-style");
    expect(document.body.classList.contains("elpis-skin-perso")).toBe(true);
    expect(document.body.className).not.toContain("perso:");
    await a.loadAppSkins();
    await nextTick();
    expect(document.getElementById("elpis-plugin-skin")?.getAttribute("href")).toBe(PERSO.css_url);
    expect(document.body.classList.contains("elpis-dark-surface")).toBe(true);
    settings.value.skin = "elpis";
    await nextTick();
    expect(document.body.classList.contains("elpis-skin-perso")).toBe(false);
    expect(document.body.classList.contains("elpis-skin-elpis")).toBe(true);
    expect(document.getElementById("elpis-plugin-skin")).toBeNull();
  });

  it("setAppSkin accepte un id perso: présent dans la liste", async () => {
    const { a, settings } = monter("elpis");
    await a.loadAppSkins();
    expect(await a.setAppSkin("perso:mon-style")).toBe(true);
    expect(settings.value.skin).toBe("perso:mon-style");
    expect(await a.setAppSkin("perso:absent")).toBe(false);
  });

  it("liste du compte : disponibilité et plafond lus sur /api/skins/perso", async () => {
    const { a } = monter("elpis");
    await a.loadAppSkins();
    await a.chargerSkinsPerso();
    expect(a.persoDispo.value).toBe(true);
    expect(a.persoMax.value).toBe(7);
    expect(a.skinsPerso.value.map((k) => k.id)).toEqual(["perso:mon-style"]);
    expect(a.skinsInstance.value.map((k) => k.id)).toEqual(["elpis"]);
  });

  it("suppression : refusée à la confirmation = rien ; confirmée = DELETE et retour au défaut si actif", async () => {
    const { a, settings } = monter("perso:mon-style");
    await a.loadAppSkins();
    confirmer = false;
    await a.supprimerHabillage(PERSO);
    expect(appels.some((x) => x.startsWith("DELETE"))).toBe(false);
    confirmer = true;
    await a.supprimerHabillage(PERSO);
    expect(appels).toContain("DELETE /api/skins/perso/mon-style");
    expect(settings.value.skin).toBe("elpis");
  });

  it("événement d'import : recharge la liste et applique l'id demandé", async () => {
    const { a, settings } = monter("elpis");
    window.dispatchEvent(new CustomEvent(EVT_SKINS_PERSO, { detail: { appliquer: "perso:mon-style" } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(a.skinsPerso.value.length).toBe(1);
    expect(settings.value.skin).toBe("perso:mon-style");
  });
});
