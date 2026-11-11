// SPDX-License-Identifier: MIT
/** apps/core/test/apparence-deux-mondes.test.ts — séparation des deux mondes : l'habillage du compte n'existe pas dans la console, la console n'existe pas dans main, un skin désactivé ne sort de la console que pour un administrateur ; le nom de l'assistant se règle dans la console seule. */
import { writeFileSync } from "node:fs";

import { getUserSettings, mergeUserSettings } from "@elpis/auth";
import { config, invalidateConfigCache } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerCompte, demarrerCore } from "../../../packages/contracts/test/core/aides";
import type { CoreDeTest } from "../../../packages/contracts/test/core/aides";
import { enregistrerPerso } from "../src/apparence/comptes-perso";
import { evaluerSkinPerso } from "../src/apparence/perso";

const JETONS = {
  "--app-bg": "#f1f5f9",
  "--surface": "#ffffff",
  "--text-900": "#0f172a",
  "--text-600": "#475569",
  "--border": "#e2e8f0",
  "--accent": "#2563eb",
  "--rail-bg": "#0f172a",
  "--rail-text": "#cbd5e1",
};
const CORPS = { id: "mon-style", label: "Mon style", darkBase: true, tokens: { light: JETONS } };

const ROUTES_COMPTE: readonly (readonly ["GET" | "POST" | "DELETE", string])[] = [
  ["GET", "/api/skins/perso"],
  ["POST", "/api/skins/perso"],
  ["POST", "/api/skins/perso/verifier"],
  ["DELETE", "/api/skins/perso/mon-style"],
  ["GET", "/api/skins/perso/mon-style/skin.css"],
];

let core: CoreDeTest;
let cookieAdmin = "";
let cookieUser = "";
let uidAdmin = 0;
let uidUser = 0;

/** Démarre un core, crée un administrateur et un compte simple, et donne un habillage à l'administrateur. */
async function preparer(mode: "main" | "admin"): Promise<void> {
  core = await demarrerCore(mode);
  uidAdmin = await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  uidUser = await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookieAdmin = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieUser = await core.connecter("lou", "mdp-de-lou-1");
  const { manifeste } = evaluerSkinPerso(CORPS);
  await enregistrerPerso(uidAdmin, manifeste as Record<string, unknown>, false);
  await mergeUserSettings(core.base, uidAdmin, (s) => {
    s["skin"] = "perso:mon-style";
  });
  ecrireConfig({ skins: { enabled: { kiki: false } }, app_info: { name: "Atlas" } });
}

function ecrireConfig(valeurs: Record<string, unknown>): void {
  writeFileSync(config.CONFIG_JSON_PATH, JSON.stringify(valeurs));
  invalidateConfigCache();
}

