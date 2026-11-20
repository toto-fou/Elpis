// SPDX-License-Identifier: MIT
/** apps/core/test/identite/recette-oidc-reelle.test.ts — recette à la main contre un vrai fournisseur OpenID Connect (Keycloak…) décrit par le fichier JSON de `ELPIS_RECETTE_OIDC` ; sautée sans lui. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:https";
import type { Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, resetUserPassword, revoquerOauthDuCompte } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composer } from "../../src/composition";
import { testerFournisseur } from "../../src/identite/essai";
import { enregistrerSecret, enregistrerTestReussi, secretFournisseur } from "../../src/identite/fournisseurs";
import { ancreIdentite } from "../../src/identite/ancre";
import { preparerRattachement } from "../../src/identite/rattachement";
import { validerFournisseur } from "../../src/identite/reglages";
import type { Fournisseur } from "../../src/identite/reglages";
import { appTest, journalMuet } from "../aides";
import { cleCoffreDeTest, configDeTest, oidcValide } from "./aides";
import type { ConfigDeTest } from "./aides";
import { cookies } from "./banc-oidc";

interface Compte {
  readonly login: string;
  readonly mdp: string;
}

interface Recette {
  readonly ca: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly public_url: string;
  readonly groupe: string;
  /** Groupe dont `membre` fait partie et pas `autre_membre`. */
  readonly autre_groupe: string;
  readonly membre: Compte;
  readonly autre_membre: Compte;
  readonly hors_groupe: Compte;
  /** Valeur d'`acr` que le fournisseur met dans ses jetons (exigée pour donner le rôle administrateur). */
  readonly acr?: string;
  /** Administrateur du fournisseur (API d'administration), pour provoquer une déconnexion par canal arrière. */
  readonly admin_fournisseur?: Compte & { readonly realm: string };
  /** Adresse où le fournisseur peut joindre Elpis en HTTPS (celle de `public_url`), avec son certificat. */
  readonly ecoute?: {
    readonly hote: string;
    readonly port: number;
    readonly cert: string;
    readonly cle: string;
  };
}

const CHEMIN = process.env["ELPIS_RECETTE_OIDC"] ?? "";
const RECETTE: Recette | null = CHEMIN ? (JSON.parse(readFileSync(CHEMIN, "utf8")) as Recette) : null;
const ACTEUR = { userId: null, username: null, ip: null };

interface Reponse {
  readonly statut: number;
  readonly entetes: Record<string, string | string[] | undefined>;
  readonly corps: string;
}

/** Requête HTTPS vers le fournisseur sous l'autorité d'essai, sans suivi de redirection (le test joue le navigateur). */
function navigateur(
  adresse: string,
  ca: string,
  o: { cookie?: string; corps?: string; entetes?: Record<string, string> } = {},
): Promise<Reponse> {
  return new Promise((resoudre, rejeter) => {
    const r = request(
      adresse,
      {
        method: o.corps === undefined ? "GET" : "POST",
        ca,
        headers: {
          ...(o.cookie ? { cookie: o.cookie } : {}),
          ...o.entetes,
          ...(o.corps === undefined
            ? {}
            : {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": String(Buffer.byteLength(o.corps)),
              }),
        },
      },
      (rep) => {
        const morceaux: Buffer[] = [];
        rep.on("data", (m: Buffer) => morceaux.push(m));
        rep.on("end", () =>
          resoudre({
            statut: rep.statusCode ?? 0,
            entetes: rep.headers,
            corps: Buffer.concat(morceaux).toString("utf8"),
          }),
        );
      },
    );
    r.on("error", rejeter);
    r.end(o.corps);
  });
}

function temoins(r: Reponse, avant = ""): string {
  const jar = new Map<string, string>();
  for (const c of avant.split("; ").filter(Boolean)) jar.set(c.slice(0, c.indexOf("=")), c);
  const brut = r.entetes["set-cookie"];
  for (const l of Array.isArray(brut) ? brut : brut === undefined ? [] : [brut]) {
    const nv = l.split(";")[0] ?? "";
    jar.set(nv.slice(0, nv.indexOf("=")), nv);
  }
  return [...jar.values()].join("; ");
}

