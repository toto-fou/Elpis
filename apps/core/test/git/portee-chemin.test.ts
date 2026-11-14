// SPDX-License-Identifier: MIT
/** apps/core/test/git/portee-chemin.test.ts — portée par chemin des comptes git (SQLite, PostgreSQL si ELPIS_TEST_PG) : chemins lus, compte le plus précis, coffre qui refuse hors portée, unicité, élargissement avec le jeton seulement, dépôts bornés à la portée, comptes sans portée, migration 0030. */
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
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre, configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS_DU_CORE } from "../../src/base";
import { creerFamilleGit } from "../../src/familles/git";
import {
  cheminDeLUrl,
  compteCouvrant,
  contexteUtilisateur,
  createConnector,
  identifiantGitDisponible,
  resolveGitCredential,
} from "../../src/git/connecteurs";
import type { LigneConnecteur } from "../../src/git/connecteurs";
import { brancherAdressesInterdites } from "../../src/git/garde";
import { porteeDesSaisis } from "../../src/git/resolveur";
import { cheminCouvre, cheminDepot, elargit, normaliserPortee } from "../../src/secrets/portee";
import { portsMigrationsDuCore } from "../../src/secrets/reprise";
import { COLONNES_SECRET, dechiffrerLigne, modifierSecret } from "../../src/secrets/stockage";
import type { LigneSecret } from "../../src/secrets/stockage";
import { appTest } from "../aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

