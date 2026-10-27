// SPDX-License-Identifier: MIT
/** packages/mcp/src/pool.ts — pool unique du process : connexions MCP persistantes, cache des outils, concurrence par entrée et par compte, reconnexion sans rejeu d'un outil qui a peut-être agi. */
import { createHash } from "node:crypto";

import {
  comparePointsDeCode,
  ErreurPython,
  estAnnulationDemandee,
  floatPy,
  fixePy,
  pyJsonDumps,
  strPy,
  stripPy,
  veritePy,
} from "@elpis/commun";

import {
  course,
  DelaiDepasse,
  dormir,
  raisonAnnulation,
  Semaphore,
  signalBorne,
  VerrouAsyncio,
} from "./concurrence";
import { BUILTIN_SENTINEL } from "./manifeste";
import type { ConfigMcp } from "./manifeste";
import { estDict, lire } from "./outils";
import type { Dict } from "./outils";
import { deConfiance, journalDe } from "./ports";

export { estAnnulationDemandee as estAnnulation };

/** Borne du handshake (connexion + initialize + list_tools), relue de l'environnement au chargement comme en Python. */
const RELISTE_INCOMPLET_S = 15;
export const MCP_HANDSHAKE_TIMEOUT_S = floatPy(process.env["MCP_HANDSHAKE_TIMEOUT_S"] ?? "30");
/** Bornes de Python : inactivité avant fermeture, période du nettoyage, drainage avant fermeture, exclusivité tentée par le nettoyage. */
export const IDLE_TIMEOUT_SEC = 600;
export const CLEANUP_INTERVAL_SEC = 120;
export const DRAINAGE_S = 10;
export const EXCLUSIVITE_NETTOYAGE_S = 0.1;

export type OutilMcp = Dict;

export interface Progression {
  progress: number;
  total?: number | undefined;
  message?: string | undefined;
}

export type SurProgression = (p: Progression) => void | Promise<void>;
/** Notification de log MCP (`{level, logger, data}`) rendue à l'appel qui l'a produite. */
export type SurJournal = (params: Dict) => void | Promise<void>;

export interface OptionsAppelClient {
  meta?: Dict | null;
  onProgress?: SurProgression | null;
  onLog?: SurJournal | null;
  signal?: AbortSignal | undefined;
}

/** Client MCP vu par le pool ; `correle` : requêtes indépendantes (HTTP, SSE), donc concurrentes et abandonnables sans empoisonner l'entrée. */
export interface ClientMcp {
  readonly correle: boolean;
  connecter(signal: AbortSignal): Promise<void>;
  listerOutils(signal: AbortSignal): Promise<OutilMcp[]>;
  appelerOutil(nom: string, args: Dict, options: OptionsAppelClient): Promise<unknown>;
  fermer(): Promise<void>;
  /** Liste partielle (une famille d'un hôte d'outils manque) : relistée après `relisteIncompletS`, sans attendre le TTL. */
  incomplet?(): boolean;
}

export type ResoudreClient = (cfg: ConfigMcp) => ClientMcp | null;

/** L'appel n'a pas été exécuté : attente en file ou (re)connexion au-delà de sa borne ; jamais imputé à l'outil. */
export class McpFileSaturee extends Error {
  override name = "MCPQueueSaturated";
}

/** Sentinelle interne : l'entrée a été fermée entre sa lecture et la prise de sa garde ; la requête n'est jamais partie. */
export class EntreeEvincee extends Error {
  override name = "_EntryEvicted";
}

const NOMS_TRANSPORT = new Set([
  "SocketError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "ClientClosedError",
  "ClientDestroyedError",
  "TimeoutError",
  "AbortError",
]);

const CODES_TRANSPORT = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
]);

function champ(e: unknown, cle: string): unknown {
  return typeof e === "object" && e !== null ? (e as Record<string, unknown>)[cle] : undefined;
}

/** `(code, message)` d'une `McpError` du SDK (message sans le préfixe « MCP error n: »), sinon `[null, ""]`. */
export function codeMessageMcp(e: unknown): [number | null, string] {
  if (champ(e, "name") !== "McpError") return [null, ""];
  const code = champ(e, "code");
  const brut = String(champ(e, "message") ?? "");
  return [typeof code === "number" ? code : null, brut.replace(/^MCP error -?\d+: /, "")];
}

