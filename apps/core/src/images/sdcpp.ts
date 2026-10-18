// SPDX-License-Identifier: MIT
/** apps/core/src/images/sdcpp.ts — API native `/sdcpp/v1` de sd-server : soumission, sondage du job (file, avancée réelle), annulation. */
import { randomInt } from "node:crypto";

import { arrondiPy, FlottantPy, maxPy, minPy, strPy, veritePy } from "@elpis/commun";

import { journal } from "../journal";
import { CancelledError } from "../llm/client-http";
import { estDict, lire } from "../python";
import type { Dict } from "../python";
import { dataUrl, HINT_ADMIN, HORLOGES_SYSTEME, ImageError, QUEUE_MAX_S, toResult } from "./base";
import type {
  Horloges,
  ImageProvider,
  ImageRequest,
  ImageResult,
  InfoProgres,
  ModeleImage,
  SuiviProgres,
} from "./base";
import { avecClient, fetch, jsonBody, LARGE_BYTES, raiseForStatus } from "./http";
import type { ClientImages } from "./http";

const log = journal("image");
/** Sondage rapide au début (une image Turbo sort en quelques secondes), plus lâche ensuite. */
export const POLL_FIRST = 0.5;
export const POLL_MAX = 2.0;
const TERMINAUX = new Set(["completed", "failed", "cancelled"]);

const PAIRES = /[\ud800-\udbff][\udc00-\udfff]/g;

/** `s[-n:]` en points de code, sans éclater un aperçu de 2 Mo en tableau. */
function finPy(s: string, n: number): string {
  let i = s.length;
  for (let k = 0; k < n && i > 0; k++) {
    const [bas, haut] = [s.charCodeAt(i - 1), i >= 2 ? s.charCodeAt(i - 2) : 0];
    i -= bas >= 0xdc00 && bas <= 0xdfff && haut >= 0xd800 && haut <= 0xdbff ? 2 : 1;
  }
  return s.slice(i);
}

/** `isinstance(x, (int, float))` : booléens compris, comme en Python. */
function estNombrePy(x: unknown): boolean {
  return typeof x === "number" || typeof x === "boolean" || typeof x === "bigint" || x instanceof FlottantPy;
}

function valeurPy(x: unknown): number {
  if (x instanceof FlottantPy) return x.valeur;
  if (typeof x === "boolean") return x ? 1 : 0;
  return Number(x);
}

/** `isinstance(x, int)` : entier JSON ou booléen ; un flottant entier (`2.0`) n'en est pas un. */
export function estEntierPy(x: unknown): boolean {
  return typeof x === "boolean" || typeof x === "bigint" || (typeof x === "number" && Number.isInteger(x));
}

/** `d.get(a, d.get(b, d.get(c)))`. */
function premier(d: Dict, ...cles: string[]): unknown {
  for (const c of cles) if (Object.hasOwn(d, c)) return d[c];
  return null;
}

export type InfoJob = InfoProgres & { preview_key?: string };

