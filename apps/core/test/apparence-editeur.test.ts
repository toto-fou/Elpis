// SPDX-License-Identifier: MIT
/** apps/core/test/apparence-editeur.test.ts — feuille d'éditeur d'un skin : annoncée si le dossier l'a, validée à l'import, servie réécrite, exportée ; sans elle, l'éditeur reste classique. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser } from "@elpis/auth";
import { ArchiveZip, ecrireZip, HttpError } from "@elpis/commun";
import type { EntreeZipEcrite } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { exportZip, importZip, saveFromEditor, setState } from "../src/apparence/ecritures";
import { listSkins, renderEditeur, skinDetail, viderCachesSkins } from "../src/apparence/skins";
import { creerFamilleApparence } from "../src/familles/apparence";
import { appTest } from "./aides";

const JSON_SKIN = JSON.stringify({ id: "brume", label: "Brume", swatch: ["#111111", "#eeeeee", "#0088ff"] });
const FEUILLE = ".elpis-skin-self .ed2--encre { --ed-code-bg: #102030; --ed-plan: #102030; }";

function paquet(fichiers: Record<string, string>): Buffer {
  const entrees: EntreeZipEcrite[] = Object.entries(fichiers).map(([nom, texte]) => ({
    nom: `brume/${nom}`,
    donnees: Buffer.from(texte, "utf-8"),
    dateHeure: [2026, 1, 1, 0, 0, 0],
    attributsExternes: (0o600 << 16) >>> 0,
  }));
  return ecrireZip(entrees);
}

const entree = (id: string): Record<string, unknown> | undefined =>
  listSkins(true).find((s) => s["id"] === id);

describe("feuille d'éditeur d'un skin", () => {
  let dossier: string;
  let restaurer: () => void;

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-skins-editeur-"));
    const config = join(dossier, "config.json");
    writeFileSync(config, "{}");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: config, SKINS_DIR: join(dossier, "user_skins") });
    viderCachesSkins();
  });

  afterEach(() => {
    restaurer();
    viderCachesSkins();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("skins intégrés : annoncée en statique, Ardoise comprise", () => {
    expect(entree("elpis")?.["editor_css_url"]).toBe("/static/css/skins/elpis/editeur.css");
    expect(entree("")?.["editor_css_url"]).toBe("/static/css/skins/ardoise/editeur.css");
    expect(entree("kiki")?.["editor_css_url"]).toBe("/static/css/skins/kiki/editeur.css");
  });

  it("paquet sans editeur.css : rien d'annoncé, rien à servir", async () => {
    await importZip(paquet({ "skin.json": JSON_SKIN }));
    expect(entree("brume")?.["editor_css_url"]).toBeUndefined();
    expect(renderEditeur("brume")).toBeNull();
    expect(skinDetail("brume")["editeur_css"]).toBeUndefined();
  });

  it("paquet avec editeur.css : annoncée, révisée, servie avec .elpis-skin-self réécrit", async () => {
    await importZip(paquet({ "skin.json": JSON_SKIN, "editeur.css": FEUILLE }));
    expect(String(entree("brume")?.["editor_css_url"])).toMatch(
      /^\/api\/skins\/brume\/editeur\.css\?v=[0-9a-f]{10}$/,
    );
    expect(renderEditeur("brume")).toBe(
      ".elpis-skin-brume .ed2--encre { --ed-code-bg: #102030; --ed-plan: #102030; }",
    );
    expect(skinDetail("brume")["editeur_css"]).toBe(FEUILLE);
  });

  it("paquet refusé si editeur.css charge une ressource externe ou un @import, le fichier est nommé", async () => {
    await expect(
      importZip(
        paquet({ "skin.json": JSON_SKIN, "editeur.css": ".a { background: url(https://x.test/a.png); }" }),
      ),
    ).rejects.toThrow(/^editeur\.css : url\(\) refusée/);
    await expect(
      importZip(paquet({ "skin.json": JSON_SKIN, "editeur.css": '@import "https://x.test/a.css";' })),
    ).rejects.toThrow(/^editeur\.css : @import interdit/);
    expect(entree("brume")).toBeUndefined();
  });

  it("fichier invalide posé à la main : ignoré, l'éditeur reste classique", async () => {
    await importZip(paquet({ "skin.json": JSON_SKIN }));
    writeFileSync(join(dossier, "user_skins", "brume", "editeur.css"), "@import 'https://x.test/a.css';");
    viderCachesSkins();
    expect(entree("brume")?.["editor_css_url"]).toBeUndefined();
    expect(renderEditeur("brume")).toBeNull();
  });

  it("export d'un skin importé : la feuille part avec le paquet, et se réimporte", async () => {
    await importZip(paquet({ "skin.json": JSON_SKIN, "editeur.css": FEUILLE }));
    const [, octets] = exportZip("brume");
    const zf = new ArchiveZip(octets);
    const membre = zf.membres.find((m) => m.nom === "brume/editeur.css");
    expect(membre && zf.lire(membre).toString("utf-8")).toBe(FEUILLE);
    await importZip(octets, true);
    expect(renderEditeur("brume")).toContain(".elpis-skin-brume");
  });

  it("modèle exporté d'un skin intégré : sélecteurs visant le skin lui-même, Ardoise comprise", async () => {
    for (const [id, nom] of [
      ["elpis", "elpis-perso"],
      ["alize", "alize-perso"],
      ["", "ardoise-perso"],
    ] as const) {
      const zf = new ArchiveZip(exportZip(id)[1]);
      const membre = zf.membres.find((m) => m.nom === `${nom}/editeur.css`);
      const css = membre ? zf.lire(membre).toString("utf-8") : "";
      expect(css).toContain("body.elpis-skin-self .ed2--encre");
      expect(css).not.toContain(id ? `.elpis-skin-${id}` : ":not(");
      await importZip(exportZip(id)[1]);
      expect(renderEditeur(nom)).toContain(`body.elpis-skin-${nom} .ed2--encre`);
    }
  });

  it("console : création, mise à jour, corps sans le champ, retrait", async () => {
    const base = { id: "brume", label: "Brume", swatch: ["#111111", "#eeeeee", "#0088ff"], tokens: {} };
    await saveFromEditor({ ...base, editeur_css: FEUILLE });
    expect(renderEditeur("brume")).toContain(".elpis-skin-brume");
    await expect(saveFromEditor({ ...base, update: true, editeur_css: "@import 'x';" })).rejects.toThrow(
      /^editeur\.css : /,
    );
    expect(renderEditeur("brume")).toContain(".elpis-skin-brume");
    await saveFromEditor({ ...base, update: true });
    expect(readFileSync(join(dossier, "user_skins", "brume", "editeur.css"), "utf-8")).toBe(FEUILLE);
    await saveFromEditor({ ...base, update: true, editeur_css: "  " });
    expect(renderEditeur("brume")).toBeNull();
    expect(entree("brume")?.["editor_css_url"]).toBeUndefined();
    await expect(saveFromEditor({ ...base, update: true, editeur_css: 3 })).rejects.toThrow("texte attendu");
  });
});

describe("route de la feuille d'éditeur", () => {
  const gardes = {
    session: (req: { headers: Record<string, unknown>; utilisateur?: unknown }) => {
      const uid = req.headers["x-uid"];
      if (!uid) throw new HttpError(401, "not logged in");
      req.utilisateur = { id: Number(uid), username: null };
    },
  };
  let dossier: string;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let restaurer: () => void;
  const lire = (url: string, uid: string | null) =>
    app.inject({ method: "GET", url, headers: uid ? { "x-uid": uid } : {} });

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-skins-route-"));
    const config = join(dossier, "config.json");
    writeFileSync(config, "{}");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: config, SKINS_DIR: join(dossier, "user_skins") });
    viderCachesSkins();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "admin", "mdp-admin", { isAdmin: 1 });
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
    app = await appTest({ familles: [creerFamilleApparence({ base: t.base, mode: "admin" })], gardes });
    await importZip(paquet({ "skin.json": JSON_SKIN, "editeur.css": FEUILLE }));
  });

  afterAll(async () => {
    restaurer();
    viderCachesSkins();
    await app.close();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("anonyme : 401, identifiant invalide : 404", async () => {
    expect((await lire("/api/skins/brume/editeur.css", null)).statusCode).toBe(401);
    expect((await lire("/api/skins/Brume/editeur.css", "2")).statusCode).toBe(404);
    expect((await lire("/api/skins/..%2Fx/editeur.css", "2")).statusCode).toBe(404);
  });

  it("skin désactivé : réservé à l'administrateur", async () => {
    expect((await lire("/api/skins/brume/editeur.css", "2")).statusCode).toBe(404);
    expect((await lire("/api/skins/brume/editeur.css", "1")).statusCode).toBe(200);
  });

  it("skin activé : feuille réécrite, en CSS, avec son ETag et 304", async () => {
    await setState({ brume: true });
    const r = await lire("/api/skins/brume/editeur.css", "2");
    expect(r.statusCode).toBe(200);
    expect(String(r.headers["content-type"])).toMatch(/^text\/css/);
    expect(r.body).toContain(".elpis-skin-brume .ed2--encre");
    const encore = await app.inject({
      method: "GET",
      url: "/api/skins/brume/editeur.css",
      headers: { "x-uid": "2", "if-none-match": String(r.headers["etag"]) },
    });
    expect(encore.statusCode).toBe(304);
  });

  it("skin intégré ou inconnu : pas de feuille par cette route", async () => {
    expect((await lire("/api/skins/elpis/editeur.css", "2")).statusCode).toBe(404);
    expect((await lire("/api/skins/absent/editeur.css", "2")).statusCode).toBe(404);
  });
});
