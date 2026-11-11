// SPDX-License-Identifier: MIT
/** apps/core/test/ordonnanceur/proprietes.test.ts — scénarios aléatoires à graine fixée : invariants de `LLMQueue`. */
import { describe, expect, it } from "vitest";

import type { LLMQueue } from "../../src/llm/ordonnanceur/file";
import { rejouer } from "./scenario";
import type { Demande, Entrees, Etape, PolitiquePy } from "./scenario";

/** mulberry32 : suite pseudo-aléatoire reproductible. */
function aleatoire(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Serveurs, demandes (sous-agents compris), abandons et politiques relevées à chaud (jamais abaissées : le plafond reste un invariant). */
function scenario(graine: number): Entrees {
  const r = aleatoire(graine);
  const entier = (a: number, b: number): number => a + Math.floor(r() * (b - a + 1));
  const choix = <T>(xs: T[], defaut: T): T => xs[Math.floor(r() * xs.length)] ?? defaut;
  const serveurs: Record<string, Required<PolitiquePy>> = {};
  for (const s of ["A", "B"].slice(0, entier(1, 2)))
    serveurs[s] = { max_models: entier(1, 2), max_concurrency: entier(1, 3) };
  const simple = (): Etape => (r() < 0.6 ? { generer: entier(1, 6) } : { outil: entier(1, 5) });
  const enfant = () => ({
    modele: choix(["m1", "m2", "m3"], "m1"),
    priorite: r() < 0.6 ? ("high" as const) : ("low" as const),
    etapes: Array.from({ length: entier(1, 3) }, simple),
  });
  const etape = (): Etape =>
    r() < 0.08
      ? { echec_transport: true }
      : r() < 0.15
        ? { enfants: Array.from({ length: entier(1, 3) }, enfant) }
        : simple();
  const demandes: Demande[] = Array.from({ length: entier(3, 14) }, (_, i) => ({
    id: `D${i}`,
    arrivee: entier(0, 60) / 2,
    serveur: choix(Object.keys(serveurs), "A"),
    modele: choix(["m1", "m2", "m3"], "m1"),
    priorite: r() < 0.6 ? "high" : "low",
    etapes: Array.from({ length: entier(1, 4) }, etape),
  }));
  const actions: NonNullable<Entrees["actions"]> = [];
  for (let k = entier(0, 3); k > 0; k -= 1)
    actions.push({
      a: entier(0, 80) / 2,
      annuler: choix(
        demandes.map((d) => d.id),
        "D0",
      ),
    });
  const courantes = structuredClone(serveurs);
  for (let [k, a] = [entier(0, 2), 0]; k > 0; k -= 1) {
    const s = choix(Object.keys(courantes), "A");
    const p = courantes[s];
    if (!p) continue;
    a += entier(1, 20);
    p.max_models += entier(0, 1);
    p.max_concurrency += 1;
    actions.push({ a, politique: { [s]: { ...p } } });
  }
  return { harnais: "ordonnanceur", serveurs, mode: r() < 0.5 ? "classic" : "optimized", demandes, actions };
}

describe("propriétés de LLMQueue sur 400 scénarios aléatoires", () => {
  it("≤ max_models modèles, ≤ plafond créneaux, toute demande finit, file vide à la fin", async () => {
    for (let graine = 1; graine <= 400; graine += 1) {
      const entrees = scenario(graine);
      const violations: string[] = [];
      let file: LLMQueue | undefined;
      const res = await rejouer(entrees, (q, t, politiques) => {
        file = q;
        for (const [s, p] of Object.entries(politiques)) {
          const stats = q.stats(s);
          if (stats.active_models.length > (p.max_models ?? 1))
            violations.push(`t=${t} ${s} : trop de modèles`);
          for (const m of stats.active_models)
            if (m.shared_busy > (p.max_concurrency ?? 1))
              violations.push(`t=${t} ${s}/${m.model} : trop de créneaux`);
        }
      });
      const contexte = `graine ${graine} : ${JSON.stringify(entrees)}`;
      expect(violations, contexte).toEqual([]);
      expect(res.finies.size, contexte).toBe(entrees.demandes.length);
      for (const s of Object.keys(entrees.serveurs)) {
        expect(file?.stats(s).active_models, contexte).toEqual([]);
        expect(file?.stats(s).slot_waiters, contexte).toEqual([]);
      }
    }
  });
});
