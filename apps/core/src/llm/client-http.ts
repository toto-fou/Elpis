// SPDX-License-Identifier: MIT
/** apps/core/src/llm/client-http.ts — clients HTTP du moteur sur undici : délais et pool comme httpx, TLS explicite, erreurs aux noms de httpx. */
import * as tls from "node:tls";

import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import { CancelledError, estErreurAnnulation, pyJsonDumps, quotePy } from "@elpis/commun";
import { config, parseJsonPy } from "@elpis/config";
import { autoritesTls } from "@elpis/http";

export { autoritesTls, CancelledError, corpsJsonSortant as corpsJson, estErreurAnnulation as estAnnulation };

/** `httpx.HTTPError` : `name` porte le nom de la classe httpx (taxonomie, disjoncteur, `error_type`). */
export class HTTPError extends Error {
  override name = "HTTPError";
}
export class RequestError extends HTTPError {
  override name = "RequestError";
}
export class TransportError extends RequestError {
  override name = "TransportError";
}
export class TimeoutException extends TransportError {
  override name = "TimeoutException";
}
export class ConnectTimeout extends TimeoutException {
  override name = "ConnectTimeout";
}
export class ReadTimeout extends TimeoutException {
  override name = "ReadTimeout";
}
export class WriteTimeout extends TimeoutException {
  override name = "WriteTimeout";
}
export class PoolTimeout extends TimeoutException {
  override name = "PoolTimeout";
}
export class NetworkError extends TransportError {
  override name = "NetworkError";
}
export class ConnectError extends NetworkError {
  override name = "ConnectError";
}
export class ReadError extends NetworkError {
  override name = "ReadError";
}
export class ProtocolError extends TransportError {
  override name = "ProtocolError";
}
export class RemoteProtocolError extends ProtocolError {
  override name = "RemoteProtocolError";
}

/** Requête sur un client fermé : le `RuntimeError` de httpx. */
export class ClientFerme extends Error {
  override name = "RuntimeError";
  constructor(options?: ErrorOptions) {
    super("Cannot send a request, as the client has been closed.", options);
  }
}

/** Corps lu avant d'avoir été demandé (`httpx.ResponseNotRead`). */
export class ResponseNotRead extends Error {
  override name = "ResponseNotRead";
  constructor() {
    super("Attempted to access streaming response content, without having called `read()`.");
  }
}

/** Ce que le constructeur `Headers` accepte. */
export type EntetesInit = ConstructorParameters<typeof Headers>[0];

export interface RequeteHttp {
  readonly method: string;
  readonly url: string;
}

/** Ce que la taxonomie lit d'une réponse : code, en-têtes, texte (qui peut lever s'il n'a pas été lu). */
export interface ReponseLisible {
  readonly statusCode: number;
  readonly headers: Headers;
  readonly request: RequeteHttp;
  readonly reasonPhrase: string;
  readonly text: string;
}

/** `httpx.codes.get_reason_phrase`. */
const LIBELLES: Readonly<Record<number, string>> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Request Entity Too Large",
  414: "Request-URI Too Long",
  415: "Unsupported Media Type",
  416: "Requested Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

export function getReasonPhrase(code: number): string {
  return LIBELLES[code] ?? "";
}

const TYPES_ERREUR: Readonly<Record<number, string>> = {
  1: "Informational response",
  3: "Redirect response",
  4: "Client error",
  5: "Server error",
};

/** `httpx.HTTPStatusError` : la réponse garde code, en-têtes et (si lu) corps. */
export class HTTPStatusError extends HTTPError {
  override name = "HTTPStatusError";
  readonly request: RequeteHttp;
  readonly response: ReponseLisible;

  constructor(message: string, options: { request: RequeteHttp; response: ReponseLisible }) {
    super(message);
    this.request = options.request;
    this.response = options.response;
  }
}

