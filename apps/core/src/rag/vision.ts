// SPDX-License-Identifier: MIT
/** apps/core/src/rag/vision.ts — sonde du serveur de vision de l'OCR (`GET /v1/models`) pour l'essai de la console et `./elpis doctor`. */

/** Modèles annoncés par un serveur de vision OpenAI-compatible (`GET /v1/models`, clé en Bearer), ou le motif d'échec lisible. */
export async function modelesVision(
  url: string,
  cle: string,
  delaiMs: number,
): Promise<{ modeles: string[] } | { erreur: string }> {
  let r: Response;
  try {
    r = await fetch(`${url.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/models`, {
      headers: { accept: "application/json", ...(cle ? { authorization: `Bearer ${cle}` } : {}) },
      signal: AbortSignal.timeout(delaiMs),
      redirect: "error",
    });
  } catch {
    return { erreur: "Serveur OCR injoignable." };
  }
  if (r.status === 401 || r.status === 403)
    return { erreur: `Clé refusée par le serveur OCR (HTTP ${r.status}).` };
  if (!r.ok) return { erreur: `Serveur OCR : HTTP ${r.status}.` };
  const corps = (await r.json().catch(() => null)) as { data?: unknown; models?: unknown } | null;
  const liste: unknown[] = Array.isArray(corps?.data)
    ? corps.data
    : Array.isArray(corps?.models)
      ? corps.models
      : [];
  const nom = (m: unknown): string => {
    if (typeof m === "string") return m;
    const o = m !== null && typeof m === "object" ? (m as Record<string, unknown>) : {};
    return typeof o["id"] === "string" ? o["id"] : typeof o["name"] === "string" ? o["name"] : "";
  };
  return { modeles: liste.map(nom).filter((m) => m !== "") };
}
