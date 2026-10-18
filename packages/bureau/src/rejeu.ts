// SPDX-License-Identifier: MIT
/** packages/bureau/src/rejeu.ts — rejeu déterministe d'un scénario bureau : ré-ancrage a11y, auto-réparation vision bornée, attentes intelligentes, arrêt coopératif. */
import { AsyncLocalStorage } from "node:async_hooks";

import {
  BLANC_PY,
  chercherRe,
  echapperPy,
  ErreurPython,
  ErreurRe,
  estDict,
  exigerDict,
  floatPy,
  intPy,
  iterPy,
  lire,
  lowerPy,
  ouPy as ou,
  poserCle,
  prefixePy,
  RegexNonGeree,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import { journal } from "@elpis/http";

import { primitivesBureau } from "./ports";
import { resolveElement, sequencePy } from "./session";
import type { Proche } from "./session";

const log = journal("replay");

const POINT_OPS = new Set([
  "click",
  "left_click",
  "double_click",
  "right_click",
  "triple_click",
  "middle_click",
  "move",
  "drag",
]);
const SEMANTIC_REPLAY_OPS = new Set([
  "toggle",
  "check",
  "uncheck",
  "select",
  "expand",
  "collapse",
  "scroll_into_view",
  "set_value",
  "invoke",
]);
const ACT_ARG_KEYS = ["text", "keys", "button", "clicks", "dy", "x2", "y2", "modifiers"] as const;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_500;
export const MAX_TIMEOUT_MS = 300_000;
export const STABLE_CEILING_MS = 8_000;
export const SETTLE_QUIET_MS = 700;
export const SETTLE_POLL_MS = 400;
export const ELEMENT_POLL_MS = 600;
export const TEXT_POLL_MS = 1500;
const sigEnv = process.env["DESKTOP_SIG_SAME"] ?? "2";
/** Distance de Hamming en dessous de laquelle deux captures sont « identiques » (`DESKTOP_SIG_SAME`). */
export const SIG_SAME = veritePy(sigEnv) ? intPy(sigEnv) : 2;
export const RETRY_BACKOFF_MS = 600;
export const MAX_RETRY = 5;
const WINDOW_ROLES = new Set(["window", "dialog", "frame", "document", "pane", "panel"]);

/** Horloge monotone (secondes) et attente : remplaçables dans les tests. */
export type HorlogeRejeu = { monotone(): number; dormir(secondes: number): Promise<void> };
const HORLOGE_SYSTEME: HorlogeRejeu = {
  monotone: () => performance.now() / 1000,
  dormir: (s) => new Promise((ok) => setTimeout(ok, s * 1000)),
};
let horloge = HORLOGE_SYSTEME;

export function installerHorlogeRejeu(h: HorlogeRejeu | null): void {
  horloge = h ?? HORLOGE_SYSTEME;
}

/** Arrêt demandé par l'utilisateur pendant un rejeu (traverse les captures d'erreurs des pas). */
export class ReplayAborted extends Error {
  override name = "ReplayAborted";
}

/** Propre à chaque rejeu : son arrêt et son budget d'auto-réparation vision (`_self_heal_left`, un rejeu par cible). */
type ContexteRejeu = { arret: (() => unknown) | null; reparations: number };
const contexteRejeu = new AsyncLocalStorage<ContexteRejeu>();

function nowMs(): number {
  return Math.trunc(horloge.monotone() * 1000);
}

function aborted(): boolean {
  const fn = contexteRejeu.getStore()?.arret;
  try {
    return Boolean(fn && veritePy(fn()));
  } catch {
    return false;
  }
}

async function sleepMs(ms: number): Promise<void> {
  if (aborted()) throw new ReplayAborted();
  if (ms > 0) await horloge.dormir(ms / 1000);
}

function selfHealCap(): number {
  return Math.max(0, intPy(ou(config.DESKTOP_REPLAY_SELF_HEAL_MAX ?? 10, 0)));
}

/** Passe vision permise (et décomptée) ; hors rejeu (chemin direct de `desktop_wait`), pas de budget : toujours permise. */
function selfHealAllow(): boolean {
  const ctx = contexteRejeu.getStore();
  if (ctx === undefined) return true;
  if (ctx.reparations <= 0) return false;
  ctx.reparations -= 1;
  return true;
}

function selfHealDenied(): boolean {
  const ctx = contexteRejeu.getStore();
  return ctx !== undefined && ctx.reparations <= 0;
}

function erreurConversion(e: unknown): boolean {
  return e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError");
}

/** Délai d'un pas borné à 1,5 s – 5 min ; illisible : 30 s. */
export function clampTimeout(ms: unknown): number {
  let v: number;
  try {
    v = intPy(ms);
  } catch (e) {
    if (erreurConversion(e)) return DEFAULT_TIMEOUT_MS;
    throw e;
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, v));
}

