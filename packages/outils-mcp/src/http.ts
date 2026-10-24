// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/http.ts — service MCP en HTTP : porte d'origine, portée `/mcp|/sse/<famille>`, Bearer, transport HTTP streamable (sessions) et SSE (`/messages/`), comme local_mcp_server.py sous uvicorn. */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

import {
  ErreurJsonPy,
  ErreurLecturePy,
  estDict,
  FlottantPy,
  journalDe,
  lowerPy,
  lstripPy,
  objetNu,
  pyJsonDumps,
  pyJsonLoads,
  pyJsonLoadsOctets,
  rstripPy,
  texteJsonPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { analyserRequete, decouperCible, desechapper } from "@elpis/http";
import { FAMILY_NAMES, originAllowed } from "@elpis/mcp";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";

import type { JetonAcces } from "./contexte";
import type { VerificateurJetons } from "./jetons";
import { VERSION_PROTOCOLE_DEFAUT, VERSIONS_PROTOCOLE } from "./serveur";
import type { ServeurOutils, SessionOutils } from "./serveur";

export const HTTP_MOUNT_PATH = "/mcp";
export const SSE_MOUNT_PATH = "/sse";
export const MESSAGES_PATH = "/messages/";
export const PING_MS = 15_000;
const TERMINEES_MAX = 4096;
/** Tampon d'écriture d'un flux SSE au-delà duquel le client, trop lent, est coupé. */
export const TAMPON_SSE_MAX = 32 * 1024 * 1024;
export const SESSION_INACTIVE_MS = 30 * 60_000;
export const SESSIONS_MAX = 1024;

const DESCRIPTION_401 =
  "Authentication failed. The provided bearer token is invalid, expired, or no longer recognized by the server. " +
  "To resolve: clear authentication tokens in your MCP client and reconnect. " +
  "Your client should automatically re-register and obtain new tokens.";

export interface OptionsServiceHttp {
  readonly serveur: ServeurOutils;
  readonly verificateur?: VerificateurJetons | null;
  /** Montage HTTP streamable (`null` : non servi). */
  readonly http?: string | null;
  /** Montage SSE et chemin des messages (`null` : non servi). */
  readonly sse?: string | null;
  readonly messages?: string;
  /** Porte d'origine sur tous les chemins (service seul) ou sur les montages MCP seulement (hôte d'outils). */
  readonly porteSurTout?: boolean;
  readonly limiteCorps?: number;
  readonly pingMs?: number;
  /** Session HTTP sans flux ouvert ni requête depuis ce délai : terminée à la prochaine ouverture. */
  readonly sessionInactiveMs?: number;
  /** Au-delà, la session la moins récemment active est terminée. */
  readonly sessionsMax?: number;
}

/** Ce que l'appelant sait déjà de la requête : corps lu, client authentifié (pont du core), chemin réécrit. */
export interface OptionsRequete {
  readonly corps?: Buffer;
  readonly jeton?: JetonAcces;
  readonly chemin?: string;
  readonly entetes?: TransformationEntetes;
}

export type TransformationEntetes = (entetes: Record<string, string>) => OutgoingHttpHeaders;

const transformations = new WeakMap<ServerResponse, TransformationEntetes>();

/** `writeHead` avec la transformation d'en-têtes de l'appelant (pont : `no-store`, cookie de session). */
function tete(res: ServerResponse, statut: number, entetes: Record<string, string>): void {
  const t = transformations.get(res);
  res.writeHead(statut, t ? t(entetes) : entetes);
}

/** Première valeur d'un en-tête (Starlette lit la première des doublons). */
function entete(req: IncomingMessage, nom: string): string | undefined {
  const brut = req.rawHeaders;
  for (let i = 0; i + 1 < brut.length; i += 2) if (brut[i]?.toLowerCase() === nom) return brut[i + 1];
  return undefined;
}

function json(
  res: ServerResponse,
  statut: number,
  corps: string,
  entetes: Record<string, string> = {},
): void {
  const octets = Buffer.from(corps, "utf8");
  tete(res, statut, {
    "content-type": "application/json",
    ...entetes,
    "content-length": String(octets.length),
  });
  res.end(octets);
}

/** `Response(texte)` de Starlette : sans type de contenu, sauf `PlainTextResponse` (404 et 405 du routeur). */
function texte(
  res: ServerResponse,
  statut: number,
  corps: string,
  type: string | null = null,
  entetes: Record<string, string> = {},
): void {
  const octets = Buffer.from(corps, "utf8");
  tete(res, statut, {
    ...(type === null ? {} : { "content-type": type }),
    ...entetes,
    "content-length": String(octets.length),
  });
  res.end(octets);
}

/** Méthodes des routes Starlette (HEAD ajouté pour GET) ; une autre → 405 du routeur, avant l'authentification. */
const METHODES_HTTP = ["GET", "POST", "DELETE", "HEAD"];
const METHODES_SSE = ["GET", "HEAD"];

/** `TransportSecurityMiddleware` : un POST doit annoncer `application/json` (sans casse), sinon 400 en texte. */
function typeJsonAnnonce(req: IncomingMessage): boolean {
  const ct = entete(req, "content-type");
  return Boolean(ct) && (ct as string).toLowerCase().startsWith("application/json");
}

/** Erreur JSON-RPC « serveur » du transport Python (`id: "server-error"`). */
function erreurTransport(
  res: ServerResponse,
  statut: number,
  message: string,
  o: { code?: number; session?: string | null; entetes?: Record<string, string> } = {},
): void {
  const corps = JSON.stringify({
    jsonrpc: "2.0",
    id: "server-error",
    error: { code: o.code ?? -32600, message },
  });
  json(res, statut, corps, { ...(o.entetes ?? {}), ...(o.session ? { "mcp-session-id": o.session } : {}) });
}

/** Message JSON-RPC sérialisé dans l'ordre des champs pydantic (réponse : jsonrpc, id, result ; notification : method, params, jsonrpc). */
export function serialiserMessage(m: JSONRPCMessage): string {
  const o = m as Dict;
  let ordonne: Dict;
  if ("id" in o && ("result" in o || "error" in o))
    ordonne = {
      jsonrpc: o["jsonrpc"],
      id: o["id"],
      ...("result" in o ? { result: o["result"] } : { error: o["error"] }),
    };
  else if ("id" in o)
    ordonne = {
      method: o["method"],
      ...("params" in o ? { params: o["params"] } : {}),
      jsonrpc: o["jsonrpc"],
      id: o["id"],
    };
  else
    ordonne = {
      method: o["method"],
      ...("params" in o ? { params: o["params"] } : {}),
      jsonrpc: o["jsonrpc"],
    };
  return JSON.stringify(ordonne);
}

/** Flux d'événements à la sse-starlette : lignes `\r\n`, commentaire `: ping` périodique, client trop lent coupé. */
export class FluxSse {
  private readonly res: ServerResponse;
  private readonly minuterie: ReturnType<typeof setInterval> | null;
  ferme = false;

  constructor(res: ServerResponse, entetes: Record<string, string>, pingMs: number) {
    this.res = res;
    tete(res, 200, { ...entetes, "x-accel-buffering": "no" });
    res.flushHeaders();
    this.minuterie =
      pingMs > 0
        ? setInterval(() => {
            if (!res.writableNeedDrain) this.brut(`: ping - ${horodatagePing()}\r\n\r\n`);
          }, pingMs)
        : null;
    this.minuterie?.unref();
    res.on("close", () => this.fermer());
  }

  private brut(s: string): void {
    if (this.ferme || this.res.destroyed) return;
    this.res.write(s);
    if (this.res.writableLength <= TAMPON_SSE_MAX) return;
    journalDe("outils-mcp").warn("flux SSE coupé : client trop lent (tampon plein)");
    this.res.destroy();
    this.fermer();
  }

  evenement(nom: string, donnees: string): void {
    this.brut(`event: ${nom}\r\ndata: ${donnees}\r\n\r\n`);
  }

  fermer(): void {
    if (this.ferme) return;
    this.ferme = true;
    if (this.minuterie !== null) clearInterval(this.minuterie);
    if (!this.res.destroyed && !this.res.writableEnded) this.res.end();
  }
}

/** `str(datetime.now(timezone.utc))` : `2026-10-09 20:35:05.123456+00:00`. */
function horodatagePing(): string {
  const d = new Date();
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000+00:00`;
}

type Aiguillage = { authInfo?: MessageExtraInfo["authInfo"] };

function infoAuth(jeton: JetonAcces | null): Aiguillage {
  return jeton === null
    ? {}
    : {
        authInfo: {
          token: jeton.token,
          clientId: jeton.client_id,
          scopes: [...jeton.scopes],
          extra: { claims: jeton.claims },
        },
      };
}

/** Transport d'une session HTTP streamable : un flux par requête POST, un flux GET autonome au plus. */
class TransportSessionHttp implements Transport {
  readonly sessionId: string;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  readonly flux = new Map<string, FluxSse>();
  fluxGet: FluxSse | null = null;
  termine = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async start(): Promise<void> {
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const o = message as Dict;
    const reponse = "id" in o && ("result" in o || "error" in o);
    const lie = reponse ? o["id"] : options?.relatedRequestId;
    const cle = lie === undefined || lie === null ? null : String(lie as string | number);
    const cible = cle === null ? this.fluxGet : (this.flux.get(cle) ?? null);
    if (cible !== null && !cible.ferme) cible.evenement("message", serialiserMessage(message));
    if (reponse && cle !== null && cible !== null) {
      cible.fermer();
      this.flux.delete(cle);
    }
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.termine) return;
    this.termine = true;
    for (const f of this.flux.values()) f.fermer();
    this.flux.clear();
    this.fluxGet?.fermer();
    this.fluxGet = null;
    this.onclose?.();
  }
}

/** Transport d'une session SSE : événement `endpoint`, puis messages ; les POST arrivent par `/messages/?session_id=`. */
class TransportSessionSse implements Transport {
  readonly sessionId: string;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly flux: FluxSse;

  constructor(sessionId: string, flux: FluxSse) {
    this.sessionId = sessionId;
    this.flux = flux;
  }

  async start(): Promise<void> {
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.flux.evenement("message", serialiserMessage(message));
    return Promise.resolve();
  }

  /** Message illisible : le serveur Python en fait un journal d'erreur sur le flux. */
  erreurInterne(): void {
    this.flux.evenement(
      "message",
      JSON.stringify({
        method: "notifications/message",
        params: { level: "error", logger: "mcp.server.exception_handler", data: "Internal Server Error" },
        jsonrpc: "2.0",
      }),
    );
  }

  async close(): Promise<void> {
    this.flux.fermer();
    this.onclose?.();
    return Promise.resolve();
  }
}

/** Valeurs JSON ordinaires pour le SDK : flottants marqués et entiers longs rendus en nombres. */
function ordinaire(v: unknown): unknown {
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(ordinaire);
  if (estDict(v)) {
    const copie: Dict = objetNu();
    for (const [k, x] of Object.entries(v)) copie[k] = ordinaire(x);
    return copie;
  }
  return v;
}

/** Message pour le SDK : valeurs ordinaires, sauf les arguments de `tools/call` repris de la lecture « valeurs » (`1.0`, entiers longs gardés). */
function versSdk(brut: unknown, valeurs: () => unknown): unknown {
  const message = ordinaire(brut);
  if (!estDict(brut) || brut["method"] !== "tools/call" || !estDict(message)) return message;
  const copie = message["params"];
  if (!estDict(brut["params"]) || !estDict(copie) || !estDict(brut["params"]["arguments"])) return message;
  const lu = valeurs();
  const params = estDict(lu) ? lu["params"] : null;
  if (estDict(params) && estDict(params["arguments"])) copie["arguments"] = params["arguments"];
  return message;
}

/** Nombre qui perd sa forme à la lecture « corps » : flottant (`1.0`, `1e2`), entier de 16 chiffres ou plus. */
const NOMBRE_A_FORME = /[0-9][.eE]|[0-9]{16}/u;

/** Relecture « valeurs » d'un corps, seulement s'il porte un nombre à forme ; un échec laisse les arguments ordinaires. */
function relireValeurs(octets: Uint8Array): unknown {
  try {
    const texte = texteJsonPy(octets);
    return NOMBRE_A_FORME.test(texte) ? pyJsonLoads(texte) : null;
  } catch (e) {
    journalDe("outils-mcp").debug("arguments relus sans leur forme Python", e);
    return null;
  }
}

/** Texte, clé ou valeur, qui contient une demi-paire de substitution (pydantic la refuse). */
function aDemiPaire(v: unknown): boolean {
  if (typeof v === "string") return !v.isWellFormed();
  if (Array.isArray(v)) return v.some(aDemiPaire);
  if (estDict(v)) return Object.entries(v).some(([k, x]) => !k.isWellFormed() || aDemiPaire(x));
  return false;
}

/** Corps d'un message SSE comme `model_validate_json` : UTF-8 strict sans BOM, pas de demi-paire, nombres sous leur forme Python. */
function messageSse(octets: Uint8Array): unknown {
  const valeurs = pyJsonLoads(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(octets));
  if (aDemiPaire(valeurs)) throw new Error("demi-paire de substitution");
  return versSdk(valeurs, () => valeurs);
}

/** `JSONRPCMessage.model_validate` (forme seulement) : requête, notification, réponse ou erreur. */
function estMessageJsonRpc(v: unknown): v is JSONRPCMessage {
  if (!estDict(v) || v["jsonrpc"] !== "2.0") return false;
  const id = v["id"];
  const idValide = typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
  const params = v["params"];
  if (typeof v["method"] === "string") {
    if (params !== undefined && params !== null && !estDict(params)) return false;
    return !("id" in v) || idValide;
  }
  if (!idValide) return false;
  if ("result" in v) return estDict(v["result"]);
  const e = v["error"];
  return (
    estDict(e) &&
    typeof e["code"] === "number" &&
    Number.isInteger(e["code"]) &&
    typeof e["message"] === "string"
  );
}

const estRequete = (m: JSONRPCMessage): boolean => {
  const o = m as Dict;
  return typeof o["method"] === "string" && "id" in o;
};

interface SessionHttp {
  readonly transport: TransportSessionHttp;
  readonly etat: SessionOutils;
  actif: number;
}

/** Session occupée : requête en cours ou flux GET ouvert. */
function occupee(s: SessionHttp): boolean {
  return s.transport.flux.size > 0 || (s.transport.fluxGet !== null && !s.transport.fluxGet.ferme);
}

/** `session_id` des messages SSE (dernier de la requête) en hexadécimal minuscule ; `null` s'il manque, `""` s'il n'est pas un UUID. */
function idSessionSse(requete: string): string | null {
  const valeurs = analyserRequete(requete).filter(([k]) => k === "session_id");
  const brut = valeurs.length > 0 ? (valeurs[valeurs.length - 1] as [string, string])[1] : null;
  if (brut === null) return null;
  const uuid = brut.replace("urn:", "").replace("uuid:", "");
  const hex = lstripPy(rstripPy(uuid, "{}"), "{}").replaceAll("-", "");
  return /^[0-9a-fA-F]{32}$/u.test(hex) ? hex.toLowerCase() : "";
}

/** Service MCP monté dans un hôte HTTP (hôte d'outils, core) ou appelé directement (pont du core). */
export class ServiceMcpHttp {
  private readonly serveur: ServeurOutils;
  private readonly verificateur: VerificateurJetons | null;
  readonly http: string | null;
  readonly sse: string | null;
  readonly messages: string;
  private readonly porteSurTout: boolean;
  private readonly limiteCorps: number;
  private readonly pingMs: number;
  private readonly inactiveMs: number;
  private readonly sessionsMax: number;
  private readonly sessions = new Map<string, SessionHttp>();
  private readonly terminees = new Set<string>();
  private readonly sessionsSse = new Map<string, TransportSessionSse>();

  constructor(o: OptionsServiceHttp) {
    this.serveur = o.serveur;
    this.verificateur = o.verificateur ?? null;
    this.http = o.http === undefined ? HTTP_MOUNT_PATH : o.http;
    this.sse = o.sse === undefined ? null : o.sse;
    this.messages = o.messages ?? MESSAGES_PATH;
    this.porteSurTout = o.porteSurTout ?? false;
    this.limiteCorps = o.limiteCorps ?? 64 * 1024 * 1024;
    this.pingMs = o.pingMs ?? PING_MS;
    this.inactiveMs = o.sessionInactiveMs ?? SESSION_INACTIVE_MS;
    this.sessionsMax = o.sessionsMax ?? SESSIONS_MAX;
  }

  /** Session HTTP streamable ouverte (ni inconnue ni terminée). */
  aSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Requête `/messages/?session_id=` d'une session SSE ouverte ici, pour un hôte qui sert aussi d'autres services sur ce chemin. */
  aSessionSse(requete: string): boolean {
    const id = idSessionSse(requete);
    return Boolean(id) && this.sessionsSse.has(id as string);
  }

  get nombreSessions(): number {
    return this.sessions.size + this.sessionsSse.size;
  }

  private bases(): string[] {
    return [this.http, this.sse]
      .filter((b): b is string => b !== null)
      .map((b) => b.replace(/\/+$/u, "") || "/");
  }

  private couvre(chemin: string): boolean {
    if (this.porteSurTout) return true;
    const messages = this.messages.replace(/\/+$/u, "");
    return [...this.bases(), messages].some((p) => chemin === p || chemin.startsWith(p + "/"));
  }

  /** Chemins servis : montages, `<montage>/<famille>`, messages SSE. */
  chemins(): string[] {
    const sortie: string[] = [];
    for (const b of this.bases()) sortie.push(b, `${b}/*`);
    if (this.sse !== null)
      sortie.push(this.messages.replace(/\/+$/u, ""), `${this.messages.replace(/\/+$/u, "")}/*`);
    return sortie;
  }

  /** Traite la requête si elle vise le service ; `false` sinon (l'hôte répond). */
  async traiter(req: IncomingMessage, res: ServerResponse, o: OptionsRequete = {}): Promise<boolean> {
    if (o.entetes) transformations.set(res, o.entetes);
    const cible = decouperCible(req.url ?? "/");
    let chemin = o.chemin ?? desechapper(cible.chemin);
    if (this.couvre(chemin) && !originAllowed(entete(req, "origin") ?? null)) {
      json(res, 403, pyJsonDumps({ error: "origine non autorisée" }, { ensureAscii: false }), {
        "content-type": "application/json; charset=utf-8",
      });
      return true;
    }
    let famille: string | null = null;
    for (const base of this.bases()) {
      if (!chemin.startsWith(base + "/")) continue;
      const fam = lowerPy(lstripPy(rstripPy(chemin.slice(base.length + 1), "/"), "/"));
      if (!fam) break;
      if (!FAMILY_NAMES.includes(fam)) {
        json(res, 404, pyJsonDumps({ error: `famille d'outils inconnue : ${fam}` }, { ensureAscii: false }), {
          "content-type": "application/json; charset=utf-8",
        });
        return true;
      }
      chemin = base;
      famille = fam;
      break;
    }
    const messages = this.messages.replace(/\/+$/u, "");
    const route =
      chemin === this.http
        ? "http"
        : chemin === this.sse
          ? "sse"
          : this.sse !== null && chemin.startsWith(messages + "/")
            ? "messages"
            : null;
    if (route === null) return false;
    const permises = route === "http" ? METHODES_HTTP : route === "sse" ? METHODES_SSE : null;
    if (permises !== null && !permises.includes(req.method ?? "GET")) {
      texte(res, 405, "Method Not Allowed", "text/plain; charset=utf-8", { allow: permises.join(", ") });
      return true;
    }
    const jeton = o.jeton ?? (await this.authentifier(req, res));
    if (jeton === false) return true;
    if (route === "http") await this.traiterHttp(req, res, famille, jeton, o.corps, cible.requete);
    else if (route === "sse") this.ouvrirSse(req, res, famille, jeton);
    else await this.posterMessage(req, res, jeton, o.corps, cible.requete);
    return true;
  }

  /** `RequireAuthMiddleware` + `BearerAuthBackend` : jeton d'accès, `null` sans authentification configurée, `false` si refusé (401 écrit). */
  private async authentifier(req: IncomingMessage, res: ServerResponse): Promise<JetonAcces | null | false> {
    if (this.verificateur === null) return null;
    const auth = entete(req, "authorization");
    const jeton = auth && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : null;
    const acces = jeton === null ? null : await this.verificateur.verifier(jeton);
    if (acces !== null) return acces;
    json(res, 401, pyJsonDumps({ error: "invalid_token", error_description: DESCRIPTION_401 }), {
      "www-authenticate": `Bearer error="invalid_token", error_description="${DESCRIPTION_401}"`,
    });
    return false;
  }

  private async lireCorps(req: IncomingMessage, corps: Buffer | undefined): Promise<Buffer> {
    if (corps !== undefined) return corps;
    const morceaux: Buffer[] = [];
    let total = 0;
    for await (const m of req) {
      const b = Buffer.isBuffer(m) ? m : Buffer.from(m as string);
      total += b.length;
      if (total > this.limiteCorps) throw new Error("corps trop volumineux");
      morceaux.push(b);
    }
    return Buffer.concat(morceaux);
  }

  /** Corps JSON à la `json.loads` : message, ou réponse d'erreur déjà écrite. */
  private async decoder(
    req: IncomingMessage,
    res: ServerResponse,
    corps: Buffer | undefined,
    session: string | null,
  ): Promise<JSONRPCMessage | null> {
    let brut: unknown;
    let octets: Buffer;
    try {
      octets = await this.lireCorps(req, corps);
      brut = pyJsonLoadsOctets(octets);
    } catch (e) {
      if (e instanceof ErreurJsonPy)
        erreurTransport(res, 400, `Parse error: ${e.message}`, { code: -32700, session });
      else
        erreurTransport(
          res,
          500,
          `Error handling POST request: ${e instanceof ErreurLecturePy ? e.message : String(e)}`,
          {
            code: -32603,
            session,
          },
        );
      return null;
    }
    const message = versSdk(brut, () => relireValeurs(octets));
    if (!estMessageJsonRpc(message)) {
      erreurTransport(res, 400, "Validation error: invalid JSON-RPC message", { code: -32602, session });
      return null;
    }
    return message;
  }

  /** `StreamableHTTPSessionManager` + `StreamableHTTPServerTransport` (mode avec état, réponses en flux SSE). */
  private async traiterHttp(
    req: IncomingMessage,
    res: ServerResponse,
    famille: string | null,
    jeton: JetonAcces | null,
    corps: Buffer | undefined,
    _requete: string,
  ): Promise<void> {
    const id = entete(req, "mcp-session-id");
    const existante = id === undefined ? undefined : this.sessions.get(id);
    const connue = id === undefined || existante !== undefined || this.terminees.has(id);
    if (connue && req.method === "POST" && !typeJsonAnnonce(req)) {
      texte(res, 400, "Invalid Content-Type header");
      return;
    }
    if (id !== undefined && existante === undefined) {
      if (this.terminees.has(id))
        erreurTransport(res, 404, "Not Found: Session has been terminated", { session: id });
      else
        json(
          res,
          404,
          JSON.stringify({
            jsonrpc: "2.0",
            id: "server-error",
            error: { code: -32600, message: "Session not found" },
          }),
        );
      return;
    }
    if (existante !== undefined && id !== undefined) {
      existante.actif = Date.now();
      this.sessions.delete(id);
      this.sessions.set(id, existante);
    }
    const sid = existante?.transport.sessionId ?? randomUUID().replaceAll("-", "");
    const methode = req.method ?? "GET";
    if (methode === "POST") return this.posterHttp(req, res, famille, jeton, corps, sid, existante ?? null);
    if (methode === "GET") return this.ouvrirGet(req, res, sid, existante ?? null);
    if (methode === "DELETE") {
      if (!this.entetesValides(req, res, sid, existante ?? null)) return;
      await this.terminer(sid);
      json(res, 200, "", { "mcp-session-id": sid });
      return;
    }
    erreurTransport(res, 405, "Method Not Allowed", {
      session: sid,
      entetes: { allow: "GET, POST, DELETE" },
    });
  }

  /** `_validate_request_headers` : session présente (sinon 400), version de protocole connue. */
  private entetesValides(
    req: IncomingMessage,
    res: ServerResponse,
    sid: string,
    session: SessionHttp | null,
  ): boolean {
    if (session === null) {
      erreurTransport(res, 400, "Bad Request: Missing session ID", { session: sid });
      return false;
    }
    const version = entete(req, "mcp-protocol-version") ?? VERSION_PROTOCOLE_DEFAUT;
    if (!VERSIONS_PROTOCOLE.includes(version)) {
      erreurTransport(
        res,
        400,
        `Bad Request: Unsupported protocol version: ${version}. Supported versions: ${VERSIONS_PROTOCOLE.join(", ")}`,
        { session: sid },
      );
      return false;
    }
    return true;
  }

  private async posterHttp(
    req: IncomingMessage,
    res: ServerResponse,
    famille: string | null,
    jeton: JetonAcces | null,
    corps: Buffer | undefined,
    sid: string,
    session: SessionHttp | null,
  ): Promise<void> {
    const types = (entete(req, "accept") ?? "").split(",").map((t) => t.trim());
    if (!(
      types.some((t) => t.startsWith("application/json")) &&
      types.some((t) => t.startsWith("text/event-stream"))
    )) {
      erreurTransport(
        res,
        406,
        "Not Acceptable: Client must accept both application/json and text/event-stream",
        { session: sid },
      );
      return;
    }
    const ct = (entete(req, "content-type") ?? "").split(";")[0] ?? "";
    if (!ct.split(",").some((p) => p.trim() === "application/json")) {
      erreurTransport(res, 415, "Unsupported Media Type: Content-Type must be application/json", {
        session: sid,
      });
      return;
    }
    const message = await this.decoder(req, res, corps, sid);
    if (message === null) return;
    const initialisation = estRequete(message) && (message as Dict)["method"] === "initialize";
    if (!initialisation && !this.entetesValides(req, res, sid, session)) return;
    const s = session ?? (await this.ouvrirSession(sid, famille));
    if (!estRequete(message)) {
      json(res, 202, "", { "mcp-session-id": sid });
      s.transport.onmessage?.(message, infoAuth(jeton));
      return;
    }
    const cle = String((message as Dict)["id"] as string | number);
    const flux = new FluxSse(
      res,
      {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "mcp-session-id": sid,
      },
      this.pingMs,
    );
    s.transport.flux.set(cle, flux);
    res.on("close", () => {
      if (s.transport.flux.get(cle) === flux) s.transport.flux.delete(cle);
    });
    s.transport.onmessage?.(message, infoAuth(jeton));
  }

  private ouvrirGet(
    req: IncomingMessage,
    res: ServerResponse,
    sid: string,
    session: SessionHttp | null,
  ): void {
    const types = (entete(req, "accept") ?? "").split(",").map((t) => t.trim());
    if (!types.some((t) => t.startsWith("text/event-stream"))) {
      erreurTransport(res, 406, "Not Acceptable: Client must accept text/event-stream", { session: sid });
      return;
    }
    if (!this.entetesValides(req, res, sid, session) || session === null) return;
    if (session.transport.fluxGet !== null && !session.transport.fluxGet.ferme) {
      erreurTransport(res, 409, "Conflict: Only one SSE stream is allowed per session", { session: sid });
      return;
    }
    const flux = new FluxSse(
      res,
      {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "mcp-session-id": sid,
      },
      this.pingMs,
    );
    session.transport.fluxGet = flux;
  }

  private async ouvrirSession(sid: string, famille: string | null): Promise<SessionHttp> {
    const transport = new TransportSessionHttp(sid);
    const etat: SessionOutils = { famille, niveau: null };
    const session: SessionHttp = { transport, etat, actif: Date.now() };
    await this.purger();
    this.sessions.set(sid, session);
    await this.serveur.connecter(transport, etat);
    return session;
  }

  /** Sessions inactives terminées, puis les moins récemment actives tant que le plafond est atteint (oisives d'abord). */
  private async purger(): Promise<void> {
    const limite = Date.now() - this.inactiveMs;
    for (const [sid, s] of [...this.sessions]) if (s.actif < limite && !occupee(s)) await this.terminer(sid);
    while (this.sessions.size >= this.sessionsMax) {
      const liste = [...this.sessions];
      const [sid] = liste.find(([, s]) => !occupee(s)) ?? liste[0] ?? [];
      if (sid === undefined) break;
      journalDe("outils-mcp").warn(`plafond de ${this.sessionsMax} sessions MCP : session ${sid} terminée`);
      await this.terminer(sid);
    }
  }

  private async terminer(sid: string): Promise<void> {
    const s = this.sessions.get(sid);
    if (s === undefined) return;
    this.sessions.delete(sid);
    this.terminees.add(sid);
    if (this.terminees.size > TERMINEES_MAX) {
      const premiere = this.terminees.values().next().value;
      if (premiere !== undefined) this.terminees.delete(premiere);
    }
    await s.transport.close();
  }

  /** `connect_sse` : session SSE dont la portée est fixée par ce GET. */
  private ouvrirSse(
    req: IncomingMessage,
    res: ServerResponse,
    famille: string | null,
    _jeton: JetonAcces | null,
  ): void {
    const sid = randomUUID().replaceAll("-", "");
    const flux = new FluxSse(
      res,
      {
        "cache-control": "no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      },
      this.pingMs,
    );
    const transport = new TransportSessionSse(sid, flux);
    this.sessionsSse.set(sid, transport);
    flux.evenement("endpoint", `${encodeURI(this.messages)}?session_id=${sid}`);
    res.on("close", () => {
      this.sessionsSse.delete(sid);
      void transport.close();
    });
    void this.serveur.connecter(transport, { famille, niveau: null }).catch(() => {
      flux.fermer();
    });
  }

  /** `handle_post_message` : `session_id` exigé (UUID), message validé, « Accepted ». */
  private async posterMessage(
    req: IncomingMessage,
    res: ServerResponse,
    jeton: JetonAcces | null,
    corps: Buffer | undefined,
    requete: string,
  ): Promise<void> {
    if (!typeJsonAnnonce(req)) return texte(res, 400, "Invalid Content-Type header");
    const id = idSessionSse(requete);
    if (id === null) return texte(res, 400, "session_id is required");
    if (!id) return texte(res, 400, "Invalid session ID");
    const transport = this.sessionsSse.get(id);
    if (transport === undefined) return texte(res, 404, "Could not find session");
    let message: unknown;
    try {
      message = messageSse(await this.lireCorps(req, corps));
    } catch {
      message = null;
    }
    if (!estMessageJsonRpc(message)) {
      texte(res, 400, "Could not parse message");
      transport.erreurInterne();
      return;
    }
    texte(res, 202, "Accepted");
    transport.onmessage?.(message, infoAuth(jeton));
  }

  /** Routes de l'hôte Fastify : la requête est prise en main avant toute analyse du corps. */
  monter(app: FastifyInstance): void {
    for (const url of this.chemins())
      app.route({
        method: ["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"],
        url,
        onRequest: (req, reply, fini) => {
          reply.hijack();
          void this.traiter(req.raw, reply.raw).then(
            (pris) => {
              if (!pris && !reply.raw.headersSent)
                texte(reply.raw, 404, "Not Found", "text/plain; charset=utf-8");
            },
            (e: unknown) => {
              journalDe("outils-mcp").error("service MCP : requête en échec", e);
              if (!reply.raw.headersSent)
                erreurTransport(reply.raw, 500, "Error handling request", { code: -32603 });
              else reply.raw.destroy();
            },
          );
          fini();
        },
        handler: () => undefined,
      });
  }

  /** Sessions terminées, flux fermés. */
  async fermer(): Promise<void> {
    for (const sid of [...this.sessions.keys()]) await this.terminer(sid);
    for (const t of [...this.sessionsSse.values()]) await t.close();
    this.sessionsSse.clear();
  }
}
