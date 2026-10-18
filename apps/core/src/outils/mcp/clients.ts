// SPDX-License-Identifier: MIT
/** apps/core/src/outils/mcp/clients.ts — clients MCP du pool (HTTP streamable, SSE), schémas d'outils pour le LLM, routage des logs et exécution d'un appel rendue en JSON. */
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";

import {
  adresseIpOuNul,
  dansReseau,
  delaiMinuterie,
  ErreurPython,
  estGlobaleIp,
  fixePy,
  hostname as hotePy,
  port as portPy,
  pyJsonDumps,
  reseauPy,
  strPy,
  stripPy,
  urlsplit,
  urlunsplit,
  veritePy,
} from "@elpis/commun";
import { config, parseJsonPy } from "@elpis/config";
import {
  brancherInvalidationPool,
  BUILTIN_SENTINEL,
  codeMessageMcp,
  compilerSchema,
  course,
  DelaiDepasse,
  deConfiance,
  estAnnulation,
  estErreurTransport,
  estNonEnvoyee,
  estSessionPerdue,
  FAMILY_NAMES,
  load as chargerManifeste,
  MCP_HANDSHAKE_TIMEOUT_S,
  McpFileSaturee,
  meilleureErreur,
  PoolMcp,
  raisonAnnulation,
  ROLE_APP,
  ROLE_TOOLHOST,
  sharedId,
} from "@elpis/mcp";
import type { ClientMcp, ConfigMcp, OptionsAppelClient, OutilMcp, SurJournal } from "@elpis/mcp";
import { blockRemoteUrlReason } from "@elpis/securite";
import type { Resolveur } from "@elpis/securite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { CTX } from "../../contexte/config-contexte";
import { journal } from "../../journal";
import { LLAMA_TOOL_PARALLELISM } from "../../llm/constantes";
import { estDict, lire, poser, prefixePy, splitlinesPy } from "../../python";
import type { Dict } from "../../python";
import { ingestTools } from "../categories";
import { installerManifesteMcp } from "../ports";
import { serveurEnProcessus, transportEnProcessus } from "./en-processus";
import { toolTraits } from "../traits";
import { agentEpingle, CODE_REFUS, fetchPar, MESSAGE_REFUS } from "@elpis/http";
import type { VerdictHote } from "@elpis/http";

const log = journal("mcp");

/** Délai d'attente maximal d'une requête du SDK : le Python n'en pose aucun (`read_timeout_seconds=None`). */
const SANS_DELAI_MS = 2_147_483_647;
/** `_TOOL_QUEUE_WAIT_S` : borne de l'attente en file du pool, distincte de l'exécution. */
export const TOOL_QUEUE_WAIT_S = 120.0;
const LIST_TOOLS_MAX_PAGES = 50;
const LIST_TOOLS_MAX = 2000;
const DELAI_FIN_SESSION_MS = 5_000;

/** Refus explicite d'un transport que le core ne joint plus (stdio des comptes, MCP en processus de l'ancien core). */
export class TransportNonPrisEnCharge extends Error {
  override name = "TransportNonPrisEnCharge";
}

// ── Erreurs lisibles ───────────────────────────────────────────────────────

function champ(e: unknown, cle: string): unknown {
  return typeof e === "object" && e !== null ? (e as Record<string, unknown>)[cle] : undefined;
}

/** Statut HTTP porté par une erreur de transport du SDK (`StreamableHTTPError`, `SseError`), sinon `null`. */
function statutHttp(e: unknown): number | null {
  const code = champ(e, "code");
  if (typeof code !== "number" || code <= 0) return null;
  const msg = String(champ(e, "message") ?? "");
  return /^(Streamable HTTP error|SSE error): /.test(msg) ? code : null;
}

const CODE_DANS_MESSAGE =
  /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ETIMEDOUT|EPIPE|UND_ERR_[A-Z_]+)\b/;

/** Code réseau (système ou d'undici) de l'erreur, relevé dans le message d'une erreur SSE ; `profond` suit toute la chaîne des causes, sinon seulement celle d'un `fetch failed`. */
function codeReseau(e: unknown, profond: boolean): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur !== undefined && cur !== null; i++) {
    const code = champ(cur, "code");
    if (typeof code === "string") return code;
    const msg = String(champ(cur, "message") ?? "");
    if (msg.startsWith("SSE error: "))
      return CODE_DANS_MESSAGE.exec(msg)?.[1] ?? (msg.includes(`${MESSAGE_REFUS} : `) ? CODE_REFUS : null);
    if (!profond && !(champ(cur, "name") === "TypeError" && msg === "fetch failed")) return null;
    cur = champ(cur, "cause");
  }
  return null;
}

const CODES_CONNEXION = new Set([
  CODE_REFUS,
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
]);
const CODES_DELAI_CONNEXION = new Set(["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"]);
const CODES_DELAI_LECTURE = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/** Nom httpx équivalent d'une panne réseau (ConnectError, ConnectTimeout, ReadTimeout…), pour des messages identiques au Python. */
function nomHttpx(e: unknown, profond = false): string | null {
  const code = codeReseau(e, profond);
  if (code === null) return null;
  if (CODES_CONNEXION.has(code)) return "ConnectError";
  if (CODES_DELAI_CONNEXION.has(code)) return "ConnectTimeout";
  if (CODES_DELAI_LECTURE.has(code)) return "ReadTimeout";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") return "RemoteProtocolError";
  return null;
}

function messageDe(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "McpError") return codeMessageMcp(e)[1];
    return e.message;
  }
  return strPy(e);
}

/** Les groupes d'erreurs dépliés (`AggregateError`), comme `flatten_exc` sur les ExceptionGroup. */
export function flattenExc(e: unknown): unknown[] {
  const out: unknown[] = [e];
  const sous = champ(e, "errors");
  if (Array.isArray(sous)) for (const s of sous) out.push(...flattenExc(s));
  return out;
}

/** Message actionnable (statut HTTP, serveur injoignable, délai) plutôt qu'une trace de transport. */
export function friendlyMcpError(e: unknown): string {
  for (const x of flattenExc(e)) {
    const statut = statutHttp(x);
    if (statut === 401 || statut === 403)
      return `HTTP ${statut} : jeton refusé ou absent. Vérifiez le mode d'authentification et le jeton.`;
    if (statut === 404) return "HTTP 404 : l'URL ne correspond à aucun endpoint MCP.";
    if (statut === 405)
      return "HTTP 405 : cette URL ne sert pas ce transport (essayez l'autre type, HTTP ou SSE).";
    if (statut !== null) return `HTTP ${statut}.`;
    const nom = nomHttpx(x);
    if (nom === "ConnectError") return "Connexion impossible : serveur injoignable à cette adresse.";
    if (nom === "ConnectTimeout" || nom === "ReadTimeout")
      return "Délai de connexion dépassé : adresse injoignable ou filtrée.";
  }
  let msg = stripPy(messageDe(e) || (e instanceof Error ? e.name : typeof e));
  if (msg.startsWith("MCP HTTP ") && msg.includes(" — ")) msg = msg.slice(msg.indexOf(" — ") + 3);
  if (msg.startsWith("ConnectError")) return "Connexion impossible : serveur injoignable à cette adresse.";
  if (msg.startsWith("ConnectTimeout") || msg.startsWith("ReadTimeout"))
    return "Délai de connexion dépassé : adresse injoignable ou filtrée.";
  return prefixePy(msg, 300);
}

