// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/banc-annuaire.ts — base, config.json, coffre et annuaire factice prêts : un ou plusieurs fournisseurs LDAP actifs (test réussi, secret rangé) sur l'un des deux moteurs. */
import { createUser } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";

import { PorteAnnuaire } from "../../../src/identite/annuaire/connexion";
import type { DependancesAnnuaire } from "../../../src/identite/annuaire/connexion";
import { enregistrerSecret, enregistrerTestReussi } from "../../../src/identite/fournisseurs";
import { validerFournisseur } from "../../../src/identite/reglages";
import type { FournisseurLdap } from "../../../src/identite/reglages";
import { journalMuet } from "../../aides";
import { cleCoffreDeTest, configDeTest, ldapValide } from "../aides";
import type { ConfigDeTest } from "../aides";
import { AnnuaireFactice, GROUPE, MDP_SERVICE } from "./annuaire-factice";

export const URL_PUBLIQUE = "https://elpis.exemple.lan";
const ACTEUR = { userId: null, username: null, ip: null };

export interface BancAnnuaire {
  readonly t: BaseDeTest;
  readonly cfg: ConfigDeTest;
  readonly annuaire: AnnuaireFactice;
  readonly fournisseurs: FournisseurLdap[];
  /** Horloge en secondes, réglable. */
  horloge: number;
  dep(): DependancesAnnuaire;
  fermer(): Promise<void>;
}

/** Fournisseurs LDAP actifs (`extra` par fournisseur, `id` annuaire, annuaire2…), un administrateur local `chef` ; l'annuaire factice est partagé. */
export async function ouvrirBancAnnuaire(
  moteur: "sqlite" | "postgres",
  extras: Record<string, unknown>[] = [{}],
  annuaire: AnnuaireFactice = new AnnuaireFactice(),
): Promise<BancAnnuaire> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
  cleCoffreDeTest();
  const cfg = configDeTest({ https: true });
  const fournisseurs: FournisseurLdap[] = [];
  for (const [i, extra] of extras.entries()) {
    const f = validerFournisseur(
      ldapValide({
        id: i === 0 ? "annuaire" : `annuaire${i + 1}`,
        enabled: true,
        required_groups: [GROUPE],
        groups: { mode: "member" },
        urls: [`ldaps://ldap${i === 0 ? "" : i + 1}.exemple.lan`],
        ...extra,
      }),
    );
    if (f.type !== "ldap") throw new Error("LDAP attendu");
    fournisseurs.push(f);
    await enregistrerSecret(t.base, f, MDP_SERVICE, ACTEUR);
    await enregistrerTestReussi(t.base, f, URL_PUBLIQUE);
  }
  cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: fournisseurs } });
  const porte = new PorteAnnuaire();
  const banc: BancAnnuaire = {
    t,
    cfg,
    annuaire,
    fournisseurs,
    horloge: 1_800_000_000,
    dep: () => ({
      base: t.base,
      fabrique: annuaire.fabrique,
      maintenant: () => banc.horloge,
      cookieSecure: () => true,
      journal: journalMuet,
      porte,
    }),
    async fermer() {
      cfg.fermer();
      await t.fermer();
    },
  };
  return banc;
}
