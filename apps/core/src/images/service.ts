// SPDX-License-Identifier: MIT
/** apps/core/src/images/service.ts — orchestration : moteur configuré, capacités en cache, validation, créneaux de la file commune, génération, magasin. */
import { createHash } from "node:crypto";

import { arrondiEntierPy, arrondiPy, ErreurPython, floatPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { prepareSource } from "@elpis/images";

import { base as baseApp } from "../base";
import { journal } from "../journal";
import { LLMCircuitOpen, LLMQueueAborted } from "../llm/ordonnanceur";
import type { Priorite, Slot } from "../llm/ordonnanceur";
import { entierPy, estDict, lire, longueurPy, prefixePy } from "../python";
import type { Dict } from "../python";
import { HINT_ADMIN, HORLOGES_SYSTEME, ImageError, imageRequest, QUEUE_MAX_S } from "./base";
import type { Horloges, ImageProvider, ImageRequest, ImageResult, InfoProgres, SuiviProgres } from "./base";
import { apiKey, effectiveMaxN, features, parseSize, roundStep } from "./config";
import { recentTimings, saveImages } from "./magasin";
import type { RefImage } from "./magasin";
import { OpenAIProvider } from "./openai";
import { fileImages, PREFIXE_SERVEUR_IMAGES, reglerCapacite } from "./ports";
import { SdcppProvider } from "./sdcpp";

const log = journal("image");

export const PROMPT_MAX = 4000;
export const NEGATIVE_MAX = 2000;
export { SOURCE_MAX_BYTES } from "@elpis/images";

const CAPS_TTL = 60.0;
const CAPS_FAIL_TTL = 10.0;
const capsCache = new Map<string, [number, Dict | ImageError]>();
/** « Modèle » unique d'un serveur d'images dans la file : un changement de modèle ne fait pas attendre les calculs en cours. */
const MODELE_FILE = "image";

const sec = (): number => performance.now() / 1000;

/** Client du moteur configuré ; `cfg` peut porter `api_key` (formulaire de la console). */
export function getProvider(cfg: Readonly<Dict>, horloges?: Horloges): ImageProvider {
  const key = Object.hasOwn(cfg, "api_key") ? strPy(cfg["api_key"] ?? "") : apiKey(cfg);
  const commun = {
    timeoutSec: entierPy(Object.hasOwn(cfg, "timeout_sec") ? cfg["timeout_sec"] : 180),
    verify: veritePy(Object.hasOwn(cfg, "verify") ? cfg["verify"] : true),
    caPem: strPy(cfg["ca_pem"] ?? ""),
    apiKey: key,
    ...(horloges === undefined ? {} : { horloges }),
  };
  const url = strPy(cfg["url"] ?? "");
  if (cfg["provider"] === "openai")
    return new OpenAIProvider(url, { model: strPy(cfg["model"] ?? ""), ...commun });
  return new SdcppProvider(url, commun);
}

function cleCapacites(cfg: Readonly<Dict>): string {
  const ca = createHash("sha256")
    .update(strPy(veritePy(cfg["ca_pem"]) ? cfg["ca_pem"] : ""), "utf-8")
    .digest("hex")
    .slice(0, 12);
  const verify = Object.hasOwn(cfg, "verify") ? cfg["verify"] : true;
  return JSON.stringify([strPy(cfg["url"] ?? ""), strPy(cfg["provider"] ?? ""), strPy(verify), ca]);
}

/** Capacités de sd-server gardées 60 s (un échec de connexion 10 s) ; `{}` pour un service OpenAI ou une réponse inattendue. */
export async function capabilities(cfg: Readonly<Dict>, signal?: AbortSignal): Promise<Dict> {
  if (cfg["provider"] !== "sdcpp") return {};
  const k = cleCapacites(cfg);
  const maintenant = sec();
  const connu = capsCache.get(k);
  if (connu !== undefined) {
    const age = maintenant - connu[0];
    if (connu[1] instanceof ImageError) {
      if (age < CAPS_FAIL_TTL) throw connu[1];
    } else if (age < CAPS_TTL) return connu[1];
  }
  let caps: Dict;
  try {
    caps = await getProvider(cfg).capabilities(signal);
  } catch (e) {
    if (e instanceof ImageError) {
      if (e.code === "unavailable" || e.code === "timeout") {
        capsCache.set(k, [maintenant, e]);
        throw e;
      }
      log.info(`capacités indisponibles : ${e.detail || e.message}`);
      return {};
    }
    throw e;
  }
  capsCache.set(k, [maintenant, caps]);
  return caps;
}

/** Après un changement de configuration (test de la console). */
export function forgetCapabilities(): void {
  capsCache.clear();
}

/** `_int(v, défaut)` : `int()` ; TypeError et ValueError donnent le défaut, OverflowError remonte. */
function entierOu(v: unknown, defaut: number): number {
  try {
    return entierPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "OverflowError") throw e;
    return defaut;
  }
}

