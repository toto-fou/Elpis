// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/bilan-tache.ts — bloc du harnais d'un sous-agent (`harness` de l'étape finale de `task` et du run persisté) : lecture validée et libellés français de la carte. */
import { schemaBilanTache } from "@elpis/contracts";
import type { BilanTache, StatutTache, VerdictTache } from "@elpis/contracts";
import { z } from "zod";

import { fmtElapsed } from "../../../utils/utils-purs";

export type { BilanTache };

// Une clé ajoutée plus tard par le core, ou retirée depuis (`git.pr_url` des anciens runs), ne fait pas disparaître le bloc.
const schemaLu = z.object({ ...schemaBilanTache.shape, git: z.object(schemaBilanTache.shape.git.shape) });

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
  lost: "interrompu par un redémarrage",
};

/** État d'un run de sous-agent en français ; un état inconnu reste tel quel. */
export const libelleEtatRun = (s: string | undefined): string => (s ? (LIBELLES_ETAT_RUN[s] ?? s) : "");

const LIBELLES_VERDICT: Readonly<Record<VerdictTache, string>> = {
  pass: "vérifié",
  fail: "vérification échouée",
  inconclusive: "non concluant",
};

export const libelleVerdictTache = (v: VerdictTache): string => LIBELLES_VERDICT[v];

/** Ton du badge de verdict : vert si la vérification a réussi, rouge si elle a échoué, orange si elle n'a rien établi. */
export function classeVerdictTache(v: VerdictTache): "is-ok" | "is-warn" | "is-error" {
  return v === "pass" ? "is-ok" : v === "fail" ? "is-error" : "is-warn";
}

/** Réserve d'un run terminé : statut non abouti (partiel, bloqué, inconnu) ou verdict `verify` qui n'est pas une réussite. */
export type ReserveRun = "partial" | "blocked" | "unknown" | "verdict_fail" | "verdict_inconclusive";

/** Réserve d'un run terminé sans réussite déclarée (statut, verdict d'un `verify` terminé) ; `null` sinon. */
export function statutReserve(run: { state?: string; harness?: BilanTache | null }): ReserveRun | null {
  if (run.state !== "completed") return null;
  const s = run.harness?.status;
  if (s === "partial" || s === "blocked" || s === "unknown") return s;
  const v = run.harness?.verdict;
  if (v === "fail" || v === "inconclusive") return v === "fail" ? "verdict_fail" : "verdict_inconclusive";
  return null;
}

/** Libellé court d'une réserve (statut du harnais, ou verdict). */
export function libelleReserve(r: ReserveRun): string {
  return r === "verdict_fail"
    ? LIBELLES_VERDICT.fail
    : r === "verdict_inconclusive"
      ? LIBELLES_VERDICT.inconclusive
      : LIBELLES_STATUT[r];
}

/** Signe d'un run fini : réussite, échec, incomplet ou arrêt (seul le signe porte la couleur) ; terminé avec une réserve (`statut`), il reste incomplet. */
export function signeEtatRun(
  s: string | undefined,
  statut: ReserveRun | null = null,
): "ok" | "echec" | "incomplet" | "arret" {
  if (s === "completed") return statut === null ? "ok" : "incomplet";
  if (s === "failed" || s === "timeout") return "echec";
  if (s === "cancelled") return "arret";
  if (s === "lost") return "echec";
  return "incomplet";
}

const LIBELLES_ARRET: Readonly<Record<string, string>> = {
  steps: "budget d'appels atteint",
  hard: "trop d'appels en échec",
  wallclock: "budget de temps atteint",
  wallclock_hard: "délai dépassé, agent interrompu",
  wrap_up: "conclusion demandée par l'agent parent",
  ctx_saturated: "contexte saturé",
  gen_cap: "plafond de génération atteint",
  cycle: "appels répétés en boucle",
  empty_choices: "réponse vide du moteur",
  budget_wrap_up: "arrêt sur budget : conclu après l'avertissement de fin de budget",
};

/** Cause d'arrêt en français ; une cause inconnue reste telle quelle. */
export const libelleArretTache = (r: string): string => LIBELLES_ARRET[r] ?? r;

/** « réflexion » de la carte : des jetons de réflexion mesurés par le moteur (> 0). */
export const aReflechi = (run: { think_tokens?: number | null }): boolean => (run.think_tokens ?? 0) > 0;

/** Mention compacte de la ligne : l'agent a conclu de lui-même sur l'avertissement de fin de budget. */
export const arretSurBudget = (b: BilanTache): boolean => b.stop_reason === "budget_wrap_up";

/** Appels de ce lancement ; le cumul des reprises par `task_id` est rappelé à part par l'appelant. */
export const fmtAppelsTache = (b: BilanTache): string => String(b.tool_calls);

export const fmtDureeTache = (b: BilanTache): string => fmtElapsed(b.duration_s);

const LIBELLES_CHANGEMENT: Readonly<Record<string, string>> = {
  created: "créé",
  modified: "modifié",
  deleted: "supprimé",
  moved: "déplacé",
};

export const libelleChangement = (c: string): string => LIBELLES_CHANGEMENT[c] ?? c;

/** Résumé du bouton de détails : fichiers et commits comptés ; vide s'il n'y a rien. */
export function resumeDetailsTache(b: BilanTache): string {
  const parts: string[] = [];
  const nf = b.files_changed.length;
  const nc = b.git.commits.length;
  if (nf) parts.push(`${nf} fichier${nf > 1 ? "s" : ""}`);
  if (nc) parts.push(`${nc} commit${nc > 1 ? "s" : ""}`);
  if (b.git.index_changed) parts.push("index git modifié");
  return parts.join(" · ");
}

/** Vrai si le panneau de détails a quelque chose à montrer en plus de la ligne. */
export function detailsTache(b: BilanTache): boolean {
  return !!(
    b.files_changed.length ||
    b.git.branch ||
    b.git.commits.length ||
    b.git.index_changed ||
    b.read_only ||
    b.remaining_work ||
    b.stop_reason ||
    b.budget_warnings?.length ||
    b.resumed ||
    b.errors ||
    b.report_saved_to ||
    b.secrets_masked
  );
}
