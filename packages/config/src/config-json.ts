// SPDX-License-Identifier: MIT
/** packages/config/src/config-json.ts — lire-modifier-écrire de config.json sous `config.json.lock` (elpis.verrou.v1.1), relecture sur disque. */
import { ErreurJsonPy, estDict, estErreurValeur, existePy, lireTextePy, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { avecVerrou, cheminVerrou } from "@elpis/verrous";

import { config } from "./instance";
import { writeConfigJson } from "./vivant";

/** Exclusion inter-process du lire-modifier-écrire de config.json : `config.json.lock` au protocole elpis.verrou.v1.1. */
export async function sousVerrouConfigJson<T>(f: () => T | Promise<T>): Promise<T> {
  return avecVerrou(cheminVerrou(config.CONFIG_JSON_PATH), {}, async () => f());
}

/** `_update_config` : config.json relu sur disque, modifié puis réécrit (atomique) sous le verrou ; JSON illisible : `illisible(message)` levée. */
export async function mettreAJourConfigJson(
  mutateur: (cfg: Dict) => void,
  illisible: (message: string) => Error,
): Promise<void> {
  await sousVerrouConfigJson(() => {
    const chemin = config.CONFIG_JSON_PATH;
    let disque: unknown = {};
    if (existePy(chemin)) {
      const texte = lireTextePy(chemin) || "{}";
      try {
        disque = pyJsonLoads(texte);
      } catch (e) {
        if (e instanceof ErreurJsonPy)
          throw illisible("config.json est illisible : corrigez-le avant d'enregistrer.");
        throw e;
      }
      if (!estDict(disque)) disque = {};
    }
    mutateur(disque as Dict);
    writeConfigJson(disque as Dict);
  });
}

/** config.json relu sur disque (à appeler sous `sousVerrouConfigJson`) : absent = `{}`, JSON ou UTF-8 illisible = `null`, autre chose qu'un objet = `{}`. */
export function lireConfigDisque(): Dict | null {
  const chemin = config.CONFIG_JSON_PATH;
  if (!existePy(chemin)) return {};
  let valeur: unknown;
  try {
    valeur = pyJsonLoads(lireTextePy(chemin) || "{}");
  } catch (e) {
    if (estErreurValeur(e)) return null;
    throw e;
  }
  return estDict(valeur) ? valeur : {};
}

export const CONFIG_ILLISIBLE = "config.json est illisible : corrigez-le avant d'enregistrer.";
