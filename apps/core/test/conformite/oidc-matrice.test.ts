// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/oidc-matrice.test.ts — interopérabilité OIDC transversale : algorithmes de signature, secrets du client à caractères spéciaux (RFC 6749 §2.3.1), méthodes d'authentification annoncées, PAR, fin de session annoncée ou absente. */
import { afterEach, describe, expect, it } from "vitest";

import { ELPIS, HOTE_PUBLIC, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { MOTEURS } from "../identite/banc";
import type { OptionsFactice } from "../identite/oidc-factice";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { codeRefus, departRefuse, ouvrir } from "./aides-oidc";

let b: BancOidc | undefined;
const ouvrirBanc = async (...a: Parameters<typeof ouvrir>): Promise<BancOidc> => {
  await b?.fermer().catch(() => undefined);
  b = await ouvrir(...a);
  return b;
};
afterEach(async () => {
  expect(b?.idp.erreurs ?? []).toEqual([]);
  await b?.fermer().catch(() => undefined);
  b = undefined;
});

const ALGORITHMES = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;
const SECRETS = [
  "simple",
  "avec espace",
  "a:b:c",
  "plus+plus",
  "100%25 %",
  "é à ü ß",
  "a&b=c?d#e",
  "\"'\\/<>",
  "😀 emoji",
  ":::",
  "~-_.!*()",
];
const IDENTIFIANTS = ["elpis", "elpis app:1", "app+test@exemple.lan", "id é%"];

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("interopérabilité OIDC transversale (%s)", (moteur) => {
  describe.each(ALGORITHMES)("jeton signé en %s", (alg) => {
    it(`RFC 7518 §3 / RFC 8037 : jeton d'identité ${alg} accepté quand l'algorithme est réglé`, async () => {
      const x = await ouvrirBanc(moteur, { idp: { alg } });
      expect((await x.connecter(ELPIS("alice"))).retour.statusCode).toBe(200);
    });

    it(`RFC 8725 §3.1 : jeton d'identité ${alg} refusé quand un autre algorithme est réglé`, async () => {
      const x = await ouvrirBanc(moteur, { idp: { alg } });
      await x.reglages({ id_token_alg: alg === "RS256" ? "ES256" : "RS256" });
      expect(codeRefus((await x.connecter(ELPIS("alice"))).retour)).toBe("failed");
    });
  });

  describe("authentification du client au point de jetons (RFC 6749 §2.3.1)", () => {
    for (const mode of ["basic", "post"] as const)
      it.each(SECRETS)(
        `RFC 6749 §2.3.1 : secret « %s » en client_secret_${mode} : parcours complet`,
        async (secret) => {
          const x = await ouvrirBanc(moteur, { idp: { clientSecret: secret, authClient: mode } });
          expect((await x.connecter(ELPIS("alice"))).retour.statusCode).toBe(200);
        },
      );

    it.each(IDENTIFIANTS)(
      "RFC 6749 §2.3.1 : identifiant client « %s » encodé avant le Basic : parcours complet",
      async (clientId) => {
        const x = await ouvrirBanc(moteur, { idp: { clientId, authClient: "basic" } });
        expect((await x.connecter(ELPIS("alice"))).retour.statusCode).toBe(200);
        const t = x.idp.traces.find((r) => r.chemin === x.idp.chemins.token);
        expect(t?.autorisation).toMatch(/^Basic [A-Za-z0-9+/=]+$/u);
      },
    );

    it("RFC 6749 §2.3.1 : le Basic encode d'abord l'identifiant et le secret en application/x-www-form-urlencoded (espace en `+`, `:` en `%3A`)", async () => {
      const x = await ouvrirBanc(moteur, { idp: { clientSecret: "a b:c", authClient: "basic" } });
      await x.connecter(ELPIS("alice"));
      const t = x.idp.traces.find((r) => r.chemin === x.idp.chemins.token);
      expect(Buffer.from((t?.autorisation ?? "").slice(6), "base64").toString("utf8")).toBe("elpis:a+b%3Ac");
    });

    it("RFC 6749 §2.3.1 : identifiant client à tiret : la bibliothèque encode aussi le `-` (`%2D`) dans le Basic, tel quel dans le corps en `post`", async () => {
      const id = "elpis-web-2";
      const b = await ouvrirBanc(moteur, { idp: { clientId: id, authClient: "basic" } });
      expect((await b.connecter(ELPIS("alice"))).retour.statusCode).toBe(200);
      const tb = b.idp.traces.find((r) => r.chemin === b.idp.chemins.token);
      expect(Buffer.from((tb?.autorisation ?? "").slice(6), "base64").toString("utf8")).toBe(
        "elpis%2Dweb%2D2:secret%2Dclient%2Dde%2Dtest",
      );
      const p = await ouvrirBanc(moteur, { idp: { clientId: id, authClient: "post" } });
      expect((await p.connecter(ELPIS("alice"))).retour.statusCode).toBe(200);
      const tp = p.idp.traces.find((r) => r.chemin === p.idp.chemins.token);
      expect(tp?.autorisation).toBeNull();
      expect(tp?.corps.get("client_id")).toBe(id);
    });

    it("RFC 6749 §3.2.1 : le mode `post` n'envoie aucun en-tête Authorization et met l'identifiant et le secret dans le corps", async () => {
      const x = await ouvrirBanc(moteur, { idp: { authClient: "post" } });
      await x.connecter(ELPIS("alice"));
      const t = x.idp.traces.find((r) => r.chemin === x.idp.chemins.token);
      expect(t?.autorisation).toBeNull();
      expect(t?.corps.get("client_id")).toBe("elpis");
      expect(t?.corps.get("client_secret")).toBe("secret-client-de-test");
    });

    it.each([
      ["private_key_jwt seul", ["private_key_jwt"]],
      ["client_secret_jwt seul", ["client_secret_jwt"]],
      ["none seul", ["none"]],
      ["tls_client_auth seul", ["tls_client_auth"]],
      ["liste vide", []],
    ])(
      "Discovery 1.0 §3 : méthodes annoncées (%s) que le produit n'a pas : l'annonce est ignorée, la méthode réglée (Basic) est utilisée",
      async (_n, annoncees) => {
        const x = await ouvrirBanc(moteur, {
          decouverte: () => ({ token_endpoint_auth_methods_supported: annoncees }),
        });
        expect((await x.connecter(ELPIS("alice"))).retour.statusCode).toBe(200);
        expect(x.idp.traces.find((r) => r.chemin === x.idp.chemins.token)?.autorisation).toMatch(/^Basic /u);
      },
    );

    it("Discovery 1.0 §3 : `token_endpoint_auth_methods_supported` absent (défaut `client_secret_basic`) : parcours en Basic", async () => {
      const x = await ouvrirBanc(moteur, {
        decouverte: () => ({ token_endpoint_auth_methods_supported: undefined }),
      });
      expect((await x.connecter(ELPIS("alice"))).retour.statusCode).toBe(200);
    });
  });

  describe("requête d'autorisation poussée (RFC 9126)", () => {
    it("RFC 9126 §2 : point PAR annoncé et exigé (`require_pushed_authorization_requests`) : l'adresse d'autorisation ne porte que `client_id` et `request_uri`", async () => {
      const x = await ouvrirBanc(moteur, {
        idp: { exigerPar: true },
        decouverte: () => ({ require_pushed_authorization_requests: true }),
      });
      x.idp.activerPar();
      const d = await x.demarrer();
      const p = new URL(d.url ?? "").searchParams;
      expect([...p.keys()].sort()).toEqual(["client_id", "request_uri"]);
      expect((await x.connecter(ELPIS("alice"))).retour.statusCode).toBe(200);
    });

    it("RFC 9126 §2.1 : la requête poussée est authentifiée comme le point de jetons (Basic) et porte PKCE S256, state et nonce", async () => {
      const x = await ouvrirBanc(moteur);
      x.idp.activerPar();
      await x.demarrer();
      const t = x.idp.traces.find((r) => r.chemin === x.idp.chemins.par);
      expect(t?.autorisation).toMatch(/^Basic /u);
      expect(t?.corps.get("code_challenge_method")).toBe("S256");
      expect(t?.corps.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(t?.corps.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(t?.corps.get("response_type")).toBe("code");
    });

    it("RFC 9126 §2.3 : erreur du point PAR (400 invalid_request) : départ refusé proprement, aucun secret ne sort", async () => {
      const x = await ouvrirBanc(moteur);
      x.idp.activerPar();
      x.idp.surcharges.set(x.idp.chemins.par, () => ({
        statut: 400,
        entetes: { "content-type": "application/json" },
        corps: JSON.stringify({ error: "invalid_request", error_description: "SECRET-DU-FOURNISSEUR" }),
      }));
      const code = await departRefuse(x);
      expect(code).toBeGreaterThanOrEqual(400);
      expect((await x.demarrer()).reponse.body).not.toContain("SECRET-DU-FOURNISSEUR");
    });

    it("RFC 9126 §2.2 : réponse PAR sans `request_uri` : départ refusé", async () => {
      const x = await ouvrirBanc(moteur);
      x.idp.activerPar();
      x.idp.surcharges.set(x.idp.chemins.par, () => ({
        statut: 201,
        entetes: { "content-type": "application/json" },
        corps: JSON.stringify({ expires_in: 60 }),
      }));
      expect(await departRefuse(x)).toBeGreaterThanOrEqual(400);
    });
  });

  describe("fin de session annoncée (OIDC RP-Initiated Logout 1.0 §2)", () => {
    const deconnecter = async (x: BancOidc): Promise<string | undefined> => {
      const { session } = await x.connecter(ELPIS("alice"));
      const r = await x.main.inject({
        method: "POST",
        url: "/api/logout-lite",
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie: session },
      });
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as { logout_url?: string }).logout_url;
    };
    const opt: { extra: Record<string, unknown> } = {
      extra: { logout: { rp_initiated: true, backchannel: false } },
    };
    const fonds: [string, Record<string, unknown>, boolean][] = [
      ["`end_session_endpoint` absent", { end_session_endpoint: undefined }, false],
      [
        "`end_session_endpoint` hors de l'origine de l'émetteur : ignoré sans refuser la découverte",
        { end_session_endpoint: "https://autre.exemple.lan/logout" },
        false,
      ],
      [
        "`end_session_endpoint` en http : ignoré",
        { end_session_endpoint: "http://elpis-test.invalid/logout" },
        false,
      ],
      [
        "`end_session_endpoint` avec fragment : ignoré",
        { end_session_endpoint: "https://elpis-test.invalid/logout#x" },
        false,
      ],
      ["`end_session_endpoint` non texte : ignoré", { end_session_endpoint: 5 }, false],
    ];
    it.each(fonds)("%s : connexion possible, aucune adresse de fin de session", async (_n, doc, adresse) => {
      const x = await ouvrirBanc(moteur, { ...opt, decouverte: () => doc });
      expect((await deconnecter(x)) !== undefined).toBe(adresse);
    });

    it("`end_session_endpoint` sur l'origine : adresse avec `client_id`, `post_logout_redirect_uri` et `id_token_hint`", async () => {
      const x = await ouvrirBanc(moteur, opt);
      const u = new URL((await deconnecter(x)) ?? "");
      expect([...u.searchParams.keys()].sort()).toEqual([
        "client_id",
        "id_token_hint",
        "post_logout_redirect_uri",
      ]);
    });
  });

  it("OIDC Discovery 1.0 §3 : annonce de signature (`id_token_signing_alg_values_supported`) sans l'algorithme réglé : le jeton signé avec l'algorithme réglé reste accepté (l'annonce ne décide pas)", async () => {
    const x = await ouvrirBanc(moteur, {
      idp: { alg: "ES256" },
      decouverte: () => ({ id_token_signing_alg_values_supported: ["RS256"] }),
    });
    expect((await x.connecter(ELPIS("alice"))).retour.statusCode).toBe(200);
  });

  it("fournisseur factice : le banc ouvert par défaut garde l'émetteur et les chemins `/realms/elpis`", async () => {
    const o: OptionsFactice = {};
    const x = await ouvrirBancOidc(moteur, { idp: o });
    try {
      expect(x.idp.issuer.endsWith("/realms/elpis")).toBe(true);
      expect(x.idp.chemins.token).toBe("/realms/elpis/token");
    } finally {
      await x.fermer();
    }
  });
});