/** Cause d'un échec d'ouverture HTTP streamable, au format du diagnostic Python (`_diagnose`). */
function diagnostic(e: unknown): string {
  const statut =
    statutHttp(e) ?? (typeof champ(e, "code") === "number" ? (champ(e, "code") as number) : null);
  if (statut === 401 || statut === 403) return `HTTP ${statut} : jeton d'authentification refusé ou absent`;
  if (statut === 405)
    return "HTTP 405 : cette URL ne sert pas le transport HTTP streamable (essayez le type SSE)";
  if (statut !== null && statut >= 400) return `HTTP ${statut}`;
  const nom = nomHttpx(e, true);
  if (nom !== null) {
    const cause = champ(e, "cause");
    return `${nom}: ${cause instanceof Error ? cause.message : messageDe(e)}`;
  }
  return "HTTP 200 : négociation MCP échouée";
}

/** URL sans identifiants ni requête, pour les messages et les journaux (un jeton peut s'y cacher). */
export function urlSansSecret(url: string): string {
  try {
    const u = urlsplit(url);
    const netloc = u.netloc.includes("@") ? u.netloc.slice(u.netloc.lastIndexOf("@") + 1) : u.netloc;
    return `${u.scheme ? u.scheme + "://" : ""}${netloc}${u.path}${u.query ? "?…" : ""}`;
  } catch {
    return "(url illisible)";
  }
}

export const ADRESSE_MASQUEE = "(adresse masquée)";

function motifLitteral(texte: string): string {
  return texte.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Message montré aux comptes : l'adresse d'un serveur partagé (URL, sans identifiants, hôte:port, hôte borné) n'y paraît jamais, casse ignorée ; le journal la garde. */
export function masquerAdresse(texte: string, url: unknown): string {
  const brute = typeof url === "string" ? stripPy(url) : "";
  if (!texte || !brute) return texte;
  const formes = new Set([brute, urlSansSecret(brute)]);
  let hote: string | null;
  try {
    const u = urlsplit(brute);
    formes.add(u.netloc.slice(u.netloc.lastIndexOf("@") + 1));
    hote = hotePy(u);
  } catch {
    hote = null;
  }
  const motifs = [...formes]
    .filter((f) => f && f !== "(url illisible)")
    .sort((a, b) => b.length - a.length)
    .map(motifLitteral);
  if (hote) motifs.push(`(?<![\\w.-])${motifLitteral(hote)}(?![\\w-]|\\.\\w)`);
  return motifs.reduce((sortie, motif) => sortie.replace(new RegExp(motif, "giu"), ADRESSE_MASQUEE), texte);
}

// ── Schémas d'outils pour le LLM ───────────────────────────────────────────

const CLES_SOUS_SCHEMA = new Set([
  "items",
  "additionalItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const CLES_DICT_SCHEMAS = new Set([
  "properties",
  "$defs",
  "definitions",
  "patternProperties",
  "dependentSchemas",
]);
const CLES_LISTE_SCHEMAS = new Set(["prefixItems", "anyOf", "oneOf", "allOf"]);

/** Schéma booléen → `{}` partout où un sous-schéma est attendu (sauf `additionalProperties`) : le convertisseur GBNF de llama.cpp les refuse en 400. */
export function sanitizeSchemaForGrammar(node: unknown): unknown {
  if (typeof node === "boolean") return {};
  if (!estDict(node)) return node;
  const out: Dict = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "additionalProperties") poser(out, k, typeof v === "boolean" ? v : sanitizeSchemaForGrammar(v));
    else if (CLES_SOUS_SCHEMA.has(k)) poser(out, k, sanitizeSchemaForGrammar(v));
    else if (CLES_DICT_SCHEMAS.has(k) && estDict(v)) {
      const d: Dict = {};
      for (const [kk, vv] of Object.entries(v)) poser(d, kk, sanitizeSchemaForGrammar(vv));
      poser(out, k, d);
    } else if (CLES_LISTE_SCHEMAS.has(k) && Array.isArray(v)) poser(out, k, v.map(sanitizeSchemaForGrammar));
    else poser(out, k, v);
  }
  return out;
}

/** Outil MCP → entrée `tools[]` OpenAI : schéma normalisé (`type`/`properties` par défaut), description surchargée par `context_config`. */
export function mcpToolToOpenai(tool: unknown): Dict {
  const d: Dict = estDict(tool) ? tool : {};
  const name = Object.hasOwn(d, "name") ? d["name"] : "unknown";
  let description = veritePy(lire(d, "description")) ? lire(d, "description") : "";
  const brut = veritePy(lire(d, "inputSchema")) ? lire(d, "inputSchema") : lire(d, "input_schema");
  let schema: unknown = veritePy(brut) ? brut : {};
  if (!estDict(schema)) schema = {};
  const propre = sanitizeSchemaForGrammar(schema) as Dict;
  if (!Object.hasOwn(propre, "type")) poser(propre, "type", "object");
  if (!Object.hasOwn(propre, "properties")) poser(propre, "properties", {});
  if (veritePy(name) && name !== "unknown") {
    try {
      description = CTX.toolDescription(strPy(name), strPy(description));
    } catch {
      // réglages illisibles : description du serveur
    }
  }
  return { type: "function", function: { name, description, parameters: propre } };
}

// ── Routage des logs MCP vers l'appel qui les a produits ──────────────────────

/** Jeton d'appel pour le routage : `log_token` du run, sinon `call_id`, sinon anonyme. */
export function logCallToken(meta: unknown): string {
  const tok = veritePy(lire(meta, "log_token")) ? lire(meta, "log_token") : lire(meta, "call_id");
  if (veritePy(tok)) return strPy(tok);
  return "_anon_" + randomBytes(6).toString("hex");
}

/** Aiguille chaque notification de log vers son appel : identifiant dans la charge, appel unique, nom d'outil ; sinon jetée. */
export class RouteurJournal {
  private readonly appels = new Map<string, [string, SurJournal | null]>();
  private jetees = 0;

  /** Inscrit l'appel et rend le jeton effectif (anonyme en cas de collision, jamais l'emplacement du voisin). */
  register(token: string, toolName: string, cb: SurJournal | null): string {
    if (this.appels.has(token)) {
      const alt = "_dup_" + randomBytes(6).toString("hex");
      log.warn(
        `[mcp_log_router] jeton d'appel '${token}' déjà enregistré (${this.appels.get(token)?.[0] ?? "?"}) — ` +
          `le nouvel appel '${toolName}' prend un jeton anonyme plutôt que de détourner la sortie du premier.`,
      );
      this.appels.set(alt, [toolName, cb]);
      return alt;
    }
    this.appels.set(token, [toolName, cb]);
    return token;
  }

  unregister(token: string): void {
    this.appels.delete(token);
  }

