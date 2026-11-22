// SPDX-License-Identifier: MIT
/** apps/core/test/securite-rattachement.test.ts — détachement d'un compte de son identité externe (mot de passe temporaire, sessions et accès d'avant coupés), droits de l'administrateur seul, rattachements préparés d'un fournisseur OIDC, session cohérente avec l'état du compte (SQLite, PostgreSQL si ELPIS_TEST_PG). */
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
import { ancreIdentite } from "../src/identite/ancre";
import { rattacher } from "../src/identite/rattachement";
import { sessionAdmise } from "../src/identite/session";
import { MOTEURS } from "./identite/banc";
import { ouvrirBancFournisseur, URL_PUBLIQUE } from "./identite/banc-fournisseur";
import type { BancFournisseur } from "./identite/banc-fournisseur";
import { appTest, journalMuet, lignesAuditRecentes } from "./aides";

const ID_RATTACHE = "sso";

describe.each(MOTEURS)("rattachement et détachement des comptes (%s)", (moteur) => {
  let b: BancFournisseur;
  let admin: FastifyInstance;
  let main: FastifyInstance;
  let racine: string;
  let audit: string;
  let revoques: number[];
  let chef: number;

  const ouvrir = async (): Promise<void> => {
    b = await ouvrirBancFournisseur(moteur);
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
    main = await appTest({ ...(await composer("main", b.t.base, journalMuet, dep, racine)) });
  };

  /** Rattache le compte à une identité du fournisseur (mot de passe local retiré, sessions d'avant coupées), comme une connexion SSO prouvée. */
  const lier = async (uid: number, sujet: string, confirmeAdmin = false): Promise<void> => {
    const refus = await b.t.base.ecriture((x) =>
      rattacher(
        x,
        uid,
        {
          fournisseurId: ID_RATTACHE,
          subject: sujet,
          issuer: ancreIdentite(b.fournisseurs[0] as never),
          extUsername: sujet,
        },
        { par: "auto", confirmeAdmin, t: Date.now() / 1000 },
      ),
    );
    expect(refus).toBeNull();
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

  describe("détachement", () => {
    const detacher = (cible: number, corps: unknown = { new_password: "Temporaire-Mdp-9" }, uid = chef) =>
      appeler("POST", `/api/admin/users/${cible}/identity/detach`, corps, uid);

    it("sans mot de passe valide : refus, le compte reste rattaché", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await lier(jean, "jean");
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
      const ouverte = cookie(await connexion("jean", "mdp-local-1"));
      expect((await moi(ouverte))["logged_in"]).toBe(true);
      await lier(jean, "jean");
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
      expect((await connexion("jean", "mdp-local-1", "10.0.0.10")).statusCode).toBe(401);
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
      await lier(jean, "jean");
      await detacher(jean);
      await lier(jeanne, "jean");
      expect((await identites()).map((i) => i["user_id"])).toEqual([jeanne]);
    });
  });

  describe("droits : l'administrateur seul", () => {
    it("un modérateur, un utilisateur et un visiteur : 403 ou 401 partout, rien d'écrit", async () => {
      const modo = await createUser(b.t.base, "modo", "mdp-modo-12", { isAdmin: 2 });
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const appels: ["GET" | "POST" | "DELETE", string, unknown?][] = [
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

    it("création : identifiant normalisé, échéance à 30 jours, auteur, audit ; liste avec le nom du compte", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const avant = Date.now() / 1000;
      expect((await preparer(alice, "Alice.Ｄupont@Exemple.LAN")).statusCode).toBe(400);
      const r = await preparer(alice, "Alice.Dupont@Exemple.LAN");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        username: "alice",
        expected: "alice.dupont@exemple.lan",
        waiver: false,
      });
      const [l] = await lignes();
      expect(l).toMatchObject({ user_id: alice, created_by: chef });
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

    it("fournisseur inconnu : 404, rien d'écrit", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      expect(
        (await appeler("POST", "/api/admin/auth/providers/zzz/prelinks", { user_id: alice, expected: "a" }))
          .statusCode,
      ).toBe(404);
      expect((await appeler("GET", "/api/admin/auth/providers/zzz/prelinks")).statusCode).toBe(404);
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
      await lier(jean, "jean");
      expect((await preparer(jean, "jean")).statusCode).toBe(409);
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      for (const attendu of ["", "x".repeat(257), "a\u0000b", " alice"])
        expect((await preparer(alice, attendu)).statusCode, JSON.stringify(attendu)).toBe(400);
    });

    it("une ligne périmée n'est plus listée et ne bloque plus l'identifiant", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const bob = await createUser(b.t.base, "bob", "mdp-bob-123");
      await preparer(alice, "alice");
      await b.t.base.run("UPDATE auth_prelinks SET expires_at=1.0");
      expect(((await appeler("GET", prelinks)).json() as { items: unknown[] }).items).toEqual([]);
      await preparer(alice, "alice");
      await b.t.base.run("UPDATE auth_prelinks SET expires_at=1.0");
      expect((await preparer(bob, "alice")).statusCode).toBe(200);
      expect((await lignes()).map((l) => l["user_id"])).toEqual([bob]);
    });

    it("suppression : la ligne disparaît (audit), une ligne inconnue ou d'un autre fournisseur : 404 ; la suppression du compte retire ses lignes", async () => {
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const { id } = (await preparer(alice, "alice")).json() as { id: number };
      expect((await appeler("DELETE", `${prelinks}/${id + 100}`)).statusCode).toBe(404);
      expect((await appeler("DELETE", `/api/admin/auth/providers/zzz/prelinks/${id}`)).statusCode).toBe(404);
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

  describe("session cohérente avec l'état du compte", () => {
    const deps = () => ({ ...dependancesParDefaut(b.t.base), sessionAdmise });
    const session = (uid: number, methode: "password" | "oidc:sso"): Session => {
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
      await lier(jean, "jean");
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
      expect(await utilisable(session(jean, "oidc:sso"), jean)).toBe(true);
    });

    it("session SSO ouverte autour d'un détachement : refusée ensuite, la session par mot de passe redevient la bonne", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await lier(jean, "jean");
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
            methode: "oidc:sso",
            ip: "1.1.1.1",
            userAgent: null,
          },
        ),
      ).rejects.toBeInstanceOf(ConnexionRefusee);
      expect(await utilisable(session(jean, "oidc:sso"), jean)).toBe(false);
      expect(await utilisable(session(jean, "password"), jean)).toBe(true);
    });

    it("détachement : jetons d'API supprimés dans l'écriture, audit écrit", async () => {
      const jean = await createUser(b.t.base, "jean", "mdp-local-1");
      await lier(jean, "jean");
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
