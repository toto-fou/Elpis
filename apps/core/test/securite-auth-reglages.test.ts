// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-reglages.test.ts — la section `auth` de config.json n'est écrite que par ses routes (jamais créée ni écrasée par l'éditeur générique), aucune route ne rend un secret, les routes du coffre ne voient pas les secrets `auth-*`, l'activation exige chaque prérequis, un modérateur est refusé partout. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleAdminConfig } from "../src/familles/admin-config";
import { creerFamilleAdminIdentite } from "../src/familles/admin-identite";
import { creerFamilleSecrets } from "../src/familles/secrets";
import { enregistrerTestReussi } from "../src/identite/fournisseurs";
import { validerFournisseur } from "../src/identite/reglages";
import { appTest, journalMuet, lignesAuditRecentes } from "./aides";
import { cleCoffreDeTest, configDeTest, ldapValide, oidcValide } from "./identite/aides";
import type { ConfigDeTest } from "./identite/aides";

const URL_PUBLIQUE = "https://elpis.exemple.lan";
const MOT_DE_PASSE_SERVICE = "mot-de-passe-de-service-tres-secret";

describe("connexion d'entreprise : réglages, secrets, droits (SQLite)", () => {
  let t: BaseDeTest;
  let cfg: ConfigDeTest;
  let dossier: string;
  let admin: FastifyInstance;
  let principal: FastifyInstance;
  let chef = 0;
  let modo = 0;
  let alice = 0;
  let cookieSecure = true;
  const revoques: number[] = [];

  const role = async (req: FastifyRequest, roles: number[], message: string): Promise<void> => {
    const uid = req.headers["x-uid"];
    if (!uid) throw new HttpError(401, "not logged in");
    const ligne = await ligneUtilisateur(t.base, Number(uid));
    req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
    if (!ligne || !roles.includes(Number(ligne.is_admin))) throw new HttpError(403, message);
  };

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    cleCoffreDeTest();
    cfg = configDeTest({ https: true });
    dossier = mkdtempSync(join(tmpdir(), "elpis-securite-auth-"));
    configureAudit({
      service: "admin",
      auditDir: join(dossier, "audit"),
      hmacKeyPath: join(dossier, "sans-cle"),
    });
    chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    modo = await createUser(t.base, "modo", "mdp-modo-1", { isAdmin: 2 });
    alice = await createUser(t.base, "alice", "mdp-alice-1");
    const auth = {
      ...dependancesParDefaut(t.base),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax" as const,
        https_only: cookieSecure,
        max_age: 86_400,
      }),
    };
    const gardes = {
      admin: (req: FastifyRequest) => role(req, [1], "Admin required"),
      staff: (req: FastifyRequest) => role(req, [1, 2], "Staff required"),
      session: (req: FastifyRequest) => role(req, [0, 1, 2], "login"),
      service: async () => {
        throw new HttpError(403, "service");
      },
    };
    admin = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminIdentite({
          base: t.base,
          auth,
          journal: journalMuet,
          revoquer: async (uid) => void revoques.push(uid),
        }),
        creerFamilleAdminConfig({ journal: journalMuet, fermerClientCompression: async () => undefined }),
        creerFamilleSecrets({ base: t.base, auth }),
      ],
      gardes,
    });
    principal = await appTest({
      mode: "main",
      familles: [creerFamilleSecrets({ base: t.base, auth })],
      gardes,
    });
  });

  afterAll(async () => {
    await admin.close();
    await principal.close();
    oublierConfigurationAudit();
    cfg.fermer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const appeler = (
    app: FastifyInstance,
    methode: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    url: string,
    uid: number,
    corps?: unknown,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method: methode,
      url,
      headers: { "x-uid": String(uid) },
      ...(corps === undefined ? {} : { payload: corps as object }),
    });
  const lireConfig = (): Record<string, unknown> =>
    existsSync(cfg.chemin) ? (JSON.parse(readFileSync(cfg.chemin, "utf8")) as Record<string, unknown>) : {};
  const fichier = (): string => (existsSync(cfg.chemin) ? readFileSync(cfg.chemin, "utf8") : "");

  describe("l'éditeur générique de configuration ne touche pas à `auth`", () => {
    const enregistrerFichier = (contenu: unknown): Promise<{ statusCode: number }> =>
      appeler(admin, "POST", "/api/admin/config-file", chef, {
        type: "main",
        content: JSON.stringify(contenu),
      });

    it("instance sans section `auth` : une section apportée par le formulaire n'est pas créée", async () => {
      cfg.ecrire({ app: { nom: "x" } });
      const r = await enregistrerFichier({
        app: { nom: "y" },
        auth: {
          public_url: URL_PUBLIQUE,
          local: { mode: "admins" },
          providers: [ldapValide({ enabled: true })],
        },
      });
      expect(r.statusCode).toBe(200);
      expect(lireConfig()).toEqual({ app: { nom: "y" } });
    });

    it("instance sans fichier : pas de section non plus", async () => {
      cfg.ecrire(null);
      expect((await enregistrerFichier({ auth: { public_url: URL_PUBLIQUE } })).statusCode).toBe(200);
      expect(lireConfig()["auth"]).toBeUndefined();
    });

    it("section présente : la valeur du disque gagne, absente du formulaire elle est gardée", async () => {
      const disque = { public_url: URL_PUBLIQUE, local: { mode: "all" }, providers: [ldapValide()] };
      cfg.ecrire({ app: {}, auth: disque });
      await enregistrerFichier({ app: {}, auth: { local: { mode: "admins" }, providers: [] } });
      expect(lireConfig()["auth"]).toEqual(disque);
      await enregistrerFichier({ app: {} });
      expect(lireConfig()["auth"]).toEqual(disque);
    });

    it("PATCH champ par champ : tout chemin sous `auth` est refusé, rien n'est écrit", async () => {
      cfg.ecrire({ app: {} });
      for (const chemin of ["auth", "auth.local.mode", "auth.providers", "auth.public_url"]) {
        const r = await appeler(admin, "PATCH", "/api/admin/config", chef, {
          changes: [{ path: chemin, to: "x" }],
          force: true,
        });
        expect(r.statusCode, chemin).toBe(400);
      }
      expect(lireConfig()).toEqual({ app: {} });
    });
  });

  describe("routes de la console", () => {
    const ROUTES: [string, string][] = [
      ["GET", "/api/admin/auth"],
      ["PUT", "/api/admin/auth/settings"],
      ["POST", "/api/admin/auth/providers"],
      ["PUT", "/api/admin/auth/providers/annuaire"],
      ["DELETE", "/api/admin/auth/providers/annuaire"],
      ["PUT", "/api/admin/auth/providers/annuaire/secret"],
      ["POST", "/api/admin/auth/providers/annuaire/enable"],
      ["POST", "/api/admin/auth/providers/annuaire/disable"],
      ["POST", "/api/admin/auth/providers/test"],
    ];

    it("chaque route : modérateur 403, simple compte 403, sans session 401, et rien n'est écrit", async () => {
      cfg.ecrire(null);
      for (const [m, u] of ROUTES) {
        const corps = m === "GET" || m === "DELETE" ? undefined : {};
        for (const [uid, attendu] of [
          [modo, 403],
          [alice, 403],
        ] as const)
          expect((await appeler(admin, m as "GET", u, uid, corps)).statusCode, `${m} ${u} ${uid}`).toBe(
            attendu,
          );
        const sans = await admin.inject({
          method: m as "GET",
          url: u,
          ...(corps === undefined ? {} : { payload: corps }),
        });
        expect(sans.statusCode, `${m} ${u} sans session`).toBe(401);
      }
      expect(existsSync(cfg.chemin)).toBe(false);
    });

    it("toutes les routes de la famille sont réservées au processus console et à l'administrateur", () => {
      const f = creerFamilleAdminIdentite({
        base: t.base,
        auth: dependancesParDefaut(t.base),
        journal: journalMuet,
        revoquer: async () => undefined,
      });
      expect(f.routes.map((r) => `${r.methode} ${r.chemin}`).sort()).toEqual(
        ROUTES.map(([m, u]) => `${m} ${u.replace("annuaire", ":id")}`).sort(),
      );
      for (const r of f.routes) expect([r.acces, r.processus], r.chemin).toEqual(["admin", ["admin"]]);
    });

    it("création, secret, lecture : le secret n'est jamais renvoyé ni écrit dans config.json ni au journal", async () => {
      cfg.ecrire(null);
      const brut = ldapValide({ required_groups: ["cn=elpis"] });
      const cree = await appeler(admin, "POST", "/api/admin/auth/providers", chef, brut);
      expect(cree.statusCode, cree.body).toBe(200);
      expect(
        cree.json<{ providers: { id: string; enabled: boolean; has_secret: boolean }[] }>().providers,
      ).toMatchObject([{ id: "annuaire", enabled: false, has_secret: false }]);
      const pose = await appeler(admin, "PUT", "/api/admin/auth/providers/annuaire/secret", chef, {
        secret: MOT_DE_PASSE_SERVICE,
      });
      expect(pose.statusCode, pose.body).toBe(200);
      expect(pose.json<{ providers: { has_secret: boolean }[] }>().providers[0]?.has_secret).toBe(true);
      const lecture = await appeler(admin, "GET", "/api/admin/auth", chef);
      const audit = lignesAuditRecentes({ limit: 500 })
        .map((l) => JSON.stringify(l))
        .join("\n");
      const sorties = [cree.body, pose.body, lecture.body, fichier(), audit];
      for (const s of sorties) expect(s).not.toContain(MOT_DE_PASSE_SERVICE);
      const actions = lignesAuditRecentes({ actionPrefix: "admin.auth." }).map((l) => l["action"]);
      expect(actions).toEqual(
        expect.arrayContaining(["admin.auth.provider.create", "admin.auth.provider.secret"]),
      );
      expect(JSON.stringify(lireConfig())).not.toMatch(/password|secret/iu);
    });

    it("secret : texte vide supprime, valeur trop longue ou mauvais type refusés", async () => {
      const url = "/api/admin/auth/providers/annuaire/secret";
      expect((await appeler(admin, "PUT", url, chef, { secret: "x".repeat(16_385) })).statusCode).toBe(400);
      expect((await appeler(admin, "PUT", url, chef, { secret: 12 })).statusCode).toBe(400);
      expect((await appeler(admin, "PUT", url, chef, { secret: "x", autre: 1 })).statusCode).toBe(400);
      expect(
        (await appeler(admin, "PUT", "/api/admin/auth/providers/inconnu/secret", chef, { secret: "x" }))
          .statusCode,
      ).toBe(404);
      const r = await appeler(admin, "PUT", url, chef, { secret: "" });
      expect(r.json<{ providers: { has_secret: boolean }[] }>().providers[0]?.has_secret).toBe(false);
      await appeler(admin, "PUT", url, chef, { secret: MOT_DE_PASSE_SERVICE });
    });

    it("les routes ordinaires du coffre ne voient pas, ne changent pas, ne suppriment pas le secret d'instance `auth-*` ; un secret personnel peut porter ce nom", async () => {
      const ligne = await t.base.get<{ id: number }>(
        "SELECT id FROM vault_secrets WHERE name='auth-annuaire'",
      );
      expect(ligne).toBeDefined();
      const id = ligne?.id ?? 0;
      const liste = await appeler(admin, "GET", "/api/admin/secrets", chef);
      expect(liste.body).not.toContain("auth-annuaire");
      expect(liste.statusCode).toBe(200);
      expect(
        (await appeler(admin, "POST", `/api/admin/secrets/${id}/rotate`, chef, { value: "autre" }))
          .statusCode,
      ).toBe(404);
      expect((await appeler(admin, "DELETE", `/api/admin/secrets/${id}`, chef)).statusCode).toBe(404);
      for (const nom of ["auth-annuaire", "auth-x", "auth-"]) {
        const cree = await appeler(principal, "POST", "/api/secrets", alice, {
          name: nom,
          kind: "token",
          value: "v",
        });
        expect(cree.statusCode, nom).toBe(200);
      }
      const perso = await appeler(principal, "POST", "/api/secrets", alice, {
        name: "perso",
        kind: "token",
        value: "v",
      });
      const idPerso = perso.json<{ secret: { id: number } }>().secret.id;
      const renomme = await appeler(principal, "PUT", `/api/secrets/${idPerso}`, alice, {
        name: "auth-perso",
      });
      expect(renomme.statusCode).toBe(200);
      expect(
        await t.base.valeurs(
          "SELECT COUNT(*) FROM vault_secrets WHERE name='auth-annuaire' AND user_id IS NULL",
        ),
      ).toEqual([[1]]);
      for (const url of [`/api/secrets/${id}`]) {
        expect((await appeler(principal, "PUT", url, alice, { value: "autre" })).statusCode).toBe(404);
        expect((await appeler(principal, "DELETE", url, alice)).statusCode).toBe(404);
      }
      const chiffre = await t.base.get<{ secret_enc: string }>(
        "SELECT secret_enc FROM vault_secrets WHERE id=?",
        [id],
      );
      expect(chiffre?.secret_enc).toBeTruthy();
      expect(lireConfig()).toBeDefined();
    });

    it("activation : refusée un prérequis après l'autre, acceptée quand tous tiennent ; extinction toujours permise", async () => {
      const f = validerFournisseur(ldapValide({ required_groups: [] }));
      const activer = (): Promise<LightMyRequestResponse> =>
        appeler(admin, "POST", "/api/admin/auth/providers/annuaire/enable", chef);
      const motif = async (): Promise<string> => (await activer()).json<{ detail: string }>().detail;
      cfg.ecrire({ auth: { public_url: "", providers: [f] } });
      expect(await motif()).toMatch(/adresse publique/u);
      cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [f] } });
      cookieSecure = false;
      expect(await motif()).toMatch(/https/u);
      cookieSecure = true;
      await t.base.run("UPDATE users SET suspended_at=1 WHERE id=?", [chef]);
      const adminLocal = await activer();
      await t.base.run("UPDATE users SET suspended_at=0 WHERE id=?", [chef]);
      expect([adminLocal.statusCode, adminLocal.json<{ detail: string }>().detail]).toEqual([
        409,
        expect.stringMatching(/administrateur/u),
      ]);
      expect(await motif()).toMatch(/groupe/u);
      const avecGroupe = validerFournisseur(ldapValide({ required_groups: ["cn=elpis"] }));
      cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [avecGroupe] } });
      await t.base.run("DELETE FROM vault_secrets WHERE name='auth-annuaire'");
      expect(await motif()).toMatch(/secret/u);
      await appeler(admin, "PUT", "/api/admin/auth/providers/annuaire/secret", chef, {
        secret: MOT_DE_PASSE_SERVICE,
      });
      expect(await motif()).toMatch(/test réussi/u);
      await enregistrerTestReussi(t.base, avecGroupe, URL_PUBLIQUE);
      const ok = await activer();
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json<{ providers: { enabled: boolean; active: boolean }[] }>().providers[0]).toMatchObject({
        enabled: true,
        active: true,
      });
      expect(
        ((lireConfig()["auth"] as { providers: { enabled: boolean }[] }).providers[0] as { enabled: boolean })
          .enabled,
      ).toBe(true);
      expect(lignesAuditRecentes({ actionPrefix: "admin.auth.provider.enable" })).toHaveLength(1);
    });

    it("fournisseur allumé : réglages sensibles et adresse publique verrouillés, libellé libre ; ni suppression ni double activation", async () => {
      const mettre = (corps: unknown): Promise<{ statusCode: number }> =>
        appeler(admin, "PUT", "/api/admin/auth/providers/annuaire", chef, corps);
      expect((await mettre({ bind_dn: "uid=x,dc=y" })).statusCode).toBe(409);
      expect((await mettre({ required_groups: [] })).statusCode).toBe(409);
      expect((await mettre({ label: "Nouveau nom", freshness_days: 20 })).statusCode).toBe(200);
      expect((await mettre({ enabled: false })).statusCode).toBe(400);
      expect((await appeler(admin, "DELETE", "/api/admin/auth/providers/annuaire", chef)).statusCode).toBe(
        409,
      );
      expect(
        (
          await appeler(admin, "PUT", "/api/admin/auth/settings", chef, {
            public_url: "https://autre.exemple.lan",
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await appeler(admin, "PUT", "/api/admin/auth/settings", chef, { public_url: URL_PUBLIQUE }))
          .statusCode,
      ).toBe(200);
    });

    it("extinction : coupe les sessions des comptes rattachés (plancher monté, flux fermés), pas des autres", async () => {
      await t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
        [alice, "annuaire", "s-alice", "i", "admin", 1],
      );
      revoques.length = 0;
      const r = await appeler(admin, "POST", "/api/admin/auth/providers/annuaire/disable", chef);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<{ providers: { enabled: boolean; identities: number }[] }>().providers[0]).toMatchObject({
        enabled: false,
        identities: 1,
      });
      expect(revoques).toEqual([alice]);
      const min = async (u: number): Promise<number> =>
        Number((await t.base.valeurs("SELECT session_min_ts FROM users WHERE id=?", [u]))[0]?.[0]);
      expect(await min(alice)).toBeGreaterThan(1_700_000_000);
      expect(await min(chef)).toBe(0);
      const ev = lignesAuditRecentes({ actionPrefix: "admin.auth.provider.disable" })[0];
      expect(ev?.["details"]).toMatchObject({ provider_id: "annuaire", sessions_cut: 1 });
      expect(
        ((lireConfig()["auth"] as { providers: { enabled: boolean }[] }).providers[0] as { enabled: boolean })
          .enabled,
      ).toBe(false);
    });

    it("fournisseur avec des comptes rattachés : champs figés, suppression refusée ; sans compte : supprimé avec son secret et son état", async () => {
      const mettre = (corps: unknown): Promise<{ statusCode: number }> =>
        appeler(admin, "PUT", "/api/admin/auth/providers/annuaire", chef, corps);
      expect((await mettre({ attrs: { id: "ipaUniqueID" } })).statusCode).toBe(409);
      expect(
        (await mettre({ attrs: { username: "sAMAccountName" }, user_filter: "(cn={username})" })).statusCode,
      ).toBe(200);
      expect((await appeler(admin, "DELETE", "/api/admin/auth/providers/annuaire", chef)).statusCode).toBe(
        409,
      );
      await t.base.run("DELETE FROM user_identities WHERE user_id=?", [alice]);
      expect((await mettre({ attrs: { id: "ipaUniqueID" } })).statusCode).toBe(200);
      const r = await appeler(admin, "DELETE", "/api/admin/auth/providers/annuaire", chef);
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true }]);
      expect(
        await t.base.get("SELECT 1 AS un FROM vault_secrets WHERE name='auth-annuaire'"),
      ).toBeUndefined();
      expect(
        await t.base.get("SELECT 1 AS un FROM auth_provider_state WHERE provider_id='annuaire'"),
      ).toBeUndefined();
      expect((lireConfig()["auth"] as { providers: unknown[] }).providers).toEqual([]);
    });

    it("champs figés d'un fournisseur OIDC : émetteur, client et revendication de sujet", async () => {
      expect(
        (
          await appeler(
            admin,
            "POST",
            "/api/admin/auth/providers",
            chef,
            oidcValide({ required_groups: ["cn=a"] }),
          )
        ).statusCode,
      ).toBe(200);
      const mettre = (corps: unknown): Promise<{ statusCode: number }> =>
        appeler(admin, "PUT", "/api/admin/auth/providers/sso", chef, corps);
      expect((await mettre({ issuer: "https://autre.exemple.lan" })).statusCode).toBe(200);
      await t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
        [alice, "sso", "s-alice", "i", "admin", 1],
      );
      for (const corps of [
        { issuer: "https://idp.exemple.lan" },
        { client_id: "autre" },
        { subject_claim: "oid" },
      ])
        expect((await mettre(corps)).statusCode, JSON.stringify(corps)).toBe(409);
      expect((await mettre({ username_claim: "upn", name_claim: "nom" })).statusCode).toBe(200);
      await t.base.run("DELETE FROM user_identities WHERE user_id=?", [alice]);
    });

    it("rattachements préparés d'un fournisseur OIDC : supprimés avec lui, ou quand son émetteur, son client ou sa revendication d'identifiant change", async () => {
      cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
      expect(
        (
          await appeler(
            admin,
            "POST",
            "/api/admin/auth/providers",
            chef,
            oidcValide({ id: "sso", required_groups: ["cn=a"] }),
          )
        ).statusCode,
      ).toBe(200);
      const poser = (): Promise<unknown> =>
        t.base.run(
          "INSERT INTO auth_prelinks(user_id, provider_id, expected, waiver, created_by, created_at, expires_at, issuer, admin_confirmed, attempts) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [alice, "sso", "alice", 0, chef, 1, 9e9, "oidc:https://idp.exemple.lan", 0, 0],
        );
      const restantes = (): Promise<unknown[][]> =>
        t.base.valeurs("SELECT id FROM auth_prelinks WHERE provider_id='sso'");
      const mettre = (corps: unknown): Promise<{ statusCode: number }> =>
        appeler(admin, "PUT", "/api/admin/auth/providers/sso", chef, corps);
      await poser();
      expect((await mettre({ required_groups: ["cn=b"] })).statusCode).toBe(200);
      expect(await restantes()).toHaveLength(1);
      expect((await mettre({ issuer: "https://autre.exemple.lan" })).statusCode).toBe(200);
      expect(await restantes()).toEqual([]);
      await poser();
      expect((await mettre({ client_id: "autre-client" })).statusCode).toBe(200);
      expect(await restantes()).toEqual([]);
      await poser();
      expect((await mettre({ username_claim: "upn" })).statusCode).toBe(200);
      expect(await restantes()).toEqual([]);
      await poser();
      expect((await appeler(admin, "DELETE", "/api/admin/auth/providers/sso", chef)).statusCode).toBe(200);
      expect(await restantes()).toEqual([]);
    });

    it("créations : doublon d'id 409, sixième fournisseur 400, corps invalide 400 sans rien écrire", async () => {
      cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
      expect(
        (
          await appeler(
            admin,
            "POST",
            "/api/admin/auth/providers",
            chef,
            ldapValide({ id: "p1", urls: ["ldap://x.lan"] }),
          )
        ).statusCode,
      ).toBe(400);
      for (let i = 1; i <= 5; i++)
        expect(
          (await appeler(admin, "POST", "/api/admin/auth/providers", chef, ldapValide({ id: `p${i}` })))
            .statusCode,
        ).toBe(200);
      expect(
        (await appeler(admin, "POST", "/api/admin/auth/providers", chef, ldapValide({ id: "p6" })))
          .statusCode,
      ).toBe(400);
      expect((await appeler(admin, "DELETE", "/api/admin/auth/providers/p5", chef)).statusCode).toBe(200);
      expect(
        (await appeler(admin, "POST", "/api/admin/auth/providers", chef, ldapValide({ id: "p1" })))
          .statusCode,
      ).toBe(409);
      expect((lireConfig()["auth"] as { providers: unknown[] }).providers).toHaveLength(4);
    });

    it("réglages généraux : section créée et journalisée ; mode `admins` refusé sans administrateur local, accepté avec", async () => {
      cfg.ecrire({ app: {} });
      const r = await appeler(admin, "PUT", "/api/admin/auth/settings", chef, {
        public_url: `${URL_PUBLIQUE}/`,
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(lireConfig()["auth"]).toEqual({
        public_url: URL_PUBLIQUE,
        local: { mode: "all" },
        providers: [],
      });
      expect(lignesAuditRecentes({ actionPrefix: "admin.auth.settings" })).not.toHaveLength(0);
      expect(
        (await appeler(admin, "PUT", "/api/admin/auth/settings", chef, { public_url: "http://elpis.lan" }))
          .statusCode,
      ).toBe(400);
      expect(
        (await appeler(admin, "PUT", "/api/admin/auth/settings", chef, { local: { mode: "x" } })).statusCode,
      ).toBe(400);
      expect(
        (await appeler(admin, "PUT", "/api/admin/auth/settings", chef, { providers: [] })).statusCode,
      ).toBe(400);
      const hash =
        (await t.base.get<{ pass_hash: string }>("SELECT pass_hash FROM users WHERE id=?", [chef]))
          ?.pass_hash ?? "";
      await t.base.run("UPDATE users SET pass_hash='!' WHERE id=?", [chef]);
      const refus = await appeler(admin, "PUT", "/api/admin/auth/settings", chef, {
        local: { mode: "admins" },
      });
      await t.base.run("UPDATE users SET pass_hash=? WHERE id=?", [hash, chef]);
      expect(refus.statusCode).toBe(409);
      expect((lireConfig()["auth"] as { local: { mode: string } }).local.mode).toBe("all");
      const ok = await appeler(admin, "PUT", "/api/admin/auth/settings", chef, { local: { mode: "admins" } });
      expect([ok.statusCode, ok.json<{ local: { mode: string } }>().local.mode]).toEqual([200, "admins"]);
      expect((lireConfig()["auth"] as { local: { mode: string } }).local.mode).toBe("admins");
    });
  });
});
