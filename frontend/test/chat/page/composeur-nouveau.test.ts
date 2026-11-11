// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/composeur-nouveau.test.ts — composeur : rangée courte, puces d'état, réflexion et paramètres de génération dans le menu du modèle, nom abrégé, en-tête sans curseurs. */
import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import BarreComposeur from "../../../src/components/chat/page/BarreComposeur.vue";
import EnteteConversation from "../../../src/components/chat/page/EnteteConversation.vue";
import PucesComposeur from "../../../src/components/chat/page/PucesComposeur.vue";
import {
  CLE_COMPOSEUR,
  CLE_ENTETE,
  CLE_IMAGE,
  CLE_MODELES,
  CLE_PAGE,
} from "../../../src/features/chat/page/domaines";
import { abregerModele, compteTaches, puceContexte } from "../../../src/features/chat/page/puces";
import { CLE_PREFERENCES_CHAT } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";
import { appelsDe, demonter, etat, monter, noms } from "./montage";

vi.mock("../../../src/components/voix/BoutonMicro.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ render: () => h("button", { "data-stub": "micro" }) }) };
});

afterEach(demonter);

const cle = (k: InjectionKey<unknown>): InjectionKey<object> => k as InjectionKey<object>;

const ENTETE = {
  showSidebar: false,
  editingChatTitle: false,
  chatTitleDraft: "",
  currentChatId: "c1",
  currentChatTitle: "Migration",
  titleFlash: false,
  planMode: true,
  settings: { enable_model_selector: true },
  selectedModel: "m",
  selectedConnector: null,
  activeModelIds: ["m"],
  showSamplingPanel: false,
  features: { opencode: false },
  showChatMenu: false,
  showExportFormatMenu: false,
  messageSearchActive: false,
  messageSearch: "",
  showOpenCodeModal: false,
  showInfoModal: false,
};

function modeles(extra: Record<string, unknown> = {}) {
  return etat({
    imageMode: false,
    showModelManager: false,
    selectedModel: "qwen3-coder-30b",
    selectedModelLabel: "qwen3-coder-30b",
    selectedConnector: null,
    selectedEngineMeta: null,
    builtinAllowed: true,
    noEngineAllowed: false,
    canManageModels: false,
    moteurIntegre: null,
    chargementIntegre: false,
    llmHealth: null,
    availableModels: ["qwen3-coder-30b"],
    modelsLoading: false,
    modelsError: "",
    isLoadingModel: "",
    pickerConnectors: [],
    pickerConnState: {},
    pickerConnModels: {},
    pickerConnFree: {},
    pickerConnLoading: {},
    modelesVision: [],
    effectiveParamsData: null,
    modelLoadingId: "",
    modelLoadPct: null,
    modelLoadStage: "",
    reasoningEffortValues: ["low", "high"],
    samplingOverride: { reasoning_effort: null },
    liveGen: null,
    ctxUsage: { used: 12000, total: 32000, pct: 37.5 },
    isModelLoaded: () => false,
    isModelFailed: () => false,
    ...extra,
  });
}

describe("libellés des puces", () => {
  it("contexte : direct (jetons/s et durée en infobulle) ou repos ; rien sans fenêtre connue", () => {
    expect(
      puceContexte({ secLabel: "12,3 s", tokPerSec: 45, ctxLabel: "12k / 32k", pct: 38.2 }, null),
    ).toEqual({
      pct: 38,
      part: 0.382,
      titre: "12k / 32k jetons · 45 jetons/s · 12,3 s",
    });
    expect(puceContexte(null, { used: 12000, total: 32000, pct: 37.5 })).toMatchObject({
      pct: 38,
      part: 0.375,
    });
    expect(puceContexte(null, { used: 12000, total: 32000, pct: 37.5, persisted: true })?.titre).toContain(
      "restaurée au chargement",
    );
    expect(puceContexte(null, { used: 0, total: 0, pct: 0 })).toBeNull();
    const sansFenetre = { secLabel: "3 s", tokPerSec: 40, ctxLabel: "", pct: 0 };
    expect(puceContexte(sansFenetre, { used: 8000, total: 32000, pct: 25 })?.titre).toContain(
      "40 jetons/s · 3 s",
    );
    expect(puceContexte(sansFenetre, null)).toBeNull();
  });

  it("nom de modèle abrégé ; tâches faites, total et tâche en cours", () => {
    expect(abregerModele("qwen3-coder-30b")).toBe("qwen3-coder");
    expect(abregerModele("models/Mistral-Small-24B-Q4.gguf")).toBe("Mistral-Small");
    expect(abregerModele("unmodeletreslongsansaucuntiret")).toBe("unmodeletresl…");
    expect(
      compteTaches([
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ]),
    ).toEqual({ faites: 1, total: 3, enCours: "b" });
  });
});

