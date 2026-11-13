// SPDX-License-Identifier: MIT
/** frontend/test/reglages/ouverture.test.ts — Paramètres : la fenêtre s'affiche avant toute réponse, document et onglet se relisent en parallèle, une saisie faite pendant la lecture est gardée puis enregistrée. */
import { nextTick, ref } from "vue";
import * as Vue from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupReglages } from "../../src/features/reglages/reglages";
import type { CtxReglages, RefsReglages, ReglagesApp } from "../../src/features/reglages/types";
import { ClientHttp } from "../../src/platform/http/client";
import { fetchManuel, json, vider } from "../aides";

function monter(initial: ReglagesApp) {
  const { fetch, appels } = fetchManuel();
  const settings = ref<ReglagesApp>(initial);
  const refs: RefsReglages = {
    user: ref({ username: "alice" }),
    settings,
    config: ref({ active_mcp_ids: [] }),
    inputMessage: ref(""),
    inputRef: ref(null),
  };
  const ctx: CtxReglages = {
    showToast: () => undefined,
    fetchAuth: (url, options) => fetch(url, options),
    openConfirm: () => Promise.resolve(true),
    openPrompt: () => Promise.resolve(null),
  };
  const R = setupReglages(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetch));
  const urls = (): string[] => appels.map((a) => `${a.init?.method ?? "GET"} ${a.url.split("?")[0]}`);
  /** Répond à la première requête encore en attente dont l'URL commence par `debut`. */
  const repondre = (debut: string, corps: unknown, methode = "GET"): void => {
    const a = appels.find((x) => x.url.startsWith(debut) && (x.init?.method ?? "GET") === methode);
    if (!a) throw new Error(`aucune requête ${methode} ${debut}`);
    appels.splice(appels.indexOf(a), 1);
    a.repondre(json(corps));
  };
  return { R, settings, urls, repondre };
}

describe("ouverture des Paramètres", () => {
  it("affiche la fenêtre sans attendre le réseau ; document et dernier onglet partent ensemble", async () => {
    const { R, urls } = monter({ assistant_name: "Elpis" });
    R.settingsTab.value = "usage";
    void R.openSettings();
    expect(R.showSettingsModal.value).toBe(true);
    await vider();
    expect(urls()).toContain("GET /api/settings");
    expect(urls()).toContain("GET /api/usage/me");
  });

  it("une saisie faite pendant la lecture n'est ni écrasée ni perdue", async () => {
    const { R, settings, urls, repondre } = monter({ assistant_name: "Elpis", system_prompt: "" });
    const ouverture = R.openSettings();
    settings.value.system_prompt = "Réponds en français.";
    await nextTick();
    expect(R.settingsDirty.value).toBe(true);
    repondre("/api/settings", { assistant_name: "Zoé", system_prompt: "ancien" });
    await ouverture;
    expect(settings.value.system_prompt).toBe("Réponds en français.");
    expect(settings.value.assistant_name).toBe("Zoé");
    await vider();
    const put = urls().filter((u) => u === "PUT /api/settings");
    expect(put).toHaveLength(1);
  });

  it("l'instantané est le document reçu : une valeur changée ailleurs n'est pas une modification", async () => {
    const { R, settings, repondre } = monter({ assistant_name: "Elpis" });
    const ouverture = R.openSettings();
    repondre("/api/settings", { assistant_name: "Zoé" });
    await ouverture;
    expect(settings.value.assistant_name).toBe("Zoé");
    expect(R.settingsDirty.value).toBe(false);
  });

  it("un document identique ne remplace pas celui affiché", async () => {
    const { R, settings, repondre } = monter({});
    const premiere = R.openSettings();
    repondre("/api/settings", { assistant_name: "Zoé" });
    await premiere;
    const affiche = settings.value;
    await R.closeSettings(true);
    const seconde = R.openSettings();
    repondre("/api/settings", { assistant_name: "Zoé" });
    await seconde;
    expect(settings.value).toBe(affiche);
  });

  it("fenêtre déjà ouverte : un autre onglet demandé garde la saisie en attente", async () => {
    const { R, settings, urls, repondre } = monter({});
    const ouverture = R.openSettings();
    repondre("/api/settings", { system_prompt: "" });
    await ouverture;
    settings.value.system_prompt = "en cours";
    await nextTick();
    void R.openSettingsTab("usage");
    await vider();
    expect(settings.value.system_prompt).toBe("en cours");
    expect(R.settingsDirty.value).toBe(true);
    expect(urls().filter((u) => u === "GET /api/settings")).toHaveLength(0);
  });

  it("/memory ouvre l'onglet Mémoire sans relire l'onglet précédent", async () => {
    const { R, urls } = monter({});
    R.settingsTab.value = "usage";
    void R.openSettingsTab("memory");
    expect(R.settingsTab.value).toBe("memory");
    expect(R.showSettingsModal.value).toBe(true);
    await vider();
    expect(urls()).toContain("GET /api/memory/state");
    expect(urls()).not.toContain("GET /api/usage/me");
  });
});
