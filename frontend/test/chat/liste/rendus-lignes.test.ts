// SPDX-License-Identifier: MIT
/** frontend/test/chat/liste/rendus-lignes.test.ts — fil des messages : une ligne et son habillage ne se re-rendent que quand ce qu'ils affichent change (texte du flux, message remplacé, carte mémoire, fichiers modifiés, édition, recherche, saut, bulle regroupée). */
import { computed, createApp, nextTick, reactive, ref, toRaw, watch } from "vue";
import type { App, ComponentPublicInstance, Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ListeMessages from "../../../src/components/chat/liste/ListeMessages.vue";
import { creerDefilementVirtuel } from "../../../src/features/chat/liste/defilement-virtuel";
import { creerCartesMemoire } from "../../../src/features/chat/message/effets";
import { creerCarteFichiers } from "../../../src/features/chat/message/fichiers-modifies";
import type { ContexteListe, MessageAffiche } from "../../../src/features/chat/message/types";
import { CLE_FIL, CLE_LISTE } from "../../../src/features/chat/page/domaines";
import { creerPorteur, synchroniserPorteur } from "../../../src/features/chat/rendu/porteur-flux";
import { CLE_PREFERENCES_CHAT } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const attendre = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

const MEMOIRE = {
  name: "memory",
  args: { action: "add", content: "note du compte" },
  status: "done",
  result: JSON.stringify({ ok: true, op: "ab12cd34" }),
};

/** Fil de 6 messages (chargés gelés, puis la question et la réponse en cours), état et cartes réels, rendus comptés par composant et par ligne. */
function monterFil() {
  const charges: MessageAffiche[] = [
    { role: "user", content: "Question 0" },
    { role: "assistant", content: "Réponse 1", toolSteps: [MEMOIRE] },
    { role: "user", content: "Question 2" },
    {
      role: "assistant",
      content: "Réponse 3",
      files_changed: [{ path: "src/a.py", added: 2, removed: 1 }],
      _diffFiles: { "src/b.py": "a\n" },
    },
  ].map((m) => Object.freeze(m) as MessageAffiche);
  const porteur = creerPorteur();
  const messages = ref([
    ...charges,
    { role: "user", content: "Question 4" },
    { role: "assistant", content: "Début", isStreaming: true, _flux: porteur },
  ]) as Ref<MessageAffiche[]>;
  const defil = creerDefilementVirtuel(
    { ref, computed, watch, nextTick },
    { messages, chatContainer: ref(null), isUserScrolling: ref(false) },
  );
  const detail = { op: "ab12cd34", added: ["note du compte"], removed: [], can_undo: true };
  // Mémoire : détail de l'écriture ; bac : version actuelle d'un fichier (statistiques calculées après une attente).
  const fetchAuth = async (url: string): Promise<Response> =>
    (url.startsWith("/api/sandbox/download")
      ? { ok: true, arrayBuffer: async () => new TextEncoder().encode("a\nb\n").buffer }
      : { ok: true, json: async () => detail }) as unknown as Response;
  const memoire = creerCartesMemoire({ reactive }, { currentChatId: ref("c1") }, { fetchAuth });
  const fichiers = creerCarteFichiers({ reactive }, { settings: ref({}) }, { fetchAuth });
  const etat = reactive({
    settings: { assistant_name: "Elpis" },
    user: { username: "alice", avatar: null },
    skinCourant: {},
    nomMarque: "Elpis",
    logoApp: "static/elpis-256.png",
    lastAssistantIdx: defil.lastAssistantIdx,
    visibleMessages: defil.visibleMessages,
    vsTopPad: 0,
    vsBotPad: 0,
    vsFlashIdx: null as number | null,
    isStreaming: true,
    isThinking: false,
    statusText: "",
    compactionNotice: null,
    currentChatId: "c1",
    editingMessageIndex: null as number | null,
    editMessageText: "",
    messageSearchQ: "",
    messageSearchActive: false,
    compressionStatus: null,
    voiceReadingIdx: null,
    voiceCanRead: false,
  });
  const fonctions: Record<string, unknown> = {
    ...memoire,
    diffFilesFor: fichiers.diffFilesFor,
    hasDiffFiles: fichiers.hasDiffFiles,
    isDiffEditorEnabled: fichiers.isDiffEditorEnabled,
    pipelineFor: () => ({ show: false }),
    segGroupsFor: () => [],
    isImageMessage: () => false,
    statusPhase: () => null,
    statusDotClass: () => "",
    fmtThinkingMeta: () => "",
    fmtElapsed: (s: number) => s + " s",
    metricsTooltip: () => "",
    thinkingTokensOf: () => 0,
    cachePctOf: () => 0,
  };
  const ctx = new Proxy(etat, {
    get(cible, cle: string) {
      if (cle in cible) return (cible as Record<string, unknown>)[cle];
      return cle in fonctions ? fonctions[cle] : () => undefined;
    },
  }) as unknown as ContexteListe;

  const rendus: Record<string, number> = {};
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(ListeMessages);
  app.provide(CLE_PREFERENCES_CHAT, prefsDeroule("classic"));
  app.provide(CLE_FIL, ctx);
  app.provide(CLE_LISTE, ctx);
  app.mixin({
    updated(this: ComponentPublicInstance) {
      const nom = this.$options.__name ?? "?";
      const idx = (this.$props as { entry?: { idx: number } }).entry?.idx;
      const cle = idx === undefined ? nom : nom + "#" + idx;
      rendus[cle] = (rendus[cle] ?? 0) + 1;
    },
  });
  app.mount(hote);
  const remettre = (): void => {
    for (const k of Object.keys(rendus)) delete rendus[k];
  };
  return { hote, messages, porteur, etat, rendus, remettre };
}

describe("fil des messages : rendus par ligne", () => {
  it("le texte du flux (porteur) ne re-rend que le corps Markdown : ni la liste, ni la ligne, ni son habillage", async () => {
    const { hote, messages, porteur, rendus, remettre } = monterFil();
    await attendre();
    remettre();
    const brut = toRaw(messages.value[5]!);
    for (const texte of ["Début de", "Début de la", "Début de la réponse"]) {
      Object.assign(brut, { content: texte, _mdActiveHtml: "<p>" + texte + "</p>" });
      synchroniserPorteur(porteur, brut);
      await nextTick();
    }
    expect(rendus).toEqual({ ContenuMarkdown: 3 });
    expect(hote.querySelector("[data-vs-idx='5']")?.textContent).toContain("Début de la réponse");
  });

  it("un message remplacé (outil, statut, fin du flux) re-rend sa ligne seule", async () => {
    const { hote, messages, rendus, remettre } = monterFil();
    await attendre();
    remettre();
    const cur = messages.value[5]!;
    messages.value[5] = { ...cur, toolSteps: [{ name: "session_search", status: "running", args: {} }] };
    await nextTick();
    expect(Object.keys(rendus).filter((k) => /#[0-4]$/.test(k))).toEqual([]);
    expect(rendus["MessageChat#5"]).toBe(1);
    remettre();
    messages.value[5] = { ...messages.value[5]!, isStreaming: false, _flux: null, content: "Fin." };
    await nextTick();
    expect(Object.keys(rendus).filter((k) => /#[0-4]$/.test(k))).toEqual([]);
    expect(rendus["PiedMessage#5"]).toBe(1);
    expect(hote.querySelector("[data-vs-idx='5'] [data-copier]")).not.toBeNull();
  });

  it("carte mémoire : ouvrir l'écriture affiche son détail sans re-rendre la liste ni les autres lignes", async () => {
    const { hote, rendus, remettre } = monterFil();
    await attendre();
    remettre();
    (hote.querySelector("[data-vs-idx='1'] [data-effect-memory] button") as HTMLButtonElement).click();
    await attendre();
    expect(hote.querySelector("[data-vs-idx='1'] [data-effect-added]")?.textContent).toContain(
      "note du compte",
    );
    expect(
      Object.keys(rendus).every((k) => k.startsWith("EffetMemoire") || k.startsWith("LibelleVivant")),
    ).toBe(true);
  });

  it("fichiers modifiés : les statistiques posées après le rendu s'affichent dans leur ligne seule", async () => {
    const { hote, rendus } = monterFil();
    await attendre();
    const lignes = hote.querySelector("[data-vs-idx='3'] .diff-rows")?.textContent ?? "";
    expect(lignes).toContain("+2 −1");
    expect(lignes).toMatch(/b\.py[\s\S]*\+1(?!\d)/);
    expect(rendus["FichiersModifies#3"]).toBeGreaterThan(0);
    expect(Object.keys(rendus).filter((k) => /#[0-2,4-5]$/.test(k))).toEqual([]);
  });

  it("édition, saut et recherche : seules les lignes concernées changent", async () => {
    const { hote, etat, rendus, remettre } = monterFil();
    await attendre();
    remettre();
    etat.editingMessageIndex = 2;
    await nextTick();
    expect(hote.querySelector("[data-vs-idx='2'] textarea[data-edit-message-input]")).not.toBeNull();
    expect(Object.keys(rendus).filter((k) => k.startsWith("MessageChat"))).toEqual(["MessageChat#2"]);
    remettre();
    etat.editingMessageIndex = null;
    etat.vsFlashIdx = 3;
    await nextTick();
    expect(hote.querySelector("[data-vs-idx='3']")?.classList.contains("vs-jump-flash")).toBe(true);
    expect(
      Object.keys(rendus)
        .filter((k) => k.startsWith("MessageChat"))
        .sort(),
    ).toEqual(["MessageChat#2", "MessageChat#3"]);
    remettre();
    etat.messageSearchQ = "Question";
    etat.messageSearchActive = true;
    await nextTick();
    expect(hote.querySelector("[data-vs-idx='1']")?.classList.contains("opacity-25")).toBe(true);
    expect(hote.querySelector("[data-vs-idx='2']")?.classList.contains("opacity-25")).toBe(false);
    expect(rendus["ListeMessages"]).toBeUndefined();
  });

  it("titre d'état de la réflexion : la liste ne se re-rend que quand la bulle de reconnexion paraît ou change", async () => {
    const { hote, etat, rendus, remettre } = monterFil();
    await attendre();
    etat.isThinking = true;
    etat.statusText = "Réflexion : le pipeline";
    await nextTick();
    remettre();
    for (const titre of ["Réflexion : les étapes", "Réflexion : un exemple", "Génération…"]) {
      etat.statusText = titre;
      await nextTick();
    }
    expect(rendus).toEqual({});
    etat.statusText = "Reconnexion au flux…";
    await nextTick();
    expect(hote.querySelector(":scope > [role='status']")?.textContent).toContain("Reconnexion au flux…");
    etat.statusText = "Reconnexion au flux (2)…";
    await nextTick();
    expect(hote.querySelector(":scope > [role='status']")?.textContent).toContain("Reconnexion au flux (2)…");
    expect(rendus["ListeMessages"]).toBe(2);
  });

  it("bulle regroupée : un réveil qui arrive re-rend la ligne de tête qu'il continue, pas les autres", async () => {
    const reveil = { role: "user", origin: "job_wake", content: "réveil" } as MessageAffiche;
    const { messages, rendus, remettre } = monterFil();
    await attendre();
    messages.value[5] = { ...messages.value[5]!, isStreaming: false, _flux: null, content: "Lancé." };
    await nextTick();
    remettre();
    messages.value.push(reveil);
    await nextTick();
    expect(rendus["MessageChat#5"]).toBe(1);
    expect(Object.keys(rendus).filter((k) => /#[0-4]$/.test(k))).toEqual([]);
  });
});
