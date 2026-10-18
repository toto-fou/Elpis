// SPDX-License-Identifier: MIT
/** packages/config/src/contexte.ts — `context_config.json` partagé par le core et l'hôte d'outils : chemin résolu, outils éteints (`tools.<nom>.enabled=false`) et ratio chars/token du repli. */
import path from "node:path";

import { estDict, exigerDict, lire, ouPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { asStr, deepGet, readJsonFile, resolveRel } from "./brut";
import { config } from "./instance";

const DEFAUT_CHEMIN = "shared_infra/context_config.json";

/** Ratio chars/token du repli, défini ici seulement : le compteur (`apps/core/src/contexte/tokens.ts`) et le débord du shell de l'hôte le partagent. */
export const CHARS_PER_TOKEN = 3.3;

/** env `APP_CONTEXT_CONFIG` > `app.context_config_path` de `shared_infra/config.json` > défaut, sous la racine du dépôt. */
export function cheminContextConfig(env: NodeJS.ProcessEnv = process.env): string {
  return resolveRel(
    asStr(
      env["APP_CONTEXT_CONFIG"],
      asStr(
        deepGet(
          readJsonFile(path.join(config.PROJECT_ROOT, "shared_infra", "config.json")),
          "app.context_config_path",
          DEFAUT_CHEMIN,
        ),
        DEFAUT_CHEMIN,
      ),
    ),
    config.PROJECT_ROOT,
  );
}

/** `disabled_tools` : noms marqués `tools.<nom>.enabled: false` ; `tools` non dict : TypeError comme Python. */
export function outilsEteints(raw: Dict): Set<string> {
  const outils = exigerDict(ouPy(deepGet(raw, "tools", {}), {}));
  return new Set(
    Object.entries(outils)
      .filter(([, v]) => estDict(v) && lire(v, "enabled") === false)
      .map(([nom]) => nom),
  );
}