const refus = (message: string): ImageError => new ImageError(message, { code: "invalid", status: 400 });

/** Valide la demande (`ImageError` invalid, 400) ; les options que le moteur ne comprend pas sont ignorées. */
export async function buildRequest(
  cfg: Readonly<Dict>,
  prompt: unknown,
  opts: Readonly<Dict>,
  caps: Readonly<Dict> | null = null,
  source: Uint8Array | null = null,
): Promise<ImageRequest> {
  const texte = stripPy(strPy(veritePy(prompt) ? prompt : ""));
  if (!texte) throw refus("Décrivez l'image à générer.");
  if (longueurPy(texte) > PROMPT_MAX)
    throw refus(`Description trop longue (${PROMPT_MAX} caractères au plus).`);
  const cote = veritePy(cfg["default_side"]) ? cfg["default_side"] : 1024;
  const wh = parseSize(veritePy(opts["size"]) ? opts["size"] : `${strPy(cote)}x${strPy(cote)}`);
  if (wh === null) throw refus("Format d'image invalide.");
  let [w, h] = wh;
  if (cfg["size_policy"] === "fixed") {
    const tailles = veritePy(cfg["sizes"]) ? (cfg["sizes"] as unknown[]) : [];
    if (!tailles.includes(`${w}x${h}`))
      throw refus("Taille non proposée par ce moteur : " + tailles.map((t) => strPy(t)).join(", ") + ".");
  } else {
    [w, h] = [roundStep(w), roundStep(h)];
    const maxSide = entierPy(veritePy(cfg["max_side"]) ? cfg["max_side"] : 2048);
    if (Math.max(w, h) > maxSide) throw refus(`Image trop grande : ${maxSide} px au plus par côté.`);
  }
  const brut = caps === null ? undefined : lire(caps, "limits");
  const limites: unknown = veritePy(brut) ? brut : {};
  const limite = (cle: string): unknown => {
    if (!estDict(limites)) throw new ErreurPython("AttributeError", "'list' object has no attribute 'get'");
    return lire(limites, cle) ?? null;
  };
  for (const [cle, val, label] of [
    ["width", w, "Largeur"],
    ["height", h, "Hauteur"],
  ] as const) {
    const [bas, haut] = [entierOu(limite(`min_${cle}`), 0), entierOu(limite(`max_${cle}`), 0)];
    if ((bas && val < bas) || (haut && val > haut))
      throw refus(`${label} ${val} hors des limites du moteur (${bas}–${haut}).`);
  }
  const n = entierOu(opts["n"] ?? null, 1);
  let maxN = effectiveMaxN(cfg);
  const lot = entierOu(limite("max_batch_count"), 0);
  if (lot) maxN = Math.min(maxN, lot);
  if (!(1 <= n && n <= maxN)) throw refus(`Nombre d'images entre 1 et ${maxN}.`);
  const req = imageRequest({ prompt: texte, width: w, height: h, n });
  const traits = features(cfg);
  if (source !== null && source.length > 0) {
    req.initImage = await prepareSource(source, w, h);
    req.editMode = strPy(veritePy(cfg["edit_mode"]) ? cfg["edit_mode"] : "init");
    const force = opts["strength"];
    let st: number;
    try {
      st = force !== null && force !== undefined ? floatPy(force) : 0.0;
    } catch {
      st = 0.0;
    }
    req.strength = 0.05 <= st && st <= 1.0 ? st : 0.75;
  }
  if (traits.seed) {
    const graine = entierOu(opts["seed"] ?? null, -1);
    req.seed = 0 <= graine && graine < 2 ** 31 ? graine : -1;
  }
  if (traits.negative) {
    const negatif = opts["negative_prompt"];
    req.negativePrompt = prefixePy(stripPy(strPy(veritePy(negatif) ? negatif : "")), NEGATIVE_MAX);
  }
  if (traits.steps) {
    const etapes = entierOu(opts["steps"] ?? null, 0);
    req.steps = 0 < etapes && etapes <= 200 ? etapes : 0;
  }
  return req;
}

/** Créneau d'un service OpenAI dans la file commune ; gardé après un Stop jusqu'à la fin estimée du calcul distant. */
export class Creneau {
  private rendu = false;
  private readonly slot: Slot;

  constructor(slot: Slot) {
    this.slot = slot;
  }

  rendre(): void {
    if (this.rendu) return;
    this.rendu = true;
    this.slot.release();
  }

  rendreApres(secondes: number): void {
    if (secondes <= 0) {
      this.rendre();
      return;
    }
    this.rendu = true;
    setTimeout(() => this.slot.release(), secondes * 1000).unref();
  }
}