/** `d.get(cle)` (AttributeError si ce n'est pas un dict). */
function get(d: unknown, cle: string): unknown {
  return lire(exigerDict(d), cle) ?? null;
}

/** `(x or {})`. */
function dictOu(v: unknown): unknown {
  return veritePy(v) ? v : {};
}

function sigOf(res: unknown): unknown {
  return estDict(res) ? ou(lire(res, "sig") ?? null, "") : "";
}

const CHIFFRE_UNICODE = /^\p{Nd}$/u;
const BLANC = new RegExp(`^${BLANC_PY}$`);
const HEXA_PY = /^[ \t\n\v\f\r]*([+-]?)(?:0[xX]_?)?([0-9a-fA-F](?:_?[0-9a-fA-F])*)[ \t\n\v\f\r]*$/;

/** `int(texte, 16)` de Python (blancs et chiffres Unicode, préfixe `0x`, soulignés) ; ValueError sinon. */
function entierHexa(s: string): bigint {
  let ascii = "";
  for (const c of s) {
    if (c.charCodeAt(0) < 128 && c.length === 1) ascii += c;
    else if (BLANC.test(c)) ascii += " ";
    else if (CHIFFRE_UNICODE.test(c)) ascii += String(intPy(c));
    else throw new ErreurPython("ValueError", `invalid literal for int() with base 16: '${s}'`);
  }
  const m = HEXA_PY.exec(ascii);
  if (m === null) throw new ErreurPython("ValueError", `invalid literal for int() with base 16: '${s}'`);
  const v = BigInt(`0x${(m[2] ?? "").replaceAll("_", "")}`);
  return m[1] === "-" ? -v : v;
}

/** Distance de Hamming entre deux signatures dHash ; 64 (« tout diffère ») si l'une manque ou est illisible. */
export function hamHex(a: unknown, b: unknown): number {
  if (!veritePy(a) || !veritePy(b)) return 64;
  if (typeof a !== "string" || typeof b !== "string")
    throw new ErreurPython("TypeError", "int() can't convert non-string with explicit base");
  if (Array.from(a).length !== Array.from(b).length) return 64;
  let x: bigint;
  let y: bigint;
  try {
    x = entierHexa(a);
    y = entierHexa(b);
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "ValueError") return 64;
    throw e;
  }
  let v = x ^ y;
  if (v < 0n) v = -v;
  return [...v.toString(2)].filter((c) => c === "1").length;
}

/** L'écran a cessé de bouger (signatures quasi identiques pendant `quietMs`), borné ; renvoie les ms attendues. */
export async function waitStable(
  username: string,
  target: string,
  o: { timeoutMs: number; quietMs?: number; pollMs?: number },
): Promise<number> {
  const p = primitivesBureau();
  const calme = o.quietMs ?? SETTLE_QUIET_MS;
  const sondage = o.pollMs ?? SETTLE_POLL_MS;
  const debut = nowMs();
  const echeance = debut + Math.max(0, o.timeoutMs);
  let prec = sigOf(await p.grab(username, target));
  let stableDepuis = nowMs();
  while (nowMs() < echeance) {
    await sleepMs(sondage);
    const cur = sigOf(await p.grab(username, target));
    if (!veritePy(cur) || !veritePy(prec) || hamHex(prec, cur) > SIG_SAME) stableDepuis = nowMs();
    prec = cur;
    if (nowMs() - stableDepuis >= calme) break;
  }
  return nowMs() - debut;
}

/** La sonde a11y a-t-elle abouti ? Un échec n'est jamais un verdict. */
export function sondeOk(obs: unknown): boolean {
  return !(estDict(obs) && obs["ok"] === false);
}

/** Centre enregistré d'un élément, en entiers ; `null` s'il n'en a pas. */
export function center(el: unknown): [number, number] | null {
  if (!veritePy(el)) return null;
  const c = sequencePy(ou(get(el, "center"), []));
  return c.n >= 2 ? [intPy(c.at(0)), intPy(c.at(1))] : null;
}

async function waitElement(
  username: string,
  target: string,
  query: string,
  o: { present: boolean; timeoutMs: number; pollMs?: number; selfHeal?: boolean },
): Promise<[boolean, number]> {
  const p = primitivesBureau();
  const debut = nowMs();
  const echeance = debut + Math.max(0, o.timeoutMs);
  if (!query) return [true, 0];
  for (;;) {
    if (!sondeOk(await p.probeTree(username, target))) {
      if (nowMs() >= echeance) return [false, nowMs() - debut];
      await sleepMs(o.pollMs ?? ELEMENT_POLL_MS);
      continue;
    }
    const trouve = center(await resolveElement(username, target, { query })) !== null;
    if (trouve === o.present) return [true, nowMs() - debut];
    if (nowMs() >= echeance) {
      if (o.present && (o.selfHeal ?? true) && selfHealAllow()) {
        await p.observe(username, target, { prompt: query, use_vision: true, use_tree: true });
        if (center(await resolveElement(username, target, { query })) !== null)
          return [true, nowMs() - debut];
      }
      return [false, nowMs() - debut];
    }
    await sleepMs(o.pollMs ?? ELEMENT_POLL_MS);
  }
}

