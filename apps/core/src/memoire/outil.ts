// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/outil.ts — corps des outils `memory` et `session_search` (requête, bornes, erreurs guidées, portée du compte) en fonctions à brancher sur le socle MCP, port de llm_core/tools/memory_tools.py. */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";

import {
  estAlnumPy,
  FlottantPy,
  floatPy,
  lowerPy,
  longueurPy,
  prefixePy,
  pyJsonDumps,
  reprPy,
  rstripPy,
  splitlinesPy,
  splitPy,
  strPy,
  stripPy,
  texteOu,
  utf8Remplace,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, reloadMemoryConfigFromDisk } from "@elpis/config";
import type { Executeur } from "@elpis/db";

import * as memoryJournal from "./journal";
import { sanitizeEntryText, StoreBusyError } from "./magasin";
import type { MarkdownStore, StoreOpResult } from "./magasin";
import { cheminPy, safeUsername, storeFor } from "./portee";
import { migrateLegacyMemory } from "./migration";
import { sessionMessageByRef, sessionSearchSnippets } from "./sessions";

const MEMORY_SCOPE = "user";
/** Plafond de mots d'une requête de `session_search` (écart : Python les cherche tous dans un fil à part, ici le SQL bloque la boucle de main : 50 000 mots = 4 s). */
export const MAX_MOTS_REQUETE = 1000;
const ENTRY_EXCERPT_CHARS = 60;
const PAIRES_DE_GUILLEMETS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
];

/** Identité de l'appel telle que l'a résolue le socle (jeton, puis `_meta`, puis `guest`), jamais lue dans les arguments du modèle. */
export interface IdentiteAppel {
  username: string;
  chatId: string;
}

/** Arguments de l'outil `memory`, déjà validés par le socle (ou bruts, pour un appel direct). */
export interface ArgsMemoire {
  action?: unknown;
  store?: unknown;
  content?: unknown;
  target?: unknown;
  old_text?: unknown;
  title?: unknown;
}

/** Arguments de l'outil `session_search`. */
export interface ArgsSessionSearch {
  query?: unknown;
  limit?: unknown;
  ref?: unknown;
}

export interface DependancesMemoire {
  /** `root_base` : dossier des bacs à sable, le magasin vit sous `<racine>/<compte>/memory`. */
  racine: string;
  /** `_memory_limits` : (memory, user), relues sur disque à chaque appel ; absent : celles de la config. */
  limites?: () => [number, number];
  /** Fabrique du magasin (tests : magasin en panne) ; absent : `storeFor`. */
  magasin?: (kind: string, username: string, scope: string, limites: [number, number]) => MarkdownStore;
  /** Horloge de l'audit (`time.time()`). */
  horloge?: () => number;
  /** `ctx.info`. */
  info?: (message: string) => void | Promise<void>;
}

export interface DependancesSessionSearch {
  /** Base lue pour `session_messages` et les titres des chats. */
  base: Executeur;
  /** `get_user(username)["id"]`, `null` si le compte n'existe pas. */
  idUtilisateur(username: string): Promise<number | null>;
}

/** `_toolkit.unquote` : retire les guillemets dont un modèle entoure une valeur, couches imbriquées comprises. */
export function unquote(s: unknown): string {
  if (s === null || s === undefined) return "";
  let t = stripPy(strPy(s));
  let change = true;
  while (change && t.length >= 2) {
    change = false;
    for (const [a, b] of PAIRES_DE_GUILLEMETS) {
      if (t.startsWith(a) && t.endsWith(b)) {
        t = stripPy(t.slice(a.length, t.length - b.length));
        change = true;
        break;
      }
    }
  }
  return t;
}

const normaliserChoix = (s: string): string => lowerPy(s).replaceAll("-", "_").replaceAll(" ", "_");

/** `_toolkit.as_enum` : la valeur de `choices` dont le nom normalisé (casse, tirets, espaces) égale celui de `v`, sinon `defaut`. */
export function asEnum<D extends string | null>(
  v: unknown,
  choices: readonly string[],
  defaut: D,
): string | D {
  const s = normaliserChoix(unquote(v));
  return choices.find((c) => normaliserChoix(c) === s) ?? defaut;
}

/** `_opt_str` : paramètre facultatif en texte, `null` s'il est absent. */
function optStr(v: unknown): string | null {
  return v === null || v === undefined ? null : strPy(v);
}

