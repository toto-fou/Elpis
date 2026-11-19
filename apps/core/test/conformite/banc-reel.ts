// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/banc-reel.ts — banc de conformité : serveur LDAPS local, autorité jetable et banc d'annuaire branché sur l'adaptateur réel (ldapts) au lieu de l'annuaire factice. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExternalUser, dependancesParDefaut } from "@elpis/auth";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";

import { etapesAnnuaire } from "../../src/identite/annuaire/essai";
import type { EtapeEssai } from "../../src/identite/etapes";
import { ancreIdentite } from "../../src/identite/ancre";
import { balayerAnnuaire } from "../../src/identite/annuaire/balayage";
import type { DependancesBalayage, IssueBalayage } from "../../src/identite/annuaire/balayage";
import type { FabriqueConnexion } from "../../src/identite/annuaire/client";
import type { FournisseurLdap } from "../../src/identite/reglages";
import { journalMuet } from "../aides";
import { fabriqueLdapts } from "../../src/identite/annuaire/client";
import type { DependancesAnnuaire } from "../../src/identite/annuaire/connexion";
import { creerAutorite, creerFeuille, effacer } from "../identite/pki-openssl";
import type { Autorite, OptionsFeuille } from "../identite/pki-openssl";
import { ouvrirBancAnnuaire } from "../identite/annuaire/banc-annuaire";
import type { BancAnnuaire } from "../identite/annuaire/banc-annuaire";
import { demarrerServeurLdap } from "../identite/annuaire/serveur-ldap";
import type { OptionsServeurLdap, ServeurLdap } from "../identite/annuaire/serveur-ldap";
import { installerProfil, MDP_SERVICE } from "./profils-annuaire";
import type { ProfilAnnuaire } from "./profils-annuaire";

export const fabriqueReelle = (): FabriqueConnexion => fabriqueLdapts({ juger: VERS_BOUCLE });
export const NOM = "elpis-test.invalid";
export const VERS_BOUCLE = async (): Promise<{ motif: null; adresses: string[] }> => ({
  motif: null,
  adresses: ["127.0.0.1"],
});

export interface Hote {
  readonly ca: Autorite;
  readonly serveur: ServeurLdap;
  readonly url: string;
  fermer(): Promise<void>;
}

/** Serveur LDAPS local signé par une autorité jetable ; `feuille` et `options` règlent le certificat et le TLS offerts. */
export async function demarrerHote(
  feuille: OptionsFeuille = {},
  options: OptionsServeurLdap = {},
  ca: Autorite = creerAutorite("Annuaire de conformité"),
): Promise<Hote> {
  const f = creerFeuille(ca, { noms: [NOM], ...feuille });
  const serveur = await demarrerServeurLdap(f.cert, f.cle, options);
  return {
    ca,
    serveur,
    url: `ldaps://${NOM}:${serveur.port}`,
    async fermer() {
      await serveur.fermer();
      effacer(ca);
    },
  };
}

/** Banc d'annuaire dont les connexions passent par l'adaptateur réel vers `hote`, réglé d'après le profil. */
export async function ouvrirBancReel(
  moteur: "sqlite" | "postgres",
  hote: Hote,
  profil: ProfilAnnuaire,
  extra: Record<string, unknown> = {},
): Promise<BancAnnuaire> {
  installerProfil(hote.serveur, profil);
  const b = await ouvrirBancAnnuaire(moteur, [
    { ...profil.reglages, urls: [hote.url], ca_pem: hote.ca.cert, timeout_sec: 5, ...extra },
  ]);
  const base = b.dep.bind(b);
  b.dep = (): DependancesAnnuaire => ({ ...base(), fabrique: fabriqueLdapts({ juger: VERS_BOUCLE }) });
  return b;
}

export interface Balayage {
  /** Une passe sur le profil (l'identité rattachée est vérifiée depuis longtemps) ; rend l'issue. */
  passe(): Promise<IssueBalayage>;
  /** Compte externe rattaché à la clé stable donnée ; rend son identifiant. */
  rattacher(uid: string, cle: string): Promise<number>;
  suspendu(id: number): Promise<boolean>;
  fermer(): Promise<void>;
}

/** Outillage de balayage sur le banc réel : verrou et audit jetables, un compte externe par appel de `rattacher`. */
export function preparerBalayage(b: BancAnnuaire, fabrique: FabriqueConnexion): Balayage {
  const audit = mkdtempSync(join(tmpdir(), "elpis-audit-conformite-"));
  const verrous = mkdtempSync(join(tmpdir(), "elpis-verrous-conformite-"));
  configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(audit, "sans-cle") });
  const f = b.fournisseurs[0] as FournisseurLdap;
  const dep: DependancesBalayage = {
    base: b.t.base,
    fabrique,
    maintenant: () => b.horloge,
    cookieSecure: () => true,
    journal: journalMuet,
    cheminVerrou: (id) => join(verrous, `${id}.lock`),
    etat: {
      base: b.t.base,
      acces: dependancesParDefaut(b.t.base),
      maintenant: () => b.horloge,
      publierSuspension: async () => true,
      journal: journalMuet,
    },
  };
  return {
    passe: () => balayerAnnuaire(dep, f),
    async rattacher(uid, cle) {
      const id = await createExternalUser(b.t.base, uid, { maintenant: b.horloge - 1000 });
      await b.t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?)",
        [id, f.id, cle, ancreIdentite(f), "auto", b.horloge - 1000, 5],
      );
      return id;
    },
    async suspendu(id) {
      const l = await b.t.base.get<{ suspended_at: number | null }>(
        "SELECT suspended_at FROM users WHERE id=?",
        [id],
      );
      return Number(l?.suspended_at ?? 0) !== 0;
    },
    async fermer() {
      oublierConfigurationAudit();
      rmSync(audit, { recursive: true, force: true });
      rmSync(verrous, { recursive: true, force: true });
    },
  };
}

/** Étapes du bouton « Tester » sur le profil, avec l'utilisateur d'essai donné, contre l'adaptateur réel. */
export async function jouerEssai(
  b: BancAnnuaire,
  hote: Hote,
  utilisateur: string | null,
  secret: string | null = null,
): Promise<EtapeEssai[]> {
  const f = b.fournisseurs[0] as FournisseurLdap;
  const etapes: EtapeEssai[] = [];
  await etapesAnnuaire(etapes, f, hote.url, {
    fabrique: fabriqueLdapts({ juger: VERS_BOUCLE }),
    secretEnregistre: () => Promise.resolve(MDP_SERVICE),
    utilisateur,
    secret,
    limiteur: {
      refuse: () => Promise.resolve(false),
      echec: () => Promise.resolve(),
      succes: () => Promise.resolve(),
    },
    maintenant: () => b.horloge,
    signal: new AbortController().signal,
  });
  return etapes;
}