/** `Response.raise_for_status()` de httpx : même message, redirection comprise. */
export function raiseForStatus<R extends ReponseLisible>(r: R): R {
  if (r.statusCode >= 200 && r.statusCode < 300) return r;
  const type = TYPES_ERREUR[Math.trunc(r.statusCode / 100)] ?? "Invalid status code";
  const location = r.headers.get("location");
  const redirection =
    [301, 302, 303, 307, 308].includes(r.statusCode) && location !== null
      ? `Redirect location: '${location}'\n`
      : "";
  const message =
    `${type} '${r.statusCode} ${r.reasonPhrase}' for url '${r.request.url}'\n${redirection}` +
    `For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${r.statusCode}`;
  throw new HTTPStatusError(message, { request: r.request, response: r });
}

/** `.text` de httpx : charset de la réponse (UTF-8 sinon), BOM UTF-8 gardé comme le codec `utf-8` de Python. */
function decoderTexte(contenu: Uint8Array, headers: Headers): string {
  const m = /charset=["']?([^"';\s]+)/i.exec(headers.get("content-type") ?? "");
  let encodage: string;
  try {
    encodage = new TextDecoder(m?.[1] ?? "utf-8").encoding;
  } catch {
    encodage = "utf-8";
  }
  return new TextDecoder(encodage, { ignoreBOM: encodage === "utf-8" }).decode(contenu);
}

/** `json.loads(contenu)` : BOM ignoré, NaN et Infinity acceptés comme en Python. */
function lireJsonPy(contenu: Uint8Array): unknown {
  return parseJsonPy(new TextDecoder("utf-8").decode(contenu));
}

/** Réponse lue en entier (`httpx.Response`). */
export class ReponseHttp implements ReponseLisible {
  readonly statusCode: number;
  readonly headers: Headers;
  readonly request: RequeteHttp;
  readonly reasonPhrase: string;
  readonly content: Uint8Array;
  private texte: string | null = null;

  constructor(champs: {
    statusCode: number;
    request: RequeteHttp;
    content?: Uint8Array;
    text?: string;
    headers?: EntetesInit | null;
    reasonPhrase?: string;
  }) {
    this.statusCode = champs.statusCode;
    this.request = champs.request;
    this.headers = new Headers(champs.headers ?? undefined);
    this.reasonPhrase = champs.reasonPhrase ?? getReasonPhrase(champs.statusCode);
    this.content = champs.content ?? new TextEncoder().encode(champs.text ?? "");
    if (champs.text !== undefined) this.texte = champs.text;
  }

  get text(): string {
    this.texte ??= decoderTexte(this.content, this.headers);
    return this.texte;
  }

  json(): unknown {
    return lireJsonPy(this.content);
  }

  get isSuccess(): boolean {
    return this.statusCode >= 200 && this.statusCode < 300;
  }

  raiseForStatus(): this {
    return raiseForStatus(this);
  }
}

const FINS_DE_LIGNE = /\r\n|\r|\n/;

/** Réponse en flux (`client.stream(...)`) : corps lu à la demande, fermeture = coupure de la connexion. */
export class ReponseFlux implements ReponseLisible {
  readonly statusCode: number;
  readonly headers: Headers;
  readonly request: RequeteHttp;
  readonly reasonPhrase: string;
  private readonly corps: AsyncIterable<Uint8Array> & { destroy(e?: Error): unknown };
  private readonly liberer: () => void;
  private readonly traduire: (e: unknown) => unknown;
  private contenu: Uint8Array | null = null;
  private ferme = false;

  constructor(champs: {
    statusCode: number;
    headers: Headers;
    request: RequeteHttp;
    reasonPhrase: string;
    corps: AsyncIterable<Uint8Array> & { destroy(e?: Error): unknown };
    liberer: () => void;
    traduire: (e: unknown) => unknown;
  }) {
    this.statusCode = champs.statusCode;
    this.headers = champs.headers;
    this.request = champs.request;
    this.reasonPhrase = champs.reasonPhrase;
    this.corps = champs.corps;
    this.liberer = champs.liberer;
    this.traduire = champs.traduire;
  }

  get isClosed(): boolean {
    return this.ferme;
  }

  /** Morceaux bruts ; une erreur de transport est traduite en erreur httpx, la fin libère la connexion. */
  async *aiterBytes(): AsyncGenerator<Uint8Array> {
    if (this.contenu !== null) {
      yield this.contenu;
      return;
    }
    if (this.ferme) throw new Error("Attempted to read or stream content, but the stream has been closed.");
    try {
      for await (const morceau of this.corps) yield morceau;
    } catch (e) {
      if (this.ferme) return;
      throw this.traduire(e);
    } finally {
      await this.aclose();
    }
  }

  /** Lignes du flux selon la norme SSE : `\n`, `\r\n`, `\r` (httpx coupe aussi sur \x0b, \x0c, \x1c-\x1e, U+0085, U+2028, U+2029). */
  async *aiterLines(): AsyncGenerator<string> {
    const decodeur = new TextDecoder("utf-8");
    let reste = "";
    for await (const morceau of this.aiterBytes()) {
      reste += decodeur.decode(morceau, { stream: true });
      const crFinal = reste.endsWith("\r");
      const lignes = (crFinal ? reste.slice(0, -1) : reste).split(FINS_DE_LIGNE);
      reste = (lignes.pop() ?? "") + (crFinal ? "\r" : "");
      yield* lignes;
    }
    reste += decodeur.decode();
    if (reste.endsWith("\r")) yield reste.slice(0, -1);
    else if (reste !== "") yield reste;
  }

  /** `aread()` : lit tout le corps (une fois) ; le texte devient lisible. */
  async aread(): Promise<Uint8Array> {
    if (this.contenu !== null) return this.contenu;
    const morceaux: Uint8Array[] = [];
    for await (const m of this.aiterBytes()) morceaux.push(m);
    this.contenu = Buffer.concat(morceaux);
    return this.contenu;
  }

  get text(): string {
    if (this.contenu === null) throw new ResponseNotRead();
    return decoderTexte(this.contenu, this.headers);
  }

  json(): unknown {
    if (this.contenu === null) throw new ResponseNotRead();
    return lireJsonPy(this.contenu);
  }

  raiseForStatus(): this {
    return raiseForStatus(this);
  }

  /** `aclose()` : un corps non lu jusqu'au bout coupe la connexion (le serveur voit la déconnexion). */
  aclose(): Promise<void> {
    if (!this.ferme) {
      this.ferme = true;
      if (this.contenu === null) this.corps.destroy();
      this.liberer();
    }
    return Promise.resolve();
  }
}

/** `httpx.Timeout` en secondes ; `null` = sans limite. */
export interface Delais {
  readonly connect: number | null;
  readonly read: number | null;
  readonly write: number | null;
  readonly pool: number | null;
}

/** `httpx.Timeout(t, connect=…, read=…)` : les champs absents valent `t`. */
export function delais(t: number | null, autres: Partial<Delais> = {}): Delais {
  return {
    connect: autres.connect !== undefined ? autres.connect : t,
    read: autres.read !== undefined ? autres.read : t,
    write: autres.write !== undefined ? autres.write : t,
    pool: autres.pool !== undefined ? autres.pool : t,
  };
}

function versDelais(t: number | Delais | null): Delais {
  return typeof t === "object" && t !== null ? t : delais(t);
}

/** `httpx.Limits`. */
export interface Limites {
  readonly maxConnections: number | null;
  readonly maxKeepaliveConnections: number | null;
  readonly keepaliveExpiry: number | null;
}

export interface OptionsRequete {
  headers?: Readonly<Record<string, string>> | null;
  json?: unknown;
  params?: Readonly<Record<string, string | number>>;
  /** `undefined` = délais du client ; un nombre = `httpx.Timeout(n)`. */
  timeout?: number | Delais | null;
  signal?: AbortSignal;
}

const contextesTls = new WeakMap<readonly string[], tls.SecureContext>();

/** Contexte TLS d'une liste de CA, construit une fois (et non à chaque connexion). */
function contexteTls(autorites: readonly string[]): tls.SecureContext {
  let ctx = contextesTls.get(autorites);
  if (ctx === undefined) {
    ctx = tls.createSecureContext({ ca: [...autorites] });
    contextesTls.set(autorites, ctx);
  }
  return ctx;
}

/** Encodage `json=` de httpx 0.28 : compact, UTF-8, NaN refusé. */
export function corpsJsonSortant(valeur: unknown): Buffer {
  const texte = pyJsonDumps(valeur, { ensureAscii: false, separators: [",", ":"], allowNan: false });
  if (!texte.isWellFormed())
    throw new ErreurEncodage("'utf-8' codec can't encode character: surrogates not allowed");
  return Buffer.from(texte, "utf-8");
}

export class ErreurEncodage extends Error {
  override name = "UnicodeEncodeError";
}

/** `urlencode` (`quote_plus`) des paramètres, ajoutés à l'URL comme httpx. */
export function avecParametres(
  url: string,
  params: Readonly<Record<string, string | number>> | undefined,
): string {
  if (!params || Object.keys(params).length === 0) return url;
  const requete = Object.entries(params)
    .map(
      ([k, v]) => `${quotePy(k, "").replaceAll("%20", "+")}=${quotePy(String(v), "").replaceAll("%20", "+")}`,
    )
    .join("&");
  return url + (url.includes("?") ? "&" : "?") + requete;
}

/** Échecs de connexion TCP : anyio les résume tous en « All connection attempts failed ». */
const CODES_CONNEXION = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EHOSTDOWN",
]);
/** Échecs de résolution : le `socket.gaierror` de Python. */
const CODES_DNS: Readonly<Record<string, string>> = {
  ENOTFOUND: "[Errno -2] Name or service not known",
  EAI_AGAIN: "[Errno -3] Temporary failure in name resolution",
};

