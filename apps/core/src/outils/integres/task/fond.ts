// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/fond.ts — sous-agents lancés en fond par ce process : registre, inscription parmi les jobs, progression, fin inscrite, arrêt ciblé. */
import { longueurPy, prefixePy, pyJsonDumps } from "@elpis/commun";
import { masquerSecretsTexte } from "@elpis/securite";

import type { SurEvenement } from "../../../boucle/evenements";
import { journal } from "../../../journal";
import { plafondParSlots } from "../../../llm/constantes";
import type { Dict } from "../../../python";
import { err } from "../../erreur-outil";
import { tachesFond } from "../../ports";
import { attenteAuMoteur, duree } from "./enfant";
import type { RunEnfant } from "./enfant";
import { traceEnFond } from "./concurrence";
import { champsConso, consoFinale } from "./evenements";
import { ACTIFS, applyChildCancel, cle } from "./registre";

const log = journal("outils.taches-agents");

/** Sous-agent lancé en fond par ce process : son job, sa progression (lue par `task_status`), sa fin (attendue par `task_wait`). */
export interface EnFond {
  readonly uid: number;
  readonly username: string;
  readonly chatId: string;
  readonly jobId: string;
  readonly taskId: string;
  readonly agent: string;
  readonly label: string;
  /** Entrée dans `task` (s, epoch) : l'attente d'une place au moteur s'y mesure tant que l'enfant n'est pas parti. */
  readonly debut: number;
  actif: boolean;
  /** Progression en direct (consommation comprise), puis détail final. */
  lire: () => Dict;
  /** Messages de `task_send` en attente de la prochaine requête de l'enfant au moteur. */
  readonly boite: string[];
  /** Conclusion demandée par le parent (`task_send` wrap_up) : la boucle de l'enfant la prend pour son échéance souple. */
  readonly conclusion: AbortController;
  /** Cinq derniers appels d'outils de l'enfant : outil, aperçu des arguments, état ; figés à sa fin. */
  recent: () => Dict[];
  /** Résolue une fois la fin inscrite parmi les événements du job. */
  readonly fin: Promise<void>;
}
export const FOND = new Map<string, EnFond>();
/** Dernier slot llama.cpp de chaque enfant en fond : les enfants des tours suivants du compte l'évitent comme celui d'un frère. */
export const SLOTS_FOND = new Map<string, { username: string; slot: number }>();
/** Enfants finis gardés pour `task_status` au plus (les plus anciens partent d'abord). */
const FOND_FINIS_MAX = 200;

/** Inscrit un enfant en fond ; au-delà du plafond, les plus anciens finis partent. */
function retenirFond(k: string, e: EnFond): void {
  FOND.delete(k);
  FOND.set(k, e);
  for (const [ancienne, v] of FOND) {
    if (FOND.size <= FOND_FINIS_MAX) break;
    if (!v.actif) FOND.delete(ancienne);
  }
}

/** Sous-agents en fond encore actifs du compte dans ce process. */
export function enfantsEnFondActifs(username: string): number {
  let n = 0;
  for (const e of FOND.values()) if (e.actif && e.username === username) n++;
  return n;
}

/** Arrête un sous-agent en fond actif dans ce process (`/jobs stop`, suppression de sa conversation) ; vrai aussi s'il conclut déjà (sa fin, rapport compris, arrive par son job) ; faux s'il n'y est pas. */
export function annulerEnFond(uid: number, childId: string): boolean {
  for (const [k, e] of FOND)
    if (e.actif && e.uid === uid && k === cle(e.username, childId)) {
      applyChildCancel(e.username, childId);
      return true;
    }
  return false;
}