  /** Identifiant d'appel porté par la notification (charge structurée `extra`, ou `__shell_output__` sérialisé). */
  static callIdOf(params: unknown): string | null {
    let data = lire(params, "data");
    if (estDict(data) && estDict(data["extra"])) {
      const x = data["extra"];
      if (x["kind"] === "shell_output" || x["kind"] === "heartbeat") {
        const cid = veritePy(x["log_token"]) ? x["log_token"] : x["call_id"];
        return veritePy(cid) ? strPy(cid) : null;
      }
    }
    if (estDict(data) && typeof data["msg"] === "string") data = data["msg"];
    if (typeof data !== "string" || !data.includes("__shell_output__")) return null;
    let charge: unknown;
    try {
      charge = parseJsonPy(data);
    } catch {
      return null;
    }
    const inner = estDict(charge) ? charge["__shell_output__"] : null;
    if (!estDict(inner)) return null;
    const cid = veritePy(inner["log_token"]) ? inner["log_token"] : inner["call_id"];
    return veritePy(cid) ? strPy(cid) : null;
  }

  resolve(params: unknown): SurJournal | null {
    const cid = RouteurJournal.callIdOf(params);
    if (cid !== null) {
      const appel = this.appels.get(cid);
      if (appel !== undefined) return appel[1];
      this.jetees++;
      return null;
    }
    const vivants = [...this.appels.values()];
    if (vivants.length === 1) return vivants[0]?.[1] ?? null;
    const loggerNom = lire(params, "logger");
    if (veritePy(loggerNom)) {
      const trouves = vivants.filter(([nom]) => nom === loggerNom);
      if (trouves.length === 1) return trouves[0]?.[1] ?? null;
    }
    this.jetees++;
    if ([1, 10, 100, 1000].includes(this.jetees))
      log.debug(
        `[mcp_wrapper] notification de log non attribuable (${vivants.length} appels en vol, logger=${strPy(loggerNom ?? null)}) — ` +
          `${this.jetees} ignorée(s) au total`,
      );
    return null;
  }
}

// ── Clients réseau ─────────────────────────────────────────────────────────

/** Réponse `tools/list` lue comme le SDK Python : `inputSchema` quelconque (schémas booléens compris), clés inconnues gardées. */
const ListeOutilsPermissive = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string(), inputSchema: z.record(z.string(), z.unknown()) })),
  nextCursor: z.string().nullish(),
});

/** `CallToolResult` du SDK, `structuredContent: null` accepté comme pydantic. */
const ResultatAppelPermissif = CallToolResultSchema.extend({
  structuredContent: z.record(z.string(), z.unknown()).nullish(),
});

/** Validateur de sortie d'un outil, compilé au premier appel : schéma, texte (clé de réutilisation), validateur ou erreur de schéma. */
interface Sortie {
  schema: Dict;
  texte: string;
  compile?: { valider: ReturnType<typeof compilerSchema> } | { erreur: string };
}

interface Transport {
  close(): Promise<void>;
  terminateSession?: () => Promise<void>;
}

/** Client MCP sur un transport réseau (requêtes corrélées) ; l'abandon d'un appel n'envoie aucune annulation au serveur, comme le Python, sauf `annulable` (hôte d'outils intégré : `notifications/cancelled`). */
abstract class ClientMcpReseau implements ClientMcp {
  readonly correle = true;
  readonly url: string;
  readonly headers: Record<string, string> | null;
  readonly annulable: boolean;
  protected client: Client | null = null;
  protected transport: Transport | null = null;
  private readonly routeur = new RouteurJournal();
  private readonly sorties = new Map<string, Sortie>();

  protected readonly fetchGarde: typeof fetch | null;

  constructor(
    url: string,
    headers: Record<string, string> | null = null,
    fetchGarde: typeof fetch | null = null,
    annulable = false,
  ) {
    this.url = url;
    this.headers = headers && Object.keys(headers).length > 0 ? { ...headers } : null;
    this.fetchGarde = fetchGarde;
    this.annulable = annulable;
  }

  /** Options communes des transports : en-têtes, et `fetch` épinglé d'une connexion gardée. */
  protected optionsTransport(): { requestInit?: RequestInit; fetch?: typeof fetch } {
    return { ...initRequete(this.headers), ...(this.fetchGarde === null ? {} : { fetch: this.fetchGarde }) };
  }

  protected abstract ouvrirTransport(): Transport & Parameters<Client["connect"]>[0];

  protected echecOuverture(e: unknown): unknown {
    return e;
  }

  async connecter(signal: AbortSignal): Promise<void> {
    const client = new Client({ name: "mcp", version: "0.1.0" }, { capabilities: {} });
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      const cb = this.routeur.resolve(n.params);
      if (cb === null) return;
      try {
        await cb(n.params as Dict);
      } catch (e) {
        log.error("[mcp_wrapper] log callback raised", e);
      }
    });
    const transport = this.ouvrirTransport();
    this.client = client;
    this.transport = transport;
    try {
      await course(client.connect(transport, { timeout: SANS_DELAI_MS }), signal);
    } catch (e) {
      await this.fermer();
      if (signal.aborted) throw e;
      throw this.echecOuverture(e);
    }
  }

  private exiger(): Client {
    if (this.client === null) throw new Error("Not connected");
    return this.client;
  }

  /** Tous les outils, pages suivies (`nextCursor`), bornés à 50 pages et 2000 outils. */
  async listerOutils(signal: AbortSignal): Promise<OutilMcp[]> {
    const client = this.exiger();
    const page = (cursor?: string): Promise<z.infer<typeof ListeOutilsPermissive>> =>
      course(
        client.request(
          { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
          ListeOutilsPermissive,
          { timeout: SANS_DELAI_MS },
        ),
        signal,
      );
    let res = await page();
    const outils: OutilMcp[] = [...res.tools];
    let curseur = res.nextCursor;
    let pages = 1;
    const vus = new Set<string>();
    while (curseur && !vus.has(curseur) && pages < LIST_TOOLS_MAX_PAGES && outils.length < LIST_TOOLS_MAX) {
      vus.add(curseur);
      res = await page(curseur);
      outils.push(...res.tools);
      curseur = res.nextCursor;
      pages++;
    }
    const liste = outils.slice(0, LIST_TOOLS_MAX);
    for (const t of liste) {
      const nom = String(t["name"]);
      const schema = t["outputSchema"];
      if (!estDict(schema)) {
        this.sorties.delete(nom);
        continue;
      }
      const texte = JSON.stringify(schema);
      if (this.sorties.get(nom)?.texte !== texte) this.sorties.set(nom, { schema, texte });
    }
    return liste;
  }

  /** Appel d'outil : `_meta` transmis tel quel, progression et logs rendus à cet appel ; sortie structurée validée comme le SDK Python. */
  async appelerOutil(nom: string, args: Dict, options: OptionsAppelClient): Promise<unknown> {
    const client = this.exiger();
    const jeton = this.routeur.register(logCallToken(options.meta), nom, options.onLog ?? null);
    try {
      const params: { name: string; arguments: Dict; _meta?: Dict } = { name: nom, arguments: args };
      if (veritePy(options.meta) && options.meta) params._meta = { ...options.meta };
      const progression = options.onProgress;
      const resultat = await course(
        client.request({ method: "tools/call", params }, ResultatAppelPermissif, {
          timeout: SANS_DELAI_MS,
          ...(this.annulable && options.signal ? { signal: options.signal } : {}),
          ...(progression
            ? {
                onprogress: (p: { progress: number; total?: number; message?: string }) => {
                  void Promise.resolve(progression(p)).catch((e: unknown) =>
                    log.error("[mcp_wrapper] progress callback raised", e),
                  );
                },
              }
            : {}),
        }),
        options.signal,
      );
      if (!resultat.isError) this.validerSortie(nom, resultat);
      return resultat;
    } finally {
      this.routeur.unregister(jeton);
    }
  }

  /** `_validate_tool_result` du SDK Python : contenu structuré exigé, validé par le brouillon de `$schema` ; schéma invalide signalé à l'appel. */
  private validerSortie(nom: string, resultat: Dict): void {
    const sortie = this.sorties.get(nom);
    if (sortie === undefined) return;
    const contenu = resultat["structuredContent"];
    if (contenu === undefined || contenu === null)
      throw new Error(`Tool ${nom} has an output schema but did not return structured content`);
    if (sortie.compile === undefined) {
      try {
        sortie.compile = { valider: compilerSchema(sortie.schema) };
      } catch (e) {
        sortie.compile = { erreur: messageDe(e) };
      }
    }
    if ("erreur" in sortie.compile)
      throw new Error(`Invalid schema for tool ${nom}: ${sortie.compile.erreur}`);
    const erreur = meilleureErreur(sortie.compile.valider, sortie.schema, contenu);
    if (erreur !== null)
      throw new Error(`Invalid structured content returned by tool ${nom}: ${erreur.message}`);
  }

  async fermer(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (transport?.terminateSession) {
      try {
        await course(transport.terminateSession(), AbortSignal.timeout(DELAI_FIN_SESSION_MS));
      } catch (e) {
        log.debug(`[MCP] fin de session ignorée : ${messageDe(e)}`);
      }
    }
    try {
      await client?.close();
    } catch (e) {
      log.debug(`[MCP] fermeture partielle ignorée : ${messageDe(e)}`);
    }
  }
}

