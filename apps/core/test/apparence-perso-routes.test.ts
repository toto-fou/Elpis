// SPDX-License-Identifier: MIT
/** apps/core/test/apparence-perso-routes.test.ts — routes des habillages personnels contre le core réel : CRUD, isolation entre comptes, plafond, fonction coupée, réglages, suppression de compte. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config, invalidateConfigCache } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST } from "../../../packages/contracts/src";
import { cle, creerCompte, demarrerCore } from "../../../packages/contracts/test/core/aides";
import type { CoreDeTest } from "../../../packages/contracts/test/core/aides";
import { dossierCompte } from "../src/apparence/comptes-perso";
import { deleteUserFull } from "../src/comptes/suppression";

let core: CoreDeTest;
let cookieA = "";
let cookieB = "";
let uidA = 0;

const CLAIR = {
  "--app-bg": "#f1f5f9",
  "--surface": "#ffffff",
  "--text-900": "#0f172a",
  "--text-600": "#475569",
  "--border": "#e2e8f0",
  "--accent": "#2563eb",
  "--rail-bg": "#0f172a",
  "--rail-text": "#cbd5e1",
};
const SOMBRE = {
  "--app-bg": "#1e1e1e",
  "--surface": "#252526",
  "--text-900": "#f8fafc",
  "--text-600": "#cbd5e1",
  "--border": "rgba(255, 255, 255, 0.10)",
  "--accent": "#60a5fa",
  "--rail-bg": "#0b1120",
  "--rail-text": "#cbd5e1",
};
const skin = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  label: `Style ${id}`,
  tokens: { light: CLAIR, dark: SOMBRE },
  ...extra,
});

/** Écrit la section `skins` de config.json puis vide le cache de lecture. */
function reglerSkins(section: Record<string, unknown>): void {
  writeFileSync(config.CONFIG_JSON_PATH, JSON.stringify({ skins: section }));
  invalidateConfigCache();
}

const get = (url: string, cookie: string, entetes: Record<string, string> = {}) =>
  core.app.inject({ method: "GET", url, headers: { cookie, ...entetes } });

