// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/oidc-jeton-identite.test.ts — conformité du jeton d'identité : OIDC Core 1.0 §3.1.3.7 (points 1 à 13), §2 (`sub`), RFC 7515 / 7519 (forme et revendications), RFC 8725 (bonnes pratiques JWT). */
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ELPIS, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { MOTEURS } from "../identite/banc";
import type { PiegesJeton } from "../identite/oidc-factice";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { causeDuDernierRefus, codeRefus, maintenant } from "./aides-oidc";

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("conformité du jeton d'identité (%s)", (moteur) => {
  let b: BancOidc;
  beforeEach(async () => {
    b = await ouvrirBancOidc(moteur);
  });
  afterEach(async () => {
    expect(b.idp.erreurs).toEqual([]);
    await b.fermer();
  });

  const accepte = async (p: PiegesJeton, sub = "sub-x"): Promise<void> => {
    b.idp.pieges = p;
    const r = await b.connecter(ELPIS(sub));
    expect(r.retour.statusCode, r.retour.body).toBe(200);
  };
  const refuse = async (p: PiegesJeton, sub = "sub-x", cause?: string): Promise<void> => {
    b.idp.pieges = p;
    const r = await b.connecter(ELPIS(sub));
    expect(codeRefus(r.retour)).toBe("failed");
    if (cause !== undefined) expect(causeDuDernierRefus()).toBe(cause);
    expect(await b.utilisateurs()).toEqual(["chef"]);
  };
  const t = maintenant;
  /** Retour joué avec un jeton fabriqué à partir du vrai nonce du départ. */
  const retourAvecNonce = async (
    fabriquer: (nonce: string) => Promise<string>,
    sub = "sub-x",
  ): Promise<Awaited<ReturnType<BancOidc["retourner"]>>> => {
    const d = await b.demarrer();
    const nonce = new URL(d.url ?? "").searchParams.get("nonce") ?? "";
    b.idp.pieges = { jetonBrut: await fabriquer(nonce) };
    const { retour } = b.idp.autoriser(d.url ?? "", ELPIS(sub));
    return b.retourner(retour, { cookie: d.cookie });
  };

  describe("OIDC Core §3.1.3.7 point 1 : jeton chiffré", () => {
    it("point 1 : un jeton d'identité chiffré (JWE compact à cinq segments) est refusé, aucun mécanisme de déchiffrement n'étant enregistré", async () => {
      const seg = (x: string): string => Buffer.from(x).toString("base64url");
      await refuse({
        jetonBrut: [
          seg('{"alg":"RSA-OAEP","enc":"A256GCM"}'),
          seg("cle"),
          seg("iv"),
          seg("texte"),
          seg("tag"),
        ].join("."),
      });
    });
  });

  describe("point 2 : émetteur", () => {
    it("point 2 : `iss` identique à l'émetteur configuré accepté", async () => accepte({}));
    it("point 2 : `iss` avec une barre finale en plus refusé (comparaison exacte)", async () =>
      refuse({ claims: { iss: `${b.idp.issuer}/` } }, "sub-x", "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED"));
    it("point 2 : `iss` dont l'hôte change de casse refusé (comparaison exacte)", async () =>
      refuse(
        { claims: { iss: b.idp.issuer.replace("elpis-test.invalid", "ELPIS-TEST.invalid") } },
        "sub-x",
        "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED",
      ));
    it("point 2 : `iss` absent refusé", async () =>
      refuse({ sans: ["iss"] }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 2 : `iss` en liste refusé", async () =>
      refuse({ claims: { iss: [b.idp.issuer] } }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 2 : `iss` d'un autre chemin du même hôte refusé", async () =>
      refuse(
        { claims: { iss: `${b.idp.origine}/realms/autre` } },
        "sub-x",
        "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED",
      ));
  });

  describe("points 3, 4 et 5 : public et partie autorisée", () => {
    it("point 3 : `aud` chaîne égale au client accepté", async () => accepte({ claims: { aud: "elpis" } }));
    it("point 3 : `aud` liste d'un seul élément égal au client accepté", async () =>
      accepte({ claims: { aud: ["elpis"] } }));
    it("Core §3.1.3.7 (3) : un public supplémentaire, même avec `azp` égal au client, est refusé (cause `aud_untrusted`) ; `aud` à un seul élément ou chaîne égal au client accepté", async () => {
      await refuse({ claims: { aud: ["elpis", "api-ressource"], azp: "elpis" } });
      expect(causeDuDernierRefus()).toBe("aud_untrusted");
      await accepte({ claims: { aud: ["elpis"], azp: "elpis" } }, "sub-y");
      await accepte({ claims: { aud: "elpis", azp: "elpis" } }, "sub-z");
    });
    it("points 4 et 5 : `aud` à plusieurs éléments sans `azp` refusé", async () =>
      refuse(
        { claims: { aud: ["elpis", "api-ressource"] } },
        "sub-x",
        "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED",
      ));
    it("point 5 : `aud` à plusieurs éléments avec `azp` d'un autre client refusé", async () =>
      refuse(
        { claims: { aud: ["elpis", "autre"], azp: "autre" } },
        "sub-x",
        "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED",
      ));
    it("point 3 : `aud` liste sans le client refusé", async () =>
      refuse({ claims: { aud: ["autre", "api"] } }, "sub-x", "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED"));
    it("point 3 : `aud` d'un autre client refusé", async () =>
      refuse({ claims: { aud: "autre" } }, "sub-x", "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED"));
    it("point 3 : `aud` de casse différente refusé (comparaison exacte)", async () =>
      refuse({ claims: { aud: "ELPIS" } }, "sub-x", "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED"));
    it("point 3 : `aud` absent refusé", async () =>
      refuse({ sans: ["aud"] }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 3 : `aud` non texte refusé", async () =>
      refuse({ claims: { aud: 5 } }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 5 : `azp` égal au client avec `aud` simple accepté", async () =>
      accepte({ claims: { azp: "elpis" } }));
    it("point 5 : `azp` d'un autre client avec `aud` simple refusé, refusé par choix (plus strict que la norme)", async () =>
      refuse({ claims: { azp: "autre" } }, "sub-x", "azp_mismatch"));
  });

  describe("points 6, 7 et 8 : signature et algorithme", () => {
    it("point 7 : signature juste accepte", async () => accepte({}));
    it("point 6 : signature fausse refusée même reçue directement du point de jetons (TLS ne dispense pas de la signature)", async () =>
      refuse({ signerAvecAutreCle: true }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 7 / RFC 8725 §3.2 : `alg` none refusé", async () =>
      refuse({ alg: "none" }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 8 : HS256 signé avec le secret du client refusé (plus strict que la norme : aucun algorithme à clé partagée)", async () =>
      refuse({ alg: "HS256" }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 8 : HS512 signé avec le secret du client refusé (plus strict que la norme)", async () =>
      refuse({ alg: "HS512" }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("RFC 8725 §3.1 : confusion d'algorithme : HS256 signé avec la clé publique du fournisseur comme secret refusé", async () => {
      const jwk = JSON.stringify(b.idp.jwkPublic);
      const r = await retourAvecNonce((nonce) =>
        new SignJWT({ iss: b.idp.issuer, sub: "sub-x", aud: "elpis", iat: t(), exp: t() + 300, nonce })
          .setProtectedHeader({ alg: "HS256", kid: b.idp.jwkPublic.kid ?? "" })
          .sign(new TextEncoder().encode(jwk)),
      );
      expect(codeRefus(r)).toBe("failed");
      expect(causeDuDernierRefus()).toBe("lib:OAUTH_INVALID_RESPONSE");
      expect(await b.utilisateurs()).toEqual(["chef"]);
    });
    it("point 7 / RFC 8725 §3.1 : algorithme du jeton (ES256) différent de l'algorithme réglé (RS256) refusé", async () => {
      await b.reglages({ id_token_alg: "RS256" });
      await refuse({}, "sub-x", "lib:OAUTH_INVALID_RESPONSE");
    });
  });

  describe("point 9 : expiration", () => {
    it("point 9 : `exp` dans le futur accepté", async () => accepte({ claims: { exp: t() + 3600 } }));
    it("point 9 : `exp` dépassé au-delà de la tolérance refusé", async () =>
      refuse({ claims: { exp: t() - 3600 } }, "sub-x", "lib:OAUTH_JWT_TIMESTAMP_CHECK_FAILED"));
    it("point 9 : `exp` absent refusé", async () =>
      refuse({ sans: ["exp"] }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 9 : `exp` en chaîne refusé", async () =>
      refuse({ claims: { exp: String(t() + 300) } }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 9 / RFC 7519 §4.1.4 : `exp` fractionnaire accepté (NumericDate)", async () =>
      accepte({ claims: { exp: t() + 300.5 } }));
    it("RFC 7519 §4.1.5 : `nbf` dans le futur refusé", async () =>
      refuse({ claims: { nbf: t() + 3600 } }, "sub-x", "lib:OAUTH_JWT_TIMESTAMP_CHECK_FAILED"));
    it("RFC 7519 §4.1.5 : `nbf` passé accepté", async () => accepte({ claims: { nbf: t() - 60 } }));
  });

  describe("point 10 : date d'émission", () => {
    it("point 10 : `iat` absent refusé", async () =>
      refuse({ sans: ["iat"] }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 10 : `iat` dans le futur au-delà de la tolérance refusé", async () =>
      refuse({ claims: { iat: t() + 3600 } }, "sub-x", "iat_in_future"));
    it("point 10 : `iat` en chaîne refusé", async () =>
      refuse({ claims: { iat: String(t()) } }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 10 : `iat` ancien mais `exp` dans le futur accepté (le rejet des jetons trop vieux est facultatif dans la norme)", async () =>
      accepte({ claims: { iat: t() - 86_400 } }));
  });

  describe("point 11 : nonce", () => {
    it("point 11 : `nonce` absent refusé", async () =>
      refuse({ sans: ["nonce"] }, "sub-x", "lib:OAUTH_INVALID_RESPONSE"));
    it("point 11 : `nonce` faux refusé", async () =>
      refuse({ claims: { nonce: "autre" } }, "sub-x", "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED"));
    it("point 11 : `nonce` en liste refusé", async () =>
      refuse({ claims: { nonce: [b.idp.clientId] } }, "sub-x", "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED"));
    it("point 11 : `nonce` vide refusé", async () =>
      refuse({ claims: { nonce: "" } }, "sub-x", "lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED"));
    it("OIDC Core §15.5.2 : un jeton déjà utilisé pour un autre flux (nonce d'un autre départ) refusé", async () => {
      const a = await b.demarrer();
      const { retour: r1 } = b.idp.autoriser(a.url ?? "", ELPIS("sub-a"));
      const premier = await b.retourner(r1, { cookie: a.cookie });
      expect(premier.statusCode).toBe(200);
      const nonceDuPremier = new URL(a.url ?? "").searchParams.get("nonce") ?? "";
      b.idp.pieges = { claims: { nonce: nonceDuPremier } };
      const c = await b.connecter(ELPIS("sub-b"));
      expect(codeRefus(c.retour)).toBe("failed");
      expect(causeDuDernierRefus()).toBe("lib:OAUTH_JWT_CLAIM_COMPARISON_FAILED");
    });
  });

  describe("points 12 et 13 : acr et auth_time", () => {
    it("point 12 : `acr` demandé et rendu en liste de valeurs : valeur de la liste réglée acceptée", async () => {
      await b.reglages({ required_acr: ["urn:mace:incommon:iap:silver", "mfa"] });
      b.idp.pieges = { claims: { acr: "mfa" } };
      expect((await b.connecter(ELPIS("sub-x"))).retour.statusCode).toBe(200);
    });
    it("point 12 : `acr` demandé : valeur hors de la liste, de casse différente ou numérique refusée (mfa_required)", async () => {
      await b.reglages({ required_acr: ["mfa"] });
      for (const acr of ["pwd", "MFA", 2, ["mfa"]]) {
        b.idp.pieges = { claims: { acr } };
        expect(codeRefus((await b.connecter(ELPIS("sub-x"))).retour), String(acr)).toBe("mfa_required");
      }
    });
    it("point 12 : `acr_values` demandé dans la requête d'autorisation, espace comme séparateur", async () => {
      await b.reglages({ required_acr: ["a", "b"] });
      expect(new URL((await b.demarrer()).url ?? "").searchParams.get("acr_values")).toBe("a b");
    });
    it("point 13 : `max_age` demandé : `auth_time` récent accepté, absent refusé, trop ancien refusé, dans le futur au-delà de la tolérance refusé", async () => {
      await b.reglages({ max_age_sec: 300 });
      await accepte({ claims: { auth_time: t() - 10 } });
      b.idp.pieges = { sans: ["auth_time"] };
      expect(codeRefus((await b.connecter(ELPIS("sub-y"))).retour)).toBe("failed");
      b.idp.pieges = { claims: { auth_time: t() - 3600 } };
      expect(codeRefus((await b.connecter(ELPIS("sub-y"))).retour)).toBe("failed");
      b.idp.pieges = { claims: { auth_time: "maintenant" } };
      expect(codeRefus((await b.connecter(ELPIS("sub-y"))).retour)).toBe("failed");
    });
    it("point 13 : `max_age` demandé dans la requête d'autorisation (entier en secondes)", async () => {
      await b.reglages({ max_age_sec: 300 });
      expect(new URL((await b.demarrer()).url ?? "").searchParams.get("max_age")).toBe("300");
    });
    it("point 13 : sans `max_age`, `auth_time` absent accepté", async () => accepte({ sans: ["auth_time"] }));
  });

  describe("OIDC Core §2 : sub", () => {
    it("§2 : `sub` de 255 caractères ASCII accepté", async () =>
      accepte({ claims: { sub: "a".repeat(255) } }));
    it("§2 : `sub` de 256 caractères refusé", async () => refuse({ claims: { sub: "a".repeat(256) } }));
    it("§2 : `sub` vide, absent, numérique, booléen, liste ou objet refusé", async () => {
      for (const sub of ["", 12, true, ["a"], { a: 1 }, null]) await refuse({ claims: { sub } });
      await refuse({ sans: ["sub"] });
    });
    it("§2 : `sub` sensible à la casse : deux sujets qui ne diffèrent que par la casse sont deux comptes distincts", async () => {
      expect((await b.connecter({ ...ELPIS("Alice"), sub: "Alice" })).retour.statusCode).toBe(200);
      expect((await b.connecter({ ...ELPIS("alice-bis"), sub: "alice" })).retour.statusCode).toBe(200);
      expect(await b.t.base.valeurs("SELECT COUNT(*) FROM user_identities")).toEqual([[2]]);
    });
    it("§2 : `sub` à caractères non ASCII accepté (la norme parle d'ASCII, le produit ne l'exige pas)", async () =>
      accepte({ claims: { sub: "utilisateur-é" } }));
    it("§2 : `sub` avec une moitié de paire de substitution Unicode refusé", async () =>
      refuse({ claims: { sub: "a\ud800" } }));
  });

  describe("RFC 7515 / 7519 : forme du jeton", () => {
    const seg = (x: string): string => Buffer.from(x).toString("base64url");
    it("RFC 7515 §7.1 : un jeton en sérialisation JSON (non compacte) refusé", async () =>
      refuse({ jetonBrut: JSON.stringify({ payload: seg("{}"), signatures: [] }) }));
    it("RFC 7515 §7.1 : un jeton à deux ou quatre segments refusé", async () => {
      await refuse({ jetonBrut: `${seg("{}")}.${seg("{}")}` });
      await refuse({ jetonBrut: `${seg("{}")}.${seg("{}")}.${seg("x")}.${seg("y")}` });
    });
    it("RFC 7515 §5.2 : signature vide refusée", async () => {
      const fabrique = (nonce: string): Promise<string> =>
        b.idp.fabriquerJeton(
          { utilisateur: ELPIS("sub-x"), nonce, challenge: "", redirectUri: "", clientId: "elpis" },
          {},
        );
      const vide = await retourAvecNonce(
        async (n) => `${(await fabrique(n)).split(".").slice(0, 2).join(".")}.`,
      );
      expect(codeRefus(vide)).toBe("failed");
      expect(causeDuDernierRefus()).toBe("lib:OAUTH_INVALID_RESPONSE");
      expect(await b.utilisateurs()).toEqual(["chef"]);
      expect((await retourAvecNonce(fabrique, "sub-y")).statusCode).toBe(200);
    });
    it("RFC 7515 §5 : témoin : le même jeton signé à la main, sans `crit`, est accepté (la signature manuelle des cas suivants est valide)", async () =>
      accepte({ signatureManuelle: true }));
    it("RFC 7515 §4.1.11 : paramètre d'en-tête critique inconnu (`crit`) refusé", async () =>
      refuse({ signatureManuelle: true, entete: { crit: ["exp-etendu"], "exp-etendu": 1 } }));
    it("RFC 7797 : `b64: false` avec `crit` refusé", async () =>
      refuse({ signatureManuelle: true, entete: { b64: false, crit: ["b64"] } }));
    it("RFC 8725 §3.10 : clé embarquée dans l'en-tête (`jwk`) jamais utilisée : jeton signé par la clé de l'attaquant refusé", async () => {
      const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
      const jwk = await exportJWK(publicKey);
      await refuse({ cleDeSignature: privateKey, entete: { jwk, kid: undefined } });
    });
    it("RFC 8725 §3.10 : adresse de clé dans l'en-tête (`jku`, `x5u`) jamais suivie : aucune requête vers elle, jeton signé par une autre clé refusé", async () => {
      const avant = b.idp.traces.length;
      await refuse({
        signerAvecAutreCle: true,
        entete: { jku: `${b.idp.origine}/jwks-attaquant`, x5u: `${b.idp.origine}/x5u` },
      });
      expect(
        b.idp.traces.slice(avant).some((r) => r.chemin === "/jwks-attaquant" || r.chemin === "/x5u"),
      ).toBe(false);
    });
    it("RFC 8725 §3.10 : `kid` hostile (injection) traité comme une valeur opaque : jeton refusé, rien d'inattendu", async () =>
      refuse({ kid: "../../etc/passwd'; DROP TABLE users;--" }));
    it("RFC 7519 §5.1 : `typ` absent accepté, `typ` JWT accepté", async () => {
      await accepte({ entete: { typ: undefined } });
      await accepte({ entete: { typ: "JWT" } }, "sub-y");
    });
    it("RFC 8725 §3.12 : un jeton de déconnexion valide (`logout+jwt`, sans `nonce`) présenté comme jeton d'identité refusé", async () => {
      const jeton = await b.idp.jetonDeconnexion(
        { sid: "s", sub: "sub-x" },
        { entete: { typ: "logout+jwt" } },
      );
      await refuse({ jetonBrut: jeton });
    });
  });

  describe("OIDC Core §3.1.3.3 et RFC 6749 §5.1 : réponse du point de jetons", () => {
    const repondre = (corps: Record<string, unknown>): void => {
      b.idp.extraJetons = corps;
    };
    it("§3.1.3.3 : `id_token` absent de la réponse refusé", async () => refuse({ sansJeton: true }));
    it("§3.1.3.3 : `token_type` `bearer` en minuscules accepté (RFC 6749 §7.1 : insensible à la casse)", async () => {
      repondre({ token_type: "bearer" });
      expect((await b.connecter(ELPIS("sub-x"))).retour.statusCode).toBe(200);
    });
    it("§3.1.3.3 : `token_type` `Bearer` accepté", async () => {
      repondre({ token_type: "Bearer" });
      expect((await b.connecter(ELPIS("sub-x"))).retour.statusCode).toBe(200);
    });
    it("§3.1.3.3 : `token_type` `mac` refusé", async () => {
      repondre({ token_type: "mac" });
      expect(codeRefus((await b.connecter(ELPIS("sub-x"))).retour)).toBe("failed");
    });
    it("RFC 6749 §5.1 : `token_type` absent refusé", async () => {
      repondre({ token_type: undefined });
      expect(codeRefus((await b.connecter(ELPIS("sub-x"))).retour)).toBe("failed");
    });
    it("RFC 6749 §5.1 : `access_token` absent refusé", async () => {
      repondre({ access_token: undefined });
      expect(codeRefus((await b.connecter(ELPIS("sub-x"))).retour)).toBe("failed");
    });
    it("RFC 6749 §5.1 : champs inconnus, `scope`, `refresh_token`, `ext_expires_in` ignorés", async () => {
      repondre({ scope: "openid profile", refresh_token: "r", ext_expires_in: 600, foo: { a: 1 } });
      expect((await b.connecter(ELPIS("sub-x"))).retour.statusCode).toBe(200);
    });
    it("RFC 6749 §5.1 : `expires_in` en chaîne (usage de certains produits) accepté", async () => {
      repondre({ expires_in: "3599" });
      expect((await b.connecter(ELPIS("sub-x"))).retour.statusCode).toBe(200);
    });
    it("OIDC Core §3.1.3.8 : `at_hash` présent dans le jeton d'identité accepté même faux (`at_hash` n'est pas vérifié, ce que la norme permet)", async () =>
      accepte({ claims: { at_hash: "x".repeat(22) } }));
    it("OIDC Core §2 : `sid` présent accepté et rangé, absent accepté", async () => {
      await accepte({ claims: { sid: "sid-1" } });
      await accepte({ sans: ["sid"] }, "sub-z");
      const lignes = await b.t.base.valeurs<[string | null]>("SELECT idp_sid FROM auth_ext_sessions");
      expect(lignes.map((r) => r[0] ?? "(aucun)").sort()).toEqual(["(aucun)", "sid-1"]);
    });
    it("OIDC Core §2 : `sid` non texte, vide ou de plus de 255 caractères ignoré sans refuser la connexion", async () => {
      for (const sid of [5, "", "s".repeat(256)])
        await accepte({ claims: { sid } }, `sub-${String(sid).length}`);
      expect(
        await b.t.base.valeurs("SELECT COUNT(*) FROM auth_ext_sessions WHERE idp_sid IS NOT NULL"),
      ).toEqual([[0]]);
    });
    it("OIDC Core §5.1 : `amr` en liste, `acr` en adresse, `auth_time` absent, `email_verified` en chaîne : acceptés", async () => {
      await accepte({
        claims: {
          amr: ["pwd", "otp"],
          acr: "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
          email: "a@b.c",
          email_verified: "true",
        },
        sans: ["auth_time"],
      });
    });
  });
});
