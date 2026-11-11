// SPDX-License-Identifier: MIT
/** apps/core/test/images/faux-moteur.ts — faux moteurs locaux (sd-server, OpenAI images, annotation) : files de réponses par route, corps bruts, HTTP ou HTTPS. */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createServerTls } from "node:https";
import type { AddressInfo, Socket } from "node:net";

export interface RequeteBrute {
  methode: string;
  chemin: string;
  entetes: IncomingMessage["headers"];
  corps: Buffer;
}

/** Réponse scriptée : statut, texte ou octets base64, en-têtes ; `panne` coupe la connexion, `attendreMs` retarde. */
export type ReponseScriptee = {
  statut?: number;
  texte?: string;
  octets?: string;
  entetes?: Record<string, string>;
  panne?: string;
  delai?: boolean;
  attendreMs?: number;
};

export type Gestion = (req: RequeteBrute, rep: ServerResponse) => void | Promise<void>;

export class FauxMoteur {
  readonly requetes: RequeteBrute[] = [];
  private readonly files = new Map<string, ReponseScriptee[]>();
  private readonly gestions = new Map<string, Gestion>();
  private readonly sockets = new Set<Socket>();
  private serveur: Server | null = null;
  private tls = false;
  port = 0;
  /** Appelé à chaque requête reçue, avant la réponse. */
  surRequete: (req: RequeteBrute) => void = () => undefined;

  get url(): string {
    return `${this.tls ? "https" : "http"}://127.0.0.1:${this.port}`;
  }

  static async demarrer(options: { cert?: string; cle?: string } = {}): Promise<FauxMoteur> {
    const m = new FauxMoteur();
    await m.ecouter(options);
    return m;
  }

  /** File de réponses de « MÉTHODE /chemin » (« * » pour le reste) : la dernière se répète. */
  file(cle: string, reponses: readonly ReponseScriptee[]): this {
    this.files.set(cle, [...reponses]);
    return this;
  }

  route(cle: string, g: Gestion): this {
    this.gestions.set(cle, g);
    return this;
  }

  sur(chemin: string): RequeteBrute[] {
    return this.requetes.filter((r) => r.chemin.split("?")[0] === chemin);
  }

  private ecouter(options: { cert?: string; cle?: string }): Promise<void> {
    const traiter = (req: IncomingMessage, rep: ServerResponse): void => void this.servir(req, rep);
    this.tls = options.cert !== undefined;
    this.serveur = this.tls
      ? createServerTls({ cert: options.cert, key: options.cle }, traiter)
      : createServer(traiter);
    this.serveur.on(this.tls ? "secureConnection" : "connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    return new Promise((ok) => {
      this.serveur?.listen(0, "127.0.0.1", () => {
        this.port = (this.serveur?.address() as AddressInfo).port;
        ok();
      });
    });
  }

  private async servir(req: IncomingMessage, rep: ServerResponse): Promise<void> {
    const morceaux: Buffer[] = [];
    for await (const m of req) morceaux.push(m as Buffer);
    const brute: RequeteBrute = {
      methode: req.method ?? "GET",
      chemin: req.url ?? "/",
      entetes: req.headers,
      corps: Buffer.concat(morceaux),
    };
    this.requetes.push(brute);
    this.surRequete(brute);
    const cle = `${brute.methode} ${brute.chemin.split("?")[0]}`;
    const g = this.gestions.get(cle) ?? this.gestions.get("*");
    if (g !== undefined) {
      await g(brute, rep);
      return;
    }
    const file = this.files.get(cle) ?? this.files.get("*");
    if (file === undefined || file.length === 0) {
      rep.writeHead(404, { "content-type": "application/json" });
      rep.end('{"error": "introuvable"}');
      return;
    }
    const r = (file.length > 1 ? file.shift() : file[0]) ?? {};
    if (r.attendreMs) await new Promise((ok) => setTimeout(ok, r.attendreMs));
    if (r.delai) return;
    if (r.panne !== undefined) {
      req.socket.destroy();
      return;
    }
    const contenu =
      r.octets !== undefined ? Buffer.from(r.octets, "base64") : Buffer.from(r.texte ?? "", "utf-8");
    rep.writeHead(r.statut ?? 200, { "content-length": String(contenu.length), ...(r.entetes ?? {}) });
    rep.end(contenu);
  }

  async arreter(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((ok) => this.serveur?.close(() => ok()) ?? ok());
  }
}
