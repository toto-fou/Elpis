// SPDX-License-Identifier: MIT
/** apps/core/src/skills/ports.ts — dépendances des skills pas encore portées (nom du compte, racine de sa sandbox) : interface et pose. */
import { ErreurPortAbsent } from "../llm/ports";

/** `get_username_by_id` et `_get_sandbox_path` de Python. */
export interface PortComptesSkills {
  nomUtilisateur(uid: number): Promise<string | null>;
  /** Racine de la sandbox du compte (où vit le miroir `skills/`), `null` si inconnue. */
  racineSandbox(uid: number): Promise<string | null>;
}

let comptes: PortComptesSkills | null = null;

export function installerComptesSkills(impl: PortComptesSkills | null): void {
  comptes = impl;
}

export function comptesSkills(): PortComptesSkills {
  if (comptes === null) throw new ErreurPortAbsent("comptes des skills non installés");
  return comptes;
}
