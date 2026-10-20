// SPDX-License-Identifier: MIT
/** apps/core/src/llm/llama-http.ts — appels courts au serveur d'inférence (client d'administration partagé) : GET, POST, DELETE, routes par modèle d'un routeur. */
import { setTimeout as attendre } from "node:timers/promises";

import { quotePy, raisonAnnulation } from "@elpis/commun";

import { journal } from "../journal";
import { estDict, prefixePy } from "../python";
import type { Dict } from "../python";
import { CancelledError, ClientHttp } from "./client-http";
import { engineCaps } from "./fournisseurs/llama-capacites";
import { currentEngine, racineIntegre } from "./moteurs";
import type { EngineRef } from "./moteurs";
import { getCurrentlyLoadedModel } from "./sante";

const log = journal("llama_http");

/** Horloge monotone en secondes (`time.monotonic`) ; l'origine du process la rend grande, comme celle du système en Python. */
export function monotonic(): number {
  return (performance.timeOrigin + performance.now()) / 1000;
}

/** `asyncio.sleep` annulable : un signal abandonné lève `CancelledError`. */
export async function dormir(secondes: number, signal?: AbortSignal): Promise<void> {
  try {
    await attendre(Math.max(0, secondes * 1000), undefined, { signal });
  } catch (e) {
    if (signal?.aborted) throw new CancelledError("attente annulée", { cause: signal.reason });
    throw e;
  }
}

/** Racine du serveur intégré (`llama.url` sans `/v1…`). */
export function llamaBaseUrl(): string {
  return racineIntegre();
}

let clientAdmin: ClientHttp | null = null;

/** Client partagé des appels d'administration et de surveillance : délai fixé par requête, 8 connexions. */
export function getAdminClient(): ClientHttp {
  if (clientAdmin !== null && !clientAdmin.isClosed) return clientAdmin;
  clientAdmin = new ClientHttp({
    delais: null,
    limites: { maxKeepaliveConnections: 4, maxConnections: 8, keepaliveExpiry: 120 },
  });
  return clientAdmin;
}

export async function closeAdminClient(): Promise<void> {
  if (clientAdmin !== null && !clientAdmin.isClosed) {
    try {
      await clientAdmin.aclose();
    } catch {
      // fermeture au mieux, comme au shutdown Python
    }
    clientAdmin = null;
  }
}

function moteur(engine?: EngineRef | null): EngineRef {
  return engine ?? currentEngine();
}

/** `[url, en-têtes]` du serveur visé : explicite, sinon celui de la cible du tour, sinon l'intégré. */
export function engineUrlHeaders(
  path: string,
  engine?: EngineRef | null,
): [string, Record<string, string> | null] {
  const eng = moteur(engine);
  const entetes = eng.headerDict();
  return [`${eng.baseRoot}${path}`, Object.keys(entetes).length > 0 ? entetes : null];
}

/** Routes qu'un routeur ne sert que pour UN modèle nommé. */
export const PER_MODEL_PATHS: readonly string[] = ["/metrics", "/slots"];

/** Serveur lancé sans métriques (statut du profil : 501 llama.cpp, 404 vLLM et SGLang) : plus de demande pendant ce délai. */
export const METRICS_OFF_S = 300.0;
export const metricsOffUntil = new Map<string, number>();

function metricsKey(engine: EngineRef | null | undefined, routed: string): string {
  return `${moteur(engine).key}${routed}`;
}

function metricsOff(engine: EngineRef | null | undefined, routed: string): boolean {
  return (metricsOffUntil.get(metricsKey(engine, routed)) ?? 0) > monotonic();
}

/** `/metrics` et `/slots` de l'intégré en routeur : le modèle CHARGÉ, sans charger ; aucun chargé = `null`. */
export async function perModelPath(path: string, engine?: EngineRef | null): Promise<string | null> {
  if (!PER_MODEL_PATHS.includes(path)) return path;
  const routed = await routeToLoaded(path, engine);
  if (routed && path === "/metrics" && metricsOff(engine, routed)) return null;
  return routed;
}

