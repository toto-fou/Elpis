// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/usage-requete.test.ts — usage d'une requête coupée tel que le moteur l'a rapporté (usage, timings par jeton, préremplissage ; rien : zéro, jamais d'estimation) et usage cumulé publié par le run. */
import "../moteur-environnement";

import { describe, expect, it } from "vitest";

import { RunRecord } from "../../src/boucle/run";
import { usageRequeteCoupee } from "../../src/boucle/usage-requete";
import type { UsageRun } from "../../src/boucle/usage-requete";
import { consoFinale } from "../../src/outils/integres/task/evenements";

describe("usage d'une requête coupée", () => {
  it("usage rapporté par le moteur : pris tel quel, cache borné à l'entrée", () => {
    const u = usageRequeteCoupee({
      usage: { prompt_tokens: 500, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 450 } },
      timings: { prompt_n: 1, predicted_n: 1 },
      progression: {},
    });
    expect(u).toEqual({ entree: 500, sortie: 40, cache: 450 });
  });

  it("timings par jeton de llama.cpp : préremplissage + cache en entrée, jetons générés en sortie", () => {
    const u = usageRequeteCoupee({
      usage: {},
      timings: { prompt_n: 120, cache_n: 3000, predicted_n: 77 },
      progression: {},
    });
    expect(u).toEqual({ entree: 3120, sortie: 77, cache: 3000 });
  });

  it("coupée pendant le préremplissage : la progression donne l'entrée traitée", () => {
    const u = usageRequeteCoupee({
      usage: {},
      timings: {},
      progression: { total: 8000, cache: 2000, processed: 5000 },
    });
    expect(u).toEqual({ entree: 5000, sortie: 0, cache: 2000 });
  });

  it("rien de rapporté (vLLM, SGLang, autre moteur) : zéro, aucune estimation", () => {
    expect(usageRequeteCoupee(null)).toEqual({ entree: 0, sortie: 0, cache: 0 });
    expect(usageRequeteCoupee({ usage: {}, timings: {}, progression: {} })).toEqual({
      entree: 0,
      sortie: 0,
      cache: 0,
    });
  });
});

describe("usage cumulé publié par le run", () => {
  it("requêtes abouties puis coupées : cumul des deux, rien de rapporté ignoré, métriques du moteur intactes", () => {
    const vus: UsageRun[] = [];
    const rec = new RunRecord();
    rec.usageAcc = {};
    rec.surUsage = (u) => void vus.push(u);
    rec.cumulIn = 1000;
    rec.cumulOut = 50;
    rec.cumulCacheRead = 800;
    rec.usageNote({ effectiveIter: 1, model: "m" });
    rec.noterCoupee({ entree: 1200, sortie: 30, cache: 1000 });
    rec.noterCoupee({ entree: 0, sortie: 0, cache: 0 });
    rec.noterCoupee({ entree: 1300, sortie: 5, cache: 0 });
    expect(vus).toHaveLength(3);
    expect(vus[0]).toEqual({ entree: 1000, sortie: 50, cache: 800, reflexion: 0 });
    expect(vus.at(-1)).toEqual({ entree: 3500, sortie: 85, cache: 1800, reflexion: 0 });
    expect([rec.cumulIn, rec.cumulOut]).toEqual([1000, 50]);
  });

  it("réflexion : seulement si le moteur la compte, jamais estimée sur le texte gardé ; un observateur qui lève est tu", () => {
    const vus: UsageRun[] = [];
    const rec = new RunRecord();
    rec.surUsage = (u) => void vus.push(u);
    rec.allThinking = ["x".repeat(330)];
    rec.publierUsage();
    rec.cumulReasoning = 7;
    rec.publierUsage();
    expect(vus.map((u) => u.reflexion)).toEqual([0, 7]);
    rec.surUsage = () => {
      throw new Error("observateur en panne");
    };
    expect(() => rec.publierUsage()).not.toThrow();
  });
});

describe("consommation finale d'un sous-agent", () => {
  it("réflexion des métriques gardée seulement si le moteur l'a comptée, jamais l'estimation", () => {
    const u: UsageRun = { entree: 10, sortie: 5, cache: 0, reflexion: 0 };
    const m = { input_tokens: 20, output_tokens: 8, thinking_tokens: 3 };
    expect(consoFinale(m, u)).toEqual({
      input_tokens: 20,
      output_tokens: 8,
      cache_tokens: 0,
      think_tokens: 3,
    });
    expect(consoFinale({ ...m, thinking_tokens_estimated: true }, u).think_tokens).toBe(0);
    expect(consoFinale({ ...m, thinking_tokens_estimated: true }, { ...u, reflexion: 2 }).think_tokens).toBe(
      2,
    );
  });
});
