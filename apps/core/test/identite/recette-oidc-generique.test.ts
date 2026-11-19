// SPDX-License-Identifier: MIT
/** apps/core/test/identite/recette-oidc-generique.test.ts — recette à la main contre plusieurs vrais fournisseurs OpenID Connect à formulaire simple (Dex, LemonLDAP::NG…) décrits par le fichier JSON de `ELPIS_RECETTE_OIDC_MULTI` ; sautée sans lui. */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testerFournisseur } from "../../src/identite/essai";
import { secretFournisseur } from "../../src/identite/fournisseurs";
import { ouvrirBancRecette, traverserFournisseur } from "./recette-outils";
import type { BancRecette, Compte } from "./recette-outils";

interface FournisseurReel {
  readonly nom: string;
  /** Identifiant du fournisseur dans Elpis (celui de l'adresse de retour déclarée chez lui). */
  readonly id: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly reglages: Record<string, unknown>;
  readonly groupe: string;
  readonly champs: { readonly login: string; readonly mdp: string };
  readonly membre: Compte;
  readonly hors_groupe: Compte;
  /** Code d'erreur attendu pour une personne hors du groupe requis (`not_in_group`, ou `groups_unknown` si le fournisseur omet alors la revendication). */
  readonly refus_hors_groupe: string;
  /** Vrai si le fournisseur annonce une adresse de fin de session. */
  readonly fin_de_session: boolean;
}

interface Recette {
  readonly ca: string;
  readonly public_url: string;
  readonly fournisseurs: readonly FournisseurReel[];
}

const CHEMIN = process.env["ELPIS_RECETTE_OIDC_MULTI"] ?? "";
const RECETTE: Recette | null = CHEMIN ? (JSON.parse(readFileSync(CHEMIN, "utf8")) as Recette) : null;

describe.skipIf(RECETTE === null)("recette sur de vrais fournisseurs OpenID Connect", () => {
  const recette = RECETTE as Recette;
  const ca = RECETTE === null ? "" : readFileSync(recette.ca, "utf8");

  describe.each((RECETTE?.fournisseurs ?? []).map((f) => [f.nom, f] as const))("%s", (_nom, f) => {
    let b: BancRecette;

    const installer = (extra: Record<string, unknown> = {}, secret = f.client_secret) =>
      b.installer(
        {
          id: f.id,
          label: f.nom.slice(0, 40),
          issuer: f.issuer,
          client_id: f.client_id,
          required_groups: [f.groupe],
          ...f.reglages,
          ...extra,
        },
        secret,
      );

    async function connecter(c: Compte): Promise<{ statut: number; lieu: string; session: string }> {
      const ip = b.adresse();
      const { url, liaison } = await b.demarrer(f.id, ip);
      const { lieu } = await traverserFournisseur(f.issuer, ca, url, c, "", f.champs);
      expect(lieu.startsWith(`${recette.public_url}/api/auth/oidc/${f.id}/callback?`), lieu).toBe(true);
      const { retour, session } = await b.retourner(f.id, lieu, liaison, ip);
      return { statut: retour.statusCode, lieu: String(retour.headers["location"]), session };
    }

    beforeAll(async () => {
      b = await ouvrirBancRecette(recette.public_url, ca);
      await installer();
    }, 60_000);

    afterAll(async () => {
      await b?.fermer();
    });

    it("bouton Tester : aucune étape en échec", async () => {
      const { type: _type, ...reglages } = b.fournisseur();
      const r = await testerFournisseur(
        { type: "oidc", ...reglages },
        { publicUrl: recette.public_url, cookieSecure: true, adminsLocaux: 1 },
        { oidc: { secretEnregistre: (x) => secretFournisseur(b.t.base, x) } },
      );
      expect(r.steps.filter((e) => e.level === "fail").map((e) => `${e.id} : ${e.detail}`)).toEqual([]);
    }, 60_000);

    it("un membre du groupe requis se connecte : compte créé, puis le même compte à la connexion suivante", async () => {
      const r = await connecter(f.membre);
      expect(r.statut, r.lieu).toBe(200);
      expect((await b.moi(r.session)).username).toBe(f.membre.login.replaceAll(".", "-"));
      const encore = await connecter(f.membre);
      expect(encore.statut, encore.lieu).toBe(200);
      const identites = await b.t.base.all<{ subject: string; issuer: string }>(
        "SELECT subject, issuer FROM user_identities WHERE provider_id=?",
        [f.id],
      );
      expect(identites).toHaveLength(1);
      expect(identites[0]?.issuer).toBe(`oidc:${f.issuer}`);
    }, 60_000);

    it("hors du groupe requis : refus, aucun compte, aucune session", async () => {
      const avant = await b.t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
      const r = await connecter(f.hors_groupe);
      expect(r.statut).toBe(302);
      expect(r.lieu).toMatch(new RegExp(`^/\\?auth_error=${f.refus_hors_groupe}&ref=[A-Za-z0-9_-]{8}$`, "u"));
      expect((await b.moi(r.session)).username).toBeUndefined();
      const apres = await b.t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
      expect(Number(apres?.n)).toBe(Number(avant?.n));
    }, 60_000);

    it("déconnexion d'Elpis : adresse de fin de session seulement si le fournisseur en annonce une", async () => {
      await installer({ logout: { rp_initiated: true, backchannel: false } });
      try {
        const r = await connecter(f.membre);
        expect(r.statut, r.lieu).toBe(200);
        const sortie = await b.interroger("POST", "/api/logout-lite", r.session);
        expect(sortie.statusCode).toBe(200);
        const corps = sortie.json<{ ok: boolean; logout_url?: string }>();
        expect(corps.ok).toBe(true);
        if (f.fin_de_session) expect(new URL(String(corps.logout_url)).origin).toBe(new URL(f.issuer).origin);
        else expect(corps.logout_url).toBeUndefined();
        expect((await b.moi(r.session)).username).toBeUndefined();
      } finally {
        await installer();
      }
    }, 60_000);

    it("secret client faux : aucune session", async () => {
      await installer({}, "pas-le-bon-secret");
      try {
        const r = await connecter(f.membre).catch((e: unknown) => ({
          statut: 0,
          lieu: String(e),
          session: "",
        }));
        expect(r.statut).not.toBe(200);
        expect(r.lieu).not.toContain("pas-le-bon-secret");
        if (r.session !== "") expect((await b.moi(r.session)).username).toBeUndefined();
      } finally {
        await installer();
      }
    }, 60_000);
  });
});
