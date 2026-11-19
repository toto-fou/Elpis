// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/connexion.ts — connexion par l'annuaire : l'annuaire qui contient l'identifiant décide ; liaison de l'utilisateur sur sa propre connexion, compteur d'essais par entrée, état de l'entrée, appartenance aux groupes requis. */
import type { Base } from "@elpis/db";

import type { Journal } from "../../journal";
import { ancreIdentite } from "../ancre";
import { fournisseursActifs, secretFournisseur } from "../fournisseurs";
import type { Appartenance, ProfilIdentite } from "../provisionnement";
import type { FournisseurLdap } from "../reglages";
import { appartient } from "./appartenance";
import { MOT_DE_PASSE_MAX_OCTETS } from "./client";
import type { ConnexionAnnuaire, EntreeAnnuaire, FabriqueConnexion } from "./client";
import { compterEssai, oublierEssais } from "./echecs";
import { chercherUtilisateur, cleStable, etatEntree, profilExterne } from "./entree";
import { ErreurAnnuaire } from "./erreur";

export type RaisonRefusAnnuaire =
  | "bad_password"
  | "ambiguous"
  | "throttled"
  | "entry_disabled"
  | "entry_locked"
  | "password_expired"
  | "state_unknown";

export type ResultatAnnuaire =
  | {
      readonly type: "ok";
      readonly fournisseur: FournisseurLdap;
      readonly profil: ProfilIdentite;
      readonly appartenance: Appartenance;
    }
  | { readonly type: "refus"; readonly raison: RaisonRefusAnnuaire; readonly fournisseurId: string | null }
  | { readonly type: "absent" }
  | { readonly type: "indisponible" };

export const AUTHENTIFICATIONS_EN_COURS_MAX = 8;
export const AUTHENTIFICATIONS_EN_ATTENTE_MAX = 32;

/** Au plus 8 authentifications en cours et 32 en attente dans le process ; au-delà, l'appel est refusé sans attendre. */
export class PorteAnnuaire {
  private enCours = 0;
  private readonly file: (() => void)[] = [];

  async avec<T>(fn: () => Promise<T>): Promise<{ admis: true; valeur: T } | { admis: false }> {
    if (this.enCours >= AUTHENTIFICATIONS_EN_COURS_MAX) {
      if (this.file.length >= AUTHENTIFICATIONS_EN_ATTENTE_MAX) return { admis: false };
      await new Promise<void>((suite) => this.file.push(suite));
    } else this.enCours++;
    try {
      return { admis: true, valeur: await fn() };
    } finally {
      const suivant = this.file.shift();
      if (suivant === undefined) this.enCours--;
      else suivant();
    }
  }
}

export interface DependancesAnnuaire {
  readonly base: Base;
  readonly fabrique: FabriqueConnexion;
  /** Secondes. */
  readonly maintenant: () => number;
  /** Cookie de session `Secure` en vigueur dans le process. */
  readonly cookieSecure: () => boolean;
  readonly journal: Journal;
  readonly porte: PorteAnnuaire;
}

/** Annuaires LDAP actifs (tous leurs invariants de lecture tiennent), dans l'ordre de la configuration. */
export async function annuairesActifs(
  dep: Pick<DependancesAnnuaire, "base" | "cookieSecure">,
): Promise<FournisseurLdap[]> {
  const actifs = await fournisseursActifs(dep.base, dep.cookieSecure);
  return actifs.filter((f): f is FournisseurLdap => f.type === "ldap");
}

const refus = (raison: RaisonRefusAnnuaire, fournisseurId: string | null): ResultatAnnuaire => ({
  type: "refus",
  raison,
  fournisseurId,
});

const RAISON_ETAT: Readonly<Record<string, RaisonRefusAnnuaire>> = {
  desactivee: "entry_disabled",
  verrouillee: "entry_locked",
  expiree: "password_expired",
  inconnu: "state_unknown",
};

function signaler(dep: DependancesAnnuaire, f: FournisseurLdap, e: ErreurAnnuaire): void {
  dep.journal.warn(
    `annuaire ${f.id} : ${e.nature}${e.code === null ? "" : ` (code ${e.code})`}${e.sortant === null ? "" : ` (${e.sortant})`}`,
  );
}

/** Connexion de service liée, adresses essayées dans l'ordre (la suivante seulement sur « injoignable ») ; rend aussi l'adresse retenue. */
async function ouvrirService(
  dep: DependancesAnnuaire,
  f: FournisseurLdap,
  secret: string,
): Promise<{ cnx: ConnexionAnnuaire; url: string }> {
  let derniere = new ErreurAnnuaire("injoignable");
  for (const url of f.urls) {
    let cnx: ConnexionAnnuaire | null = null;
    try {
      cnx = await dep.fabrique(f, url);
      await cnx.lier(f.bind_dn, secret);
      return { cnx, url };
    } catch (e) {
      await cnx?.fermer();
      if (!(e instanceof ErreurAnnuaire)) throw e;
      derniere = e;
      if (e.nature !== "injoignable") break;
    }
  }
  throw derniere;
}

