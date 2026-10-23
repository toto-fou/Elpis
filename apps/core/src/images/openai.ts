// SPDX-License-Identifier: MIT
/** apps/core/src/images/openai.ts — moteur « OpenAI-compatible » : `/v1/images/generations` et `/edits`, appel synchrone sans file visible. */
import { comparePointsDeCode, rstripPy, strPy, veritePy } from "@elpis/commun";

import { CancelledError } from "../llm/client-http";
import { estDict, lire } from "../python";
import type { Dict } from "../python";
import { HINT_ADMIN, HORLOGES_SYSTEME, ImageError, toResult } from "./base";
import type { Horloges, ImageProvider, ImageRequest, ImageResult, ModeleImage, SuiviProgres } from "./base";
import { engineOrigin } from "./config";
import { avecClient, fetch, jsonBody, LARGE_BYTES, raiseForStatus } from "./http";
import type { ClientImages } from "./http";

/** `^gpt-image` sous `re.I` de Python : le `i` y reconnaît aussi « ı » et « İ ». */
const SANS_RESPONSE_FORMAT = /^gpt-[iıİ]mage/iu;
/** Plafond d'une image téléchargée par URL. */
const MAX_DOWNLOAD = 40 * 1024 * 1024;

/** Base « http://h:port », « …/v1 » ou route complète. */
export function endpoint(base: string, suffix: string): string {
  const b = (base || "").replace(/\/+$/, "");
  if (b.endsWith(suffix)) return b;
  if (b.endsWith("/v1")) return b + suffix.slice(3);
  return b + suffix;
}

export type OptionsOpenAI = {
  model?: string;
  apiKey?: string;
  timeoutSec?: number;
  verify?: boolean;
  caPem?: string;
  horloges?: Horloges;
};

const annule = (): ImageError => new ImageError("Génération annulée.", { code: "cancelled" });

export class OpenAIProvider implements ImageProvider {
  readonly url: string;
  readonly model: string;
  readonly timeoutSec: number;
  readonly verify: boolean;
  readonly caPem: string;
  private readonly entetes: Record<string, string>;
  private readonly horloges: Horloges;

  constructor(url: string, options: OptionsOpenAI = {}) {
    this.url = rstripPy(url || "", "/");
    this.model = options.model ?? "";
    this.timeoutSec = Math.trunc(options.timeoutSec ?? 180);
    this.verify = options.verify ?? true;
    this.caPem = options.caPem ?? "";
    this.entetes = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
    this.horloges = options.horloges ?? HORLOGES_SYSTEME;
  }

  private avec<T>(timeout: number, fn: (c: ClientImages) => Promise<T>): Promise<T> {
    return avecClient(timeout, { verify: this.verify, caPem: this.caPem }, fn);
  }

  private endpoint(suffix: string): string {
    if (!this.url) throw new ImageError("Aucune adresse configurée. " + HINT_ADMIN, { code: "unavailable" });
    return endpoint(this.url, suffix);
  }

  async capabilities(signal?: AbortSignal): Promise<Dict> {
    const models = await this.listModels(signal);
    return { model: this.model, mode: "img_gen", limits: {}, defaults: {}, models: models.map((m) => m.id) };
  }

  async listModels(signal?: AbortSignal): Promise<ModeleImage[]> {
    const r = await this.avec(10.0, (c) =>
      fetch(c, "GET", this.endpoint("/v1/models"), { headers: this.entetes, signal }),
    );
    raiseForStatus(r, "models");
    const data = jsonBody(r, "models");
    const items = estDict(data) ? lire(data, "data") : undefined;
    if (!Array.isArray(items)) throw new ImageError("Liste de modèles illisible.", { code: "engine" });
    const ids = new Set<string>();
    for (const m of items) if (estDict(m) && veritePy(lire(m, "id"))) ids.add(strPy(lire(m, "id")));
    return [...ids].sort(comparePointsDeCode).map((id) => ({ id, label: id }));
  }

  /** Champs envoyés : `response_format` sauf pour gpt-image (base64 d'office). */
  buildPayload(req: ImageRequest): Dict {
    const p: Dict = { prompt: req.prompt, n: Math.max(1, req.n), size: `${req.width}x${req.height}` };
    if (this.model) p["model"] = this.model;
    if (!SANS_RESPONSE_FORMAT.test(this.model || "")) p["response_format"] = "b64_json";
    return p;
  }

