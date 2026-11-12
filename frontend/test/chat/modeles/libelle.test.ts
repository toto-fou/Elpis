// SPDX-License-Identifier: MIT
/** frontend/test/chat/modeles/libelle.test.ts — libellé du sélecteur de modèle : vide tant que la liste n'est pas connue, « Aucun modèle » ensuite si elle est vide ou injoignable. */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { setupChatModels } from "../../../src/features/chat/modeles/modeles";
import { json } from "../../aides";

function monter(reponseListe: () => Promise<Response | null>, connecteurs: unknown = { connectors: [] }) {
  const refs = {
    availableModels: ref<string[]>([]),
    selectedModel: ref(""),
    activeModelIds: ref<string[]>([]),
    llmHealth: ref(null),
    isLoadingModel: ref(false),
    showModelProps: ref(false),
    modelPropsData: ref(null),
    modelPropsLoading: ref(false),
    showModelManager: ref(false),
    selectedConnector: ref(""),
    selectedEngineMeta: ref({ key: "builtin", llamacpp: true, loaded: [] }),
  };
  const fetchAuth = (url: string): Promise<Response | null> =>
    url === "/api/llm/models" ? reponseListe() : Promise.resolve(json(connecteurs));
  const modeles = setupChatModels(
    Vue as never,
    refs as never,
    { showToast: () => {}, fetchAuth, openConfirm: () => Promise.resolve(true) } as never,
  );
  return { modeles, refs };
}

describe("libellé du sélecteur de modèle", () => {
  it("vide tant que la liste n'est pas arrivée, puis le vrai nom", async () => {
    let repondre: (r: Response) => void = () => {};
    const attente = new Promise<Response>((r) => {
      repondre = r;
    });
    const { modeles } = monter(() => attente);
    expect(modeles.selectedModelLabel.value).toBe("");
    const chargement = modeles.loadAvailableModels();
    expect(modeles.selectedModelLabel.value).toBe("");
    repondre(json({ models: ["qwen3"], models_with_status: [{ id: "qwen3", status: "loaded" }] }));
    await chargement;
    expect(modeles.selectedModelLabel.value).toBe("qwen3");
  });

  it("liste réellement vide : « Aucun modèle » une fois la réponse reçue", async () => {
    const { modeles } = monter(() => Promise.resolve(json({ models: [] })));
    expect(modeles.selectedModelLabel.value).toBe("");
    await modeles.loadAvailableModels();
    expect(modeles.selectedModelLabel.value).toBe("Aucun modèle");
  });

  it("moteur injoignable, erreur HTTP ou réseau : le libellé est correct dès l'échec", async () => {
    for (const reponse of [
      () => Promise.resolve(null),
      () => Promise.resolve(json({}, 502)),
      () => Promise.reject(new Error("réseau")),
    ]) {
      const { modeles } = monter(reponse);
      await modeles.loadAvailableModels();
      expect(modeles.selectedModelLabel.value).toBe("Aucun modèle");
    }
  });

  it("serveur intégré interdit et aucun connecteur : « Aucun serveur » dès que les connecteurs sont connus", async () => {
    const { modeles } = monter(() => new Promise<Response>(() => {}), {
      connectors: [],
      shared: [],
      builtin_allowed: false,
    });
    await modeles.loadLlmConnectors();
    expect(modeles.selectedModelLabel.value).toBe("Aucun serveur");
  });
});
