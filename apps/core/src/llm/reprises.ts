// SPDX-License-Identifier: MIT
/** apps/core/src/llm/reprises.ts — pannes LLM : fatale ou transitoire, famille et message actionnable, `Retry-After`, attente du chargement, backoff à gigue complète. */
import { ErreurPython, floatPy, intPy, maxPy, minPy, strPy, stripPy, veritePy } from "@elpis/commun";
import { config, parseJsonPy } from "@elpis/config";

import { journal } from "../journal";
import { estDict, prefixePy, splitPy } from "../python";
import { currentTarget } from "./cible";
import type { EntetesInit } from "./client-http";
import {
  CancelledError,
  ConnectError,
  ConnectTimeout,
  getLlmClient,
  HTTPStatusError,
  PoolTimeout,
  ReadTimeout,
  ReponseHttp,
  WriteTimeout,
} from "./client-http";
import { getPy, isdigitPy } from "./dict-py";
import { dormir, engineUrlHeaders, monotonic } from "./llama-http";
import { currentEngine } from "./moteurs";

const log = journal("llm_retry");

export const SLEEP_SLICE_S = 0.2;
export const SUCCESS_MEMORY_S = 3600.0;

let lastLlmSuccessMono: number | null = null;
export const lastSuccessByEngine = new Map<string, number>();

function currentEngineKey(): string {
  try {
    return currentEngine().key;
  } catch {
    return "builtin";
  }
}

/** Après chaque appel LLM abouti : arme l'attente de redémarrage sur les erreurs de connexion suivantes. */
export function noteLlmSuccess(): void {
  lastLlmSuccessMono = monotonic();
  lastSuccessByEngine.set(currentEngineKey(), lastLlmSuccessMono);
}

/** Oublie l'historique des succès (isolation des tests). */
export function forgetLlmSuccess(): void {
  lastLlmSuccessMono = null;
  lastSuccessByEngine.clear();
}

export function derniereReussite(): number | null {
  return lastLlmSuccessMono;
}

/** Un appel a-t-il abouti récemment, dans ce process, sur le serveur de la cible courante ? */
export function engineWasAlive(): boolean {
  const ts = lastSuccessByEngine.get(currentEngineKey());
  return ts !== undefined && monotonic() - ts < SUCCESS_MEMORY_S;
}

/** Réglage lu à l'usage (pas figé au chargement). */
function cfg(nom: string, defaut: number): number {
  const v = (config as unknown as Record<string, unknown>)[nom];
  return typeof v === "number" ? v : defaut;
}

function codeStatut(e: HTTPStatusError): number {
  try {
    return intPy(e.response.statusCode);
  } catch {
    return 0;
  }
}

/** Rejouer la MÊME requête reproduira l'erreur : 4xx hors 408, 409 et 429. */
export function llmErrorIsFatal(e: unknown): boolean {
  if (!(e instanceof HTTPStatusError)) return false;
  const code = codeStatut(e);
  return code >= 400 && code < 500 && ![408, 409, 429].includes(code);
}

/** 503 de llama-server pendant le chargement d'un modèle. */
export function llmErrorIsLoading(e: unknown): boolean {
  return e instanceof HTTPStatusError && e.response.statusCode === 503;
}

export const CTX_OVERFLOW_MARKERS = [
  "exceeds the available context size",
  "exceed the available context",
  "context size exceeded",
  "context_length_exceeded",
  "maximum context length",
  "too large to process",
  "prompt is too long",
  "n_ctx",
];

export const ACCESS_MARKERS = [
  "can only be used",
  "not allowed",
  "not permitted",
  "no access",
  "not authorized",
  "unauthorized",
  "forbidden",
  "permission",
  "is disabled",
  "model is disabled",
  "insufficient_quota",
  "exceeded your current quota",
  "subscription",
  "free tier",
  "requires a paid",
];

export const KIND_CONTEXT_OVERFLOW = "context_overflow";
export const KIND_INVALID_REQUEST = "invalid_request";
export const KIND_FORBIDDEN = "forbidden";
export const KIND_RATE_LIMITED = "rate_limited";
export const KIND_LOADING = "loading";
export const KIND_UNREACHABLE = "unreachable";
export const KIND_TIMEOUT = "timeout";
export const KIND_UNKNOWN = "unknown";

