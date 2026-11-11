// SPDX-License-Identifier: MIT
/** apps/core/test/git/coffre-git.test.ts — comptes git sur le coffre « Secrets » (SQLite, PostgreSQL si ELPIS_TEST_PG) : jeton en écriture seule (vide = inchangé), `has_token` honnête, hôte, type ou API effective changés sans jeton : jeton effacé (secret ou ancien clair), suppression avec le secret, lecture journalisée et portée vérifiée ; identifiant git, sa présence (sans compter) et hôtes des comptes git au compte de l'enveloppe signée seulement ; enregistrement par le clone de l'éditeur seul ; ancien `.git-credentials.json` importé à vérifier ; suppression du compte. */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, creerGardes, dependancesParDefaut, installerAuth } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase, MIGRATIONS_TS } from "@elpis/db";
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

import { deleteUserFull } from "../../src/comptes/suppression";
import { creerFamilleGit } from "../../src/familles/git";
import { creerFamilleInterneToolhost } from "../../src/familles/interne-toolhost";
import { creerFamilleSecrets } from "../../src/familles/secrets";
import {
  contexteUtilisateur,
  createConnector,
  getConnector,
  identifiantGitDisponible,
  resolveGitCredential,
  updateConnector,
} from "../../src/git/connecteurs";
import { brancherAdressesInterdites } from "../../src/git/garde";
import {
  COLONNES_SECRET,
  dechiffrerLigne,
  modifierSecret,
  supprimerSecret,
} from "../../src/secrets/stockage";
import type { LigneSecret } from "../../src/secrets/stockage";
import { appTest, journalMuet } from "../aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const SVC = "svc-coffre-git";