const annule = (): ImageError => new ImageError("Génération annulée.", { code: "cancelled" });

/** `slots.acquire` : un des `cap` créneaux du serveur ; `onWait` une fois s'ils sont tous pris ; Stop → cancelled ; au-delà de `QUEUE_MAX_S` → busy. */
export async function prendreCreneau(
  url: string,
  cap: number,
  priorite: Priorite,
  signal: AbortSignal | undefined,
  onWait: () => unknown,
  attenteMaxS = QUEUE_MAX_S,
): Promise<Creneau> {
  const server = PREFIXE_SERVEUR_IMAGES + url;
  reglerCapacite(server, cap);
  const controleur = new AbortController();
  let delaiDepasse = false;
  const minuterie = setTimeout(() => {
    delaiDepasse = true;
    controleur.abort();
  }, attenteMaxS * 1000);
  minuterie.unref();
  const relais = (): void => controleur.abort(signal?.reason);
  signal?.addEventListener("abort", relais, { once: true });
  let attente: Promise<Slot> | undefined;
  try {
    if (signal?.aborted) throw annule();
    attente = fileImages().acquire({
      server,
      model: MODELE_FILE,
      priority: priorite,
      signal: controleur.signal,
    });
    let pris = false;
    attente.then(
      () => (pris = true),
      () => undefined,
    );
    await new Promise<void>((ok) => setImmediate(ok));
    if (!pris) await onWait();
    return new Creneau(await attente);
  } catch (e) {
    if (attente !== undefined) {
      controleur.abort();
      attente.then(
        (s) => s.release(),
        () => undefined,
      );
    }
    if (e instanceof LLMQueueAborted)
      throw delaiDepasse
        ? new ImageError("Moteur d'images occupé trop longtemps.", { code: "busy" })
        : annule();
    if (e instanceof LLMCircuitOpen)
      throw new ImageError("Moteur d'images injoignable. " + HINT_ADMIN, { code: "unavailable", cause: e });
    throw e;
  } finally {
    clearTimeout(minuterie);
    signal?.removeEventListener("abort", relais);
  }
}

export type OptionsGeneration = { etaS?: number | null; priorite?: Priorite; horloges?: Horloges };

/** Génère `req.n` images ; un service OpenAI passe par la file commune (sd-server tient sa propre file et en publie la position). */
export async function runGeneration(
  cfg: Readonly<Dict>,
  req: ImageRequest,
  onProgress: SuiviProgres,
  signal?: AbortSignal,
  options: OptionsGeneration = {},
): Promise<ImageResult[]> {
  const provider = getProvider(cfg, options.horloges);
  if (cfg["provider"] !== "openai") return provider.generate(req, onProgress, signal);
  const cap = Object.hasOwn(cfg, "max_concurrent") ? entierPy(cfg["max_concurrent"]) : 1;
  const creneau = await prendreCreneau(strPy(cfg["url"] ?? ""), cap, options.priorite ?? "high", signal, () =>
    onProgress("waiting", null),
  );
  const t0 = sec();
  try {
    return await provider.generate(req, onProgress, signal);
  } catch (e) {
    if (e instanceof ImageError && e.code === "cancelled") {
      const reste = (veritePy(options.etaS) ? (options.etaS as number) : 30.0) - (sec() - t0);
      const plafond = floatPy(veritePy(cfg["timeout_sec"]) ? cfg["timeout_sec"] : 180);
      creneau.rendreApres(Math.min(Math.max(0.0, reste), plafond));
    }
    throw e;
  } finally {
    creneau.rendre();
  }
}

/** Médiane des secondes par mégapixel × mégapixels demandés (au moins 1 s) ; `null` sans historique. */
export function estimerDepuisHistorique(
  hist: readonly (readonly [number, number])[],
  req: ImageRequest,
): number | null {
  if (hist.length === 0) return null;
  const taux = hist
    .filter(([, mp]) => mp > 0)
    .map(([d, mp]) => d / mp)
    .sort((a, b) => a - b);
  if (taux.length === 0) return null;
  const rate = taux[Math.trunc(taux.length / 2)] ?? 0;
  return Math.max(1.0, rate * ((req.width * req.height * Math.max(1, req.n)) / 1e6));
}

/** Durée de calcul attendue d'après les lots précédents du même modèle ; `null` plutôt qu'une estimation inventée. */
export async function estimateSeconds(base: Base, model: string, req: ImageRequest): Promise<number | null> {
  let hist: [number, number][];
  try {
    hist = await recentTimings(base, model, req.steps);
  } catch (e) {
    log.info(`historique de durées illisible : ${String(e)}`);
    return null;
  }
  return estimerDepuisHistorique(hist, req);
}