async function waitText(
  username: string,
  target: string,
  texte: string,
  o: { present: boolean; timeoutMs: number; pollMs?: number; cmp?: string },
): Promise<[boolean, number]> {
  const p = primitivesBureau();
  const debut = nowMs();
  const echeance = debut + Math.max(0, o.timeoutMs);
  const aiguille = stripPy(texte || "");
  let premier = true;
  let derniere: unknown = "";
  let meule: unknown = "";
  for (;;) {
    const cur = sigOf(await p.grab(username, target));
    if (premier || !veritePy(cur) || hamHex(cur, derniere) > SIG_SAME) {
      const res = await p.readText(username, target, {});
      meule = estDict(res) ? ou(lire(res, "text") ?? null, "") : "";
      derniere = cur;
      premier = false;
    }
    if (textCmp(meule, aiguille, o.cmp ?? "partiel") === o.present) return [true, nowMs() - debut];
    if (nowMs() >= echeance) return [false, nowMs() - debut];
    await sleepMs(o.pollMs ?? TEXT_POLL_MS);
  }
}

/** Clé d'élément (libellé + rôle, sinon `#id`) pour repérer les apparitions. */
export function elKey(el: unknown): string {
  const libelle = lowerPy(stripPy(strPy(ou(get(el, "label"), ""))));
  const role = lowerPy(strPy(ou(get(el, "role"), "")));
  return libelle ? `${libelle}\x01${role}` : `#${strPy(ou(get(el, "id"), ""))}`;
}

function elementsDe(obs: unknown): unknown[] {
  const els = estDict(obs) ? (lire(obs, "elements") ?? null) : null;
  if (!veritePy(els)) return [];
  const it = iterPy(els);
  if (it === null) throw new ErreurPython("TypeError", "object is not iterable");
  return it;
}

async function observeKeys(username: string, target: string): Promise<Set<string>> {
  const obs = await primitivesBureau().probeTree(username, target);
  return new Set(elementsDe(obs).filter(estDict).map(elKey));
}

async function waitAppear(
  username: string,
  target: string,
  base: ReadonlySet<string>,
  o: { timeoutMs: number; pollMs?: number; minNew?: number },
): Promise<[boolean, number]> {
  const p = primitivesBureau();
  const debut = nowMs();
  const echeance = debut + Math.max(0, o.timeoutMs);
  for (;;) {
    const nouveaux = elementsDe(await p.probeTree(username, target)).filter(
      (e) => estDict(e) && !base.has(elKey(e)),
    );
    const fenetres = nouveaux.filter((e) => WINDOW_ROLES.has(lowerPy(strPy(ou(get(e, "role"), "")))));
    if (fenetres.length > 0 || nouveaux.length >= (o.minNew ?? 3)) return [true, nowMs() - debut];
    if (nowMs() >= echeance) return [false, nowMs() - debut];
    await sleepMs(o.pollMs ?? ELEMENT_POLL_MS);
  }
}

/** `re.search` de Python ; motif refusé : sous-chaîne sans casse (motif intraduisible : idem, signalé au journal). */
function chercheRegex(meule: string, aiguille: string): boolean {
  try {
    return chercherRe(aiguille, meule) !== null;
  } catch (e) {
    if (e instanceof RegexNonGeree)
      log.warn(`regex sans équivalent JS, comparée en sous-chaîne : ${aiguille}`);
    else if (!(e instanceof ErreurRe)) throw e;
    return lowerPy(meule).includes(lowerPy(aiguille));
  }
}

/** Comparaison de texte : `exact` (casse et blancs de bord ignorés), `regex` (recherche), sinon `partiel` (sous-chaîne sans casse). */
export function textCmp(meule: unknown, aiguille: unknown, cmp: unknown = "partiel"): boolean {
  const h = veritePy(meule) ? strPy(meule) : "";
  const n = veritePy(aiguille) ? strPy(aiguille) : "";
  if (!stripPy(n)) return veritePy(stripPy(h));
  const c = lowerPy(stripPy(veritePy(cmp) ? strPy(cmp) : "partiel"));
  if (c === "exact") return lowerPy(stripPy(h)) === lowerPy(stripPy(n));
  if (c === "regex") return chercheRegex(h, n);
  return lowerPy(h).includes(lowerPy(stripPy(n)));
}

