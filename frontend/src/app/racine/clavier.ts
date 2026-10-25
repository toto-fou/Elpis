// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/clavier.ts — clavier global de la page : piège Tab et garde de focus des grandes fenêtres, cascade d'Échap (la fenêtre du dessus d'abord, la page en dernier), Alt+I et Ctrl+Maj+O. */
import { computed, nextTick, watch } from "vue";
import type { Ref } from "vue";

import { apercuSkin, fermerApercuSkin } from "../../features/reglages/skins-perso";
import { gardeFocus, piegerTab, SELECTEUR_FOCUSABLES } from "../../utils/focus";
import type { EtatFenetre, MenuContextuel } from "./chrome";
import type { Modules } from "./types";

export interface EtatClavier {
  readonly modules: Modules;
  readonly modalState: Ref<EtatFenetre>;
  readonly contextMenu: Ref<MenuContextuel>;
  readonly showInfoModal: Ref<boolean>;
  readonly showOpenCodeModal: Ref<boolean>;
  readonly imgZoom: Ref<string | null>;
  readonly showNotifPanel: Ref<boolean>;
  readonly menuPagesOuvert: Ref<boolean>;
  readonly currentView: Ref<string>;
  readonly inputMessage: Ref<string>;
  readonly inputRef: Ref<HTMLTextAreaElement | null>;
  handleModalCancel(): void;
  closeContextMenu(): void;
}

/** Événement marqué par la cascade : le repli « plein écran » de l'éditeur ne rejoue pas le même Échap. */
interface EvenementCascade extends KeyboardEvent {
  _elpisCascadeSaw?: boolean;
  /** Posé quand la cascade a consommé l'Échap : le questionnaire du composeur ne se ferme pas aussi. */
  _elpisEchapPris?: boolean;
}

const vrai = (r: { value: unknown } | null | undefined): boolean => !!r?.value;

