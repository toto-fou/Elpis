// SPDX-License-Identifier: MIT
/** apps/core/test/git/regle-git.test.ts — règle Git du profil réseau côté core (SQLite, PostgreSQL si ELPIS_TEST_PG) : portées des comptes Git, règle d'un compte, hôtes de ses comptes (route interne), PR et import du bac bornés par la règle, comptes Git et dépôts listés bornés aux serveurs choisis. */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, creerGardes, dependancesParDefaut, installerAuth } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  configurerCoffre,
  configureAudit,
  creerIdentite,
  IDENTITY_HEADER,
  oublierConfigurationAudit,
  sign,
} from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleGit } from "../../src/familles/git";
import { creerFamilleInterneToolhost } from "../../src/familles/interne-toolhost";
import { createConnector, listConnectorScopes } from "../../src/git/connecteurs";
import { brancherAdressesInterdites } from "../../src/git/garde";
import { regleGitDuCompte, serveurPermis, serveursDuProfil } from "../../src/git/regle";
import { appTest, journalMuet } from "../aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const SVC = "svc-regle-git";
const acteur = { userId: null, username: null };

describe.each(MOTEURS)("règle Git du profil réseau (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let srv: Server;
  let hote = "";
  let dossier = "";
  let restaurer: () => void = () => undefined;
  let bob = 0;
  let alice = 0;
  let carol = 0;

  const profils = (liste: Record<string, unknown>[]): void => {
    writeFileSync(join(dossier, "config.json"), JSON.stringify({ executors: { network_profiles: liste } }));
    invalidateConfigCache();
  };
  const choisir = async (uid: number, profil: string): Promise<void> => {
    await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
      JSON.stringify({ network_profile_id: profil }),
      uid,
    ]);
  };
  const regleDe = (id: string, git_access: string, git_servers: string[] = []): Record<string, unknown> => ({
    id,
    name: id,
    mode: "bridge",
    git_access,
    git_servers,
  });

  const appel = (uid: number, methode: "GET" | "POST" | "PUT" | "DELETE", url: string, corps?: unknown) =>
    app.inject({
      method: methode,
      url,
      headers: {
        "x-uid": String(uid),
        ...(corps === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
    });
  const interne = (methode: "GET" | "POST", url: string, uid: number, nom: string, corps?: unknown) =>
    app.inject({
      method: methode,
      url,
      headers: {
        authorization: `Bearer ${SVC}`,
        [IDENTITY_HEADER]: sign(creerIdentite({ user_id: uid, username: nom }), SVC),
        ...(corps === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
    });
  const creer = (
    uid: number,
    type: string,
    host: string,
    champs: { token?: string; path?: string; source?: "sandbox-file" } = {},
  ) => createConnector(t.base, uid, type, host, { token: "tok", ...champs }, acteur);

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-regle-git-"));
    mkdirSync(join(dossier, "journal"));
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    configureAudit({ service: "main", auditDir: join(dossier, "journal"), hmacKeyPath: "/nonexistent" });
    restaurer = surchargerConfig({
      LOCAL_MCP_TOKEN: SVC,
      DB_PATH: join(dossier, "user_db", "app.db"),
      CONFIG_JSON_PATH: join(dossier, "config.json"),
      SANDBOX_DIR: join(dossier, "sandboxes"),
      MEMORY_DIR: join(dossier, "sandboxes"),
      USER_SKILLS_DIR: join(dossier, "user_skills"),
      SKINS_DIR: join(dossier, "skins"),
    });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    bob = await createUser(t.base, "bob", "mdp-bob");
    alice = await createUser(t.base, "alice", "mdp-alice");
    carol = await createUser(t.base, "carol", "mdp-carol");
    brancherAdressesInterdites(() => false);
    srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const depot = (nom: string): Record<string, unknown> => ({
        full_name: nom,
        clone_url: `http://${hote}/${nom}.git`,
      });
      res.end(
        JSON.stringify(
          req.url?.includes("/user/repos")
            ? [depot("Acme/API"), depot("acme/web"), depot("autre/y")]
            : { login: "bob" },
        ),
      );
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    hote = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const auth = { ...dependancesParDefaut(t.base, () => SVC) };
    app = await appTest({
      familles: [
        creerFamilleGit({ base: t.base, auditer: () => undefined }),
        creerFamilleInterneToolhost({ auth, journal: journalMuet }),
      ],
      gardes: {
        ...creerGardes(auth),
        session: (req) => {
          if (req.headers["x-uid"] === undefined) throw new HttpError(401, "not logged in");
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: null };
        },
      },
      extensions: [(a) => installerAuth(a, auth)],
    });
  });

  afterAll(async () => {
    brancherAdressesInterdites(null);
    restaurer();
    oublierConfigurationAudit();
    await app.close();
    await new Promise((ok) => srv.close(ok));
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("portées des comptes Git : hôte, chemin, casse exacte pour un service générique ; jeton à vérifier exclu", async () => {
    await creer(bob, "gitea", "forge.lan");
    await creer(bob, "gitea", "forge.lan", { path: "Team" });
    await creer(bob, "generic", "gen.lan", { path: "Acme/Api" });
    await creer(bob, "generic", "gen2.lan");
    await creer(bob, "gitea", "importe.lan", { source: "sandbox-file" });
    await creer(alice, "gitea", "autre-compte.lan");
    const tri = (l: { host: string; path: string; exact: boolean }[]): unknown[] =>
      [...l].sort((a, b) => `${a.host}/${a.path}`.localeCompare(`${b.host}/${b.path}`));
    expect(tri(await listConnectorScopes(t.base, bob))).toEqual([
      { host: "forge.lan", path: "", exact: false },
      { host: "forge.lan", path: "team", exact: false },
      { host: "gen.lan", path: "Acme/Api", exact: true },
      { host: "gen2.lan", path: "", exact: true },
    ]);
    expect(await listConnectorScopes(t.base, alice)).toEqual([
      { host: "autre-compte.lan", path: "", exact: false },
    ]);
    expect(await listConnectorScopes(t.base, carol)).toEqual([]);
  });

  it("chemin du compte absent : celui de son secret, ou tout l'hôte ; deux comptes de même portée comptent pour un", async () => {
    const a = await creer(carol, "gitea", "nul.lan", { path: "equipe" });
    const b = await creer(carol, "gitea", "nul2.lan", { path: "x" });
    const c = await creer(carol, "gitea", "nul2.lan", { path: "y" });
    await t.base.run("UPDATE git_connectors SET path = NULL WHERE id IN (?, ?, ?)", [a, b, c]);
    await t.base.run(
      "UPDATE vault_secrets SET scope_json = ? WHERE id = (SELECT secret_id FROM git_connectors WHERE id = ?)",
      [JSON.stringify({ host: "nul2.lan" }), b],
    );
    await t.base.run(
      "UPDATE vault_secrets SET scope_json = ? WHERE id = (SELECT secret_id FROM git_connectors WHERE id = ?)",
      [JSON.stringify({ host: "nul2.lan" }), c],
    );
    const r = await listConnectorScopes(t.base, carol);
    expect(r.filter((p) => p.host === "nul.lan")).toEqual([
      { host: "nul.lan", path: "equipe", exact: false },
    ]);
    expect(r.filter((p) => p.host === "nul2.lan")).toEqual([{ host: "nul2.lan", path: "", exact: false }]);
  });

  it("compte sans jeton : sa portée compte, avec le chemin du compte ou tout l'hôte", async () => {
    const d = await createUser(t.base, "dave", "mdp-dave");
    await createConnector(t.base, d, "gitea", "sansjeton.lan", { token: "", path: "org" }, acteur);
    await createConnector(t.base, d, "gitea", "sansjeton2.lan", { token: "" }, acteur);
    expect((await listConnectorScopes(t.base, d)).sort((x, y) => x.host.localeCompare(y.host))).toEqual([
      { host: "sansjeton.lan", path: "org", exact: false },
      { host: "sansjeton2.lan", path: "", exact: false },
    ]);
  });

  it("règle du compte : lue du profil choisi ; profil inconnu ou absent : repli « isolated », tous les dépôts", async () => {
    profils([
      { id: "isolated", name: "I", mode: "none" },
      regleDe("serveurs", "servers", ["forge.lan", "github.com/Acme"]),
      regleDe("comptes", "accounts"),
      regleDe("libre", "all"),
    ]);
    await choisir(alice, "serveurs");
    expect(await regleGitDuCompte(t.base, alice)).toEqual({
      acces: "servers",
      portees: [
        { host: "forge.lan", path: "" },
        { host: "github.com", path: "Acme", exact: true },
      ],
    });
    expect(await serveursDuProfil(t.base, alice)).toEqual([
      { host: "forge.lan", path: "" },
      { host: "github.com", path: "Acme" },
    ]);
    await choisir(alice, "comptes");
    expect(await regleGitDuCompte(t.base, alice)).toEqual({
      acces: "accounts",
      portees: [{ host: "autre-compte.lan", path: "", exact: false }],
    });
    expect(await serveursDuProfil(t.base, alice)).toBeNull();
    for (const profil of ["libre", "inexistant"]) {
      await choisir(alice, profil);
      expect(await regleGitDuCompte(t.base, alice), profil).toEqual({ acces: "all" });
      expect(await serveursDuProfil(t.base, alice), profil).toBeNull();
    }
  });

  it("serveur permis : toujours sans règle de serveurs ; sinon seulement les hôtes listés, sans la casse", async () => {
    profils([
      { id: "isolated", name: "I", mode: "none" },
      regleDe("serveurs", "servers", ["forge.lan", "github.com/acme"]),
      regleDe("comptes", "accounts"),
    ]);
    await choisir(bob, "serveurs");
    for (const [h, attendu] of [
      ["forge.lan", true],
      ["FORGE.lan", true],
      ["github.com", true],
      ["autre.lan", false],
      ["sous.forge.lan", false],
      ["forge.lan:3000", false],
      ["forge.lan:443", true],
      ["forge.lan:80", true],
    ] as const)
      expect(await serveurPermis(t.base, bob, h), h).toBe(attendu);
    await choisir(bob, "comptes");
    expect(await serveurPermis(t.base, bob, "n'importe.quoi")).toBe(true);
    await choisir(bob, "inexistant");
    expect(await serveurPermis(t.base, bob, "n'importe.quoi")).toBe(true);
  });

  it("route interne des hôtes : hôtes et portées des comptes du compte signé", async () => {
    const r = await interne("GET", "/api/internal/git/connector-hosts", bob, "bob");
    expect(r.statusCode).toBe(200);
    const d = r.json() as { ok: boolean; hosts: string[]; scopes: Record<string, unknown>[] };
    expect(d.ok).toBe(true);
    expect(d.hosts).toEqual(expect.arrayContaining(["forge.lan", "gen.lan"]));
    expect(d.scopes).toEqual(
      expect.arrayContaining([
        { host: "gen.lan", path: "Acme/Api", exact: true },
        { host: "forge.lan", path: "team", exact: false },
      ]),
    );
    expect(d.scopes.some((s) => s["host"] === "importe.lan")).toBe(false);
    const sans = await app.inject({
      method: "GET",
      url: "/api/internal/git/connector-hosts",
      headers: { authorization: `Bearer ${SVC}` },
    });
    expect(sans.statusCode).toBe(401);
  });

  describe("pull requests", () => {
    const demande = (url: string) => ({
      remote_url: url,
      head: "agent/x",
      base: "main",
      title: "T",
      body: "",
      draft: true,
    });
    const pr = async (
      uid: number,
      nom: string,
      url: string,
    ): Promise<{ outcome?: string; message?: string; hint?: string }> =>
      (
        (await interne("POST", "/api/internal/git/pr", uid, nom, demande(url))).json() as {
          result: Record<string, string>;
        }
      ).result;

    it("hors de la règle du profil : refus sans toucher au compte Git", async () => {
      profils([
        { id: "isolated", name: "I", mode: "none" },
        regleDe("serveurs", "servers", ["permis.lan/acme"]),
        regleDe("comptes", "accounts"),
      ]);
      await choisir(bob, "serveurs");
      for (const url of [
        "https://autre.lan/acme/r.git",
        "https://permis.lan/autre/r.git",
        "https://permis.lan/acme2/r.git",
        "https://permis.lan/acme/..%2fx",
      ]) {
        const r = await pr(bob, "bob", url);
        expect([r.outcome, r.message], url).toEqual(["error", "git_rule_refused"]);
        expect(r.hint).toContain("not allowed by the Git rule");
      }
      await choisir(bob, "comptes");
      expect((await pr(bob, "bob", "https://inconnu.lan/o/r.git")).message).toBe("git_rule_refused");
    });

    it("couvert par la règle : la demande suit son cours (aucun refus de règle)", async () => {
      await choisir(bob, "serveurs");
      const r = await pr(bob, "bob", "https://permis.lan/acme/r.git");
      expect(r.message).not.toBe("git_rule_refused");
      await choisir(bob, "comptes");
      expect((await pr(bob, "bob", "https://forge.lan/o/r.git")).message).not.toBe("git_rule_refused");
      expect((await pr(bob, "bob", "https://gen.lan/Acme/Api.git")).message).not.toBe("git_rule_refused");
      expect((await pr(bob, "bob", "https://gen.lan/acme/api.git")).message).toBe("git_rule_refused");
      await choisir(bob, "inexistant");
      expect((await pr(bob, "bob", "https://n-importe-ou.lan/o/r.git")).message).not.toBe("git_rule_refused");
    });
  });

  describe("comptes Git sous des serveurs choisis", () => {
    const corps = (host: string) => ({ provider_type: "gitea", host, token: "tok-s" });

    it("création et changement d'hôte d'un compte sur un autre serveur : 403 ; sur un serveur listé : permis", async () => {
      profils([
        { id: "isolated", name: "I", mode: "none" },
        regleDe("serveurs", "servers", [hote, "listé.lan/acme"]),
        regleDe("libre", "all"),
      ]);
      await choisir(carol, "serveurs");
      const refus = await appel(carol, "POST", "/api/git/connectors", corps("ailleurs.lan"));
      expect([refus.statusCode, refus.json()]).toEqual([
        403,
        { detail: "Ce serveur Git n'est pas autorisé pour votre compte. Demandez à votre administrateur." },
      ]);
      expect(await t.base.get("SELECT id FROM git_connectors WHERE host = 'ailleurs.lan'")).toBeUndefined();
      const ok = await appel(carol, "POST", "/api/git/connectors", corps(hote.toUpperCase()));
      expect(ok.statusCode, ok.body).toBe(200);
      const cid = (ok.json() as { id: number }).id;
      const deplace = await appel(carol, "PUT", `/api/git/connectors/${cid}`, { host: "ailleurs.lan" });
      expect(deplace.statusCode).toBe(403);
      expect(
        (await appel(carol, "PUT", `/api/git/connectors/${cid}`, { label: "autre libellé" })).statusCode,
      ).toBe(200);
    });

    it("sans règle de serveurs : aucun refus", async () => {
      await choisir(carol, "libre");
      expect((await appel(carol, "POST", "/api/git/connectors", corps("ailleurs.lan"))).statusCode).toBe(200);
    });

    it("dépôts listés : seuls ceux des serveurs choisis, au niveau de l'organisation ; hôte sans la casse, chemin avec", async () => {
      const noms = async (uid: number, cid: number): Promise<unknown[]> =>
        (
          (await appel(uid, "GET", `/api/git/connectors/${cid}/repos`)).json() as {
            repos: { full_name: string }[];
          }
        ).repos.map((d) => d.full_name);
      const e = await createUser(t.base, "eve", "mdp-eve");
      const cid = await creer(e, "gitea", hote);
      await choisir(e, "libre");
      expect(await noms(e, cid)).toEqual(["Acme/API", "acme/web", "autre/y"]);
      for (const [liste, attendu] of [
        [[hote], ["Acme/API", "acme/web", "autre/y"]],
        [[hote.toUpperCase()], ["Acme/API", "acme/web", "autre/y"]],
        [[`${hote}/acme`], ["acme/web"]],
        [[`${hote}/Acme`], ["Acme/API"]],
        [[`${hote}/ACME`], []],
        [[`${hote}/Acme/API`], ["Acme/API"]],
        [[`${hote}/acme/api`], []],
        [
          [`${hote}/autre`, `${hote}/acme/web`],
          ["acme/web", "autre/y"],
        ],
        [["ailleurs.lan"], []],
        [[], []],
      ] as const) {
        profils([{ id: "isolated", name: "I", mode: "none" }, regleDe("serveurs", "servers", [...liste])]);
        await choisir(e, "serveurs");
        expect(await noms(e, cid), JSON.stringify(liste)).toEqual(attendu);
      }
    });
  });

  describe("import des anciens identifiants du bac", () => {
    it("un hôte enregistré par un administrateur mais hors des serveurs choisis n'est pas importé", async () => {
      const f = await createUser(t.base, "fred", "mdp-fred");
      const admin = await createUser(t.base, "root", "mdp-root", { isAdmin: 1 });
      await creer(admin, "gitea", "permis.lan");
      await creer(admin, "gitlab", "refuse.lan");
      const donnees = Buffer.from(
        JSON.stringify({
          gitea: { token: "t1", url: "https://permis.lan/x", user: "me" },
          gitlab: { token: "t2", url: "https://refuse.lan/x", user: "me" },
        }),
      ).toString("base64");
      profils([
        { id: "isolated", name: "I", mode: "none" },
        regleDe("serveurs", "servers", ["permis.lan"]),
        regleDe("libre", "all"),
      ]);
      await choisir(f, "serveurs");
      const r = await interne("POST", "/api/internal/git/legacy-credentials", f, "fred", {
        data_b64: donnees,
      });
      expect(r.json()).toEqual({ ok: true, created: 1, refused: 1 });
      await choisir(f, "libre");
      const sans = await interne("POST", "/api/internal/git/legacy-credentials", f, "fred", {
        data_b64: donnees,
      });
      expect(sans.json()).toEqual({ ok: true, created: 1 });
    });
  });
});
