// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/tokens.ts — SEUL compteur de tokens : exact via `/tokenize` et `/apply-template` du serveur de la cible, repli estimé (chars pondérés, ratio mesuré). */
import { createHash } from "node:crypto";

import { arrondiEntierPy, intPy, pyJsonDumps, strPy, utf8Remplace, veritePy } from "@elpis/commun";
import { CHARS_PER_TOKEN, config } from "@elpis/config";

import { journal } from "../journal";
import { estDict, longueurPy } from "../python";
import type { Dict } from "../python";
import { getPy, iterExige } from "../llm/dict-py";
import { engineUrlHeaders, llamaPost, monotonic } from "../llm/llama-http";
import { currentEngine } from "../llm/moteurs";
import type { EngineRef } from "../llm/moteurs";
import { surChangementDeModele } from "../llm/registre-caches";

const log = journal("tokens");

/** Surcoût fixe par message (délimiteurs de rôle du gabarit). */
export const MSG_OVERHEAD_TOKENS = 8;

/** Poids d'un caractère « large » (CJK, kana, hangul, écritures indiennes, thaï, birman, pleine chasse, emoji). */
export const WIDE_CHAR_WEIGHT = CHARS_PER_TOKEN;
/** Même table que Python : U+0900–U+109F, U+1100–U+11FF, U+2E80–U+10FFFF (points de code). */
const WIDE_CHARS_RE = /[ऀ-႟ᄀ-ᇿ⺀-\u{10ffff}]/gu;
/** `str.isascii()` : tous les points de code sous U+0080. */
function estAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** Longueur « équivalent latin » : `len(s)` en points de code, chaque caractère large comptant `WIDE_CHAR_WEIGHT`. */
export function weightedLen(s: string | null | undefined): number {
  if (!s) return 0;
  if (estAscii(s)) return s.length;
  const larges = s.match(WIDE_CHARS_RE)?.length ?? 0;
  const n = longueurPy(s);
  if (larges === 0) return n;
  return n - larges + arrondiEntierPy(larges * WIDE_CHAR_WEIGHT);
}

const RATIO_ALPHA = 0.3;
const RATIO_MIN = 1.0;
const RATIO_MAX = 8.0;
/** Ratio chars/token MESURÉ par modèle (EWMA), clé `""` = repli du process. */
export const measuredRatio = new Map<string, number>();

/** Alimente le ratio mesuré depuis une réponse RÉELLE ; une mesure polluée par des images ou hors bornes est ignorée. */
export function noteRealUsage(
  modelId: string | null | undefined,
  promptChars: number,
  promptTokens: number,
  nImages = 0,
): void {
  try {
    if (!promptTokens || promptTokens <= 0 || promptChars <= 0) return;
    if (veritePy(nImages) && intPy(nImages) > 0) return;
    const r = promptChars / promptTokens;
    if (!(r >= RATIO_MIN && r <= RATIO_MAX)) {
      log.debug(
        `ratio mesuré ${r.toFixed(2)} chars/token hors bornes [1.0, 8.0] (modèle ${String(modelId)}) — ignoré`,
      );
      return;
    }
    for (const cle of new Set([modelId || "", ""])) {
      const avant = measuredRatio.get(cle);
      measuredRatio.set(cle, avant === undefined ? r : avant + RATIO_ALPHA * (r - avant));
    }
  } catch {
    return;
  }
}

/** Ratio mesuré du modèle ; un modèle nommé jamais mesuré garde l'amorce, un appel sans modèle hérite du repli du process. */
export function measuredCharsPerToken(modelId: string | null = null): number {
  if (modelId) return measuredRatio.get(modelId) ?? CHARS_PER_TOKEN;
  return measuredRatio.get("") ?? CHARS_PER_TOKEN;
}

/** Budget de tokens matérialisé en longueur de chaîne (coupes seulement, jamais une décision). */
export function tokensToChars(nTokens: number, modelId: string | null = null): number {
  return Math.max(0, intPy(nTokens * measuredCharsPerToken(modelId)));
}

/** Variante stable (amorce 3.3) pour les coupes ré-évaluées à chaque tour. */
export function tokensToCharsStable(nTokens: number): number {
  return Math.max(0, intPy(nTokens * CHARS_PER_TOKEN));
}

function ouVide(v: unknown, vide: unknown): unknown {
  return veritePy(v) ? v : vide;
}

