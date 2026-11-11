// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/core.test.ts — essai réel core TS → hôte TS : session d'historique ouverte au login, requête relayée acceptée par la porte (jeton et enveloppe signés par main), identifiant git du connecteur rendu par le core pour l'hôte exact et relayé par le relais Git TS. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser, getUserSettings, mergeUserSettings } from "@elpis/auth";
import { reglagesBac, resetImageLoadState, resetUserSandboxCache } from "@elpis/bac";
import { creerFauxDocker } from "@elpis/bac/test";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { composer as composerCore, creerApp, Journal } from "@elpis/core";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierManifeste } from "@elpis/mcp";
import { configurerCoffre } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AgentClient, arreterRelais, runNetwork } from "@elpis/fichiers";

import { remplacerBase } from "../../../core/src/base";
import { createConnector } from "../../../core/src/git/connecteurs";
import { BacTest, PYTHON } from "../../../../packages/fichiers/test/aides";
import { BASIC, demarrerAmont, git, JETON } from "../../../../packages/fichiers/test/amont-git";
import { ClientRappel } from "../../src/rappel";
import { configTest, hoteTest, journalMuet, SVC } from "../aides";
import type { HoteTest } from "../aides";

const CACHE = vi.hoisted(() => {
  const chemin = `${process.env["TMPDIR"] ?? "/tmp"}/elpis-toolhost-categories-${process.pid}.json`;
  process.env["TOOL_CATEGORIES_CACHE_PATH"] = chemin;
  return chemin;
});

const lignesCore: string[] = [];
const journalCore = new Journal({ niveau: "info", sortie: (l) => lignesCore.push(l) });

