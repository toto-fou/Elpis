// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/connexion.ts — connexion par l'annuaire : l'annuaire qui contient l'identifiant décide ; liaison de l'utilisateur sur sa propre connexion, compteur d'essais par entrée, état de l'entrée, appartenance aux groupes requis. */
import type { Base } from "@elpis/db";

import type { Journal } from "../../journal";
import { ancreIdentite } from "../ancre";
import { fournisseursActifs, secretFournisseur } from "../fournisseurs";
import type { Appartenance, ProfilIdentite } from "../provisionnement";
import type { FournisseurLdap } from "../reglages";
import { appartient, groupeExiste } from "./appartenance";
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
  | "state_unknown"
  | "not_in_group"
  | "groups_unknown";

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

export const ECHEANCE_AUTHENTIFICATION_MS = 20_000;
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
  /** Échéance globale d'une authentification, en millisecondes (20 s par défaut). */
  readonly echeanceMs?: number;
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
export async function ouvrirService(
  dep: Pick<DependancesAnnuaire, "fabrique">,
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

export async function appartenance(
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
  if (erreur) return "inconnu";
  // « non » suspend un compte connu : il n'est rendu que si chaque groupe requis existe bien dans l'annuaire.
  for (const groupe of f.required_groups) {
    try {
      if (!(await groupeExiste(cnx, groupe))) return "inconnu";
    } catch (e) {
      if (!(e instanceof ErreurAnnuaire)) throw e;
      return "inconnu";
    }
  }
  return "non";
}

const CODES_ENTREE_FERMEE = [19, 53];

/** Liaison de l'utilisateur sur une connexion à elle ; vrai si l'annuaire l'accepte, faux sur « identifiants » ou entrée verrouillée / désactivée (codes 19, 53) ; toute autre erreur est propagée. */
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
    if (e instanceof ErreurAnnuaire && e.code !== null && CODES_ENTREE_FERMEE.includes(e.code)) return false;
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
      if (e instanceof ErreurAnnuaire && e.nature === "identifiants" && e.code === null) return "absent";
      throw e;
    }
    if (trouve === "absent") return "absent";
    if (trouve === "ambigu") return refus("ambiguous", f.id);
    const sujet = cleStable(trouve, f);
    // L'état de l'entrée est jugé avant la liaison : aucun mot de passe n'est envoyé pour une entrée qui ne peut pas se connecter.
    const etat = etatEntree(trouve, f, dep.maintenant() * 1000);
    if (etat !== "active") return refus(RAISON_ETAT[etat] ?? "state_unknown", f.id);
    // Seuls les membres des groupes requis reçoivent une liaison : aucune autre entrée n'est devinable ni verrouillable par Elpis.
    const membre = await appartenance(service, f, trouve);
    if (membre !== "oui") return refus(membre === "non" ? "not_in_group" : "groups_unknown", f.id);
    if (await compterEssai(dep.base, f, sujet, dep.maintenant())) return refus("throttled", f.id);
    if (!(await lierUtilisateur(dep, f, url, trouve.dn, motDePasse))) return refus("bad_password", f.id);
    await oublierEssais(dep.base, f, sujet);
    const externe = profilExterne(trouve, f);
    return {
      type: "ok",
      fournisseur: f,
      profil: {
        subject: sujet,
        issuer: ancreIdentite(f),
        extUsername: externe.identifiant,
        extEmail: externe.email,
        extName: externe.nom,
      },
      appartenance: membre,
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
  const r = await dep.porte.avec(() =>
    avecEcheance(dep, (d) => travailler(d, identifiant, motDePasse, actifs)),
  );
  return r.admis ? r.valeur : { type: "indisponible" };
}

async function travailler(
  dep: DependancesAnnuaire,
  identifiant: string,
  motDePasse: string,
  actifs: readonly FournisseurLdap[] | undefined,
): Promise<ResultatAnnuaire> {
  const annuaires = actifs ?? (await annuairesActifs(dep));
  return annuaires.length === 0 ? { type: "absent" } : parcourir(dep, annuaires, identifiant, motDePasse);
}

/** Travail borné dans le temps, toutes adresses et opérations comprises : passé l'échéance, les connexions ouvertes sont fermées, aucune autre ne s'ouvre et le résultat est « indisponible ». */
async function avecEcheance(
  dep: DependancesAnnuaire,
  travail: (d: DependancesAnnuaire) => Promise<ResultatAnnuaire>,
): Promise<ResultatAnnuaire> {
  const ouvertes = new Set<ConnexionAnnuaire>();
  let expire = false;
  const borne: DependancesAnnuaire = {
    ...dep,
    fabrique: async (f, url) => {
      if (expire) throw new ErreurAnnuaire("injoignable");
      const c = await dep.fabrique(f, url);
      ouvertes.add(c);
      if (expire) await c.fermer();
      return c;
    },
  };
  let minuteur: NodeJS.Timeout | undefined;
  const echeance = new Promise<ResultatAnnuaire>((fin) => {
    minuteur = setTimeout(() => {
      expire = true;
      dep.journal.warn("annuaire : échéance de l'authentification dépassée");
      for (const c of ouvertes) void c.fermer().catch(() => undefined);
      fin({ type: "indisponible" });
    }, dep.echeanceMs ?? ECHEANCE_AUTHENTIFICATION_MS);
  });
  const fait = travail(borne);
  fait.catch(() => undefined);
  try {
    return await Promise.race([fait, echeance]);
  } finally {
    clearTimeout(minuteur);
  }
}
