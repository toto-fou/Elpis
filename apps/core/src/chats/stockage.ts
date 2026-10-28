// SPDX-License-Identifier: MIT
/** apps/core/src/chats/stockage.ts — conversations d'un compte (shared_infra/chat/store.py) : lecture, écriture, meta_json, rétention. */
import {
  arrondiEntierPy,
  clesOrdonnees,
  copieDict,
  entierOuNulPy,
  ErreurCle,
  ErreurPython,
  estDict,
  floatPy,
  getOu,
  intPy,
  iterExige,
  longueurPy,
  nomTypePy,
  poserCle,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  reprPy,
  stripPy,
  strPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict, FlottantPy } from "@elpis/commun";
import { maxRecentChats } from "@elpis/config";
import { ciLike } from "@elpis/db";
import type { Base, Executeur, Valeur } from "@elpis/db";

import { purgerJetonsConversations } from "../coffre/jetons";
import { retirerDemandesDesChats } from "../procedures/demandes";
import { deleteForChats } from "../images/magasin";
import { journal } from "../journal";

const log = journal("chats");

export const TITRE_PAR_DEFAUT = "Nouveau chat";

type LigneChat = {
  id: string;
  user_id: number;
  title: string;
  messages_json: unknown;
  updated_at: number;
  archived: number;
  archived_at: number | null;
  meta_json: unknown;
};

type LigneResume = { id: string; title: string; updated_at: number; archived: number };

export interface ResumeChat {
  id: string;
  title: string;
  updated_at: number | FlottantPy;
  archived: boolean;
}

/** `time.time()`. */
export function maintenant(): number {
  return Date.now() / 1000;
}

/** Valeur liée telle quelle : le moteur refuse ce que sqlite3 ou psycopg refuseraient (liste, dict…). */
export function valeurSql(v: unknown): Valeur {
  return v as Valeur;
}

function resume(r: LigneResume): ResumeChat {
  return {
    id: r.id,
    title: r.title,
    updated_at: versFlottantPy(Number(r.updated_at)),
    archived: veritePy(r.archived),
  };
}

/** `_purge_images` : après le commit ; une panne ici ne défait pas la suppression (l'entretien rattrape). */
async function purgerImages(base: Base, uid: number, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await deleteForChats(base, uid, ids);
  } catch (e) {
    log.warn(
      { err: e },
      `[chats] images des conversations supprimées non effacées (user_id=${uid}, ${ids.length} conversation(s))`,
    );
  }
}

/** Crochets posés par la composition : conversations épargnées par le plafond, suite d'une suppression (tâches de fond). */
export interface CrochetsConversations {
  epargnees?(x: Executeur, uid: number): Promise<ReadonlySet<string>>;
  apresSuppression?(uid: number, chatIds: readonly string[]): Promise<void>;
}

let crochets: CrochetsConversations = {};

export function installerCrochetsConversations(c: CrochetsConversations | null): void {
  crochets = c ?? {};
}

/** Après le commit d'une suppression : images, puis le crochet ; une panne ici ne défait pas la suppression. */
async function apresSuppression(base: Base, uid: number, ids: readonly string[]): Promise<void> {
  await purgerImages(base, uid, ids);
  await purgerJetonsConversations(base, uid, ids).catch((e: unknown) =>
    log.warn({ err: e }, `[chats] jetons du coffre non purgés (user_id=${uid})`),
  );
  await retirerDemandesDesChats(base, uid, ids).catch((e: unknown) =>
    log.warn({ err: e }, `[chats] demandes d'accord non purgées (user_id=${uid})`),
  );
  if (ids.length === 0 || crochets.apresSuppression === undefined) return;
  try {
    await crochets.apresSuppression(uid, ids);
  } catch (e) {
    log.warn(
      { err: e },
      `[chats] suite de suppression en échec (user_id=${uid}, ${ids.length} conversation(s))`,
    );
  }
}

/** `_chat_meta` : `meta_json` relu ; illisible ou pas un objet, `{}`. */
function metaDe(brut: unknown): Dict {
  const texte = veritePy(brut) ? brut : "{}";
  if (typeof texte !== "string") return {};
  try {
    const d = pyJsonLoads(texte);
    return estDict(d) ? d : {};
  } catch (e) {
    if (e instanceof SyntaxError) return {};
    throw e;
  }
}

