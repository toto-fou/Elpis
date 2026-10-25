// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/interface.ts — préférence « Interface classique » (`classic_ui`) : seul point de lecture des composants, fourni par les racines, et classe du body pour les écarts de style. */
import { computed, inject, provide, reactive, watch } from "vue";
import type { InjectionKey } from "vue";

export interface DomaineInterface {
  /** Vrai : ancienne disposition (composeur, menus, fil, Paramètres, console) ; les correctifs restent communs. */
  readonly classique: boolean;
}

export const CLE_INTERFACE: InjectionKey<DomaineInterface> = Symbol("elpis:interface");
export const CLASSE_INTERFACE_CLASSIQUE = "elpis-ui-classique";
const PAR_DEFAUT: DomaineInterface = Object.freeze({ classique: false });

/** Fournit le domaine depuis la préférence lue (seul `true` active l'interface classique) ; dans le `setup` d'une racine. */
export function fournirInterface(lire: () => unknown): DomaineInterface {
  const classique = computed(() => lire() === true);
  const domaine: DomaineInterface = reactive({ classique });
  watch(
    classique,
    (actif) => {
      try {
        document.body.classList.toggle(CLASSE_INTERFACE_CLASSIQUE, actif);
      } catch {
        /* DOM indisponible */
      }
    },
    { immediate: true },
  );
  provide(CLE_INTERFACE, domaine);
  return domaine;
}

/** Domaine fourni par la racine ; sans racine (composant monté seul), la nouvelle interface. */
export function interfaceApp(): DomaineInterface {
  return inject(CLE_INTERFACE, PAR_DEFAUT);
}
