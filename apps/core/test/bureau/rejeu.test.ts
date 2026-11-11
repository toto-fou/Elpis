// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/rejeu.test.ts — rejeu en temps réel : arrêt pendant une attente, arrêts indépendants de deux rejeux, primitives absentes, attente de stabilité. */
import { afterEach, describe, expect, it } from "vitest";

import {
  assignStableIds,
  checkExpect,
  installerHorlogeRejeu,
  installerPrimitivesBureau,
  registerDesktopObservation,
  replayScenario,
  waitStable,
} from "../../src/bureau";
import type { PrimitivesBureau } from "../../src/bureau";

afterEach(() => {
  installerPrimitivesBureau(null);
  installerHorlogeRejeu(null);
});

/** Agent factice : rien n'apparaît jamais, les actions réussissent, l'écran est figé. */
function agentFige(journal: string[] = []): PrimitivesBureau {
  return {
    grab: async () => ({ ok: true, sig: "aaaaaaaaaaaaaaaa" }),
    probeTree: async (u, t) => {
      journal.push(`probe ${t}`);
      registerDesktopObservation(u, t, assignStableIds(u, t, []));
      return { ok: true, elements: [] };
    },
    observe: async () => {
      journal.push("observe");
      return { ok: true, elements: [] };
    },
    act: async (_u, t) => {
      journal.push(`act ${t}`);
      return { ok: true, frame_token: "tok" };
    },
    readText: async () => ({ ok: true, text: "" }),
    launch: async () => ({ ok: true, found: true }),
    waitWindow: async () => ({ ok: true, found: true }),
  };
}

const attenteLongue = {
  op: "click",
  anchor: { x: 1, y: 1 },
  args: {},
  expect: { kind: "element", query: "Dialogue" },
  timeout_ms: 30_000,
};

describe("rejeu en temps réel", () => {
  it("Stop pendant une attente : pas annulé au sondage suivant, pas restants sautés", async () => {
    installerPrimitivesBureau(agentFige());
    let stop = false;
    setTimeout(() => {
      stop = true;
    }, 100);
    const debut = Date.now();
    const r = await replayScenario([attenteLongue, attenteLongue], "u", "vm-stop", {
      shouldAbort: () => stop,
    });
    expect(Date.now() - debut).toBeLessThan(5000);
    expect([r["cancelled"], r["aborted"], r["skipped"], r["passed"], r["failed"]]).toEqual([
      true,
      true,
      2,
      0,
      0,
    ]);
  });

  it("deux rejeux simultanés : chacun lit son propre arrêt", async () => {
    const journal: string[] = [];
    installerPrimitivesBureau(agentFige(journal));
    let stopA = false;
    setTimeout(() => {
      stopA = true;
    }, 100);
    const court = { ...attenteLongue, timeout_ms: 1500 };
    const [a, b] = await Promise.all([
      replayScenario([attenteLongue], "u", "vm-a", { shouldAbort: () => stopA }),
      replayScenario([court], "u", "vm-b", { shouldAbort: () => false }),
    ]);
    expect([a["cancelled"], a["skipped"]]).toEqual([true, 1]);
    expect([b["cancelled"], b["failed"], (b["results"] as Record<string, unknown>[])[0]?.["error"]]).toEqual([
      false,
      1,
      "expect_timeout: element «Dialogue»",
    ]);
    expect(journal.filter((l) => l === "observe")).toHaveLength(1);
  });

  it("primitives non installées : erreur explicite", async () => {
    await expect(replayScenario([attenteLongue], "u", "vm-x")).rejects.toThrow(
      /primitives du bureau non installées/,
    );
  });

  it("hors rejeu, l'auto-réparation vision n'est pas bornée ; la stabilité rend le temps attendu", async () => {
    const journal: string[] = [];
    installerPrimitivesBureau(agentFige(journal));
    const h = { t: 50.0 };
    installerHorlogeRejeu({
      monotone: () => h.t,
      dormir: async (s) => {
        h.t += s;
      },
    });
    for (let i = 0; i < 3; i++) {
      const [ok, , detail] = await checkExpect("u", "vm-libre", { kind: "element", query: "X" }, 1500);
      expect([ok, detail]).toEqual([false, "element «X»"]);
    }
    expect(journal.filter((l) => l === "observe")).toHaveLength(3);
    expect(await waitStable("u", "vm-libre", { timeoutMs: 5000 })).toBe(800);
  });

  it("budget d'auto-réparation propre au rejeu : un autre compte sur la même cible, en direct, reste illimité", async () => {
    const vues: string[] = [];
    let libererRejeu = (): void => undefined;
    const directsFinis = new Promise<void>((ok) => (libererRejeu = ok));
    installerPrimitivesBureau({
      ...agentFige(),
      observe: async (u) => {
        vues.push(u);
        return { ok: true, elements: [] };
      },
      act: async () => {
        await directsFinis;
        return { ok: true, frame_token: "tok" };
      },
    });
    const h = { t: 50.0 };
    installerHorlogeRejeu({
      monotone: () => h.t,
      dormir: async (s) => {
        h.t += s;
      },
    });
    const rejeu = replayScenario([{ ...attenteLongue, timeout_ms: 1500 }], "alice", "vm1");
    await new Promise((ok) => setImmediate(ok));
    for (let i = 0; i < 12; i++) await checkExpect("bob", "vm1", { kind: "element", query: "X" }, 1500);
    libererRejeu();
    const r = await rejeu;
    expect([vues.filter((u) => u === "bob").length, vues.filter((u) => u === "alice").length]).toEqual([
      12, 1,
    ]);
    expect(r["heal_budget_exhausted"]).toBe(false);
  });
});
