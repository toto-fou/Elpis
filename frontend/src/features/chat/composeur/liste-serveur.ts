// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/composeur/liste-serveur.ts — liste lue au serveur pour les menus du composeur (skills, prompts, gabarits) : gardée 30 s, périmée par l'événement de changement des Paramètres. */
import { getCurrentScope, onScopeDispose, ref } from "vue";
import type { Ref } from "vue";

const CACHE_MS = 30000;

export interface ListeServeur<T> {
  /** Dernière liste lue, `null` tant qu'aucune lecture n'a abouti : les menus la montrent telle quelle. */
  readonly items: Ref<T[] | null>;
  /** Relit la liste si elle a plus de 30 s ou a été périmée ; `lire` rend `null` pour un échec (liste gardée). */
  charger(force?: boolean): Promise<T[]>;
}

export function listeServeur<T>(evenement: string, lire: () => Promise<T[] | null>): ListeServeur<T> {
  const items = ref<T[] | null>(null) as Ref<T[] | null>;
  let lueA = 0;
  let enVol: Promise<T[]> | null = null;
  const perimer = (): void => {
    lueA = 0;
  };
  globalThis.addEventListener?.(evenement, perimer);
  if (getCurrentScope()) onScopeDispose(() => globalThis.removeEventListener?.(evenement, perimer));

  async function relire(): Promise<T[]> {
    try {
      const liste = await lire();
      if (liste) {
        items.value = liste;
        lueA = Date.now();
      }
    } catch {
      /* liste gardée telle quelle */
    }
    return items.value ?? [];
  }

  function charger(force?: boolean): Promise<T[]> {
    if (!force && lueA && Date.now() - lueA < CACHE_MS) return Promise.resolve(items.value ?? []);
    enVol ??= relire().finally(() => {
      enVol = null;
    });
    return enVol;
  }

  return { items, charger };
}
