// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/historique/ouverture.ts — ouverture d'une conversation : la ligne en cours d'ouverture, la lecture lancée à l'appui, reprise par le clic, et les dernières lectures gardées pour un retour sans attente. */
import { ref } from "vue";
import type { Ref } from "vue";

import type { FetchAuth } from "./recherche";

/** Durée de vie d'une lecture lancée à l'appui et jamais reprise (appui relâché ailleurs, clic trop tardif). */
export const DELAI_PRECHARGE_MS = 2000;

/** Conversation en cours d'ouverture : la ligne cliquée est marquée, le fil quitté reste affiché mais inerte. */
export const chatEnOuverture: Ref<string | null> = ref(null);

interface Precharge {
  readonly id: string;
  readonly generation: number;
  readonly reponse: Promise<Response | null>;
  readonly minuteur: ReturnType<typeof setTimeout>;
}

let courant: Precharge | null = null;

export const urlChat = (id: string): string => "/api/saved/chats/" + id;

/** Libère la lecture en attente : sa réponse, si elle arrive, est refermée sans être lue. */
export function oublierPrecharge(): void {
  const p = courant;
  if (!p) return;
  courant = null;
  clearTimeout(p.minuteur);
  void p.reponse.then(
    (r) => r?.body?.cancel().catch(() => {}),
    () => {},
  );
}

/** Lance la lecture d'une conversation (sans effet de bord côté serveur) avant que le clic ne l'ouvre ; son rejet éventuel est vu par qui la reprend. */
export function precharger(fetchAuth: FetchAuth, id: string, generation: number): void {
  if (courant && courant.id === id && courant.generation === generation) return;
  oublierPrecharge();
  const reponse = fetchAuth(urlChat(id), {}, true);
  reponse.catch(() => {});
  courant = { id, generation, reponse, minuteur: setTimeout(oublierPrecharge, DELAI_PRECHARGE_MS) };
}

/** Reprend la lecture lancée pour cette conversation (une seule fois), ou rien. */
export function reprendrePrecharge(id: string, generation: number): Promise<Response | null> | null {
  const p = courant;
  if (!p || p.id !== id || p.generation !== generation) return null;
  courant = null;
  clearTimeout(p.minuteur);
  return p.reponse;
}

/** Dernières conversations lues, gardées en mémoire seulement (texte de la réponse) : nombre et taille bornés. */
export const GARDEES_MAX = 5;
export const GARDEES_CARACTERES_MAX = 8_000_000;

interface Gardee {
  readonly generation: number;
  readonly texte: string;
  readonly maj: number;
}

const gardees = new Map<string, Gardee>();

/** Garde la lecture d'une conversation (la plus récente en dernier) ; les plus anciennes et celles d'une autre session sortent. */
export function garderConversation(id: string, generation: number, texte: string, maj: number): void {
  gardees.delete(id);
  for (const [cle, g] of gardees) if (g.generation !== generation) gardees.delete(cle);
  if (texte.length > GARDEES_CARACTERES_MAX) return;
  gardees.set(id, { generation, texte, maj });
  let total = 0;
  for (const g of gardees.values()) total += g.texte.length;
  for (const [cle, g] of gardees) {
    if (gardees.size <= GARDEES_MAX && total <= GARDEES_CARACTERES_MAX) break;
    gardees.delete(cle);
    total -= g.texte.length;
  }
}

/** Lecture gardée de cette session, si la liste ne la dit pas dépassée (`maj` null : date inconnue de la liste). */
export function conversationGardee(id: string, generation: number, maj: number | null): string | null {
  const g = gardees.get(id);
  if (!g) return null;
  gardees.delete(id);
  if (g.generation !== generation || (maj !== null && maj !== g.maj)) return null;
  gardees.set(id, g);
  return g.texte;
}

/** Oublie la lecture gardée d'une conversation, ou toutes. */
export function oublierConversation(id?: string): void {
  if (id === undefined) gardees.clear();
  else gardees.delete(id);
}
