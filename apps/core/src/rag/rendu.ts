// SPDX-License-Identifier: MIT
/** apps/core/src/rag/rendu.ts — client de l'extracteur pour la visionneuse : rendu WebP d'une page (`/api/render`) et localisation d'un passage (`/api/locate`) ; erreurs rendues en refus de route. */
import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import { getServiceToken, getServiceUrl } from "./client";
import { ErreurRouteRag } from "./http";

const CONNEXION_MS = 5_000;
const DELAI_RENDU_MS = 200_000;
const DELAI_LOCALISATION_MS = 70_000;
const IMAGE_MAX_OCTETS = 32 * 1024 * 1024;
export const DPI_RENDU = 110;

export interface RenduPage {
  readonly octets: Buffer;
  readonly pages: number | null;
  readonly largeur: number | null;
  readonly hauteur: number | null;
}

export interface LocalisationExtracteur {
  readonly page: number | null;
  readonly boites: [number, number, number, number][];
  readonly score: number;
  readonly largeur: number | null;
  readonly hauteur: number | null;
}

const INDISPONIBLE = (): ErreurRouteRag =>
  new ErreurRouteRag(
    503,
    "extracteur_indisponible",
    "L'extracteur de documents est momentanément indisponible.",
  );

function detailDe(corps: string): { code: string; message: string } {
  try {
    const j = JSON.parse(corps) as unknown;
    const d = j !== null && typeof j === "object" ? (j as Record<string, unknown>)["detail"] : undefined;
    if (d !== null && typeof d === "object") {
      const o = d as Record<string, unknown>;
      return { code: String(o["code"] ?? ""), message: String(o["message"] ?? "") };
    }
  } catch {
    return { code: "", message: "" };
  }
  return { code: "", message: "" };
}

/** Réponse d'erreur de l'extracteur rendue en refus de route : page absente, fichier absent, document non affichable, ou service indisponible. */
function erreurHttp(statut: number, corps: string): ErreurRouteRag {
  const { code } = detailDe(corps);
  if (statut === 404 && code === "page_out_of_range")
    return new ErreurRouteRag(404, "page_introuvable", "Cette page n'existe pas dans le document.");
  if (statut === 404)
    return new ErreurRouteRag(404, "document_introuvable", "Le fichier source est introuvable.");
  if ([413, 415, 422].includes(statut))
    return new ErreurRouteRag(422, "rendu_impossible", "Ce document ne peut pas être affiché en pages.");
  return INDISPONIBLE();
}

async function lireBorne(corps: AsyncIterable<Uint8Array>, max: number): Promise<Buffer | null> {
  const morceaux: Buffer[] = [];
  let total = 0;
  for await (const m of corps) {
    total += m.byteLength;
    if (total > max) return null;
    morceaux.push(Buffer.from(m));
  }
  return Buffer.concat(morceaux);
}

/** POST JSON à l'extracteur avec son jeton ; le jeton ne part qu'à l'adresse configurée. */
async function appeler(
  chemin: string,
  corps: Record<string, unknown>,
  delaiMs: number,
  signal: AbortSignal | undefined,
): Promise<{ r: Dispatcher.ResponseData; agent: Agent }> {
  const base = getServiceUrl().replace(/\/+$/u, "");
  if (base === "") throw INDISPONIBLE();
  const jeton = getServiceToken();
  const agent = new Agent({ connect: { timeout: CONNEXION_MS } });
  try {
    const r = await request(`${base}${chemin}`, {
      method: "POST",
      dispatcher: agent,
      headers: { "content-type": "application/json", ...(jeton ? { authorization: `Bearer ${jeton}` } : {}) },
      body: JSON.stringify(corps),
      headersTimeout: delaiMs,
      bodyTimeout: delaiMs,
      ...(signal ? { signal } : {}),
    });
    return { r, agent };
  } catch {
    void agent.close().catch(() => undefined);
    if (signal?.aborted) throw signal.reason;
    throw INDISPONIBLE();
  }
}

const entete = (r: Dispatcher.ResponseData, nom: string): number | null => {
  const v = Number(r.headers[nom]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** Rendu WebP de la page `page` (à partir de 1) d'une source du magasin (chemin RELATIF à la racine du magasin). */
export async function rendrePageExtracteur(o: {
  source: string;
  ext: string;
  page: number;
  signal?: AbortSignal | undefined;
}): Promise<RenduPage> {
  const { r, agent } = await appeler(
    "/api/render",
    { source: o.source, ext: o.ext, page: o.page, dpi: DPI_RENDU },
    DELAI_RENDU_MS,
    o.signal,
  );
  try {
    if (r.statusCode !== 200)
      throw erreurHttp(r.statusCode, (await lireBorne(r.body, 65_536))?.toString("utf8") ?? "");
    const octets = await lireBorne(r.body, IMAGE_MAX_OCTETS);
    if (octets === null || octets.length === 0)
      throw new ErreurRouteRag(422, "rendu_impossible", "Ce document ne peut pas être affiché en pages.");
    return {
      octets,
      pages: entete(r, "x-rag-pages"),
      largeur: entete(r, "x-rag-page-width"),
      hauteur: entete(r, "x-rag-page-height"),
    };
  } catch (e) {
    if (e instanceof ErreurRouteRag) throw e;
    if (o.signal?.aborted) throw o.signal.reason;
    throw INDISPONIBLE();
  } finally {
    await r.body.dump().catch(() => undefined);
    void agent.close().catch(() => undefined);
  }
}

function boiteDe(v: unknown): [number, number, number, number] | null {
  return Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number" && Number.isFinite(x))
    ? [v[0] as number, v[1] as number, v[2] as number, v[3] as number]
    : null;
}

/** Page et rectangles (points PDF) d'un passage dans le rendu du document ; `page: null` si l'extracteur ne le retrouve pas. */
export async function localiserExtracteur(o: {
  source: string;
  ext: string;
  texte: string;
  pageIndice?: number | undefined;
  signal?: AbortSignal | undefined;
}): Promise<LocalisationExtracteur> {
  const { r, agent } = await appeler(
    "/api/locate",
    {
      source: o.source,
      ext: o.ext,
      text: o.texte,
      ...(o.pageIndice === undefined ? {} : { page_hint: o.pageIndice }),
    },
    DELAI_LOCALISATION_MS,
    o.signal,
  );
  try {
    const corps = (await lireBorne(r.body, 4 * 1024 * 1024))?.toString("utf8") ?? "";
    if (r.statusCode !== 200) throw erreurHttp(r.statusCode, corps);
    const j = JSON.parse(corps) as unknown;
    const m = j !== null && typeof j === "object" ? (j as Record<string, unknown>) : {};
    const page =
      typeof m["page"] === "number" && Number.isInteger(m["page"]) && m["page"] >= 1 ? m["page"] : null;
    const boites: [number, number, number, number][] = [];
    if (Array.isArray(m["boxes"]))
      for (const b of m["boxes"]) {
        const boite = boiteDe(b);
        if (boite !== null) boites.push(boite);
      }
    const score = typeof m["score"] === "number" && Number.isFinite(m["score"]) ? m["score"] : 0;
    const dim = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    return {
      page,
      boites: page === null ? [] : boites,
      score,
      largeur: dim(m["page_width"]),
      hauteur: dim(m["page_height"]),
    };
  } catch (e) {
    if (e instanceof ErreurRouteRag) throw e;
    if (o.signal?.aborted) throw o.signal.reason;
    throw INDISPONIBLE();
  } finally {
    await r.body.dump().catch(() => undefined);
    void agent.close().catch(() => undefined);
  }
}