/** Avancée d'une génération pour la tuile du chat : pourcentage seulement s'il est réel, sinon temps écoulé et durée attendue. */
export class ProgressTracker {
  readonly w: number;
  readonly h: number;
  readonly n: number;
  readonly t0: number;
  state = "queued";
  qp: unknown = null;
  etaS: number | null;
  genT0: number | null = null;
  pctReal: number | null = null;
  preview: string | null = null;
  private previewSent: string | null = null;
  private readonly horloges: Horloges;

  constructor(req: ImageRequest, etaS: number | null = null, horloges: Horloges = HORLOGES_SYSTEME) {
    [this.w, this.h, this.n] = [req.width, req.height, req.n];
    this.horloges = horloges;
    this.t0 = horloges.monotone();
    this.etaS = etaS;
  }

  update(state: string, qp: unknown = null, info: InfoProgres | Dict | null = null): void {
    const i: Dict = (veritePy(info) ? info : {}) as Dict;
    [this.state, this.qp] = [state, qp];
    if (state === "generating" && this.genT0 === null) {
      const started = i["started_at"];
      const lag = veritePy(started) ? Math.max(0.0, this.horloges.murale() - floatPy(started)) : 0.0;
      this.genT0 = this.horloges.monotone() - Math.min(lag, this.horloges.monotone() - this.t0);
    }
    const pct = i["pct"];
    if (typeof pct === "number" || typeof pct === "boolean") this.pctReal = floatPy(pct);
    if (veritePy(i["preview"])) this.preview = i["preview"] as string;
  }

  /** Événement `image_progress` ; l'aperçu n'est envoyé qu'une fois par nouvelle image (il pèse). */
  event(source?: string): Dict {
    const ev: Dict = {
      type: "image_progress",
      state: this.state,
      queue_position: this.qp,
      elapsed_s: Math.trunc(this.horloges.monotone() - this.t0),
      eta_s: this.etaS ? arrondiEntierPy(this.etaS) : null,
      pct: this.pctReal !== null ? Math.trunc(this.pctReal) : null,
      pct_real: this.pctReal !== null,
      width: this.w,
      height: this.h,
      n: this.n,
    };
    if (source) ev["source"] = source;
    if (this.preview && this.preview !== this.previewSent) {
      ev["preview"] = this.preview;
      this.previewSent = this.preview;
    }
    return ev;
  }

  genSeconds(): number | null {
    return this.genT0 === null ? null : this.horloges.monotone() - this.genT0;
  }
}

/** Nom du modèle : celui que sd-server annonce, sinon celui de la configuration. */
export function modelName(cfg: Readonly<Dict>, caps: Readonly<Dict> | null): string {
  const annonce = caps === null ? undefined : caps["model"];
  if (veritePy(annonce)) return strPy(annonce);
  return strPy(veritePy(cfg["model"]) ? cfg["model"] : "");
}

export type OptionsStockage = {
  userId: number;
  chatId: string | null;
  prompt: string;
  caps: Readonly<Dict> | null;
  onProgress: SuiviProgres;
  signal?: AbortSignal;
  tracker: ProgressTracker;
  extra?: Dict | null;
  priorite?: Priorite;
  base?: Base;
};

/** Génère puis range les images du compte (même moteur, même magasin, même rétention pour le tour « Images » et l'outil) ; l'écriture finit même après un Stop. */
export async function generateAndStore(
  cfg: Readonly<Dict>,
  req: ImageRequest,
  o: OptionsStockage,
): Promise<{ refs: RefImage[]; meta: Dict }> {
  const base = o.base ?? baseApp();
  const model = modelName(cfg, o.caps);
  if (o.tracker.etaS === null) o.tracker.etaS = await estimateSeconds(base, model, req);
  const progres: SuiviProgres = async (state, qp = null, info = null) => {
    o.tracker.update(state, qp, info);
    await o.onProgress(state, qp, info);
  };
  const results = await runGeneration(cfg, req, progres, o.signal, {
    etaS: o.tracker.etaS,
    ...(o.priorite === undefined ? {} : { priorite: o.priorite }),
  });
  const gs = o.tracker.genSeconds();
  const duree = gs && gs > 0.2 ? arrondiPy(gs, 2) : null;
  const params: Dict = {
    size: `${req.width}x${req.height}`,
    provider: cfg["provider"],
    negative_prompt: req.negativePrompt,
    steps: req.steps,
    edit: req.initImage !== null && req.initImage.length > 0,
  };
  if (veritePy(o.extra)) Object.assign(params, { ...o.extra });
  const keep = entierPy(cfg["keep_per_user"]);
  const refs = await saveImages(base, o.userId, o.chatId, o.prompt, {
    model,
    params,
    results,
    keep,
    steps: req.steps,
    durationS: duree,
  });
  const meta: Dict = { model };
  if (duree !== null) meta["duration_s"] = arrondiPy(duree, 1);
  return { refs, meta };
}
