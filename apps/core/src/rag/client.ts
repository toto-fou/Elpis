// SPDX-License-Identifier: MIT
/** apps/core/src/rag/client.ts — client HTTP du service `rag_app` : outils en flux SSE, santé et collections, délais par phase, jeton jamais envoyé à une URL tierce. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { floatPy, minPy, pyJsonDumps, strPy, stripPy, veritePy } from "@elpis/commun";
import { config, configView, parseJsonPy } from "@elpis/config";
import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import { journal } from "../journal";
import { estDict, lire, lstripPy, prefixePy } from "../python";
import type { Dict } from "../python";

const log = journal("rag_client");

/** Panne de transport : service injoignable, flux SSE invalide, délai. */
export class RagServiceError extends Error {
  override name = "RagServiceError";
}

/** Le service a rendu une erreur structurée pour l'outil demandé. */
export class RagToolError extends Error {
  override name = "RagToolError";
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

/** `RAG_SERVICE_TIMEOUT` > `rag.service_timeout` > 30 s. */
export function getServiceTimeout(): number {
  const env = stripPy(process.env["RAG_SERVICE_TIMEOUT"] ?? "");
  if (env) {
    try {
      return floatPy(env);
    } catch {
      // valeur illisible : la config décide
    }
  }
  try {
    const v = lire(sectionRag(), "service_timeout");
    return floatPy(veritePy(v) ? v : 30.0);
  } catch {
    return 30.0;
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

let agentPartage: { connexionMs: number; agent: Agent } | null = null;

/** Client partagé (keep-alive, 32 connexions) ; la connexion échoue vite (`min(5 s, délai)`), la lecture garde le délai configuré. */
function agentRag(delaiS: number): Agent {
  const connexionMs = minPy(5.0, delaiS) * 1000;
  if (agentPartage === null || agentPartage.connexionMs !== connexionMs) {
    const ancien = agentPartage?.agent;
    agentPartage = { connexionMs, agent: new Agent({ connections: 32, connect: { timeout: connexionMs } }) };
    if (ancien) void ancien.close().catch(() => undefined);
  }
  return agentPartage.agent;
}

/** Fins de ligne de `str.splitlines` (`\r\n` compte pour une). */
const FINS_DE_LIGNE: ReadonlySet<number> = new Set([
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

/** Lignes complètes de `tampon` et le reste ; hors fin de flux, un `\r` final attend le morceau suivant (il peut précéder un `\n`). */
function decouper(tampon: string, fin: boolean): [string[], string] {
  const out: string[] = [];
  let debut = 0;
  for (let i = 0; i < tampon.length; i++) {
    const code = tampon.charCodeAt(i);
    if (!FINS_DE_LIGNE.has(code)) continue;
    if (code === 0x0d && i === tampon.length - 1 && !fin) break;
    out.push(tampon.slice(debut, i));
    if (code === 0x0d && tampon.charCodeAt(i + 1) === 0x0a) i++;
    debut = i + 1;
  }
  return [out, tampon.slice(debut)];
}

/** Lignes du corps comme `iter_lines` d'httpx (décodage UTF-8 tolérant). */
async function* lignes(corps: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder("utf-8");
  let tampon = "";
  for await (const morceau of corps) {
    const [completes, reste] = decouper(tampon + dec.decode(morceau, { stream: true }), false);
    tampon = reste;
    yield* completes;
  }
  const [completes, reste] = decouper(tampon + dec.decode(), true);
  yield* completes;
  if (reste) yield reste;
}

/** Événements `data: {json}` du flux ; commentaires et champs étrangers ignorés, trame JSON invalide sautée. */
async function* evenementsSse(corps: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  for await (const brut of lignes(corps)) {
    if (!brut || brut.startsWith(":") || !brut.startsWith("data:")) continue;
    const data = lstripPy(brut.slice(5));
    if (!data) continue;
    try {
      yield parseJsonPy(data);
    } catch {
      log.warn(`SSE: skipping malformed JSON frame: ${prefixePy(data, 200)}`);
    }
  }
}

function entetes(): Record<string, string> {
  const h: Record<string, string> = { Accept: "text/event-stream", "Content-Type": "application/json" };
  const tok = getServiceToken();
  if (tok) h["Authorization"] = `Bearer ${tok}`;
  return h;
}

function decrire(e: unknown): string {
  if (e instanceof Error) return e.message;
  return strPy(e);
}

/** Panne réseau ou de protocole (équivalent de `httpx.HTTPError`) : erreurs d'undici et du système, jamais une annulation. */
function estErreurHttp(e: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted || !(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return (
    typeof code === "string" ||
    e.name.startsWith("UND_") ||
    (e.name === "TypeError" && e.message === "fetch failed")
  );
}

/** Appelle un outil SSE du service et rend la charge du `result` ; `error` → `RagToolError`, flux sans résultat → `RagServiceError`. */
export async function callTool(
  toolName: string,
  payload: Dict | null = null,
  signal?: AbortSignal,
): Promise<Dict> {
  const base = getServiceUrl();
  if (!base)
    throw new RagServiceError(
      "RAG service URL is not configured. Set rag.service_url in config.json (repo root) or RAG_SERVICE_URL env var.",
    );
  const url = `${base}/api/tools/${toolName}`;
  const corps = pyJsonDumps(payload ?? {}, { ensureAscii: false, separators: [",", ":"], allowNan: false });
  const delai = getServiceTimeout();
  let derniereErreur: string | null = null;
  let resultat: Dict | null = null;
  let reponse: Dispatcher.ResponseData | null = null;
  try {
    reponse = await request(url, {
      method: "POST",
      dispatcher: agentRag(delai),
      headers: entetes(),
      body: corps,
      headersTimeout: delai * 1000,
      bodyTimeout: delai * 1000,
      ...(signal ? { signal } : {}),
    });
    if (reponse.statusCode >= 400) {
      let texte = "";
      try {
        texte = prefixePy(new TextDecoder("utf-8").decode(await reponse.body.arrayBuffer()), 500);
      } catch {
        // corps illisible
      }
      throw new RagServiceError(`HTTP ${reponse.statusCode} on ${url}: ${texte || "no body"}`);
    }
    for await (const evt of evenementsSse(reponse.body)) {
      const t = lire(evt, "type");
      if (t === "result")
        resultat =
          estDict(lire(evt, "payload")) && veritePy(lire(evt, "payload"))
            ? (lire(evt, "payload") as Dict)
            : {};
      else if (t === "error")
        derniereErreur = strPy(veritePy(lire(evt, "msg")) ? lire(evt, "msg") : "unknown error");
      else if (t === "done") break;
    }
  } catch (e) {
    if (estErreurHttp(e, signal))
      throw new RagServiceError(`Network error contacting RAG service (${url}): ${decrire(e)}`, { cause: e });
    throw e;
  } finally {
    if (reponse !== null) await reponse.body.dump().catch(() => undefined);
  }
  if (derniereErreur !== null) throw new RagToolError(derniereErreur);
  if (resultat === null)
    throw new RagServiceError(
      `RAG service stream closed without a result event (${url}). Check the rag_app logs.`,
    );
  return resultat;
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

/** `GET /api/collections`, au mieux : `[]` sur toute panne pour que le front continue de s'afficher. */
export async function listCollections(
  url: string | null = null,
  token: string | null = null,
  timeoutS = 5.0,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const cible = (url || getServiceUrl() || "").replace(/\/+$/, "");
  if (!cible) return [];
  try {
    const r = await lireJson(`${cible}/api/collections`, jetonPour(url, token), timeoutS, signal);
    const texte = await r.body.text();
    if (r.statusCode !== 200) return [];
    const data = parseJsonPy(texte);
    if (Array.isArray(data)) return data;
    if (estDict(data)) {
      const cols = data["collections"];
      if (Array.isArray(cols)) {
        const presents = cols.filter((c) => veritePy(c));
        if (presents.some((c) => typeof c !== "string" && !estDict(c))) return [];
        return presents.map((c) => (typeof c === "string" ? c : (lire(c, "name") ?? "")));
      }
    }
    return [];
  } catch {
    return [];
  }
}