function initRequete(headers: Record<string, string> | null): { requestInit?: RequestInit } {
  return headers === null ? {} : { requestInit: { headers } };
}

/** Transport « HTTP streamable » (POST /mcp), celui des services d'outils intégrés. */
export class ClientMcpHttp extends ClientMcpReseau {
  protected ouvrirTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(this.url), this.optionsTransport());
  }

  protected override echecOuverture(e: unknown): unknown {
    return new Error(`MCP HTTP ${urlSansSecret(this.url)} — ${diagnostic(e)}`, { cause: e });
  }
}

/** Transport SSE historique (GET /sse + POST de messages) ; une reconnexion silencieuse du flux ferme le client (session perdue). */
export class ClientMcpSse extends ClientMcpReseau {
  protected ouvrirTransport(): SSEClientTransport {
    const transport = new SSEClientTransport(new URL(this.url), this.optionsTransport());
    let ouvert = false;
    transport.onerror = (e: Error) => {
      if (ouvert && e instanceof SseError) void this.fermer();
    };
    const demarrer = transport.start.bind(transport);
    transport.start = async () => {
      await demarrer();
      ouvert = true;
    };
    return transport;
  }
}

/** Familles du compte servies par le serveur MCP de ce process (entrée `inprocess`), sans saut réseau. */
export class ClientMcpEnProcessus extends ClientMcpReseau {
  private readonly cfg: ConfigMcp;

  constructor(cfg: ConfigMcp) {
    super(`inprocess:${strPy(lire(cfg, "name") ?? "elpis-app")}`);
    this.cfg = cfg;
  }

  protected ouvrirTransport(): InMemoryTransport {
    const t = transportEnProcessus(this.cfg);
    if (t === null) throw new TransportNonPrisEnCharge("serveur MCP en processus absent");
    return t;
  }
}

/** Borne d'une famille, entière (`AbortSignal.timeout`) : deux tiers du délai de poignée de main, `null` sans borne. */
export function delaiFamilleMs(poigneeS: number): number | null {
  const d = delaiMinuterie((poigneeS * 2000) / 3);
  return d === null ? null : Math.floor(d);
}

let delaiFamille: number | null = delaiFamilleMs(MCP_HANDSHAKE_TIMEOUT_S);

/** Tests : borne d'une famille imposée (`undefined` : celle du délai de poignée de main). */
export function brancherDelaiFamille(ms: number | null | undefined): void {
  delaiFamille = ms === undefined ? delaiFamilleMs(MCP_HANDSHAKE_TIMEOUT_S) : ms;
}

/** Une famille qui ne répond pas est retirée avant que l'entrée entière n'expire. */
const borneFamille = (signal: AbortSignal): AbortSignal =>
  delaiFamille === null ? signal : AbortSignal.any([signal, AbortSignal.timeout(delaiFamille)]);

/** Panne d'une famille rendue à l'appel : jamais classée panne de transport, l'entrée (les autres familles) reste ouverte. */
export class ErreurFamille extends Error {
  override name = "ErreurFamille";
}

/** Dernier échec signalé par famille d'entrée : un échec répété ne remplit pas le journal. */
const echecsFamille = new Map<string, string>();
const doublonsSignales = new Set<string>();

function raisonFamille(e: unknown): string {
  if (champ(e, "name") === "TimeoutError" && delaiFamille !== null)
    return `pas de réponse en ${fixePy(delaiFamille / 1000, 0)} s`;
  return friendlyMcpError(e);
}

/** Familles tombées, une ligne par cause ; une cause déjà signalée passe en debug. */
function signalerFamilles(entree: string, echecs: readonly (readonly [string, unknown])[]): void {
  const parCause = new Map<string, string[]>();
  for (const [f, e] of echecs) {
    const cause = raisonFamille(e);
    const cle = `${entree}/${f}`;
    if (echecsFamille.get(cle) === cause) {
      log.debug(`[mcp] famille '${f}' de '${entree}' toujours injoignable`);
      continue;
    }
    echecsFamille.set(cle, cause);
    parCause.set(cause, [...(parCause.get(cause) ?? []), f]);
  }
  for (const [cause, familles] of parCause)
    log.warn(
      `[mcp] famille(s) ${familles.join(", ")} de '${entree}' injoignable(s), outils retirés : ${cause}`,
    );
}

function familleRevenue(entree: string, f: string): void {
  if (echecsFamille.delete(`${entree}/${f}`))
    log.info(`[mcp] famille '${f}' de '${entree}' de nouveau servie`);
}

/** Entrée de l'hôte d'outils à plusieurs familles : une connexion par famille (`<montage>/<famille>`), outils fusionnés dans l'ordre canonique ; une famille en panne est rouverte ou retirée seule, sans toucher aux autres. */
export class ClientMcpParFamille implements ClientMcp {
  readonly correle = true;
  readonly nom: string;
  private readonly familles: readonly (readonly [string, ClientMcp])[];
  private readonly rejouable: (outil: string) => boolean;
  private readonly ouvertes = new Set<string>();
  /** Familles tombées à la connexion : pas retentées par le listage qui la suit, seulement au rafraîchissement. */
  private readonly differees = new Set<string>();
  private readonly route = new Map<string, string>();
  private readonly reouvertures = new Map<string, Promise<boolean>>();
  private manquantes = false;
  private ferme = false;

