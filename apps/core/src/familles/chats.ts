// SPDX-License-Identifier: MIT
/** apps/core/src/familles/chats.ts — historique des conversations du compte (chatbot_app/routes/saved_chats.py) et boîte de réception. */
import { randomBytes } from "node:crypto";

import { getUsernameById } from "@elpis/auth";
import {
  ErreurPython,
  estDict,
  getOu,
  getPy,
  HttpError,
  intPy,
  iterExige,
  longueurPy,
  nomTypePy,
  prefixePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";

import {
  archiveChat,
  deleteAllChats,
  deleteChat,
  deleteChatsByIds,
  enforceRecentChatsCap,
  getChat,
  listChats,
  maintenant,
  renameChat,
  searchChats,
  setChatPlanMode,
  setChatTools,
  TITRE_PAR_DEFAUT,
  unarchiveChat,
  upsertChat,
  valeurSql,
} from "../chats/stockage";
import { listSharedPrompts } from "../chats/prompts";
import {
  buildStateSystemMessage,
  extractCompressionState,
  stripSummaryMessages,
} from "../contexte/etat-compression";
import { embedChartConfigs } from "../graphiques/incrustation";
import { journal } from "../journal";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, py, reponseJsonPy } from "@elpis/http";

const log = journal("chats");

/** `_no_cache` (routes/_helpers.py). */
const SANS_CACHE_STRICT = {
  "cache-control": "no-cache, no-store, must-revalidate",
  pragma: "no-cache",
  expires: "0",
};

export interface DependancesChats {
  readonly base: Base;
  readonly logMetric?: (nom: string, valeur: number, etiquettes: Record<string, unknown>) => void;
  /** `is_generation_active` : un run tient ce chat et le persiste lui-même (B1-20b) ; absent = faux. */
  readonly generationEnCours?: (uid: number, chatId: string) => boolean;
  /** « Ne pas me réveiller » posé sur la conversation (tâches de fond) ; `null` : non posé, le champ n'est pas rendu (parité Python). */
  readonly reveilCoupe?: (uid: number, chatId: string) => Promise<boolean | null>;
}

/** `_content_len` : texte des messages (hors system et notice), une part non textuelle compte 1. */
function longueurContenu(messages: unknown): number {
  let total = 0;
  for (const m of iterExige(messages)) {
    if (!estDict(m)) continue;
    const role = getOu(m, "role", null);
    if (role === "system" || role === "notice") continue;
    const c = getOu(m, "content", null);
    if (typeof c === "string") total += longueurPy(c);
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (!estDict(part)) continue;
        const t = getOu(part, "text", null);
        total += typeof t === "string" ? longueurPy(t) : 1;
      }
    }
  }
  return total;
}

/** Le message system d'état de compression n'est jamais renvoyé par le client : repris de la version stockée. */
function avecEtatCompression(existant: Dict, messages: unknown): unknown {
  try {
    const stockes = getOu(existant, "messages", null);
    const etat: unknown = extractCompressionState(iterExige(veritePy(stockes) ? stockes : []));
    if (!estDict(etat)) return messages;
    const champ = (cle: string, defaut: unknown): unknown => {
      const v = getOu(etat, cle, null);
      return veritePy(v) ? v : defaut;
    };
    const resume = champ("summary_xml", "");
    if (typeof resume !== "string")
      throw new ErreurPython("AttributeError", `'${nomTypePy(resume)}' object has no attribute 'strip'`);
    if (!stripPy(resume)) return messages;
    return [
      buildStateSystemMessage(
        resume,
        intPy(champ("round", 1)),
        intPy(champ("covered_turns", 0)),
        null,
        strPy(champ("ledger_block", "")),
      ),
      ...stripSummaryMessages(iterExige(messages)),
    ];
  } catch (e) {
    log.warn({ err: e }, "[save-messages] carry-forward état compression échoué");
    return messages;
  }
}

function ids(data: unknown): unknown[] {
  const v = getPy(data, "ids", []);
  if (!Array.isArray(v)) throw new HttpError(400, "ids doit être une liste");
  return v;
}

