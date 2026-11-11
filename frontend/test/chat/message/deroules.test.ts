// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/deroules.test.ts — les quatre déroulés du tour sur un même message : fil rendu, bloc replié puis ouvert, lignes du journal, réflexions repliées, dépliées ou masquées, métriques du pied. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import CorpsMessage from "../../../src/components/chat/message/CorpsMessage.vue";
import PiedMessage from "../../../src/components/chat/message/PiedMessage.vue";
import type { ContexteMessage, MessageAffiche } from "../../../src/features/chat/message/types";
import type { EtapeOutil } from "../../../src/features/chat/outils/types";
import { CLE_FIL } from "../../../src/features/chat/page/domaines";
import { configurerEnrichissement } from "../../../src/features/chat/rendu/enrichissement";
import { CLE_PREFERENCES_CHAT, DEROULES } from "../../../src/features/reglages/affichage-chat";
import type { Deroule, PreferencesChat } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function contexte(): ContexteMessage {
  const etat = reactive({
    settings: {},
    lastAssistantIdx: 1,
    isStreaming: false,
    logoApp: "x.png",
    compressionStatus: null,
    messageSearchQ: "",
    messageSearchActive: false,
  });
  const neutres: Record<string, unknown> = {
    pipelineFor: () => ({ show: true, nTools: 2, nComp: 0, running: false, label: "", summary: "" }),
    segGroupsFor: () => [],
    effectLinesFor: () => [],
    diffFilesFor: () => [],
    hasDiffFiles: () => false,
    isDiffEditorEnabled: () => false,
    isImageMessage: () => false,
    statusPhase: (m: MessageAffiche) => (m.isStreaming ? { kind: "think", label: "Réflexion…" } : null),
    fmtThinkingMeta: () => "",
    thinkingTokensOf: () => 0,
    cachePctOf: () => 0,
    metricsTooltip: () => "",
    fmtElapsed: (d: number) => `${d} s`,
    setMsgUi: (e: { msg: object }, patch: object) => Object.assign(e.msg, patch),
  };
  return new Proxy(etat, {
    get(cible, cle: string) {
      if (cle in cible) return (cible as Record<string, unknown>)[cle];
      if (cle in neutres) return neutres[cle];
      return () => undefined;
    },
  }) as unknown as ContexteMessage;
}

function monter(msg: MessageAffiche, pref: PreferencesChat, composant: typeof CorpsMessage = CorpsMessage) {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const entree = { idx: 1, msg: reactive(msg) as MessageAffiche };
  app = createApp({ render: () => h(composant, { entry: entree, pied: false }) });
  app.provide(CLE_PREFERENCES_CHAT, pref);
  app.provide(CLE_FIL, contexte());
  app.mount(hote);
  return hote;
}

/** Un tour fini : lecture réussie, puis tests en échec ; une réflexion par appel. */
function tour(extra: Partial<MessageAffiche> = {}): MessageAffiche {
  const etapes: EtapeOutil[] = [
    {
      name: "read_file",
      status: "done",
      seg: 0,
      args: { path: "package.json" },
      durationMs: 100,
      thinking: "je lis d'abord",
      thinkingMs: 3000,
      callId: "a",
      result: '{"name":"contrats"}',
    },
    {
      name: "execute_shell",
      status: "done",
      seg: 1,
      args: { command: "npm test" },
      durationMs: 42000,
      thinking: "je teste",
      callId: "b",
      result: { exit_code: 1, stdout: "47 réussis, 1 échec" },
      _is_error: true,
    },
  ];
  return {
    role: "assistant",
    content: "Corrigé.",
    thinking: "je conclus",
    segTexts: ["Je lis la config.", "Je lance les tests."],
    toolSteps: etapes,
    ...extra,
  } as MessageAffiche;
}

const FILS: Record<Deroule, string | null> = {
  classic: null,
  work_block: "[data-fil-bloc]",
  timeline: "[data-fil-tour]",
  terminal: "[data-fil-journal]",
};
const texte = (e: Element | null | undefined): string => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
/** Texte des enfants séparés d'une espace (l'écart à l'écran vient de la mise en page). */
const morceaux = (e: Element): string => [...e.children].map(texte).filter(Boolean).join(" ");

describe("déroulé choisi", () => {
  it("chaque déroulé rend son fil et lui seul ; le classique garde « Travail » et la réflexion en tête", () => {
    for (const d of DEROULES) {
      const hote = monter(tour(), prefsDeroule(d));
      for (const [autre, sel] of Object.entries(FILS))
        if (sel) expect(!!hote.querySelector(sel), `${d} / ${autre}`).toBe(autre === d);
      expect(!!hote.querySelector("[data-pipeline]"), d).toBe(d === "classic");
      app?.unmount();
      app = null;
    }
  });

  it("classique, réflexions masquées : plus de réflexion en tête", () => {
    expect(monter(tour(), prefsDeroule("classic")).querySelector("details[data-think]")).not.toBeNull();
    app?.unmount();
    const hote = monter(tour(), prefsDeroule("classic", { reflexions: "hidden" }));
    expect(hote.querySelector("details[data-think]")).toBeNull();
  });
});

