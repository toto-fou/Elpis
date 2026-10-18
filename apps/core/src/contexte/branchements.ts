// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/branchements.ts — ports du contexte posés au démarrage : profil réseau du compte, mémoire AX des sites, compte et index des sessions du compresseur. */
import { getUser, getUserSettings } from "@elpis/auth";
import { chargerConfigBac, profilParId } from "@elpis/bac";
import type { Base, Executeur } from "@elpis/db";
import { detectSessionUrl, detectSitesFromText, normalizeUrl, renderSiteContextual } from "@elpis/navigateur";

import { sessionIndexMessages } from "../memoire/sessions";
import { recordTurnUsage, usageScope } from "../observabilite/usage-contexte";
import { resolveNetworkProfileId } from "../relais/identite";
import { installerMemoireAx, installerPortCompresseur, installerProfilReseau } from "./ports";
import type { PortCompresseur, PortMemoireAx, PortProfilReseau } from "./ports";

/** `_network_status_line` : profil du compte (« isolated » s'il est inconnu) et mode du profil appliqué. */
export function profilReseauDuProcess(base: Executeur): PortProfilReseau {
  return {
    async profilReseau(username) {
      const ligne = await getUser(base, username);
      const id =
        ligne === undefined
          ? "isolated"
          : resolveNetworkProfileId(await getUserSettings(base, Number(ligne.id)));
      return { id, mode: profilParId(chargerConfigBac(), id).mode };
    },
  };
}

export function memoireAxDuProcess(base: Executeur): PortMemoireAx {
  return {
    detectSitesFromText,
    detectSessionUrl: (messages, owner) => detectSessionUrl(messages, owner),
    normalizeUrl,
    renderSiteContextual: (site, o) =>
      renderSiteContextual(base, site, {
        currentPath: o.currentPath,
        iteration: o.iteration,
        owner: o.owner,
      }),
  };
}

/** Compresseur du process ; l'endpoint dédié verse son tour au registre d'usage sous la source « compression ». */
export function compresseurDuProcess(base: Base): PortCompresseur {
  return {
    async userIdParNom(username) {
      const ligne = await getUser(base, username);
      return ligne === undefined ? null : Number(ligne.id);
    },
    sessionIndexMessages: (rows) => sessionIndexMessages(base, rows),
    recordTurnUsage: (usage, o) =>
      void usageScope("compression", {}, () =>
        recordTurnUsage(base, {
          usage,
          model: o.model,
          path: o.path,
          durationMs: o.durationMs,
          iterations: o.iterations,
        }),
      ),
  };
}

export function brancherContexte(base: Base): void {
  installerProfilReseau(profilReseauDuProcess(base));
  installerMemoireAx(memoireAxDuProcess(base));
  installerPortCompresseur(compresseurDuProcess(base));
}
