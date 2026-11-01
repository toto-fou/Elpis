// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/conclusion.ts — conclusion d'un enfant : bloc du harnais (statut corrigé, branche relue, rapport masqué, plafonné et sauvé s'il déborde) et enveloppe rendue au modèle selon son état. */
import { estErreurAnnulation, longueurPy, pyJsonDumps } from "@elpis/commun";
import { toContainer } from "@elpis/securite";

import type { Dict } from "../../../python";
import { err } from "../../erreur-outil";
import { noteDebord, preparerRapport, rendreTache } from "./bilan";
import type { Bilan, Statut } from "./bilan";
import { finTrace } from "./concurrence";
import { LEGENDE_TASK_META } from "./definition";
import { attenteAuMoteur, bilanDe, duree } from "./enfant";
import type { RunEnfant } from "./enfant";
import { estLeDernier } from "./registre";
import { aEchange, avecReprise, enregistrement, memoriserReprise, travailCourant } from "./reprise";
import { statutDeclare, travailRestant, verdictDeclare } from "./statut";
import { prendreLegende } from "./tour";

/** Branche du dépôt relue après un outil git ou le shell (le modèle a pu en changer). */
async function relireBranche(r: RunEnfant): Promise<void> {
  const depot = r.suivi.depotARelire();
  if (!r.suivi.gitOuShell || depot === null || r.etat === "cancelled" || r.signalTour?.aborted) return;
  let relue: string | null;
  try {
    relue = await r.t.hote.brancheCourante({ ...r.compte, repo: depot });
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    relue = null;
  }
  if (relue) r.suivi.branche = relue;
}

/** Rapport masqué et plafonné ; le texte complet sauvé dans le bac s'il déborde. */
async function rapportRendu(
  r: RunEnfant,
): Promise<{ rapport: string; complet: string; masques: number; sauve: string | null }> {
  const prepare = preparerRapport(r.finalText || "");
  let rapport = prepare.rendu;
  let sauve: string | null = null;
  if (prepare.deborde) {
    const rel = `.tool-output/task-${r.childId}.md`;
    let fait: boolean;
    try {
      fait = await r.t.hote.sauverRapport({ ...r.compte, chemin: rel, texte: prepare.complet });
    } catch (e) {
      if (estErreurAnnulation(e)) throw e;
      fait = false;
    }
    sauve = fait ? toContainer(rel) : null;
    rapport += noteDebord(longueurPy(prepare.complet), sauve);
  }
  return { rapport, complet: prepare.complet, masques: prepare.masques, sauve };
}

/** Bloc du harnais une fois l'enfant terminé (rapport masqué, plafonné et sauvé dans le bac s'il déborde) ; limite atteinte avec un rapport complet (`Status: done`, rien sous « Left open ») : terminé, la limite reste dans `stop_reason`. */
export async function conclure(r: RunEnfant): Promise<{ bilan: Bilan; rapport: string }> {
  const concurrent = estLeDernier(r.k, r.arret) && finTrace(r.t.o.username, r.childId);
  await relireBranche(r);
  const { rapport, complet, masques, sauve } = await rapportRendu(r);
  if (
    r.etat === "incomplete" &&
    r.finalText &&
    statutDeclare(r.finalText) === "done" &&
    travailRestant(complet) === null
  ) {
    r.etat = "completed";
    r.statut = "done";
  }
  if (r.statut === "done") r.statut = statutDeclare(r.finalText);
  if (r.statut === "partial" && r.etat === "completed" && r.finDeBudgetAnnoncee && r.stopReason === null)
    r.stopReason = "budget_wrap_up";
  const reste = r.statut !== "done" ? travailRestant(complet) : null;
  const verdict = r.agentType === "verify" ? verdictDeclare(r.finalText) : null;
  const bilan = bilanDe(r, {
    status: r.statut,
    ...(r.stopReason ? { stop_reason: r.stopReason } : {}),
    tool_calls: r.appelsVus,
    tool_calls_total: r.appelsAvant + r.appelsVus,
    ...(r.avertissements.length ? { budget_warnings: [...r.avertissements] } : {}),
    iterations: r.iters.n,
    duration_s: Math.round(duree(r) * 10) / 10,
    queued_s: attenteAuMoteur(r),
    files_changed: r.suivi.fichiersModifies(),
    ...(concurrent ? { concurrent: true as const } : {}),
    git: r.suivi.git(),
    errors: r.suivi.erreurs,
    ...(reste ? { remaining_work: reste } : {}),
    ...(verdict ? { verdict } : {}),
    report_chars: longueurPy(complet),
    ...(sauve ? { report_saved_to: sauve } : {}),
    ...(masques ? { secrets_masked: masques } : {}),
  });
  return { bilan, rapport };
}

