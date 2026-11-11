// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/questionnaire-palette.test.ts — rendu du questionnaire dans la carte du composeur : rôles, aria-checked, progression, pied, bouton principal et puce Reprendre. */
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import BoutonsEnvoi from "../../../src/components/chat/page/BoutonsEnvoi.vue";
import PiedQuestionnaire from "../../../src/components/chat/page/PiedQuestionnaire.vue";
import PuceQuestionnaire from "../../../src/components/chat/page/PuceQuestionnaire.vue";
import QuestionnaireAssistant from "../../../src/components/chat/page/QuestionnaireAssistant.vue";
import { CLE_COMPOSEUR, CLE_PAGE } from "../../../src/features/chat/page/domaines";
import { appelsDe, demonter, etat, monter } from "./montage";
import type { InjectionKey } from "vue";

afterEach(demonter);

const cle = CLE_COMPOSEUR as InjectionKey<object>;

function domaine(idx = 0, ouvert = true, extra: Record<string, unknown> = {}) {
  const items = [
    { q: "Quoi ?", options: ["A", "B"], multi: false, _sel: ["A"], _free: "" },
    { q: "Outils ?", options: ["X", "Y"], multi: true, _sel: [], _free: "" },
  ];
  return etat({
    askUserPanel: { items, idx, ouvert, brouillon: "" },
    askUserCurrent: items[idx],
    askUserRepondues: 1,
    isStreaming: false,
    imageMode: false,
    inputMessage: "",
    attachedFiles: [],
    isAskOptionOn: (opt: string) => items[idx]?._sel.includes(opt) ?? false,
    ...extra,
  });
}

// Domaine « page » du « + » et du micro, tels que la barre normale les monte.
const pageVoix = (): [InjectionKey<object>, object] => [
  CLE_PAGE as InjectionKey<object>,
  etat({ voiceCanDictate: true, voiceState: "arrete", voiceBusy: false }),
];