function code(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "";
}

/** Erreur undici → famille et message de httpx (`entetes` : la réponse avait commencé). */
export function traduireErreur(e: unknown, entetes: boolean): unknown {
  if (e instanceof HTTPError || e instanceof CancelledError || e instanceof ClientFerme) return e;
  const c = code(e);
  const sousCode = code((e as { cause?: unknown } | null)?.cause);
  const opts = { cause: e };
  const dns = Object.hasOwn(CODES_DNS, c) ? c : Object.hasOwn(CODES_DNS, sousCode) ? sousCode : "";
  if (c === "UND_ERR_CONNECT_TIMEOUT") return new ConnectTimeout("", opts);
  if (c === "UND_ERR_HEADERS_TIMEOUT" || c === "UND_ERR_BODY_TIMEOUT") return new ReadTimeout("", opts);
  if (dns) return new ConnectError(CODES_DNS[dns] ?? "", opts);
  if (CODES_CONNEXION.has(c) || CODES_CONNEXION.has(sousCode))
    return new ConnectError("All connection attempts failed", opts);
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_|EPROTO/.test(c))
    return new ConnectError(
      `[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: ${e instanceof Error ? e.message : String(e)}`,
      opts,
    );
  if (c === "ECONNRESET" || sousCode === "ECONNRESET") return new ReadError("", opts);
  if (c === "ETIMEDOUT" || sousCode === "ETIMEDOUT")
    return entetes ? new ReadError("", opts) : new ConnectError("All connection attempts failed", opts);
  if (c === "UND_ERR_SOCKET" || c === "UND_ERR_RES_CONTENT_LENGTH_MISMATCH" || c === "ECONNABORTED")
    return new RemoteProtocolError(
      entetes
        ? "peer closed connection without sending complete message body (incomplete chunked read)"
        : "Server disconnected without sending a response.",
      opts,
    );
  if (c === "UND_ERR_DESTROYED" || c === "UND_ERR_CLOSED")
    return entetes ? new ReadError("", opts) : new ClientFerme(opts);
  return e instanceof Error && c.startsWith("UND_ERR") ? new TransportError(e.message, opts) : e;
}

