// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/accessibilite.test.ts — composeur et volet au clavier et au lecteur d'écran : saisie en combobox, menus « / » et « @ » en listbox, boutons icônes nommés, rangée de conversation sans bouton imbriqué, garde de focus de « Détails ». */
import { nextTick, ref } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { creerClavier } from "../../../src/app/racine/clavier";
import type { EtatClavier } from "../../../src/app/racine/clavier";
import BarreLaterale from "../../../src/components/chat/page/BarreLaterale.vue";
import BoutonBas from "../../../src/components/chat/page/BoutonBas.vue";
import EpinglesComposeur from "../../../src/components/chat/page/EpinglesComposeur.vue";
import MenuSlash from "../../../src/components/chat/page/MenuSlash.vue";
import MenuMention from "../../../src/components/chat/composeur/MenuMention.vue";
import ZoneSaisie from "../../../src/components/chat/composeur/ZoneSaisie.vue";
import {
  CLE_BARRE,
  CLE_COMPOSEUR,
  CLE_CONVERSATION,
  CLE_IMAGE,
} from "../../../src/features/chat/page/domaines";
import { barre, demonter, etat, monter, noms } from "./montage";

afterEach(demonter);

const cle = (k: InjectionKey<unknown>): InjectionKey<object> => k as InjectionKey<object>;

