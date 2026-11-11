// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/mcp.test.ts — contrats des serveurs MCP du panneau (dossiers, catégories, manifeste, bibliothèque partagée, test) rejoués contre le core TS réel et un faux serveur MCP. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "@elpis/config";
import { oublierManifeste } from "@elpis/mcp";
import { configurerChiffrement } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ingestTools, reinitialiserRegistre } from "../../../../apps/core/src/outils/categories";
import { demarrerFauxServeur } from "../../../../apps/core/test/outils/mcp/faux-serveur";
import type { FauxServeur } from "../../../../apps/core/test/outils/mcp/faux-serveur";
import { CONTRATS_REST, schemaReponseTestMcp } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";
let dossier = "";
let faux: FauxServeur;
const manifesteAvant = process.env["APP_MCP_MANIFEST"];

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-contrats-mcp-"));
  process.env["APP_MCP_MANIFEST"] = join(dossier, "mcp.json");
  oublierManifeste();
  configurerChiffrement({ cleEnv: "cle-de-test-contrats", fichierCle: join(dossier, ".k") });
  faux = await demarrerFauxServeur({ jeton: "jeton-mcp" });
  core = await demarrerCore();
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
  await faux.fermer();
  if (manifesteAvant === undefined) delete process.env["APP_MCP_MANIFEST"];
  else process.env["APP_MCP_MANIFEST"] = manifesteAvant;
  oublierManifeste();
  reinitialiserRegistre();
  rmSync(dossier, { recursive: true, force: true });
});

describe("contrats REST : serveurs MCP (core réel)", () => {
  it("dossiers déposés : liste, suppression réservée à l'administrateur ; plus de dépôt (404)", async () => {
    expect(await core.appeler("GET", "/api/mcp/custom-servers", { cookie: cookieLou })).toMatchObject({
      servers: [],
    });
    const depot = await core.app.inject({ method: "POST", url: "/api/mcp/upload", headers: { cookie } });
    expect(depot.statusCode).toBe(404);
    mkdirSync(join(config.MCP_SERVERS_DIR, "srv"), { recursive: true });
    writeFileSync(join(config.MCP_SERVERS_DIR, "srv", "server.py"), "print(1)");
    expect(await core.appeler("GET", "/api/mcp/custom-servers", { cookie })).toMatchObject({
      servers: [{ name: "srv", suggested_cmd: expect.stringContaining("server.py") }],
    });
    await core.appeler("DELETE", "/api/mcp/custom-servers/srv", { cookie: cookieLou });
    expect(await core.appeler("DELETE", "/api/mcp/custom-servers/srv", { cookie })).toEqual({ ok: true });
    await core.appeler("DELETE", "/api/mcp/custom-servers/srv", { cookie });
    await core.appeler("GET", "/api/mcp/custom-servers");
  });

  it("catégories d'outils et serveurs du manifeste", async () => {
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify({
        mcpServers: { meteo: { type: "http", url: "http://meteo/mcp", description: "Météo" } },
      }),
    );
    oublierManifeste();
    reinitialiserRegistre({ cheminCache: join(dossier, "categories.json") });
    ingestTools(
      [
        {
          name: "read_file",
          description: "Lire un fichier",
          _meta: { category: { name: "fs", label: "Fichiers" } },
          annotations: { title: "Lire", readOnlyHint: true },
        },
      ],
      "test",
    );
    expect(await core.appeler("GET", "/api/mcp/categories", { cookie: cookieLou })).toMatchObject({
      categories: [{ name: "fs", tools: [{ name: "read_file", read_only: true }] }],
    });
    expect(await core.appeler("GET", "/api/mcp/manifest-servers", { cookie: cookieLou })).toMatchObject({
      servers: [{ name: "meteo", type: "http" }],
    });
    await core.appeler("GET", "/api/mcp/categories");
  });

  it("bibliothèque partagée : publication, vue réduite d'un compte, modification, retrait", async () => {
    const corps = {
      name: "Intranet",
      type: "http",
      url: "http://intra.lan:9000/mcp",
      auth_mode: "bearer",
      auth_secret: "jeton-secret",
      headers: [{ name: "X-Equipe", value: "valeur-secrete" }],
    };
    await core.appeler("POST", "/api/mcp/shared-servers", { cookie: cookieLou, corps });
    expect(await core.appeler("POST", "/api/mcp/shared-servers", { cookie, corps })).toMatchObject({
      ok: true,
      server: { id: "shared:1", has_auth: true, headers: [{ name: "X-Equipe", has_value: true }] },
    });
    await core.appeler("POST", "/api/mcp/shared-servers", { cookie, corps: { ...corps, name: "" } });
    await core.appeler("POST", "/api/mcp/shared-servers", { cookie, corps: { ...corps, type: "stdio" } });
    expect(await core.appeler("GET", "/api/mcp/shared-servers", { cookie: cookieLou })).toMatchObject({
      servers: [{ id: "shared:1", name: "Intranet" }],
      can_publish: false,
    });
    expect(await core.appeler("GET", "/api/mcp/shared-servers", { cookie })).toMatchObject({
      servers: [{ url: "http://intra.lan:9000/mcp" }],
      can_publish: true,
    });
    expect(
      await core.appeler("PUT", "/api/mcp/shared-servers/shared:1", {
        cookie,
        corps: { ...corps, name: "Intranet 2", enabled: false },
      }),
    ).toMatchObject({ server: { name: "Intranet 2", enabled: false } });
    await core.appeler("PUT", "/api/mcp/shared-servers/shared:9", { cookie, corps });
    await core.appeler("PUT", "/api/mcp/shared-servers/abc", { cookie, corps });
    expect(await core.appeler("DELETE", "/api/mcp/shared-servers/shared:1", { cookie })).toEqual({
      ok: true,
    });
    await core.appeler("DELETE", "/api/mcp/shared-servers/shared:1", { cookie });
    await core.appeler("GET", "/api/mcp/shared-servers");
  });

  it("bouton « Tester » : outils listés, authentification refusée, configuration incomplète, adresse interne refusée à un compte", async () => {
    const ok = schemaReponseTestMcp.parse(
      await core.appeler("POST", "/api/mcp/test", {
        cookie,
        corps: {
          name: "Perso",
          type: "http",
          url: `${faux.base}/mcp`,
          auth_mode: "bearer",
          auth_secret: "jeton-mcp",
        },
      }),
    );
    expect(ok).toMatchObject({ ok: true, tools: expect.arrayContaining(["echo"]) });
    expect(
      await core.appeler("POST", "/api/mcp/test", {
        cookie,
        corps: { name: "Perso", type: "http", url: `${faux.base}/mcp` },
      }),
    ).toMatchObject({ ok: false });
    expect(await core.appeler("POST", "/api/mcp/test", { cookie, corps: { type: "http" } })).toEqual({
      ok: false,
      error: "Configuration incomplète (type ou URL/commande).",
    });
    await core.appeler("POST", "/api/mcp/test", {
      cookie: cookieLou,
      corps: { name: "P", type: "http", url: `${faux.base}/mcp` },
    });
    await core.appeler("POST", "/api/mcp/test", { cookie, corps: [1] });
  });

  it("toutes les routes du domaine mcp ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "mcp").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