beforeAll(async () => {
  core = await demarrerCore("main");
  uidA = await creerCompte(core.base, "ada", "mdp-de-ada-1");
  await creerCompte(core.base, "bob", "mdp-de-bob-1");
  cookieA = await core.connecter("ada", "mdp-de-ada-1");
  cookieB = await core.connecter("bob", "mdp-de-bob-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("habillages personnels : routes", () => {
  it("vérifie sans écrire, puis crée, liste et sert la feuille", async () => {
    const rapport = (await core.appeler("POST", "/api/skins/perso/verifier", {
      cookie: cookieA,
      corps: skin("ardoise-perso"),
    })) as { ok: boolean; css: string };
    expect(rapport.ok).toBe(true);
    expect(rapport.css).toContain("body.elpis-skin-perso {");
    expect(await core.appeler("GET", "/api/skins/perso", { cookie: cookieA })).toMatchObject({ skins: [] });

    const cree = (await core.appeler("POST", "/api/skins/perso", {
      cookie: cookieA,
      corps: skin("ardoise-perso"),
    })) as { skin: { css_url: string }; remplace: boolean };
    expect(cree.remplace).toBe(false);
    expect(cree.skin.css_url).toMatch(/^\/api\/skins\/perso\/ardoise-perso\/skin\.css\?v=[0-9a-f]{12}$/);
    expect(await core.appeler("GET", "/api/skins/perso", { cookie: cookieA })).toMatchObject({
      skins: [{ id: "ardoise-perso", perso: true, builtin: false, sw: ["#0f172a", "#f1f5f9", "#2563eb"] }],
    });
    const liste = (await core.appeler("GET", "/api/skins", { cookie: cookieA })) as {
      skins: { id: string; perso?: boolean; css_url?: string }[];
    };
    expect(liste.skins.find((s) => s.id === "perso:ardoise-perso")).toMatchObject({ perso: true });

    const css = await get(cree.skin.css_url, cookieA);
    expect(css.statusCode).toBe(200);
    expect(css.headers["x-content-type-options"]).toBe("nosniff");
    expect(css.headers["cache-control"]).toContain("private");
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.body).toBe(rapport.css);
    const etag = String(css.headers["etag"]);
    expect((await get(cree.skin.css_url, cookieA, { "if-none-match": etag })).statusCode).toBe(304);
  });

  it("refuse un id déjà pris sans overwrite, le remplace avec", async () => {
    await core.appeler("POST", "/api/skins/perso", { cookie: cookieA, corps: skin("ardoise-perso") });
    const r = (await core.appeler("POST", "/api/skins/perso", {
      cookie: cookieA,
      corps: skin("ardoise-perso", { label: "Renommé", overwrite: true }),
    })) as { remplace: boolean };
    expect(r.remplace).toBe(true);
    expect(await core.appeler("GET", "/api/skins/perso", { cookie: cookieA })).toMatchObject({
      skins: [{ label: "Renommé" }],
    });
  });

  it("renvoie 400 avec le rapport quand il reste des erreurs, et n'écrit rien", async () => {
    const mauvais = skin("trop-clair", {
      tokens: { light: { ...CLAIR, "--text-600": "#cccccc" }, dark: SOMBRE },
    });
    const r = await core.app.inject({
      method: "POST",
      url: "/api/skins/perso",
      headers: { cookie: cookieA },
      payload: mauvais,
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { detail: { ok: boolean; erreurs: string[] } }).detail.erreurs.join()).toContain(
      "Contraste",
    );
    const inj = await core.app.inject({
      method: "POST",
      url: "/api/skins/perso",
      headers: { cookie: cookieA },
      payload: skin("injecte", { tokens: { light: { ...CLAIR, "--accent": "url(x)" }, dark: SOMBRE } }),
    });
    expect(inj.statusCode).toBe(400);
    const ids = (
      (await core.appeler("GET", "/api/skins/perso", { cookie: cookieA })) as { skins: { id: string }[] }
    ).skins.map((s) => s.id);
    expect(ids).toEqual(["ardoise-perso"]);
  });

  it("isole les comptes : B ne voit, ne lit et ne supprime pas l'habillage de A", async () => {
    expect(await core.appeler("GET", "/api/skins/perso", { cookie: cookieB })).toMatchObject({ skins: [] });
    expect((await get("/api/skins/perso/ardoise-perso/skin.css", cookieB)).statusCode).toBe(404);
    expect((await get("/api/skins/perso/..%2Fx/skin.css", cookieB)).statusCode).toBe(404);
    expect(
      (
        await core.app.inject({
          method: "DELETE",
          url: "/api/skins/perso/ardoise-perso",
          headers: { cookie: cookieB },
        })
      ).statusCode,
    ).toBe(404);
    const liste = (await core.appeler("GET", "/api/skins", { cookie: cookieB })) as {
      skins: { id: string }[];
    };
    expect(liste.skins.some((s) => s.id.startsWith("perso:"))).toBe(false);
    const sans = await core.app.inject({ method: "GET", url: "/api/skins/perso" });
    expect(sans.statusCode).toBeGreaterThanOrEqual(401);
  });

  it("réglages : perso:<id> accepté pour le propriétaire, ramené au défaut pour un autre compte", async () => {
    await core.appeler("PUT", "/api/settings", { cookie: cookieA, corps: { skin: "perso:ardoise-perso" } });
    expect(await core.appeler("GET", "/api/settings", { cookie: cookieA })).toMatchObject({
      skin: "perso:ardoise-perso",
    });
    await core.appeler("PUT", "/api/settings", { cookie: cookieB, corps: { skin: "perso:ardoise-perso" } });
    expect(await core.appeler("GET", "/api/settings", { cookie: cookieB })).toMatchObject({ skin: "elpis" });
    await core.appeler("PUT", "/api/settings", { cookie: cookieB, corps: { skin: "perso:inconnu" } });
    expect(await core.appeler("GET", "/api/settings", { cookie: cookieB })).toMatchObject({ skin: "elpis" });
  });

  it("plafond : refuse au-delà de skins.user_max, mais autorise le remplacement", async () => {
    reglerSkins({ user_max: 2 });
    await core.appeler("POST", "/api/skins/perso", { cookie: cookieA, corps: skin("second") });
    const trop = await core.app.inject({
      method: "POST",
      url: "/api/skins/perso",
      headers: { cookie: cookieA },
      payload: skin("troisieme"),
    });
    expect(trop.statusCode).toBe(409);
    expect(
      (
        await core.app.inject({
          method: "POST",
          url: "/api/skins/perso",
          headers: { cookie: cookieA },
          payload: skin("second", { overwrite: true }),
        })
      ).statusCode,
    ).toBe(200);
    expect(await core.appeler("GET", "/api/skins/perso", { cookie: cookieA })).toMatchObject({ max: 2 });
    reglerSkins({});
  });

  it("B crée le même id que A avec overwrite : l'habillage et la feuille de A restent intacts", async () => {
    const avant = await get("/api/skins/perso/ardoise-perso/skin.css", cookieA);
    const listeA = await core.appeler("GET", "/api/skins/perso", { cookie: cookieA });
    const r = (await core.appeler("POST", "/api/skins/perso", {
      cookie: cookieB,
      corps: skin("ardoise-perso", { label: "Pirate", overwrite: true }),
    })) as { remplace: boolean };
    expect(r.remplace).toBe(false);
    expect(await core.appeler("GET", "/api/skins/perso", { cookie: cookieA })).toEqual(listeA);
    const apres = await get("/api/skins/perso/ardoise-perso/skin.css", cookieA);
    expect(apres.body).toBe(avant.body);
    expect(apres.headers["etag"]).toBe(avant.headers["etag"]);
    expect(await core.appeler("GET", "/api/skins/perso", { cookie: cookieB })).toMatchObject({
      skins: [{ id: "ardoise-perso", label: "Pirate" }],
    });
    await core.app.inject({
      method: "DELETE",
      url: "/api/skins/perso/ardoise-perso",
      headers: { cookie: cookieB },
    });
  });

  it("plafond : un dossier illisible ne compte pas et se supprime par son id", async () => {
    reglerSkins({ user_max: 3 });
    const d = join(dossierCompte(uidA), "corrompu");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "skin.json"), "{ pas du json");
    const ok = await core.app.inject({
      method: "POST",
      url: "/api/skins/perso",
      headers: { cookie: cookieA },
      payload: skin("troisieme"),
    });
    expect(ok.statusCode).toBe(200);
    const del = (id: string) =>
      core.app.inject({ method: "DELETE", url: `/api/skins/perso/${id}`, headers: { cookie: cookieA } });
    expect((await del("corrompu")).statusCode).toBe(200);
    expect(existsSync(d)).toBe(false);
    await del("troisieme");
    reglerSkins({});
  });

  it("fonction coupée : routes en 403, absente de la liste, réglage ramené au défaut", async () => {
    reglerSkins({ user_custom: false });
    for (const [m, u] of [
      ["GET", "/api/skins/perso"],
      ["POST", "/api/skins/perso"],
      ["POST", "/api/skins/perso/verifier"],
      ["DELETE", "/api/skins/perso/second"],
      ["GET", "/api/skins/perso/second/skin.css"],
    ] as const)
      expect(
        (
          await core.app.inject({
            method: m,
            url: u,
            headers: { cookie: cookieA },
            payload: m === "POST" ? skin("x") : undefined,
          })
        ).statusCode,
        `${m} ${u}`,
      ).toBe(403);
    const liste = (await core.appeler("GET", "/api/skins", { cookie: cookieA })) as {
      skins: { id: string }[];
    };
    expect(liste.skins.some((s) => s.id.startsWith("perso:"))).toBe(false);
    expect(await core.appeler("GET", "/api/settings", { cookie: cookieA })).toMatchObject({ skin: "elpis" });
    reglerSkins({});
    expect(await core.appeler("GET", "/api/settings", { cookie: cookieA })).toMatchObject({
      skin: "perso:ardoise-perso",
    });
  });

  it("supprime un habillage ; le réglage qui le visait retombe sur le défaut", async () => {
    expect(await core.appeler("DELETE", "/api/skins/perso/ardoise-perso", { cookie: cookieA })).toEqual({
      ok: true,
    });
    expect(
      (
        await core.app.inject({
          method: "DELETE",
          url: "/api/skins/perso/ardoise-perso",
          headers: { cookie: cookieA },
        })
      ).statusCode,
    ).toBe(404);
    expect(await core.appeler("GET", "/api/settings", { cookie: cookieA })).toMatchObject({ skin: "elpis" });
  });

  it("la suppression du compte retire son dossier d'habillages", async () => {
    const dossier = join(config.SKINS_DIR, "_comptes", String(uidA));
    expect(existsSync(dossier)).toBe(true);
    expect(await deleteUserFull(core.base, uidA)).toBe(true);
    expect(existsSync(dossier)).toBe(false);
  });

  it("toutes les routes perso du registre ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.chemin.startsWith("/api/skins/perso")).map(cle);
    expect(attendues).toHaveLength(4);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
