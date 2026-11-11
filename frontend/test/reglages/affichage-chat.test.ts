// SPDX-License-Identifier: MIT
/** frontend/test/reglages/affichage-chat.test.ts — préférences d'affichage du chat : lecture normalisée, compatibilité de « Masquer le raisonnement », domaine injecté, classe de densité, liste de l'écran. */
/* eslint-disable vue/one-component-per-file -- racine et enfant sonde du test d'injection */
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLASSE_FIL_COMPACT,
  CONTEXTES,
  DENSITES,
  DEROULES,
  fournirPreferencesChat,
  lirePreferencesChat,
  METRIQUES,
  PREFERENCES_PAR_DEFAUT,
  preferencesChat,
  REFLEXIONS,
  REGLAGES_AFFICHAGE,
} from "../../src/features/reglages/affichage-chat";
import type { PreferencesChat } from "../../src/features/reglages/affichage-chat";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.className = "";
});

/** Monte une racine qui fournit (ou non) les préférences et un enfant qui les lit. */
function monter(reglages: Record<string, unknown>, fournir = true): () => PreferencesChat {
  let lu: PreferencesChat | null = null;
  const Enfant = defineComponent({
    setup() {
      lu = preferencesChat();
      return () => h("span");
    },
  });
  const Racine = defineComponent({
    setup() {
      if (fournir) fournirPreferencesChat(() => reglages);
      return () => h(Enfant);
    },
  });
  app = createApp(Racine);
  app.mount(document.createElement("div"));
  return () => lu as unknown as PreferencesChat;
}

describe("lirePreferencesChat", () => {
  it("par défaut : déroulé classique, contexte en jetons, réflexions repliées, métriques complètes, confortable, captures", () => {
    for (const s of [undefined, null, "x", 3, {}])
      expect(lirePreferencesChat(s)).toEqual({
        deroule: "classic",
        contexte: "tokens",
        reflexions: "collapsed",
        metriques: "full",
        densite: "comfortable",
        captures: true,
      });
  });

  it("lit chaque valeur permise, et ramène toute autre au défaut", () => {
    const p = lirePreferencesChat({
      chat_workflow: "terminal",
      context_display: "ring",
      thinking_display: "expanded",
      footer_metrics: "essential",
      thread_density: "compact",
    });
    expect(p).toMatchObject({
      deroule: "terminal",
      contexte: "ring",
      reflexions: "expanded",
      metriques: "essential",
      densite: "compact",
    });
    const q = lirePreferencesChat({
      chat_workflow: "Terminal",
      context_display: 1,
      thinking_display: null,
      footer_metrics: ["full"],
      thread_density: true,
    });
    expect(q).toEqual(PREFERENCES_PAR_DEFAUT);
  });

  it("« Masquer le raisonnement » coché masque les réflexions tant qu'aucun choix n'est fait", () => {
    expect(lirePreferencesChat({ hide_thinking: true }).reflexions).toBe("hidden");
    expect(lirePreferencesChat({ hide_thinking: "oui" }).reflexions).toBe("collapsed");
    expect(lirePreferencesChat({ hide_thinking: true, thinking_display: "expanded" }).reflexions).toBe(
      "expanded",
    );
  });

  it("captures web : masquées seulement par le booléen vrai", () => {
    expect(lirePreferencesChat({ hide_web_screenshots: true }).captures).toBe(false);
    expect(lirePreferencesChat({ hide_web_screenshots: "true" }).captures).toBe(true);
  });
});

describe("fournirPreferencesChat", () => {
  it("suit les réglages et pose la classe compacte sur le body", async () => {
    const reglages = reactive<Record<string, unknown>>({});
    const lu = monter(reglages);
    expect(lu().deroule).toBe("classic");
    expect(document.body.classList.contains(CLASSE_FIL_COMPACT)).toBe(false);
    reglages["chat_workflow"] = "work_block";
    reglages["thread_density"] = "compact";
    await nextTick();
    expect(lu().deroule).toBe("work_block");
    expect(document.body.classList.contains(CLASSE_FIL_COMPACT)).toBe(true);
    reglages["thread_density"] = "comfortable";
    await nextTick();
    expect(document.body.classList.contains(CLASSE_FIL_COMPACT)).toBe(false);
  });

  it("hors racine, un composant lit les valeurs par défaut", () => {
    expect(monter({ chat_workflow: "terminal" }, false)()).toEqual(PREFERENCES_PAR_DEFAUT);
  });
});

describe("REGLAGES_AFFICHAGE", () => {
  it("chaque réglage propose exactement les valeurs permises, et le déroulé une aide par valeur", () => {
    const attendu: Record<string, readonly string[]> = {
      chat_workflow: DEROULES,
      context_display: CONTEXTES,
      thinking_display: REFLEXIONS,
      footer_metrics: METRIQUES,
      thread_density: DENSITES,
    };
    expect(REGLAGES_AFFICHAGE.map((r) => r.cle)).toEqual(Object.keys(attendu));
    for (const r of REGLAGES_AFFICHAGE) {
      expect(r.choix.map((c) => c.valeur)).toEqual([...(attendu[r.cle] ?? [])]);
      expect(r.choix.every((c) => c.libelle.trim().length > 0)).toBe(true);
    }
    const deroule = REGLAGES_AFFICHAGE[0]!;
    expect(Object.keys(deroule.aides ?? {})).toEqual([...DEROULES]);
  });

  it("lire renvoie la valeur normalisée de chaque réglage", () => {
    const p = lirePreferencesChat({ chat_workflow: "timeline", footer_metrics: "hidden" });
    expect(REGLAGES_AFFICHAGE.map((r) => r.lire(p))).toEqual([
      "timeline",
      "tokens",
      "collapsed",
      "hidden",
      "comfortable",
    ]);
  });
});
