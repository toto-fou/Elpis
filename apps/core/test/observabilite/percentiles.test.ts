// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/percentiles.test.ts — percentiles calculés dans la base : mêmes valeurs que le tri complet d'origine, ex aequo, fenêtre, valeurs nulles ou négatives. */
import "../moteur-environnement";

import { arrondiPy, FlottantPy } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { maintenant, percentileMetric, percentilesMetric } from "../../src/observabilite/fournisseurs/base";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const PS = [0, 1, 50, 75, 95, 99, 100];

/** Algorithme d'origine : toutes les valeurs de la fenêtre triées, rang `floor(n × p / 100)`. */
function reference(valeurs: readonly number[], p: number, positifs: boolean): number {
  const v = valeurs.filter((x) => !positifs || x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const i = Math.max(0, Math.min(v.length - 1, Math.trunc((v.length * p) / 100)));
  return arrondiPy(v[i] as number, 2);
}

const nombre = (x: number | FlottantPy): number => (x instanceof FlottantPy ? x.valeur : x);

describe.each(MOTEURS)("percentiles (%s)", (moteur) => {
  let t: BaseDeTest;
  const dansLaFenetre: number[] = [];

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    const t0 = maintenant();
    let graine = 7;
    const hasard = (): number => ((graine = (graine * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 40 - 5;
    const lignes: [string, number, number][] = [];
    for (let i = 0; i < 997; i++) {
      const v = i % 13 === 0 ? 0 : i % 17 === 0 ? 2.5 : Math.round(hasard() * 1000) / 1000;
      dansLaFenetre.push(v);
      lignes.push(["llm_latency", v, t0 - 60 - i]);
    }
    for (let i = 0; i < 50; i++) lignes.push(["llm_latency", 999, t0 - 48 * 3600 - i]);
    for (let i = 0; i < 50; i++) lignes.push(["autre", -1, t0 - 60]);
    for (const [type, v, quand] of lignes)
      await t.base.run(
        "INSERT INTO metric_events(event_type, value, tags_json, created_at) VALUES (?,?,?,?)",
        [type, v, null, quand],
      );
  });

  afterAll(async () => {
    await t.fermer();
  });

  it.each([true, false])("positifs seulement = %s : identique au tri complet", async (positifs) => {
    const obtenus = (await percentilesMetric(t.base, "llm_latency", 24, PS, positifs)).map(nombre);
    expect(obtenus).toEqual(PS.map((p) => reference(dansLaFenetre, p, positifs)));
    for (const p of [50, 95])
      expect(nombre(await percentileMetric(t.base, "llm_latency", 24, p, positifs))).toBe(
        reference(dansLaFenetre, p, positifs),
      );
  });

  it("une seule instruction par appel : rang et effectif viennent du même instantané", async () => {
    const espion = vi.spyOn(t.base, "valeurs");
    try {
      await percentilesMetric(t.base, "llm_latency", 24, PS);
      expect(espion).toHaveBeenCalledTimes(1);
    } finally {
      espion.mockRestore();
    }
  });

  it("fenêtre vide ou type absent : 0 pour chaque percentile", async () => {
    expect(await percentilesMetric(t.base, "inconnu", 24, [50, 99])).toEqual([0, 0]);
    expect(await percentileMetric(t.base, "autre", 24, 50)).toBe(0);
  });
});
