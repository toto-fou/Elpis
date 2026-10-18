// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/raccourcis.ts — raccourcis clavier de l'éditeur, écoutés en capture (avant Monaco, qui arrête la propagation de ses touches) : Ctrl+S, Ctrl+Maj+T, Ctrl+Maj+F, Ctrl+`, Ctrl+Alt+S, Ctrl+B, Alt+W/PgPréc/PgSuiv/L/←/→ ; Échap laissé à Monaco quand un de ses widgets est ouvert. */
import { nextTick } from "vue";
import type { Ref } from "vue";

import type { EtatEditeur } from "./etat";
import type { ReglagesEditeur } from "./instances";
import type { LiensEditeur, ServicesEditeur } from "./liens";

const EST_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

export interface RappelsRaccourcis {
  rouvrirDernierFerme(): unknown;
  basculerTerminal(): unknown;
  toutEnregistrer(): unknown;
  navArriere(): unknown;
  navAvant(): unknown;
}

export function setupEditorShortcuts(
  e: EtatEditeur,
  s: ServicesEditeur,
  l: LiensEditeur,
  settings: Ref<ReglagesEditeur>,
  r: RappelsRaccourcis,
) {
  const { monacoRef, showEditor, activeTabPath, openTabs } = e;

  /** Vrai si Échap revient à Monaco (recherche, suggestions, renommage, multi-curseur…). */
  function monacoConsumesEscape(ev: KeyboardEvent): boolean {
    const cible = ev.target as HTMLElement | null;
    const hote = cible?.closest?.(".monaco-editor");
    if (!cible || !hote) return false;
    if (
      hote.querySelector(
        ".find-widget.visible, .suggest-widget.visible, .parameter-hints-widget.visible, .rename-box, .zone-widget, .peekview-widget",
      )
    )
      return true;
    for (const ed of [monacoRef.instance, monacoRef.instance2, monacoRef.diff?.getModifiedEditor()]) {
      try {
        if (ed && ed.getContainerDomNode().contains(cible) && (ed.getSelections() ?? []).length > 1)
          return true;
      } catch {
        /* éditeur libéré */
      }
    }
    return false;
  }

  function focusDansEditeur(): boolean {
    const ae = document.activeElement;
    if (ae?.closest?.("[data-editor-root]")) return true;
    return e.editorFullscreen.value && (!ae || ae === document.body);
  }

  function cyclerOnglet(sens: number): void {
    const tabs = openTabs.value;
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.path === activeTabPath.value);
    const suivant = tabs[(i + sens + tabs.length) % tabs.length];
    if (suivant) void l.switchTab(suivant.path);
  }

  const mod = (ev: KeyboardEvent): boolean => ev.ctrlKey || ev.metaKey;

  // Ctrl+Maj+T : rouvre le dernier onglet fermé (préféré à celui du navigateur).
  function rouvrir(ev: KeyboardEvent): void {
    if (!settings.value?.enable_editor) return;
    if (!(mod(ev) && ev.shiftKey && (ev.key === "T" || ev.key === "t"))) return;
    ev.preventDefault();
    void r.rouvrirDernierFerme();
  }

  // Ctrl+S, focus dans ou hors de Monaco : enregistre le panneau actif (le service dédoublonne avec la commande Monaco).
  function enregistrer(ev: KeyboardEvent): void {
    if (!settings.value?.enable_editor || !showEditor.value) return;
    if (!(mod(ev) && !ev.shiftKey && !ev.altKey && (ev.key === "s" || ev.key === "S"))) return;
    ev.preventDefault();
    if (e.activePane.value === "right" && e.splitTabPath.value)
      void l.saveEditorContent({ path: e.splitTabPath.value });
    else void l.saveEditorContent();
  }

  // Ctrl+Maj+F : onglet Fichiers, recherche dans le contenu.
  function rechercher(ev: KeyboardEvent): void {
    if (!settings.value?.enable_editor) return;
    if (!(mod(ev) && ev.shiftKey && (ev.key === "F" || ev.key === "f"))) return;
    ev.preventDefault();
    showEditor.value = true;
    e.showExplorer.value = true;
    s.git.explorerTab.value = "files";
    e.sandboxSearchMode.value = "content";
    void nextTick(() => {
      const champ = document.getElementById("elpis-file-search-input") as HTMLInputElement | null;
      if (champ) {
        champ.focus();
        champ.select();
      }
    });
  }

  // Raccourcis de l'éditeur ; Ctrl+W, Ctrl+Tab et Ctrl+T sont réservés par les navigateurs (d'où Alt+W, Alt+PgPréc/PgSuiv).
  function editeur(ev: KeyboardEvent): void {
    if (!settings.value?.enable_editor || !showEditor.value) return;
    const code = ev.code;
    if (mod(ev) && !ev.altKey && !ev.shiftKey && code === "Backquote") {
      ev.preventDefault();
      ev.stopPropagation();
      void r.basculerTerminal();
      return;
    }
    if (!focusDansEditeur()) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.closest?.(".xterm")) return;
    const dansChamp =
      !!ae &&
      (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable) &&
      !ae.closest?.(".monaco-editor");
    if (mod(ev) && ev.altKey && !ev.shiftKey && code === "KeyS") {
      ev.preventDefault();
      ev.stopPropagation();
      void r.toutEnregistrer();
      return;
    }
    if (mod(ev) && !ev.altKey && !ev.shiftKey && code === "KeyB" && !dansChamp) {
      ev.preventDefault();
      ev.stopPropagation();
      e.showExplorer.value = !e.showExplorer.value;
      return;
    }
    if (ev.altKey && !mod(ev) && !ev.shiftKey) {
      if (ae?.closest?.(".find-widget")) return;
      let traite = true;
      if (code === "KeyW") {
        if (activeTabPath.value) void l.closeTab(activeTabPath.value);
      } else if (code === "PageDown") cyclerOnglet(1);
      else if (code === "PageUp") cyclerOnglet(-1);
      else if (code === "KeyL") l.revealActiveInTree();
      else if (code === "ArrowLeft" && !dansChamp && !EST_MAC) void r.navArriere();
      else if (code === "ArrowRight" && !dansChamp && !EST_MAC) void r.navAvant();
      else traite = false;
      if (traite) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }
  }

  const ecoutes: Array<(ev: KeyboardEvent) => void> = [rouvrir, enregistrer, rechercher, editeur];
  for (const f of ecoutes) window.addEventListener("keydown", f, true);

  return {
    monacoConsumesEscape,
    libererRaccourcis(): void {
      for (const f of ecoutes) window.removeEventListener("keydown", f, true);
    },
  };
}
