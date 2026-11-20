// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc.test.ts — la connexion par SSO OIDC ne se laisse pas tromper : jeton signé avec l'algorithme réglé seulement, flux lié au navigateur qui l'a lancé et à usage unique, adresse de retour tirée de la configuration, points d'accès sur l'origine de l'émetteur, tout refus mène à un code fermé et rien du fournisseur n'atteint le navigateur, le journal ou l'audit (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createServer } from "node:net";
import type { Server } from "node:net";

import {
  CODES_ERREUR_CONNEXION,
  schemaHoteNonCanonique,
  schemaReponseConfigPublique,
  schemaReponseDepartOidc,
} from "@elpis/contracts";
import { dechiffrerSecret } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enregistrerSecret, enregistrerTestReussi } from "../src/identite/fournisseurs";
import { empreinteAdresses } from "../src/identite/oidc/flux";
import { lignesAuditRecentes, lignesJournal } from "./aides";
import {
  adresseNeuve,
  COOKIE_LIAISON,
  cookies,
  ELPIS,
  HOTE_PUBLIC,
  ouvrirBancOidc,
  URL_PUBLIQUE,
} from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { MOTEURS } from "./identite/banc";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";
import type { LightMyRequestResponse } from "fastify";

const SECRET_CLIENT = "secret-client-de-test";
const MARQUEUR = "MARQUEUR-DU-FOURNISSEUR";

interface Refus {
  readonly code: string;
  readonly ref: string;
}