/** Agent utilisateur des requêtes du moteur (httpx envoie le sien ; un pare-feu peut refuser une requête sans). */
export const AGENT_UTILISATEUR = "elpis-core";

function valeurOu(v: number | null | undefined, defaut: number): number | null {
  return v === undefined ? defaut : v;
}

function enMs(s: number | null): number {
  return s === null ? 0 : Math.max(1, Math.round(s * 1000));
}

/** `httpx.AsyncClient` : délais par défaut et par requête, pool borné (attente ≤ `pool`), un agent undici par délai de connexion. */
export class ClientHttp {
  readonly delais: Delais | null;
  readonly limites: Limites;
  private readonly autorites: readonly string[];
  private readonly agents = new Map<number, Agent>();
  private enCours = 0;
  private readonly attente: (() => void)[] = [];
  private ferme = false;

  constructor(
    options: { delais?: Delais | null; limites?: Partial<Limites>; autorites?: readonly string[] } = {},
  ) {
    this.delais = options.delais === undefined ? delais(5) : options.delais;
    this.limites = {
      maxConnections: valeurOu(options.limites?.maxConnections, 100),
      maxKeepaliveConnections: valeurOu(options.limites?.maxKeepaliveConnections, 20),
      keepaliveExpiry: valeurOu(options.limites?.keepaliveExpiry, 5),
    };
    this.autorites = options.autorites ?? autoritesTls();
  }

