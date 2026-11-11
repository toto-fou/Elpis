// SPDX-License-Identifier: MIT
/** apps/core/test/relais/aides.ts — faux hôte d'outils (vérifie jeton de service et enveloppe), app main avec session réelle, manifeste jetable. */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { creerGardes, installerAuth } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { IDENTITY_HEADER, verify } from "@elpis/securite";
import type { Identity } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import WebSocket, { WebSocketServer } from "ws";

import { creerApp } from "../../src/app";
import { remplacerBase } from "../../src/base";
import { Journal } from "../../src/journal";
import { creerRelais, familleJetonApercu } from "../../src/relais/index";
import type { OptionsRelais, Relais } from "../../src/relais/index";
import { oublierHotes } from "../../src/relais/hotes";
import type { Famille } from "../../src/routes";

export const JETON = "jeton-de-service-de-test";
export const lignes: string[] = [];
export const journalTest = new Journal({ niveau: "trace", sortie: (l) => lignes.push(l) });

export interface RequeteVue {
  methode: string;
  url: string;
  entetes: IncomingMessage["headers"];
  brutes: string[];
  identite: Identity | null;
  corps: Buffer;
  fermee: boolean;
}

export interface WsVue {
  url: string;
  identite: Identity | null;
  socket: WebSocket;
  fermeture: Promise<{ code: number; raison: string }>;
}

type Traitement = (
  requete: IncomingMessage,
  reponse: ServerResponse,
  vue: RequeteVue,
) => void | Promise<void>;

/** Hôte d'outils de test : deux preuves exigées (Bearer + enveloppe signée), comme toolhost/auth.py. */
export class FauxToolhost {
  readonly requetes: RequeteVue[] = [];
  readonly ws: WsVue[] = [];
  readonly traitements = new Map<string, Traitement>();
  sockets = new Set<Socket>();
  private serveur: Server | undefined;
  private wss = new WebSocketServer({ noServer: true });
  jeton = JETON;
  hote = "127.0.0.1";
  port = 0;

  get url(): string {
    return `http://${this.hote}:${this.port}`;
  }

  private identite(entetes: IncomingMessage["headers"]): Identity | null {
    const auth = String(entetes.authorization ?? "");
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== this.jeton) return null;
    const enveloppe = entetes[IDENTITY_HEADER];
    return verify(Array.isArray(enveloppe) ? enveloppe[0] : enveloppe, this.jeton);
  }

  async demarrer(hote = "127.0.0.1"): Promise<this> {
    this.hote = hote;
    this.serveur = createServer((requete, reponse) => void this.servir(requete, reponse));
    this.serveur.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    this.serveur.on("upgrade", (requete: IncomingMessage, socket: Socket, tete: Buffer) => {
      const identite = this.identite(requete.headers);
      if (identite === null) {
        socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(requete, socket, tete, (ws) => this.accueillir(ws, requete, identite));
    });
    await new Promise<void>((fin) => this.serveur?.listen(0, hote, fin));
    const adresse = this.serveur.address();
    this.port = typeof adresse === "object" && adresse ? adresse.port : 0;
    return this;
  }

  private async servir(requete: IncomingMessage, reponse: ServerResponse): Promise<void> {
    const vue: RequeteVue = {
      methode: requete.method ?? "",
      url: requete.url ?? "",
      entetes: requete.headers,
      brutes: requete.rawHeaders,
      identite: this.identite(requete.headers),
      corps: Buffer.alloc(0),
      fermee: false,
    };
    this.requetes.push(vue);
    reponse.on("close", () => {
      vue.fermee = true;
    });
    if (vue.identite === null) {
      reponse.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      reponse.end(JSON.stringify({ detail: "enveloppe d'identité absente ou invalide" }));
      return;
    }
    const chemin = (requete.url ?? "").split("?")[0] ?? "";
    const traitement = this.traitements.get(chemin);
    if (traitement) {
      await traitement(requete, reponse, vue);
      return;
    }
    const morceaux: Buffer[] = [];
    for await (const m of requete) morceaux.push(m as Buffer);
    vue.corps = Buffer.concat(morceaux);
    reponse.writeHead(200, { "content-type": "application/json" });
    reponse.end(
      JSON.stringify({
        methode: vue.methode,
        url: vue.url,
        uid: vue.identite.user_id,
        nom: vue.identite.username,
        admin: vue.identite.is_admin,
        profil: vue.identite.network_profile_id,
        impose: vue.identite.forced_network_profile_id,
        taille: vue.corps.length,
        empreinte: createHash("sha256").update(vue.corps).digest("hex"),
      }),
    );
  }

  private accueillir(ws: WebSocket, requete: IncomingMessage, identite: Identity): void {
    const url = requete.url ?? "";
    const fermeture = new Promise<{ code: number; raison: string }>((fin) => {
      ws.on("close", (code, raison) => fin({ code, raison: raison.toString() }));
    });
    this.ws.push({ url, identite, socket: ws, fermeture });
    if (url.startsWith("/ws/terminal/expiree")) {
      ws.close(4001, "session expirée");
      return;
    }
    if (url.startsWith("/ws/terminal/coupe")) {
      ws.terminate();
      return;
    }
    if (url.startsWith("/ws/terminal/muet")) {
      (ws as unknown as { _socket: Socket })._socket.pause();
      return;
    }
    if (url.startsWith("/ws/terminal/inonde")) {
      void this.inonder(ws);
      return;
    }
    ws.send(`hello ${identite.username} ${url}`);
    ws.on("message", (donnees, binaire) => {
      if (binaire) ws.send(Buffer.concat([Buffer.from("bin:"), donnees as Buffer]), { binary: true });
      else ws.send(`echo:${String(donnees)}`);
    });
  }

  /** Messages de 64 Kio envoyés tant que la socket les accepte ; `inondes` compte ceux réellement écrits. */
  inondes = 0;
  readonly totalInondation = 512;

  private async inonder(ws: WebSocket): Promise<void> {
    const morceau = randomBytes(64 * 1024);
    for (let i = 0; i < this.totalInondation && ws.readyState === WebSocket.OPEN; i++) {
      await new Promise<void>((fin) =>
        ws.send(morceau, { binary: true }, () => {
          this.inondes++;
          fin();
        }),
      );
    }
  }

  async arreter(): Promise<void> {
    for (const w of this.ws) w.socket.terminate();
    this.wss.close();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((fin) => (this.serveur ? this.serveur.close(() => fin()) : fin()));
  }
}