/** Ce que le job dit vraiment de son avancée : `started`, progression (0–1, 0–100 ou étapes), aperçu ; rien d'inventé. */
export function progressInfo(job: Dict): InfoJob {
  const out: InfoJob = {};
  const started = lire(job, "started");
  if (estNombrePy(started) && valeurPy(started) > 0) out.started_at = valeurPy(started);
  const prog = lire(job, "progress");
  let step: unknown = null;
  let steps: unknown = null;
  let pct: number | null = null;
  if (estDict(prog)) {
    step = premier(prog, "step", "current_step", "current");
    steps = premier(prog, "steps", "total_steps", "total");
    const frac = premier(prog, "fraction", "percent");
    if (estNombrePy(frac)) pct = valeurPy(frac) <= 1 ? valeurPy(frac) * 100 : valeurPy(frac);
  } else if (estNombrePy(prog) && typeof prog !== "boolean") {
    pct = valeurPy(prog) <= 1 ? valeurPy(prog) * 100 : valeurPy(prog);
  }
  if (step === null) {
    step = premier(job, "step", "current_step");
    steps = premier(job, "steps", "total_steps");
  }
  if (pct === null && estNombrePy(step) && estNombrePy(steps) && valeurPy(steps) > 0)
    pct = (100.0 * valeurPy(step)) / valeurPy(steps);
  if (pct !== null) out.pct = maxPy(0.0, minPy(100.0, pct));
  let prev: unknown = lire(job, "preview") ?? null;
  if (prev === null && estDict(prog)) prev = lire(prog, "preview") ?? null;
  if (estDict(prev)) prev = veritePy(lire(prev, "b64_json")) ? lire(prev, "b64_json") : lire(prev, "data");
  if (typeof prev === "string") {
    const n = prev.length - (prev.match(PAIRES) ?? []).length;
    if (32 < n && n <= 2_000_000) {
      out.preview = prev.startsWith("data:image/") ? prev : "data:image/png;base64," + prev;
      out.preview_key = `${n}:${finPy(prev, 48)}`;
    }
  }
  return out;
}

export type OptionsSdcpp = {
  timeoutSec?: number;
  verify?: boolean;
  caPem?: string;
  apiKey?: string;
  horloges?: Horloges;
  /** Cadence de sondage (secondes) : première attente et plafond. */
  sondage?: { premier: number; max: number };
  /** Délais de lecture (secondes) : capacités 10, soumission et sondage 30, annulation 5. */
  delais?: Partial<DelaisSdcpp>;
  /** Graine tirée quand la demande n'en donne pas (1 à 2³¹ − 1). */
  tirerGraine?: () => number;
};

export type DelaisSdcpp = { capacites: number; sondage: number; annulation: number };
const DELAIS: DelaisSdcpp = { capacites: 10.0, sondage: 30.0, annulation: 5.0 };

const annule = (): ImageError => new ImageError("Génération annulée.", { code: "cancelled" });

/** Attente interrompue par Stop. */
function dormir(s: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((ok, ko) => {
    if (signal?.aborted) {
      ko(annule());
      return;
    }
    const surStop = (): void => {
      clearTimeout(minuterie);
      ko(annule());
    };
    const minuterie = setTimeout(
      () => {
        signal?.removeEventListener("abort", surStop);
        ok();
      },
      Math.max(0, s * 1000),
    );
    signal?.addEventListener("abort", surStop, { once: true });
  });
}

export class SdcppProvider implements ImageProvider {
  readonly url: string;
  readonly timeoutSec: number;
  readonly verify: boolean;
  readonly caPem: string;
  private readonly entetes: Record<string, string>;
  private readonly horloges: Horloges;
  private readonly sondage: { premier: number; max: number };
  private readonly delais: DelaisSdcpp;
  private readonly tirerGraine: () => number;

  constructor(url: string, options: OptionsSdcpp = {}) {
    this.url = (url || "").replace(/\/+$/, "");
    this.timeoutSec = Math.trunc(options.timeoutSec ?? 180);
    this.verify = options.verify ?? true;
    this.caPem = options.caPem ?? "";
    this.entetes = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
    this.horloges = options.horloges ?? HORLOGES_SYSTEME;
    this.sondage = options.sondage ?? { premier: POLL_FIRST, max: POLL_MAX };
    this.delais = { ...DELAIS, ...options.delais };
    this.tirerGraine = options.tirerGraine ?? (() => randomInt(1, 2 ** 31));
  }

  private avec<T>(timeout: number, fn: (c: ClientImages) => Promise<T>): Promise<T> {
    return avecClient(timeout, { verify: this.verify, caPem: this.caPem }, fn);
  }

  private chemin(path: string): string {
    if (!this.url) throw new ImageError("Aucune adresse configurée. " + HINT_ADMIN, { code: "unavailable" });
    return this.url + path;
  }

