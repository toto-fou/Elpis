// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-essai.test.ts — le bouton « Tester » d'un fournisseur OIDC lit les clés, vérifie les algorithmes annoncés, l'origine des points d'accès, l'authentification du client et le secret, avertit sur un sujet inhabituel et ne vaut jamais test complet. */
import { generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testerFournisseur } from "../src/identite/essai";
import type { ContexteEssai } from "../src/identite/essai";
import { oidcValide } from "./identite/aides";
import { OidcFactice, VERS_BOUCLE } from "./identite/oidc-factice";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

const CONTEXTE: ContexteEssai = {
  publicUrl: "https://elpis.exemple.lan",
  cookieSecure: true,
  adminsLocaux: 1,
};

describe.skipIf(!OPENSSL_DISPONIBLE)("test d'un fournisseur OIDC", () => {
  let idp: OidcFactice;
  beforeAll(async () => {
    idp = await OidcFactice.demarrer();
  });
  afterAll(async () => {
    await idp.fermer();
  });

  const tester = async (extra: Record<string, unknown> = {}, secret: string | null = "s3cr3t") => {
    const r = await testerFournisseur(
      oidcValide({
        issuer: idp.issuer,
        id_token_alg: "ES256",
        ca_pem: idp.ca.cert,
        required_groups: ["elpis"],
        ...extra,
      }),
      CONTEXTE,
      { sortant: { juger: VERS_BOUCLE }, oidc: { secretEnregistre: async () => secret } },
    );
    return { ...r, par: Object.fromEntries(r.steps.map((e) => [e.id, e.level])) };
  };

  it("fournisseur conforme : toutes les étapes vertes, mais jamais un test complet", async () => {
    const r = await tester();
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.par).toMatchObject({
      settings: "ok",
      discovery: "ok",
      endpoints: "ok",
      algorithms: "ok",
      jwks: "ok",
      client_auth: "ok",
      secret: "ok",
    });
    expect(r.steps.find((e) => e.id === "jwks")?.detail).toContain("1 clé(s) de signature ES256");
  });

  it("algorithme réglé non annoncé : échec ; signatures symétriques ou nulles annoncées : avertissement", async () => {
    expect((await tester({ id_token_alg: "RS256" })).par["algorithms"]).toBe("fail");
    idp.decouverte = { id_token_signing_alg_values_supported: ["ES256", "HS256", "none"] };
    expect((await tester()).par["algorithms"]).toBe("warn");
    idp.decouverte = {};
  });

  it("aucune clé de signature de l'algorithme réglé dans le jeu de clés : échec", async () => {
    const r = await tester({ id_token_alg: "RS256" });
    expect(r.par["jwks"]).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("jeu de clés illisible, trop gros ou en erreur : échec lisible", async () => {
    idp.decouverte = { jwks_uri: idp.url("/realms/elpis/trop-gros") };
    const r = await tester();
    expect(r.par["jwks"]).toBe("fail");
    expect(r.steps.find((e) => e.id === "jwks")?.detail).toContain("volumineuse");
    idp.decouverte = { jwks_uri: idp.url("/realms/elpis/introuvable") };
    expect((await tester()).par["jwks"]).toBe("fail");
    idp.decouverte = {};
  });

  it("méthode d'authentification du client non annoncée : échec ; non annoncée du tout : valeur par défaut du protocole", async () => {
    idp.decouverte = { token_endpoint_auth_methods_supported: ["private_key_jwt"] };
    expect((await tester()).par["client_auth"]).toBe("fail");
    idp.decouverte = { token_endpoint_auth_methods_supported: undefined };
    expect((await tester({ client_auth: "basic" })).par["client_auth"]).toBe("ok");
    expect((await tester({ client_auth: "post" })).par["client_auth"]).toBe("warn");
    idp.decouverte = {};
  });

  it("point d'accès sur une autre origine : la découverte échoue et rien ne suit", async () => {
    idp.decouverte = { token_endpoint: "https://autre.exemple.lan/token" };
    const r = await tester();
    expect(r.par["discovery"]).toBe("fail");
    expect(r.par).not.toHaveProperty("jwks");
    idp.decouverte = {};
  });

  it("secret absent : échec ; sujet autre que `sub` et requête poussée : avertissements", async () => {
    expect((await tester({}, null)).par["secret"]).toBe("fail");
    idp.activerPar();
    const r = await tester({ subject_claim: "oid" });
    expect(r.par).toMatchObject({ subject: "warn", par: "warn" });
    expect(r.ok).toBe(true);
    idp.decouverte = {};
  });

  it("PKCE S256 non annoncé : avertissement ; annoncé : aucune étape `pkce`", async () => {
    expect(await tester()).toMatchObject({ par: expect.not.objectContaining({ pkce: expect.anything() }) });
    idp.decouverte = { code_challenge_methods_supported: ["plain"] };
    const r = await tester();
    expect(r.par["pkce"]).toBe("warn");
    expect(r.ok).toBe(true);
    idp.decouverte = { code_challenge_methods_supported: undefined };
    expect((await tester()).par["pkce"]).toBe("warn");
    idp.decouverte = {};
  });

  it("seules les clés que la bibliothèque acceptera sont comptées : RSA de moins de 2048 bits, Ed448 pour EdDSA, mauvais usage ou courbe écartés", async () => {
    const jwk = (
      type: "rsa" | "ed448" | "ed25519" | "ec",
      opt: { modulusLength?: number; namedCurve?: string; extra?: object } = {},
    ): object => {
      const { extra, ...params } = opt;
      const { publicKey } = generateKeyPairSync(type as "rsa", params as never) as unknown as {
        publicKey: KeyObject;
      };
      return { ...publicKey.export({ format: "jwk" }), ...extra };
    };
    const publier = (keys: unknown[]): void => {
      idp.jeuDeCles = { keys };
    };
    try {
      publier([jwk("rsa", { modulusLength: 1024 })]);
      expect((await tester({ id_token_alg: "RS256" })).par["jwks"]).toBe("fail");
      publier([jwk("rsa", { modulusLength: 2048 })]);
      expect((await tester({ id_token_alg: "RS256" })).par["jwks"]).toBe("ok");
      publier([jwk("rsa", { modulusLength: 2048, extra: { use: "enc" } })]);
      expect((await tester({ id_token_alg: "RS256" })).par["jwks"]).toBe("fail");
      publier([jwk("rsa", { modulusLength: 2048, extra: { key_ops: ["encrypt"] } })]);
      expect((await tester({ id_token_alg: "RS256" })).par["jwks"]).toBe("fail");
      publier([jwk("ed448")]);
      expect((await tester({ id_token_alg: "EdDSA" })).par["jwks"]).toBe("fail");
      publier([jwk("ed25519")]);
      expect((await tester({ id_token_alg: "EdDSA" })).par["jwks"]).toBe("ok");
      publier([jwk("ec", { namedCurve: "P-384" })]);
      expect((await tester({ id_token_alg: "ES256" })).par["jwks"]).toBe("fail");
    } finally {
      idp.jeuDeCles = null;
    }
  });
});