/** Le serveur ne connaît plus la session (HTTP 404 sur l'identifiant, HTTP streamable ou POST SSE) : requête non exécutée, rejeu sûr. */
export function estSessionPerdue(e: unknown): boolean {
  const [code, msg] = codeMessageMcp(e);
  if (code === 32600 && msg.toLowerCase().includes("session terminated")) return true;
  const message = String(champ(e, "message") ?? "");
  if (/^Error POSTing to endpoint \(HTTP 404\)/.test(message)) return true;
  return champ(e, "code") === 404 && /^Streamable HTTP error: /.test(message);
}

/** « Not connected » : le SDK refuse d'envoyer (client fermé, transport sans session) — la requête n'est jamais partie, la rejouer est sûr. */
export function estNonEnvoyee(e: unknown): boolean {
  return champ(e, "message") === "Not connected";
}

/** L'erreur vient-elle du tuyau (et non d'une réponse du serveur) ? Causes et groupes dépliés, 64 nœuds au plus. */
export function estErreurTransport(e: unknown): boolean {
  const pile: unknown[] = [e];
  let vus = 0;
  while (pile.length > 0 && vus < 64) {
    const cur = pile.pop();
    vus++;
    if (cur === null || cur === undefined || typeof cur !== "object") continue;
    const nom = champ(cur, "name");
    const code = champ(cur, "code");
    const message = String(champ(cur, "message") ?? "");
    if (typeof nom === "string" && NOMS_TRANSPORT.has(nom)) return true;
    if (typeof code === "string" && CODES_TRANSPORT.has(code)) return true;
    if (nom === "TypeError" && message === "fetch failed") return true;
    if (message === "Not connected") return true;
    if (/^Streamable HTTP error: /.test(message) && typeof code === "number") return true;
    if (/^SSE error: /.test(message) || /^Error POSTing to endpoint \(HTTP \d+\)/.test(message)) return true;
    const [codeMcp, msg] = codeMessageMcp(cur);
    if ((codeMcp === -32000 && stripPy(msg).toLowerCase() === "connection closed") || estSessionPerdue(cur))
      return true;
    const groupe = champ(cur, "errors");
    if (Array.isArray(groupe)) pile.push(...groupe);
    const cause = champ(cur, "cause");
    if (cause !== undefined) pile.push(cause);
  }
  return false;
}

interface Entree {
  key: string;
  client: ClientMcp;
  tools: OutilMcp[];
  toolsFetchedAt: number;
  lastUsedAt: number;
  lock: VerrouAsyncio;
  maxConcurrency: number;
  callSem: Semaphore | null;
  userSems: Map<string, Semaphore>;
  inflight: number;
  healthy: boolean;
  persistent: boolean;
}

function occupee(e: Entree): boolean {
  return e.lock.locked || e.inflight > 0;
}

function maintenant(): number {
  return performance.now() / 1000;
}

/** Entrée de service intégré : sentinelle `DEFAULT_LOCAL_PYTHON` ou MCP interne de l'app (`inprocess`). */
export function estConfigIntegree(cfg: ConfigMcp): boolean {
  const type = Object.hasOwn(cfg, "type") ? cfg["type"] : "sse";
  if (type === "inprocess") return true;
  return type === "stdio" && (Object.hasOwn(cfg, "command") ? cfg["command"] : "") === BUILTIN_SENTINEL;
}

function partieTexte(v: unknown, i: number): string {
  if (typeof v === "string") return v;
  const type =
    v === null || v === undefined
      ? "NoneType"
      : Array.isArray(v)
        ? "list"
        : typeof v === "object"
          ? "dict"
          : typeof v === "number"
            ? Number.isInteger(v)
              ? "int"
              : "float"
            : typeof v;
  throw new ErreurPython("TypeError", `sequence item ${i}: expected str instance, ${type} found`);
}

function sha256Hex(texte: string): string {
  if (!texte.isWellFormed())
    throw new ErreurPython("ValueError", "'utf-8' codec can't encode character: surrogates not allowed");
  return createHash("sha256").update(texte, "utf8").digest("hex");
}

/** `sorted(liste)` : textes par points de code, nombres par valeur ; types mêlés → TypeError. */
function trierPy(v: unknown): unknown[] {
  if (!Array.isArray(v)) {
    if (typeof v === "string") return Array.from(v).sort(comparePointsDeCode);
    if (estDict(v)) return Object.keys(v).sort(comparePointsDeCode);
    throw new ErreurPython("TypeError", "object is not iterable");
  }
  if (v.length < 2) return [...v];
  if (v.every((x) => typeof x === "string")) return [...v].sort(comparePointsDeCode);
  if (v.every((x) => typeof x === "number" || typeof x === "boolean"))
    return [...v].sort((a, b) => Number(a) - Number(b));
  throw new ErreurPython("TypeError", "'<' not supported between instances");
}