/** Chars pondérés comptables (content texte, nom et arguments des tool_calls) : numérateur du ratio mesuré. */
export function payloadChars(messages: readonly unknown[] | null | undefined): number {
  let total = 0;
  for (const m of messages ?? []) {
    if (!estDict(m)) continue;
    const c = getPy(m, "content");
    if (typeof c === "string") total += weightedLen(c);
    else if (Array.isArray(c)) {
      for (const bloc of c) {
        if (estDict(bloc) && typeof getPy(bloc, "text") === "string")
          total += weightedLen(getPy(bloc, "text") as string);
      }
    }
    for (const tc of iterExige(ouVide(getPy(m, "tool_calls"), []))) {
      if (!estDict(tc)) continue;
      const fn = ouVide(getPy(tc, "function"), {});
      const nom = getPy(fn, "name");
      const args = getPy(fn, "arguments");
      total +=
        weightedLen(typeof nom === "string" ? nom : "") + weightedLen(typeof args === "string" ? args : "");
    }
  }
  return total;
}

function estBlocImage(bloc: unknown): boolean {
  if (!estDict(bloc)) return false;
  const t = getPy(bloc, "type");
  return t === "image_url" || t === "image";
}

/** Nombre de blocs image (`image_url` / `image`). */
export function countImageBlocks(messages: readonly unknown[] | null | undefined): number {
  let n = 0;
  for (const m of messages ?? []) {
    if (!estDict(m)) continue;
    const c = getPy(m, "content");
    if (Array.isArray(c)) for (const bloc of c) if (estBlocImage(bloc)) n += 1;
  }
  return n;
}

/** Forfait d'un bloc image (`CTX_IMAGE_TOKEN_COST`, plancher 256), relu à l'usage. */
export function imageTokenCost(): number {
  try {
    return Math.max(256, intPy(config.CTX_IMAGE_TOKEN_COST || 1500));
  } catch {
    return 1500;
  }
}

/** Figé au chargement, comme l'import Python (comptage par message). */
export const IMAGE_TOKEN_COST = imageTokenCost();

/** Un message estimé au ratio MESURÉ (surcoût fixe et forfait image inclus), sans I/O. */
export function estTokensMessageMeasured(m: Dict, modelId: string | null = null): number {
  const ratio = measuredCharsPerToken(modelId);
  let total = MSG_OVERHEAD_TOKENS + intPy(payloadChars([m]) / ratio);
  const c = getPy(m, "content");
  if (Array.isArray(c)) {
    let cout: number | null = null;
    for (const bloc of c) {
      if (estBlocImage(bloc)) {
        cout ??= imageTokenCost();
        total += cout;
      }
    }
  }
  return total;
}

/** Part du prompt occupée par les OUTILS (définitions, appels re-soumis, résultats), au ratio mesuré. */
export function toolPromptTokens(
  messages: readonly unknown[] | null | undefined,
  modelId: string | null = null,
  options: { defsTokens?: number | null } = {},
): number {
  const ratio = measuredCharsPerToken(modelId);
  let n = Math.max(0, intPy(options.defsTokens || 0));
  for (const m of messages ?? []) {
    if (!estDict(m)) continue;
    if (getPy(m, "role") === "tool") n += estTokensMessageMeasured(m, modelId);
    else if (veritePy(getPy(m, "tool_calls")))
      n += intPy(payloadChars([{ tool_calls: m["tool_calls"] }]) / ratio);
  }
  return n;
}

/** Somme des estimations mesurées (delta sans I/O du fast-path). */
export function measuredPromptTokens(
  messages: readonly unknown[],
  options: { modelId?: string | null; extraFixed?: number | null } = {},
): number {
  let total = 0;
  for (const m of messages) if (estDict(m)) total += estTokensMessageMeasured(m, options.modelId ?? null);
  return total + Math.max(0, intPy(options.extraFixed || 0));
}

/** Estimation d'un texte brut (chars pondérés / 3.3). */
export function estTokensText(s: string | null | undefined): number {
  return intPy(weightedLen(s) / CHARS_PER_TOKEN);
}

/** Forfait image total (à ajouter aux comptes EXACTS, qui ne voient que le texte). */
export function imageForfaitTokens(messages: readonly unknown[] | null | undefined): number {
  const n = countImageBlocks(messages);
  return n ? n * imageTokenCost() : 0;
}

