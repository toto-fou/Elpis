// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/reprise-raisonnement.test.ts — reprise d'un raisonnement ou d'une rédaction coupés : bornes, queues, décisions sous plusieurs plafonds, usage cumulé (vecteurs Python). */
import "../moteur-environnement";

import { describe, expect, it, vi } from "vitest";

import type { Reglages } from "@elpis/config";

import * as R from "../../src/boucle/reprise-raisonnement";
import { longueurPy } from "../../src/python";
import { decoder, lireVecteurs } from "../vecteurs-moteur";
import { comparerResume } from "./aides";
import type { Resume } from "./aides";

type Recette = [string, number][] | null;

interface Vecteurs {
  constantes: Record<string, unknown>;
  bornes: { recette: Recette; sortie: Resume }[];
  queues: { recette: Recette; natif: boolean; sortie: Resume }[];
  queues_prose: { recette: Recette; sortie: Resume }[];
  axes: Record<string, unknown[]>;
  decisions: { limites: Record<string, number>; cas: [number[], unknown, unknown][] }[];
  prose_longue: { recette: Recette; decision: [boolean, string] }[];
  fusions: ({ acc: unknown; seg: unknown } & ({ valeur: unknown } | { erreur: string }))[];
}

const V = lireVecteurs<Vecteurs>("boucle-raisonnement");

function texte(r: Recette): string | null {
  return r === null ? null : r.map(([motif, n]) => motif.repeat(n)).join("");
}

/** Module rechargé avec les plafonds du groupe (les constantes de reprise sont lues au chargement, comme en Python). */
async function avecPlafonds(limites: Record<string, number>): Promise<typeof R> {
  vi.resetModules();
  const config = await import("@elpis/config");
  config.surchargerConfig(limites as Partial<Reglages>);
  return import("../../src/boucle/reprise-raisonnement");
}

describe("constantes", () => {
  it("mêmes valeurs que _think_resume et les réglages par défaut", async () => {
    const c = V.constantes;
    expect(R.THINK_PREFILL_OPEN).toBe(c["THINK_PREFILL_OPEN"]);
    expect(R.RESUME_AFTER_THINK_INSTRUCTION).toBe(c["RESUME_AFTER_THINK_INSTRUCTION"]);
    expect(R.MAX_RESUME_THINKING_CHARS).toBe(c["MAX_RESUME_THINKING_CHARS"]);
    expect(R.RESUME_TRUNC_MARKER).toBe(c["RESUME_TRUNC_MARKER"]);
    expect(R.RESUME_HEADROOM_TOKENS).toBe(c["RESUME_HEADROOM_TOKENS"]);
    expect(R.MAX_RESUME_CONTENT_CHARS).toBe(c["MAX_RESUME_CONTENT_CHARS"]);
    const k = await import("../../src/llm/constantes");
    expect([k.LLAMA_THINK_RESUME_MAX, k.LLAMA_THINK_RESUME_TOTAL_TOKENS, k.LLAMA_CONTENT_RESUME_MAX]).toEqual(
      [c["LLAMA_THINK_RESUME_MAX"], c["LLAMA_THINK_RESUME_TOTAL_TOKENS"], c["LLAMA_CONTENT_RESUME_MAX"]],
    );
  });
});

describe("bornes et queues de reprise (vecteurs Python, points de code)", () => {
  it("clip_resume_thinking : suffixe en points de code, marqueur, astral et combinants", () => {
    expect(V.bornes.length).toBeGreaterThanOrEqual(12);
    for (const b of V.bornes)
      comparerResume(R.clipResumeThinking(texte(b.recette)), b.sortie, JSON.stringify(b.recette));
  });

  it("build_resume_tail (natif et repli) et build_content_resume_tail", () => {
    for (const q of V.queues)
      comparerResume(
        R.buildResumeTail(texte(q.recette), { native: q.natif }),
        q.sortie,
        `${JSON.stringify(q.recette)} natif=${q.natif}`,
      );
    for (const q of V.queues_prose)
      comparerResume(R.buildContentResumeTail(texte(q.recette) ?? ""), q.sortie, JSON.stringify(q.recette));
  });
});

/** Décision `[ok, raison]` attendue, ou `{"erreur": "ValueError"}` quand Python lève (un `int()` sur un texte qui n'est pas un entier pour Unicode 15.1). */
function comparerDecision(f: () => unknown, attendu: unknown, contexte: string): void {
  if (attendu !== null && typeof attendu === "object" && !Array.isArray(attendu)) {
    let nom = "aucune";
    try {
      f();
    } catch (e) {
      nom = (e as Error).name;
    }
    expect(nom, contexte).toBe((attendu as { erreur: string }).erreur);
    return;
  }
  expect(f(), contexte).toEqual(attendu);
}