describe.each(MOTEURS)("comptes git sur le coffre (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let srv: Server;
  let hote = "";
  let dossier = "";
  let journal = "";
  let cle = "";
  let bob = 0;
  let alice = 0;
  let admin = 0;
  let restaurer: () => void = () => undefined;
  let cacheAvant: string | undefined;
  const recus: string[] = [];

  const coffre = (k: string): void =>
    configurerCoffre({
      cleEnv: k,
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });

  /** Lignes du journal de sécurité d'une action. */
  const evenements = (action: string): Record<string, unknown>[] =>
    readdirSync(journal)
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) => readFileSync(join(journal, n), "utf8").split("\n"))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l["action"] === action);

  const toutLeJournal = (): string =>
    readdirSync(journal)
      .map((n) => readFileSync(join(journal, n), "utf8"))
      .join("");

  const appel = (
    uid: number,
    methode: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    corps?: unknown,
  ): Promise<{ statusCode: number; body: string; json: () => unknown }> =>
    app.inject({
      method: methode,
      url,
      headers: {
        "x-uid": String(uid),
        ...(corps === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
    });

  const interne = (
    methode: "GET" | "POST",
    url: string,
    identite: string | null,
    corps?: unknown,
  ): Promise<{ statusCode: number; body: string; headers: Record<string, unknown>; json: () => unknown }> =>
    app.inject({
      method: methode,
      url,
      headers: {
        authorization: `Bearer ${SVC}`,
        ...(identite === null ? {} : { [IDENTITY_HEADER]: identite }),
        ...(corps === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
    });

  const enveloppe = (uid: number, nom: string, o: { cle?: string; chat?: string } = {}): string =>
    sign(creerIdentite({ user_id: uid, username: nom, chat_id: o.chat ?? "" }), o.cle ?? SVC);

  const ligne = async (cid: number): Promise<Record<string, unknown>> =>
    (await t.base.get<Record<string, unknown>>(
      "SELECT host, label, username, token_enc, token_scheme, secret_id FROM git_connectors WHERE id = ?",
      [cid],
    )) as Record<string, unknown>;

  const secret = async (sid: unknown): Promise<Record<string, unknown> | undefined> =>
    t.base.get<Record<string, unknown>>(`SELECT ${COLONNES_SECRET} FROM vault_secrets WHERE id = ?`, [
      Number(sid),
    ]);

  const clair = (s: Record<string, unknown> | undefined): string =>
    dechiffrerLigne(s as unknown as LigneSecret);

  const comptesGit = async (uid: number): Promise<Record<string, unknown>[]> =>
    ((await appel(uid, "GET", "/api/git/connectors")).json() as { connectors: Record<string, unknown>[] })
      .connectors;

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-coffre-git-"));
    journal = join(dossier, "journal");
    mkdirSync(journal);
    cle = randomBytes(32).toString("base64");
    coffre(cle);
    configureAudit({ service: "main", auditDir: journal, hmacKeyPath: "/nonexistent" });
    restaurer = surchargerConfig({
      LOCAL_MCP_TOKEN: SVC,
      DB_PATH: join(dossier, "user_db", "app.db"),
      SANDBOX_DIR: join(dossier, "sandboxes"),
      MEMORY_DIR: join(dossier, "sandboxes"),
      USER_SKILLS_DIR: join(dossier, "user_skills"),
      SKINS_DIR: join(dossier, "skins"),
    });
    cacheAvant = process.env["CHART_CACHE_DIR"];
    process.env["CHART_CACHE_DIR"] = join(dossier, "charts");
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    bob = await createUser(t.base, "bob", "mdp-bob");
    alice = await createUser(t.base, "alice", "mdp-alice");
    admin = await createUser(t.base, "root", "mdp-root", { isAdmin: 1 });
    brancherAdressesInterdites(() => false);
    srv = createServer((req, res) => {
      recus.push(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ login: "bob" }));
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    hote = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const auth = { ...dependancesParDefaut(t.base, () => SVC) };
    app = await appTest({
      familles: [
        creerFamilleGit({ base: t.base, auditer: () => undefined }),
        creerFamilleInterneToolhost({ auth, journal: journalMuet }),
        creerFamilleSecrets({ base: t.base, auth }),
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
    if (cacheAvant === undefined) delete process.env["CHART_CACHE_DIR"];
    else process.env["CHART_CACHE_DIR"] = cacheAvant;
    oublierConfigurationAudit();
    await app.close();
    await new Promise((ok) => srv.close(ok));
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("création : jeton dans un secret `git` (portée : l'hôte), jamais en clair ni rendu ; has_token vrai ; test avec ce jeton", async () => {
    const r = await appel(bob, "POST", "/api/git/connectors", {
      provider_type: "gitea",
      host: hote,
      token: "tok-1",
      username: "bob",
      label: "Équipe",
    });
    expect(r.statusCode).toBe(200);
    const cid = (r.json() as { id: number }).id;
    const l = await ligne(cid);
    expect(l).toMatchObject({ token_enc: "", token_scheme: "vault" });
    const s = await secret(l["secret_id"]);
    expect(s).toMatchObject({ kind: "git", name: `git-${hote.replace(":", "-")}-equipe`, username: "bob" });
    expect(Number(s?.["user_id"])).toBe(bob);
    expect(JSON.parse(String(s?.["scope_json"]))).toEqual({ host: hote });
    expect(JSON.parse(String(s?.["policy_json"]))).toMatchObject({ subagents: true, routines: true });
    expect(JSON.parse(String(s?.["meta_json"]))).toEqual({ connector_id: cid });
    expect(clair(s)).toBe("tok-1");
    const liste = await appel(bob, "GET", "/api/git/connectors");
    expect(liste.body).not.toContain("tok-1");
    expect((liste.json() as { connectors: Record<string, unknown>[] }).connectors).toEqual([
      expect.objectContaining({ id: cid, host: hote, token_scheme: "vault", has_token: true }),
    ]);
    const secrets = (await appel(bob, "GET", "/api/secrets")).json() as {
      secrets: Record<string, unknown>[];
    };
    expect(secrets.secrets.map((x) => [x["kind"], x["scope"]])).toEqual([["git", { host: hote }]]);
    expect(JSON.stringify(secrets)).not.toContain("tok-1");
    const essai = await appel(bob, "POST", `/api/git/connectors/${cid}/test`);
    expect(essai.json()).toMatchObject({ ok: true });
    expect(Buffer.from(String(recus.at(-1)).replace("Basic ", ""), "base64").toString()).toBe("bob:tok-1");
    expect(evenements("vault.secret.created").at(-1)).toMatchObject({
      user_id: bob,
      details: { kind: "git" },
    });
    expect(evenements("vault.secret.used").at(-1)).toMatchObject({
      user_id: bob,
      details: { kind: "git", usage: "git", target: hote },
    });
    expect(toutLeJournal()).not.toContain("tok-1");
  });

  it("modification : vide = inchangé ; hôte, type ou API effective changés sans jeton : jeton effacé, jamais suivi ; nouveau jeton → version n+1, renommé si l'hôte change", async () => {
    const acteur = { userId: bob, username: "bob" };
    const cid = await createConnector(
      t.base,
      bob,
      "gitlab",
      "forge.lan",
      { token: "tok-a", username: "u1", label: "pro" },
      acteur,
    );
    const sid = (await ligne(cid))["secret_id"];
    const avant = await secret(sid);
    expect(
      (await appel(bob, "PUT", `/api/git/connectors/${cid}`, { label: "pro", token: "  " })).statusCode,
    ).toBe(200);
    expect(await secret(sid)).toEqual(avant);
    expect(
      (await appel(bob, "PUT", `/api/git/connectors/${cid}`, { api_base: "https://forge.lan/api/v4" }))
        .statusCode,
    ).toBe(200);
    expect(await secret(sid)).toEqual(avant);
    expect((await appel(bob, "PUT", `/api/git/connectors/${cid}`, { token: "tok-b" })).statusCode).toBe(200);
    let s = await secret(sid);
    expect(Number(s?.["version"])).toBe(2);
    expect(clair(s)).toBe("tok-b");
    expect(
      (await appel(bob, "PUT", `/api/git/connectors/${cid}`, { host: "GIT.Neuf.lan:8443", token: "tok-c" }))
        .statusCode,
    ).toBe(200);
    s = await secret(sid);
    expect(s).toMatchObject({ name: "git-git.neuf.lan-8443-pro" });
    expect(JSON.parse(String(s?.["scope_json"]))).toEqual({ host: "git.neuf.lan:8443" });
    expect(clair(s)).toBe("tok-c");
    expect((await appel(bob, "PUT", `/api/git/connectors/${cid}`, { username: "u2" })).statusCode).toBe(200);
    expect(await secret(sid)).toMatchObject({ username: "u2", version: s?.["version"] });
    expect((await appel(alice, "PUT", `/api/git/connectors/${cid}`, { token: "pirate" })).statusCode).toBe(
      404,
    );
    expect(clair(await secret(sid))).toBe("tok-c");
    for (const [i, corps] of [
      { host: "ailleurs.lan" },
      { api_base: "https://evil.example/api/v4" },
      { provider_type: "bitbucket-cloud" },
      { host: "x.lan", token: "" },
    ].entries()) {
      const c = await createConnector(
        t.base,
        bob,
        "gitlab",
        "dep.lan",
        { token: "tok-d", label: `dep-${i}` },
        acteur,
      );
      const sd = (await ligne(c))["secret_id"];
      const r = await appel(bob, "PUT", `/api/git/connectors/${c}`, corps);
      expect(r.statusCode, JSON.stringify(corps)).toBe(200);
      expect(await ligne(c), JSON.stringify(corps)).toMatchObject({ secret_id: null, token_enc: "" });
      expect(await secret(sd)).toBeUndefined();
      expect((await comptesGit(bob)).find((x) => x["id"] === c)).toMatchObject({ has_token: false });
      expect(evenements("vault.secret.deleted").at(-1)).toMatchObject({ details: { secret_id: Number(sd) } });
      expect(toutLeJournal()).not.toContain("tok-d");
    }
    // Ligne d'avant le coffre (migration en attente) : son ancien jeton clair est effacé, jamais migré vers le nouvel hôte.
    const ancienne = await t.base.insertId(
      "INSERT INTO git_connectors(owner_user_id, provider_type, host, api_base, label, username, token_enc, token_scheme, created_at, updated_at) VALUES (?, 'gitea', 'vieux.lan', '', 'legacy', 'bob', 'TOK-CLAIR', 'plain', 1, 1)",
      [bob],
    );
    expect(await updateConnector(t.base, bob, ancienne, { host: "evil.example" }, acteur)).toBe(true);
    expect(await ligne(ancienne)).toMatchObject({ host: "evil.example", token_enc: "", secret_id: null });
    expect(await updateConnector(t.base, bob, ancienne, { token: "tok-neuf" }, acteur)).toBe(true);
    expect(clair(await secret((await ligne(ancienne))["secret_id"]))).toBe("tok-neuf");
    const sansChangement = await t.base.insertId(
      "INSERT INTO git_connectors(owner_user_id, provider_type, host, api_base, label, username, token_enc, token_scheme, created_at, updated_at) VALUES (?, 'gitea', 'garde.lan', '', 'legacy', 'bob', 'TOK-GARDE', 'plain', 1, 1)",
      [bob],
    );
    expect(await updateConnector(t.base, bob, sansChangement, { label: "renomme" }, acteur)).toBe(true);
    expect(await ligne(sansChangement)).toMatchObject({ token_enc: "TOK-GARDE", label: "renomme" });
    expect(MIGRATIONS_TS).toContain("0027_vault_git");
    for (const c of [ancienne, sansChangement])
      expect((await appel(bob, "DELETE", `/api/git/connectors/${c}`)).statusCode).toBe(200);
  });

  it("portée changée ou secret supprimé dans Secrets, clé changée : has_token faux, aucun jeton (refus journalisé) ; un jeton saisi à nouveau répare", async () => {
    const acteur = { userId: bob, username: "bob" };
    const cid = await createConnector(t.base, bob, "gitea", "10.9.0.1:3000", { token: "tok-p" }, acteur);
    const sid = Number((await ligne(cid))["secret_id"]);
    const url = "http://10.9.0.1:3000/o/r.git";
    const hasToken = async (): Promise<unknown> =>
      (await comptesGit(bob)).find((c) => c["id"] === cid)?.["has_token"];
    expect(await resolveGitCredential(t.base, bob, url, contexteUtilisateur(acteur))).toMatchObject({
      token: "tok-p",
      host: "10.9.0.1:3000",
    });
    await modifierSecret(t.base, bob, sid, { scope: { host: "autre.lan" }, value: "v" }, acteur);
    expect(await hasToken()).toBe(false);
    expect(await resolveGitCredential(t.base, bob, url, contexteUtilisateur(acteur))).toBeNull();
    expect(evenements("vault.secret.refused").at(-1)).toMatchObject({
      details: { code: "secret_scope_mismatch", usage: "git" },
    });
    expect((await appel(bob, "PUT", `/api/git/connectors/${cid}`, { token: "tok-q" })).statusCode).toBe(200);
    expect(await hasToken()).toBe(true);
    expect((await resolveGitCredential(t.base, bob, url, contexteUtilisateur(acteur)))?.token).toBe("tok-q");
    coffre(randomBytes(32).toString("base64"));
    try {
      expect(await hasToken()).toBe(false);
      expect(await resolveGitCredential(t.base, bob, url, contexteUtilisateur(acteur))).toBeNull();
      expect(evenements("vault.secret.refused").at(-1)).toMatchObject({
        details: { code: "secret_undecryptable" },
      });
    } finally {
      coffre(cle);
    }
    expect(await hasToken()).toBe(true);
    await supprimerSecret(t.base, bob, sid, acteur);
    expect(await hasToken()).toBe(false);
    expect(await resolveGitCredential(t.base, bob, url, contexteUtilisateur(acteur))).toBeNull();
    expect((await appel(bob, "PUT", `/api/git/connectors/${cid}`, { token: "tok-r" })).statusCode).toBe(200);
    const nouveau = (await ligne(cid))["secret_id"];
    expect(Number(nouveau)).not.toBe(sid);
    expect(clair(await secret(nouveau))).toBe("tok-r");
    expect(await hasToken()).toBe(true);
  });

  it("suppression d'un compte git : son secret part avec lui (journalisé) ; pas celui d'un autre compte", async () => {
    const acteur = { userId: bob, username: "bob" };
    const cid = await createConnector(t.base, bob, "gitea", "suppr.lan", { token: "tok-s" }, acteur);
    const sid = (await ligne(cid))["secret_id"];
    expect((await appel(alice, "DELETE", `/api/git/connectors/${cid}`)).statusCode).toBe(404);
    expect(await secret(sid)).toBeDefined();
    expect((await appel(bob, "DELETE", `/api/git/connectors/${cid}`)).statusCode).toBe(200);
    expect(await secret(sid)).toBeUndefined();
    expect(evenements("vault.secret.deleted").at(-1)).toMatchObject({
      details: { secret_id: Number(sid), kind: "git" },
    });
  });

  it("identifiant git interne : compte de l'enveloppe signée seulement (jamais `user_id`), no-store, usage journalisé avec la conversation", async () => {
    await createConnector(
      t.base,
      bob,
      "gitea",
      "10.0.0.42:3000",
      { token: "tok-int", username: "ci" },
      { userId: bob, username: "bob" },
    );
    const chemin = (uid: number): string =>
      `/api/internal/git/credential?user_id=${uid}&remote_url=${encodeURIComponent("http://10.0.0.42:3000/a/b.git")}`;
    const sans = await interne("GET", chemin(bob), null);
    expect(sans.statusCode).toBe(401);
    expect(sans.body).not.toContain("tok-int");
    expect((await interne("GET", chemin(bob), enveloppe(bob, "bob", { cle: "autre" }))).statusCode).toBe(401);
    expect((await interne("GET", chemin(bob), enveloppe(bob, "alice"))).statusCode).toBe(403);
    const autre = await interne("GET", chemin(bob), enveloppe(alice, "alice"));
    expect(autre.statusCode).toBe(200);
    expect(autre.json()).toEqual({ ok: true, credential: null });
    const ok = await interne("GET", chemin(0), enveloppe(bob, "bob", { chat: "chat-7" }));
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.json()).toEqual({
      ok: true,
      credential: { username: "ci", token: "tok-int", host: "10.0.0.42:3000" },
    });
    expect(evenements("vault.secret.used").at(-1)).toMatchObject({
      user_id: bob,
      username: "bob",
      details: { usage: "git", target: "10.0.0.42:3000", chat_id: "chat-7", subagent: false },
    });
    expect((await interne("GET", "/api/internal/git/credential", enveloppe(bob, "bob"))).statusCode).toBe(
      400,
    );
  });

  it("présence d'un identifiant git (messages des outils) : compte signé, mêmes règles que la lecture, rien de compté ni journalisé ; hôtes des comptes git du compte signé seulement", async () => {
    const acteur = { userId: bob, username: "bob" };
    const cid = await createConnector(t.base, bob, "gitea", "10.0.0.43:3000", { token: "tok-pres" }, acteur);
    const sid = Number((await ligne(cid))["secret_id"]);
    const url = encodeURIComponent("http://10.0.0.43:3000/a/b.git");
    const chemin = `/api/internal/git/credential/available?remote_url=${url}`;
    const usages = async (): Promise<number> => Number((await secret(sid))?.["use_count"]);
    const utilises = evenements("vault.secret.used").length;
    expect((await interne("GET", chemin, null)).statusCode).toBe(401);
    const r = await interne("GET", chemin, enveloppe(bob, "bob"));
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json()).toEqual({ ok: true, available: true });
    expect((await interne("GET", chemin, enveloppe(alice, "alice"))).json()).toEqual({
      ok: true,
      available: false,
    });
    const autre = `/api/internal/git/credential/available?remote_url=${encodeURIComponent("https://github.com/o/r.git")}`;
    expect((await interne("GET", autre, enveloppe(bob, "bob"))).json()).toEqual({
      ok: true,
      available: false,
    });
    await modifierSecret(t.base, bob, sid, { policy: { subagents: false } }, acteur);
    const sousAgent = sign(
      creerIdentite({ user_id: bob, username: "bob", chat_id: "c#task-x", subagent: { type: "explore" } }),
      SVC,
    );
    expect((await interne("GET", chemin, sousAgent)).json()).toEqual({ ok: true, available: false });
    expect((await interne("GET", chemin, enveloppe(bob, "bob"))).json()).toEqual({
      ok: true,
      available: true,
    });
    expect(
      await identifiantGitDisponible(t.base, bob, decodeURIComponent(url), contexteUtilisateur(acteur)),
    ).toBe(true);
    expect(await usages()).toBe(0);
    expect(evenements("vault.secret.used")).toHaveLength(utilises);
    coffre(randomBytes(32).toString("base64"));
    try {
      expect((await interne("GET", chemin, enveloppe(bob, "bob"))).json()).toEqual({
        ok: true,
        available: false,
      });
    } finally {
      coffre(cle);
    }
    const hotes = "/api/internal/git/connector-hosts";
    expect((await interne("GET", `${hotes}?user_id=${bob}`, null)).statusCode).toBe(401);
    const deBob = (await interne("GET", `${hotes}?user_id=${alice}`, enveloppe(bob, "bob"))).json() as {
      hosts: string[];
    };
    expect(deBob.hosts).toContain("10.0.0.43:3000");
    const dAlice = (await interne("GET", `${hotes}?user_id=${bob}`, enveloppe(alice, "alice"))).json() as {
      hosts: string[];
    };
    expect(dAlice.hosts).not.toContain("10.0.0.43:3000");
    expect((await appel(bob, "DELETE", `/api/git/connectors/${cid}`)).statusCode).toBe(200);
  });

  it("enregistrement interne : seul le clone de l'éditeur écrit (dans le coffre) ; une autre origine est refusée", async () => {
    const env = enveloppe(alice, "alice");
    const refus = await interne("POST", "/api/internal/git/credential", env, {
      target: "https://agent.lan/o/r.git",
      token: "tok-agent",
      username: "a",
    });
    expect(refus.json()).toEqual({
      ok: true,
      saved: false,
      connector_id: null,
      host: "",
      refus: "editor_only",
    });
    expect(await t.base.get("SELECT id FROM git_connectors WHERE host = 'agent.lan'")).toBeUndefined();
    const r = await interne("POST", "/api/internal/git/credential", env, {
      target: "https://Forge2.lan/o/r.git",
      token: " tok-ed ",
      username: "alice-git",
      origine: "editeur",
    });
    const d = r.json() as { saved: boolean; connector_id: number; host: string };
    expect(d).toMatchObject({ ok: true, saved: true, host: "forge2.lan" });
    const l = await ligne(d.connector_id);
    expect(l).toMatchObject({ label: "auto", username: "alice-git", token_enc: "", token_scheme: "vault" });
    expect(clair(await secret(l["secret_id"]))).toBe("tok-ed");
    const encore = await interne("POST", "/api/internal/git/credential", env, {
      target: "https://forge2.lan/o/autre.git",
      token: "tok-ed-2",
      origine: "editeur",
    });
    expect((encore.json() as { connector_id: number }).connector_id).toBe(d.connector_id);
    expect(clair(await secret(l["secret_id"]))).toBe("tok-ed-2");
  });

  it("ancien .git-credentials.json (écrit par l'agent) : importé à vérifier (`unverified`, source sandbox-file), pour un hôte déjà enregistré seulement ; jamais rendu avant la vérification par l'utilisateur", async () => {
    await createConnector(
      t.base,
      admin,
      "gitlab",
      "gl.lan",
      { token: "adm" },
      { userId: admin, username: "root" },
    );
    const donnees = Buffer.from(
      JSON.stringify({
        gitlab: { token: "gl-tok", url: "https://gl.lan/x", user: "me" },
        gitea: { token: "z", url: "https://inconnu.lan" },
      }),
    ).toString("base64");
    const r = await interne("POST", "/api/internal/git/legacy-credentials", enveloppe(alice, "alice"), {
      data_b64: donnees,
    });
    expect(r.json()).toEqual({ ok: true, created: 1, refused: 1 });
    const l = await t.base.get<Record<string, unknown>>(
      "SELECT id, label, username, token_enc, secret_id FROM git_connectors WHERE owner_user_id = ? AND host = 'gl.lan'",
      [alice],
    );
    expect(l).toMatchObject({ label: "imported", username: "me", token_enc: "" });
    const s = await secret(l?.["secret_id"]);
    expect(s).toMatchObject({ kind: "git", state: "unverified" });
    expect(JSON.parse(String(s?.["meta_json"]))).toEqual({
      connector_id: Number(l?.["id"]),
      source: "sandbox-file",
    });
    expect(clair(s)).toBe("gl-tok");
    const ctx = contexteUtilisateur({ userId: alice, username: "alice" });
    expect(await resolveGitCredential(t.base, alice, "https://gl.lan/x/y.git", ctx)).toBeNull();
    expect(evenements("vault.secret.refused").at(-1)).toMatchObject({
      user_id: alice,
      details: { code: "secret_unverified", usage: "git" },
    });
    expect(await identifiantGitDisponible(t.base, alice, "https://gl.lan/x/y.git", ctx)).toBe(false);
    expect((await comptesGit(alice)).find((c) => c["id"] === l?.["id"])).toMatchObject({ has_token: false });
    const lu = await interne(
      "GET",
      `/api/internal/git/credential?remote_url=${encodeURIComponent("https://gl.lan/x/y.git")}`,
      enveloppe(alice, "alice"),
    );
    expect(lu.json()).toEqual({ ok: true, credential: null });
    expect((await appel(alice, "POST", `/api/secrets/${Number(l?.["secret_id"])}/verify`)).statusCode).toBe(
      200,
    );
    expect((await resolveGitCredential(t.base, alice, "https://gl.lan/x/y.git", ctx))?.token).toBe("gl-tok");
    // Jeton saisi par l'humain sur un secret encore à vérifier : rendu utilisable, provenance oubliée.
    const plante = await createConnector(
      t.base,
      alice,
      "gitea",
      "plante.lan",
      { token: "PLANTE", source: "sandbox-file" },
      { userId: alice, username: "alice" },
    );
    const sp = (await ligne(plante))["secret_id"];
    expect(await secret(sp)).toMatchObject({ state: "unverified" });
    expect(
      (await appel(alice, "PUT", `/api/git/connectors/${plante}`, { token: "tok-humain" })).statusCode,
    ).toBe(200);
    expect(await secret(sp)).toMatchObject({ state: "active" });
    expect(JSON.parse(String((await secret(sp))?.["meta_json"]))).toEqual({ connector_id: plante });
    expect(clair(await secret(sp))).toBe("tok-humain");
    expect((await getConnector(t.base, alice, plante))?.secret_id).toBe(Number(sp));
  });

  it("suppression du compte : ses comptes git et leurs secrets partent (cascade et deleteUserFull)", async () => {
    const zoe = await createUser(t.base, "zoe", "mdp-zoe");
    const yann = await createUser(t.base, "yann", "mdp-yann");
    for (const [uid, nom] of [
      [zoe, "zoe"],
      [yann, "yann"],
    ] as const)
      await createConnector(
        t.base,
        uid,
        "gitea",
        `${nom}.lan`,
        { token: `tok-${nom}` },
        { userId: uid, username: nom },
      );
    const restants = async (uid: number): Promise<unknown> =>
      t.base.get(
        "SELECT (SELECT COUNT(*) FROM vault_secrets WHERE user_id = ?) AS s, (SELECT COUNT(*) FROM git_connectors WHERE owner_user_id = ?) AS c",
        [uid, uid],
      );
    expect(await restants(zoe)).toEqual({ s: 1, c: 1 });
    await t.base.run("DELETE FROM users WHERE id = ?", [zoe]);
    expect(await restants(zoe)).toEqual({ s: 0, c: 0 });
    expect(await deleteUserFull(t.base, yann)).toBe(true);
    expect(await restants(yann)).toEqual({ s: 0, c: 0 });
    expect(
      Number(
        (await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM vault_secrets WHERE user_id = ?", [bob]))
          ?.n,
      ),
    ).toBeGreaterThan(0);
  });
});