/** Progression d'un enfant en fond : gardée pour `task_status`, publiée au plus toutes les 3 s (`chat_job`). */
function suivreFond(r: RunEnfant, ev: Dict): void {
  if (r.inscrit === null || ev["type"] !== "task_step" || ev["status"] === "final") return;
  const d = r.progres.detail;
  const st = ev["status"];
  if (st === "running" || st === "done" || st === "error") {
    for (const c of ["step", "max_steps"] as const) if (typeof ev[c] === "number") d[c] = ev[c];
    if (typeof ev["calls"] === "number") d["tool_calls"] = ev["calls"];
    if (typeof ev["tool"] === "string") d["last_tool"] = ev["tool"];
  } else if (st === "text" && typeof ev["text"] === "string")
    d["last_text"] = prefixePy(masquerSecretsTexte(ev["text"]).texte, 400);
  else if (st === "tick" && ev["started"] === true) {
    d["started_at"] = r.t0;
    d["queued_s"] = attenteAuMoteur(r);
  }
  const envoyer = (): void => {
    r.progres.minuterie = null;
    r.progres.envoyeMs = Date.now();
    const port = tachesFond();
    const e = FOND.get(r.k);
    const userId = r.t.o.userId;
    if (port === null || r.inscrit === null || !e?.actif || !userId) return;
    const ligne = typeof d["last_tool"] === "string" ? `étape ${d["step"] ?? "?"} · ${d["last_tool"]}` : "";
    void port.progresser(userId, r.inscrit.jobId, e.lire(), ligne).catch(() => undefined);
  };
  const attente = 3000 - (Date.now() - r.progres.envoyeMs);
  if (attente <= 0) envoyer();
  else if (r.progres.minuterie === null) {
    r.progres.minuterie = setTimeout(envoyer, attente);
    r.progres.minuterie.unref();
  }
}

/** Événements d'un enfant en fond : à sa progression, et au tour qui l'a lancé tant qu'il tourne (une erreur de ce flux ne touche pas l'enfant). */
export function relaisEnFond(r: RunEnfant): SurEvenement {
  const o = r.t.o;
  return async (ev: Dict) => {
    suivreFond(r, ev);
    const port = tachesFond();
    if (!o.onEvent || r.inscrit === null || port === null || !o.userId || !o.chatId) return;
    if (!port.tourActif(o.userId, o.chatId, r.inscrit.runId)) return;
    try {
      await o.onEvent(ev);
    } catch (e) {
      log.debug(`[task_tool] étape de ${r.childId} non relayée au tour parent (${String(e)})`);
    }
  };
}

/** Refus d'une inscription en fond, rendu au modèle par `task`. */
export interface RefusFond {
  code: string;
  message: string;
  fix: string;
}

/** Entrée du run en fond dans l'usage du tour (complétée à sa fin). */
function entreeUsage(r: RunEnfant, jobId: string): Dict {
  return {
    id: r.childId,
    agent: r.agentType,
    label: r.description,
    prompt: longueurPy(r.prompt) <= 2000 ? r.prompt : prefixePy(r.prompt, 2000) + "…",
    result: "",
    state: "running",
    background: true,
    job_id: jobId,
    steps_total: 0,
    context_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    think_tokens: 0,
    duration_ms: 0,
    transcript: [],
    depth: 0,
    resumed: r.resumed !== null,
  };
}

/** Inscription d'un enfant en fond parmi les jobs (place du compte : slots de llama.cpp ; conversation enregistrée et tour exigés) : un refus, ou `null` une fois inscrit. */
export async function inscrireFond(r: RunEnfant): Promise<RefusFond | null> {
  const o = r.t.o;
  const port = tachesFond();
  if (port === null || !o.userId || !o.chatId)
    return {
      code: "not_available_here",
      message:
        "background sub-agents need a saved conversation with an active top-level turn (not a routine or webhook)",
      fix: "run the agent without background=true",
    };
  const max = await plafondParSlots(Number.MAX_SAFE_INTEGER);
  const actifs = enfantsEnFondActifs(o.username);
  if (actifs >= max)
    return {
      code: "background_limit",
      message: `${actifs} background sub-agents already run for this account (limit ${max})`,
      fix: "wait for one to end (task_wait), stop one, or run this agent without background=true",
    };
  const detail: Dict = {
    child_id: r.childId,
    agent: r.agentType,
    call_id: r.callId ?? "",
    label: r.description,
    state: "running",
  };
  const ins = await port.inscrire(o.userId, o.chatId, {
    callId: r.callId ?? "",
    label: `${r.agentType} — ${r.description}`,
    max,
    detail,
  });
  if (!ins.ok) return { code: ins.error, message: ins.message, fix: ins.fix };
  if (ACTIFS.has(r.k)) {
    const message = `agent '${r.childId}' is still running`;
    await port.terminer(o.userId, ins.jobId, {
      etat: "killed",
      declencheur: "killed",
      taskId: r.childId,
      agent: r.agentType,
      enveloppe: pyJsonDumps(err("task_busy", message)),
      detail: { ...detail, state: "cancelled" },
      resume: "refusé : agent déjà en cours",
      dureeS: 0,
    });
    return { code: "task_busy", message, fix: "wait for its result or start a fresh agent" };
  }
  r.inscrit = { jobId: ins.jobId, runId: ins.runId, entree: null };
  r.progres.detail = { ...detail };
  const fin = new Promise<void>((ok) => (r.finFond = ok));
  retenirFond(r.k, {
    uid: o.userId,
    username: o.username,
    chatId: o.chatId,
    jobId: ins.jobId,
    taskId: r.childId,
    agent: r.agentType,
    label: r.description,
    debut: r.debutS,
    actif: true,
    lire: () => ({ ...r.progres.detail, ...champsConso(r.conso), context_tokens: r.tok.v }),
    boite: r.boite,
    conclusion: r.conclusion,
    recent: () => r.recents.map((x) => ({ tool: x["tool"], args: x["args"], status: x["status"] })),
    fin,
  });
  const sink = o.usageSink;
  if (sink) {
    if (!Array.isArray(sink["runs"])) sink["runs"] = [];
    r.inscrit.entree = entreeUsage(r, ins.jobId);
    (sink["runs"] as Dict[]).push(r.inscrit.entree);
  }
  return null;
}