/** Empreinte stable des éléments d'auth (en-têtes, authorization, basic_auth, env) : deux identités distinctes, deux entrées. */
export function authFingerprint(cfg: ConfigMcp): string {
  const materiau = {
    headers: lire(cfg, "headers") ?? null,
    authorization: lire(cfg, "authorization") ?? null,
    basic_auth: lire(cfg, "basic_auth") ?? null,
    env: lire(cfg, "env") ?? null,
  };
  return sha256Hex(pyJsonDumps(materiau, { sortKeys: true })).slice(0, 12);
}

/** Clé de pool d'une config : une entrée par entrée de manifeste intégrée, sinon type + adresse + empreinte d'auth (+ confiance). */
export function makeKey(cfg: ConfigMcp): string {
  const g = (k: string, d: unknown): unknown => (Object.hasOwn(cfg, k) ? cfg[k] : d);
  const ctype = g("type", "sse");
  let parts: unknown[];
  if (ctype === "inprocess") {
    const n = veritePy(g("manifest", null))
      ? g("manifest", null)
      : veritePy(g("name", null))
        ? g("name", null)
        : "elpis-app";
    parts = [ctype, strPy(n)];
  } else if (ctype === "stdio") {
    if (g("command", "") === BUILTIN_SENTINEL) {
      parts = [ctype, BUILTIN_SENTINEL];
      const mf = stripPy(veritePy(g("manifest", null)) ? strPy(g("manifest", null)) : "");
      if (mf) parts.push(mf);
    } else {
      parts = [
        ctype,
        g("command", ""),
        g("name", ""),
        pyJsonDumps(trierPy(g("filter_categories", []))),
        authFingerprint(cfg),
      ];
    }
  } else {
    parts = [ctype, g("url", ""), authFingerprint(cfg)];
    if (deConfiance(cfg)) parts.push("confiance");
  }
  return sha256Hex(parts.map(partieTexte).join("|")).slice(0, 16);
}

function nomCfg(cfg: ConfigMcp, defaut: string): string {
  return strPy(Object.hasOwn(cfg, "name") ? cfg["name"] : defaut);
}

/** `_username_of(meta)` : le compte porté par le `_meta` d'appel, sinon `None`. */
export function utilisateurDuMeta(meta: Dict | null | undefined): string | null {
  const u = lire(meta, "username");
  return veritePy(u) ? strPy(u) : null;
}

export interface OptionsPool {
  /** `tool_traits(nom).replay_safe` : un outil mutant n'est jamais rejoué après une coupure. */
  rejouable: (nom: string) => boolean;
  /** Ingestion du registre de catégories : (re)connexion d'un service intégré, relistage d'une liste partielle. */
  surConnexionIntegree?: (outils: OutilMcp[], cle: string) => void;
  /** `LLAMA_TOOL_PARALLELISM` : appels simultanés sur un transport corrélé. */
  parallelisme: () => number;
  /** `TOOLS_CACHE_TTL_SEC`. */
  ttlOutilsS: () => number;
  /** Délai avant de relister une liste partielle (15 s par défaut). */
  relisteIncompletS?: number;
  delaiPoigneeS?: number;
  inactiviteS?: number;
  intervalleNettoyageS?: number;
  drainageS?: number;
}

export interface OptionsAppel {
  resolveClient?: ResoudreClient | null;
  meta?: Dict | null;
  /** Reprend le `_meta` à l'envoi effectif, après l'attente en file : ce qui dépend de l'heure (durée restante d'un sous-agent) ne vieillit pas dans la file. */
  refraichirMeta?: ((meta: Dict) => Dict) | null;
  onProgress?: SurProgression | null;
  onLog?: SurJournal | null;
  execTimeoutS?: number | null;
  queueTimeoutS?: number | null;
  signal?: AbortSignal | undefined;
}

/** Garde de concurrence prise autour d'un appel ; `liberer` la rend. */
interface Garde {
  liberer: () => void;
}

const log = (): ReturnType<typeof journalDe> => journalDe("MCP_POOL");

/** Pool de connexions MCP persistantes, unique pour le process ; les cycles de vie se sérialisent par clé, jamais entre serveurs. */
export class PoolMcp {
  readonly IDLE_TIMEOUT_SEC: number;
  readonly CLEANUP_INTERVAL_SEC: number;
  private readonly pool = new Map<string, Entree>();
  private readonly verrousCles = new Map<string, VerrouAsyncio>();
  private readonly fermetures = new Set<Promise<void>>();
  private arretNettoyage: AbortController | null = null;
  private ferme = false;
  private readonly delaiPoigneeS: number;
  private readonly drainageS: number;