function listeOu<T>(v: unknown, defaut: T): unknown[] | T {
  return Array.isArray(v) ? v : defaut;
}

export async function getChatTodos(x: Executeur, uid: number, chatId: string): Promise<unknown[]> {
  const r = await x.get<{ meta_json: unknown }>("SELECT meta_json FROM chats WHERE id=? AND user_id=?", [
    chatId,
    uid,
  ]);
  if (!r) return [];
  return listeOu(getOu(metaDe(r.meta_json), "todos", null), []);
}

export async function getChatPlanMode(x: Executeur, uid: number, chatId: string): Promise<boolean> {
  if (!chatId) return false;
  const r = await x.get<{ meta_json: unknown }>("SELECT meta_json FROM chats WHERE id=? AND user_id=?", [
    chatId,
    uid,
  ]);
  return r ? veritePy(getOu(metaDe(r.meta_json), "plan_mode", null)) : false;
}

/** `get_chat` : la conversation et ses réglages par chat, `null` si elle n'est pas à ce compte. */
export async function getChat(x: Executeur, uid: number, chatId: string): Promise<Dict | null> {
  const r = await x.get<LigneChat>("SELECT * FROM chats WHERE id=? AND user_id=?", [chatId, uid]);
  if (!r) return null;
  const meta = metaDe(r.meta_json);
  const messages = veritePy(r.messages_json) ? r.messages_json : "[]";
  if (typeof messages !== "string")
    throw new ErreurPython("TypeError", "the JSON object must be str, bytes or bytearray");
  const usage = getOu(meta, "ctx_usage", null);
  const suffixes = getOu(meta, "llm_user_suffixes", null);
  const rag = getOu(meta, "rag", null);
  return {
    id: r.id,
    title: r.title,
    updated_at: versFlottantPy(Number(r.updated_at)),
    archived: veritePy(r.archived),
    messages: pyJsonLoads(messages),
    tools: listeOu(getOu(meta, "tools", null), null),
    plan_mode: veritePy(getOu(meta, "plan_mode", null)),
    todos: listeOu(getOu(meta, "todos", null), []),
    ctx_pruned_keys: listeOu(getOu(meta, "ctx_pruned_keys", null), []),
    ctx_usage: estDict(usage) ? usage : null,
    llm_user_suffixes: estDict(suffixes) ? suffixes : {},
    ...(estDict(rag) ? { rag } : {}),
  };
}

export async function listChats(x: Executeur, uid: number, archived: number): Promise<ResumeChat[]> {
  const lignes = await x.all<LigneResume>(
    "SELECT id,title,updated_at,archived FROM chats WHERE user_id=? AND archived=? ORDER BY updated_at DESC",
    [uid, archived],
  );
  const out = lignes.map(resume);
  return archived === 0 ? out.slice(0, maxRecentChats()) : out;
}

/** `{k: v for k, v in d.items() if k != sauf}`, dans l'ordre Python des clés. */
function sansCle(d: Dict, sauf: string): Dict {
  const out = copieDict(d);
  delete out[sauf];
  return out;
}

/** Le raisonnement n'est gardé que pour l'affichage en direct : ni `thinking`, ni `metrics.thinking` en base. */
function sansRaisonnement(messages: unknown): unknown[] {
  return iterExige(messages).map((m) => {
    let message = m;
    if (estDict(message) && Object.hasOwn(message, "thinking")) message = sansCle(message, "thinking");
    const metriques = estDict(message) ? getOu(message, "metrics", null) : null;
    if (estDict(message) && estDict(metriques) && Object.hasOwn(metriques, "thinking")) {
      const avec = copieDict(message);
      poserCle(avec, "metrics", sansCle(metriques, "thinking"));
      message = avec;
    }
    return message;
  });
}

