// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/historique/ouverture.ts — ouverture d'une conversation : la ligne en cours d'ouverture et la lecture lancée à l'appui, reprise par le clic. */
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
