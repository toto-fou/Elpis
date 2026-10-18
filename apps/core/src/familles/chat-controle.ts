// SPDX-License-Identifier: MIT
/** apps/core/src/familles/chat-controle.ts — pilotage d'un tour en cours : « Répondre maintenant », Stop, arrêt d'un sous-agent, état et suivi NDJSON du run (chatbot_app/routes/chat_control.py). */
import { getUsernameById, revaliderFlux } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { CancelledError, estDict, HttpError, intPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import type { Base } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { getChat } from "../chats/stockage";
import { journal } from "../journal";
import { getLlmClient } from "../llm/client-http";
import { baseServeur, engineCaps } from "../llm/fournisseurs/llama-capacites";
import { endReasoning } from "../llm/fournisseurs/llama-flux";
import { BUILTIN_KEY, resolveEngineForUser } from "../llm/moteurs";
import { cancelChild } from "../outils/integres/taches-agents";
import { getRun } from "../routines/magasin";
import { planificateurDuProcess } from "../routines/planificateur";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import {
  controleRaisonnementDuProcess,
  getActiveChatTask,
  isGenerationActive,
  markChatCancelled,
  tachesSansChat,
} from "../tour/etat";
import { cancelEngineStream } from "../tour/evenements";
import { currentRun, listActiveChatIds } from "../tour/journal-run";
import { ENTETES_NDJSON, ligneNdjson } from "../tour/ndjson";
import { jobsTour } from "../tour/ports-jobs";
import { evenementsDuRun, preparerSuivi } from "../tour/suivi-run";
import { utilisateur } from "./comptes";
import { corpsJson, corpsJsonValeurs, entrees, ouvrirFlux, py, reponseJsonPy } from "@elpis/http";

const log = journal("uvicorn.error");
/** Clé d'un run de routine (`runChatKey`) : son arrêt passe par le planificateur, qui tient ses propres drapeaux. */
const RUN_DE_ROUTINE = /^routine:(-?\d+):run:(-?\d+)$/u;

export interface DependancesChatControle {
  readonly base: Base;
  readonly auth: DependancesAuth;
  readonly arret?: AbortSignal | undefined;
}

function route(methode: "GET" | "POST", chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["main"], acces: "session", traiter };
}

/** Champ texte du corps JSON (`with swallow` : corps illisible = absent). */
function champCorps(req: FastifyRequest, nom: string): string | null {
  try {
    const corps = corpsJson(req);
    if (estDict(corps) && veritePy(corps[nom])) return strPy(corps[nom]);
  } catch {
    // corps illisible : champ absent
  }
  return null;
}

function parametre(req: FastifyRequest, nom: string): string | null {
  return entrees(req, { query: { [nom]: py.optional(py.str()).defaut(null) } }).query[nom] as string | null;
}

function chatDuChemin(req: FastifyRequest): string {
  return entrees(req, { path: { chat_id: py.str() } }).path.chat_id;
}

/** Ferme le raisonnement de la complétion en cours sur le serveur qui la porte (re-résolu pour l'appelant) ; `ok: false` + raison sinon. */
async function reasoningEnd(dep: DependancesChatControle, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const chatId = champCorps(req, "chat_id") ?? "";
  if (!chatId) return { ok: false, reason: "no_chat" };
  if (!(await getChat(dep.base, uid, chatId))) throw new HttpError(404, "chat_not_found");
  if (!config.LLAMA_REASONING_CONTROL) return { ok: false, reason: "disabled" };
  const entree = controleRaisonnementDuProcess.getCompletion(chatId);
  if (entree === null) return { ok: false, reason: "no_active_completion" };
  const engine = await resolveEngineForUser(uid, entree.engine_key || BUILTIN_KEY);
  if (engine === null || !engine.isLlamacpp) return { ok: false, reason: "unsupported" };
  if (!(await engineCaps("", { engine })).reasoningControl) return { ok: false, reason: "unsupported" };
  const base = engine.isBuiltin ? baseServeur(config.LLAMA_URL) : engine.baseRoot;
  const client = engine.isBuiltin ? getLlmClient() : getLlmClient(base);
  const auth = engine.headerDict();
  const ok = await endReasoning(client, base, entree.completion_id || "", entree.model || "", {
    headers: Object.keys(auth).length ? auth : null,
  });
  log.info(
    `[reasoning_end] user=${uid} chat=${Array.from(chatId).slice(0, 12).join("")} → ${ok ? "ok" : "refusé"}`,
  );
  return { ok, reason: ok ? "" : "engine_refused" };
}

/** Stop : drapeau d'annulation, contrôleur du tour abandonné, session du moteur arrêtée ; sans `chat_id`, seuls les tours sans chat. */
/** Arrêt d'un run de routine : seulement s'il appartient au compte et à cette routine (le Python ne pose qu'un drapeau du compte). */
async function arreterRoutine(base: Base, uid: number, chatId: string): Promise<void> {
  const m = RUN_DE_ROUTINE.exec(chatId);
  const planificateur = planificateurDuProcess();
  if (!m || planificateur === null) return;
  const [routineId, runId] = [Number(m[1]), Number(m[2])];
  try {
    const run = await getRun(base, runId, uid);
    if (run && intPy(run["routine_id"] ?? 0) === routineId)
      planificateur.demanderArret(uid, routineId, runId);
  } catch (e) {
    log.debug(`[chat_cancel.routine] ${String(e)}`);
  }
}

