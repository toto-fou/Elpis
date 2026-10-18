// SPDX-License-Identifier: MIT
/** packages/config/src/instance.ts — réglages du process : objet `config` mutable, calculé au premier import. */
import path from "node:path";

import { copieProfondePy } from "@elpis/commun";

import { gelerProfond, readJsonFile, realpathPy, resolveConfigJsonPath } from "./brut";
import type { Dict } from "./brut";
import { calculerReglages, propagerEnv } from "./reglages";
import type { Reglages } from "./reglages";

/** Racine du dépôt : `ELPIS_RACINE`, sinon trois niveaux au-dessus de ce fichier (`packages/config/src`). */
export function racineDepot(): string {
  return realpathPy(process.env["ELPIS_RACINE"] || path.resolve(import.meta.dirname, "..", "..", ".."));
}

function calculerDepuisProcessus(): { reglages: Reglages; brut: Dict } {
  const racine = racineDepot();
  const cheminConfig = resolveConfigJsonPath(process.env, racine);
  const brut = readJsonFile(cheminConfig);
  const { reglages } = calculerReglages(process.env, brut, racine, cheminConfig);
  propagerEnv(process.env, reglages);
  return { reglages, brut };
}

const initial = calculerDepuisProcessus();

export const config: Reglages = initial.reglages;

let brutDemarrage: Readonly<Dict> = gelerProfond(copieProfondePy(initial.brut));

/** config.json tel que lu au démarrage (le `_RAW` de Python), gelé. */
export function bootRaw(): Readonly<Dict> {
  return brutDemarrage;
}

/** Recalcule tous les réglages depuis l'env et le disque, dans le même objet `config`. */
export function remplacerConfig(): void {
  const nouveau = calculerDepuisProcessus();
  Object.assign(config, nouveau.reglages);
  brutDemarrage = gelerProfond(copieProfondePy(nouveau.brut));
}