  constructor(
    nom: string,
    familles: readonly (readonly [string, ClientMcp])[],
    rejouable: (outil: string) => boolean,
  ) {
    this.nom = nom;
    this.familles = familles;
    this.rejouable = rejouable;
  }

  /** Une famille au moins manque à la dernière liste : le pool la reliste sans attendre le TTL. */
  incomplet(): boolean {
    return this.manquantes;
  }

  /** Familles jointes ; échec seulement si aucune ne l'est (l'entrée entière est alors en panne). */
  async connecter(signal: AbortSignal): Promise<void> {
    const res = await Promise.allSettled(this.familles.map(([, c]) => c.connecter(borneFamille(signal))));
    if (signal.aborted) {
      await this.fermer();
      throw raisonAnnulation(signal);
    }
    const echecs: [string, unknown][] = [];
    res.forEach((r, i) => {
      const [f] = this.familles[i] ?? [""];
      if (r.status === "fulfilled") this.ouvertes.add(f);
      else {
        echecs.push([f, r.reason]);
        this.differees.add(f);
      }
    });
    if (this.ouvertes.size === 0 && echecs[0]) throw echecs[0][1];
    signalerFamilles(this.nom, echecs);
  }

  /** Outils de chaque famille (une famille tombée est rouverte une fois), concaténés dans l'ordre canonique. */
  async listerOutils(signal: AbortSignal): Promise<OutilMcp[]> {
    const res = await Promise.allSettled(
      this.familles.map(([f, c]) =>
        this.differees.has(f) ? Promise.resolve(null) : this.listerFamille(f, c, signal),
      ),
    );
    const differees = this.differees.size;
    this.differees.clear();
    if (signal.aborted) throw raisonAnnulation(signal);
    if (!res.some((r) => r.status === "fulfilled" && r.value !== null)) {
      const premier = res.find((r) => r.status === "rejected");
      throw premier ? premier.reason : new Error(`aucune famille de '${this.nom}' joignable`);
    }
    const outils: OutilMcp[] = [];
    const echecs: [string, unknown][] = [];
    this.route.clear();
    res.forEach((r, i) => {
      const f = this.familles[i]?.[0];
      if (f === undefined) return;
      if (r.status === "rejected") {
        echecs.push([f, r.reason]);
        return;
      }
      if (r.value === null) return;
      familleRevenue(this.nom, f);
      for (const t of r.value) {
        const nom = String(t["name"]);
        if (this.route.has(nom)) {
          const cle = `${this.nom}/${nom}`;
          if (!doublonsSignales.has(cle))
            log.warn(
              `[mcp] outil '${nom}' servi par deux familles de '${this.nom}' : celui de '${f}' ignoré`,
            );
          doublonsSignales.add(cle);
          continue;
        }
        this.route.set(nom, f);
        outils.push(t);
      }
    });
    signalerFamilles(this.nom, echecs);
    this.manquantes = echecs.length > 0 || differees > 0;
    return outils.slice(0, LIST_TOOLS_MAX);
  }

  /** Outils d'une famille ; rouverte une fois si sa session est perdue, fermée si elle reste en échec (jamais sur un abandon de l'appelant). */
  private async listerFamille(f: string, c: ClientMcp, exterieur: AbortSignal): Promise<OutilMcp[]> {
    const signal = borneFamille(exterieur);
    try {
      if (this.ouvertes.has(f)) {
        try {
          return await c.listerOutils(signal);
        } catch (e) {
          if (signal.aborted) throw e;
          this.ouvertes.delete(f);
          await c.fermer();
        }
      }
      await this.ouvrir(f, c, signal);
      return await c.listerOutils(signal);
    } catch (e) {
      if (!exterieur.aborted) {
        this.ouvertes.delete(f);
        await c.fermer();
      }
      throw e;
    }
  }

  /** Connexion d'une famille ; refermée aussitôt si l'entrée a été fermée entre-temps. */
  private async ouvrir(f: string, c: ClientMcp, signal: AbortSignal): Promise<void> {
    await c.connecter(signal);
    if (this.ferme) {
      await c.fermer();
      throw new ErreurFamille(`entrée '${this.nom}' fermée`);
    }
    this.ouvertes.add(f);
  }

  /** Réouverture d'une seule famille, partagée par les appels qui la demandent en même temps ; vrai si elle répond. */
  private reouvrir(f: string): Promise<boolean> {
    const enCours = this.reouvertures.get(f);
    if (enCours !== undefined) return enCours;
    const c = this.familles.find(([x]) => x === f)?.[1];
    const reouverture = (async (): Promise<boolean> => {
      if (c === undefined || this.ferme) return false;
      this.ouvertes.delete(f);
      await c.fermer();
      try {
        await this.ouvrir(f, c, borneFamille(new AbortController().signal));
        familleRevenue(this.nom, f);
        return true;
      } catch (e) {
        signalerFamilles(this.nom, [[f, e]]);
        this.manquantes = true;
        return false;
      }
    })().finally(() => this.reouvertures.delete(f));
    this.reouvertures.set(f, reouverture);
    return reouverture;
  }

  /** Appel routé vers la connexion de sa famille ; une coupure rouvre cette famille seule, rejoue si la requête n'est pas partie ou si l'outil le permet, sinon rend une erreur de famille. */
  async appelerOutil(nom: string, args: Dict, options: OptionsAppelClient): Promise<unknown> {
    const f = this.route.get(nom);
    const c = this.familles.find(([x]) => x === f)?.[1];
    if (f === undefined || c === undefined) {
      const absentes = this.familles.map(([x]) => x).filter((x) => !this.ouvertes.has(x));
      throw new ErreurFamille(
        absentes.length > 0
          ? `Outil '${nom}' indisponible : famille(s) ${absentes.join(", ")} de '${this.nom}' injoignable(s).`
          : `Unknown tool: '${nom}'`,
      );
    }
    const indisponible = (): ErreurFamille =>
      new ErreurFamille(`Outil '${nom}' indisponible : famille '${f}' de '${this.nom}' injoignable.`);
    if (!this.ouvertes.has(f) && !(await this.reouvrir(f))) throw indisponible();
    try {
      return await c.appelerOutil(nom, args, options);
    } catch (e) {
      if (options.signal?.aborted || !estErreurTransport(e)) throw e;
      const nonPartie = estSessionPerdue(e) || estNonEnvoyee(e);
      log.warn(
        `[mcp] '${nom}' : connexion à la famille '${f}' de '${this.nom}' coupée (${messageDe(e)}) — réouverture de cette famille seule`,
      );
      if (!(await this.reouvrir(f))) throw indisponible();
      if (!nonPartie && !this.rejouable(nom))
        throw new ErreurFamille(
          `Outil '${nom}' : connexion à la famille '${f}' coupée pendant l'appel (${friendlyMcpError(e)}) — ` +
            "non rejoué, l'effet a peut-être déjà été appliqué.",
        );
      try {
        return await c.appelerOutil(nom, args, options);
      } catch (e2) {
        if (options.signal?.aborted || !estErreurTransport(e2)) throw e2;
        this.ouvertes.delete(f);
        throw new ErreurFamille(
          `Outil '${nom}' : famille '${f}' de '${this.nom}' injoignable (${friendlyMcpError(e2)}).`,
        );
      }
    }
  }