/** Mode d'une attente Texte/Valeur : `cmp`, sinon l'ancien booléen `match` (regex). */
export function expectCmp(attente: unknown): string {
  const e = dictOu(attente);
  const c = lowerPy(stripPy(strPy(ou(get(e, "cmp"), ""))));
  if (c === "partiel" || c === "exact" || c === "regex") return c;
  return veritePy(get(e, "match")) ? "regex" : "partiel";
}

export function valueMatches(valeur: unknown, aiguille: unknown, cmp: unknown = "partiel"): boolean {
  return textCmp(valeur, aiguille, typeof cmp === "boolean" ? (cmp ? "regex" : "partiel") : cmp);
}

export function countOk(n: number, op: unknown, attendu: number): boolean {
  const o = stripPy(veritePy(op) ? strPy(op) : "==");
  if (o === ">=" || o === "ge") return n >= attendu;
  if (o === "<=" || o === "le") return n <= attendu;
  if (o === ">" || o === "gt") return n > attendu;
  if (o === "<" || o === "lt") return n < attendu;
  return n === attendu;
}

/** Valeur d'un élément : `value` a11y, sinon OCR ciblé sur son id. */
async function readElementValue(username: string, target: string, el: unknown): Promise<unknown> {
  if (!veritePy(el)) return "";
  const v = get(el, "value");
  if (v !== null && v !== "") return strPy(v);
  try {
    const r = await primitivesBureau().readText(username, target, {
      element_id: strPy(ou(get(el, "id"), "")),
    });
    return estDict(r) ? ou(lire(r, "text") ?? null, "") : "";
  } catch (e) {
    if (e instanceof ReplayAborted) throw e;
    return "";
  }
}

async function waitValue(
  username: string,
  target: string,
  query: string,
  attendu: string,
  o: { present: boolean; cmp: string; timeoutMs: number; pollMs?: number },
): Promise<[boolean, number]> {
  const p = primitivesBureau();
  const debut = nowMs();
  const echeance = debut + Math.max(0, o.timeoutMs);
  for (;;) {
    if (!sondeOk(await p.probeTree(username, target))) {
      if (nowMs() >= echeance) return [false, nowMs() - debut];
      await sleepMs(o.pollMs ?? ELEMENT_POLL_MS);
      continue;
    }
    const el = query ? await resolveElement(username, target, { query }) : null;
    if (valueMatches(await readElementValue(username, target, dictOu(el)), attendu, o.cmp) === o.present)
      return [true, nowMs() - debut];
    if (nowMs() >= echeance) {
      if (o.present && query && selfHealAllow()) {
        await p.observe(username, target, {
          prompt: query,
          use_vision: true,
          use_tree: true,
          persist_frame: false,
        });
        const el2 = await resolveElement(username, target, { query });
        if (valueMatches(await readElementValue(username, target, dictOu(el2)), attendu, o.cmp) === o.present)
          return [true, nowMs() - debut];
      }
      return [false, nowMs() - debut];
    }
    await sleepMs(o.pollMs ?? ELEMENT_POLL_MS);
  }
}

function etatsDe(el: unknown): string[] {
  if (!veritePy(el)) return [];
  const it = iterPy(ou(get(el, "states"), []));
  if (it === null) throw new ErreurPython("TypeError", "object is not iterable");
  return it.map((s) => lowerPy(strPy(s)));
}

async function waitState(
  username: string,
  target: string,
  query: string,
  etat: string,
  o: { timeoutMs: number; pollMs?: number },
): Promise<[boolean, number]> {
  const p = primitivesBureau();
  const debut = nowMs();
  const echeance = debut + Math.max(0, o.timeoutMs);
  const st = lowerPy(stripPy(etat || ""));
  for (;;) {
    if (!sondeOk(await p.probeTree(username, target))) {
      if (nowMs() >= echeance) return [false, nowMs() - debut];
      await sleepMs(o.pollMs ?? ELEMENT_POLL_MS);
      continue;
    }
    const el = query ? await resolveElement(username, target, { query }) : null;
    if (st && etatsDe(el).includes(st)) return [true, nowMs() - debut];
    if (nowMs() >= echeance) {
      if (st && query && selfHealAllow()) {
        await p.observe(username, target, {
          prompt: query,
          use_vision: true,
          use_tree: true,
          persist_frame: false,
        });
        if (etatsDe(await resolveElement(username, target, { query })).includes(st))
          return [true, nowMs() - debut];
      }
      return [false, nowMs() - debut];
    }
    await sleepMs(o.pollMs ?? ELEMENT_POLL_MS);
  }
}

