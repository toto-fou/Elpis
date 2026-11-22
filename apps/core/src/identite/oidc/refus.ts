// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/refus.ts — refus d'une connexion SSO : un code d'une liste fermée pour le navigateur, la cause réelle pour le journal serveur et l'audit. */
import type { CodeErreurConnexion } from "@elpis/contracts";

/** Refus porté d'un bout à l'autre du parcours ; `cause` ne quitte jamais le serveur. */
export class RefusOidc extends Error {
  readonly code: CodeErreurConnexion;
  readonly cause_: string;
  readonly uid: number | null;

  constructor(code: CodeErreurConnexion, cause: string, uid: number | null = null) {
    super(cause);
    this.name = "RefusOidc";
    this.code = code;
    this.cause_ = cause;
    this.uid = uid;
  }
}
