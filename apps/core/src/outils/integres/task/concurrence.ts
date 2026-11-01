// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/concurrence.ts — runs du compte suivis pour le drapeau `concurrent` du bilan : sous-agents et boucles de premier niveau. */
import type { SousAgent } from "@elpis/securite";

import { BORNES_DELAI_FOND } from "./reglages";

interface Trace {
  parent: string;
  sousAgent: boolean;
  /** Sous-agent en fond : sa boucle parente continue pendant qu'il tourne, elle compte comme les autres. */
  fond: boolean;
  t0: number;
  t1: number | null;
  ecrit: boolean;
}

/** Runs suivis par compte (le shell relève tout le bac du compte) : sous-agents et boucles de premier niveau. */
const TRACES = new Map<string, Map<string, Trace>>();
/** Au-delà, une trace part quoi qu'il arrive : délai maximal d'un enfant en fond, marge comprise. */
const TRACE_MAX_MS = (BORNES_DELAI_FOND[1] + 600) * 1000;
let numeroBoucle = 0;

/** Runs suivis du compte ; une trace finie part dès qu'aucun run actif n'a commencé avant sa fin (aucun bilan à venir ne peut la croiser), toute trace au-delà de `TRACE_MAX_MS`. */
function tracesDu(compte: string): Map<string, Trace> {
  const m = TRACES.get(compte) ?? new Map<string, Trace>();
  const maintenant = Date.now();
  for (const [k, t] of m) if (maintenant - (t.t1 ?? t.t0) > TRACE_MAX_MS) m.delete(k);
  let premierActif = Infinity;
  for (const t of m.values()) if (t.t1 === null) premierActif = Math.min(premierActif, t.t0);
  for (const [k, t] of m) if (t.t1 !== null && t.t1 < premierActif) m.delete(k);
  TRACES.set(compte, m);
  return m;
}

/** Début d'un sous-agent du compte sous son chat parent (`compte:chat`). */
export function debutTrace(compte: string, parent: string, id: string, sa: SousAgent): void {
  tracesDu(compte).set(id, {
    parent,
    sousAgent: true,
    fond: false,
    t0: Date.now(),
    t1: null,
    ecrit: !sa.read_only,
  });
}

/** Le sous-agent `id` part en fond : la boucle qui l'a lancé compte désormais parmi ses concurrents. */
export function traceEnFond(compte: string, id: string): void {
  const t = TRACES.get(compte)?.get(id);
  if (t) t.fond = true;
}

/** Boucle de premier niveau du compte (chat, routine) ; rend sa fin. */
export function debutBoucle(compte: string, chatId: string | null, ecrit: boolean): () => void {
  const cle = `#${++numeroBoucle}`;
  const t: Trace = {
    parent: `${compte}:${chatId || ""}`,
    sousAgent: false,
    fond: false,
    t0: Date.now(),
    t1: null,
    ecrit,
  };
  tracesDu(compte).set(cle, t);
  return () => void (t.t1 = Date.now());
}

/** Fin d'un sous-agent : vrai si un autre run du compte qui peut écrire a tourné en même temps que lui (la boucle de sa conversation exclue au premier plan, où elle l'attend). */
export function finTrace(compte: string, id: string): boolean {
  const m = TRACES.get(compte);
  const moi = m?.get(id);
  if (!m || !moi) return false;
  moi.t1 = Date.now();
  for (const [k, t] of m) {
    if (k === id || !t.ecrit || (!moi.fond && !t.sousAgent && t.parent === moi.parent)) continue;
    if (t.t0 <= moi.t1 && (t.t1 === null || t.t1 >= moi.t0)) return true;
  }
  return false;
}

/** Tests : runs suivis du compte (après la purge). */
export function tracesSuivies(compte: string): number {
  return tracesDu(compte).size;
}

/** Tests : plus aucune trace. */
export function oublierTraces(): void {
  TRACES.clear();
}
