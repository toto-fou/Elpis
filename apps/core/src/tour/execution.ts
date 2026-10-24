// SPDX-License-Identifier: MIT
/** apps/core/src/tour/execution.ts — exécution d'un tour : générateur des événements du flux et son worker (attente du moteur, boucle d'outils, titre, persistance du tour ou du partiel, `final`), puis détachement ou clôture du run (chatbot_app/turn/execution.py ; chemin outils seul, E23). */
import { performance } from "node:perf_hooks";

import {
  arrondiEntierPy,
  CancelledError,
  dormirMs,
  ErreurPython,
  estDict,
  FlottantPy,
  estErreurAnnulation,
  floatPy,
  intPy,
  prefixePy,
  strPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import type { Base } from "@elpis/db";

import { generateChatTitle } from "../boucle/appels-uniques";
import { runChatMultiMcp } from "../boucle/orchestrateur";
import type { OptionsRun } from "../boucle/orchestrateur";
import { logMetric, tokenHex } from "../boucle/ports";
import type { SortieRun } from "../boucle/sortie";
import { enforceRecentChatsCap, finalizeTurnMeta, getChat } from "../chats/stockage";
import {
  buildStateSystemMessage,
  extractCompressionState,
  stripSummaryMessages,
} from "../contexte/etat-compression";
import { currentRun, runScope } from "../executions/registre";
import { embedChartConfigs } from "../graphiques/incrustation";
import { journal } from "../journal";
import type { LlmTarget } from "../llm/cible";
import { useLlmTarget } from "../llm/cible";
import { getModelContextSize } from "../llm/modeles";
import { engineForTarget } from "../llm/moteurs";
import { avecLLM, etatFile, ordonnanceur } from "../llm/ordonnanceur/process";
import type { Slot } from "../llm/ordonnanceur";
import { LLMQueueAborted } from "../llm/ordonnanceur";
import { LLMFailure, llmErrorKind } from "../llm/reprises";
import type { OutilIntegre } from "../outils/catalogue";
import { buildImageBuiltinTool } from "../outils/integres/image";
import { buildTaskBuiltinTool } from "../outils/integres/taches-agents";
import { creerOutilsChatRag } from "../rag/outils-chat";
import type { OutilsChatRag } from "../rag/outils-chat";
import { reclamerVerrou } from "./admission";
import {
  clearChatCancellation,
  isChatCancelled,
  markChatCancelled,
  registerChatTask,
  unregisterChatTask,
} from "./etat";
import {
  drainCoalesced,
  dropEventAfterCancel,
  FileEvenements,
  startLoadWatch,
  stopLoadWatch,
} from "./evenements";
import { CANCEL_PLACEHOLDER, compactionPourMessage, fcMerge } from "./historique";
import { RunJournal } from "./journal-run";
import {
  CONTINUE_ADDITIVE_METRICS,
  messageAssistant,
  messagePartiel,
  persistTurn,
  planModeShouldEnd,
  suffixeQuestion,
} from "./persistance";
import { jobsTour } from "./ports-jobs";
import { agentMcpConfigs, suffixeDeQuestion } from "./preparation";
import type { PersistBaseline, TurnPlan, TurnResources } from "./preparation";

const log = journal("uvicorn.error");

const WAIT_REPORT_FIRST_S = 3.0;
const WAIT_REPORT_PERIOD_S = 10.0;
const TITRE_ATTENTE_S = 3.0;
const CLOTURE_S = 10.0;

const monotone = (): number => performance.now() / 1000;
const court = (s: string): string => Array.from(s).slice(0, 12).join("");

export interface OptionsAdmission {
  readonly model: string | null;
  readonly target: LlmTarget;
  readonly signal: AbortSignal;
  readonly onWait: (waited: number) => Promise<void>;
  readonly cancelProbe: () => boolean;
}

/** Points de substitution des tests (horloge, admission, boucle, titre, file, fenêtre). */
export interface ReglagesExecution {
  dormir: (s: number, signal?: AbortSignal) => Promise<void>;
  admission: <T>(o: OptionsAdmission, fn: (slot: Slot | null) => Promise<T>) => Promise<T>;
  boucle: (o: OptionsRun) => Promise<SortieRun>;
  titre: typeof generateChatTitle;
  etatFile: (model: string | null, target: LlmTarget) => Promise<Dict>;
  contexteModele: (model: string) => Promise<number>;
}

function dormirReel(s: number, signal?: AbortSignal): Promise<void> {
  return dormirMs(s * 1000, signal).catch(() => undefined);
}

/** `llm_scheduling_guard` du tour : attente rapportée (3 s puis toutes les 10 s), le corps n'entre qu'après le rapport en cours ; abandon sur le drapeau d'annulation ; moteur hors file, sans attente. */
async function admissionRapportee<T>(o: OptionsAdmission, fn: (slot: Slot | null) => Promise<T>): Promise<T> {
  const engine = engineForTarget(o.target);
  if (!engine.profil.capacites.file) return fn(null);
  const admission = new AbortController();
  const relais = (): void => admission.abort(o.signal.reason);
  if (o.signal.aborted) relais();
  else o.signal.addEventListener("abort", relais, { once: true });
  let admis = false;
  let rapport: Promise<void> = Promise.resolve();
  const t0 = monotone();
  let prochain = WAIT_REPORT_FIRST_S;
  const sonde = async (): Promise<void> => {
    while (!admis && !admission.signal.aborted) {
      await reglages.dormir(0.25, admission.signal);
      if (admis || admission.signal.aborted) return;
      const attendu = monotone() - t0;
      let abandon: boolean;
      try {
        abandon = o.cancelProbe();
      } catch {
        abandon = false;
      }
      if (abandon) {
        admission.abort(new LLMQueueAborted("attente du modèle interrompue à votre demande"));
        return;
      }
      if (attendu >= prochain) {
        prochain = attendu + WAIT_REPORT_PERIOD_S;
        rapport = o.onWait(attendu).catch(() => undefined);
        await rapport;
      }
    }
  };
  void sonde();
  try {
    return await avecLLM(
      engine,
      o.model,
      "high",
      admission.signal,
      async (slot) => {
        admis = true;
        await rapport;
        return fn(slot);
      },
      { outils: true },
    );
  } finally {
    admis = true;
    o.signal.removeEventListener("abort", relais);
  }
}

const DEFAUTS: ReglagesExecution = {
  dormir: dormirReel,
  admission: admissionRapportee,
  boucle: runChatMultiMcp,
  titre: generateChatTitle,
  etatFile: (model, target) => etatFile(model, engineForTarget(target)),
  contexteModele: (model) => getModelContextSize(model),
};
let reglages: ReglagesExecution = { ...DEFAUTS };

export function reglerExecutionPourTests(r: Partial<ReglagesExecution> | null): void {
  reglages = r === null ? { ...DEFAUTS } : { ...reglages, ...r };
}

/** Détacher le run plutôt que l'arrêter à la fermeture du flux : déconnexion subie d'un tour reprenable, ou qui a déjà fait tourner un outil ; jamais sur un Stop ni un tour fini. */
export function shouldDetachRun(o: {
  detachEnabled: boolean;
  taskDone: boolean;
  userStopped: boolean;
  toolsRan?: boolean;
}): boolean {
  if (o.taskDone || o.userStopped) return false;
  return o.detachEnabled || Boolean(o.toolsRan);
}

/** Occupation du contexte à pousser dans la jauge : le dernier prompt envoyé, sinon l'entrée d'un appel unique ; 0 = rien de fiable. */
export function kvGaugeUsedTokens(metrics: unknown): number {
  if (!estDict(metrics)) return 0;
  const lp = metrics["last_prompt_tokens"];
  if ((typeof lp === "number" || typeof lp === "boolean" || lp instanceof FlottantPy) && floatPy(lp) > 0)
    return Math.trunc(floatPy(lp));
  if ("submitted_input_tokens" in metrics || veritePy(metrics["tool_limit_reached"])) return 0;
  try {
    return Math.max(0, intPy(veritePy(metrics["input_tokens"]) ? metrics["input_tokens"] : 0));
  } catch {
    return 0;
  }
}

/** Occupation RÉELLE du contexte en fin de tour (`{used, total, pct, model, ts}`), sur un moteur qui annonce sa fenêtre. */
export async function ctxUsageSnapshot(
  metrics: unknown,
  model: string | null,
  target: LlmTarget,
): Promise<Dict | null> {
  if (!estDict(metrics) || !Object.keys(metrics).length || target.profil.capacites.contexte === "aucune")
    return null;
  let used = kvGaugeUsedTokens(metrics);
  if (used <= 0) return null;
  let total: number;
  try {
    total = Math.trunc((await useLlmTarget(target, () => reglages.contexteModele(model || ""))) || 0);
  } catch {
    total = 0;
  }
  if (total <= 0) return null;
  used = Math.min(used, total);
  return {
    used,
    total,
    pct: Math.min(100, arrondiEntierPy((used / total) * 100)),
    model: prefixePy(strPy(model || ""), 120),
    ts: versFlottantPy(Date.now() / 1000),
  };
}

/** Événement `final` du tour complet ; `title` seulement si le titre vient d'être (re)généré. */
export function payloadFinal(
  assistant: string,
  msg: Dict,
  thinkingText: string,
  metrics: Dict | null,
  o: {
    execId: string;
    chatId: string;
    planDone: boolean;
    titleWasGenerated: boolean;
    finalTitle: string;
    persisted: boolean;
    persistError: string | null;
  },
): Dict {
  const metMsg = estDict(msg["metrics"]) ? msg["metrics"] : {};
  const avec = estDict(metrics) && Object.keys(metrics).length > 0;
  const metriques: Dict | null = avec ? { ...metrics } : metrics;
  if (avec)
    for (const k of [...CONTINUE_ADDITIVE_METRICS, "segments", "thinking_tokens_estimated"])
      if (k in metMsg) metriques![k] = metMsg[k];
  const p: Dict = {
    type: "final",
    assistant,
    run_ids: veritePy(msg["run_ids"]) ? msg["run_ids"] : [o.execId],
    ...(veritePy(msg["files_changed"]) ? { files_changed: msg["files_changed"] } : {}),
    ...(veritePy(msg["compactions"]) ? { compactions: msg["compactions"] } : {}),
    ...(veritePy(msg["pruned"]) ? { pruned: msg["pruned"] } : {}),
    ...(veritePy(msg["tool_images"]) ? { tool_images: msg["tool_images"] } : {}),
    ...(veritePy(msg["rag_sources"]) ? { rag_sources: msg["rag_sources"] } : {}),
    chat_id: o.chatId,
    ...(o.planDone ? { plan_mode_done: true } : {}),
    ...(o.titleWasGenerated ? { title: o.finalTitle } : {}),
    metrics: metriques,
    thinking: "thinking" in msg ? msg["thinking"] : thinkingText,
    tool_limit_reached: avec && veritePy(metrics["tool_limit_reached"]),
    truncated: avec && (veritePy(metrics["truncated"]) || veritePy(metrics["tool_limit_reached"])),
    truncated_in_think: avec && veritePy(metrics["truncated_in_think"]),
    persisted: o.persisted,
  };
  if (!o.persisted && o.persistError) p["persist_error"] = o.persistError;
  return p;
}

/** `p` borné à `s` secondes : `undefined` à l'échéance ; la minuterie tombe avec la course. */
async function auPlus<T>(p: Promise<T>, s: number): Promise<T | undefined> {
  const fin = new AbortController();
  try {
    return await Promise.race([p, reglages.dormir(s, fin.signal).then(() => undefined)]);
  } finally {
    fin.abort();
  }
}

/** Clôture du run sans détachement : déconnexion en plein travail (Stop, attente de l'unwind) ou fin normale (verrou rendu). */
async function cloturerRun(
  tache: Promise<void>,
  etat: { fini: boolean },
  controleur: AbortController,
  uid: number,
  chatId: string,
  finalSent: boolean,
): Promise<void> {
  const attendre = (): Promise<unknown> =>
    auPlus(
      tache.catch(() => undefined),
      CLOTURE_S,
    );
  if (finalSent && !etat.fini) await attendre();
  else if (!etat.fini) {
    markChatCancelled(uid, chatId);
    controleur.abort(new CancelledError("chat stream closed"));
    await attendre();
  }
  if (etat.fini) unregisterChatTask(uid, chatId, controleur);
  else {
    log.warn(
      `[chat_stream] worker toujours actif 10 s après l'annulation (user=${uid} chat=${chatId}) — présence conservée jusqu'à sa fin réelle`,
    );
    void tache.finally(() => unregisterChatTask(uid, chatId, controleur));
  }
}

export interface DependancesExecution {
  readonly base: Base;
}

/** Événements du tour pour le client : réclame le verrou réservé, lance le worker et draine sa file ; à la fermeture (fin, ou `signal` : client parti), détache ou clôt le run. */
export async function* runTurn(
  dep: DependancesExecution,
  plan: TurnPlan,
  res: TurnResources,
  base: PersistBaseline,
  signal: AbortSignal,
): AsyncGenerator<Dict> {
  const db = dep.base;
  const { userId: uid, chatId, target, selectedModel } = plan;
  const claimed = reclamerVerrou(uid, chatId);
  let journalRun: RunJournal | null = null;
  if (plan.resumable) {
    try {
      const jmeta: Dict = {
        engine_key: target.connectorId ? `conn:${target.connectorId}` : "builtin",
        model: selectedModel || "",
        is_continue: plan.isContinue,
        base_count: plan.messages.length,
        user_message: prefixePy(plan.lastUserText || "", 20000),
        ...(plan.origin === "job_wake"
          ? { origin: "job_wake", ...(plan.wake ? { wake: plan.wake } : {}) }
          : {}),
      };
      journalRun = new RunJournal(uid, chatId, plan.runId, jmeta);
      if (!(await journalRun.open({ ...jmeta, chat_id: chatId }))) journalRun = null;
    } catch (e) {
      log.debug(`[chat.run_journal.open] ${String(e)}`);
      journalRun = null;
    }
  }
  const q = new FileEvenements(1000);
  const contenuPartiel: string[] = [];
  const fichiers = new Map<string, Dict>();
  const compactions: Dict[] = [];
  let compactionEnCours: Dict = {};
  const toursVus = { n: 0, arme: false };
  const raisonnementPartiel: string[] = [];
  let historiquePartiel: unknown[] = [];
  let nouvelEtatCompression: Dict = {};
  let nouvellesClesElaguees: string[] = [];
  const suffixeTour = suffixeDeQuestion(plan.ragSuffix, plan.jobSuffix);
  const nouveauSuffixe: Dict = suffixeTour ? { text: suffixeTour } : {};
  const issueJobs = { message: false, reponse: false, suffixe: false };
  const drapeaux = { detache: false, lecteurParti: false, outils: false, finalEnvoye: false };
  let { updatedAt: baselineUpdatedAt, messages: baselineMessages, title: baselineTitle } = base;
  let comprPrevState = base.comprPrevState;

  const onEvent = async (ev: Dict): Promise<void> => {
    const t = estDict(ev) ? ev["type"] : undefined;
    if (t === "tool_history_partial") {
      if (Array.isArray(ev["tool_history"])) historiquePartiel = [...(ev["tool_history"] as unknown[])];
      return;
    }
    if (t === "llm_user_suffix") {
      if (typeof ev["text"] === "string" && ev["text"])
        nouveauSuffixe["text"] = suffixeTour ? `${suffixeTour}\n\n${ev["text"]}` : ev["text"];
      return;
    }
    if (t === "prune_state") {
      if (Array.isArray(ev["keys"]))
        nouvellesClesElaguees = (ev["keys"] as unknown[]).filter((k): k is string => typeof k === "string");
      return;
    }
    if (t === "compression_state") {
      nouvelEtatCompression = {
        round: ev["round"] ?? null,
        covered_turns: ev["covered_turns"] ?? null,
        summary_xml: ev["summary_xml"] ?? null,
        turns_compressed: ev["turns_compressed"] ?? null,
        ledger_block: veritePy(ev["ledger_block"]) ? ev["ledger_block"] : "",
      };
      return;
    }
    if (t === "iteration") toursVus.arme = true;
    else if (t === "tool_call" && toursVus.arme) {
      toursVus.n += 1;
      toursVus.arme = false;
    } else if (t === "compression_start") {
      compactionEnCours = {
        reason: ev["reason"] ?? null,
        threshold: ev["threshold"] ?? null,
        ctx_size: ev["ctx_size"] ?? null,
        round: toursVus.n,
      };
    } else if (t === "compression_done") {
      const st = estDict(ev["stats"]) ? ev["stats"] : {};
      if (veritePy(st["compressed"]))
        compactions.push(compactionPourMessage({ ...st, ...compactionEnCours, path: ev["path"] ?? null }));
      compactionEnCours = {};
    }
    if ((t === "tool_result" || t === "task_step") && veritePy(ev["files"])) fcMerge(fichiers, ev["files"]);
    if (dropEventAfterCancel(t, isChatCancelled(uid, chatId), ev["status"])) return;
    if (t === "tool_call" || t === "tool_result") drapeaux.outils = true;
    else if (t === "final") drapeaux.finalEnvoye = true;
    if (t === "content_token") {
      contenuPartiel.push(strPy(ev["text"] ?? ""));
      if (contenuPartiel.length > 512)
        contenuPartiel.splice(0, contenuPartiel.length, contenuPartiel.join(""));
    } else if (t === "content_replace")
      contenuPartiel.splice(0, contenuPartiel.length, strPy(ev["text"] ?? ""));
    else if (t === "thinking_token") {
      raisonnementPartiel.push(strPy(ev["text"] ?? ""));
      if (raisonnementPartiel.length > 512)
        raisonnementPartiel.splice(0, raisonnementPartiel.length, raisonnementPartiel.join(""));
    }
    if (journalRun !== null) {
      journalRun.append(ev);
      if (t === "final") {
        const statut = veritePy(ev["cancelled"])
          ? "cancelled"
          : ev["persisted"] === false && veritePy(ev["persist_error"])
            ? "error"
            : "done";
        void journalRun.close(statut);
      }
    }
    if (drapeaux.detache || drapeaux.lecteurParti) return;
    await q.put(ev);
  };

  /** Préfixe l'état de compression (nouveau, sinon reporté) à la liste persistée ; jamais bloquant. */
  const avecEtatCompression = async (full: Dict[]): Promise<Dict[]> => {
    try {
      if (plan.chatReadFailed && comprPrevState === null) {
        try {
          const relu = await getChat(db, uid, chatId);
          if (relu)
            comprPrevState = extractCompressionState(
              Array.isArray(relu["messages"]) ? relu["messages"] : [],
            ) as Dict | null;
        } catch (e) {
          log.warn(
            `[chat_stream] relecture de l'état de compression échouée — persist SANS carry-forward : ${String(e)}`,
          );
        }
      }
      let st: Dict | null = null;
      if (veritePy(nouvelEtatCompression["summary_xml"])) st = nouvelEtatCompression;
      else if (comprPrevState && veritePy(comprPrevState["summary_xml"])) st = comprPrevState;
      if (!st) return full;
      const etat = buildStateSystemMessage(
        strPy(st["summary_xml"]),
        intPy(veritePy(st["round"]) ? st["round"] : 1),
        intPy(veritePy(st["covered_turns"]) ? st["covered_turns"] : 0),
        (st["turns_compressed"] ?? null) as number | null,
        veritePy(st["ledger_block"]) ? strPy(st["ledger_block"]) : "",
      );
      return [etat, ...(stripSummaryMessages(full) as Dict[])];
    } catch (e) {
      log.warn(`[chat_stream] _with_compr_state échoué (persist sans état) : ${String(e)}`);
      return full;
    }
  };

  /** Question écrite dès le début d'un tour reprenable (sous la garde optimiste), base recalée. */
  const persisterQuestion = async (): Promise<void> => {
    if (!plan.resumable || plan.ephemeral || plan.chatReadFailed || plan.isContinue) return;
    try {
      const tot = await avecEtatCompression([...plan.msgs]);
      const ts = Date.now() / 1000;
      const attendu =
        baselineUpdatedAt === null || baselineUpdatedAt === undefined ? null : floatPy(baselineUpdatedAt);
      const ok = await res.persistChat(uid, chatId, plan.title, tot, ts, attendu);
      if (ok !== false) {
        issueJobs.message = true;
        baselineUpdatedAt = versFlottantPy(ts);
        baselineMessages = tot;
        baselineTitle = plan.title;
      }
    } catch (e) {
      log.debug(`[chat.persist_question] ${String(e)}`);
    }
  };

  const issueDuTour = (statut: string, kind = ""): void => {
    try {
      currentRun()?.finish(statut, kind);
    } catch {
      // issue best-effort
    }
  };

  const controleur = new AbortController();
  const estAnnule = (): boolean => isChatCancelled(uid, chatId);

  const worker = async (): Promise<void> => {
    clearChatCancellation(uid, chatId);
    let finalAssistant = "";
    let tourPersiste = false;
    let annule = false;
    let plante = false;
    const fileAnnoncee = { v: false };
    const taskUsage: Dict = {};
    const imageSink: Dict = {};
    const rag: { outils: OutilsChatRag | null } = { outils: null };
    let titre: { promesse: Promise<string | null>; fini: boolean; valeur: string | null } | null = null;
    const titreArret = new AbortController();
    try {
      await persisterQuestion();
      const parts: string[] = [];
      if (plan.activeMcpServers.length)
        parts.push("MCP: " + plan.activeMcpServers.map((s) => strPy(s["name"] ?? "?")).join(", "));
      if (plan.rag) parts.push("Documents");
      if (plan.imageToolOn) parts.push("Images");
      await onEvent({ type: "mode", text: parts.length ? parts.join(" + ") : "Génération en cours…" });

      let metrics: Dict = {};
      let assistant = "";
      let thinkingText = "";
      const engine = engineForTarget(target);
      const qstatus = await reglages.etatFile(selectedModel, target);
      if (qstatus["kind"] !== "ready") {
        await onEvent({ type: "queue_status", ...qstatus });
        fileAnnoncee.v = true;
      }
      if (qstatus["kind"] === "loading")
        useLlmTarget(target, () => startLoadWatch(selectedModel ?? "", onEvent, uid, chatId, qstatus));
      if (target.profil.capacites.file) {
        const effectif = ordonnanceur().modeleEffectif(engine.key, selectedModel);
        const pools = (ordonnanceur().stats(engine.key) as Dict)["active_models"];
        if (
          Array.isArray(pools) &&
          pools.some((p) => estDict(p) && p["model"] === effectif && p["sem_locked"] === true)
        )
          await onEvent({ type: "thinking", text: "En attente…" });
      }
      const surAttente = async (attendu: number): Promise<void> => {
        const qs: Dict = { ...(await reglages.etatFile(selectedModel, target)) };
        delete qs["type"];
        qs["kind"] = veritePy(qs["kind"]) ? qs["kind"] : "waiting";
        qs["waited_ms"] = Math.trunc(attendu * 1000);
        fileAnnoncee.v = true;
        await onEvent({ type: "queue_status", ...qs });
      };
      const attenteT0 = monotone();
      let debutLlm = 0;
      await useLlmTarget(target, () =>
        reglages.admission(
          {
            model: selectedModel,
            target,
            signal: controleur.signal,
            onWait: surAttente,
            cancelProbe: estAnnule,
          },
          async (slot) => {
            try {
              currentRun()?.addWait(Math.trunc((monotone() - attenteT0) * 1000));
            } catch {
              // attente non comptée
            }
            if (fileAnnoncee.v) {
              await onEvent({ type: "queue_cleared" });
              fileAnnoncee.v = false;
            }
            debutLlm = Date.now();
            if (plan.titleWasGenerated && !plan.ephemeral && !plan.chatReadFailed) {
              const t = {
                promesse: Promise.resolve<string | null>(null),
                fini: false,
                valeur: null as string | null,
              };
              t.promesse = reglages
                .titre(selectedModel, plan.titleContent, "", { chatId, signal: titreArret.signal })
                .catch(() => null)
                .then((v) => {
                  t.fini = true;
                  t.valeur = v;
                  return v;
                });
              titre = t;
            }
            await onEvent({ type: "mode", text: "Outils prêts…" });
            rag.outils = plan.rag
              ? creerOutilsChatRag({
                  base: db,
                  uid,
                  chatId,
                  collections: plan.rag.collections,
                  mode: plan.rag.mode,
                  topK: plan.rag.topK,
                  precedentes: plan.rag.precedentes,
                  ecriture: !plan.planMode,
                  onEvent,
                  signal: controleur.signal,
                })
              : null;
            const taskBuiltin = plan.agentsOn
              ? buildTaskBuiltinTool({
                  parentMcpConfigs: plan.activeMcpServers,
                  parentBuiltinTools: rag.outils?.outils ?? null,
                  username: plan.username,
                  chatId,
                  model: selectedModel,
                  samplingOverride: plan.samplingOverride,
                  memoryEnabled: plan.memoryOn,
                  isCancelled: estAnnule,
                  signal: controleur.signal,
                  onEvent,
                  usageSink: taskUsage,
                  customAgents: Array.isArray(plan.userSettings["custom_agents"])
                    ? (plan.userSettings["custom_agents"] as unknown[])
                    : [],
                  userMcpConfigs: await agentMcpConfigs(db, plan.userSettings, uid),
                  userId: uid,
                })
              : {};
            const imageBuiltin: Record<string, OutilIntegre> = plan.imageToolOn
              ? buildImageBuiltinTool({
                  base: db,
                  userId: uid,
                  chatId: plan.ephemeral ? null : chatId,
                  onEvent,
                  signal: controleur.signal,
                  sink: imageSink,
                  prefs: plan.userSettings["image_prefs"],
                })
              : {};
            const tous = { ...(rag.outils?.outils ?? {}), ...taskBuiltin, ...imageBuiltin };
            [assistant, , metrics] = await reglages.boucle({
              messages: plan.msgsForLlm,
              mcpConfigs: plan.activeMcpServers,
              onEvent,
              username: plan.username,
              userId: uid,
              model: selectedModel,
              builtinTools: Object.keys(tous).length ? tous : null,
              isCancelled: estAnnule,
              signal: controleur.signal,
              chatId,
              samplingOverride: plan.samplingOverride,
              thinkingMode: plan.thinkingMode,
              memoryEnabled: plan.memoryOn,
              compressionPrevState: comprPrevState,
              liveShell: plan.liveShellOn,
              compressionEnabled: plan.compressionOn,
              compactionThreshold: plan.compactionThreshold,
              compactionMaxRounds: plan.compactionMaxRounds,
              pruneKeys: plan.prunedKeys,
              ephemeral: plan.ephemeral,
              denyToolNames: plan.denyTools,
              readOnly: plan.planMode,
              slot,
            });
            thinkingText =
              estDict(metrics) && typeof metrics["thinking"] === "string" ? metrics["thinking"] : "";
            if (veritePy(taskUsage["tasks"]))
              logMetric("task_runs", Number(taskUsage["tasks"]), { user: plan.username });
          },
        ),
      );
      if (target.profil.capacites.file) {
        try {
          ordonnanceur().recordLlmDuration(engine.key, selectedModel, Date.now() - debutLlm);
        } catch (e) {
          log.debug(`[chat.worker.3] ${String(e)}`);
        }
      }
      let ctxSnap: Dict | null = null;
      try {
        ctxSnap = await ctxUsageSnapshot(metrics, selectedModel, target);
      } catch (e) {
        log.debug(`[chat.worker.ctx_snapshot] ${String(e)}`);
      }
      const [msg, avant, apres, contenu] = messageAssistant(assistant, thinkingText, metrics, {
        execId: plan.execId,
        ctxSnap,
        taskUsage,
        filesChanged: fichiers,
        compactions,
        pruneKeys: nouvellesClesElaguees,
        msgs: plan.msgs,
        isContinue: plan.isContinue,
        toolImages: Array.isArray(imageSink["images"]) ? (imageSink["images"] as unknown[]) : null,
        ragSources: rag.outils?.numerotation.sources() ?? null,
      });
      assistant = contenu;
      let full = await avecEtatCompression([...avant, msg, ...apres]);
      full = (await embedChartConfigs(db, uid, chatId, full)) as Dict[];
      let persisted = false;
      let persistError: string | null = null;
      let finalTitle = plan.title;
      const t = titre as { promesse: Promise<string | null>; fini: boolean; valeur: string | null } | null;
      if (t !== null) {
        const attente = await auPlus(t.promesse, TITRE_ATTENTE_S);
        if (attente === undefined && !t.fini) titreArret.abort(new CancelledError("chat_title wait"));
        else if (attente) finalTitle = attente;
      }
      let chatEffectif = chatId;
      try {
        tourPersiste = true;
        let ret: boolean | null;
        [ret, finalTitle] = await persistTurn(res.persistChat, uid, chatId, finalTitle, full, {
          baselineUpdatedAt,
          baselineMessages,
          baselineTitle,
          readChat: (u, c) => getChat(db, u, c),
        });
        if (ret === false) {
          persistError = "conflict";
          log.warn(
            `[chat_stream] persist en conflit optimiste (tour concurrent sur le même chat) user_id=${uid} chat_id=${court(chatId)} — non écrasé`,
          );
        } else {
          await enforceRecentChatsCap(db, uid);
          persisted = true;
          issueJobs.message = issueJobs.reponse = true;
        }
      } catch (e) {
        if (e instanceof ErreurPython && e.type === "ValueError") {
          const nouveau = tokenHex(12);
          log.warn(
            `[chat_stream] collision chat_id cross-user — bascule sur un nouvel id serveur user_id=${uid} ancien=${court(chatId)} nouveau=${nouveau.slice(0, 12)} : ${e.message}`,
          );
          try {
            await res.persistChat(uid, nouveau, finalTitle, full, Date.now() / 1000, null);
            await enforceRecentChatsCap(db, uid);
            chatEffectif = nouveau;
            persisted = true;
          } catch (e2) {
            persistError = "collision";
            log.warn(
              `[chat_stream] retry sur nouvel id échoué user_id=${uid} chat_id=${nouveau.slice(0, 12)} : ${String(e2)}`,
            );
          }
        } else {
          persistError = "db";
          log.warn(
            `[chat_stream] persistance du tour échouée (réponse générée mais NON sauvegardée) user_id=${uid} chat_id=${court(chatId)} : ${String(e)}`,
          );
        }
      }
      const doPrune = persisted && nouvellesClesElaguees.length > 0;
      const doTools = persisted && !plan.ephemeral && plan.mcpOn && plan.origin !== "job_wake";
      const planOff = planModeShouldEnd(plan.planMode, persisted, plan.ephemeral, metrics);
      const doCtx = persisted && !plan.ephemeral && ctxSnap !== null;
      let suffixes: Dict | null = null;
      let rangSuffixe: number | null = null;
      if (persisted && !plan.ephemeral && !plan.isContinue) {
        try {
          [suffixes, rangSuffixe] = suffixeQuestion(plan.messages, plan.existingChat, nouveauSuffixe);
        } catch (e) {
          log.debug(`[chat.user_suffix_sig] ${String(e)}`);
        }
      }
      let planDone = false;
      if (doPrune || doTools || planOff || doCtx || suffixes) {
        try {
          const ok = await finalizeTurnMeta(db, uid, chatEffectif, {
            prunedKeys: doPrune ? [...nouvellesClesElaguees] : null,
            tools: doTools
              ? [...plan.uiToolCats, ...plan.uiExtIds, ...plan.uiExcl.map((n) => "-" + n)]
              : null,
            planModeOff: planOff,
            ctxUsage: doCtx ? ctxSnap : null,
            userSuffixes: suffixes,
            suffixDropFromRank: rangSuffixe,
          });
          planDone = ok && planOff;
          if (suffixes) issueJobs.suffixe = ok;
        } catch (e) {
          log.debug(`[chat.worker.4] ${String(e)}`);
        }
      }
      finalAssistant = assistant;
      if (ctxSnap) {
        try {
          await onEvent({
            type: "kv_cache",
            used: ctxSnap["used"],
            total: ctxSnap["total"],
            pct: ctxSnap["pct"],
          });
        } catch (e) {
          log.debug(`[chat.worker.6] ${String(e)}`);
        }
      }
      await onEvent(
        payloadFinal(assistant, msg, thinkingText, metrics, {
          execId: plan.execId,
          chatId: chatEffectif,
          planDone,
          titleWasGenerated: plan.titleWasGenerated,
          finalTitle,
          persisted,
          persistError,
        }),
      );
      try {
        if (res.memManager !== null) await res.memManager.syncTurn(plan.lastUserText, assistant);
      } catch (e) {
        log.debug(`[chat.worker.5] ${String(e)}`);
      }
      logMetric("message_sent", 1, { role: "user", user: plan.username }, uid);
      logMetric("message_sent", 1, { role: "assistant", user: plan.username }, uid);
    } catch (e) {
      if (e instanceof LLMQueueAborted) {
        annule = true;
        issueDuTour("cancelled");
        log.info("[chat_stream] attente du modèle abandonnée (Stop pendant la file)");
        try {
          await onEvent({ type: "queue_cleared" });
        } catch {
          // événement best-effort
        }
      } else if (estErreurAnnulation(e) || controleur.signal.aborted) {
        annule = true;
        issueDuTour("cancelled");
        log.info("[chat_stream] Cancellation détectée, sauvegarde du partiel…");
      } else {
        if (fileAnnoncee.v) {
          fileAnnoncee.v = false;
          try {
            await onEvent({ type: "queue_cleared" });
          } catch {
            // événement best-effort
          }
        }
        log.error(`[chat_stream] échec de la génération : ${String(e).slice(0, 300)}`);
        plante = true;
        let texte: string;
        let detail: string;
        let kind: string;
        if (e instanceof LLMFailure) [texte, detail, kind] = [e.message, e.detail, e.kind];
        else {
          kind = llmErrorKind(e);
          texte =
            "La génération s'est interrompue sur une erreur interne. Relancez-la ; si le problème persiste, ouvrez un nouveau chat ou signalez le détail ci-dessous.";
          detail = "Le détail figure dans le journal du serveur.";
        }
        issueDuTour("error", kind);
        await onEvent({ type: "error", text: texte, detail, kind });
      }
    } finally {
      if (res.memManager !== null) {
        try {
          await res.memManager.shutdown();
        } catch (e) {
          log.debug(`[chat.worker.7] ${String(e)}`);
        }
      }
      let titrePartiel = plan.title || "Nouveau chat";
      const t = titre as { fini: boolean; valeur: string | null } | null;
      if (t !== null) {
        if (t.fini) titrePartiel = t.valeur || titrePartiel;
        else titreArret.abort(new CancelledError("chat_title abandoned"));
      }
      if ((annule || plante) && !finalAssistant && !tourPersiste) {
        try {
          const p = messagePartiel(contenuPartiel, raisonnementPartiel, historiquePartiel, {
            execId: plan.execId,
            taskUsage,
            filesChanged: fichiers,
            compactions,
            msgs: plan.msgs,
            isContinue: plan.isContinue,
            toolImages: Array.isArray(imageSink["images"]) ? (imageSink["images"] as unknown[]) : null,
            ragSources: rag.outils?.numerotation.sources() ?? null,
          });
          let persiste = false;
          let erreur: string | null = null;
          try {
            let r: boolean | null;
            [r, titrePartiel] = await persistTurn(
              res.persistChat,
              uid,
              chatId,
              titrePartiel,
              await avecEtatCompression(p.conversation),
              { baselineUpdatedAt, baselineMessages, baselineTitle, readChat: (u, c) => getChat(db, u, c) },
            );
            if (r === false) erreur = "conflict";
            else persiste = issueJobs.message = issueJobs.reponse = true;
            if (persiste && !plan.ephemeral && nouvellesClesElaguees.length)
              await finalizeTurnMeta(db, uid, chatId, { prunedKeys: [...nouvellesClesElaguees] }).catch((e) =>
                log.debug(`[chat.partiel.prune] ${String(e)}`),
              );
          } catch (e) {
            erreur = "db";
            log.warn(
              `[chat_stream] persistance du partiel échouée (réponse interrompue NON sauvegardée) user_id=${uid} chat_id=${court(chatId)} : ${String(e)}`,
            );
          }
          const final: Dict = {
            type: "final",
            assistant: p.message["content"],
            run_ids: veritePy(p.message["run_ids"]) ? p.message["run_ids"] : [plan.execId],
            ...(veritePy(p.message["tool_images"]) ? { tool_images: p.message["tool_images"] } : {}),
            ...(veritePy(p.message["rag_sources"]) ? { rag_sources: p.message["rag_sources"] } : {}),
            chat_id: chatId,
            metrics: null,
            thinking: "thinking" in p.message ? p.message["thinking"] : p.raisonnement,
            tool_limit_reached: false,
            cancelled: annule,
            truncated: plante,
            persisted: persiste,
            truncated_in_think: !p.texte && Boolean(p.raisonnementFusionne),
          };
          if (erreur) final["persist_error"] = erreur;
          if (plan.titleWasGenerated) final["title"] = titrePartiel;
          await onEvent(final);
        } catch (e) {
          log.warn(`[chat_stream] Sauvegarde du partiel échouée: ${String(e)}`);
          if (!drapeaux.finalEnvoye) {
            const texte = contenuPartiel.join("").trim();
            const pensee = raisonnementPartiel.join("").trim();
            await onEvent({
              type: "final",
              assistant: texte || CANCEL_PLACEHOLDER,
              run_ids: [plan.execId],
              chat_id: chatId,
              metrics: null,
              thinking: pensee,
              tool_limit_reached: false,
              cancelled: annule,
              truncated: true,
              persisted: false,
              persist_error: "db",
              truncated_in_think: !texte && Boolean(pensee),
            }).catch(() => undefined);
          }
        }
      }
      if (!(drapeaux.detache || drapeaux.lecteurParti)) await q.put(null);
    }
  };

  const etat = { fini: false };
  registerChatTask(uid, controleur, chatId, {
    presenceToken: claimed?.jeton ?? null,
    instantane: plan.instantane ?? null,
  });
  const tache = runScope(
    "chat",
    {
      runId: plan.execId,
      userId: uid,
      chatId,
      model: selectedModel || "",
      engine: engineForTarget(target).key,
    },
    () => worker(),
  )
    .catch((e: unknown) => log.debug(`[chat_stream] worker : ${String(e)}`))
    .finally(async () => {
      if (journalRun !== null) {
        try {
          await journalRun.close(drapeaux.finalEnvoye ? "done" : "error");
        } catch {
          // fermeture best-effort
        }
      }
      etat.fini = true;
      jobsTour()?.finTour(uid, chatId, plan.runId, issueJobs);
    });
  try {
    for await (const ev of drainCoalesced(q, { signal, dormir: (s) => reglages.dormir(s) })) yield ev;
  } catch (e) {
    log.error(`[chat_stream] erreur dans le drain du flux: ${String(e)}`);
    yield { type: "error", text: "Flux interrompu : erreur interne du serveur." };
  } finally {
    stopLoadWatch(uid, chatId);
    const stoppe = isChatCancelled(uid, chatId);
    const detacher = shouldDetachRun({
      detachEnabled: Boolean(config.DETACH_RUN_ON_DISCONNECT) || plan.resumable,
      taskDone: etat.fini,
      userStopped: stoppe,
      toolsRan: drapeaux.outils,
    });
    if (detacher) {
      drapeaux.detache = true;
      q.couper();
      void tache.finally(() => unregisterChatTask(uid, chatId, controleur));
      log.info(
        `[chat_stream] client déconnecté — run DÉTACHÉ (user=${uid} chat=${chatId}) : il ira au bout et persistera seul.`,
      );
    } else {
      drapeaux.lecteurParti = true;
      q.couper();
      await cloturerRun(tache, etat, controleur, uid, chatId, drapeaux.finalEnvoye);
    }
  }
}