async function waitCount(
  username: string,
  target: string,
  query: string,
  role: unknown,
  op: string,
  n: number,
  o: { timeoutMs: number; pollMs?: number },
): Promise<[boolean, number]> {
  const p = primitivesBureau();
  const debut = nowMs();
  const echeance = debut + Math.max(0, o.timeoutMs);
  const q = lowerPy(stripPy(query || ""));
  const rl = lowerPy(stripPy(veritePy(role) ? strPy(role) : ""));
  for (;;) {
    const obs = await p.probeTree(username, target);
    if (!sondeOk(obs)) {
      if (nowMs() >= echeance) return [false, nowMs() - debut];
      await sleepMs(o.pollMs ?? ELEMENT_POLL_MS);
      continue;
    }
    let compte = 0;
    for (const e of elementsDe(obs)) {
      if (!estDict(e)) continue;
      const lbl = lowerPy(strPy(ou(ou(get(e, "label"), get(e, "name")), "")));
      const ro = lowerPy(strPy(ou(get(e, "role"), "")));
      if ((!q || lbl.includes(q)) && (!rl || ro === rl)) compte += 1;
    }
    if (countOk(compte, op, n)) return [true, nowMs() - debut];
    if (nowMs() >= echeance) return [false, nowMs() - debut];
    await sleepMs(o.pollMs ?? ELEMENT_POLL_MS);
  }
}

/** Requête d'une attente : `query`, sinon `value`, sinon le libellé ou la requête de son ancre. */
export function expectQuery(attente: unknown): string {
  let q = ou(get(attente, "query"), get(attente, "value"));
  if (!veritePy(q)) {
    const ancre = dictOu(get(attente, "anchor"));
    q = ou(get(ancre, "label"), get(ancre, "query"));
  }
  return veritePy(q) ? strPy(q) : "";
}

/** Vérifie l'attente d'un pas (`element`, `text`, `value`, `state`, `count`, `appear`, `window_ready`, `none`, sinon `stable`). */
export async function checkExpect(
  username: string,
  target: string,
  attente: unknown,
  timeoutMs: number,
  base: ReadonlySet<string> | null = null,
): Promise<[boolean, number, string]> {
  const e = dictOu(attente);
  const kind = ou(get(e, "kind"), "stable");
  const q = expectQuery(e);
  if (kind === "none") return [true, 0, "none"];
  if (kind === "appear") {
    const [ok, attendu] = await waitAppear(username, target, base ?? new Set(), { timeoutMs });
    return [ok, attendu, "appear"];
  }
  if (kind === "window_ready") {
    const aid = ou(get(dictOu(get(e, "anchor")), "auto_id"), "");
    const r = await primitivesBureau().waitWindow(username, target, {
      title_re: q && !veritePy(aid) ? echapperPy(q) : "",
      auto_id: aid,
      ready: true,
      timeout_ms: timeoutMs,
    });
    const ok = estDict(r) && r["ok"] !== false && veritePy(lire(r, "found") ?? null);
    return [ok, 0, `window_ready «${strPy(ou(aid, q))}»`];
  }
  if (kind === "element" || kind === "element_gone") {
    const [ok, attendu] = await waitElement(username, target, q, { present: kind === "element", timeoutMs });
    return [ok, attendu, `${kind} «${q}»`];
  }
  if (kind === "text" || kind === "text_gone") {
    const [ok, attendu] = await waitText(username, target, q, {
      present: kind === "text",
      cmp: expectCmp(e),
      timeoutMs,
    });
    return [ok, attendu, `${kind} «${q}»`];
  }
  if (kind === "value" || kind === "value_gone") {
    const ev = strPy(ou(get(e, "expected"), ""));
    const [ok, attendu] = await waitValue(username, target, q, ev, {
      present: kind === "value",
      cmp: expectCmp(e),
      timeoutMs,
    });
    return [ok, attendu, `${kind} «${q}»=«${ev}»`];
  }
  if (kind === "state") {
    const etat = strPy(ou(get(e, "state"), ""));
    const [ok, attendu] = await waitState(username, target, q, etat, { timeoutMs });
    return [ok, attendu, `state «${q}» ${etat}`];
  }
  if (kind === "count") {
    const op = strPy(ou(get(e, "op"), "=="));
    let n: number;
    try {
      n = intPy(ou(get(e, "count"), 0));
    } catch (err) {
      if (!erreurConversion(err)) throw err;
      n = 0;
    }
    const role = ou(get(e, "role"), "");
    const [ok, attendu] = await waitCount(username, target, q, role, op, n, { timeoutMs });
    return [ok, attendu, `count «${strPy(ou(q, ou(get(e, "role"), "*")))}» ${op}${n}`];
  }
  return [
    true,
    await waitStable(username, target, { timeoutMs: Math.min(timeoutMs, STABLE_CEILING_MS) }),
    "stable",
  ];
}

