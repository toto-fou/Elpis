// SPDX-License-Identifier: MIT
/** apps/core/test/ordonnanceur/goldens.test.ts — rejoue les goldens `ordonnanceur_*.json` du Python (v9 §7 bis) sur `LLMQueue`. */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { rejouer } from "./scenario";
import type { Entrees, Sorties } from "./scenario";

const DOSSIER = new URL("../../../../tests/goldens/", import.meta.url);
/** Écarts définitifs au Python : `AbortSignal` sur-le-champ (sonde de 0,25 s : seul visible ici), réveils exacts du portail (sondes de 1 s), `max_models` > 1 appliqué (E12), `LLM_GRACE_SOURCE` ignoré, `record_model_load_duration` non porté. */
const ECARTS: Record<string, Record<string, string>> = {
  "ordonnanceur_annulation.json": { "t=3.25 H2 abandon": "t=3.1 H2 abandon" },
};
const fichiers = readdirSync(DOSSIER)
  .filter((f) => /^ordonnanceur_.+\.json$/.test(f))
  .sort();

describe("goldens de l'ordonnanceur (v9 §7 bis), rejoués sur LLMQueue", () => {
  it("les neuf scénarios sont présents", () => expect(fichiers).toHaveLength(9));

  for (const fichier of fichiers) {
    it(`${fichier} : mêmes événements aux mêmes instants, mêmes instantanés`, async () => {
      const golden = JSON.parse(readFileSync(new URL(fichier, DOSSIER), "utf-8")) as Sorties & {
        entrees: Entrees;
      };
      const obtenu = await rejouer(golden.entrees);
      expect(obtenu.ordre).toEqual(golden.ordre.map((e) => ECARTS[fichier]?.[e] ?? e));
      expect(obtenu.instantanes).toEqual(golden.instantanes);
    });
  }
});