async function appartenance(
  cnx: ConnexionAnnuaire,
  f: FournisseurLdap,
  entree: EntreeAnnuaire,
): Promise<Appartenance> {
  let erreur = false;
  for (const groupe of f.required_groups) {
    try {
      if (await appartient(cnx, f, entree, groupe)) return "oui";
    } catch (e) {
      if (!(e instanceof ErreurAnnuaire)) throw e;
      erreur = true;
    }
  }
  return erreur ? "inconnu" : "non";
}

/** Liaison de l'utilisateur sur une connexion à elle ; vrai si l'annuaire l'accepte, faux sur « identifiants » ; toute autre erreur est propagée. */
async function lierUtilisateur(
  dep: DependancesAnnuaire,
  f: FournisseurLdap,
  url: string,
  dn: string,
  motDePasse: string,
): Promise<boolean> {
  let cnx: ConnexionAnnuaire | null = null;
  try {
    cnx = await dep.fabrique(f, url);
    await cnx.lier(dn, motDePasse);
    return true;
  } catch (e) {
    if (e instanceof ErreurAnnuaire && e.nature === "identifiants") return false;
    throw e;
  } finally {
    await cnx?.fermer();
  }
}

/** L'annuaire `f` contient-il l'identifiant ? `"absent"`, ou le résultat qui décide. */
async function interroger(
  dep: DependancesAnnuaire,
  f: FournisseurLdap,
  identifiant: string,
  motDePasse: string,
): Promise<ResultatAnnuaire | "absent"> {
  const secret = await secretFournisseur(dep.base, f);
  if (secret === null) {
    dep.journal.warn(`annuaire ${f.id} : secret du compte de service absent ou hors de portée`);
    return { type: "indisponible" };
  }
  const { cnx: service, url } = await ouvrirService(dep, f, secret);
  try {
    let trouve: EntreeAnnuaire | "absent" | "ambigu";
    try {
      trouve = await chercherUtilisateur(service, f, identifiant);
    } catch (e) {
      if (e instanceof ErreurAnnuaire && e.nature === "identifiants") return "absent";
      throw e;
    }
    if (trouve === "absent") return "absent";
    if (trouve === "ambigu") return refus("ambiguous", f.id);
    const sujet = cleStable(trouve, f);
    if (await compterEssai(dep.base, f, sujet, dep.maintenant())) return refus("throttled", f.id);
    if (!(await lierUtilisateur(dep, f, url, trouve.dn, motDePasse))) return refus("bad_password", f.id);
    await oublierEssais(dep.base, f, sujet);
    const etat = etatEntree(trouve, f, dep.maintenant() * 1000);
    if (etat !== "active") return refus(RAISON_ETAT[etat] ?? "state_unknown", f.id);
    const externe = profilExterne(trouve, f);
    return {
      type: "ok",
      fournisseur: f,
      profil: {
        subject: sujet,
        issuer: ancreIdentite(f) ?? "",
        extUsername: externe.identifiant,
        extEmail: externe.email,
        extName: externe.nom,
      },
      appartenance: await appartenance(service, f, trouve),
    };
  } finally {
    await service.fermer();
  }
}

function motDePasseAdmis(motDePasse: unknown): motDePasse is string {
  return (
    typeof motDePasse === "string" &&
    motDePasse !== "" &&
    motDePasse.isWellFormed() &&
    !motDePasse.includes("\0") &&
    Buffer.byteLength(motDePasse) <= MOT_DE_PASSE_MAX_OCTETS
  );
}

async function parcourir(
  dep: DependancesAnnuaire,
  annuaires: readonly FournisseurLdap[],
  identifiant: string,
  motDePasse: string,
): Promise<ResultatAnnuaire> {
  for (const f of annuaires) {
    try {
      const r = await interroger(dep, f, identifiant, motDePasse);
      if (r !== "absent") return r;
    } catch (e) {
      if (!(e instanceof ErreurAnnuaire)) throw e;
      signaler(dep, f, e);
      return { type: "indisponible" };
    }
  }
  return { type: "absent" };
}

/** Authentifie l'identifiant tapé auprès des annuaires actifs, dans l'ordre ; le premier qui le contient décide, aucun essai sur le suivant. */
export async function authentifierParAnnuaire(
  dep: DependancesAnnuaire,
  identifiant: string,
  motDePasse: string,
  actifs?: readonly FournisseurLdap[],
): Promise<ResultatAnnuaire> {
  if (!motDePasseAdmis(motDePasse)) return refus("bad_password", null);
  // La porte est prise d'abord, sans attente : elle borne tout le travail, lecture des annuaires actifs comprise.
  const r = await dep.porte.avec(async (): Promise<ResultatAnnuaire> => {
    const annuaires = actifs ?? (await annuairesActifs(dep));
    return annuaires.length === 0 ? { type: "absent" } : parcourir(dep, annuaires, identifiant, motDePasse);
  });
  return r.admis ? r.valeur : { type: "indisponible" };
}
