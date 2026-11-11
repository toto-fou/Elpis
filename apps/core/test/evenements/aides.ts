// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/aides.ts — vraie authentification (base, sessions, gardes), lecture brute d'un flux HTTP, mandataire TCP. */
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { createServer, Socket } from "node:net";
import type { AddressInfo, Server } from "node:net";

import { creerGardes, installerAuth, MANDATAIRES_DE_CONFIANCE } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { jetonInterne } from "@elpis/securite";
import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import type { SourceRedemarrage } from "../../src/evenements/redemarrage";
import type { Journal } from "../../src/journal";
import type { ModeApp } from "../../src/mode";
import { monterFamilles } from "../../src/routes";
import type { Famille, RouteMontee } from "../../src/routes";
import { journalMuet } from "../aides";
import {
  installerEntetesSecurite,
  installerGestionErreurs,
  installerLecteurCorps,
  installerMultipart,
} from "@elpis/http";

export const JETON_TOOLHOST = "jeton-de-service-du-toolhost";
export const SECRET = "secret-de-session-des-tests";
export const JETON_INTERNE = jetonInterne(SECRET);
export const ALICE = 1;
export const BOB = 2;
export const ADMIN = 3;

export const SOURCE_TEST: SourceRedemarrage = {
  lectures: ["llama.ip"],
  prefixesChauds: [],
  cheminsChauds: [],
  brutDemarrage: () => ({ llama: { ip: "10.0.0.5" } }),
  vueCourante: () => ({ llama: { ip: "10.0.0.5" } }),
};

export interface EnvAuth {
  readonly t: BaseDeTest;
  readonly dep: DependancesAuth;
  config: Record<string, unknown>;
}

/** Base SQLite initialisée (alice, bob, admin) et dépendances d'authentification partagées par main et admin. */
export async function environnementAuth(secret = SECRET): Promise<EnvAuth> {
  const t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  for (const [nom, role] of [
    ["alice", 0],
    ["bob", 0],
    ["admin", 1],
  ] as const) {
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, ?)",
      [nom, role],
    );
  }
  const env: EnvAuth = {
    t,
    config: {},
    dep: {
      base: t.base,
      config: () => env.config,
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => secret,
      jetonService: () => JETON_TOOLHOST,
    },
  };
  return env;
}

const familleConnexion: Famille = {
  nom: "connexion-de-test",
  routes: [
    {
      methode: "POST",
      chemin: "/test/connexion/:uid",
      processus: ["main", "admin"],
      acces: "public",
      traiter: (requete) => {
        const sid = randomUUID();
        requete.session.set("user_id", Number((requete.params as { uid: string }).uid));
        requete.session.set("_login_ts", Date.now() / 1000);
        requete.session.set("_sid", sid);
        return { sid };
      },
    },
  ],
};

/** Comme `ControleurJournal` de `creerApp` : pas de ligne par requête, erreurs de flux et d'écriture journalisées. */
class ControleurTest extends LogController {
  override incomingRequest(): void {}
  override requestCompleted(): void {}
  override routeNotFound(): void {}
}

/** Comme `creerApp`, avec `installerAuth` et les gardes réelles de `creerGardes` posées avant le montage des routes. */
export async function appAuthentifiee(
  mode: ModeApp,
  famille: Famille | readonly Famille[],
  dep: DependancesAuth,
  journal: Journal = journalMuet,
  options: { multipart?: boolean } = {},
): Promise<{ app: FastifyInstance; routes: RouteMontee[] }> {
  const loggerInstance: FastifyBaseLogger = journal;
  const app: FastifyInstance = Fastify({
    loggerInstance,
    logController: new ControleurTest(),
    keepAliveTimeout: 120_000,
    requestTimeout: 0,
    connectionTimeout: 0,
    return503OnClosing: false,
    trustProxy: [...MANDATAIRES_DE_CONFIANCE],
  });
  installerAuth(app, dep);
  installerEntetesSecurite(app);
  installerGestionErreurs(app, journal);
  installerLecteurCorps(app);
  if (options.multipart) await installerMultipart(app, 100 * 1024 * 1024);
  const familles = Array.isArray(famille) ? (famille as readonly Famille[]) : [famille as Famille];
  const routes = monterFamilles(app, mode, [...familles, familleConnexion], creerGardes(dep)).filter(
    (r) => r.famille !== familleConnexion.nom,
  );
  await app.ready();
  return { app, routes };
}