  get isClosed(): boolean {
    return this.ferme;
  }

  private agent(connect: number | null): Agent {
    const ms = enMs(connect);
    let a = this.agents.get(ms);
    if (a === undefined) {
      const vie = enMs(this.limites.keepaliveExpiry);
      a = new Agent({
        connect: { timeout: ms === 0 ? 2 ** 31 - 1 : ms, secureContext: contexteTls(this.autorites) },
        connections: this.limites.maxConnections,
        keepAliveTimeout: vie,
        keepAliveMaxTimeout: vie,
        allowH2: false,
      });
      this.agents.set(ms, a);
    }
    return a;
  }

  /** Une connexion du pool (`max_connections`), attendue au plus `pool` secondes ; rendue, elle passe au premier en attente. */
  private async prendre(pool: number | null, signal: AbortSignal | undefined): Promise<() => void> {
    const max = this.limites.maxConnections;
    if (max === null || this.enCours < max) this.enCours++;
    else {
      await new Promise<void>((ok, ko) => {
        let minuterie: NodeJS.Timeout | undefined;
        const reveil = (): void => {
          clearTimeout(minuterie);
          signal?.removeEventListener("abort", abandon);
          ok();
        };
        const retirer = (): void => {
          const i = this.attente.indexOf(reveil);
          if (i >= 0) this.attente.splice(i, 1);
        };
        const abandon = (): void => {
          clearTimeout(minuterie);
          retirer();
          ko(new CancelledError("requête annulée en attente d'une connexion", { cause: signal?.reason }));
        };
        if (pool !== null)
          minuterie = setTimeout(() => {
            signal?.removeEventListener("abort", abandon);
            retirer();
            ko(new PoolTimeout(""));
          }, enMs(pool));
        signal?.addEventListener("abort", abandon, { once: true });
        this.attente.push(reveil);
      });
    }
    let rendu = false;
    return () => {
      if (rendu) return;
      rendu = true;
      const suivant = this.attente.shift();
      if (suivant) suivant();
      else this.enCours--;
    };
  }