/** Estimation d'UN message OpenAI complet (texte, blocs, forfait image, tool_calls, surcoût). */
export function estTokensMessage(m: Dict): number {
  let total = MSG_OVERHEAD_TOKENS;
  let cout: number | null = null;
  const c = getPy(m, "content");
  if (typeof c === "string") total += estTokensText(c);
  else if (Array.isArray(c)) {
    for (const bloc of c) {
      if (!estDict(bloc)) continue;
      const t = getPy(bloc, "text");
      if (typeof t === "string") total += estTokensText(t);
      else if (estBlocImage(bloc)) {
        cout ??= imageTokenCost();
        total += cout;
      }
    }
  }
  for (const tc of iterExige(ouVide(getPy(m, "tool_calls"), []))) {
    if (!estDict(tc)) continue;
    const fn = ouVide(getPy(tc, "function"), {});
    const nom = getPy(fn, "name");
    if (typeof nom === "string") total += estTokensText(nom);
    const args = getPy(fn, "arguments");
    if (typeof args === "string") total += estTokensText(args);
  }
  return total;
}

/** Approximation sans I/O au ratio unifié 3.3 (repli de la pré-porte de compression). */
export function approxPromptTokens(
  messages: readonly unknown[],
  options: { extraFixed?: number | null } = {},
): number {
  let total = 0;
  for (const m of messages) if (estDict(m)) total += estTokensMessage(m);
  return total + Math.max(0, intPy(options.extraFixed || 0));
}

// ── Comptage exact (`/tokenize`, `/apply-template`) ─────────────────────────

export const TOKENIZE_CACHE_MAX = 2048;
/** LRU `(modèle du serveur, sha256[:24] du texte, add_special)` → nombre de tokens. */
export const tokenizeCache = new Map<string, number>();
export const TOKENIZE_BACKOFF_S = 3.0;
export const tokenizeDownUntil = new Map<string, number>();
export const TOKENIZE_DOWN_ERRORS: ReadonlySet<string> = new Set([
  "ConnectError",
  "ConnectTimeout",
  "RemoteProtocolError",
  "ConnectionRefusedError",
  "ConnectionResetError",
  "OSError",
]);
export const TOKENIZE_SLOW_TEXT_CHARS = 20_000;

/** Ouvre le disjoncteur de `/tokenize` si l'échec signe un serveur hors d'état (pas un pool saturé ni un gros texte lent). */
function noteEchecTokenize(r: Dict | null, engine: EngineRef, nbChars: number): void {
  if (!veritePy(r) || r === null || r["_status"] !== 0) return;
  const type = strPy(ouVide(r["error_type"], ""));
  if (
    TOKENIZE_DOWN_ERRORS.has(type) ||
    ((type === "ReadTimeout" || type === "WriteTimeout") && nbChars <= TOKENIZE_SLOW_TEXT_CHARS)
  )
    tokenizeDownUntil.set(engineUrlHeaders("/tokenize", engine)[0], monotonic() + TOKENIZE_BACKOFF_S);
}

/** Disjoncteur de `/tokenize` ouvert pour ce serveur ? Une résolution en échec vaut « fermé ». */
export function tokenizeBackoffActive(engine: EngineRef | null = null): boolean {
  if (tokenizeDownUntil.size === 0) return false;
  let url: string;
  try {
    [url] = engineUrlHeaders("/tokenize", engine);
  } catch {
    return false;
  }
  const jusque = tokenizeDownUntil.get(url);
  return jusque !== undefined && monotonic() < jusque;
}

function cleTokenize(
  texte: string,
  modelId: string | null,
  addSpecial: boolean,
  engine: EngineRef | null,
): string {
  const h = createHash("sha256").update(utf8Remplace(texte)).digest("hex").slice(0, 24);
  const mk = engine !== null ? engine.cacheKey(modelId) : modelId || "";
  return JSON.stringify([mk, h, addSpecial]);
}

