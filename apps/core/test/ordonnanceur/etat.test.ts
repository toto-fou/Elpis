// SPDX-License-Identifier: MIT
/** apps/core/test/ordonnanceur/etat.test.ts — widget de file, estimation des durées et mode : vecteurs Python. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ajouterDuree,
  construireEtat,
  DEFAULT_ESTIMATE_MS,
  estimerDuree,
  RECENT_LLM_DURATIONS_MAX,
  resoudreMode,
  sommePython,
} from "../../src/llm/ordonnanceur/etat";
import type { ModeOrdonnancement } from "../../src/llm/ordonnanceur/etat";

type Nombre = number | "inf" | "-inf" | "nan";
type EntreeStatut = {
  model: string;
  excl_model: string | null;
  excl_count: number;
  statuts: [string, string][] | null;
  charge_connu: string | null;
  actifs: number;
  en_attente: number;
  plein: boolean;
  durees: number[];
  chargement_ms: number | null;
};
type Vecteurs = {
  defaut_ms: number;
  fenetre: number;
  estimations: { durees: Nombre[]; estimation: number }[];
  statuts: { entree: EntreeStatut; sortie: Record<string, unknown> }[];
  modes: { valeur: unknown; recommande: ModeOrdonnancement; mode: ModeOrdonnancement }[];
};

const vecteurs = JSON.parse(
  readFileSync(new URL("../vecteurs/ordonnanceur_etat.json", import.meta.url), "utf-8"),
) as Vecteurs;
const nombre = (n: Nombre): number =>
  n === "inf" ? Infinity : n === "-inf" ? -Infinity : n === "nan" ? Number.NaN : n;

describe("estimation des durées (vecteurs Python)", () => {
  it("mêmes constantes que _queue.py", () => {
    expect([DEFAULT_ESTIMATE_MS, RECENT_LLM_DURATIONS_MAX]).toEqual([vecteurs.defaut_ms, vecteurs.fenetre]);
  });

  for (const [i, cas] of vecteurs.estimations.entries()) {
    it(`${i} ${JSON.stringify(cas.durees).slice(0, 80)}`, () => {
      const fenetres = new Map<string, number[]>();
      for (const d of cas.durees) ajouterDuree(fenetres, "m", nombre(d));
      expect(estimerDuree(fenetres.get("m") ?? [])).toBe(cas.estimation);
    });
  }

  it("la somme compense comme sum() de Python ≥ 3.12", () => {
    expect(sommePython([1e16, 1, 1])).toBe(1.0000000000000002e16);
    expect(sommePython([])).toBe(0);
  });
});

describe("état du widget (vecteurs Python de get_queue_status_for_async)", () => {
  it("couvre les cas générés", () => expect(vecteurs.statuts.length).toBeGreaterThan(250));

  for (const [i, { entree: e, sortie }] of vecteurs.statuts.entries()) {
    it(`${i} ${e.model} excl=${String(e.excl_model)}/${e.excl_count} statuts=${JSON.stringify(e.statuts)}`, () => {
      const etat = construireEtat({
        model: e.model,
        exclModel: e.excl_model,
        exclCount: e.excl_count,
        statuts: e.statuts ? new Map(e.statuts) : null,
        chargeConnu: e.charge_connu,
        actifs: e.actifs,
        enAttente: e.en_attente,
        plein: e.plein,
        dureeUnitaire: estimerDuree(e.durees.slice(-RECENT_LLM_DURATIONS_MAX)),
        dureeChargement: e.chargement_ms ?? DEFAULT_ESTIMATE_MS,
      });
      expect(etat).toEqual(sortie);
    });
  }
});

describe("mode d'ordonnancement (vecteurs Python de resolve_scheduling_mode)", () => {
  for (const [i, cas] of vecteurs.modes.entries()) {
    it(`${i} ${JSON.stringify(cas.valeur)} / ${cas.recommande}`, () => {
      expect(resoudreMode(cas.valeur, cas.recommande)).toBe(cas.mode);
    });
  }

  it("valeur absente : le mode recommandé", () => {
    expect(resoudreMode(undefined, "optimized")).toBe("optimized");
  });
});