describe("décisions de reprise sous chaque jeu de plafonds", () => {
  for (const g of V.decisions) {
    it(`plafonds ${JSON.stringify(g.limites)} : ${g.cas.length} cas`, async () => {
      const M = await avecPlafonds(g.limites);
      const axes = Object.values(V.axes);
      for (const [idx, pensee, prose] of g.cas) {
        const [
          finish,
          content,
          thinking,
          hadToolCalls,
          partial,
          resumesDone,
          thinkTokensDone,
          ctxSize,
          windowTokens,
          nativeOk,
        ] = idx.map((i, a) => axes[a]?.[i]) as [
          string | null,
          string | null,
          string | null,
          boolean,
          boolean,
          number,
          number,
          number | null,
          number | null,
          boolean,
        ];
        const contexte = JSON.stringify(idx);
        comparerDecision(
          () =>
            M.shouldAutoResume({
              finish,
              content,
              thinking,
              hadToolCalls,
              partial,
              resumesDone,
              thinkTokensDone,
              ctxSize,
              windowTokens,
            }),
          pensee,
          contexte,
        );
        comparerDecision(
          () =>
            M.shouldAutoResumeContent({
              finish,
              content,
              hadToolCalls,
              nativeOk,
              resumesDone,
              ctxSize,
              windowTokens,
            }),
          prose,
          contexte,
        );
      }
    });
  }

  it("prose de plus de 200 000 points de code : refusée (longueur en points de code, pas en unités UTF-16)", () => {
    for (const p of V.prose_longue) {
      const prose = texte(p.recette) ?? "";
      expect(R.shouldAutoResumeContent({ finish: "length", content: prose, nativeOk: true })).toEqual(
        p.decision,
      );
    }
  });
});

describe("usage cumulé des segments (vecteurs Python, valeurs hostiles comprises)", () => {
  it("completion et total additionnés, le reste du dernier segment ; int() de Python, OverflowError propagée", () => {
    expect(V.fusions.length).toBeGreaterThan(400);
    for (const f of V.fusions) {
      const contexte = `${JSON.stringify(f.acc)} + ${JSON.stringify(f.seg)}`;
      const appel = (): unknown =>
        R.mergeSegmentUsage(
          decoder(f.acc) as Record<string, unknown>,
          decoder(f.seg) as Record<string, unknown>,
        );
      if ("erreur" in f) {
        expect(appel, contexte).toThrow();
        try {
          appel();
        } catch (e) {
          expect((e as Error).name, contexte).toBe(f.erreur);
        }
      } else {
        const obtenu = appel();
        expect(obtenu, contexte).toEqual(decoder(f.valeur));
        if (obtenu !== null && typeof obtenu === "object")
          expect(Object.keys(obtenu), contexte).toEqual(Object.keys(decoder(f.valeur) as object));
      }
    }
  });
});

