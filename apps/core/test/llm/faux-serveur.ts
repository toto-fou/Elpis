// SPDX-License-Identifier: MIT
/** apps/core/test/llm/faux-serveur.ts — faux serveur HTTP local (llama-server, OpenAI, Anthropic) : routes programmables, SSE, coupures et déconnexions observées. */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface RequeteRecue {
  readonly methode: string;
  readonly chemin: string;
  readonly url: URL;
  readonly entetes: IncomingMessage["headers"];
  readonly corps: string;
  json(): unknown;
}

export type Gestionnaire = (req: RequeteRecue, rep: ServerResponse) => void | Promise<void>;

export function attendre(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}

/** Serveur de test : une route = « MÉTHODE /chemin » (sans la requête), « * » attrape le reste (404 sinon). */
export class FauxServeur {
  readonly requetes: RequeteRecue[] = [];
  /** Requêtes dont le client a coupé la connexion avant la fin de la réponse. */
  deconnexions = 0;
  private readonly routes = new Map<string, Gestionnaire>();
  private readonly sockets = new Set<Socket>();
  private serveur: Server | null = null;
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  static async demarrer(routes: Record<string, Gestionnaire> = {}): Promise<FauxServeur> {
    const s = new FauxServeur();
    for (const [cle, g] of Object.entries(routes)) s.route(cle, g);
    await s.ecouter();
    return s;
  }

  route(cle: string, g: Gestionnaire): this {
    this.routes.set(cle, g);
    return this;
  }

  /** Réponse JSON fixe. */
  json(cle: string, corps: unknown, statut = 200, entetes: Record<string, string> = {}): this {
    return this.route(cle, (_r, rep) => {
      rep.writeHead(statut, { "content-type": "application/json", ...entetes });
      rep.end(JSON.stringify(corps));
    });
  }

  /** Réponse texte fixe. */
  texte(cle: string, corps: string, statut = 200, entetes: Record<string, string> = {}): this {
    return this.route(cle, (_r, rep) => {
      rep.writeHead(statut, { "content-type": "text/plain; charset=utf-8", ...entetes });
      rep.end(corps);
    });
  }

  /** Flux SSE : chaque ligne suivie d'une ligne vide, un délai entre deux ; `ouvert` : jamais fermé par le serveur. */
  sse(
    cle: string,
    lignes: readonly string[],
    options: { delaiMs?: number; ouvert?: boolean; statut?: number } = {},
  ): this {
    return this.route(cle, async (_r, rep) => {
      rep.writeHead(options.statut ?? 200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      rep.flushHeaders();
      for (const ligne of lignes) {
        if (rep.destroyed) return;
        rep.write(`${ligne}\n\n`);
        if (options.delaiMs) await attendre(options.delaiMs);
      }
      if (!options.ouvert) rep.end();
    });
  }

  private ecouter(): Promise<void> {
    this.serveur = createServer((req, rep) => void this.servir(req, rep));
    this.serveur.on("connection", (s: Socket) => {
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
    const corps = Buffer.concat(morceaux).toString("utf-8");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const recue: RequeteRecue = {
      methode: req.method ?? "GET",
      chemin: url.pathname + url.search,
      url,
      entetes: req.headers,
      corps,
      json: () => JSON.parse(corps),
    };
    this.requetes.push(recue);
    rep.on("close", () => {
      if (!rep.writableFinished) this.deconnexions++;
    });
    const g = this.routes.get(`${recue.methode} ${url.pathname}`) ?? this.routes.get("*");
    if (g === undefined) {
      rep.writeHead(404, { "content-type": "application/json" });
      rep.end(JSON.stringify({ error: "introuvable" }));
      return;
    }
    try {
      await g(recue, rep);
    } catch (e) {
      if (!rep.headersSent) rep.writeHead(500);
      rep.end(String(e));
    }
  }

  /** Requêtes reçues sur un chemin (sans la requête d'URL). */
  sur(chemin: string): RequeteRecue[] {
    return this.requetes.filter((r) => r.url.pathname === chemin);
  }

  async arreter(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((ok) => this.serveur?.close(() => ok()) ?? ok());
  }
}

/** Un port local fermé (connexion refusée). */
export async function portFerme(): Promise<number> {
  const s = await FauxServeur.demarrer();
  const p = s.port;
  await s.arreter();
  return p;
}

/** Faux llama-server : `/props`, `/v1/models`, `/slots`, `/metrics`, `/health`, `/tokenize`, `/apply-template`, `/infill`. */
export async function fauxLlama(
  options: { props?: unknown; modeles?: unknown; build?: string } = {},
): Promise<FauxServeur> {
  const s = await FauxServeur.demarrer();
  s.json(
    "GET /props",
    options.props ?? {
      build_info: options.build ?? "b10545-abc",
      default_generation_settings: { n_ctx: 8192 },
      total_slots: 1,
    },
  );
  s.json(
    "GET /v1/models",
    options.modeles ?? { data: [{ id: "golden-model", status: { value: "loaded" } }] },
  );
  s.json("GET /health", { status: "ok" });
  s.json("GET /slots", []);
  s.texte(
    "GET /metrics",
    "llamacpp:n_ctx_total 8192\nllamacpp:kv_cache_tokens 0\nllamacpp:requests_processing 0\n",
  );
  s.route("POST /tokenize", (req, rep) => {
    const corps = req.json() as { content: string };
    rep.writeHead(200, { "content-type": "application/json" });
    rep.end(JSON.stringify({ tokens: Array.from(corps.content).map((_, i) => i) }));
  });
  return s;
}
