// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/execution.ts — le run d'un enfant, de sa boucle (file du moteur, délai dur) à son enveloppe : issue lue sur ses métriques ou son exception, navigateur privé fermé, usage du tour, état repris. */
import {
  CancelledError,
  estErreurAnnulation,
  intPy,
  longueurPy,
  prefixePy,
  strPy,
  stripPy,
  texteOu,
} from "@elpis/commun";
import { masquerSecretsTexte } from "@elpis/securite";

import type { OptionsRun } from "../../../boucle/orchestrateur";
import { dansPorteeExecution, fileLlm } from "../../../boucle/ports";
import type { SortieRun } from "../../../boucle/sortie";
import { journal } from "../../../journal";
import { TASK_RESULT_PERSIST_CAP } from "../../../llm/constantes";
import { currentEngine } from "../../../llm/moteurs";
import type { Dict } from "../../../python";
import { BUDGET_WARNINGS_MAX, texteAvertissement } from "./bilan";
import type { Bilan } from "./bilan";
import { CONSIGNE_CLOTURE } from "./brief";
import { conclure, enveloppeFinale } from "./conclusion";
import { duree, enfantAnnule } from "./enfant";
import type { RunEnfant } from "./enfant";
import { rapportCoupe, rapportDeGarde } from "./echeances";
import {
  consoFinale,
  demarrer,
  emitFinalStep,
  flushChat,
  recevoirParent,
  surEvenementEnfant,
  surUsage,
} from "./evenements";
import { SLOTS_FOND } from "./fond";
import { ACTIFS, ANNULES, estLeDernier } from "./registre";
import { avecReprise, clorePoints, storeResumeState } from "./reprise";
import { slotsAEviter } from "./tour";

const log = journal("outils.taches-agents");

/** Attente au plus de la fermeture du navigateur privé d'un enfant : le run ne dépend pas d'un hôte qui ne répond pas. */
const DELAI_FERMETURE_NAVIGATEUR_S = 20;

/** Options de la boucle de l'enfant (`runChatMultiMcp`) sur le slot `slot`. */
function optionsBoucle(r: RunEnfant, signal: AbortSignal, slot: OptionsRun["slot"]): OptionsRun {
  const { t } = r;
  const o = t.o;
  return {
    messages: r.childMessages,
    mcpConfigs: r.childMcpConfigs,
    onEvent: (ev) => surEvenementEnfant(r, ev),
    username: o.username,
    model: o.model,
    builtinTools: null,
    isCancelled: () => enfantAnnule(r, ANNULES),
    signal,
    chatId: r.childChatId,
    slotKey: r.slotKey,
    slotAvoid: () => slotsAEviter(t, r.childId),
    slotPrefere: () => {
      const dernier = t.slotsEnfants.get(r.childId) ?? null;
      return dernier !== null && dernier !== (o.slotParent?.() ?? null) ? dernier : null;
    },
    surSlot: (s) => {
      t.slotsEnfants.set(r.childId, s);
      if (r.fond) SLOTS_FOND.set(r.k, { username: o.username, slot: s });
    },
    samplingOverride: r.childSampling,
    thinkingMode: r.reflexion,
    allowedToolNames: r.childAllowed,
    memoryEnabled: false,
    denyToolNames: r.childDeny,
    priority: r.prioriteRun,
    userId: o.userId ?? null,
    slot: slot ?? null,
    subagent: r.saRun,
    surUsage: (u) => surUsage(r, u),
    echeanceMs: r.echeanceSoupleMs,
    wrapupSuffix: CONSIGNE_CLOTURE,
    canal: r.fond ? { recevoir: () => recevoirParent(r), conclure: r.conclusion.signal } : null,
    surTexteSynthese: (delta) => {
      if (longueurPy(r.texteSynthese) < 24_000) r.texteSynthese += delta;
    },
    exposerTravail: (lire) => {
      r.lireTravail = lire;
    },
    surPointEtape: ({ texte, finDeBudget }) => {
      if (r.avertissements.length < BUDGET_WARNINGS_MAX)
        r.avertissements.push({ at: r.appelsVus, text: texteAvertissement(texte) });
      if (finDeBudget) r.finDeBudgetAnnoncee = true;
    },
  };
}

