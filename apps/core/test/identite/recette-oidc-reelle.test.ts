// SPDX-License-Identifier: MIT
/** apps/core/test/identite/recette-oidc-reelle.test.ts — recette à la main contre un vrai fournisseur OpenID Connect (Keycloak…) décrit par le fichier JSON de `ELPIS_RECETTE_OIDC` ; sautée sans lui. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, revoquerOauthDuCompte } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composer } from "../../src/composition";
import { testerFournisseur } from "../../src/identite/essai";
import { enregistrerSecret, enregistrerTestReussi, secretFournisseur } from "../../src/identite/fournisseurs";
import { validerFournisseur } from "../../src/identite/reglages";
import type { FournisseurOidc } from "../../src/identite/reglages";
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
  o: { cookie?: string; corps?: string } = {},
): Promise<Reponse> {
  return new Promise((resoudre, rejeter) => {
    const r = request(
      adresse,
      {
        method: o.corps === undefined ? "GET" : "POST",
        ca,
        headers: {
          ...(o.cookie ? { cookie: o.cookie } : {}),
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
  let fournisseur: FournisseurOidc;
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
    ) as FournisseurOidc;
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
      expect(e?.suspended_by).toBe("directory:sso");
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
    // Seul l'essai de connexion d'un administrateur valide un fournisseur SSO.
    expect(r.complete).toBe(false);
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
});
