// SPDX-License-Identifier: MIT
/** apps/core/src/llm/capacites.ts — capacités du llama-server intégré (`/props`, `/slots`) et mode d'ordonnancement effectif (`auto` re-sondé après un échec). */
import { quotePy, strPy, veritePy } from "@elpis/commun";
import { config, liveConfigValue } from "@elpis/config";

import { journal } from "../journal";
import { estDict } from "../python";
import type { Dict } from "../python";
import { ClientHttp, delais } from "./client-http";
import { getPy, iterExige } from "./dict-py";
import { monotonic } from "./llama-http";
import { builtinEngine } from "./moteurs";

const log = journal("llama_caps");

/** Capacités détectées (dict du module, muté en place comme en Python). */
export const LLAMA_CAPABILITIES: Dict = {
  probed: false,
  slots_endpoint: false,
  total_slots: null,
  loaded_model: null,
  probe_error: null,
  recommended_mode: "classic",
};

export const PROBE_RETRY_TTL_S = 60.0;
export const probeState: { ts: number; inflight: boolean } = { ts: 0.0, inflight: false };
const resondages = new Set<Promise<void>>();

function texte(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Premier modèle à l'état `loaded` dans `/v1/models` d'un routeur. */
async function loadedModel(client: ClientHttp, baseUrl: string): Promise<string | null> {
  try {
    const r = await client.get(`${baseUrl}/v1/models`);
    if (r.statusCode !== 200) return null;
    const corps = r.json();
    const donnees = getPy(veritePy(corps) ? corps : {}, "data");
    for (const m of iterExige(veritePy(donnees) ? donnees : [])) {
      const st = estDict(m) ? getPy(m, "status") : null;
      const valeur = estDict(st) ? getPy(st, "value") : st;
      if (valeur === "loaded" && veritePy(getPy(m, "id"))) return strPy(getPy(m, "id"));
    }
  } catch (e) {
    log.debug(`/v1/models illisible : ${texte(e)}`);
  }
  return null;
}

/** `os.path.splitext(os.path.basename(chemin))[0]` (POSIX). */
export function nomSansExtension(chemin: string): string {
  const base = chemin.slice(chemin.lastIndexOf("/") + 1);
  const point = base.lastIndexOf(".");
  if (point <= 0) return base;
  for (let i = 0; i < point; i++) if (base.charAt(i) !== ".") return base.slice(0, point);
  return base;
}

/** Un `/slots` qui répond une liste non vide, ou un objet qui n'est pas celui d'un routeur. */
async function essayerSlots(client: ClientHttp, url: string): Promise<boolean> {
  try {
    const r = await client.get(url);
    if (r.statusCode !== 200) return false;
    const corps = r.json();
    if (Array.isArray(corps)) return corps.length > 0;
    if (estDict(corps)) return Object.keys(corps).length > 0 && !Object.hasOwn(corps, "role");
    return true;
  } catch {
    return false;
  }
}

/** Sonde le serveur intégré : rôle, `total_slots`, modèle chargé, `/slots` ; jamais d'exception. */
export async function detectLlamaCapabilities(timeoutS = 3.0): Promise<Dict> {
  const caps: Dict = {
    probed: true,
    slots_endpoint: false,
    total_slots: null,
    loaded_model: null,
    role: null,
    max_instances: null,
    probe_error: null,
    recommended_mode: "classic",
  };
  let baseUrl = builtinEngine().baseRoot;
  if (!baseUrl) baseUrl = `http://${config.LLAMA_IP}:${config.LLAMA_PORT}`;
  let client: ClientHttp | null = null;
  try {
    client = new ClientHttp({ delais: delais(timeoutS) });
    try {
      const r = await client.get(`${baseUrl}/props`);
      if (r.statusCode === 200) {
        const brut = r.json();
        const data = veritePy(brut) ? brut : {};
        caps["total_slots"] = getPy(data, "total_slots");
        caps["role"] = veritePy(getPy(data, "role")) ? getPy(data, "role") : "single-model";
        caps["max_instances"] = getPy(data, "max_instances");
        let lm = getPy(data, "model_alias");
        if (!veritePy(lm)) lm = getPy(data, "model");
        if (!veritePy(lm)) lm = getPy(getPy(data, "default_generation_settings", {}), "model");
        if (!veritePy(lm)) {
          const mp = getPy(data, "model_path");
          if (veritePy(mp)) lm = nomSansExtension(strPy(mp));
        }
        caps["loaded_model"] = lm;
      }
    } catch (e) {
      caps["probe_error"] = `/props: ${texte(e)}`;
    }
    if (caps["role"] === "router") {
      const charge = await loadedModel(client, baseUrl);
      if (charge) {
        caps["loaded_model"] = charge;
        caps["slots_endpoint"] = await essayerSlots(
          client,
          `${baseUrl}/slots?model=${quotePy(charge, "")}&autoload=false`,
        );
      } else caps["slots_pending"] = true;
    } else caps["slots_endpoint"] = await essayerSlots(client, `${baseUrl}/slots`);
    if (!caps["slots_endpoint"] && !veritePy(caps["probe_error"]) && !veritePy(caps["slots_pending"]))
      caps["probe_error"] =
        "/slots non accessible — en mode router, vérifie que le modèle par défaut est chargeable, et que " +
        "llama-server n'a pas été lancé avec --no-slots.";
  } catch (e) {
    caps["probe_error"] = `connection: ${texte(e)}`;
  } finally {
    await client?.aclose();
  }
  const serveurPresent =
    veritePy(caps["slots_endpoint"]) ||
    (caps["role"] !== null && caps["role"] !== undefined) ||
    (caps["total_slots"] !== null && caps["total_slots"] !== undefined);
  if (serveurPresent) caps["recommended_mode"] = "optimized";
  for (const cle of Object.keys(LLAMA_CAPABILITIES)) Reflect.deleteProperty(LLAMA_CAPABILITIES, cle);
  Object.assign(LLAMA_CAPABILITIES, caps);
  log.info(
    `probe done — role=${strPy(caps["role"])} slots=${strPy(caps["slots_endpoint"])} ` +
      `total_slots=${strPy(caps["total_slots"])} max_instances=${strPy(caps["max_instances"])} ` +
      `recommended=${strPy(caps["recommended_mode"])}`,
  );
  return { ...caps };
}

/** Copie des capacités détectées (défauts tant que la détection n'a pas eu lieu). */
export function getLlamaCapabilities(): Dict {
  return { ...LLAMA_CAPABILITIES };
}

/** Mode effectif : `classic`, `optimized`, ou celui recommandé par la sonde en `auto` (jamais `auto`). */
export function resolveSchedulingMode(): "classic" | "optimized" {
  const valeur = liveConfigValue("llm.scheduling_mode", config.LLM_SCHEDULING_MODE);
  const mode = strPy(veritePy(valeur) ? valeur : "auto").toLowerCase();
  if (mode === "classic") return "classic";
  if (mode === "optimized") return "optimized";
  maybeReprobeCapabilities();
  return LLAMA_CAPABILITIES["recommended_mode"] === "optimized" ? "optimized" : "classic";
}

/** Relance la sonde en tâche de fond si la précédente a échoué et que le délai de re-tentative est écoulé. */
export function maybeReprobeCapabilities(): void {
  const caps = LLAMA_CAPABILITIES;
  if (veritePy(caps["slots_endpoint"]) || probeState.inflight) return;
  if (!veritePy(caps["probed"]) && !veritePy(caps["probe_error"])) return;
  const maintenant = monotonic();
  if (maintenant - (probeState.ts || 0.0) < PROBE_RETRY_TTL_S) return;
  probeState.ts = maintenant;
  probeState.inflight = true;
  const tache = detectLlamaCapabilities(3.0)
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      probeState.inflight = false;
      resondages.delete(tache);
    });
  resondages.add(tache);
}

/** Re-sondes en vol (tests, arrêt propre). */
export function resondagesEnVol(): Promise<void>[] {
  return [...resondages];
}