/** Tokens EXACTS d'un texte (tokenizer du modèle du serveur de la cible), LRU 2048 ; `null` si indisponible. */
export async function countTokensExact(
  text: string,
  modelId: string | null = null,
  options: { timeout?: number; useCache?: boolean; addSpecial?: boolean; signal?: AbortSignal } = {},
): Promise<number | null> {
  options.signal?.throwIfAborted();
  if (!text) return 0;
  const useCache = options.useCache ?? true;
  const addSpecial = options.addSpecial ?? false;
  const eng = currentEngine();
  if (!eng.isLlamacpp) return null;
  const cle = useCache ? cleTokenize(text, modelId, addSpecial, eng) : null;
  if (cle !== null) {
    const v = tokenizeCache.get(cle);
    if (v !== undefined) {
      tokenizeCache.delete(cle);
      tokenizeCache.set(cle, v);
      return v;
    }
  }
  if (tokenizeBackoffActive(eng)) return null;
  const corps: Dict = { content: text, add_special: addSpecial };
  if (modelId) corps["model"] = modelId;
  const r = await llamaPost("/tokenize", corps, options.timeout ?? 5.0, {
    engine: eng,
    signal: options.signal,
  });
  if (r["_status"] !== 200) {
    noteEchecTokenize(r, eng, longueurPy(text));
    return null;
  }
  const jetons = r["tokens"];
  if (!Array.isArray(jetons)) return null;
  const n = jetons.length;
  if (cle !== null) {
    tokenizeCache.delete(cle);
    tokenizeCache.set(cle, n);
    while (tokenizeCache.size > TOKENIZE_CACHE_MAX) {
      const ancienne = tokenizeCache.keys().next().value;
      if (ancienne === undefined) break;
      tokenizeCache.delete(ancienne);
    }
  }
  return n;
}

/** Content multimodal aplati en texte pour `/apply-template` (les images ont leur forfait à part). */
export function messagesTextOnly(messages: readonly unknown[]): unknown[] {
  return messages.map((m) => {
    const c = getPy(m, "content");
    if (!Array.isArray(c)) return m;
    const texte = c
      .filter((b) => estDict(b) && typeof getPy(b, "text") === "string")
      .map((b) => getPy(b, "text", "") as string)
      .join(" ");
    return { ...(m as Dict), content: texte };
  });
}

