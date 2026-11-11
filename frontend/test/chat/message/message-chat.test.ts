// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/message-chat.test.ts — ligne de message : en-tête et actions, édition, réflexion, pièces jointes, demande d'image, pied, incidents ; actions remontées par l'adaptateur. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { CLE_FIL, CLE_LISTE } from "../../../src/features/chat/page/domaines";
import { CLE_PREFERENCES_CHAT } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";
import ListeMessages from "../../../src/components/chat/liste/ListeMessages.vue";
import MessageChat from "../../../src/components/chat/message/MessageChat.vue";
import type {
  ContexteListe,
  ContexteMessage,
  EntreeMessage,
  MessageAffiche,
} from "../../../src/features/chat/message/types";

let app: App | null = null;
const appels: unknown[][] = [];
const emis: unknown[][] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  emis.length = 0;
  document.body.innerHTML = "";
});

const ETAT = {
  settings: { assistant_name: "Elpis", hide_thinking: false },
  user: { username: "alice", avatar: null },
  skinCourant: {},
  nomMarque: "Elpis",
  logoApp: "static/elpis-256.png",
  lastAssistantIdx: 1,
  isStreaming: false,
  editingMessageIndex: null as number | null,
  editMessageText: "",
  messageSearchQ: "",
  messageSearchActive: false,
  compressionStatus: null,
  voiceReadingIdx: null,
  voiceCanRead: true,
};

/** Adaptateur de test : état réactif, toute action inconnue est enregistrée et rend une valeur neutre. */
function contexte(surcharges: Record<string, unknown> = {}): ContexteMessage {
  const etat = reactive({ ...ETAT, ...surcharges });
  const neutres: Record<string, unknown> = {
    pipelineFor: () => ({ show: false }),
    segGroupsFor: () => [],
    effectLinesFor: () => [],
    diffFilesFor: () => [],
    hasDiffFiles: () => false,
    isDiffEditorEnabled: () => false,
    isImageMessage: () => false,
    statusPhase: () => null,
    fmtThinkingMeta: () => "47 s",
    fmtElapsed: (s: number) => s + " s",
    thinkingTokensOf: () => 0,
    cachePctOf: () => 0,
    metricsTooltip: () => "",
    imageRequestLabel: () => "1 image, 1024×1024",
    toolLimitLabel: () => "Limite",
  };
  return new Proxy(etat, {
    set(cible, cle: string, valeur: unknown) {
      (cible as Record<string, unknown>)[cle] = valeur;
      return true;
    },
    get(cible, cle: string) {
      if (cle in cible) return (cible as Record<string, unknown>)[cle];
      if (cle in neutres) return neutres[cle];
      return (...args: unknown[]) => {
        appels.push([cle, ...args]);
      };
    },
  }) as unknown as ContexteMessage;
}

function monterRendu(rendu: () => VNode, ctx: ContexteMessage, classique = false): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  app.provide(CLE_PREFERENCES_CHAT, prefsDeroule(classique ? "classic" : "timeline"));
  app.provide(CLE_FIL, ctx);
  app.provide(CLE_LISTE, ctx as ContexteListe);
  app.mount(hote);
  return hote;
}

function monter(msg: MessageAffiche, ctx: ContexteMessage, idx = 1, classique = false): HTMLElement {
  const entry: EntreeMessage = { idx, msg };
  return monterRendu(
    () =>
      h(MessageChat, {
        entry,
        "onZoom-image": (u: string) => emis.push(["zoom", u]),
        onEdition: (t: string) => emis.push(["edition", t]),
      }),
    ctx,
    classique,
  );
}

