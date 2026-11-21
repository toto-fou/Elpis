// SPDX-License-Identifier: MIT
/** apps/core/src/administration/hote-console.ts — appels de la console à l'hôte d'outils (seul à lancer docker) : hôte par défaut (celui du relevé), identité signée de l'admin ou du compte visé, erreurs claires. */
import { HttpError } from "@elpis/commun";

import { appelerHote, ErreurHote } from "../admin/pilote-bac";
import { journal } from "../journal";
import { sandboxHostFor } from "../relais/hotes";

const log = journal("sandbox");
const MESSAGE_INJOIGNABLE = "L'hôte d'outils ne répond pas. Vérifiez qu'il est démarré, puis réessayez.";

/** Compte au nom duquel l'appel est signé : l'admin à la console, le compte visé pour son bac. */
export interface Acteur {
  readonly id: number;
  readonly username: string | null;
}

/** Appel JSON de l'hôte d'outils ; refus 502 de l'hôte rendu tel quel, hôte absent ou refus d'accès : 502 clair, panne interne de l'hôte : erreur interne. */
export async function appelerConsole(
  acteur: Acteur | undefined,
  methode: "GET" | "POST",
  chemin: string,
  options: { delaiS: number; json?: unknown; compte?: Acteur } = { delaiS: 60 },
): Promise<unknown> {
  const signataire = options.compte ?? acteur;
  if (signataire === undefined) throw new HttpError(502, MESSAGE_INJOIGNABLE);
  const hote = await sandboxHostFor(null, false);
  if (hote === null || !hote.token) {
    log.warn("[console] aucun hôte d'outils déclaré pour les opérations Docker");
    throw new HttpError(502, MESSAGE_INJOIGNABLE);
  }
  try {
    return await appelerHote(
      hote,
      signataire.id,
      signataire.username ?? `user_${signataire.id}`,
      methode,
      chemin,
      {
        delaiS: options.delaiS,
        ...(options.json === undefined ? {} : { json: options.json }),
      },
    );
  } catch (e) {
    if (e instanceof ErreurHote && e.statut === 502 && e.detail) throw new HttpError(502, e.detail);
    if (e instanceof ErreurHote && e.statut === 500) throw e;
    log.warn(`[console] hôte d'outils injoignable : ${e instanceof Error ? e.message : String(e)}`);
    throw new HttpError(502, MESSAGE_INJOIGNABLE);
  }
}
