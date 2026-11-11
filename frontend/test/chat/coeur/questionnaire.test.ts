// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/questionnaire.test.ts — questionnaire ask_user dans le composeur : brouillon mis de côté, zone et champ libre synchronisés, clavier, puce Reprendre, envoi. */
import { nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { creerQuestionnaire } from "../../../src/features/chat/coeur/questionnaire";

const QS = () => [
  { q: "Quoi ?", options: ["A", "B", "C"], multi: false, _sel: [], _free: "" },
  { q: "Outils ?", options: ["X", "Y"], multi: true, _sel: [], _free: "" },
];

function monter(brouillon = "", streaming = false, menu = ref(false)) {
  const toasts: string[] = [];
  const sendMessage = vi.fn();
  const focus = vi.fn();
  const c = {
    r: { inputMessage: ref(brouillon), isStreaming: ref(streaming), inputRef: ref({ focus }) },
    ctx: { showToast: (m: string) => void toasts.push(m) },
    e: { askUserPanel: ref(null as unknown) },
    f: {
      pendingAskUser: null as unknown,
      composeRestoreDraft: null as string | null,
      envoiQuestionnaire: false,
    },
    l: { autoResize: () => undefined, sendMessage },
  };
  const q = creerQuestionnaire(c as never, () => menu.value);
  q.ouvrirAskUser(QS());
  const panneau = () => c.e.askUserPanel.value as { idx: number; ouvert: boolean; brouillon: string };
  return { c, q, toasts, sendMessage, focus, panneau };
}

function touche(key: string, cible: "zone" | "option" | "dehors", opts: Partial<KeyboardEventInit> = {}) {
  const ev = new KeyboardEvent("keydown", { key, cancelable: true, ...opts });
  const el = document.createElement(cible === "zone" ? "textarea" : "button");
  if (cible === "option") {
    const bloc = document.createElement("div");
    bloc.setAttribute("data-ask-bloc", "");
    bloc.appendChild(el);
  }
  Object.defineProperty(ev, "target", { value: el });
  return ev;
}

describe("brouillon", () => {
  it("met le texte du composeur de côté à l'ouverture et le rend après l'envoi", async () => {
    const { c, q, panneau, sendMessage } = monter("mon brouillon");
    expect(panneau().brouillon).toBe("mon brouillon");
    expect(c.r.inputMessage.value).toBe("");
    q.toggleAskOption("A");
    q.askUserNext();
    q.askUserNext();
    expect(c.f.composeRestoreDraft).toBe("mon brouillon");
    expect(c.r.inputMessage.value).toContain("**Quoi ?**");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sans brouillon, rien n'est restauré", () => {
    const { c, q } = monter("");
    q.toggleAskOption("A");
    q.askUserNext();
    q.askUserNext();
    expect(c.f.composeRestoreDraft).toBeNull();
  });

  it("donne le focus à la zone à l'ouverture", async () => {
    const { focus } = monter();
    await nextTick();
    expect(focus).toHaveBeenCalled();
  });
});

describe("synchronisation zone et champ libre", () => {
  it("la zone va dans _free en quittant, et revient en revenant", () => {
    const { c, q, panneau } = monter();
    c.r.inputMessage.value = "précision 1";
    q.askUserNext();
    expect(panneau().idx).toBe(1);
    expect((panneau() as never as { items: { _free: string }[] }).items[0]!._free).toBe("précision 1");
    expect(c.r.inputMessage.value).toBe("");
    c.r.inputMessage.value = "précision 2";
    q.askUserPrev();
    expect(c.r.inputMessage.value).toBe("précision 1");
    q.askUserNext();
    expect(c.r.inputMessage.value).toBe("précision 2");
  });

  it("le champ libre part dans le message avec les options", () => {
    const { c, q } = monter();
    q.toggleAskOption("B");
    c.r.inputMessage.value = "et plus";
    q.askUserNext();
    q.askUserNext();
    expect(c.r.inputMessage.value).toBe("**Quoi ?**  \nB ; et plus");
  });

  it("rien de répondu : toast et pas d'envoi", () => {
    const { q, toasts, sendMessage } = monter();
    q.askUserNext();
    q.askUserNext();
    expect(toasts).toEqual(["Réponds à au moins une question"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("envoi refusé pendant un flux", () => {
    const { c, q, sendMessage } = monter("", true);
    q.toggleAskOption("A");
    q.askUserNext();
    q.askUserNext();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(c.f.composeRestoreDraft).toBeNull();
  });
});

describe("clavier", () => {
  it("un chiffre coche l'option quand la zone est vide", () => {
    const { q } = monter();
    const ev = touche("2", "zone");
    expect(q.askUserKeydown(ev)).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    expect(q.isAskOptionOn("B")).toBe(true);
    q.askUserKeydown(touche("2", "zone"));
    expect(q.isAskOptionOn("B")).toBe(false);
  });

  it("un chiffre est tapé normalement quand la zone n'est pas vide", () => {
    const { c, q } = monter();
    c.r.inputMessage.value = "abc";
    const ev = touche("1", "zone");
    expect(q.askUserKeydown(ev)).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
    expect(q.isAskOptionOn("A")).toBe(false);
  });

  it("un chiffre sur une option coche même si la zone est remplie", () => {
    const { c, q } = monter();
    c.r.inputMessage.value = "abc";
    expect(q.askUserKeydown(touche("1", "option"))).toBe(true);
    expect(q.isAskOptionOn("A")).toBe(true);
  });

  it("un chiffre au-delà des options n'est pas pris", () => {
    const { q } = monter();
    expect(q.askUserKeydown(touche("9", "zone"))).toBe(false);
  });

  it("Entrée passe à la question suivante, Maj+Entrée laisse le retour à la ligne", () => {
    const { q, panneau } = monter();
    const maj = touche("Enter", "zone", { shiftKey: true });
    expect(q.askUserKeydown(maj)).toBe(true);
    expect(maj.defaultPrevented).toBe(false);
    expect(panneau().idx).toBe(0);
    const ev = touche("Enter", "zone");
    expect(q.askUserKeydown(ev)).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    expect(panneau().idx).toBe(1);
  });

  it("Entrée sur une option ne déclenche pas Suivant", () => {
    const { q, panneau } = monter();
    const ev = touche("Enter", "option");
    expect(q.askUserKeydown(ev)).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
    expect(panneau().idx).toBe(0);
  });

  it("Entrée sur la dernière question envoie", () => {
    const { q, sendMessage } = monter();
    q.toggleAskOption("A");
    q.askUserKeydown(touche("Enter", "zone"));
    q.askUserKeydown(touche("Enter", "zone"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("Échap ferme ; une touche hors du bloc ou questionnaire fermé est ignorée", () => {
    const { q, panneau } = monter();
    expect(q.askUserKeydown(touche("Escape", "dehors"))).toBe(false);
    expect(q.askUserKeydown(touche("Escape", "zone"))).toBe(true);
    expect(panneau().ouvert).toBe(false);
    expect(q.askUserKeydown(touche("1", "zone"))).toBe(false);
  });

  it("une touche déjà prise n'est pas traitée deux fois", () => {
    const { q, panneau } = monter();
    const ev = touche("Enter", "zone");
    q.askUserKeydown(ev);
    expect(q.askUserKeydown(ev)).toBe(false);
    expect(panneau().idx).toBe(1);
  });
});

describe("fermeture et puce Reprendre", () => {
  it("fermé sans texte tapé : la zone reprend le brouillon, les réponses restent", () => {
    const { c, q, panneau } = monter("brouillon");
    q.toggleAskOption("A");
    q.dismissAskUser();
    expect(panneau().ouvert).toBe(false);
    expect(c.r.inputMessage.value).toBe("brouillon");
    expect(q.isAskOptionOn("A")).toBe(true);
    expect(q.askUserRepondues.value).toBe(1);
  });

  it("fermé avec du texte tapé : la zone le garde", () => {
    const { c, q } = monter("brouillon");
    c.r.inputMessage.value = "réponse libre";
    q.dismissAskUser();
    expect(c.r.inputMessage.value).toBe("réponse libre");
  });

  it("rouvert : même question, réponses gardées, texte de la zone remis de côté", () => {
    const { c, q, panneau } = monter();
    q.toggleAskOption("A");
    q.askUserNext();
    q.dismissAskUser();
    c.r.inputMessage.value = "autre brouillon";
    q.rouvrirAskUser();
    expect(panneau().ouvert).toBe(true);
    expect(panneau().idx).toBe(1);
    expect(panneau().brouillon).toBe("autre brouillon");
    expect(c.r.inputMessage.value).toBe("");
    q.askUserPrev();
    expect(q.isAskOptionOn("A")).toBe(true);
  });

  it("reset : le panneau disparaît et le brouillon revient s'il était ouvert", () => {
    const { c, q } = monter("brouillon");
    q.resetAskUser();
    expect(c.e.askUserPanel.value).toBeNull();
    expect(c.r.inputMessage.value).toBe("brouillon");
  });
});

describe("brouillon rendu à toutes les sorties", () => {
  it("reset panneau fermé : le brouillon revient dans la zone vide, ou devant le texte tapé", () => {
    const a = monter("B");
    a.q.dismissAskUser();
    expect(a.c.r.inputMessage.value).toBe("B");
    a.q.resetAskUser();
    expect(a.c.r.inputMessage.value).toBe("B");
    const b = monter("B");
    b.c.r.inputMessage.value = "F";
    b.q.dismissAskUser();
    b.q.resetAskUser();
    expect(b.c.r.inputMessage.value).toBe("B\nF");
    expect(b.c.f.composeRestoreDraft).toBeNull();
  });

  it("fermé avec du texte : le brouillon part dans composeRestoreDraft, une seule place", () => {
    const { c, q, panneau } = monter("B");
    c.r.inputMessage.value = "F";
    q.dismissAskUser();
    expect(c.f.composeRestoreDraft).toBe("B");
    expect(panneau().brouillon).toBe("");
    expect(c.r.inputMessage.value).toBe("F");
  });

  it("envoyer F librement puis reset : le brouillon n'est pas doublé", () => {
    const { c, q } = monter("B");
    c.r.inputMessage.value = "F";
    q.dismissAskUser();
    // sendMessage : la zone reprend le brouillon, composeRestoreDraft est consommé.
    c.r.inputMessage.value = c.f.composeRestoreDraft ?? "";
    c.f.composeRestoreDraft = null;
    q.resetAskUser();
    expect(c.r.inputMessage.value).toBe("B");
  });

  it("rouvert avant l'envoi : le brouillon en attente revient dans le panneau", () => {
    const { c, q, panneau } = monter("B");
    c.r.inputMessage.value = "F";
    q.dismissAskUser();
    q.rouvrirAskUser();
    expect(panneau().brouillon).toBe("B");
    expect(c.f.composeRestoreDraft).toBeNull();
  });

  it("rouvert avec un nouveau texte : le brouillon existant est complété, pas écrasé", () => {
    const { c, q, panneau } = monter("B");
    c.r.inputMessage.value = "F";
    q.dismissAskUser();
    c.r.inputMessage.value = "F2";
    q.rouvrirAskUser();
    expect(panneau().brouillon).toBe("B\nF2");
  });
});

describe("clavier : menus, IME, Échap déjà consommé", () => {
  it("menu « / » ou « @ » ouvert : le questionnaire laisse Entrée au composeur", () => {
    const menu = ref(true);
    const { q, panneau } = monter("", false, menu);
    const ev = touche("Enter", "zone");
    expect(q.askUserKeydown(ev)).toBe(false);
    expect(panneau().idx).toBe(0);
    menu.value = false;
    expect(q.askUserKeydown(touche("Enter", "zone"))).toBe(true);
  });

  it("composition IME : touche traitée sans preventDefault, aucune action", () => {
    const { q, panneau } = monter();
    const a = touche("Enter", "zone", { isComposing: true });
    expect(q.askUserKeydown(a)).toBe(true);
    expect(a.defaultPrevented).toBe(false);
    const b = touche("Enter", "zone", { keyCode: 229 });
    expect(q.askUserKeydown(b)).toBe(true);
    expect(b.defaultPrevented).toBe(false);
    expect(panneau().idx).toBe(0);
  });

  it("Échap déjà consommé par la cascade : le questionnaire reste ouvert", () => {
    const { q, panneau } = monter();
    const ev = touche("Escape", "zone");
    (ev as KeyboardEvent & { _elpisEchapPris?: boolean })._elpisEchapPris = true;
    expect(q.askUserKeydown(ev)).toBe(true);
    expect(panneau().ouvert).toBe(true);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("focus, envoi", () => {
  it("à l'ouverture, le focus n'est pas volé à un champ hors du composeur ; la puce le rend", async () => {
    const ailleurs = document.createElement("input");
    document.body.appendChild(ailleurs);
    ailleurs.focus();
    const { q, focus } = monter();
    await nextTick();
    expect(focus).not.toHaveBeenCalled();
    q.dismissAskUser();
    await nextTick();
    focus.mockClear();
    q.rouvrirAskUser();
    await nextTick();
    expect(focus).toHaveBeenCalled();
    ailleurs.remove();
  });

  it("le focus est pris quand il est dans la colonne du composeur", async () => {
    const col = document.createElement("div");
    col.className = "elpis-compose-col";
    const dedans = document.createElement("button");
    col.appendChild(dedans);
    document.body.appendChild(col);
    dedans.focus();
    const { focus } = monter();
    await nextTick();
    expect(focus).toHaveBeenCalled();
    col.remove();
  });

  it("l'envoi part en message de chat (drapeau) et ne laisse aucun brouillon en route", async () => {
    const { c, q, sendMessage } = monter("B");
    q.toggleAskOption("A");
    q.askUserNext();
    q.askUserNext();
    expect(c.f.envoiQuestionnaire).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(c.f.envoiQuestionnaire).toBe(false);
    expect(c.f.composeRestoreDraft).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("Entrée sur la dernière question pendant un flux : toast au lieu du silence", () => {
    const { q, toasts } = monter("", true);
    q.toggleAskOption("A");
    q.askUserNext();
    q.askUserNext();
    expect(toasts).toEqual(["Réponse en cours : envoi possible une fois terminée"]);
  });
});
