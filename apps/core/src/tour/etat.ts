// SPDX-License-Identifier: MIT
/** apps/core/src/tour/etat.ts — état des tours du process : annulations, contrôleurs actifs, verrous de présence et complétion qui raisonne (routes/_state.py, runtime/chat_locks.py, llm/reasoning_control.py ; en mémoire, v9 §7). */
import { strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import type { PortControleRaisonnement } from "../boucle/ports";

const CANCEL_FLAG_TTL_S = 3600.0;
const CANCEL_FLAG_SWEEP_MIN = 256;

interface Entree<T> {
  readonly uid: number;
  readonly cid: string;
  readonly valeur: T;
}

const maintenant = (): number => Date.now() / 1000;

/** `_norm_chat_id` : sans identifiant (premier message d'un chat neuf), la clé `__none__`. */
export function normChatId(chatId: unknown): string {
  return chatId ? strPy(chatId) : "__none__";
}

const cle = (uid: number, cid: string): string => `${uid}\x00${cid}`;

const annules = new Map<string, Entree<number>>();
const taches = new Map<string, Entree<AbortController>>();
const presences = new Map<string, JetonVerrou>();
const instantanes = new Map<string, Readonly<Dict>>();
const finsDeTour = new Set<(uid: number, chatId: string) => void>();

function balayerAnnulations(): void {
  if (annules.size <= CANCEL_FLAG_SWEEP_MIN) return;
  const limite = maintenant() - CANCEL_FLAG_TTL_S;
  for (const [k, e] of annules) if (e.valeur < limite) annules.delete(k);
}

/** Rappel `is_cancelled` des boucles ; sans chat (`null`) : n'importe quel chat du compte. */
export function isChatCancelled(uid: number, chatId: string | null = null): boolean {
  if (chatId === null) return [...annules.values()].some((e) => e.uid === uid);
  return annules.has(cle(uid, normChatId(chatId)));
}

/** Pose le drapeau d'annulation ; sans chat (`null`) : tous les tours en cours du compte. */
export function markChatCancelled(uid: number, chatId: string | null = null): void {
  if (chatId === null) {
    for (const [k, e] of taches) if (e.uid === uid) annules.set(k, { uid, cid: e.cid, valeur: maintenant() });
  } else {
    const cid = normChatId(chatId);
    annules.set(cle(uid, cid), { uid, cid, valeur: maintenant() });
  }
  balayerAnnulations();
}

export function clearChatCancellation(uid: number, chatId: string | null = null): void {
  if (chatId === null) {
    for (const [k, e] of annules) if (e.uid === uid) annules.delete(k);
    return;
  }
  annules.delete(cle(uid, normChatId(chatId)));
}

export interface OptionsEnregistrement {
  presenceLock?: boolean;
  presenceToken?: JetonVerrou | null;
  /** Instantané du tour de premier niveau (sans secret ni adresse), relu à l'enregistrement d'un job. */
  instantane?: Readonly<Dict> | null;
}

/** Enregistre le contrôleur du tour et prend le verrou de présence à la PREMIÈRE tâche de la clé (une passation ne le fait pas clignoter). */
export function registerChatTask(
  uid: number,
  controleur: AbortController,
  chatId: string | null = null,
  options: OptionsEnregistrement = {},
): void {
  const cid = normChatId(chatId);
  const k = cle(uid, cid);
  taches.set(k, { uid, cid, valeur: controleur });
  if (options.instantane) instantanes.set(k, options.instantane);
  else instantanes.delete(k);
  const jeton = options.presenceToken ?? null;
  if ((options.presenceLock ?? true) && !presences.has(k)) {
    const pris = jeton ?? verrousChat.acquire("gen", uid, chatId);
    if (pris !== null) presences.set(k, pris);
  } else if (jeton !== null && presences.get(k) !== jeton) verrousChat.release(jeton);
}

/** Retire le tour qui se termine ; `controleur` donné : seulement s'il est encore celui de la clé (passation). */
export function unregisterChatTask(
  uid: number,
  chatId: string | null = null,
  controleur?: AbortController,
): void {
  const k = cle(uid, normChatId(chatId));
  const actuel = taches.get(k);
  if (controleur !== undefined && actuel !== undefined && actuel.valeur !== controleur) return;
  const retire = taches.delete(k);
  verrousChat.release(presences.get(k) ?? null);
  presences.delete(k);
  annules.delete(k);
  if (!retire) return;
  instantanes.delete(k);
  for (const f of finsDeTour) {
    try {
      f(uid, normChatId(chatId));
    } catch {
      // abonné en panne : les autres sont prévenus
    }
  }
}

/** Instantané du tour en cours sur ce chat, `null` sans tour de premier niveau. */
export function instantaneTour(uid: number, chatId: string): Readonly<Dict> | null {
  return instantanes.get(cle(uid, normChatId(chatId))) ?? null;
}

/** Abonnement à la fin d'un tour (tâche retirée du registre) ; rend le désabonnement. */
export function surFinDeTour(f: (uid: number, chatId: string) => void): () => void {
  finsDeTour.add(f);
  return () => void finsDeTour.delete(f);
}

/** Contrôleur du tour de ce chat ; sans chat (`null`) : le premier tour du compte. */
export function getActiveChatTask(uid: number, chatId: string | null = null): AbortController | null {
  if (chatId !== null) return taches.get(cle(uid, normChatId(chatId)))?.valeur ?? null;
  for (const e of taches.values()) if (e.uid === uid) return e.valeur;
  return null;
}

/** Tours sans chat explicite (`__none__`) du compte : l'annulation historique sans `chat_id`. */
export function tachesSansChat(uid: number): AbortController[] {
  return [...taches.values()].filter((e) => e.uid === uid && e.cid === "__none__").map((e) => e.valeur);
}

export function isGenerationActive(uid: number, chatId: string | null = null): boolean {
  return getActiveChatTask(uid, chatId) !== null || verrousChat.isHeld("gen", uid, chatId);
}

// ── Verrous de présence (chat_locks, en mémoire) ──────────────────────────────

/** Jeton rendu par `acquire`, à présenter à `release`. */
export type JetonVerrou = symbol;

const verrous = new Map<string, JetonVerrou>();

function cleVerrou(kind: string, uid: number, chatId: unknown): string {
  const sur = strPy(kind)
    .toLowerCase()
    .replace(/[^a-z0-9_]/gu, "_");
  return `${Array.from(sur).slice(0, 16).join("") || "lock"}\x00${Math.trunc(uid)}\x00${normChatId(chatId)}`;
}

export const verrousChat = {
  /** Jeton, ou `null` si le verrou est DÉJÀ tenu. */
  acquire(kind: string, uid: number, chatId: unknown): JetonVerrou | null {
    const k = cleVerrou(kind, uid, chatId);
    if (verrous.has(k)) return null;
    const jeton = Symbol(k);
    verrous.set(k, jeton);
    return jeton;
  },
  release(jeton: JetonVerrou | null): void {
    if (jeton === null) return;
    for (const [k, j] of verrous) if (j === jeton) verrous.delete(k);
  },
  isHeld(kind: string, uid: number, chatId: unknown): boolean {
    return verrous.has(cleVerrou(kind, uid, chatId));
  },
  /** Verrous `kind` tenus, d'un compte ou de tous. */
  countHeld(kind: string, uid: number | null = null): number {
    const prefixe = cleVerrou(kind, uid ?? 0, "").split("\x00")[0] + "\x00";
    let n = 0;
    for (const k of verrous.keys()) {
      if (!k.startsWith(prefixe)) continue;
      if (uid === null || k.split("\x00")[1] === String(Math.trunc(uid))) n += 1;
    }
    return n;
  },
};

// ── Complétion qui raisonne (reasoning_control, en mémoire) ───────────────────

const ENTRY_TTL_S = 900.0;
const completions = new Map<
  string,
  { completion_id: string; model: string; engine_key: string; ts: number }
>();

/** `PortControleRaisonnement` du process : une entrée par chat, périmée après 15 min. */
export const controleRaisonnementDuProcess: PortControleRaisonnement & {
  getCompletion(
    chatId: string,
  ): { completion_id: string; model: string; engine_key: string; ts: number } | null;
} = {
  noteCompletion(chatId, completionId, model = "", engineKey = "builtin") {
    if (!chatId || !completionId) return;
    const t = maintenant();
    for (const [k, e] of completions) if (t - e.ts > ENTRY_TTL_S) completions.delete(k);
    completions.set(chatId, {
      completion_id: strPy(completionId),
      model: model || "",
      engine_key: engineKey || "builtin",
      ts: t,
    });
  },
  getCompletion(chatId) {
    if (!chatId) return null;
    const e = completions.get(chatId);
    if (e === undefined || maintenant() - e.ts > ENTRY_TTL_S) return null;
    return e.completion_id ? { ...e } : null;
  },
  clearCompletion(chatId) {
    completions.delete(chatId);
  },
};

/** Remet l'état à zéro (tests). */
/** `len(_active_chat_tasks)` : tours de chat en vol dans ce process (échantillonneur, B1-32). */
export function nombreTachesChat(): number {
  return taches.size;
}

export function viderEtatPourTests(): void {
  for (const m of [annules, taches, presences, verrous, completions, instantanes]) m.clear();
}
