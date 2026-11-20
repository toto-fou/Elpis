// SPDX-License-Identifier: MIT
/** apps/core/test/identite/banc-oidc.ts — banc du SSO OIDC : base, config.json et coffre jetables, fournisseur factice actif (test réussi, secret rangé), main et console composés, parcours navigateur simulé (départ, autorisation, retour). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, revoquerOauthDuCompte } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { composer } from "../../src/composition";
import { enregistrerSecret, enregistrerTestReussi } from "../../src/identite/fournisseurs";
import { validerFournisseur } from "../../src/identite/reglages";
import type { Fournisseur } from "../../src/identite/reglages";
import { appTest, journalMuet } from "../aides";
import { cleCoffreDeTest, configDeTest, oidcValide } from "./aides";
import type { ConfigDeTest } from "./aides";
import type { OptionsSortant } from "../../src/identite/sortant";
import { OidcFactice, VERS_BOUCLE } from "./oidc-factice";
import type { OptionsFactice, Utilisateur } from "./oidc-factice";

export const URL_PUBLIQUE = "https://elpis.exemple.lan";
export const HOTE_PUBLIC = "elpis.exemple.lan";
export const COOKIE_LIAISON = "__Host-elpis-sso";
const ACTEUR = { userId: null, username: null, ip: null };
let compteurAdresses = 0;

/** Adresse cliente neuve : chaque appel a son propre seau de débit. */
export function adresseNeuve(): string {
  compteurAdresses += 1;
  return `10.${(compteurAdresses >> 16) & 255}.${(compteurAdresses >> 8) & 255}.${compteurAdresses & 255}`;
}

export interface ReponseDepart {
  readonly reponse: LightMyRequestResponse;
  /** Adresse d'autorisation rendue (`null` si le départ a échoué). */
  readonly url: string | null;
  /** `Cookie` à rejouer pour le retour (liaison, plus ce que le navigateur avait déjà). */
  readonly cookie: string;
}

export interface BancOidc {
  readonly t: BaseDeTest;
  readonly cfg: ConfigDeTest;
  readonly idp: OidcFactice;
  readonly fournisseur: Fournisseur;
  readonly chef: number;
  readonly main: FastifyInstance;
  readonly console: FastifyInstance;
  /** Second fournisseur actif sur le même fournisseur factice (autre identifiant). */
  ajouter(id: string, extra?: Record<string, unknown>): Promise<Fournisseur>;
  /** Réécrit config.json avec ce fournisseur (réglages modifiés, test et secret conservés). */
  reglages(extra: Record<string, unknown>): Promise<Fournisseur>;
  /** Départ du flux depuis le navigateur (POST start). */
  demarrer(o?: {
    id?: string;
    corps?: unknown;
    cookie?: string;
    hote?: string;
    adresse?: string;
    entetes?: Record<string, string>;
    process?: "main" | "console";
  }): Promise<ReponseDepart>;
  /** Retour sur le callback avec cet état d'un navigateur. */
  retourner(
    adresseDeRetour: string,
    o?: { id?: string; cookie?: string; adresse?: string; process?: "main" | "console" },
  ): Promise<LightMyRequestResponse>;
  /** Parcours entier : départ, authentification chez le fournisseur, retour. */
  connecter(
    u: Utilisateur,
    o?: { corps?: unknown; adresse?: string; cookieAvant?: string },
  ): Promise<{ depart: ReponseDepart; retour: LightMyRequestResponse; session: string }>;
  utilisateurs(): Promise<string[]>;
  fermer(): Promise<void>;
}

export const GROUPE = "elpis";
export const ELPIS = (sub: string, extra: Record<string, unknown> = {}): Utilisateur => ({
  sub,
  claims: {
    preferred_username: sub,
    name: `Nom de ${sub}`,
    email: `${sub}@exemple.lan`,
    email_verified: true,
    groups: [GROUPE],
    ...extra,
  },
});

/** Cookies posés par une réponse, réduits à `nom=valeur` ; ceux de `avant` conservés sauf s'ils sont remplacés. */
export function cookies(r: LightMyRequestResponse, avant = ""): string {
  const brut = r.headers["set-cookie"];
  const lignes = Array.isArray(brut) ? brut : brut === undefined ? [] : [brut];
  const jar = new Map<string, string>();
  for (const c of avant.split("; ").filter(Boolean)) jar.set(c.slice(0, c.indexOf("=")), c);
  for (const l of lignes) {
    const nv = l.split(";")[0] ?? "";
    const nom = nv.slice(0, nv.indexOf("="));
    if (/Max-Age=0/iu.test(l) || nv.slice(nv.indexOf("=") + 1) === '""') jar.delete(nom);
    else jar.set(nom, nv);
  }
  return [...jar.values()].join("; ");
}

