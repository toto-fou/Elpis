// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/menu-conversation.test.ts — menu « Conversation » identique dans l'en-tête, sur la rangée et au clic droit : entrées, flèches, Échap, F2, exécution sur une autre conversation. */
import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { CLE_CHROME } from "../../../src/app/racine/domaine";
import BarreLaterale from "../../../src/components/chat/page/BarreLaterale.vue";
import EnteteConversation from "../../../src/components/chat/page/EnteteConversation.vue";
import ChromeApp from "../../../src/components/racine/ChromeApp.vue";
import { executerConversation } from "../../../src/features/chat/page/conversation";
import type { ActionsConversation } from "../../../src/features/chat/page/conversation";
import { CLE_BARRE, CLE_ENTETE } from "../../../src/features/chat/page/domaines";
import { appels, appelsDe, barre, demonter, etat, monter, noms } from "./montage";

afterEach(demonter);

const cle = (k: InjectionKey<unknown>): InjectionKey<object> => k as InjectionKey<object>;
const ENTREES = ["Renommer… F2", "Rechercher", "Exporter", "Archiver", "Supprimer"];
const texte = (e: Element): string => (e.textContent ?? "").replace(/\s+/g, " ").trim();

function entete(extra: Record<string, unknown> = {}) {
  return etat({
    showSidebar: false,
    editingChatTitle: false,
    chatTitleDraft: "",
    currentChatId: "c1",
    currentChatTitle: "Migration",
    titleFlash: false,
    showChatMenu: false,
    messageSearchActive: false,
    messageSearch: "",
    ...extra,
  });
}

describe("exécution d'une action", () => {
  it("renommer, archiver, supprimer : directement ; rechercher et exporter : la conversation est ouverte d'abord", async () => {
    const d = etat<ActionsConversation>({
      currentChatId: "c1",
      messageSearchActive: false,
      messageSearch: "",
    });
    await executerConversation("renommer", { id: "c2", title: "Revue" }, d);
    await executerConversation("archiver", { id: "c2", title: "Revue" }, d);
    await executerConversation("rechercher", { id: "c1", title: "Migration" }, d);
    await executerConversation("exporter:pdf", { id: "c2", title: "Revue" }, d);
    expect(appels).toEqual([
      ["renameChat", "c2", "Revue"],
      ["archiveChat", "c2"],
      ["loadChat", "c2"],
      ["exportChatAs", "pdf"],
    ]);
    expect(d.messageSearchActive).toBe(true);
  });
});

describe("en-tête", () => {
  it("⋯ « Conversation » : role=menu, focus sur la première entrée, flèches, Exporter déplié sur place", async () => {
    const ent = entete();
    const hote = monter(EnteteConversation, [[cle(CLE_ENTETE), ent]]);
    const bouton = hote.querySelector("[data-menu-conversation]") as HTMLButtonElement;
    expect(bouton.getAttribute("aria-label")).toBe("Conversation");
    bouton.click();
    await nextTick();
    await nextTick();
    const menu = hote.querySelector('[role="menu"]') as HTMLElement;
    const items = () => [...menu.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    expect(items().map(texte)).toEqual(ENTREES);
    expect(document.activeElement).toBe(items()[0]);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(items()[4]);
    items()[2]?.click();
    await nextTick();
    expect(items().map(texte)).toEqual([
      "Renommer… F2",
      "Rechercher",
      "Exporter",
      "Markdown",
      "JSON",
      "Texte brut",
      "PDF",
      "Archiver",
      "Supprimer",
    ]);
    (menu.querySelector('[data-conv-export="md"]') as HTMLElement).click();
    await nextTick();
    expect(appelsDe("exportChatAs")).toEqual([["md"]]);
    expect(ent.showChatMenu).toBe(false);
  });

  it("Échap ferme et rend le focus au bouton ; F2 renomme ; pas de menu sans conversation", async () => {
    const ent = entete({ showChatMenu: true });
    const hote = monter(EnteteConversation, [[cle(CLE_ENTETE), ent]]);
    await nextTick();
    const menu = hote.querySelector('[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    expect(appelsDe("renameChat")).toEqual([["c1", "Migration"]]);
    ent.showChatMenu = true;
    await nextTick();
    (hote.querySelector('[role="menu"]') as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await nextTick();
    expect(ent.showChatMenu).toBe(false);
    expect(document.activeElement).toBe(hote.querySelector("[data-menu-conversation]"));
    demonter();
    const vide = monter(EnteteConversation, [[cle(CLE_ENTETE), entete({ currentChatId: null })]]);
    expect(vide.querySelector("[data-menu-conversation]")).toBeNull();
  });
});

function chrome(item: Record<string, unknown>) {
  return etat({
    systemAlert: "",
    announcerText: "",
    announcerAssertive: false,
    toasts: [],
    modalState: { isOpen: false },
    contextMenu: { isOpen: true, x: 10, y: 10, type: "chat", item },
  });
}

describe("clic droit et rangée", () => {
  it("même menu que l'en-tête ; archiver passe par la racine, exporter ouvre puis exporte", async () => {
    const c = chrome({ id: "c2", title: "Revue" });
    const conv = entete();
    const hote = monter(ChromeApp, [
      [cle(CLE_CHROME), c],
      [cle(CLE_ENTETE), conv],
    ]);
    const menu = hote.querySelector("#custom-context-menu") ?? document.getElementById("custom-context-menu");
    const items = [...(menu as HTMLElement).querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    expect(items.map(texte)).toEqual(ENTREES);
    items[3]?.click();
    items[2]?.click();
    await nextTick();
    ((menu as HTMLElement).querySelector('[data-conv-export="json"]') as HTMLElement).click();
    await nextTick();
    await nextTick();
    expect(appelsDe("handleContextAction")).toEqual([["archive"], ["fermer"]]);
    expect(appelsDe("loadChat")).toEqual([["c2"]]);
    expect(appelsDe("exportChatAs")).toEqual([["json"]]);
  });

  it("F2 sur une rangée du volet renomme cette conversation", () => {
    const hote = monter(BarreLaterale, [[cle(CLE_BARRE), barre()]]);
    const titre = hote.querySelectorAll("[data-chat-open]")[1] as HTMLElement;
    titre.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    expect(noms()).toEqual(["renameChat"]);
    expect(appelsDe("renameChat")).toEqual([["c2", "Revue PR"]]);
  });
});
