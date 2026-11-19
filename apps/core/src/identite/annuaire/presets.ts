// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/presets.ts — préréglages d'annuaire (freeipa, active-directory, openldap, other) : valeurs proposées au formulaire, la source de vérité restant les réglages enregistrés. */
import type { FournisseurLdap, ModeGroupes } from "../reglages";

export type IdPreset = "freeipa" | "active-directory" | "openldap" | "other";
export type FamilleEtat = "freeipa" | "active-directory" | "aucune";

export interface PresetAnnuaire {
  readonly id: IdPreset;
  readonly libelle: string;
  readonly filtre: string;
  readonly attrs: FournisseurLdap["attrs"];
  readonly mode: ModeGroupes;
  readonly famille: FamilleEtat;
  /** Attributs d'état à lire en plus des quatre attributs d'identité. */
  readonly attributsEtat: readonly string[];
}

export const PRESETS: Readonly<Record<IdPreset, PresetAnnuaire>> = {
  freeipa: {
    id: "freeipa",
    libelle: "FreeIPA",
    filtre: "(&(objectClass=person)(uid={username}))",
    attrs: { id: "ipaUniqueID", username: "uid", email: "mail", name: "cn" },
    mode: "memberof",
    famille: "freeipa",
    attributsEtat: ["nsAccountLock", "krbPasswordExpiration", "krbLastPwdChange"],
  },
  "active-directory": {
    id: "active-directory",
    libelle: "Active Directory",
    filtre: "(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))",
    attrs: { id: "objectGUID", username: "sAMAccountName", email: "mail", name: "displayName" },
    mode: "chain",
    famille: "active-directory",
    attributsEtat: ["userAccountControl", "msDS-User-Account-Control-Computed"],
  },
  openldap: {
    id: "openldap",
    libelle: "OpenLDAP",
    filtre: "(&(objectClass=inetOrgPerson)(uid={username}))",
    attrs: { id: "entryUUID", username: "uid", email: "mail", name: "cn" },
    mode: "member",
    famille: "aucune",
    attributsEtat: [],
  },
  other: {
    id: "other",
    libelle: "Autre",
    filtre: "(uid={username})",
    attrs: { id: "entryUUID", username: "uid", email: "mail", name: "cn" },
    mode: "memberof",
    famille: "aucune",
    attributsEtat: [],
  },
};

/** Préréglage d'un identifiant enregistré, `undefined` s'il est inconnu ou vide. */
export function presetDe(id: string): PresetAnnuaire | undefined {
  return Object.hasOwn(PRESETS, id) ? PRESETS[id as IdPreset] : undefined;
}