/** Arguments d'action d'un pas (clés connues, sans valeur vide). */
export function actKwargs(args: unknown): Dict {
  const a = dictOu(args);
  const kw: Dict = {};
  for (const k of ACT_ARG_KEYS) {
    if (!Object.hasOwn(exigerDict(a), k)) continue;
    const v = (a as Dict)[k];
    if (v !== null && v !== undefined && v !== "") poserCle(kw, k, v);
  }
  return kw;
}

/** Libellé lisible d'un pas (journal, interface). */
export function stepLabel(pas: unknown): string {
  const op = ou(get(pas, "op"), "?");
  const a = dictOu(get(pas, "anchor"));
  let qui: unknown = ou(get(a, "label"), get(a, "query"));
  if (!veritePy(qui)) qui = veritePy(get(a, "id")) ? `#${strPy(get(a, "id"))}` : null;
  if (!veritePy(qui) && get(a, "x") !== null) qui = `(${strPy(get(a, "x"))},${strPy(get(a, "y"))})`;
  const args = dictOu(get(pas, "args"));
  if ((op === "type" || op === "paste") && veritePy(get(args, "text")))
    return `${strPy(op)} « ${strPy(get(args, "text"))} »`;
  if (op === "key" && veritePy(get(args, "keys"))) return `key ${strPy(get(args, "keys"))}`;
  if (typeof op !== "string") throw new ErreurPython("TypeError", "unsupported operand type(s) for +");
  return op + (veritePy(qui) ? ` « ${strPy(qui)} »` : "");
}

/** Coordonnées enregistrées d'une ancre : x/y explicites, sinon son centre. */
export function anchorPoint(ancre: unknown): [number, number] | null {
  const a = dictOu(ancre);
  if (get(a, "x") !== null && get(a, "y") !== null) {
    try {
      return [intPy(get(a, "x")), intPy(get(a, "y"))];
    } catch (e) {
      if (!erreurConversion(e)) throw e;
    }
  }
  return center(a);
}

/** Point de référence d'une ancre pour départager : x/y, sinon centre, sinon milieu de la boîte. */
function procheDe(a: unknown): Proche {
  if (get(a, "x") !== null && get(a, "y") !== null) return [floatPy(get(a, "x")), floatPy(get(a, "y"))];
  const c = get(a, "center");
  if (Array.isArray(c) && c.length >= 2) {
    try {
      return [floatPy(c[0]), floatPy(c[1])];
    } catch (e) {
      if (e instanceof ReplayAborted) throw e;
    }
  }
  const b = get(a, "box");
  if (Array.isArray(b) && b.length >= 4) {
    try {
      return [(floatPy(b[0]) + floatPy(b[2])) / 2, (floatPy(b[1]) + floatPy(b[3])) / 2];
    } catch (e) {
      if (e instanceof ReplayAborted) throw e;
    }
  }
  return null;
}

/** Point où agir au rejeu : a11y (auto_id puis libellé), une passe vision bornée, coordonnées, id brut. */
async function resolveAnchor(
  username: string,
  target: string,
  ancre: unknown,
  selfHeal: boolean,
): Promise<[[number, number] | null, boolean, string | null]> {
  const p = primitivesBureau();
  const a = dictOu(ancre);
  const aid = get(a, "auto_id");
  const libelle = ou(get(a, "label"), get(a, "query"));
  const role = get(a, "role");
  const proche = procheDe(a);
  const criteres = { auto_id: ou(aid, null), query: ou(libelle, null), near: proche, role };
  if (veritePy(aid) || veritePy(libelle)) {
    const obs = await p.probeTree(username, target);
    if (!(estDict(obs) && obs["ok"] === false)) {
      const pt = center(await resolveElement(username, target, criteres));
      if (pt !== null) return [pt, false, null];
    }
    if (selfHeal && veritePy(libelle) && selfHealAllow()) {
      const obs2 = await p.observe(username, target, {
        prompt: strPy(libelle),
        use_vision: true,
        use_tree: true,
      });
      if (!(estDict(obs2) && obs2["ok"] === false)) {
        const pt = center(await resolveElement(username, target, criteres));
        if (pt !== null) return [pt, true, null];
      }
    }
  }
  if (get(a, "x") !== null && get(a, "y") !== null)
    return [[intPy(get(a, "x")), intPy(get(a, "y"))], false, null];
  if (veritePy(get(a, "id"))) {
    const obs = await p.probeTree(username, target);
    if (!(estDict(obs) && obs["ok"] === false)) {
      const pt = center(await resolveElement(username, target, { element_id: strPy(get(a, "id")) }));
      if (pt !== null) return [pt, false, null];
    }
  }
  if (veritePy(libelle) && selfHealDenied())
    return [null, false, "anchor_unresolved (budget self-heal épuisé)"];
  return [null, false, "anchor_unresolved"];
}

