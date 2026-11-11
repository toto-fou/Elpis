// SPDX-License-Identifier: MIT
/** apps/core/test/apparence-palettes.test.ts — Parchemin fondu dans Elpis : alias, palette d'un compte, liste fermée, id réservé ; mascotte coupée par défaut. */
import { writeFileSync } from "node:fs";

import { mergeUserSettings } from "@elpis/auth";
import { config, invalidateConfigCache } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerCompte, demarrerCore } from "../../../packages/contracts/test/core/aides";
import type { CoreDeTest } from "../../../packages/contracts/test/core/aides";
import {
  aliasDe,
  defaultSkin,
  listSkins,
  paletteAdmise,
  paletteDuCompte,
  resolveUserSkin,
  SkinError,
  validateManifest,
} from "../src/apparence/skins";

let core: CoreDeTest;
let cookie = "";
let uid = 0;

const lire = async (): Promise<{ skin: string; skin_palette: string }> =>
  (await core.app.inject({ method: "GET", url: "/api/settings", headers: { cookie } })).json();
const ecrire = (corps: object) =>
  core.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: corps });

/** Écrit la section `skins` de config.json puis vide le cache de lecture. */
function reglerSkins(section: Record<string, unknown>): void {
  writeFileSync(config.CONFIG_JSON_PATH, JSON.stringify({ skins: section }));
  invalidateConfigCache();
}

beforeAll(async () => {
  core = await demarrerCore("main");
  uid = await creerCompte(core.base, "ada", "mdp-de-ada-1");
  cookie = await core.connecter("ada", "mdp-de-ada-1");
});

afterAll(() => core.fermer());

describe("registre", () => {
  it("Elpis annonce ses palettes, Parchemin n'est plus un skin mais un alias", () => {
    const skins = listSkins();
    expect(skins.some((s) => s["id"] === "parchemin")).toBe(false);
    const elpis = skins.find((s) => s["id"] === "elpis") as { palettes: { id: string }[] };
    expect(elpis.palettes.map((p) => p.id)).toEqual(["", "argile"]);
    expect(aliasDe("parchemin")).toEqual({ skin: "elpis", palette: "argile" });
    expect(aliasDe("elpis")).toBeNull();
  });

  it("un skin importé ne peut pas prendre l'identifiant d'un ancien skin fusionné", () => {
    expect(() =>
      validateManifest({ id: "parchemin", label: "Faux", swatch: ["#000", "#111", "#222"] }),
    ).toThrow(SkinError);
  });

  it("n'admet que les palettes du manifeste, pour le skin qui les propose", () => {
    expect(paletteAdmise("elpis", "argile")).toBe("argile");
    expect(paletteAdmise("elpis", "")).toBe("");
    expect(paletteAdmise("kiki", "argile")).toBe("");
    for (const hostile of ["inconnue", "argile evil", "<x>", 3, null, undefined, ["argile"]])
      expect(paletteAdmise("elpis", hostile)).toBe("");
  });

  it("résout le skin et la palette d'un compte resté sur l'ancien id", () => {
    expect(resolveUserSkin("parchemin")).toBe("elpis");
    expect(paletteDuCompte("elpis", null, "parchemin")).toBe("argile");
    expect(paletteDuCompte("elpis", "", "elpis")).toBe("");
    expect(paletteDuCompte("kiki", "argile", "kiki")).toBe("");
  });

  it("un défaut d'instance sur l'ancien id donne Elpis et Argile aux comptes sans choix", () => {
    reglerSkins({ default: "parchemin" });
    expect(defaultSkin()).toBe("elpis");
    expect(paletteDuCompte("elpis", null, null)).toBe("argile");
    expect(paletteDuCompte("elpis", null, "elpis")).toBe("");
    reglerSkins({});
  });

  it("un ancien skin activé garde sa cible activée", () => {
    reglerSkins({ default: "emeraude", enabled: { elpis: false, parchemin: true } });
    expect(resolveUserSkin("parchemin")).toBe("elpis");
    reglerSkins({ default: "emeraude", enabled: { elpis: false } });
    expect(resolveUserSkin("elpis")).toBe("emeraude");
    reglerSkins({});
  });
});

describe("réglages d'un compte", () => {
  it("un compte resté sur Parchemin lit Elpis et Argile sans écriture", async () => {
    await mergeUserSettings(core.base, uid, (s) => {
      s["skin"] = "parchemin";
    });
    expect(await lire()).toMatchObject({ skin: "elpis", skin_palette: "argile" });
  });

  it("écrire l'ancien id enregistre la cible et sa palette", async () => {
    expect((await ecrire({ skin: "parchemin" })).statusCode).toBe(200);
    expect(await lire()).toMatchObject({ skin: "elpis", skin_palette: "argile" });
  });

  it("un compte resté sur l'ancien id peut quitter sa palette : le choix tient à la relecture", async () => {
    await mergeUserSettings(core.base, uid, (s) => {
      s["skin"] = "parchemin";
      delete s["skin_palette"];
    });
    expect((await ecrire({ skin_palette: "" })).statusCode).toBe(200);
    expect(await lire()).toMatchObject({ skin: "elpis", skin_palette: "" });
  });

  it("changer de skin oublie la palette ; le même skin la garde", async () => {
    await ecrire({ skin: "elpis", skin_palette: "argile" });
    await ecrire({ skin: "elpis" });
    expect((await lire()).skin_palette).toBe("argile");
    await ecrire({ skin: "emeraude" });
    await ecrire({ skin: "elpis" });
    expect((await lire()).skin_palette).toBe("");
  });

  it("une palette inconnue revient à celle par défaut, sur le skin envoyé ou stocké", async () => {
    await ecrire({ skin: "elpis", skin_palette: "argile" });
    expect((await lire()).skin_palette).toBe("argile");
    await ecrire({ skin_palette: "pas-une-palette" });
    expect((await lire()).skin_palette).toBe("");
    await ecrire({ skin: "emeraude", skin_palette: "argile" });
    expect(await lire()).toMatchObject({ skin: "emeraude", skin_palette: "" });
  });
});

describe("mascotte d'un compte", () => {
  it("absente tant que le compte n'a rien choisi, booléen strict à l'écriture", async () => {
    const lu = (await lire()) as unknown as Record<string, unknown>;
    expect(Object.hasOwn(lu, "welcome_mascot_on")).toBe(false);
    await ecrire({ welcome_mascot_on: "oui" });
    expect(((await lire()) as unknown as Record<string, unknown>)["welcome_mascot_on"]).toBe(true);
    await ecrire({ welcome_mascot_on: false });
    expect(((await lire()) as unknown as Record<string, unknown>)["welcome_mascot_on"]).toBe(false);
  });
});
