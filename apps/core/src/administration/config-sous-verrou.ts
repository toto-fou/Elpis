// SPDX-License-Identifier: MIT
/** apps/core/src/administration/config-sous-verrou.ts — lire-modifier-écrire de config.json par la console, sous `config.json.lock` (le Python écrivait sans verrou). */
import { estDict, HttpError, lireTextePy, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, sousVerrouConfigJson, writeConfigJson } from "@elpis/config";

import { existePy } from "../apparence/skins";

/** `read_config_json()` relu sur disque comme `json.load` (`2.0` reste un flottant) ; absent ou illisible : `{}`. */
export function lireConfigJson(): Dict {
  try {
    const chemin = config.CONFIG_JSON_PATH;
    if (!existePy(chemin)) return {};
    const donnees = pyJsonLoads(lireTextePy(chemin));
    return estDict(donnees) ? donnees : {};
  } catch {
    return {};
  }
}

/** Config à réécrire : absente = `{}`, illisible = refus (le Python repartait de `{}` et effaçait le reste du fichier). */
function configAReecrire(): Dict {
  const chemin = config.CONFIG_JSON_PATH;
  if (!existePy(chemin)) return {};
  let donnees: unknown;
  try {
    donnees = pyJsonLoads(lireTextePy(chemin));
  } catch {
    throw new HttpError(500, "config.json est illisible : corrigez-le avant d'enregistrer.");
  }
  return estDict(donnees) ? donnees : {};
}

/** `cfg = read_config_json()` relu sous le verrou, muté, puis `write_config_json(cfg)` ; une exception du mutateur n'écrit rien. */
export async function modifierConfigJson(muter: (cfg: Dict) => void): Promise<void> {
  await sousVerrouConfigJson(() => {
    const cfg = configAReecrire();
    muter(cfg);
    writeConfigJson(cfg);
  });
}
