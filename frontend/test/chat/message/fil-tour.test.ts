// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/fil-tour.test.ts — fil chronologique du tour : ordre d'arrivée, texte qui ne bouge pas, étapes groupées en ligne riche numérotée sur le tour, verbes, arrêt, déroulé Classique intacte. */
import { createApp, h, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import CorpsMessage from "../../../src/components/chat/message/CorpsMessage.vue";
import { chronologieTour, textesDuTour } from "../../../src/features/chat/message/chronologie";
import type { ContexteMessage, MessageAffiche } from "../../../src/features/chat/message/types";
import type { EtapeOutil } from "../../../src/features/chat/outils/types";
import { CLE_FIL } from "../../../src/features/chat/page/domaines";
import { CLE_PREFERENCES_CHAT } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";

let app: App | null = null;
const appels: unknown[][] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
});

function contexte(): ContexteMessage {
  const etat = reactive({
    settings: { hide_thinking: false },
    lastAssistantIdx: 1,
    isStreaming: true,
    logoApp: "x.png",
    compressionStatus: null,
    messageSearchQ: "",
    messageSearchActive: false,
  });
  const neutres: Record<string, unknown> = {
    pipelineFor: () => ({ show: true, nTools: 1, nComp: 0, running: false, label: "", summary: "" }),
    segGroupsFor: () => [],
    effectLinesFor: () => [],
    diffFilesFor: () => [],
    hasDiffFiles: () => false,
    isDiffEditorEnabled: () => false,
    isImageMessage: () => false,
    statusPhase: () => null,
    fmtThinkingMeta: () => "",
    thinkingTokensOf: () => 0,
    cachePctOf: () => 0,
    metricsTooltip: () => "",
  };
  return new Proxy(etat, {
    get(cible, cle: string) {
      if (cle in cible) return (cible as Record<string, unknown>)[cle];
      if (cle in neutres) return neutres[cle];
      return (...args: unknown[]) => void appels.push([cle, ...args]);
    },
  }) as unknown as ContexteMessage;
}

function monter(msg: MessageAffiche, classique = false): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(CorpsMessage, { entry: { idx: 1, msg }, pied: false }) });
  app.provide(CLE_PREFERENCES_CHAT, prefsDeroule(classique ? "classic" : "timeline"));
  app.provide(CLE_FIL, contexte());
  app.mount(hote);
  return hote;
}

const lit = (path: string, ms: number, seg = 0, extra: Partial<EtapeOutil> = {}): EtapeOutil => ({
  name: "read_file",
  status: "done",
  args: { path },
  durationMs: ms,
  seg,
  ...extra,
});

describe("chronologieTour", () => {
  it("ordre d'arrivée : réflexion, texte, étapes groupées, sous-agent, mémoire, compression, réflexion finale", () => {
    const blocs = chronologieTour({
      segTexts: ["Je lis la config.", "Je lance les tests."],
      toolSteps: [
        lit("package.json", 100, 0, { thinking: "je lis d'abord", thinkingMs: 3000, callId: "a" }),
        lit("vitest.config.ts", 100, 0, { callId: "b" }),
        { name: "task", _kind: "task", status: "done", seg: 1, callId: "t" },
        { name: "memory", _kind: "memory", status: "done", seg: 1, args: { action: "add" } },
        { name: "todowrite", _kind: "todo", status: "done", seg: 1 },
        { name: "context_compress", _kind: "compression", status: "done", seg: 1 },
        { name: "execute_shell", status: "done", seg: 1, args: { command: "npm test" }, callId: "c" },
      ],
      taskRuns: [{ callId: "t", state: "completed" }],
      thinking: "je conclus",
      _thinkingMs: 1500,
    });
    expect(blocs.map((b) => b.cle)).toEqual([
      "r:0",
      "t:0",
      "e:0",
      "t:1",
      "a:2",
      "m:3",
      "c:5",
      "e:6",
      "r:fin",
    ]);
    const groupes = blocs.filter((b) => b.k === "etapes");
    expect(groupes.map((g) => g.etapes.map((e) => e.numero))).toEqual([[1, 2], [3]]);
    expect(blocs.find((b) => b.k === "agents")).toMatchObject({ agents: [{ ri: 0 }] });
    expect(blocs.at(-1)).toMatchObject({ k: "reflexion", texte: "je conclus", ms: 1500, vivante: false });
  });

  it("un segment sans outil garde sa place avant la réflexion du segment suivant", () => {
    const blocs = chronologieTour({
      segTexts: ["Premier.", "Entre-deux.", "Troisième."],
      toolSteps: [lit("a", 1, 0), lit("b", 1, 2, { thinking: "plus tard" })],
    });
    expect(blocs.map((b) => b.cle)).toEqual(["t:0", "e:0", "t:1", "r:1", "t:2", "e:1"]);
  });

  it("réflexion notée après un outil hors liste : avant le texte de son appel, jamais répétée", () => {
    const blocs = chronologieTour({
      segTexts: ["Je planifie."],
      toolSteps: [
        { name: "todowrite", _kind: "todo", status: "done", seg: 0 },
        { name: "chart_bar", status: "done", seg: 0, thinking: "je réfléchis", thinkingMs: 900 },
      ],
      thinking: "je réfléchis",
    });
    expect(blocs.map((b) => b.cle)).toEqual(["r:1", "t:0", "e:1"]);
    const deux = chronologieTour({
      segTexts: ["Je planifie."],
      toolSteps: [
        { name: "todowrite", _kind: "todo", status: "done", seg: 0, thinking: "je réfléchis" },
        { name: "chart_bar", status: "done", seg: 0, thinking: "je réfléchis" },
      ],
    });
    expect(deux.map((b) => b.cle)).toEqual(["r:0", "t:0", "e:1"]);
  });

  it("réflexion en cours (rien d'écrit après) : vivante", () => {
    const [b] = chronologieTour({ thinking: "hmm", isStreaming: true, _thinkingStartedAt: 1000 }, 4000);
    expect(b).toMatchObject({ k: "reflexion", vivante: true, ms: 3000 });
  });

  it("Copier : textes dans l'ordre, réponse comprise", () => {
    expect(textesDuTour({ segTexts: ["Je lis.", "", "Je teste."], content: "Tout passe." })).toBe(
      "Je lis.\n\nJe teste.\n\nTout passe.",
    );
  });
});

