// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/battement.test.ts — battement du flux : une mise à jour du message par image (porteur ou remplacement), arrêt au repos, budget par image, onglet caché, vidage synchrone (Stop, appel d'outil, fin), voix, une écriture de défilement par image, panneau de réflexion, caret plein tant que le texte coule. */
import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ContenuMarkdown from "../../../src/components/chat/ContenuMarkdown.vue";
import TexteFlux from "../../../src/components/chat/TexteFlux.vue";
import { GestionnaireSession } from "../../../src/features/auth/session";
import { setupChat } from "../../../src/features/chat/coeur/chat";
import type { ModulesChat } from "../../../src/features/chat/coeur/chat";
import { projeterPourPersistance } from "../../../src/features/chat/coeur/persistance";
import type { CtxChat, MessageChat, RefsRacineChat } from "../../../src/features/chat/coeur/types";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";

vi.mock("../../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));

type Ev = Record<string, unknown>;
type Api = Record<string, unknown> & {
  handleStreamEvent(e: Ev): Promise<void>;
  stopGeneration(): void;
};

const voix = {
  onAssistantStream: vi.fn(),
  onAssistantToolStream: vi.fn(),
};

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
    onAssistantStream: voix.onAssistantStream,
    onAssistantToolStream: voix.onAssistantToolStream,
    onAssistantFinal: () => undefined,
  }),
  images: () => ({
    imageMode: Vue.ref(false),
    imageAvailable: Vue.ref(false),
    imageViewer: Vue.ref(null),
    imageGallery: Vue.ref(null),
    imagePop: Vue.ref(null),
    imageEscape: () => false,
    closeImageViewer: () => undefined,
    closeImageGallery: () => undefined,
    toggleImageMode: async () => false,
    closeImageMode: () => undefined,
    buildImageRequest: () => ({}),
    clearImageEditRef: () => undefined,
    loadImageStatus: async () => null,
  }),
} as unknown as ModulesChat;

function refs(messages: MessageChat[]): RefsRacineChat {
  return {
    user: Vue.ref(null),
    settings: Vue.ref({ enable_editor: false }),
    config: Vue.ref({ active_mcp_ids: [] }),
    messages: Vue.ref(messages),
    currentChatId: Vue.ref("c1"),
    inputMessage: Vue.ref(""),
    inputRef: Vue.ref(null),
    isStreaming: Vue.ref(true),
    currentView: Vue.ref("chat"),
    isUserScrolling: Vue.ref(false),
    features: Vue.ref({}),
  } as RefsRacineChat;
}

function ctx(): CtxChat {
  return {
    showToast: () => undefined,
    fetchAuth: async () => new Response("{}", { status: 404 }),
    openConfirm: async () => true,
    openPrompt: async () => null,
    systemAlert: Vue.ref(null),
    liveLogs: Vue.ref(null),
  } as unknown as CtxChat;
}

/** Images simulées : une file de rappels déclenchée à la main, l'horloge avance de 1/60 s à chaque image. */
let file = new Map<number, FrameRequestCallback>();
let ids = 0;
const IMAGE = 1000 / 60;

async function image(n = 1): Promise<void> {
  for (let k = 0; k < n; k++) {
    vi.advanceTimersByTime(IMAGE);
    const rappels = [...file.values()];
    file.clear();
    for (const rappel of rappels) rappel(performance.now());
    await vi.advanceTimersByTimeAsync(0);
  }
}

const noyaux: Vue.EffectScope[] = [];

function monter(texte = ""): { api: Api; r: RefsRacineChat; remplacements: () => number; stop: () => void } {
  const r = refs([
    { role: "user", content: "Q" },
    { role: "assistant", content: texte, isStreaming: true },
  ]);
  const scope = Vue.effectScope();
  const api = scope.run(() => setupChat(new GestionnaireSession(), r, ctx(), MODULES)) as unknown as Api;
  let n = 0;
  scope.run(() =>
    Vue.watch(
      () => r.messages.value[1],
      () => n++,
      { flush: "sync" },
    ),
  );
  noyaux.push(scope);
  return { api, r, remplacements: () => n, stop: () => scope.stop() };
}

