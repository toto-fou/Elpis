// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/questionnaire-integration.test.ts — questionnaire ask_user avec les vrais gestionnaires : wrapper de saisie du chat, cascade d'Échap globale, brouillon rendu par une régénération. */
import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerClavier } from "../../../src/app/racine/clavier";
import type { EtatClavier } from "../../../src/app/racine/clavier";
import { GestionnaireSession } from "../../../src/features/auth/session";
import { setupChat } from "../../../src/features/chat/coeur/chat";
import type { ModulesChat } from "../../../src/features/chat/coeur/chat";
import type { CtxChat, MessageChat, RefsRacineChat } from "../../../src/features/chat/coeur/types";

type Api = Record<string, unknown> & {
  generateResponse(): Promise<void>;
  handleInputKeydown(ev: KeyboardEvent): void;
  askUserKeydown(ev: KeyboardEvent): boolean;
  rouvrirAskUser(): void;
  handleInputInput(): Promise<void>;
};

const etatModules = { voixEchap: false, imageEchap: false };

const MODULES = {
  echantillonnage: () => ({
    showSamplingPanel: Vue.ref(false),
    samplingOverride: Vue.ref({}),
    loadEffectiveParams: () => undefined,
    _cleanSamplingOverride: () => null,
  }),
  voix: () => ({
    voiceState: Vue.ref("arrete"),
    cancelVoice: () => undefined,
    stopDictation: () => undefined,
    onAssistantStart: () => undefined,
    onAssistantStream: () => undefined,
    onAssistantToolStream: () => undefined,
    onAssistantFinal: () => undefined,
    voiceEscape: () => etatModules.voixEchap,
  }),
  images: () => ({
    imageMode: Vue.ref(false),
    imageAvailable: Vue.ref(false),
    imageViewer: Vue.ref(null),
    imageGallery: Vue.ref(null),
    imagePop: Vue.ref(null),
    imageEscape: () => etatModules.imageEchap,
    closeImageViewer: () => undefined,
    closeImageGallery: () => undefined,
    toggleImageMode: async () => false,
    closeImageMode: () => undefined,
    buildImageRequest: () => ({}),
    clearImageEditRef: () => undefined,
    loadImageStatus: async () => null,
  }),
} as unknown as ModulesChat;

function refs(messages: MessageChat[] = []): RefsRacineChat {
  return {
    user: Vue.ref(null),
    settings: Vue.ref({ enable_editor: false }),
    config: Vue.ref({ active_mcp_ids: [] }),
    messages: Vue.ref(messages),
    currentChatId: Vue.ref("c1"),
    inputMessage: Vue.ref(""),
    inputRef: Vue.ref(null),
    isStreaming: Vue.ref(false),
    currentView: Vue.ref("chat"),
    isUserScrolling: Vue.ref(false),
    features: Vue.ref({}),
  } as RefsRacineChat;
}

const ctx = (): CtxChat =>
  ({
    showToast: () => undefined,
    fetchAuth: async () => new Response("{}", { status: 404 }),
    openConfirm: async () => true,
    openPrompt: async () => null,
    systemAlert: Vue.ref(null),
    liveLogs: Vue.ref(null),
  }) as unknown as CtxChat;

const QS = () => [
  { q: "Quoi ?", options: ["A", "B"], multi: false, _sel: [], _free: "" },
  { q: "Outils ?", options: ["X", "Y"], multi: true, _sel: [], _free: "" },
];

type Panneau = { items: unknown[]; idx: number; ouvert: boolean; brouillon: string } | null;

/** Chat réel, questionnaire fermé puis rouvert sur un brouillon, clavier global en capture et zone de saisie dans le DOM. */
function monterTout(brouillon = "") {
  const scope = Vue.effectScope();
  const r = refs([
    { role: "user", content: "Q" },
    { role: "assistant", content: "R" },
  ]);
  const api = scope.run(() => setupChat(new GestionnaireSession(), r, ctx(), MODULES)) as unknown as Api;
  const s = {
    modules: { chat: api } as unknown as EtatClavier["modules"],
    modalState: Vue.ref({ isOpen: false }),
    contextMenu: Vue.ref({ isOpen: false }),
    showInfoModal: Vue.ref(false),
    showOpenCodeModal: Vue.ref(false),
    imgZoom: Vue.ref(null),
    showNotifPanel: Vue.ref(false),
    menuPagesOuvert: Vue.ref(false),
    currentView: Vue.ref("chat"),
    inputMessage: r.inputMessage,
    inputRef: Vue.ref(null),
    handleModalCancel: () => undefined,
    closeContextMenu: () => undefined,
  } as unknown as EtatClavier;
  const clavier = creerClavier(s);
  document.addEventListener("keydown", clavier.onGlobalKeydown, { capture: true });
  const carte = document.createElement("div");
  const zone = document.createElement("textarea");
  carte.appendChild(zone);
  document.body.appendChild(carte);
  carte.addEventListener("keydown", (ev) => void api.askUserKeydown(ev));
  zone.addEventListener("keydown", (ev) => api.handleInputKeydown(ev));
  r.inputRef.value = zone;
  const panneau = api["askUserPanel"] as Vue.Ref<Panneau>;
  r.inputMessage.value = brouillon;
  panneau.value = { items: QS(), idx: 0, ouvert: false, brouillon: "" };
  api.rouvrirAskUser();
  const frappe = (key: string, extra: KeyboardEventInit = {}): KeyboardEvent => {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
    zone.dispatchEvent(ev);
    return ev;
  };
  const arreter = (): void => {
    document.removeEventListener("keydown", clavier.onGlobalKeydown, { capture: true });
    scope.stop();
    carte.remove();
  };
  return { api, r, panneau, frappe, arreter };
}

