// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/oidc-produits.test.ts — interopérabilité OIDC : le parcours complet (découverte, départ, retour, compte, groupes, déconnexion) joué avec la forme propre à chaque produit d'identité ; le verdict de chaque produit repose sur ces tests. */
import { afterEach, describe, expect, it } from "vitest";

import { MOTEURS } from "../identite/banc";
import type { BancOidc } from "../identite/banc-oidc";
import { ELPIS, HOTE_PUBLIC } from "../identite/banc-oidc";
import type { OidcFactice } from "../identite/oidc-factice";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { codeRefus, departRefuse, ouvrirProfil as ouvrirProfilAide } from "./aides-oidc";
import { PROFILS } from "./profils-oidc";

let b: BancOidc | undefined;

const ouvrirProfil = async (...a: Parameters<typeof ouvrirProfilAide>): Promise<BancOidc> => {
  await b?.fermer().catch(() => undefined);
  b = await ouvrirProfilAide(...a);
  return b;
};

afterEach(async () => {
  expect(b?.idp.erreurs ?? []).toEqual([]);
  await b?.fermer().catch(() => undefined);
  b = undefined;
});

const SANS_ORIGINE = { origine: "https://x.invalid" } as unknown as OidcFactice;
const annonce = (p: (typeof PROFILS)[number], champ: string): boolean => {
  const d = p.decouverte(SANS_ORIGINE);
  return !(champ in d && d[champ] === undefined);
};

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)(
  "interopérabilité OIDC : profils de produits (%s)",
  (moteur) => {
    describe.each(PROFILS.filter((p) => p.horsOrigine !== true))("$nom", (p) => {
      it(`${p.nom} : parcours complet, compte créé sous l'émetteur exact, groupe requis lu — verdict « ${p.resume} »`, async () => {
        const x = await ouvrirProfil(moteur, p);
        const u = p.utilisateur("alice");
        const { retour } = await x.connecter(u);
        expect(retour.statusCode, retour.body).toBe(200);
        expect(await x.utilisateurs()).toHaveLength(2);
        expect(await x.t.base.get("SELECT issuer, subject FROM user_identities")).toEqual({
          issuer: `oidc:${x.idp.issuer}`,
          subject: u.sub,
        });
        expect(x.idp.traces[0]?.chemin).toBe(`${x.idp.racine}/.well-known/openid-configuration`);
      });

      it(`${p.nom} : une personne hors du groupe requis est refusée (not_in_group), aucun compte`, async () => {
        const x = await ouvrirProfil(moteur, p);
        const { retour } = await x.connecter(p.utilisateur("bob", ["autre-groupe", "autre-deux"]));
        expect(codeRefus(retour)).toBe("not_in_group");
        expect(await x.utilisateurs()).toEqual(["chef"]);
      });

      it(`${p.nom} : deuxième connexion de la même personne, même compte (sujet stable)`, async () => {
        const x = await ouvrirProfil(moteur, p);
        const u = p.utilisateur("alice");
        expect((await x.connecter(u)).retour.statusCode).toBe(200);
        expect((await x.connecter(u)).retour.statusCode).toBe(200);
        expect(await x.utilisateurs()).toHaveLength(2);
      });

      it(`${p.nom} (OIDC RP-Initiated Logout 1.0 §2) : adresse de fin de session ${annonce(p, "end_session_endpoint") ? "sur le point annoncé, avec client_id et id_token_hint" : "absente quand le produit n'en annonce pas"}`, async () => {
        const x = await ouvrirProfil(moteur, p, {
          extra: { logout: { rp_initiated: true, backchannel: false } },
        });
        const { session } = await x.connecter(p.utilisateur("alice"));
        const r = await x.main.inject({
          method: "POST",
          url: "/api/logout-lite",
          headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie: session },
        });
        expect(r.statusCode, r.body).toBe(200);
        const url = (r.json() as { logout_url?: string }).logout_url;
        if (!annonce(p, "end_session_endpoint")) return void expect(url).toBeUndefined();
        const u = new URL(url ?? "");
        expect(u.origin + u.pathname).toBe(`${x.idp.origine}${x.idp.chemins.logout}`);
        expect(u.searchParams.get("client_id")).toBe(x.idp.clientId);
        expect(u.searchParams.get("id_token_hint")).toBe(x.idp.emis.at(-1));
      });

      if (annonce(p, "backchannel_logout_supported"))
        it(`${p.nom} (Back-Channel Logout 1.0 §2.6) : jeton de déconnexion à la forme du produit (profil : sans \`exp\`, ou \`typ\` \`logout+jwt\`) avec \`sid\` seul, puis \`sub\` seul, ferme la session`, async () => {
          const x = await ouvrirProfil(moteur, p, {
            extra: { logout: { rp_initiated: false, backchannel: true } },
          });
          const vivante = async (c: string): Promise<boolean> =>
            (await x.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: c } })).json<{
              logged_in?: boolean;
            }>().logged_in === true;
          const poster = async (jeton: string): Promise<number> =>
            (
              await x.main.inject({
                method: "POST",
                url: "/api/auth/oidc/sso/backchannel-logout",
                headers: { host: HOTE_PUBLIC, "content-type": "application/x-www-form-urlencoded" },
                payload: new URLSearchParams({ logout_token: jeton }).toString(),
              })
            ).statusCode;
          const forme = {
            ...(p.jetonDeconnexion?.sans === undefined ? {} : { sans: [...p.jetonDeconnexion.sans] }),
            ...(p.jetonDeconnexion?.entete === undefined ? {} : { entete: p.jetonDeconnexion.entete }),
          };
          const u = p.utilisateur("alice");
          const sid = u.claims?.["sid"];
          if (typeof sid === "string") {
            const a = (await x.connecter(u)).session;
            expect(await vivante(a)).toBe(true);
            expect(await poster(await x.idp.jetonDeconnexion({ sid }, forme))).toBe(200);
            expect(await vivante(a)).toBe(false);
          }
          const c = (await x.connecter(u)).session;
          expect(await poster(await x.idp.jetonDeconnexion({ sub: u.sub }, forme))).toBe(200);
          expect(await vivante(c)).toBe(false);
        });
    });

    describe.each(PROFILS.filter((p) => p.horsOrigine === true))(
      "$nom (points d'accès hors de l'origine)",
      (p) => {
        it(`${p.nom} : document de découverte fidèle refusé par choix (plus strict que la norme) — verdict « ${p.resume} »`, async () => {
          const x = await ouvrirProfil(moteur, p);
          expect(await departRefuse(x)).toBeGreaterThanOrEqual(400);
          expect(x.idp.traces.some((t) => t.chemin === x.idp.chemins.token)).toBe(false);
        });

        it(`${p.nom} : le même document ramené sur l'origine de l'émetteur suit le parcours (seule la règle d'origine bloque)`, async () => {
          const x = await ouvrirProfil(moteur, p, { surOrigine: true });
          const { retour } = await x.connecter(p.utilisateur("alice"));
          if (p.apresOrigine === undefined) expect(retour.statusCode, retour.body).toBe(200);
          else expect(codeRefus(retour)).toBe(p.apresOrigine);
        });
      },
    );

    it("un fournisseur sans groupe requis n'est jamais actif : un produit sans revendication de groupes (Google) ne peut pas être branché", async () => {
      const google = PROFILS.find((p) => p.cle === "google");
      if (google === undefined) throw new Error("profil absent");
      const x = await ouvrirProfil(moteur, google, { surOrigine: true, extra: { required_groups: [] } });
      const d = await x.demarrer();
      expect(d.reponse.statusCode).toBe(404);
      expect(ELPIS("a").sub).toBe("a");
    });
  },
);
