// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/oidc-deconnexion-conformite.test.ts — conformité de la déconnexion : OpenID Connect Back-Channel Logout 1.0 §2.4 à §2.8 (jeton de déconnexion, réponse) et RP-Initiated Logout 1.0 §2 à §3 (adresse de fin de session), RFC 8725 §3.11-§3.12. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";

import { lignesAuditRecentes } from "../aides";
import { adresseNeuve, ELPIS, HOTE_PUBLIC, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { MOTEURS } from "../identite/banc";
import type { PiegesJeton } from "../identite/oidc-factice";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { maintenant } from "./aides-oidc";

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("déconnexion OIDC : conformité (%s)", (moteur) => {
  let b: BancOidc;
  beforeEach(async () => {
    b = await ouvrirBancOidc(moteur, { extra: { logout: { rp_initiated: true, backchannel: true } } });
  });
  afterEach(async () => {
    expect(b.idp.erreurs).toEqual([]);
    await b.fermer();
  });

  const poster = (
    jeton: string,
    o: { type?: string; corps?: string } = {},
  ): Promise<LightMyRequestResponse> =>
    b.main.inject({
      method: "POST",
      url: "/api/auth/oidc/sso/backchannel-logout",
      remoteAddress: adresseNeuve(),
      headers: { host: HOTE_PUBLIC, "content-type": o.type ?? "application/x-www-form-urlencoded" },
      payload: o.corps ?? new URLSearchParams({ logout_token: jeton }).toString(),
    });
  const vivante = async (cookie: string): Promise<boolean> =>
    (await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie } })).json<{
      logged_in?: boolean;
    }>().logged_in === true;
  const ouverte = async (sub = "sub-x", sid = "idp-sid"): Promise<string> =>
    (await b.connecter(ELPIS(sub, { sid }))).session;
  const accepte = async (
    p: PiegesJeton,
    u: { sid?: string; sub?: string } = { sid: "idp-sid" },
  ): Promise<void> => {
    const cookie = await ouverte();
    const r = await poster(await b.idp.jetonDeconnexion(u, p));
    expect(r.statusCode, r.body).toBe(200);
    expect(await vivante(cookie)).toBe(false);
  };
  const refuse = async (
    p: PiegesJeton,
    u: { sid?: string; sub?: string } = { sid: "idp-sid" },
    raison?: string,
  ): Promise<void> => {
    const cookie = await ouverte();
    const r = await poster(await b.idp.jetonDeconnexion(u, p));
    expect(r.statusCode, r.body).toBe(400);
    expect(await vivante(cookie)).toBe(true);
    if (raison !== undefined)
      expect(
        lignesAuditRecentes({ actionPrefix: "auth.oidc.backchannel_logout.denied" })[0]?.["details"],
      ).toMatchObject({
        reason: raison,
      });
  };

  describe("Back-Channel Logout §2.4 : jeton de déconnexion", () => {
    it("§2.4 : jeton complet (iss, aud, iat, exp, jti, events, sid, sub) accepté", async () =>
      accepte({ claims: { exp: maintenant() + 120 } }, { sid: "idp-sid", sub: "sub-x" }));
    it("§2.4 : `sid` seul accepté", async () => accepte({}, { sid: "idp-sid" }));
    it("§2.4 : `sub` seul accepté", async () => accepte({}, { sub: "sub-x" }));
    it("§2.4 : ni `sid` ni `sub` refusé", async () => refuse({}, {}, "no_subject"));
    it("§2.4 : `aud` en liste d'un seul élément égal au client accepté ; avec un public de plus refusé (aucun autre public de confiance)", async () => {
      await accepte({ claims: { aud: ["elpis"] } });
      await refuse({ claims: { aud: ["elpis", "autre-rp"] } });
    });
    it("§2.4 : `aud` en liste sans le client refusé", async () => refuse({ claims: { aud: ["autre-rp"] } }));
    it("§2.4 : `exp` absent toléré (plus tolérant que la norme : borné par `iat` et par l'usage unique du `jti`)", async () => {
      await accepte({ sans: ["exp"] });
      await refuse(
        { sans: ["exp"], claims: { iat: maintenant() - 3600 } },
        { sid: "idp-sid" },
        "iat_invalid",
      );
      const a = await ouverte();
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-sid" }, { sans: ["exp"] });
      expect((await poster(jeton)).statusCode).toBe(200);
      expect(await vivante(a)).toBe(false);
      const c = await ouverte();
      expect((await poster(jeton)).statusCode).toBe(200);
      expect(await vivante(c)).toBe(true);
    });
    it("§2.4 : `exp` présent d'un autre type que nombre refusé, pour une raison propre", async () =>
      refuse({ claims: { exp: "demain" } }, { sid: "idp-sid" }, "bad_exp"));
    it("§2.4 : `events` avec le membre de déconnexion et d'autres événements : accepté", async () =>
      accepte({
        claims: {
          events: {
            "http://schemas.openid.net/event/backchannel-logout": {},
            "https://exemple/autre": { a: 1 },
          },
        },
      }));
    it("§2.4 : `events` sans le membre de déconnexion refusé", async () =>
      refuse({ claims: { events: { "https://exemple/autre": {} } } }));
    it("§2.4 : `events` en liste refusé", async () =>
      refuse({ claims: { events: ["http://schemas.openid.net/event/backchannel-logout"] } }));
    it("§2.4 : revendications inconnues ignorées", async () =>
      accepte({ claims: { x_inconnu: { a: 1 }, name: "Alice" } }));
    it("§2.4 : `nonce` présent refusé (interdit : le jeton ne doit pas servir de jeton d'identité)", async () =>
      refuse({ claims: { nonce: "n" } }));
    it("§2.4 : `typ` `logout+jwt` accepté", async () => accepte({ entete: { typ: "logout+jwt" } }));
    it("§2.4 : `typ` absent toléré", async () => accepte({ entete: { typ: undefined } }));
    it("§2.4 : `typ` `JWT` toléré", async () => accepte({ entete: { typ: "JWT" } }));
  });

  describe("Back-Channel Logout §2.6 : validation du jeton", () => {
    it("§2.6 (2) : signature fausse refusée", async () => refuse({ signerAvecAutreCle: true }));
    it("§2.6 (3) : `alg` none refusé", async () => refuse({ alg: "none" }));
    it("§2.6 (3) : HS256 refusé", async () => refuse({ alg: "HS256" }));
    it("§2.6 (4) : `iss` faux refusé", async () => refuse({ claims: { iss: "https://autre.exemple.lan" } }));
    it("§2.6 (4) : `aud` faux refusé", async () => refuse({ claims: { aud: "autre-rp" } }));
    it("§2.6 (4) : `exp` dépassé refusé", async () =>
      refuse({ claims: { exp: maintenant() - 600 } }, { sid: "idp-sid" }, "expired"));
    it("§2.6 (4) : `iat` absent refusé", async () => refuse({ sans: ["iat"] }));
    it("§2.6 (4) : `iat` dans le futur refusé", async () => refuse({ claims: { iat: maintenant() + 3600 } }));
    it("§2.6 (4) : `iat` vieux de plus de dix minutes refusé", async () =>
      refuse({ claims: { iat: maintenant() - 3600 } }));
    it("§2.6 (4) : `kid` inconnu refusé", async () => refuse({ kid: "inconnue" }));
    it("RFC 7515 §4.1.11 : paramètre critique inconnu refusé", async () =>
      refuse({ signatureManuelle: true, entete: { crit: ["x"], x: 1 } }));
    it("§2.6 : jeton de déconnexion sans `jti` refusé", async () => refuse({ sans: ["jti"] }));
    it("§2.6 (8) : un jeton déjà appliqué (même `jti`) rejoué : reçu sans effet (200), la session ouverte depuis reste vivante", async () => {
      const a = await ouverte();
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-sid" });
      expect((await poster(jeton)).statusCode).toBe(200);
      expect(await vivante(a)).toBe(false);
      const c = await ouverte();
      expect((await poster(jeton)).statusCode).toBe(200);
      expect(await vivante(c)).toBe(true);
    });
    it("RFC 8725 §3.12 : un jeton d'identité valide présenté comme jeton de déconnexion refusé (porte un `nonce`, aucun événement)", async () => {
      const a = await ouverte();
      const id = b.idp.emis.at(-1) ?? "";
      expect((await poster(id)).statusCode).toBe(400);
      expect(await vivante(a)).toBe(true);
    });
  });

  describe("Back-Channel Logout §2.5 et §2.8 : requête et réponse", () => {
    it("§2.5 : requête POST en `application/x-www-form-urlencoded` avec `charset` acceptée", async () => {
      const a = await ouverte();
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-sid" });
      const r = await poster(jeton, { type: "application/x-www-form-urlencoded; charset=UTF-8" });
      expect(r.statusCode).toBe(200);
      expect(await vivante(a)).toBe(false);
    });
    it("§2.5 : corps JSON refusé (400)", async () => {
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-sid" });
      expect(
        (await poster(jeton, { type: "application/json", corps: JSON.stringify({ logout_token: jeton }) }))
          .statusCode,
      ).toBe(400);
    });
    it("§2.5 : `logout_token` absent, en double ou vide refusé", async () => {
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-sid" });
      expect((await poster("", { corps: "autre=1" })).statusCode).toBe(400);
      expect(
        (
          await poster("", {
            corps: new URLSearchParams([
              ["logout_token", jeton],
              ["logout_token", jeton],
            ]).toString(),
          })
        ).statusCode,
      ).toBe(400);
      expect((await poster("", { corps: "logout_token=" })).statusCode).toBe(400);
    });
    it("§2.8 : succès : 200 sans corps ni jeton relayé ; jeton invalide : 400 ; `Cache-Control: no-store` dans les deux cas (le produit répond aussi 429 à une adresse saturée de refus et 500 sur une erreur interne pour que le fournisseur réessaie : écarts voulus à la norme, qui dit 400)", async () => {
      await ouverte();
      const bon = await poster(await b.idp.jetonDeconnexion({ sid: "idp-sid" }));
      expect(bon.statusCode).toBe(200);
      expect(bon.headers["cache-control"]).toBe("no-store");
      expect(bon.body).toBe("");
      const mauvais = await poster("pas-un-jeton");
      expect(mauvais.statusCode).toBe(400);
      expect(mauvais.headers["cache-control"]).toBe("no-store");
    });
    it("§2.7 : l'utilisateur déjà déconnecté : la déconnexion réussit quand même (200)", async () => {
      expect((await poster(await b.idp.jetonDeconnexion({ sid: "session-inconnue" }))).statusCode).toBe(200);
    });
    it("§2.8 : méthode GET sur la route refusée (4xx) sans effet", async () => {
      const a = await ouverte();
      const r = await b.main.inject({
        method: "GET",
        url: `/api/auth/oidc/sso/backchannel-logout?logout_token=${await b.idp.jetonDeconnexion({ sid: "idp-sid" })}`,
        headers: { host: HOTE_PUBLIC },
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(await vivante(a)).toBe(true);
    });
    it("§2.6 : un refus est audité avec sa raison, jamais avec le jeton", async () => {
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-sid" }, { alg: "none" });
      await poster(jeton);
      expect(
        lignesAuditRecentes({ actionPrefix: "auth.oidc.backchannel_logout.denied" })[0]?.["details"],
      ).toMatchObject({
        reason: "bad_alg",
      });
      expect(JSON.stringify(lignesAuditRecentes({ limit: 50 }))).not.toContain(jeton.split(".")[1] ?? "x");
    });
  });

  describe("RP-Initiated Logout §2 et §3 : adresse de fin de session", () => {
    const deconnecter = async (): Promise<URL> => {
      const cookie = await ouverte();
      const r = await b.main.inject({
        method: "POST",
        url: "/api/logout-lite",
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie },
      });
      expect(r.statusCode, r.body).toBe(200);
      return new URL((r.json() as { logout_url: string }).logout_url);
    };
    it("§2 : `id_token_hint` est le jeton d'identité de la session, `client_id` celui du client (l'audience du jeton)", async () => {
      const u = await deconnecter();
      const hint = u.searchParams.get("id_token_hint") ?? "";
      expect(hint).toBe(b.idp.emis.at(-1));
      expect(JSON.parse(Buffer.from(hint.split(".")[1] ?? "", "base64url").toString("utf8"))).toMatchObject({
        aud: u.searchParams.get("client_id"),
      });
    });
    it("§3 : `post_logout_redirect_uri` est l'origine publique réglée plus `/`, jamais une valeur de la requête", async () => {
      const u = await deconnecter();
      expect(u.searchParams.get("post_logout_redirect_uri")).toBe("https://elpis.exemple.lan/");
    });
    it("§2 : aucun `logout_hint`, `state` ni `ui_locales` inventé", async () => {
      const u = await deconnecter();
      for (const k of ["logout_hint", "state", "ui_locales"]) expect(u.searchParams.has(k)).toBe(false);
    });
    it("§2 : le point annoncé porte déjà une chaîne de requête : conservée, les paramètres s'y ajoutent", async () => {
      b.idp.decouverte = { end_session_endpoint: `${b.idp.origine}${b.idp.chemins.logout}?tenant=x` };
      await b.reglages({ label: "Autre libellé" });
      const u = await deconnecter();
      expect(u.searchParams.get("tenant")).toBe("x");
      expect(u.searchParams.get("client_id")).toBe("elpis");
    });
    it("§2 : la session déconnectée est morte avant même la réponse de l'adresse (déconnexion locale d'abord)", async () => {
      const cookie = await ouverte();
      await b.main.inject({
        method: "POST",
        url: "/api/logout-lite",
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie },
      });
      expect(await vivante(cookie)).toBe(false);
    });
  });
});
