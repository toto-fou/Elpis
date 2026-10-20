// SPDX-License-Identifier: MIT
/** apps/core/src/rag/extracteur.ts — client de l'extracteur Python (`POST /api/extract`, flux NDJSON) : chemins relatifs au magasin, délai, abandon, erreurs classées (document, panne du service, douteux). */
import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import { configRag } from "@elpis/config";
import type { ConfigRag } from "@elpis/config";
import type { Bloc, Boite, GenreBloc } from "@elpis/rag";

import { getServiceToken, getServiceUrl } from "./client";

/** `document` : échec propre au fichier ; `panne` : service indisponible (réessayer plus tard) ; `douteux` : flux coupé ou invalide (essais comptés). */
export type NatureErreurExtraction = "document" | "panne" | "douteux";

export class ErreurExtraction extends Error {
  override name = "ErreurExtraction";
  readonly code: string;
  readonly nature: NatureErreurExtraction;
  constructor(code: string, nature: NatureErreurExtraction, message: string) {
    super(message);
    this.code = code;
    this.nature = nature;
  }
}

export interface MetaExtraction {
  readonly pages: number | null;
  readonly title: string | null;
  readonly text_layer: boolean;
  readonly mime: string;
}

export interface AvertissementExtraction {
  readonly code: string;
  readonly message: string;
}

export interface ResultatExtraction {
  readonly meta: MetaExtraction;
  readonly blocs: Bloc[];
  readonly avertissements: AvertissementExtraction[];
}

export interface OptionsExtraction {
  /** Chemin RELATIF à la racine du magasin (`<uid>/<collection>/sources/<doc>.<ext>`). */
  readonly source: string;
  readonly ext: string;
  readonly ocr?: boolean;
  readonly maxChars?: number;
  readonly signal?: AbortSignal;
  /** Délai total (défaut : `RAG_EXTRACT_TIMEOUT_S` de l'extracteur + 60 s). */
  readonly delaiMs?: number;
  readonly surProgres?: (faits: number, total: number) => void;
  /** Adresse et jeton (défaut : `rag.service_url` et le jeton de service, relus à chaque appel). */
  readonly url?: string;
  readonly jeton?: string;
  /** Modèle de vision des pages scannées (défaut : `rag.ocr`, relu à chaque appel) ; envoyé seulement avec `ocr`. */
  readonly serviceOcr?: ConfigRag["ocr"] | null;
}

/** Réglages OCR à transmettre à l'extracteur, `null` sans adresse configurée. */
export function serviceOcrConfigure(): ConfigRag["ocr"] | null {
  const ocr = configRag().ocr;
  return ocr.url === "" ? null : ocr;
}

/** Codes d'erreur que l'extracteur rend dans la ligne `error` (contrat §5.1). */
export const CODES_EXTRACTION_DOCUMENT: ReadonlySet<string> = new Set([
  "no_text",
  "encrypted",
  "unsupported",
  "too_large",
  "timeout",
  "corrupt",
  "ocr_unavailable",
]);

const GENRES: ReadonlySet<string> = new Set(["heading", "paragraph", "list", "table", "code"]);
const LIGNE_MAX_OCTETS = 256 * 1024 * 1024;
const CONNEXION_MS = 5_000;
const ENTETES_MS = 60_000;
const DELAI_EXTRACTEUR_S = 300;
const MARGE_MS = 60_000;

/** Délai total d'une extraction : celui de l'extracteur (même variable d'environnement) plus une marge. */
export function delaiExtractionMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number((env["RAG_EXTRACT_TIMEOUT_S"] ?? "").trim());
  const s = Number.isFinite(v) && v > 0 && v <= 86_400 ? v : DELAI_EXTRACTEUR_S;
  return s * 1000 + MARGE_MS;
}