const gardeSurs = (s: string): string =>
  Array.from(s)
    .filter((c) => estAlnumPy(c) || c === "-" || c === "_")
    .join("");

/** `_safe_username` de memory_tools : lettres et chiffres Unicode, `-` et `_` gardés, « guest » si rien ne reste. */
export function safeUsernameOutil(username: string | null | undefined): string {
  return gardeSurs(username ?? "") || "guest";
}

/** `_toolkit._safe_chat_id` : `[A-Za-z0-9_-]` gardés, « default » si rien ne reste. */
function safeChatIdToolkit(chatId: string | null | undefined): string {
  if (!chatId) return "default";
  return String(chatId).replace(/[^A-Za-z0-9_-]/gu, "") || "default";
}

/** `_safe_chat_id` de memory_tools : identifiant sûr inchangé, sinon sa partie sûre suivie de 8 caractères du SHA-1 de l'original. */
export function safeChatIdOutil(chatId: string | null | undefined): string {
  if (!chatId) return "default";
  const brut = String(chatId);
  const sortie = gardeSurs(brut);
  if (!sortie) return "default";
  if (sortie === brut) return sortie;
  return `${sortie}_${createHash("sha1").update(utf8Remplace(brut)).digest("hex").slice(0, 8)}`;
}

/** `_identity` : (compte, chat) de l'appel, nettoyés comme `get_username`/`get_chat_id` du toolkit puis comme memory_tools. */
export function identiteMemoire(id: IdentiteAppel): [string, string] {
  return [safeUsernameOutil(safeUsername(id.username)), safeChatIdOutil(safeChatIdToolkit(id.chatId))];
}

/** `_memory_limits` : limites relues sur disque (config illisible : celles du process). */
export function limitesMemoire(): [number, number] {
  try {
    reloadMemoryConfigFromDisk();
  } catch {
    return limitesCourantes();
  }
  return limitesCourantes();
}

function limitesCourantes(): [number, number] {
  return [Math.trunc(config.MEMORY_MD_CHAR_LIMIT), Math.trunc(config.USER_MD_CHAR_LIMIT)];
}

/** `ErrEnvelope(...).model_dump()` : champs dans l'ordre du modèle, absents à `null`. */
export function errEnvelope(
  error: string,
  message: string | null = null,
  extra: { fix?: string | null; retryable?: boolean | null } = {},
): Dict {
  return {
    ok: false,
    error,
    message,
    fix: extra.fix ?? null,
    next_action: null,
    retryable: extra.retryable ?? null,
  };
}

/** `_fmt_entry` : `[id] (Nc) première ligne tronquée`. */
export function fmtEntry(eid: string, text: unknown, maxChars = ENTRY_EXCERPT_CHARS): string {
  const full = stripPy(texteOu(text, ""));
  let first = full ? (splitlinesPy(full)[0] ?? "") : "";
  if (longueurPy(first) > maxChars) first = rstripPy(prefixePy(first, maxChars)) + "…";
  else if (full.includes("\n")) first += " …";
  return `[${eid}] (${longueurPy(full)}c) ${first}`;
}

function fmtEntries(res: StoreOpResult): string[] {
  return res.entries.map((txt, i) => fmtEntry(res.entry_ids[i] ?? "", txt));
}

function fmtIndex(res: StoreOpResult, i: number | null): string | null {
  if (i === null || !(i >= 0 && i < res.entries.length)) return null;
  return fmtEntry(res.entry_ids[i] ?? "", res.entries[i]);
}

/** `_fix_for` : geste correctif selon le code d'échec du magasin. */
function fixFor(res: StoreOpResult): string | null {
  const code = res.error_code;
  if (!code) return null;
  if (code === "no_match") {
    const c = fmtIndex(res, res.closest_index);
    const base = "Reuse the exact bracketed id from entries.";
    return c ? `${base} Likely candidate: ${c}` : base;
  }
  if (code === "ambiguous") {
    const cands = res.candidate_indexes
      .map((i) => fmtIndex(res, i))
      .filter((c) => c)
      .join(" ; ");
    return `Several entries match — narrow down with ONE id: ${cands}`;
  }
  if (code === "over_limit")
    return (
      `Budget full (${res.chars}/${res.limit}c). Consolidate: remove/replace an ` +
      "entry, or action=rewrite to rewrite the whole store shorter."
    );
  if (code === "empty_content")
    return "Pass the text in content (for rewrite: entries separated by a --- line).";
  return null;
}