async function routeToLoaded(path: string, engine?: EngineRef | null): Promise<string | null> {
  let caps;
  let loaded: string | null;
  try {
    if (!moteur(engine).isBuiltin) return path;
    caps = await engineCaps();
    if (!caps.isRouter) return path;
    loaded = await getCurrentlyLoadedModel();
  } catch (e) {
    log.debug(`modèle chargé inconnu (${String(e)})`);
    return path;
  }
  if (!loaded) return null;
  const suffixe = caps.autoloadParam ? "&autoload=false" : "";
  return `${path}?model=${quotePy(loaded, "")}${suffixe}`;
}

/** GET → JSON (`{"_raw": …}` s'il est illisible), `null` sur toute panne. */
export async function llamaGet(
  path: string,
  timeout = 5.0,
  options: { engine?: EngineRef | null } = {},
): Promise<unknown> {
  const routed = await perModelPath(path, options.engine);
  if (routed === null) return null;
  const [url, headers] = engineUrlHeaders(routed, options.engine);
  try {
    const r = await getAdminClient().get(url, { timeout, headers });
    if (r.statusCode === 200) {
      try {
        return r.json();
      } catch {
        return { _raw: prefixePy(r.text, 2000) };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** GET → texte brut (`/metrics` Prometheus) ; le statut « métriques désactivées » du profil coupe la demande pendant `METRICS_OFF_S`. */
export async function llamaGetText(
  path: string,
  timeout = 5.0,
  options: { engine?: EngineRef | null } = {},
): Promise<string | null> {
  const routed = await perModelPath(path, options.engine);
  if (routed === null) return null;
  const [url, headers] = engineUrlHeaders(routed, options.engine);
  try {
    const r = await getAdminClient().get(url, { timeout, headers });
    if (r.statusCode === 200) return r.text;
    const profil = moteur(options.engine).profil;
    if (path === profil.chemins.metriques && r.statusCode === profil.metriques.statutDesactivees) {
      metricsOffUntil.set(metricsKey(options.engine, routed), monotonic() + METRICS_OFF_S);
      log.info(
        `/metrics non activé sur ${profil.libelle} (${profil.drapeaux.metriques ?? "option du serveur"}) : ` +
          `relu dans ${Math.trunc(METRICS_OFF_S)} s`,
      );
    }
  } catch {
    return null;
  }
  return null;
}

function reponseDict(statut: number, lire: () => unknown, texte: () => string): Dict {
  try {
    const d = lire();
    if (estDict(d)) return { _status: statut, ...d };
  } catch {
    // corps illisible : le texte suit
  }
  return { _status: statut, text: prefixePy(texte(), 300) };
}

/** POST JSON → `{"_status": code, …corps}` ; panne → `{"_status": 0, "error", "error_type"}`. */
export async function llamaPost(
  path: string,
  body: unknown,
  timeout = 60.0,
  options: { engine?: EngineRef | null; signal?: AbortSignal } = {},
): Promise<Dict> {
  const [url, headers] = engineUrlHeaders(path, options.engine);
  try {
    const r = await getAdminClient().post(url, { json: body, timeout, headers, signal: options.signal });
    return reponseDict(
      r.statusCode,
      () => r.json(),
      () => r.text,
    );
  } catch (e) {
    if (options.signal?.aborted) throw raisonAnnulation(options.signal);
    return {
      _status: 0,
      error: e instanceof Error ? e.message : String(e),
      error_type: e instanceof Error ? e.name : typeof e,
    };
  }
}

export async function llamaDelete(
  path: string,
  timeout = 30.0,
  options: { engine?: EngineRef | null } = {},
): Promise<Dict> {
  const [url, headers] = engineUrlHeaders(path, options.engine);
  try {
    const r = await getAdminClient().delete(url, { timeout, headers });
    return reponseDict(
      r.statusCode,
      () => r.json(),
      () => r.text,
    );
  } catch (e) {
    return { _status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
