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
import { amont } from "@elpis/fichiers";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre, configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS_DU_CORE } from "../../src/base";
import { creerFamilleGit } from "../../src/familles/git";
import {
  cheminDeLUrl,
  cheminPourType,
  compteCouvrant,
  contexteUtilisateur,
  createConnector,
  identifiantGitDisponible,
  resolveGitCredential,
} from "../../src/git/connecteurs";
import type { LigneConnecteur } from "../../src/git/connecteurs";
import { brancherAdressesInterdites } from "../../src/git/garde";
import { porteeDesSaisis, saveGitCredential } from "../../src/git/resolveur";
import { cheminCouvre, cheminDepot, cheminExact, elargit, normaliserPortee } from "../../src/secrets/portee";
import { portsMigrationsDuCore } from "../../src/secrets/reprise";
import { COLONNES_SECRET, dechiffrerLigne, modifierSecret } from "../../src/secrets/stockage";
import type { LigneSecret } from "../../src/secrets/stockage";
import { appTest } from "../aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const V = JSON.parse(readFileSync(new URL("../vecteurs/portee-git.json", import.meta.url), "utf-8")) as {
  chemins: [string, string | null][];
  couverture: [string, string | null, boolean][];
  urls: [string, string | null][];
};

describe("chemins et portées (règles pures)", () => {
  it("chemin d'une portée : segments simples, casse gardée, barres des bords et un `.git` retirés ; vide = tout l'hôte ; illisible = null (vecteurs partagés avec l'interface)", () => {
    for (const [brut, attendu] of V.chemins) expect(cheminDepot(brut), JSON.stringify(brut)).toBe(attendu);
    expect(cheminDepot("x".repeat(201))).toBeNull();
    expect(cheminExact("acme/api")).toBe("acme/api");
    for (const brut of ["", "/acme/api", "acme/api/", " acme", "acme/api.git"])
      expect(cheminExact(brut), JSON.stringify(brut)).toBeNull();
  });

  it("couverture : tout l'hôte, le chemin même ou un parent sur une frontière de segment, casse comprise ; un dépôt illisible n'est couvert que par tout l'hôte", () => {
    for (const [portee, chemin, attendu] of V.couverture)
      expect(cheminCouvre(portee, chemin), JSON.stringify([portee, chemin])).toBe(attendu);
  });

  it("chemin d'une URL : celui que le relais joint, casse gardée ; `@`, requête, encodage, second `.git`, segment vide ou unique : null ; forme SSH lue", () => {
    for (const [url, attendu] of V.urls) {
      expect(cheminDeLUrl(url), url).toBe(attendu);
      let joint: string | null;
      try {
        joint = amont(url)[1];
      } catch {
        joint = null;
      }
      // Quand le relais accepte l'URL et qu'un chemin est lu, c'est exactement le dépôt qu'il joint.
      if (attendu !== null && joint !== null) expect(joint, url).toBe(`/${attendu}`);
    }
    expect(amont("https://git.corp/x@git.corp/acme/api")[1]).toBe("/x@git.corp/acme/api");
    expect(cheminDeLUrl("git@github.com:Acme/API.git")).toBe("Acme/API");
    expect(cheminDeLUrl("git@github.com:acme/api.git.git")).toBeNull();
    expect(cheminDeLUrl("")).toBeNull();
  });

  it("casse selon le type du compte : ignorée par les forges connues, exacte pour un service générique", () => {
    expect(cheminPourType("Acme/API", "github")).toBe("acme/api");
    expect(cheminPourType("Acme/API", "bitbucket-server")).toBe("acme/api");
    expect(cheminPourType("Acme/API", "generic")).toBe("Acme/API");
  });

  it("portée du coffre : `path` facultatif, mis en forme, absent pour tout l'hôte ; clé inconnue ou chemin illisible refusés ; réduire n'élargit pas", () => {
    expect(normaliserPortee("git", { host: "GitHub.com" })).toEqual({ host: "github.com" });
    expect(normaliserPortee("git", { host: "github.com", path: "" })).toEqual({ host: "github.com" });
    expect(normaliserPortee("git", { host: "github.com", path: "/acme/api.git" })).toEqual({
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
    expect(elargit("git", org, { host: "github.com", path: "Acme" })).toBe(true);
    expect(elargit("git", org, { host: "gitlab.com", path: "acme" })).toBe(true);
  });

  it("compte retenu : le plus long chemin qui couvre, selon la casse de son type ; jamais un compte sans portée ; un dépôt illisible n'a pas de compte dès qu'un compte de l'hôte est borné", () => {
    const c = (id: number, path: string | null, type = "github"): LigneConnecteur =>
      ({ id, path, host: "h", owner_user_id: 1, provider_type: type }) as LigneConnecteur;
    const tous = [c(1, ""), c(2, "acme"), c(3, "acme/api"), c(4, null)];
    expect(compteCouvrant(tous, "acme/api")?.id).toBe(3);
    expect(compteCouvrant(tous, "Acme/API/sous")?.id).toBe(3);
    expect(compteCouvrant(tous, "acme/web")?.id).toBe(2);
    expect(compteCouvrant(tous, "autre/x")?.id).toBe(1);
    expect(compteCouvrant(tous, null)).toBeUndefined();
    expect(compteCouvrant([c(1, ""), c(4, null)], null)?.id).toBe(1);
    expect(compteCouvrant([c(2, "acme"), c(4, null)], "autre/x")).toBeUndefined();
    expect(compteCouvrant([c(4, null)], "acme/api")).toBeUndefined();
    const generiques = [c(1, "", "generic"), c(2, "Equipe/Depot", "generic")];
    expect(compteCouvrant(generiques, "Equipe/Depot")?.id).toBe(2);
    expect(compteCouvrant(generiques, "equipe/depot")?.id).toBe(1);
  });

  it("identifiants saisis : portée demandée si elle couvre (dans la casse de l'URL), compte à chemin rafraîchi, tout l'hôte s'il est libre, sinon le parent du dépôt ; dépôt illisible : jamais par-dessus le compte de tout l'hôte", () => {
    const c = (id: number, path: string | null): LigneConnecteur =>
      ({ id, path, host: "h", owner_user_id: 1, provider_type: "gitea" }) as LigneConnecteur;
    const tous = [c(1, ""), c(2, "acme"), c(3, "acme/api"), c(4, null)];
    expect(porteeDesSaisis([], "acme/api")).toBe("");
    expect(porteeDesSaisis([c(4, null)], "acme/api")).toBe("");
    expect(porteeDesSaisis([c(1, "")], "Acme/API")).toBe("Acme");
    expect(porteeDesSaisis([c(1, "")], "g/sous/depot")).toBe("g/sous");
    expect(porteeDesSaisis(tous, "Acme/web")).toBe("Acme");
    expect(porteeDesSaisis(tous, "acme/web", "")).toBe("");
    expect(porteeDesSaisis(tous, "Acme/Web", "acme/web.git")).toBe("Acme/Web");
    expect(porteeDesSaisis(tous, "acme/web", "ailleurs")).toBe("acme");
    expect(porteeDesSaisis(tous, "acme/web", "a b")).toBe("acme");
    expect(porteeDesSaisis([], null)).toBe("");
    expect(porteeDesSaisis([c(2, "acme")], null)).toBe("");
    expect(porteeDesSaisis([c(1, "")], null)).toBeNull();
    expect(porteeDesSaisis([c(1, "")], null, "acme")).toBeNull();
    expect(porteeDesSaisis([c(1, "")], null, "")).toBe("");
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
    expect(evenements("vault.secret.used").at(-1)).toMatchObject({
      details: { usage: "git", target: "forge.lan/autre/y" },
    });
    // Dépôt illisible sur un hôte découpé en portées : aucun jeton, pas même celui de tout l'hôte.
    const lus = evenements("vault.secret.used").length;
    for (const url of [
      "https://forge.lan/acme/api?x=1",
      "https://forge.lan/x@forge.lan/acme/api",
      "https://forge.lan/acme/api.git.git",
      "https://forge.lan/acme/%61pi",
    ])
      expect(await jeton(bob, url), url).toBeNull();
    expect(evenements("vault.secret.used").length).toBe(lus);
    expect(await jeton(alice, "https://forge.lan/acme/api.git")).toBeNull();
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
    expect(await jeton(bob, "https://seul.lan/ACME/API.git")).toBe("tok-acme");
    for (const url of [
      "https://seul.lan/autre/depot.git",
      "https://seul.lan/acme-corp/depot.git",
      "https://seul.lan/acme/..%2f..%2fautre/depot.git",
      "https://seul.lan/acme/api?x=1",
      "https://seul.lan/acme%2fapi/x",
      "https://seul.lan/x@seul.lan/acme/api",
      "https://seul.lan/autre@seul.lan/acme/api.git",
      "https://seul.lan/acme/api.git.git",
      "https://seul.lan/acme/api.GIT",
      "https://seul.lan//acme/api",
    ]) {
      expect(await jeton(bob, url), url).toBeNull();
      expect(await identifiantGitDisponible(t.base, bob, url, ctx), url).toBe(false);
    }
    // Service générique : la casse du chemin compte, elle est gardée telle que saisie.
    const generique = await creer(bob, {
      provider_type: "generic",
      host: "casse.lan",
      path: "Equipe/Depot",
      token: "tok-casse",
    });
    expect(await ligne(generique)).toMatchObject({ path: "Equipe/Depot" });
    expect(await jeton(bob, "https://casse.lan/Equipe/Depot.git")).toBe("tok-casse");
    expect(await jeton(bob, "https://casse.lan/equipe/depot.git")).toBeNull();
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

  it("montée de version d'une base d'avant la portée : colonne ajoutée, puis 0030 par main ; par compte et par hôte, le dernier compte utilisé garde tout l'hôte, les autres restent sans portée ; l'index par libellé part ; un compte sans portée en reçoit une sans ressaisir le jeton", async () => {
    const acteur = { userId: bob, username: "bob" };
    const ids: number[] = [];
    const noms = ["vieux", "recent", "jamais"];
    for (const [i, label] of noms.entries())
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
    const seul = await createConnector(t.base, alice, "gitea", "double.lan", { token: "tok-al" }, acteur);
    const [vieux, recent, jamais] = ids as [number, number, number];
    // Base d'avant : secrets sur l'hôte seul, table sans colonne `path`, unicité par libellé, 0030 jamais jouée.
    for (const [i, cid] of ids.entries())
      await modifierSecret(
        t.base,
        bob,
        Number((await secretDe(cid))["id"]),
        { scope: { host: "double.lan" }, value: `tok-${noms[i]}` },
        acteur,
      );
    await t.base.run("DELETE FROM git_connectors WHERE host <> 'double.lan'");
    await t.base.run("UPDATE git_connectors SET last_used = 100 WHERE id = ?", [vieux]);
    await t.base.run("UPDATE git_connectors SET last_used = 200 WHERE id = ?", [recent]);
    await t.base.run("DROP INDEX idx_gitconn_owner_host_path");
    await t.base.run("ALTER TABLE git_connectors DROP COLUMN path");
    await t.base.run(
      "CREATE UNIQUE INDEX idx_gitconn_owner_host_label ON git_connectors (owner_user_id, host, label)",
    );
    await t.base.run("DELETE FROM schema_migrations WHERE name = '0030_git_account_scope'");
    // Un process sans l'implémentation (admin, hôte d'outils) passe d'abord : colonne et index posés, 0030 laissée à main, aucun compte ne sert en attendant.
    const sans = await initialiserBase(t.base);
    expect(sans.echec).toBeNull();
    expect(sans.colonnesAjoutees).toContain("git_connectors.path");
    expect(sans.differees.map((d) => d.name)).toEqual(["0030_git_account_scope"]);
    expect(await jeton(bob, "https://double.lan/acme/api.git")).toBeNull();
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
    expect([rejouee.appliquees, rejouee.colonnesAjoutees]).toEqual([[], []]);
    // Un compte sans portée ne sert à aucun dépôt, garde son jeton (testable), et s'active en recevant un chemin, sans le ressaisir.
    expect(await portee(vieux)).toEqual({ host: "double.lan" });
    expect((await comptes(bob)).find((c) => c["id"] === vieux)).toMatchObject({
      path: null,
      has_token: true,
    });
    expect(await jeton(bob, "https://double.lan/acme/api.git")).toBe("tok-recent");
    expect((await appel(bob, "PUT", `/api/git/connectors/${vieux}`, { label: "v" })).statusCode).toBe(200);
    expect((await appel(bob, "PUT", `/api/git/connectors/${vieux}`, { path: null })).statusCode).toBe(404);
    expect((await ligne(vieux))["path"]).toBeNull();
    expect((await appel(bob, "PUT", `/api/git/connectors/${vieux}`, { path: "acme" })).statusCode).toBe(200);
    expect(await portee(vieux)).toEqual({ host: "double.lan", path: "acme" });
    expect(await jeton(bob, "https://double.lan/acme/api.git")).toBe("tok-vieux");
    expect(await jeton(bob, "https://double.lan/autre/x.git")).toBe("tok-recent");
    expect((await appel(bob, "PUT", `/api/git/connectors/${jamais}`, { path: "" })).statusCode).toBe(409);
  });

  it("identifiants saisis au clone : jamais repris par un compte importé du bac, à vérifier (son type et son API viennent de l'agent) ; une portée demandée ne remplace rien d'autre que son compte", async () => {
    const acteur = { userId: bob, username: "bob" };
    const importe = await createConnector(
      t.base,
      bob,
      "bitbucket-cloud",
      "import.lan",
      { token: "tok-agent", label: "imported", source: "sandbox-file" },
      acteur,
    );
    expect((await secretDe(importe))["state"]).toBe("unverified");
    for (const portee of [undefined, "", "acme"])
      expect(
        await saveGitCredential(
          t.base,
          bob,
          "https://import.lan/acme/api.git",
          "bob",
          "tok-humain",
          "",
          acteur,
          portee,
        ),
        String(portee),
      ).toSatisfy((id: number | null) => id === null || id !== importe);
    expect((await secretDe(importe))["state"]).toBe("unverified");
    expect(await clair(importe)).toBe("tok-agent");
    expect(await ligne(importe)).toMatchObject({ path: "" });
    expect(
      (
        await t.base.get<{ provider_type: string }>("SELECT provider_type FROM git_connectors WHERE id = ?", [
          importe,
        ])
      )?.provider_type,
    ).toBe("bitbucket-cloud");
  });

  it("unicité entre types : un compte générique et un compte de forge ne couvrent jamais exactement le même endroit, casse ignorée", async () => {
    await creer(bob, { provider_type: "generic", host: "mixte.lan", path: "Acme", token: "t1" });
    const r = await appel(bob, "POST", "/api/git/connectors", {
      provider_type: "gitea",
      host: "mixte.lan",
      path: "acme",
      token: "t2",
    });
    expect(r.statusCode).toBe(409);
    const autre = await creer(bob, { provider_type: "gitea", host: "mixte.lan", path: "autre", token: "t3" });
    expect(
      (await appel(bob, "PUT", `/api/git/connectors/${autre}`, { path: "ACME", token: "t4" })).statusCode,
    ).toBe(409);
  });

  it("portée saisie : jamais tronquée (une saisie trop longue est refusée, pas raccourcie en une portée plus large)", async () => {
    const longue = `${"/".repeat(295)}acme/api`;
    const r = await appel(bob, "POST", "/api/git/connectors", {
      provider_type: "gitea",
      host: "long.lan",
      path: longue,
      token: "t",
    });
    expect(r.statusCode).toBe(400);
    expect(await t.base.get("SELECT id FROM git_connectors WHERE host = 'long.lan'")).toBeUndefined();
  });
});