/** Corps de la réponse d'erreur (`""` s'il n'est pas lisible, p. ex. flux jamais lu). */
export function errorBodyText(e: unknown, limit = 2000): string {
  const reponse = (e as { response?: { text?: unknown } } | null)?.response;
  if (reponse === null || reponse === undefined) return "";
  try {
    const t = reponse.text;
    return prefixePy(typeof t === "string" ? t : "", limit);
  } catch {
    return "";
  }
}

/** Message LISIBLE du fournisseur (`{"error": {"message": …}}`, texte court d'une ligne), ou `""`. */
export function providerMessage(e: unknown, limit = 220): string {
  const brut = stripPy(errorBodyText(e, 4000));
  if (!brut || brut.slice(0, 1) === "<") return "";
  let message: unknown = "";
  let donnees: unknown;
  try {
    donnees = parseJsonPy(brut);
  } catch {
    donnees = null;
  }
  if (estDict(donnees)) {
    const err = getPy(donnees, "error");
    if (estDict(err)) {
      const m = veritePy(getPy(err, "message")) ? getPy(err, "message") : getPy(err, "detail");
      message = strPy(veritePy(m) ? m : "");
    } else if (typeof err === "string") message = err;
    if (!veritePy(message)) {
      const m = veritePy(getPy(donnees, "message")) ? getPy(donnees, "message") : getPy(donnees, "detail");
      message = strPy(veritePy(m) ? m : "");
    }
  } else if (donnees === null && [...brut].length <= limit && !brut.includes("\n")) message = brut;
  const propre = splitPy(strPy(message)).join(" ");
  return propre ? prefixePy(propre, limit) : "";
}

/** Famille de panne, pour choisir le message montré à l'utilisateur. */
export function llmErrorKind(e: unknown): string {
  if (e instanceof HTTPStatusError) {
    const code = codeStatut(e);
    const corps = errorBodyText(e).toLowerCase();
    if (CTX_OVERFLOW_MARKERS.some((m) => corps.includes(m))) return KIND_CONTEXT_OVERFLOW;
    if (code === 503) return KIND_LOADING;
    if (code === 429 || code === 529 || (code >= 500 && corps.includes("overloaded")))
      return KIND_RATE_LIMITED;
    if (code === 408) return KIND_TIMEOUT;
    if (code === 401 || code === 403) return KIND_FORBIDDEN;
    if (code >= 400 && code < 500 && ACCESS_MARKERS.some((m) => corps.includes(m))) return KIND_FORBIDDEN;
    if (code >= 400 && code < 500) return KIND_INVALID_REQUEST;
    return KIND_UNKNOWN;
  }
  if (e instanceof ConnectError || e instanceof ConnectTimeout) return KIND_UNREACHABLE;
  if (e instanceof ReadTimeout || e instanceof PoolTimeout || e instanceof WriteTimeout) return KIND_TIMEOUT;
  return KIND_UNKNOWN;
}

export const KIND_MESSAGES: Readonly<Record<string, string>> = {
  [KIND_CONTEXT_OVERFLOW]:
    "La conversation dépasse la fenêtre de contexte du modèle. Compactez la conversation, ouvrez un nouveau chat, " +
    "ou retirez les pièces jointes volumineuses du dernier message.",
  [KIND_INVALID_REQUEST]:
    "Le modèle a refusé la requête telle qu'elle a été construite. Réessayer à l'identique donnera le même " +
    "résultat : changez de modèle, ou désactivez les outils du chat pour isoler la cause.",
  [KIND_FORBIDDEN]:
    "La clé de ce connecteur n'ouvre pas ce modèle. Mettez une clé qui y donne droit, ou choisissez un modèle que " +
    "la vôtre couvre — relancer à l'identique donnera le même refus.",
  [KIND_RATE_LIMITED]:
    "Le service du modèle limite le débit des requêtes. Patientez quelques instants avant de relancer.",
  [KIND_LOADING]:
    "Le modèle est encore en cours de chargement. Relancez la génération dans quelques instants.",
  [KIND_UNREACHABLE]:
    "Le serveur du modèle est injoignable. Vérifiez qu'il est démarré, puis relancez la génération.",
  [KIND_TIMEOUT]:
    "Le modèle n'a pas répondu dans le temps imparti. Relancez la génération, ou choisissez un modèle plus léger.",
  [KIND_UNKNOWN]:
    "La génération a échoué pour une raison inattendue. Relancez-la ; si le problème persiste, consultez les journaux.",
};