/** Bilan lu maintenant, sans attendre la fin de l'enfant (ni relecture de la branche ni rapport) : ce que ses outils ont déjà fait. */
function bilanInstantane(r: RunEnfant, status: Statut): Bilan {
  return bilanDe(r, {
    status,
    tool_calls: r.appelsVus,
    tool_calls_total: r.appelsAvant + r.appelsVus,
    iterations: r.iters.n,
    duration_s: Math.round(duree(r) * 10) / 10,
    queued_s: attenteAuMoteur(r),
    files_changed: r.suivi.fichiersModifies(),
    git: r.suivi.git(),
    errors: r.suivi.erreurs,
  });
}

/** Enveloppe `task_cancelled` : `task_id` à reprendre si l'enfant a de quoi l'être ; `tourArrete` : le tour entier a été arrêté (Stop), sinon cet agent seul. */
function enveloppeAnnulee(r: RunEnfant, bilan: Bilan, reprenable: boolean, tourArrete: boolean): string {
  return pyJsonDumps(
    err("task_cancelled", `sub-agent '${r.agentType}' was cancelled by the user`, {
      nextAction:
        tourArrete && reprenable
          ? "the user stopped the turn: to finish this work, pass task_id to resume this agent from its partial work (its last action may be unconfirmed, check the state first); otherwise continue without its report"
          : "continue the turn without this sub-agent's report, or ask the user how to proceed",
      ...(reprenable ? { task_id: r.childId } : {}),
      harness: bilan,
    }),
  );
}

/** Résultat de l'appel si le tour parent est annulé pendant l'enfant : `task_cancelled` avec son `task_id`, déposé dans le lot partiel avant que l'annulation ne remonte, et l'état repris déjà en mémoire ; `null` si l'enfant n'a encore rien à reprendre. */
export function rendreSiTourAnnule(r: RunEnfant): string | null {
  const lu = travailCourant(r);
  const obtenu = lu !== null && aEchange(r, lu);
  if (r.resumed === null && !obtenu) return null;
  if (obtenu && estLeDernier(r.k, r.arret))
    memoriserReprise(r.t.o.username, r.childId, enregistrement(r, lu, true));
  return enveloppeAnnulee(r, bilanInstantane(r, "cancelled"), true, true);
}

/** Enveloppe rendue au modèle selon l'état final de l'enfant ; la légende du bloc en tête du premier de la conversation (jamais persistée). */
export function enveloppeFinale(r: RunEnfant, bilan: Bilan, rapport: string): string {
  const meta = prendreLegende(r.t) ? { legend: LEGENDE_TASK_META, ...bilan } : bilan;
  const reprise = (suite: string): Dict => (avecReprise(r) ? { task_id: r.childId, nextAction: suite } : {});
  const { agentType, dureeMax, etat, stopReason, finalText, erreurMessage } = r;
  if (etat === "completed") return rendreTache(r.childId, "completed", meta, rapport);
  if (etat === "incomplete")
    return pyJsonDumps(
      err(
        "task_incomplete",
        stopReason === "wrap_up"
          ? `sub-agent '${agentType}' concluded at your request (task_send wrap_up); its work is unfinished`
          : `sub-agent '${agentType}' stopped before finishing (harness limit: ${stopReason}); its work is unfinished` +
              (stopReason === "wallclock"
                ? `; the ${dureeMax}s limit counts from the task call, queue time included (queued_s)`
                : ""),
        {
          stop_reason: stopReason,
          ...reprise("pass task_id to resume this agent from its partial work, with a narrower brief"),
          ...(finalText ? { partial_report: rapport } : {}),
          harness: meta,
        },
      ),
    );
  if (etat === "timeout")
    return pyJsonDumps(
      err(
        "task_timeout",
        `sub-agent '${agentType}' exceeded ${dureeMax}s before its final report was complete; the limit counts ` +
          "from the task call, queue time included (queued_s)",
        {
          fix: "read partial_report, then split the mission into smaller, more targeted tasks",
          ...reprise("pass task_id to resume this agent from its partial work, with a narrower brief"),
          partial_report: rapport,
          harness: meta,
        },
      ),
    );
  if (etat === "cancelled") return enveloppeAnnulee(r, meta, avecReprise(r), false);
  return pyJsonDumps(
    err(
      "task_failed",
      erreurMessage || `sub-agent '${agentType}' stopped on a model error before finishing`,
      {
        retryable: true,
        ...(avecReprise(r)
          ? {
              task_id: r.childId,
              ...(erreurMessage
                ? {}
                : { nextAction: "pass task_id to resume this agent from its partial work" }),
            }
          : {}),
        ...(finalText ? { partial_report: rapport } : {}),
        harness: meta,
      },
    ),
  );
}