const appel = (methode: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  core.app.inject({
    method: methode,
    url,
    headers: { cookie },
    ...(payload ? { payload: payload as object } : {}),
  });

const nomLu = (r: { json: <T>() => T }): string => r.json<{ assistant_name: string }>().assistant_name;

describe("console (process admin)", () => {
  beforeAll(() => preparer("admin"));
  afterAll(() => core.fermer());

  it("ne monte aucune route d'habillage personnel, pour personne", async () => {
    for (const [methode, url] of ROUTES_COMPTE) {
      expect(
        (await appel(methode, url, cookieAdmin, methode === "POST" ? CORPS : undefined)).statusCode,
      ).toBe(404);
      expect((await appel(methode, url, cookieUser, methode === "POST" ? CORPS : undefined)).statusCode).toBe(
        404,
      );
    }
  });

  it("ne liste que les skins de l'instance", async () => {
    const r = (await appel("GET", "/api/skins", cookieAdmin)).json<{ skins: { id: string }[] }>();
    expect(r.skins.some((s) => s.id === "elpis")).toBe(true);
    expect(r.skins.some((s) => s.id.startsWith("perso:"))).toBe(false);
  });

  it("montre le skin d'instance à l'administrateur dont le compte est sur un habillage, sans toucher son choix", async () => {
    const lu = (await appel("GET", "/api/settings", cookieAdmin)).json<{ skin: string }>();
    expect(lu.skin).toBe("elpis");
    const refus = await appel("PUT", "/api/settings", cookieAdmin, { skin: "perso:mon-style" });
    expect(refus.statusCode).toBe(403);
    expect((await appel("PUT", "/api/settings", cookieAdmin, { dark_mode: true })).statusCode).toBe(200);
  });

  it("n'accepte que les préférences de la console en écriture", async () => {
    for (const cle of ["welcome_mascot", "welcome_mascot_on", "skin_palette", "editor_ui", "chat_workflow"])
      expect((await appel("PUT", "/api/settings", cookieAdmin, { [cle]: "x" })).statusCode).toBe(403);
  });

  it("donne à tous le nom de l'assistant réglé dans la console ; aucun compte ne l'écrit", async () => {
    for (const cookie of [cookieAdmin, cookieUser]) {
      await appel("PUT", "/api/settings", cookie, { assistant_name: "Zed" });
      expect(nomLu(await appel("GET", "/api/settings", cookie))).toBe("Atlas");
    }
  });

  it("réserve l'aperçu d'un skin désactivé à l'administrateur", async () => {
    expect((await appel("GET", "/api/skins/kiki/skin.css", cookieAdmin)).statusCode).toBe(200);
    expect((await appel("GET", "/api/skins/kiki/skin.css", cookieUser)).statusCode).toBe(404);
  });

  it("garde la gestion des skins à l'administrateur", async () => {
    expect((await appel("GET", "/api/admin/skins", cookieAdmin)).statusCode).toBe(200);
    expect((await appel("GET", "/api/admin/skins", cookieUser)).statusCode).toBe(403);
    expect((await appel("DELETE", "/api/admin/skins/kiki", cookieUser)).statusCode).toBe(403);
  });
});

describe("application (process main)", () => {
  beforeAll(() => preparer("main"));
  afterAll(() => core.fermer());

  it("ne monte aucune route de gestion des skins, même pour un administrateur", async () => {
    for (const [methode, url] of [
      ["GET", "/api/admin/skins"],
      ["PUT", "/api/admin/skins"],
      ["POST", "/api/admin/skins"],
      ["POST", "/api/admin/skins/import"],
      ["GET", "/api/admin/skins/kiki"],
      ["GET", "/api/admin/skins/kiki/export"],
      ["DELETE", "/api/admin/skins/kiki"],
    ] as const)
      expect((await appel(methode, url, cookieAdmin)).statusCode).toBe(404);
  });

  it("ne sert jamais un skin désactivé, même à un administrateur", async () => {
    expect((await appel("GET", "/api/skins/kiki/skin.css", cookieAdmin)).statusCode).toBe(404);
    expect((await appel("GET", "/api/skins/kiki/skin.css", cookieUser)).statusCode).toBe(404);
  });

  it("garde l'habillage personnel à son propriétaire", async () => {
    const liste = (await appel("GET", "/api/skins", cookieAdmin)).json<{ skins: { id: string }[] }>();
    expect(liste.skins.some((s) => s.id === "perso:mon-style")).toBe(true);
    const autre = (await appel("GET", "/api/skins", cookieUser)).json<{ skins: { id: string }[] }>();
    expect(autre.skins.some((s) => s.id.startsWith("perso:"))).toBe(false);
    expect((await appel("GET", "/api/skins/perso/mon-style/skin.css", cookieUser)).statusCode).toBe(404);
    const lu = (await appel("GET", "/api/settings", cookieAdmin)).json<{ skin: string }>();
    expect(lu.skin).toBe("perso:mon-style");
  });

  it("le nom de l'assistant vient de la console : un compte ne l'écrit pas, un ancien choix est ignoré", async () => {
    expect(nomLu(await appel("GET", "/api/settings", cookieUser))).toBe("Atlas");
    expect((await appel("PUT", "/api/settings", cookieUser, { assistant_name: "Zed" })).statusCode).toBe(200);
    expect(nomLu(await appel("GET", "/api/settings", cookieUser))).toBe("Atlas");
    expect(await getUserSettings(core.base, uidUser)).not.toHaveProperty("assistant_name");
    await mergeUserSettings(core.base, uidUser, (s) => {
      s["assistant_name"] = "Ancien";
    });
    expect(nomLu(await appel("GET", "/api/settings", cookieUser))).toBe("Atlas");
  });

  it("sans nom d'application, l'assistant s'appelle Elpis", async () => {
    for (const app_info of [{}, { name: "   " }, { name: 3 }]) {
      ecrireConfig({ app_info });
      expect(nomLu(await appel("GET", "/api/settings", cookieUser))).toBe("Elpis");
    }
  });
});