describe("phase pendant la réflexion", () => {
  it("réflexions masquées : la phase reste dite dans les déroulés en fil ; visibles, la ligne de réflexion la porte", () => {
    const enCours = (): MessageAffiche =>
      ({ role: "assistant", content: "", thinking: "je réfléchis", isStreaming: true }) as MessageAffiche;
    for (const d of ["work_block", "timeline", "terminal"] as const) {
      const masque = monter(enCours(), prefsDeroule(d, { reflexions: "hidden" }));
      expect(masque.querySelector("[data-reflexion]"), d).toBeNull();
      expect(masque.querySelector("[data-phase]"), d).not.toBeNull();
      app?.unmount();
      const visible = monter(enCours(), prefsDeroule(d));
      expect(visible.querySelector("[data-reflexion]"), d).not.toBeNull();
      expect(visible.querySelector("[data-phase]"), d).toBeNull();
      app?.unmount();
      app = null;
    }
  });
});

describe("En bloc", () => {
  it("fini : replié sur son bilan (étapes, échecs, durée), ouvert au clic avec une pastille par étape", async () => {
    const hote = monter(tour(), prefsDeroule("work_block"));
    const tete = hote.querySelector("[data-tete-bloc]") as HTMLButtonElement;
    expect(morceaux(tete)).toBe("Travail · 2 étapes · 1 échec 42 s");
    expect(tete.getAttribute("aria-expanded")).toBe("false");
    expect(hote.querySelector("[data-corps-bloc]")).toBeNull();
    tete.click();
    await nextTick();
    expect(tete.getAttribute("aria-expanded")).toBe("true");
    expect([...hote.querySelectorAll("[data-appel] [data-texte-tour]")].map(texte)).toEqual([
      "Je lis la config.",
      "Je lance les tests.",
    ]);
    const pastilles = [...hote.querySelectorAll<HTMLButtonElement>("[data-pastille-etape]")];
    expect(pastilles.map(texte)).toEqual(["Lit package.json", "Exécute npm test"]);
    expect(pastilles[1]!.className).toContain("text-red-700");
    pastilles[0]!.click();
    await nextTick();
    expect(pastilles[0]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("en cours : ouvert, l'en-tête suit l'étape vivante et ses dernières lignes", () => {
    const fini = tour();
    const vivante: EtapeOutil = {
      name: "execute_shell",
      status: "running",
      seg: 1,
      args: { command: "npm test" },
      startedAt: Date.now() - 5000,
      shellOut: "un\ndeux\ntrois",
    };
    const m = tour({ isStreaming: true, content: "", toolSteps: [fini.toolSteps![0]!, vivante] });
    const hote = monter(m, prefsDeroule("work_block"));
    const tete = hote.querySelector("[data-tete-bloc]") as HTMLElement;
    expect(tete.getAttribute("aria-expanded")).toBe("true");
    expect(morceaux(tete)).toMatch(/^Étape 2 · Exécute npm test \d/);
    expect(morceaux(hote.querySelector("[data-sortie-vivante]")!)).toBe("deux trois");
  });

  it("réflexions : derrière un cerveau, dépliées d'emblée au choix, absentes si masquées", async () => {
    const replie = monter(tour({ _filOuverts: { bloc: true } }), prefsDeroule("work_block"));
    expect(replie.querySelectorAll("[data-cerveau]").length).toBe(2);
    expect(replie.querySelector("[data-pensee]")).toBeNull();
    (replie.querySelector("[data-cerveau]") as HTMLButtonElement).click();
    await nextTick();
    expect(texte(replie.querySelector("[data-pensee]"))).toBe("je lis d'abord");
    app?.unmount();
    const deplie = monter(
      tour({ _filOuverts: { bloc: true } }),
      prefsDeroule("work_block", { reflexions: "expanded" }),
    );
    expect([...deplie.querySelectorAll("[data-pensee]")].map(texte)).toEqual(["je lis d'abord", "je teste"]);
    app?.unmount();
    const masque = monter(
      tour({ _filOuverts: { bloc: true } }),
      prefsDeroule("work_block", { reflexions: "hidden" }),
    );
    expect(masque.querySelector("[data-cerveau], [data-pensee], [data-reflexion]")).toBeNull();
  });
});

describe("Journal", () => {
  it("une ligne par geste « Verbe(objet) », son résultat en retrait, l'échec en rouge, le détail au clic", async () => {
    const hote = monter(tour(), prefsDeroule("terminal"));
    const gestes = [...hote.querySelectorAll<HTMLButtonElement>("[data-geste]")];
    expect(gestes.map((g) => texte(g).replace(/\s/g, ""))).toEqual(["Lit(package.json)", "Exécute(npmtest)"]);
    const resultats = [...hote.querySelectorAll("[data-resultat]")];
    expect(resultats.map(texte)).toEqual(['{"name":"contrats"}', "code 1 · 47 réussis, 1 échec"]);
    expect(resultats[1]!.className).toContain("text-red-600");
    gestes[1]!.click();
    await nextTick();
    expect(gestes[1]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("réflexions : une ligne grise par appel, son texte selon le choix", async () => {
    const replie = monter(tour(), prefsDeroule("terminal"));
    const lignes = [...replie.querySelectorAll("[data-fil-journal] [data-reflexion]")];
    expect(lignes.length).toBe(3);
    expect(replie.querySelector("[data-fil-journal] pre")).toBeNull();
    (lignes[0]!.querySelector("button") as HTMLButtonElement).click();
    await nextTick();
    expect(texte(replie.querySelector("[data-fil-journal] pre"))).toBe("je lis d'abord");
    app?.unmount();
    const deplie = monter(tour(), prefsDeroule("terminal", { reflexions: "expanded" }));
    expect(deplie.querySelectorAll("[data-fil-journal] pre").length).toBe(3);
    app?.unmount();
    const masque = monter(tour(), prefsDeroule("terminal", { reflexions: "hidden" }));
    expect(masque.querySelector("[data-reflexion]")).toBeNull();
  });
});

describe("Chronologie", () => {
  it("réflexions masquées : aucune ligne de réflexion ; dépliées : ouvertes d'emblée", () => {
    const masque = monter(tour(), prefsDeroule("timeline", { reflexions: "hidden" }));
    expect(masque.querySelector("[data-reflexion]")).toBeNull();
    app?.unmount();
    const deplie = monter(tour(), prefsDeroule("timeline", { reflexions: "expanded" }));
    const lignes = [...deplie.querySelectorAll("[data-reflexion] button[aria-expanded]")];
    expect(lignes.length).toBe(3);
    expect(lignes.every((b) => b.getAttribute("aria-expanded") === "true")).toBe(true);
  });
});

describe("métriques du pied", () => {
  const avecMetriques = (): MessageAffiche =>
    tour({
      metrics: { model: "ornith-9b", duration: 12, read_tps: 900, write_tps: 40 },
    } as Partial<MessageAffiche>);

  it("complètes : modèle, durée et vitesses ; essentielles : modèle et durée ; masquées : rien", () => {
    const attendu: Record<string, string | null> = {
      full: "ornith-9b · 12 s · ↓ 900 jetons/s · ↑ 40 jetons/s",
      essential: "ornith-9b · 12 s",
      hidden: null,
    };
    for (const [metriques, ligne] of Object.entries(attendu)) {
      const hote = monter(
        avecMetriques(),
        prefsDeroule("classic", { metriques: metriques as PreferencesChat["metriques"] }),
        PiedMessage as typeof CorpsMessage,
      );
      const m = hote.querySelector("[data-metriques]");
      expect(m ? morceaux(m) : null, metriques).toBe(ligne);
      app?.unmount();
      app = null;
    }
  });

  it("essentielles sans modèle ni durée : pas de rangée vide", () => {
    const hote = monter(
      tour({ metrics: { write_tps: 40 } } as Partial<MessageAffiche>),
      prefsDeroule("classic", { metriques: "essential" }),
      PiedMessage as typeof CorpsMessage,
    );
    expect(hote.querySelector("[data-metriques]")).toBeNull();
  });
});

describe("graphiques : seulement dans la réponse finale", () => {
  const REF = "!9dba45deb90f";
  const avecGraphique = (content: string): MessageAffiche =>
    ({
      role: "assistant",
      content,
      segTexts: [`Je trace le budget ${REF}.`],
      _filOuverts: { bloc: true },
      toolSteps: [
        {
          name: "chart_bar",
          status: "done",
          seg: 0,
          args: { title: "Budget" },
          result: { ref: REF },
          callId: "g",
        },
      ],
    }) as MessageAffiche;

  it("dans chaque déroulé, un seul graphique, tracé dans la réponse ou à sa suite ; le texte d'étape le mentionne", async () => {
    configurerEnrichissement({ fetch: () => new Promise<Response>(() => {}), chatCourant: () => "c1" });
    for (const d of DEROULES)
      for (const content of ["Le budget est prêt.", `Voici le budget :\n\n${REF}`]) {
        const hote = monter(avecGraphique(content), prefsDeroule(d, { reflexions: "expanded" }));
        await vi.waitFor(() => expect(hote.querySelectorAll(".chart-ref-holder").length, d).toBe(1));
        const graphique = hote.querySelector(".chart-ref-holder")!;
        expect(!!graphique.closest("[data-sans-graphiques]"), d).toBe(false);
        expect(!!hote.querySelector("[data-graphiques-fin]"), d).toBe(!content.includes(REF));
        if (d !== "classic")
          expect(texte(hote.querySelector("[data-texte-tour]")), d).toBe(
            "Je trace le budget graphique dans la réponse.",
          );
        app?.unmount();
        app = null;
      }
  });
});