describe("core TS → hôte TS", () => {
  let dossier: string;
  let h: HoteTest;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let restaurer: () => void;
  let core = "";
  let uid = 0;

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-core-hote-")));
    vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(dossier, "fh"));
    h = await hoteTest(configTest());
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const hote = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    writeFileSync(
      path.join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        toolHosts: { main: { url: hote, token: SVC } },
        mcpServers: {
          "elpis-tools": {
            type: "http",
            url: `${hote}/mcp`,
            headers: { Authorization: `Bearer ${SVC}` },
            "x-elpis": { role: "toolhost", host: "main", families: ["fs"] },
          },
        },
      }),
    );
    writeFileSync(
      path.join(dossier, "config.json"),
      JSON.stringify({
        executors: {
          network_profiles: [
            { id: "isolated", name: "Isolé", mode: "none" },
            { id: "web", name: "Web", mode: "bridge" },
          ],
        },
      }),
    );
    vi.stubEnv("APP_MCP_MANIFEST", path.join(dossier, "mcp.json"));
    vi.stubEnv("ELPIS_AUDIT_DIR", path.join(dossier, "audit"));
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: path.join(dossier, "config.json"),
      SANDBOX_DIR: path.join(dossier, "sb"),
    });
    invalidateConfigCache();
    oublierManifeste();
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: path.join(dossier, "absente.key"),
      repli: path.join(dossier, ".vault.key"),
    });
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    uid = await createUser(t.base, "alice", "mdp-alice-hote-ts", { isAdmin: 0 });
    remplacerBase(t.base);
    const composition = await composerCore("main", t.base, journalCore);
    app = await creerApp({ mode: "main", journal: journalCore, ...composition });
    await app.listen({ port: 0, host: "127.0.0.1" });
    core = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    try {
      resetUserSandboxCache();
      resetImageLoadState();
      reglagesBac.attenteCreationMs = 800;
      app?.server.closeAllConnections();
      await app?.close();
      await h?.fermer();
    } finally {
      vi.unstubAllEnvs();
      remplacerBase(undefined);
      oublierManifeste();
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      rmSync(CACHE, { force: true });
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  }, 30_000);

  it("login : main ouvre la session d'historique du compte sur l'hôte TS ; requête relayée acceptée par la porte", async () => {
    const r = await fetch(`${core}/api/login-lite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "mdp-alice-hote-ts" }),
    });
    expect(r.status).toBe(200);
    await r.arrayBuffer();
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const session = path.join(dossier, "fh", String(uid), "session.json");
    for (let i = 0; i < 100 && !existsSync(session); i++) await new Promise((f) => setTimeout(f, 50));
    expect(existsSync(session), lignesCore.filter((l) => /historique|relay|hôte/u.test(l)).join("\n")).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(session, "utf-8"))).toMatchObject({
      id: expect.stringMatching(/^\d{8}-/u) as unknown,
    });
    const relaye = await fetch(`${core}/api/sandbox/arbre-non-servi`, { headers: { cookie } });
    expect(relaye.status).toBe(404);
    expect(await relaye.text()).toBe("Not Found");
    const anonyme = await fetch(`${core}/api/sandbox/arbre-non-servi`);
    expect(anonyme.status).toBe(401);
  }, 30_000);

  it("rappels de l'hôte vers l'API interne du core TS : identité du compte, jeton de service exigé", async () => {
    const rappel = new ClientRappel({ appUrl: core, jeton: SVC, journal: journalMuet });
    expect(await rappel.identityForUsername("alice")).toEqual({
      user_id: uid,
      username: "alice",
      network_profile_id: "isolated",
      is_admin: false,
    });
    expect(await rappel.identityForUsername("inconnu")).toBeNull();
    expect(await rappel.connectorHosts({ user_id: uid, username: "alice" })).toEqual([]);
    const faux = new ClientRappel({ appUrl: core, jeton: "faux", journal: journalMuet });
    expect(await faux.identityForUsername("alice")).toBeNull();
  }, 30_000);
  it("bac : /api/sandbox/me relayé par main vers l'hôte TS ; choix du profil enregistré par main ; imposition de l'admin appliquée par l'hôte", async () => {
    const docker = creerFauxDocker(path.join(dossier, "docker"));
    vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    vi.stubEnv("FAUX_DOCKER", docker.etat);
    vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
    reglagesBac.attenteCreationMs = 0;
    const r = await fetch(`${core}/api/login-lite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "mdp-alice-hote-ts" }),
    });
    await r.arrayBuffer();
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const me = await fetch(`${core}/api/sandbox/me`, { headers: { cookie } });
    const corps = (await me.json()) as Record<string, unknown>;
    expect([me.status, corps["network_profile_id"], corps["container"]]).toMatchObject([
      200,
      "isolated",
      { running: true, container_name: "elpis-sb-alice" },
    ]);
    const choix = await fetch(`${core}/api/sandbox/me`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ mode: "docker", network_profile_id: "web" }),
    });
    expect([choix.status, ((await choix.json()) as Record<string, unknown>)["network_profile_id"]]).toEqual([
      200,
      "web",
    ]);
    let reglages: Record<string, unknown> = {};
    for (let i = 0; i < 100 && reglages["network_profile_id"] !== "web"; i++) {
      reglages = await getUserSettings(t.base, uid);
      await new Promise((f) => setTimeout(f, 20));
    }
    expect(reglages).toMatchObject({ network_profile_id: "web", sandbox_mode: "docker" });
    const apres = (await (await fetch(`${core}/api/sandbox/me`, { headers: { cookie } })).json()) as Record<
      string,
      unknown
    >;
    expect([apres["network_profile_id"], apres["network_profile_locked"]]).toEqual(["web", false]);
    await mergeUserSettings(t.base, uid, (s) => {
      s["forced_network_profile_id"] = "isolated";
    });
    const refus = await fetch(`${core}/api/sandbox/me`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ network_profile_id: "web" }),
    });
    expect([refus.status, await refus.json()]).toEqual([
      403,
      {
        detail:
          "Votre profil réseau est imposé par l'administrateur ('isolated') et ne peut pas être changé ici.",
      },
    ]);
    const verrouille = (await (
      await fetch(`${core}/api/sandbox/me`, { headers: { cookie } })
    ).json()) as Record<string, unknown>;
    expect([verrouille["network_profile_id"], verrouille["network_profile_locked"]]).toEqual([
      "isolated",
      true,
    ]);
    expect(docker.appels().some((a) => a.startsWith("run -d --init --name elpis-sb-alice"))).toBe(true);
  }, 30_000);

  it.skipIf(!PYTHON)(
    "relais Git : jeton du connecteur rendu par le core TS pour l'hôte EXACT (port compris), envoyé d'emblée ; autre port : aucun jeton",
    async () => {
      const amont = await demarrerAmont(dossier);
      git(amont.racine, "clone", "-q", "--bare", "depot.git", "org/depot.git");
      const url = amont.url.replace("/depot.git", "/org/depot.git");
      const bac = new BacTest(dossier, "alice");
      const agent = new AgentClient(bac);
      const rappel = new ClientRappel({ appUrl: core, jeton: SVC, journal: journalMuet });
      const hote = url.slice("http://".length, url.indexOf("/", "http://".length));
      const libre = async (): Promise<{ motif: null; adresses: null }> => ({ motif: null, adresses: null });
      try {
        const acteur = { userId: uid, username: "alice" };
        await createConnector(
          t.base,
          uid,
          "gitea",
          "127.0.0.1",
          { token: "jeton-du-mauvais-port", username: "x" },
          acteur,
        );
        expect(await rappel.gitCredential({ user_id: uid, username: "alice" }, url)).toBeNull();
        let r = await runNetwork(agent, "", ["clone", "-q", "--", url, "sans"], {
          uid,
          username: "alice",
          url,
          source: rappel,
          garde: libre,
        });
        expect(r.ok).toBe(false);
        expect(amont.vus.every(([, , a]) => a === undefined)).toBe(true);
        await createConnector(t.base, uid, "gitea", hote, { token: JETON, username: "u" }, acteur);
        rappel.viderCache();
        expect(await rappel.connectorHosts({ user_id: uid, username: "alice" })).toEqual(["127.0.0.1", hote]);
        expect(await rappel.gitCredential({ user_id: uid, username: "mallory" }, url)).toBeNull();
        amont.vus.length = 0;
        r = await runNetwork(agent, "", ["clone", "-q", "--", url, "avec"], {
          uid,
          username: "alice",
          url,
          source: rappel,
          garde: libre,
        });
        expect(r.ok, r.stderr).toBe(true);
        expect(amont.vus.length).toBeGreaterThan(0);
        expect(amont.vus.every(([, , a]) => a === BASIC)).toBe(true);
      } finally {
        await amont.fermer();
        await bac.arreter();
        await arreterRelais();
      }
    },
    60_000,
  );

  it("rappels du bureau : notification et ancres au nom du compte de l'enveloppe signée par l'hôte", async () => {
    const rappel = new ClientRappel({ appUrl: core, jeton: SVC, journal: journalMuet });
    const alice = { user_id: uid, username: "alice" };
    expect(
      await rappel.creerNotification(alice, "Automatisation « x » : 1/1 cible(s) réussie(s)", "vm1 : OK — "),
    ).toBe(true);
    expect(
      await t.base.all(
        "SELECT owner_user_id, kind, ref_type FROM notifications WHERE title LIKE 'Automatisation%'",
      ),
    ).toEqual([{ owner_user_id: uid, kind: "automation", ref_type: "automation" }]);
    expect(await rappel.creerNotification({ user_id: uid, username: "mallory" }, "t", "")).toBe(false);
    expect(
      await rappel.noterAncre(alice, "vm1", "enregistrer", {
        auto_id: "saveBtn",
        role: "button",
        center: [8, 5],
      }),
    ).toBe(true);
    expect(await rappel.ancre(alice, "vm1", "enregistrer")).toEqual({
      auto_id: "saveBtn",
      role: "button",
      center: [8, 5],
    });
    expect(await rappel.ancre(alice, "vm2", "enregistrer")).toBeNull();
    const faux = new ClientRappel({ appUrl: core, jeton: "faux", journal: journalMuet });
    expect(await faux.creerNotification(alice, "t", "")).toBe(false);
  }, 30_000);

  it("rappels git de l'hôte : identifiant saisi au clone de l'éditeur écrit dans le coffre par le core, PR demandée au core au nom du compte signé", async () => {
    const rappel = new ClientRappel({ appUrl: core, jeton: SVC, journal: journalMuet });
    const alice = { user_id: uid, username: "alice" };
    expect(
      await rappel.enregistrerIdentifiantGit(
        alice,
        "https://Forge.Example:3000/o/r.git",
        "moi",
        "pat-e2e",
        "",
      ),
    ).toBe(true);
    const ligne = await t.base.get<Record<string, unknown>>(
      "SELECT id, provider_type, host, token_enc, token_scheme, secret_id FROM git_connectors WHERE host=?",
      ["forge.example:3000"],
    );
    expect(ligne).toMatchObject({ provider_type: "gitea", token_enc: "", token_scheme: "vault" });
    expect(await rappel.gitCredential(alice, "https://forge.example:3000/o/r.git")).toEqual({
      username: "moi",
      token: "pat-e2e",
      host: "forge.example:3000",
    });
    expect(await rappel.enregistrerIdentifiantGit(alice, "forge.example:3000", "moi", "pat-neuf", "")).toBe(
      true,
    );
    expect(
      await t.base.get("SELECT COUNT(*) AS n FROM git_connectors WHERE host=?", ["forge.example:3000"]),
    ).toEqual({ n: 1 });
    expect(
      await rappel.enregistrerIdentifiantGit(
        { user_id: uid, username: "mallory" },
        "https://autre.example/o/r.git",
        "moi",
        "pat-e2e",
        "",
      ),
    ).toBe(false);
    expect(await t.base.get("SELECT id FROM git_connectors WHERE host=?", ["autre.example"])).toBeUndefined();
    const demande = {
      remote_url: "https://github.com/o/r.git",
      head: "agent/x-0123abcd",
      base: "main",
      title: "Titre",
      body: "",
      draft: true,
    };
    expect(await rappel.ouvrirPr({ user_id: uid, username: "alice" }, demande)).toEqual({
      outcome: "fallback",
      provider: "github",
      host: "github.com",
      fallback_url: "https://github.com/o/r/compare/main...agent/x-0123abcd?expand=1",
    });
    expect(await rappel.ouvrirPr({ user_id: uid, username: "mallory" }, demande)).toEqual({
      outcome: "rejected",
      status: 403,
    });
    const faux = new ClientRappel({ appUrl: core, jeton: "faux", journal: journalMuet });
    expect(await faux.ouvrirPr({ user_id: uid, username: "alice" }, demande)).toEqual({
      outcome: "rejected",
      status: 401,
    });
  }, 30_000);
});
