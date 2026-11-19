// SPDX-License-Identifier: MIT
/** apps/core/test/securite-rattachement.test.ts — un compte local ne devient une identité d'annuaire que sur appel explicite d'un administrateur, par la clé stable relue côté serveur ; rien par nom ou e-mail ; confirmation des administrateurs, dernier administrateur local gardé, sessions d'avant coupées, détachement avec mot de passe temporaire, droits (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createUser,
  dependancesParDefaut,
  dependancesSession,
  ligneUtilisateur,
  metaSession,
  ouvrirSession,
  revaliderFlux,
  revoquerOauthDuCompte,
  Session,
  validerSession,
  verifyUser,
} from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composer } from "../src/composition";
import { creerFamilleAdminComptes } from "../src/familles/admin-comptes";
import { ConnexionRefusee, etablirConnexion } from "../src/comptes/ouverture";
import { creerFamilleAdminRattachement } from "../src/familles/admin-rattachement";
import { sessionAdmise } from "../src/identite/session";
import { MOTEURS } from "./identite/banc";
import { AnnuaireFactice, GROUPE, UUID } from "./identite/annuaire/annuaire-factice";
import { ouvrirBancAnnuaire, URL_PUBLIQUE } from "./identite/annuaire/banc-annuaire";
import type { BancAnnuaire } from "./identite/annuaire/banc-annuaire";
import { oidcValide } from "./identite/aides";
import { appTest, journalMuet, lignesAuditRecentes } from "./aides";

const MDP = "Pl4nt3-Mdp-Reconnaissable";
const ANCRE = "ldap:cn=users,dc=exemple,dc=lan#entryuuid";
const ID_RATTACHE = "annuaire";

describe.each(MOTEURS)("rattachement des comptes locaux (%s)", (moteur) => {
  let b: BancAnnuaire;
  let annuaire: AnnuaireFactice;
  let admin: FastifyInstance;
  let main: FastifyInstance;
  let racine: string;
  let audit: string;
  let revoques: number[];
  let chef: number;

  const ouvrir = async (extras: Record<string, unknown>[] = [{}]): Promise<void> => {
    annuaire = new AnnuaireFactice();
    annuaire.ajouter({ uid: "jean", cle: UUID(1), mdp: MDP, groupes: [GROUPE] });
    annuaire.ajouter({ uid: "paul", cle: UUID(2), mdp: MDP, groupes: [GROUPE] });
    annuaire.ajouter({ uid: "hors", cle: UUID(3), mdp: MDP, groupes: [] });
    b = await ouvrirBancAnnuaire(moteur, extras, annuaire);
    audit = mkdtempSync(join(tmpdir(), "elpis-audit-ratt-"));
    racine = mkdtempSync(join(tmpdir(), "elpis-racine-ratt-"));
    configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(audit, "sans-cle") });
    revoques = [];
    chef = Number((await ligneUtilisateur(b.t.base, 1))?.id);
    const auth = {
      ...dependancesParDefaut(b.t.base),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax" as const,
        https_only: true,
        max_age: 86_400,
      }),
    };
    admin = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminRattachement({
          base: b.t.base,
          auth,
          journal: journalMuet,
          revoquer: async (uid) => void revoques.push(uid),
          fabrique: annuaire.fabrique,
        }),
        creerFamilleAdminComptes({
          base: b.t.base,
          auth,
          journal: journalMuet,
          revoquer: async () => undefined,
        }),
      ],
      gardes: {
        admin: async (req) => {
          const uid = req.headers["x-uid"];
          if (!uid) throw new HttpError(401, "not logged in");
          const ligne = await ligneUtilisateur(b.t.base, Number(uid));
          req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
          if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
        },
      },
    });
    const dep = {
      ...dependancesParDefaut(b.t.base),
      config: () => ({}),
      attributsCookie: auth.attributsCookie,
      secret: () => "secret-de-test",
      jetonService: () => "",
      revoquerOauth: (uid: number) => revoquerOauthDuCompte(b.t.base, uid, 1),
    };
    main = await appTest({
      ...(await composer("main", b.t.base, journalMuet, dep, racine, {
        fabriqueAnnuaire: annuaire.fabrique,
      })),
    });
  };

  const appeler = (
    methode: "GET" | "POST" | "DELETE",
    url: string,
    corps?: unknown,
    uid: number = chef,
  ): Promise<LightMyRequestResponse> =>
    admin.inject({
      method: methode,
      url,
      headers: { "x-uid": String(uid) },
      ...(corps === undefined ? {} : { payload: corps as object }),
    });
  const lier = (
    links: { user_id: number; subject: string }[],
    confirm: number[] = [],
    keepTokens?: boolean,
  ): Promise<LightMyRequestResponse> =>
    appeler("POST", `/api/admin/auth/providers/${ID_RATTACHE}/migration/link`, {
      links,
      confirm_admins: confirm,
      ...(keepTokens === undefined ? {} : { keep_tokens: keepTokens }),
    });
  const resultats = (r: LightMyRequestResponse): string[] =>
    (r.json() as { results: { result: string }[] }).results.map((x) => x.result);
  const connexion = (username: string, password: string, ip = "10.0.0.5"): Promise<LightMyRequestResponse> =>
    main.inject({
      method: "POST",
      url: "/api/login-lite",
      remoteAddress: ip,
      payload: { username, password },
    });
  const cookie = (r: LightMyRequestResponse): string => {
    const brut = r.headers["set-cookie"];
    return ((Array.isArray(brut) ? brut[0] : brut) ?? "").split(";")[0] ?? "";
  };
  const moi = async (c: string): Promise<Record<string, unknown>> =>
    (await main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: c } })).json();
  const compte = (nom: string) =>
    b.t.base.get<Record<string, unknown>>("SELECT * FROM users WHERE username=?", [nom]);
  const identites = () => b.t.base.all<Record<string, unknown>>("SELECT * FROM user_identities ORDER BY id");
  const audits = (prefixe: string) => lignesAuditRecentes({ actionPrefix: prefixe });

  beforeEach(async () => {
    await ouvrir();
  });
  afterEach(async () => {
    await admin.close();
    await main.close();
    oublierConfigurationAudit();
    rmSync(audit, { recursive: true, force: true });
    rmSync(racine, { recursive: true, force: true });
    await b.fermer();
  });

  describe("la clé stable envoyée est le seul lien avec l'entrée, relue côté serveur", () => {
    it("clé inventée, entrée hors groupe, entrée déjà rattachée : refus, rien d'écrit", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const avant = await b.t.base.all("SELECT * FROM users ORDER BY id");
      const lignesAvant = audits("auth.identity.link").length;
      const r = await lier([
        { user_id: jean, subject: UUID(77) },
        { user_id: jean, subject: "n'importe quoi" },
        { user_id: alice, subject: UUID(3) },
      ]);
      expect([r.statusCode, resultats(r)]).toEqual([200, ["entry_not_found", "duplicate", "not_in_group"]]);
      expect(await b.t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
      expect(await identites()).toEqual([]);
      expect(revoques).toEqual([]);
      const nouvelles = audits("auth.identity.link").slice(
        0,
        audits("auth.identity.link").length - lignesAvant,
      );
      expect(nouvelles).toHaveLength(3);
      expect(nouvelles.every((l) => l.outcome === "failure")).toBe(true);
      expect(nouvelles.map((l) => (l.details as { reason: string }).reason).sort()).toEqual([
        "duplicate",
        "entry_not_found",
        "not_in_group",
      ]);
    });

    it("le navigateur n'envoie que la clé : nom, DN, e-mail et rôle envoyés en plus sont ignorés, l'identité vient de l'annuaire", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      const r = await appeler("POST", `/api/admin/auth/providers/${ID_RATTACHE}/migration/link`, {
        links: [{ user_id: jean, subject: UUID(1), ext_username: "root", dn: "cn=root", is_admin: 1 }],
        confirm_admins: [],
      });
      expect(resultats(r)).toEqual(["linked"]);
      expect(await identites()).toMatchObject([
        {
          user_id: jean,
          subject: UUID(1),
          ext_username: "jean",
          ext_email: "jean@exemple.lan",
          issuer: ANCRE,
        },
      ]);
      expect(Number((await compte("jean"))?.["is_admin"])).toBe(0);
    });

    it("entrée désactivée ou verrouillée : refus (annuaire FreeIPA)", async () => {
      await b.fermer();
      await admin.close();
      await main.close();
      oublierConfigurationAudit();
      await ouvrir([{ preset: "freeipa" }]);
      const etat = (verrou: string) => ({
        nsaccountlock: [verrou],
        krbpasswordexpiration: ["20990101000000Z"],
      });
      annuaire.personnes[0]!.attrs = etat("TRUE");
      annuaire.personnes[1]!.attrs = etat("FALSE");
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      const paul = await createUser(b.t.base, "paul", "mdp-local-2");
      const r = await lier([
        { user_id: jean, subject: UUID(1) },
        { user_id: paul, subject: UUID(2) },
      ]);
      expect(resultats(r)).toEqual(["entry_not_active", "linked"]);
    });

    it("groupes illisibles : refus sans rien écrire", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      annuaire.groupesLisibles = false;
      expect(resultats(await lier([{ user_id: jean, subject: UUID(1) }]))).toEqual(["groups_unknown"]);
      expect(await identites()).toEqual([]);
    });

    it("entrée déjà rattachée à un autre compte : refus", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      const jeanne = await createUser(b.t.base, "jeanne", "mdp-local-2");
      expect(resultats(await lier([{ user_id: jean, subject: UUID(1) }]))).toEqual(["linked"]);
      expect(resultats(await lier([{ user_id: jeanne, subject: UUID(1) }]))).toEqual([
        "entry_already_linked",
      ]);
      expect(await identites()).toHaveLength(1);
    });

    it("annuaire injoignable : 503 court, rien d'écrit ; l'entrée disparue entre-temps : refus du lien", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      annuaire.injoignable = true;
      const r = await lier([{ user_id: jean, subject: UUID(1) }]);
      expect(r.statusCode).toBe(503);
      expect(r.body).not.toMatch(/ldap|exemple|uid=/u);
      expect(await identites()).toEqual([]);
    });
  });

  describe("aucun rattachement sans appel explicite", () => {
    it("une connexion d'annuaire homonyme reste refusée tant que l'administrateur n'a rien fait", async () => {
      await createUser(b.t.base, "jean", "mdp-local-1");
      annuaire.personnes[0]!.uid = "jean";
      const avant = await b.t.base.all("SELECT * FROM users ORDER BY id");
      const r = await connexion("jean", MDP);
      expect(r.statusCode).toBe(401);
      expect(await b.t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
      expect(await identites()).toEqual([]);
    });

    it("la liste propose l'entrée d'identifiant égal au nom seulement, sans rien écrire ; rien d'approchant", async () => {
      await createUser(b.t.base, "jean", "mdp-local-1");
      await createUser(b.t.base, "paulo", "mdp-local-2");
      await createUser(b.t.base, "jeandupont", "mdp-local-3");
      const avant = await b.t.base.all("SELECT * FROM users ORDER BY id");
      const r = await appeler("GET", `/api/admin/auth/providers/${ID_RATTACHE}/migration`);
      expect(r.statusCode).toBe(200);
      const liste = r.json() as {
        items: { username: string; role: string; proposal: Record<string, unknown> | null }[];
        total: number;
      };
      expect(liste.total).toBe(4);
      const par = Object.fromEntries(liste.items.map((i) => [i.username, i.proposal]));
      expect(par["jean"]).toEqual({
        subject: UUID(1),
        dn: "uid=jean,cn=users,dc=exemple,dc=lan",
        ext_username: "jean",
        ext_name: "Nom jean",
        ext_email: "jean@exemple.lan",
        state: "active",
        in_required_group: true,
      });
      expect([par["paulo"], par["jeandupont"], par["chef"]]).toEqual([null, null, null]);
      expect(liste.items.find((i) => i.username === "chef")?.role).toBe("admin");
      expect(await b.t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
      expect(await identites()).toEqual([]);
    });

    it("la liste ne contient que les comptes sans identité, par pages de 100 au plus", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      for (let i = 0; i < 5; i++) await createUser(b.t.base, `compte${i}`, "mdp-x-123");
      await lier([{ user_id: jean, subject: UUID(1) }]);
      const page = async (q: string) =>
        (await appeler("GET", `/api/admin/auth/providers/${ID_RATTACHE}/migration${q}`)).json() as {
          items: { username: string }[];
          total: number;
          offset: number;
          limit: number;
        };
      const tout = await page("");
      expect(tout.items.map((i) => i.username)).toEqual([
        "chef",
        "compte0",
        "compte1",
        "compte2",
        "compte3",
        "compte4",
      ]);
      expect(await page("?offset=2&limit=2")).toMatchObject({ total: 6, offset: 2, limit: 2 });
      expect((await page("?offset=2&limit=2")).items.map((i) => i.username)).toEqual(["compte1", "compte2"]);
      for (const q of ["?limit=101", "?limit=0", "?offset=-1", "?limit=abc"])
        expect(
          (await appeler("GET", `/api/admin/auth/providers/${ID_RATTACHE}/migration${q}`)).statusCode,
        ).toBe(400);
    });

    it("annuaire éteint, inconnu ou OIDC : refusé sans appel à l'annuaire", async () => {
      expect((await appeler("GET", "/api/admin/auth/providers/inconnu/migration")).statusCode).toBe(404);
      b.cfg.ecrire({
        auth: {
          public_url: URL_PUBLIQUE,
          providers: [{ ...b.fournisseurs[0], enabled: false }, oidcValide()],
        },
        security: { https: { enabled: true } },
      });
      const avant = annuaire.traces.length;
      expect((await appeler("GET", `/api/admin/auth/providers/${ID_RATTACHE}/migration`)).statusCode).toBe(
        409,
      );
      expect((await appeler("GET", "/api/admin/auth/providers/sso/migration")).statusCode).toBe(409);
      expect(
        (
          await appeler("POST", `/api/admin/auth/providers/${ID_RATTACHE}/migration/link`, {
            links: [],
            confirm_admins: [],
          })
        ).statusCode,
      ).toBe(409);
      expect(annuaire.traces.length).toBe(avant);
    });

    it("annuaire injoignable : la liste répond 503", async () => {
      annuaire.injoignable = true;
      expect((await appeler("GET", `/api/admin/auth/providers/${ID_RATTACHE}/migration`)).statusCode).toBe(
        503,
      );
    });
  });

  describe("recherche à la main", () => {
    const chercher = (query: unknown) =>
      appeler("POST", `/api/admin/auth/providers/${ID_RATTACHE}/migration/search`, { query });
    const sujets = (r: LightMyRequestResponse): string[] =>
      (r.json() as { items: { ext_username: string }[] }).items.map((i) => i.ext_username).sort();

    it("identifiant ou e-mail égal, ou nom affiché qui commence par la requête", async () => {
      expect(sujets(await chercher("jean"))).toEqual(["jean"]);
      expect(sujets(await chercher("paul@exemple.lan"))).toEqual(["paul"]);
      expect(sujets(await chercher("Nom pa"))).toEqual(["paul"]);
      expect(sujets(await chercher("Nom"))).toEqual(["hors", "jean", "paul"]);
      expect(sujets(await chercher("jea"))).toEqual([]);
    });

    it("la saisie ne porte pas de joker : `*` et `)` sont échappés dans le filtre envoyé", async () => {
      expect(sujets(await chercher("j*n"))).toEqual([]);
      expect(sujets(await chercher("*)(uid=*"))).toEqual([]);
      for (const filtre of annuaire.recherches.filter((x) => x.includes("(|"))) {
        expect(filtre).not.toContain("j*n");
        expect(filtre).toMatch(/\\2a/u);
      }
    });

    it("bornes de la requête : 3 à 64 caractères, texte seulement", async () => {
      for (const q of ["ab", "x".repeat(65), "", 12, null, "a\u0000bc"])
        expect((await chercher(q)).statusCode).toBe(400);
      expect((await chercher("abc")).statusCode).toBe(200);
      expect((await chercher("x".repeat(64))).statusCode).toBe(200);
    });

    it("une entrée déjà rattachée n'est plus proposée", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await lier([{ user_id: jean, subject: UUID(1) }]);
      expect(sujets(await chercher("jean"))).toEqual([]);
    });
  });

  describe("administrateurs", () => {
    it("un compte administrateur sans confirmation explicite n'est pas rattaché ; avec elle, oui", async () => {
      const sam = await createUser(b.t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      annuaire.ajouter({ uid: "sam", cle: UUID(4), mdp: MDP, groupes: [GROUPE] });
      expect(resultats(await lier([{ user_id: sam, subject: UUID(4) }]))).toEqual([
        "admin_confirmation_required",
      ]);
      expect(resultats(await lier([{ user_id: sam, subject: UUID(4) }], [chef]))).toEqual([
        "admin_confirmation_required",
      ]);
      expect(await identites()).toEqual([]);
      expect(resultats(await lier([{ user_id: sam, subject: UUID(4) }], [sam]))).toEqual(["linked"]);
      expect(Number((await compte("sam"))?.["is_admin"])).toBe(1);
      expect((await compte("sam"))?.["pass_hash"]).toBe("!");
    });

    it("le dernier administrateur à mot de passe local ne se rattache pas, même confirmé", async () => {
      annuaire.ajouter({ uid: "chef", cle: UUID(5), mdp: MDP, groupes: [GROUPE] });
      const r = await lier([{ user_id: chef, subject: UUID(5) }], [chef]);
      expect(resultats(r)).toEqual(["last_local_admin"]);
      expect((await compte("chef"))?.["pass_hash"]).not.toBe("!");
      expect(await identites()).toEqual([]);
    });

    it("avec un second administrateur local, le premier peut l'être ; ensuite le second est le dernier", async () => {
      const sam = await createUser(b.t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      annuaire.ajouter({ uid: "chef", cle: UUID(5), mdp: MDP, groupes: [GROUPE] });
      annuaire.ajouter({ uid: "sam", cle: UUID(4), mdp: MDP, groupes: [GROUPE] });
      expect(resultats(await lier([{ user_id: chef, subject: UUID(5) }], [chef]))).toEqual(["linked"]);
      expect(resultats(await lier([{ user_id: sam, subject: UUID(4) }], [sam]))).toEqual([
        "last_local_admin",
      ]);
    });

    it("deux administrateurs dans un même lot : le dernier restant est refusé, l'autre lié", async () => {
      const sam = await createUser(b.t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      annuaire.ajouter({ uid: "chef", cle: UUID(5), mdp: MDP, groupes: [GROUPE] });
      annuaire.ajouter({ uid: "sam", cle: UUID(4), mdp: MDP, groupes: [GROUPE] });
      const r = await lier(
        [
          { user_id: chef, subject: UUID(5) },
          { user_id: sam, subject: UUID(4) },
        ],
        [chef, sam],
      );
      expect(resultats(r)).toEqual(["linked", "last_local_admin"]);
    });

    it("un administrateur suspendu ne se rattache pas", async () => {
      const sam = await createUser(b.t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      annuaire.ajouter({ uid: "sam", cle: UUID(4), mdp: MDP, groupes: [GROUPE] });
      await b.t.base.run("UPDATE users SET suspended_at=1, suspended_by='admin' WHERE id=?", [sam]);
      expect(resultats(await lier([{ user_id: sam, subject: UUID(4) }], [sam]))).toEqual([
        "account_suspended",
      ]);
    });
  });

  describe("après le rattachement", () => {
    it("le mot de passe local ne marche plus, la session d'avant est morte, la connexion par l'annuaire ouvre CE compte", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await b.t.base.run("UPDATE users SET must_change_pwd=1 WHERE id=?", [jean]);
      await b.t.base.run(
        "INSERT INTO chats(id, user_id, title, messages_json, updated_at) VALUES('c1', ?, 'Ma conversation', '[]', 1.0)",
        [jean],
      );
      await b.t.base.run("UPDATE users SET must_change_pwd=0 WHERE id=?", [jean]);
      const ouverte = cookie(await connexion("jean", "mdp-local-1"));
      expect((await moi(ouverte))["logged_in"]).toBe(true);
      await b.t.base.run("UPDATE users SET must_change_pwd=1 WHERE id=?", [jean]);
      const salAvant = (await compte("jean"))?.["pass_salt"];

      const r = await lier([{ user_id: jean, subject: UUID(1) }]);
      expect([r.statusCode, resultats(r)]).toEqual([200, ["linked"]]);

      const u = await compte("jean");
      expect(u).toMatchObject({ pass_hash: "!", must_change_pwd: 0 });
      expect(u?.["pass_salt"]).not.toBe(salAvant);
      expect(Number(u?.["session_min_ts"])).toBeGreaterThan(0);
      expect(await identites()).toMatchObject([
        {
          user_id: jean,
          provider_id: ID_RATTACHE,
          subject: UUID(1),
          issuer: ANCRE,
          linked_by: `admin:${chef}`,
        },
      ]);
      expect(revoques).toEqual([jean]);
      expect(audits("auth.identity.link")[0]).toMatchObject({
        action: "auth.identity.link",
        user_id: chef,
        details: { target_user_id: jean, provider_id: ID_RATTACHE, by: `admin:${chef}` },
      });

      expect((await moi(ouverte))["logged_in"]).toBe(false);
      expect((await connexion("jean", "mdp-local-1")).statusCode).toBe(401);
      const r2 = await connexion("jean", MDP);
      expect(r2.statusCode).toBe(200);
      expect(await moi(cookie(r2))).toMatchObject({
        logged_in: true,
        username: "jean",
        password_managed: true,
      });
      expect((await moi(cookie(r2)))["id"]).toBe(jean);
      expect(await b.t.base.valeurs("SELECT id FROM chats WHERE user_id=?", [jean])).toEqual([["c1"]]);
      expect(await b.t.base.valeurs("SELECT username FROM users ORDER BY id")).toEqual([["chef"], ["jean"]]);
    });

    it("lien partiel : un refus au milieu n'empêche pas les autres", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      const paul = await createUser(b.t.base, "paul", "mdp-local-2");
      const r = await lier([
        { user_id: jean, subject: UUID(1) },
        { user_id: 99_999, subject: UUID(9) },
        { user_id: paul, subject: UUID(2) },
      ]);
      expect(resultats(r)).toEqual(["linked", "entry_not_found", "linked"]);
      expect(await identites()).toHaveLength(2);
    });

    it("un compte qui a déjà une identité, un compte inconnu : refusés", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await lier([{ user_id: jean, subject: UUID(1) }]);
      expect(resultats(await lier([{ user_id: jean, subject: UUID(2) }]))).toEqual(["account_has_identity"]);
      expect(resultats(await lier([{ user_id: 99_999, subject: UUID(2) }]))).toEqual(["account_not_found"]);
    });

    it("un compte suspendu n'est pas rattaché", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await b.t.base.run("UPDATE users SET suspended_at=1, suspended_by='admin' WHERE id=?", [jean]);
      expect(resultats(await lier([{ user_id: jean, subject: UUID(1) }]))).toEqual(["account_suspended"]);
      expect((await compte("jean"))?.["pass_hash"]).not.toBe("!");
    });

    it("tout dans une seule écriture : une panne après les écritures les annule toutes", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      const { rattacher } = await import("../src/identite/rattachement");
      const avant = await compte("jean");
      await expect(
        b.t.base.ecriture(async (x) => {
          await rattacher(
            x,
            jean,
            {
              fournisseurId: ID_RATTACHE,
              subject: UUID(1),
              issuer: ANCRE,
              extUsername: "jean",
              extEmail: "",
              extName: "",
            },
            { par: "admin:1", confirmeAdmin: false, t: 1_800_000_000 },
          );
          throw new Error("panne");
        }),
      ).rejects.toThrow("panne");
      expect(await compte("jean")).toEqual(avant);
      expect(await identites()).toEqual([]);
    });

    it("la liste des comptes de la console rend l'identité et le mot de passe local", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await createUser(b.t.base, "alice", "mdp-alice-1");
      await lier([{ user_id: jean, subject: UUID(1) }]);
      const r = await appeler("GET", "/api/admin/users-with-groups");
      const par = Object.fromEntries(
        (r.json() as { users: { username: string }[] }).users.map((u) => [u.username, u]),
      );
      expect(par["jean"]).toMatchObject({
        identity: { provider_id: ID_RATTACHE, ext_username: "jean", linked_at: expect.any(Number) },
        has_local_password: false,
      });
      expect(par["alice"]).toMatchObject({ identity: null, has_local_password: true });
      expect(JSON.stringify(par["jean"])).not.toMatch(/pass_hash|pass_salt|"!"/u);
    });
  });

  describe("détachement", () => {
    const detacher = (cible: number, corps: unknown = { new_password: "Temporaire-Mdp-9" }, uid = chef) =>
      appeler("POST", `/api/admin/users/${cible}/identity/detach`, corps, uid);

    it("sans mot de passe valide : refus, le compte reste rattaché", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await lier([{ user_id: jean, subject: UUID(1) }]);
      const avant = await compte("jean");
      for (const corps of [{}, { new_password: "" }, { new_password: 12 }, { new_password: null }])
        expect((await detacher(jean, corps)).statusCode).toBe(400);
      b.cfg.ecrire({
        auth: { public_url: URL_PUBLIQUE, providers: b.fournisseurs },
        security: { https: { enabled: true }, password_policy: { min_length: 16 } },
      });
      expect((await detacher(jean, { new_password: "court" })).statusCode).toBe(400);
      expect(await compte("jean")).toEqual(avant);
      expect(await identites()).toHaveLength(1);
    });

    it("avec un mot de passe valide : le compte redevient local, à changer, sessions et accès d'avant coupés", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await lier([{ user_id: jean, subject: UUID(1) }]);
      const ouverte = cookie(await connexion("jean", MDP));
      expect((await moi(ouverte))["logged_in"]).toBe(true);
      await b.t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, created_at) VALUES(?, 'api', 'jeton', 'hash-1', 1.0)",
        [jean],
      );
      revoques.length = 0;
      const r = await detacher(jean);
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true }]);
      expect(await identites()).toEqual([]);
      expect(revoques).toEqual([jean]);
      expect(await b.t.base.valeurs("SELECT 1 FROM tool_tokens WHERE user_id=?", [jean])).toEqual([]);
      expect((await compte("jean"))?.["pass_hash"]).not.toBe("!");
      expect(Number((await compte("jean"))?.["must_change_pwd"])).toBe(1);
      expect((await moi(ouverte))["logged_in"]).toBe(false);
      const local = await connexion("jean", "Temporaire-Mdp-9", "10.0.0.9");
      expect(local.statusCode).toBe(200);
      expect(local.json()).toMatchObject({ must_change_password: true });
      expect((await connexion("jean", MDP, "10.0.0.10")).statusCode).toBe(401);
      expect(audits("auth.identity.unlink")[0]).toMatchObject({
        user_id: chef,
        details: { target_user_id: jean, provider_id: ID_RATTACHE, by: `admin:${chef}` },
      });
    });

    it("compte sans identité : 409 ; compte inconnu : 404 ; son propre compte : 400", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      expect((await detacher(alice)).statusCode).toBe(409);
      expect((await detacher(99_999)).statusCode).toBe(404);
      expect((await detacher(chef)).statusCode).toBe(400);
    });

    it("l'identité détachée peut être rattachée à un autre compte", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      const jeanne = await createUser(b.t.base, "jeanne", "mdp-local-2");
      await lier([{ user_id: jean, subject: UUID(1) }]);
      await detacher(jean);
      expect(resultats(await lier([{ user_id: jeanne, subject: UUID(1) }]))).toEqual(["linked"]);
    });
  });

  describe("droits : l'administrateur seul", () => {
    it("un modérateur, un utilisateur et un visiteur : 403 ou 401 partout, rien d'écrit", async () => {
      const modo = await createUser(b.t.base, "modo", "mdp-modo-12", { isAdmin: 2 });
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const appels: ["GET" | "POST" | "DELETE", string, unknown?][] = [
        ["GET", `/api/admin/auth/providers/${ID_RATTACHE}/migration`],
        ["POST", `/api/admin/auth/providers/${ID_RATTACHE}/migration/search`, { query: "jean" }],
        [
          "POST",
          `/api/admin/auth/providers/${ID_RATTACHE}/migration/link`,
          { links: [{ user_id: alice, subject: UUID(1) }] },
        ],
        ["POST", `/api/admin/users/${alice}/identity/detach`, { new_password: "Temporaire-Mdp-9" }],
        ["GET", "/api/admin/auth/providers/sso/prelinks"],
        ["POST", "/api/admin/auth/providers/sso/prelinks", { user_id: alice, expected: "alice" }],
        ["DELETE", "/api/admin/auth/providers/sso/prelinks/1"],
      ];
      for (const [m, u, corps] of appels) {
        expect((await appeler(m, u, corps, modo)).statusCode, `${m} ${u}`).toBe(403);
        expect((await appeler(m, u, corps, alice)).statusCode, `${m} ${u}`).toBe(403);
        const sans = await admin.inject({
          method: m,
          url: u,
          ...(corps === undefined ? {} : { payload: corps as object }),
        });
        expect(sans.statusCode, `${m} ${u}`).toBe(401);
      }
      expect(await identites()).toEqual([]);
    });
  });

  describe("rattachements préparés (fournisseur OIDC)", () => {
    const prelinks = "/api/admin/auth/providers/sso/prelinks";
    const preparer = (user_id: number, expected: string, extra: Record<string, unknown> = {}) =>
      appeler("POST", prelinks, { user_id, expected, ...extra });
    const lignes = () => b.t.base.all<Record<string, unknown>>("SELECT * FROM auth_prelinks ORDER BY id");

    beforeEach(() => {
      b.cfg.ecrire({
        auth: { public_url: URL_PUBLIQUE, providers: [...b.fournisseurs, oidcValide()] },
        security: { https: { enabled: true } },
      });
    });

    it("création : identifiant normalisé, échéance à 30 jours, auteur, audit ; liste avec le nom du compte", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const avant = Date.now() / 1000;
      expect((await preparer(alice, "Alice.Ｄupont@Exemple.LAN")).statusCode).toBe(400);
      const r = await preparer(alice, "Alice.Dupont@Exemple.LAN");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        user_id: alice,
        username: "alice",
        expected: "alice.dupont@exemple.lan",
        waiver: false,
        created_by: chef,
      });
      const [l] = await lignes();
      expect(Number(l?.["expires_at"]) - Number(l?.["created_at"])).toBe(30 * 86_400);
      expect(Number(l?.["created_at"])).toBeGreaterThanOrEqual(avant - 1);
      expect(audits("auth.prelink.create")[0]).toMatchObject({
        user_id: chef,
        details: { target_user_id: alice, provider_id: "sso", waiver: false },
      });
      const liste = (await appeler("GET", prelinks)).json() as { items: { username: string }[] };
      expect(liste.items.map((i) => i.username)).toEqual(["alice"]);
      expect(JSON.stringify(liste)).not.toMatch(/pass_|secret/u);
    });

    it("un annuaire LDAP se rattache par l'assistant : les rattachements préparés sont refusés ; fournisseur inconnu : 404", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const r = await appeler("POST", `/api/admin/auth/providers/${ID_RATTACHE}/prelinks`, {
        user_id: alice,
        expected: "alice",
      });
      expect(r.statusCode).toBe(409);
      expect((await appeler("GET", `/api/admin/auth/providers/${ID_RATTACHE}/prelinks`)).statusCode).toBe(
        409,
      );
      expect(
        (await appeler("POST", "/api/admin/auth/providers/zzz/prelinks", { user_id: alice, expected: "a" }))
          .statusCode,
      ).toBe(404);
      expect(await lignes()).toEqual([]);
    });

    it("dispense refusée pour un administrateur ; administrateur sans confirmation refusé ; avec elle accepté", async () => {
      const sam = await createUser(b.t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      expect((await preparer(sam, "sam", { waiver: true, confirm_admin: true })).statusCode).toBe(400);
      expect((await preparer(sam, "sam")).statusCode).toBe(400);
      expect(await lignes()).toEqual([]);
      expect((await preparer(sam, "sam", { confirm_admin: true })).statusCode).toBe(200);
      expect(Number((await lignes())[0]?.["waiver"])).toBe(0);
    });

    it("le dernier administrateur local ne reçoit pas de rattachement préparé", async () => {
      expect((await preparer(chef, "chef", { confirm_admin: true })).statusCode).toBe(409);
      expect(await lignes()).toEqual([]);
    });

    it("dispense pour un compte ordinaire : enregistrée ; doublon d'identifiant attendu et second rattachement du compte : 409", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const bob = await createUser(b.t.base, "bob", "mdp-bob-123");
      expect((await preparer(alice, "ALICE", { waiver: true })).json()).toMatchObject({ waiver: true });
      expect((await preparer(bob, "alice")).statusCode).toBe(409);
      expect((await preparer(alice, "autre")).statusCode).toBe(409);
      expect(await lignes()).toHaveLength(1);
    });

    it("compte inconnu : 404 ; compte déjà rattaché : 409 ; identifiant vide, trop long ou à caractère de contrôle : 400", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      expect((await preparer(99_999, "x")).statusCode).toBe(404);
      await lier([{ user_id: jean, subject: UUID(1) }]);
      expect((await preparer(jean, "jean")).statusCode).toBe(409);
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      for (const attendu of ["", "x".repeat(257), "a\u0000b", " alice"])
        expect((await preparer(alice, attendu)).statusCode, JSON.stringify(attendu)).toBe(400);
    });

    it("une ligne périmée est purgée à la lecture et ne bloque plus l'identifiant", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const bob = await createUser(b.t.base, "bob", "mdp-bob-123");
      await preparer(alice, "alice");
      await b.t.base.run("UPDATE auth_prelinks SET expires_at=1.0");
      expect(((await appeler("GET", prelinks)).json() as { items: unknown[] }).items).toEqual([]);
      expect(await lignes()).toEqual([]);
      await preparer(alice, "alice");
      await b.t.base.run("UPDATE auth_prelinks SET expires_at=1.0");
      expect((await preparer(bob, "alice")).statusCode).toBe(200);
      expect((await lignes()).map((l) => l["user_id"])).toEqual([bob]);
    });

    it("suppression : la ligne disparaît (audit), une ligne inconnue ou d'un autre fournisseur : 404 ; la suppression du compte retire ses lignes", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const { id } = (await preparer(alice, "alice")).json() as { id: number };
      expect((await appeler("DELETE", `${prelinks}/${id + 100}`)).statusCode).toBe(404);
      expect(
        (await appeler("DELETE", `/api/admin/auth/providers/${ID_RATTACHE}/prelinks/${id}`)).statusCode,
      ).toBe(409);
      expect((await appeler("DELETE", `${prelinks}/${id}`)).json()).toEqual({ ok: true });
      expect(await lignes()).toEqual([]);
      expect(audits("auth.prelink.delete")[0]).toMatchObject({
        details: { target_user_id: alice, provider_id: "sso" },
      });
      await preparer(alice, "alice");
      const { deleteUserFull } = await import("../src/comptes/suppression");
      await deleteUserFull(b.t.base, alice);
      expect(await lignes()).toEqual([]);
    });
  });

  describe("assistant : contrôles de la relecture", () => {
    const jeton = (uid: number) =>
      b.t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
        [uid, "api", "t", `h-${uid}-${Math.random()}`, "", "", 1],
      );
    const nbJetons = async (uid: number): Promise<number> =>
      Number((await b.t.base.valeurs("SELECT COUNT(*) FROM tool_tokens WHERE user_id=?", [uid]))[0]?.[0]);

    it("entrée que la connexion ne retrouverait pas (identifiant ambigu) : entry_not_loginable, rien d'écrit, refus audité", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      annuaire.ajouter({ uid: "jean", cle: UUID(9), mdp: MDP, groupes: [GROUPE] });
      const r = await lier([{ user_id: jean, subject: UUID(1) }]);
      expect(resultats(r)).toEqual(["entry_not_loginable"]);
      expect(await identites()).toEqual([]);
      expect((await compte("jean"))?.["pass_hash"]).not.toBe("!");
      expect(audits("auth.identity.link")[0]).toMatchObject({
        outcome: "failure",
        details: { reason: "entry_not_loginable", target_user_id: jean },
      });
    });

    it("un modérateur exige la même confirmation qu'un administrateur", async () => {
      const mo = await createUser(b.t.base, "mo", "mdp-mo-1234", { isAdmin: 2 });
      annuaire.ajouter({ uid: "mo", cle: UUID(6), mdp: MDP, groupes: [GROUPE] });
      expect(resultats(await lier([{ user_id: mo, subject: UUID(6) }]))).toEqual([
        "admin_confirmation_required",
      ]);
      expect(await identites()).toEqual([]);
      expect(resultats(await lier([{ user_id: mo, subject: UUID(6) }], [mo]))).toEqual(["linked"]);
      expect(Number((await compte("mo"))?.["is_admin"])).toBe(2);
    });

    it("jetons d'API et accès OAuth révoqués par le rattachement (nombres rendus et audités) ; keep_tokens les garde (kept)", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      const paul = await createUser(b.t.base, "paul", "mdp-local-2");
      await jeton(jean);
      await jeton(jean);
      await jeton(paul);
      const r1 = await lier([{ user_id: jean, subject: UUID(1) }]);
      expect(r1.json()).toMatchObject({
        results: [{ result: "linked", revoked_tokens: 2, revoked_oauth: 0 }],
        kept_tokens: false,
      });
      expect(await nbJetons(jean)).toBe(0);
      expect(audits("auth.identity.link")[0]).toMatchObject({
        details: { method: "assistant", subject: UUID(1), revoked_tokens: 2, revoked_oauth: 0 },
      });
      const r2 = await lier([{ user_id: paul, subject: UUID(2) }], [], true);
      expect(r2.json()).toMatchObject({ results: [{ result: "linked", kept: true }], kept_tokens: true });
      expect(await nbJetons(paul)).toBe(1);
      expect(audits("auth.identity.link")[0]).toMatchObject({ details: { kept: true } });
    });

    it("annuaire éteint pendant le lot : le lien en cours et les suivants sont refusés (directory_unavailable), le précédent reste lié", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      const paul = await createUser(b.t.base, "paul", "mdp-local-2");
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      annuaire.ajouter({ uid: "alice", cle: UUID(7), mdp: MDP, groupes: [GROUPE] });
      const f = b.fournisseurs[0];
      let lectures = 0;
      const pousser = annuaire.recherches.push.bind(annuaire.recherches);
      annuaire.recherches.push = (...e: string[]): number => {
        if (/entryUUID=/u.test(e[0] ?? "") && ++lectures === 2)
          b.cfg.ecrire({ auth: { providers: [{ ...f, enabled: false }] } });
        return pousser(...e);
      };
      const r = await lier([
        { user_id: jean, subject: UUID(1) },
        { user_id: paul, subject: UUID(2) },
        { user_id: alice, subject: UUID(7) },
      ]);
      expect(resultats(r)).toEqual(["linked", "directory_unavailable", "directory_unavailable"]);
      expect((await identites()).map((i) => i["user_id"])).toEqual([jean]);
      expect((await compte("paul"))?.["pass_hash"]).not.toBe("!");
    });
  });

  describe("session cohérente avec l'état du compte", () => {
    const deps = () => ({ ...dependancesParDefaut(b.t.base), sessionAdmise });
    const session = (uid: number, methode: "password" | "ldap:annuaire"): Session => {
      const s = new Session();
      ouvrirSession(s, { uid, methode, maintenant: Date.now() / 1000 + 120, dureeMax: 3600 });
      return s;
    };
    const utilisable = async (s: Session, uid: number): Promise<boolean> =>
      (await validerSession(s, uid, dependancesSession(deps()))).valide &&
      (await revaliderFlux(deps(), uid, s.get("_login_ts"), s.get("_sid"), metaSession(s)));
    const effets = {
      maintenant: () => Date.now() / 1000 + 60,
      dureeMax: () => 3600,
    };

    it("mot de passe vérifié avant le rattachement : aucune session ouverte ni forgée n'est utilisable ensuite", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      expect(await verifyUser(b.t.base, "jean", "mdp-local-1")).toBe(jean);
      expect(await utilisable(session(jean, "password"), jean)).toBe(true);
      expect(resultats(await lier([{ user_id: jean, subject: UUID(1) }]))).toEqual(["linked"]);
      await expect(
        etablirConnexion(
          { base: b.t.base, ...effets },
          {
            session: new Session(),
            uid: jean,
            username: "jean",
            methode: "password",
            ip: "1.1.1.1",
            userAgent: null,
          },
        ),
      ).rejects.toBeInstanceOf(ConnexionRefusee);
      expect(await utilisable(session(jean, "password"), jean)).toBe(false);
      expect(await utilisable(session(jean, "ldap:annuaire"), jean)).toBe(true);
    });

    it("session d'annuaire ouverte autour d'un détachement : refusée ensuite, la session par mot de passe redevient la bonne", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      expect(resultats(await lier([{ user_id: jean, subject: UUID(1) }]))).toEqual(["linked"]);
      const r = await appeler("POST", `/api/admin/users/${jean}/identity/detach`, {
        new_password: "Mdp-Temporaire-9",
      });
      expect(r.statusCode).toBe(200);
      await expect(
        etablirConnexion(
          { base: b.t.base, ...effets },
          {
            session: new Session(),
            uid: jean,
            username: "jean",
            methode: "ldap:annuaire",
            ip: "1.1.1.1",
            userAgent: null,
          },
        ),
      ).rejects.toBeInstanceOf(ConnexionRefusee);
      expect(await utilisable(session(jean, "ldap:annuaire"), jean)).toBe(false);
      expect(await utilisable(session(jean, "password"), jean)).toBe(true);
    });

    it("détachement : jetons d'API supprimés dans l'écriture, audit écrit", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      expect(resultats(await lier([{ user_id: jean, subject: UUID(1) }], [], true))).toEqual(["linked"]);
      await b.t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
        [jean, "api", "t", "h-detach", "", "", 1],
      );
      const r = await appeler("POST", `/api/admin/users/${jean}/identity/detach`, {
        new_password: "Mdp-Temporaire-9",
      });
      expect(r.statusCode).toBe(200);
      expect(await b.t.base.valeurs("SELECT 1 FROM tool_tokens WHERE user_id=?", [jean])).toEqual([]);
      expect(audits("auth.identity.unlink")[0]).toMatchObject({ details: { target_user_id: jean } });
    });
  });
});