/** `_saved_result` : retour court d'une écriture réussie (id de l'entrée écrite, remplissage, consigne de fin). */
function savedResult(
  act: string,
  store: string,
  res: StoreOpResult,
  content: string | null,
  op: string | null,
): Dict {
  let eid = "";
  if (act === "add" || act === "replace") {
    const txt = sanitizeEntryText(stripPy(content ?? ""));
    const i = res.entries.indexOf(txt);
    if (i >= 0) eid = res.entry_ids[i] ?? "";
  }
  const usage =
    `${strPy(res.usage_pct)}% · ${res.chars}/${res.limit} chars · ` +
    `${res.n_entries} entr${res.n_entries === 1 ? "y" : "ies"}`;
  let note: string;
  if (res.unchanged) note = `Already stored as [${eid}] (identical text): nothing written.`;
  else if (act === "add") note = "Saved. Done — do not repeat this call.";
  else if (act === "replace") note = "Updated. Done — do not repeat this call.";
  else if (act === "remove") note = "Removed. Done — do not repeat this call.";
  else
    note = `Store rewritten (${res.n_entries} entries, new ids next turn). Done — do not repeat this call.`;
  return { ok: true, action: act, store, id: eid, op: op ?? "", usage, note };
}

/** Écrit une ligne d'audit JSONL à côté du magasin ; best-effort. */
async function auditer(
  memDir: string,
  horloge: () => number,
  act: string,
  store: string,
  res: StoreOpResult,
): Promise<void> {
  try {
    await mkdir(memDir, { recursive: true });
    const ligne = pyJsonDumps(
      {
        ts: new FlottantPy(horloge()),
        action: act,
        store,
        scope: MEMORY_SCOPE,
        ok: Boolean(res.ok),
        error: res.error,
        error_code: res.error_code,
        chars: res.chars,
        limit: res.limit,
        usage_pct: res.usage_pct,
        n_entries: res.n_entries,
      },
      { ensureAscii: false },
    );
    await appendFile(cheminPy(memDir, ".audit.jsonl"), ligne + "\n", "utf8");
  } catch {
    return;
  }
}

/** Corps de l'outil `memory` : `model_dump()` de MemorySaved, MemoryResult ou ErrEnvelope. */
export async function memory(
  dep: DependancesMemoire,
  identite: IdentiteAppel,
  args: ArgsMemoire,
): Promise<Dict> {
  const [username, chat] = identiteMemoire(identite);
  const limites = (dep.limites ?? limitesMemoire)();
  const title = optStr(args.title);
  const content = optStr(args.content);
  const target = optStr(args.target);
  const oldText = optStr(args.old_text);
  const store = asEnum(args.store, ["memory", "user"], "memory");
  let memDir: string;
  let md: MarkdownStore;
  try {
    memDir = await migrateLegacyMemory(dep.racine, username);
    md = (dep.magasin ?? defautMagasin(dep.racine))(store, username, MEMORY_SCOPE, limites);
  } catch (e) {
    return errEnvelope("memory_store_unavailable", `memory store unavailable: ${messageDe(e)}`, {
      retryable: true,
    });
  }
  const act = asEnum(args.action, ["add", "replace", "remove", "rewrite"], null);
  if (act === null)
    return errEnvelope("bad_action", `unknown action: ${reprPy(args.action ?? null)}`, {
      fix: "Use add, replace, remove or rewrite.",
    });
  const tgt = stripPy(target || oldText || "");
  if ((act === "replace" || act === "remove") && !tgt)
    return errEnvelope("target_required", `${act} requires target`, {
      fix: "Pass target = the [xxxx] id shown before the entry, or an exact excerpt.",
    });
  if (act === "rewrite" && !stripPy(content || ""))
    return errEnvelope("content_required", "rewrite requires content", {
      fix: "Pass the ENTIRE new store content in content, entries separated by a --- line.",
    });
  let res: StoreOpResult;
  let op: string | null = null;
  try {
    if (act === "add") res = await md.add(content || "");
    else if (act === "replace") res = await md.replace(tgt, content || "");
    else if (act === "remove") res = await md.remove(tgt);
    else res = await md.rewrite(content || "");
    await auditer(memDir, dep.horloge ?? (() => Date.now() / 1000), act, store, res);
    if (res.ok && !res.unchanged) {
      try {
        op = await memoryJournal.append(memDir, {
          action: act,
          store,
          before: res.before,
          after: res.entries,
          source: "tool",
          chat_id: chat && chat !== "default" ? chat : null,
          title,
        });
      } catch {
        op = null;
      }
    }
  } catch (e) {
    if (!(e instanceof StoreBusyError)) throw e;
    return errEnvelope("store_busy", `memory temporarily locked: ${e.message}`, {
      retryable: true,
      fix: "Retry in a moment.",
    });
  }
  if (res.ok) {
    await dep.info?.(
      `memory ${act} on ${store} for ${username} (${strPy(res.usage_pct)}% · ${res.chars}/${res.limit})`,
    );
    return savedResult(act, store, res, content, op);
  }
  return {
    ok: res.ok,
    action: res.action,
    store,
    error: res.error_code,
    message: res.error,
    fix: fixFor(res),
    closest: fmtIndex(res, res.closest_index),
    chars: res.chars,
    limit: res.limit,
    usage_pct: res.usage_pct,
    n_entries: res.n_entries,
    entries: fmtEntries(res),
  };
}

