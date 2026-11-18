// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/faux.ts — connexion d'annuaire factice (aucun réseau) qui enregistre les recherches et rend des réponses scriptées. */
import type {
  ConnexionAnnuaire,
  EntreeAnnuaire,
  OptionsRecherche,
} from "../../../src/identite/annuaire/client";
import type { FournisseurLdap } from "../../../src/identite/reglages";
import { validerFournisseur } from "../../../src/identite/reglages";
import { ldapValide } from "../aides";

export interface AppelRecherche {
  readonly base: string;
  readonly o: OptionsRecherche;
}

export type Reponse = (base: string, o: OptionsRecherche) => EntreeAnnuaire[] | Promise<EntreeAnnuaire[]>;

export function connexionFausse(reponse: Reponse = () => []): ConnexionAnnuaire & {
  readonly appels: AppelRecherche[];
  readonly liaisons: [string, string][];
} {
  const appels: AppelRecherche[] = [];
  const liaisons: [string, string][] = [];
  return {
    appels,
    liaisons,
    lier(dn, mdp) {
      liaisons.push([dn, mdp]);
      return Promise.resolve();
    },
    async chercher(base, o) {
      appels.push({ base, o });
      return reponse(base, o);
    },
    fermer: () => Promise.resolve(),
  };
}

export function fournisseur(extra: Record<string, unknown> = {}): FournisseurLdap {
  const f = validerFournisseur(ldapValide(extra));
  if (f.type !== "ldap") throw new Error("fournisseur LDAP attendu");
  return f;
}

export function entree(dn: string, attrs: Record<string, (string | Buffer)[]> = {}): EntreeAnnuaire {
  return { dn, attrs };
}
