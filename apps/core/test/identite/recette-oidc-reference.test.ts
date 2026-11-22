// SPDX-License-Identifier: MIT
/** apps/core/test/identite/recette-oidc-reference.test.ts — recette à la main contre un fournisseur OpenID Connect de référence (bibliothèque certifiée, plusieurs algorithmes de signature) décrit par le fichier JSON de `ELPIS_RECETTE_OIDC_REF` ; sautée sans lui. */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testerFournisseur } from "../../src/identite/essai";
import { secretFournisseur } from "../../src/identite/fournisseurs";
import { formulaire, navigateur, ouvrirBancRecette, temoins, traverserFournisseur } from "./recette-outils";
import type { BancRecette, Compte, Ecoute } from "./recette-outils";

interface Client {
  /** Identifiant du fournisseur dans Elpis, qui est aussi celui du client chez le fournisseur. */
  readonly id: string;
  readonly alg: string;
  readonly auth: "basic" | "post";
}

interface Recette {
  readonly ca: string;
  readonly issuer: string;
  readonly client_secret: string;
  readonly public_url: string;
  readonly groupe: string;
  readonly autre_groupe: string;
  readonly clients: readonly Client[];
  readonly membre: Compte;
  readonly autre_membre: Compte;
  readonly hors_groupe: Compte;
  readonly ecoute: Ecoute;
}

const CHEMIN = process.env["ELPIS_RECETTE_OIDC_REF"] ?? "";
const RECETTE: Recette | null = CHEMIN ? (JSON.parse(readFileSync(CHEMIN, "utf8")) as Recette) : null;