  private readonly options: OptionsPool;

  constructor(options: OptionsPool) {
    this.options = options;
    this.delaiPoigneeS = options.delaiPoigneeS ?? MCP_HANDSHAKE_TIMEOUT_S;
    this.IDLE_TIMEOUT_SEC = options.inactiviteS ?? IDLE_TIMEOUT_SEC;
    this.CLEANUP_INTERVAL_SEC = options.intervalleNettoyageS ?? CLEANUP_INTERVAL_SEC;
    this.drainageS = options.drainageS ?? DRAINAGE_S;
  }

  /** Lecture seule pour le diagnostic et les tests. */
  entree(cfg: ConfigMcp): Readonly<Entree> | undefined {
    return this.pool.get(makeKey(cfg));
  }

  get taille(): number {
    return this.pool.size;
  }

  private verrouCle(key: string): VerrouAsyncio {
    let v = this.verrousCles.get(key);
    if (v === undefined) {
      v = new VerrouAsyncio();
      this.verrousCles.set(key, v);
    }
    return v;
  }

  private outilsPerimes(e: Entree): boolean {
    if (!e.toolsFetchedAt) return true;
    const age = maintenant() - e.toolsFetchedAt;
    if (e.client.incomplet?.() === true && age > (this.options.relisteIncompletS ?? RELISTE_INCOMPLET_S))
      return true;
    return age > this.options.ttlOutilsS();
  }

  /** Registre des catégories alimenté par les outils d'un service intégré. */
  private ingerer(outils: OutilMcp[], key: string): void {
    try {
      this.options.surConnexionIntegree?.(outils, key);
    } catch (e) {
      log().debug(`category registry ingest skipped: ${messageErreur(e)}`);
    }
  }