  async capabilities(signal?: AbortSignal): Promise<Dict> {
    const r = await this.avec(this.delais.capacites, (c) =>
      fetch(c, "GET", this.chemin("/sdcpp/v1/capabilities"), { headers: this.entetes, signal }),
    );
    raiseForStatus(r, "capabilities");
    const data = jsonBody(r, "capabilities");
    if (!estDict(data))
      throw new ImageError("Réponse illisible : est-ce bien un sd-server ?", { code: "engine" });
    const brut = lire(data, "model");
    const model: Dict = estDict(brut) ? brut : {};
    const parMode = lire(data, "defaults_by_mode");
    const defauts = estDict(parMode) ? lire(parMode, "img_gen") : null;
    const limites = lire(data, "limits");
    const nom =
      [lire(model, "stem"), lire(model, "name"), lire(data, "model_name")].find((v) => veritePy(v)) ?? "";
    const mode = lire(data, "current_mode");
    return {
      model: strPy(nom),
      mode: strPy(veritePy(mode) ? mode : ""),
      limits: estDict(limites) ? limites : {},
      defaults: estDict(defauts) ? defauts : {},
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModeleImage[]> {
    const caps = await this.capabilities(signal);
    const nom = strPy(veritePy(caps["model"]) ? caps["model"] : "");
    return [{ id: nom, label: nom || "(modèle chargé)" }];
  }

  /** Charge utile `img_gen` : étapes et cfg restent les défauts du modèle tant que l'utilisateur ne les change pas. */
  buildPayload(req: ImageRequest): Dict {
    const p: Dict = {
      prompt: req.prompt,
      width: req.width,
      height: req.height,
      seed: req.seed,
      batch_count: Math.max(1, req.n),
      output_format: "png",
    };
    if (req.negativePrompt) p["negative_prompt"] = req.negativePrompt;
    if (req.steps > 0) p["sample_params"] = { sample_steps: Math.min(req.steps, 200) };
    if (req.initImage && req.initImage.length > 0) {
      if (req.editMode === "ref") p["ref_images"] = [dataUrl(req.initImage)];
      else {
        p["init_image"] = dataUrl(req.initImage);
        p["strength"] = new FlottantPy(
          arrondiPy(Math.min(Math.max(veritePy(req.strength) ? req.strength : 0.75, 0.05), 1.0), 2),
        );
      }
    }
    return p;
  }

  /** Délai de calcul compté depuis le début du calcul ; attente en file bornée à part ; Stop annule le job (en file) ou l'abandonne (en cours). */
  async generate(req: ImageRequest, onProgress: SuiviProgres, signal?: AbortSignal): Promise<ImageResult[]> {
    if (req.seed < 0) req.seed = this.tirerGraine();
    const h = this.horloges;
    const tSubmit = h.monotone();
    return this.avec(this.delais.sondage, async (c) => {
      const r = await this.requete(c, "POST", "/sdcpp/v1/img_gen", { json: this.buildPayload(req) }, signal);
      raiseForStatus(r, "img_gen");
      const job = jsonBody(r, "img_gen");
      if (!estDict(job) || !veritePy(lire(job, "id")))
        throw new ImageError("Réponse de soumission illisible.", { code: "engine" });
      const jobId = strPy(lire(job, "id"));
      let terminal = false;
      let genT0: number | null = null;
      let dernier = "";
      let delai = this.sondage.premier;
      try {
        for (;;) {
          if (signal?.aborted) throw annule();
          const maintenant = h.monotone();
          if (genT0 !== null && maintenant - genT0 > this.timeoutSec)
            throw new ImageError(`Génération trop longue (plus de ${this.timeoutSec} s).`, {
              code: "timeout",
            });
          if (genT0 === null && maintenant - tSubmit > QUEUE_MAX_S + this.timeoutSec)
            throw new ImageError("File d'attente du moteur trop longue.", { code: "busy" });
          const rj = await this.requete(c, "GET", `/sdcpp/v1/jobs/${jobId}`, { limit: LARGE_BYTES }, signal);
          if (rj.statusCode === 404 || rj.statusCode === 410) {
            terminal = true;
            throw new ImageError("Le moteur a perdu la génération (redémarré ?).", {
              code: "engine",
              status: rj.statusCode,
            });
          }
          raiseForStatus(rj, "jobs");
          const st = jsonBody(rj, "jobs");
          if (!estDict(st)) throw new ImageError("État de génération illisible.", { code: "engine" });
          const status = strPy(veritePy(lire(st, "status")) ? lire(st, "status") : "");
          if (TERMINAUX.has(status)) terminal = true;
          if (status === "completed") return this.resultats(lire(st, "result"), req);
          if (status === "failed") {
            const err = lire(st, "error");
            const msg = estDict(err) ? lire(err, "message") : err;
            throw new ImageError("Le moteur n'a pas pu générer l'image.", {
              code: "refused",
              detail: [...strPy(veritePy(msg) ? msg : "")].slice(0, 300).join(""),
            });
          }
          if (status === "cancelled")
            throw new ImageError("Génération annulée par le moteur.", { code: "cancelled" });
          const qp = lire(st, "queue_position");
          const info = progressInfo(st);
          if (status === "generating" && genT0 === null) {
            const started = info.started_at;
            let lag = started ? Math.max(0.0, h.murale() - started) : 0.0;
            lag = Math.min(lag, h.monotone() - tSubmit);
            genT0 = h.monotone() - lag;
          }
          const position = estEntierPy(qp) ? qp : null;
          const cle = JSON.stringify([
            status,
            position === null ? null : valeurPy(position),
            info.pct ?? null,
            info.preview_key ?? null,
          ]);
          if (cle !== dernier) {
            dernier = cle;
            delete info.preview_key;
            await onProgress(status || "queued", position, info);
          }
          await dormir(delai, signal);
          delai = Math.min(this.sondage.max, delai * 1.5);
        }
      } catch (e) {
        if (!terminal) await this.annuler(jobId);
        throw e;
      }
    });
  }

  /** Requête d'un job : Stop devient `ImageError` « cancelled ». */
  private async requete(
    c: ClientImages,
    methode: string,
    path: string,
    options: { json?: unknown; limit?: number },
    signal: AbortSignal | undefined,
  ) {
    try {
      return await fetch(c, methode, this.chemin(path), { ...options, headers: this.entetes, signal });
    } catch (e) {
      if (e instanceof CancelledError) throw annule();
      throw e;
    }
  }

  /** Libère le serveur après Stop, délai ou départ du client ; jamais interrompu par un second Stop. */
  private async annuler(jobId: string): Promise<void> {
    let r;
    try {
      r = await this.avec(this.delais.annulation, (c) =>
        fetch(c, "POST", this.chemin(`/sdcpp/v1/jobs/${jobId}/cancel`), { headers: this.entetes }),
      );
    } catch (e) {
      const detail = e instanceof ImageError ? e.detail || e.message : String(e);
      log.info(`annulation du job ${jobId} impossible : ${detail}`);
      return;
    }
    if (r.statusCode === 409) log.info(`job ${jobId} déjà en calcul : abandonné, résultat ignoré`);
  }

  private resultats(result: unknown, req: ImageRequest): ImageResult[] {
    const images = estDict(result) ? lire(result, "images") : null;
    if (!Array.isArray(images) || images.length === 0)
      throw new ImageError("Le moteur n'a renvoyé aucune image.", { code: "engine" });
    return images.map((item, i) => {
      const raw = estDict(item) ? lire(item, "b64_json") : item;
      return toResult(raw, [req.width, req.height], { seed: req.seed >= 0 ? req.seed + i : null });
    });
  }
}