/** Notre conseil, suivi de l'explication du fournisseur quand il en donne une. */
export function llmErrorUserMessage(e: unknown): string {
  const base = KIND_MESSAGES[llmErrorKind(e)] ?? KIND_MESSAGES[KIND_UNKNOWN] ?? "";
  const message = providerMessage(e);
  if (!message) return base;
  return `${base} Le fournisseur répond : « ${message.replace(/\.+$/u, "")} ».`;
}

function nomType(e: unknown): string {
  if (e instanceof Error) return e.name;
  if (e === null || e === undefined) return "NoneType";
  return typeof e;
}

function texteErreur(e: unknown): string {
  return e instanceof Error ? e.message : strPy(e);
}

/** Motif TECHNIQUE (journaux, repli « Détails »), jamais la seule chose montrée. */
export function llmErrorDetail(e: unknown, attempts: number | null = null): string {
  if (e === null || e === undefined) return "";
  const parties = [`${nomType(e)}: ${prefixePy(texteErreur(e), 300)}`];
  const corps = stripPy(errorBodyText(e, 400));
  if (corps) parties.push(`réponse serveur : ${corps}`);
  if (attempts) parties.push(`${attempts} tentative(s)`);
  return parties.join(" — ");
}

/** Refus du fournisseur remis en forme HTTP : toute la taxonomie s'applique. */
export class ProviderError extends HTTPStatusError {
  override name = "ProviderError";
}

/** Erreur reçue hors du code HTTP (événement SSE, adaptateur Anthropic) remise dans la forme que la taxonomie lit. */
export function providerHttpError(
  status: unknown,
  body: unknown,
  options: { url?: string; message?: string; headers?: EntetesInit | null } = {},
): ProviderError {
  const requete = { method: "POST", url: options.url || "http://llm.invalid/" };
  const code = intPy(veritePy(status) ? status : 500);
  const texte = strPy(veritePy(body) ? body : "");
  const entetes = new Headers(options.headers ?? undefined);
  if (!entetes.has("content-type")) entetes.set("content-type", "text/plain; charset=utf-8");
  const reponse = new ReponseHttp({ statusCode: code, request: requete, text: texte, headers: entetes });
  return new ProviderError(options.message || `${code}: ${prefixePy(texte, 300)}`, {
    request: requete,
    response: reponse,
  });
}

/** Échec d'appel LLM déjà traduit : `message` actionnable, `detail` technique, `kind` la famille. */
export class LLMFailure extends Error {
  override name = "LLMFailure";
  readonly kind: string;
  readonly detail: string;

  constructor(cause: unknown, options: { attempts?: number | null } = {}) {
    super(llmErrorUserMessage(cause), { cause });
    this.kind = llmErrorKind(cause);
    this.detail = llmErrorDetail(cause, options.attempts ?? null);
  }
}

/** Gigue complète : uniforme dans [0, min(cap, base·2^attempt)]. */
export function backoffDelay(attempt: number, options: { base?: number; cap?: number } = {}): number {
  const b = options.base ?? cfg("LLAMA_RETRY_BACKOFF_SEC", 0.6);
  const c = options.cap ?? cfg("LLAMA_RETRY_BACKOFF_CAP_S", 15.0);
  return Math.random() * Math.max(0.0, Math.min(c, b * 2 ** Math.max(0, Math.trunc(attempt))));
}

export const RETRY_AFTER_CAP_S = 60.0;

const MOIS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const JOURS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const FUSEAUX: Readonly<Record<string, number>> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  AST: -400,
  ADT: -300,
  EST: -500,
  EDT: -400,
  CST: -600,
  CDT: -500,
  MST: -700,
  MDT: -600,
  PST: -800,
  PDT: -700,
};

function entierOuNull(s: string | number): number | null {
  try {
    return intPy(s);
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "ValueError") return null;
    throw e;
  }
}

function joursDuMois(annee: number, mois: number): number {
  if (mois === 2) return (annee % 4 === 0 && annee % 100 !== 0) || annee % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(mois) ? 30 : 31;
}

/** Heure `hh:mm[:ss]` (ou à points) d'une date RFC 2822 ; `null` si la forme est inconnue. */
function decouperHeure(tm: string): [string, string, string | number] | null {
  let parts = tm.split(":");
  if (parts.length === 2) return [parts[0] ?? "", parts[1] ?? "", "0"];
  if (parts.length === 3) return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
  if (parts.length === 1 && (parts[0] ?? "").includes(".")) {
    parts = (parts[0] ?? "").split(".");
    if (parts.length === 2) return [parts[0] ?? "", parts[1] ?? "", 0];
    if (parts.length === 3) return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
  }
  return null;
}

