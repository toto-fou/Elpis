// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/bulle-reveil.test.ts — réveils dans la bulle de l'agent : une seule réponse continue (aucune ligne de réveil, un seul pied à la fin) ; recherche, saut, liste mémoïsée. */
import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ListeMessages from "../../../src/components/chat/liste/ListeMessages.vue";
import MessageChat from "../../../src/components/chat/message/MessageChat.vue";
import { CLE_FIL, CLE_LISTE } from "../../../src/features/chat/page/domaines";
import { CLE_PREFERENCES_CHAT } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";
import type {
  ContexteListe,
  ContexteMessage,
  EntreeMessage,
  MessageAffiche,
} from "../../../src/features/chat/message/types";
import { REVEIL } from "./outils-jobs";

let app: App | null = null;
const appels: unknown[][] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
});

const REVEIL2 = {
  ...REVEIL,
  summary: "pytest terminé, code 0, 4 s",
  events: REVEIL.events.map((e) => ({ ...e, exit_code: 0, duration_s: 4 })),
};

function contexte(surcharges: Record<string, unknown> = {}): ContexteMessage {
  const etat = reactive({
    settings: { assistant_name: "Elpis" },
    user: { username: "alice", avatar: null },
    skinCourant: {},
    nomMarque: "Elpis",
    lastAssistantIdx: 5,
    isStreaming: false,
    editingMessageIndex: null,
    editMessageText: "",
    messageSearchQ: "",
    messageSearchActive: false,
    compressionStatus: null,
    voiceReadingIdx: null,
    voiceCanRead: true,
    vsFlashIdx: null,
    visibleMessages: [],
    vsTopPad: 0,
    vsBotPad: 0,
    effectUiRev: 0,
    diffCardRev: 0,
    isThinking: false,
    statusText: "",
    compactionNotice: null,
    currentChatId: "c1",
    ...surcharges,
  });
  const neutres: Record<string, unknown> = {
    pipelineFor: () => ({ show: false }),
    segGroupsFor: () => [],
    effectLinesFor: () => [],
    diffFilesFor: () => [],
    hasDiffFiles: () => false,
    isDiffEditorEnabled: () => false,
    isImageMessage: () => false,
    statusPhase: () => null,
    fmtElapsed: (s: number) => s + " s",
    thinkingTokensOf: () => 0,
    cachePctOf: () => 0,
    metricsTooltip: () => "",
    toolLimitLabel: () => "",
  };
  return new Proxy(etat, {
    set(cible, cle: string, valeur: unknown) {
      (cible as Record<string, unknown>)[cle] = valeur;
      return true;
    },
    get(cible, cle: string) {
      if (cle in cible) return (cible as Record<string, unknown>)[cle];
      if (cle in neutres) return neutres[cle];
      return (...args: unknown[]) => void appels.push([cle, ...args]);
    },
  }) as unknown as ContexteMessage;
}

function monter(rendu: () => VNode, ctx: ContexteMessage): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  app.provide(CLE_PREFERENCES_CHAT, prefsDeroule("timeline"));
  app.provide(CLE_FIL, ctx);
  app.provide(CLE_LISTE, ctx as ContexteListe);
  app.mount(hote);
  return hote;
}

const msg = (m: MessageAffiche): MessageAffiche => m;

/** Réponse de l'agent (1), réveil (2), réponse (3), réveil (4), réponse (5). */
function bulle(): EntreeMessage {
  return {
    idx: 1,
    msg: msg({
      role: "assistant",
      content: "Je lance pytest.",
      metrics: { model: "m-tete" },
      run_ids: ["r0"],
    }),
    suite: [
      {
        idx: 2,
        msg: msg({ role: "user", origin: "job_wake", wake: REVEIL, content: "[Automatic wake-up] 1" }),
      },
      { idx: 3, msg: msg({ role: "assistant", content: "Un test échoue, je corrige." }) },
      {
        idx: 4,
        msg: msg({ role: "user", origin: "job_wake", wake: REVEIL2, content: "[Automatic wake-up] 2" }),
      },
      {
        idx: 5,
        msg: msg({
          role: "assistant",
          content: "Tout passe.",
          thinking: "Relire le journal",
          metrics: { model: "m-fin" },
          run_ids: ["r2"],
        }),
      },
    ],
  };
}