function objet(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function entierPositif(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : undefined;
}

function boites(v: unknown): Boite[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Boite[] = [];
  for (const b of v)
    if (Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === "number" && Number.isFinite(x)))
      out.push([b[0] as number, b[1] as number, b[2] as number, b[3] as number]);
  return out.length ? out : undefined;
}

/** Bloc de l'extracteur lu prudemment : genre connu et texte, le reste seulement s'il a la bonne forme. */
export function lireBloc(v: unknown): Bloc | null {
  const o = objet(v);
  if (o === null || typeof o["kind"] !== "string" || !GENRES.has(o["kind"]) || typeof o["text"] !== "string")
    return null;
  const bloc: Bloc = { kind: o["kind"] as GenreBloc, text: o["text"] };
  const niveau = entierPositif(o["level"]);
  const page = entierPositif(o["page"]);
  const slide = entierPositif(o["slide"]);
  const rects = boites(o["boxes"]);
  if (niveau !== undefined) bloc.level = niveau;
  if (page !== undefined) bloc.page = page;
  if (slide !== undefined) bloc.slide = slide;
  if (rects !== undefined) bloc.boxes = rects;
  if (typeof o["sheet"] === "string") bloc.sheet = o["sheet"];
  return bloc;
}

export function lireMeta(v: unknown): MetaExtraction {
  const o = objet(v) ?? {};
  return {
    pages: entierPositif(o["pages"]) ?? null,
    title: typeof o["title"] === "string" ? o["title"] : null,
    text_layer: o["text_layer"] !== false,
    mime: typeof o["mime"] === "string" ? o["mime"] : "",
  };
}

function lireAvertissements(v: unknown): AvertissementExtraction[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a) => {
    const o = objet(a);
    if (o !== null && typeof o["code"] === "string")
      return [{ code: o["code"], message: typeof o["message"] === "string" ? o["message"] : "" }];
    return typeof a === "string" ? [{ code: "warning", message: a }] : [];
  });
}

/** Lignes NDJSON d'un corps, sans recopier le tampon à chaque morceau ; une ligne trop longue est refusée. */
export async function* lignesNdjson(corps: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  let morceaux: Buffer[] = [];
  let taille = 0;
  const dec = (bufs: Buffer[]): string => Buffer.concat(bufs).toString("utf8");
  for await (const brut of corps) {
    let m = Buffer.from(brut.buffer, brut.byteOffset, brut.byteLength);
    for (let i = m.indexOf(0x0a); i >= 0; i = m.indexOf(0x0a)) {
      morceaux.push(m.subarray(0, i));
      const ligne = dec(morceaux).trim();
      morceaux = [];
      taille = 0;
      m = m.subarray(i + 1);
      if (ligne !== "") yield ligne;
    }
    taille += m.byteLength;
    if (taille > LIGNE_MAX_OCTETS)
      throw new ErreurExtraction("too_large", "document", "Résultat d'extraction trop volumineux.");
    if (m.byteLength) morceaux.push(Buffer.from(m));
  }
  const fin = dec(morceaux).trim();
  if (fin !== "") yield fin;
}