export function creerFamilleChats(dep: DependancesChats): Famille {
  const base = dep.base;
  const chatIdDe = (req: Parameters<typeof utilisateur>[0]): string =>
    entrees(req, { path: { chat_id: py.str() } }).path.chat_id;
  return {
    nom: "chats",
    routes: [
      {
        methode: "GET",
        chemin: "/api/saved/chats",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const { archived } = entrees(req, { query: { archived: py.int().defaut(0) } }).query;
          return reponseJsonPy(
            rep,
            { items: await listChats(base, uid, archived) },
            { "cache-control": "no-cache" },
          );
        },
      },
      {
        methode: "GET",
        chemin: "/api/saved/chats/search",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const { q, archived, deep } = entrees(req, {
            query: { q: py.str(), archived: py.int().defaut(0), deep: py.int().defaut(0) },
          }).query;
          if (!q) return { items: [] };
          return reponseJsonPy(rep, { items: await searchChats(base, uid, q, archived, deep !== 0) });
        },
      },
      {
        methode: "POST",
        chemin: "/api/saved/chats/new",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          let corps: unknown;
          try {
            corps = corpsJsonValeurs(req);
          } catch {
            corps = null;
          }
          let planMode = false;
          if (estDict(corps) && Object.hasOwn(corps, "plan_mode")) {
            if (typeof corps["plan_mode"] !== "boolean")
              throw new HttpError(422, "plan_mode doit être un booléen");
            planMode = corps["plan_mode"];
          }
          const chatId = randomBytes(12).toString("hex");
          await upsertChat(base, uid, chatId, TITRE_PAR_DEFAUT, [], maintenant());
          if (planMode) await setChatPlanMode(base, uid, chatId, true);
          await enforceRecentChatsCap(base, uid);
          const nom = (await getUsernameById(base, uid)) || `user_${uid}`;
          dep.logMetric?.("new_chat", 1, { user: nom });
          return { id: chatId };
        },
      },
      {
        methode: "GET",
        chemin: "/api/saved/chats/:chat_id",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const c = await getChat(base, uid, chatIdDe(req));
          if (!c) throw new HttpError(404, "chat not found");
          const coupe = dep.reveilCoupe ? await dep.reveilCoupe(uid, String(c["id"])) : null;
          if (coupe !== null) c["wake_disabled"] = coupe;
          return reponseJsonPy(rep, c, SANS_CACHE_STRICT);
        },
      },
      {
        methode: "PATCH",
        chemin: "/api/saved/chats/:chat_id",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const chatId = chatIdDe(req);
          const data = corpsJsonValeurs(req);
          if (!(await renameChat(base, uid, chatId, getPy(data, "title", ""))))
            throw new HttpError(404, "chat not found or invalid title");
          return { ok: true };
        },
      },
      {
        methode: "PUT",
        chemin: "/api/saved/chats/:chat_id/tools",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const chatId = chatIdDe(req);
          const tools = getPy(corpsJsonValeurs(req), "tools");
          if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string"))
            throw new HttpError(422, "tools doit être une liste de noms de catégories");
          if (!(await setChatTools(base, uid, chatId, tools))) throw new HttpError(404, "chat not found");
          return { ok: true };
        },
      },
      {
        methode: "PUT",
        chemin: "/api/saved/chats/:chat_id/plan-mode",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const chatId = chatIdDe(req);
          const valeur = getPy(corpsJsonValeurs(req), "plan_mode");
          if (typeof valeur !== "boolean") throw new HttpError(422, "plan_mode doit être un booléen");
          if (!(await setChatPlanMode(base, uid, chatId, valeur))) throw new HttpError(404, "chat not found");
          return { ok: true, plan_mode: valeur };
        },
      },
      {
        methode: "PUT",
        chemin: "/api/saved/chats/:chat_id/save-messages",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const chatId = chatIdDe(req);
          const data = corpsJsonValeurs(req);
          let messages = getPy(data, "messages", []);
          let titre = getPy(data, "title", "");
          if (dep.generationEnCours?.(uid, chatId)) {
            log.info(
              `[save-messages] chat=${prefixePy(chatId, 12)} tenu par un run en cours : sauvegarde partielle ignorée (le run persiste lui-même).`,
            );
            return { ok: true, skipped: "generation_running" };
          }
          const existant = await getChat(base, uid, chatId);
          if (!existant) {
            log.info(
              `[save-messages] chat=${prefixePy(chatId, 12)} absent : sauvegarde partielle ignorée (conversation supprimée entre-temps).`,
            );
            return { ok: true, skipped: "absent" };
          }
          if (!veritePy(titre)) titre = getOu(existant, "title", TITRE_PAR_DEFAUT);
          if (
            Array.isArray(messages) &&
            longueurContenu(messages) < longueurContenu(getOu(existant, "messages", []))
          ) {
            log.info(
              `[save-messages] payload périmé ignoré pour chat=${prefixePy(chatId, 12)} (contenu entrant plus court que le stocké) — garde anti-écrasement de la sauvegarde finale.`,
            );
            return { ok: true, skipped: "stale" };
          }
          messages = avecEtatCompression(existant, messages);
          messages = await embedChartConfigs(base, uid, chatId, messages, existant);
          try {
            await upsertChat(base, uid, chatId, valeurSql(titre), messages, maintenant());
          } catch (e) {
            if (e instanceof ErreurPython && e.type === "ValueError")
              throw new HttpError(409, "chat_id already exists for another user");
            throw e;
          }
          return { ok: true };
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/saved/chats/:chat_id",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          if (!(await deleteChat(base, uid, chatIdDe(req)))) throw new HttpError(404, "chat not found");
          return { ok: true };
        },
      },
      {
        methode: "POST",
        chemin: "/api/saved/chats/clear-all",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => ({ ok: true, deleted: await deleteAllChats(base, utilisateur(req), 0) }),
      },
      {
        methode: "POST",
        chemin: "/api/saved/chats/delete-batch",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const liste = ids(corpsJsonValeurs(req));
          return {
            ok: true,
            deleted: await deleteChatsByIds(
              base,
              uid,
              liste.map((c) => strPy(c)),
            ),
          };
        },
      },
      {
        methode: "POST",
        chemin: "/api/saved/chats/archive-batch",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const liste = ids(corpsJsonValeurs(req));
          let n = 0;
          for (const cid of liste) if (await archiveChat(base, uid, strPy(cid))) n++;
          if (n) await enforceRecentChatsCap(base, uid);
          return { ok: true, archived: n };
        },
      },
      {
        methode: "POST",
        chemin: "/api/saved/chats/:chat_id/archive",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          if (!(await archiveChat(base, uid, chatIdDe(req)))) throw new HttpError(404, "chat not found");
          await enforceRecentChatsCap(base, uid);
          return { ok: true };
        },
      },
      {
        methode: "POST",
        chemin: "/api/saved/chats/:chat_id/unarchive",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          if (!(await unarchiveChat(base, uid, chatIdDe(req)))) throw new HttpError(404, "chat not found");
          await enforceRecentChatsCap(base, uid);
          return { ok: true };
        },
      },
      {
        methode: "GET",
        chemin: "/api/inbox/count",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const n = (await listSharedPrompts(base, utilisateur(req))).length;
          return { count: n, prompts: n };
        },
      },
    ],
  };
}