describe("chemins et portées (règles pures)", () => {
  it("chemin d'une portée : segments simples en minuscules, sans barres aux bords ni `.git` ; vide = tout l'hôte ; illisible = null", () => {
    expect(cheminDepot("")).toBe("");
    expect(cheminDepot(" / ")).toBe("");
    expect(cheminDepot("Acme")).toBe("acme");
    expect(cheminDepot("/Acme/API.git/")).toBe("acme/api");
    expect(cheminDepot("groupe/sous-groupe/depot_1.x")).toBe("groupe/sous-groupe/depot_1.x");
    expect(cheminDepot("scm/~bob/outils")).toBe("scm/~bob/outils");
    for (const brut of [
      "acme//api",
      "acme/../autre",
      "acme/.",
      "acme/a b",
      "acme%2fapi",
      "acme/api?x=1",
      "acme\\api",
      "a/b/c/d/e/f/g/h/i",
      "é/x",
      "x".repeat(201),
    ])
      expect(cheminDepot(brut), brut).toBeNull();
  });

  it("couverture : tout l'hôte, le chemin même ou un parent sur une frontière de segment ; un dépôt illisible n'est couvert que par tout l'hôte", () => {
    expect(cheminCouvre("", "acme/api")).toBe(true);
    expect(cheminCouvre("", null)).toBe(true);
    expect(cheminCouvre("acme", "acme/api")).toBe(true);
    expect(cheminCouvre("acme/api", "acme/api")).toBe(true);
    expect(cheminCouvre("acme", "acme")).toBe(true);
    expect(cheminCouvre("acme", "acme-corp/api")).toBe(false);
    expect(cheminCouvre("acme/api", "acme")).toBe(false);
    expect(cheminCouvre("acme/api", "acme/api-v2")).toBe(false);
    expect(cheminCouvre("acme", null)).toBe(false);
    expect(cheminCouvre("acme", "")).toBe(false);
  });

  it("chemin d'une URL de dépôt : organisation/dépôt en minuscules ; forme SSH lue ; requête, encodage ou segment douteux : null", () => {
    expect(cheminDeLUrl("https://GitHub.com/Acme/API.git")).toBe("acme/api");
    expect(cheminDeLUrl("https://gl.lan/groupe/sous/depot")).toBe("groupe/sous/depot");
    expect(cheminDeLUrl("git@github.com:acme/api.git")).toBe("acme/api");
    expect(cheminDeLUrl("https://bb.lan/scm/proj/depot.git")).toBe("scm/proj/depot");
    for (const url of [
      "https://github.com/acme/api?x=1",
      "https://github.com/acme/..%2f..%2fautre/depot.git",
      "https://github.com/acme/%2e%2e/depot",
      "https://github.com/acme/a b.git",
      "https://github.com/seul.git",
      "",
    ])
      expect(cheminDeLUrl(url), url).toBeNull();
  });

  it("portée du coffre : `path` facultatif, normalisé, absent pour tout l'hôte ; clé inconnue ou chemin illisible refusés ; réduire n'élargit pas", () => {
    expect(normaliserPortee("git", { host: "GitHub.com" })).toEqual({ host: "github.com" });
    expect(normaliserPortee("git", { host: "github.com", path: "" })).toEqual({ host: "github.com" });
    expect(normaliserPortee("git", { host: "github.com", path: "/Acme/API.git" })).toEqual({
      host: "github.com",
      path: "acme/api",
    });
    for (const brut of [
      { host: "github.com", path: "a b" },
      { host: "github.com", path: 3 },
      { host: "github.com", autre: "x" },
      { path: "acme" },
    ])
      expect(() => normaliserPortee("git", brut), JSON.stringify(brut)).toThrow(/Invalid scope/u);
    const h = { host: "github.com" };
    const org = { host: "github.com", path: "acme" };
    const depot = { host: "github.com", path: "acme/api" };
    expect(elargit("git", h, org)).toBe(false);
    expect(elargit("git", org, depot)).toBe(false);
    expect(elargit("git", depot, depot)).toBe(false);
    expect(elargit("git", depot, org)).toBe(true);
    expect(elargit("git", org, h)).toBe(true);
    expect(elargit("git", org, { host: "github.com", path: "autre" })).toBe(true);
    expect(elargit("git", org, { host: "gitlab.com", path: "acme" })).toBe(true);
  });

  it("compte retenu : le plus long chemin qui couvre ; jamais un compte sans portée ; identifiants saisis : portée demandée si elle couvre, compte à chemin rafraîchi, tout l'hôte s'il est libre, sinon le parent du dépôt", () => {
    const c = (id: number, path: string | null): LigneConnecteur =>
      ({ id, path, host: "h", owner_user_id: 1 }) as LigneConnecteur;
    const tous = [c(1, ""), c(2, "acme"), c(3, "acme/api"), c(4, null)];
    expect(compteCouvrant(tous, "acme/api")?.id).toBe(3);
    expect(compteCouvrant(tous, "acme/api/sous")?.id).toBe(3);
    expect(compteCouvrant(tous, "acme/web")?.id).toBe(2);
    expect(compteCouvrant(tous, "autre/x")?.id).toBe(1);
    expect(compteCouvrant(tous, null)?.id).toBe(1);
    expect(compteCouvrant([c(2, "acme"), c(4, null)], "autre/x")).toBeUndefined();
    expect(compteCouvrant([c(4, null)], "acme/api")).toBeUndefined();
    expect(porteeDesSaisis([], "acme/api")).toBe("");
    expect(porteeDesSaisis([c(4, null)], "acme/api")).toBe("");
    expect(porteeDesSaisis([c(1, "")], "acme/api")).toBe("acme");
    expect(porteeDesSaisis([c(1, "")], "g/sous/depot")).toBe("g/sous");
    expect(porteeDesSaisis([c(1, "")], null)).toBe("");
    expect(porteeDesSaisis(tous, "acme/web")).toBe("acme");
    expect(porteeDesSaisis(tous, "acme/web", "")).toBe("");
    expect(porteeDesSaisis(tous, "acme/web", "Acme/Web.git")).toBe("acme/web");
    expect(porteeDesSaisis(tous, "acme/web", "ailleurs")).toBe("acme");
    expect(porteeDesSaisis(tous, "acme/web", "a b")).toBe("acme");
  });
});