  /** `client.stream(méthode, url, …)` : la réponse arrive avant le corps ; l'appelant DOIT la fermer (`aclose`), un corps coupé sans lecteur ne lève jamais hors de lui. */
  async stream(methode: string, url: string, options: OptionsRequete = {}): Promise<ReponseFlux> {
    if (this.ferme) throw new ClientFerme();
    const d = options.timeout === undefined ? (this.delais ?? delais(null)) : versDelais(options.timeout);
    const cible = avecParametres(url, options.params);
    const signal = options.signal;
    if (signal?.aborted) throw new CancelledError("requête annulée", { cause: signal.reason });
    const liberer = await this.prendre(d.pool, signal);
    const entetes: Record<string, string> = { accept: "*/*", "user-agent": AGENT_UTILISATEUR };
    let corps: Buffer | undefined;
    if (options.json !== undefined && options.json !== null) {
      try {
        corps = corpsJsonSortant(options.json);
      } catch (e) {
        liberer();
        throw e;
      }
      entetes["content-type"] = "application/json";
    }
    for (const [k, v] of Object.entries(options.headers ?? {})) entetes[k.toLowerCase()] = v;
    let reponse: Dispatcher.ResponseData;
    try {
      reponse = await request(cible, {
        method: methode as Dispatcher.HttpMethod,
        headers: entetes,
        body: corps,
        dispatcher: this.agent(d.connect),
        headersTimeout: enMs(d.read),
        bodyTimeout: enMs(d.read),
        signal,
      });
    } catch (e) {
      liberer();
      if (signal?.aborted) throw new CancelledError("requête annulée", { cause: signal.reason });
      throw traduireErreur(e, false);
    }
    reponse.body.on("error", () => undefined);
    const headers = new Headers();
    for (const [k, v] of Object.entries(reponse.headers)) {
      if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      else if (v !== undefined) headers.set(k, v);
    }
    return new ReponseFlux({
      statusCode: reponse.statusCode,
      headers,
      request: { method: methode, url: cible },
      reasonPhrase: reponse.statusText ?? getReasonPhrase(reponse.statusCode),
      corps: reponse.body,
      liberer,
      traduire: (e) =>
        signal?.aborted
          ? new CancelledError("requête annulée", { cause: signal.reason })
          : traduireErreur(e, true),
    });
  }

  /** `client.request(...)` : corps lu en entier, connexion rendue. */
  async request(methode: string, url: string, options: OptionsRequete = {}): Promise<ReponseHttp> {
    const flux = await this.stream(methode, url, options);
    try {
      const contenu = await flux.aread();
      return new ReponseHttp({
        statusCode: flux.statusCode,
        headers: flux.headers,
        request: flux.request,
        reasonPhrase: flux.reasonPhrase,
        content: contenu,
      });
    } finally {
      await flux.aclose();
    }
  }

  get(url: string, options: OptionsRequete = {}): Promise<ReponseHttp> {
    return this.request("GET", url, options);
  }

  post(url: string, options: OptionsRequete = {}): Promise<ReponseHttp> {
    return this.request("POST", url, options);
  }

  delete(url: string, options: OptionsRequete = {}): Promise<ReponseHttp> {
    return this.request("DELETE", url, options);
  }

  /** `aclose()` comme le pool de httpcore : plus aucune requête, TOUTES les connexions fermées (flux en cours compris). */
  async aclose(): Promise<void> {
    if (this.ferme) return;
    this.ferme = true;
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.allSettled(agents.map((a) => a.destroy()));
  }
}

/** `async with client.stream(...) as resp` : la réponse est fermée quoi qu'il arrive. */
export async function avecFlux<T>(
  client: ClientHttp,
  methode: string,
  url: string,
  options: OptionsRequete,
  fn: (reponse: ReponseFlux) => Promise<T>,
): Promise<T> {
  const reponse = await client.stream(methode, url, options);
  try {
    return await fn(reponse);
  } finally {
    await reponse.aclose();
  }
}

