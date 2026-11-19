// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/securite-oidc-client.test.ts — le client OpenID Connect suit le guide de l'ANSSI, la RFC 9700 et OWASP ASVS 5.0 V9 / V10 : aléas de 128 bits au moins, seul le code d'autorisation, jeton d'accès jamais gardé ni exposé, en-têtes du jeton d'identité sans autorité (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOTEURS } from "../identite/banc";
import { ELPIS, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import type { LightMyRequestResponse } from "fastify";

function codeDeRefus(r: LightMyRequestResponse): string | null {
  if (r.statusCode !== 302) return null;
  return /^\/\?auth_error=([a-z_]+)&ref=/u.exec(String(r.headers.location))?.[1] ?? null;
}

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("client OIDC : référentiels (%s)", (moteur) => {
  let b: BancOidc;

  beforeEach(async () => {
    b = await ouvrirBancOidc(moteur);
  });
  afterEach(async () => {
    await b.fermer();
  });

  /** Refus d'un jeton d'identité forgé par `fabriquer(nonce)` rendu à la place de celui du fournisseur. */
  async function retourForge(fabriquer: (nonce: string) => Promise<string>): Promise<LightMyRequestResponse> {
    const d = await b.demarrer();
    const nonce = new URL(d.url ?? "").searchParams.get("nonce") ?? "";
    const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-forge"));
    const jeton = await fabriquer(nonce);
    b.idp.reponseJetons = () => ({
      statut: 200,
      corps: JSON.stringify({ access_token: "acces-forge", token_type: "Bearer", id_token: jeton }),
    });
    const r = await b.retourner(retour, { cookie: d.cookie });
    expect(await b.utilisateurs()).toEqual(["chef"]);
    return r;
  }

  const revendications = (nonce: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const t = Math.floor(Date.now() / 1000);
    return {
      iss: b.idp.issuer,
      sub: "sub-forge",
      aud: b.idp.clientId,
      iat: t,
      exp: t + 300,
      nonce,
      groups: ["elpis"],
      ...extra,
    };
  };

  it("ANSSI-PA-080 R11 et R15 : `state` et `nonce` viennent d'un générateur d'aléa cryptographique, 128 bits au moins, jamais deux fois les mêmes", async () => {
    const etats = new Set<string>();
    const nonces = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const u = new URL((await b.demarrer()).url ?? "");
      const s = u.searchParams.get("state") ?? "";
      const n = u.searchParams.get("nonce") ?? "";
      for (const v of [s, n]) {
        expect(v).toMatch(/^[A-Za-z0-9_-]+$/u);
        expect(Buffer.from(v, "base64url").length * 8).toBeGreaterThanOrEqual(128);
      }
      etats.add(s);
      nonces.add(n);
    }
    expect(etats.size).toBe(25);
    expect(nonces.size).toBe(25);
  });

  it("RFC 9700 §2.1.1 : le défi PKCE est propre à chaque transaction et n'expose pas le vérificateur (S256)", async () => {
    const defis = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const u = new URL((await b.demarrer()).url ?? "");
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      defis.add(u.searchParams.get("code_challenge") ?? "");
    }
    expect(defis.size).toBe(10);
    expect([...defis].every((d) => /^[A-Za-z0-9_-]{43}$/u.test(d))).toBe(true);
  });

  it("RFC 9700 §2.4 : seul le code d'autorisation est échangé (jamais le mot de passe du propriétaire de la ressource), avec vérificateur PKCE et authentification du client", async () => {
    await b.connecter(ELPIS("sub-grant"));
    const jetons = b.idp.traces.filter((t) => t.chemin.endsWith("/token"));
    expect(jetons.length).toBe(1);
    for (const t of jetons) {
      expect(t.corps.get("grant_type")).toBe("authorization_code");
      expect(t.corps.has("password")).toBe(false);
      expect(t.corps.has("username")).toBe(false);
      expect(t.corps.get("code_verifier") ?? "").toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
      expect(t.autorisation ?? "").toMatch(/^Basic /u);
    }
  });

  it("ASVS 5.0 V10.4.10 : le client confidentiel s'authentifie à chaque requête du canal arrière (secret du client, jamais dans l'adresse)", async () => {
    await b.connecter(ELPIS("sub-client"));
    const jeton = b.idp.traces.find((t) => t.chemin.endsWith("/token"));
    const [id, secret] = Buffer.from((jeton?.autorisation ?? "").slice(6), "base64")
      .toString("utf8")
      .split(":");
    expect(decodeURIComponent(id ?? "")).toBe(b.idp.clientId);
    expect(decodeURIComponent(secret ?? "")).toBe(b.idp.clientSecret);
    for (const t of b.idp.traces) expect(t.chemin).not.toContain(b.idp.clientSecret);
  });

  it("ANSSI-PA-080 R31 : le jeton d'accès part dans l'en-tête Authorization (jamais dans l'adresse ni dans le corps)", async () => {
    b.idp.userinfo = (u) => ({ sub: u.sub, groups: ["elpis"], preferred_username: u.sub });
    const { retour } = await b.connecter(ELPIS("sub-info", { groups: undefined }));
    expect(retour.statusCode, retour.body).toBe(200);
    const info = b.idp.traces.find((t) => t.chemin.endsWith("/userinfo"));
    expect(info).toBeDefined();
    expect(info?.autorisation).toBe(`Bearer ${b.idp.emis[0]}`);
    expect(info?.corps.size).toBe(0);
  });

  it("ANSSI-PA-080 R32 et RFC 9700 §4.9 : le jeton d'accès n'est ni gardé en base, ni rendu au navigateur, ni écrit au journal", async () => {
    b.idp.userinfo = (u) => ({ sub: u.sub, groups: ["elpis"] });
    const { depart, retour, session } = await b.connecter(ELPIS("sub-acces", { groups: undefined }));
    const acces = b.idp.emis[0] ?? "";
    expect(acces).toMatch(/^acces-/u);
    const tables = ["users", "user_identities", "auth_ext_sessions", "auth_flows", "revoked_sessions"];
    const base = JSON.stringify(await Promise.all(tables.map((t) => b.t.base.valeurs(`SELECT * FROM ${t}`))));
    expect(base.includes(acces)).toBe(false);
    const vu = JSON.stringify([
      depart.reponse.headers,
      depart.reponse.body,
      retour.headers,
      retour.body,
      session,
    ]);
    expect(vu.includes(acces)).toBe(false);
    expect(vu.includes(b.idp.clientSecret)).toBe(false);
  });

  it("ASVS 5.0 V9.1.3 : une clé ou une adresse de clés portée par l'en-tête du jeton (jwk, jku, x5u) n'est jamais utilisée", async () => {
    const attaquant = await generateKeyPair(b.idp.alg, { extractable: true });
    const publique = await exportJWK(attaquant.publicKey);
    for (const entete of [
      { jwk: publique },
      { jwk: { ...publique, kid: "autre" }, kid: "autre" },
      { jku: "https://attaquant.invalid/cles", kid: "inconnue" },
      { x5u: "https://attaquant.invalid/chaine", kid: "inconnue" },
    ]) {
      const r = await retourForge((nonce) =>
        new SignJWT(revendications(nonce))
          .setProtectedHeader({ alg: b.idp.alg, ...entete })
          .sign(attaquant.privateKey),
      );
      expect(codeDeRefus(r), JSON.stringify(Object.keys(entete))).toBe("failed");
    }
  });

  it("ASVS 5.0 V9.2.1 : un jeton d'identité qui n'est pas encore valable (nbf) est refusé", async () => {
    b.idp.pieges = { claims: { nbf: Math.floor(Date.now() / 1000) + 3600 } };
    const { retour } = await b.connecter(ELPIS("sub-nbf"));
    expect(codeDeRefus(retour)).toBe("failed");
    expect(await b.utilisateurs()).toEqual(["chef"]);
  });

  it("ASVS 5.0 V9.2.2 : un jeton de déconnexion présenté comme jeton d'identité est refusé", async () => {
    const r = await retourForge(async (nonce) => {
      const logout = await b.idp.jetonDeconnexion({ sub: "sub-forge", sid: "s1" });
      expect(nonce).not.toBe("");
      return logout;
    });
    expect(codeDeRefus(r)).toBe("failed");
  });
  it("OIDC Core §3.1.3.7 (4) : un jeton d'identité qui nomme un public de plus que le client est refusé", async () => {
    b.idp.pieges = { claims: { aud: [b.idp.clientId, "autre-client"] } };
    const { retour } = await b.connecter(ELPIS("sub-aud"));
    expect(codeDeRefus(retour)).toBe("failed");
    expect(await b.utilisateurs()).toEqual(["chef"]);
  });
});