/** `email.utils.parsedate_to_datetime(raw).timestamp()` (sans fuseau = UTC) ; `null` là où Python lève. */
export function parsedateEpoch(raw: string): number | null {
  if (!raw) return null;
  let d = splitPy(raw);
  if (d.length === 0) return null;
  const premier = d[0] ?? "";
  if (premier.endsWith(",") || JOURS.includes(premier.toLowerCase())) d.splice(0, 1);
  else {
    const i = premier.lastIndexOf(",");
    if (i >= 0) d[0] = premier.slice(i + 1);
  }
  if (d.length === 3) {
    const morceaux = (d[0] ?? "").split("-");
    if (morceaux.length === 3) d = [...morceaux, ...d.slice(1)];
  }
  if (d.length === 4) {
    const s = d[3] ?? "";
    let i = s.indexOf("+");
    if (i === -1) i = s.indexOf("-");
    if (i > 0) d.splice(3, 1, s.slice(0, i), s.slice(i));
    else d.push("");
  }
  if (d.length < 5) return null;
  let [dd = "", mm = "", yy = "", tm = "", tz = ""] = d.slice(0, 5);
  if (!(dd && mm && yy)) return null;
  mm = mm.toLowerCase();
  if (!MOIS.includes(mm)) {
    [dd, mm] = [mm, dd.toLowerCase()];
    if (!MOIS.includes(mm)) return null;
  }
  let mois = MOIS.indexOf(mm) + 1;
  if (mois > 12) mois -= 12;
  if (dd.endsWith(",")) dd = dd.slice(0, -1);
  if (yy.indexOf(":") > 0) [yy, tm] = [tm, yy];
  if (yy.endsWith(",")) {
    yy = yy.slice(0, -1);
    if (!yy) return null;
  }
  if (!isdigitPy([...yy][0] ?? "")) [yy, tz] = [tz, yy];
  if (tm.endsWith(",")) tm = tm.slice(0, -1);
  const heure = decouperHeure(tm);
  if (heure === null) return null;
  const valeurs = [yy, dd, ...heure].map(entierOuNull);
  if (valeurs.some((v) => v === null)) return null;
  const [an = 0, jour = 0, h = 0, mi = 0, se = 0] = valeurs as number[];
  const annee = an < 100 ? an + (an > 68 ? 1900 : 2000) : an;
  const zone = tz.toUpperCase();
  let decalage: number | null = Object.hasOwn(FUSEAUX, zone) ? (FUSEAUX[zone] ?? 0) : entierOuNull(zone);
  if (!Object.hasOwn(FUSEAUX, zone) && decalage === 0 && zone.startsWith("-")) decalage = null;
  if (decalage) {
    const a = Math.abs(decalage);
    decalage = (decalage < 0 ? -1 : 1) * (Math.floor(a / 100) * 3600 + (a % 100) * 60);
  }
  if (annee < 1 || annee > 9999 || mois < 1 || mois > 12 || jour < 1 || jour > joursDuMois(annee, mois))
    return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || se < 0 || se > 59) return null;
  if (decalage !== null && Math.abs(decalage) >= 86400) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(annee, mois - 1, jour);
  utc.setUTCHours(h, mi, se, 0);
  return utc.getTime() / 1000 - (decalage ?? 0);
}

/** Délai d'un `Retry-After` (secondes ou date HTTP) ou `retry-after-ms`, borné à `RETRY_AFTER_CAP_S` ; `null` sans en-tête lisible. */
export function retryAfterSeconds(
  e: unknown,
  maintenant: () => number = () => Date.now() / 1000,
): number | null {
  if (!(e instanceof HTTPStatusError)) return null;
  let brut: string;
  try {
    brut = stripPy(e.response.headers.get("retry-after-ms") || "");
    if (brut) return maxPy(0.0, minPy(RETRY_AFTER_CAP_S, floatPy(brut) / 1000.0));
    brut = stripPy(e.response.headers.get("retry-after") || "");
  } catch {
    return null;
  }
  if (!brut) return null;
  let secondes: number;
  try {
    secondes = floatPy(brut);
  } catch {
    const quand = parsedateEpoch(brut);
    if (quand === null) return null;
    secondes = quand - maintenant();
  }
  return maxPy(0.0, minPy(RETRY_AFTER_CAP_S, secondes));
}