function defautMagasin(racine: string): NonNullable<DependancesMemoire["magasin"]> {
  return (kind, username, scope, [memoryLimit, userLimit]) =>
    storeFor(kind, username, scope, racine, { memoryLimit, userLimit });
}

function messageDe(e: unknown): string {
  return e instanceof Error ? e.message : strPy(e);
}

/** `_iso_day` : jour local AAAA-MM-JJ d'un horodatage, `""` s'il n'en est pas un. */
export function isoDay(ts: unknown): string {
  try {
    const d = new Date(floatPy(ts) * 1000);
    if (Number.isNaN(d.getTime())) return "";
    const deux = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}`;
  } catch {
    return "";
  }
}

/** Un entier qui n'est pas un booléen, comme `isinstance(v, int) and not isinstance(v, bool)`. */
function entierPur(v: unknown): v is number | bigint {
  return typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v));
}

function correspondance(r: Dict): Dict {
  return {
    ref: r["ref"],
    date: isoDay(r["ts"]),
    chat: texteOu(r["title"], ""),
    role: r["role"] ?? "",
    excerpt: r["excerpt"],
  };
}

/** Corps de l'outil `session_search` : `model_dump()` de SessionSearchResult ou ErrEnvelope ; seul le compte de l'identité est lu. */
export async function sessionSearch(
  dep: DependancesSessionSearch,
  identite: IdentiteAppel,
  args: ArgsSessionSearch,
): Promise<Dict> {
  const [username] = identiteMemoire(identite);
  const q = stripPy(optStr(args.query) ?? "");
  const ref = entierPur(args.ref) ? args.ref : null;
  if (ref !== null) {
    let hit;
    try {
      const uid = await dep.idUtilisateur(username);
      hit = uid !== null ? await sessionMessageByRef(dep.base, uid, ref) : null;
    } catch (e) {
      return errEnvelope("search_failed", `search failed: ${messageDe(e)}`, { retryable: true });
    }
    if (!hit)
      return errEnvelope("unknown_ref", `no passage with ref ${ref}`, {
        fix: "Use a ref returned by a previous session_search.",
      });
    const m = correspondance({
      ref: hit.ref,
      ts: hit.ts,
      title: hit.title,
      role: hit.role,
      excerpt: hit.content + (hit.truncated ? " … [truncated]" : ""),
    });
    return { ok: true, query: "", matches: [m], count: 1, error: null };
  }
  if (!q) return errEnvelope("empty_query", "query is empty", { fix: "Pass keywords to search for." });
  let rows;
  try {
    const uid = await dep.idUtilisateur(username);
    if (uid === null) return { ok: true, query: q, matches: [], count: 0, error: null };
    const lim = Math.max(1, Math.min(20, entierPur(args.limit) ? Number(args.limit) : 5));
    const mots = splitPy(q);
    const cherchee = mots.length > MAX_MOTS_REQUETE ? mots.slice(0, MAX_MOTS_REQUETE).join(" ") : q;
    rows = await sessionSearchSnippets(dep.base, uid, cherchee, lim);
  } catch (e) {
    return errEnvelope("search_failed", `search failed: ${messageDe(e)}`, { retryable: true });
  }
  const matches = rows.map((r) =>
    correspondance({
      ref: Math.trunc(Number(r.ref || 0)),
      ts: r.ts,
      title: r.title,
      role: r.role,
      excerpt: r.snippet,
    }),
  );
  return { ok: true, query: q, matches, count: matches.length, error: null };
}