/** `upsert_chat` : vrai si écrit, faux sur conflit de la garde optimiste ou chat supprimé depuis la lecture (jamais recréé) ; un `chat_id` d'un autre compte lève ValueError. */
export async function upsertChat(
  x: Executeur,
  uid: number,
  chatId: string,
  title: Valeur,
  messages: unknown,
  updatedAt: number,
  expectedUpdatedAt: number | null = null,
): Promise<boolean> {
  const mj = pyJsonDumps(sansRaisonnement(messages), { ensureAscii: false });
  const r =
    expectedUpdatedAt === null
      ? await x.run(
          "INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived) VALUES (?, ?, ?, ?, ?, 0) " +
            "ON CONFLICT(id) DO UPDATE SET title = excluded.title, messages_json= excluded.messages_json, " +
            "updated_at = excluded.updated_at WHERE chats.user_id = excluded.user_id",
          [chatId, uid, title, mj, updatedAt],
        )
      : await x.run(
          "UPDATE chats SET title=?, messages_json=?, updated_at=? WHERE id=? AND user_id=? AND updated_at=?",
          [title, mj, updatedAt, chatId, uid, expectedUpdatedAt],
        );
  if (r.changes !== 0) return true;
  if (await x.get("SELECT 1 FROM chats WHERE id=? AND user_id=?", [chatId, uid]))
    return expectedUpdatedAt === null;
  if (expectedUpdatedAt !== null && !(await x.get("SELECT 1 FROM chats WHERE id=?", [chatId]))) return false;
  throw new ErreurPython(
    "ValueError",
    `chat_id collision: chat ${reprPy(chatId)} exists for a different user`,
  );
}

/** `_merge_meta_json` : lecture, `muter` en place et réécriture sous un même verrou d'écriture ; faux si le chat n'est pas à ce compte. */
export async function mergeMetaJson(
  base: Base,
  uid: number,
  chatId: string,
  muter: (meta: Dict) => void,
): Promise<boolean> {
  return base.ecriture(async (tx) => {
    const r = await tx.get<{ meta_json: unknown }>("SELECT meta_json FROM chats WHERE id=? AND user_id=?", [
      chatId,
      uid,
    ]);
    if (!r) return false;
    const meta = metaDe(r.meta_json);
    muter(meta);
    const u = await tx.run("UPDATE chats SET meta_json=? WHERE id=? AND user_id=?", [
      pyJsonDumps(meta, { ensureAscii: false }),
      chatId,
      uid,
    ]);
    return u.changes > 0;
  });
}

/** `[str(t)[:64] for t in (tools or []) if isinstance(t, str) and t.strip()][:max]`. */
function outilsPropres(tools: unknown, max: number): string[] {
  const propres: string[] = [];
  for (const t of veritePy(tools) ? iterExige(tools) : []) {
    if (typeof t === "string" && stripPy(t)) propres.push(prefixePy(t, 64));
  }
  return propres.slice(0, max);
}

/** `set_chat_tools` : catégories et exclusions d'outils du chat (192 au plus), sans toucher à `updated_at`. */
export async function setChatTools(
  base: Base,
  uid: number,
  chatId: string,
  tools: unknown,
): Promise<boolean> {
  const propres = outilsPropres(tools, 192);
  return mergeMetaJson(base, uid, chatId, (meta) => poserCle(meta, "tools", propres));
}

export async function setChatPlanMode(
  base: Base,
  uid: number,
  chatId: string,
  planMode: unknown,
): Promise<boolean> {
  const valeur = veritePy(planMode);
  return mergeMetaJson(base, uid, chatId, (meta) => poserCle(meta, "plan_mode", valeur));
}

/** Clés d'élagage fusionnées sans doublon, ordre d'arrivée, plafonnées aux `cap` dernières. */
function fusionnerClesElaguees(meta: Dict, cles: readonly unknown[], cap: number): void {
  const actuelles = getOu(meta, "ctx_pruned_keys", null);
  let fusion = Array.isArray(actuelles) ? [...actuelles] : [];
  for (const e of fusion)
    if (estDict(e) || Array.isArray(e))
      throw new ErreurPython("TypeError", `unhashable type: '${nomTypePy(e)}'`);
  const vues = new Set(fusion);
  for (const k of cles) {
    if (typeof k === "string" && k && !vues.has(k)) {
      fusion.push(k);
      vues.add(k);
    }
  }
  if (fusion.length > cap) fusion = fusion.slice(-cap);
  poserCle(meta, "ctx_pruned_keys", fusion);
}