describe("puces de la rangée du composeur", () => {
  it("Mode plan (refermable), Tâches 1/2, Contexte 38 % avec infobulle", async () => {
    const p = etat({
      planMode: true,
      imageMode: false,
      todoPanelOpen: false,
      todoList: [
        { content: "Lire", status: "completed" },
        { content: "Corriger", status: "in_progress" },
      ],
    });
    const img = etat({ imageMode: false });
    const hote = monter(PucesComposeur, [
      [cle(CLE_PAGE), p],
      [cle(CLE_MODELES), modeles()],
      [cle(CLE_IMAGE), img],
      [cle(CLE_PREFERENCES_CHAT), prefsDeroule("classic", { contexte: "fill" })],
    ]);
    expect(hote.querySelector("[data-plan-chip]")?.textContent).toContain("Mode plan");
    expect(hote.querySelector("[data-puce-taches]")?.textContent).toContain("Tâches 1/2");
    const ctx = hote.querySelector("[data-puce-contexte]") as HTMLElement;
    expect(ctx.textContent?.trim()).toBe("Contexte 38 %");
    expect(ctx.title).toContain("12");
    expect([ctx.getAttribute("role"), ctx.getAttribute("aria-valuenow")]).toEqual(["meter", "38"]);
    const jauge = ctx.querySelector<HTMLElement>("[data-jauge-contexte]");
    expect(parseFloat(jauge?.style.width ?? "")).toBeCloseTo(37.5, 1);
    expect(hote.querySelector("[data-puces-composeur]")?.className).not.toMatch(/border/);
    (hote.querySelector('button[aria-label="Désactiver le mode plan"]') as HTMLElement).click();
    expect(appelsDe("setPlanMode")).toEqual([[false]]);
    (hote.querySelector("[data-puce-taches]") as HTMLElement).click();
    await nextTick();
    expect(hote.textContent).toContain("Tâches de la session");
  });

  it("rangée étroite : libellés abrégés, noms accessibles entiers", () => {
    const p = etat({
      planMode: true,
      imageMode: false,
      todoPanelOpen: false,
      todoList: [
        { content: "Lire", status: "completed" },
        { content: "Corriger", status: "pending" },
      ],
    });
    const hote = monter(
      PucesComposeur,
      [
        [cle(CLE_PAGE), p],
        [cle(CLE_MODELES), modeles()],
        [cle(CLE_IMAGE), etat({ imageMode: false })],
        [cle(CLE_PREFERENCES_CHAT), prefsDeroule("classic", { contexte: "fill" })],
      ],
      { props: { etroit: true } },
    );
    const plan = hote.querySelector("[data-plan-chip] button") as HTMLElement;
    expect(plan.textContent?.trim()).toBe("");
    expect(plan.getAttribute("aria-label")).toBe("Désactiver le mode plan");
    const taches = hote.querySelector("[data-puce-taches]") as HTMLElement;
    expect([taches.textContent?.trim(), taches.getAttribute("aria-label")]).toEqual([
      "1/2",
      "Tâches 1 sur 2",
    ]);
    const ctx = hote.querySelector("[data-puce-contexte]") as HTMLElement;
    expect(ctx.querySelector(".sr-only")?.textContent).toBe("Contexte ");
    expect(ctx.textContent?.trim()).toBe("Contexte 38 %");
  });

  it("forme « jetons » (défaut) : « utilisés / fenêtre » au repos ; durée, débit et jetons pendant le tour", () => {
    const p = etat({ planMode: false, imageMode: false, todoPanelOpen: false, todoList: [] });
    const fmt = {
      fmtCtxUsage: (u: { used: number; total: number }) => `${u.used / 1000}k / ${u.total / 1000}k`,
    };
    const repos = monter(PucesComposeur, [
      [cle(CLE_PAGE), p],
      [cle(CLE_MODELES), modeles(fmt)],
      [cle(CLE_IMAGE), etat({ imageMode: false })],
    ]);
    expect(repos.querySelector("[data-puce-contexte]")).toBeNull();
    const auRepos = repos.querySelector('[data-contexte-jetons="repos"]') as HTMLElement;
    expect(auRepos.textContent?.trim()).toBe("12k / 32k");
    expect(auRepos.title).toMatch(/12\s000 \/ 32\s000 jetons/);
    demonter();
    const direct = monter(PucesComposeur, [
      [cle(CLE_PAGE), p],
      [
        cle(CLE_MODELES),
        modeles({
          ...fmt,
          liveGen: { secLabel: "12 s", tokPerSec: 25, ctxLabel: "12k + 120 / 32k", pct: 38 },
        }),
      ],
      [cle(CLE_IMAGE), etat({ imageMode: false })],
    ]);
    const enDirect = direct.querySelector('[data-contexte-jetons="direct"]') as HTMLElement;
    expect(
      [...enDirect.children]
        .map((e) => e.textContent?.trim())
        .filter(Boolean)
        .join(" "),
    ).toBe("12 s · ↑ 25 jetons/s · 12k + 120 / 32k");
    demonter();
    const image = monter(PucesComposeur, [
      [cle(CLE_PAGE), p],
      [cle(CLE_MODELES), modeles({ ...fmt, imageMode: true })],
      [cle(CLE_IMAGE), etat({ imageMode: true })],
    ]);
    expect(image.querySelector("[data-contexte-jetons]")).toBeNull();
  });

  it("rien à montrer : pas de rangée", () => {
    const p = etat({ planMode: false, imageMode: false, todoPanelOpen: false, todoList: [] });
    const hote = monter(PucesComposeur, [
      [cle(CLE_PAGE), p],
      [cle(CLE_MODELES), modeles({ ctxUsage: null })],
      [cle(CLE_IMAGE), etat({ imageMode: false })],
    ]);
    expect(hote.querySelector("[data-puces-composeur]")).toBeNull();
  });
});