/** Redirection d'un refus : `/?auth_error=<code>&ref=<référence>` et rien d'autre, sans session ouverte. */
function refus(r: LightMyRequestResponse): Refus {
  expect(r.statusCode, r.body).toBe(302);
  const l = String(r.headers.location);
  const m = /^\/\?auth_error=([a-z_]+)&ref=([A-Za-z0-9_-]{8})$/u.exec(l);
  expect(m, l).not.toBeNull();
  expect(String(r.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session");
  expect(CODES_ERREUR_CONNEXION as readonly string[]).toContain(m?.[1]);
  return { code: m?.[1] ?? "", ref: m?.[2] ?? "" };
}

function sessionDe(cookie: string): Record<string, unknown> {
  const brut = /(?:^|; )mcpwebui_session=([^;]+)/u.exec(cookie)?.[1] ?? "";
  return (
    JSON.parse(Buffer.from(brut.split(".")[0] ?? "", "base64url").toString("utf8")) as {
      d: Record<string, unknown>;
    }
  ).d;
}

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("connexion par SSO OIDC (%s)", (moteur) => {
  let b: BancOidc;

  const ouvrir = async (o: Parameters<typeof ouvrirBancOidc>[1] = {}): Promise<void> => {
    await b?.fermer().catch(() => undefined);
    b = await ouvrirBancOidc(moteur, o);
  };
  const lignes = (sql: string): Promise<unknown[][]> => b.t.base.valeurs(sql);
  const denies = (): Record<string, unknown>[] => lignesAuditRecentes({ actionPrefix: "auth.login.denied" });
  const intact = async (): Promise<void> => {
    expect(await b.utilisateurs()).toEqual(["chef"]);
    expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
  };

  beforeEach(async () => {
    lignesJournal.length = 0;
    await ouvrir();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await b.fermer();
  });

  describe("parcours nominal", () => {
    it("compte créé, session `oidc:<id>` à échéance figée, ligne de session du fournisseur, page sans script", async () => {
      b.idp.userinfo = null;
      const { retour, session, depart } = await b.connecter(ELPIS("sub-jean", { sid: "idp-session-1" }));
      expect(retour.statusCode, retour.body).toBe(200);
      expect(retour.headers["cache-control"]).toBe("no-store");
      expect(retour.headers["referrer-policy"]).toBe("no-referrer");
      expect(String(retour.headers["content-security-policy"])).toContain("default-src 'none'");
      expect(retour.body).toContain('http-equiv="refresh" content="0;url=/"');
      expect(retour.body).not.toMatch(/<script|onclick|onload|<style/iu);
      expect(retour.body).not.toContain("sub-jean");
      const s = sessionDe(session);
      expect(s["_auth"]).toBe("oidc:sso");
      expect(Number(s["_exp"]) - Number(s["_login_ts"])).toBe(86_400);
      expect(await b.utilisateurs()).toEqual(["chef", "sub-jean"]);
      const moi = await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: session } });
      expect(moi.json()).toMatchObject({ logged_in: true, username: "sub-jean", password_managed: true });
      const ext = await b.t.base.get<Record<string, unknown>>("SELECT * FROM auth_ext_sessions");
      expect(ext).toMatchObject({
        sid: s["_sid"],
        provider_id: "sso",
        idp_sid: "idp-session-1",
        subject: "sub-jean",
      });
      expect(String(ext?.["id_token_enc"])).toMatch(/^v1\./u);
      expect(b.idp.emis).not.toContain(String(ext?.["id_token_enc"]));
      expect(dechiffrerSecret(String(ext?.["id_token_enc"]), `auth-ext-session:${String(s["_sid"])}`)).toBe(
        b.idp.emis[1],
      );
      expect(await b.t.base.get("SELECT issuer FROM user_identities")).toEqual({
        issuer: `oidc:${b.idp.issuer}`,
      });
      expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
      const ev = lignesAuditRecentes({ actionPrefix: "auth.login" }).find(
        (e) => e["action"] === "auth.login",
      );
      expect(ev?.["details"]).toMatchObject({ login_method: "oidc:sso" });
      expect(depart.reponse.headers["set-cookie"]).toContain(`${COOKIE_LIAISON}=`);
    });

    it("l'adresse d'autorisation porte PKCE S256, state, nonce, portée et l'adresse de retour de la configuration", async () => {
      const d = await b.demarrer({ hote: HOTE_PUBLIC });
      expect(schemaReponseDepartOidc.safeParse(d.reponse.json()).success).toBe(true);
      const p = new URL(d.url ?? "").searchParams;
      expect(p.get("redirect_uri")).toBe(`${URL_PUBLIQUE}/api/auth/oidc/sso/callback`);
      expect(p.get("response_type")).toBe("code");
      expect(p.get("code_challenge_method")).toBe("S256");
      expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(p.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(p.get("scope")).toBe("openid profile email");
      expect(p.get("acr_values")).toBeNull();
      expect(p.get("max_age")).toBeNull();
      const flux = await b.t.base.get<Record<string, unknown>>("SELECT * FROM auth_flows");
      expect(flux).toMatchObject({ provider_id: "sso", target: "app", stage: "auth", trial_admin: null });
      expect(String(flux?.["state_hash"])).not.toContain(p.get("state") ?? "x");
      expect(String(flux?.["browser_hash"])).toMatch(/^[0-9a-f]{64}$/u);
      const c = String(d.reponse.headers["set-cookie"]);
      expect(c).toMatch(
        /^__Host-elpis-sso=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/u,
      );
      expect(c).not.toContain(String(flux?.["browser_hash"]));
    });

    it("`acr_values` et `max_age` demandés quand ils sont réglés ; un second flux du même navigateur garde son secret de liaison", async () => {
      await b.reglages({ required_acr: ["mfa"], max_age_sec: 300 });
      const a = await b.demarrer();
      const p = new URL(a.url ?? "").searchParams;
      expect([p.get("acr_values"), p.get("max_age")]).toEqual(["mfa", "300"]);
      const second = await b.demarrer({ cookie: a.cookie });
      expect(cookies(second.reponse, a.cookie)).toBe(a.cookie);
    });

    it("seconde connexion : même compte, `checked_at` mis à jour, rien de nouveau", async () => {
      await b.connecter(ELPIS("sub-jean"));
      await b.t.base.run("UPDATE user_identities SET checked_at=1");
      const r = await b.connecter(ELPIS("sub-jean"));
      expect(r.retour.statusCode).toBe(200);
      expect(await b.utilisateurs()).toEqual(["chef", "sub-jean"]);
      const c = await b.t.base.valeurs<[number]>("SELECT checked_at FROM user_identities");
      expect(Number(c[0]?.[0])).toBeGreaterThan(1_700_000_000);
    });

    it("authentification du client par le corps (`post`) : réussit avec un fournisseur qui l'exige", async () => {
      await ouvrir({ idp: { authClient: "post" } });
      expect((await b.connecter(ELPIS("sub-post"))).retour.statusCode).toBe(200);
    });

    it("le jeton d'identité en RS256 (algorithme par défaut) passe aussi", async () => {
      await ouvrir({ idp: { alg: "RS256" } });
      expect((await b.connecter(ELPIS("sub-rsa"))).retour.statusCode).toBe(200);
    });

    it("la durée de session du fournisseur raccourcit la session, jamais ne l'allonge", async () => {
      await b.reglages({ session_max_age_sec: 600 });
      const court = sessionDe((await b.connecter(ELPIS("sub-a"))).session);
      expect(Number(court["_exp"]) - Number(court["_login_ts"])).toBe(600);
      await b.reglages({ session_max_age_sec: 2_592_000 });
      const long = sessionDe((await b.connecter(ELPIS("sub-a"))).session);
      expect(Number(long["_exp"]) - Number(long["_login_ts"])).toBe(86_400);
    });
  });

  describe("signature et revendications du jeton d'identité", () => {
    const rejete = async (
      pieges: Record<string, unknown>,
      u = ELPIS("sub-x"),
      code = "failed",
    ): Promise<Refus> => {
      b.idp.pieges = pieges;
      const r = await b.connecter(u);
      const f = refus(r.retour);
      expect(f.code).toBe(code);
      await intact();
      return f;
    };

    it("jeton d'identité : `alg: none` refusé", async () => void (await rejete({ alg: "none" })));
    it("HS256 signé avec le secret client refusé", async () => void (await rejete({ alg: "HS256" })));
    it("signature fausse (autre clé, même identifiant de clé) refusée", async () =>
      void (await rejete({ signerAvecAutreCle: true })));
    it("algorithme autre que celui réglé refusé (signature valide, réglage RS256)", async () => {
      await b.reglages({ id_token_alg: "RS256" });
      await rejete({});
    });
    it("jeton d'identité : `iss` faux refusé", async () =>
      void (await rejete({ claims: { iss: "https://autre.exemple.lan" } })));
    it("jeton d'identité : `aud` faux refusé", async () =>
      void (await rejete({ claims: { aud: "autre-client" } })));
    it("jeton d'identité : `nonce` faux refusé", async () =>
      void (await rejete({ claims: { nonce: "autre-nonce" } })));
    it("jeton sans `nonce` refusé", async () => void (await rejete({ sans: ["nonce"] })));
    it("jeton d'identité : jeton expiré refusé", async () => {
      const t = Math.floor(Date.now() / 1000);
      await rejete({ claims: { iat: t - 7200, exp: t - 3600 } });
    });
    it("`iat` dans le futur au-delà de la tolérance refusé, en deçà accepté", async () => {
      const t = Math.floor(Date.now() / 1000);
      await rejete({ claims: { iat: t + 3600, exp: t + 7200 } });
      b.idp.pieges = { claims: { iat: t + 30 } };
      expect((await b.connecter(ELPIS("sub-y"))).retour.statusCode).toBe(200);
    });
    it("sans jeton d'identité dans la réponse : refusé", async () =>
      void (await rejete({ sansJeton: true })));
    it("la tolérance d'horloge du fournisseur est celle qui s'applique (0 s : `iat` à +30 s refusé)", async () => {
      await b.reglages({ clock_skew_sec: 0 });
      const t = Math.floor(Date.now() / 1000);
      await rejete({ claims: { iat: t + 30 } });
    });
    it("sujet vide ou trop long refusé", async () => {
      await rejete({ claims: { sub: "" } }, ELPIS("x"));
      await rejete({ claims: { sub: "s".repeat(256) } }, ELPIS("x"));
    });
    it("`auth_time` trop ancien au regard de `max_age_sec` refusé", async () => {
      await b.reglages({ max_age_sec: 60 });
      const t = Math.floor(Date.now() / 1000);
      await rejete({ claims: { auth_time: t - 3600 } });
    });

    it("la cause réelle va au journal et à l'audit avec la référence, jamais au navigateur", async () => {
      b.idp.pieges = { alg: "none" };
      const r = await b.connecter(ELPIS("sub-z"));
      const f = refus(r.retour);
      expect(r.retour.body).toBe("");
      expect(lignesJournal.some((l) => l.includes(f.ref) && l.includes("sso"))).toBe(true);
      const ev = denies().find((e) => (e["details"] as Record<string, unknown>)["ref"] === f.ref);
      expect(ev).toMatchObject({ outcome: "failure" });
      expect(ev?.["details"]).toMatchObject({ login_method: "oidc:sso", ref: f.ref });
      expect(String((ev?.["details"] as Record<string, unknown>)["reason"])).toMatch(/^[a-z_:A-Z0-9]+$/u);
    });
  });

  describe("second facteur", () => {
    it("`acr` requis : valeur insuffisante ou absente refusée, valeur de la liste acceptée", async () => {
      await b.reglages({ required_acr: ["mfa"] });
      for (const claims of [{ acr: "pwd" }, {}]) {
        b.idp.pieges = { claims };
        expect(refus((await b.connecter(ELPIS("sub-m"))).retour).code).toBe("mfa_required");
      }
      b.idp.pieges = { claims: { acr: "mfa" } };
      expect((await b.connecter(ELPIS("sub-m"))).retour.statusCode).toBe(200);
    });

    it("`amr` requis : au moins une valeur de la liste", async () => {
      await b.reglages({ required_amr: ["otp", "hwk"] });
      for (const claims of [{ amr: ["pwd"] }, { amr: "otp" }, {}]) {
        b.idp.pieges = { claims };
        expect(refus((await b.connecter(ELPIS("sub-m"))).retour).code).toBe("mfa_required");
      }
      b.idp.pieges = { claims: { amr: ["pwd", "otp"] } };
      expect((await b.connecter(ELPIS("sub-m"))).retour.statusCode).toBe(200);
    });
  });

  describe("groupes", () => {
    beforeEach(() => {
      b.idp.userinfo = (u) => ({ sub: u.sub });
    });
    const refuse = async (u: ReturnType<typeof ELPIS>, code: string): Promise<void> => {
      expect(refus((await b.connecter(u)).retour).code).toBe(code);
      await intact();
    };

    it("groupes d'un autre groupe : `not_in_group`, aucun compte", async () =>
      refuse(ELPIS("s", { groups: ["autres"] }), "not_in_group"));
    it("revendication absente : `groups_unknown`", async () => {
      b.idp.pieges = { sans: ["groups"] };
      await refuse(ELPIS("s"), "groups_unknown");
    });
    it("revendication d'un autre type : `groups_unknown`", async () => {
      await refuse(ELPIS("s", { groups: "autre" }), "groups_unknown");
      await refuse(ELPIS("s", { groups: "elpis;autre" }), "groups_unknown");
      await refuse(ELPIS("s", { groups: "" }), "groups_unknown");
      await refuse(ELPIS("s", { groups: [1, 2] }), "groups_unknown");
      await refuse(ELPIS("s", { groups: { elpis: true } }), "groups_unknown");
    });
    it("chaîne unique égale au groupe requis : connexion, par le jeton ou par le point d'information ; toute autre chaîne : `groups_unknown`, jamais « non membre »", async () => {
      await refuse(ELPIS("s", { groups: "mods" }), "groups_unknown");
      await refuse(ELPIS("s", { groups: "elpis;mods" }), "groups_unknown");
      expect((await b.connecter(ELPIS("sub-un", { groups: "elpis" }))).retour.statusCode).toBe(200);
      b.idp.userinfo = (u) => ({ sub: u.sub, groups: "elpis" });
      expect((await b.connecter(ELPIS("sub-deux", { groups: undefined }))).retour.statusCode).toBe(200);
    });
    const OTP = ["mfa"];
    it("rôles ou groupes suivis par le fournisseur : une chaîne n'est plus lue, une liste est exigée (ni rôle donné, ni rôle gardé sur une chaîne)", async () => {
      const niveau = async (nom: string): Promise<number> =>
        Number(
          (await b.t.base.get<{ is_admin: number }>("SELECT is_admin FROM users WHERE username=?", [nom]))
            ?.is_admin,
        );
      await b.reglages({
        required_groups: ["elpis", "admins"],
        roles: { enabled: true, admin_groups: ["admins"], moderator_groups: ["mods"] },
        required_amr: ["mfa"],
      });
      await refuse(ELPIS("sub-chaine", { groups: "admins", amr: OTP }), "groups_unknown");
      await refuse(ELPIS("sub-chaine", { groups: "elpis", amr: OTP }), "groups_unknown");
      expect(
        (await b.connecter(ELPIS("sub-liste", { groups: ["admins"], amr: OTP }))).retour.statusCode,
      ).toBe(200);
      expect(await niveau("sub-liste")).toBe(1);
    });
    it("identité connue et chaîne : jamais suspendue ni rétrogradée par une chaîne, et jamais admise avec des droits que la chaîne ne permet pas de vérifier", async () => {
      const etat = async (nom: string) =>
        b.t.base.get<{ is_admin: number; suspended_at: number }>(
          "SELECT is_admin, suspended_at FROM users WHERE username=?",
          [nom],
        );
      const code = async (extra: Record<string, unknown>): Promise<string | null> =>
        new URL(
          String((await b.connecter(ELPIS("sub-chef", extra))).retour.headers["location"]),
          "https://x",
        ).searchParams.get("auth_error");
      await b.reglages({
        roles: { enabled: true, admin_groups: ["admins"], moderator_groups: ["mods"] },
        required_amr: ["mfa"],
      });
      expect(
        (await b.connecter(ELPIS("sub-chef", { groups: ["elpis", "admins"], amr: OTP }))).retour.statusCode,
      ).toBe(200);
      expect(await etat("sub-chef")).toMatchObject({ is_admin: 1, suspended_at: 0 });
      // Le fournisseur ne rend plus qu'une valeur : rien ne dit si elle est toute la liste ou sa première ligne.
      for (const groups of ["elpis", "mods", "admins"])
        expect(await code({ groups, amr: OTP }), groups).toBe("groups_unknown");
      expect(await etat("sub-chef")).toMatchObject({ is_admin: 1, suspended_at: 0 });
      // Une LISTE sans le groupe des administrateurs rétrograde ; sans le groupe requis elle suspend.
      expect((await b.connecter(ELPIS("sub-chef", { groups: ["elpis"], amr: OTP }))).retour.statusCode).toBe(
        200,
      );
      expect(await etat("sub-chef")).toMatchObject({ is_admin: 0, suspended_at: 0 });
      expect(await code({ groups: ["mods"], amr: OTP })).toBe("not_in_group");
      expect(Number((await etat("sub-chef"))?.suspended_at)).toBeGreaterThan(0);
    });
    it("identité connue, sans rôle ni groupe suivi : la chaîne du groupe requis laisse entrer, une autre chaîne ne suspend pas", async () => {
      expect((await b.connecter(ELPIS("sub-simple", { groups: ["elpis"] }))).retour.statusCode).toBe(200);
      expect((await b.connecter(ELPIS("sub-simple", { groups: "elpis" }))).retour.statusCode).toBe(200);
      const r = await b.connecter(ELPIS("sub-simple", { groups: "autres" }));
      expect(refus(r.retour).code).toBe("groups_unknown");
      expect(
        await b.t.base.get<{ suspended_at: number }>("SELECT suspended_at FROM users WHERE username=?", [
          "sub-simple",
        ]),
      ).toMatchObject({ suspended_at: 0 });
    });
    it("groupes en dépassement (`_claim_names`, `hasgroups`) : `groups_unknown` même avec une liste présente", async () => {
      await refuse(
        ELPIS("s", { groups: undefined, _claim_names: { groups: "src1" }, _claim_sources: { src1: {} } }),
        "groups_unknown",
      );
      await refuse(ELPIS("s", { hasgroups: true }), "groups_unknown");
      await refuse(ELPIS("s", { groups: [], _claim_names: { groups: "src1" } }), "groups_unknown");
    });
    it("chemin pointé : `realm_access.roles`", async () => {
      await b.reglages({ groups_claim: "realm_access.roles" });
      const u = ELPIS("sub-r", { groups: undefined, realm_access: { roles: ["elpis"] } });
      expect((await b.connecter(u)).retour.statusCode).toBe(200);
      expect(
        refus((await b.connecter(ELPIS("s2", { groups: undefined, realm_access: { roles: ["x"] } }))).retour)
          .code,
      ).toBe("not_in_group");
      expect(
        refus((await b.connecter(ELPIS("s3", { groups: undefined, realm_access: "elpis" }))).retour).code,
      ).toBe("groups_unknown");
    });
    it("groupes absents du jeton : `userinfo` du même sujet les fournit, appelé seulement alors", async () => {
      b.idp.userinfo = (u) => ({ sub: u.sub, groups: ["elpis"] });
      b.idp.pieges = { sans: ["groups"] };
      expect((await b.connecter(ELPIS("sub-ui"))).retour.statusCode).toBe(200);
      expect(b.idp.traces.filter((t) => t.chemin.endsWith("/userinfo"))).toHaveLength(1);
      b.idp.traces.length = 0;
      b.idp.userinfo = (u) => ({ sub: u.sub, groups: ["elpis"] });
      expect((await b.connecter(ELPIS("sub-ui2"))).retour.statusCode).toBe(200);
      expect(b.idp.traces.some((t) => t.chemin.endsWith("/userinfo"))).toBe(false);
    });
    it("`userinfo` en erreur alors que les groupes manquent : refusé", async () => {
      b.idp.userinfo = null;
      b.idp.pieges = { sans: ["groups"] };
      await refuse(ELPIS("sub-ui"), "failed");
    });
    it("`userinfo` d'un autre sujet refusé", async () => {
      b.idp.userinfo = () => ({ sub: "quelquun-d-autre", groups: ["elpis"] });
      b.idp.pieges = { sans: ["groups"] };
      await refuse(ELPIS("sub-ui"), "failed");
    });
    it("`userinfo` ne remplace jamais une valeur du jeton d'identité", async () => {
      b.idp.userinfo = (u) => ({ sub: u.sub, groups: ["elpis"], preferred_username: "usurpe" });
      b.idp.pieges = { sans: ["groups"] };
      expect((await b.connecter(ELPIS("sub-ui"))).retour.statusCode).toBe(200);
      expect(await b.utilisateurs()).toEqual(["chef", "sub-ui"]);
    });
  });

  describe("compte existant, conflit, suspension", () => {
    it("un compte local homonyme n'est jamais rattaché : `conflict`", async () => {
      const { createUser } = await import("@elpis/auth");
      await createUser(b.t.base, "sub-jean", "mdp-local-1");
      const avant = await lignes("SELECT id, pass_hash FROM users ORDER BY id");
      expect(refus((await b.connecter(ELPIS("sub-jean"))).retour).code).toBe("conflict");
      expect(await lignes("SELECT id, pass_hash FROM users ORDER BY id")).toEqual(avant);
      expect(await lignes("SELECT COUNT(*) FROM user_identities")).toEqual([[0]]);
    });

    it("compte suspendu par un administrateur : `suspended`, aucune session", async () => {
      await b.connecter(ELPIS("sub-jean"));
      await b.t.base.run("UPDATE users SET suspended_at=1, suspended_by='admin' WHERE username='sub-jean'");
      const f = refus((await b.connecter(ELPIS("sub-jean"))).retour);
      expect(f.code).toBe("suspended");
      expect(denies().some((e) => (e["details"] as Record<string, unknown>)["ref"] === f.ref)).toBe(true);
    });

    it("sorti du groupe : `not_in_group` et suspension par le fournisseur", async () => {
      await b.connecter(ELPIS("sub-jean"));
      expect(refus((await b.connecter(ELPIS("sub-jean", { groups: ["autres"] }))).retour).code).toBe(
        "not_in_group",
      );
      expect(await lignes("SELECT suspended_by FROM users WHERE username='sub-jean'")).toEqual([
        ["provider:sso"],
      ]);
    });

    it("un résultat de provisionnement autre que `compte` est un refus (`preuve` : `conflict`)", async () => {
      const { refusDeResolution } = await import("../src/identite/oidc/connexion");
      const r = refusDeResolution({ type: "preuve", prelinkId: 1, uid: 2 } as never);
      expect(r.code).toBe("conflict");
    });
  });

  describe("le flux est lié au navigateur, à usage unique, à son fournisseur", () => {
    it("`state` inconnu : `expired`", async () => {
      const d = await b.demarrer();
      const r = await b.retourner(`${URL_PUBLIQUE}/x?code=abc&state=${"A".repeat(43)}`, { cookie: d.cookie });
      expect(refus(r).code).toBe("expired");
      await intact();
    });

    it("`state` rejoué : le second retour est refusé, le flux reste consommé", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-rejeu"));
      expect((await b.retourner(retour, { cookie: d.cookie })).statusCode).toBe(200);
      const r2 = await b.retourner(retour, { cookie: d.cookie });
      expect(refus(r2).code).toBe("expired");
      expect(await b.utilisateurs()).toEqual(["chef", "sub-rejeu"]);
    });

    it("flux lancé par un AUTRE navigateur : refusé, et le flux est détruit même pour son propriétaire", async () => {
      const a = await b.demarrer();
      const autre = await b.demarrer();
      expect(a.cookie).not.toBe(autre.cookie);
      const { retour } = b.idp.autoriser(a.url ?? "", ELPIS("sub-a"));
      expect(refus(await b.retourner(retour, { cookie: autre.cookie })).code).toBe("failed");
      expect(refus(await b.retourner(retour, { cookie: a.cookie })).code).toBe("expired");
      await intact();
    });

    it("sans cookie de liaison : `expired`, et le fournisseur n'est pas appelé", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-a"));
      b.idp.traces.length = 0;
      expect(refus(await b.retourner(retour)).code).toBe("expired");
      expect(b.idp.traces).toEqual([]);
    });

    it("cookie de liaison de forme invalide : traité comme absent", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-a"));
      expect(refus(await b.retourner(retour, { cookie: `${COOKIE_LIAISON}=a%00b` })).code).toBe("expired");
    });

    it("retour sur le fournisseur B d'un flux du fournisseur A : refusé", async () => {
      await b.ajouter("autre");
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-a"));
      expect(refus(await b.retourner(retour, { cookie: d.cookie, id: "autre" })).code).toBe("failed");
      await intact();
    });

    it("deux retours simultanés du même état : un seul réussit, un seul compte", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-course"));
      const rs = await Promise.all([1, 2, 3].map(() => b.retourner(retour, { cookie: d.cookie })));
      expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 302, 302]);
      expect(await b.utilisateurs()).toEqual(["chef", "sub-course"]);
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[1]]);
    });

    it("flux périmé (plus de dix minutes) : `expired`", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-a"));
      await b.t.base.run("UPDATE auth_flows SET expires_at=1");
      expect(refus(await b.retourner(retour, { cookie: d.cookie })).code).toBe("expired");
      await intact();
    });

    it("le flux est supprimé avant tout appel sortant, même si la suite échoue", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-a"));
      b.idp.reponseJetons = () => ({ statut: 500, corps: "panne" });
      expect(refus(await b.retourner(retour, { cookie: d.cookie })).code).toBe("failed");
      expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
    });

    it("erreur renvoyée par le fournisseur : `denied`, sans appel au point de jetons", async () => {
      const d = await b.demarrer();
      const state = new URL(d.url ?? "").searchParams.get("state");
      b.idp.traces.length = 0;
      const r = await b.retourner(
        `${URL_PUBLIQUE}/x?error=access_denied&error_description=${MARQUEUR}&state=${state}`,
        { cookie: d.cookie },
      );
      expect(refus(r).code).toBe("denied");
      expect(JSON.stringify([r.headers, r.body, lignesJournal])).not.toContain(MARQUEUR);
      expect(b.idp.traces).toEqual([]);
    });

    it("`iss` du retour qui n'est pas l'émetteur : refusé", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-a"));
      const r = await b.retourner(`${retour}&iss=${encodeURIComponent("https://autre.exemple.lan")}`, {
        cookie: d.cookie,
      });
      expect(refus(r).code).toBe("failed");
      await intact();
    });
  });

  describe("l'adresse de retour vient de la configuration, jamais de la requête", () => {
    it("hôte, protocole et port de la requête n'entrent pas dans la requête au point de jetons", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-h"));
      const u = new URL(retour);
      const r = await b.main.inject({
        method: "GET",
        url: `/api/auth/oidc/sso/callback${u.search}`,
        remoteAddress: adresseNeuve(),
        headers: {
          host: "pirate.exemple.lan:9999",
          "x-forwarded-host": "pirate.exemple.lan",
          "x-forwarded-proto": "http",
          cookie: d.cookie,
        },
      });
      expect(r.statusCode, r.body).toBe(200);
      const jetons = b.idp.traces.filter((t) => t.chemin.endsWith("/token")).at(-1);
      expect(jetons?.corps.get("redirect_uri")).toBe(`${URL_PUBLIQUE}/api/auth/oidc/sso/callback`);
    });

    it("la cible `console` mène à l'adresse de la console calculée depuis la configuration", async () => {
      const r = await b.connecter(ELPIS("sub-c"), { corps: { target: "console" } });
      expect(r.retour.statusCode).toBe(200);
      expect(r.retour.body).toContain(`content="0;url=https://elpis.exemple.lan:8443/admin"`);
    });

    it("`oauth_next` valide repris, hostile ignoré", async () => {
      const bon = "/oauth/authorize?client_id=x&state=y";
      const ok = await b.connecter(ELPIS("sub-n"), { corps: { target: "app", oauth_next: bon } });
      expect(ok.retour.body).toContain(`url=/?oauth_next=${encodeURIComponent(bon).replace(/&/gu, "&amp;")}`);
      const hostiles = [
        "https://pirate.exemple.lan/",
        "//pirate.exemple.lan/oauth/authorize?x=1",
        "/autre/chemin",
        "/oauth/authorize?x=1\r\nSet-Cookie: a=b",
        "/oauth/authorize?x=\\\\pirate",
        `/oauth/authorize?${"a".repeat(2000)}`,
        42,
        ["/oauth/authorize?x"],
      ];
      for (const oauth_next of hostiles) {
        const r = await b.connecter(ELPIS("sub-n"), { corps: { target: "app", oauth_next } });
        expect(r.retour.body, String(oauth_next)).toContain('content="0;url=/"');
      }
    });
  });

  describe("départ du flux", () => {
    it("hôte non canonique : 409 avec l'adresse canonique, aucun flux, aucun cookie", async () => {
      const r = await b.demarrer({ hote: "10.1.2.3:8001" });
      expect([r.reponse.statusCode, r.reponse.json()]).toMatchObject([409, { canonical: URL_PUBLIQUE }]);
      expect(schemaHoteNonCanonique.safeParse(r.reponse.json()).success).toBe(true);
      expect(r.reponse.headers["set-cookie"]).toBeUndefined();
      expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
    });

    it("l'hôte canonique avec un port est accepté (le cookie ne dépend pas du port)", async () => {
      expect((await b.demarrer({ hote: `${HOTE_PUBLIC}:8001` })).reponse.statusCode).toBe(200);
    });

    it("la console lance aussi un flux", async () => {
      expect((await b.demarrer({ process: "console" })).reponse.statusCode).toBe(200);
    });

    it("corps invalide : 400 ; cible hors liste : 400", async () => {
      for (const corps of [{}, { target: "https://pirate.exemple.lan" }, { target: 1 }, []])
        expect((await b.demarrer({ corps })).reponse.statusCode, JSON.stringify(corps)).toBe(400);
      expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
    });

    it("requête inter-site refusée, même sans cookie de session ; aucun flux", async () => {
      for (const entetes of [
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "", origin: "https://pirate.exemple.lan" },
      ] as Record<string, string>[]) {
        const r = await b.demarrer({ entetes });
        expect(r.reponse.statusCode, JSON.stringify(entetes)).toBe(403);
      }
      expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
    });

    it("au plafond de 20 flux en cours par adresse, le plus ancien flux de l'adresse est évincé et le départ passe", async () => {
      const adresse = adresseNeuve();
      const departs = [];
      for (let i = 0; i < 21; i++) {
        const d = await b.demarrer({ adresse });
        expect(d.reponse.statusCode).toBe(200);
        departs.push(d);
      }
      expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[20]]);
      const premier = b.idp.autoriser(departs[0]?.url ?? "", ELPIS("sub-evince"));
      expect(refus(await b.retourner(premier.retour, { cookie: departs[0]?.cookie })).code).toBe("expired");
      const dernier = b.idp.autoriser(departs[20]?.url ?? "", ELPIS("sub-dernier"));
      expect((await b.retourner(dernier.retour, { cookie: departs[20]?.cookie })).statusCode).toBe(200);
      expect((await b.demarrer()).reponse.statusCode).toBe(200);
    });

    it("plafond de 5 000 flux par fournisseur : refusé pour un préfixe qui en détient déjà plus de 20", async () => {
      const adresse = adresseNeuve();
      const prefixe = empreinteAdresses(adresse).slice(0, 64);
      const lignesFlux = Array.from({ length: 5000 }, (_v, i) => [
        `h${i}`,
        "sso",
        "b",
        `${prefixe}:${i}`,
        "n",
        "v",
        "app",
        null,
        null,
        "auth",
        1,
        4_000_000_000,
      ]);
      await b.t.base.runMany(
        "INSERT INTO auth_flows(state_hash, provider_id, browser_hash, ip_hash, nonce, code_verifier, target, oauth_next, trial_admin, stage, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        lignesFlux,
      );
      expect((await b.demarrer({ adresse })).reponse.statusCode).toBe(429);
    });

    it("les flux périmés ne comptent pas dans les plafonds", async () => {
      const adresse = adresseNeuve();
      for (let i = 0; i < 20; i++) await b.demarrer({ adresse });
      await b.t.base.run("UPDATE auth_flows SET expires_at=1");
      expect((await b.demarrer({ adresse })).reponse.statusCode).toBe(200);
    });

    it("le seau de débit par adresse s'applique au départ comme au retour, hors plafond de flux", async () => {
      const adresse = adresseNeuve();
      let premierRefus = -1;
      for (let i = 0; i < 60; i++) {
        const r = await b.demarrer({ adresse });
        await b.t.base.run("DELETE FROM auth_flows");
        if (r.reponse.statusCode === 429 && premierRefus < 0) premierRefus = i;
      }
      expect(premierRefus).toBeGreaterThanOrEqual(50);
      const autre = adresseNeuve();
      const cookie = `${COOKIE_LIAISON}=${"a".repeat(43)}`;
      const url = `${URL_PUBLIQUE}/x?code=a&state=${"A".repeat(43)}`;
      const codes: string[] = [];
      for (let i = 0; i < 60; i++) {
        const r = await b.retourner(url, { cookie, adresse: autre });
        codes.push(/auth_error=([a-z_]+)/u.exec(String(r.headers.location))?.[1] ?? "");
      }
      expect(codes.indexOf("unavailable")).toBeGreaterThanOrEqual(50);
      expect(
        denies().some((e) => (e["details"] as Record<string, unknown>)["reason"] === "rate_limited"),
      ).toBe(false);
    });
  });

  describe("fournisseur non actif : 404", () => {
    const toutes = async (): Promise<[number, string][]> => {
      const d = await b.demarrer({ id: "sso" });
      const cookie = d.cookie || `${COOKIE_LIAISON}=${"a".repeat(43)}`;
      const r1 = await b.demarrer({ id: "sso", cookie });
      const r2 = await b.retourner(`${URL_PUBLIQUE}/x?code=a&state=${"A".repeat(43)}`, { cookie });
      const r3 = await b.retourner(`${URL_PUBLIQUE}/x?code=a&state=${"A".repeat(43)}`);
      return [r1, r2, r3].map((r) => [
        ("reponse" in r ? r.reponse : r).statusCode,
        ("reponse" in r ? r.reponse : r).body,
      ]);
    };

    it("fournisseur éteint, inconnu, de l'autre type : mêmes 404 sur les deux routes", async () => {
      await ouvrir({ actif: false });
      for (const id of ["sso", "inconnu", "Pas Valide", "chef"]) {
        const s = await b.demarrer({ id });
        const c = await b.retourner(`${URL_PUBLIQUE}/x?code=a&state=${"A".repeat(43)}`, {
          id,
          cookie: `${COOKIE_LIAISON}=${"a".repeat(43)}`,
        });
        expect([s.reponse.statusCode, c.statusCode], id).toEqual([404, 404]);
        expect(s.reponse.body).toBe(c.body);
        expect(s.reponse.headers["set-cookie"]).toBeUndefined();
      }
      expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
      expect(b.idp.traces).toEqual([]);
    });

    it("fournisseur allumé mais écarté (sans test réussi, sans secret) : 404 aussi", async () => {
      await b.t.base.run("DELETE FROM auth_provider_state");
      expect((await toutes()).map((x) => x[0])).toEqual([404, 404, 404]);
      await b.reglages({});
      expect((await b.demarrer()).reponse.statusCode).toBe(200);
      await b.t.base.run("DELETE FROM vault_secrets");
      expect((await b.demarrer()).reponse.statusCode).toBe(404);
    });

    it("la page publique et la configuration ne disent rien d'un fournisseur éteint", async () => {
      await ouvrir({ actif: false });
      const c = (
        await b.main.inject({ method: "GET", url: "/api/public-config", headers: { host: HOTE_PUBLIC } })
      ).json();
      expect(c).not.toHaveProperty("login_methods");
      expect(c).not.toHaveProperty("auth_origin");
    });

    it("fournisseur actif : `login_methods` ne donne que identifiant et libellé, plus l'origine publique", async () => {
      const c = (
        await b.main.inject({ method: "GET", url: "/api/public-config", headers: { host: HOTE_PUBLIC } })
      ).json();
      expect(c.login_methods).toEqual([{ id: "sso", label: "Single sign-on" }]);
      expect(c.auth_origin).toBe(URL_PUBLIQUE);
      expect(schemaReponseConfigPublique.safeParse(c).success).toBe(true);
      const k = (
        await b.console.inject({ method: "GET", url: "/api/public-config", headers: { host: HOTE_PUBLIC } })
      ).json();
      expect(k.login_methods).toEqual([{ id: "sso", label: "Single sign-on" }]);
    });
  });

  describe("points d'accès, tailles, redirections, proxy", () => {
    it("point de jetons, clés, informations ou poussée sur une autre origine : le départ échoue, aucun secret ne part", async () => {
      for (const champ of ["token_endpoint", "jwks_uri", "pushed_authorization_request_endpoint"]) {
        b.idp.decouverte = { [champ]: "https://autre.exemple.lan/x" };
        await b.reglages({ label: `x-${champ}`.slice(0, 20) });
        const r = await b.demarrer();
        expect(r.reponse.statusCode, champ).toBe(503);
        expect(r.reponse.body).not.toContain("autre.exemple.lan");
        expect(r.url).toBeNull();
      }
      b.idp.decouverte = { authorization_endpoint: "http://idp.exemple.lan/auth" };
      await b.reglages({ label: "http" });
      expect((await b.demarrer()).reponse.statusCode).toBe(503);
      expect(b.idp.traces.every((t) => !t.corps.has("client_secret"))).toBe(true);
    });

    it("émetteur annoncé différent de l'émetteur réglé : refusé", async () => {
      b.idp.decouverte = { issuer: "https://autre.exemple.lan" };
      await b.reglages({ label: "autre" });
      expect((await b.demarrer()).reponse.statusCode).toBe(503);
    });

    it("réponse de plus de 1 Mio du point de jetons : refusée", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-gros"));
      b.idp.reponseJetons = () => ({ statut: 200, corps: " ".repeat(1024 * 1024 + 10) });
      expect(refus(await b.retourner(retour, { cookie: d.cookie })).code).toBe("unavailable");
      await intact();
    });

    it("redirection du point de jetons : non suivie", async () => {
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-redir"));
      b.idp.reponseJetons = () => ({
        statut: 302,
        entetes: { location: b.idp.url("/realms/elpis/userinfo") },
      });
      b.idp.traces.length = 0;
      expect(refus(await b.retourner(retour, { cookie: d.cookie })).code).toBe("unavailable");
      expect(b.idp.traces.map((t) => t.chemin)).toEqual(["/realms/elpis/token"]);
    });

    it("point d'information sur une autre origine : ignoré, jamais contacté, le parcours reste celui du jeton d'identité", async () => {
      let touches = 0;
      const ecouteur: Server = createServer((s) => {
        touches += 1;
        s.destroy();
      });
      await new Promise<void>((ok) => ecouteur.listen(0, "127.0.0.1", () => ok()));
      const port = (ecouteur.address() as { port: number }).port;
      try {
        b.idp.decouverte = { userinfo_endpoint: `https://autre.exemple.lan:${port}/userinfo` };
        await b.reglages({ label: "hors-origine" });
        expect((await b.connecter(ELPIS("sub-ho"))).retour.statusCode).toBe(200);
        b.idp.pieges = { sans: ["groups"] };
        expect(refus((await b.connecter(ELPIS("sub-ho2"))).retour).code).toBe("groups_unknown");
        expect(touches).toBe(0);
        expect(b.idp.traces.some((t) => t.chemin.endsWith("/userinfo"))).toBe(false);
      } finally {
        await new Promise<void>((ok) => ecouteur.close(() => ok()));
      }
    });

    it("`HTTPS_PROXY` piégé dans l'environnement : jamais contacté, le parcours réussit", async () => {
      let touches = 0;
      const piege: Server = createServer((s) => {
        touches += 1;
        s.destroy();
      });
      await new Promise<void>((ok) => piege.listen(0, "127.0.0.1", () => ok()));
      const port = (piege.address() as { port: number }).port;
      const avant = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].map(
        (k) => [k, process.env[k]] as const,
      );
      for (const [k] of avant) process.env[k] = `http://127.0.0.1:${port}`;
      try {
        expect((await b.connecter(ELPIS("sub-proxy"))).retour.statusCode).toBe(200);
      } finally {
        for (const [k, v] of avant) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        await new Promise<void>((ok) => piege.close(() => ok()));
      }
      expect(touches).toBe(0);
    });

    it("secret client absent ou hors de portée : fournisseur écarté (404), jamais un appel sans secret", async () => {
      await b.t.base.run("DELETE FROM vault_secrets");
      expect((await b.demarrer()).reponse.statusCode).toBe(404);
      expect(b.idp.traces).toEqual([]);
    });
  });

  describe("client sortant et découverte", () => {
    it("point de jetons muet : délai borné, refus `unavailable`, flux consommé", async () => {
      await ouvrir({ sortant: { delaiTotalMs: 400 } });
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-muet"));
      b.idp.muet = true;
      const debut = Date.now();
      expect(refus(await b.retourner(retour, { cookie: d.cookie })).code).toBe("unavailable");
      expect(Date.now() - debut).toBeLessThan(5_000);
      expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
    });

    it("adresse refusée par le juge : jamais contactée, `unavailable` au départ", async () => {
      await ouvrir({ sortant: { juger: async () => ({ motif: "blocked", adresses: [] }) } });
      const r = await b.demarrer();
      expect(r.reponse.statusCode).toBe(503);
      expect(b.idp.traces).toEqual([]);
    });

    it("autorité inconnue : la connexion TLS échoue, rien n'est lu", async () => {
      const f = await b.reglages({ ca_pem: "" });
      expect((await b.demarrer()).reponse.statusCode).toBe(404);
      await enregistrerSecret(b.t.base, f, b.idp.clientSecret, { userId: null, username: null, ip: null });
      await enregistrerTestReussi(b.t.base, f, URL_PUBLIQUE);
      const r = await b.demarrer();
      expect(r.reponse.statusCode).toBe(503);
      expect(b.idp.traces).toEqual([]);
    });

    it("la découverte est gardée une heure et relue si les réglages du fournisseur changent", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const lectures = (): number =>
        b.idp.traces.filter((t) => t.chemin.endsWith("openid-configuration")).length;
      await b.connecter(ELPIS("sub-d"));
      await b.connecter(ELPIS("sub-d"));
      expect(lectures()).toBe(1);
      await b.reglages({ scopes: ["openid", "email"] });
      await b.connecter(ELPIS("sub-d"));
      expect(lectures()).toBe(2);
      vi.setSystemTime(Date.now() + 3_599_000);
      await b.connecter(ELPIS("sub-d"));
      expect(lectures()).toBe(2);
      vi.setSystemTime(Date.now() + 2_000);
      await b.connecter(ELPIS("sub-d"));
      expect(lectures()).toBe(3);
    });

    it("requête d'autorisation poussée (PAR) quand le fournisseur l'annonce : rien en clair dans l'adresse", async () => {
      b.idp.activerPar();
      await b.reglages({ label: "Par" });
      const r = await b.connecter(ELPIS("sub-par"));
      expect(r.retour.statusCode, r.retour.body).toBe(200);
      const u = new URL(r.depart.url ?? "");
      expect([...u.searchParams.keys()].sort()).toEqual(["client_id", "request_uri"]);
      expect(b.idp.traces.some((t) => t.chemin.endsWith("/par"))).toBe(true);
    });
  });

  describe("clés du fournisseur", () => {
    it("rotation : un jeton à clé inconnue est refusé tant que les clés lues ont moins d'une minute, puis relues une fois", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      expect((await b.connecter(ELPIS("sub-k"))).retour.statusCode).toBe(200);
      expect(b.idp.lecturesCles).toBe(1);
      await b.idp.rotation();
      expect(refus((await b.connecter(ELPIS("sub-k"))).retour).code).toBe("failed");
      expect(b.idp.lecturesCles).toBe(1);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await b.connecter(ELPIS("sub-k"))).retour.statusCode).toBe(200);
      expect(b.idp.lecturesCles).toBe(2);
    });

    it("`kid` inconnu en rafale : une seule relecture des clés par minute", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await b.connecter(ELPIS("sub-k"));
      expect(b.idp.lecturesCles).toBe(1);
      for (let i = 0; i < 6; i++) {
        b.idp.pieges = { kid: "inconnue" };
        expect(refus((await b.connecter(ELPIS("sub-k"))).retour).code).toBe("failed");
      }
      expect(b.idp.lecturesCles).toBe(1);
      vi.setSystemTime(Date.now() + 61_000);
      for (let i = 0; i < 6; i++) {
        b.idp.pieges = { kid: "inconnue" };
        refus((await b.connecter(ELPIS("sub-k"))).retour);
      }
      expect(b.idp.lecturesCles).toBe(2);
    });

    it("les clés lues sont gardées d'un retour à l'autre (une seule lecture pour plusieurs connexions)", async () => {
      for (const s of ["a", "b", "c"]) await b.connecter(ELPIS(`sub-${s}`));
      expect(b.idp.lecturesCles).toBe(1);
    });
  });

  describe("rien du fournisseur n'atteint le navigateur, le journal ni l'audit", () => {
    it("jetons, secret client, messages d'erreur et revendications brutes absents des réponses, du journal et de l'audit", async () => {
      const toutes: LightMyRequestResponse[] = [];
      const garde = async (
        p: Promise<{ retour: LightMyRequestResponse; depart: { reponse: LightMyRequestResponse } }>,
      ) => {
        const r = await p;
        toutes.push(r.depart.reponse, r.retour);
      };
      await garde(b.connecter(ELPIS("sub-ok", { secret_interne: MARQUEUR })));
      b.idp.pieges = { alg: "none" };
      await garde(b.connecter(ELPIS("sub-mauvais", { secret_interne: MARQUEUR })));
      b.idp.pieges = { claims: { iss: `https://${MARQUEUR}.exemple.lan` } };
      await garde(b.connecter(ELPIS("sub-iss")));
      const d = await b.demarrer();
      const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-err"));
      b.idp.reponseJetons = () => ({
        statut: 400,
        corps: JSON.stringify({ error: "invalid_grant", error_description: MARQUEUR }),
      });
      toutes.push(await b.retourner(retour, { cookie: d.cookie }));
      toutes.push(
        await b.retourner(`${URL_PUBLIQUE}/x?error=access_denied&error_description=${MARQUEUR}&state=x`, {
          cookie: d.cookie,
        }),
      );
      const vus = JSON.stringify(toutes.map((r) => [r.statusCode, r.headers, r.body]));
      const audit = JSON.stringify(lignesAuditRecentes({ limit: 500 }));
      const journal = lignesJournal.join("\n");
      for (const [nom, corps] of [
        ["réponses", vus],
        ["audit", audit],
        ["journal", journal],
      ] as const) {
        for (const x of [SECRET_CLIENT, MARQUEUR, ...b.idp.emis])
          expect(corps.includes(x), `${nom} : ${x.slice(0, 12)}`).toBe(false);
        for (const jeton of b.idp.emis.filter((j) => j.includes(".")))
          expect(corps.includes(jeton.split(".")[1] ?? "-"), nom).toBe(false);
      }
      expect(b.idp.emis.length).toBeGreaterThan(2);
    });

    it("tout refus mène à un code de la liste fermée et à une référence de 8 caractères, jamais ailleurs que `/`", async () => {
      const cas: Record<string, unknown>[] = [
        { alg: "none" },
        { claims: { aud: "x" } },
        { claims: { nonce: "x" } },
        { sans: ["groups"] },
      ];
      for (const pieges of cas) {
        b.idp.pieges = pieges;
        const f = refus((await b.connecter(ELPIS("sub-code"))).retour);
        expect(f.ref).toHaveLength(8);
      }
    });
  });

  describe("nettoyage", () => {
    it("éteindre le fournisseur supprime ses flux, ses sessions et son résultat d'essai", async () => {
      await b.connecter(ELPIS("sub-ext"));
      await b.demarrer();
      await b.t.base.run("INSERT INTO auth_trials(provider_id, result_json) VALUES('sso', '{}')");
      const { effacerEtatOidc } = await import("../src/identite/oidc/flux");
      await b.t.base.ecriture((x) => effacerEtatOidc(x, "sso"));
      for (const t of ["auth_flows", "auth_ext_sessions", "auth_trials"])
        expect(await lignes(`SELECT COUNT(*) FROM ${t}`), t).toEqual([[0]]);
    });

    it("la purge périodique retire flux et sessions périmés, rien d'autre", async () => {
      await b.connecter(ELPIS("sub-ext"));
      await b.demarrer();
      const { purgerFluxPerimes } = await import("../src/identite/oidc/flux");
      expect(await purgerFluxPerimes(b.t.base, 1)).toBe(0);
      expect(await purgerFluxPerimes(b.t.base, 4_000_000_000)).toBe(2);
    });
  });
});