describe("FilTour", () => {
  it("rythme : un appel (réflexion, texte, étapes) se tient, l'appel suivant et la réponse qui suit des étapes se détachent", () => {
    const hote = monter({
      role: "assistant",
      content: "Fin.",
      segTexts: ["Je lis.", "Je teste."],
      toolSteps: [lit("a", 1, 0, { thinking: "r1" }), lit("b", 1, 1, { thinking: "r2" })],
    } as MessageAffiche);
    const fil = hote.querySelector("[data-fil-tour]") as HTMLElement;
    expect([...fil.children].map((e) => e.classList.contains("mt-3"))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(fil.classList.contains("mb-3")).toBe(true);
  });

  it("le texte écrit avant un outil reste à sa place, en style normal, et la ligne d'étape vient après", () => {
    const avant = monter({
      role: "assistant",
      isStreaming: true,
      content: "",
      _pendingPreContent: "Je lis la config.",
    });
    const vivant = avant.querySelector("[data-texte-vivant]");
    expect(vivant?.textContent).toContain("Je lis la config.");
    expect(vivant?.classList.contains("markdown-body--worklog")).toBe(false);
    app?.unmount();
    const apres = monter({
      role: "assistant",
      isStreaming: true,
      content: "",
      segTexts: ["Je lis la config."],
      toolSteps: [
        { name: "read_file", status: "running", args: { path: "/w/package.json" }, seg: 0, callId: "a" },
      ],
    });
    const texte = apres.querySelector("[data-texte-tour]");
    const ligne = apres.querySelector("[data-ligne-etapes]");
    expect(texte?.textContent).toContain("Je lis la config.");
    expect(texte?.classList.contains("markdown-body--worklog")).toBe(false);
    expect(texte!.compareDocumentPosition(ligne!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ligne?.textContent?.replace(/\s+/g, " ")).toContain("Étape 1 · Lit package.json");
    expect(apres.querySelector("[data-pipeline]")).toBeNull();
    expect(apres.querySelector("[data-live-narration]")).toBeNull();
  });

  it("étapes finies : « 2 étapes · package.json, vitest.config.ts · 0,2 s », liste numérotée sur le tour au clic", () => {
    const hote = monter({
      role: "assistant",
      content: "Fini.",
      segTexts: [""],
      toolSteps: [
        {
          name: "execute_shell",
          status: "done",
          args: { command: "ls" },
          durationMs: 50,
          seg: 0,
          callId: "z",
        },
        lit("vitest.config.ts", 100, 0, { thinking: "ensuite", callId: "a" }),
        lit("/w/src/vitest.config.ts", 100, 0, { callId: "b" }),
      ],
      _filOuverts: { "e:1": true },
    });
    const lignes = hote.querySelectorAll("[data-ligne-etapes]");
    expect(lignes.length).toBe(2);
    expect(lignes[0]?.textContent?.replace(/\s+/g, " ")).toContain("Exécute ls");
    expect(lignes[1]?.textContent?.replace(/\s+/g, " ")).toContain("2 étapes · vitest.config.ts");
    expect(lignes[1]?.textContent).toContain("0,2 s");
    const items = hote.querySelectorAll("ol li");
    expect([...items].map((li) => li.getAttribute("data-etape"))).toEqual(["a", "b"]);
    expect(items[0]?.textContent?.replace(/\s+/g, " ")).toContain("2.");
    expect(items[1]?.textContent?.replace(/\s+/g, " ")).toContain("3.");
    expect(
      hote.querySelector("[data-etape='b']")?.closest("[data-etapes]")?.getAttribute("data-etapes"),
    ).toBe("a b");
    (lignes[0] as HTMLButtonElement).click();
    expect(appels).toContainEqual([
      "setMsgUi",
      { idx: 1, msg: expect.anything() },
      { _filOuverts: { "e:1": true, "e:0": true } },
    ]);
  });

  it("étape vivante : numéro sur le tour, horloge, deux dernières lignes de sortie ; arrêtée : « arrêtée à 18 s »", () => {
    const vivant = monter({
      role: "assistant",
      isStreaming: true,
      toolSteps: [
        lit("a", 1, 0),
        lit("b", 1, 0),
        {
          name: "execute_shell",
          status: "running",
          args: { command: "npm test" },
          startedAt: Date.now() - 18_200,
          shellOut: "> vitest run\n\u001b[32m✓ src/auth.test.ts (12)\u001b[0m\n✓ src/db.test.ts (8)\n",
          seg: 0,
        },
      ],
    });
    const ligne = vivant.querySelector("[data-ligne-etapes]");
    expect(ligne?.textContent?.replace(/\s+/g, " ")).toContain("Étape 3 · Exécute npm test");
    expect(ligne?.textContent).toContain("18 s");
    expect(vivant.querySelector("[data-sortie-vivante]")?.textContent).toBe(
      "✓ src/auth.test.ts (12)✓ src/db.test.ts (8)",
    );
    app?.unmount();
    const arrete = monter({
      role: "assistant",
      toolSteps: [
        {
          name: "execute_shell",
          status: "stopped",
          args: { command: "npm test" },
          durationMs: 18_000,
          seg: 0,
        },
      ],
    });
    expect(arrete.querySelector("[data-ligne-etapes]")?.textContent).toContain("arrêtée à 18 s");
    expect(arrete.querySelector(".ph-stop-circle")).not.toBeNull();
    expect(arrete.querySelector(".animate-spin")).toBeNull();
  });

  it("sous-agent : une ligne à sa place dans le fil, le clic ouvre son volet par openTaskModal", () => {
    const hote = monter({
      role: "assistant",
      segTexts: ["Je lance une revue."],
      toolSteps: [{ name: "task", _kind: "task", status: "running", seg: 0, callId: "t1" }],
      taskRuns: [{ id: "k", agent: "revue", state: "running", callId: "t1" } as never],
    });
    expect(hote.querySelector(".task-runs")).toBeNull();
    const ligne = hote.querySelector<HTMLButtonElement>("[data-ligne-agent][data-etape='t1']");
    expect(ligne?.textContent).toContain("revue");
    ligne?.click();
    expect(appels).toContainEqual(["openTaskModal", { idx: 1, msg: expect.anything() }, 0]);
  });

  it("outil MCP tiers : son nom, faute de verbe", () => {
    const hote = monter({
      role: "assistant",
      toolSteps: [{ name: "jira_search_issues", status: "done", args: { query: "bug" }, seg: 0 }],
    });
    const nom = hote.querySelector("[data-ligne-etapes] .font-mono");
    expect(nom?.textContent?.trim()).toBe("jira_search_issues");
  });

  it("déroulé Classique : conteneur « Travail » et réflexion d'avant, aucun fil chronologique", () => {
    const hote = monter(
      {
        role: "assistant",
        content: "Fini.",
        thinking: "hmm",
        segTexts: ["Je lis."],
        toolSteps: [lit("a", 1, 0)],
      },
      true,
    );
    expect(hote.querySelector("[data-fil-tour]")).toBeNull();
    expect(hote.querySelector("[data-pipeline]")).not.toBeNull();
    expect(hote.querySelector("details[data-think]")).not.toBeNull();
  });
});
