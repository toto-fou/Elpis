// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/liste/regroupement.ts — réveils des tâches de fond regroupés à l'affichage : chaque ligne de réveil et la réponse qui la suit continuent la bulle de l'agent qui précède (stockage et contexte du modèle inchangés). */

export interface MessageGroupable {
  role?: string;
  origin?: string | null;
  isError?: boolean;
}

type Liste = readonly (MessageGroupable | null | undefined)[];

export const estReveil = (m: MessageGroupable | null | undefined): boolean =>
  m?.role === "user" && m.origin === "job_wake";

const estReponse = (m: MessageGroupable | null | undefined): boolean => m?.role === "assistant" && !m.isError;

// Une bulle reste ouverte après `k` si, en remontant les réveils, on tombe sur une réponse de l'agent.
function ouverte(msgs: Liste, k: number): boolean {
  for (; k >= 0; k--) {
    if (estReponse(msgs[k])) return true;
    if (!estReveil(msgs[k])) return false;
  }
  return false;
}

/** Le message `i` continue la bulle précédente : réveil, ou réponse à un réveil, après une réponse de l'agent. */
export function absorbe(msgs: Liste, i: number): boolean {
  if (i <= 0) return false;
  const local = estReveil(msgs[i]) || (estReveil(msgs[i - 1]) && estReponse(msgs[i]));
  return local && ouverte(msgs, i - 1);
}

/** Tête de la bulle du message `i`, en ne remontant que la bulle elle-même (pas toute la liste). */
export function teteDeBulle(msgs: Liste, i: number): number {
  while (i > 0 && i < msgs.length && absorbe(msgs, i)) i--;
  return i;
}

/** Tête de bulle de chaque message : son propre index, ou celui de la réponse de l'agent qu'il continue. */
export function tetesDeBulles(msgs: Liste): number[] {
  const tetes = new Array<number>(msgs.length);
  for (let i = 0; i < msgs.length; i++) tetes[i] = absorbe(msgs, i) ? (tetes[i - 1] ?? i) : i;
  return tetes;
}

/** Nombre de bulles affichées dont au moins un message vérifie `garde`. */
export function compterBulles<T extends MessageGroupable>(
  msgs: readonly T[],
  garde: (m: T) => boolean,
): number {
  const tetes = tetesDeBulles(msgs);
  const vues = new Set<number>();
  msgs.forEach((m, i) => {
    if (garde(m)) vues.add(tetes[i] ?? i);
  });
  return vues.size;
}
