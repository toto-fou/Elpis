// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/composeur/depot.ts — pièces jointes du chat : glisser-déposer de fichiers du système (verrou partagé avec l'arbre de l'éditeur), sélecteur de fichiers, lecture texte ou image, plafonds. */
import type * as Vue from "vue";
import type { Ref } from "vue";

import { depotDejaTraite } from "../../../utils/depot.ts";
import type { PieceJointe } from "./composeur";

export interface RefsDepot {
  attachedFiles: Ref<PieceJointe[]>;
}

export interface CtxDepot {
  showToast(message: string, type?: string): void;
  readonly fileInput?: Ref<HTMLInputElement | null> | null;
}

export interface DepotChat {
  chatDragOver: Ref<boolean>;
  handleChatDragEnter(e: DragEvent): void;
  handleChatDragOver(e: DragEvent): void;
  handleChatDragLeave(e: DragEvent): void;
  handleChatDrop(e: DragEvent): void;
  triggerFileUpload(): void;
  handleFileUpload(e: { target: { files?: ArrayLike<File> | null } }): void;
  removeAttachedFile(index: number): void;
}

export const MAX_FICHIERS = 10;
const MAX_TEXTE = 5 * 1024 * 1024;
const MAX_IMAGE = 15 * 1024 * 1024;
const CAPTURES = [".pcap", ".pcapng", ".cap"];

function estCapture(nom: string): boolean {
  const point = nom.lastIndexOf(".");
  return point >= 0 && CAPTURES.includes(nom.substring(point).toLowerCase());
}

function contientFichiers(e: DragEvent): boolean {
  try {
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes("Files");
  } catch {
    return false;
  }
}

// Un dépôt de texte sur une zone éditable garde le comportement natif.
function cibleEditable(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t || !t.tagName) return false;
  return t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable === true;
}

/** Même contrat que l'ancien `setupChatDnd(vue, refs, ctx)` de chat/_dnd.js. */
export function creerDepotChat(vue: Pick<typeof Vue, "ref">, refs: RefsDepot, ctx: CtxDepot): DepotChat {
  const { ref } = vue;
  const { attachedFiles } = refs;
  const { showToast } = ctx;
  const chatDragOver = ref(false);
  let compteur = 0;
  let sequence = 0;

  function viderSelecteur(): void {
    if (ctx.fileInput?.value) ctx.fileInput.value.value = "";
  }

  function handleChatDragEnter(e: DragEvent): void {
    if (!contientFichiers(e)) return;
    e.preventDefault();
    compteur++;
    chatDragOver.value = true;
  }

  function handleChatDragOver(e: DragEvent): void {
    const fichiers = contientFichiers(e);
    if (fichiers || !cibleEditable(e)) e.preventDefault();
    if (!fichiers) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    chatDragOver.value = true;
  }

  function handleChatDragLeave(e: DragEvent): void {
    if (!contientFichiers(e)) return;
    compteur = Math.max(0, compteur - 1);
    if (compteur === 0) chatDragOver.value = false;
  }

  function handleChatDrop(e: DragEvent): void {
    const files = e.dataTransfer?.files;
    const avecFichiers = !!(files && files.length);
    if (avecFichiers || !cibleEditable(e)) e.preventDefault();
    compteur = 0;
    chatDragOver.value = false;
    // Dépôt déjà traité par l'arbre de l'éditeur dans les 200 ms : pas de double envoi.
    if (depotDejaTraite(200)) return;
    if (!avecFichiers || !files) return;
    handleFileUpload({ target: { files } });
  }

  function triggerFileUpload(): void {
    ctx.fileInput?.value?.click();
  }

  function refuserTaille(f: File, limite: number): void {
    const mo = Math.round((f.size || 0) / (1024 * 1024));
    showToast(`${f.name} (${mo} Mo) dépasse la limite (${Math.round(limite / (1024 * 1024))} Mo)`, "warning");
  }

  // Une lecture terminée après un changement de conversation (liste remplacée) n'ajoute rien.
  function ajouter(proprietaire: PieceJointe[], item: PieceJointe & Record<string, unknown>): void {
    if (attachedFiles.value !== proprietaire) return;
    if (proprietaire.length >= MAX_FICHIERS) {
      showToast("Maximum " + MAX_FICHIERS + " fichiers atteint", "warning");
      return;
    }
    item._uid = ++sequence;
    proprietaire.push(item);
  }

  function handleFileUpload(e: { target: { files?: ArrayLike<File> | null } }): void {
    const files = Array.from(e.target.files || []).filter((f) => {
      if (!estCapture(f.name)) return true;
      showToast(f.name + " : captures réseau non prises en charge", "warning");
      return false;
    });
    if (!files.length) {
      viderSelecteur();
      return;
    }
    const restant = MAX_FICHIERS - attachedFiles.value.length;
    if (restant <= 0) {
      showToast("Maximum 10 fichiers atteint", "warning");
      viderSelecteur();
      return;
    }
    if (files.length > restant)
      showToast(`${files.length - restant} fichier(s) ignoré(s) (max ${MAX_FICHIERS})`, "warning");
    const proprietaire = attachedFiles.value;
    for (const f of files.slice(0, restant)) {
      const image = f.type.startsWith("image/");
      if (f.size > (image ? MAX_IMAGE : MAX_TEXTE)) {
        refuserTaille(f, image ? MAX_IMAGE : MAX_TEXTE);
        continue;
      }
      const lecteur = new FileReader();
      lecteur.onload = () => {
        const content = lecteur.result as string;
        ajouter(
          proprietaire,
          image
            ? { name: f.name, content, isImage: true, mimeType: f.type, fichier: f }
            : { name: f.name, content, fichier: f },
        );
      };
      if (image) lecteur.readAsDataURL(f);
      else lecteur.readAsText(f);
    }
    viderSelecteur();
  }

  function removeAttachedFile(index: number): void {
    attachedFiles.value.splice(index, 1);
  }

  return {
    chatDragOver,
    handleChatDragEnter,
    handleChatDragOver,
    handleChatDragLeave,
    handleChatDrop,
    triggerFileUpload,
    handleFileUpload,
    removeAttachedFile,
  };
}