describe.each(MOTEURS)("comptes git à portée par chemin (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let srv: Server;
  let hote = "";
  let dossier = "";
  let journal = "";
  let bob = 0;
  let alice = 0;
  let restaurer: () => void = () => undefined;

  const evenements = (action: string): Record<string, unknown>[] =>
    readdirSync(journal)
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) => readFileSync(join(journal, n), "utf8").split("\n"))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l["action"] === action);

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

  const creer = async (uid: number, corps: Record<string, unknown>): Promise<number> => {
    const r = await appel(uid, "POST", "/api/git/connectors", { provider_type: "gitea", ...corps });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { id: number }).id;
  };

  const ligne = async (cid: number): Promise<Record<string, unknown>> =>
    (await t.base.get<Record<string, unknown>>(
      "SELECT id, host, path, label, secret_id FROM git_connectors WHERE id = ?",
      [cid],
    )) as Record<string, unknown>;

  const secretDe = async (cid: number): Promise<Record<string, unknown>> =>
    (await t.base.get<Record<string, unknown>>(`SELECT ${COLONNES_SECRET} FROM vault_secrets WHERE id = ?`, [
      Number((await ligne(cid))["secret_id"]),
    ])) as Record<string, unknown>;

  const portee = async (cid: number): Promise<unknown> =>
    JSON.parse(String((await secretDe(cid))["scope_json"]));

  const clair = async (cid: number): Promise<string> =>
    dechiffrerLigne((await secretDe(cid)) as unknown as LigneSecret);

  const jeton = async (uid: number, url: string): Promise<string | null> =>
    (await resolveGitCredential(t.base, uid, url, contexteUtilisateur({ userId: uid, username: "x" })))
      ?.token ?? null;

  const comptes = async (uid: number): Promise<Record<string, unknown>[]> =>
    ((await appel(uid, "GET", "/api/git/connectors")).json() as { connectors: Record<string, unknown>[] })
      .connectors;

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-portee-git-"));
    journal = join(dossier, "journal");
    mkdirSync(journal);
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    configureAudit({ service: "main", auditDir: journal, hmacKeyPath: "/nonexistent" });
    restaurer = surchargerConfig({ DB_PATH: join(dossier, "user_db", "app.db") });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    bob = await createUser(t.base, "bob", "mdp-bob");
    alice = await createUser(t.base, "alice", "mdp-alice");
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
            ? [depot("Acme/API"), depot("acme/web"), depot("acme-corp/x"), depot("autre/y")]
            : { login: "bob" },
        ),
      );
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    hote = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const auth = { ...dependancesParDefaut(t.base, () => "svc") };
    app = await appTest({
      familles: [creerFamilleGit({ base: t.base, auditer: () => undefined })],
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

  it("trois comptes sur un hôte : chaque dépôt reçoit le jeton du compte le plus précis ; la portée est dans le secret ; la liste est triée par portée", async () => {
    const tout = await creer(bob, { host: "forge.lan", token: "tok-hote", label: "perso" });
    const org = await creer(bob, { host: "forge.lan", path: "Acme", token: "tok-org", label: "robot" });
    const depot = await creer(bob, { host: "forge.lan", path: "/acme/api.git", token: "tok-depot" });
    expect([await portee(tout), await portee(org), await portee(depot)]).toEqual([
      { host: "forge.lan" },
      { host: "forge.lan", path: "acme" },
      { host: "forge.lan", path: "acme/api" },
    ]);
    expect((await secretDe(org))["name"]).toBe("git-forge.lan-acme-robot");
    expect(await jeton(bob, "https://forge.lan/Acme/API.git")).toBe("tok-depot");
    expect(await jeton(bob, "https://forge.lan/acme/web.git")).toBe("tok-org");
    expect(await jeton(bob, "https://forge.lan/acme-corp/x.git")).toBe("tok-hote");
    expect(await jeton(bob, "https://forge.lan/autre/y")).toBe("tok-hote");
    expect(await jeton(bob, "https://forge.lan/acme/api?x=1")).toBe("tok-hote");
    expect(await jeton(alice, "https://forge.lan/acme/api.git")).toBeNull();
    expect(evenements("vault.secret.used").at(-1)).toMatchObject({
      details: { usage: "git", target: "forge.lan" },
    });
    expect(
      (await comptes(bob)).filter((c) => c["host"] === "forge.lan").map((c) => [c["path"], c["has_token"]]),
    ).toEqual([
      ["", true],
      ["acme", true],
      ["acme/api", true],
    ]);
  });

  it("sans compte pour tout l'hôte : un dépôt hors des chemins n'a aucun identifiant, ni par une URL travestie", async () => {
    await creer(bob, { host: "seul.lan", path: "acme", token: "tok-acme" });
    const ctx = contexteUtilisateur({ userId: bob, username: "bob" });
    expect(await jeton(bob, "https://seul.lan/acme/api.git")).toBe("tok-acme");
    expect(await identifiantGitDisponible(t.base, bob, "https://seul.lan/acme/api.git", ctx)).toBe(true);
    for (const url of [
      "https://seul.lan/autre/depot.git",
      "https://seul.lan/acme-corp/depot.git",
      "https://seul.lan/acme/..%2f..%2fautre/depot.git",
      "https://seul.lan/acme/api?x=1",
      "https://seul.lan/acme%2fapi/x",
    ]) {
      expect(await jeton(bob, url), url).toBeNull();
      expect(await identifiantGitDisponible(t.base, bob, url, ctx), url).toBe(false);
    }
  });

  it("portée du compte élargie hors du coffre : le coffre refuse (journalisé), aucun jeton ne sort", async () => {
    const cid = await creer(bob, { host: "coffre.lan", path: "acme", token: "tok-borne" });
    await t.base.run("UPDATE git_connectors SET path = '' WHERE id = ?", [cid]);
    const refus = evenements("vault.secret.refused").length;
    expect(await jeton(bob, "https://coffre.lan/autre/depot.git")).toBeNull();
    expect(evenements("vault.secret.refused").slice(refus)).toMatchObject([
      { details: { code: "secret_scope_mismatch", usage: "git", target: "coffre.lan/autre/depot" } },
    ]);
    expect((await comptes(bob)).find((c) => c["id"] === cid)).toMatchObject({ has_token: false });
  });

  it("unicité par portée : même hôte et même chemin refusés (409), libellé libre ; un autre compte Elpis garde la sienne", async () => {
    const a = await creer(bob, { host: "uni.lan", token: "t1", label: "a" });
    const r = await appel(bob, "POST", "/api/git/connectors", {
      provider_type: "gitea",
      host: "UNI.lan",
      token: "t2",
      label: "b",
    });
    expect([r.statusCode, r.json()]).toEqual([
      409,
      { detail: "Un autre compte s'applique déjà à tout uni.lan." },
    ]);
    const org = await creer(bob, { host: "uni.lan", path: "acme", token: "t3", label: "a" });
    const double = await appel(bob, "POST", "/api/git/connectors", {
      provider_type: "gitea",
      host: "uni.lan",
      path: "ACME/",
      token: "t4",
    });
    expect([double.statusCode, double.json()]).toEqual([
      409,
      { detail: "Un autre compte s'applique déjà à uni.lan/acme." },
    ]);
    expect((await appel(bob, "PUT", `/api/git/connectors/${org}`, { path: "" })).statusCode).toBe(409);
    expect(await ligne(org)).toMatchObject({ path: "acme" });
    expect(await clair(a)).toBe("t1");
    await creer(alice, { host: "uni.lan", token: "t5" });
    const mauvais = await appel(bob, "POST", "/api/git/connectors", {
      provider_type: "gitea",
      host: "uni.lan",
      path: "a b",
      token: "t6",
    });
    expect(mauvais.statusCode).toBe(400);
    expect(String((mauvais.json() as { detail: string }).detail)).toContain("Portée invalide");
  });

  it("modification : réduire la portée garde le jeton ; l'élargir ou la déplacer exige de le ressaisir (rien n'est changé sinon)", async () => {
    const cid = await creer(bob, { host: "modif.lan", path: "acme", token: "tok-m" });
    const version = async (): Promise<number> => Number((await secretDe(cid))["version"]);
    expect((await appel(bob, "PUT", `/api/git/connectors/${cid}`, { path: "acme/api" })).statusCode).toBe(
      200,
    );
    expect(await portee(cid)).toEqual({ host: "modif.lan", path: "acme/api" });
    expect([await clair(cid), await version()]).toEqual(["tok-m", 1]);
    expect(await jeton(bob, "https://modif.lan/acme/api.git")).toBe("tok-m");
    expect(await jeton(bob, "https://modif.lan/acme/web.git")).toBeNull();
    for (const chemin of ["acme", "", "autre"]) {
      const r = await appel(bob, "PUT", `/api/git/connectors/${cid}`, { path: chemin });
      expect([r.statusCode, r.json()], chemin).toEqual([
        400,
        { detail: "Ressaisissez le jeton pour élargir la portée du compte." },
      ]);
      expect(await ligne(cid), chemin).toMatchObject({ path: "acme/api" });
      expect(await portee(cid), chemin).toEqual({ host: "modif.lan", path: "acme/api" });
    }
    expect(
      (await appel(bob, "PUT", `/api/git/connectors/${cid}`, { path: "", token: "tok-m2" })).statusCode,
    ).toBe(200);
    expect(await portee(cid)).toEqual({ host: "modif.lan" });
    expect([await clair(cid), await version()]).toEqual(["tok-m2", 2]);
    expect(await jeton(bob, "https://modif.lan/acme/web.git")).toBe("tok-m2");
    expect((await appel(bob, "PUT", `/api/git/connectors/${cid}`, { path: "a b" })).statusCode).toBe(400);
  });

  it("dépôts d'un compte : bornés à sa portée (adresse de clonage, sans la casse) ; l'analyse d'une URL rend le chemin du dépôt", async () => {
    const tout = await creer(bob, { host: hote, token: "tok-l" });
    const org = await creer(bob, { host: hote, path: "acme", token: "tok-l2" });
    const noms = async (cid: number): Promise<unknown[]> =>
      (
        (await appel(bob, "GET", `/api/git/connectors/${cid}/repos`)).json() as {
          repos: { full_name: string }[];
        }
      ).repos.map((d) => d.full_name);
    expect(await noms(tout)).toEqual(["Acme/API", "acme/web", "acme-corp/x", "autre/y"]);
    expect(await noms(org)).toEqual(["Acme/API", "acme/web"]);
    expect(
      (await appel(bob, "POST", `/api/git/connectors/${org}/test`)).json() as Record<string, unknown>,
    ).toMatchObject({ ok: true, login: "bob" });
    const analyse = (
      await appel(bob, "POST", "/api/git/connectors/parse", { url: "https://GitHub.com/Acme/API.git" })
    ).json();
    expect(analyse).toMatchObject({ ok: true, host: "github.com", path: "acme/api" });
    expect(
      (
        await appel(bob, "POST", "/api/git/connectors/parse", { url: "https://github.com/acme/api?x=1" })
      ).json(),
    ).toMatchObject({ ok: true, host: "github.com", path: "" });
  });

  it("migration 0030 : par compte et par hôte, le dernier compte utilisé garde tout l'hôte, les autres restent sans portée (inactifs, à préciser) ; l'index par libellé part ; un compte sans portée en reçoit une sans ressaisir le jeton", async () => {
    const acteur = { userId: bob, username: "bob" };
    const ids: number[] = [];
    for (const [i, label] of ["vieux", "recent", "jamais"].entries()) {
      ids.push(
        await createConnector(
          t.base,
          bob,
          "gitea",
          "double.lan",
          { token: `tok-${label}`, label, path: `tmp${i}` },
          acteur,
        ),
      );
    }
    const seul = await createConnector(t.base, alice, "gitea", "double.lan", { token: "tok-al" }, acteur);
    const [vieux, recent, jamais] = ids as [number, number, number];
    // État d'avant la migration : portée du coffre sur l'hôte seul, aucune colonne `path` renseignée, index unique par libellé.
    for (const [i, cid] of ids.entries())
      await modifierSecret(
        t.base,
        bob,
        Number((await secretDe(cid))["id"]),
        { scope: { host: "double.lan" }, value: `tok-${["vieux", "recent", "jamais"][i]}` },
        acteur,
      );
    await t.base.run("DELETE FROM git_connectors WHERE host <> 'double.lan'");
    await t.base.run("UPDATE git_connectors SET path = NULL");
    await t.base.run("UPDATE git_connectors SET last_used = 100 WHERE id = ?", [vieux]);
    await t.base.run("UPDATE git_connectors SET last_used = 200 WHERE id = ?", [recent]);
    await t.base.run(
      "CREATE UNIQUE INDEX idx_gitconn_owner_host_label ON git_connectors (owner_user_id, host, label)",
    );
    await t.base.run("DELETE FROM schema_migrations WHERE name = '0030_git_account_scope'");
    const r = await initialiserBase(t.base, {
      migrations: MIGRATIONS_DU_CORE,
      ports: portsMigrationsDuCore(),
    });
    expect(r.echec).toBeNull();
    expect(r.appliquees).toEqual(["0030_git_account_scope"]);
    expect(r.avertissements.join("\n")).toContain("2 compte(s) git en double sur leur hôte");
    expect((await ligne(recent))["path"]).toBe("");
    expect((await ligne(vieux))["path"]).toBeNull();
    expect((await ligne(jamais))["path"]).toBeNull();
    expect((await ligne(seul))["path"]).toBe("");
    // Plus d'unicité par libellé : deux comptes du même hôte et du même libellé, de portées différentes.
    const meme = await creer(bob, { host: "double.lan", path: "x", token: "t", label: "recent" });
    expect(await ligne(meme)).toMatchObject({ path: "x", label: "recent" });
    const rejouee = await initialiserBase(t.base, {
      migrations: MIGRATIONS_DU_CORE,
      ports: portsMigrationsDuCore(),
    });
    expect(rejouee.appliquees).toEqual([]);
    // Un compte sans portée ne sert à aucun dépôt, garde son jeton (testable), et s'active en recevant un chemin, sans le ressaisir.
    expect(await portee(vieux)).toEqual({ host: "double.lan" });
    expect((await comptes(bob)).find((c) => c["id"] === vieux)).toMatchObject({
      path: null,
      has_token: true,
    });
    expect(await jeton(bob, "https://double.lan/acme/api.git")).toBe("tok-recent");
    expect((await appel(bob, "PUT", `/api/git/connectors/${vieux}`, { label: "v" })).statusCode).toBe(200);
    expect((await ligne(vieux))["path"]).toBeNull();
    expect((await appel(bob, "PUT", `/api/git/connectors/${vieux}`, { path: "acme" })).statusCode).toBe(200);
    expect(await portee(vieux)).toEqual({ host: "double.lan", path: "acme" });
    expect(await jeton(bob, "https://double.lan/acme/api.git")).toBe("tok-vieux");
    expect(await jeton(bob, "https://double.lan/autre/x.git")).toBe("tok-recent");
    expect((await appel(bob, "PUT", `/api/git/connectors/${jamais}`, { path: "" })).statusCode).toBe(409);
  });
});