describe("rangée courte", () => {
  it("+ et micro à gauche, modèle et Envoyer à droite ; Réflexion et Paramètres de génération… dans le menu du modèle", async () => {
    const mod = modeles({ showModelManager: true });
    const ent = etat(ENTETE);
    const p = etat({
      voiceCanDictate: true,
      voiceState: "idle",
      voiceBusy: false,
      composerPlusRef: null,
      planMode: false,
      todoList: [],
      todoPanelOpen: false,
      imageMode: false,
      jobsActifsTotal: 0,
      jobsChat: [],
      jobsFileReveil: [],
      jobsOuvert: false,
    });
    const comp = etat({
      showComposerPlus: false,
      showSharedPrompts: false,
      inboxCount: 0,
      isStreaming: false,
      imageMode: false,
      inputMessage: "",
      attachedFiles: [],
      noEngineAllowed: false,
      sharedPromptsList: [],
    });
    const hote = monter(BarreComposeur, [
      [cle(CLE_PAGE), p],
      [cle(CLE_MODELES), mod],
      [cle(CLE_ENTETE), ent],
      [cle(CLE_COMPOSEUR), comp],
      [cle(CLE_IMAGE), etat({ imageMode: false })],
    ]);
    const rangee = hote.querySelector("[data-barre-composeur]") as HTMLElement;
    const enfants = [...rangee.children].map((e) =>
      e.matches("[data-model-manager]")
        ? "modèle"
        : e.querySelector("[data-stub=micro]")
          ? "gauche"
          : e.tagName,
    );
    expect(enfants[0]).toBe("gauche");
    expect(rangee.querySelector("[data-puces-composeur]")).not.toBeNull();
    expect(enfants).toContain("modèle");
    expect(rangee.querySelector('button[aria-label="Plus d\'actions"]')).not.toBeNull();
    expect(rangee.lastElementChild?.querySelector('button[aria-label="Envoyer le message"]')).not.toBeNull();
    (hote.querySelector("[data-effort-menu] > button") as HTMLElement).click();
    await nextTick();
    expect(
      [...hote.querySelectorAll("[data-effort-menu] [role='menuitemradio']")].map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(["Auto", "Basse", "Élevée"]);
    (hote.querySelectorAll("[data-effort-menu] [role='menuitemradio']")[2] as HTMLElement).click();
    (hote.querySelector("[data-reglages-generation]") as HTMLElement).click();
    expect(noms()).toEqual(expect.arrayContaining(["pickReasoningEffort", "togglePanel"]));
    expect(mod.showModelManager).toBe(false);
    await nextTick();
  });
});

describe("en-tête", () => {
  it("ni curseurs ni témoin du mode plan", () => {
    const hote = monter(EnteteConversation, [[cle(CLE_ENTETE), etat(ENTETE)]]);
    expect(hote.querySelector('button[aria-label="Réglages de génération"]')).toBeNull();
    expect(hote.querySelector("[data-plan-badge]")).toBeNull();
  });
});
