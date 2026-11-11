// SPDX-License-Identifier: MIT
/** frontend/test/reglages/skins-perso.test.ts — client des habillages personnels : analyse du bloc, pastilles sûres, vérification, import (409, 400, 403), message de correction, composition de l'aperçu. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  analyserBlocSkin,
  composerApercu,
  configurerSkinsPerso,
  EVT_SKINS_PERSO,
  importerSkin,
  libelleImport,
  listerSkinsPerso,
  brouillonAvecCorrection,
  messageBlocIllisible,
  messageCorrection,
  nomSkin,
  pastillesSkin,
  supprimerSkinPerso,
  verifierSkin,
} from "../../src/features/reglages/skins-perso";
import type { CorpsPerso } from "@elpis/contracts";
import { json } from "../aides";

const CORPS = {
  id: "mon-style",
  label: "Mon style",
  tokens: { light: { "--rail-bg": "#111111", "--app-bg": "#eeeeee", "--accent": "rgb(10, 20, 30)" } },
} as unknown as CorpsPerso;
const RAPPORT = { ok: true, erreurs: [], avertissements: [], contrastes: [], css: "body.elpis-skin-perso{}" };
const SKIN = {
  id: "mon-style",
  label: "Mon style",
  desc: "",
  darkBase: false,
  sw: [],
  builtin: false,
  perso: true,
  css_url: "/x",
};

let appels: { url: string; init?: RequestInit }[] = [];
function brancher(reponse: (url: string, init?: RequestInit) => Response | null): void {
  appels = [];
  configurerSkinsPerso(async (url, init) => {
    appels.push({ url, ...(init ? { init } : {}) });
    return reponse(url, init);
  });
}

beforeEach(() => brancher(() => null));
afterEach(() => vi.restoreAllMocks());

describe("analyserBlocSkin", () => {
  it("JSON invalide, non objet, objet", () => {
    expect(analyserBlocSkin("{")).toMatchObject({ ok: false });
    expect(analyserBlocSkin("[1]")).toEqual({ ok: false, erreur: "Objet JSON attendu." });
    expect(analyserBlocSkin('{"id":"a"}')).toMatchObject({ ok: true });
  });
  it("nom et pastilles : repli sur l'id, couleurs numériques seulement", () => {
    expect(nomSkin({ id: "abc" } as unknown as CorpsPerso)).toBe("abc");
    expect(nomSkin({} as unknown as CorpsPerso)).toBe("Habillage");
    expect(pastillesSkin(CORPS)).toEqual(["#111111", "#eeeeee", "rgb(10, 20, 30)"]);
    expect(pastillesSkin({ ...CORPS, swatch: ["red; background:url(x)", "#fff", "#000"] })).toEqual([]);
    expect(pastillesSkin({ ...CORPS, swatch: ["#111", "#222", "#333"] })).toEqual(["#111", "#222", "#333"]);
  });
});

describe("verifierSkin", () => {
  it("rend le rapport du serveur", async () => {
    brancher(() => json(RAPPORT));
    expect(await verifierSkin(CORPS)).toEqual({ ok: true, rapport: RAPPORT });
    expect(appels[0]?.url).toBe("/api/skins/perso/verifier");
    expect(JSON.parse(String(appels[0]?.init?.body))).toMatchObject({ id: "mon-style" });
  });
  it("réseau ou 403 : message", async () => {
    expect(await verifierSkin(CORPS)).toMatchObject({ ok: false });
    brancher(() => json({ detail: "x" }, 403));
    expect(await verifierSkin(CORPS)).toMatchObject({
      ok: false,
      message: expect.stringContaining("désactivés"),
    });
  });
});

describe("importerSkin", () => {
  it("succès : événement, application demandée seulement à la demande", async () => {
    brancher(() => json({ ok: true, remplace: false, skin: SKIN, rapport: RAPPORT }));
    const vus: unknown[] = [];
    const ecoute = (e: Event): number => vus.push((e as CustomEvent).detail);
    window.addEventListener(EVT_SKINS_PERSO, ecoute);
    expect(await importerSkin(CORPS)).toEqual({
      type: "ok",
      id: "mon-style",
      remplace: false,
      demande: false,
      applique: false,
    });
    await importerSkin(CORPS, { appliquer: true, overwrite: true });
    window.removeEventListener(EVT_SKINS_PERSO, ecoute);
    expect(vus).toEqual([{}, { appliquer: "perso:mon-style" }]);
    expect(JSON.parse(String(appels[1]?.init?.body)).overwrite).toBe(true);
    expect(JSON.parse(String(appels[0]?.init?.body)).overwrite).toBeUndefined();
  });
  it("409 existe déjà -> existe ; autre 409, 400 et 403 -> refus", async () => {
    brancher(() => json({ detail: "L'habillage « x » existe déjà." }, 409));
    expect(await importerSkin(CORPS)).toEqual({ type: "existe" });
    brancher(() => json({ detail: "Plafond de 10 habillages atteint." }, 409));
    expect(await importerSkin(CORPS)).toEqual({
      type: "refus",
      message: "Plafond de 10 habillages atteint.",
    });
    brancher(() => json({ detail: { ...RAPPORT, ok: false, erreurs: ["a", "b"] } }, 400));
    expect(await importerSkin(CORPS)).toEqual({ type: "refus", message: "a b" });
    brancher(() => json({ detail: "x" }, 403));
    expect(await importerSkin(CORPS)).toMatchObject({ type: "refus" });
    expect(libelleImport({ type: "existe" })).toContain("existe déjà");
    const ok = { type: "ok", id: "a", remplace: true, demande: true } as const;
    expect(libelleImport({ ...ok, applique: true })).toBe("Habillage remplacé et appliqué.");
    expect(libelleImport({ ...ok, applique: false })).toBe("Habillage remplacé, mais non appliqué.");
    expect(libelleImport({ ...ok, demande: false, applique: false })).toBe("Habillage remplacé.");
  });
});

describe("importerSkin : corps envoyé et application", () => {
  it("liste blanche : un overwrite ou une clé étrangère du bloc n'est jamais transmis", async () => {
    brancher(() => json({ ok: true, remplace: false, skin: SKIN, rapport: RAPPORT }));
    const hostile = { ...CORPS, overwrite: true, css: "x", brand: {} } as unknown as CorpsPerso;
    await importerSkin(hostile);
    const envoye = JSON.parse(String(appels[0]?.init?.body)) as Record<string, unknown>;
    expect(Object.keys(envoye).sort()).toEqual(["id", "label", "tokens"]);
    await importerSkin(hostile, { overwrite: true });
    expect(JSON.parse(String(appels[1]?.init?.body)).overwrite).toBe(true);
    await verifierSkin(hostile);
    expect(JSON.parse(String(appels[2]?.init?.body))).not.toHaveProperty("overwrite");
  });
  it("« appliqué » seulement si l'application a réussi", async () => {
    brancher(() => json({ ok: true, remplace: false, skin: SKIN, rapport: RAPPORT }));
    const reussi = (e: Event): void => {
      (e as CustomEvent).detail.promesse = Promise.resolve(true);
    };
    window.addEventListener(EVT_SKINS_PERSO, reussi);
    expect(await importerSkin(CORPS, { appliquer: true })).toMatchObject({ applique: true, demande: true });
    window.removeEventListener(EVT_SKINS_PERSO, reussi);
    expect(await importerSkin(CORPS, { appliquer: true })).toMatchObject({ applique: false, demande: true });
  });
});

describe("liste et suppression", () => {
  it("403 : null (fonction coupée) ; sinon nombre et plafond", async () => {
    brancher(() => json({ detail: "x" }, 403));
    expect(await listerSkinsPerso()).toBeNull();
    brancher(() => json({ skins: [SKIN], max: 10 }));
    expect(await listerSkinsPerso()).toEqual({ nombre: 1, max: 10 });
  });
  it("suppression : DELETE puis événement", async () => {
    brancher(() => json({ ok: true }));
    expect(await supprimerSkinPerso("mon-style")).toBe(true);
    expect(appels[0]).toMatchObject({ url: "/api/skins/perso/mon-style", init: { method: "DELETE" } });
    brancher(() => json({ detail: "x" }, 404));
    expect(await supprimerSkinPerso("absent")).toBe(false);
  });
});

describe("messageCorrection et composerApercu", () => {
  it("liste erreurs et contrastes en échec seulement", () => {
    const m = messageCorrection(CORPS, {
      ...RAPPORT,
      ok: false,
      erreurs: ["Contraste insuffisant"],
      contrastes: [
        { paire: "--text-900 / --surface", mode: "dark", ratio: 2.1, seuil: 4.5, ok: false },
        { paire: "--accent / --surface", mode: "light", ratio: 5, seuil: 3, ok: true },
      ],
    });
    expect(m).toContain("« Mon style »");
    expect(m).toContain("COMPLET");
    expect(m).toContain("- Contraste insuffisant");
    expect(m).toContain("--text-900 / --surface (sombre) : 2.1:1, 4.5:1 exigé");
    expect(m).not.toContain("--accent / --surface");
  });
  it("libellé tronqué à 40, clés inconnues comptées sans être recopiées", () => {
    const m = messageCorrection({ ...CORPS, label: "N".repeat(80) } as CorpsPerso, {
      ...RAPPORT,
      ok: false,
      erreurs: [
        "Clé « zzsecret » inconnue.",
        "Jetons clairs : jeton « --evil » hors de la liste admise.",
        "Autre",
      ],
    });
    expect(m).toContain("«" + " " + "N".repeat(39) + "…");
    expect(m).not.toContain("zzsecret");
    expect(m).not.toContain("--evil");
    expect(m).toContain("2 clé(s) ou jeton(s) hors de la liste admise");
    expect(m).toContain("- Autre");
  });
  it("brouillonAvecCorrection ajoute sans écraser", () => {
    expect(brouillonAvecCorrection("", "T")).toBe("T");
    expect(brouillonAvecCorrection("Mon brouillon  \n", "T")).toBe("Mon brouillon\n\nT");
  });
  it("bloc illisible : message tronqué", () => {
    expect(messageBlocIllisible("JSON invalide : " + "x".repeat(300)).length).toBeLessThan(260);
  });
  it("injecte la feuille dans l'emplacement, ajoute elpis-app-dark en sombre", () => {
    const maquette = '<style id="elpis-jetons"></style><body class="elpis-skin-perso">';
    expect(composerApercu(maquette, "a{}", false)).toBe(
      '<style id="elpis-jetons">a{}</style><body class="elpis-skin-perso">',
    );
    expect(composerApercu(maquette, "a{}", true)).toContain('class="elpis-skin-perso elpis-app-dark"');
    expect(composerApercu(maquette, "</style><script>", false)).not.toContain("</style><script>");
  });
});
