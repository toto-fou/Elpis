// SPDX-License-Identifier: MIT
/** frontend/test/chat/composeur/depot.test.ts — pièces jointes : captures réseau refusées sans prendre de place, texte et image lus, plafond de dix, lecture tardive après changement de chat ignorée, glisser-déposer. */
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PieceJointe } from "../../../src/features/chat/composeur/composeur";
import { creerDepotChat, MAX_FICHIERS } from "../../../src/features/chat/composeur/depot";
import { marquerDepotTraite } from "../../../src/utils/depot";

class FauxLecteur {
  static enAttente: FauxLecteur[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  readAsText(f: File): void {
    this.result = "texte de " + f.name;
    FauxLecteur.enAttente.push(this);
  }
  readAsDataURL(f: File): void {
    this.result = "data:" + f.name;
    FauxLecteur.enAttente.push(this);
  }
  static terminer(): void {
    for (const l of FauxLecteur.enAttente.splice(0)) l.onload?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function monter(deja: PieceJointe[] = []) {
  vi.stubGlobal("FileReader", FauxLecteur);
  const toasts: string[] = [];
  const attachedFiles = ref<PieceJointe[]>(deja);
  const entree = document.createElement("input");
  entree.type = "text";
  entree.value = "x";
  const d = creerDepotChat(
    { ref },
    { attachedFiles },
    { showToast: (m) => toasts.push(m), fileInput: ref(entree) },
  );
  return { d, attachedFiles, toasts, entree };
}

const fichier = (name: string, type = "text/plain", size = 10): File =>
  ({ name, type, size }) as unknown as File;

describe("dépôt de fichiers", () => {
  it("une capture réseau est refusée avec un message et ne consomme pas de place", () => {
    const { d, attachedFiles, toasts, entree } = monter();
    d.handleFileUpload({ target: { files: [fichier("trafic.pcapng", "application/octet-stream")] } });
    expect(attachedFiles.value).toHaveLength(0);
    expect(toasts.some((m) => m.includes("trafic.pcapng") && m.includes("captures réseau"))).toBe(true);
    expect(entree.value).toBe("");
    const lot = [fichier("a.cap"), ...Array.from({ length: 10 }, (_, i) => fichier("f" + i + ".txt"))];
    d.handleFileUpload({ target: { files: lot } });
    FauxLecteur.terminer();
    expect(attachedFiles.value.map((x) => x.name)).toHaveLength(MAX_FICHIERS);
    expect(attachedFiles.value.some((x) => x.name === "a.cap")).toBe(false);
  });

  it("texte et image restent joints ; trop gros refusé ; lecture finie après changement de chat ignorée", () => {
    const { d, attachedFiles, toasts } = monter();
    d.handleFileUpload({
      target: {
        files: [
          fichier("n.md"),
          fichier("p.png", "image/png"),
          fichier("g.png", "image/png", 16 * 1024 * 1024),
        ],
      },
    });
    FauxLecteur.terminer();
    expect(attachedFiles.value.map((x) => [x.content, !!x.isImage])).toEqual([
      ["texte de n.md", false],
      ["data:p.png", true],
    ]);
    expect(toasts.some((m) => m.includes("g.png") && m.includes("15 Mo"))).toBe(true);
    d.handleFileUpload({ target: { files: [fichier("tard.txt")] } });
    attachedFiles.value = [];
    FauxLecteur.terminer();
    expect(attachedFiles.value).toEqual([]);
  });

  it("glisser-déposer : voile sur un glisser de fichiers, compteur d'entrées, verrou de l'arbre", () => {
    const { d, attachedFiles } = monter();
    const evt = (types: string[], files: File[] = []) =>
      ({
        dataTransfer: { types, files, dropEffect: "" },
        target: document.body,
        preventDefault: vi.fn(),
      }) as unknown as DragEvent;
    d.handleChatDragEnter(evt(["text/plain"]));
    expect(d.chatDragOver.value).toBe(false);
    d.handleChatDragEnter(evt(["Files"]));
    d.handleChatDragEnter(evt(["Files"]));
    d.handleChatDragLeave(evt(["Files"]));
    expect(d.chatDragOver.value).toBe(true);
    d.handleChatDragLeave(evt(["Files"]));
    expect(d.chatDragOver.value).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    marquerDepotTraite();
    d.handleChatDrop(evt(["Files"], [fichier("a.txt")]));
    FauxLecteur.terminer();
    expect(attachedFiles.value).toHaveLength(0);
    vi.advanceTimersByTime(300);
    d.handleChatDrop(evt(["Files"], [fichier("a.txt")]));
    vi.useRealTimers();
    FauxLecteur.terminer();
    expect(attachedFiles.value.map((x) => x.name)).toEqual(["a.txt"]);
  });
});
