// SPDX-License-Identifier: MIT
/** apps/core/src/rag/client.ts — adresse et jeton du service `rag_app` (extracteur), sonde de santé ; jeton jamais envoyé à une URL tierce. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { strPy, stripPy, veritePy } from "@elpis/commun";
import { config, configView, parseJsonPy } from "@elpis/config";
import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import { estDict, lire, prefixePy } from "../python";
import type { Dict } from "../python";

/** Panne de transport : service injoignable, réponse illisible, délai. */
export class RagServiceError extends Error {
  override name = "RagServiceError";
}

function sectionRag(): Dict {
  try {
    const rag = lire(configView(), "rag");
    return estDict(rag) ? rag : {};
  } catch {
    return {};
  }
}

/** `RAG_SERVICE_URL` > `config.json › rag.service_url`, sans `/` final. */
export function getServiceUrl(): string {
  const env = stripPy(process.env["RAG_SERVICE_URL"] ?? "");
  if (env) return env.replace(/\/+$/, "");
  return stripPy(
    strPy(veritePy(lire(sectionRag(), "service_url")) ? lire(sectionRag(), "service_url") : ""),
  ).replace(/\/+$/, "");
}

/** `RAG_SERVICE_TOKEN` > `rag.service_token` > `user_db/.rag_service_token` (écrit par ./elpis configure). */
export function getServiceToken(): string {
  const env = stripPy(process.env["RAG_SERVICE_TOKEN"] ?? "");
  if (env) return env;
  const tok = stripPy(
    strPy(veritePy(lire(sectionRag(), "service_token")) ? lire(sectionRag(), "service_token") : ""),
  );
  if (tok) return tok;
  try {
    return stripPy(readFileSync(path.join(config.PROJECT_ROOT, "user_db", ".rag_service_token"), "utf8"));
  } catch {
    return "";
  }
}

export function isConfigured(): boolean {
  return Boolean(getServiceUrl());
}

/** Jeton à présenter à `url` : le jeton configuré ne part qu'au service configuré. */
function jetonPour(url: string | null | undefined, token: string | null | undefined): string {
  if (token !== null && token !== undefined) return token;
  if (url && url.replace(/\/+$/, "") !== getServiceUrl().replace(/\/+$/, "")) return "";
  return getServiceToken();
}

function decrire(e: unknown): string {
  if (e instanceof Error) return e.message;
  return strPy(e);
}

async function lireJson(
  url: string,
  jeton: string,
  delaiS: number,
  signal?: AbortSignal,
): Promise<Dispatcher.ResponseData> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (jeton) h["Authorization"] = `Bearer ${jeton}`;
  const agent = new Agent({ connect: { timeout: delaiS * 1000 } });
  try {
    return await request(url, {
      method: "GET",
      dispatcher: agent,
      headers: h,
      headersTimeout: delaiS * 1000,
      bodyTimeout: delaiS * 1000,
      ...(signal ? { signal } : {}),
    });
  } finally {
    void agent.close().catch(() => undefined);
  }
}

/** `GET /api/health` (bouton « Tester » de l'administration) ; l'URL et le jeton peuvent être ceux d'un formulaire non enregistré. */
export async function ping(
  url: string | null = null,
  token: string | null = null,
  timeoutS = 5.0,
  signal?: AbortSignal,
): Promise<unknown> {
  const cible = (url || getServiceUrl() || "").replace(/\/+$/, "");
  if (!cible) throw new RagServiceError("No URL provided.");
  let r: Dispatcher.ResponseData;
  let texte: string;
  try {
    r = await lireJson(`${cible}/api/health`, jetonPour(url, token), timeoutS, signal);
    texte = await r.body.text();
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new RagServiceError(`Network error: ${decrire(e)}`, { cause: e });
  }
  if (r.statusCode === 401 || r.statusCode === 403)
    throw new RagServiceError(`Auth refused (HTTP ${r.statusCode}).`);
  if (r.statusCode >= 400) throw new RagServiceError(`HTTP ${r.statusCode}: ${prefixePy(texte, 200)}`);
  try {
    return parseJsonPy(texte);
  } catch {
    return { ok: true, raw: prefixePy(texte, 200) };
  }
}
