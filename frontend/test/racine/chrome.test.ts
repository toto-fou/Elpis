// SPDX-License-Identifier: MIT
/** frontend/test/racine/chrome.test.ts — couche commune de la racine : toasts (fusion des doublons), fenêtre de confirmation, de saisie et de choix, menu contextuel au clavier. */
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerAnnonceur, creerFenetre, creerMenuContextuel, creerToasts } from "../../src/app/racine/chrome";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("toasts", () => {
  it("deux toasts identiques : un seul, prolongé", () => {
    const t = creerToasts();
    const a = t.showToast("Sauvegardé !");
    vi.advanceTimersByTime(3000);
    const b = t.showToast("Sauvegardé !");
    expect(a).toBe(b);
    expect(t.toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(t.toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(t.toasts.value).toHaveLength(0);
  });

  it("une erreur reste jusqu'à sa fermeture, une durée explicite reste respectée", () => {
    const t = creerToasts();
    const id = t.showToast("Enregistrement refusé", "error");
    t.showToast("Court", "error", { duration: 1000 });
    vi.advanceTimersByTime(60_000);
    expect(t.toasts.value.map((x) => x.message)).toEqual(["Enregistrement refusé"]);
    t.removeToast(id);
    expect(t.toasts.value).toHaveLength(0);
  });

  it("les erreurs persistantes sont plafonnées et fusionnées quand elles sont identiques", () => {
    const t = creerToasts();
    t.showToast("Identique", "error");
    t.showToast("Identique", "error");
    expect(t.toasts.value).toHaveLength(1);
    for (let i = 0; i < 8; i++) t.showToast("Erreur " + i, "error");
    expect(t.toasts.value.length).toBeLessThanOrEqual(5);
    expect(t.toasts.value.at(-1)?.message).toBe("Erreur 7");
  });

  it("texte ou type différent : deux toasts", () => {
    const t = creerToasts();
    t.showToast("Sauvegardé !");
    t.showToast("Sauvegardé !", "error");
    t.showToast("Autre");
    expect(t.toasts.value).toHaveLength(3);
  });

  it("un toast avec action ou rappel n'est jamais fusionné", () => {
    const t = creerToasts();
    t.showToast("Conversation supprimée", "success", { actionLabel: "Annuler", onAction() {} });
    t.showToast("Conversation supprimée", "success", { actionLabel: "Annuler", onAction() {} });
    t.showToast("X", "success", { onExpire() {} });
    t.showToast("X", "success", { onExpire() {} });
    expect(t.toasts.value).toHaveLength(4);
  });

  it("après expiration, un nouveau toast identique réapparaît ; le rappel d'expiration est joué", () => {
    const t = creerToasts();
    const expire = vi.fn();
    t.showToast("Sauvegardé !");
    vi.advanceTimersByTime(4000);
    expect(t.toasts.value).toHaveLength(0);
    t.showToast("Sauvegardé !");
    expect(t.toasts.value).toHaveLength(1);
    const id = t.showToast("Supprimé", "success", { onExpire: expire });
    t.removeToast(id, true);
    expect(expire).toHaveBeenCalledOnce();
  });
});

describe("annonceur", () => {
  it("vide puis remplit au tick suivant (même texte relu)", () => {
    const a = creerAnnonceur();
    a.announce("Réponse prête", true);
    expect(a.announcerText.value).toBe("");
    expect(a.announcerAssertive.value).toBe(true);
    vi.advanceTimersByTime(30);
    expect(a.announcerText.value).toBe("Réponse prête");
  });
});

describe("fenêtre", () => {
  it("confirmation : vrai à la validation, faux à l'annulation", async () => {
    const f = creerFenetre();
    const p = f.openConfirm("Supprimer ?", "", true);
    expect(f.modalState.value.confirmLabel).toBe("Supprimer");
    f.handleModalSubmit();
    expect(await p).toBe(true);
    const q = f.openConfirm("Encore ?");
    f.handleModalCancel();
    expect(await q).toBe(false);
    expect(f.modalState.value.isOpen).toBe(false);
  });

  it("saisie : la valeur, ou null à l'annulation", async () => {
    const f = creerFenetre();
    const p = f.openPrompt("Nom", "a.txt");
    f.modalState.value.inputValue = "b.txt";
    f.handleModalSubmit();
    expect(await p).toBe("b.txt");
    const q = f.openPrompt("Nom");
    f.handleModalCancel();
    expect(await q).toBeNull();
  });

  it("choix : l'identifiant, ou null ; confirmation saisie bloquée tant que le mot n'est pas recopié", async () => {
    const f = creerFenetre();
    const p = f.openChoice("Fermer", "", [{ id: "save", label: "Enregistrer", tone: "primary" }]);
    f.handleModalChoice("save");
    expect(await p).toBe("save");
    const q = f.openTypedConfirm("Purger", "", "PURGER");
    f.handleModalSubmit();
    expect(f.modalState.value.isOpen).toBe(true);
    f.modalState.value.inputValue = " purger ";
    expect(f.modalTypedBlocked()).toBe(false);
    f.handleModalSubmit();
    expect(await q).toBe(true);
  });
});

describe("menu contextuel", () => {
  it("borné à la fenêtre, focus sur la première entrée, flèches et Fin", async () => {
    document.body.innerHTML =
      '<div id="custom-context-menu"><button role="menuitem">a</button><button role="menuitem">b</button><button role="menuitem">c</button></div>';
    const m = creerMenuContextuel();
    m.openContextMenu(new MouseEvent("contextmenu", { clientX: 99999, clientY: 99999 }), "file", {
      path: "x",
    });
    expect(m.contextMenu.value.x).toBe(window.innerWidth - 210);
    expect(m.contextMenu.value.y).toBe(window.innerHeight - 360);
    await nextTick();
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    m.onContextMenuKeydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.activeElement).toBe(items[1]);
    m.onContextMenuKeydown(new KeyboardEvent("keydown", { key: "End" }));
    expect(document.activeElement).toBe(items[2]);
    m.closeContextMenu();
    expect(m.contextMenu.value.isOpen).toBe(false);
  });
});