export function stepRetry(pas: unknown): number {
  try {
    return Math.max(0, Math.min(MAX_RETRY, intPy(ou(get(pas, "retry"), 0))));
  } catch (e) {
    if (erreurConversion(e)) return 0;
    throw e;
  }
}

export function stepOnError(pas: unknown, defaut: string): string {
  const v = lowerPy(stripPy(strPy(ou(get(pas, "on_error"), ""))));
  return v === "continue" || v === "abort" ? v : defaut;
}

type Tentative = {
  status: string;
  healed: boolean;
  error: unknown;
  frame_token: unknown;
  waited_ms: number;
  expect: string;
};

/** Une tentative d'un pas : (ré)ancrage, action, vérification de l'attente (rien n'est persisté ici). */
export async function runStepOnce(
  username: string,
  target: string,
  pas: unknown,
  selfHeal = true,
): Promise<Tentative> {
  const p = primitivesBureau();
  const op = lowerPy(stripPy(strPy(ou(get(pas, "op"), ""))));
  const ancre = dictOu(get(pas, "anchor"));
  const args = dictOu(get(pas, "args"));
  const delai = clampTimeout(
    Object.hasOwn(exigerDict(pas), "timeout_ms") ? get(pas, "timeout_ms") : get(pas, "timeoutMs"),
  );
  const attente = ou(get(pas, "expect"), { kind: "stable" });
  const aid = stripPy(strPy(ou(get(dictOu(ancre), "auto_id"), "")));
  const clicUia = aid !== "" && (op === "click" || op === "left_click" || op === "double_click");
  let point: [number, number] | null = null;
  let repare = false;
  if (POINT_OPS.has(op)) {
    if (clicUia) point = anchorPoint(ancre);
    else {
      const [pt, gueri, err] = await resolveAnchor(username, target, ancre, selfHeal);
      point = pt;
      repare = gueri;
      if (point === null)
        return {
          status: "failed",
          healed: repare,
          error: err ?? "anchor_unresolved",
          frame_token: null,
          waited_ms: 0,
          expect: "",
        };
    }
  }
  let base: Set<string> | null = null;
  if (get(dictOu(attente), "kind") === "appear") {
    try {
      base = await observeKeys(username, target);
    } catch (e) {
      if (e instanceof ReplayAborted) throw e;
      base = new Set();
    }
  }
  let res: unknown;
  if (op === "launch") {
    const app = strPy(ou(ou(get(args, "app"), get(args, "target")), ""));
    try {
      res = await p.launch(username, target, { app, timeout_ms: delai });
    } catch (e) {
      if (e instanceof ReplayAborted) throw e;
      res = {
        ok: false,
        error: "exception",
        message: prefixePy(e instanceof Error ? e.message : String(e), 200),
      };
    }
  } else {
    const kw = actKwargs(args);
    poserCle(kw, "op", op);
    if (point !== null) {
      poserCle(kw, "x", point[0]);
      poserCle(kw, "y", point[1]);
    }
    if (clicUia) {
      poserCle(kw, "op", "invoke");
      poserCle(kw, "auto_id", aid);
      poserCle(kw, "name", ou(ou(get(ancre, "label"), get(ancre, "query")), ""));
      poserCle(kw, "control_type", ou(get(ancre, "role"), ""));
      if (op === "double_click") poserCle(kw, "clicks", 2);
    } else if (SEMANTIC_REPLAY_OPS.has(op)) {
      if (aid) poserCle(kw, "auto_id", aid);
      const lbl = ou(ou(get(ancre, "label"), get(ancre, "query")), "");
      if (veritePy(lbl)) {
        poserCle(kw, "name", lbl);
        poserCle(kw, "query", lbl);
      }
      const ct = ou(get(ancre, "role"), "");
      if (veritePy(ct)) poserCle(kw, "control_type", ct);
      try {
        await p.probeTree(username, target);
      } catch (e) {
        if (e instanceof ReplayAborted) throw e;
      }
    }
    try {
      res = await p.act(username, target, { semantic_click: op === "type" || op === "paste", ...kw });
    } catch (e) {
      if (e instanceof ReplayAborted) throw e;
      res = {
        ok: false,
        error: "exception",
        message: prefixePy(e instanceof Error ? e.message : String(e), 200),
      };
    }
  }
  const ok = estDict(res) && res["ok"] !== false;
  const jeton = get(dictOu(res), "frame_token");
  if (!ok)
    return {
      status: "failed",
      healed: repare,
      error: ou(get(dictOu(res), "error"), "act_failed"),
      frame_token: jeton,
      waited_ms: 0,
      expect: "",
    };
  let verdict: [boolean, number, string];
  try {
    verdict = await checkExpect(username, target, attente, delai, base);
  } catch (e) {
    if (e instanceof ReplayAborted) throw e;
    verdict = [true, 0, "expect_error"];
  }
  const [expOk, attendu, detail] = verdict;
  if (!expOk)
    return {
      status: "failed",
      healed: repare,
      error: `expect_timeout: ${detail}`,
      frame_token: jeton,
      waited_ms: attendu,
      expect: detail,
    };
  return {
    status: "passed",
    healed: repare,
    error: null,
    frame_token: jeton,
    waited_ms: attendu,
    expect: detail,
  };
}

