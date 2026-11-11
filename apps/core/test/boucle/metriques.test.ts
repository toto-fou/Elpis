// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/metriques.test.ts — métriques d'un appel LLM (vecteurs Python : débits, réflexion ⊆ sortie, passe-plats, entrées hostiles). */
import "../moteur-environnement";

import { describe, expect, it } from "vitest";

import { config } from "@elpis/config";

import { calculateMetrics } from "../../src/boucle/metriques";
import type { Dict } from "../../src/python";
import { decoder, lireVecteurs } from "../vecteurs-moteur";

interface Vecteurs {
  modele_defaut: string;
  cas: ({ meta: unknown; duree: number } & ({ valeur: unknown } | { erreur: string }))[];
}

const V = lireVecteurs<Vecteurs>("boucle-metriques");

describe("vecteurs Python de calculate_metrics", () => {
  it("même modèle par défaut que la config Python", () => {
    expect(config.LLAMA_MODEL).toBe(V.modele_defaut);
  });

  it("mêmes métriques, ou même exception (TypeError, ValueError, OverflowError, ZeroDivisionError, AttributeError)", () => {
    expect(V.cas.length).toBeGreaterThan(500);
    for (const c of V.cas) {
      const contexte = `${JSON.stringify(c.meta)} / ${c.duree}`;
      const appel = (): Dict => calculateMetrics(decoder(c.meta) as Dict, c.duree);
      if ("erreur" in c) {
        let nom = "aucune";
        try {
          appel();
        } catch (e) {
          nom = (e as Error).name;
        }
        expect(nom, contexte).toBe(c.erreur);
      } else {
        const obtenu = appel();
        expect(obtenu, contexte).toEqual(decoder(c.valeur));
        expect(Object.keys(obtenu), contexte).toEqual(Object.keys(decoder(c.valeur) as object));
      }
    }
  });
});

describe("comportements des tests pytest", () => {
  it("la sortie se décompose en réflexion et réponse, l'entrée ne bouge pas", () => {
    const m = calculateMetrics(
      {
        usage: { prompt_tokens: 1000, completion_tokens: 800 },
        thinking_tokens: 600,
        thinking_tokens_estimated: true,
      },
      1.0,
    );
    expect([m["output_tokens"], m["thinking_tokens"], m["response_tokens"], m["input_tokens"]]).toEqual([
      800, 600, 200, 1000,
    ]);
    expect(m["thinking_tokens_estimated"]).toBe(true);
  });

  it("sans mesure : toute la sortie est de la réponse ; une mesure aberrante est bornée par la sortie", () => {
    const sans = calculateMetrics({ usage: { prompt_tokens: 10, completion_tokens: 90 } }, 1.0);
    expect([sans["thinking_tokens"], sans["response_tokens"], sans["thinking_tokens_estimated"]]).toEqual([
      0,
      90,
      false,
    ]);
    const borne = calculateMetrics(
      { usage: { prompt_tokens: 10, completion_tokens: 40 }, thinking_tokens: 999 },
      1.0,
    );
    expect([borne["thinking_tokens"], borne["response_tokens"]]).toEqual([40, 0]);
  });

  it("le raisonnement déclaré par le backend est repris quand personne ne l'a mesuré", () => {
    const m = calculateMetrics(
      {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 200,
          completion_tokens_details: { reasoning_tokens: 150 },
        },
      },
      1.0,
    );
    expect([m["thinking_tokens"], m["response_tokens"], m["thinking_tokens_estimated"]]).toEqual([
      150,
      50,
      false,
    ]);
  });

  it("une réponse coupée garde `truncated` (bouton Continuer) ; la part outils de l'entrée passe", () => {
    expect(calculateMetrics({ finish_reason: "length", truncated: true }, 0.0)["truncated"]).toBe(true);
    const m = calculateMetrics(
      { usage: { prompt_tokens: 5000, completion_tokens: 10, tool_input_tokens: 1200 } },
      1.0,
    );
    expect(m["tool_input_tokens"]).toBe(1200);
  });

  it("une clé à `undefined` vaut une clé absente (modèle par défaut, raisonnement natif, pas de budget)", () => {
    const usage = {
      prompt_tokens: 10,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 7 },
    };
    const avec = calculateMetrics(
      {
        usage: { ...usage, tool_input_tokens: undefined },
        timings: { prompt_per_token_ms: undefined, prompt_ms: 100, prompt_n: 10 },
        thinking_tokens: undefined,
        model: undefined,
        thinking_budget_effective: undefined,
        think_resumes: undefined,
      },
      1.0,
    );
    const sans = calculateMetrics({ usage, timings: { prompt_ms: 100, prompt_n: 10 } }, 1.0);
    expect(avec).toEqual(sans);
    expect([avec["thinking_tokens"], avec["model"], avec["read_tps"]]).toEqual([7, config.LLAMA_MODEL, 100]);
    expect(calculateMetrics({ usage: undefined, timings: undefined }, 0)).toEqual(calculateMetrics({}, 0));
  });

  it("débit d'écriture de repli : sortie / durée quand le serveur ne donne pas de timings", () => {
    const m = calculateMetrics({ usage: { completion_tokens: 10 }, timings: {} }, 4.0);
    expect(m["write_tps"]).toBe(2.5);
    expect(m["model"]).toBe(config.LLAMA_MODEL);
  });
});
