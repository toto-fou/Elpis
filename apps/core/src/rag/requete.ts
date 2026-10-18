// SPDX-License-Identifier: MIT
/** apps/core/src/rag/requete.ts — module de requête RAG des outils intégrés par le point d'entrée HTTP de `rag_app` (choix de `_rag_client` : URL, jeton et délai configurés) au lieu de l'import en process de `rag_query`. */
import { estDict, getPy, intPy, pyJsonDumps, pyJsonLoads, strPy, texteJsonPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { Agent, request } from "undici";

import type { ModuleRequeteRag, ParametresRecherche } from "../outils/integres/rag";
import {
  callTool,
  getServiceTimeout,
  getServiceToken,
  getServiceUrl,
  isConfigured,
  RagServiceError,
  RagToolError,
} from "./client";

/** Plus grande fenêtre servie par `rag_get_document` (`_DOC_WINDOW_HARD_CAP`) ; au-delà, lecture par fenêtres successives. */
const FENETRE_SERVICE = 500;
/** Budget de caractères passé à `rag_get_document` pour que seul le nombre de chunks borne la lecture. */
const SANS_PLAFOND_CARACTERES = 2 ** 31 - 1;

/** Appel JSON simple (`/api/config`, `/api/search`) : jeton du service, délai configuré, panne réseau = `RagServiceError`. */
async function appelJson(
  methode: "GET" | "POST",
  chemin: string,
  corps: Dict | null,
  signal?: AbortSignal,
): Promise<unknown> {
  const base = getServiceUrl();
  if (!base)
    throw new RagServiceError(
      "RAG service URL is not configured. Set rag.service_url in config.json (repo root) or RAG_SERVICE_URL env var.",
    );
  const url = `${base}${chemin}`;
  const delai = getServiceTimeout() * 1000;
  const entetes: Record<string, string> = { Accept: "application/json" };
  const jeton = getServiceToken();
  if (jeton) entetes["Authorization"] = `Bearer ${jeton}`;
  if (corps !== null) entetes["Content-Type"] = "application/json";
  const agent = new Agent({ connect: { timeout: Math.min(5000, delai) } });
  try {
    const r = await request(url, {
      method: methode,
      dispatcher: agent,
      headers: entetes,
      ...(corps !== null
        ? { body: pyJsonDumps(corps, { ensureAscii: false, separators: [",", ":"], allowNan: false }) }
        : {}),
      headersTimeout: delai,
      bodyTimeout: delai,
      ...(signal ? { signal } : {}),
    });
    const octets = new Uint8Array(await r.body.arrayBuffer());
    if (r.statusCode >= 400)
      throw new RagServiceError(
        `HTTP ${r.statusCode} on ${url}: ${new TextDecoder().decode(octets).slice(0, 500) || "no body"}`,
      );
    return pyJsonLoads(texteJsonPy(octets));
  } catch (e) {
    if (signal?.aborted || e instanceof RagServiceError) throw e;
    throw new RagServiceError(
      `Network error contacting RAG service (${url}): ${e instanceof Error ? e.message : strPy(e)}`,
      {
        cause: e,
      },
    );
  } finally {
    void agent.close().catch(() => undefined);
  }
}

/** Ligne de `rag_search` (outil du service) remise à la forme de `rag_search_only` (`name`, `folder`, `chunk_index`, `score`, `text`). */
function ligneRecherche(r: unknown): Dict {
  const source = strPy(getPy(r, "source", "") ?? "");
  const i = source.lastIndexOf("/");
  return {
    score: getPy(r, "score", 0),
    name: i >= 0 ? source.slice(i + 1) : source,
    folder: i >= 0 ? source.slice(0, i) : "",
    chunk_index: getPy(r, "chunk", 0),
    text: getPy(r, "text", ""),
  };
}

/** `rag_app.rag_query` vu des outils intégrés, par HTTP : la configuration et la recherche de la collection par défaut passent par les routes qui appellent `load_config` et `rag_search_only` ; une autre collection, les sources et les chunks d'un document, par les outils SSE du service. */
export class ModuleRequeteRagHttp implements ModuleRequeteRag {
  private config: Dict | null = null;

  async loadConfig(signal?: AbortSignal): Promise<Dict> {
    const cfg = await appelJson("GET", "/api/config", null, signal);
    this.config = estDict(cfg) ? cfg : {};
    return this.config;
  }

  private async collectionParDefaut(signal?: AbortSignal): Promise<unknown> {
    return getPy(this.config ?? (await this.loadConfig(signal)), "collection", "");
  }

  async ragSearchOnly(p: ParametresRecherche, signal?: AbortSignal): Promise<unknown> {
    const autre =
      veritePy(p.collection) && strPy(p.collection) !== strPy(await this.collectionParDefaut(signal));
    if (!autre)
      return appelJson(
        "POST",
        "/api/search",
        { query: p.question, top_k: p.top_k, use_hybrid: p.use_hybrid, use_mmr: p.use_mmr },
        signal,
      );
    let charge: Dict;
    try {
      charge = await callTool(
        "rag_search",
        {
          query: p.question,
          top_k: p.top_k,
          use_hybrid: p.use_hybrid,
          use_mmr: p.use_mmr,
          collections: [p.collection],
        },
        signal,
      );
    } catch (e) {
      if (e instanceof RagToolError) return { ok: false, results: [], msg: e.message };
      throw e;
    }
    const lignes = getPy(charge, "results", []);
    return { ok: true, results: Array.isArray(lignes) ? lignes.map(ligneRecherche) : [], query: p.question };
  }

  async getAllChunksForFiles(
    cfg: Dict,
    fichiers: unknown[],
    maxChunks: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let plafond: number;
    try {
      plafond = intPy(maxChunks || getPy(cfg, "tool_max_chunks", 100));
    } catch {
      plafond = 100;
    }
    const lignes: Dict[] = [];
    for (const f of fichiers) {
      let debut = 0;
      while (lignes.length < plafond) {
        const reste = plafond - lignes.length;
        let charge: Dict;
        try {
          charge = await callTool(
            "rag_get_document",
            {
              filename: strPy(f),
              collection: getPy(cfg, "collection", null),
              chunk_start: debut,
              max_chunks: Math.min(reste, FENETRE_SERVICE),
              max_chars: SANS_PLAFOND_CARACTERES,
            },
            signal,
          );
        } catch (e) {
          if (e instanceof RagToolError) break;
          throw e;
        }
        const resultats = getPy(charge, "results", []);
        for (const r of Array.isArray(resultats) ? resultats : [])
          lignes.push({ chunk_index: getPy(r, "chunk", 0), text: getPy(r, "text", "") });
        const suite = getPy(charge, "next_chunk_start", null);
        if (typeof suite !== "number" || !Array.isArray(resultats) || resultats.length === 0) break;
        debut = suite;
      }
      if (lignes.length >= plafond) break;
    }
    return lignes.slice(0, plafond);
  }

  async listIndexedFiles(cfg: Dict, signal?: AbortSignal): Promise<unknown> {
    try {
      const charge = await callTool(
        "rag_list_sources",
        { collection: getPy(cfg, "collection", null) },
        signal,
      );
      const fichiers = getPy(charge, "files", []);
      return Array.isArray(fichiers) ? fichiers : [];
    } catch (e) {
      if (e instanceof RagToolError) return [];
      throw e;
    }
  }
}

/** Module de requête RAG d'un tour (B1-20b) : `null` sans service RAG configuré (aucun outil RAG, repli sur le RAG automatique). */
export function moduleRequeteRag(): ModuleRequeteRag | null {
  return isConfigured() ? new ModuleRequeteRagHttp() : null;
}