let arret: (() => void) | null = null;

/** Tape « / » dans la zone : le menu des commandes s'ouvre (calculé depuis la saisie). */
async function ouvrirSlash(t: ReturnType<typeof monterTout>): Promise<void> {
  t.r.inputMessage.value = "/";
  const zone = t.r.inputRef.value as HTMLTextAreaElement;
  zone.value = "/";
  zone.setSelectionRange(1, 1);
  await t.api.handleInputInput();
  expect((t.api["showSlash"] as Vue.Ref<boolean>).value).toBe(true);
}

beforeEach(() => {
  etatModules.voixEchap = false;
  etatModules.imageEchap = false;
});

afterEach(() => {
  arret?.();
  arret = null;
  vi.unstubAllGlobals();
});

describe("Échap : une seule action par touche", () => {
  it("menu « / » ouvert : Échap ferme le menu, le questionnaire reste ouvert", async () => {
    const t = monterTout();
    arret = t.arreter;
    await ouvrirSlash(t);
    t.frappe("Escape");
    expect((t.api["showSlash"] as Vue.Ref<boolean>).value).toBe(false);
    expect(t.panneau.value?.ouvert).toBe(true);
    t.frappe("Escape");
    expect(t.panneau.value?.ouvert).toBe(false);
  });

  it("menu « @ » ouvert : même chose", () => {
    const t = monterTout();
    arret = t.arreter;
    (t.api["showMentionDropdown"] as Vue.Ref<boolean>).value = true;
    t.frappe("Escape");
    expect((t.api["showMentionDropdown"] as Vue.Ref<boolean>).value).toBe(false);
    expect(t.panneau.value?.ouvert).toBe(true);
  });

  it("dictée en cours (voiceEscape) : Échap l'arrête seulement", () => {
    const t = monterTout();
    arret = t.arreter;
    etatModules.voixEchap = true;
    t.frappe("Escape");
    expect(t.panneau.value?.ouvert).toBe(true);
    etatModules.voixEchap = false;
    t.frappe("Escape");
    expect(t.panneau.value?.ouvert).toBe(false);
  });

  it("mode Images (imageEscape) : Échap n'en sort que lui", () => {
    const t = monterTout();
    arret = t.arreter;
    etatModules.imageEchap = true;
    t.frappe("Escape");
    expect(t.panneau.value?.ouvert).toBe(true);
  });
});

describe("Entrée avec un menu ouvert", () => {
  it("le menu « @ » reçoit Entrée avant le questionnaire", () => {
    const t = monterTout();
    arret = t.arreter;
    (t.api["showMentionDropdown"] as Vue.Ref<boolean>).value = true;
    const ev = t.frappe("Enter");
    expect(ev.defaultPrevented).toBe(true);
    expect(t.panneau.value?.idx).toBe(0);
  });

  it("le menu « / » reçoit Entrée avant le questionnaire", async () => {
    const t = monterTout();
    arret = t.arreter;
    await ouvrirSlash(t);
    const ev = t.frappe("Enter");
    expect(ev.defaultPrevented).toBe(true);
    expect(t.panneau.value?.idx).toBe(0);
  });

  it("menus fermés : Entrée passe à la question suivante", () => {
    const t = monterTout();
    arret = t.arreter;
    t.frappe("Enter");
    expect(t.panneau.value?.idx).toBe(1);
  });

  it("composition IME : le composeur n'envoie pas, le questionnaire n'avance pas", () => {
    const t = monterTout();
    arret = t.arreter;
    const ev = t.frappe("Enter", { isComposing: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(t.panneau.value?.idx).toBe(0);
  });
});

describe("génération : le brouillon est rendu", () => {
  it("régénérer avec le questionnaire ouvert rend le brouillon à la zone et ferme le panneau", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: { signal: AbortSignal }) => {
      void init;
      return new Response(
        JSON.stringify({
          type: "final",
          assistant: "Ok",
          chat_id: "c1",
          run_ids: [],
          metrics: null,
          persisted: true,
        }) + "\n",
        { status: 200 },
      );
    });
    const t = monterTout("mon brouillon");
    arret = t.arreter;
    expect(t.r.inputMessage.value).toBe("");
    t.r.inputMessage.value = "texte libre en cours";
    await t.api.generateResponse();
    expect(t.panneau.value).toBeNull();
    expect(t.r.inputMessage.value).toBe("mon brouillon");
  });
});