  async fermer(): Promise<void> {
    this.ferme = true;
    this.ouvertes.clear();
    this.route.clear();
    await Promise.all(this.familles.map(([, c]) => c.fermer()));
  }
}

/** URL racine d'un montage (`…/mcp`, `…/sse`), à laquelle une famille s'ajoute en dernier segment. */
function urlFamille(url: string, famille: string): string | null {
  let u: ReturnType<typeof urlsplit>;
  try {
    u = urlsplit(url);
  } catch {
    return null;
  }
  const chemin = u.path.replace(/\/+$/, "");
  const dernier = chemin.slice(chemin.lastIndexOf("/") + 1);
  if (dernier !== "mcp" && dernier !== "sse") return null;
  return urlunsplit({ ...u, path: `${chemin}/${famille}` });
}

// ── Résolution d'une config en client ────────────────────────────────────────

/** En-têtes de transport : `headers` (dict, paires ou texte « K: v »), puis `authorization` brut, puis `basic_auth`. */
export function buildAuthHeaders(cfg: ConfigMcp): Record<string, string> {
  const out: Record<string, string> = {};
  let brut = lire(cfg, "headers");
  if (Array.isArray(brut)) {
    const d = new Map<unknown, unknown>();
    for (const p of brut) if (estDict(p) && veritePy(p["name"])) d.set(p["name"], p["value"]);
    brut = Object.fromEntries([...d].filter(([k]) => typeof k === "string"));
  }
  if (estDict(brut)) {
    for (const [k, v] of Object.entries(brut)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
      const sv = stripPy(strPy(v));
      if (sv) poser(out, k, sv);
    }
  } else if (typeof brut === "string") {
    for (const ligneBrute of splitlinesPy(brut)) {
      const ligne = stripPy(ligneBrute);
      if (!ligne || !ligne.includes(":")) continue;
      const i = ligne.indexOf(":");
      poser(out, stripPy(ligne.slice(0, i)), stripPy(ligne.slice(i + 1)));
    }
  }
  const auth = texteNet(lire(cfg, "authorization"));
  if (auth) out["Authorization"] = auth;
  const basic = lire(cfg, "basic_auth");
  if (estDict(basic)) {
    const u = texteNet(basic["username"]);
    const p = texteNet(veritePy(basic["password"]) ? basic["password"] : basic["token"]);
    if (u && p) out["Authorization"] = `Basic ${Buffer.from(`${u}:${p}`, "utf8").toString("base64")}`;
  }
  return out;
}

/** `(v or "").strip()` : une valeur vraie qui n'est pas un texte lève comme Python (config corrompue, pas un en-tête deviné). */
function texteNet(v: unknown): string {
  if (!veritePy(v)) return "";
  if (typeof v === "string") return stripPy(v);
  const type =
    typeof v === "boolean"
      ? "bool"
      : typeof v === "number"
        ? Number.isInteger(v)
          ? "int"
          : "float"
        : Array.isArray(v)
          ? "list"
          : "dict";
  throw new ErreurPython("AttributeError", `'${type}' object has no attribute 'strip'`);
}

function decoderPourcent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** URL sans identifiants (fetch les refuse) et l'en-tête Basic qu'httpx en tire ; l'identifiant de l'URL prime sur un Authorization configuré. */
function separerIdentifiants(url: string, headers: Record<string, string>): [string, Record<string, string>] {
  let u: ReturnType<typeof urlsplit>;
  try {
    u = urlsplit(url);
  } catch {
    return [url, headers];
  }
  const at = u.netloc.lastIndexOf("@");
  if (at < 0) return [url, headers];
  const info = u.netloc.slice(0, at);
  const sep = info.indexOf(":");
  const user = decoderPourcent(sep < 0 ? info : info.slice(0, sep));
  const pass = sep < 0 ? "" : decoderPourcent(info.slice(sep + 1));
  const propre = urlunsplit({ ...u, netloc: u.netloc.slice(at + 1) });
  if (!user && !pass) return [propre, headers];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== "authorization") poser(out, k, v);
  out["Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
  return [propre, out];
}

const NOM_ENTETE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

let resolutionGardee: Resolveur | null = null;
let agentGarde: ReturnType<typeof agentEpingle> | null = null;

async function resoudreSysteme(hote: string): Promise<string[]> {
  return (await lookup(hote, { all: true, order: "verbatim" })).map((r) => r.address);
}

const NAT64 = reseauPy("64:ff9b::/96");

/** Adresse du préfixe NAT64 bien connu dont l'IPv4 traduite n'est pas globale. */
function nat64NonGlobale(brute: string): boolean {
  const ip = adresseIpOuNul(brute);
  if (ip === null || NAT64 === null || !dansReseau(ip, NAT64)) return false;
  return !estGlobaleIp({ version: 4, valeur: ip.valeur & 0xffffffffn, zone: null });
}

/** Règle de `personalUrlBlockReason` (garde stricte) rejouée à chaque connexion : adresses globales seules (IPv4 traduite par NAT64 comprise), celles de cette résolution. */
async function jugerStrict(hote: string, port: number): Promise<VerdictHote> {
  let vues: string[] = [];
  const motif = await blockRemoteUrlReason(`http://${hote.includes(":") ? `[${hote}]` : hote}:${port}/`, {
    allowSchemes: ["http"],
    resoudre: async (h, p) => (vues = await (resolutionGardee ?? resoudreSysteme)(h, p)),
  });
  if (motif !== null) return { motif, adresses: [] };
  const adresses = adresseIpOuNul(hote) !== null ? [hote] : vues.filter((a) => adresseIpOuNul(a) !== null);
  const traduite = adresses.find(nat64NonGlobale);
  if (traduite !== undefined) return { motif: `resolves_to_blocked (${traduite})`, adresses: [] };
  return { motif: null, adresses };
}

/** `fetch` des configs qui ne sont pas de confiance : chaque connexion jugée, jointe aux seules adresses validées. */
function fetchGarde(): typeof fetch {
  agentGarde ??= agentEpingle(jugerStrict);
  return fetchPar(agentGarde);
}

/** Tests : résolution DNS du juge des connexions gardées (`null` : celle du système) ; l'agent est recréé. */
export function brancherResolutionGardee(r: Resolveur | null): void {
  resolutionGardee = r;
  void agentGarde?.close().catch(() => undefined);
  agentGarde = null;
}

