// SPDX-License-Identifier: MIT
/** frontend/test/chat/slash-rag.test.ts — commande /rag dans le menu « / » : sous-commandes avec leurs indications, menu des collections (les miennes puis celles partagées), noms de plusieurs mots, entêtes, lancement par Entrée ou par le menu. */
import * as Vue from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerMenuSlash } from "../../src/features/chat/composeur/slash";
import type { CtxSlash, RagSlash, ValeurArgument } from "../../src/features/chat/composeur/slash";
import { creerCommandeRag } from "../../src/features/rag/commande";
import type { ChatPourRag } from "../../src/features/rag/commande";
import { collection, fausseApi, idRag, partagee } from "../rag/aides";

afterEach(() => {
  document.body.innerHTML = "";
});

const mes = [
  collection(1, { name: "Procédures réseau", doc_count: 48 }),
  collection(2, { name: "Contrats fournisseurs", doc_count: 17, visibility: "groups" }),
  collection(4, { name: "Notes de réunion 2026", doc_count: 31 }),
];
const autres = [
  partagee(3, "Sophie Laurent", { name: "Base de connaissances support", doc_count: 128 }),
  partagee(5, "Marc Dubois", { name: "Référentiel sécurité (PSSI)", doc_count: 22 }),
];

function monter(o: { rag?: boolean; autorise?: boolean | null } = {}) {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const inputRef = Vue.ref<HTMLTextAreaElement | null>(ta);
  const inputMessage = Vue.ref("");
  const toasts: { m: string; t?: string }[] = [];
  const selection = Vue.ref<readonly string[]>([]);
  const ragChat = {
    autorise: Vue.ref<boolean | null>(o.autorise === undefined ? true : o.autorise),
    selection,
    accessibles: Vue.ref([...mes, ...autres]),
    rafraichir: vi.fn(async () => undefined),
    activer: vi.fn(async (id: string) => {
      selection.value = [...selection.value, id];
      return true;
    }),
    couper: vi.fn(async () => {
      selection.value = [];
      return true;
    }),
  };
  const chat = {
    ragChat,
    attachedFiles: Vue.ref([]),
    messages: Vue.ref([]),
  } as unknown as ChatPourRag;
  const api = fausseApi();
  const ouvrirPage = vi.fn();
  const rag = creerCommandeRag({
    api,
    chat: () => chat,
    ouvrirPage,
    enGeneration: () => false,
    notifierCollections: () => undefined,
  });
  const ctx: CtxSlash = {
    fetchAuth: () => Promise.resolve(null),
    showToast: (m, t) => toasts.push({ m, t }),
    rag: o.rag === false ? null : (rag as RagSlash),
  };
  const menu = creerMenuSlash(Vue, { inputRef, inputMessage }, ctx);
  const taper = (texte: string): void => {
    inputMessage.value = texte;
    ta.value = texte;
    ta.setSelectionRange(texte.length, texte.length);
    menu.onInput();
  };
  const choisir = async (i: number): Promise<void> => {
    await menu.selectSlash(menu.slashList.value[i]);
    await Vue.nextTick();
  };
  return { menu, taper, choisir, toasts, inputMessage, ragChat, api, ouvrirPage, selection };
}

const valeurs = (b: ReturnType<typeof monter>): string[] =>
  (b.menu.slashList.value as readonly ValeurArgument[]).map((v) => v.value);

describe("/rag : menu", () => {
  it("la commande est proposée avec son icône de livres", () => {
    const b = monter();
    b.taper("/ra");
    const c = b.menu.slashList.value[0] as { name: string; icon: string };
    expect(c.name).toBe("rag");
    expect(c.icon).toBe("ph-books");
  });

  it("la commande n'est pas proposée quand le serveur refuse le RAG au compte", () => {
    const b = monter({ autorise: false });
    b.taper("/ra");
    expect(b.menu.slashList.value.map((c) => (c as { name: string }).name)).not.toContain("rag");
    const sans = monter({ rag: false });
    sans.taper("/ra");
    expect(sans.menu.slashList.value.map((c) => (c as { name: string }).name)).not.toContain("rag");
  });

  it("« /rag » puis Entrée ouvre les sept sous-commandes, dans l'ordre de la maquette, avec leurs indications", async () => {
    const b = monter();
    b.taper("/rag");
    await b.choisir(0);
    expect(b.inputMessage.value).toBe("/rag ");
    b.taper("/rag ");
    expect(b.menu.slashLevel.value).toBe("values");
    expect(valeurs(b)).toEqual(["use", "off", "search", "add", "new", "status", "open"]);
    const lignes = b.menu.slashList.value as readonly ValeurArgument[];
    expect(lignes[0]).toMatchObject({
      value: "use",
      indice: "collection",
      label: "Interroger une collection dans ce chat",
    });
    expect(lignes[2]).toMatchObject({ value: "search", indice: "question" });
    expect(lignes[1]?.indice).toBeUndefined();
    expect(b.menu.slashHeaderLabel.value).toBe("RAG");
    expect(b.menu.slashHeaderCmd.value).toBe("/rag");
  });

  it("« /rag use » : les collections, les miennes puis celles partagées avec l'auteur, entête dédié", () => {
    const b = monter();
    b.taper("/rag use ");
    expect(b.menu.slashHeaderLabel.value).toBe("Collection à interroger");
    expect(b.menu.slashHeaderCmd.value).toBe("/rag use");
    const l = b.menu.slashList.value as readonly ValeurArgument[];
    expect(l.map((v) => v.value)).toEqual([
      "Contrats fournisseurs",
      "Notes de réunion 2026",
      "Procédures réseau",
      "Base de connaissances support",
      "Référentiel sécurité (PSSI)",
    ]);
    expect(l[0]?.label.replace(/\u00a0/g, " ")).toBe("Vous · publiée · 17 documents");
    expect(l[0]?.icone).toBe("ph-books");
    expect(l[3]?.label.replace(/\u00a0/g, " ")).toBe("Sophie Laurent · 128 documents");
    expect(l[3]?.icone).toBe("ph-users-three");
  });

  it("« /rag add » ne propose que mes collections", () => {
    const b = monter();
    b.taper("/rag add ");
    expect(b.menu.slashHeaderLabel.value).toBe("Collection à enrichir");
    expect(valeurs(b)).toHaveLength(3);
  });

  it("un nom de plusieurs mots filtre l'ensemble de ce qui est tapé", () => {
    const b = monter();
    b.taper("/rag use Procédures ré");
    expect(valeurs(b)).toEqual(["Procédures réseau"]);
    b.taper("/rag use sophie");
    expect(valeurs(b)).toEqual([]);
  });

  it("« /rag search » et « /rag new » n'ouvrent pas de menu : la saisie est libre", () => {
    const b = monter();
    b.taper("/rag search comment renouveler ");
    expect(b.menu.showSlash.value).toBe(false);
    b.taper("/rag new Notes ");
    expect(b.menu.showSlash.value).toBe(false);
  });
});

