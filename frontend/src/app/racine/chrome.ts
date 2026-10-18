// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/chrome.ts — couche commune à toutes les vues : toasts, annonces aux lecteurs d'écran, fenêtre de confirmation, de saisie ou de choix, menu contextuel. */
import { nextTick, ref } from "vue";
import type { Ref } from "vue";

import { gardeFocus, piegerTab } from "../../utils/focus";

export interface OptionsToast {
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
  onExpire?: () => void;
}

export interface Toast {
  id: number;
  message: string;
  type: string;
  actionLabel?: string;
  onAction?: () => void;
  onExpire?: () => void;
  _timer?: ReturnType<typeof setTimeout>;
}

export interface ChoixFenetre {
  id: string;
  label: string;
  tone?: "primary" | "danger" | "neutral" | string;
}

type Resolution = (v: string | boolean | null) => void;

export interface EtatFenetre {
  isOpen: boolean;
  type: "confirm" | "prompt" | "choice";
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  isDanger: boolean;
  inputValue: string;
  placeholder: string;
  requireText?: string;
  choices?: ChoixFenetre[];
  resolve: Resolution | null;
}

export interface MenuContextuel {
  isOpen: boolean;
  x: number;
  y: number;
  type: string;
  item: ElementMenu | null;
}

export interface ElementMenu {
  id?: string;
  title?: string;
  path?: string;
  [cle: string]: unknown;
}

const fenetreFermee = (): EtatFenetre => ({
  isOpen: false,
  type: "confirm",
  title: "",
  message: "",
  confirmLabel: "Confirmer",
  cancelLabel: "Annuler",
  isDanger: false,
  inputValue: "",
  placeholder: "",
  resolve: null,
});

export function creerToasts() {
  const toasts = ref<Toast[]>([]);

  /** Deux toasts identiques sans action ne s'empilent pas : le premier est prolongé. */
  function showToast(message: string, type?: string, opts: OptionsToast = {}): number {
    const genre = type || "success";
    const duree = typeof opts.duration === "number" ? opts.duration : 4000;
    if (!opts.actionLabel && !opts.onExpire) {
      const meme = toasts.value.find(
        (x) => x.message === message && x.type === genre && !x.actionLabel && !x.onExpire,
      );
      if (meme) {
        if (meme._timer) clearTimeout(meme._timer);
        meme._timer = setTimeout(() => {
          toasts.value = toasts.value.filter((x) => x.id !== meme.id);
        }, duree);
        return meme.id;
      }
    }
    const id = Date.now() + Math.random();
    const toast: Toast = { id, message, type: genre };
    if (opts.actionLabel && typeof opts.onAction === "function") {
      toast.actionLabel = opts.actionLabel;
      toast.onAction = opts.onAction;
    }
    if (typeof opts.onExpire === "function") toast.onExpire = opts.onExpire;
    toasts.value.push(toast);
    toast._timer = setTimeout(() => {
      const t = toasts.value.find((x) => x.id === id);
      toasts.value = toasts.value.filter((x) => x.id !== id);
      if (t?.onExpire) {
        try {
          t.onExpire();
        } catch {
          /* rappel d'expiration fautif : le toast part quand même */
        }
      }
    }, duree);
    return id;
  }

  function removeToast(id: number, avecExpiration?: boolean): void {
    const t = toasts.value.find((x) => x.id === id);
    if (t?._timer) clearTimeout(t._timer);
    toasts.value = toasts.value.filter((x) => x.id !== id);
    if (avecExpiration && t?.onExpire) {
      try {
        t.onExpire();
      } catch {
        /* rappel d'expiration fautif */
      }
    }
  }

  return { toasts, showToast, removeToast };
}

/** Région sr-only unique : annonce les événements sans interface dédiée (fin de génération, choix de modèle…). */
export function creerAnnonceur() {
  const announcerText = ref("");
  const announcerAssertive = ref(false);
  let minuterie: ReturnType<typeof setTimeout> | null = null;
  function announce(message: unknown, assertif?: boolean): void {
    announcerAssertive.value = !!assertif;
    // Vider puis remplir au tick suivant : le même texte annoncé deux fois est relu.
    announcerText.value = "";
    if (minuterie) clearTimeout(minuterie);
    minuterie = setTimeout(() => {
      announcerText.value = String(message || "");
    }, 30);
  }
  return { announcerText, announcerAssertive, announce };
}

