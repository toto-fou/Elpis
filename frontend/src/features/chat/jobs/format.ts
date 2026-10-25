// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/jobs/format.ts — libellés français des tâches de fond : durée, état et issue (code de sortie), déclencheurs, résumé d'un réveil. */
import type { DeclencheurJob, EtatJob, EvenementReveil, ResumeJob, ResumeReveil } from "@elpis/contracts";

const ETATS: Readonly<Record<EtatJob, string>> = {
  starting: "démarrage",
  running: "en cours",
  exited: "terminé",
  killed: "arrêté",
  lost: "perdu",
  failed: "échec du lancement",
};

const DECLENCHEURS: Readonly<Record<DeclencheurJob, string>> = {
  exit: "terminé",
  match: "motif trouvé",
  regex: "motif trouvé",
  port: "port ouvert",
  file: "fichier modifié",
  idle: "plus de sortie",
  timeout: "délai écoulé",
  lost: "tâche perdue",
  killed: "arrêtée",
  max_runtime: "durée maximale atteinte",
};

export const libelleEtat = (etat: EtatJob): string => ETATS[etat];

export const jobActif = (j: Pick<ResumeJob, "state">): boolean =>
  j.state === "starting" || j.state === "running";

export type IssueJob = "actif" | "reussi" | "echec" | "arrete" | "perdu";

/** Issue d'un job : une sortie en code ≠ 0 ou par signal est un échec, pas une fin normale. */
export function issueJob(j: Pick<ResumeJob, "state" | "exit_code" | "signal">): IssueJob {
  if (jobActif(j)) return "actif";
  if (j.state === "exited") return j.exit_code === 0 && !j.signal ? "reussi" : "echec";
  if (j.state === "killed") return "arrete";
  return j.state === "lost" ? "perdu" : "echec";
}

/** « terminé », « échec, code 1 », « échec (SIGSEGV) », « arrêté »… */
export function libelleJob(j: Pick<ResumeJob, "state" | "exit_code" | "signal">): string {
  if (j.state !== "exited" || issueJob(j) === "reussi") return ETATS[j.state];
  if (j.signal) return `échec (${j.signal})`;
  return j.exit_code == null ? "échec" : `échec, code ${j.exit_code}`;
}

/** « 10 min 03 s », « 42 s », « 1 h 02 min » ; vide si la durée est inconnue. */
export function dureeFr(secondes: number | null | undefined): string {
  if (secondes == null || !Number.isFinite(secondes) || secondes < 0) return "";
  const s = Math.floor(secondes);
  if (s < 60) return `${s} s`;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)} min ${pad(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))} min`;
}

/** Durée d'un job : écoulée depuis le départ s'il tourne, sinon totale. */
export function dureeJob(j: ResumeJob, maintenantS: number): string {
  if (j.started_at == null) return "";
  return dureeFr((j.ended_at ?? maintenantS) - j.started_at);
}

/** Déclencheur armé en français : « exit » devient « fin du programme ». */
export function libelleArme(entree: string): string {
  const [type = "", ...reste] = entree.split(":");
  const arg = reste.join(":");
  switch (type) {
    case "exit":
      return "fin du programme";
    case "match":
      return `texte « ${arg} »`;
    case "regex":
      return `motif /${arg}/`;
    case "port":
      return `port ${arg}`;
    case "file":
      return `fichier ${arg}`;
    case "idle":
      return `silence ${arg} s`;
    case "timeout":
      return `après ${arg} s`;
    default:
      return entree;
  }
}

function texteEvenement(ev: EvenementReveil): string {
  let quoi = DECLENCHEURS[ev.trigger];
  if (ev.trigger === "exit" && ev.state === "exited") {
    quoi = ev.signal ? `terminé (${ev.signal})` : `terminé, code ${ev.exit_code ?? "?"}`;
  }
  const duree = dureeFr(ev.duration_s);
  return `${ev.label} ${quoi}${duree ? ", " + duree : ""}`;
}

/** Ligne du fil : le résumé du core, sinon reconstruit depuis les événements. */
export function resumeReveil(wake: ResumeReveil | null | undefined): string {
  if (!wake) return "Réveil";
  const base = wake.summary.trim() || wake.events.map(texteEvenement).join(" ; ");
  return base ? `Réveil : ${base}` : "Réveil";
}
