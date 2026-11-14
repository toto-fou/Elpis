// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/erreurs.ts — refus du coffre « Secrets » : statut HTTP, code `secret_*` stable et message en anglais (lu par le modèle et par l'interface). */
import type { CodeErreurSecret } from "@elpis/contracts";
import { CleCoffreIndisponible, SecretIndechiffrable } from "@elpis/securite";

export class ErreurSecret extends Error {
  override name = "ErreurSecret";
  readonly statut: number;
  readonly code: CodeErreurSecret;
  constructor(statut: number, code: CodeErreurSecret, message: string) {
    super(message);
    this.statut = statut;
    this.code = code;
  }
}

/** Erreur de clé ou de déchiffrement rendue en refus du coffre ; `null` pour toute autre erreur (à laisser monter). */
export function refusDeCle(e: unknown, nom?: string): ErreurSecret | null {
  if (e instanceof ErreurSecret) return e;
  if (e instanceof CleCoffreIndisponible)
    return new ErreurSecret(
      503,
      "secret_key_unavailable",
      "The vault key is unavailable on this server (see ./elpis doctor).",
    );
  if (e instanceof SecretIndechiffrable)
    return new ErreurSecret(
      409,
      "secret_undecryptable",
      `Secret ${nom ? `'${nom}' ` : ""}cannot be decrypted with the current vault key: rotate it, or run ./elpis vault rekey.`,
    );
  return null;
}
