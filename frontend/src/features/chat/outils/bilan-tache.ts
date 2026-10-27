// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/bilan-tache.ts — bloc du harnais d'un sous-agent (`harness` de l'étape finale de `task` et du run persisté) : lecture validée et libellés français de la carte. */
import { schemaBilanTache } from "@elpis/contracts";
import type { BilanTache, StatutTache } from "@elpis/contracts";
import { z } from "zod";

import { fmtElapsed } from "../../../utils/utils-purs";

export type { BilanTache };

// Une clé ajoutée plus tard par le core ne fait pas disparaître le bloc.
const schemaLu = z.object(schemaBilanTache.shape);

/** Bloc validé, ou `null` (absent sur les anciens runs, ou illisible). */
export function lireBilanTache(brut: unknown): BilanTache | null {
  if (brut === undefined || brut === null) return null;
  const lu = schemaLu.safeParse(brut);
  return lu.success ? lu.data : null;
}

const LIBELLES_STATUT: Readonly<Record<StatutTache, string>> = {
  done: "terminé",
  partial: "partiel",
  blocked: "bloqué",
  unknown: "statut inconnu",
  budget_exhausted: "budget épuisé",
  timeout: "délai dépassé",
  unavailable: "indisponible",
  error: "erreur",
  cancelled: "annulé",
};

export const libelleStatutTache = (s: StatutTache): string => LIBELLES_STATUT[s];

/** Classe de ton du badge : vert si fini, orange si incomplet, rouge si échec, neutre si annulé. */
export function classeStatutTache(s: StatutTache): "is-ok" | "is-warn" | "is-error" | "is-neutral" {
  if (s === "done") return "is-ok";
  if (s === "error" || s === "unavailable") return "is-error";
  if (s === "cancelled") return "is-neutral";
  return "is-warn";
}

const LIBELLES_ETAT_RUN: Readonly<Record<string, string>> = {
  running: "en cours",
  completed: "terminé",
  incomplete: "inachevé",
  timeout: "délai dépassé",
  failed: "échec",
  cancelled: "annulé",
};

/** État d'un run de sous-agent en français ; un état inconnu reste tel quel. */
export const libelleEtatRun = (s: string | undefined): string => (s ? (LIBELLES_ETAT_RUN[s] ?? s) : "");

/** Statut du harnais d'un run terminé qui n'est pas une réussite déclarée (partiel, bloqué, inconnu) ; `null` sinon. */
export function statutReserve(run: { state?: string; harness?: BilanTache | null }): StatutTache | null {
  const s = run.harness?.status;
  return run.state === "completed" && (s === "partial" || s === "blocked" || s === "unknown") ? s : null;
}

/** Signe d'un run fini : réussite, échec, incomplet ou arrêt (seul le signe porte la couleur) ; terminé sans réussite déclarée (`statut`), il reste incomplet. */
export function signeEtatRun(
  s: string | undefined,
  statut: StatutTache | null = null,
): "ok" | "echec" | "incomplet" | "arret" {
  if (s === "completed") return statut === null ? "ok" : "incomplet";
  if (s === "failed" || s === "timeout") return "echec";
  if (s === "cancelled") return "arret";
  return "incomplet";
}

const LIBELLES_SOURCE: Readonly<Record<NonNullable<BilanTache["read_only_source"]>, string>> = {
  admin_forced: "imposée par l'administrateur",
  task: "demandée par l'agent principal",
  user: "réglage du compte",
  admin_default: "défaut de l'administrateur",
};

export function libelleSourceLectureSeule(src: BilanTache["read_only_source"]): string {
  return src ? LIBELLES_SOURCE[src] : "";
}

const LIBELLES_ARRET: Readonly<Record<string, string>> = {
  steps: "budget d'appels atteint",
  hard: "trop d'appels en échec",
  wallclock: "budget de temps atteint",
  wallclock_hard: "délai dépassé, agent interrompu",
  ctx_saturated: "contexte saturé",
  gen_cap: "plafond de génération atteint",
  cycle: "appels répétés en boucle",
  empty_choices: "réponse vide du moteur",
  budget_wrap_up: "arrêt sur budget : conclu après l'avertissement de fin de budget",
};

/** Cause d'arrêt en français ; une cause inconnue reste telle quelle. */
export const libelleArretTache = (r: string): string => LIBELLES_ARRET[r] ?? r;

/** « réflexion » de la carte : des jetons de réflexion mesurés (> 0) quand le run porte la mesure, sinon la réflexion demandée au lancement (anciens runs). */
export function aReflechi(run: { think_tokens?: number | null }, b: BilanTache): boolean {
  return typeof run.think_tokens === "number" ? run.think_tokens > 0 : b.thinking === true;
}

/** Mention compacte de la ligne : l'agent a conclu de lui-même sur l'avertissement de fin de budget. */
export const arretSurBudget = (b: BilanTache): boolean => b.stop_reason === "budget_wrap_up";

/** « 95/100 » ; le cumul des reprises par `task_id` est rappelé à part par l'appelant. */
export const fmtAppelsTache = (b: BilanTache): string => `${b.tool_calls}/${b.tool_budget}`;

export const fmtDureeTache = (b: BilanTache): string => fmtElapsed(b.duration_s);

const LIBELLES_CHANGEMENT: Readonly<Record<string, string>> = {
  created: "créé",
  modified: "modifié",
  deleted: "supprimé",
  moved: "déplacé",
};

export const libelleChangement = (c: string): string => LIBELLES_CHANGEMENT[c] ?? c;

/** Résumé du bouton de détails : fichiers sûrs, fichiers à l'auteur incertain et commits comptés ; vide s'il n'y a rien. */
export function resumeDetailsTache(b: BilanTache): string {
  const parts: string[] = [];
  const nf = b.files_changed.length;
  const ni = b.files_changed_candidates?.length ?? 0;
  const nc = b.git.commits.length;
  if (nf) parts.push(`${nf} fichier${nf > 1 ? "s" : ""}`);
  if (ni) parts.push(`${ni} incertain${ni > 1 ? "s" : ""}`);
  if (nc) parts.push(`${nc} commit${nc > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

/** Vrai si le panneau de détails a quelque chose à montrer en plus de la ligne. */
export function detailsTache(b: BilanTache): boolean {
  return !!(
    b.files_changed.length ||
    b.files_changed_candidates?.length ||
    b.git.branch ||
    b.git.commits.length ||
    b.git.pr_url ||
    b.read_only ||
    b.allow_submit ||
    b.browser_session === "user" ||
    b.writable_paths?.length ||
    b.remaining_work ||
    b.missing_fields?.length ||
    b.reason ||
    b.stop_reason ||
    b.budget_warnings?.length ||
    b.resumed ||
    b.errors ||
    b.report_saved_to ||
    b.secrets_masked
  );
}