function enregistrementSaute(i: number, pas: unknown): Dict {
  return {
    step_index: i,
    op: lowerPy(stripPy(strPy(ou(get(pas, "op"), "")))),
    label: stepLabel(pas),
    status: "skipped",
    healed: false,
    error: null,
    frame_token: null,
    duration_ms: 0,
    waited_ms: 0,
    expect: "",
    attempts: 0,
  };
}

export type OptionsRejeu = {
  onStep?: (rec: Dict) => unknown;
  selfHeal?: boolean;
  fromStep?: unknown;
  defaultOnError?: string;
  shouldAbort?: (() => unknown) | null;
};

/** Rejoue les pas avec réessais et politique d'échec (`continue`/`abort`) ; « Arrêter » est lu entre les pas et dans les attentes. */
export async function replayScenario(
  steps: unknown,
  username: string,
  target: string,
  o: OptionsRejeu = {},
): Promise<Dict> {
  const it = veritePy(steps) ? iterPy(steps) : [];
  if (it === null) throw new ErreurPython("TypeError", "object is not iterable");
  const pas = [...it];
  const total = pas.length;
  let debut: number;
  try {
    debut = Math.max(0, intPy(ou(o.fromStep ?? 0, 0)));
  } catch (e) {
    if (!erreurConversion(e)) throw e;
    debut = 0;
  }
  const arret = o.shouldAbort ?? null;
  const resultats: Dict[] = [];
  let passes = 0;
  let echecs = 0;
  let sautes = Math.min(debut, total);
  let abandon = false;
  let annule = false;
  const emettre = async (rec: Dict): Promise<void> => {
    resultats.push(rec);
    if (!o.onStep) return;
    try {
      await o.onStep(rec);
    } catch {
      log.debug("on_step a levé (ignoré)");
    }
  };
  const contexte: ContexteRejeu = { arret, reparations: selfHealCap() };
  let epuise = false;
  await contexteRejeu.run(contexte, async () => {
    try {
      for (let i = debut; i < total; i++) {
        const pasCourant = pas[i];
        const stop = arret !== null && veritePy(arret());
        if (abandon || stop) {
          if (stop && !abandon) annule = true;
          abandon = true;
          sautes += 1;
          await emettre(enregistrementSaute(i, pasCourant));
          continue;
        }
        const t0 = horloge.monotone();
        const reessais = stepRetry(pasCourant);
        let tentatives = 0;
        let sortie: Tentative = {
          status: "failed",
          healed: false,
          error: "not_run",
          frame_token: null,
          waited_ms: 0,
          expect: "",
        };
        try {
          for (let essai = 0; essai <= reessais; essai++) {
            tentatives += 1;
            sortie = await runStepOnce(username, target, pasCourant, o.selfHeal ?? true);
            if (sortie.status === "passed") break;
            if (essai < reessais) await sleepMs(RETRY_BACKOFF_MS * (essai + 1));
          }
        } catch (e) {
          if (!(e instanceof ReplayAborted)) throw e;
          annule = true;
          abandon = true;
          sautes += 1;
          await emettre(enregistrementSaute(i, pasCourant));
          continue;
        }
        const statut = sortie.status || "failed";
        if (statut === "passed") passes += 1;
        else echecs += 1;
        await emettre({
          step_index: i,
          op: lowerPy(stripPy(strPy(ou(get(pasCourant, "op"), "")))),
          label: stepLabel(pasCourant),
          status: statut,
          healed: veritePy(sortie.healed),
          error: sortie.error,
          frame_token: sortie.frame_token,
          duration_ms: Math.trunc((horloge.monotone() - t0) * 1000),
          waited_ms: Math.trunc(sortie.waited_ms || 0),
          expect: sortie.expect || "",
          attempts: tentatives,
        });
        if (statut === "failed" && stepOnError(pasCourant, o.defaultOnError ?? "continue") === "abort")
          abandon = true;
      }
    } finally {
      epuise = contexte.reparations === 0;
      if (epuise)
        log.warn(
          "budget self-heal vision ÉPUISÉ sur ce run — des ancres déplacées ont pu échouer faute de passe vision",
        );
    }
  });
  return {
    total,
    passed: passes,
    failed: echecs,
    skipped: sautes,
    from_step: debut,
    aborted: abandon,
    cancelled: annule,
    healed: resultats.filter((r) => veritePy(r["healed"])).length,
    heal_budget_exhausted: epuise,
    results: resultats,
  };
}
