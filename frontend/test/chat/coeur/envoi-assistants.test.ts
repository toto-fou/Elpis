// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/envoi-assistants.test.ts — ouverture et lancement des assistants de création : champ requis, prérequis absents (catégorie, réglage, fonction de l'instance), fermeture, catégories cochées, skill épinglé une fois, lignes envoyées. */
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { creerEnvoi } from "../../../src/features/chat/coeur/envoi";

function monter(
  outils: Record<string, boolean>,
  reglages: Record<string, unknown> = {},
  fonctions: Record<string, unknown> | null = null,
) {
  const toasts: { m: string; t?: string }[] = [];
  const generateResponse = vi.fn(() => Promise.resolve());
  const messages = ref<{ content?: string }[]>([]);
  const c = {
    r: {
      currentView: ref("settings"),
      settings: ref(reglages),
      features: ref(fonctions),
      inputMessage: ref(""),
      isStreaming: ref(false),
      currentChatId: ref("c1"),
      messages,
      inputRef: ref(null),
    },
    ctx: {
      showToast: (m: string, t?: string) => void toasts.push({ m, t }),
      closeSettings: vi.fn(),
      loadSettingsData: vi.fn(),
    },
    e: {
      localTools: ref({ ...outils }),
      assistantForm: ref({ open: false, id: "", valeurs: {} as Record<string, string> }),
      planMode: ref(false),
      attachedFiles: ref([]),
    },
    f: { composeRestoreDraft: null },
    l: {
      autoResize: () => undefined,
      generateResponse,
      ragEnAttente: () => [],
      voix: () => ({ stopDictation: () => undefined }),
    },
  };
  const pinnedSkills = { value: [] as { name: string }[] };
  const startNewChat = vi.fn(() => Promise.resolve());
  const envoi = creerEnvoi(
    c as never,
    {
      closeMentionDropdown: () => undefined,
      pinnedSkills,
      images: { imageMode: ref(false) },
      ensureServerChat: () => Promise.resolve("c1"),
      startNewChat,
    } as never,
  );
  return { c, envoi, toasts, generateResponse, pinnedSkills, startNewChat };
}

describe("ouvrirAssistant", () => {
  it("ouvre le formulaire préremplit, ignore un id inconnu", () => {
    const { c, envoi } = monter({});
    envoi.ouvrirAssistant("routine", { objectif: "Veille" });
    expect(c.e.assistantForm.value).toMatchObject({
      open: true,
      id: "routine",
      valeurs: { objectif: "Veille" },
    });
    envoi.ouvrirAssistant("inconnu");
    expect(c.e.assistantForm.value.id).toBe("routine");
  });
});

describe("lancerAssistantForm", () => {
  it("champ requis vide : toast d'erreur, formulaire resté ouvert, rien envoyé", async () => {
    const { c, envoi, toasts, generateResponse } = monter({ skill: false, routine: false });
    envoi.ouvrirAssistant("routine");
    await envoi.lancerAssistantForm();
    expect(toasts).toEqual([{ m: "Objectif requis", t: "error" }]);
    expect(c.e.assistantForm.value.open).toBe(true);
    expect(generateResponse).not.toHaveBeenCalled();
  });

  it("ferme le formulaire, coche les catégories, épingle le skill et envoie les lignes", async () => {
    const { c, envoi, toasts, generateResponse, pinnedSkills, startNewChat } = monter({ skill: false });
    envoi.ouvrirAssistant("routine", { objectif: "Résumer les tickets", quand: "lundi 8 h" });
    await envoi.lancerAssistantForm();
    expect(c.e.assistantForm.value.open).toBe(false);
    expect(c.r.currentView.value).toBe("chat");
    expect(startNewChat).toHaveBeenCalledOnce();
    expect(c.e.localTools.value).toEqual({ skill: true });
    expect(pinnedSkills.value.map((s) => s.name)).toEqual(["creer-une-routine"]);
    expect(toasts).toEqual([]);
    const envoye = c.r.messages.value[0]?.content ?? "";
    expect(envoye).toContain("**Objectif :** Résumer les tickets");
    expect(envoye).toContain("**Quand :** lundi 8 h");
    expect(generateResponse).toHaveBeenCalledOnce();
  });

  it("skill épinglé une seule fois ; catégorie absente : toast seulement si le descripteur le prévoit", async () => {
    const { c, envoi, toasts, pinnedSkills } = monter({ fs: false });
    envoi.ouvrirAssistant("skill", { sujet: "Déployer" });
    await envoi.lancerAssistantForm();
    envoi.ouvrirAssistant("skill", { sujet: "Déployer encore" });
    await envoi.lancerAssistantForm();
    expect(pinnedSkills.value).toHaveLength(1);
    expect(c.e.localTools.value).toEqual({ fs: true });
    expect(toasts.map((x) => x.m)).toEqual([
      "Outils « Skills » indisponibles : l’assistant rédigera le skill sans pouvoir l’enregistrer lui-même",
      "Outils « Skills » indisponibles : l’assistant rédigera le skill sans pouvoir l’enregistrer lui-même",
    ]);
  });

  it("routine : réglage « Créer des routines » coupé ou catégorie skill absente, toast ; sinon silence", async () => {
    const coupe = monter({ skill: true }, { routine_tool_enabled: false });
    coupe.envoi.ouvrirAssistant("routine", { objectif: "Veille" });
    await coupe.envoi.lancerAssistantForm();
    expect(coupe.toasts.map((x) => x.m)).toEqual([
      "Création de routines coupée (Paramètres › Fonctionnalités) : l’assistant rédigera la routine sans pouvoir l’enregistrer",
    ]);
    const sansSkill = monter({}, {});
    sansSkill.envoi.ouvrirAssistant("routine", { objectif: "Veille" });
    await sansSkill.envoi.lancerAssistantForm();
    expect(sansSkill.toasts).toHaveLength(1);
    expect(sansSkill.toasts[0]!.m).toContain("Skills");
    const ok = monter({ skill: true }, { routine_tool_enabled: true });
    ok.envoi.ouvrirAssistant("routine", { objectif: "Veille" });
    await ok.envoi.lancerAssistantForm();
    expect(ok.toasts).toEqual([]);
  });

  it("agent : sous-agents coupés par l'administrateur, toast ; fonction présente ou inconnue, silence", async () => {
    const coupe = monter({ skill: true }, {}, { agents: false });
    coupe.envoi.ouvrirAssistant("agent", { nom: "revue-sql", mission: "Relire" });
    await coupe.envoi.lancerAssistantForm();
    expect(coupe.toasts.map((x) => x.m)).toEqual([
      "Sous-agents coupés par l’administrateur : l’assistant rédigera l’agent sans pouvoir l’enregistrer",
    ]);
    expect(coupe.pinnedSkills.value.map((s) => s.name)).toEqual(["creer-un-agent"]);
    for (const fonctions of [{ agents: true }, null]) {
      const ok = monter({ skill: true }, {}, fonctions);
      ok.envoi.ouvrirAssistant("agent", { nom: "revue-sql", mission: "Relire" });
      await ok.envoi.lancerAssistantForm();
      expect(ok.toasts).toEqual([]);
    }
  });

  it("une catégorie absente sans message propre reste silencieuse", async () => {
    const { envoi, toasts } = monter({ skill: true });
    envoi.ouvrirAssistant("skill", { sujet: "X" });
    await envoi.lancerAssistantForm();
    expect(toasts).toEqual([]);
  });
});