export async function addChatPrunedKeys(
  base: Base,
  uid: number,
  chatId: string,
  cles: readonly unknown[],
  cap = 500,
): Promise<boolean> {
  if (cles.length === 0) return true;
  return mergeMetaJson(base, uid, chatId, (meta) => fusionnerClesElaguees(meta, cles, cap));
}

/** `clean_ctx_usage` : `{used, total, pct, model, ts}` nettoyé (occupation réelle, seul `pct` borné), `null` si la mesure est inexploitable. */
export function cleanCtxUsage(brut: unknown): Dict | null {
  if (!estDict(brut)) return null;
  const used = entierOuNulPy(veritePy(getOu(brut, "used", null)) ? getOu(brut, "used", null) : 0);
  const total = entierOuNulPy(veritePy(getOu(brut, "total", null)) ? getOu(brut, "total", null) : 0);
  if (used === null || total === null || used <= 0 || total <= 0) return null;
  const pctBrut = getOu(brut, "pct", null);
  let pct = pctBrut === null ? null : entierOuNulPy(pctBrut);
  if (pct === null || !(pct >= 0 && pct <= 100)) pct = Math.min(100, arrondiEntierPy((used / total) * 100));
  let ts: number;
  try {
    const t = getOu(brut, "ts", null);
    const f = floatPy(veritePy(t) ? t : 0);
    ts = f !== 0 ? f : maintenant();
  } catch (e) {
    if (!(e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))) throw e;
    ts = maintenant();
  }
  const modele = getOu(brut, "model", null);
  return {
    used,
    total,
    pct,
    model: typeof modele === "string" && modele ? prefixePy(modele, 120) : "",
    ts: versFlottantPy(ts),
  };
}

export async function clearChatCtxUsage(base: Base, uid: number, chatId: string): Promise<boolean> {
  return mergeMetaJson(base, uid, chatId, (meta) => {
    delete meta["ctx_usage"];
  });
}

export interface FinTour {
  prunedKeys?: readonly unknown[] | null;
  tools?: unknown;
  planModeOff?: boolean;
  cap?: number;
  ctxUsage?: unknown;
  userSuffixes?: Dict | null;
  suffixDropFromRank?: number | null;
}

/** Longueur enregistrée d'un suffixe LLM de question (au-delà, coupé : le tour doit envoyer la même borne). */
export const SUFFIXE_LLM_MAX = 8000;

/** Suffixes LLM des questions : rangs réécrits retirés, ajouts et retraits, 40 derniers gardés. */
function fusionnerSuffixes(
  meta: Dict,
  ajouts: Dict | null | undefined,
  depuisRang: number | null | undefined,
): void {
  const actuels = getOu(meta, "llm_user_suffixes", null);
  const fusion: Dict = {};
  if (estDict(actuels)) for (const k of clesOrdonnees(actuels)) poserCle(fusion, k, actuels[k]);
  if (depuisRang !== null && depuisRang !== undefined) {
    for (const k of [...clesOrdonnees(fusion)]) {
      const rang = entierOuNulPy(k.split(":", 1)[0] ?? "");
      if (rang !== null && rang >= intPy(depuisRang)) delete fusion[k];
    }
  }
  if (ajouts) {
    for (const k of clesOrdonnees(ajouts)) {
      if (!k) continue;
      delete fusion[k];
      const v = ajouts[k];
      if (typeof v === "string" && v) poserCle(fusion, prefixePy(k, 64), prefixePy(v, SUFFIXE_LLM_MAX));
    }
  }
  const garde: Dict = {};
  for (const k of clesOrdonnees(fusion).slice(-40)) poserCle(garde, k, fusion[k]);
  poserCle(meta, "llm_user_suffixes", garde);
}