const bulle = (r: RefsRacineChat): MessageChat | undefined => r.messages.value[1];
const contenu = (api: Api, texte: string, n = 1): Promise<void> =>
  api.handleStreamEvent({ type: "content_token", text: texte, n });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  file = new Map();
  ids = 0;
  vi.stubGlobal("requestAnimationFrame", (rappel: FrameRequestCallback) => {
    file.set(++ids, rappel);
    return ids;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => file.delete(id));
  voix.onAssistantStream.mockClear();
  voix.onAssistantToolStream.mockClear();
});

afterEach(() => {
  for (const scope of noyaux.splice(0)) scope.stop();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("battement : une image, un remplacement", () => {
  it("plusieurs événements dans la même image : un seul remplacement du message", async () => {
    const { api, r, remplacements, stop } = monter();
    await contenu(api, "Bon");
    await contenu(api, "jour");
    await contenu(api, " tout");
    expect(remplacements()).toBe(0);
    await image();
    expect(remplacements()).toBe(1);
    expect("Bonjour tout".startsWith(bulle(r)?.content ?? "x")).toBe(true);
    // Une image de plus, un remplacement de plus, jamais deux ; le texte finit par tout apparaître.
    for (let k = 0; k < 40; k++) {
      const avant = remplacements();
      await image();
      expect(remplacements() - avant).toBeLessThanOrEqual(1);
    }
    expect(bulle(r)?.content).toBe("Bonjour tout");
    stop();
  });

  it("réflexion et sortie shell arrivées ensemble : un seul remplacement par image", async () => {
    const { api, r, remplacements, stop } = monter();
    r.messages.value[1] = {
      ...r.messages.value[1]!,
      toolSteps: [{ name: "execute_shell", status: "running", callId: "s" }],
    };
    const avant = remplacements();
    await api.handleStreamEvent({ type: "thinking_token", text: "Je réfléchis. ", n: 1 });
    await api.handleStreamEvent({
      type: "shell_output",
      name: "execute_shell",
      call_id: "s",
      chunk: "ligne 1\n",
      seq: 1,
    });
    await image();
    expect(remplacements() - avant).toBe(1);
    expect(bulle(r)?.thinking?.length).toBeGreaterThan(0);
    expect(bulle(r)?.toolSteps?.[0]?.shellOut).toBe("ligne 1\n");
    await image(30);
    expect(bulle(r)?.thinking).toBe("Je réfléchis. ");
    stop();
  });

  it("la sortie shell d'une étape est coalescée : au plus un patch toutes les 100 ms", async () => {
    const { api, r, remplacements, stop } = monter();
    r.messages.value[1] = {
      ...r.messages.value[1]!,
      toolSteps: [{ name: "execute_shell", status: "running", callId: "s" }],
    };
    const avant = remplacements();
    for (let k = 1; k <= 12; k++) {
      await api.handleStreamEvent({
        type: "shell_output",
        name: "execute_shell",
        call_id: "s",
        chunk: `l${k}\n`,
        seq: k,
      });
      await image();
    }
    const patchs = remplacements() - avant;
    expect(patchs).toBeGreaterThanOrEqual(1);
    expect(patchs).toBeLessThanOrEqual(3);
    await image(8);
    expect(bulle(r)?.toolSteps?.[0]?.shellOut).toBe(
      Array.from({ length: 12 }, (_v, k) => `l${k + 1}\n`).join(""),
    );
    stop();
  });
});

describe("battement : arrêt au repos", () => {
  it("rien n'est demandé tant qu'aucun tampon ne reçoit de texte, ni une fois tout versé", async () => {
    const { api, stop } = monter();
    expect(file.size).toBe(0);
    await contenu(api, "Un texte assez long pour plusieurs images de suite.");
    expect(file.size).toBe(1);
    await image(40);
    expect(file.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("l'événement d'erreur puis la fin de flux laissent le battement éteint", async () => {
    const { api, stop } = monter();
    await contenu(api, "abc");
    await image(30);
    await api.handleStreamEvent({ type: "error", text: "boum" });
    await image(3);
    expect(file.size).toBe(0);
    stop();
  });
});

describe("battement : budget", () => {
  it("un battement coûteux fait sauter des images, les tampons se remplissent entre deux", async () => {
    const { api, r, remplacements, stop } = monter();
    const moteur = moteurMarkdown();
    const vrai = moteur.avancerFlux;
    const rendu = vi.spyOn(moteur, "avancerFlux").mockImplementation((...args: Parameters<typeof vrai>) => {
      vi.advanceTimersByTime(20);
      return vrai(...args);
    });
    await contenu(api, "a");
    await image();
    expect(remplacements()).toBe(1);
    // 20 ms de coût moyen : des images sautées, le texte arrivé entre deux s'accumule ; le texte qui grandit ne remplace pas le message.
    const avant = remplacements();
    let plusGros = 0;
    let majs = 0;
    let longueur = bulle(r)?.content?.length ?? 0;
    for (let k = 0; k < 9; k++) {
      await contenu(api, "b".repeat(30));
      await image();
      const nouvelle = bulle(r)?.content?.length ?? 0;
      plusGros = Math.max(plusGros, nouvelle - longueur);
      if (nouvelle > longueur) majs++;
      longueur = nouvelle;
    }
    expect(majs).toBeGreaterThanOrEqual(3);
    expect(majs).toBeLessThanOrEqual(5);
    expect(remplacements() - avant).toBe(0);
    expect(plusGros).toBeGreaterThanOrEqual(40);
    expect(bulle(r)?.content).toMatch(/^ab*$/);
    rendu.mockRestore();
    stop();
  });
});

describe("battement : onglet caché", () => {
  it("aucune image, une minuterie de 250 ms verse tout d'un coup, la voix reçoit le texte", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const { api, r, remplacements, stop } = monter();
    await contenu(api, "Bonjour ");
    await contenu(api, "à tous");
    expect(file.size).toBe(0);
    await vi.advanceTimersByTimeAsync(249);
    expect(remplacements()).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(remplacements()).toBe(1);
    expect(bulle(r)?.content).toBe("Bonjour à tous");
    expect(voix.onAssistantStream).toHaveBeenLastCalledWith("Bonjour à tous");
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("le retour de l'onglet annule la minuterie et reprend aux images", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const { api, r, stop } = monter();
    await contenu(api, "Texte en attente");
    expect(file.size).toBe(0);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(file.size).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(bulle(r)?.content).toBe("");
    await image();
    expect(bulle(r)?.content?.length).toBeGreaterThan(0);
    await image(40);
    expect(bulle(r)?.content).toBe("Texte en attente");
    stop();
  });
});

describe("battement : vidage synchrone", () => {
  it("Stop verse tout de suite le texte en attente et éteint le battement", async () => {
    const { api, r, stop } = monter();
    await api.handleStreamEvent({ type: "thinking_token", text: "Je pense.", n: 1 });
    await contenu(api, "Début de réponse");
    api.stopGeneration();
    expect(bulle(r)?.thinking).toBe("Je pense.");
    expect(bulle(r)?.content).toContain("Début de réponse");
    expect(bulle(r)?.isStreaming).toBe(false);
    expect(file.size).toBe(0);
    stop();
  });

  it("un appel d'outil verse le texte en attente dans la narration de l'étape", async () => {
    const { api, r, stop } = monter();
    await contenu(api, "Je regarde ce fichier.");
    await api.handleStreamEvent({
      type: "tool_call",
      name: "read_file",
      call_id: "t",
      args: { path: "a.txt" },
    });
    expect(bulle(r)?.segTexts?.join("")).toContain("Je regarde ce fichier.");
    expect(bulle(r)?.content).toBe("");
    expect(file.size).toBe(0);
    stop();
  });

  it("la fin du tour verse tout le texte et éteint le battement", async () => {
    const { api, r, stop } = monter();
    await api.handleStreamEvent({ type: "thinking_token", text: "Réflexion.", n: 1 });
    await contenu(api, "Réponse complète");
    await api.handleStreamEvent({
      type: "final",
      assistant: "",
      chat_id: "c1",
      run_ids: [],
      metrics: null,
      persisted: true,
    });
    expect(bulle(r)).toMatchObject({
      content: "Réponse complète",
      thinking: "Réflexion.",
      isStreaming: false,
    });
    expect(file.size).toBe(0);
    stop();
  });
});

describe("battement : caret plein tant que le texte coule", () => {
  const COULE = "elpis-texte-coule";

  it("le fil porte la classe dès le premier caractère versé et la perd 400 ms après le dernier, sans toucher au message", async () => {
    const { api, r, remplacements, stop } = monter();
    const fil = document.createElement("div");
    (api["chatContainer"] as Vue.Ref<HTMLElement | null>).value = fil;
    await contenu(api, "Bonjour");
    expect(fil.classList.contains(COULE)).toBe(false);
    await image();
    expect(fil.classList.contains(COULE)).toBe(true);
    // Arrivées régulières, plus espacées qu'une image : la classe reste.
    for (let k = 0; k < 20; k++) {
      await contenu(api, " mot");
      await image(3);
      expect(fil.classList.contains(COULE)).toBe(true);
    }
    const complet = "Bonjour" + " mot".repeat(20);
    while (bulle(r)?.content !== complet) await image();
    const avant = remplacements();
    await vi.advanceTimersByTimeAsync(390);
    expect(fil.classList.contains(COULE)).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(fil.classList.contains(COULE)).toBe(false);
    expect(remplacements()).toBe(avant);
    expect(vi.getTimerCount()).toBe(0);
    // Le texte reprend : la classe revient à l'image qui le verse.
    await contenu(api, " suite");
    expect(fil.classList.contains(COULE)).toBe(false);
    await image();
    expect(fil.classList.contains(COULE)).toBe(true);
    stop();
    expect(fil.classList.contains(COULE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("la réflexion seule ne pose pas la classe (aucun caret ne la suit)", async () => {
    const { api, stop } = monter();
    const fil = document.createElement("div");
    (api["chatContainer"] as Vue.Ref<HTMLElement | null>).value = fil;
    await api.handleStreamEvent({ type: "thinking_token", text: "Je réfléchis longuement.", n: 1 });
    await image(20);
    expect(fil.classList.contains(COULE)).toBe(false);
    stop();
  });
});

describe("battement : titre de la réflexion", () => {
  it("recalculé au plus toutes les 250 ms", async () => {
    const { api, stop } = monter();
    const statut = api["statusText"] as Vue.Ref<string>;
    const titres: string[] = [];
    Vue.watch(statut, (v) => titres.push(v), { flush: "sync" });
    for (let k = 0; k < 60; k++) {
      await api.handleStreamEvent({ type: "thinking_token", text: `Phrase numéro ${k} terminée. `, n: 1 });
      await image();
    }
    expect(titres.length).toBeGreaterThanOrEqual(3);
    expect(titres.length).toBeLessThanOrEqual(6);
    stop();
  });
});

/** Conteneur de fil simulé : hauteur fixe, écritures de `scrollTop` comptées et datées par rapport à la mise à jour du message (remplacement ou porteur). */
function fil(r: RefsRacineChat, scope: Vue.EffectScope) {
  const journal: string[] = [];
  let haut = 0;
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: 5000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => haut,
    set: (v: number) => {
      haut = v;
      journal.push("défilement");
    },
  });
  scope.run(() =>
    Vue.watch(
      () => [r.messages.value[1], r.messages.value[1]?._flux?.corps.value],
      () => journal.push("message"),
      { flush: "post" },
    ),
  );
  return { el, journal };
}

/** Panneau de réflexion simulé dans le fil. */
function panneau(parent: HTMLElement, haut: number) {
  const bloc = document.createElement("div");
  bloc.setAttribute("data-reflexion", "");
  const pre = document.createElement("pre");
  let st = haut;
  Object.defineProperty(pre, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(pre, "clientHeight", { value: 100, configurable: true });
  Object.defineProperty(pre, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => (st = v),
  });
  bloc.appendChild(pre);
  parent.appendChild(bloc);
  return pre;
}

describe("battement : une écriture de défilement par image", () => {
  it("après la mise à jour du message, une fois par image qui a versé du texte", async () => {
    const { api, r, stop } = monter();
    const noyau = noyaux[noyaux.length - 1] as Vue.EffectScope;
    const { el, journal } = fil(r, noyau);
    (api["chatContainer"] as Vue.Ref<HTMLElement | null>).value = el;
    for (let k = 0; k < 4; k++) {
      await contenu(api, "x".repeat(20));
      await image();
    }
    expect(journal.filter((j) => j === "défilement").length).toBe(
      journal.filter((j) => j === "message").length,
    );
    expect(journal.length).toBeGreaterThanOrEqual(2);
    for (let k = 0; k < journal.length; k += 2)
      expect(journal.slice(k, k + 2)).toEqual(["message", "défilement"]);
    expect(el.scrollTop).toBe(5000);
    stop();
  });

  it("le lecteur remonté n'est pas ramené en bas", async () => {
    const { api, r, stop } = monter();
    const { el, journal } = fil(r, noyaux[noyaux.length - 1] as Vue.EffectScope);
    (api["chatContainer"] as Vue.Ref<HTMLElement | null>).value = el;
    r.isUserScrolling.value = true;
    await contenu(api, "x".repeat(40));
    await image(3);
    expect(journal).toContain("message");
    expect(journal).not.toContain("défilement");
    stop();
  });

  it("panneau de réflexion : recollé en bas s'il y était, laissé s'il a été remonté", async () => {
    const { api, r, stop } = monter();
    const { el } = fil(r, noyaux[noyaux.length - 1] as Vue.EffectScope);
    (api["chatContainer"] as Vue.Ref<HTMLElement | null>).value = el;
    const collee = panneau(el, 400);
    await api.handleStreamEvent({ type: "thinking_token", text: "Je réfléchis. ", n: 1 });
    await image();
    expect(collee.scrollTop).toBe(500);
    el.removeChild(collee.parentElement as Node);
    const remontee = panneau(el, 120);
    await api.handleStreamEvent({ type: "thinking_token", text: "Encore une idée. ", n: 1 });
    await image(3);
    expect(remontee.scrollTop).toBe(120);
    stop();
  });
});

describe("battement : le corps garde ses blocs à la fin", () => {
  const FIN = { type: "final", chat_id: "c1", run_ids: [], metrics: null, persisted: true };
  const TEXTE = "Un paragraphe.\n\nDeux paragraphes.\n\n- a\n- b\n\nTrois";

  async function diffuser(api: Api): Promise<void> {
    await contenu(api, TEXTE);
    await image(60);
  }

  it("final : le bloc actif est figé avec les autres, le message garde sa liste de blocs", async () => {
    const { api, r, stop } = monter();
    await diffuser(api);
    const avant = bulle(r)?._mdBlocks ?? [];
    expect(avant.length).toBeGreaterThan(0);
    expect(bulle(r)?._mdActiveHtml).not.toBe("");
    await api.handleStreamEvent({ ...FIN, assistant: "" });
    const m = bulle(r);
    expect(m?.isStreaming).toBe(false);
    expect(m?.content).toBe(TEXTE);
    expect(m?._mdActiveHtml).toBe("");
    expect(m?._mdFlux?.source).toBe(TEXTE);
    expect((m?._mdBlocks ?? []).map((b) => b.html).join("")).toBe(moteurMarkdown().renderMarkdown(TEXTE));
    (m?._mdBlocks ?? []).slice(0, avant.length).forEach((b, i) => expect(b).toBe(avant[i]));
    stop();
  });

  it("final : le texte du serveur plus long réutilise les blocs figés et rend le texte du serveur", async () => {
    const { api, r, stop } = monter();
    await diffuser(api);
    const avant = bulle(r)?._mdBlocks ?? [];
    const serveur = TEXTE + " et la fin.\n\nQuatre.\n";
    await api.handleStreamEvent({ ...FIN, assistant: serveur });
    const m = bulle(r);
    expect(m?.content).toBe(serveur);
    expect(m?._mdFlux?.source).toBe(serveur);
    expect((m?._mdBlocks ?? []).map((b) => b.html).join("")).toBe(moteurMarkdown().renderMarkdown(serveur));
    avant.forEach((b, i) => expect(m?._mdBlocks?.[i]).toBe(b));
    stop();
  });

  it("Stop : le message arrêté garde ses blocs", async () => {
    const { api, r, stop } = monter();
    await diffuser(api);
    api.stopGeneration();
    const m = bulle(r);
    expect(m?.isStreaming).toBe(false);
    expect(m?._mdFlux?.source).toBe(m?.content);
    expect((m?._mdBlocks ?? []).map((b) => b.html).join("")).toBe(
      moteurMarkdown().renderMarkdown(m?.content),
    );
    stop();
  });

  it("remplacement du texte : les blocs de tête inchangés sont gardés, la suite est redécoupée", async () => {
    const { api, r, stop } = monter();
    await diffuser(api);
    const tete = [...(bulle(r)?._mdBlocks ?? [])];
    expect(tete.length).toBeGreaterThan(1);
    const remplace = TEXTE.replace("Trois", "Tout autre texte.\n\nFin");
    await api.handleStreamEvent({ type: "content_replace", text: remplace });
    const m = bulle(r);
    expect(m?.isStreaming).toBe(true);
    expect(m?.content).toBe(remplace);
    tete.forEach((b, i) => expect(m?._mdBlocks?.[i]).toBe(b));
    expect(m?._mdFlux?.source).toBe(remplace);
    stop();
  });

  it("remplacement après la fin : le texte du serveur est figé, sans curseur ni bloc actif", async () => {
    const { api, r, stop } = monter();
    await diffuser(api);
    await api.handleStreamEvent({ ...FIN, assistant: "" });
    const remplace = TEXTE.replace("Trois", "Une autre fin.");
    await api.handleStreamEvent({ type: "content_replace", text: remplace });
    const m = bulle(r);
    expect(m?.isStreaming).toBe(false);
    expect(m?.content).toBe(remplace);
    expect(m?._mdActiveHtml).toBe("");
    expect(m?._mdFlux?.source).toBe(remplace);
    expect((m?._mdBlocks ?? []).map((b) => b.html).join("")).toBe(moteurMarkdown().renderMarkdown(remplace));
    expect(m?._flux ?? null).toBeNull();
    stop();
  });

  it("erreur : les blocs sont retirés, le corps repasse au rendu complet", async () => {
    const { api, r, stop } = monter();
    await diffuser(api);
    await api.handleStreamEvent({ type: "error", text: "boum" });
    const m = bulle(r);
    expect(m?.isStreaming).toBe(false);
    expect(m?._mdBlocks).toBeNull();
    expect(m?._mdFlux).toBeNull();
    stop();
  });

  it("pièces jointes dans le texte : aucun bloc gardé", async () => {
    const { api, r, stop } = monter();
    await contenu(api, "--- FILE: a.txt ---\nx\n--- END FILE ---\nTexte");
    await image(10);
    await api.handleStreamEvent({ ...FIN, assistant: "" });
    expect(bulle(r)?._mdBlocks).toBeNull();
    stop();
  });
});

describe("porteur du flux : le message n'est remplacé que pour sa structure", () => {
  const FIN = { type: "final", chat_id: "c1", run_ids: [], metrics: null, persisted: true, assistant: "" };

  it("le texte qui grandit garde l'objet message ; le porteur et l'objet brut portent l'affichage à jour", async () => {
    const { api, r, remplacements, stop } = monter();
    await contenu(api, "Un premier paragraphe.\n\nUn second qui s'écrit");
    await image();
    expect(remplacements()).toBe(1);
    const m = bulle(r) as MessageChat;
    expect(m._flux).toBeTruthy();
    for (let k = 0; k < 12; k++) {
      await contenu(api, " encore");
      await image();
      expect(bulle(r)).toBe(m);
      expect(m._flux?.corps.value.actif).toBe(m._mdActiveHtml);
      expect(m._flux?.corps.value.blocs ?? null).toBe(m._mdBlocks ?? null);
    }
    await image(60);
    expect(remplacements()).toBe(1);
    expect(m.content).toBe("Un premier paragraphe.\n\nUn second qui s'écrit" + " encore".repeat(12));
    expect(Vue.toRaw(m).content).toBe(m.content);
    expect(m._flux?.corps.value.actif).toContain("encore encore");
    stop();
  });

  it("chaque changement de vacuité de content, thinking et _pendingPreContent remplace le message", async () => {
    const { api, r, remplacements, stop } = monter();
    await api.handleStreamEvent({ type: "thinking_token", text: "  ", n: 1 });
    await image(3);
    expect(remplacements()).toBe(1);
    await api.handleStreamEvent({ type: "thinking_token", text: "Je pense", n: 1 });
    await image(3);
    expect(remplacements()).toBe(2);
    await api.handleStreamEvent({ type: "thinking_token", text: " encore et encore", n: 1 });
    await image(30);
    expect(remplacements()).toBe(2);
    expect(bulle(r)?._flux?.reflexion.value).toBe("  Je pense encore et encore");
    await contenu(api, "Réponse");
    await image(3);
    const apresCorps = remplacements();
    expect(apresCorps).toBeGreaterThan(2);
    await contenu(api, " qui continue");
    await image(30);
    expect(remplacements()).toBe(apresCorps);
    // Appel d'outil : le texte part dans la narration ; la narration suivante change de vacuité, puis grandit sans remplacement.
    await api.handleStreamEvent({ type: "tool_call", name: "read_file", call_id: "t", args: { path: "a" } });
    await api.handleStreamEvent({ type: "tool_result", name: "read_file", call_id: "t", result: "{}" });
    const avantNarration = remplacements();
    await contenu(api, "Je lis");
    await image(3);
    expect(remplacements()).toBeGreaterThan(avantNarration);
    const narration = remplacements();
    await contenu(api, " le fichier suivant.");
    await image(30);
    expect(remplacements()).toBe(narration);
    expect(bulle(r)?._pendingPreContent).toBe("Je lis le fichier suivant.");
    expect(bulle(r)?._flux?.narration.value.actif).toContain("le fichier suivant.");
    stop();
  });

  it("continuation d'un message déjà rempli : un remplacement pour poser le porteur, puis aucun", async () => {
    const { api, r, remplacements, stop } = monter("Texte existant. ");
    await contenu(api, "Suite");
    await image();
    expect(remplacements()).toBe(1);
    await contenu(api, " de la réponse.");
    await image(30);
    expect(remplacements()).toBe(1);
    expect(bulle(r)?.content).toBe("Texte existant. Suite de la réponse.");
    stop();
  });

  it("les lecteurs de content et thinking voient le texte à jour à tout instant", async () => {
    const { api, r, stop } = monter();
    await api.handleStreamEvent({ type: "thinking_token", text: "Raisonnement. ", n: 1 });
    await image(20);
    await contenu(api, "Début. ");
    await image(10);
    await contenu(api, "x".repeat(200));
    await image(3);
    const m = bulle(r) as MessageChat;
    const vu = m.content ?? "";
    expect(vu.length).toBeGreaterThan(7);
    expect(projeterPourPersistance(m)).toMatchObject({ content: vu, thinking: "Raisonnement. " });
    expect(JSON.stringify(projeterPourPersistance(m))).not.toContain("_flux");
    // Stop : le texte affiché et le tampon, lus sur l'objet, font le contenu final.
    api.stopGeneration();
    expect(bulle(r)?.content).toBe("Début. " + "x".repeat(200));
    expect(bulle(r)?._flux).toBeNull();
    stop();
  });

  it("Continuer après un Stop : le porteur est recréé au premier battement, puis le message garde son identité", async () => {
    const { api, r, remplacements, stop } = monter();
    await contenu(api, "Début de réponse.");
    await image(30);
    api.stopGeneration();
    expect(bulle(r)?._flux).toBeNull();
    // Comme continueGeneration : le même message rouvert au flux.
    r.messages.value[1] = { ...(bulle(r) as MessageChat), isTruncated: false, isStreaming: true };
    const avant = remplacements();
    await contenu(api, " Suite.");
    await image();
    expect(remplacements()).toBe(avant + 1);
    const m = bulle(r) as MessageChat;
    expect(m._flux).toBeTruthy();
    await contenu(api, " Et encore.");
    await image(30);
    expect(bulle(r)).toBe(m);
    expect(m.content).toBe("Début de réponse. Suite. Et encore.");
    expect(m._flux?.corps.value.actif).toBe(m._mdActiveHtml);
    expect(m._flux?.corps.value.blocs ?? null).toBe(m._mdBlocks ?? null);
    stop();
  });

  it("le porteur est lâché à la fin du tour, à l'erreur et suit un remplacement structurel", async () => {
    const a = monter();
    await contenu(a.api, "Texte.");
    await image(20);
    expect(bulle(a.r)?._flux).toBeTruthy();
    await a.api.handleStreamEvent({ type: "thinking_content", text: "Réflexion du serveur" });
    expect(bulle(a.r)?._flux?.reflexion.value).toBe("Réflexion du serveur");
    await a.api.handleStreamEvent(FIN);
    expect(bulle(a.r)?.isStreaming).toBe(false);
    expect(bulle(a.r)?._flux).toBeNull();
    a.stop();
    const b = monter();
    await contenu(b.api, "Texte.");
    await image(20);
    await b.api.handleStreamEvent({ type: "error", text: "boum" });
    expect(bulle(b.r)?._flux).toBeNull();
    b.stop();
  });

  it("la ligne du message ne se re-rend pas pendant le flux ; le corps et la réflexion suivent le porteur", async () => {
    const { api, r, stop } = monter();
    let rendus = 0;
    const Ligne = Vue.defineComponent({
      props: { msg: { type: Object, required: true } },
      setup(props) {
        return () => {
          rendus++;
          const m = props.msg as MessageChat;
          return Vue.h("div", [
            m.thinking ? Vue.h(TexteFlux, { texte: m.thinking, flux: m._flux?.reflexion }) : null,
            Vue.h(ContenuMarkdown, { msg: m }),
          ]);
        };
      },
    });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    const app = Vue.createApp({ render: () => Vue.h(Ligne, { msg: r.messages.value[1] as MessageChat }) });
    app.mount(hote);
    await api.handleStreamEvent({ type: "thinking_token", text: "Je pense", n: 1 });
    await image(10);
    const avantReflexion = rendus;
    for (let k = 0; k < 10; k++) {
      await api.handleStreamEvent({ type: "thinking_token", text: " idée" + k, n: 1 });
      await image();
    }
    await image(30);
    expect(rendus).toBe(avantReflexion);
    expect(hote.querySelector("pre")?.textContent).toBe(
      "Je pense idée0 idée1 idée2 idée3 idée4 idée5 idée6 idée7 idée8 idée9",
    );
    await contenu(api, "Premier paragraphe.\n\nDeuxième");
    await image(10);
    const base = rendus;
    for (let k = 0; k < 20; k++) {
      await contenu(api, " mot" + k);
      await image();
    }
    await image(60);
    expect(rendus).toBe(base);
    expect(hote.querySelector(".markdown-body")?.textContent).toContain("Deuxième mot0 mot1");
    expect(hote.querySelector(".markdown-body")?.textContent).toContain("mot19");
    await api.handleStreamEvent(FIN);
    await Vue.nextTick();
    expect(rendus).toBeGreaterThan(base);
    expect(hote.querySelector(".markdown-body")?.textContent).toContain("mot19");
    app.unmount();
    hote.remove();
    stop();
  });
});