describe.skipIf(RECETTE === null)("recette sur un fournisseur OpenID Connect réel", () => {
  const recette = RECETTE as Recette;
  const ca = RECETTE === null ? "" : readFileSync(recette.ca, "utf8");
  const hote = RECETTE === null ? "" : new URL(recette.public_url).host;
  let t: BaseDeTest;
  let cfg: ConfigDeTest;
  let main: FastifyInstance;
  let dossier: string;
  let fournisseur: Fournisseur;
  let adresses = 0;
  const adresse = (): string => `10.77.0.${(adresses += 1)}`;

  async function installer(
    extra: Record<string, unknown> = {},
    secret = recette.client_secret,
  ): Promise<void> {
    fournisseur = validerFournisseur(
      oidcValide({
        id: "sso",
        label: "Organisation",
        enabled: true,
        issuer: recette.issuer,
        client_id: recette.client_id,
        ca_pem: ca,
        required_groups: [recette.groupe],
        ...extra,
      }),
    ) as Fournisseur;
    await enregistrerSecret(t.base, fournisseur, secret, ACTEUR);
    await enregistrerTestReussi(t.base, fournisseur, recette.public_url);
    cfg.ecrire({ auth: { public_url: recette.public_url, providers: [fournisseur] } });
  }

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    cleCoffreDeTest();
    cfg = configDeTest({ https: true });
    dossier = mkdtempSync(join(tmpdir(), "elpis-recette-oidc-"));
    configureAudit({
      service: "main",
      auditDir: join(dossier, "audit"),
      hmacKeyPath: join(dossier, "sans-cle"),
    });
    await installer();
    const dep = {
      ...dependancesParDefaut(t.base),
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax" as const,
        https_only: true,
        max_age: 86_400,
      }),
      secret: () => "secret-de-recette",
      jetonService: () => "",
      revoquerOauth: (uid: number) => revoquerOauthDuCompte(t.base, uid, 1),
    };
    main = await appTest({ ...(await composer("main", t.base, journalMuet, dep, dossier)), mode: "main" });
    configureAudit({
      service: "main",
      auditDir: join(dossier, "audit"),
      hmacKeyPath: join(dossier, "sans-cle"),
    });
  }, 60_000);

  afterAll(async () => {
    await main?.close();
    oublierConfigurationAudit();
    cfg?.fermer();
    await t?.fermer();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  /** Parcours entier joué comme un navigateur : départ, formulaire du fournisseur, retour sur Elpis. */
  async function connecter(c: Compte): Promise<{ retour: LightMyRequestResponse; session: string }> {
    const ip = adresse();
    const depart = await main.inject({
      method: "POST",
      url: "/api/auth/oidc/sso/start",
      remoteAddress: ip,
      headers: { host: hote, "sec-fetch-site": "same-origin" },
      payload: { target: "app" },
    });
    expect(depart.statusCode, depart.body).toBe(200);
    const liaison = cookies(depart);
    // Le fournisseur peut rediriger chez lui avant d'afficher son formulaire : suivi borné, sur sa seule origine.
    let page = await navigateur(depart.json<{ url: string }>().url, ca);
    let jar = temoins(page);
    for (let i = 0; i < 5 && page.statut === 302; i++) {
      const suite = new URL(String(page.entetes["location"]), recette.issuer);
      expect(suite.origin).toBe(new URL(recette.issuer).origin);
      page = await navigateur(suite.href, ca, { cookie: jar });
      jar = temoins(page, jar);
    }
    expect(page.statut, page.corps.slice(0, 200)).toBe(200);
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/u.exec(page.corps)?.[1];
    expect(action, "formulaire de connexion du fournisseur").toBeTruthy();
    const envoi = await navigateur((action ?? "").replaceAll("&amp;", "&"), ca, {
      cookie: jar,
      corps: new URLSearchParams({ username: c.login, password: c.mdp, credentialId: "" }).toString(),
    });
    expect(envoi.statut, envoi.corps.slice(0, 300)).toBe(302);
    const lieu = String(envoi.entetes["location"]);
    expect(lieu.startsWith(`${recette.public_url}/api/auth/oidc/sso/callback?`)).toBe(true);
    const retour = await main.inject({
      method: "GET",
      url: `/api/auth/oidc/sso/callback${new URL(lieu).search}`,
      remoteAddress: ip,
      headers: { host: hote, cookie: liaison },
    });
    return { retour, session: cookies(retour, liaison) };
  }

  const moi = async (session: string): Promise<{ username?: string }> =>
    (
      await main.inject({ method: "GET", url: "/api/me-lite", headers: { host: hote, cookie: session } })
    ).json<{ username?: string }>();

  it("un membre du groupe requis se connecte : compte créé, session ouverte, identité par le sujet du fournisseur", async () => {
    const { retour, session } = await connecter(recette.membre);
    expect(retour.statusCode, `retour : ${String(retour.headers["location"])}`).toBe(200);
    expect(retour.headers["content-type"]).toMatch(/text\/html/u);
    expect((await moi(session)).username).toBe(recette.membre.login);
    const identites = await t.base.all<{ subject: string; issuer: string; ext_username: string }>(
      "SELECT subject, issuer, ext_username FROM user_identities WHERE provider_id='sso'",
    );
    expect(identites).toHaveLength(1);
    expect(identites[0]?.subject).not.toBe(recette.membre.login);
    expect(identites[0]?.issuer).toBe(`oidc:${recette.issuer}`);
  }, 60_000);

  it("seconde connexion : le même compte, aucun doublon", async () => {
    const { retour, session } = await connecter(recette.membre);
    expect(retour.statusCode).toBe(200);
    expect((await moi(session)).username).toBe(recette.membre.login);
    const n = await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_identities");
    expect(Number(n?.n)).toBe(1);
  }, 60_000);

  it("identifiant à point : le nom Elpis est dérivé, l'identité garde l'identifiant du fournisseur", async () => {
    const { retour, session } = await connecter(recette.autre_membre);
    expect(retour.statusCode, retour.body.slice(0, 300)).toBe(200);
    expect((await moi(session)).username).toBe(recette.autre_membre.login.replaceAll(".", "-"));
  }, 60_000);

  it("sans aucun groupe : la revendication est absente, donc « groupes illisibles » : refus, aucun compte, aucune session", async () => {
    const avant = await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
    const { retour, session } = await connecter(recette.hors_groupe);
    expect(retour.statusCode).toBe(302);
    expect(String(retour.headers["location"])).toMatch(
      /^\/\?auth_error=groups_unknown&ref=[A-Za-z0-9_-]{8}$/u,
    );
    expect((await moi(session)).username).toBeUndefined();
    const apres = await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
    expect(Number(apres?.n)).toBe(Number(avant?.n));
  }, 60_000);

  it("compte connu sorti du groupe requis : refus `not_in_group` et suspension ; revenu dans le groupe : réactivé", async () => {
    const nom = recette.autre_membre.login.replaceAll(".", "-");
    const etat = async (): Promise<{ suspended_at: unknown; suspended_by: unknown } | undefined> =>
      t.base.get("SELECT suspended_at, suspended_by FROM users WHERE username=?", [nom]);
    await installer({ required_groups: [recette.autre_groupe] });
    try {
      const { retour, session } = await connecter(recette.autre_membre);
      expect(retour.statusCode).toBe(302);
      expect(String(retour.headers["location"])).toMatch(
        /^\/\?auth_error=not_in_group&ref=[A-Za-z0-9_-]{8}$/u,
      );
      expect((await moi(session)).username).toBeUndefined();
      const e = await etat();
      expect(Number(e?.suspended_at)).toBeGreaterThan(0);
      expect(e?.suspended_by).toBe("provider:sso");
    } finally {
      await installer();
    }
    const { retour, session } = await connecter(recette.autre_membre);
    expect(retour.statusCode, String(retour.headers["location"])).toBe(200);
    expect((await moi(session)).username).toBe(nom);
    expect(Number((await etat())?.suspended_at ?? 0)).toBe(0);
  }, 60_000);

  it("bouton Tester : découverte, points d'accès, algorithme, clés et secret passent, sans échec", async () => {
    const { type: _type, ...reglages } = fournisseur;
    const r = await testerFournisseur(
      { type: "oidc", ...reglages },
      { publicUrl: recette.public_url, cookieSecure: true, adminsLocaux: 1 },
      { oidc: { secretEnregistre: (f) => secretFournisseur(t.base, f) } },
    );
    expect(r.steps.filter((e) => e.level === "fail").map((e) => `${e.id} : ${e.detail}`)).toEqual([]);
    expect(r.steps.map((e) => e.id)).toEqual(
      expect.arrayContaining([
        "tls",
        "discovery",
        "endpoints",
        "algorithms",
        "jwks",
        "client_auth",
        "secret",
      ]),
    );
  }, 60_000);

  it("secret client faux : le fournisseur refuse le client, aucune connexion possible", async () => {
    await installer({}, "pas-le-bon-secret");
    try {
      const depart = await main.inject({
        method: "POST",
        url: "/api/auth/oidc/sso/start",
        remoteAddress: adresse(),
        headers: { host: hote, "sec-fetch-site": "same-origin" },
        payload: { target: "app" },
      });
      // Avec les demandes d'autorisation poussées (PAR), le client est authentifié dès le départ.
      expect([200, 503]).toContain(depart.statusCode);
      expect(depart.body).not.toContain("pas-le-bon-secret");
      if (depart.statusCode === 200) {
        const { retour, session } = await connecter(recette.membre);
        expect(retour.statusCode).toBe(302);
        expect((await moi(session)).username).toBeUndefined();
      }
    } finally {
      await installer();
    }
  }, 60_000);

  it("sans l'autorité du fournisseur : départ impossible (certificat non reconnu)", async () => {
    await installer({ ca_pem: "" });
    try {
      const depart = await main.inject({
        method: "POST",
        url: "/api/auth/oidc/sso/start",
        remoteAddress: adresse(),
        headers: { host: hote, "sec-fetch-site": "same-origin" },
        payload: { target: "app" },
      });
      expect(depart.statusCode).toBe(503);
    } finally {
      await installer();
    }
  }, 60_000);

  const interroger = (methode: "GET" | "POST", url: string, cookie: string, corps?: object) =>
    main.inject({
      method: methode,
      url,
      remoteAddress: adresse(),
      headers: { host: hote, "sec-fetch-site": "same-origin", cookie },
      ...(corps === undefined ? {} : { payload: corps }),
    });

  it("preuve du titulaire : un compte local existant est relié après son ancien mot de passe, une seule fois", async () => {
    const nom = recette.membre.login;
    const compte = await t.base.get<{ id: number }>("SELECT id FROM users WHERE username=?", [nom]);
    const uid = Number(compte?.id);
    // Le compte redevient un compte local à mot de passe, comme sur une instance d'avant le SSO.
    await t.base.run("DELETE FROM user_identities WHERE user_id=?", [uid]);
    await resetUserPassword(t.base, uid, "ancien-mdp-local-1", { detacher: true });
    const prepare = await t.base.ecriture((x) =>
      preparerRattachement(x, {
        uid,
        fournisseurId: "sso",
        ancre: ancreIdentite(fournisseur),
        attendu: nom,
        dispense: false,
        confirmeAdmin: false,
        par: 1,
        t: Date.now() / 1000,
      }),
    );
    expect(prepare).toHaveProperty("id");

    const { retour, session: liaison } = await connecter(recette.membre);
    expect(retour.statusCode, String(retour.headers["location"])).toBe(200);
    expect(retour.body).toContain("auth_link=1");
    expect((await moi(liaison)).username).toBeUndefined();
    expect((await interroger("GET", "/api/auth/oidc/link-proof", liaison)).json()).toEqual({
      pending: true,
      username: nom,
    });
    // Sans le cookie de liaison (autre navigateur), rien n'est en attente.
    expect((await interroger("GET", "/api/auth/oidc/link-proof", "")).json()).toEqual({
      pending: false,
      username: null,
    });
    const faux = await interroger("POST", "/api/auth/oidc/link-proof", liaison, { password: "pas-le-bon" });
    expect(faux.statusCode).toBe(401);
    const bon = await interroger("POST", "/api/auth/oidc/link-proof", liaison, {
      password: "ancien-mdp-local-1",
    });
    expect(bon.statusCode, bon.body).toBe(200);
    expect(bon.json()).toMatchObject({ ok: true, next: "/" });
    expect((await moi(cookies(bon, liaison))).username).toBe(nom);
    const identite = await t.base.get<{ linked_by: string; issuer: string }>(
      "SELECT linked_by, issuer FROM user_identities WHERE user_id=?",
      [uid],
    );
    expect(identite).toMatchObject({ linked_by: "proof", issuer: `oidc:${recette.issuer}` });
    // L'ancien mot de passe local ne vaut plus rien, et la preuve ne se rejoue pas.
    const local = await interroger("POST", "/api/login-lite", "", {
      username: nom,
      password: "ancien-mdp-local-1",
    });
    expect(local.statusCode).toBe(401);
    const rejeu = await interroger("POST", "/api/auth/oidc/link-proof", liaison, {
      password: "ancien-mdp-local-1",
    });
    expect(rejeu.statusCode).toBe(409);
  }, 60_000);

  it.skipIf(RECETTE?.acr === undefined)(
    "rôles d'après les groupes : un niveau `acr` à un seul facteur ne donne jamais le rôle administrateur",
    async () => {
      // Le niveau de la recette (« 1 », mot de passe seul) ne prouve aucun second facteur : groupes d'administrateurs ignorés.
      await installer({
        required_acr: [recette.acr],
        roles: { enabled: true, admin_groups: [recette.autre_groupe], moderator_groups: [] },
      });
      try {
        const role = async (c: Compte): Promise<string | undefined> => {
          const { retour, session } = await connecter(c);
          expect(retour.statusCode, String(retour.headers["location"])).toBe(200);
          return (
            await main.inject({
              method: "GET",
              url: "/api/me-lite",
              headers: { host: hote, cookie: session },
            })
          ).json<{ role?: string }>().role;
        };
        expect(await role(recette.membre)).toBe("user");
        expect(await role(recette.autre_membre)).toBe("user");
      } finally {
        await installer();
      }
    },
    60_000,
  );

  describe.skipIf(RECETTE?.ecoute === undefined || RECETTE?.admin_fournisseur === undefined)(
    "déconnexion côté fournisseur",
    () => {
      let ecoute: Server;

      beforeAll(async () => {
        const e = recette.ecoute;
        if (e === undefined) return;
        await installer({ logout: { rp_initiated: true, backchannel: true } });
        // Le fournisseur appelle Elpis à son adresse publique : un écouteur HTTPS relaie vers l'application du test.
        ecoute = createServer({ cert: readFileSync(e.cert), key: readFileSync(e.cle) }, (req, res) => {
          const morceaux: Buffer[] = [];
          req.on("data", (m: Buffer) => morceaux.push(m));
          req.on("end", () => {
            void main
              .inject({
                method: req.method === "POST" ? "POST" : "GET",
                url: req.url ?? "/",
                headers: req.headers as Record<string, string>,
                payload: Buffer.concat(morceaux),
                remoteAddress: req.socket.remoteAddress ?? "0.0.0.0",
              })
              .then((r) => {
                res.writeHead(r.statusCode);
                res.end(r.rawPayload);
              });
          });
        });
        await new Promise<void>((pret) => ecoute.listen(e.port, e.hote, pret));
      });

      afterAll(async () => {
        await new Promise<void>((fin) => (ecoute === undefined ? fin() : ecoute.close(() => fin())));
        await installer();
      });

      it("déconnexion d'Elpis : `logout_url` mène à la fin de session du fournisseur, sur son origine", async () => {
        const { retour, session } = await connecter(recette.autre_membre);
        expect(retour.statusCode, String(retour.headers["location"])).toBe(200);
        const sortie = await interroger("POST", "/api/logout-lite", session);
        expect(sortie.statusCode).toBe(200);
        const adresseDeFin = new URL(sortie.json<{ logout_url: string }>().logout_url);
        expect(adresseDeFin.origin).toBe(new URL(recette.issuer).origin);
        expect(adresseDeFin.searchParams.get("post_logout_redirect_uri")).toBe(`${recette.public_url}/`);
        expect((await moi(session)).username).toBeUndefined();
      }, 60_000);

      it("session fermée chez le fournisseur : il prévient Elpis par canal arrière, la session Elpis meurt", async () => {
        const admin = recette.admin_fournisseur;
        if (admin === undefined) return;
        const { retour, session } = await connecter(recette.autre_membre);
        expect(retour.statusCode, String(retour.headers["location"])).toBe(200);
        const nom = recette.autre_membre.login.replaceAll(".", "-");
        expect((await moi(session)).username).toBe(nom);
        const racine = new URL(recette.issuer).origin;
        const jeton = await navigateur(`${racine}/realms/master/protocol/openid-connect/token`, ca, {
          corps: new URLSearchParams({
            grant_type: "password",
            client_id: "admin-cli",
            username: admin.login,
            password: admin.mdp,
          }).toString(),
        });
        expect(jeton.statut, jeton.corps.slice(0, 200)).toBe(200);
        const porteur = {
          authorization: `Bearer ${(JSON.parse(jeton.corps) as { access_token: string }).access_token}`,
        };
        const liste = await navigateur(
          `${racine}/admin/realms/${admin.realm}/users?exact=true&username=${encodeURIComponent(recette.autre_membre.login)}`,
          ca,
          { entetes: porteur },
        );
        const idFournisseur = (JSON.parse(liste.corps) as { id: string }[])[0]?.id;
        expect(idFournisseur, liste.corps.slice(0, 200)).toBeTruthy();
        const fermeture = await navigateur(
          `${racine}/admin/realms/${admin.realm}/users/${String(idFournisseur)}/logout`,
          ca,
          { corps: "", entetes: porteur },
        );
        expect(fermeture.statut, fermeture.corps.slice(0, 200)).toBe(204);
        await expect
          .poll(async () => (await moi(session)).username, { timeout: 15_000, interval: 500 })
          .toBeUndefined();
      }, 60_000);
    },
  );
});