describe("bloc du questionnaire", () => {
  it("choix unique : radiogroup, radio, aria-checked, progression annoncée", () => {
    const h = monter(QuestionnaireAssistant, [[cle, domaine(0)]]);
    const groupe = h.querySelector("[role='radiogroup']")!;
    expect(groupe.getAttribute("aria-labelledby")).toBe("elpis-ask-question");
    const opts = [...groupe.querySelectorAll("button[role='radio']")];
    expect(opts.map((o) => o.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(opts.map((o) => o.querySelector(".elpis-ask-kbd")!.textContent)).toEqual(["1", "2"]);
    expect(h.querySelector(".elpis-ask-ind.is-rond")).not.toBeNull();
    expect(h.querySelector(".elpis-ask-etape")!.textContent).toBe("Question 1 sur 2");
    expect(h.querySelector("[aria-live]")).toBeNull();
    expect(h.querySelector("[role='form']")).toBeNull();
    expect(h.querySelector("svg")).toBeNull();
    expect(h.textContent).not.toContain("Plusieurs choix possibles.");
  });

  it("choix multiple : group, checkbox, indicateur carré et mention", () => {
    const h = monter(QuestionnaireAssistant, [[cle, domaine(1)]]);
    expect(h.querySelector("[role='group']")).not.toBeNull();
    expect(h.querySelectorAll("button[role='checkbox']").length).toBe(2);
    expect(h.querySelector(".elpis-ask-ind.is-carre")).not.toBeNull();
    expect(h.textContent).toContain("Plusieurs choix possibles.");
    expect(h.querySelector("[role='group']")!.getAttribute("aria-describedby")).toBe("elpis-ask-multi");
    expect(h.querySelector("#elpis-ask-multi")).not.toBeNull();
    expect(h.querySelector(".elpis-ask-ind svg path")!.getAttribute("d")).toBe("M5 12.5l4.5 4.5L19 7.5");
    expect(h.querySelector(".elpis-ask-ind svg")!.getAttribute("stroke-width")).toBe("3");
  });

  it("choix unique : tabindex itinérant, flèches qui déplacent la coche, clic sans décocher", async () => {
    const h = monter(QuestionnaireAssistant, [[cle, domaine(0)]]);
    const radios = [...h.querySelectorAll<HTMLButtonElement>("button[role='radio']")];
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1]);
    radios[0]!.click();
    expect(appelsDe("toggleAskOption")).toEqual([]);
    radios[1]!.click();
    expect(appelsDe("toggleAskOption")).toEqual([["B"]]);
    radios[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    expect(appelsDe("toggleAskOption")).toEqual([["B"], ["B"]]);
    const haut = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    radios[0]!.dispatchEvent(haut);
    expect(haut.defaultPrevented).toBe(true);
  });

  it("choix multiple : toutes les cases tabulables, pas de flèches, clic qui bascule", () => {
    const h = monter(QuestionnaireAssistant, [[cle, domaine(1)]]);
    const cases = [...h.querySelectorAll<HTMLButtonElement>("button[role='checkbox']")];
    expect(cases.map((c) => c.tabIndex)).toEqual([0, 0]);
    const fl = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    cases[0]!.dispatchEvent(fl);
    expect(fl.defaultPrevented).toBe(false);
  });

  it("la touche n'est affichée que pour les options 1 à 9", () => {
    const options = Array.from({ length: 11 }, (_, i) => `o${i}`);
    const items = [{ q: "Q ?", options, multi: false, _sel: [], _free: "" }];
    const d = etat({
      askUserPanel: { items, idx: 0, ouvert: true, brouillon: "" },
      askUserCurrent: items[0],
      isAskOptionOn: () => false,
    });
    const h = monter(QuestionnaireAssistant, [[cle, d]]);
    const touches = [...h.querySelectorAll(".elpis-ask-kbd")].map((k) => k.textContent);
    expect(touches.slice(0, 9)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(touches.slice(9)).toEqual(["", ""]);
  });

  it("pastilles : faite, courante, à venir ; clic sur une option et « Répondre librement »", () => {
    const h = monter(QuestionnaireAssistant, [[cle, domaine(1)]]);
    expect([...h.querySelectorAll(".elpis-ask-pas")].map((p) => p.className)).toEqual([
      "elpis-ask-pas is-faite",
      "elpis-ask-pas is-courante",
    ]);
    h.querySelector<HTMLButtonElement>("button[role='checkbox']")!.click();
    h.querySelector<HTMLButtonElement>(".elpis-ask-lien")!.click();
    expect(appelsDe("toggleAskOption")).toEqual([["X"]]);
    expect(appelsDe("dismissAskUser").length).toBe(1);
  });

  it("fermé : rien n'est rendu", () => {
    const h = monter(QuestionnaireAssistant, [[cle, domaine(0, false)]]);
    expect(h.querySelector("[data-ask-bloc]")).toBeNull();
  });
});

describe("pied et bouton principal", () => {
  it("première question : Suivant, pas de Retour", () => {
    const h = monter(PiedQuestionnaire, [[cle, domaine(0)], pageVoix()]);
    expect(h.textContent).toContain("Chiffres pour choisir · Entrée pour valider · Échap pour fermer");
    expect(h.textContent).not.toContain("Retour");
    const btn = h.querySelector<HTMLButtonElement>(".elpis-ask-btn-p")!;
    expect(btn.textContent).toContain("Suivant");
    btn.click();
    expect(appelsDe("askUserNext").length).toBe(1);
  });

  it("garde le « + » et le micro de la barre normale, sans le modèle ni les puces", () => {
    const h = monter(PiedQuestionnaire, [[cle, domaine(0)], pageVoix()]);
    expect(h.querySelector("[aria-label='Plus'], [aria-label*='Plus'], [aria-haspopup]")).not.toBeNull();
    expect(h.querySelector("[data-barre-composeur], [data-model-manager]")).toBeNull();
    expect(h.querySelector(".elpis-ask-aide-clavier")).not.toBeNull();
    expect(h.querySelector("[data-pied-questionnaire]")).toBeNull();
  });

  it("dernière question : Retour et Envoyer les réponses, désactivé pendant un flux", async () => {
    const d = domaine(1);
    const h = monter(PiedQuestionnaire, [[cle, d], pageVoix()]);
    h.querySelector<HTMLButtonElement>(".elpis-ask-btn-g")!.click();
    expect(appelsDe("askUserPrev").length).toBe(1);
    const btn = h.querySelector<HTMLButtonElement>(".elpis-ask-btn-p")!;
    expect(btn.textContent).toContain("Envoyer les réponses");
    expect(btn.disabled).toBe(false);
    (d as unknown as { isStreaming: boolean }).isStreaming = true;
    await nextTick();
    expect(btn.disabled).toBe(true);
  });

  it("le bouton d'envoi du composeur est remplacé tant que le questionnaire est ouvert", () => {
    const h = monter(BoutonsEnvoi, [[cle, domaine(0)]]);
    expect(h.querySelector("[aria-label='Envoyer le message']")).toBeNull();
    const ferme = monter(BoutonsEnvoi, [[cle, domaine(0, false)]]);
    expect(ferme.querySelector("[aria-label='Envoyer le message']")).not.toBeNull();
  });

  it("un flux pendant le questionnaire (réveil de tâche) montre Arrêter à côté de Suivant", async () => {
    const d = domaine(0);
    const h = monter(BoutonsEnvoi, [[cle, d]]);
    expect(h.querySelector("[aria-label='Arrêter la génération']")).toBeNull();
    (d as unknown as { isStreaming: boolean }).isStreaming = true;
    await nextTick();
    h.querySelector<HTMLButtonElement>("[aria-label='Arrêter la génération']")!.click();
    expect(appelsDe("stopGeneration").length).toBe(1);
    expect(h.querySelector(".elpis-ask-btn-p")!.textContent).toContain("Suivant");
  });
});

describe("puce Reprendre", () => {
  it("fermé : « Reprendre le questionnaire · 1 sur 2 », clic rouvre", () => {
    const h = monter(PuceQuestionnaire, [[cle, domaine(0, false)]]);
    const puce = h.querySelector<HTMLButtonElement>(".elpis-ask-reprendre")!;
    expect(puce.textContent).toContain("Reprendre le questionnaire · 1 sur 2");
    puce.click();
    expect(appelsDe("rouvrirAskUser").length).toBe(1);
  });

  it("ouvert ou absent : pas de puce", () => {
    expect(
      monter(PuceQuestionnaire, [[cle, domaine(0, true)]]).querySelector(".elpis-ask-reprendre"),
    ).toBeNull();
    expect(
      monter(PuceQuestionnaire, [[cle, etat({ askUserPanel: null })]]).querySelector(".elpis-ask-reprendre"),
    ).toBeNull();
  });
});
