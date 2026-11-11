// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/reconciliation-raisonnement.test.ts — réponse piégée dans le raisonnement, intro creuse, raisonnement tronqué jamais promu (vecteurs Python). */
import { describe, expect, it } from "vitest";

import { reconcileThinkingContent } from "../../src/boucle/reconciliation-raisonnement";
import { lireVecteurs } from "../vecteurs-moteur";
import { comparerResume } from "./aides";
import type { Resume } from "./aides";

interface Vecteurs {
  reconciliation_axes: { thinking: (string | null)[]; content: (string | null)[]; finish: (string | null)[] };
  reconciliations: [[number, number, boolean, boolean, number], Resume][];
}

const V = lireVecteurs<Vecteurs>("boucle-raisonnement");

describe("vecteurs Python de reconcile_thinking_content", () => {
  it("produit complet : vides, blancs Unicode, seuils 200 et 3× en points de code, appels d'outil, finish", () => {
    const axes = V.reconciliation_axes;
    expect(V.reconciliations.length).toBe(
      axes.thinking.length * axes.content.length * 2 * 2 * axes.finish.length,
    );
    for (const [[a, b, inThink, hadToolCalls, f], sortie] of V.reconciliations) {
      const thinking = axes.thinking[a] ?? null;
      const content = axes.content[b] ?? null;
      const finish = axes.finish[f] ?? null;
      comparerResume(
        reconcileThinkingContent(thinking, content, { inThink, hadToolCalls, finish }),
        sortie,
        JSON.stringify([a, b, inThink, hadToolCalls, f]),
      );
    }
  });
});

describe("comportements des tests pytest (réponse piégée, raisonnement tronqué)", () => {
  it("une réponse visible existe : le raisonnement n'est jamais déplacé", () => {
    expect(reconcileThinkingContent("raisonnement", "réponse")).toEqual(["raisonnement", "réponse"]);
  });

  it("réponse aspirée dans le raisonnement (content vide) : promotion intégrale", () => {
    expect(reconcileThinkingContent("La vraie réponse.", "")).toEqual(["", "La vraie réponse."]);
  });

  it("appels d'outil : un content vide est normal, rien n'est promu", () => {
    expect(reconcileThinkingContent("plan d'action", "", { hadToolCalls: true })).toEqual([
      "plan d'action",
      "",
    ]);
  });

  it("intro creuse + vraie réponse coincée dans un <think> non fermé : ajout, raisonnement gardé", () => {
    const pensee = "X".repeat(200);
    const [th, ct] = reconcileThinkingContent(pensee, "ok", { inThink: true });
    expect(ct.startsWith("ok")).toBe(true);
    expect(ct.endsWith(pensee)).toBe(true);
    expect(th).toBe(pensee);
    expect(reconcileThinkingContent(pensee, "42", { inThink: false })).toEqual([pensee, "42"]);
  });

  it("coupure par le plafond (finish=length) : ni promotion ni ajout, le raisonnement tronqué ne fuit pas dans la bulle", () => {
    expect(reconcileThinkingContent("raisonnement coupé", "", { finish: "length" })).toEqual([
      "raisonnement coupé",
      "",
    ]);
    const pensee = "X".repeat(200);
    expect(reconcileThinkingContent(pensee, "ok", { inThink: true, finish: "length" })).toEqual([
      pensee,
      "ok",
    ]);
  });

  it("deux vides restent vides ; les seuils comptent les points de code (199 émojis < 200)", () => {
    expect(reconcileThinkingContent("", "")).toEqual(["", ""]);
    const emojis = "😀".repeat(199);
    expect(reconcileThinkingContent(emojis, "ok", { inThink: true })).toEqual([emojis, "ok"]);
    const deuxCents = "😀".repeat(200);
    expect(reconcileThinkingContent(deuxCents, "ok", { inThink: true })[1]).toBe(`ok\n\n${deuxCents}`);
  });
});