  /** `(client, outils)` : entrée saine réutilisée (outils rafraîchis après le TTL), sinon connexion neuve sous le verrou de sa clé. */
  async getOrConnect(
    cfg: ConfigMcp,
    resolveClient: ResoudreClient | null | undefined,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<[ClientMcp, OutilMcp[]]> {
    if (this.ferme) throw new Error("MCPConnectionPool est fermé.");
    const key = makeKey(cfg);
    const signal = options.signal;
    this.demarrerNettoyage();
    const entree = this.pool.get(key);
    if (entree !== undefined) {
      await entree.lock.acquerir({ signal });
      try {
        if (entree.healthy && this.pool.get(key) === entree) {
          entree.lastUsedAt = maintenant();
          if (!this.outilsPerimes(entree)) return [entree.client, entree.tools];
          const borne = signalBorne(signal, this.delaiPoigneeS * 1000);
          try {
            const partielle = entree.client.incomplet?.() === true;
            entree.tools = await entree.client.listerOutils(borne.signal);
            entree.toolsFetchedAt = maintenant();
            if (partielle && entree.persistent) this.ingerer(entree.tools, key);
            log().info(`Outils rafraîchis pour '${nomCfg(cfg, key)}' (${entree.tools.length} outils)`);
            return [entree.client, entree.tools];
          } catch (e) {
            if (signal?.aborted) throw raisonAnnulation(signal);
            log().warn(`Échec rafraîchissement outils '${nomCfg(cfg, key)}': ${messageErreur(e)}`);
            entree.healthy = false;
          } finally {
            borne.liberer();
          }
        }
      } finally {
        entree.lock.liberer();
      }
    }
    return this.verrouCle(key).avec(
      async () => {
        const e = this.pool.get(key);
        if (e !== undefined && e.healthy) {
          e.lastUsedAt = maintenant();
          return [e.client, e.tools];
        }
        return this.connecterNeuf(key, cfg, resolveClient, signal);
      },
      { signal },
    );
  }

  /** Appel d'outil : garde bornée (file), exécution bornée, reconnexion sur rupture de tuyau seulement, rejeu si sûr. */
  async callTool(cfg: ConfigMcp, toolName: string, args: Dict, options: OptionsAppel = {}): Promise<unknown> {
    const key = makeKey(cfg);
    const { signal, queueTimeoutS } = options;
    const nom = nomCfg(cfg, key);
    const utilisateur = utilisateurDuMeta(options.meta);
    let entree = this.pool.get(key);
    if (entree === undefined || !entree.healthy) {
      await this.borneFile(
        (s) => this.getOrConnect(cfg, options.resolveClient, { signal: s }),
        signal,
        queueTimeoutS,
        `(re)connexion à '${nom}' trop longue (> ${fixePy(queueTimeoutS ?? 0, 0)}s) — l'appel n'a pas été exécuté`,
      );
      entree = this.pool.get(key);
      if (entree === undefined) throw new Error(`MCP '${nom}' indisponible après reconnexion.`);
    }

    let erreurAppel: unknown;
    const garde = await this.prendreGarde(entree, utilisateur, queueTimeoutS, signal);
    try {
      if (this.pool.get(key) !== entree || !entree.healthy) {
        erreurAppel = new EntreeEvincee("entry évincée avant l'appel");
      } else {
        const client = entree.client;
        try {
          const resultat = await this.executer(client, toolName, args, options);
          entree.lastUsedAt = maintenant();
          return resultat;
        } catch (e) {
          if (e instanceof DelaiDepasse || estAnnulationDemandee(e, signal)) {
            if (this.pool.get(key) === entree && !client.correle) entree.healthy = false;
            throw e;
          }
          erreurAppel = e;
          if (this.pool.get(key) === entree) entree.healthy = false;
        }
      }
    } finally {
      garde.liberer();
    }

    let evincee = erreurAppel instanceof EntreeEvincee;
    if (!evincee && (estSessionPerdue(erreurAppel) || estNonEnvoyee(erreurAppel))) evincee = true;
    const transport = evincee || estErreurTransport(erreurAppel);
    if (!transport) {
      if (this.pool.get(key) === entree) entree.healthy = true;
      log().info(
        `call_tool '${toolName}' sur '${nom}' a échoué côté SERVEUR (${nomErreur(erreurAppel)}: ${messageErreur(erreurAppel)}) ` +
          "— remonté comme erreur d'outil, connexion conservée.",
      );
      throw erreurAppel;
    }
    log().warn(
      `Erreur call_tool '${toolName}' sur '${nom}': ${messageErreur(erreurAppel)}. Tentative de reconnexion…`,
    );
    const actuelle = this.pool.get(key);
    if (actuelle !== undefined && actuelle !== entree && actuelle.healthy) {
      log().info(
        `'${nom}' a déjà été reconnecté par un autre appel — on se rattache à l'entrée saine au lieu de la remplacer.`,
      );
    } else {
      await this.borneFile(
        (s) => this.reconnecter(key, cfg, options.resolveClient, s, entree),
        signal,
        queueTimeoutS,
        `(re)connexion à '${nom}' trop longue (> ${fixePy(queueTimeoutS ?? 0, 0)}s) — l'outil n'a pas été rejoué`,
        erreurAppel,
      );
    }
    if (!evincee && !this.options.rejouable(toolName)) {
      log().warn(
        `'${toolName}' NON rejoué après reconnexion (outil mutant : l'effet a peut-être déjà été appliqué avant la coupure).`,
      );
      throw erreurAppel;
    }
    const nouvelle = this.pool.get(key);
    if (nouvelle === undefined) throw new Error(`MCP '${nom}' indisponible après reconnexion.`);
    const garde2 = await this.prendreGarde(nouvelle, utilisateur, queueTimeoutS, signal);
    try {
      const resultat = await this.executer(nouvelle.client, toolName, args, options);
      nouvelle.lastUsedAt = maintenant();
      return resultat;
    } catch (e) {
      if (e instanceof DelaiDepasse || estAnnulationDemandee(e, signal)) {
        if (this.pool.get(key) === nouvelle && !nouvelle.client.correle) nouvelle.healthy = false;
      } else if (this.pool.get(key) === nouvelle && estErreurTransport(e)) nouvelle.healthy = false;
      throw e;
    } finally {
      garde2.liberer();
    }
  }

  /** Exécution bornée par `execTimeoutS` (l'attente en file n'est pas comptée) ; le dépassement lève `DelaiDepasse`. */
  private async executer(
    client: ClientMcp,
    toolName: string,
    args: Dict,
    options: OptionsAppel,
  ): Promise<unknown> {
    const delai = options.execTimeoutS;
    const borne = signalBorne(options.signal, delai === null || delai === undefined ? null : delai * 1000);
    try {
      const appel: OptionsAppelClient = { signal: borne.signal };
      if (veritePy(options.meta))
        appel.meta =
          options.meta && options.refraichirMeta
            ? options.refraichirMeta(options.meta)
            : (options.meta ?? null);
      if (options.onProgress) appel.onProgress = options.onProgress;
      if (options.onLog) appel.onLog = options.onLog;
      return await course(client.appelerOutil(toolName, args, appel), borne.signal);
    } catch (e) {
      if (borne.signal.aborted && borne.signal.reason === borne.delai) throw borne.delai;
      throw e;
    } finally {
      borne.liberer();
    }
  }

  /** `wait_for(op, queue_timeout_s)` : au-delà de la borne, `McpFileSaturee` (l'appel n'a pas été exécuté). */
  private async borneFile<T>(
    op: (signal: AbortSignal | undefined) => Promise<T>,
    signal: AbortSignal | undefined,
    queueTimeoutS: number | null | undefined,
    message: string,
    cause?: unknown,
  ): Promise<T> {
    if (queueTimeoutS === null || queueTimeoutS === undefined) return op(signal);
    const borne = signalBorne(signal, queueTimeoutS * 1000);
    try {
      return await op(borne.signal);
    } catch (e) {
      if (borne.signal.aborted && borne.signal.reason === borne.delai && !signal?.aborted)
        throw cause === undefined ? new McpFileSaturee(message) : new McpFileSaturee(message, { cause });
      throw e;
    } finally {
      borne.liberer();
    }
  }

  /** Part de concurrence d'un compte sur une entrée partagée : la moitié des places, registre borné à 256 comptes. */
  private partUtilisateur(entree: Entree, utilisateur: string | null): Semaphore | null {
    if (!utilisateur || entree.maxConcurrency <= 1) return null;
    const parCompte = Math.max(1, Math.floor(entree.maxConcurrency / 2));
    let sem = entree.userSems.get(utilisateur);
    if (sem === undefined) {
      sem = new Semaphore(parCompte);
      if (entree.userSems.size >= 256) {
        const libres = [...entree.userSems].filter(([, s]) => s.value >= parCompte).slice(0, 128);
        for (const [k] of libres) entree.userSems.delete(k);
      }
      entree.userSems.set(utilisateur, sem);
    }
    return sem;
  }

  /** Garde d'appel : verrou exclusif (transport sériel) ou part du compte puis sémaphore global ; attente bornée. */
  private async prendreGarde(
    entree: Entree,
    utilisateur: string | null,
    queueTimeoutS: number | null | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Garde> {
    const borne = signalBorne(
      signal,
      queueTimeoutS === null || queueTimeoutS === undefined ? null : queueTimeoutS * 1000,
    );
    try {
      if (entree.maxConcurrency <= 1 || entree.callSem === null) {
        await entree.lock.acquerir({ signal: borne.signal });
        return { liberer: () => entree.lock.liberer() };
      }
      const part = this.partUtilisateur(entree, utilisateur);
      const sem = entree.callSem;
      if (part !== null) await part.acquerir({ signal: borne.signal });
      try {
        await sem.acquerir({ signal: borne.signal });
      } catch (e) {
        part?.liberer();
        throw e;
      }
      entree.inflight++;
      return {
        liberer: () => {
          entree.inflight--;
          sem.liberer();
          part?.liberer();
        },
      };
    } catch (e) {
      if (borne.signal.aborted && borne.signal.reason === borne.delai && !signal?.aborted)
        throw new McpFileSaturee(
          `file d'attente d'outils saturée (> ${fixePy(queueTimeoutS ?? 0, 0)}s) — l'appel n'a pas été exécuté`,
        );
      throw e;
    } finally {
      borne.liberer();
    }
  }

  /** Exclusivité de cycle de vie : verrou + tous les permis ; `null` si le délai expire (rien n'est alors tenu). */
  private async exclusivite(entree: Entree, delaiS: number): Promise<number | null> {
    const t0 = maintenant();
    try {
      await entree.lock.acquerir({ delaiMs: delaiS * 1000 });
    } catch (e) {
      if (e instanceof DelaiDepasse) return null;
      throw e;
    }
    if (entree.maxConcurrency <= 1 || entree.callSem === null) return 0;
    let pris = 0;
    try {
      for (let i = 0; i < entree.maxConcurrency; i++) {
        const reste = delaiS - (maintenant() - t0);
        if (reste <= 0) throw new DelaiDepasse();
        await entree.callSem.acquerir({ delaiMs: reste * 1000 });
        pris++;
      }
    } catch (e) {
      for (let i = 0; i < pris; i++) entree.callSem.liberer();
      entree.lock.liberer();
      if (e instanceof DelaiDepasse) return null;
      throw e;
    }
    return pris;
  }

  private rendreExclusivite(entree: Entree, pris: number | null): void {
    if (pris === null) return;
    if (entree.callSem !== null) for (let i = 0; i < pris; i++) entree.callSem.liberer();
    if (entree.lock.locked) entree.lock.liberer();
  }

  private async connecterNeuf(
    key: string,
    cfg: ConfigMcp,
    resolveClient: ResoudreClient | null | undefined,
    signal: AbortSignal | undefined,
  ): Promise<[ClientMcp, OutilMcp[]]> {
    if (this.pool.has(key)) await this.fermerEntreeSansVerrou(key, signal);
    if (!resolveClient) throw new Error("resolve_client_fn requis pour créer une connexion MCP.");
    const client = resolveClient(cfg);
    if (client === null) throw new Error(`Config MCP invalide: ${nomCfg(cfg, "?")}`);
    const t0 = maintenant();
    let outils: OutilMcp[];
    try {
      const b1 = signalBorne(signal, this.delaiPoigneeS * 1000);
      try {
        await course(client.connecter(b1.signal), b1.signal);
      } finally {
        b1.liberer();
      }
      const b2 = signalBorne(signal, this.delaiPoigneeS * 1000);
      try {
        outils = await course(client.listerOutils(b2.signal), b2.signal);
      } finally {
        b2.liberer();
      }
    } catch (e) {
      try {
        await client.fermer();
      } catch {
        // fermeture best-effort d'une connexion avortée
      }
      if (signal?.aborted) throw raisonAnnulation(signal);
      const raison = e instanceof DelaiDepasse ? "" : messageErreur(e);
      throw new Error(`Échec connexion MCP '${nomCfg(cfg, "?")}': ${raison}`, { cause: e });
    }
    const t = maintenant();
    const integree = estConfigIntegree(cfg);
    const conc = client.correle ? Math.max(1, Math.trunc(this.options.parallelisme())) : 1;
    this.pool.set(key, {
      key,
      client,
      tools: outils,
      toolsFetchedAt: t,
      lastUsedAt: t,
      lock: new VerrouAsyncio(),
      maxConcurrency: conc,
      callSem: conc > 1 ? new Semaphore(conc) : null,
      userSems: new Map(),
      inflight: 0,
      healthy: true,
      persistent: integree,
    });
    if (integree) this.ingerer(outils, key);
    log().info(
      `Connecté '${nomCfg(cfg, "?")}' en ${Math.round((t - t0) * 1000)}ms (${outils.length} outils). Clé=${key}`,
    );
    return [client, outils];
  }

  /** Reconnexion sous le verrou de clé ; une entrée saine posée entre-temps par un autre appel est reprise (Python la remplaçait). */
  private reconnecter(
    key: string,
    cfg: ConfigMcp,
    resolveClient: ResoudreClient | null | undefined,
    signal: AbortSignal | undefined,
    tombee: Entree,
  ): Promise<[ClientMcp, OutilMcp[]]> {
    return this.verrouCle(key).avec(
      async () => {
        const actuelle = this.pool.get(key);
        if (actuelle !== undefined && actuelle !== tombee && actuelle.healthy) {
          log().info(
            `'${nomCfg(cfg, key)}' a déjà été reconnecté par un autre appel — on se rattache à l'entrée saine au lieu de la remplacer.`,
          );
          return [actuelle.client, actuelle.tools];
        }
        log().info(`Reconnexion '${nomCfg(cfg, "?")}'…`);
        return this.connecterNeuf(key, cfg, resolveClient, signal);
      },
      { signal },
    );
  }

  /** Ferme et retire l'entrée d'une config. */
  async invalidate(cfg: ConfigMcp): Promise<void> {
    const key = makeKey(cfg);
    await this.verrouCle(key).avec(() => this.fermerEntreeSansVerrou(key, undefined));
  }

  /** Ferme tout ; le pool refuse ensuite toute connexion (arrêt du process). */
  async closeAll(): Promise<void> {
    this.ferme = true;
    this.arreterNettoyage();
    const cles = [...this.pool.keys()];
    for (const key of cles) await this.verrouCle(key).avec(() => this.fermerEntreeSansVerrou(key, undefined));
    log().info(`Pool fermé (${cles.length} connexion(s) libérée(s)).`);
  }

  /** Ferme les connexions sans fermer le pool ; les entrées persistantes (services intégrés) sont épargnées par défaut. */
  async reset(options: { keepPersistent?: boolean } = {}): Promise<void> {
    const garder = options.keepPersistent ?? true;
    this.arreterNettoyage();
    const cles = [...this.pool].filter(([, e]) => !garder || !e.persistent).map(([k]) => k);
    const gardees = this.pool.size - cles.length;
    for (const key of cles) await this.verrouCle(key).avec(() => this.fermerEntreeSansVerrou(key, undefined));
    this.ferme = false;
    log().info(
      `Pool reset (${cles.length} connexion(s) libérée(s), ${gardees} persistante(s) conservée(s)).`,
    );
  }

  /** Retire l'entrée puis draine et ferme dans une tâche détachée : l'annulation de l'appelant n'empêche pas la fermeture. */
  private async fermerEntreeSansVerrou(key: string, signal: AbortSignal | undefined): Promise<void> {
    const entree = this.pool.get(key);
    if (entree === undefined) return;
    this.pool.delete(key);
    const fermeture = this.drainerEtFermer(key, entree);
    this.fermetures.add(fermeture);
    void fermeture.finally(() => this.fermetures.delete(fermeture)).catch(() => undefined);
    await course(fermeture, signal);
  }

  private async drainerEtFermer(key: string, entree: Entree): Promise<void> {
    const pris = await this.exclusivite(entree, this.drainageS);
    if (pris === null) {
      log().warn(
        `Fermeture forcée de ${key} après timeout — un call_tool était bloqué. Le subprocess sera tué.`,
      );
      try {
        await entree.client.fermer();
      } catch (e) {
        log().debug(`Erreur fermeture forcée ${key}: ${messageErreur(e)}`);
      }
      return;
    }
    try {
      await entree.client.fermer();
    } catch (e) {
      log().debug(`Erreur fermeture ${key}: ${messageErreur(e)}`);
    } finally {
      this.rendreExclusivite(entree, pris);
    }
  }

  /** Fermetures détachées encore en cours (tests, arrêt). */
  async attendreFermetures(): Promise<void> {
    await Promise.allSettled([...this.fermetures]);
  }

  private demarrerNettoyage(): void {
    if (this.arretNettoyage !== null) return;
    const arret = new AbortController();
    this.arretNettoyage = arret;
    void this.boucleNettoyage(arret.signal).catch((e: unknown) => {
      if (!arret.signal.aborted) log().error(`Erreur cleanup: ${messageErreur(e)}`);
    });
  }

  private arreterNettoyage(): void {
    this.arretNettoyage?.abort();
    this.arretNettoyage = null;
  }

  /** Ferme les connexions non persistantes inactives depuis plus de `IDLE_TIMEOUT_SEC`, jamais une entrée occupée. */
  private async boucleNettoyage(arret: AbortSignal): Promise<void> {
    while (!this.ferme && !arret.aborted) {
      await dormir(this.CLEANUP_INTERVAL_SEC * 1000, arret);
      try {
        await this.passeNettoyage();
      } catch (e) {
        log().error(`Erreur cleanup: ${messageErreur(e)}`);
      }
    }
  }

  /** Une passe du nettoyage périodique (exposée pour les tests). */
  async passeNettoyage(): Promise<void> {
    const t = maintenant();
    const candidates = [...this.pool].filter(
      ([, e]) => !e.persistent && e.lastUsedAt && t - e.lastUsedAt > this.IDLE_TIMEOUT_SEC,
    );
    for (const [key, entree] of candidates) {
      if (occupee(entree)) {
        log().debug(`Skip cleanup de ${key} : connexion en usage`);
        continue;
      }
      let pris: number | null = null;
      try {
        pris = await this.verrouCle(key).avec(async () => {
          if (this.pool.get(key) !== entree) return null;
          if (maintenant() - entree.lastUsedAt <= this.IDLE_TIMEOUT_SEC) return null;
          const exclusif = await this.exclusivite(entree, EXCLUSIVITE_NETTOYAGE_S);
          if (exclusif !== null) this.pool.delete(key);
          return exclusif;
        });
        if (pris === null) continue;
        log().info(`Fermeture connexion inactive: ${key}`);
        try {
          await entree.client.fermer();
        } catch (e) {
          log().debug(`Erreur fermeture ${key}: ${messageErreur(e)}`);
        }
      } finally {
        this.rendreExclusivite(entree, pris);
      }
      const v = this.verrousCles.get(key);
      if (v !== undefined && !v.locked && v.enAttente === 0) this.verrousCles.delete(key);
    }
  }
}

export function nomErreur(e: unknown): string {
  const n = champ(e, "name");
  return typeof n === "string" && n ? n : typeof e;
}

/** `str(e)` : message de l'erreur (jamais ses en-têtes ni son contexte de requête). */
export function messageErreur(e: unknown): string {
  if (e instanceof Error) return e.message;
  return strPy(e);
}
