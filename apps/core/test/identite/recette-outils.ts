// SPDX-License-Identifier: MIT
/** apps/core/test/identite/recette-outils.ts — outils des recettes à la main contre de vrais fournisseurs OpenID Connect : navigateur minimal sous une autorité d'essai, application Elpis composée, écouteur HTTPS qui relaie vers elle. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:https";
import type { Server } from "node:https";
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
import type { FournisseurOidc } from "../../src/identite/reglages";
import { appTest, journalMuet } from "../aides";
import { cleCoffreDeTest, configDeTest, oidcValide } from "./aides";
import type { ConfigDeTest } from "./aides";
import { cookies } from "./banc-oidc";

export interface Compte {
  readonly login: string;
  readonly mdp: string;
}

export interface Ecoute {
  readonly hote: string;
  readonly port: number;
  readonly cert: string;
  readonly cle: string;
}

export interface Reponse {
  readonly statut: number;
  readonly entetes: Record<string, string | string[] | undefined>;
  readonly corps: string;
}

const ACTEUR = { userId: null, username: null, ip: null };

/** Requête HTTPS vers le fournisseur sous l'autorité d'essai, sans suivi de redirection (le test joue le navigateur). */
export function navigateur(
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

/** Témoins posés par une réponse du fournisseur, ajoutés à ceux d'avant (un témoin vidé est retiré). */
export function temoins(r: Reponse, avant = ""): string {
  const jar = new Map<string, string>();
  for (const c of avant.split("; ").filter(Boolean)) jar.set(c.slice(0, c.indexOf("=")), c);
  const brut = r.entetes["set-cookie"];
  for (const l of Array.isArray(brut) ? brut : brut === undefined ? [] : [brut]) {
    const nv = l.split(";")[0] ?? "";
    const nom = nv.slice(0, nv.indexOf("="));
    if (nv.slice(nv.indexOf("=") + 1) === "" || /expires=Thu, 01 Jan 1970/iu.test(l)) jar.delete(nom);
    else jar.set(nom, nv);
  }
  return [...jar.values()].join("; ");
}

export interface BancRecette {
  readonly t: BaseDeTest;
  readonly main: FastifyInstance;
  readonly hote: string;
  /** Fournisseur courant, tel qu'il est enregistré. */
  fournisseur(): FournisseurOidc;
  /** Enregistre le fournisseur (réglages, secret, test réussi) et l'écrit dans la configuration. */
  installer(reglages: Record<string, unknown>, secret: string): Promise<FournisseurOidc>;
  adresse(): string;
  /** Départ SSO : adresse d'autorisation et témoin de liaison. */
  demarrer(id: string, ip: string): Promise<{ url: string; liaison: string }>;
  /** Retour du fournisseur sur Elpis avec le témoin de liaison. */
  retourner(
    id: string,
    lieu: string,
    liaison: string,
    ip: string,
  ): Promise<{ retour: LightMyRequestResponse; session: string }>;
  moi(session: string): Promise<{ username?: string; role?: string }>;
  interroger(
    methode: "GET" | "POST",
    url: string,
    cookie: string,
    corps?: object,
  ): Promise<LightMyRequestResponse>;
  /** Écouteur HTTPS à l'adresse publique d'Elpis, qui relaie vers l'application du test (canal arrière). */
  ecouter(e: Ecoute): Promise<void>;
  fermer(): Promise<void>;
}

/** Elpis composé (main) sur une base jetable, avec `public_url` pour adresse publique et `ca` pour seule autorité. */
export async function ouvrirBancRecette(publicUrl: string, ca: string): Promise<BancRecette> {
  const t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
  cleCoffreDeTest();
  const cfg: ConfigDeTest = configDeTest({ https: true });
  const dossier = mkdtempSync(join(tmpdir(), "elpis-recette-oidc-"));
  const audit = (): void =>
    configureAudit({
      service: "main",
      auditDir: join(dossier, "audit"),
      hmacKeyPath: join(dossier, "sans-cle"),
    });
  audit();
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
  const main = await appTest({
    ...(await composer("main", t.base, journalMuet, dep, dossier)),
    mode: "main",
  });
  audit();
  const hote = new URL(publicUrl).host;
  let courant: FournisseurOidc | undefined;
  let adresses = 0;
  let ecoute: Server | undefined;
  const banc: BancRecette = {
    t,
    main,
    hote,
    fournisseur() {
      if (courant === undefined) throw new Error("aucun fournisseur installé");
      return courant;
    },
    async installer(reglages, secret) {
      const f = validerFournisseur(oidcValide({ enabled: true, ca_pem: ca, ...reglages })) as FournisseurOidc;
      await enregistrerSecret(t.base, f, secret, ACTEUR);
      await enregistrerTestReussi(t.base, f, publicUrl);
      cfg.ecrire({ auth: { public_url: publicUrl, providers: [f] } });
      courant = f;
      return f;
    },
    adresse: () => `10.78.0.${(adresses += 1)}`,
    async demarrer(id, ip) {
      const r = await main.inject({
        method: "POST",
        url: `/api/auth/oidc/${id}/start`,
        remoteAddress: ip,
        headers: { host: hote, "sec-fetch-site": "same-origin" },
        payload: { target: "app" },
      });
      if (r.statusCode !== 200) throw new Error(`départ refusé : ${r.statusCode} ${r.body}`);
      return { url: r.json<{ url: string }>().url, liaison: cookies(r) };
    },
    async retourner(id, lieu, liaison, ip) {
      const retour = await main.inject({
        method: "GET",
        url: `/api/auth/oidc/${id}/callback${new URL(lieu).search}`,
        remoteAddress: ip,
        headers: { host: hote, cookie: liaison },
      });
      return { retour, session: cookies(retour, liaison) };
    },
    moi: async (session) =>
      (
        await main.inject({ method: "GET", url: "/api/me-lite", headers: { host: hote, cookie: session } })
      ).json<{ username?: string; role?: string }>(),
    interroger: (methode, url, cookie, corps) =>
      main.inject({
        method: methode,
        url,
        remoteAddress: banc.adresse(),
        headers: { host: hote, "sec-fetch-site": "same-origin", cookie },
        ...(corps === undefined ? {} : { payload: corps }),
      }),
    async ecouter(e) {
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
      const serveur = ecoute;
      await new Promise<void>((pret) => serveur.listen(e.port, e.hote, pret));
    },
    async fermer() {
      const serveur = ecoute;
      if (serveur !== undefined) await new Promise<void>((fin) => serveur.close(() => fin()));
      await main.close();
      oublierConfigurationAudit();
      cfg.fermer();
      await t.fermer();
      rmSync(dossier, { recursive: true, force: true });
    },
  };
  return banc;
}
