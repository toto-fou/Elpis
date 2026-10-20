// SPDX-License-Identifier: MIT
/** apps/core/src/llm/moteurs.ts — serveur d'inférence visé par un appel (`EngineRef`) : intégré, connecteur de la cible, ou surcharge explicite. */
import { AsyncLocalStorage } from "node:async_hooks";

import { ErreurPython, stripPy, urlsplit, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";

import { entierPy } from "../python";
import { cibleDuContexte, resolveLlmTarget } from "./cible";
import { sansBarresFinales } from "./client-http";
import { connecteurs } from "./ports";
import { profilDuType } from "./profils";
import type { ProfilMoteur } from "./profils";

export const BUILTIN_KEY = "builtin";
const CONN_PREFIX = "conn:";

export interface ChampsMoteur {
  key: string;
  baseRoot: string;
  providerType?: string;
  headers?: readonly (readonly [string, string])[];
  connectorId?: number | null;
  label?: string;
}

/** Serveur adressable, figé : racine HTTP sans `/v1`, dialecte, en-têtes d'authentification. */
export class EngineRef {
  readonly key: string;
  readonly baseRoot: string;
  readonly providerType: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly connectorId: number | null;
  readonly label: string;

  constructor(champs: ChampsMoteur) {
    this.key = champs.key;
    this.baseRoot = champs.baseRoot;
    this.providerType = champs.providerType ?? "llamacpp";
    this.headers = Object.freeze((champs.headers ?? []).map((h) => Object.freeze([h[0], h[1]] as const)));
    this.connectorId = champs.connectorId ?? null;
    this.label = champs.label ?? "";
    Object.freeze(this);
  }

  get isBuiltin(): boolean {
    return this.key === BUILTIN_KEY;
  }

  /** Profil du type déclaré : adresses, capacités, métriques. */
  get profil(): ProfilMoteur {
    return profilDuType(this.providerType);
  }

  get isLlamacpp(): boolean {
    return this.profil.type === "llamacpp";
  }

  headerDict(): Record<string, string> {
    return Object.fromEntries(this.headers);
  }

  url(path: string): string {
    return `${this.baseRoot}${path}`;
  }

  /** Clé de cache par (serveur, modèle) : le nom seul pour l'intégré, préfixé par la clé du serveur sinon. */
  cacheKey(model?: string | null): string {
    const m = model || "";
    return this.isBuiltin ? m : `${this.key}|${m}`;
  }

  /** Jamais la clé d'API dans un journal. */
  toString(): string {
    return `EngineRef(${this.key}, ${this.baseRoot}, ${this.providerType})`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

export function connectorKey(connectorId: unknown): string {
  return `${CONN_PREFIX}${entierPy(connectorId)}`;
}

/** `"builtin"` ou vide → `["builtin", null]` ; `"conn:3"` → `["conn", 3]` ; sinon `null`. */
export function parseEngineKey(key: string | null | undefined): ["builtin", null] | ["conn", number] | null {
  const k = stripPy(key || "");
  if (!k || k === BUILTIN_KEY) return [BUILTIN_KEY, null];
  if (!k.startsWith(CONN_PREFIX)) return null;
  let cid: number;
  try {
    cid = entierPy(k.slice(CONN_PREFIX.length));
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "ValueError") return null;
    throw e;
  }
  return cid > 0 ? ["conn", cid] : null;
}

/** Racine d'un serveur OpenAI-compatible : sans `/chat/completions` ni `/v1` final, préfixe de proxy gardé. */
export function baseRoot(url: string | null | undefined): string {
  let u = sansBarresFinales(stripPy(url || ""));
  for (const suffixe of ["/v1/chat/completions", "/chat/completions", "/v1"]) {
    if (u.endsWith(suffixe)) {
      u = u.slice(0, u.length - suffixe.length);
      break;
    }
  }
  return sansBarresFinales(u);
}

/** Racine du serveur intégré : `scheme://hôte:port` de `LLAMA_URL` (vide si illisible), relue à chaque appel. */
export function racineIntegre(): string {
  try {
    const p = urlsplit(config.LLAMA_URL || "");
    return p.scheme && p.netloc ? `${p.scheme}://${p.netloc}` : "";
  } catch {
    return "";
  }
}

/** En-tête Bearer du serveur intégré (`llama.api_key` ou `LLAMA_API_KEY`) ; jamais journalisé. */
export function entetesIntegre(): [string, string][] {
  const cle = stripPy(config.LLAMA_API_KEY || "");
  return cle ? [["Authorization", `Bearer ${cle}`]] : [];
}

/** Serveur intégré, du type déclaré par `llama.engine` (llama.cpp si `LLAMA_URL` est illisible), relu à chaque appel. */
export function builtinEngine(): EngineRef {
  let racine: string;
  let type: string;
  try {
    const p = urlsplit(config.LLAMA_URL || "");
    racine = p.scheme && p.netloc ? `${p.scheme}://${p.netloc}` : "";
    type = config.LLAMA_PROVIDER_TYPE || "llamacpp";
  } catch {
    racine = "";
    type = "llamacpp";
  }
  return new EngineRef({
    key: BUILTIN_KEY,
    baseRoot: racine,
    providerType: type,
    headers: entetesIntegre(),
    label: "Serveur intégré",
  });
}

/** Ce que `engineForTarget` lit d'une cible (une `LlmTarget` ou tout objet de même forme). */
export interface CibleMoteur {
  isDefault?: unknown;
  apiKey?: string | null;
  connectorId?: unknown;
  baseUrl?: string | null;
  providerType?: string | null;
}

/** Serveur d'une cible ; cible absente ou par défaut ⇒ intégré. */
export function engineForTarget(target: CibleMoteur | null | undefined): EngineRef {
  if (
    target === null ||
    target === undefined ||
    veritePy(target.isDefault === undefined ? true : target.isDefault)
  )
    return builtinEngine();
  const apiKey = target.apiKey || "";
  const cid = target.connectorId;
  const avecId = veritePy(cid);
  return new EngineRef({
    key: avecId ? connectorKey(cid) : `url:${baseRoot(target.baseUrl)}`,
    baseRoot: baseRoot(target.baseUrl || ""),
    providerType: target.providerType || "generic",
    headers: apiKey ? [["Authorization", `Bearer ${apiKey}`]] : [],
    connectorId: avecId ? entierPy(cid) : null,
  });
}

const surcharge = new AsyncLocalStorage<EngineRef | null>();

/** Serveur visé par l'appel en cours : surcharge (`useEngine`), sinon celui de la cible du tour, sinon l'intégré. */
export function currentEngine(): EngineRef {
  const moteur = surcharge.getStore();
  if (moteur) return moteur;
  try {
    return engineForTarget(cibleDuContexte());
  } catch {
    return builtinEngine();
  }
}

/** Vise `engine` pendant `fn` (`null` = règle normale), à travers `await` et `Promise.all`. */
export function useEngine<T>(engine: EngineRef | null, fn: (engine: EngineRef | null) => T): T {
  return surcharge.run(engine, () => fn(engine));
}

/** Serveur d'une clé pour ce compte (connecteur perso ou partagé, actif), `null` si invalide ou inutilisable. */
export async function resolveEngineForUser(
  userId: unknown,
  key: string | null | undefined,
): Promise<EngineRef | null> {
  const lu = parseEngineKey(key);
  if (lu === null) return null;
  const [genre, cid] = lu;
  if (genre === BUILTIN_KEY) return builtinEngine();
  let cible;
  try {
    cible = await resolveLlmTarget(userId, cid, null, { strict: true, touch: false });
  } catch {
    return null;
  }
  return engineForTarget(cible);
}

function entierOu(v: unknown, defaut: number): number {
  return entierPy(veritePy(v) ? v : defaut);
}

/** `[max_models, max_concurrency]` déclarés pour ce serveur ; 0 = non déclaré (l'appelant découvre ou retombe sur 1). */
export async function engineLimits(engine: EngineRef): Promise<[number, number]> {
  if (engine.isBuiltin) {
    try {
      return [entierOu(config.LLAMA_MAX_MODELS, 1), entierOu(config.LLAMA_MAX_CONCURRENCY, 1)];
    } catch {
      return [1, 1];
    }
  }
  if (!engine.connectorId) return [0, 0];
  let meta;
  try {
    meta = (await connecteurs().getMeta(engine.connectorId)) || {};
  } catch {
    return [0, 0];
  }
  return [entierOu(meta.max_models, 0), entierOu(meta.max_concurrency, 0)];
}
