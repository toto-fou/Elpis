// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/registre.ts — runs de sous-agents actifs dans ce process : clé par compte, annulation ciblée, dernier run d'une clé. */
import { CancelledError } from "@elpis/commun";

import { journal } from "../../../journal";

const log = journal("outils.taches-agents");

export const ACTIFS = new Map<
  string,
  { agent: string; chatId: string | null; t0: number; arret: AbortController }
>();
export const ANNULES = new Set<string>();
/** Dernier run lancé par clé, gardé après sa sortie d'`ACTIFS` : un run plus ancien qui finit en retard (Stop puis reprise immédiate) ne ferme ni n'écrase rien du nouveau. */
const DERNIER = new Map<string, AbortController>();
const DERNIER_MAX = 1000;

/** Pose le dernier run de `k` ; au-delà du plafond, les plus anciens partent, sauf une clé encore active (un run long garde sa place). */
export function marquerDernier(k: string, arret: AbortController): void {
  DERNIER.delete(k);
  DERNIER.set(k, arret);
  for (const ancienne of DERNIER.keys()) {
    if (DERNIER.size <= DERNIER_MAX) break;
    if (!ACTIFS.has(ancienne)) DERNIER.delete(ancienne);
  }
}

/** Ce run est-il le dernier de sa clé ? Une clé absente (évincée après sa fin, aucun run plus récent) vaut oui. */
export const estLeDernier = (k: string, arret: AbortController): boolean =>
  (DERNIER.get(k) ?? arret) === arret;

/** Clé d'un enfant dans les registres : compte et `task_id`. */
export const cle = (username: string, childId: string): string =>
  JSON.stringify([String(username), String(childId)]);

/** Pose l'annulation d'un enfant ACTIF sur ce process (et arrête ses appels) ; `false` s'il n'y est pas. */
export function applyChildCancel(username: string, childId: string): boolean {
  const k = cle(username, childId);
  const actif = ACTIFS.get(k);
  if (actif) {
    ANNULES.add(k);
    actif.arret.abort(new CancelledError("sub-agent cancelled"));
  }
  return Boolean(actif);
}

/** Annule UN sous-agent sans toucher au tour parent (endpoint `POST /api/chat/task-cancel`). */
export function cancelChild(username: string, childId: string): boolean {
  const actif = applyChildCancel(username, childId);
  log.info(`[task_tool] cancel_child ${username}/${childId} (actif=${actif})`);
  return actif;
}