describe("comportements des tests pytest", () => {
  it("clip : court inchangé, long = marqueur + suffixe de la longueur maximale", () => {
    expect(R.clipResumeThinking("abc")).toBe("abc");
    expect(R.clipResumeThinking("")).toBe("");
    const long = "x".repeat(R.MAX_RESUME_THINKING_CHARS + 500) + "FIN";
    const sortie = R.clipResumeThinking(long);
    expect(sortie.startsWith(R.RESUME_TRUNC_MARKER)).toBe(true);
    expect(sortie.endsWith("FIN")).toBe(true);
    expect(longueurPy(sortie)).toBe(longueurPy(R.RESUME_TRUNC_MARKER) + R.MAX_RESUME_THINKING_CHARS);
  });

  it("queue native : assistant terminal avec reasoning_content et drapeaux ; repli : réflexion close + consigne", () => {
    expect(R.buildResumeTail("raisonnement en cours", { native: true })).toEqual([
      [{ role: "assistant", content: "", reasoning_content: "raisonnement en cours" }],
      { continue_final_message: true, add_generation_prompt: false },
    ]);
    const [msgs, drapeaux] = R.buildResumeTail("raisonnement", { native: false });
    expect(drapeaux).toEqual({});
    expect(msgs[0]?.["content"]).toBe("<think>\nraisonnement\n</think>");
    expect(msgs[1]).toEqual({ role: "user", content: R.RESUME_AFTER_THINK_INSTRUCTION });
    expect(Object.keys(msgs[0] ?? {})).toEqual(["role", "content"]);
  });

  it("reprise du raisonnement : cas nominal, chaque garde, partiel de transport accepté", () => {
    const base = { finish: "length", content: "", thinking: "pensées…" };
    expect(R.shouldAutoResume(base)[0]).toBe(true);
    expect(R.shouldAutoResume({ ...base, finish: "stop" })).toEqual([false, "finish!=length"]);
    expect(R.shouldAutoResume({ ...base, content: "du texte visible" })[0]).toBe(false);
    expect(R.shouldAutoResume({ ...base, thinking: "   " })[0]).toBe(false);
    expect(R.shouldAutoResume({ ...base, hadToolCalls: true })[1]).toContain("tool_calls");
    const [ok, pourquoi] = R.shouldAutoResume({ ...base, partial: true });
    expect(ok).toBe(true);
    expect(pourquoi).toContain("coupure transport");
    expect(R.shouldAutoResume({ ...base, ctxSize: 10_000, windowTokens: 8_500 })[1]).toContain(
      "fenêtre d'inférence",
    );
    expect(R.shouldAutoResume({ ...base, ctxSize: 10_000, windowTokens: 5_500 })[0]).toBe(true);
    expect(
      R.shouldAutoResume({ ...base, ctxSize: 10_000, windowTokens: 6_000, thinkTokensDone: 3_500 })[0],
    ).toBe(true);
    expect(R.shouldAutoResume({ ...base, ctxSize: 4_096, windowTokens: 0, thinkTokensDone: 99_000 })[0]).toBe(
      true,
    );
  });

  it("plafonds : max 2, max 0 (désactivée), budget total de 1 000 tokens", async () => {
    const M = await avecPlafonds({ LLAMA_THINK_RESUME_MAX: 2, LLAMA_THINK_RESUME_TOTAL_TOKENS: 1000 });
    const base = { finish: "length", content: "", thinking: "pensées…" };
    expect(M.shouldAutoResume({ ...base, resumesDone: 2 })).toEqual([
      false,
      "plafond de reprises atteint (2/2)",
    ]);
    expect(M.shouldAutoResume({ ...base, resumesDone: 1 })[0]).toBe(true);
    expect(M.shouldAutoResume({ ...base, thinkTokensDone: 1000 })[1]).toContain("budget total");
    expect(M.shouldAutoResume({ ...base, thinkTokensDone: 999 })[0]).toBe(true);
    const Z = await avecPlafonds({ LLAMA_THINK_RESUME_MAX: 0 });
    expect(Z.shouldAutoResume(base)[1]).toContain("désactivée");
  });

  it("reprise de la prose : natif exigé, appels d'outil, fenêtre pleine, prose trop longue, plafond", () => {
    const base = { finish: "length", content: "Voici le début", nativeOk: true };
    expect(R.shouldAutoResumeContent({ ...base, nativeOk: false })[1]).toContain("natif");
    const [ok, pourquoi] = R.shouldAutoResumeContent(base);
    expect(ok).toBe(true);
    expect(pourquoi).toContain("1/");
    expect(R.shouldAutoResumeContent({ ...base, hadToolCalls: true })[1]).toContain("tool_calls");
    expect(R.shouldAutoResumeContent({ ...base, ctxSize: 8192, windowTokens: 8000 })[1]).toContain("fenêtre");
    expect(
      R.shouldAutoResumeContent({ ...base, content: "x".repeat(R.MAX_RESUME_CONTENT_CHARS + 1) })[1],
    ).toContain("trop longue");
    expect(R.shouldAutoResumeContent({ ...base, resumesDone: 4 })[0]).toBe(false);
    expect(R.buildContentResumeTail("début de réponse")).toEqual([
      [{ role: "assistant", content: "début de réponse" }],
      { continue_final_message: true, add_generation_prompt: false },
    ]);
  });

  it("usage : completion sommés, prompt = dernier segment ; acc vide = copie du segment ; segment vide = acc lui-même", () => {
    const acc = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const seg = { prompt_tokens: 160, completion_tokens: 30, total_tokens: 190 };
    expect(R.mergeSegmentUsage(acc, seg)).toEqual({
      prompt_tokens: 160,
      completion_tokens: 80,
      total_tokens: 340,
    });
    const seul = { prompt_tokens: 7, completion_tokens: 3 };
    const copie = R.mergeSegmentUsage({}, seul);
    expect(copie).toEqual(seul);
    expect(copie).not.toBe(seul);
    const garde = { completion_tokens: 5 };
    expect(R.mergeSegmentUsage(garde, {})).toBe(garde);
    expect(R.mergeSegmentUsage(null, {})).toBeNull();
  });

  it("un `__proto__` venu du serveur reste une clé ordinaire de l'usage cumulé", () => {
    const seg = JSON.parse('{"__proto__": {"x": 1}, "completion_tokens": 2}') as Record<string, unknown>;
    const r = R.mergeSegmentUsage({ completion_tokens: 1 }, seg);
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(Object.hasOwn(r, "__proto__")).toBe(true);
    expect(r["completion_tokens"]).toBe(3);
  });
});
