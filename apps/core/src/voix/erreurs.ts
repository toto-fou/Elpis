// SPDX-License-Identifier: MIT
/** apps/core/src/voix/erreurs.ts — échecs du moteur vocal traduits en messages actionnables, avec le code HTTP à renvoyer (shared_infra/voice/errors.py). */

/** Base des échecs vocaux : `statut` = code HTTP rendu, `code` = celui du moteur distant (0 sans réponse). */
export class VoiceError extends Error {
  override name = "VoiceError";
  readonly statut: number = 502;
  readonly detail: string;
  readonly code: number;

  constructor(message: string, options: { detail?: string; code?: number } = {}) {
    super(message);
    this.detail = options.detail ?? "";
    this.code = options.code ?? 0;
  }
}

/** Fonction éteinte ou aucune adresse configurée. */
export class VoiceDesactive extends VoiceError {
  override name = "VoiceDesactive";
  override readonly statut: number = 403;
}

/** Service arrêté, mauvaise adresse ou pare-feu. */
export class VoiceInjoignable extends VoiceError {
  override name = "VoiceInjoignable";
}

/** Service trop lent (modèle trop gros pour la machine). */
export class VoiceTimeout extends VoiceError {
  override name = "VoiceTimeout";
  override readonly statut: number = 504;
}

/** Réponse en erreur (HTTP 4xx/5xx, corps inattendu). */
export class VoiceRefus extends VoiceError {
  override name = "VoiceRefus";
}

/** Créneaux vers le moteur tous pris, attente expirée. */
export class VoiceOccupe extends VoiceError {
  override name = "VoiceOccupe";
  override readonly statut: number = 503;
}
