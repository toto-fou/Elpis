// SPDX-License-Identifier: MIT
/** apps/core/src/llm/fournisseurs/decouverte.ts — découverte des modèles et test de connexion d'un connecteur (OpenAI-compatible ou Anthropic), sans jamais rendre la clé. */
import { stripPy, strPy, veritePy } from "@elpis/commun";

import { journal } from "../../journal";
import { estDict, splitlinesPy } from "../../python";
import type { Dict } from "../../python";
import { LlmTarget } from "../cible";
import { getLlmClient } from "../client-http";
import { getPy, iterExige } from "../dict-py";
import { engineForTarget } from "../moteurs";
import { sonderMoteur } from "../sonde-moteur";
import { apiRoot, buildHeaders } from "./anthropic";
import { headers as enTetesOpenai, modelsUrl } from "./openai-compat";

const log = journal("discovery");

/** Catalogue Anthropic semé : repli si `GET /v1/models` échoue. */
export const ANTHROPIC_CATALOG: readonly string[] = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-fable-5",
];

export const FREE_MODEL_SUFFIX = "-free";
export const FREE_MODEL_PROVIDERS: readonly string[] = ["opencode"];

/** Sous-ensemble GRATUIT des modèles d'un fournisseur (convention `-free` d'OpenCode Zen). */
export function freeModels(providerType: string | null | undefined, modelIds: readonly unknown[]): unknown[] {
  if (!FREE_MODEL_PROVIDERS.includes(providerType || "")) return [];
  return modelIds.filter((m) => strPy(m).endsWith(FREE_MODEL_SUFFIX));
}

function ordonner(providerType: string, ids: readonly unknown[]): unknown[] {
  const gratuits = new Set(freeModels(providerType, ids));
  if (gratuits.size === 0) return [...ids];
  return [...ids.filter((m) => gratuits.has(m)), ...ids.filter((m) => !gratuits.has(m))];
}

function texte(row: Dict, cle: string, defaut = ""): string {
  const v = getPy(row, cle);
  return (veritePy(v) ? v : defaut) as string;
}

/** Ligne de connecteur → cible (non par défaut). */
export function rowToTarget(row: Dict): LlmTarget {
  const id = getPy(row, "id");
  return new LlmTarget({
    wire: texte(row, "wire", "openai"),
    providerType: texte(row, "provider_type", "generic"),
    baseUrl: stripPy(texte(row, "base_url")),
    apiKey: texte(row, "api_key"),
    model: texte(row, "default_model"),
    connectorId: (id ?? null) as number | null,
    isDefault: false,
  });
}

/** `[url des modèles, en-têtes]` selon le dialecte du connecteur. */
export function modelsUrlAndHeaders(row: Dict): [string, Record<string, string>] {
  const t = rowToTarget(row);
  if (t.wire === "anthropic") return [apiRoot(t) + "/v1/models", buildHeaders(t)];
  return [modelsUrl(t), enTetesOpenai(t)];
}

/** `{models, free}` : liste ordonnée (gratuits en tête) et sous-ensemble gratuit. */
export function decorate(row: Dict, ids: readonly unknown[]): Dict {
  const pt = texte(row, "provider_type");
  return { models: ordonner(pt, ids), free: freeModels(pt, ids) };
}

/** Modèles d'un connecteur `{ok, models, status, error?}` ; replis : liste saisie à la main, puis catalogue Anthropic. */
export async function fetchModels(row: Dict, options: { timeout?: number } = {}): Promise<Dict> {
  const manuel = splitlinesPy(texte(row, "models_json").replaceAll(",", "\n"))
    .map((m) => stripPy(m))
    .filter((m) => m);
  const [url, entetes] = modelsUrlAndHeaders(row);
  let base = texte(row, "base_url");
  if (!base && rowToTarget(row).wire === "anthropic") base = "https://api.anthropic.com";
  const client = getLlmClient(base || null);
  const anthropic = getPy(row, "wire") === "anthropic";
  try {
    const r = await client.get(url, { headers: entetes, timeout: options.timeout ?? 8.0 });
    if (r.statusCode === 200) {
      const donnees = r.json();
      const items = estDict(donnees) ? getPy(donnees, "data") : null;
      let ids: unknown[] = iterExige(veritePy(items) ? items : [])
        .filter((m) => estDict(m) && veritePy(getPy(m, "id")))
        .map((m) => getPy(m, "id"));
      if (ids.length === 0 && manuel.length > 0) ids = manuel;
      return { ok: true, status: 200, ...decorate(row, ids) };
    }
    if (manuel.length > 0)
      return { ok: true, status: r.statusCode, fallback: "manual", ...decorate(row, manuel) };
    if (anthropic)
      return {
        ok: false,
        status: r.statusCode,
        models: [...ANTHROPIC_CATALOG],
        fallback: "catalog",
        error: `HTTP ${r.statusCode}`,
      };
    return { ok: false, status: r.statusCode, models: [], error: `HTTP ${r.statusCode}` };
  } catch (e) {
    const message = [...(e instanceof Error ? e.message : String(e))].slice(0, 160).join("");
    log.debug(`fetch_models échec: ${message}`);
    if (manuel.length > 0) return { ok: true, status: 0, fallback: "manual", ...decorate(row, manuel) };
    if (anthropic)
      return { ok: false, status: 0, models: [...ANTHROPIC_CATALOG], fallback: "catalog", error: message };
    return { ok: false, status: 0, models: [], error: message };
  }
}

/** Test de connexion (lister les modèles ; `sonde` : rapport du profil hors générique) : `{ok, status, models_count, error?, hint?, sonde?}`, jamais la clé. */
export async function testConnector(
  row: Dict,
  options: { timeout?: number; sonde?: boolean } = {},
): Promise<Dict> {
  const res = await fetchModels(row, options);
  const statut = res["status"];
  const sortie: Dict = {
    ok: veritePy(res["ok"]) && statut !== 401 && statut !== 403,
    status: statut,
    models_count: (veritePy(res["models"]) ? (res["models"] as unknown[]) : []).length,
  };
  if (veritePy(res["fallback"])) sortie["fallback"] = res["fallback"];
  if (!sortie["ok"]) {
    sortie["error"] = veritePy(res["error"]) ? res["error"] : "échec";
    if (statut === 401 || statut === 403)
      sortie["hint"] = "401/403 : clé API refusée. Vérifie la clé du fournisseur.";
    else if (statut === 0 || statut === null || statut === undefined)
      sortie["hint"] = "Aucune réponse : base_url injoignable depuis l'app (réseau / port).";
    else if (statut === 404) sortie["hint"] = "404 : base_url probablement faux (chemin /v1 attendu).";
  }
  const cible = rowToTarget(row);
  if (options.sonde && cible.wire !== "anthropic" && cible.profil.type !== "generic")
    sortie["sonde"] = await sonderMoteur(engineForTarget(cible), { generation: true, modele: cible.model });
  return sortie;
}
