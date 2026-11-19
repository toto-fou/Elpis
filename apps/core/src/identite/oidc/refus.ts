// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/refus.ts — refus d'une connexion SSO : un code d'une liste fermée pour le navigateur, la cause réelle pour le journal serveur et l'audit. */

export const CODES_REFUS = [
  "denied",
  "expired",
  "not_in_group",
  "groups_unknown",
  "conflict",
  "suspended",
  "mfa_required",
  "unavailable",
  "failed",
] as const;

export type CodeRefus = (typeof CODES_REFUS)[number];

/** Refus porté d'un bout à l'autre du parcours ; `cause` ne quitte jamais le serveur. */
export class RefusOidc extends Error {
  readonly code: CodeRefus;
  readonly cause_: string;
  readonly uid: number | null;

  constructor(code: CodeRefus, cause: string, uid: number | null = null) {
    super(cause);
    this.name = "RefusOidc";
    this.code = code;
    this.cause_ = cause;
    this.uid = uid;
  }
}