describe("saisie et menus du composeur", () => {
  it("pendant le questionnaire, la saisie est décrite par la question", () => {
    const hote = monter(ZoneSaisie, [], {
      props: { texte: "", placeholder: "Message", decritPar: "elpis-ask-question" },
    });
    expect(hote.querySelector("textarea")!.getAttribute("aria-describedby")).toBe("elpis-ask-question");
    demonter();
    const sans = monter(ZoneSaisie, [], { props: { texte: "", placeholder: "Message" } });
    expect(sans.querySelector("textarea")!.hasAttribute("aria-describedby")).toBe(false);
  });

  it("la saisie est une combobox reliée à la liste ouverte et à son option active", async () => {
    const hote = monter(ZoneSaisie, [], {
      props: { texte: "/", placeholder: "Message", listeId: "slash-list", optionActive: "slash-opt-2" },
    });
    const zone = hote.querySelector("textarea") as HTMLTextAreaElement;
    expect(zone.getAttribute("role")).toBe("combobox");
    expect(zone.getAttribute("aria-expanded")).toBe("true");
    expect(zone.getAttribute("aria-controls")).toBe("slash-list");
    expect(zone.getAttribute("aria-activedescendant")).toBe("slash-opt-2");
    expect(zone.getAttribute("aria-label")).toBe("Message");
    demonter();
    const ferme = monter(ZoneSaisie, [], { props: { texte: "", placeholder: "Message", optionActive: "x" } });
    const z2 = ferme.querySelector("textarea") as HTMLTextAreaElement;
    expect(z2.getAttribute("aria-expanded")).toBe("false");
    expect(z2.hasAttribute("aria-activedescendant")).toBe(false);
    await nextTick();
  });

  it("menu « / » : listbox nommée, options identifiées, la ligne active est sélectionnée", async () => {
    const comp = etat({
      showSlash: true,
      slashLevel: "commands",
      slashList: [
        { name: "plan", label: "Mode plan", desc: "Préparer un plan" },
        { name: "compact", label: "Compacter", desc: "Résumer" },
      ],
      slashIdx: 1,
      slashRaw: { name: "" },
      slashHeaderIcon: "ph-terminal",
      slashHeaderLabel: "Commandes",
      slashHeaderCmd: "/",
      slashRowKey: (item: { name: string }) => item.name,
      slashRowTitle: () => "",
      slashCmdOk: () => true,
    });
    const hote = monter(MenuSlash, [[cle(CLE_COMPOSEUR), comp]]);
    const liste = hote.querySelector("#slash-list") as HTMLElement;
    expect(liste.getAttribute("role")).toBe("listbox");
    expect(liste.getAttribute("aria-label")).toBe("Commandes, 2 suggestions");
    const options = [...hote.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.id)).toEqual(["slash-opt-0", "slash-opt-1"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  });

  it("menu « @ » : listbox de fichiers, titres de groupe hors des options", () => {
    const hote = monter(MenuMention, [], {
      props: {
        ouvert: true,
        requete: "",
        fichiers: [
          { path: "src/a.ts", name: "a.ts" },
          { path: "src/b.ts", name: "b.ts" },
        ],
        index: 0,
        recents: 1,
        chargement: false,
        encore: false,
      },
    });
    const liste = hote.querySelector("#mention-list") as HTMLElement;
    expect(liste.getAttribute("role")).toBe("listbox");
    expect([...liste.querySelectorAll('[role="option"]')].map((o) => o.id)).toEqual([
      "mention-opt-0",
      "mention-opt-1",
    ]);
    expect(liste.querySelectorAll('[role="presentation"]').length).toBe(2);
  });
});

describe("boutons icônes", () => {
  it("« Aller en bas » et le retrait d'un skill épinglé ont un nom", () => {
    const conv = etat({ messages: [1, 2, 3], chatAwayFromBottom: true, scrollBtnBottom: 120 });
    const hote = monter(BoutonBas, [[cle(CLE_CONVERSATION), conv]]);
    expect(hote.querySelector("button")?.getAttribute("aria-label")).toBe("Aller en bas");
    demonter();
    const comp = etat({ ragActives: [], pinnedSkills: [{ name: "revue-code" }] });
    const img = etat({ imageMode: false, imageEditRef: null });
    const h2 = monter(EpinglesComposeur, [
      [cle(CLE_COMPOSEUR), comp],
      [cle(CLE_IMAGE), img],
    ]);
    expect(h2.querySelector("button")?.getAttribute("aria-label")).toBe("Retirer le skill revue-code");
  });
});

describe("rangée de conversation", () => {
  it("titre seul dans la rangée, actions au clic droit ; la conversation ouverte porte aria-current", () => {
    const b = barre();
    const hote = monter(BarreLaterale, [[cle(CLE_BARRE), b]]);
    expect(hote.querySelectorAll('[role="button"] button').length).toBe(0);
    const rangees = [...hote.querySelectorAll("[data-chat-row]")];
    expect(rangees).toHaveLength(2);
    const titres = rangees.map((r) => r.querySelector("[data-chat-open]") as HTMLButtonElement);
    expect(titres.map((t) => t.getAttribute("aria-current"))).toEqual(["page", null]);
    expect(hote.querySelectorAll('[data-chat-row] [aria-haspopup="menu"]').length).toBe(0);
    titres[1]?.click();
    titres[1]?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(noms()).toEqual(["loadChat", "openContextMenu"]);
  });

  it("mode sélection : le titre coche (aria-pressed), sans bouton d'actions", () => {
    const b = barre({ chatSelectMode: true, chatSelected: ["c2"] });
    const hote = monter(BarreLaterale, [[cle(CLE_BARRE), b]]);
    const titres = [...hote.querySelectorAll("[data-chat-open]")];
    expect(titres.map((t) => t.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(hote.querySelectorAll('[data-chat-row] [aria-haspopup="menu"]').length).toBe(0);
  });
});

describe("garde de focus des grandes fenêtres", () => {
  it("« Détails de l'exécution » ouvert compte comme une grande fenêtre (Tab piégé)", () => {
    const runDetails = ref<unknown>(null);
    const chat = {
      runDetails,
      taskModal: ref(null),
      toolInfo: ref(null),
      showModelProps: ref(false),
      assistantForm: ref({ open: false, id: "", valeurs: {} }),
    };
    const s = {
      modules: { chat } as unknown as EtatClavier["modules"],
      modalState: ref({ isOpen: false }),
      contextMenu: ref({ isOpen: false }),
      showInfoModal: ref(false),
      showOpenCodeModal: ref(false),
      imgZoom: ref(null),
      showNotifPanel: ref(false),
      menuPagesOuvert: ref(false),
      currentView: ref("chat"),
      inputMessage: ref(""),
      inputRef: ref(null),
      handleModalCancel: () => undefined,
      closeContextMenu: () => undefined,
    } as unknown as EtatClavier;
    const { grandeFenetreOuverte } = creerClavier(s);
    expect(grandeFenetreOuverte.value).toBe(false);
    runDetails.value = { runId: "r1" };
    expect(grandeFenetreOuverte.value).toBe(true);
  });
});