describe.skipIf(RECETTE === null)("recette sur un fournisseur OpenID Connect de référence", () => {
  const recette = RECETTE as Recette;
  const ca = RECETTE === null ? "" : readFileSync(recette.ca, "utf8");
  const origine = RECETTE === null ? "" : new URL(recette.issuer).origin;

  const traverser = (depart: string, c: Compte, jar = "") =>
    traverserFournisseur(recette.issuer, ca, depart, c, jar);

  describe.each((RECETTE?.clients ?? []).map((c) => [`${c.id} (${c.alg}, ${c.auth})`, c] as const))(
    "%s",
    (_nom, client) => {
      let b: BancRecette;

      const installer = (extra: Record<string, unknown> = {}, secret = recette.client_secret) =>
        b.installer(
          {
            id: client.id,
            label: "Référence",
            issuer: recette.issuer,
            client_id: client.id,
            client_auth: client.auth,
            id_token_alg: client.alg,
            scopes: ["openid", "profile", "email", "groups"],
            required_groups: [recette.groupe],
            logout: { rp_initiated: true, backchannel: true },
            ...extra,
          },
          secret,
        );

      async function connecter(
        c: Compte,
      ): Promise<{ statut: number; lieu: string; session: string; jar: string }> {
        const ip = b.adresse();
        const { url, liaison } = await b.demarrer(client.id, ip);
        const { lieu, jar } = await traverser(url, c);
        expect(lieu.startsWith(`${recette.public_url}/api/auth/oidc/${client.id}/callback?`), lieu).toBe(
          true,
        );
        const { retour, session } = await b.retourner(client.id, lieu, liaison, ip);
        return { statut: retour.statusCode, lieu: String(retour.headers["location"]), session, jar };
      }

      beforeAll(async () => {
        b = await ouvrirBancRecette(recette.public_url, ca);
        await installer();
        await b.ecouter(recette.ecoute);
      }, 60_000);

      afterAll(async () => {
        await b?.fermer();
      });

      it("bouton Tester : toutes les étapes passent, PKCE S256 annoncé", async () => {
        const { type: _type, ...reglages } = b.fournisseur();
        const r = await testerFournisseur(
          { type: "oidc", ...reglages },
          { publicUrl: recette.public_url, cookieSecure: true, adminsLocaux: 1 },
          { oidc: { secretEnregistre: (f) => secretFournisseur(b.t.base, f) } },
        );
        expect(r.steps.filter((e) => e.level === "fail").map((e) => `${e.id} : ${e.detail}`)).toEqual([]);
        expect(r.steps.map((e) => e.id)).not.toContain("pkce");
      }, 60_000);

      it("connexion complète : jeton signé avec cet algorithme, groupes lus au point d'information, compte créé", async () => {
        const r = await connecter(recette.membre);
        expect(r.statut, r.lieu).toBe(200);
        expect((await b.moi(r.session)).username).toBe(recette.membre.login);
        const identite = await b.t.base.get<{ subject: string; issuer: string }>(
          "SELECT subject, issuer FROM user_identities WHERE provider_id=?",
          [client.id],
        );
        expect(identite).toMatchObject({
          subject: recette.membre.login,
          issuer: `oidc:${recette.issuer}`,
        });
        const encore = await connecter(recette.membre);
        expect(encore.statut).toBe(200);
        expect(await b.t.base.all("SELECT 1 AS un FROM user_identities")).toHaveLength(1);
      }, 60_000);

      it("hors du groupe requis : refus `not_in_group`, aucun compte", async () => {
        const r = await connecter(recette.hors_groupe);
        expect(r.statut).toBe(302);
        expect(r.lieu).toMatch(/^\/\?auth_error=not_in_group&ref=[A-Za-z0-9_-]{8}$/u);
        expect((await b.moi(r.session)).username).toBeUndefined();
      }, 60_000);

      it("rôles d'après les groupes : administrateur pour le groupe désigné, utilisateur sinon", async () => {
        await installer({
          required_acr: [],
          required_amr: [],
          roles: { enabled: true, admin_groups: [], moderator_groups: [recette.autre_groupe] },
        });
        try {
          const a = await connecter(recette.membre);
          expect(a.statut, a.lieu).toBe(200);
          expect((await b.moi(a.session)).role).toBe("moderator");
          const j = await connecter(recette.autre_membre);
          expect(j.statut, j.lieu).toBe(200);
          expect((await b.moi(j.session)).role).toBe("user");
        } finally {
          await installer();
        }
      }, 60_000);

      it("déconnexion d'Elpis : adresse de fin de session du fournisseur, avec l'indice du jeton", async () => {
        const r = await connecter(recette.autre_membre);
        expect(r.statut, r.lieu).toBe(200);
        const sortie = await b.interroger("POST", "/api/logout-lite", r.session);
        expect(sortie.statusCode).toBe(200);
        const fin = new URL(sortie.json<{ logout_url: string }>().logout_url);
        expect(fin.origin).toBe(origine);
        expect(fin.searchParams.get("post_logout_redirect_uri")).toBe(`${recette.public_url}/`);
        expect(fin.searchParams.get("id_token_hint")).toBeTruthy();
        expect((await b.moi(r.session)).username).toBeUndefined();
      }, 60_000);

      it("session fermée chez le fournisseur : son avis par canal arrière ferme la session Elpis", async () => {
        const r = await connecter(recette.autre_membre);
        expect(r.statut, r.lieu).toBe(200);
        const nom = recette.autre_membre.login.replaceAll(".", "-");
        expect((await b.moi(r.session)).username).toBe(nom);
        // La personne se déconnecte CHEZ LE FOURNISSEUR (son navigateur porte ses témoins) : il prévient ses clients.
        const fin = new URL(`${origine}/session/end`);
        fin.searchParams.set("client_id", client.id);
        fin.searchParams.set("post_logout_redirect_uri", `${recette.public_url}/`);
        const page = await navigateur(fin.href, ca, { cookie: r.jar });
        const f = formulaire(page);
        expect(f, page.corps.slice(0, 200)).not.toBeNull();
        const confirme = await navigateur(new URL(f?.action ?? "", recette.issuer).href, ca, {
          cookie: temoins(page, r.jar),
          corps: new URLSearchParams({ ...f?.champs, logout: "yes" }).toString(),
        });
        expect(confirme.statut).toBeLessThan(400);
        await expect
          .poll(async () => (await b.moi(r.session)).username, { timeout: 15_000, interval: 500 })
          .toBeUndefined();
      }, 60_000);

      it("secret client faux : aucune connexion possible, rien du secret dans la réponse", async () => {
        await installer({}, "pas-le-bon-secret");
        try {
          const depart = await b.main.inject({
            method: "POST",
            url: `/api/auth/oidc/${client.id}/start`,
            remoteAddress: b.adresse(),
            headers: { host: b.hote, "sec-fetch-site": "same-origin" },
            payload: { target: "app" },
          });
          expect([200, 503]).toContain(depart.statusCode);
          expect(depart.body).not.toContain("pas-le-bon-secret");
        } finally {
          await installer();
        }
      }, 60_000);

      it("algorithme réglé différent de celui du fournisseur : la connexion échoue, sans session", async () => {
        const autre = client.alg === "RS256" ? "ES256" : "RS256";
        await installer({ id_token_alg: autre });
        try {
          const r = await connecter(recette.membre).catch((e: unknown) => ({
            statut: 0,
            lieu: String(e),
            session: "",
          }));
          expect(r.statut).not.toBe(200);
          if (r.session !== "") expect((await b.moi(r.session)).username).toBeUndefined();
        } finally {
          await installer();
        }
      }, 60_000);
    },
  );
});
