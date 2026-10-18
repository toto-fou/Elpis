// SPDX-License-Identifier: MIT
/** packages/auth/src/defaut.ts — dépendances de production : réglages et config.json relus à chaud par @elpis/config. */
import { config, configView, sessionCookieAttrs } from "@elpis/config";
import { stripPy } from "@elpis/commun";
import type { Base } from "@elpis/db";

import type { DependancesAuth } from "./garde";
import type { DependancesJetons } from "./jetons";
import { revoquerOauthDuCompte } from "./oauth";

/** Attributs du cookie figés à l'appel (démarrage) ; `jetonService` : LOCAL_MCP_TOKEN seul par défaut, `composer` y branche le jeton du manifeste. */
export function dependancesParDefaut(
  base: Base,
  jetonService: () => string = () => stripPy(config.LOCAL_MCP_TOKEN),
): DependancesAuth & DependancesJetons {
  const attributs = sessionCookieAttrs();
  return {
    base,
    config: () => configView(),
    attributsCookie: () => attributs,
    secret: () => config.SESSION_SECRET,
    jetonService,
    revoquerOauth: (uid) => revoquerOauthDuCompte(base, uid, Date.now() / 1000),
  };
}