/** Ouvre une session réelle (cookie signé) pour `uid` ; rend le cookie et le `_sid`. */
export async function connecter(base: string, uid: number): Promise<{ cookie: string; sid: string }> {
  const reponse = await fetch(`${base}/test/connexion/${uid}`, { method: "POST" });
  const { sid } = (await reponse.json()) as { sid: string };
  const cookie = (reponse.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  if (!cookie.startsWith("mcpwebui_session=")) throw new Error(`pas de cookie de session : ${cookie}`);
  return { cookie, sid };
}

export async function attendreQue(
  condition: () => boolean,
  delaiMs = 5_000,
  quoi = "condition",
): Promise<void> {
  const fin = Date.now() + delaiMs;
  while (!condition()) {
    if (Date.now() > fin) throw new Error(`délai dépassé : ${quoi}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface FluxBrut {
  readonly statut: number;
  readonly entetes: IncomingHttpHeaders;
  texte(): string;
  readonly fini: Promise<void>;
  fermer(): void;
  suspendre(): void;
  reprendre(): void;
  attendreTexte(motif: string | RegExp, delaiMs?: number): Promise<void>;
}

/** Ouvre un flux (`GET`) et accumule ses octets décodés en UTF-8, sans interprétation. */
export function ouvrirFlux(url: string, entetes: Record<string, string> = {}): Promise<FluxBrut> {
  return new Promise((resoudre, rejeter) => {
    const req = request(url, { headers: entetes });
    req.on("error", rejeter);
    req.on("response", (rep) => {
      const morceaux: Buffer[] = [];
      let finir = (): void => {};
      const fini = new Promise<void>((r) => {
        finir = r;
      });
      rep.on("data", (m: Buffer) => morceaux.push(m));
      rep.on("end", () => finir());
      rep.on("close", () => finir());
      rep.on("error", () => finir());
      const texte = (): string => Buffer.concat(morceaux).toString("utf8");
      resoudre({
        statut: rep.statusCode ?? 0,
        entetes: rep.headers,
        texte,
        fini,
        fermer: () => req.destroy(),
        suspendre: () => rep.pause(),
        reprendre: () => rep.resume(),
        attendreTexte: (motif, delaiMs = 5_000) =>
          attendreQue(
            () => (typeof motif === "string" ? texte().includes(motif) : motif.test(texte())),
            delaiMs,
            `texte ${String(motif)}`,
          ),
      });
    });
    req.end();
  });
}

/** Mandataire TCP vers `cible` : coupe (connexions détruites, port refusé), gèle les octets, change de cible. */
export class Mandataire {
  cible: number;
  port = 0;
  private serveur: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private gele = false;

  constructor(cible: number) {
    this.cible = cible;
  }

  async ouvrir(port = 0): Promise<void> {
    const serveur = createServer((entree) => {
      const sortie = new Socket();
      this.sockets.add(entree);
      this.sockets.add(sortie);
      const fermer = (): void => {
        entree.destroy();
        sortie.destroy();
        this.sockets.delete(entree);
        this.sockets.delete(sortie);
      };
      entree.on("error", fermer).on("close", fermer);
      sortie.on("error", fermer).on("close", fermer);
      sortie.connect(this.cible, "127.0.0.1");
      entree.on("data", (d: Buffer) => {
        if (!this.gele) sortie.write(d);
      });
      sortie.on("data", (d: Buffer) => {
        if (!this.gele) entree.write(d);
      });
    });
    await new Promise<void>((r) => serveur.listen(port, "127.0.0.1", () => r()));
    this.port = (serveur.address() as AddressInfo).port;
    this.serveur = serveur;
  }

  geler(): void {
    this.gele = true;
  }

  degeler(): void {
    this.gele = false;
  }

  async couper(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const serveur = this.serveur;
    this.serveur = undefined;
    if (serveur) await new Promise<void>((r) => serveur.close(() => r()));
  }

  retablir(): Promise<void> {
    return this.ouvrir(this.port);
  }
}
