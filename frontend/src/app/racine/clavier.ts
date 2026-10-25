// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/clavier.ts — clavier global de la page : piège Tab et garde de focus des grandes fenêtres, cascade d'Échap (la fenêtre du dessus d'abord, la page en dernier), Alt+I et Ctrl+Maj+O. */
import { computed, nextTick, watch } from "vue";
import type { Ref } from "vue";

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

  /** Échap : ferme l'élément du dessus et s'arrête ; vrai s'il a été consommé. */
  function cascadeEchap(e: KeyboardEvent): void {
    const c = m.chat;
    const r = m.reglages;
    const a = m.admin;
    const ed = m.editeur;
    // Fenêtre de confirmation ou de saisie : au sommet de la pile, porte de toutes les actions destructrices.
    if (s.modalState.value.isOpen) {
      s.handleModalCancel();
      return;
    }
    // Boîtes de la page RAG (Publier, Nouvelle collection, import du bac) : au-dessus de la page.
    if (m.rag?.fermerDialogue()) return;
    if (c?.imageViewer.value) {
      c.closeImageViewer();
      return;
    }
    if (c?.imageGallery.value) {
      c.closeImageGallery();
      return;
    }
    // Voix très haut (dictée, lecture), sauf si une fenêtre, un menu du composeur ou Monaco attend cet Échap.
    const actif = document.activeElement;
    const ailleurs =
      grandeFenetreOuverte.value ||
      vrai(c?.showSlash) ||
      vrai(c?.showMentionDropdown) ||
      vrai(c?.showComposerPlus) ||
      !!actif?.closest(".monaco-editor");
    if (!ailleurs && c?.voiceEscape()) return;
    // Handler en capture : les menus internes d'une fenêtre passent avant la fenêtre elle-même.
    const sk = m.skills;
    if (sk?.showSkillImportMenu.value) {
      sk.closeSkillImportMenu();
      return;
    }
    if (r?.netMenuOpen.value) {
      r.closeNetMenu();
      return;
    }
    if (a?.paletteOpen.value) {
      a.closePalette();
      return;
    }
    if (a?.adminMeOpen.value) {
      a.adminMeOpen.value = false;
      return;
    }
    if (a?.dashMenu.value) {
      a.dashMenu.value = null;
      return;
    }
    if (a?.engineDrawer.value) {
      a.closeEngineDrawer();
      return;
    }
    if (a?.groupModal.value.show) {
      a.groupModal.value.show = false;
      return;
    }
    if (a?.groupMembersModal.value.show) {
      a.groupMembersModal.value.show = false;
      return;
    }
    if (a?.resetTarget.value) {
      a.resetTarget.value = null;
      return;
    }
    if (m.auth?.showNewUserModal.value) {
      m.auth.showNewUserModal.value = false;
      return;
    }
    if (c?.skillAssistForm.value.open) {
      c.skillAssistForm.value.open = false;
      return;
    }
    if (c?.toolInfo.value) {
      c.closeToolInfo();
      return;
    }
    if (c?.runDetails.value) {
      c.closeRunDetails();
      return;
    }
    // Transfert : fermable seulement une fois terminé.
    const tr = a?.transferModal.value;
    if (tr?.active && (tr.done || tr.error)) {
      a?.closeTransferModal();
      return;
    }
    if (r?.showSettingsModal.value) {
      void r.closeSettings();
      return;
    }
    if (r?.showMcpManagerModal.value) {
      void r.closeMcpManager();
      return;
    }
    if (r?.isShareModalOpen.value) {
      r.isShareModalOpen.value = false;
      return;
    }
    if (r?.showHelpModal.value) {
      r.showHelpModal.value = false;
      return;
    }
    if (s.showInfoModal.value) {
      s.showInfoModal.value = false;
      return;
    }
    if (s.showOpenCodeModal.value) {
      s.showOpenCodeModal.value = false;
      return;
    }
    if (c?.showModelProps.value) {
      c.showModelProps.value = false;
      return;
    }
    if (c?.taskModal.value) {
      c.closeTaskModal();
      return;
    }
    if (a?.showAxModal.value) {
      a.showAxModal.value = false;
      return;
    }
    if (ed?.shortcutsModalVisible.value) {
      ed.closeShortcutsModal();
      return;
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
        return;
      }
    }
    if (s.imgZoom.value) {
      s.imgZoom.value = null;
      return;
    }
    for (const pop of [ed?.showEditorMore, ed?.showImportMenu, ed?.showTabsOverflow]) {
      if (pop?.value) {
        pop.value = false;
        return;
      }
    }
    if (ed?.tabCtxMenu.value.show) {
      ed.closeTabCtxMenu();
      return;
    }
    // Menus du composeur : la saisie les ferme trop tard (écoute en capture ici).
    if (c?.showSlash.value) {
      c.slashDismiss();
      return;
    }
    if (c?.showMentionDropdown.value) {
      c.closeMentionDropdown();
      return;
    }
    for (const panneau of [c?.showSamplingPanel, c?.showMcpPanel, c?.showComposerPlus]) {
      if (panneau?.value) {
        panneau.value = false;
        return;
      }
    }
    // Mode Images : popover d'abord, puis sortie du mode quand la saisie vide a le focus.
    if (c) {
      const ta = s.inputRef.value;
      const vide = !(s.inputMessage.value || "").trim();
      if (c.imageEscape(vide, !!ta && document.activeElement === ta)) return;
    }
    if (c?.showModelManager.value) {
      c.showModelManager.value = false;
      return;
    }
    const effort = c?.showReasoningEffortMenu as Ref<boolean> | undefined;
    if (effort?.value) {
      effort.value = false;
      return;
    }
    if (s.showNotifPanel.value) {
      s.showNotifPanel.value = false;
      return;
    }
    if (s.menuPagesOuvert.value) {
      s.menuPagesOuvert.value = false;
      return;
    }
    if (r?.showSharedPrompts.value) {
      r.showSharedPrompts.value = false;
      return;
    }
    if (s.contextMenu.value.isOpen) {
      s.closeContextMenu();
      return;
    }
    // Bulle puis visionneuse d'une source du RAG : volet du chat, avant les pages plein écran.
    if (s.currentView.value === "chat" && m.rag?.sources.echap()) return;
    // Pages plein écran en dernier : une fenêtre ouverte par-dessus se ferme d'abord.
    const vue = s.currentView.value;
    if (vue === "routines") {
      const ro = m.routines;
      // En pleine édition, Échap revient à la lecture (même geste que la flèche) au lieu de tout jeter.
      if (ro?.routineIsEditing.value) void ro.cancelRoutineEdit();
      else if (ro) ro.closeRoutinesPage();
      else s.currentView.value = "chat";
      return;
    }
    if (vue === "rag") {
      if (m.rag?.echapPage()) return;
      if (m.rag) m.rag.fermer();
      else s.currentView.value = "chat";
      return;
    }
    if (vue === "studio") {
      const sc = m.studioChat;
      if (sc?.studioTextModal.value) {
        sc.textModalCancel();
        return;
      }
      if (sc?.studioCtxMenu.value) {
        sc.closeStudioCtx();
        return;
      }
      if (sc?.studioDragFrom.value) {
        sc.cancelStudioDrag();
        return;
      }
      if (m.studio) m.studio.closeStudio();
      else s.currentView.value = "chat";
      return;
    }
    if (vue === "code") {
      const co = m.code;
      if (co?.codeEscape()) return;
      if (co) co.closeCodePage();
      else s.currentView.value = "chat";
      return;
    }
    // Plein écran de l'éditeur en dernier ; Échap consommé par Monaco (recherche, suggestions) n'en sort pas.
    if (ed?.editorFullscreen.value) {
      if (ed.monacoConsumesEscape(e)) return;
      ed.exitEditorFullscreen();
    }
  }

  function onGlobalKeydown(ev: KeyboardEvent): void {
    const e = ev as EvenementCascade;
    const c = m.chat;
    const r = m.reglages;
    // Piège Tab de la grande fenêtre ouverte ; les fenêtres du dessus (confirmation, menu, images) gardent le leur.
    const dialogueImage = vrai(c?.imageViewer) || vrai(c?.imageGallery);
    if (
      e.key === "Tab" &&
      grandeFenetreOuverte.value &&
      !dialogueImage &&
      !s.modalState.value.isOpen &&
      !s.contextMenu.value.isOpen
    ) {
      const overlay = document.querySelector<HTMLElement>("[data-a11y-modal]");
      if (overlay) piegerTab(e, overlay);
    }
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey) {
      // Pas de preventDefault : Monaco et les listes déroulantes en ont besoin aussi.
      e._elpisCascadeSaw = true;
      cascadeEchap(e);
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