/** Fin d'un enfant en fond : détail final (état, statut, consommation, bloc du harnais, début du rapport) et enveloppe de `task` inscrits parmi les événements de son job. */
async function terminerFond(r: RunEnfant, jobId: string, out: string): Promise<void> {
  if (r.progres.minuterie !== null) clearTimeout(r.progres.minuterie);
  SLOTS_FOND.delete(r.k);
  const tue = r.etat === "cancelled";
  const dureeS = Math.round(duree(r) * 10) / 10;
  const bilan = r.bilanFinal;
  const detail: Dict = {
    ...r.progres.detail,
    ...consoFinale(r.childMetrics, r.conso),
    context_tokens: r.tok.v,
    state: r.etat,
    ...(bilan ? { status: bilan.status, harness: bilan } : {}),
    duration_s: dureeS,
    queued_s: attenteAuMoteur(r),
    result: prefixePy(masquerSecretsTexte(r.finalText || "").texte, 2000),
  };
  const enFond = FOND.get(r.k);
  if (enFond) {
    const recents = enFond.recent();
    enFond.actif = false;
    enFond.lire = () => detail;
    enFond.recent = () => recents;
  }
  const port = tachesFond();
  const userId = r.t.o.userId;
  if (port === null || !userId) return;
  try {
    await port.terminer(userId, jobId, {
      etat: tue ? "killed" : "exited",
      declencheur: tue ? "killed" : "exit",
      taskId: r.childId,
      agent: r.agentType,
      enveloppe: out,
      detail,
      resume: `${r.etat}${bilan ? ` — ${bilan.status}` : ""}`,
      dureeS,
    });
  } catch (e) {
    log.warn(`[task_tool] fin du sous-agent en fond ${r.childId} non inscrite (${String(e)})`);
  }
}

/** Détache le run d'un enfant inscrit en fond (`executer`) et rend tout de suite son `task_id` ; sa fin est inscrite parmi les événements de son job. */
export function lancerEnFond(r: RunEnfant, executer: () => Promise<string>): string {
  const lance = r.inscrit!;
  const enFond = FOND.get(r.k);
  traceEnFond(r.t.o.username, r.childId);
  void executer()
    .catch((e: unknown) => {
      log.warn(`[task_tool] sous-agent en fond '${r.agentType}' ${r.childId} en échec : ${String(e)}`);
      r.etat = "failed";
      return pyJsonDumps(err("task_failed", prefixePy(String(e), 300), { task_id: r.childId }));
    })
    .then((out) => terminerFond(r, lance.jobId, out))
    .finally(() => {
      if (enFond) enFond.actif = false;
      r.finFond();
    });
  return pyJsonDumps({
    ok: true,
    task_id: r.childId,
    job_id: lance.jobId,
    state: "running",
    background: true,
    agent: r.agentType,
    message:
      `Sub-agent '${r.agentType}' started in the background; this turn goes on. Its report will be delivered ` +
      "automatically as a job event: with a later tool result while this turn runs, otherwise in a new message " +
      "that wakes this conversation. Do not poll: call task_status(task_id) only to look at its progress, and " +
      "task_wait(task_id, timeout_s) when you cannot go on without its report. Stopping this turn does not stop it.",
  });
}
