// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-executeurs.test.ts — contrats de la console pour les exécuteurs, les conteneurs et les hôtes d'outils rejoués contre le core TS réel en process admin (sans Docker : les chemins qui l'exigent sont vérifiés sur des exemples). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTRATS_REST,
  schemaReponseConteneurs,
  schemaReponseEtatExecuteurs,
  schemaReponseExecuteurs,
  schemaReponseHotesOutils,
  schemaReponseSanteDocker,
} from "../../src";
import { oublierHotes } from "../../../../apps/core/src/relais/hotes";
import { journalMuet } from "../../../../apps/core/test/aides";
import { creerAppToolhost } from "../../../../apps/toolhost/src/app";
import { routesConsole } from "../../../../apps/toolhost/src/bac/console";
import { configParDefaut } from "../../../../apps/toolhost/src/config";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";
let hoteOutils: FastifyInstance;
let dossierHote = "";
let manifesteHote = "";
const dockerHostAvant = process.env["DOCKER_HOST"];
const manifesteAvant = process.env["APP_MCP_MANIFEST"];

beforeAll(async () => {
  process.env["DOCKER_HOST"] = "unix:///nonexistent/elpis-test-docker.sock";
  hoteOutils = await creerAppToolhost({
    tc: { ...configParDefaut(), token: "jeton-de-service-de-test" },
    familles: [{ nom: "bac", routes: routesConsole() }],
    journal: journalMuet,
  });
  await hoteOutils.listen({ host: "127.0.0.1", port: 0 });
  dossierHote = mkdtempSync(join(tmpdir(), "elpis-contrats-hote-"));
  const port = (hoteOutils.server.address() as { port: number }).port;
  writeFileSync(
    join(dossierHote, "mcp.json"),
    JSON.stringify({
      toolHosts: { main: { url: `http://127.0.0.1:${port}`, token: "jeton-de-service-de-test" } },
    }),
  );
  manifesteHote = join(dossierHote, "mcp.json");
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
  await hoteOutils.close();
  rmSync(dossierHote, { recursive: true, force: true });
  if (manifesteAvant === undefined) delete process.env["APP_MCP_MANIFEST"];
  else process.env["APP_MCP_MANIFEST"] = manifesteAvant;
  oublierHotes();
  if (dockerHostAvant === undefined) delete process.env["DOCKER_HOST"];
  else process.env["DOCKER_HOST"] = dockerHostAvant;
});