/** `finalize_turn_meta` : écritures de fin de tour en une transaction ; chaque volet absent reste intact. */
export async function finalizeTurnMeta(
  base: Base,
  uid: number,
  chatId: string,
  fin: FinTour = {},
): Promise<boolean> {
  const tools = fin.tools === undefined || fin.tools === null ? null : outilsPropres(fin.tools, 64);
  const usage = fin.ctxUsage === undefined || fin.ctxUsage === null ? null : cleanCtxUsage(fin.ctxUsage);
  const cap = fin.cap ?? 500;
  return mergeMetaJson(base, uid, chatId, (meta) => {
    if (fin.prunedKeys && fin.prunedKeys.length > 0) fusionnerClesElaguees(meta, fin.prunedKeys, cap);
    if (tools !== null) poserCle(meta, "tools", tools);
    if (fin.planModeOff) poserCle(meta, "plan_mode", false);
    if (usage !== null) poserCle(meta, "ctx_usage", usage);
    const ajouts = fin.userSuffixes && clesOrdonnees(fin.userSuffixes).length > 0 ? fin.userSuffixes : null;
    if (ajouts || (fin.suffixDropFromRank !== null && fin.suffixDropFromRank !== undefined))
      fusionnerSuffixes(meta, ajouts, fin.suffixDropFromRank);
  });
}

/** `set_chat_todos` : liste remplacée (50 au plus, champs bornés), sans toucher à `updated_at`. */
export async function setChatTodos(
  base: Base,
  uid: number,
  chatId: string,
  todos: unknown,
): Promise<boolean> {
  const liste = veritePy(todos) ? todos : [];
  if (estDict(liste)) throw new ErreurCle("slice(None, 50, None)");
  if (!Array.isArray(liste) && typeof liste !== "string")
    throw new ErreurPython("TypeError", `'${nomTypePy(liste)}' object is not subscriptable`);
  const propres: Dict[] = [];
  for (const t of iterExige(liste).slice(0, 50)) {
    if (!estDict(t)) continue;
    const contenu = getOu(t, "content", null);
    if (!stripPy(strPy(veritePy(contenu) ? contenu : ""))) continue;
    const statut = getOu(t, "status", null);
    const priorite = getOu(t, "priority", null);
    propres.push({
      content: prefixePy(strPy(contenu), 300),
      status: prefixePy(strPy(veritePy(statut) ? statut : "pending"), 16),
      priority: prefixePy(strPy(veritePy(priorite) ? priorite : "medium"), 8),
    });
  }
  return mergeMetaJson(base, uid, chatId, (meta) => poserCle(meta, "todos", propres));
}

/** `delete_chats_by_ids` : une transaction, `IN` par tranches de 500 ; rend le nombre de lignes supprimées. */
export async function deleteChatsByIds(base: Base, uid: number, chatIds: unknown): Promise<number> {
  const ids = iterExige(veritePy(chatIds) ? chatIds : [])
    .map((c) => strPy(c))
    .filter((c) => c !== "");
  if (ids.length === 0) return 0;
  const total = await base.transaction(async (tx) => {
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const tranche = ids.slice(i, i + 500);
      const r = await tx.run(
        `DELETE FROM chats WHERE user_id=? AND id IN (${tranche.map(() => "?").join(",")})`,
        [uid, ...tranche],
      );
      n += r.changes;
    }
    return n;
  });
  await apresSuppression(base, uid, ids);
  return total;
}

export async function deleteAllChats(base: Base, uid: number, archived = 0): Promise<number> {
  const [ids, n] = await base.transaction(async (tx) => {
    const lignes = await tx.all<{ id: string }>("SELECT id FROM chats WHERE user_id=? AND archived=?", [
      uid,
      archived,
    ]);
    const r = await tx.run("DELETE FROM chats WHERE user_id=? AND archived=?", [uid, archived]);
    return [lignes.map((l) => l.id), r.changes] as const;
  });
  await apresSuppression(base, uid, ids);
  return n;
}