describe("/rag : lancement", () => {
  it("choisir « use » dans le menu laisse « /rag use » et montre les collections", async () => {
    const b = monter();
    b.taper("/rag ");
    await b.choisir(0);
    expect(b.inputMessage.value).toBe("/rag use ");
    b.taper("/rag use ");
    expect(b.menu.slashLevel.value).toBe("values");
  });

  it("choisir une collection l'active, le texte est vidé, un toast confirme", async () => {
    const b = monter();
    b.taper("/rag use ");
    const i = valeurs(b).indexOf("Procédures réseau");
    await b.choisir(i);
    expect(b.ragChat.activer).toHaveBeenCalledWith(idRag(1));
    expect(b.inputMessage.value).toBe("");
    expect(b.toasts).toEqual([{ m: "« Procédures réseau » sera interrogée dans ce chat.", t: "success" }]);
  });

  it("choisir une collection après en avoir tapé le début ne duplique pas les mots", async () => {
    const b = monter();
    b.taper("/rag use Procédures ré");
    await b.choisir(0);
    expect(b.ragChat.activer).toHaveBeenCalledWith(idRag(1));
  });

  it("choisir « off » coupe tout de suite, sans argument", async () => {
    const b = monter();
    b.selection.value = [idRag(1)];
    b.taper("/rag ");
    await b.choisir(1);
    expect(b.ragChat.couper).toHaveBeenCalled();
    expect(b.toasts[0]).toEqual({ m: "Ce chat n’interroge plus de collection.", t: "success" });
  });

  it("choisir « status » ou « open » lance aussitôt", async () => {
    const b = monter();
    b.taper("/rag ");
    await b.choisir(5);
    expect(b.api.travaux).toHaveBeenCalledWith(true);
    b.taper("/rag ");
    await b.choisir(6);
    expect(b.ouvrirPage).toHaveBeenCalledWith();
  });

  it("choisir « search » ou « new » attend la suite de la saisie", async () => {
    const b = monter();
    b.taper("/rag ");
    await b.choisir(2);
    expect(b.inputMessage.value).toBe("/rag search ");
    expect(b.toasts).toEqual([]);
  });

  it("Entrée sur un texte complet : la commande est reconnue et lancée avec la ligne entière", async () => {
    const b = monter();
    const hit = b.menu.slashResolve("/rag use Contrats fournisseurs");
    expect(hit?.cmd.name).toBe("rag");
    expect(hit?.raw).toBe("use Contrats fournisseurs");
    await b.menu.slashRun(hit);
    expect(b.ragChat.activer).toHaveBeenCalledWith(idRag(2));
  });

  it("collection inconnue : erreur dite en toast, rien d'activé", async () => {
    const b = monter();
    await b.menu.slashRun(b.menu.slashResolve("/rag use Rien"));
    expect(b.ragChat.activer).not.toHaveBeenCalled();
    expect(b.toasts[0]?.t).toBe("error");
    expect(b.toasts[0]?.m).toContain("Collection inconnue : « Rien »");
  });

  it("taper « /rag » relit la liste des collections", () => {
    const b = monter();
    b.taper("/rag");
    expect(b.ragChat.rafraichir).toHaveBeenCalled();
  });
});

describe("autres commandes : entêtes inchangés", () => {
  it("le niveau des valeurs d'une autre commande garde « Valeurs » et « /nom »", () => {
    const b = monter();
    b.taper("/settings ");
    expect(b.menu.slashHeaderLabel.value).toBe("Valeurs");
    expect(b.menu.slashHeaderCmd.value).toBe("/settings");
  });
});
