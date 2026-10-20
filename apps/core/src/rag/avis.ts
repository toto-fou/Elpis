// SPDX-License-Identifier: MIT
/** apps/core/src/rag/avis.ts — avis aux lecteurs d'une collection publiée dont le compte auteur est supprimé : une notification par lecteur et par collection. */
import type { Base } from "@elpis/db";

import { journal } from "../journal";
import { pousserNotification } from "../notifications/envoi";
import { audiencePublicationRag } from "./collections";
import type { CollectionPartieRag } from "./nettoyage";

const log = journal("rag");

/** Lecteurs prévenus au plus par collection supprimée. */
export const LECTEURS_AVERTIS_MAX = 500;

/** Prévient les comptes qui lisaient les collections publiées (tous les comptes ou les membres des groupes accordés) ; un échec est journalisé, jamais propagé. */
export async function avertirLecteursRag(
  base: Base,
  auteur: number,
  collections: readonly CollectionPartieRag[],
): Promise<void> {
  for (const c of collections) {
    if (c.visibility === "private") continue;
    try {
      const lecteurs = [...(await audiencePublicationRag(base, auteur, c.visibility, c.group_ids))].slice(
        0,
        LECTEURS_AVERTIS_MAX,
      );
      for (const uid of lecteurs)
        await pousserNotification(
          base,
          uid,
          "rag_share_end",
          `La collection ${c.name} n'est plus disponible`,
          {
            body: "Son auteur a quitté l'application : la collection partagée avec vous a été supprimée.",
          },
        );
    } catch (e) {
      log.warn({ err: e }, `avis aux lecteurs de la collection ${c.id} en échec`);
    }
  }
}