export function creerClavier(s: EtatClavier) {
  const m = s.modules;
  const garde = gardeFocus();

  // Grandes fenêtres (overlay [data-a11y-modal]) : une garde commune plutôt qu'une par fenêtre.
  const grandeFenetreOuverte = computed(() => {
    const r = m.reglages;
    const c = m.chat;
    const a = m.admin;
    const e = m.editeur;
    return !!(
      vrai(r?.showSettingsModal) ||
      vrai(r?.showMcpManagerModal) ||
      vrai(r?.isShareModalOpen) ||
      vrai(r?.showHelpModal) ||
      s.showInfoModal.value ||
      s.showOpenCodeModal.value ||
      vrai(c?.showModelProps) ||
      vrai(c?.taskModal) ||
      vrai(c?.toolInfo) ||
      vrai(c?.runDetails) ||
      !!c?.assistantForm.value.open ||
      vrai(a?.showAxModal) ||
      vrai(e?.showGitCloneModal) ||
      vrai(e?.showGitInitModal) ||
      vrai(e?.showGitRemoteModal) ||
      vrai(e?.showGitPushAuth) ||
      vrai(e?.showGitMergeModal) ||
      vrai(a?.resetTarget) ||
      vrai(m.auth?.showNewUserModal) ||
      !!a?.groupModal.value.show ||
      !!a?.groupMembersModal.value.show ||
      vrai(m.rag?.dialogueOuvert)
    );
  });

  watch(grandeFenetreOuverte, (ouverte) => {
    if (!ouverte) {
      garde.restore();
      return;
    }
    garde.remember();
    void nextTick(() => {
      const overlay = document.querySelector("[data-a11y-modal]");
      // Fenêtre qui a déjà pris le focus : on ne l'écrase pas.
      if (!overlay || overlay.contains(document.activeElement)) return;
      overlay.querySelector<HTMLElement>(SELECTEUR_FOCUSABLES)?.focus();
    });
  });

  // Aperçu d'habillage (z-[6000], au-dessus de Paramètres) : il prend le focus et gagne le piège Tab tant qu'il est ouvert.
  const gardeApercu = gardeFocus();
  watch(
    () => apercuSkin.value !== null,
    (ouvert) => {
      if (!ouvert) {
        gardeApercu.restore();
        return;
      }
      gardeApercu.remember();
      void nextTick(() => {
        document
          .querySelector("[data-apercu-skin]")
          ?.querySelector<HTMLElement>(SELECTEUR_FOCUSABLES)
          ?.focus();
      });
    },
  );

  /** Échap : ferme l'élément du dessus et s'arrête ; vrai s'il a été consommé. */
  function cascadeEchap(e: KeyboardEvent): boolean {
    const c = m.chat;
    const r = m.reglages;
    const a = m.admin;
    const ed = m.editeur;
    // Fenêtre de confirmation ou de saisie : au sommet de la pile, porte de toutes les actions destructrices.
    if (s.modalState.value.isOpen) {
      s.handleModalCancel();
      return true;
    }
    // Aperçu d'habillage : ouvert depuis le chat ou Paramètres, il se ferme avant eux.
    if (apercuSkin.value) {
      fermerApercuSkin();
      return true;
    }
    // Boîtes de la page RAG (Publier, Nouvelle collection, import du bac) : au-dessus de la page.
    if (m.rag?.fermerDialogue()) return true;
    if (c?.imageViewer.value) {
      c.closeImageViewer();
      return true;
    }
    if (c?.imageGallery.value) {
      c.closeImageGallery();
      return true;
    }
    // Voix très haut (dictée, lecture), sauf si une fenêtre, un menu du composeur ou Monaco attend cet Échap.
    const actif = document.activeElement;
    const ailleurs =
      grandeFenetreOuverte.value ||
      vrai(c?.showSlash) ||
      vrai(c?.showMentionDropdown) ||
      vrai(c?.showComposerPlus) ||
      !!actif?.closest(".monaco-editor");
    if (!ailleurs && c?.voiceEscape()) return true;
    // Handler en capture : les menus internes d'une fenêtre passent avant la fenêtre elle-même.
    const sk = m.skills;
    if (sk?.showSkillImportMenu.value) {
      sk.closeSkillImportMenu();
      return true;
    }
    if (r?.netMenuOpen.value) {
      r.closeNetMenu();
      return true;
    }
    if (a?.paletteOpen.value) {
      a.closePalette();
      return true;
    }
    if (a?.adminMeOpen.value) {
      a.adminMeOpen.value = false;
      return true;
    }
    if (a?.dashMenu.value) {
      a.dashMenu.value = null;
      return true;
    }
    if (a?.engineDrawer.value) {
      a.closeEngineDrawer();
      return true;
    }
    if (a?.groupModal.value.show) {
      a.groupModal.value.show = false;
      return true;
    }
    if (a?.groupMembersModal.value.show) {
      a.groupMembersModal.value.show = false;
      return true;
    }
    if (a?.resetTarget.value) {
      a.resetTarget.value = null;
      return true;
    }
    if (m.auth?.showNewUserModal.value) {
      m.auth.showNewUserModal.value = false;
      return true;
    }
    if (c?.assistantForm.value.open) {
      c.assistantForm.value.open = false;
      return true;
    }
    if (c?.toolInfo.value) {
      c.closeToolInfo();
      return true;
    }
    if (c?.runDetails.value) {
      c.closeRunDetails();
      return true;
    }
    // Transfert : fermable seulement une fois terminé.
    const tr = a?.transferModal.value;
    if (tr?.active && (tr.done || tr.error)) {
      a?.closeTransferModal();
      return true;
    }
    if (r?.showSettingsModal.value) {
      void r.closeSettings();
      return true;
    }
    if (r?.showMcpManagerModal.value) {
      void r.closeMcpManager();
      return true;
    }
    if (r?.isShareModalOpen.value) {
      r.isShareModalOpen.value = false;
      return true;
    }
    if (r?.showHelpModal.value) {
      r.showHelpModal.value = false;
      return true;
    }
    if (s.showInfoModal.value) {
      s.showInfoModal.value = false;
      return true;
    }
    if (s.showOpenCodeModal.value) {
      s.showOpenCodeModal.value = false;
      return true;
    }
    if (c?.showModelProps.value) {
      c.showModelProps.value = false;
      return true;
    }
    if (c?.taskModal.value) {
      c.closeTaskModal();
      return true;
    }
    if (a?.showAxModal.value) {
      a.showAxModal.value = false;
      return true;
    }
    if (ed?.shortcutsModalVisible.value) {
      ed.closeShortcutsModal();
      return true;
    }
    for (const fenetre of [
      ed?.showGitCloneModal,
      ed?.showGitInitModal,
      ed?.showGitRemoteModal,
      ed?.showGitPushAuth,
      ed?.showGitMergeModal,
    ]) {
      if (fenetre?.value) {
        fenetre.value = false;
        return true;
      }
    }
    if (s.imgZoom.value) {
      s.imgZoom.value = null;
      return true;
    }
    for (const pop of [ed?.showEditorMore, ed?.showImportMenu, ed?.showTabsOverflow]) {
      if (pop?.value) {
        pop.value = false;
        return true;
      }
    }
    if (ed?.tabCtxMenu.value.show) {
      ed.closeTabCtxMenu();
      return true;
    }
    // Menus du composeur : la saisie les ferme trop tard (écoute en capture ici).
    if (c?.showSlash.value) {
      c.slashDismiss();
      return true;
    }
    if (c?.showMentionDropdown.value) {
      c.closeMentionDropdown();
      return true;
    }
    // Sous-menu ouvert dans le menu du modèle (actions « ⋯ », effort) : le menu le ferme seul, focus rendu à sa ligne.
    if (
      c?.showModelManager.value &&
      document.querySelector("[data-sous-menu-modele]") &&
      document.activeElement?.closest("[data-model-manager]")
    )
      return true;
    for (const panneau of [c?.showSamplingPanel, c?.showMcpPanel, c?.showComposerPlus]) {
      if (panneau?.value) {
        panneau.value = false;
        return true;
      }
    }
    // Mode Images : popover d'abord, puis sortie du mode quand la saisie vide a le focus.
    if (c) {
      const ta = s.inputRef.value;
      const vide = !(s.inputMessage.value || "").trim();
      if (c.imageEscape(vide, !!ta && document.activeElement === ta)) return true;
    }
    if (c?.showModelManager.value) {
      c.showModelManager.value = false;
      return true;
    }
    const effort = c?.showReasoningEffortMenu as Ref<boolean> | undefined;
    if (effort?.value) {
      effort.value = false;
      return true;
    }
    if (s.showNotifPanel.value) {
      s.showNotifPanel.value = false;
      return true;
    }
    if (s.menuPagesOuvert.value) {
      s.menuPagesOuvert.value = false;
      return true;
    }
    if (r?.showSharedPrompts.value) {
      r.showSharedPrompts.value = false;
      return true;
    }
    if (s.contextMenu.value.isOpen) {
      s.closeContextMenu();
      return true;
    }
    // Bulle puis visionneuse d'une source du RAG : volet du chat, avant les pages plein écran.
    if (s.currentView.value === "chat" && m.rag?.sources.echap()) return true;
    // Pages plein écran en dernier : une fenêtre ouverte par-dessus se ferme d'abord.
    const vue = s.currentView.value;
    if (vue === "routines") {
      const ro = m.routines;
      // En pleine édition, Échap revient à la lecture (même geste que la flèche) au lieu de tout jeter.
      if (ro?.routineIsEditing.value) void ro.cancelRoutineEdit();
      else if (ro) ro.closeRoutinesPage();
      else s.currentView.value = "chat";
      return true;
    }
    if (vue === "rag") {
      if (m.rag?.echapPage()) return true;
      if (m.rag) m.rag.fermer();
      else s.currentView.value = "chat";
      return true;
    }
    if (vue === "studio") {
      const sc = m.studioChat;
      if (sc?.studioTextModal.value) {
        sc.textModalCancel();
        return true;
      }
      if (sc?.studioCtxMenu.value) {
        sc.closeStudioCtx();
        return true;
      }
      if (sc?.studioDragFrom.value) {
        sc.cancelStudioDrag();
        return true;
      }
      if (m.studio) m.studio.closeStudio();
      else s.currentView.value = "chat";
      return true;
    }
    if (vue === "code") {
      const co = m.code;
      if (co?.codeEscape()) return true;
      if (co) co.closeCodePage();
      else s.currentView.value = "chat";
      return true;
    }
    // Plein écran de l'éditeur en dernier ; Échap consommé par Monaco (recherche, suggestions) n'en sort pas.
    if (ed?.editorFullscreen.value) {
      if (ed.monacoConsumesEscape(e)) return true;
      ed.exitEditorFullscreen();
      return true;
    }
    return false;
  }

  function onGlobalKeydown(ev: KeyboardEvent): void {
    const e = ev as EvenementCascade;
    const c = m.chat;
    const r = m.reglages;
    // Piège Tab de la grande fenêtre ouverte ; les fenêtres du dessus (confirmation, menu, images) gardent le leur.
    const dialogueImage = vrai(c?.imageViewer) || vrai(c?.imageGallery);
    if (
      e.key === "Tab" &&
      (grandeFenetreOuverte.value || apercuSkin.value !== null) &&
      !dialogueImage &&
      !s.modalState.value.isOpen &&
      !s.contextMenu.value.isOpen
    ) {
      const overlay =
        document.querySelector<HTMLElement>("[data-apercu-skin]") ??
        document.querySelector<HTMLElement>("[data-a11y-modal]");
      if (overlay) piegerTab(e, overlay);
    }
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey) {
      // Pas de preventDefault : Monaco et les listes déroulantes en ont besoin aussi.
      e._elpisCascadeSaw = true;
      if (cascadeEchap(e)) e._elpisEchapPris = true;
      return;
    }
    // Alt+I : mode Images (Ctrl+Maj+I ouvre les outils de développement) ; e.key garde la touche morte de macOS.
    const cible = e.target instanceof Element ? e.target.closest(".xterm, .monaco-editor") : null;
    if (
      e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      (e.key === "i" || e.key === "I") &&
      !cible &&
      s.currentView.value === "chat" &&
      c?.imageAvailable.value
    ) {
      if (s.modalState.value.isOpen || vrai(r?.showSettingsModal)) return;
      e.preventDefault();
      void c.toggleImageMode();
      return;
    }
    // Ctrl/Cmd+Maj+O : nouveau chat (Ctrl+N appartient au navigateur) ; dans Monaco c'est « Aller au symbole ».
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "O" || e.key === "o")) {
      if (document.activeElement?.closest(".monaco-editor")) return;
      e.preventDefault();
      // Pas de nouveau chat sous une fenêtre : ses gardes passeraient à la trappe.
      if (s.modalState.value.isOpen || vrai(r?.showSettingsModal)) return;
      s.currentView.value = "chat";
      void c?.startNewChat();
    }
  }

  return { onGlobalKeydown, grandeFenetreOuverte };
}
