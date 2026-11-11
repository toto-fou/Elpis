// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-agents.test.ts — contrats de la console pour les sous-agents (lecture seule et réflexion par type, budget de réflexion, sous-agents simultanés) rejoués contre le core TS réel en process admin : défauts, écriture partielle, bornes, refus, relecture à chaud. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, DEFAUTS_REGLAGES_AGENTS } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";

beforeAll(async () => {
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : sous-agents de la console (core réel)", () => {
  it("défauts, écriture partielle gardant le reste, bornes, types et modes inconnus en 400, compte non admin refusé", async () => {
    expect(await core.appeler("GET", "/api/admin/agents", { cookie })).toEqual({
      config: DEFAUTS_REGLAGES_AGENTS,
      types: ["explore", "implement", "verify", "web", "pr", "custom"],
      bounds: {
        max_tasks_per_turn: [1, 100],
        max_child_tokens_per_turn: [10000, 50000000],
        thinking_budget_tokens: [512, 131072],
        background_timeout_s: [300, 21600],
      },
    });
    const ecrit = (await core.appeler("POST", "/api/admin/agents", {
      cookie,
      corps: {
        agents: {
          read_only: { forced: { verify: true } },
          thinking: { defaults: { explore: "inherit" } },
          thinking_budget_tokens: 4096,
          background_timeout_s: 7200,
        },
      },
    })) as { config: typeof DEFAUTS_REGLAGES_AGENTS };
    expect(ecrit.config.background_timeout_s).toBe(7200);
    expect(ecrit.config.read_only.forced.verify).toBe(true);
    expect(ecrit.config.read_only.defaults.explore).toBe(true);
    expect(ecrit.config.thinking.defaults).toEqual({
      ...DEFAUTS_REGLAGES_AGENTS.thinking.defaults,
      explore: "inherit",
    });
    expect(ecrit.config.thinking_budget_tokens).toBe(4096);
    const relu = (await core.appeler("GET", "/api/admin/agents", { cookie })) as {
      config: typeof DEFAUTS_REGLAGES_AGENTS;
    };
    expect(relu.config).toEqual(ecrit.config);
    for (const corps of [
      { agents: { read_only: { defaults: { inconnu: true } } } },
      { agents: { read_only: { forced: { explore: "oui" } } } },
      { agents: { thinking: { defaults: { verify: "toujours" } } } },
      { agents: { thinking: { defaults: { inconnu: "on" } } } },
      { agents: { thinking: "on" } },
      { agents: { thinking_budget_tokens: 511 } },
      { agents: { thinking_budget_tokens: 131073 } },
      { agents: { thinking_budget_tokens: 1024.5 } },
      { agents: { background_timeout_s: 299 } },
      { agents: { background_timeout_s: 21601 } },
      { agents: { background_timeout_s: "1h" } },
      {},
    ]) {
      const r = await core.app.inject({
        method: "POST",
        url: "/api/admin/agents",
        headers: { cookie },
        payload: corps,
      });
      expect(r.statusCode, JSON.stringify(corps)).toBe(400);
    }
    expect(
      ((await core.appeler("GET", "/api/admin/agents", { cookie })) as { config: unknown }).config,
    ).toEqual(ecrit.config);
    await core.appeler("GET", "/api/admin/agents", { cookie: cookieLou });
    const refus = await core.app.inject({
      method: "POST",
      url: "/api/admin/agents",
      headers: { cookie: cookieLou },
      payload: { agents: { max_tasks_per_turn: 2 } },
    });
    expect(refus.statusCode).toBe(403);
  });

  it("toutes les routes du domaine admin-agents ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-agents").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