export type EstAnnule = (() => boolean) | null | undefined;

/** Sommeil découpé qui lève `CancelledError` dès que le drapeau d'annulation passe (jamais de tentative après un stop). */
export async function cancelAwareSleep(
  secondes: number,
  isCancelled: EstAnnule,
  signal?: AbortSignal,
): Promise<void> {
  const echeance = monotonic() + Math.max(0.0, secondes);
  for (;;) {
    if ((isCancelled && isCancelled()) || signal?.aborted)
      throw new CancelledError("llm_retry: cancelled during backoff");
    const reste = echeance - monotonic();
    if (reste <= 0) return;
    await dormir(Math.min(SLEEP_SLICE_S, reste), signal);
  }
}

/** `GET /health` du serveur de la cible (statut, `null` si injoignable). */
async function sondeSante(): Promise<number | null> {
  try {
    const eng = currentEngine();
    const [url, entetes] = engineUrlHeaders(eng.profil.chemins.sante ?? eng.profil.chemins.modeles, eng);
    const client = eng.isBuiltin ? getLlmClient() : getLlmClient(eng.baseRoot);
    const r = await client.get(url, { timeout: 3.0, headers: entetes });
    return r.statusCode;
  } catch {
    return null;
  }
}

/** Sonde `/health` jusqu'à 200 ou l'échéance (`LLAMA_LOADING_WAIT_S`) ; lève `CancelledError` sur annulation. */
export async function waitLlamaReady(
  maxWaitS: number | null = null,
  options: {
    isCancelled?: EstAnnule;
    probe?: () => Promise<number | null>;
    pollS?: number;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  const limite = maxWaitS ?? cfg("LLAMA_LOADING_WAIT_S", 90.0);
  const sonde = options.probe ?? sondeSante;
  const echeance = monotonic() + Math.max(0.0, limite);
  for (;;) {
    if ((options.isCancelled && options.isCancelled()) || options.signal?.aborted)
      throw new CancelledError("llm_retry: cancelled while waiting for /health");
    let statut: number | null;
    try {
      statut = await sonde();
    } catch {
      statut = null;
    }
    if (statut === 200) return true;
    if (monotonic() >= echeance) return false;
    await cancelAwareSleep(options.pollS ?? 2.0, options.isCancelled, options.signal);
  }
}

/** Pause avant la tentative suivante : 503 ou redémarrage d'un llama.cpp → attendre `/health`, sinon `Retry-After` ou backoff. */
export async function retryPause(
  e: unknown,
  attempt: number,
  options: {
    isCancelled?: EstAnnule;
    label?: string;
    signal?: AbortSignal;
    attendrePret?: typeof waitLlamaReady;
  } = {},
): Promise<void> {
  const tag = options.label ? `[${options.label}] ` : "";
  let local: boolean;
  try {
    local = currentTarget().profil.capacites.attenteSante;
  } catch {
    local = true;
  }
  const redemarrage = llmErrorKind(e) === KIND_UNREACHABLE && engineWasAlive();
  if (local && (llmErrorIsLoading(e) || redemarrage)) {
    const pourquoi = !redemarrage
      ? "503 chargement de modèle"
      : "moteur injoignable après un appel abouti — redémarrage ?";
    const t0 = monotonic();
    const attendre = options.attendrePret ?? waitLlamaReady;
    if (await attendre(null, { isCancelled: options.isCancelled, signal: options.signal })) {
      const attendu = monotonic() - t0;
      log.info(
        `${tag}llama-server prêt après ${attendu.toFixed(1)}s d'attente (${pourquoi}) — nouvelle tentative`,
      );
      if (attendu >= 1.0) return;
    } else
      log.warn(
        `${tag}llama-server toujours pas prêt après ${(monotonic() - t0).toFixed(0)}s d'attente (${pourquoi}) — backoff standard`,
      );
    await cancelAwareSleep(backoffDelay(attempt), options.isCancelled, options.signal);
    return;
  }
  const ra = retryAfterSeconds(e);
  if (ra !== null) {
    log.info(`${tag}Retry-After : ${ra.toFixed(1)}s`);
    await cancelAwareSleep(ra, options.isCancelled, options.signal);
    return;
  }
  await cancelAwareSleep(backoffDelay(attempt), options.isCancelled, options.signal);
}