async function corpsTexte(r: Dispatcher.ResponseData): Promise<string> {
  try {
    return (await r.body.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/** Erreur HTTP avant le flux : chemin ou fichier refusé = document ; jeton, configuration, 5xx = panne du service. */
function erreurHttp(statut: number, texte: string): ErreurExtraction {
  let code = "";
  try {
    const detail = objet(objet(JSON.parse(texte) as unknown)?.["detail"]);
    if (typeof detail?.["code"] === "string") code = detail["code"];
  } catch {
    // corps illisible : le statut décide
  }
  if (statut === 404 || code === "not_found")
    return new ErreurExtraction(
      "source_missing",
      "document",
      "Fichier source introuvable pour l'extracteur.",
    );
  if (statut === 400 || statut === 422)
    return new ErreurExtraction("internal", "document", `Extracteur : demande refusée (HTTP ${statut}).`);
  return new ErreurExtraction(
    "extractor_unavailable",
    "panne",
    `Extracteur indisponible (HTTP ${statut}${code ? `, ${code}` : ""}).`,
  );
}

/** Extrait un document du magasin : progression rapportée, résultat lu de la dernière ligne ; l'abandon de l'appelant est relancé tel quel. */
export async function extraireDocument(o: OptionsExtraction): Promise<ResultatExtraction> {
  const base = (o.url ?? getServiceUrl()).replace(/\/+$/u, "");
  if (!base)
    throw new ErreurExtraction(
      "extractor_unavailable",
      "panne",
      "Extracteur non configuré (rag.service_url ou RAG_SERVICE_URL).",
    );
  const jeton = o.jeton ?? getServiceToken();
  const serviceOcr = o.ocr ? (o.serviceOcr === undefined ? serviceOcrConfigure() : o.serviceOcr) : null;
  const delai = AbortSignal.timeout(o.delaiMs ?? delaiExtractionMs());
  const signal = o.signal ? AbortSignal.any([o.signal, delai]) : delai;
  const agent = new Agent({ connect: { timeout: CONNEXION_MS } });
  let reponse: Dispatcher.ResponseData | null = null;
  try {
    try {
      reponse = await request(`${base}/api/extract`, {
        method: "POST",
        dispatcher: agent,
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
          ...(jeton ? { authorization: `Bearer ${jeton}` } : {}),
        },
        body: JSON.stringify({
          source: o.source,
          ext: o.ext,
          ocr: o.ocr ?? false,
          ...(o.maxChars ? { max_chars: o.maxChars } : {}),
          ...(serviceOcr ? { ocr_service: serviceOcr } : {}),
        }),
        headersTimeout: ENTETES_MS,
        bodyTimeout: 0,
        signal,
      });
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason;
      throw new ErreurExtraction(
        "extractor_unavailable",
        "panne",
        `Extracteur injoignable : ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (reponse.statusCode !== 200) throw erreurHttp(reponse.statusCode, await corpsTexte(reponse));
    try {
      for await (const ligne of lignesNdjson(reponse.body)) {
        let msg: Record<string, unknown> | null;
        try {
          msg = objet(JSON.parse(ligne) as unknown);
        } catch {
          throw new ErreurExtraction("internal", "douteux", "Ligne illisible dans le flux de l'extracteur.");
        }
        if (msg === null) continue;
        if (msg["type"] === "progress") {
          const faits = Number(msg["done"]);
          const total = Number(msg["total"]);
          if (Number.isFinite(faits) && Number.isFinite(total)) o.surProgres?.(faits, total);
        } else if (msg["type"] === "error") {
          const code = typeof msg["code"] === "string" ? msg["code"] : "corrupt";
          const message = typeof msg["message"] === "string" ? msg["message"] : "";
          throw new ErreurExtraction(
            CODES_EXTRACTION_DOCUMENT.has(code) ? code : "corrupt",
            "document",
            message,
          );
        } else if (msg["type"] === "result") {
          const blocs = Array.isArray(msg["blocks"]) ? msg["blocks"].flatMap((b) => lireBloc(b) ?? []) : [];
          return { meta: lireMeta(msg["meta"]), blocs, avertissements: lireAvertissements(msg["warnings"]) };
        }
      }
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason;
      if (e instanceof ErreurExtraction) throw e;
      if (delai.aborted)
        throw new ErreurExtraction("timeout", "douteux", "Délai de l'extraction dépassé côté core.");
      throw new ErreurExtraction(
        "extractor_unavailable",
        "douteux",
        `Flux de l'extracteur coupé : ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    throw new ErreurExtraction("internal", "douteux", "Flux de l'extracteur terminé sans résultat.");
  } finally {
    if (reponse !== null) await reponse.body.dump().catch(() => undefined);
    void agent.close().catch(() => undefined);
  }
}