describe("MessageChat", () => {
  it("message utilisateur : en-tête, actions, pièces jointes, demande d'image", () => {
    const hote = monter(
      {
        role: "user",
        content: "Bonjour",
        images: [{ dataUrl: "data:image/png;base64,AA", name: "a.png" }],
        files: ["notes.md", { name: "code.py", lines: 12 }],
        image_request: { ref_image_id: "img1" },
      },
      contexte(),
      0,
    );
    const ligne = hote.querySelector("[data-vs-idx='0']") as HTMLElement;
    expect(ligne.classList.contains("elpis-msg-user")).toBe(true);
    expect(ligne.textContent).toContain("alice");
    expect(hote.querySelectorAll(".file-chip").length).toBe(2);
    expect(hote.textContent).toContain("12L");
    expect(hote.querySelector("[data-image-request]")?.textContent).toContain("1 image");
    hote.querySelector<HTMLButtonElement>("button[title='Éditer et renvoyer']")?.click();
    hote.querySelector<HTMLImageElement>("img[alt='a.png']")?.click();
    hote.querySelector<HTMLButtonElement>(".elpis-img-reqline__ref")?.click();
    expect(appels.map((a) => a[0])).toEqual(["startEditMessage", "openImageViewer"]);
    expect(emis).toEqual([["zoom", "data:image/png;base64,AA"]]);
  });

  it("édition : le texte remonte par l'événement, Ctrl+Entrée envoie", async () => {
    const hote = monter(
      { role: "user", content: "x" },
      contexte({ editingMessageIndex: 0, editMessageText: "a" }),
      0,
    );
    const ta = hote.querySelector("textarea[data-edit-message-input]") as HTMLTextAreaElement;
    expect(ta.value).toBe("a");
    ta.value = "ab";
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    await nextTick();
    expect(emis).toEqual([["edition", "ab"]]);
    expect(appels).toContainEqual(["submitEditMessage", 0]);
  });

  it("réponse (déroulé Classique) : réflexion repliable, corps Markdown, pied et actions", () => {
    const hote = monter(
      {
        role: "assistant",
        content: "**Salut**",
        thinking: "Je réfléchis",
        metrics: { model: "m1", duration: 3, write_tps: 40 },
        run_ids: ["r1"],
      },
      contexte(),
      1,
      true,
    );
    expect(hote.querySelector("details[data-think] summary")?.textContent).toContain("47 s");
    expect(hote.querySelector(".markdown-body strong")?.textContent).toBe("Salut");
    expect(hote.textContent).toContain("m1");
    hote.querySelector<HTMLButtonElement>("button[title='Copier la réponse']")?.click();
    hote.querySelector<HTMLButtonElement>('button[aria-label="Détails de l\'exécution"]')?.click();
    const noms = appels.map((a) => a[0]);
    expect(noms).toContain("copyAssistantMessage");
    expect(noms).toContain("openRunDetails");
    const d = hote.querySelector("details[data-think]") as HTMLDetailsElement;
    d.open = true;
    d.dispatchEvent(new Event("toggle"));
    expect(appels.find((a) => a[0] === "setMsgUi")?.[2]).toEqual({ thinkingOpen: true });
  });

  it("réponse : réflexion en ligne « Réflexion · 3 s » dépliable à sa place, avant le corps", () => {
    const hote = monter(
      { role: "assistant", content: "**Salut**", thinking: "Je réfléchis", _thinkingMs: 3000, metrics: {} },
      contexte(),
    );
    expect(hote.querySelector("details[data-think]")).toBeNull();
    const ligne = hote.querySelector("[data-reflexion] button") as HTMLButtonElement;
    expect(ligne.textContent?.replace(/\s+/g, " ").trim()).toBe("Réflexion · 3 s");
    expect(ligne.getAttribute("aria-expanded")).toBe("false");
    const corps = hote.querySelector(".markdown-body strong");
    expect(ligne.compareDocumentPosition(corps as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    ligne.click();
    expect(appels.find((a) => a[0] === "setMsgUi")?.[2]).toEqual({ _filOuverts: { "r:fin": true } });
  });

  it("incidents : réponse interrompue (Continuer) et erreur en ligne sous le texte partiel (Reprendre)", () => {
    const hote = monter({ role: "assistant", content: "début", isTruncated: true }, contexte());
    hote
      .querySelector<HTMLButtonElement>("button[aria-label='Continuer la génération interrompue']")
      ?.click();
    expect(appels).toContainEqual(["continueGeneration"]);
    app?.unmount();
    const h2 = monter(
      {
        role: "assistant",
        content: "pg_dump -Fc -d recette",
        isTruncated: true,
        isError: true,
        errorMessage: "Le serveur du modèle est injoignable.",
        errorDetail: "connect ECONNREFUSED 10.0.0.12:8080",
        errorKind: "unreachable",
      },
      contexte(),
    );
    expect(h2.textContent).toContain("pg_dump -Fc -d recette");
    expect(h2.querySelector("[data-interruption]")?.textContent).toContain(
      "Interrompue : serveur injoignable",
    );
    expect(h2.querySelector(".elpis-error-card")).toBeNull();
    expect(h2.textContent).not.toContain("Erreur d'exécution");
    expect(h2.querySelector("button[aria-label='Continuer la génération interrompue']")).toBeNull();
    h2.querySelector<HTMLButtonElement>("[data-interruption-action]")?.click();
    expect(appels).toContainEqual(["resumeAfterError", 1]);
  });

  it("avatar de l'assistant : logo de l'application, aucune icône Phosphor, même en erreur ; utilisateur inchangé", () => {
    const LOGO = "/api/app-logo?v=0123456789abcdef";
    const hote = monter(
      { role: "assistant", content: "ok" },
      contexte({ logoApp: LOGO, settings: { assistant_icon: "ph-cat", assistant_avatar: "bot_1_2.png" } }),
    );
    expect(hote.querySelector("img[data-avatar-assistant]")?.getAttribute("src")).toBe(LOGO);
    expect(hote.querySelector(".ph-robot, .ph-cat")).toBeNull();
    expect(hote.innerHTML).not.toContain("bot_1_2.png");
    app?.unmount();
    const erreur = monter(
      { role: "assistant", isError: true, errorMessage: "boum" },
      contexte({ logoApp: LOGO }),
    );
    expect(erreur.querySelector("img[data-avatar-assistant]")?.getAttribute("src")).toBe(LOGO);
    app?.unmount();
    const moi = monter({ role: "user", content: "q" }, contexte({ logoApp: LOGO }));
    expect(moi.querySelector("img[data-avatar-assistant]")).toBeNull();
  });

  it("recherche : ligne non correspondante atténuée", () => {
    const hote = monter(
      { role: "assistant", content: "rien" },
      contexte({ messageSearchQ: "chat", messageSearchActive: true }),
    );
    expect(hote.querySelector("[data-vs-idx]")?.classList.contains("opacity-25")).toBe(true);
  });
});

describe("ListeMessages", () => {
  it("cales de la fenêtre, une ligne par entrée visible, ligne du saut mise en évidence", async () => {
    const entrees: EntreeMessage[] = [
      { idx: 40, msg: { role: "user", content: "q" } },
      { idx: 41, msg: { role: "assistant", content: "r" } },
    ];
    const ctx = contexte({
      visibleMessages: entrees,
      vsTopPad: 500,
      vsBotPad: 0,
      effectUiRev: 0,
      diffCardRev: 0,
      isThinking: false,
      statusText: "",
      compactionNotice: null,
      currentChatId: "c1",
      lastAssistantIdx: 41,
      vsFlashIdx: null,
    }) as ContexteListe;
    const hote = monterRendu(() => h(ListeMessages), ctx);
    const lignes = hote.querySelectorAll("[data-vs-idx]");
    expect([...lignes].map((l) => l.getAttribute("data-vs-idx"))).toEqual(["40", "41"]);
    expect((hote.firstElementChild as HTMLElement).style.height).toBe("500px");
    (ctx as unknown as { vsFlashIdx: number }).vsFlashIdx = 41;
    await nextTick();
    expect(hote.querySelector("[data-vs-idx='41']")?.classList.contains("vs-jump-flash")).toBe(true);
  });

  it("avis de compaction : avatar = logo de l'application", () => {
    const LOGO = "/api/app-logo?v=0123456789abcdef";
    const ctx = contexte({
      logoApp: LOGO,
      visibleMessages: [],
      vsTopPad: 0,
      vsBotPad: 0,
      effectUiRev: 0,
      diffCardRev: 0,
      isThinking: false,
      statusText: "",
      compactionNotice: { chatId: "c1", state: "running", pct: 40 },
      currentChatId: "c1",
      vsFlashIdx: null,
    }) as ContexteListe;
    const hote = monterRendu(() => h(ListeMessages), ctx);
    expect(hote.textContent).toContain("Compaction en cours");
    expect(hote.querySelector("img[data-avatar-assistant]")?.getAttribute("src")).toBe(LOGO);
    expect(hote.querySelector(".ph-robot")).toBeNull();
  });
});