// ── Clients LLM partagés (`_client.py`) ─────────────────────────────────────

const LLAMA_TIMEOUT_SEC = config.LLAMA_TIMEOUT_SEC;
const LLAMA_MAX_CONCURRENCY = config.LLAMA_MAX_CONCURRENCY;

const LIMITES_LLM: Limites = {
  maxKeepaliveConnections: LLAMA_MAX_CONCURRENCY,
  maxConnections: LLAMA_MAX_CONCURRENCY + 2,
  keepaliveExpiry: 300,
};
const DELAIS_LLM = delais(LLAMA_TIMEOUT_SEC, { connect: 15.0 });

export const PREFILL_TPS_FLOOR = 100.0;
export const STREAM_READ_MAX_S = 3600.0;
export const MAX_DEDICATED_CLIENTS = 16;

/** Délais d'UN appel en flux : lecture élargie au pire pré-remplissage plausible de la fenêtre (plafond 1 h). */
export function streamTimeoutForCtx(ctxSize: number | null | undefined): Delais {
  let readS = LLAMA_TIMEOUT_SEC;
  if (ctxSize && ctxSize > 0)
    readS = Math.max(readS, Math.min(STREAM_READ_MAX_S, ctxSize / PREFILL_TPS_FLOOR));
  return delais(LLAMA_TIMEOUT_SEC, { connect: 15.0, read: readS });
}

let clientLlm: ClientHttp | null = null;
const clientsParBase = new Map<string, ClientHttp>();
const fermeturesEnVol = new Set<Promise<void>>();

function nouveauClient(): ClientHttp {
  return new ClientHttp({ delais: DELAIS_LLM, limites: LIMITES_LLM });
}

/** `s.rstrip("/")`. */
export function sansBarresFinales(s: string): string {
  let fin = s.length;
  while (fin > 0 && s.charAt(fin - 1) === "/") fin--;
  return s.slice(0, fin);
}

/** Client partagé du llama-server local, ou client dédié (LRU de 16) d'un fournisseur distant. */
export function getLlmClient(baseUrl?: string | null): ClientHttp {
  if (!baseUrl) {
    if (clientLlm === null || clientLlm.isClosed) clientLlm = nouveauClient();
    return clientLlm;
  }
  const cle = sansBarresFinales(baseUrl.trim());
  let c = clientsParBase.get(cle);
  if (c === undefined || c.isClosed) {
    c = nouveauClient();
    clientsParBase.set(cle, c);
    evictDedicatedClients();
  }
  clientsParBase.delete(cle);
  clientsParBase.set(cle, c);
  return c;
}

/** Ferme (pas seulement oublie) les clients dédiés au-delà de `MAX_DEDICATED_CLIENTS`. */
function evictDedicatedClients(): void {
  while (clientsParBase.size > MAX_DEDICATED_CLIENTS) {
    const [cle, ancien] = clientsParBase.entries().next().value as [string, ClientHttp];
    clientsParBase.delete(cle);
    if (ancien.isClosed) continue;
    const f = ancien.aclose().catch(() => undefined);
    fermeturesEnVol.add(f);
    void f.finally(() => fermeturesEnVol.delete(f));
  }
}

export function dedicatedClientKeys(): string[] {
  return [...clientsParBase.keys()];
}

/** Arrêt du process (lifespan) : ferme le client partagé et les clients dédiés. */
export async function closeLlmClient(): Promise<void> {
  if (clientLlm !== null && !clientLlm.isClosed) await clientLlm.aclose();
  clientLlm = null;
  const dedies = [...clientsParBase.values()];
  clientsParBase.clear();
  await Promise.allSettled([...dedies.map((c) => c.aclose()), ...fermeturesEnVol]);
}