/** Client réseau ; un en-tête que fetch refuserait lève ici, sans jamais citer sa valeur (souvent un secret). */
function clientPour(
  type: string,
  url: string,
  headers: Record<string, string> | null,
  nom: string,
  garde = false,
  annulable = false,
): ClientMcp {
  const [propre, h] = separerIdentifiants(url, headers ?? {});
  for (const [k, v] of Object.entries(h))
    if (!NOM_ENTETE.test(k) || /[\0\r\n]/.test(v))
      throw new Error(
        `En-tête « ${prefixePy(k, 64)} » du serveur MCP « ${nom || "?"} » invalide (nom ou valeur non transmissible).`,
      );
  const final = Object.keys(h).length > 0 ? h : null;
  const f = garde ? fetchGarde() : null;
  return type === "sse"
    ? new ClientMcpSse(propre, final, f, annulable)
    : new ClientMcpHttp(propre, final, f, annulable);
}

/** Config de pool → client réseau, épinglé sous la garde stricte sauf config de confiance ; `null` si inexploitable ; stdio des comptes et MCP en processus refusés explicitement. */
export function resoudreClientMcp(cfg: ConfigMcp): ClientMcp | null {
  const ctype = Object.hasOwn(cfg, "type") ? cfg["type"] : "sse";
  const nom = strPy(lire(cfg, "name") ?? "");
  if (ctype === "stdio") {
    if ((Object.hasOwn(cfg, "command") ? cfg["command"] : "") === BUILTIN_SENTINEL) return clientIntegre(cfg);
    const message =
      `Serveur MCP « ${nom || "?"} » de type stdio (commande lancée sur le serveur) : non pris en charge par le core ` +
      "(plus aucun sous-processus) — publiez-le en HTTP streamable ou SSE.";
    log.warn(message);
    throw new TransportNonPrisEnCharge(message);
  }
  if (ctype === "inprocess") {
    if (serveurEnProcessus() !== null) return new ClientMcpEnProcessus(cfg);
    const message =
      `Entrée MCP « ${nom || "?"} » servie en processus : aucun serveur MCP dans ce process (seul main sert les ` +
      "familles du compte).";
    log.warn(message);
    throw new TransportNonPrisEnCharge(message);
  }
  if (ctype === "sse" || ctype === "http" || ctype === "streamable-http") {
    const url = lire(cfg, "url");
    if (!veritePy(url)) return null;
    return clientPour(
      ctype === "sse" ? "sse" : "http",
      strPy(url),
      buildAuthHeaders(cfg),
      nom,
      !deConfiance(cfg),
    );
  }
  return null;
}

/** Service d'outils intégré : entrée nommée (toolhost ou app réseau) du manifeste, sinon l'entrée toolhost par défaut. */
function clientIntegre(cfg: ConfigMcp): ClientMcp | null {
  let entree;
  try {
    const m = chargerManifeste();
    const nom = stripPy(strPy(veritePy(lire(cfg, "manifest")) ? lire(cfg, "manifest") : ""));
    entree = nom ? m.get(nom) : null;
    if (entree === null || (entree.role !== ROLE_TOOLHOST && entree.role !== ROLE_APP)) {
      if (nom)
        log.warn(`[mcp] entrée '${nom}' absente du manifeste — repli sur l'entrée toolhost par défaut`);
      entree = m.toolhost();
    }
  } catch (e) {
    log.error("[mcp] manifeste illisible : outils intégrés indisponibles", e);
    return null;
  }
  const url = stripPy(entree !== null && entree.isNetwork ? entree.url : "");
  if (!url || entree === null) {
    log.error(
      "[mcp] aucun service d'outils joignable déclaré (mcp.json ou LOCAL_MCP_URL) : lancer l'hôte d'outils (./elpis start)",
    );
    return null;
  }
  const type = url.replace(/\/+$/, "").endsWith("/mcp") || entree.type === "http" ? "http" : "sse";
  const hote = entree.role === ROLE_TOOLHOST;
  const familles = hote ? FAMILY_NAMES.filter((f) => entree.families.includes(f)) : [];
  const urls = familles.map((f) => [f, urlFamille(url, f)] as const);
  if (urls.length > 1 && urls.every(([, u]) => u !== null)) {
    const nom = entree.name;
    return new ClientMcpParFamille(
      nom,
      urls.map(([f, u]) => [f, clientPour(type, u ?? "", { ...entree.headers }, nom, false, hote)] as const),
      (outil) => toolTraits(outil).replaySafe,
    );
  }
  return clientPour(type, url, { ...entree.headers }, entree.name, false, hote);
}

/** Le port de `url` écoute-t-il ? (connexion TCP brève, sans requête HTTP). */
export function serviceJoignable(url: string, delaiMs = 500): Promise<boolean> {
  let hote: string;
  let port: number;
  try {
    const u = urlsplit(url);
    hote = hotePy(u) ?? "127.0.0.1";
    port = portPy(u) ?? (u.scheme === "https" ? 443 : 80);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const s = connect({ host: hote.replace(/^\[|\]$/g, ""), port, timeout: delaiMs });
    const fin = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => fin(true));
    s.once("timeout", () => fin(false));
    s.once("error", () => fin(false));
  });
}

// ── Pool unique du process ─────────────────────────────────────────────────

/** Le pool MCP du process : rejeu décidé par les traits d'outil, registre des catégories alimenté par les services intégrés. */
export const poolMcp = new PoolMcp({
  rejouable: (nom) => toolTraits(nom).replaySafe,
  surConnexionIntegree: (outils, cle) => {
    ingestTools(outils, cle);
  },
  parallelisme: () => LLAMA_TOOL_PARALLELISM,
  ttlOutilsS: () => config.TOOLS_CACHE_TTL_SEC,
});

/** Branche le manifeste `mcp.json` dans le registre des catégories (démarrage du core). */
export function brancherOutilsMcp(): void {
  installerManifesteMcp({ defaultOnCategories: () => chargerManifeste().defaultOnCategories() });
}

let desabonnerPool: (() => void) | null = null;

/** Pool du process abonné une seule fois aux invalidations (réglages d'un compte, bibliothèque partagée, manifeste). */
export function brancherInvalidationOutils(): void {
  desabonnerPool ??= brancherInvalidationPool(poolMcp);
}

// ── Exécution d'un appel MCP rendue en JSON (jamais levée vers la boucle) ────

/** Message utile pour le modèle : groupes dépliés, feuilles dédupliquées, borné. */
export function flattenExceptionMessage(e: unknown, limit = 300): string {
  const feuilles: string[] = [];
  const parcourir = (x: unknown, profondeur: number): void => {
    const sous = champ(x, "errors");
    if (Array.isArray(sous) && sous.length > 0 && profondeur < 5) {
      for (const s of sous) parcourir(s, profondeur + 1);
      return;
    }
    const m = stripPy(messageDe(x));
    feuilles.push(m || (x instanceof Error ? x.name : typeof x));
  };
  parcourir(e, 0);
  const texte = [...new Set(feuilles)].join(" | ") || (e instanceof Error ? e.name : typeof e);
  return prefixePy(texte, limit);
}

const logOutils = journal("tools");