/** Banc sur un moteur ; `extra` : réglages du fournisseur, `idp` : options du fournisseur factice. */
export async function ouvrirBancOidc(
  moteur: "sqlite" | "postgres",
  o: {
    extra?: Record<string, unknown>;
    idp?: OptionsFactice;
    actif?: boolean;
    sortant?: OptionsSortant;
  } = {},
): Promise<BancOidc> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  const chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
  cleCoffreDeTest();
  const cfg = configDeTest({ https: true });
  const idp = await OidcFactice.demarrer(o.idp);
  const dossier = mkdtempSync(join(tmpdir(), "elpis-banc-oidc-"));
  configureAudit({
    service: "main",
    auditDir: join(dossier, "audit"),
    hmacKeyPath: join(dossier, "sans-cle"),
  });
  const autres: Fournisseur[] = [];
  let fournisseur = validerFournisseur(
    oidcValide({
      id: "sso",
      label: "Single sign-on",
      enabled: o.actif ?? true,
      issuer: idp.issuer,
      client_id: idp.clientId,
      client_auth: idp.authClient,
      id_token_alg: idp.alg,
      ca_pem: idp.ca.cert,
      required_groups: [GROUPE],
      ...o.extra,
    }),
  ) as Fournisseur;
  await enregistrerSecret(t.base, fournisseur, idp.clientSecret, ACTEUR);
  await enregistrerTestReussi(t.base, fournisseur, URL_PUBLIQUE);
  const ecrire = (): void =>
    cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [fournisseur, ...autres] } });
  ecrire();
  const dep = {
    ...dependancesParDefaut(t.base),
    config: () => ({}),
    attributsCookie: () => ({
      cookie_name: "mcpwebui_session",
      same_site: "lax" as const,
      https_only: true,
      max_age: 86_400,
    }),
    secret: () => "secret-de-test",
    jetonService: () => "",
    revoquerOauth: (uid: number) => revoquerOauthDuCompte(t.base, uid, 1),
  };
  const racine = mkdtempSync(join(tmpdir(), "elpis-racine-oidc-"));
  const monter = async (mode: "main" | "admin"): Promise<FastifyInstance> =>
    appTest({
      ...(await composer(mode, t.base, journalMuet, dep, racine, {
        sortantOidc: { juger: VERS_BOUCLE, ...o.sortant },
      })),
      mode,
    });
  const main = await monter("main");
  const console = await monter("admin");
  configureAudit({
    service: "main",
    auditDir: join(dossier, "audit"),
    hmacKeyPath: join(dossier, "sans-cle"),
  });

  const banc: BancOidc = {
    t,
    cfg,
    idp,
    get fournisseur() {
      return fournisseur;
    },
    chef,
    main,
    console,
    async ajouter(id, extra = {}) {
      const f = validerFournisseur({ ...fournisseur, id, label: `Autre ${id}`, ...extra }) as Fournisseur;
      await enregistrerSecret(t.base, f, idp.clientSecret, ACTEUR);
      await enregistrerTestReussi(t.base, f, URL_PUBLIQUE);
      autres.push(f);
      ecrire();
      return f;
    },
    async reglages(extra) {
      fournisseur = validerFournisseur({ ...fournisseur, ...extra }) as Fournisseur;
      await enregistrerTestReussi(t.base, fournisseur, URL_PUBLIQUE);
      ecrire();
      return fournisseur;
    },
    async demarrer(opt = {}) {
      const app = opt.process === "console" ? console : main;
      const reponse = await app.inject({
        method: "POST",
        url: `/api/auth/oidc/${opt.id ?? "sso"}/start`,
        remoteAddress: opt.adresse ?? adresseNeuve(),
        headers: {
          host: opt.hote ?? HOTE_PUBLIC,
          "sec-fetch-site": "same-origin",
          ...(opt.cookie === undefined ? {} : { cookie: opt.cookie }),
          ...opt.entetes,
        },
        payload: (opt.corps ?? { target: "app" }) as object,
      });
      const corps = reponse.statusCode === 200 ? reponse.json<{ url?: string }>() : {};
      return { reponse, url: corps.url ?? null, cookie: cookies(reponse, opt.cookie ?? "") };
    },
    async retourner(adresse, opt = {}) {
      const app = opt.process === "console" ? console : main;
      const u = new URL(adresse);
      return app.inject({
        method: "GET",
        url: `/api/auth/oidc/${opt.id ?? "sso"}/callback${u.search}`,
        remoteAddress: opt.adresse ?? adresseNeuve(),
        headers: { host: HOTE_PUBLIC, ...(opt.cookie === undefined ? {} : { cookie: opt.cookie }) },
      });
    },
    async connecter(u, opt = {}) {
      const adresse = opt.adresse ?? adresseNeuve();
      const depart = await banc.demarrer({
        corps: opt.corps ?? { target: "app" },
        adresse,
        ...(opt.cookieAvant === undefined ? {} : { cookie: opt.cookieAvant }),
      });
      if (depart.url === null)
        throw new Error(`départ refusé : ${depart.reponse.statusCode} ${depart.reponse.body}`);
      const { retour: adresseRetour } = idp.autoriser(depart.url, u);
      const retour = await banc.retourner(adresseRetour, { cookie: depart.cookie, adresse });
      return { depart, retour, session: cookies(retour, depart.cookie) };
    },
    utilisateurs: async () =>
      (await t.base.valeurs<[string]>("SELECT username FROM users ORDER BY id")).map((r) => r[0]),
    async fermer() {
      await main.close();
      await console.close();
      await idp.fermer();
      oublierConfigurationAudit();
      cfg.fermer();
      await t.fermer();
      rmSync(dossier, { recursive: true, force: true });
      rmSync(racine, { recursive: true, force: true });
    },
  };
  return banc;
}