export interface Banc {
  app: FastifyInstance;
  relais: Relais;
  base: BaseDeTest;
  url: string;
  arret: AbortController;
  dep: DependancesAuth;
  config: Record<string, unknown>;
  manifeste(hotes: Record<string, unknown>, placement?: Record<string, unknown>): void;
  connecter(uid: number): Promise<string>;
  fermer(): Promise<void>;
}

let horloge = 1_791_331_200;
export function avancer(secondes: number): void {
  horloge += secondes;
}

/** App main réelle (creerApp) : session et CSRF de @elpis/auth, gardes réelles, base SQLite neuve, famille du relais. */
export async function monterBanc(
  options: Omit<OptionsRelais, "arret"> = {},
  app: { limiteCorps?: number; corsOrigines?: readonly string[] } = {},
): Promise<Banc> {
  const base = ouvrirBaseDeTest("sqlite");
  await initialiserBase(base.base);
  for (const [nom, role, changer, reglages] of [
    ["alice", 0, 0, '{"network_profile_id": "bridge"}'],
    ["bob", 0, 0, null],
    ["chef", 1, 0, '{"forced_network_profile_id": "lan", "network_profile_id": "bridge"}'],
    ["neuf", 0, 1, null],
    ["modo", 2, 0, "{corrompu"],
  ] as const) {
    await base.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin, must_change_pwd, settings_json) VALUES (?, 's', 'h', 0, ?, ?, ?)",
      [nom, role, changer, reglages],
    );
  }
  remplacerBase(base.base);
  const config: Record<string, unknown> = {};
  const dep: DependancesAuth = {
    base: base.base,
    config: () => config,
    attributsCookie: () => ({
      cookie_name: "mcpwebui_session",
      same_site: "lax",
      https_only: false,
      max_age: 86400,
    }),
    secret: () => "secret-de-session-de-test",
    jetonService: () => JETON,
    maintenant: () => horloge,
  };
  const arret = new AbortController();
  const relais = creerRelais({
    journal: journalTest.child({ domaine: "sandbox-relay" }),
    arret: arret.signal,
    auth: dep,
    ...options,
  });
  const test: Famille = {
    nom: "test",
    routes: [
      {
        methode: "POST",
        chemin: "/test/connexion/:uid",
        processus: ["main"],
        acces: "public",
        traiter: (requete) => {
          const uid = Number((requete.params as { uid: string }).uid);
          requete.session.set("user_id", uid);
          requete.session.set("_login_ts", horloge);
          requete.session.set("_sid", `sid-${uid}`);
          return { ok: true };
        },
      },
    ],
  };
  const fastify = await creerApp({
    ...app,
    mode: "main",
    journal: journalTest,
    familles: [test, relais.famille, familleJetonApercu],
    gardes: creerGardes(dep),
    avantRoutes: (a) => installerAuth(a, dep),
  });
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const adresse = fastify.server.address();
  const url = `http://127.0.0.1:${typeof adresse === "object" && adresse ? adresse.port : 0}`;
  const dossier = mkdtempSync(join(tmpdir(), "elpis-relais-"));
  const precedent = process.env["APP_MCP_MANIFEST"];
  return {
    app: fastify,
    relais,
    base,
    url,
    arret,
    dep,
    config,
    manifeste(hotes, placement = {}) {
      const chemin = join(dossier, `mcp-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(chemin, JSON.stringify({ mcpServers: {}, sandboxHosts: hotes, placement }), "utf-8");
      process.env["APP_MCP_MANIFEST"] = chemin;
      oublierHotes();
    },
    async connecter(uid) {
      const r = await fetch(`${url}/test/connexion/${uid}`, { method: "POST" });
      return (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    },
    async fermer() {
      await fastify.close();
      await relais.fermer();
      remplacerBase(undefined);
      await base.fermer();
      if (precedent === undefined) delete process.env["APP_MCP_MANIFEST"];
      else process.env["APP_MCP_MANIFEST"] = precedent;
      oublierHotes();
      rmSync(dossier, { recursive: true, force: true });
    },
  };
}

export function attendre(ms: number): Promise<void> {
  return new Promise((fin) => setTimeout(fin, ms));
}

/** Attend qu'une condition devienne vraie (sondage court), échoue au délai. */
export async function attendreQue(condition: () => boolean, delaiMs = 5_000): Promise<void> {
  const fin = Date.now() + delaiMs;
  while (!condition()) {
    if (Date.now() > fin) throw new Error("condition non atteinte dans le délai");
    await attendre(10);
  }
}
