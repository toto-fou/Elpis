// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/page-chat-interfaces.test.ts — disposition de PageChat : en-tête « Conversation », rangée du composeur avec ses puces, rien au-dessus de la saisie. */
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageChat from "../../../src/components/chat/page/PageChat.vue";
import { CLE_COMPOSEUR, CLE_CONVERSATION, CLE_PAGE } from "../../../src/features/chat/page/domaines";
import { demonter, etat, monter } from "./montage";

const { bouchon } = vi.hoisted(() => ({
  bouchon: async (nom: string) => {
    const { defineComponent, h } = await import("vue");
    return { default: defineComponent({ name: nom, render: () => h("div", { "data-bouchon": nom }) }) };
  },
}));
vi.mock("../../../src/components/mascotte/MascottePerchee.vue", () => bouchon("MascottePerchee"));
vi.mock("../../../src/components/voix/BoutonMicro.vue", () => bouchon("BoutonMicro"));
vi.mock("../../../src/components/chat/composeur/MenuMention.vue", () => bouchon("MenuMention"));
vi.mock("../../../src/components/chat/composeur/PiecesJointes.vue", () => bouchon("PiecesJointes"));
vi.mock("../../../src/components/chat/composeur/ZoneSaisie.vue", () => bouchon("ZoneSaisie"));
vi.mock("../../../src/components/chat/outils/PuceJobs.vue", () => bouchon("PuceJobs"));
vi.mock("../../../src/components/chat/page/AlerteContexte.vue", () => bouchon("AlerteContexte"));
vi.mock("../../../src/components/chat/page/BarreComposeur.vue", () => bouchon("BarreComposeur"));
vi.mock("../../../src/components/chat/page/BarreImage.vue", () => bouchon("BarreImage"));
vi.mock("../../../src/components/chat/page/BoutonBas.vue", () => bouchon("BoutonBas"));
vi.mock("../../../src/components/chat/page/BoutonsEnvoi.vue", () => bouchon("BoutonsEnvoi"));
vi.mock("../../../src/components/chat/page/EnteteConversation.vue", () => bouchon("EnteteConversation"));
vi.mock("../../../src/components/chat/page/EpinglesComposeur.vue", () => bouchon("EpinglesComposeur"));
vi.mock("../../../src/components/chat/page/FilConversation.vue", () => bouchon("FilConversation"));
vi.mock("../../../src/components/chat/page/InfoCompression.vue", () => bouchon("InfoCompression"));
vi.mock("../../../src/components/chat/page/MenuSlash.vue", () => bouchon("MenuSlash"));
vi.mock("../../../src/components/chat/page/ProgressionModele.vue", () => bouchon("ProgressionModele"));
vi.mock("../../../src/components/chat/page/PucesComposeur.vue", () => bouchon("PucesComposeur"));
vi.mock("../../../src/components/chat/page/QuestionnaireAssistant.vue", () =>
  bouchon("QuestionnaireAssistant"),
);
vi.mock("../../../src/components/chat/page/PiedQuestionnaire.vue", () => bouchon("PiedQuestionnaire"));
vi.mock("../../../src/components/chat/page/PuceQuestionnaire.vue", () => bouchon("PuceQuestionnaire"));
vi.mock("../../../src/components/chat/page/SurvolDepot.vue", () => bouchon("SurvolDepot"));

afterEach(demonter);

const cle = (k: InjectionKey<unknown>): InjectionKey<object> => k as InjectionKey<object>;

function rendre(panneau: unknown = null): string[] {
  const p = etat({
    messages: [{ role: "user" }],
    settings: {},
    showEditor: false,
    planMode: true,
    todoList: [{ content: "a", status: "pending" }],
    jobsActifsTotal: 1,
    jobsChat: [],
    jobsFileReveil: [],
    jobsOuvert: false,
    jobsLimites: { chat: 3, compte: 5 },
    voiceCanDictate: false,
    mentionFiles: [],
    showMentionDropdown: false,
    inputMessage: "",
    attachedFiles: [],
  });
  const comp = etat({ showSlash: false, slashIdx: 0, askUserPanel: panneau });
  const hote = monter(PageChat, [
    [cle(CLE_PAGE), p],
    [cle(CLE_COMPOSEUR), comp],
    [cle(CLE_CONVERSATION), etat({ isUserScrolling: false })],
  ]);
  return [...hote.querySelectorAll("[data-bouchon]")].map((e) => (e as HTMLElement).dataset.bouchon ?? "");
}

describe("disposition de la page de chat", () => {
  it("en-tête « Conversation », rangée du composeur ; rien au-dessus de la saisie", () => {
    const vus = rendre();
    expect(vus).toEqual(expect.arrayContaining(["EnteteConversation", "BarreComposeur"]));
    // Les puces d'état vivent dans la rangée du composeur (BarreComposeur), plus au-dessus de la saisie.
    expect(vus).not.toContain("PucesComposeur");
    expect(
      document.querySelector("[data-barre-activite], [role='region'][aria-label='Activité']"),
    ).toBeNull();
  });

  it("questionnaire ouvert : « + » et micro dans le pied, région d'annonce hors du questionnaire", () => {
    const q = (idx: number, ouvert = true) => ({
      items: [
        { q: "Quoi ?", options: [], multi: false, _sel: [], _free: "" },
        { q: "Outils ?", options: [], multi: false, _sel: [], _free: "" },
      ],
      idx,
      ouvert,
      brouillon: "",
    });
    const vus = rendre(q(1));
    expect(vus).toContain("PiedQuestionnaire");
    expect(vus).not.toContain("BarreComposeur");
    expect(document.querySelector("[role='status'][aria-live='polite']")!.textContent).toBe(
      "Question 2 sur 2 : Outils ?",
    );
    demonter();
    rendre(q(0, false));
    const region = document.querySelector("[role='status'][aria-live='polite']");
    expect(region).not.toBeNull();
    expect(region!.textContent).toBe("");
  });
});