/** Enveloppe d'erreur `timeout` : l'attente est abandonnée, l'outil peut encore s'exécuter côté serveur. */
export function toolTimeoutJson(toolName: string, timeoutS: number): string {
  logOutils.warn(`'${toolName}' sans réponse après ${fixePy(timeoutS, 0)}s — appel annulé (timeout)`);
  return pyJsonDumps(
    {
      ok: false,
      error: "timeout",
      message:
        `L'outil '${toolName}' n'a pas répondu en ${Math.trunc(timeoutS)}s — ` +
        "attente abandonnée ; il peut encore s'exécuter côté serveur.",
      fix:
        "Vérifie l'état (fichier, dépôt, processus) avant de relancer ; " +
        "puis relance une action plus ciblée/rapide, ou découpe le " +
        "travail en étapes plus petites.",
    },
    { ensureAscii: false },
  );
}

/** Rendu texte d'un bloc non textuel : ressource texte, repère court pour un binaire (jamais la charge base64), lien. */
export function contentBlockText(item: unknown): string {
  const type = strPy(lire(item, "type") ?? "");
  const nomType =
    {
      text: "TextContent",
      image: "ImageContent",
      audio: "AudioContent",
      resource: "EmbeddedResource",
      resource_link: "ResourceLink",
    }[type] ?? "dict";
  const res = lire(item, "resource");
  if (res !== undefined && res !== null) {
    const uri = strPy(veritePy(lire(res, "uri")) ? lire(res, "uri") : "");
    const txt = lire(res, "text");
    if (typeof txt === "string") return uri ? `[resource ${uri}]\n${txt}` : txt;
    const blob = strPy(veritePy(lire(res, "blob")) ? lire(res, "blob") : "");
    const mime = strPy(veritePy(lire(res, "mimeType")) ? lire(res, "mimeType") : "application/octet-stream");
    return `[binary resource ${uri} (${mime}, ~${Math.floor(Math.floor((blob.length * 3) / 4) / 1024)} KB) — not shown]`;
  }
  const data = lire(item, "data");
  if (typeof data === "string") {
    const mime = strPy(veritePy(lire(item, "mimeType")) ? lire(item, "mimeType") : "?");
    const genre = nomType.startsWith("Image") ? "image" : nomType.startsWith("Audio") ? "audio" : "binary";
    return `[${genre} ${mime}, ~${Math.floor(Math.floor((data.length * 3) / 4) / 1024)} KB — not shown]`;
  }
  const uri = lire(item, "uri");
  if (veritePy(uri)) return `[resource link: ${strPy(uri)}]`;
  return `[non-text content block: ${nomType}]`;
}

function jsonOuNul(texte: string): unknown {
  try {
    return parseJsonPy(texte);
  } catch {
    return null;
  }
}

function aTexte(item: unknown): boolean {
  return estDict(item) && Object.hasOwn(item, "text") && item["text"] !== undefined;
}

/** Charge utile d'un `CallToolResult` : erreur protocolaire en `{ok: false}`, bloc texte unique décodé en JSON, multi-blocs concaténés. */
export function pickToolPayload(resultat: unknown): unknown {
  if (!estDict(resultat)) return resultat;
  const contenu = resultat["content"];
  if (veritePy(resultat["isError"])) {
    const parties = (Array.isArray(contenu) ? contenu : [])
      .filter(aTexte)
      .map((i) => strPy((i as Dict)["text"]));
    const txt = stripPy(parties.join("\n\n")) || "erreur outil (MCP isError)";
    const decode = jsonOuNul(txt);
    if (estDict(decode) && (decode["ok"] === false || Object.hasOwn(decode, "error")))
      return { ...decode, ok: false };
    return { ok: false, error: prefixePy(txt, 2000) };
  }
  if (Object.hasOwn(resultat, "content")) {
    if (Array.isArray(contenu) && contenu.length > 0) {
      if (contenu.length === 1) {
        const item: unknown = contenu[0];
        if (aTexte(item)) {
          const texte = strPy((item as Dict)["text"]);
          try {
            return parseJsonPy(texte);
          } catch {
            return texte;
          }
        }
        return contentBlockText(item);
      }
      return contenu
        .map((item: unknown) => (aTexte(item) ? strPy((item as Dict)["text"]) : contentBlockText(item)))
        .join("\n\n");
    }
    const sc = resultat["structuredContent"];
    if (sc !== undefined && sc !== null && !veritePy(contenu)) return sc;
    return contenu;
  }
  return resultat;
}

export interface OptionsExecution {
  meta?: Dict | null;
  onProgress?: OptionsAppelClient["onProgress"];
  onLog?: SurJournal | null;
  timeoutS: number;
  queueTimeoutS?: number;
  signal?: AbortSignal | undefined;
  pool?: PoolMcp;
}

/** Panne d'un appel vue par le modèle et le compte : l'adresse d'un serveur partagé y est masquée, le journal garde le message entier. */
function erreurAppel(cfg: ConfigMcp, toolName: string, e: unknown): string {
  const complet = flattenExceptionMessage(e, Number.MAX_SAFE_INTEGER);
  if (sharedId(lire(cfg, "id")) === null) return prefixePy(complet, 300);
  const masque = masquerAdresse(complet, lire(cfg, "url"));
  if (masque !== complet)
    logOutils.warn(
      `'${toolName}' sur le serveur partagé '${strPy(lire(cfg, "name") ?? "?")}' en échec : ${prefixePy(complet, 300)}`,
    );
  return prefixePy(masque, 300);
}

/** Appel d'un outil MCP rendu en JSON : délai, file saturée et pannes deviennent une erreur d'outil ; seule l'annulation traverse. */
export async function executerOutilMcp(
  toolCfgMap: ReadonlyMap<string, ConfigMcp>,
  toolName: string,
  finalArgs: Dict,
  options: OptionsExecution,
): Promise<string> {
  const cfg = toolCfgMap.get(toolName);
  if (cfg === undefined || Object.keys(cfg).length === 0)
    return pyJsonDumps({ error: `Outil '${toolName}' inconnu ou désactivé.` }, { ensureAscii: false });
  const pool = options.pool ?? poolMcp;
  try {
    const res = await pool.callTool(cfg, toolName, finalArgs, {
      resolveClient: resoudreClientMcp,
      meta: options.meta ?? null,
      onProgress: options.onProgress ?? null,
      onLog: options.onLog ?? null,
      execTimeoutS: options.timeoutS,
      queueTimeoutS: options.queueTimeoutS ?? TOOL_QUEUE_WAIT_S,
      signal: options.signal,
    });
    return pyJsonDumps(pickToolPayload(res), { ensureAscii: false });
  } catch (e) {
    if (estAnnulation(e, options.signal)) throw e;
    if (e instanceof DelaiDepasse) return toolTimeoutJson(toolName, options.timeoutS);
    if (e instanceof McpFileSaturee)
      return pyJsonDumps(
        {
          ok: false,
          error: e.message,
          fix:
            "Le serveur d'outils est saturé par d'autres appels — " +
            "l'outil n'a PAS été exécuté. Réduis le parallélisme ou " +
            "réessaie dans un instant.",
        },
        { ensureAscii: false },
      );
    return pyJsonDumps({ error: erreurAppel(cfg, toolName, e) }, { ensureAscii: false });
  }
}
