// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/oidc-decouverte.test.ts — conformité du document de découverte : OpenID Connect Discovery 1.0 §3, §4 (émetteur exact, champs requis, champs inconnus, redirection, type de contenu) et RFC 8725 §3.8. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ELPIS, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { MOTEURS } from "../identite/banc";
import { lireMetadonnees } from "../../src/identite/oidc/metadonnees";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { departRefuse } from "./aides-oidc";

const ISS = "https://idp.exemple.lan/realms/elpis";
const doc = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  issuer: ISS,
  authorization_endpoint: `${ISS}/auth`,
  token_endpoint: `${ISS}/token`,
  jwks_uri: `${ISS}/certs`,
  ...extra,
});
const sans = (...noms: string[]): Record<string, unknown> => {
  const d = doc();
  for (const n of noms) delete d[n];
  return d;
};

describe("OpenID Connect Discovery 1.0 §3 : document lu (lecture seule, sans réseau)", () => {
  it("§3 : document minimal (issuer, authorization_endpoint, token_endpoint, jwks_uri) accepté", () => {
    expect(lireMetadonnees(doc(), ISS).ok).toBe(true);
  });
  it.each(["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"])(
    "§3 : champ REQUIRED `%s` absent : document refusé",
    (champ) => {
      expect(lireMetadonnees(sans(champ), ISS).ok).toBe(false);
    },
  );
  it.each(["response_types_supported", "subject_types_supported", "id_token_signing_alg_values_supported"])(
    "§3 : champ REQUIRED `%s` absent : toléré (le produit n'en dépend pas)",
    (champ) => {
      expect(lireMetadonnees(doc(), ISS).ok).toBe(true);
      expect(champ in doc()).toBe(false);
    },
  );
  it("§4.3 : `issuer` identique au réglage accepté ; barre finale en plus ou en moins refusé", () => {
    expect(lireMetadonnees(doc({ issuer: `${ISS}/` }), ISS).ok).toBe(false);
    expect(lireMetadonnees(doc(), `${ISS}/`).ok).toBe(false);
  });
  it("§4.3 : `issuer` de casse différente, avec port par défaut explicite ou avec un chemin de plus refusé (comparaison exacte)", () => {
    expect(lireMetadonnees(doc({ issuer: ISS.replace("idp", "IDP") }), ISS).ok).toBe(false);
    expect(lireMetadonnees(doc({ issuer: ISS.replace("lan/", "lan:443/") }), ISS).ok).toBe(false);
    expect(lireMetadonnees(doc({ issuer: `${ISS}/sous` }), ISS).ok).toBe(false);
  });
  it("§3 : `issuer` non texte, absent ou en liste refusé", () => {
    for (const v of [5, null, [ISS], { a: 1 }, true])
      expect(lireMetadonnees(doc({ issuer: v }), ISS).ok).toBe(false);
  });
  it("§3 : champs inconnus (dont imbriqués et volumineux) ignorés et non gardés", () => {
    const r = lireMetadonnees(
      doc({
        x_inconnu: { a: [1, 2, { b: 3 }] },
        "https://exemple/ext": 1,
        mtls_endpoint_aliases: { token_endpoint: "http://x" },
      }),
      ISS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.metadonnees)).not.toContain("x_inconnu");
  });
  it("§3 : points d'accès en http, sans hôte, avec identifiants ou non texte refusés", () => {
    for (const v of [
      `http://idp.exemple.lan/realms/elpis/token`,
      "https:///token",
      "https://u:p@idp.exemple.lan/realms/elpis/token",
      5,
      "",
      "/token",
    ])
      expect(lireMetadonnees(doc({ token_endpoint: v }), ISS).ok, String(v)).toBe(false);
  });
  it("§3 : `authorization_endpoint` en http refusé (adresse visitée par le navigateur : https exigé)", () => {
    expect(lireMetadonnees(doc({ authorization_endpoint: `http://idp.exemple.lan/auth` }), ISS).ok).toBe(
      false,
    );
  });
  it("§3 : `authorization_endpoint` sur une autre origine que l'émetteur accepté (page visitée par le navigateur, pas par le serveur)", () => {
    expect(
      lireMetadonnees(doc({ authorization_endpoint: "https://login.autre.exemple/authorize" }), ISS).ok,
    ).toBe(true);
  });
  it("§3 : listes de méthodes ou d'algorithmes mal typées (chaîne, objet, éléments non texte) ignorées sans refuser le document", () => {
    const r = lireMetadonnees(
      doc({
        token_endpoint_auth_methods_supported: "client_secret_basic",
        id_token_signing_alg_values_supported: [1, 2],
        code_challenge_methods_supported: { S256: true },
      }),
      ISS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.metadonnees)).not.toContain("token_endpoint_auth_methods_supported");
  });
  it("§3 : le document n'est pas un objet (tableau, null, chaîne, nombre) : refusé", () => {
    for (const v of [[], null, "texte", 5, true]) expect(lireMetadonnees(v, ISS).ok).toBe(false);
  });
  it("§3 : clés `__proto__`, `constructor` et `prototype` du document sans effet sur la lecture", () => {
    const d = JSON.parse(
      `{"__proto__":{"token_endpoint":"https://evil.exemple/t"},"constructor":{"x":1},"issuer":"${ISS}","authorization_endpoint":"${ISS}/auth","token_endpoint":"${ISS}/token","jwks_uri":"${ISS}/certs"}`,
    ) as unknown;
    const r = lireMetadonnees(d, ISS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.metadonnees.token_endpoint).toBe(`${ISS}/token`);
  });
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)(
  "OpenID Connect Discovery 1.0 §4 : récupération du document (%s)",
  (moteur) => {
    let b: BancOidc;
    beforeEach(async () => {
      b = await ouvrirBancOidc(moteur);
    });
    afterEach(async () => {
      expect(b.idp.erreurs).toEqual([]);
      await b.fermer();
    });
    const servir = (
      statut: number,
      corps: string,
      entetes: Record<string, string> = { "content-type": "application/json" },
    ): void => {
      b.idp.surcharges.set(`${b.idp.racine}/.well-known/openid-configuration`, () => ({
        statut,
        entetes,
        corps,
      }));
    };

    it("§4 : le document est lu à `<émetteur>/.well-known/openid-configuration`, une fois, et rien d'autre n'est demandé avant lui", async () => {
      await b.connecter(ELPIS("sub-x"));
      expect(b.idp.traces[0]?.chemin).toBe("/realms/elpis/.well-known/openid-configuration");
      expect(b.idp.traces.filter((t) => t.chemin.endsWith("openid-configuration"))).toHaveLength(1);
    });
    it("§4.2 : réponse 200 `application/json` avec charset acceptée", async () => {
      servir(
        200,
        JSON.stringify({
          issuer: b.idp.issuer,
          authorization_endpoint: `${b.idp.origine}/realms/elpis/auth`,
          token_endpoint: `${b.idp.origine}/realms/elpis/token`,
          jwks_uri: `${b.idp.origine}/realms/elpis/certs`,
        }),
        { "content-type": "application/json; charset=utf-8" },
      );
      expect((await b.demarrer()).url).not.toBeNull();
    });
    it("§4.2 : type de contenu `text/plain` ou absent avec un corps JSON valide : toléré", async () => {
      servir(
        200,
        JSON.stringify({
          issuer: b.idp.issuer,
          authorization_endpoint: `${b.idp.origine}/realms/elpis/auth`,
          token_endpoint: `${b.idp.origine}/realms/elpis/token`,
          jwks_uri: `${b.idp.origine}/realms/elpis/certs`,
        }),
        { "content-type": "text/plain" },
      );
      expect((await b.demarrer()).url).not.toBeNull();
    });
    it.each([
      ["404", 404, ""],
      ["500", 500, "{}"],
      ["204 sans contenu", 204, ""],
      ["corps HTML", 200, "<html><body>Connexion</body></html>"],
      ["JSON mal formé", 200, '{"issuer":'],
      ["tableau JSON", 200, "[]"],
      ["null", 200, "null"],
      ["corps vide", 200, ""],
    ])(
      "§4.3 : réponse « %s » : départ refusé proprement, aucun appel au point de jetons",
      async (_n, statut, corps) => {
        servir(statut as number, corps as string);
        expect(await departRefuse(b)).toBeGreaterThanOrEqual(500);
        expect(b.idp.traces.some((t) => t.chemin === b.idp.chemins.token)).toBe(false);
      },
    );
    it("§4 : document servi par une redirection (302 vers l'origine même) : redirection non suivie, départ refusé", async () => {
      servir(302, "", { location: `${b.idp.origine}/realms/elpis/.well-known/autre` });
      expect(await departRefuse(b)).toBeGreaterThanOrEqual(500);
      expect(b.idp.traces.some((t) => t.chemin.endsWith("/autre"))).toBe(false);
    });
    it("§4 : document de plus de 1 Mio refusé", async () => {
      servir(200, ` ${"x".repeat(1024 * 1024 + 10)}`);
      expect(await departRefuse(b)).toBeGreaterThanOrEqual(500);
    });
    it("§4.3 : un échec de découverte est mémorisé une minute (pas de rafale vers un fournisseur en panne)", async () => {
      servir(500, "");
      await departRefuse(b);
      await departRefuse(b);
      expect(b.idp.traces.filter((t) => t.chemin.endsWith("openid-configuration"))).toHaveLength(1);
    });
    it("§3 : émetteur annoncé avec une barre finale alors que le réglage n'en a pas : refusé (RFC 8725 §3.8 : l'émetteur annoncé est celui que l'on attend)", async () => {
      b.idp.decouverte = { issuer: `${b.idp.issuer}/` };
      expect(await departRefuse(b)).toBeGreaterThanOrEqual(500);
    });
    it("§3 : `response_types_supported` sans `code` : ignoré (le produit n'utilise que le code), parcours complet", async () => {
      b.idp.decouverte = { response_types_supported: ["id_token", "token"] };
      expect((await b.connecter(ELPIS("sub-x"))).retour.statusCode).toBe(200);
    });
    it("§3 : `subject_types_supported` `pairwise` seul accepté", async () => {
      b.idp.decouverte = { subject_types_supported: ["pairwise"] };
      expect((await b.connecter(ELPIS("sub-x"))).retour.statusCode).toBe(200);
    });
    it("§3 : champs inconnus de toute sorte dans le document : parcours complet", async () => {
      b.idp.decouverte = {
        x_inconnu: { a: [1] },
        "https://exemple/ext": true,
        claims_parameter_supported: "peut-être",
      };
      expect((await b.connecter(ELPIS("sub-x"))).retour.statusCode).toBe(200);
    });
    it("§3 : `claims_supported`, `scopes_supported` sans `profile` ni `email` : la portée réglée est quand même demandée", async () => {
      b.idp.decouverte = { scopes_supported: ["openid"] };
      expect(new URL((await b.demarrer()).url ?? "").searchParams.get("scope")).toBe("openid profile email");
    });
  },
);
