// SPDX-License-Identifier: MIT
/** frontend/test/code/code.test.ts — module de la page Code : liste des sessions, menu slash, envoi d'un prompt avec écho optimiste, commandes de l'interface. */
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { creerCode } from "../../src/features/code/code";

function monter(routeur: (url: string, init?: RequestInit) => unknown) {
  const appels: Array<[string, string]> = [];
  const toasts: string[] = [];
  const surface = creerCode(
    { currentView: ref("chat") },
    {
      showToast: (m) => void toasts.push(m),
      fetchJsonAuth: (url, init) => {
        appels.push([init?.method ?? "GET", url]);
        return Promise.resolve(routeur(url, init));
      },
      fetchAuth: () => Promise.resolve(null),
      openConfirm: () => Promise.resolve(true),
    },
  );
  return { c: surface, appels, toasts };
}

describe("module de la page Code", () => {
  it("groupe les sessions connectées et l'historique", async () => {
    const { c } = monter((u) => {
      if (u === "/api/code/sessions")
        return [
          { id: "a", connected: true, busy: true },
          { id: "b", connected: false },
        ];
      return [];
    });
    await c.codeRefreshSessions();
    expect(c.codeSessionGroups.value.map((g) => [g.key, g.sessions.length])).toEqual([
      ["live", 1],
      ["past", 1],
    ]);
    expect(c.codeBusy.value).toEqual({ a: true, b: false });
  });

  it("propose les commandes de l'interface et celles de la CLI dans le menu slash", async () => {
    const { c } = monter(() => []);
    c.codeCommands.value = [{ name: "deploy" }, { name: "review" }];
    c.codePrompt.value = "/mo";
    expect(c.codeSlashOpen.value).toBe(true);
    expect(c.codeSlashList.value.map((x) => x.name)).toEqual(["model"]);
    c.codePrompt.value = "/";
    expect(c.codeSlashList.value.map((x) => x.name).slice(-2)).toEqual(["deploy", "review"]);
    c.codePrompt.value = "texte";
    expect(c.codeSlashOpen.value).toBe(false);
  });

  it("envoie un prompt avec écho optimiste puis vide le champ", async () => {
    const { c, appels } = monter((_u, init) => (init?.method === "POST" ? { ok: true, queued: true } : []));
    c.codeActiveId.value = "s1";
    c.codePrompt.value = "bonjour";
    await c.codeSendPrompt();
    expect(appels).toContainEqual(["POST", "/api/code/sessions/s1/prompt"]);
    expect(c.codeMessages.value[0]).toMatchObject({ pending: true, role: "user" });
    expect(c.codePrompt.value).toBe("");
  });

  it("retire l'écho optimiste quand l'envoi est refusé", async () => {
    const { c } = monter(() => null);
    c.codeActiveId.value = "s1";
    c.codePrompt.value = "salut";
    await c.codeSendPrompt();
    expect(c.codeMessages.value).toHaveLength(0);
    expect(c.codePrompt.value).toBe("salut");
  });

  it("traite /model dans l'interface sans l'envoyer au modèle", async () => {
    const { c, appels } = monter(() => []);
    c.codeActiveId.value = "s1";
    c.codePrompt.value = "/model";
    await c.codeSendPrompt();
    expect(c.codeModelOpen.value).toBe(true);
    expect(appels.some(([m]) => m === "POST")).toBe(false);
  });

  it("vide l'état sensible à la déconnexion", () => {
    const { c } = monter(() => []);
    c.codeSessions.value = [{ id: "x" }];
    c.codeConfig.value = { app_url: "u", token: "secret", plugin_url: "p" };
    c.codeResetOnLogout();
    expect(c.codeSessions.value).toEqual([]);
    expect(c.codeConfig.value.token).toBe("");
  });

  it("normalise le code d'appairage avant l'envoi", async () => {
    const { c, toasts } = monter(() => []);
    c.codePairCode.value = "ab-12";
    await c.codeSubmitPairCode();
    expect(toasts).toEqual(["Le code d'appairage fait 6 caractères."]);
  });
});
