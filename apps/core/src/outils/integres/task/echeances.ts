// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/echeances.ts — fin d'un sous-agent à ses échéances : rapport coupé sans mot inachevé, rapport de garde assemblé au délai dur. */
import { stripPy, strPy } from "@elpis/commun";

import type { Dict } from "../../../python";
import type { FichierBilan } from "./bilan";

/** Rapport interrompu en pleine génération (délai dur, limite de sortie du moteur) : le mot inachevé retiré (coupe au dernier blanc), sauf s'il finit déjà une phrase, puis la note du harnais. */
export function rapportCoupe(texte: string, note: string): string {
  const t = texte.replace(/\s+$/u, "");
  if (!t) return t;
  const blanc = /[.!?:;)\]`*|>]$/u.test(t) ? -1 : t.search(/\s\S*$/u);
  return blanc > 0 ? `${t.slice(0, blanc).trimEnd()} …\n\n[${note}]` : `${t}\n\n[${note}]`;
}

/** Rapport partiel d'un enfant arrêté au délai dur sans synthèse, assemblé depuis le travail observé (dernière narration, appels d'outils, fichiers), au format commun des rapports ; textes de l'enfant sur une ligne (aucun titre ni statut imité). */
export function rapportDeGarde(o: {
  dureeMaxS: number;
  narration: string;
  appels: readonly Dict[];
  appelsTotal: number;
  enVol: readonly string[];
  fichiers: readonly FichierBilan[];
  taskId: string | null;
}): string {
  const cause = o.enVol.length
    ? `the tool call ${o.enVol.join(", ")} did not return (running or queued)`
    : "the model did not return its final report (engine stuck or far too slow)";
  const ligne = (t: unknown): string => stripPy(strPy(t ?? "").replace(/\s+/gu, " "));
  const points = Array.from(ligne(o.narration));
  const narration = points.length > 1500 ? "…" + points.slice(-1500).join("") : points.join("");
  const vus = o.appels.slice(-20).map((a) => {
    const etat =
      a["status"] === "running"
        ? "still running or queued when stopped (unconfirmed: it may have acted)"
        : a["status"];
    return `- ${ligne(a["tool"] ?? "?")} ${ligne(a["args_preview"])} → ${ligne(etat)}`;
  });
  const reprise = o.taskId
    ? `resume this agent with task_id="${o.taskId}" and a narrower brief, or hand the rest over.`
    : "start a new agent with a narrower brief, or hand the rest over.";
  return [
    "Status: partial",
    "## Answer",
    `No final answer: the harness stopped this sub-agent at its ${o.dureeMaxS} s time limit because ${cause}. ` +
      "This report is assembled by the harness from the work it observed.",
    "## Evidence",
    `Last note from the agent (unverified): ${narration || "(none)"}`,
    `Tool calls: ${o.appelsTotal}${vus.length < o.appelsTotal ? ` (last ${vus.length} of those recorded shown)` : ""}.`,
    ...vus,
    "## Changes",
    ...(o.fichiers.length
      ? o.fichiers.slice(0, 20).map((f) => `- ${f.path} (${f.change})`)
      : ["none observed"]),
    "## Left open",
    "The mission is unfinished" +
      (o.enVol.length ? `; check the state left by ${o.enVol.join(", ")} before repeating it` : "") +
      `: ${reprise}`,
  ].join("\n");
}

/** Plancher (s) de la réserve : la génération en cours à l'échéance souple (réflexion comprise, sur un moteur modeste), qu'on ne coupe pas, puis la synthèse (un long préremplissage et un rapport de quelques milliers de jetons). */
const MARGE_SYNTHESE_S = 120;
/** Part du délai dur que la réserve atteint au plus pour un long délai (au-delà du plancher). */
const PART_RESERVE = 0.1;
/** Part du délai dur que la réserve ne dépasse jamais (petit `max_seconds`). */
const PART_RESERVE_MAX = 1 / 3;

/** Réserve (s) entre l'échéance souple d'un enfant et son délai dur : `min(⅓ D, max(120 s, D / 10))` ; les appels d'outils sont coupés à l'échéance souple, la réserve n'a donc à contenir qu'une génération et la synthèse. */
export function reserveSouple(dureeMaxS: number): number {
  return Math.min(
    Math.floor(dureeMaxS * PART_RESERVE_MAX),
    Math.max(MARGE_SYNTHESE_S, Math.floor(dureeMaxS * PART_RESERVE)),
  );
}