describe("contrats REST : exécuteurs de la console (core réel)", () => {
  it("configuration : lecture, enregistrement assaini, corps invalide, refus", async () => {
    expect(await core.appeler("GET", "/api/admin/executors", { cookie })).toMatchObject({
      config: { force_user_docker: false },
    });
    expect(
      await core.appeler("POST", "/api/admin/executors", {
        cookie,
        corps: { executors: { force_user_docker: true, idle_kill_hours: 6 } },
      }),
    ).toMatchObject({ ok: true, config: { force_user_docker: true } });
    await core.appeler("POST", "/api/admin/executors", { cookie, corps: {} });
    await core.appeler("GET", "/api/admin/executors", { cookie: cookieLou });
  });

  it("profils : protections et règle Git lues par le contrat, absentes ou présentes", () => {
    const profil = {
      id: "p",
      name: "P",
      mode: "bridge",
      ips: [],
      description: "",
      domains: [],
      ports: [],
      dns: [],
    };
    const reponse = (profils: unknown[]): unknown => ({
      config: {
        limits: {},
        force_user_docker: false,
        idle_kill_hours: 24,
        network_profiles: profils,
        exec_user: "10001:10001",
        runtime: "",
        extra_run_args: [],
      },
      image: "elpis/sandbox:1.0.0",
    });
    const avec = {
      ...profil,
      block_metadata: true,
      block_lan: false,
      block_host: true,
      git_access: "servers",
      git_servers: ["git.lan"],
    };
    expect(schemaReponseExecuteurs.parse(reponse([profil, avec])).config.network_profiles).toEqual([
      profil,
      avec,
    ]);
    expect(schemaReponseExecuteurs.safeParse(reponse([{ ...profil, git_servers: "git.lan" }])).success).toBe(
      false,
    );
    expect(schemaReponseExecuteurs.safeParse(reponse([{ ...profil, block_lan: "oui" }])).success).toBe(false);
  });

  it("Docker absent : santé en échec, conteneurs en 502 ; arrêt, destruction et nettoyage répondent ok", async () => {
    process.env["APP_MCP_MANIFEST"] = manifesteHote;
    oublierHotes();
    try {
      await dockerAbsent();
    } finally {
      if (manifesteAvant === undefined) delete process.env["APP_MCP_MANIFEST"];
      else process.env["APP_MCP_MANIFEST"] = manifesteAvant;
      oublierHotes();
    }
  });

  /** Scénario « Docker absent » joué contre l'hôte d'outils en process déclaré dans le manifeste. */
  async function dockerAbsent(): Promise<void> {
    expect(
      schemaReponseSanteDocker.parse(
        await core.appeler("GET", "/api/admin/executors/healthcheck", { cookie }),
      ),
    ).toMatchObject({
      daemon_ok: false,
    });
    expect(
      schemaReponseEtatExecuteurs.parse(await core.appeler("GET", "/api/admin/executors/status", { cookie })),
    ).toMatchObject({ ok: true, domains_status: {}, stale_containers: [] });
    await core.appeler("GET", "/api/admin/executors/status", { cookie: cookieLou });
    const etat = {
      ok: true,
      domains_status: { web: { "pypi.org": ["192.0.2.7"], "absent.test": [], "lent.test": null } },
      stale_containers: [{ user_id: 1, username: "zoe", container: "elpis-sb-zoe", profile_id: "web" }],
      accounts: [{ user_id: 1, username: "zoe", profile_id: "web", origin: "chosen" as const }],
      machine: { addresses: ["192.0.2.7"], broadcasts: ["192.0.2.255"] },
      remote_toolhosts: false,
    };
    expect(schemaReponseEtatExecuteurs.parse(etat)).toEqual(etat);
    await core.appeler("GET", "/api/admin/sandbox/containers", { cookie });
    await core.appeler("POST", "/api/admin/sandbox/containers/99/stop", { cookie });
    expect(await core.appeler("POST", "/api/admin/sandbox/containers/1/stop", { cookie })).toEqual({
      ok: true,
    });
    expect(await core.appeler("DELETE", "/api/admin/sandbox/containers/1", { cookie })).toEqual({ ok: true });
    expect(await core.appeler("POST", "/api/admin/sandbox/gc", { cookie })).toEqual({
      ok: true,
      stopped: [],
    });
    await core.appeler("POST", "/api/admin/sandbox/gc", { cookie: cookieLou });
    const sain = {
      daemon_ok: true,
      server_version: "27.0.0",
      image: "elpis/sandbox:1.7.0",
      image_loaded: false,
      archive_available: false,
      archive_path: null,
      image_load_state: { status: "not_checked", image: null, archive_path: null, progress_msg: "" },
    };
    expect(schemaReponseSanteDocker.parse(sain)).toEqual(sain);
    const liste = {
      containers: [
        {
          id: "abc",
          name: "elpis-sandbox-zoe",
          image: "elpis/sandbox:1.7.0",
          state: "running",
          status: "Up 2 hours",
          created: "2026-10-12 10:00:00 +0000 UTC",
          user_id: 1,
          username: "zoe",
        },
      ],
      count: 1,
    };
    expect(schemaReponseConteneurs.parse(liste)).toEqual(liste);
  }

  it("état : chaque compte et le profil de sa sandbox, relevé de la machine ; refusé à un compte ordinaire", async () => {
    const etat = schemaReponseEtatExecuteurs.parse(
      await core.appeler("GET", "/api/admin/executors/status", { cookie }),
    );
    expect(etat.accounts.filter((c) => ["lou", "zoe"].includes(c.username))).toEqual([
      { user_id: 2, username: "lou", profile_id: "isolated", origin: "default" },
      { user_id: 1, username: "zoe", profile_id: "isolated", origin: "default" },
    ]);
    expect(etat.machine === null || etat.machine.addresses.every((a) => !a.startsWith("127."))).toBe(true);
    expect(etat.remote_toolhosts).toBe(false);
    await core.appeler("GET", "/api/admin/executors/status", { cookie: cookieLou });
    const refus = await core.app.inject({
      method: "GET",
      url: "/api/admin/executors/status",
      headers: { cookie: cookieLou },
    });
    expect(refus.statusCode).toBe(403);
  });

  it("hôtes d'outils : liste, placement inconnu refusé, placements existants", async () => {
    expect(await core.appeler("GET", "/api/admin/toolhosts", { cookie })).toEqual({
      ok: true,
      hosts: [],
      placement: {},
      placements: [],
    });
    await core.appeler("POST", "/api/admin/toolhosts/placements/1", { cookie, corps: { host_id: "x" } });
    await core.appeler("POST", "/api/admin/toolhosts/placements/1/migrate", {
      cookie,
      corps: { host_id: "x" },
    });
    await core.base.run(
      "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES (1, 'h1', 1700000000, 1700000000)",
    );
    const vue = schemaReponseHotesOutils.parse(await core.appeler("GET", "/api/admin/toolhosts", { cookie }));
    expect(vue.placements).toMatchObject([{ user_id: 1, host_id: "h1", username: "zoe" }]);
    expect(await core.appeler("DELETE", "/api/admin/toolhosts/placements/1", { cookie })).toEqual({
      ok: true,
    });
    await core.appeler("GET", "/api/admin/toolhosts", { cookie: cookieLou });
  });

  it("toutes les routes du domaine admin-executeurs ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-executeurs").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
