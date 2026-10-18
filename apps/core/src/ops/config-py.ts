// SPDX-License-Identifier: MIT
/** apps/core/src/ops/config-py.ts — config.json relu en valeurs Python pour un lire-modifier-écrire (`1.0` jamais réécrit `1`), illisible refusé (E36). */
import type { Dict } from "@elpis/commun";

import { lireConfigPourEcrire } from "../admin/aides";

/** `read_config_json()` à réécrire : relu sur disque sous le verrou de config.json ; illisible = 500, jamais une config vide réécrite. */
export function lireConfigPy(): Dict {
  return lireConfigPourEcrire();
}