  /** Le délai couvre tout l'appel ; Stop abandonne la requête (le calcul distant continue). */
  async generate(req: ImageRequest, onProgress: SuiviProgres, signal?: AbortSignal): Promise<ImageResult[]> {
    return this.avec(this.timeoutSec, async (c) => {
      await onProgress("generating", null, { started_at: this.horloges.murale() });
      const what = req.initImage ? "images/edits" : "images/generations";
      const r = await this.appelBorne(c, req, signal);
      raiseForStatus(r, what);
      const body = jsonBody(r, what);
      const items = estDict(body) ? lire(body, "data") : undefined;
      if (!Array.isArray(items) || items.length === 0)
        throw new ImageError("Le moteur n'a renvoyé aucune image.", { code: "engine" });
      const out: ImageResult[] = [];
      for (const item of items.slice(0, Math.max(1, req.n))) {
        if (!estDict(item)) continue;
        let raw: unknown;
        if (veritePy(lire(item, "b64_json"))) raw = lire(item, "b64_json");
        else if (veritePy(lire(item, "url"))) raw = await this.download(c, strPy(lire(item, "url")), signal);
        else continue;
        const revise = lire(item, "revised_prompt");
        out.push(
          toResult(raw, [req.width, req.height], { revisedPrompt: strPy(veritePy(revise) ? revise : "") }),
        );
      }
      if (out.length === 0) throw new ImageError("Le moteur n'a renvoyé aucune image.", { code: "engine" });
      return out;
    });
  }

  /** Requête unique, abandonnée sur Stop ou au-delà du délai de l'administrateur. */
  private async appelBorne(c: ClientImages, req: ImageRequest, signal: AbortSignal | undefined) {
    if (signal?.aborted) throw annule();
    const controleur = new AbortController();
    let cause: ImageError | null = null;
    const couper = (e: ImageError): void => {
      cause ??= e;
      controleur.abort(e);
    };
    const surStop = (): void => couper(annule());
    signal?.addEventListener("abort", surStop, { once: true });
    const minuterie = setTimeout(
      () =>
        couper(new ImageError(`Génération trop longue (plus de ${this.timeoutSec} s).`, { code: "timeout" })),
      Math.max(1, this.timeoutSec * 1000),
    );
    try {
      const charge = this.buildPayload(req);
      if (req.initImage) {
        const champs = Object.entries(charge).map(([k, v]) => [k, strPy(v)] as const);
        return await fetch(c, "POST", this.endpoint("/v1/images/edits"), {
          headers: this.entetes,
          limit: LARGE_BYTES,
          multipart: {
            champs,
            fichiers: [{ nom: "image", nomFichier: "source.png", type: "image/png", data: req.initImage }],
          },
          signal: controleur.signal,
        });
      }
      return await fetch(c, "POST", this.endpoint("/v1/images/generations"), {
        headers: this.entetes,
        limit: LARGE_BYTES,
        json: charge,
        signal: controleur.signal,
      });
    } catch (e) {
      if (cause !== null && e instanceof CancelledError) throw cause;
      throw e;
    } finally {
      clearTimeout(minuterie);
      signal?.removeEventListener("abort", surStop);
    }
  }

  /** Image renvoyée par URL : téléchargée ici, sans la clé, et seulement sur l'origine du moteur configuré. */
  private async download(c: ClientImages, url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const origin = engineOrigin(url);
    if (!origin || origin !== engineOrigin(this.url))
      throw new ImageError("Adresse d'image invalide renvoyée par le moteur.", {
        code: "engine",
        detail: [...url].slice(0, 200).join(""),
      });
    try {
      const r = await fetch(c, "GET", url, { limit: MAX_DOWNLOAD, signal });
      if (r.statusCode !== 200)
        throw new ImageError("Image introuvable à l'adresse renvoyée.", {
          code: "engine",
          detail: `HTTP ${r.statusCode}`,
        });
      return r.content;
    } catch (e) {
      if (e instanceof CancelledError) throw annule();
      throw e;
    }
  }
}