export function creerFenetre() {
  const modalState = ref<EtatFenetre>(fenetreFermee());
  const modalInputRef: Ref<HTMLInputElement | null> = ref(null);
  const modalDialogRef: Ref<HTMLElement | null> = ref(null);
  const modalCancelRef: Ref<HTMLButtonElement | null> = ref(null);
  const garde = gardeFocus();

  function onModalTabKey(e: KeyboardEvent): void {
    piegerTab(e, modalDialogRef.value);
  }

  function ouvrir(etat: Partial<EtatFenetre>, focus: Ref<HTMLElement | null>): void {
    garde.remember();
    modalState.value = { ...fenetreFermee(), ...etat, isOpen: true };
    void nextTick(() => focus.value?.focus());
  }

  function openConfirm(
    title: string,
    message?: string,
    isDanger?: boolean,
    confirmLabel?: string,
    cancelLabel?: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      ouvrir(
        {
          title,
          message: message || "",
          isDanger: !!isDanger,
          confirmLabel: confirmLabel || (isDanger ? "Supprimer" : "Confirmer"),
          cancelLabel: cancelLabel || "Annuler",
          resolve: (v) => resolve(v === true),
        },
        modalCancelRef,
      );
    });
  }

  function openPrompt(title: string, defaultValue?: string, placeholder?: string): Promise<string | null> {
    return new Promise((resolve) => {
      ouvrir(
        {
          type: "prompt",
          title,
          confirmLabel: "Valider",
          inputValue: defaultValue || "",
          placeholder: placeholder || "",
          resolve: (v) => resolve(typeof v === "string" ? v : null),
        },
        modalInputRef,
      );
    });
  }

  /** Choix à plus de deux issues ; rend l'identifiant choisi, ou null (Annuler, Échap, clic dehors). */
  function openChoice(
    title: string,
    message: string,
    choices: readonly ChoixFenetre[],
    cancelLabel?: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      ouvrir(
        {
          type: "choice",
          title,
          message: message || "",
          confirmLabel: "",
          cancelLabel: cancelLabel || "Annuler",
          choices: Array.isArray(choices) ? [...choices] : [],
          resolve: (v) => resolve(typeof v === "string" && v ? v : null),
        },
        modalCancelRef,
      );
    });
  }

  /** Confirmation saisie pour l'irréversible : le bouton ne s'active qu'une fois `word` recopié. */
  function openTypedConfirm(
    title: string,
    message: string,
    word: string,
    confirmLabel?: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      ouvrir(
        {
          title,
          message: message || "",
          confirmLabel: confirmLabel || "Confirmer",
          isDanger: true,
          requireText: word,
          resolve: (v) => resolve(v === true),
        },
        modalInputRef,
      );
    });
  }

  function modalTypedBlocked(): boolean {
    const m = modalState.value;
    if (!m.requireText) return false;
    return (
      String(m.inputValue || "")
        .trim()
        .toLowerCase() !== String(m.requireText).toLowerCase()
    );
  }

  function fermer(valeur: string | boolean | null): void {
    const m = modalState.value;
    m.resolve?.(valeur);
    m.isOpen = false;
    garde.restore();
  }

  function handleModalChoice(id: string): void {
    if (!modalState.value.isOpen || !modalState.value.resolve) return;
    fermer(id);
  }

  function handleModalSubmit(): void {
    const m = modalState.value;
    if (!m.isOpen || !m.resolve) return;
    if (modalTypedBlocked()) return;
    fermer(m.type === "prompt" ? m.inputValue || null : true);
  }

  function handleModalCancel(): void {
    fermer(false);
  }

  return {
    modalState,
    modalInputRef,
    modalDialogRef,
    modalCancelRef,
    onModalTabKey,
    openConfirm,
    openPrompt,
    openChoice,
    openTypedConfirm,
    modalTypedBlocked,
    handleModalChoice,
    handleModalSubmit,
    handleModalCancel,
  };
}

export function creerMenuContextuel() {
  const contextMenu = ref<MenuContextuel>({ isOpen: false, x: 0, y: 0, type: "", item: null });
  const garde = gardeFocus();

  const itemsMenu = (): HTMLElement[] => {
    const menu = document.getElementById("custom-context-menu");
    return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
  };

  /** Ouvert au clic droit, ou au clavier depuis un bouton « … » (position de la ligne quand l'événement n'en a pas). */
  function openContextMenu(event: MouseEvent | KeyboardEvent, type: string, item: ElementMenu | null): void {
    let cx = "clientX" in event ? event.clientX : 0;
    let cy = "clientY" in event ? event.clientY : 0;
    const declencheur = event.currentTarget instanceof Element ? event.currentTarget : null;
    if (!cx && !cy && declencheur) {
      const r = declencheur.getBoundingClientRect();
      cx = r.left;
      cy = r.bottom;
    }
    const x = Math.min(cx, window.innerWidth - 210);
    // Hauteur réelle du menu de fichier (une dizaine d'entrées) : il ne déborde pas du bas.
    const y = Math.max(8, Math.min(cy, window.innerHeight - (type === "chat" ? 230 : 360)));
    contextMenu.value = { isOpen: true, x, y, type, item };
    garde.remember();
    void nextTick(() => itemsMenu()[0]?.focus());
  }

  function closeContextMenu(): void {
    contextMenu.value.isOpen = false;
    garde.restore();
  }

  /** Flèches, Début et Fin entre les entrées ; Échap passe par la cascade globale. */
  function onContextMenuKeydown(e: KeyboardEvent): void {
    if (!contextMenu.value.isOpen) return;
    const items = itemsMenu();
    if (items.length === 0) return;
    const cur = items.indexOf(document.activeElement as HTMLElement);
    let cible: HTMLElement | undefined;
    if (e.key === "ArrowDown") cible = items[(cur + 1 + items.length) % items.length];
    else if (e.key === "ArrowUp") cible = items[(cur - 1 + items.length) % items.length];
    else if (e.key === "Home") cible = items[0];
    else if (e.key === "End") cible = items[items.length - 1];
    else return;
    e.preventDefault();
    cible?.focus();
  }

  return { contextMenu, openContextMenu, closeContextMenu, onContextMenuKeydown };
}
