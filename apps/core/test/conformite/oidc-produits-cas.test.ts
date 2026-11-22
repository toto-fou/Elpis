// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/oidc-produits-cas.test.ts — interopérabilité OIDC : les particularités de chaque produit (émetteur et chemins, forme des groupes, sujet, authentification du client, PAR, paramètre `iss`) qui fondent le verdict du produit. */
import { createServer } from "node:net";
import type { Server } from "node:net";
import { URL } from "node:url";

import { validerFournisseur } from "../../src/identite/reglages";
import { afterEach, describe, expect, it } from "vitest";

import { MOTEURS } from "../identite/banc";
import type { BancOidc } from "../identite/banc-oidc";
import { oidcValide } from "../identite/aides";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import {
  codeRefus,
  causeDuDernierRefus,
  departRefuse,
  ouvrirProfil as ouvrirProfilAide,
  parcours,
} from "./aides-oidc";
import { PROFILS } from "./profils-oidc";
import type { ProfilProduit } from "./profils-oidc";

let b: BancOidc | undefined;
const profil = (cle: string): ProfilProduit => {
  const p = PROFILS.find((x) => x.cle === cle);
  if (p === undefined) throw new Error(`profil ${cle} absent`);
  return p;
};
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

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)(
  "interopérabilité OIDC : cas propres aux produits (%s)",
  (moteur) => {
    describe("Keycloak", () => {
      const k = profil("keycloak");
      it("Keycloak : groupes par `realm_access.roles` (revendication imbriquée) lus", async () => {
        const x = await ouvrirProfil(moteur, k, {
          extra: { groups_claim: "realm_access.roles", required_groups: ["elpis-utilisateur"] },
        });
        const u = k.utilisateur("alice");
        const ok = {
          ...u,
          claims: { ...u.claims, realm_access: { roles: ["elpis-utilisateur", "offline_access"] } },
        };
        expect((await x.connecter(ok)).retour.statusCode).toBe(200);
        expect(codeRefus((await x.connecter(k.utilisateur("bob"))).retour)).toBe("not_in_group");
      });

      it("Keycloak : groupes par `resource_access.elpis.roles` (rôles du client) lus", async () => {
        const x = await ouvrirProfil(moteur, k, {
          extra: { groups_claim: "resource_access.elpis.roles", required_groups: ["utilisateur"] },
        });
        expect((await x.connecter(k.utilisateur("alice"))).retour.statusCode).toBe(200);
      });

      it("Keycloak : chemins de groupes `/a/b` comparés tels quels, un chemin parent n'est pas un groupe de l'enfant", async () => {
        const x = await ouvrirProfil(moteur, k, { extra: { required_groups: ["/a"] } });
        expect(codeRefus((await x.connecter(k.utilisateur("alice", ["/a/b"]))).retour)).toBe("not_in_group");
        await x.reglages({ required_groups: ["/a/b"] });
        expect((await x.connecter(k.utilisateur("alice", ["/a/b"]))).retour.statusCode).toBe(200);
      });

      it("Keycloak (RFC 9126 + RFC 9207, variante récente du document) : PAR annoncé et paramètre `iss` dans le retour, parcours complet", async () => {
        const x = await ouvrirProfil(moteur, k, {
          idp: { issDansReponse: true },
          decouverte: {
            pushed_authorization_request_endpoint: `https://elpis-test.invalid:0/par`,
            authorization_response_iss_parameter_supported: true,
          },
        });
        x.idp.activerPar();
        x.idp.decouverte = { ...x.idp.decouverte, authorization_response_iss_parameter_supported: true };
        const { rep, url } = await parcours(x, k.utilisateur("alice"));
        expect(rep.statusCode, rep.body).toBe(200);
        expect(new URL(url).searchParams.has("request_uri")).toBe(true);
        expect(x.idp.traces.some((t) => t.chemin === x.idp.chemins.par && t.methode === "POST")).toBe(true);
      });
    });

    describe("Microsoft Entra ID", () => {
      const e = profil("entra");
      it("Entra : émetteur en gabarit `{tenantid}` (point d'entrée `common`) refusé : l'émetteur annoncé n'est pas celui du réglage", async () => {
        const x = await ouvrirProfil(moteur, e, {
          idp: { racine: "/common/v2.0" },
          decouverte: { issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" },
        });
        expect(await departRefuse(x)).toBeGreaterThanOrEqual(400);
      });

      it("Entra : dépassement de groupes (`_claim_names` + `_claim_sources`) : appartenance inconnue, aucune connexion", async () => {
        const x = await ouvrirProfil(moteur, e);
        const u = e.utilisateur("alice");
        const trop = {
          ...u,
          claims: {
            ...u.claims,
            groups: undefined,
            _claim_names: { groups: "src1" },
            _claim_sources: { src1: { endpoint: "https://graph.windows.net/x/users/y/getMemberObjects" } },
          },
        };
        expect(codeRefus((await x.connecter(trop)).retour)).toBe("groups_unknown");
      });

      it("Entra : `hasgroups` sans liste de groupes : appartenance inconnue", async () => {
        const x = await ouvrirProfil(moteur, e);
        const u = e.utilisateur("alice");
        expect(
          codeRefus(
            (await x.connecter({ ...u, claims: { ...u.claims, groups: undefined, hasgroups: true } })).retour,
          ),
        ).toBe("groups_unknown");
      });

      it("Entra : groupes (identifiants d'objet) dans le jeton d'identité : connexion ; le point d'information hors origine n'est jamais contacté, groupes absents du jeton : groups_unknown", async () => {
        let touches = 0;
        const ecouteur: Server = createServer((s) => {
          touches += 1;
          s.destroy();
        });
        await new Promise<void>((ok) => ecouteur.listen(0, "127.0.0.1", () => ok()));
        const port = (ecouteur.address() as { port: number }).port;
        try {
          const x = await ouvrirProfil(moteur, e, {
            decouverte: { userinfo_endpoint: `https://elpis-test.invalid:${port}/oidc/userinfo` },
          });
          const u = e.utilisateur("alice");
          expect(Array.isArray(u.claims?.["groups"])).toBe(true);
          expect((await x.connecter(u)).retour.statusCode).toBe(200);
          const sans = { ...u, claims: { ...u.claims, groups: undefined } };
          expect(codeRefus((await x.connecter(sans)).retour)).toBe("groups_unknown");
          expect(touches).toBe(0);
        } finally {
          await new Promise<void>((ok) => ecouteur.close(() => ok()));
        }
      });

      it("Entra : `aud` est l'identifiant (GUID) de l'application, `sub` pairwise de 43 caractères, `tid` ignoré : parcours", async () => {
        const x = await ouvrirProfil(moteur, e);
        const u = e.utilisateur("alice");
        expect(u.sub).toHaveLength(43);
        expect((await x.connecter(u)).retour.statusCode).toBe(200);
      });
    });

    describe("AD FS", () => {
      const a = profil("adfs");
      it("AD FS : une personne dans un seul groupe voit la revendication rendue en chaîne : lue comme un groupe quand la chaîne est exactement le groupe requis", async () => {
        const x = await ouvrirProfil(moteur, a);
        const u = a.utilisateur("alice");
        const { retour } = await x.connecter({ ...u, claims: { ...u.claims, group: "elpis" } });
        expect(retour.statusCode, retour.body).toBe(200);
      });

      it("AD FS : chaîne unique non réglée, groupes collés (`;`, `,`, espaces) ou objet : groups_unknown, jamais découpés ni rognés", async () => {
        const x = await ouvrirProfil(moteur, a);
        const u = a.utilisateur("alice");
        for (const group of [
          "autre",
          "",
          "elpis;Domain Users",
          "elpis, Domain Users",
          "elpis,Domain Users",
          " elpis",
          "elpis ",
          { elpis: true },
        ])
          expect(
            codeRefus((await x.connecter({ ...u, claims: { ...u.claims, group } })).retour),
            JSON.stringify(group),
          ).toBe("groups_unknown");
      });

      it("AD FS : chaîne égale à un groupe de rôle mais pas au groupe requis : groups_unknown (une chaîne ne dit jamais « non membre »)", async () => {
        const x = await ouvrirProfil(moteur, a, {
          extra: { roles: { enabled: true, admin_groups: [], moderator_groups: ["moderateurs"] } },
        });
        const u = a.utilisateur("alice");
        expect(
          codeRefus((await x.connecter({ ...u, claims: { ...u.claims, group: "moderateurs" } })).retour),
        ).toBe("groups_unknown");
      });

      it("AD FS : plusieurs groupes (tableau) lus, `upn` pour l'identifiant, points d'accès avec barre finale", async () => {
        const x = await ouvrirProfil(moteur, a);
        const { retour } = await x.connecter(a.utilisateur("alice"));
        expect(retour.statusCode, retour.body).toBe(200);
        expect(await x.utilisateurs()).toContain("alice-corp-lan");
        expect(x.idp.traces.some((t) => t.chemin === "/adfs/oauth2/token/")).toBe(true);
      });
    });

    describe("Okta", () => {
      const o = profil("okta");
      it("Okta : serveur d'autorisation de l'organisation (émetteur sans chemin, points `/oauth2/v1/*`) : parcours complet", async () => {
        const x = await ouvrirProfil(moteur, o, {
          idp: {
            racine: "",
            chemins: {
              auth: "/oauth2/v1/authorize",
              token: "/oauth2/v1/token",
              certs: "/oauth2/v1/keys",
              userinfo: "/oauth2/v1/userinfo",
              logout: "/oauth2/v1/logout",
            },
          },
        });
        expect((await x.connecter(o.utilisateur("alice"))).retour.statusCode).toBe(200);
      });

      it("Okta : `amr` en liste (`pwd`, `mfa`) satisfait un second facteur exigé, `pwd` seul est refusé (mfa_required)", async () => {
        const x = await ouvrirProfil(moteur, o, { extra: { required_amr: ["mfa"] } });
        const u = o.utilisateur("alice");
        expect(
          (await x.connecter({ ...u, claims: { ...u.claims, amr: ["pwd", "mfa"] } })).retour.statusCode,
        ).toBe(200);
        expect(codeRefus((await x.connecter(o.utilisateur("bob"))).retour)).toBe("mfa_required");
      });
    });

    describe("Auth0", () => {
      const a = profil("auth0");
      it("Auth0 : émetteur saisi SANS la barre finale que le produit annonce : refusé (l'émetteur doit être identique à l'annonce)", async () => {
        const x = await ouvrirProfil(moteur, a);
        await x.reglages({ issuer: x.idp.issuer.replace(/\/$/u, "") });
        expect(await departRefuse(x)).toBeGreaterThanOrEqual(400);
      });

      it("Auth0 : nom de revendication en adresse https:// (espace de noms exigé pour les revendications personnalisées) refusé par les réglages (limite du produit : seuls les noms simples sont admis)", () => {
        expect(() =>
          validerFournisseur(oidcValide({ groups_claim: "https://elpis.exemple.lan/roles" })),
        ).toThrow();
      });

      it("Auth0 : `sub` `auth0|…`, `nickname` comme identifiant, revendication de groupes sans espace de noms : parcours", async () => {
        const x = await ouvrirProfil(moteur, a);
        const { retour } = await x.connecter(a.utilisateur("alice"));
        expect(retour.statusCode, retour.body).toBe(200);
        expect(await x.utilisateurs()).toContain("alice");
      });
    });

    describe("Authentik", () => {
      const t = profil("authentik");
      it("Authentik : sans clé de signature affectée, jetons signés en HS256 avec le secret du client : refusés (algorithmes asymétriques seuls), refusé par choix (plus strict que la norme)", async () => {
        const x = await ouvrirProfil(moteur, t);
        x.idp.pieges = { alg: "HS256" };
        expect(codeRefus((await x.connecter(t.utilisateur("alice"))).retour)).toBe("failed");
      });

      it("Authentik : noms de groupes à espaces, virgules, majuscules et caractères Unicode comparés exactement", async () => {
        const nom = "Équipe Élpis, dév (été) 日本";
        const x = await ouvrirProfil(moteur, t, { extra: { required_groups: [nom] } });
        expect((await x.connecter(t.utilisateur("alice", [nom]))).retour.statusCode).toBe(200);
        expect(codeRefus((await x.connecter(t.utilisateur("bob", [nom.toLowerCase()]))).retour)).toBe(
          "not_in_group",
        );
      });
    });

    describe("LemonLDAP::NG", () => {
      const l = profil("lemonldap");
      it("LemonLDAP::NG : groupes rendus en une chaîne séparée par `;` : non découpés, appartenance inconnue (forme du produit non sourcée)", async () => {
        const x = await ouvrirProfil(moteur, l);
        const u = l.utilisateur("alice");
        expect(
          codeRefus((await x.connecter({ ...u, claims: { ...u.claims, groups: "elpis;users" } })).retour),
        ).toBe("groups_unknown");
      });

      it("LemonLDAP::NG : jeton signé en HS512 (algorithme par défaut ancien de certains clients, non sourcé) refusé, ES256 réglé accepté", async () => {
        const x = await ouvrirProfil(moteur, l, { idp: { alg: "ES256" }, extra: { id_token_alg: "ES256" } });
        expect((await x.connecter(l.utilisateur("alice"))).retour.statusCode).toBe(200);
        x.idp.pieges = { alg: "HS512" };
        expect(codeRefus((await x.connecter(l.utilisateur("alice"))).retour)).toBe("failed");
      });
    });

    describe("GitLab", () => {
      const g = profil("gitlab");
      it("GitLab : `sub` numérique rendu en chaîne, groupes en chemins complets (`elpis/equipe`) comparés exactement", async () => {
        const x = await ouvrirProfil(moteur, g, { extra: { required_groups: ["elpis/equipe"] } });
        expect((await x.connecter(g.utilisateur("alice"))).retour.statusCode).toBe(200);
      });

      it("GitLab : `sub` numérique non chaîne (entier JSON) refusé : sujet invalide", async () => {
        const x = await ouvrirProfil(moteur, g);
        const u = g.utilisateur("alice");
        x.idp.pieges = { claims: { sub: 42 } };
        expect(codeRefus((await x.connecter(u)).retour)).toBe("failed");
      });
    });

    describe("Dex", () => {
      const d = profil("dex");
      it("Dex : la portée `groups` figure dans l'adresse d'autorisation (sans elle Dex ne rend aucun groupe)", async () => {
        const x = await ouvrirProfil(moteur, d);
        const dep = await x.demarrer();
        expect(new URL(dep.url ?? "").searchParams.get("scope")?.split(" ")).toContain("groups");
      });
    });

    describe("Zitadel", () => {
      const z = profil("zitadel");
      it("Zitadel : rôles natifs en objet (`urn:zitadel:iam:org:project:roles`) : non lus, appartenance inconnue (limite du produit : un objet n'est pas lu comme liste de groupes)", async () => {
        const x = await ouvrirProfil(moteur, z, {
          extra: { groups_claim: "urn:zitadel:iam:org:project:roles" },
        });
        expect(codeRefus((await x.connecter(z.utilisateur("alice"))).retour)).toBe("groups_unknown");
      });

      it("Zitadel : jeton sans revendication de profil, l'identifiant vient de UserInfo (appelé avec le jeton d'accès porteur)", async () => {
        const x = await ouvrirProfil(moteur, z);
        const { retour } = await x.connecter(z.utilisateur("alice"));
        expect(retour.statusCode, retour.body).toBe(200);
        const t = x.idp.traces.find((r) => r.chemin === x.idp.chemins.userinfo);
        expect(t?.autorisation).toMatch(/^Bearer acces-/u);
        expect(await x.utilisateurs()).toContain("alice");
      });
    });

    describe("Authelia", () => {
      const a = profil("authelia");
      it("Authelia (RFC 9126, RFC 9207) : requête poussée, `iss` du retour vérifié : absent refusé, faux refusé, juste accepté", async () => {
        const x = await ouvrirProfil(moteur, a);
        const { rep, url } = await parcours(x, a.utilisateur("alice"));
        expect(new URL(url).searchParams.has("request_uri")).toBe(true);
        expect(rep.statusCode, rep.body).toBe(200);
        expect(
          codeRefus((await parcours(x, a.utilisateur("bob"), (r) => r.searchParams.delete("iss"))).rep),
        ).toBe("failed");
        expect(
          codeRefus(
            (
              await parcours(x, a.utilisateur("carl"), (r) =>
                r.searchParams.set("iss", "https://autre.exemple.lan"),
              )
            ).rep,
          ),
        ).toBe("failed");
      });
    });

    describe("Hydra et Auth0 : émetteur à la racine avec barre finale", () => {
      it("Hydra : émetteur `https://hôte/` et document sous `/.well-known/openid-configuration`, paramètre `iss` juste accepté, faux refusé", async () => {
        const h = profil("hydra");
        const x = await ouvrirProfil(moteur, h);
        expect(x.idp.issuer.endsWith("/")).toBe(true);
        expect((await parcours(x, h.utilisateur("alice"))).rep.statusCode).toBe(200);
        expect(
          codeRefus(
            (
              await parcours(x, h.utilisateur("bob"), (r) =>
                r.searchParams.set("iss", x.idp.issuer.replace(/\/$/u, "")),
              )
            ).rep,
          ),
        ).toBe("failed");
      });
    });

    describe("node-oidc-provider", () => {
      it("node-oidc-provider : jeton PS256 réglé, PAR annoncé et utilisé, `acr` en URN et `amr` liste sans exigence : parcours", async () => {
        const p = profil("panva");
        const x = await ouvrirProfil(moteur, p);
        const { rep, url } = await parcours(x, p.utilisateur("alice"));
        expect(rep.statusCode, rep.body).toBe(200);
        expect(new URL(url).searchParams.has("request_uri")).toBe(true);
      });
    });

    describe("Kanidm", () => {
      it("Kanidm : authentification du client réglée en `post` alors que le produit exige l'en-tête Basic : échec du point de jetons, refus propre", async () => {
        const p = profil("kanidm");
        const x = await ouvrirProfil(moteur, p, {
          idp: { authClient: "basic" },
          extra: { client_auth: "post" },
        });
        expect(codeRefus((await x.connecter(p.utilisateur("alice"))).retour)).toBe("failed");
        expect(causeDuDernierRefus()).toBe("client_auth_rejected");
      });
    });

    describe("OneLogin et Dex : portée de groupes", () => {
      it("OneLogin : la portée `groups` est demandée", async () => {
        const x = await ouvrirProfil(moteur, profil("onelogin"));
        const dep = await x.demarrer();
        expect(new URL(dep.url ?? "").searchParams.get("scope")?.split(" ")).toContain("groups");
      });
    });
  },
);
