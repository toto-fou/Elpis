// SPDX-License-Identifier: MIT
/** apps/core/src/tour/ports-jobs.ts — port des tâches de fond vu par le tour : événements joints au message de l'utilisateur, livraisons rendues si le tour ne les a pas persistées. */

/** Origine d'un tour ouvert par le serveur : réveil d'une conversation par ses jobs. */
export interface OrigineReveil {
  readonly origin: "job_wake";
  readonly wake: Readonly<Record<string, unknown>>;
  readonly depth: number;
}

/** Ce que le tour a persisté : la question (ou le message de réveil), la réponse avec son historique d'outils, le suffixe de la question. */
export interface IssueTour {
  readonly message: boolean;
  readonly reponse: boolean;
  readonly suffixe: boolean;
}

export interface PortJobsTour {
  /** Événements non livrés pris pour le prochain message de l'utilisateur (JB-08) ; `null` sans événement. */
  prendrePourMessage(uid: number, chatId: string, runId: string): Promise<string | null>;
  /** Fin du run `runId` : ses livraisons non persistées redeviennent non livrées. */
  finTour(uid: number, chatId: string, runId: string, issue: IssueTour): void;
  /** « Arrêter » de l'utilisateur : aucun réveil automatique de la conversation jusqu'au prochain tour qu'il lance. */
  arretUtilisateur(uid: number, chatId: string): void;
  /** Tour lancé par l'utilisateur (message ou « Continuer ») : les réveils suspendus par « Arrêter » reprennent. */
  tourUtilisateur(uid: number, chatId: string): void;
}

let port: PortJobsTour | null = null;

export function installerJobsTour(p: PortJobsTour | null): void {
  port = p;
}

export function jobsTour(): PortJobsTour | null {
  return port;
}