/** `enforce_recent_chats_cap` : SUPPRIME les conversations actives au-delà du plafond, les plus anciennes d'abord. */
export async function enforceRecentChatsCap(base: Base, uid: number): Promise<void> {
  const cap = maxRecentChats();
  const aSupprimer = await base.transaction(async (tx) => {
    const ids = (
      await tx.all<{ id: string }>(
        "SELECT id FROM chats WHERE user_id=? AND archived=0 ORDER BY updated_at DESC",
        [uid],
      )
    ).map((l) => l.id);
    if (ids.length <= cap) return [];
    const epargnees = crochets.epargnees ? await crochets.epargnees(tx, uid) : null;
    const surplus = ids.slice(cap).filter((id) => !epargnees?.has(id));
    if (surplus.length === 0) return [];
    await tx.run(
      `DELETE FROM chats WHERE user_id=? AND archived=0 AND id IN (${surplus.map(() => "?").join(",")})`,
      [uid, ...surplus],
    );
    return surplus;
  });
  await apresSuppression(base, uid, aSupprimer);
}

/** `(title or "").strip()[:60]` : un titre qui n'est pas du texte lève comme `.strip()`. */
function titrePropre(title: unknown): string {
  const t = veritePy(title) ? title : "";
  if (typeof t !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(t)}' object has no attribute 'strip'`);
  return prefixePy(stripPy(t), 60);
}

export async function renameChat(
  x: Executeur,
  uid: number,
  chatId: string,
  title: unknown,
): Promise<boolean> {
  const titre = titrePropre(title);
  if (!titre) return false;
  const r = await x.run("UPDATE chats SET title=?, updated_at=? WHERE id=? AND user_id=?", [
    titre,
    maintenant(),
    chatId,
    uid,
  ]);
  return r.changes > 0;
}

/** `set_title_if_default` : titre posé dès le début d'un tour, seulement sur « Nouveau chat » ou vide, sans toucher à `updated_at`. */
export async function setTitleIfDefault(
  x: Executeur,
  uid: number,
  chatId: string,
  title: unknown,
): Promise<boolean> {
  const titre = titrePropre(title);
  if (!titre || titre === TITRE_PAR_DEFAUT) return false;
  const r = await x.run(
    "UPDATE chats SET title=? WHERE id=? AND user_id=? AND (title='' OR title='Nouveau chat')",
    [titre, chatId, uid],
  );
  return r.changes > 0;
}

export async function deleteChat(base: Base, uid: number, chatId: string): Promise<boolean> {
  const r = await base.run("DELETE FROM chats WHERE id=? AND user_id=?", [chatId, uid]);
  if (r.changes > 0) await apresSuppression(base, uid, [chatId]);
  return r.changes > 0;
}

export async function archiveChat(x: Executeur, uid: number, chatId: string): Promise<boolean> {
  const r = await x.run("UPDATE chats SET archived=1, archived_at=? WHERE id=? AND user_id=?", [
    maintenant(),
    chatId,
    uid,
  ]);
  return r.changes > 0;
}

export async function unarchiveChat(x: Executeur, uid: number, chatId: string): Promise<boolean> {
  const r = await x.run("UPDATE chats SET archived=0 WHERE id=? AND user_id=?", [chatId, uid]);
  return r.changes > 0;
}

/** `search_chats` : titre seul (indexé), ou titre et contenu si `deep` et au moins 3 caractères ; plafond max(50, liste). */
export async function searchChats(
  x: Executeur,
  uid: number,
  query: string,
  archived = 0,
  deep = false,
): Promise<ResumeChat[]> {
  const q = stripPy(query || "");
  if (!q) return [];
  const cap = Math.max(50, maxRecentChats());
  const motif = `%${q}%`;
  const lignes =
    deep && longueurPy(q) >= 3
      ? await x.all<LigneResume>(
          "SELECT id, title, updated_at, archived FROM chats " +
            `WHERE user_id=? AND archived=? AND (${ciLike("title", x.dialecte)} OR ${ciLike("messages_json", x.dialecte)}) ` +
            "ORDER BY updated_at DESC LIMIT ?",
          [uid, archived, motif, motif, cap],
        )
      : await x.all<LigneResume>(
          "SELECT id, title, updated_at, archived FROM chats " +
            `WHERE user_id=? AND archived=? AND ${ciLike("title", x.dialecte)} ORDER BY updated_at DESC LIMIT ?`,
          [uid, archived, motif, cap],
        );
  return lignes.map(resume);
}
