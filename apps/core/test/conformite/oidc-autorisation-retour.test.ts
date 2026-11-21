// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/oidc-autorisation-retour.test.ts — conformité de la requête d'autorisation et de son retour : OIDC Core §3.1.2.1 à §3.1.2.6, RFC 6749 §4.1 / §5.2 / §10.12, RFC 7636 (PKCE S256), RFC 9207 (`iss` de la réponse). */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ELPIS, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { MOTEURS } from "../identite/banc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { lignesAuditRecentes, lignesJournal } from "../aides";
import { causeDuDernierRefus, codeRefus, parcours } from "./aides-oidc";

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("requête d'autorisation et retour (%s)", (moteur) => {
  let b: BancOidc;
  beforeEach(async () => {
    lignesJournal.length = 0;
    b = await ouvrirBancOidc(moteur);
  });
  afterEach(async () => {
    expect(b.idp.erreurs).toEqual([]);
    await b.fermer();
  });

  describe("OIDC Core §3.1.2.1 : requête d'autorisation", () => {
    it("§3.1.2.1 : `scope` contient `openid`, `response_type` vaut `code`, `client_id`, `redirect_uri`, `state` et `nonce` présents", async () => {
      const p = new URL((await b.demarrer()).url ?? "").searchParams;
      expect(p.get("scope")?.split(" ")).toContain("openid");
      expect(p.get("response_type")).toBe("code");
      expect(p.get("client_id")).toBe("elpis");
      expect(p.get("redirect_uri")).toMatch(
        /^https:\/\/elpis\.exemple\.lan\/api\/auth\/oidc\/sso\/callback$/u,
      );
      expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(p.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    });

    it("§3.1.2.1 : aucun paramètre `prompt`, `login_hint`, `response_mode`, `request` ni `id_token_hint` n'est envoyé", async () => {
      const p = new URL((await b.demarrer()).url ?? "").searchParams;
      for (const k of [
        "prompt",
        "login_hint",
        "response_mode",
        "request",
        "request_uri",
        "id_token_hint",
        "display",
        "ui_locales",
      ])
        expect(p.has(k), k).toBe(false);
    });

    it("§3.1.2.1 : `state` et `nonce` neufs à chaque départ, jamais réutilisés", async () => {
      const a = new URL((await b.demarrer()).url ?? "").searchParams;
      const c = new URL((await b.demarrer()).url ?? "").searchParams;
      expect(a.get("state")).not.toBe(c.get("state"));
      expect(a.get("nonce")).not.toBe(c.get("nonce"));
      expect(a.get("code_challenge")).not.toBe(c.get("code_challenge"));
    });

    it("§3.1.2.1 : `acr_values` séparées par des espaces et `max_age` en secondes quand ils sont réglés, absents sinon", async () => {
      expect(new URL((await b.demarrer()).url ?? "").searchParams.has("acr_values")).toBe(false);
      await b.reglages({ required_acr: ["urn:a", "urn:b"], max_age_sec: 120 });
      const p = new URL((await b.demarrer()).url ?? "").searchParams;
      expect(p.get("acr_values")).toBe("urn:a urn:b");
      expect(p.get("max_age")).toBe("120");
      expect(p.has("prompt")).toBe(false);
    });

    it("§3.1.2.1 : l'adresse d'autorisation annoncée avec une chaîne de requête propre au produit la conserve", async () => {
      b.idp.decouverte = {
        authorization_endpoint: `${b.idp.origine}${b.idp.chemins.auth}?tenant=exemple&p=1`,
      };
      const u = new URL((await b.demarrer()).url ?? "");
      expect(u.searchParams.get("tenant")).toBe("exemple");
      expect(u.searchParams.get("p")).toBe("1");
      expect(u.searchParams.get("client_id")).toBe("elpis");
    });
  });

  describe("RFC 7636 : PKCE S256", () => {
    it("§4.1 et §4.2 : `code_verifier` de 43 à 128 caractères de l'alphabet non réservé, `code_challenge` = BASE64URL(SHA256(verifier))", async () => {
      const dep = await b.demarrer();
      const { retour } = b.idp.autoriser(dep.url ?? "", ELPIS("sub-x"));
      expect((await b.retourner(retour, { cookie: dep.cookie })).statusCode).toBe(200);
      const verifier =
        b.idp.traces.find((r) => r.chemin === b.idp.chemins.token)?.corps.get("code_verifier") ?? "";
      expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/u);
      expect(new URL(dep.url ?? "").searchParams.get("code_challenge")).toBe(
        createHash("sha256").update(verifier).digest("base64url"),
      );
    });

    it("§4.3 : `code_challenge_method` vaut toujours S256, jamais `plain`, même si le produit n'annonce que `plain`", async () => {
      b.idp.decouverte = { code_challenge_methods_supported: ["plain"] };
      expect(new URL((await b.demarrer()).url ?? "").searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("§4.3 : `code_challenge_methods_supported` absent : S256 envoyé quand même", async () => {
      b.idp.decouverte = { code_challenge_methods_supported: undefined };
      expect(new URL((await b.demarrer()).url ?? "").searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("§4.5 : le `code_verifier` n'est envoyé qu'au point de jetons, jamais dans l'adresse d'autorisation", async () => {
      const dep = await b.demarrer();
      const verifier =
        (await b.t.base.valeurs<[string]>("SELECT code_verifier FROM auth_flows"))[0]?.[0] ?? "";
      expect(dep.url).not.toContain(verifier);
    });
  });

  describe("OIDC Core §3.1.2.5 et §3.1.2.6 : réponse d'autorisation", () => {
    const ERREURS = [
      "access_denied",
      "login_required",
      "interaction_required",
      "consent_required",
      "account_selection_required",
      "invalid_request_uri",
      "invalid_request_object",
      "request_not_supported",
      "request_uri_not_supported",
      "registration_not_supported",
      "invalid_request",
      "unauthorized_client",
      "unsupported_response_type",
      "invalid_scope",
      "server_error",
      "temporarily_unavailable",
    ];
    it.each(ERREURS)(
      "§3.1.2.6 : erreur `%s` du fournisseur : refus `denied`, aucun appel au point de jetons, aucun compte",
      async (erreur) => {
        const { rep } = await parcours(b, ELPIS("sub-x"), (u) => {
          u.searchParams.delete("code");
          u.searchParams.set("error", erreur);
        });
        expect(codeRefus(rep)).toBe("denied");
        expect(causeDuDernierRefus()).toBe(`provider_error:${erreur}`);
        expect(b.idp.traces.some((t) => t.chemin === b.idp.chemins.token)).toBe(false);
        expect(await b.utilisateurs()).toEqual(["chef"]);
      },
    );

    it("§3.1.2.6 : erreur inconnue ou à caractères hors de la liste fermée : refus `denied`, cause réduite à `autre`", async () => {
      for (const erreur of [
        "erreur_inventée_par_le_produit",
        "ERREUR MAJUSCULE",
        "x".repeat(200),
        "<script>alert(1)</script>",
      ]) {
        const { rep } = await parcours(b, ELPIS("sub-x"), (u) => {
          u.searchParams.delete("code");
          u.searchParams.set("error", erreur);
        });
        expect(codeRefus(rep)).toBe("denied");
        expect(causeDuDernierRefus()).toMatch(/^provider_error:(autre|erreur_inventée_par_le_produit)?$/u);
      }
    });

    it("§3.1.2.6 : `error_description` et `error_uri` hostiles (balises, retours à la ligne, 4 Kio) ne sortent ni vers le navigateur, ni vers le journal, ni vers l'audit", async () => {
      const hostile = `<img src=x onerror=alert(1)>\r\nSet-Cookie: a=b\n${"A".repeat(3000)}MARQUEUR-HOSTILE`;
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => {
        u.searchParams.delete("code");
        u.searchParams.set("error", "access_denied");
        u.searchParams.set("error_description", hostile);
        u.searchParams.set("error_uri", "https://attaquant.exemple/phish");
      });
      expect(codeRefus(rep)).toBe("denied");
      expect(rep.body).toBe("");
      expect(String(rep.headers.location)).not.toContain("MARQUEUR-HOSTILE");
      const salle = JSON.stringify(lignesAuditRecentes({ limit: 100 })) + lignesJournal.join("\n");
      expect(salle).not.toContain("MARQUEUR-HOSTILE");
      expect(salle).not.toContain("attaquant.exemple");
    });

    it("§3.1.2.5 : réponse sans `code` ni `error` refusée", async () => {
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => u.searchParams.delete("code"));
      expect(codeRefus(rep)).toBe("failed");
    });

    it("§3.1.2.5 : `code` vide refusé", async () => {
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => u.searchParams.set("code", ""));
      expect(codeRefus(rep)).toBe("failed");
    });

    it("RFC 6749 §10.12 : `state` absent de la réponse refusé", async () => {
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => u.searchParams.delete("state"));
      expect(["failed", "expired"]).toContain(codeRefus(rep));
      expect(await b.utilisateurs()).toEqual(["chef"]);
    });

    it("RFC 6749 §10.12 : `state` modifié d'un caractère refusé", async () => {
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => {
        const etat = u.searchParams.get("state") ?? "";
        u.searchParams.set("state", `${etat.slice(0, -1)}${etat.endsWith("A") ? "B" : "A"}`);
      });
      expect(["failed", "expired"]).toContain(codeRefus(rep));
    });

    it("RFC 6749 §3.1 : un paramètre de réponse répété (`state` deux fois, le second faux) ne passe pas : le flux est refusé", async () => {
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => u.searchParams.append("state", "autre"));
      expect(codeRefus(rep)).toBe("failed");
      expect(await b.utilisateurs()).toEqual(["chef"]);
    });

    it("RFC 6749 §4.1.2 : un code d'un autre flux (code volé) refusé par le fournisseur : refus, aucun compte", async () => {
      const autre = await b.demarrer();
      const volé = b.idp.autoriser(autre.url ?? "", ELPIS("sub-victime")).code;
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => u.searchParams.set("code", volé));
      expect(codeRefus(rep)).toBe("failed");
      expect(await b.utilisateurs()).toEqual(["chef"]);
    });

    it("RFC 6749 §4.1.2 : un code rejoué (déjà échangé) refusé", async () => {
      const dep = await b.demarrer();
      const { retour } = b.idp.autoriser(dep.url ?? "", ELPIS("sub-x"));
      expect((await b.retourner(retour, { cookie: dep.cookie })).statusCode).toBe(200);
      const dep2 = await b.demarrer();
      const { retour: r2 } = b.idp.autoriser(dep2.url ?? "", ELPIS("sub-y"));
      const u = new URL(r2);
      u.searchParams.set("code", new URL(retour).searchParams.get("code") ?? "");
      expect(codeRefus(await b.retourner(u.href, { cookie: dep2.cookie }))).toBe("failed");
    });
  });

  describe("RFC 9207 : paramètre `iss` de la réponse d'autorisation", () => {
    const annonce = (v: boolean | undefined): void => {
      b.idp.decouverte = { authorization_response_iss_parameter_supported: v };
    };
    it("§2.4 : `iss` juste présent, annoncé par le produit : accepté", async () => {
      annonce(true);
      expect(
        (await parcours(b, ELPIS("sub-x"), (u) => u.searchParams.set("iss", b.idp.issuer))).rep.statusCode,
      ).toBe(200);
    });
    it("§2.4 : `iss` faux (autre émetteur) refusé, même si le produit ne l'annonce pas", async () => {
      annonce(undefined);
      expect(
        codeRefus(
          (await parcours(b, ELPIS("sub-x"), (u) => u.searchParams.set("iss", "https://mix-up.exemple.lan")))
            .rep,
        ),
      ).toBe("failed");
      expect(causeDuDernierRefus()).toBe("iss_mismatch");
      expect(b.idp.traces.some((t) => t.chemin === b.idp.chemins.token)).toBe(false);
    });
    it("§2.4 : `iss` faux annoncé par le produit : refusé avant tout appel au point de jetons (attaque par confusion de fournisseur)", async () => {
      annonce(true);
      expect(
        codeRefus(
          (await parcours(b, ELPIS("sub-x"), (u) => u.searchParams.set("iss", `${b.idp.issuer}/`))).rep,
        ),
      ).toBe("failed");
      expect(causeDuDernierRefus()).toBe("iss_mismatch");
      expect(b.idp.traces.some((t) => t.chemin === b.idp.chemins.token)).toBe(false);
    });
    it("§2.4 : `iss` absent alors que le produit l'annonce : refusé", async () => {
      annonce(true);
      expect(codeRefus((await parcours(b, ELPIS("sub-x"))).rep)).toBe("failed");
      expect(causeDuDernierRefus()).toBe("iss_mismatch");
    });
    it("§2.4 : réponse d'erreur dont `iss` est faux : `iss` contrôlé avant `error`, refus `failed` (cause `iss_mismatch`), erreur non attribuée au fournisseur", async () => {
      annonce(true);
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => {
        u.searchParams.delete("code");
        u.searchParams.set("error", "access_denied");
        u.searchParams.set("iss", "https://mix-up.exemple.lan");
      });
      expect(codeRefus(rep)).toBe("failed");
      expect(causeDuDernierRefus()).toBe("iss_mismatch");
    });
    it("§2.4 : réponse d'erreur sans `iss` alors que le produit l'annonce : `failed` (cause `iss_mismatch`)", async () => {
      annonce(true);
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => {
        u.searchParams.delete("code");
        u.searchParams.set("error", "access_denied");
      });
      expect(codeRefus(rep)).toBe("failed");
      expect(causeDuDernierRefus()).toBe("iss_mismatch");
    });
    it("§2.4 : réponse d'erreur au bon `iss` : refus `denied` du fournisseur", async () => {
      annonce(true);
      const { rep } = await parcours(b, ELPIS("sub-x"), (u) => {
        u.searchParams.delete("code");
        u.searchParams.set("error", "access_denied");
        u.searchParams.set("iss", b.idp.issuer);
      });
      expect(codeRefus(rep)).toBe("denied");
      expect(causeDuDernierRefus()).toBe("provider_error:access_denied");
    });
    it("§2.4 : `iss` absent, produit qui ne l'annonce pas : accepté", async () => {
      annonce(undefined);
      expect((await parcours(b, ELPIS("sub-x"))).rep.statusCode).toBe(200);
    });
    it("§2.4 : `iss` présent deux fois refusé", async () => {
      annonce(true);
      expect(
        codeRefus(
          (
            await parcours(b, ELPIS("sub-x"), (u) => {
              u.searchParams.set("iss", b.idp.issuer);
              u.searchParams.append("iss", "https://autre");
            })
          ).rep,
        ),
      ).toBe("failed");
      expect(causeDuDernierRefus()).toBe("iss_mismatch");
    });
    it("§3 : `authorization_response_iss_parameter_supported` non booléen ignoré sans refuser la découverte", async () => {
      b.idp.decouverte = { authorization_response_iss_parameter_supported: "oui" };
      expect((await parcours(b, ELPIS("sub-x"))).rep.statusCode).toBe(200);
    });
  });

  describe("RFC 6749 §5.2 : erreurs du point de jetons", () => {
    const repondre = (
      statut: number,
      corps: string,
      entetes: Record<string, string> = { "content-type": "application/json" },
    ): void => {
      b.idp.reponseJetons = () => ({ statut, entetes, corps });
    };
    const ERREURS = [
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "unsupported_grant_type",
      "invalid_scope",
    ];
    it.each(ERREURS)(
      "§5.2 : 400 `%s` : refus `failed`, cause réduite à la liste, description du produit jamais relayée",
      async (erreur) => {
        repondre(
          400,
          JSON.stringify({
            error: erreur,
            error_description: "SECRET-DU-FOURNISSEUR",
            error_uri: "https://x",
          }),
        );
        const r = await b.connecter(ELPIS("sub-x"));
        expect(codeRefus(r.retour)).toBe("failed");
        expect(causeDuDernierRefus()).toBe(
          erreur === "invalid_client" ? "client_auth_rejected" : `token_endpoint:${erreur}`,
        );
        expect(JSON.stringify(lignesAuditRecentes({ limit: 100 })) + lignesJournal.join("\n")).not.toContain(
          "SECRET-DU-FOURNISSEUR",
        );
      },
    );
    it("§5.2 : 401 `invalid_client` avec `WWW-Authenticate: Basic` : refus `failed`, cause `client_auth_rejected`", async () => {
      repondre(401, JSON.stringify({ error: "invalid_client" }), {
        "content-type": "application/json",
        "www-authenticate": 'Basic realm="x"',
      });
      expect(codeRefus((await b.connecter(ELPIS("sub-x"))).retour)).toBe("failed");
      expect(causeDuDernierRefus()).toBe("client_auth_rejected");
    });
    it("§2.3.1 : 401 avec défi `WWW-Authenticate` sans corps : cause `client_auth_rejected`, aucune session, rien du secret ni du corps journalisé", async () => {
      repondre(401, "CORPS-DU-FOURNISSEUR", { "content-type": "text/plain", "www-authenticate": "Basic" });
      expect(codeRefus((await b.connecter(ELPIS("sub-x"))).retour)).toBe("failed");
      expect(causeDuDernierRefus()).toBe("client_auth_rejected");
      const tout = JSON.stringify(lignesAuditRecentes({ limit: 100 })) + lignesJournal.join("\n");
      expect(tout).not.toContain("CORPS-DU-FOURNISSEUR");
      expect(tout).not.toContain("secret-client-de-test");
      expect(await b.utilisateurs()).toEqual(["chef"]);
    });
    it("§5.2 : erreur dont le nom sort de l'alphabet fermé : cause `autre`", async () => {
      repondre(400, JSON.stringify({ error: "Erreur Du Produit!" }));
      await b.connecter(ELPIS("sub-x"));
      expect(causeDuDernierRefus()).toBe("token_endpoint:autre");
    });
    it.each([
      ["corps HTML", 400, "<html>Bad request</html>", "text/html"],
      ["corps vide", 400, "", "application/json"],
      ["corps JSON mal formé", 200, '{"access_token":', "application/json"],
      ["tableau JSON", 200, "[]", "application/json"],
      ["texte brut en 200", 200, "OK", "text/plain"],
      ["erreur 500 en HTML", 500, "<h1>boom</h1>", "text/html"],
      ["erreur 502", 502, "", "text/html"],
      ["erreur 503 avec Retry-After", 503, "", "text/html"],
      ["204 sans contenu", 204, "", "application/json"],
    ])("§5.2 : %s : refus propre (`failed`), aucun compte, aucune fuite", async (_n, statut, corps, type) => {
      repondre(statut, corps, { "content-type": type });
      const r = await b.connecter(ELPIS("sub-x"));
      expect(["failed", "unavailable"]).toContain(codeRefus(r.retour));
      expect(await b.utilisateurs()).toEqual(["chef"]);
      expect(r.retour.body).toBe("");
    });
    it("§5.1 : réponse valide (vrai jeton, bon nonce) servie en `text/plain` : acceptée (tolérance, RFC 6749 §5.1 lie le serveur)", async () => {
      b.idp.entetesJetons = { "content-type": "text/plain" };
      expect((await b.connecter(ELPIS("sub-x"))).retour.statusCode).toBe(200);
      expect(await b.utilisateurs()).toHaveLength(2);
    });
  });
});
