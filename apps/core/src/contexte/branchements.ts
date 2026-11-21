// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/branchements.ts — ports du contexte posés au démarrage : profil réseau du compte, mémoire AX des sites, compte et index des sessions du compresseur. */
import { getUser, getUserSettings } from "@elpis/auth";
import { chargerConfigBac, profilFiltre, profilParId } from "@elpis/bac";
import { estDict } from "@elpis/commun";
import type { Base, Executeur } from "@elpis/db";
import { detectSessionUrl, detectSitesFromText, normalizeUrl, renderSiteContextual } from "@elpis/navigateur";
import type { LireUrlSession } from "@elpis/navigateur";

import { appelerHote } from "../admin/pilote-bac";
import { sessionIndexMessages } from "../memoire/sessions";
import { recordTurnUsage, usageScope } from "../observabilite/usage-contexte";
import { sandboxHostFor } from "../relais/hotes";
import { resolveNetworkProfileId } from "../relais/identite";
import { installerMemoireAx, installerPortCompresseur, installerProfilReseau } from "./ports";
import type { PortCompresseur, PortMemoireAx, PortProfilReseau } from "./ports";

/** `_network_status_line` : profil du compte (« isolated » s'il est inconnu), mode du profil appliqué et filtre de son conteneur. */
export function profilReseauDuProcess(base: Executeur): PortProfilReseau {
  return {
    async profilReseau(username) {
      const ligne = await getUser(base, username);
      const id =
        ligne === undefined
          ? "isolated"
          : resolveNetworkProfileId(await getUserSettings(base, Number(ligne.id)));
      const profil = profilParId(chargerConfigBac(), id);
      return { id, mode: profil.mode, filtre: profilFiltre(profil) };
    },
  };
}

/** Lecteur d'URL de session : l'hôte d'outils du compte `owner` la lit au service de son bac (2 s) ; `null` sans compte, sans hôte ou en cas de refus. */
function urlDeSessionParHote(base: Executeur, owner: string): LireUrlSession {
  return async (sessionId) => {
    const ligne = await getUser(base, owner);
    if (ligne === undefined) return null;
    const uid = Number(ligne.id);
    const hote = await sandboxHostFor(uid, false);
    if (hote === null) return null;
    const r = await appelerHote(hote, uid, owner, "POST", "/api/internal/browser/session-url", {
      json: { session_id: sessionId },
      delaiS: 3,
    });
    const u = estDict(r) ? r["url"] : null;
    return typeof u === "string" && u ? u : null;
  };
}

export function memoireAxDuProcess(base: Executeur): PortMemoireAx {
  return {
    detectSitesFromText,
    detectSessionUrl: (messages, owner) =>
      detectSessionUrl(messages, owner, urlDeSessionParHote(base, owner)),
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