/** Boucle de l'enfant dans la file du moteur (portée d'exécution `subagent`) ; état et statut lus sur ses métriques. */
async function boucler(r: RunEnfant, signal: AbortSignal): Promise<void> {
  const o = r.t.o;
  const boucle = (slot: OptionsRun["slot"]): Promise<SortieRun> => {
    demarrer(r);
    return r.t.runner(optionsBoucle(r, signal, slot));
  };
  const file = fileLlm();
  [r.finalText, , r.childMetrics] = await dansPorteeExecution(
    {
      genre: "subagent",
      userId: o.userId ?? null,
      chatId: r.childChatId || r.childId,
      model: texteOu(o.model, ""),
      engine: currentEngine().key,
      parentId: texteOu(o.chatId, ""),
    },
    () =>
      file
        ? file.withLLM(o.model, r.prioriteRun, signal, (slot) => boucle(slot), { outils: true })
        : boucle(null),
  );
  const m = r.childMetrics;
  if (r.finalText && m["truncated"] === true)
    r.finalText = rapportCoupe(r.finalText, "report cut by the engine's output limit (max_tokens)");
  if (m["ended_with_error"]) {
    r.etat = "failed";
    r.statut = "error";
  } else if (m["tool_limit_reached"]) {
    r.etat = "incomplete";
    r.stopReason = strPy(m["tool_limit_stop_reason"] || "steps");
    r.statut =
      r.stopReason === "steps" || r.stopReason === "hard"
        ? "budget_exhausted"
        : r.stopReason === "wallclock"
          ? "timeout"
          : "partial";
  }
}

/** Délai dur dépassé : la synthèse en cours coupée, sinon le rapport de garde assemblé depuis le travail observé. */
function issueDelaiDur(r: RunEnfant): void {
  r.etat = "timeout";
  r.statut = "timeout";
  r.stopReason = "wallclock_hard";
  const synthese = stripPy(r.texteSynthese);
  r.finalText = synthese
    ? rapportCoupe(synthese, `report cut by the harness at the ${r.dureeMax} s time limit`)
    : rapportDeGarde({
        dureeMaxS: r.dureeMax,
        narration: stripPy(r.tampon) || r.dernierTexte,
        appels: r.transcript,
        appelsTotal: r.appelsVus,
        enVol: [...new Set(r.debutsAppels.values())],
        fichiers: r.suivi.fichiersModifies(),
        taskId: avecReprise(r) ? r.childId : null,
      });
}

/** Retire l'enfant des runs actifs, si c'est bien ce run qui y est inscrit. */
function retirerActif(r: RunEnfant): void {
  if (ACTIFS.get(r.k)?.arret === r.arret) {
    ACTIFS.delete(r.k);
    ANNULES.delete(r.k);
  }
}

/** Étape finale de l'enfant vers l'interface (`result` : début du rapport, sauf annulation du tour). */
async function etapeFinale(r: RunEnfant, bilan: Bilan, result?: string): Promise<void> {
  await emitFinalStep(r.relais, r.childId, r.agentType, r.etat, r.appelsVus, r.childMetrics, duree(r), {
    callId: r.callId,
    contextTokens: r.tok.v,
    conso: r.conso,
    transcript: r.chat,
    ...(result === undefined ? {} : { result }),
    harness: bilan,
  });
}

