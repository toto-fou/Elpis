// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/securite-sessions.test.ts — la gestion de session suit OWASP ASVS 5.0 V7 : identifiant aléatoire et renouvelé à chaque authentification, ancien cookie mort, déconnexion effective, attributs du cookie, aucun compte par défaut, ouverture par une action explicite (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createUser, Session, validerSession } from "@elpis/auth";
import type { DependancesSession } from "@elpis/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOTEURS } from "../identite/banc";
import { cookies, ELPIS, HOTE_PUBLIC, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import type { LightMyRequestResponse } from "fastify";

const ENTETES = { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" };

function sidDe(cookie: string): string {
  const brut = /(?:^|; )mcpwebui_session=([^;]+)/u.exec(cookie)?.[1] ?? "";
  const d = (
    JSON.parse(Buffer.from(brut.split(".")[0] ?? "", "base64url").toString("utf8")) as {
      d: Record<string, unknown>;
    }
  ).d;
  return String(d["_sid"] ?? "");
}

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("sessions : ASVS 5.0 V7 (%s)", (moteur) => {
  let b: BancOidc;
  let rang = 0;

  const loginLocal = (cookie?: string): Promise<LightMyRequestResponse> =>
    b.main.inject({
      method: "POST",
      url: "/api/login-lite",
      remoteAddress: `10.77.${(rang += 1) >> 8}.${rang & 255}`,
      headers: { ...ENTETES, ...(cookie === undefined ? {} : { cookie }) },
      payload: { username: "chef", password: "mdp-chef-1" },
    });
  const moi = async (cookie: string): Promise<boolean> =>
    (await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie } })).json<{
      logged_in: boolean;
    }>().logged_in;

  beforeEach(async () => {
    b = await ouvrirBancOidc(moteur);
  });
  afterEach(async () => {
    await b.fermer();
  });

  it("ASVS 5.0 V7.2.3 : l'identifiant de session fait 24 caractères aléatoires (au moins 128 bits) et deux ouvertures diffèrent", async () => {
    const vus = new Set<string>();
    for (let i = 0; i < 20; i += 1) vus.add(sidDe(cookies(await loginLocal())));
    expect(vus.size).toBe(20);
    for (const sid of vus) expect(sid).toMatch(/^[A-Za-z0-9_-]{24}$/u);
  });

  it("ASVS 5.0 V7.2.4 : une ré-authentification par mot de passe donne un identifiant neuf et l'ancien cookie est refusé", async () => {
    const a = cookies(await loginLocal());
    expect(await moi(a)).toBe(true);
    const n = cookies(await loginLocal(a), a);
    expect(sidDe(n)).not.toBe(sidDe(a));
    expect(await moi(n)).toBe(true);
    expect(await moi(a)).toBe(false);
  });

  it("ASVS 5.0 V7.2.4 : une connexion SSO depuis un navigateur déjà connecté donne un identifiant neuf et l'ancien cookie est refusé", async () => {
    const a = cookies(await loginLocal());
    const { retour, session } = await b.connecter(ELPIS("sub-reauth"), { cookieAvant: a });
    expect(retour.statusCode, retour.body).toBe(200);
    expect(sidDe(session)).not.toBe(sidDe(a));
    expect(await moi(session)).toBe(true);
    expect(await moi(a)).toBe(false);
  });

  it("ASVS 5.0 V7.4.1 : après la déconnexion le cookie ne sert plus et le navigateur le reçoit effacé", async () => {
    const a = cookies(await loginLocal());
    const r = await b.main.inject({
      method: "POST",
      url: "/api/logout-lite",
      headers: { ...ENTETES, cookie: a },
    });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers["set-cookie"])).toMatch(/mcpwebui_session=""?;.*Max-Age=0/iu);
    expect(await moi(a)).toBe(false);
  });

  it("ASVS 5.0 V7.4.1 : la déconnexion d'une session SSO la rend inutilisable aussi", async () => {
    const { session } = await b.connecter(ELPIS("sub-sortie", { sid: "idp-1" }));
    expect(await moi(session)).toBe(true);
    await b.main.inject({
      method: "POST",
      url: "/api/logout-lite",
      headers: { ...ENTETES, cookie: session },
    });
    expect(await moi(session)).toBe(false);
  });

  it("ASVS 5.0 V7.4.3 : le changement de mot de passe ferme toutes les autres sessions du compte", async () => {
    const c = cookies(await loginLocal());
    const d = cookies(await loginLocal());
    expect(await moi(d)).toBe(true);
    const r = await b.main.inject({
      method: "POST",
      url: "/api/users/change-password",
      headers: { ...ENTETES, cookie: c },
      payload: { old_password: "mdp-chef-1", new_password: "mdp-chef-2-assez-long" },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(await moi(d)).toBe(false);
    expect(await moi(cookies(r, c))).toBe(true);
  });

  it("ASVS 5.0 V3.3.2 et V3.3.4 : le cookie de session est HttpOnly, Secure, SameSite=Lax, limité à la durée de session, pour tous les modes de connexion", async () => {
    const local = String((await loginLocal()).headers["set-cookie"]);
    const { retour } = await b.connecter(ELPIS("sub-cookie"));
    for (const c of [local, String(retour.headers["set-cookie"])]) {
      expect(c).toMatch(/^mcpwebui_session=/u);
      expect(c).toMatch(/httponly/iu);
      expect(c).toMatch(/;\s*secure/iu);
      expect(c).toMatch(/samesite=lax/iu);
      expect(c).toMatch(/path=\//iu);
      expect(c).toMatch(/max-age=86400/iu);
    }
  });

  it("ANSSI-PA-080 R13 : le cookie qui lie le flux SSO au navigateur porte le préfixe __Host-, Secure, HttpOnly, SameSite=Lax", async () => {
    const d = await b.demarrer();
    const c = String(d.reponse.headers["set-cookie"]);
    expect(c).toMatch(/^__Host-elpis-sso=/u);
    expect(c).toMatch(/httponly/iu);
    expect(c).toMatch(/;\s*secure/iu);
    expect(c).toMatch(/samesite=lax/iu);
    expect(c).toMatch(/path=\//iu);
    expect(c).not.toMatch(/domain=/iu);
  });

  it("ASVS 5.0 V7.6.2 : aucune session ne naît d'une simple navigation, ni sur le départ SSO en GET ni sur un retour sans flux", async () => {
    const depart = await b.main.inject({
      method: "GET",
      url: "/api/auth/oidc/sso/start",
      headers: { host: HOTE_PUBLIC },
    });
    expect(depart.statusCode).toBeGreaterThanOrEqual(400);
    expect(String(depart.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session=ey");
    const retour = await b.main.inject({
      method: "GET",
      url: "/api/auth/oidc/sso/callback?code=x&state=y",
      remoteAddress: "10.78.0.1",
      headers: { host: HOTE_PUBLIC },
    });
    expect(retour.statusCode).toBe(302);
    expect(String(retour.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session=ey");
    expect(await b.utilisateurs()).toEqual(["chef"]);
  });

  it("ASVS 5.0 V6.3.2 : une base neuve ne contient aucun compte, donc aucun compte par défaut", async () => {
    const neuf = (await import("@elpis/db/test")).ouvrirBaseDeTest(moteur);
    try {
      await (await import("@elpis/db")).initialiserBase(neuf.base);
      expect(await neuf.base.valeurs("SELECT COUNT(*) FROM users")).toEqual([[0]]);
    } finally {
      await neuf.fermer();
    }
  });
  it("ASVS 5.0 V7.4.5 : un administrateur ferme depuis la console les sessions d'un compte, sans toucher aux autres", async () => {
    await createUser(b.t.base, "cible", "mdp-cible-1");
    const admin = cookies(await loginLocal());
    const cible = cookies(
      await b.main.inject({
        method: "POST",
        url: "/api/login-lite",
        remoteAddress: "10.77.200.1",
        headers: ENTETES,
        payload: { username: "cible", password: "mdp-cible-1" },
      }),
    );
    expect(await moi(cible)).toBe(true);
    const id = (await b.t.base.valeurs<[number]>("SELECT id FROM users WHERE username = 'cible'"))[0]?.[0];
    const appel = (url: string): Promise<LightMyRequestResponse> =>
      b.console.inject({
        method: "POST",
        url,
        headers: { ...ENTETES, cookie: admin, "content-type": "application/json" },
        payload: {},
      });
    expect((await appel(`/api/admin/security/sessions/revoke-user/${String(id)}`)).statusCode).toBe(200);
    expect(await moi(cible)).toBe(false);
    expect(await moi(admin)).toBe(true);
  });
});

describe("sessions : règles de validité (ASVS 5.0 V7.3, V7.4.5)", () => {
  const ligne = { id: 1, session_min_ts: null, is_suspended: 0 } as never;
  const dep = (security: Record<string, unknown>, t: number): DependancesSession => ({
    config: () => ({ security: { session: security } }),
    utilisateur: async () => ligne,
    revoquee: async () => false,
    maintenant: () => t,
  });
  const ouverte = (): Session => new Session({ user_id: 1, _login_ts: 1000, _sid: "s", _exp: 1000 + 86_400 });

  it("ASVS 5.0 V7.3.1 : avec un délai d'inactivité réglé, une session inactive plus longtemps est refusée et une session active reste ouverte", async () => {
    const actif = ouverte();
    expect((await validerSession(actif, 1, dep({ idle_timeout_sec: 600 }, 1500))).valide).toBe(true);
    expect(actif.get("_last_activity_ts")).toBe(1500);
    expect((await validerSession(actif, 1, dep({ idle_timeout_sec: 600 }, 2000))).valide).toBe(true);
    const inactif = ouverte();
    expect((await validerSession(inactif, 1, dep({ idle_timeout_sec: 600 }, 1500))).valide).toBe(true);
    expect((await validerSession(inactif, 1, dep({ idle_timeout_sec: 600 }, 2400))).valide).toBe(false);
    expect(inactif.get("user_id")).toBeUndefined();
  });

  it("ASVS 5.0 V7.4.5 : la coupure globale décidée par l'administrateur refuse toute session ouverte avant elle, pas celles d'après", async () => {
    const avant = ouverte();
    expect((await validerSession(avant, 1, dep({ global_min_ts: 1500 }, 2000))).valide).toBe(false);
    const apres = new Session({ user_id: 1, _login_ts: 1600, _sid: "t", _exp: 1600 + 86_400 });
    expect((await validerSession(apres, 1, dep({ global_min_ts: 1500 }, 2000))).valide).toBe(true);
  });
});