async function cancel(dep: DependancesChatControle, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const chatId = champCorps(req, "chat_id");
  if (chatId) {
    markChatCancelled(uid, chatId);
    jobsTour()?.arretUtilisateur(uid, chatId);
    const tache = getActiveChatTask(uid, chatId);
    const court = Array.from(chatId).slice(0, 12).join("");
    if (tache !== null && !tache.signal.aborted) {
      tache.abort(new CancelledError("chat cancelled"));
      log.info(`[chat_cancel] User ${uid} chat=${court} : tour abandonné`);
    } else log.info(`[chat_cancel] User ${uid} chat=${court} : aucun tour en cours`);
    await arreterRoutine(dep.base, uid, chatId);
    await cancelEngineStream(uid, chatId);
  } else {
    markChatCancelled(uid, "__none__");
    let annules = 0;
    for (const t of tachesSansChat(uid)) {
      if (t.signal.aborted) continue;
      t.abort(new CancelledError("chat cancelled"));
      annules += 1;
    }
    log.warn(
      `[chat_cancel] User ${uid} : appel SANS chat_id (legacy) — ${annules} task(s) legacy cancellée(s). Le client devrait passer chat_id.`,
    );
  }
  return { status: "cancelled" };
}

async function taskCancel(dep: DependancesChatControle, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const childId = champCorps(req, "child_id");
  if (!childId) throw new HttpError(400, "child_id requis");
  const username = (await getUsernameById(dep.base, uid)) || `user_${uid}`;
  const active = cancelChild(username, childId);
  log.info(`[task_cancel] user=${username} child=${childId} active=${active}`);
  return { status: "cancelled", active };
}

/** Obsolète : la compression est faite par le serveur pendant le flux ; renvoie les messages tels quels. */
function compress(req: FastifyRequest, rep: FastifyReply): FastifyReply {
  const uid = utilisateur(req);
  let data: unknown;
  try {
    data = corpsJsonValeurs(req);
  } catch {
    data = {};
  }
  if (!estDict(data)) throw new TypeError(`corps JSON sans clés : ${typeof data}`);
  const messages = "messages" in data ? data["messages"] : [];
  log.info(
    `[/api/chat/compress DEPRECATED] call ignored — user=${uid}, ${Array.isArray(messages) ? messages.length : 0} msgs — compression is now backend-only and automatic.`,
  );
  return reponseJsonPy(rep, {
    ok: true,
    compressed: false,
    messages,
    deprecated: true,
    reason: "Server-side compression now runs automatically during chat streaming.",
  });
}

/** Génération en cours ou non, et de quoi se rattacher au run (journal non terminé). */
function generationStatus(req: FastifyRequest, rep: FastifyReply): FastifyReply {
  const uid = utilisateur(req);
  const chatId = chatDuChemin(req);
  let running = isGenerationActive(uid, chatId);
  const out: Dict = { generation_running: running, run_id: null, resumable: false };
  try {
    const cur = currentRun(uid, chatId);
    if (cur !== null && veritePy(cur["ended"])) out["generation_running"] = running = false;
    if (cur !== null && running) {
      Object.assign(out, {
        run_id: cur["run_id"] ?? null,
        resumable: true,
        started_at: cur["started_at"] ?? null,
        base_count: cur["base_count"] ?? null,
        is_continue: veritePy(cur["is_continue"]),
        user_message: veritePy(cur["user_message"]) ? cur["user_message"] : "",
        engine_key: veritePy(cur["engine_key"]) ? cur["engine_key"] : "builtin",
      });
      if (estDict(cur["image_request"])) out["image_request"] = cur["image_request"];
    }
  } catch (e) {
    log.debug(`[chat.generation_status.journal] ${String(e).slice(0, 120)}`);
  }
  return reponseJsonPy(rep, out);
}

/** Rejoue puis suit le run en NDJSON ; dossier indexé par le compte de la SESSION (jamais le run d'un autre compte). */
async function runEvents(
  dep: DependancesChatControle,
  req: FastifyRequest,
  rep: FastifyReply,
): Promise<void> {
  const uid = utilisateur(req);
  const suivi = preparerSuivi(uid, chatDuChemin(req), parametre(req, "run_id"), parametre(req, "from"));
  const loginTs = req.session.get("_login_ts");
  const sid = req.session.get("_sid");
  const sortie = ouvrirFlux(rep, ENTETES_NDJSON, dep.arret);
  try {
    const flux = evenementsDuRun(suivi, {
      signal: sortie.signal,
      revalider: () => revaliderFlux(dep.auth, uid, loginTs, sid),
    });
    for await (const ev of flux) {
      if (sortie.signal.aborted) break;
      await sortie.ecrire(ligneNdjson(ev));
    }
  } catch (e) {
    log.warn(`[run/events] suivi interrompu : ${String(e).slice(0, 160)}`);
  } finally {
    sortie.fermer();
  }
}

export function creerFamilleChatControle(dep: DependancesChatControle): Famille {
  return {
    nom: "chat-controle",
    routes: [
      route("POST", "/api/chat/reasoning-end", (req) => reasoningEnd(dep, req)),
      route("POST", "/api/chat/cancel", (req) => cancel(dep, req)),
      route("POST", "/api/chat/task-cancel", (req) => taskCancel(dep, req)),
      route("POST", "/api/chat/compress", (req, rep) => compress(req, rep)),
      route("GET", "/api/chat/:chat_id/generation-status", (req, rep) => generationStatus(req, rep)),
      route("GET", "/api/chats/active-runs", (req) => ({ chat_ids: listActiveChatIds(utilisateur(req)) })),
      route("GET", "/api/chat/:chat_id/run/events", (req, rep) => runEvents(dep, req, rep)),
    ],
  };
}