/** Compte EXACT du prompt rendu (`/apply-template` puis `/tokenize` avec `add_special`), égal au `prompt_tokens` de llama.cpp. */
export async function countRenderedPromptTokensExact(
  messages: readonly unknown[],
  tools: readonly unknown[] | null = null,
  modelId: string | null = null,
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<number | null> {
  if (messages.length === 0) return 0;
  const eng = currentEngine();
  if (!eng.isLlamacpp) return null;
  if (tokenizeBackoffActive(eng)) return null;
  const corps: Dict = { messages: messagesTextOnly(messages) };
  if (tools && tools.length > 0) corps["tools"] = tools;
  if (modelId) corps["model"] = modelId;
  const timeout = options.timeout ?? 5.0;
  const r = await llamaPost("/apply-template", corps, timeout, { engine: eng, signal: options.signal });
  if (r["_status"] !== 200) {
    noteEchecTokenize(r, eng, 0);
    return null;
  }
  const prompt = r["prompt"];
  if (typeof prompt !== "string" || !prompt) return null;
  return countTokensExact(prompt, modelId, { timeout, addSpecial: true, signal: options.signal });
}

/** Tâches concurrentes bornées (le `asyncio.Semaphore(8)` des comptages). */
async function enParallele<T, R>(
  elements: readonly T[],
  limite: number,
  fn: (e: T) => Promise<R>,
): Promise<R[]> {
  const sorties: R[] = new Array<R>(elements.length);
  let prochain = 0;
  const ouvrier = async (): Promise<void> => {
    while (prochain < elements.length) {
      const i = prochain++;
      sorties[i] = await fn(elements[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, elements.length) }, ouvrier));
  return sorties;
}

/** Tokens d'une conversation : rendu exact d'abord, sinon par message (+4 par message) ; `null` dès qu'un message échappe. */
export async function countTokensForMessages(
  messages: readonly unknown[],
  modelId: string | null = null,
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<number | null> {
  if (messages.length === 0) return 0;
  const timeout = options.timeout ?? 5.0;
  const signal = options.signal;
  const rendu = await countRenderedPromptTokensExact(messages, null, modelId, { timeout, signal });
  if (typeof rendu === "number" && rendu > 0) return rendu;
  const textes = messages.filter((m) => estDict(m)).map((m) => messageTextForTokenize(m as Dict));
  if (textes.length === 0) return 0;
  if (tokenizeBackoffActive()) return null;
  const comptes = await enParallele(textes, 8, (t) => countTokensExact(t, modelId, { timeout, signal }));
  if (comptes.some((c) => c === null)) return null;
  return (comptes as number[]).reduce((s, c) => s + c + 4, 0);
}

/** Tout le cache de tokenisation, ou les entrées d'un modèle (clé brute ou `<serveur>|<modèle>`). */
export function invalidateTokenizeCache(modelId: string | null = null): void {
  if (modelId === null) {
    tokenizeCache.clear();
    return;
  }
  for (const cle of [...tokenizeCache.keys()]) {
    const [mk] = JSON.parse(cle) as [string];
    if (mk === modelId || mk.endsWith("|" + modelId)) tokenizeCache.delete(cle);
  }
}

// ── Mémo de comptage par message ────────────────────────────────────────────

/** Signature bon marché d'un message (rôle, blocs, taille, empreintes du texte et des tool_calls, modèle). */
function signatureMemo(m: Dict, modelId: string | null): string {
  const c = getPy(m, "content");
  let taille = 0;
  let blocs = 0;
  let empreinte: string[] = [];
  if (typeof c === "string") {
    const pts = Array.from(c);
    [taille, blocs, empreinte] = [pts.length, 1, [pts.slice(0, 24).join(""), pts.slice(-24).join("")]];
  } else if (Array.isArray(c)) {
    for (const b of c) if (estDict(b)) taille += longueurPy(strPy(ouVide(getPy(b, "text"), "")));
    blocs = c.length;
    const premier = c.find((b) => estDict(b) && typeof getPy(b, "text") === "string") as Dict | undefined;
    const t0 = Array.from((premier?.["text"] as string | undefined) ?? "");
    empreinte = [t0.slice(0, 24).join(""), t0.slice(-24).join("")];
  }
  const tcs = getPy(m, "tool_calls");
  const appels = Array.isArray(tcs)
    ? tcs.map((tc) => {
        const fn = estDict(tc) ? ouVide(getPy(tc, "function"), {}) : {};
        const a = estDict(fn) ? getPy(fn, "arguments") : "";
        const args = Array.from(typeof a === "string" ? a : "");
        return [
          estDict(tc) ? strPy(ouVide(getPy(tc, "id"), "")) : "",
          estDict(fn) ? strPy(ouVide(getPy(fn, "name"), "")) : "",
          args.length,
          args.slice(0, 24).join(""),
          args.slice(-24).join(""),
        ];
      })
    : [];
  return JSON.stringify([
    getPy(m, "role") ?? null,
    blocs,
    taille,
    appels.length,
    modelId || "",
    appels,
    empreinte,
  ]);
}

/** Mémo par OBJET message (le `id(m)` de Python, sans adresse recyclable) : signature, contenu tenu, tokens. */
const memoMessages = new WeakMap<object, [string, unknown, number]>();
export const SHORT_TOKEN_MEMO_MAX = 512;
export const SHORT_TOKEN_CHARS = 512;
/** Mémo par CONTENU des messages courts sans tool_calls (copies neuves d'un message élagué). */
export const shortTokenMemo = new Map<string, number>();

function memoLookup(m: Dict, modelId: string | null): number | null {
  const ent = memoMessages.get(m);
  if (ent === undefined) return null;
  if (ent[0] !== signatureMemo(m, modelId) || ent[1] !== getPy(m, "content")) {
    memoMessages.delete(m);
    return null;
  }
  return ent[2];
}

function shortKey(m: Dict, modelId: string | null): string | null {
  const c = getPy(m, "content");
  if (typeof c !== "string" || longueurPy(c) > SHORT_TOKEN_CHARS || veritePy(getPy(m, "tool_calls")))
    return null;
  return JSON.stringify([modelId || "", getPy(m, "role") ?? null, c]);
}

function shortLookup(m: Dict, modelId: string | null): number | null {
  const cle = shortKey(m, modelId);
  if (cle === null) return null;
  const v = shortTokenMemo.get(cle);
  if (v === undefined) return null;
  shortTokenMemo.delete(cle);
  shortTokenMemo.set(cle, v);
  return v;
}

function memoStore(m: Dict, modelId: string | null, tokens: number): void {
  memoMessages.set(m, [signatureMemo(m, modelId), getPy(m, "content"), tokens]);
  const cle = shortKey(m, modelId);
  if (cle !== null) {
    shortTokenMemo.delete(cle);
    shortTokenMemo.set(cle, tokens);
    while (shortTokenMemo.size > SHORT_TOKEN_MEMO_MAX) {
      const ancienne = shortTokenMemo.keys().next().value;
      if (ancienne === undefined) break;
      shortTokenMemo.delete(ancienne);
    }
  }
}

/** Texte brut d'UN message pour `/tokenize` : rôle, contenu texte, nom et arguments des tool_calls. */
export function messageTextForTokenize(m: Dict): string {
  const parts: string[] = [];
  const role = getPy(m, "role");
  if (veritePy(role)) parts.push(strPy(role));
  const c = getPy(m, "content");
  if (typeof c === "string") parts.push(c);
  else if (Array.isArray(c)) {
    for (const bloc of c) {
      if (estDict(bloc) && typeof getPy(bloc, "text") === "string") parts.push(getPy(bloc, "text") as string);
    }
  }
  for (const tc of iterExige(ouVide(getPy(m, "tool_calls"), []))) {
    if (!estDict(tc)) continue;
    const fn = ouVide(getPy(tc, "function"), {});
    const nom = getPy(fn, "name");
    if (typeof nom === "string") parts.push(nom);
    const args = getPy(fn, "arguments");
    if (typeof args === "string") parts.push(args);
  }
  return parts.filter((p) => p).join("\n");
}

/** Tokens PAR MESSAGE (exacts, repli estimé par message). */
export async function countMessagesTokensPerMsg(
  messages: readonly Dict[],
  modelId: string | null = null,
  options: { signal?: AbortSignal } = {},
): Promise<number[]> {
  const [comptes] = await countMessagesTokensPerMsgEx(messages, modelId, options);
  return comptes;
}

/** `[tokens par message, messages en repli estimé]` : mémo par message, `/tokenize` concurrent (8) sur les seuls messages froids. */
export async function countMessagesTokensPerMsgEx(
  messages: readonly Dict[],
  modelId: string | null = null,
  options: { signal?: AbortSignal } = {},
): Promise<[number[], number]> {
  options.signal?.throwIfAborted();
  const textes: (string | null)[] = [];
  const memos: (number | null)[] = [];
  for (const m of messages) {
    const enMemo = memoLookup(m, modelId) ?? shortLookup(m, modelId);
    memos.push(enMemo);
    textes.push(enMemo === null ? messageTextForTokenize(m) : null);
  }
  const aFaire = textes.flatMap((t, i) => (t ? [i] : []));
  const comptes: (number | null)[] = new Array<number | null>(textes.length).fill(null);
  if (aFaire.length > 0) {
    const resultats = await enParallele(aFaire, 8, async (i) => {
      try {
        return await countTokensExact(textes[i] as string, modelId, { timeout: 5.0, signal: options.signal });
      } catch (e) {
        if (options.signal?.aborted) throw e;
        return null;
      }
    });
    aFaire.forEach((i, k) => (comptes[i] = resultats[k] ?? null));
  }
  const sortie: number[] = [];
  let enRepli = 0;
  messages.forEach((m, i) => {
    const memo = memos[i] ?? null;
    if (memo !== null) {
      sortie.push(memo);
      return;
    }
    let n = comptes[i] ?? null;
    if (n === null) {
      sortie.push(estTokensMessageMeasured(m, modelId));
      if (textes[i]) enRepli += 1;
      return;
    }
    n += MSG_OVERHEAD_TOKENS;
    const c = getPy(m, "content");
    if (Array.isArray(c)) for (const bloc of c) if (estBlocImage(bloc)) n += IMAGE_TOKEN_COST;
    memoStore(m, modelId, n);
    sortie.push(n);
  });
  return [sortie, enRepli];
}

/** Tokens du schéma JSON des outils : `[total, estimé]` (exact, sinon estimation ; 0 estimé sur exception). */
export async function countToolsTokensEx(
  toolsPayload: readonly unknown[] | null | undefined,
  modelId: string | null = null,
): Promise<[number, boolean]> {
  if (!toolsPayload || toolsPayload.length === 0) return [0, false];
  try {
    const tj = pyJsonDumps(toolsPayload, { ensureAscii: false });
    const tt = await countTokensExact(tj, modelId, { timeout: 5.0 });
    if (tt !== null) return [intPy(tt), false];
    return [Math.max(1, estTokensText(tj)), true];
  } catch {
    return [0, true];
  }
}

surChangementDeModele("tokenize", () => invalidateTokenizeCache());