describe("MessageChat : bulle continuée par des réveils", () => {
  it("une seule réponse continue, sans ligne de réveil ni texte remis au modèle, dans l'ordre", () => {
    const hote = monter(() => h(MessageChat, { entry: bulle() }), contexte());
    const bulles = hote.querySelectorAll(".elpis-msg-assistant");
    expect(bulles.length).toBe(1);
    expect(hote.querySelectorAll("[data-vs-idx]").length).toBe(1);
    expect(hote.querySelector("[data-wake-line]")).toBeNull();
    expect(hote.querySelector(".elpis-msg-wake")).toBeNull();
    const texte = bulles[0]?.textContent || "";
    expect(texte).not.toContain("Réveil");
    expect(texte).not.toContain("Automatic wake-up");
    const ordre = ["Je lance pytest.", "Un test échoue, je corrige.", "Tout passe."].map((t) =>
      texte.indexOf(t),
    );
    expect(ordre.every((p) => p >= 0)).toBe(true);
    expect([...ordre].sort((a, b) => a - b)).toEqual(ordre);
    expect([...hote.querySelectorAll("[data-vs-part]")].map((e) => e.getAttribute("data-vs-part"))).toEqual([
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(hote.querySelector("[data-reflexion]")).not.toBeNull();
  });

  it("un seul pied, à la fin : métriques de la dernière réponse, Copier toute la bulle, Régénérer et Détails de la dernière", () => {
    const hote = monter(() => h(MessageChat, { entry: bulle() }), contexte());
    const copier = hote.querySelectorAll<HTMLButtonElement>("button[title='Copier la réponse']");
    expect(copier.length).toBe(1);
    expect(hote.querySelector("[data-vs-part='5'] button[title='Copier la réponse']")).toBe(copier[0]);
    expect(hote.textContent).not.toContain("m-tete");
    expect(hote.textContent).toContain("m-fin");
    copier[0]?.click();
    expect(appels).toContainEqual([
      "copyAssistantMessage",
      "Je lance pytest.\n\nUn test échoue, je corrige.\n\nTout passe.",
    ]);
    const regenerer = hote.querySelectorAll<HTMLButtonElement>("button[title='Régénérer la réponse']");
    expect(regenerer.length).toBe(1);
    regenerer[0]?.click();
    expect(appels).toContainEqual(["retryGeneration", 5]);
    hote.querySelector<HTMLButtonElement>('button[aria-label="Détails de l\'exécution"]')?.click();
    expect(appels.find((a) => a[0] === "openRunDetails")?.[1]).toMatchObject({ run_ids: ["r2"] });
  });

  it("dernière réponse encore en cours : aucun pied", () => {
    const e = bulle();
    const suite = [...(e.suite ?? [])];
    suite[3] = { idx: 5, msg: { role: "assistant", content: "Je rel", isStreaming: true } };
    const enCours = { ...e, suite };
    const hote = monter(() => h(MessageChat, { entry: enCours }), contexte({ isStreaming: true }));
    expect(hote.querySelectorAll("button[title='Copier la réponse']").length).toBe(0);
  });

  it("recherche : la bulle reste nette si UNE de ses parties correspond, s'atténue sinon", () => {
    const net = monter(
      () => h(MessageChat, { entry: bulle() }),
      contexte({ messageSearchQ: "corrige", messageSearchActive: true }),
    );
    expect(net.querySelector("[data-vs-idx='1']")?.classList.contains("opacity-25")).toBe(false);
    app?.unmount();
    const terne = monter(
      () => h(MessageChat, { entry: bulle() }),
      contexte({ messageSearchQ: "introuvable", messageSearchActive: true }),
    );
    expect(terne.querySelector("[data-vs-idx='1']")?.classList.contains("opacity-25")).toBe(true);
  });

  it("saut vers un membre de la bulle : la bulle est mise en évidence", () => {
    const hote = monter(() => h(MessageChat, { entry: bulle() }), contexte({ vsFlashIdx: 3 }));
    expect(hote.querySelector("[data-vs-idx='1']")?.classList.contains("vs-jump-flash")).toBe(true);
  });

  it("sans suite : rendu inchangé (pied et copie du seul message)", () => {
    const entry: EntreeMessage = { idx: 1, msg: { role: "assistant", content: "Seul." } };
    const hote = monter(() => h(MessageChat, { entry }), contexte({ lastAssistantIdx: 1 }));
    hote.querySelector<HTMLButtonElement>("button[title='Copier la réponse']")?.click();
    expect(appels).toContainEqual(["copyAssistantMessage", "Seul."]);
    expect(hote.querySelector("[data-vs-part]")).toBeNull();
  });
});

describe("ListeMessages : bulle regroupée", () => {
  it("une ligne par bulle ; un membre qui change re-rend la bulle malgré le v-memo", async () => {
    const lignes = shallowRef<EntreeMessage[]>([{ idx: 0, msg: { role: "user", content: "q" } }, bulle()]);
    const ctx = contexte();
    Object.defineProperty(ctx, "visibleMessages", { get: () => lignes.value });
    const hote = monter(() => h(ListeMessages), ctx);
    expect([...hote.querySelectorAll("[data-vs-idx]")].map((e) => e.getAttribute("data-vs-idx"))).toEqual([
      "0",
      "1",
    ]);
    const tete = lignes.value[1] as EntreeMessage;
    const suite = [...(tete.suite ?? [])];
    suite[3] = { idx: 5, msg: { role: "assistant", content: "Tout passe, 42 tests." } };
    lignes.value = [lignes.value[0] as EntreeMessage, { ...tete, suite }];
    await nextTick();
    expect(hote.textContent).toContain("Tout passe, 42 tests.");
  });
});
