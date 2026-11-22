// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-preuve.test.ts — la première connexion SSO d'un compte local préparé n'ouvre aucune session avant la preuve du titulaire ; la preuve vise le compte de la ligne préparée, jamais un nom du navigateur, est liée au navigateur du retour, compte ses échecs sur la ligne et ouvre la session `oidc:<id>` (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createUser, verifyUser } from "@elpis/auth";
import { schemaReponsePreuveLien, schemaReponsePreuveLienReussie } from "@elpis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightMyRequestResponse } from "fastify";

import { ancreIdentite } from "../src/identite/ancre";
import { preparerRattachement } from "../src/identite/rattachement";
import { lignesAuditRecentes } from "./aides";
import {
  adresseNeuve,
  cookies,
  ELPIS,
  GROUPE,
  HOTE_PUBLIC,
  ouvrirBancOidc,
  URL_PUBLIQUE,
} from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { MOTEURS } from "./identite/banc";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("preuve du titulaire au retour SSO (%s)", (moteur) => {
  let b: BancOidc;
  let jean: number;
  let prelink: number;

  const preparer = async (uid: number, attendu: string, o: { admin?: boolean } = {}): Promise<number> => {
    const r = await b.t.base.ecriture((x) =>
      preparerRattachement(x, {
        uid,
        fournisseurId: "sso",
        ancre: ancreIdentite(b.fournisseur),
        attendu,
        dispense: false,
        confirmeAdmin: o.admin ?? false,
        par: b.chef,
        t: Date.now() / 1000,
      }),
    );
    if ("raison" in r) throw new Error(r.raison);
    return r.id;
  };
  const lignes = () => b.t.base.all<Record<string, unknown>>("SELECT * FROM auth_prelinks");
  const identites = () => b.t.base.all<Record<string, unknown>>("SELECT * FROM user_identities");
  const flux = (etape: string) =>
    b.t.base.all<Record<string, unknown>>("SELECT * FROM auth_flows WHERE stage=?", [etape]);
  const get = (cookie?: string): Promise<LightMyRequestResponse> =>
    b.main.inject({
      method: "GET",
      url: "/api/auth/oidc/link-proof",
      remoteAddress: adresseNeuve(),
      headers: { host: HOTE_PUBLIC, ...(cookie === undefined ? {} : { cookie }) },
    });
  const prouver = (
    corps: unknown,
    cookie?: string,
    entetes: Record<string, string> = {},
    adresse: string = adresseNeuve(),
  ): Promise<LightMyRequestResponse> =>
    b.main.inject({
      method: "POST",
      url: "/api/auth/oidc/link-proof",
      remoteAddress: adresse,
      headers: {
        host: HOTE_PUBLIC,
        "sec-fetch-site": "same-origin",
        ...(cookie === undefined ? {} : { cookie }),
        ...entetes,
      },
      payload: corps as object,
    });
  /** Retour SSO de « jean.dupont » : page vers `/?auth_link=1`, cookie du navigateur, sans session. */
  const retourDeJean = async (nom = "jean.dupont", extra: Record<string, unknown> = {}) => {
    const r = await b.connecter(ELPIS("sub-jd", { preferred_username: nom, ...extra }));
    return { ...r, cookie: r.session };
  };

  beforeEach(async () => {
    b = await ouvrirBancOidc(moteur);
    jean = await createUser(b.t.base, "jean-dupont", "mdp-local-1");
    prelink = await preparer(jean, "jean.dupont");
  });
  afterEach(async () => {
    await b.fermer();
  });

  it("le retour mène à `/?auth_link=1` sans session ; la demande est liée au navigateur du retour", async () => {
    const { retour, cookie } = await retourDeJean();
    expect(retour.statusCode, retour.body).toBe(200);
    expect(retour.body).toContain('http-equiv="refresh" content="0;url=/?auth_link=1"');
    expect(cookie).not.toContain("mcpwebui_session");
    expect(await identites()).toEqual([]);
    expect(await b.t.base.valeurs("SELECT 1 FROM auth_ext_sessions")).toEqual([]);
    const [f] = await flux("proof");
    expect(f).toMatchObject({ provider_id: "sso", prelink_id: prelink });
    expect(await flux("auth")).toEqual([]);
    expect(String(f?.["profile_json"])).toContain("sub-jd");
    const pret = await get(cookie);
    expect(pret.json()).toEqual({ pending: true, username: "jean-dupont" });
    expect(schemaReponsePreuveLien.safeParse(pret.json()).success).toBe(true);
    expect((await get()).json()).toEqual({ pending: false, username: null });
    expect((await get("__Host-elpis-sso=" + "a".repeat(43))).json()).toEqual({
      pending: false,
      username: null,
    });
  });

  it("bon mot de passe : session `oidc:<id>` sur le compte de la ligne, ancien mot de passe mort, jetons révoqués", async () => {
    await b.t.base.run(
      "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
      [jean, "api", "t", "h-1", "", "", 1],
    );
    const { cookie } = await retourDeJean();
    const r = await prouver({ password: "mdp-local-1" }, cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true, next: "/" });
    expect(schemaReponsePreuveLienReussie.safeParse(r.json()).success).toBe(true);
    const session = cookies(r, cookie);
    const moi = await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: session } });
    expect(moi.json()).toMatchObject({ logged_in: true, username: "jean-dupont", password_managed: true });
    expect(await identites()).toMatchObject([{ user_id: jean, subject: "sub-jd", linked_by: "proof" }]);
    expect(await verifyUser(b.t.base, "jean-dupont", "mdp-local-1")).toBeNull();
    expect(await lignes()).toEqual([]);
    expect(await flux("proof")).toEqual([]);
    expect(await b.t.base.valeurs("SELECT COUNT(*) FROM tool_tokens WHERE user_id=?", [jean])).toEqual([[0]]);
    expect(await b.t.base.valeurs("SELECT COUNT(*) FROM auth_ext_sessions WHERE user_id=?", [jean])).toEqual([
      [1],
    ]);
    expect((await get(session)).json()).toEqual({ pending: false, username: null });
    const [lien] = lignesAuditRecentes({ actionPrefix: "auth.identity.link" });
    expect(lien).toMatchObject({ details: { method: "proof", revoked_tokens: 1, revoked_oauth: 0 } });
    expect(
      lignesAuditRecentes({ actionPrefix: "auth.login" }).find((e) => e["action"] === "auth.login")?.[
        "details"
      ],
    ).toMatchObject({ login_method: "oidc:sso" });
  });

  it("l'ouverture de session qui échoue après le bon mot de passe : rattachement fait, la personne est renvoyée vers le SSO (409), l'essai est rendu, refus audité, aucune session", async () => {
    const ouverte = cookies(
      await b.main.inject({
        method: "POST",
        url: "/api/login-lite",
        remoteAddress: adresseNeuve(),
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" },
        payload: { username: "chef", password: "mdp-chef-1" },
      }),
    );
    expect(ouverte).toContain("mcpwebui_session=");
    const { cookie } = await retourDeJean();
    const reel = b.t.base.run.bind(b.t.base);
    const espion = vi
      .spyOn(b.t.base, "run")
      .mockImplementation((sql, ...reste) =>
        /revoked_sessions/u.test(sql) ? Promise.reject(new Error("base occupée")) : reel(sql, ...reste),
      );
    try {
      const r = await prouver({ password: "mdp-local-1" }, `${cookie}; ${ouverte}`);
      expect(r.statusCode, r.body).toBe(409);
      expect(String(r.headers["set-cookie"] ?? "")).not.toMatch(/mcpwebui_session=[^;"]+;/u);
      expect(
        lignesAuditRecentes({ actionPrefix: "auth.login.denied" }).some(
          (e) => (e["details"] as Record<string, unknown>)["reason"] === "session_open_failed",
        ),
      ).toBe(true);
    } finally {
      espion.mockRestore();
    }
    expect(await identites()).toMatchObject([{ user_id: jean, subject: "sub-jd", linked_by: "proof" }]);
    const suite = await retourDeJean();
    expect(suite.retour.statusCode, suite.retour.body).toBe(200);
    const moi = await b.main.inject({
      method: "GET",
      url: "/api/me-lite",
      headers: { cookie: suite.session },
    });
    expect(moi.json()).toMatchObject({ logged_in: true, username: "jean-dupont" });
  });

  it("compte rattaché : `me-lite` dit que le mot de passe est géré, et le changement de son propre mot de passe est refusé", async () => {
    const { cookie } = await retourDeJean();
    const session = cookies(await prouver({ password: "mdp-local-1" }, cookie), cookie);
    const moi = await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: session } });
    expect(moi.json()).toMatchObject({ password_managed: true });
    const r = await b.main.inject({
      method: "POST",
      url: "/api/users/change-password",
      headers: { cookie: session, "sec-fetch-site": "same-origin" },
      payload: { old_password: "mdp-local-1", new_password: "Nouveau-Mdp-123456" },
    });
    expect(r.statusCode).toBe(403);
    expect(await b.t.base.get("SELECT pass_hash FROM users WHERE id=?", [jean])).toEqual({ pass_hash: "!" });
    const connexion = await b.main.inject({
      method: "POST",
      url: "/api/login-lite",
      remoteAddress: adresseNeuve(),
      headers: { "sec-fetch-site": "same-origin" },
      payload: { username: "chef", password: "mdp-chef-1" },
    });
    const local = await b.main.inject({
      method: "GET",
      url: "/api/me-lite",
      headers: { cookie: cookies(connexion) },
    });
    expect(local.json()).toMatchObject({ logged_in: true });
    expect(local.json()).not.toHaveProperty("password_managed");
  });

  it("mauvais mot de passe : 401 commun, compteur sur la ligne ; au cinquième échec la ligne est supprimée et auditée", async () => {
    const { cookie } = await retourDeJean();
    for (let n = 1; n <= 4; n++) {
      const r = await prouver({ password: "faux" }, cookie);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ detail: "invalid credentials" });
      expect(Number((await lignes())[0]?.["attempts"])).toBe(n);
    }
    expect((await prouver({ password: "faux" }, cookie)).statusCode).toBe(401);
    expect(await lignes()).toEqual([]);
    expect(lignesAuditRecentes({ actionPrefix: "auth.prelink.locked" })).toHaveLength(1);
    expect((await prouver({ password: "mdp-local-1" }, cookie)).statusCode).toBe(409);
    expect(await identites()).toEqual([]);
    expect(await verifyUser(b.t.base, "jean-dupont", "mdp-local-1")).toBe(jean);
  });

  it("un nouveau flux SSO ne remet pas le compteur à zéro", async () => {
    const { cookie } = await retourDeJean();
    await prouver({ password: "faux" }, cookie);
    await prouver({ password: "faux" }, cookie);
    await retourDeJean();
    expect(Number((await lignes())[0]?.["attempts"])).toBe(2);
  });

  it("le navigateur ne choisit pas le compte : nom envoyé ignoré, mot de passe d'un autre compte refusé", async () => {
    const { cookie } = await retourDeJean();
    const r = await prouver(
      { password: "mdp-chef-1", username: "chef", user_id: b.chef, prelink_id: 99 },
      cookie,
    );
    expect(r.statusCode).toBe(401);
    expect(await identites()).toEqual([]);
    const ok = await prouver({ password: "mdp-local-1", username: "chef", user_id: b.chef }, cookie);
    expect(ok.statusCode).toBe(200);
    expect(await identites()).toMatchObject([{ user_id: jean }]);
  });

  it("autre navigateur (sans le cookie de liaison) ou cookie d'un autre secret : refus, rien ne change", async () => {
    await retourDeJean();
    const sans = await prouver({ password: "mdp-local-1" });
    expect(sans.statusCode).toBe(409);
    expect(String(sans.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session");
    const autre = await prouver({ password: "mdp-local-1" }, "__Host-elpis-sso=" + "b".repeat(43));
    expect(autre.statusCode).toBe(409);
    expect(await identites()).toEqual([]);
    expect(await verifyUser(b.t.base, "jean-dupont", "mdp-local-1")).toBe(jean);
    expect(Number((await lignes())[0]?.["attempts"])).toBe(0);
  });

  it("requête inter-sites refusée même sans cookie de session ; corps invalide : 400", async () => {
    const { cookie } = await retourDeJean();
    const inter = await prouver({ password: "mdp-local-1" }, cookie, { "sec-fetch-site": "cross-site" });
    expect(inter.statusCode).toBe(403);
    expect((await prouver({ password: "" }, cookie)).statusCode).toBe(400);
    expect((await prouver({}, cookie)).statusCode).toBe(400);
    expect(await identites()).toEqual([]);
  });

  it("flux de preuve périmé : plus de demande, refus", async () => {
    const { cookie } = await retourDeJean();
    await b.t.base.run("UPDATE auth_flows SET expires_at=1 WHERE stage='proof'");
    expect((await get(cookie)).json()).toEqual({ pending: false, username: null });
    expect((await prouver({ password: "mdp-local-1" }, cookie)).statusCode).toBe(409);
    expect(await identites()).toEqual([]);
  });

  it("ligne préparée supprimée ou périmée entre-temps : refus", async () => {
    const { cookie } = await retourDeJean();
    await b.t.base.run("UPDATE auth_prelinks SET expires_at=1");
    expect((await prouver({ password: "mdp-local-1" }, cookie)).statusCode).toBe(409);
    await b.t.base.run("DELETE FROM auth_prelinks");
    expect((await get(cookie)).json()).toEqual({ pending: false, username: null });
    expect((await prouver({ password: "mdp-local-1" }, cookie)).statusCode).toBe(409);
    expect(await identites()).toEqual([]);
  });

  it.each([1, 2])(
    "compte promu (rôle %i) depuis la préparation : refus, mot de passe encore valable",
    async (role) => {
      const { cookie } = await retourDeJean();
      await b.t.base.run("UPDATE users SET is_admin=? WHERE id=?", [role, jean]);
      const r = await prouver({ password: "mdp-local-1" }, cookie);
      expect(r.statusCode).toBe(409);
      expect(await identites()).toEqual([]);
      expect(await verifyUser(b.t.base, "jean-dupont", "mdp-local-1")).toBe(jean);
      expect(lignesAuditRecentes({ actionPrefix: "auth.identity.link.denied" })[0]).toMatchObject({
        outcome: "failure",
        details: { reason: "prelink_invalid" },
      });
    },
  );

  it("identifiant sosie : jamais de preuve proposée ni de session", async () => {
    for (const nom of ["jean․dupont", "ｊean.dupont", "jean.dupont "]) {
      const { retour, cookie } = await retourDeJean(nom);
      expect(retour.body, nom).not.toContain("auth_link");
      expect((await get(cookie)).json()).toEqual({ pending: false, username: null });
    }
    expect(await flux("proof")).toEqual([]);
    expect(await identites()).toMatchObject([]);
  });

  describe("l'identifiant reçu doit être fiable pour servir à la correspondance", () => {
    it("revendication d'identifiant = e-mail : sans `email_verified` vrai, aucune preuve ; avec, la preuve est proposée", async () => {
      const marie = await createUser(b.t.base, "marie", "mdp-marie-1");
      await preparer(marie, "marie@exemple.lan");
      await b.reglages({ username_claim: "email" });
      const non = await b.connecter(
        ELPIS("sub-m", { email: "marie@exemple.lan", email_verified: false, preferred_username: "x" }),
      );
      expect(non.retour.body).not.toContain("auth_link");
      expect(await flux("proof")).toEqual([]);
      const oui = await b.connecter(
        ELPIS("sub-m", { email: "marie@exemple.lan", email_verified: true, preferred_username: "x" }),
      );
      expect(oui.retour.body).toContain("auth_link");
      expect(await flux("proof")).toHaveLength(1);
    });

    it("identifiant de plus de 255 caractères : refusé, jamais tronqué pour correspondre à la ligne", async () => {
      const marie = await createUser(b.t.base, "marie", "mdp-marie-1");
      await preparer(marie, "a".repeat(255));
      const long = await b.connecter(ELPIS("sub-m", { preferred_username: "a".repeat(300) }));
      expect(long.retour.body).not.toContain("auth_link");
      expect(await flux("proof")).toEqual([]);
      const juste = await b.connecter(ELPIS("sub-m", { preferred_username: "a".repeat(255) }));
      expect(juste.retour.body).toContain("auth_link");
    });
  });

  it("les refus et le verrouillage sont audités avec l'empreinte de l'identifiant, le sujet, l'agent et la méthode ; le débit épuisé aussi", async () => {
    const adresse = "10.9.9.9";
    const { cookie } = await retourDeJean();
    for (let n = 0; n < 5; n++)
      await prouver({ password: "faux" }, cookie, { "user-agent": "Agent/1" }, adresse);
    const attendu = {
      subject: "sub-jd",
      user_agent: "Agent/1",
      login_method: "oidc:sso",
      target_user_id: jean,
      provider_id: "sso",
    };
    const [verrou] = lignesAuditRecentes({ actionPrefix: "auth.prelink.locked" });
    expect(verrou).toMatchObject({ outcome: "failure", details: attendu });
    expect(typeof (verrou?.["details"] as Record<string, unknown>)["identifier_hash"]).toBe("string");
    expect(String(JSON.stringify(verrou))).not.toContain("jean.dupont");
    expect(lignesAuditRecentes({ actionPrefix: "auth.identity.link.denied" })).toHaveLength(4);
    expect(lignesAuditRecentes({ actionPrefix: "auth.identity.link.denied" })[0]).toMatchObject({
      details: { ...attendu, reason: "bad_password" },
    });
    await preparer(jean, "jean.dupont");
    const r = await retourDeJean();
    for (let k = 0; k < 3; k++)
      await prouver({ password: "faux" }, r.cookie, { "user-agent": "Agent/1" }, adresse);
    const limites = lignesAuditRecentes({ actionPrefix: "auth.login.denied" }).filter(
      (e) => (e["details"] as Record<string, unknown>)["reason"] === "rate_limited",
    );
    expect(limites.length).toBeGreaterThan(0);
    expect(limites[0]).toMatchObject({ details: { login_method: "oidc:sso", subject: "sub-jd" } });
  });

  it("fournisseur éteint depuis le retour : 404", async () => {
    const { cookie } = await retourDeJean();
    await b.reglages({ enabled: false });
    expect((await prouver({ password: "mdp-local-1" }, cookie)).statusCode).toBe(404);
    expect(await identites()).toEqual([]);
  });

  describe("session ouverte par la preuve : une session SSO complète", () => {
    const REGLAGE = { logout: { rp_initiated: true, backchannel: true } };
    const deconnecter = async (u: { sid?: string; sub?: string }) =>
      b.main.inject({
        method: "POST",
        url: "/api/auth/oidc/sso/backchannel-logout",
        remoteAddress: adresseNeuve(),
        headers: { host: HOTE_PUBLIC, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ logout_token: await b.idp.jetonDeconnexion(u) }).toString(),
      });
    const vivante = async (session: string): Promise<boolean> =>
      (await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: session } })).json<{
        logged_in?: boolean;
      }>().logged_in === true;

    it("le `sid` du fournisseur et le jeton d'identité (chiffré) suivent la preuve ; `subject` reste le `sub` du jeton ; un jeton de déconnexion avec `sid` coupe la session", async () => {
      await b.reglages(REGLAGE);
      const { cookie } = await retourDeJean("jean.dupont", { sid: "idp-jd" });
      const [f] = await flux("proof");
      expect(String(f?.["profile_json"])).toContain("idp-jd");
      const session = cookies(await prouver({ password: "mdp-local-1" }, cookie), cookie);
      const [ligne] = await b.t.base.all<Record<string, unknown>>("SELECT * FROM auth_ext_sessions");
      expect(ligne).toMatchObject({ idp_sid: "idp-jd", subject: "sub-jd", user_id: jean });
      expect(typeof ligne?.["id_token_enc"]).toBe("string");
      expect(await vivante(session)).toBe(true);
      const r = await deconnecter({ sid: "idp-jd" });
      expect(r.statusCode, r.body).toBe(200);
      expect(await b.t.base.valeurs("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
      expect(await vivante(session)).toBe(false);
    });

    it("déconnexion par le fournisseur (`sub` seul) : la session meurt, la ligne est supprimée", async () => {
      await b.reglages(REGLAGE);
      const { cookie } = await retourDeJean();
      const session = cookies(await prouver({ password: "mdp-local-1" }, cookie), cookie);
      expect((await deconnecter({ sub: "sub-jd" })).statusCode).toBe(200);
      expect(await b.t.base.valeurs("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
      expect(await vivante(session)).toBe(false);
    });

    it("filet : un jeton avec `sid` ET `sub` ferme aussi la session de ce sujet dont le `sid` n'est pas rangé, pas celle d'un autre sujet", async () => {
      await b.reglages(REGLAGE);
      const { cookie } = await retourDeJean();
      const session = cookies(await prouver({ password: "mdp-local-1" }, cookie), cookie);
      await b.t.base.run("UPDATE auth_ext_sessions SET idp_sid=NULL");
      expect((await deconnecter({ sid: "idp-x", sub: "autre-sujet" })).statusCode).toBe(200);
      expect(await vivante(session)).toBe(true);
      expect((await deconnecter({ sid: "idp-x", sub: "sub-jd" })).statusCode).toBe(200);
      expect(await vivante(session)).toBe(false);
    });

    it("une déconnexion par le fournisseur supprime la demande de preuve en attente de ce sujet, pas celle d'un autre", async () => {
      await b.reglages(REGLAGE);
      const { cookie } = await retourDeJean();
      expect(await flux("proof")).toHaveLength(1);
      expect((await deconnecter({ sub: "autre-sujet" })).statusCode).toBe(200);
      expect(await flux("proof")).toHaveLength(1);
      expect((await deconnecter({ sid: "idp-x", sub: "sub-jd" })).statusCode).toBe(200);
      expect(await flux("proof")).toEqual([]);
      expect((await get(cookie)).json()).toEqual({ pending: false, username: null });
      expect((await prouver({ password: "mdp-local-1" }, cookie)).statusCode).toBe(409);
    });

    it("déconnexion d'Elpis : `logout_url` avec l'indice d'identité, ligne supprimée", async () => {
      await b.reglages(REGLAGE);
      const { cookie } = await retourDeJean();
      const session = cookies(await prouver({ password: "mdp-local-1" }, cookie), cookie);
      const r = await b.main.inject({
        method: "POST",
        url: "/api/logout-lite",
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie: session },
      });
      expect(r.statusCode, r.body).toBe(200);
      const u = new URL(r.json<{ logout_url: string }>().logout_url);
      expect(u.searchParams.has("id_token_hint")).toBe(true);
      expect(u.searchParams.get("client_id")).toBe("elpis");
      expect(await b.t.base.valeurs("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
    });
  });

  describe("rôles donnés par le SSO : la preuve n'applique les droits qu'en baisse", () => {
    const MODS = { roles: { enabled: true, admin_groups: [], moderator_groups: ["mods"] } };
    const niveau = async (): Promise<number> =>
      Number(
        (await b.t.base.get<{ is_admin: number }>("SELECT is_admin FROM users WHERE id=?", [jean]))?.is_admin,
      );
    const vivante = async (session: string): Promise<boolean> =>
      (await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: session } })).json<{
        logged_in?: boolean;
      }>().logged_in === true;

    it("un compte administrateur qui n'est plus dans le groupe est rétrogradé avant l'ouverture de la session", async () => {
      await b.t.base.ecriture(async (x) => {
        await x.run("DELETE FROM auth_prelinks");
      });
      await b.t.base.run("UPDATE users SET is_admin=1 WHERE id=?", [jean]);
      await preparer(jean, "jean.dupont", { admin: true });
      await b.reglages(MODS);
      const { cookie } = await retourDeJean();
      const r = await prouver({ password: "mdp-local-1" }, cookie);
      expect(r.statusCode, r.body).toBe(200);
      expect(await niveau()).toBe(0);
      expect(await vivante(cookies(r, cookie))).toBe(true);
      expect(
        lignesAuditRecentes({ actionPrefix: "auth.role.sync" }).find(
          (e) => e["action"] === "auth.role.sync",
        )?.["details"],
      ).toMatchObject({ provider_id: "sso", from: "admin", to: "user" });
    });

    it("membre du groupe des modérateurs : aucune montée par la preuve ; elle vient à la connexion suivante", async () => {
      await b.reglages(MODS);
      const { cookie } = await retourDeJean("jean.dupont", { groups: [GROUPE, "mods"] });
      const r = await prouver({ password: "mdp-local-1" }, cookie);
      expect(r.statusCode, r.body).toBe(200);
      expect(await niveau()).toBe(0);
      expect(
        lignesAuditRecentes({ actionPrefix: "auth.role.sync" }).filter(
          (e) => e["action"] === "auth.role.sync",
        ),
      ).toEqual([]);
      await b.connecter(ELPIS("sub-jd", { preferred_username: "jean.dupont", groups: [GROUPE, "mods"] }));
      expect(await niveau()).toBe(2);
    });

    it("groupes illisibles dans le jeton : rien ne bouge", async () => {
      await b.t.base.run("DELETE FROM auth_prelinks");
      await b.t.base.run("UPDATE users SET is_admin=2 WHERE id=?", [jean]);
      await preparer(jean, "jean.dupont", { admin: true });
      await b.reglages(MODS);
      const { cookie } = await retourDeJean();
      await b.t.base.run(
        "UPDATE auth_flows SET profile_json=REPLACE(profile_json, '\"groupes\"', '\"autre\"') WHERE stage='proof'",
      );
      const r = await prouver({ password: "mdp-local-1" }, cookie);
      expect(r.statusCode, r.body).toBe(200);
      expect(await niveau()).toBe(2);
    });
  });

  it("`auth.local.mode = admins` : la preuve reste possible pour un compte ordinaire (ce n'est pas une connexion locale)", async () => {
    b.cfg.ecrire({
      auth: { public_url: URL_PUBLIQUE, local: { mode: "admins" }, providers: [b.fournisseur] },
    });
    const local = await b.main.inject({
      method: "POST",
      url: "/api/login-lite",
      remoteAddress: adresseNeuve(),
      headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" },
      payload: { username: "jean-dupont", password: "mdp-local-1" },
    });
    expect(local.statusCode).toBe(401);
    const { cookie } = await retourDeJean();
    const r = await prouver({ password: "mdp-local-1" }, cookie);
    expect(r.statusCode, r.body).toBe(200);
    const moi = await b.main.inject({
      method: "GET",
      url: "/api/me-lite",
      headers: { cookie: cookies(r, cookie) },
    });
    expect(moi.json()).toMatchObject({ logged_in: true, username: "jean-dupont" });
  });
});
