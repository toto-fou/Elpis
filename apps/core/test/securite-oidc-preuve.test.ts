// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-preuve.test.ts — la première connexion SSO d'un compte local préparé n'ouvre aucune session avant la preuve du titulaire ; la preuve vise le compte de la ligne préparée, jamais un nom du navigateur, est liée au navigateur du retour, compte ses échecs sur la ligne et ouvre la session `oidc:<id>` (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createUser, verifyUser } from "@elpis/auth";
import { schemaReponsePreuveLien, schemaReponsePreuveLienReussie } from "@elpis/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";

import { ancreIdentite } from "../src/identite/ancre";
import { preparerRattachement } from "../src/identite/rattachement";
import { lignesAuditRecentes } from "./aides";
import {
  adresseNeuve,
  cookies,
  ELPIS,
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
  const retourDeJean = async (nom = "jean.dupont") => {
    const r = await b.connecter(ELPIS("sub-jd", { preferred_username: nom }));
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

  it("bon mot de passe : session `oidc:<id>` sur le compte de la ligne, ancien mot de passe mort, jetons gardés", async () => {
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
    expect(await b.t.base.valeurs("SELECT COUNT(*) FROM tool_tokens WHERE user_id=?", [jean])).toEqual([[1]]);
    expect(await b.t.base.valeurs("SELECT COUNT(*) FROM auth_ext_sessions WHERE user_id=?", [jean])).toEqual([
      [1],
    ]);
    expect((await get(session)).json()).toEqual({ pending: false, username: null });
    const [lien] = lignesAuditRecentes({ actionPrefix: "auth.identity.link" });
    expect(lien).toMatchObject({ details: { method: "proof", kept: true } });
    expect(
      lignesAuditRecentes({ actionPrefix: "auth.login" }).find((e) => e["action"] === "auth.login")?.[
        "details"
      ],
    ).toMatchObject({ login_method: "oidc:sso" });
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

  it("fournisseur éteint depuis le retour : refus", async () => {
    const { cookie } = await retourDeJean();
    await b.reglages({ enabled: false });
    expect((await prouver({ password: "mdp-local-1" }, cookie)).statusCode).toBe(409);
    expect(await identites()).toEqual([]);
  });

  describe("session ouverte par la preuve (sans `sid` du fournisseur ni jeton d'identité)", () => {
    const REGLAGE = { logout: { rp_initiated: true, backchannel: true } };

    it("déconnexion par le fournisseur (`sub` seul) : la session meurt, la ligne est supprimée", async () => {
      await b.reglages(REGLAGE);
      const { cookie } = await retourDeJean();
      const session = cookies(await prouver({ password: "mdp-local-1" }, cookie), cookie);
      expect(await b.t.base.valeurs("SELECT idp_sid, id_token_enc, subject FROM auth_ext_sessions")).toEqual([
        [null, null, "sub-jd"],
      ]);
      const r = await b.main.inject({
        method: "POST",
        url: "/api/auth/oidc/sso/backchannel-logout",
        remoteAddress: adresseNeuve(),
        headers: { host: HOTE_PUBLIC, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          logout_token: await b.idp.jetonDeconnexion({ sub: "sub-jd" }),
        }).toString(),
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(await b.t.base.valeurs("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
      const moi = await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: session } });
      expect(moi.json<{ logged_in?: boolean }>().logged_in).toBe(false);
    });

    it("déconnexion d'Elpis : `logout_url` sans indice d'identité, ligne supprimée", async () => {
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
      expect(u.searchParams.has("id_token_hint")).toBe(false);
      expect(u.searchParams.get("client_id")).toBe("elpis");
      expect(await b.t.base.valeurs("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
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