/** Usage du tour : compteurs de jetons, run inscrit dans `usageSink` (ou sa place réservée en fond complétée). */
function recordRun(r: RunEnfant, bilan: Bilan): void {
  const compte = r.t.compte;
  const c = consoFinale(r.childMetrics, r.conso);
  const [entree, sortie] = [c.input_tokens, c.output_tokens];
  compte.horsMetriques += Math.max(0, (compte.enCours.get(r.childId) ?? 0) - entree - sortie);
  compte.enCours.delete(r.childId);
  compte.jetons += entree + sortie;
  const sink = r.t.o.usageSink;
  if (!sink) return;
  sink["tasks"] = intPy(sink["tasks"] || 0) + 1;
  sink["input_tokens"] = intPy(sink["input_tokens"] || 0) + entree;
  sink["output_tokens"] = intPy(sink["output_tokens"] || 0) + sortie;
  if (!Array.isArray(sink["runs"])) sink["runs"] = [];
  const run: Dict = {
    id: r.childId,
    agent: r.agentType,
    label: r.description,
    prompt: longueurPy(r.prompt) <= 2000 ? r.prompt : prefixePy(r.prompt, 2000) + "…",
    result: prefixePy(masquerSecretsTexte(r.finalText || "").texte, TASK_RESULT_PERSIST_CAP),
    state: r.etat,
    steps_total: r.appelsVus,
    context_tokens: r.tok.v,
    ...c,
    duration_ms: Math.trunc(duree(r) * 1000),
    tools: r.transcript,
    transcript: r.chat,
    depth: 0,
    resumed: r.resumed !== null,
    harness: bilan,
  };
  const place = r.inscrit?.entree ?? null;
  if (place !== null) Object.assign(place, run);
  else (sink["runs"] as Dict[]).push(run);
}

/** Session de navigateur privée de l'enfant fermée à la fin du run, quel qu'en soit l'état ; jamais celle du compte, jamais d'échec. */
async function fermerNavigateur(r: RunEnfant): Promise<void> {
  if (r.sessionNavigateur !== "isolated" || !r.navigateurUtilise || !estLeDernier(r.k, r.arret)) return;
  try {
    const delai = new Promise<false>((fin) =>
      setTimeout(() => fin(false), DELAI_FERMETURE_NAVIGATEUR_S * 1000).unref(),
    );
    if (
      !(await Promise.race([
        r.t.hote.fermerNavigateur({ ...r.compte, signal: undefined, enfant: r.saRun }),
        delai,
      ]))
    )
      log.warn(`[task_tool] navigateur privé de ${r.childId} non confirmé fermé (le service le ramassera)`);
  } catch (e) {
    log.warn(`[task_tool] navigateur privé de ${r.childId} non fermé (${String(e)})`);
  }
}

/** Le run de l'enfant, de sa boucle à son enveloppe : attendu par l'appel `task`, ou détaché en fond. */
export async function executer(r: RunEnfant): Promise<string> {
  const signal = r.signalTour ? AbortSignal.any([r.signalTour, r.arret.signal]) : r.arret.signal;
  let delaiDepasse = false;
  const minuterie = setTimeout(
    () => {
      delaiDepasse = true;
      r.arret.abort(new CancelledError("sub-agent timeout"));
    },
    Math.ceil(Math.max(0, r.echeanceDureMs - performance.now()) / 1000) * 1000,
  );
  minuterie.unref();
  try {
    await boucler(r, signal);
  } catch (e) {
    clorePoints(r);
    if (delaiDepasse) issueDelaiDur(r);
    else if (estErreurAnnulation(e) || signal.aborted) {
      r.etat = "cancelled";
      r.statut = "cancelled";
      const enfantSeul = ANNULES.has(r.k) && !(r.tourAnnule && r.tourAnnule()) && !r.signalTour?.aborted;
      if (!enfantSeul) {
        clearTimeout(minuterie);
        retirerActif(r);
        const { bilan } = await conclure(r);
        await flushChat(r, false);
        await etapeFinale(r, bilan);
        await storeResumeState(r);
        recordRun(r, bilan);
        throw e;
      }
    } else {
      r.etat = "failed";
      r.statut = "error";
      r.erreurMessage = prefixePy(e instanceof Error ? e.message : strPy(e), 300);
      log.warn(`[task_tool] sous-agent '${r.agentType}' échoué : ${String(e)}`);
    }
  } finally {
    clearTimeout(minuterie);
    clorePoints(r);
    r.t.slotsEnfants.delete(r.childId);
    retirerActif(r);
    await fermerNavigateur(r);
  }
  const { bilan, rapport } = await conclure(r);
  const out = enveloppeFinale(r, bilan, rapport);
  await flushChat(r, false, r.finalText || "");
  await etapeFinale(
    r,
    bilan,
    prefixePy(masquerSecretsTexte(r.finalText || "").texte, TASK_RESULT_PERSIST_CAP),
  );
  await storeResumeState(r);
  recordRun(r, bilan);
  r.bilanFinal = bilan;
  return out;
}
