// SPDX-License-Identifier: MIT
/** packages/rag/src/reseau.ts — appel HTTP commun (fetch injectable) : délai, abandon, corps lu, erreurs typées. */
import { ErreurRag } from "./erreurs";
import type { CodeErreurRag } from "./erreurs";

export type FetchRag = typeof fetch;

export type Origine = "qdrant" | "embeddings" | "reranker";

export interface AppelHttp {
  fetch: FetchRag;
  origine: Origine;
  methode: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  corps?: unknown;
  entetes?: Readonly<Record<string, string>>;
  signal?: AbortSignal | undefined;
  delaiMs: number;
}

export interface ReponseHttp {
  statut: number;
  texte: string;
  entetes: Headers;
}

const EXTRAIT_MAX = 300;

/** Un appel HTTP : corps JSON, délai et abandon combinés ; l'abandon de l'appelant est relancé tel quel. */
export async function appeler(a: AppelHttp): Promise<ReponseHttp> {
  const delai = AbortSignal.timeout(Math.max(1, a.delaiMs));
  const signal = a.signal ? AbortSignal.any([a.signal, delai]) : delai;
  const entetes: Record<string, string> = { ...a.entetes };
  const init: RequestInit = { method: a.methode, signal, headers: entetes };
  if (a.corps !== undefined) {
    entetes["content-type"] = "application/json";
    init.body = JSON.stringify(a.corps);
  }
  try {
    const rep = await a.fetch(a.url, init);
    const texte = await rep.text();
    return { statut: rep.status, texte, entetes: rep.headers };
  } catch (e) {
    if (a.signal?.aborted) throw a.signal.reason ?? e;
    if (delai.aborted) {
      throw new ErreurRag(
        "delai",
        `${a.origine} : délai de ${a.delaiMs} ms dépassé (${a.methode} ${chemin(a.url)})`,
      );
    }
    const code: CodeErreurRag = `${a.origine}_injoignable`;
    throw new ErreurRag(code, `${a.origine} injoignable (${chemin(a.url)}) : ${detail(e)}`, undefined, e);
  }
}

/** `url.rstrip("/")` sans regex. */
export function sansBarresFinales(url: string): string {
  let fin = url.length;
  while (fin > 0 && url.charCodeAt(fin - 1) === 0x2f) fin--;
  return url.slice(0, fin);
}

/** Chemin d'une URL sans l'hôte ni les paramètres (messages d'erreur). */
export function chemin(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Cause lisible d'une erreur réseau (`ECONNREFUSED` plutôt que « fetch failed »). */
export function detail(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? `${code} ${cause.message}` : cause.message;
  }
  return e.message;
}

/** Corps de réponse tronqué pour un message d'erreur. */
export function extrait(texte: string): string {
  const t = texte.trim().replace(/\s+/g, " ");
  return t.length > EXTRAIT_MAX ? `${t.slice(0, EXTRAIT_MAX)}…` : t;
}

/** JSON d'un corps de réponse, ou `undefined` s'il n'est pas du JSON. */
export function jsonOuNul(texte: string): unknown {
  try {
    return JSON.parse(texte) as unknown;
  } catch {
    return undefined;
  }
}

/** Attente annulable (reprises) ; rejette avec la raison du signal. */
export function dormir(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as unknown);
      return;
    }
    const fin = (): void => {
      signal?.removeEventListener("abort", abandon);
      resolve();
    };
    const minuterie = setTimeout(fin, Math.max(0, ms));
    const abandon = (): void => {
      clearTimeout(minuterie);
      reject(signal?.reason as unknown);
    };
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

export function estObjet(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
