// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/clic-exterieur.ts — clic hors d'un menu ou d'un panneau ouvert : il se referme (menu contextuel, RAG, « + », modèles, effort, réseau, images, tâches, export, notifications). */
import type { Ref } from "vue";

import type { Modules } from "./types";

export interface EtatClicExterieur {
  readonly modules: Modules;
  readonly menuOuvert: () => boolean;
  fermerMenu(): void;
  readonly showExportMenu: Ref<boolean>;
  readonly showNotifPanel: Ref<boolean>;
  readonly notifDropdownRef: Ref<HTMLElement | null>;
}

/** Ferme ce qui est ouvert quand le clic tombe hors de son ancre (élément de référence ou attribut `data-…`). */
export function creerClicExterieur(s: EtatClicExterieur): (e: MouseEvent) => void {
  return (e) => {
    const cible = e.target instanceof Element ? e.target : null;
    const hors = (selecteur: string): boolean => !cible?.closest(selecteur);
    const horsDe = (el: HTMLElement | null | undefined): boolean =>
      !!el && !el.contains(e.target as Node | null);
    if (s.menuOuvert()) s.fermerMenu();
    const chat = s.modules.chat;
    if (chat) {
      // Le panneau des partages reçus ne se ferme pas au clic extérieur (Échap ou sa croix seulement).
      if (chat.showComposerPlus.value && horsDe(chat.composerPlusRef.value))
        chat.showComposerPlus.value = false;
      if (chat.showModelManager.value && hors("[data-model-manager]")) chat.showModelManager.value = false;
      const effort = chat.showReasoningEffortMenu as Ref<boolean> | undefined;
      if (effort?.value && hors("[data-effort-menu]")) effort.value = false;
    }
    const reglages = s.modules.reglages;
    if (reglages?.netMenuOpen.value && hors("[data-net-menu]")) reglages.netMenuOpen.value = false;
    if (chat) {
      if (chat.imagePop.value && hors("[data-image-pop]")) chat.imagePop.value = "";
      if (chat.todoPanelOpen.value && hors("[data-todo-flyout]")) chat.todoPanelOpen.value = false;
      if (chat.jobsOuvert.value && hors("[data-jobs-flyout]")) chat.jobsOuvert.value = false;
    }
    if (s.showExportMenu.value && hors("[data-export-menu]")) s.showExportMenu.value = false;
    if (s.showNotifPanel.value && horsDe(s.notifDropdownRef.value)) s.showNotifPanel.value = false;
  };
}
