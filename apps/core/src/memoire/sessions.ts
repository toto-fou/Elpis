// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/sessions.ts — index plein texte de l'historique des sessions : écriture, recherche (messages entiers, extraits, lecture par référence) en FTS5 et PostgreSQL (shared_infra/memory/store.py). */
import {
  casefoldPy,
  ErreurPython,
  findPy,
  floatPy,
  intPy,
  longueurPy,
  prefixePy,
  splitPy,
  stripPy,
  texteOu,
} from "@elpis/commun";
import { ciLike } from "@elpis/db";
import type { Base, Dialecte, Executeur, Valeur } from "@elpis/db";

import { journal } from "../journal";
import type { MessageIndexe } from "./ports";

/** Message à indexer : champs absents ou vides remplacés comme en Python (`app or "chat"`…). */
export type MessageAIndexer = Partial<Omit<MessageIndexe, "user_id" | "ts">> & {
  user_id: number | null;
  ts?: number | null;
};

/** Indexe un message de session ; best-effort : 0 si le contenu est vide, le compte inconnu ou l'écriture en échec. */
export async function sessionIndexMessage(x: Executeur, m: MessageAIndexer): Promise<number> {
  const contenu = stripPy(m.content || "");
  if (!contenu || m.user_id === null) return 0;
  try {
    return await x.insertId(
      "INSERT INTO session_messages(user_id, app, session_id, scope_key, role, content, ts) VALUES(?,?,?,?,?,?,?)",
      [
        Math.trunc(m.user_id),
        m.app || "chat",
        m.session_id || "",
        m.scope_key || "",
        m.role || "user",
        contenu,
        m.ts ?? Date.now() / 1000,
      ],
    );
  } catch (e) {
    journal("memory").debug(`[memory_store] index failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/** `session_index_messages` : un lot en une transaction (entrées invalides ou vides sautées) ; best-effort : 0 si l'écriture échoue. */
export async function sessionIndexMessages(
  x: Base,
  lignes: readonly unknown[] | null | undefined,
  maintenant: () => number = () => Date.now() / 1000,
): Promise<number> {
  const t = maintenant();
  const params: Valeur[][] = [];
  for (const r of lignes ?? []) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) continue;
    const l = r as Record<string, unknown>;
    const contenu = stripPy(texteOu(l["content"], ""));
    const uid = l["user_id"];
    if (!contenu || uid === null || uid === undefined) continue;
    const ts = l["ts"];
    params.push([
      intPy(uid),
      texteOu(l["app"], "chat"),
      texteOu(l["session_id"], ""),
      texteOu(l["scope_key"], ""),
      texteOu(l["role"], "user"),
      contenu,
      floatPy(ts !== null && ts !== undefined ? ts : t),
    ]);
  }
  if (!params.length) return 0;
  try {
    return await x.transaction(async (tx) => {
      for (const p of params)
        await tx.run(
          "INSERT INTO session_messages(user_id, app, session_id, scope_key, role, content, ts) VALUES(?,?,?,?,?,?,?)",
          p,
        );
      return params.length;
    });
  } catch (e) {
    journal("memory").debug(
      `[memory_store] bulk index failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 0;
  }
}

const SNIPPET_TOKENS = 32;
const EXCERPT_CHARS = 220;
export const SEARCH_ROLES: readonly string[] = ["user", "assistant", "tool", "tool_call"];
export const MESSAGE_MAX_CHARS = 6000;

/** Ponctuation ramenée à des espaces avant l'analyse, côté index (`pgFtsDocument`) et côté requête (`FTS_PUNCT` de _schema.py). */
export const PONCTUATION_FTS = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~«»‘’“”…–—·•";
const PONCTUATION: ReadonlySet<string> = new Set(Array.from(PONCTUATION_FTS));

/** Ligne de `session_search_fts` : le message entier. */
export interface LigneSession {
  app: string;
  session_id: string;
  scope_key: string;
  role: string;
  content: string;
  ts: number;
}

/** Résultat de `session_search_snippets` : extrait autour des mots trouvés et titre du chat (`""` hors chat). */
export interface ExtraitSession {
  ref: number;
  app: string;
  session_id: string;
  role: string;
  ts: number;
  snippet: string;
  title: string;
}

/** Résultat de `session_message_by_ref` : le passage entier, plafonné à `MESSAGE_MAX_CHARS`. */
export interface MessageSession {
  ref: number;
  app: string;
  session_id: string;
  role: string;
  ts: number;
  content: string;
  truncated: boolean;
  title: string;
}

/** `_fts_terms` : phrases entre guillemets reliées par OR (FTS5, guillemets doublés) ou « or » (PostgreSQL, ponctuation de l'index retirée) ; aucun mot de la requête n'est un opérateur. */
export function ftsTerms(rawTokens: readonly string[], dialecte: Dialecte): string {
  if (dialecte === "postgres") {
    const phrases = rawTokens.map((t) =>
      splitPy(
        Array.from(t)
          .map((c) => (PONCTUATION.has(c) ? " " : c))
          .join(""),
      ).join(" "),
    );
    return phrases
      .filter((p) => p)
      .map((p) => `"${p}"`)
      .join(" or ");
  }
  return rawTokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

/** `_fts_search_sql` : messages entiers, du mieux classé au moins bon (`bm25` croissant en FTS5, `ts_rank_cd` décroissant en PostgreSQL). */
export function ftsSearchSql(
  rawTokens: readonly string[],
  userId: number,
  lim: number,
  dialecte: Dialecte,
): [string, Valeur[]] {
  const q = ftsTerms(rawTokens, dialecte);
  if (dialecte === "postgres")
    return [
      "SELECT sm.app, sm.session_id, sm.scope_key, sm.role, sm.content, sm.ts, " +
        "ts_rank_cd(sm.content_tsv, websearch_to_tsquery('elpis_simple', ?)) AS rank_score " +
        "FROM session_messages sm " +
        "WHERE sm.content_tsv @@ websearch_to_tsquery('elpis_simple', ?) AND sm.user_id = ? " +
        "ORDER BY rank_score DESC LIMIT ?",
      [q, q, userId, lim],
    ];
  return [
    "SELECT sm.app, sm.session_id, sm.scope_key, sm.role, sm.content, sm.ts, " +
      "bm25(session_messages_fts) AS rank_score " +
      "FROM session_messages_fts " +
      "JOIN session_messages sm ON sm.id = session_messages_fts.rowid " +
      "WHERE session_messages_fts MATCH ? AND sm.user_id = ? " +
      "ORDER BY rank_score LIMIT ?",
    [q, userId, lim],
  ];
}

/** `_fts_snippet_sql` : extraits (`snippet()` en FTS5, `ts_headline` en PostgreSQL), mots trouvés entre « ». */
export function ftsSnippetSql(
  rawTokens: readonly string[],
  userId: number,
  roles: readonly string[],
  lim: number,
  dialecte: Dialecte,
): [string, Valeur[]] {
  const q = ftsTerms(rawTokens, dialecte);
  const ph = roles.map(() => "?").join(",");
  if (dialecte === "postgres") {
    const opts =
      `StartSel=«, StopSel=», MaxWords=${SNIPPET_TOKENS}, MinWords=12, ` +
      'MaxFragments=1, FragmentDelimiter=" … "';
    return [
      "SELECT sm.id, sm.app, sm.session_id, sm.role, sm.ts, " +
        "ts_headline('elpis_simple', sm.content, websearch_to_tsquery('elpis_simple', ?), " +
        `'${opts}') AS snip ` +
        "FROM session_messages sm " +
        "WHERE sm.content_tsv @@ websearch_to_tsquery('elpis_simple', ?) " +
        `AND sm.user_id = ? AND sm.role IN (${ph}) ` +
        "ORDER BY ts_rank_cd(sm.content_tsv, websearch_to_tsquery('elpis_simple', ?)) DESC " +
        "LIMIT ?",
      [q, q, userId, ...roles, q, lim],
    ];
  }
  return [
    "SELECT sm.id, sm.app, sm.session_id, sm.role, sm.ts, " +
      `snippet(session_messages_fts, 0, '«', '»', ' … ', ${SNIPPET_TOKENS}) AS snip ` +
      "FROM session_messages_fts " +
      "JOIN session_messages sm ON sm.id = session_messages_fts.rowid " +
      `WHERE session_messages_fts MATCH ? AND sm.user_id = ? AND sm.role IN (${ph}) ` +
      "ORDER BY bm25(session_messages_fts) LIMIT ?",
    [q, userId, ...roles, lim],
  ];
}

/** `" ".join(texte.split())` : blancs de Python repliés. */
function replier(texte: unknown): string {
  return splitPy(texteOu(texte, "")).join(" ");
}

/** `_row_to_dict`. */
function ligneSession(r: Record<string, unknown>): LigneSession {
  return {
    app: r["app"] as string,
    session_id: r["session_id"] as string,
    scope_key: r["scope_key"] as string,
    role: r["role"] as string,
    content: r["content"] as string,
    ts: r["ts"] as number,
  };
}

/** `session_search_fts` : messages entiers de ce compte, du mieux classé au moins bon ; repli LIKE si le plein texte manque ou refuse la requête, `[]` si la requête est vide ou tout échoue. */
export async function sessionSearchFts(
  x: Executeur,
  userId: number | null | undefined,
  query: string,
  limit: unknown = 10,
): Promise<LigneSession[]> {
  if (!query || !stripPy(query) || userId === null || userId === undefined) return [];
  const lim = Math.max(1, Math.min(100, intPy(limit)));
  const brut = splitPy(query).filter((t) => stripPy(t));
  if (!brut.length) return [];
  try {
    const [sql, params] = ftsSearchSql(brut, intPy(userId), lim, x.dialecte);
    return (await x.all(sql, params)).map(ligneSession);
  } catch {
    try {
      const rows = await x.all(
        "SELECT app, session_id, scope_key, role, content, ts FROM session_messages " +
          `WHERE user_id = ? AND ${ciLike("content", x.dialecte)} ORDER BY ts DESC LIMIT ?`,
        [intPy(userId), `%${stripPy(query)}%`, lim],
      );
      return rows.map(ligneSession);
    } catch {
      return [];
    }
  }
}

/** `_manual_excerpt` : repli sans plein texte, ~220 caractères autour de la première occurrence (positions de la forme repliée appliquées au texte, comme Python). */
export function manualExcerpt(content: unknown, tokens: readonly string[]): string {
  const text = replier(content);
  const low = casefoldPy(text);
  let pos = -1;
  for (const t of tokens) {
    pos = findPy(low, casefoldPy(t));
    if (pos >= 0) break;
  }
  if (pos < 0) pos = 0;
  const points = Array.from(text);
  const start = Math.max(0, pos - Math.floor(EXCERPT_CHARS / 2));
  const end = Math.min(points.length, start + EXCERPT_CHARS);
  const out = stripPy(points.slice(start, end).join(""));
  return (start > 0 ? "… " : "") + out + (end < points.length ? " …" : "");
}

/** Titres des chats de ce compte parmi `ids` ; `{}` si la table manque ou la requête échoue. */
async function titresDesChats(
  x: Executeur,
  userId: number,
  ids: readonly string[],
): Promise<Map<string, string>> {
  try {
    const rows = await x.all(
      `SELECT id, title FROM chats WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      [userId, ...ids],
    );
    return new Map(rows.map((r) => [r["id"] as string, texteOu(r["title"], "")]));
  } catch {
    return new Map();
  }
}

/** `session_search_snippets` : extraits (et référence `ref` pour lire le passage entier) des messages de ce compte, avec le titre du chat ; `[]` si la requête est vide ou tout échoue. */
export async function sessionSearchSnippets(
  x: Executeur,
  userId: number | null | undefined,
  query: string,
  limit: unknown = 5,
  roles: readonly string[] | null = SEARCH_ROLES,
): Promise<ExtraitSession[]> {
  if (!query || !stripPy(query) || userId === null || userId === undefined) return [];
  const lim = Math.max(1, Math.min(50, intPy(limit)));
  const brut = splitPy(query).filter((t) => stripPy(t));
  if (!brut.length) return [];
  const rolesRetenus = roles && roles.length ? roles : SEARCH_ROLES;
  let uid: number;
  const out: Omit<ExtraitSession, "title">[] = [];
  const ligne = (r: Record<string, unknown>, snippet: string): Omit<ExtraitSession, "title"> => ({
    ref: r["id"] as number,
    app: r["app"] as string,
    session_id: r["session_id"] as string,
    role: r["role"] as string,
    ts: r["ts"] as number,
    snippet,
  });
  try {
    uid = intPy(userId);
    const [sql, params] = ftsSnippetSql(brut, uid, rolesRetenus, lim, x.dialecte);
    for (const r of await x.all(sql, params)) out.push(ligne(r, replier(r["snip"])));
  } catch {
    try {
      uid = intPy(userId);
      const rows = await x.all(
        "SELECT id, app, session_id, role, content, ts FROM session_messages " +
          `WHERE user_id = ? AND ${ciLike("content", x.dialecte)} AND role IN (${rolesRetenus.map(() => "?").join(",")}) ` +
          "ORDER BY ts DESC LIMIT ?",
        [uid, `%${stripPy(query)}%`, ...rolesRetenus, lim],
      );
      out.length = 0;
      for (const r of rows) out.push(ligne(r, manualExcerpt(r["content"], brut)));
    } catch {
      return [];
    }
  }
  const ids = [...new Set(out.filter((o) => o.app === "chat").map((o) => o.session_id))];
  const titres = ids.length ? await titresDesChats(x, uid, ids) : new Map<string, string>();
  return out.map((o) => ({ ...o, title: o.app === "chat" ? (titres.get(o.session_id) ?? "") : "" }));
}

/** `session_message_by_ref` : texte entier (plafonné) d'un passage de CE compte ; `null` pour une référence invalide, inconnue ou d'un autre compte. */
export async function sessionMessageByRef(
  x: Executeur,
  userId: number | null | undefined,
  ref: unknown,
): Promise<MessageSession | null> {
  let rid: number;
  try {
    rid = intPy(ref);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return null;
    throw e;
  }
  if (userId === null || userId === undefined || rid <= 0) return null;
  let uid: number;
  let r: Record<string, unknown> | undefined;
  try {
    uid = intPy(userId);
    r = await x.get(
      "SELECT id, app, session_id, role, content, ts FROM session_messages WHERE id = ? AND user_id = ?",
      [rid, uid],
    );
  } catch {
    return null;
  }
  if (!r) return null;
  const content = texteOu(r["content"], "");
  let title = "";
  if (r["app"] === "chat") {
    try {
      const t = await x.get("SELECT title FROM chats WHERE user_id = ? AND id = ?", [
        uid,
        r["session_id"] as string,
      ]);
      title = t ? texteOu(t["title"], "") : "";
    } catch {
      title = "";
    }
  }
  return {
    ref: r["id"] as number,
    app: r["app"] as string,
    session_id: r["session_id"] as string,
    role: r["role"] as string,
    ts: r["ts"] as number,
    content: prefixePy(content, MESSAGE_MAX_CHARS),
    truncated: longueurPy(content) > MESSAGE_MAX_CHARS,
    title,
  };
}
