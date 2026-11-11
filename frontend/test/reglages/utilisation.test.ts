// SPDX-License-Identifier: MIT
/** frontend/test/reglages/utilisation.test.ts — Paramètres › Utilisation : chargement, repli sans clé `tokens`, barres, messages d'erreur. */
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupUtilisation, usageSourceLabel, usageWidth } from "../../src/features/reglages/utilisation";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const monter = (route: (u: string) => Response | Promise<Response>) =>
  setupUtilisation(new ClientHttp(new GestionnaireSession(), (u) => Promise.resolve(route(u))));

const TOKENS = {
  input: 1000,
  input_new: 200,
  output: 400,
  response: 300,
  cache: 800,
  tools: 100,
  thinking: 100,
  by_source: [{ source: "chat", tokens: 900, turns: 3 }],
};

describe("setupUtilisation", () => {
  it("charge la période demandée et calcule barres, échelles et part de réflexion", async () => {
    const vus: string[] = [];
    const U = monter((u) => {
      vus.push(u);
      return json({ tokens: TOKENS });
    });
    U.setUsageDays(7);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(vus).toEqual(["/api/usage/me?days=7"]);
    expect(U.usageBars.value.map((b) => b.key)).toEqual(["input", "cache", "tools", "output", "thinking"]);
    expect(U.usageBars.value[1]!.note).toBe("80 % de l'entrée");
    expect(U.usageBarMax.value).toBe(1000);
    expect(U.usageSourceMax.value).toBe(900);
    expect(U.usageThinkingPct.value).toBe(25);
    expect(U.usageSourceTitle(TOKENS.by_source[0]!)).toContain("Chat — 900 tokens, 3 tours");
  });

  it("jours inconnus ramenés à 30 ; payload sans `tokens` toléré", async () => {
    const U = monter(() => json({}));
    U.usageDays.value = 7;
    U.setUsageDays(5);
    expect(U.usageDays.value).toBe(30);
    await new Promise((r) => setTimeout(r, 0));
    expect(U.usageBars.value[0]!.value).toBe(0);
    expect(U.usageThinkingPct.value).toBe(0);
  });

  it("erreurs : HTTP, service injoignable", async () => {
    const http = monter(() => json({ detail: "x" }, 500));
    await http.loadUsageData();
    expect(http.usageError.value).toBe("Erreur serveur (HTTP 500)");
    const U = setupUtilisation(
      new ClientHttp(new GestionnaireSession(), () => Promise.reject(new Error("net"))),
    );
    await U.loadUsageData();
    expect(U.usageError.value).toBe("Service injoignable");
    expect(U.usageLoading.value).toBe(false);
  });

  it("aides pures", () => {
    expect(usageSourceLabel("webhook")).toBe("Webhooks");
    expect(usageSourceLabel(undefined)).toBe("Autre");
    expect(usageWidth(50, 200)).toBe("25.00%");
    expect(usageWidth(5, 0)).toBe("0.00%");
  });
});
