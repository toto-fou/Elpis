// SPDX-License-Identifier: MIT
/** frontend/test/racine/chrome.test.ts — couche commune de la racine : toasts (fusion des doublons, pause au survol et au focus), fenêtre de confirmation, de saisie et de choix, menu contextuel au clavier. */
import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerAnnonceur, creerFenetre, creerMenuContextuel, creerToasts } from "../../src/app/racine/chrome";
import { CLE_CHROME } from "../../src/app/racine/domaine";
import ChromeApp from "../../src/components/racine/ChromeApp.vue";
import { appelsDe, demonter, etat, monter } from "../chat/page/montage";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  demonter();
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

  it("en pause au survol ou au focus, un toast « Annuler » ne part pas ; il repart pour le temps qui restait", () => {
    const t = creerToasts();
    const expire = vi.fn();
    const id = t.showToast("Supprimée", "success", {
      actionLabel: "Annuler",
      onAction() {},
      onExpire: expire,
    });
    vi.advanceTimersByTime(1500);
    t.pauseToast(id);
    vi.advanceTimersByTime(60_000);
    expect(t.toasts.value).toHaveLength(1);
    t.reprendreToast(id);
    vi.advanceTimersByTime(2400);
    expect(t.toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(t.toasts.value).toHaveLength(0);
    expect(expire).toHaveBeenCalledOnce();
  });

  it("le toast affiché se met en pause au focus de ses boutons et reprend quand le focus le quitte", () => {
    const toast = { id: 7, message: "Supprimée", type: "success", actionLabel: "Annuler", onAction() {} };
    monter(ChromeApp, [
      [
        CLE_CHROME as InjectionKey<object>,
        etat({
          systemAlert: "",
          announcerText: "",
          announcerAssertive: false,
          toasts: [toast],
          modalState: { isOpen: false },
          contextMenu: { isOpen: false, x: 0, y: 0, type: "", item: null },
        }),
      ],
    ]);
    const [annuler, fermer] = [...document.querySelectorAll<HTMLButtonElement>(".elpis-toast button")];
    annuler?.focus();
    expect(appelsDe("pauseToast")).toEqual([[7]]);
    fermer?.focus();
    vi.advanceTimersByTime(20);
    expect(appelsDe("reprendreToast")).toEqual([]);
    fermer?.blur();
    vi.advanceTimersByTime(20);
    expect(appelsDe("reprendreToast")).toEqual([[7]]);
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

  it("un toast à clé est mis à jour sur place, durée relancée, seul le dernier rappel joue", () => {
    const t = creerToasts();
    const premier = vi.fn();
    const dernier = vi.fn();
    const a = t.showToast("Enregistré", "success", { cle: "k", duration: 6000, onExpire: premier });
    vi.advanceTimersByTime(5000);
    const action = vi.fn();
    const b = t.showToast("Enregistré", "success", {
      cle: "k",
      duration: 6000,
      actionLabel: "Annuler",
      onAction: action,
      onExpire: dernier,
    });
    expect(b).toBe(a);
    expect(t.toasts.value).toHaveLength(1);
    expect(t.toasts.value[0]?.actionLabel).toBe("Annuler");
    vi.advanceTimersByTime(5000);
    expect(t.toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(t.toasts.value).toHaveLength(0);
    expect(premier).not.toHaveBeenCalled();
    expect(dernier).toHaveBeenCalledOnce();
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

  it("confirmation : un texte arrivé après l'ouverture remplace le message et libère la validation, jamais après la fermeture ni sur une autre fenêtre", async () => {
    const f = creerFenetre();
    let arrivee: (t: string) => void = () => {};
    const p = f.openConfirm(
      "Supprimer ?",
      "Vous pourrez annuler.",
      true,
      undefined,
      undefined,
      new Promise((r) => (arrivee = r)),
    );
    expect(f.modalState.value.message).toBe("Vous pourrez annuler.");
    // Validation retenue tant que l'information n'est pas arrivée : ni clic ni Entrée ne confirment.
    expect(f.modalTypedBlocked()).toBe(true);
    f.handleModalSubmit();
    expect(f.modalState.value.isOpen).toBe(true);
    arrivee("2 tâches de fond seront arrêtées.");
    await vi.waitFor(() => expect(f.modalTypedBlocked()).toBe(false));
    expect(f.modalState.value.message).toBe("2 tâches de fond seront arrêtées.");
    f.handleModalSubmit();
    expect(await p).toBe(true);
    const vide = f.openConfirm("Vide ?", "garde", true, undefined, undefined, Promise.resolve(""));
    await vi.waitFor(() => expect(f.modalTypedBlocked()).toBe(false));
    expect(f.modalState.value.message).toBe("garde");
    f.handleModalCancel();
    expect(await vide).toBe(false);
    let tardif: (t: string) => void = () => {};
    const q = f.openConfirm("A ?", "a", false, undefined, undefined, new Promise((r) => (tardif = r)));
    f.handleModalCancel();
    expect(await q).toBe(false);
    const r = f.openConfirm("B ?", "b");
    tardif("texte de A");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.modalState.value.message).toBe("b");
    expect(f.modalTypedBlocked()).toBe(false);
    f.handleModalCancel();
    await r;
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
