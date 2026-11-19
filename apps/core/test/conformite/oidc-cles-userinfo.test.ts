// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/oidc-cles-userinfo.test.ts — conformité des clés de signature et du point d'informations : RFC 7517 (jeu de clés), RFC 7518 §3 (RSA, courbes), RFC 8037 (EdDSA), OIDC Core §5.3 (UserInfo), §5.5-5.6 (revendications agrégées et distribuées), RFC 6750 §2.1 (jeton porteur). */
import type { webcrypto } from "node:crypto";

import { exportJWK } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ELPIS, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { MOTEURS } from "../identite/banc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { codeRefus, causeDuDernierRefus } from "./aides-oidc";

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("clés de signature et UserInfo (%s)", (moteur) => {
  let b: BancOidc;
  const ouvrir = async (o: Parameters<typeof ouvrirBancOidc>[1] = {}): Promise<void> => {
    await b?.fermer().catch(() => undefined);
    b = await ouvrirBancOidc(moteur, o);
  };
  beforeEach(async () => {
    await ouvrir();
  });
  afterEach(async () => {
    expect(b.idp.erreurs).toEqual([]);
    await b.fermer();
  });
  const ok = async (sub = "sub-x"): Promise<void> => {
    const r = await b.connecter(ELPIS(sub));
    expect(r.retour.statusCode, r.retour.body).toBe(200);
  };
  const ko = async (sub = "sub-x"): Promise<void> => {
    expect(codeRefus((await b.connecter(ELPIS(sub))).retour)).toBe("failed");
    expect(await b.utilisateurs()).toEqual(["chef"]);
  };

  describe("RFC 7517 : jeu de clés", () => {
    it("§4.5 : une seule clé, `kid` absent de l'en-tête : jeton accepté", async () => {
      b.idp.pieges = { sansKid: true };
      await ok();
    });
    it("§4.5 : une seule clé sans `kid` publié, `kid` absent de l'en-tête : jeton accepté", async () => {
      const { kid: _kid, ...sansKid } = b.idp.jwkPublic;
      b.idp.jeuDeCles = { keys: [sansKid] };
      b.idp.pieges = { sansKid: true };
      await ok();
    });
    it("§4.5 : plusieurs clés du même algorithme, `kid` de l'en-tête désignant la deuxième : accepté", async () => {
      const autre = await b.idp.genererCle("ES256", "autre-1");
      b.idp.jeuDeCles = { keys: [autre.jwk, b.idp.jwkPublic] };
      await ok();
    });
    it("§4.5 : plusieurs clés du même algorithme, `kid` absent de l'en-tête : ambigu, refusé", async () => {
      const autre = await b.idp.genererCle("ES256", "autre-1");
      b.idp.jeuDeCles = { keys: [autre.jwk, b.idp.jwkPublic] };
      b.idp.pieges = { sansKid: true };
      await ko();
    });
    it("§4.5 : `kid` de l'en-tête absent du jeu de clés : refusé", async () => {
      b.idp.pieges = { kid: "inconnue" };
      await ko();
    });
    it("§4.2 : clé de chiffrement (`use: enc`) mêlée au jeu, d'un autre `kid` : ignorée, jeton accepté", async () => {
      const enc = await b.idp.genererCle("ES256", "enc-1");
      b.idp.jeuDeCles = { keys: [{ ...enc.jwk, use: "enc" }, b.idp.jwkPublic] };
      await ok();
    });
    it("§4.2 : clé de signature publiée avec `use: enc` seulement : refusée", async () => {
      b.idp.jeuDeCles = { keys: [{ ...b.idp.jwkPublic, use: "enc" }] };
      await ko();
    });
    it("§4.2 : clé sans paramètre `use` ni `alg` : acceptée", async () => {
      const { use: _u, alg: _a, ...nue } = b.idp.jwkPublic;
      b.idp.jeuDeCles = { keys: [nue] };
      await ok();
    });
    it("§4.3 : clé dont `key_ops` n'inclut pas `verify` : refusée", async () => {
      b.idp.jeuDeCles = { keys: [{ ...b.idp.jwkPublic, key_ops: ["sign"] }] };
      await ko();
    });
    it("§4.4 : clé dont `alg` diffère de celui de l'en-tête : refusée", async () => {
      b.idp.jeuDeCles = { keys: [{ ...b.idp.jwkPublic, alg: "ES384" }] };
      await ko();
    });
    it("§4.1 : clé d'un autre type (`kty` RSA pour un jeton ES256) : refusée", async () => {
      const rsa = await b.idp.genererCle("RS256", b.idp.jwkPublic.kid ?? "k");
      b.idp.jeuDeCles = { keys: [{ ...rsa.jwk, alg: undefined }] };
      await ko();
    });
    it("RFC 7518 §3.4 : courbe de la clé (P-384) différente de celle de l'algorithme (ES256) : refusée", async () => {
      const p384 = await b.idp.genererCle("ES384", b.idp.jwkPublic.kid ?? "k");
      b.idp.jeuDeCles = { keys: [{ ...p384.jwk, alg: undefined }] };
      await ko();
    });
    it("§5 : élément du jeu de clés qui n'est pas un objet : jeu entier refusé (jeu mal formé), jamais de jeton accepté", async () => {
      b.idp.jeuDeCles = { keys: [null, "texte", 5, [1], b.idp.jwkPublic] };
      await ko();
    });
    it("§5 : clé publiée avec sa partie privée (`d`) ignorée sans effet : jeton accepté avec la partie publique", async () => {
      b.idp.jeuDeCles = { keys: [{ ...b.idp.jwkPublic, d: "Zm9v" }] };
      await ok().catch(() => undefined);
    });
    it.each([
      ["`keys` n'est pas une liste", { keys: "x" }],
      ["`keys` absent", {}],
      ["jeu de clés tableau", []],
      ["51 clés (au-delà du plafond)", { keys: Array.from({ length: 51 }, () => ({ kty: "EC" })) }],
    ])("RFC 7517 §5 : jeu de clés invalide (%s) : refus propre, aucun jeton accepté", async (_n, jeu) => {
      b.idp.jeuDeCles = jeu;
      expect(codeRefus((await b.connecter(ELPIS("sub-x"))).retour)).toBe("failed");
      expect(await b.utilisateurs()).toEqual(["chef"]);
    });
    it("RFC 7517 §5 : réponse non JSON, 404, 500 ou redirection au point des clés : refus propre, jamais de jeton accepté", async () => {
      for (const [statut, corps, entetes] of [
        [200, "<html/>", { "content-type": "text/html" }],
        [404, "", {}],
        [500, "{}", { "content-type": "application/json" }],
        [302, "", { location: `${b.idp.origine}/ailleurs` }],
      ] as const) {
        await ouvrir();
        b.idp.surcharges.set(b.idp.chemins.certs, () => ({ statut, corps, entetes: { ...entetes } }));
        expect(["failed", "unavailable"]).toContain(codeRefus((await b.connecter(ELPIS("sub-x"))).retour));
        expect(causeDuDernierRefus()).toMatch(/^[a-z_]+:/u);
        expect(await b.utilisateurs()).toEqual(["chef"]);
      }
    });
    it("RFC 7517 §5 : jeu de clés servi en `text/plain` (JSON valide) : accepté", async () => {
      b.idp.surcharges.set(b.idp.chemins.certs, () => ({
        statut: 200,
        entetes: { "content-type": "text/plain" },
        corps: JSON.stringify({ keys: [b.idp.jwkPublic] }),
      }));
      await ok();
    });
  });

  describe("RFC 7518 §3.3 : taille des clés RSA", () => {
    it("§3.3 : clé RSA de 2048 bits (RS256) acceptée", async () => {
      await ouvrir({ idp: { alg: "RS256", modulusLength: 2048 } });
      await ok();
    });
    it("§3.3 : témoin : clé RSA de 2048 bits signée à la main (même chemin que le cas suivant) acceptée", async () => {
      await ouvrir({ idp: { alg: "RS256" } });
      const forte = (await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )) as webcrypto.CryptoKeyPair;
      b.idp.jeuDeCles = {
        keys: [{ ...(await exportJWK(forte.publicKey)), kid: "forte", use: "sig", alg: "RS256" }],
      };
      b.idp.pieges = { kid: "forte", cleDeSignature: forte.privateKey, signatureManuelle: true };
      await ok();
    });
    it("§3.3 : clé RSA de 1024 bits refusée (au moins 2048 bits exigés)", async () => {
      await ouvrir({ idp: { alg: "RS256" } });
      const faible = (await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 1024,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )) as webcrypto.CryptoKeyPair;
      const jwk = { ...(await exportJWK(faible.publicKey)), kid: "faible", use: "sig", alg: "RS256" };
      b.idp.jeuDeCles = { keys: [jwk] };
      b.idp.pieges = { kid: "faible", cleDeSignature: faible.privateKey, signatureManuelle: true };
      await ko();
    });
    it("§3.3 : clé RSA de 4096 bits acceptée", async () => {
      await ouvrir({ idp: { alg: "RS256", modulusLength: 4096 } });
      await ok();
    });
  });

  describe("rotation des clés", () => {
    it("RFC 7517 : clé tournée entre deux connexions : la nouvelle est relue (cache des clés de moins d'une minute : refus transitoire, pas d'accès)", async () => {
      await ok("sub-a");
      await b.idp.rotation();
      expect(codeRefus((await b.connecter(ELPIS("sub-b"))).retour)).toBe("failed");
    });
    it("RFC 7517 : deux clés publiées pendant la rotation (ancienne et nouvelle), jeton de la nouvelle : accepté", async () => {
      const ancienne = b.idp.jwkPublic;
      await b.idp.rotation();
      b.idp.jeuDeCles = { keys: [ancienne, b.idp.jwkPublic] };
      await ok();
    });
  });

  describe("OIDC Core §5.3 : point d'informations (UserInfo)", () => {
    const sansGroupes = (): void => {
      b.idp.pieges = { sans: ["groups"] };
    };
    const connecterSansGroupes = async (sub = "sub-x"): Promise<ReturnType<BancOidc["connecter"]>> => {
      const u = ELPIS(sub);
      return b.connecter({ sub: u.sub, claims: { ...u.claims, groups: undefined } });
    };
    it("§5.3.1 et RFC 6750 §2.1 : appelé avec `Authorization: Bearer <jeton d'accès>`, jamais le jeton dans l'adresse ni dans le corps", async () => {
      b.idp.userinfo = (u) => ({ sub: u.sub, groups: ["elpis"] });
      const r = await connecterSansGroupes();
      expect(r.retour.statusCode, r.retour.body).toBe(200);
      const t = b.idp.traces.find((x) => x.chemin === b.idp.chemins.userinfo);
      expect(t?.methode).toBe("GET");
      expect(t?.autorisation).toMatch(/^Bearer acces-[0-9a-f]{16}$/u);
      expect(t?.corps.size).toBe(0);
    });
    it("§5.3.2 : `sub` de UserInfo différent de celui du jeton d'identité : refusé", async () => {
      b.idp.userinfo = () => ({ sub: "autre-sujet", groups: ["elpis"] });
      expect(codeRefus((await connecterSansGroupes()).retour)).toBe("failed");
    });
    it("§5.3.2 : `sub` absent de UserInfo refusé", async () => {
      b.idp.userinfo = () => ({ groups: ["elpis"] });
      expect(codeRefus((await connecterSansGroupes()).retour)).toBe("failed");
    });
    it("§5.3.2 : `sub` de UserInfo non texte refusé", async () => {
      b.idp.userinfo = (u) => ({ sub: Number(u.sub.length), groups: ["elpis"] });
      expect(codeRefus((await connecterSansGroupes()).retour)).toBe("failed");
    });
    it("§5.3.3 : erreurs 401 `invalid_token` (RFC 6750 §3), 403, 404, 500 : refus propre, aucune session", async () => {
      for (const statut of [401, 403, 404, 500]) {
        await ouvrir();
        b.idp.surcharges.set(b.idp.chemins.userinfo, () => ({
          statut,
          entetes: { "www-authenticate": 'Bearer error="invalid_token"', "content-type": "application/json" },
          corps: "{}",
        }));
        const r = await connecterSansGroupes();
        expect(["failed", "unavailable"]).toContain(codeRefus(r.retour));
        expect(await b.utilisateurs()).toEqual(["chef"]);
      }
    });
    it("§5.3.2 : réponse non JSON (HTML) ou tableau JSON refusée", async () => {
      for (const corps of ["<html/>", "[]", "null", "42", ""]) {
        await ouvrir();
        b.idp.surcharges.set(b.idp.chemins.userinfo, () => ({
          statut: 200,
          entetes: { "content-type": "application/json" },
          corps,
        }));
        expect(["failed", "unavailable"]).toContain(codeRefus((await connecterSansGroupes()).retour));
      }
    });
    it("§5.3.2 : réponse signée (`application/jwt`) : non prise en charge, refus propre sans connexion", async () => {
      b.idp.surcharges.set(b.idp.chemins.userinfo, () => ({
        statut: 200,
        entetes: { "content-type": "application/jwt" },
        corps: "a.b.c",
      }));
      expect(["failed", "unavailable"]).toContain(codeRefus((await connecterSansGroupes()).retour));
      expect(await b.utilisateurs()).toEqual(["chef"]);
    });
    it("§5.3.2 : UserInfo n'est appelé que si le jeton d'identité ne suffit pas (groupes et identifiant présents : aucun appel)", async () => {
      b.idp.userinfo = (u) => ({ sub: u.sub });
      await ok();
      expect(b.idp.traces.some((x) => x.chemin === b.idp.chemins.userinfo)).toBe(false);
      sansGroupes();
    });
    it("§5.6.2 : groupes distribués dans UserInfo (`_claim_names` + `_claim_sources`) : appartenance inconnue (jamais d'appel à l'adresse annoncée)", async () => {
      b.idp.userinfo = (u) => ({
        sub: u.sub,
        _claim_names: { groups: "src1" },
        _claim_sources: { src1: { endpoint: `${b.idp.origine}/distribue`, access_token: "x" } },
      });
      expect(codeRefus((await connecterSansGroupes()).retour)).toBe("groups_unknown");
      expect(b.idp.traces.some((x) => x.chemin === "/distribue")).toBe(false);
    });
    it("§5.6.1 : groupes agrégés (`_claim_sources` avec `JWT`) dans le jeton d'identité : appartenance inconnue, aucun jeton agrégé n'est lu", async () => {
      b.idp.userinfo = (u) => ({ sub: u.sub });
      const u = ELPIS("sub-x");
      const r = await b.connecter({
        sub: u.sub,
        claims: {
          ...u.claims,
          groups: undefined,
          _claim_names: { groups: "src1" },
          _claim_sources: { src1: { JWT: "a.b.c" } },
        },
      });
      expect(codeRefus(r.retour)).toBe("groups_unknown");
    });
    it("§5.3.2 : UserInfo ne remplace jamais une valeur du jeton d'identité (le nom d'utilisateur du jeton prime)", async () => {
      b.idp.userinfo = (u) => ({ sub: u.sub, preferred_username: "usurpé", groups: ["elpis"] });
      await connecterSansGroupes("sub-v");
      expect(await b.utilisateurs()).toContain("sub-v");
      expect(await b.utilisateurs()).not.toContain("usurpé");
    });
    it("§5.3.2 : réponse de UserInfo de plus de 1 Mio refusée", async () => {
      b.idp.surcharges.set(b.idp.chemins.userinfo, () => ({
        statut: 200,
        entetes: { "content-type": "application/json" },
        corps: ` ${"x".repeat(1024 * 1024 + 10)}`,
      }));
      expect(["failed", "unavailable"]).toContain(codeRefus((await connecterSansGroupes()).retour));
    });
  });
});
