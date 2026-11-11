// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/page-chat.test.ts — page de chat : domaines injectés (absence signalée, clés manquantes listées), en-tête, recherche, accueil et conteneur publiés, menu « / », envoi, sélecteur de modèle. */
/* eslint-disable vue/one-component-per-file -- composant sonde du test d'injection */
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import type { App, Component, InjectionKey } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import AccueilChat from "../../../src/components/chat/page/AccueilChat.vue";
import BoutonsEnvoi from "../../../src/components/chat/page/BoutonsEnvoi.vue";
import MenuSlash from "../../../src/components/chat/page/MenuSlash.vue";
import RechercheMessages from "../../../src/components/chat/page/RechercheMessages.vue";
import { CLES_DOMAINES } from "../../../src/features/chat/page/cles";
import {
  CLE_COMPOSEUR,
  CLE_CONVERSATION,
  CLE_ENTETE,
  clesAbsentes,
  domaine,
} from "../../../src/features/chat/page/domaines";

let app: App | null = null;
const appels: unknown[][] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
});

/** Domaine de test : état réactif, toute méthode inconnue est enregistrée. */
function etat<T extends object>(valeurs: Record<string, unknown>): T {
  const cible = reactive({ ...valeurs });
  return new Proxy(cible, {
    set(c, cle: string, valeur: unknown) {
      (c as Record<string, unknown>)[cle] = valeur;
      return true;
    },
    get(c, cle: string) {
      if (cle in c) return (c as Record<string, unknown>)[cle];
      return (...args: unknown[]) => {
        appels.push([cle, ...args]);
        return undefined;
      };
    },
  }) as unknown as T;
}

function monter(
  composant: Component,
  fournis: [InjectionKey<object>, object][],
  props: Record<string, unknown> = {},
): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(composant, props) });
  for (const [cle, valeur] of fournis) app.provide(cle, valeur);
  app.mount(hote);
  return hote;
}

describe("domaines injectés", () => {
  it("un domaine non fourni est une erreur de montage ; les clés absentes de la racine sont listées", () => {
    const Sonde = defineComponent({
      setup() {
        domaine(CLE_ENTETE);
        return () => null;
      },
    });
    const a = createApp(Sonde);
    a.config.warnHandler = () => {};
    let erreur = "";
    a.config.errorHandler = (e) => {
      erreur = String(e);
    };
    a.mount(document.createElement("div"));
    a.unmount();
    expect(erreur).toContain("domaine du chat non fourni");
    const racine = Object.fromEntries(Object.keys(CLES_DOMAINES.entete ?? {}).map((k) => [k, 1]));
    delete racine.openHelp;
    const absentes = clesAbsentes(racine);
    expect(absentes.entete).toEqual(["openHelp"]);
    expect(Object.keys(CLES_DOMAINES.liste ?? {})).toEqual(
      expect.arrayContaining(["visibleMessages", "settings"]),
    );
  });
});

describe("conversation", () => {
  it("recherche : Échap ferme et vide ; compteur affiché ; l'accueil publie l'hôte de la scène", async () => {
    const conv = etat<Record<string, unknown>>({
      messageSearchActive: true,
      messageSearch: "abc",
      messageSearchQ: "abc",
      messageSearchCount: 2,
      mascotteVisible: true,
      welcomeConfig: null,
      user: { username: "alice" },
      messages: [],
    });
    const hote = monter(RechercheMessages, [[CLE_CONVERSATION as InjectionKey<object>, conv]]);
    expect(hote.textContent).toContain("2 résultat(s)");
    (hote.querySelector("input") as HTMLInputElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape" }),
    );
    expect([conv.messageSearchActive, conv.messageSearch]).toEqual([false, ""]);
    app?.unmount();
    const publies: (HTMLElement | null)[] = [];
    const h2 = monter(AccueilChat, [[CLE_CONVERSATION as InjectionKey<object>, conv]], {
      onHote: (el: HTMLElement | null) => publies.push(el),
    });
    await nextTick();
    expect(h2.textContent).toContain("Bonjour alice");
    expect(publies.at(-1)?.classList.contains("accueil")).toBe(true);
    app?.unmount();
    app = null;
    expect(publies.at(-1)).toBeNull();
  });
});

describe("composeur", () => {
  it("menu « / » : rangées, clic → selectSlash, ligne active gardée visible", async () => {
    const comp = etat<Record<string, unknown>>({
      showSlash: true,
      slashLevel: "commands",
      slashList: [
        { name: "plan", label: "Mode plan", desc: "Préparer", icon: "ph-binoculars" },
        { name: "help", label: "Aide", desc: "Doc", icon: "ph-question" },
      ],
      slashIdx: 0,
      slashRaw: { name: "p" },
      slashHeaderIcon: "ph-terminal",
      slashHeaderLabel: "Commandes",
      slashRowKey: (item: { name: string }) => item.name,
      slashRowTitle: () => "",
      slashCmdOk: () => true,
      promptPreview: () => "",
    });
    const hote = monter(MenuSlash, [[CLE_COMPOSEUR as InjectionKey<object>, comp]]);
    const lignes = hote.querySelectorAll<HTMLElement>("li[data-slash-row]");
    expect(lignes).toHaveLength(2);
    expect(hote.textContent).toContain("/p");
    const liste = hote.querySelector("#slash-list") as HTMLElement;
    Object.defineProperty(liste, "clientHeight", { value: 20 });
    Object.defineProperty(lignes[1], "offsetTop", { value: 40 });
    Object.defineProperty(lignes[1], "offsetHeight", { value: 20 });
    comp.slashIdx = 1;
    await nextTick();
    await nextTick();
    expect(liste.scrollTop).toBe(40);
    lignes[1]?.click();
    expect(appels.at(-1)?.[0]).toBe("selectSlash");
  });

  it("envoi : Arrêter pendant le flux, Envoyer désactivé sans texte ni pièce jointe", async () => {
    const comp = etat<Record<string, unknown>>({
      isStreaming: true,
      imageMode: false,
      inputMessage: "",
      attachedFiles: [],
      noEngineAllowed: false,
    });
    const hote = monter(BoutonsEnvoi, [[CLE_COMPOSEUR as InjectionKey<object>, comp]]);
    expect(hote.querySelector('button[title="Arrêter la génération"]')).not.toBeNull();
    comp.isStreaming = false;
    await nextTick();
    const envoyer = hote.querySelector('button[aria-label="Envoyer le message"]') as HTMLButtonElement;
    expect(envoyer.disabled).toBe(true);
    comp.inputMessage = "Bonjour";
    await nextTick();
    expect(envoyer.disabled).toBe(false);
  });
});
