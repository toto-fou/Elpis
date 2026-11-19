// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/rattachement-annuaire.ts — assistant de rattachement LDAP : comptes locaux sans identité et entrée proposée, recherche à la main, rattachement par lot où le serveur relit chaque entrée par sa clé stable. */
import { HttpError } from "@elpis/commun";
import { auditEvent } from "@elpis/securite";

import { ancreIdentite } from "../ancre";
import { cleIdentifiant } from "../cle-identifiant";
import { secretFournisseur } from "../fournisseurs";
import {
  auditerRattachement,
  rattacher,
  revoquerOauthRattachement,
  supprimerJetonsDuCompte,
} from "../rattachement";
import type { RaisonRefusRattachement } from "../rattachement";
import type { FournisseurLdap } from "../reglages";
import type { ConnexionAnnuaire, EntreeAnnuaire } from "./client";
import { annuairesActifs, appartenance, ouvrirService } from "./connexion";
import type { DependancesAnnuaire } from "./connexion";
import type { DependancesProvisionnement } from "../provisionnement";
import { attributsUtilisateur, chercherUtilisateur, cleStable, etatEntree, profilExterne } from "./entree";
import type { EtatEntree } from "./entree";
import { ErreurAnnuaire } from "./erreur";
import { filtreEgal } from "./filtre";

export const COMPTES_PAR_PAGE_MAX = 100;
export const RECHERCHE_MAX = 20;
export const LIENS_MAX = 50;

export interface Proposition {
  readonly subject: string;
  readonly dn: string;
  readonly ext_username: string;
  readonly ext_name: string;
  readonly ext_email: string;
  readonly state: EtatEntree;
  /** `null` : groupes illisibles. */
  readonly in_required_group: boolean | null;
}

export interface CompteAMigrer {
  readonly user_id: number;
  readonly username: string;
  readonly role: "admin" | "moderator" | "user";
  readonly last_login_at: number | null;
  readonly suspended: boolean;
  readonly proposal: Proposition | null;
}

export type RaisonLien =
  | RaisonRefusRattachement
  | "duplicate"
  | "entry_not_found"
  | "entry_ambiguous"
  | "entry_not_active"
  | "entry_not_loginable"
  | "not_in_group"
  | "groups_unknown"
  | "directory_unavailable";

export interface ResultatLien {
  readonly user_id: number;
  readonly subject: string;
  readonly result: "linked" | RaisonLien;
  readonly revoked_tokens?: number;
  readonly revoked_oauth?: number;
  readonly kept?: true;
}

const INDISPONIBLE = "L'annuaire ne répond pas : réessayez dans un instant.";
const CLE_LIBRE = /^[^\p{Cc}\s]{1,128}$/u;
const HEX_GUID = /^[0-9a-f]{32}$/u;

/** Travail sous la porte de l'annuaire et sur UNE connexion de service ; annuaire injoignable, secret absent ou porte pleine : 503. */
async function avecService<T>(
  dep: DependancesAnnuaire,
  f: FournisseurLdap,
  fn: (cnx: ConnexionAnnuaire) => Promise<T>,
): Promise<T> {
  try {
    const r = await dep.porte.avec(async () => {
      const secret = await secretFournisseur(dep.base, f);
      if (secret === null) throw new ErreurAnnuaire("configuration");
      const { cnx } = await ouvrirService(dep, f, secret);
      try {
        return await fn(cnx);
      } finally {
        await cnx.fermer();
      }
    });
    if (!r.admis) throw new HttpError(503, INDISPONIBLE);
    return r.valeur;
  } catch (e) {
    if (!(e instanceof ErreurAnnuaire)) throw e;
    dep.journal.warn(`annuaire ${f.id} : assistant de rattachement, ${e.nature}`);
    throw new HttpError(503, INDISPONIBLE);
  }
}

/** Valeur à chercher pour cette clé stable, `null` si elle n'a pas la forme d'une clé de cet annuaire. */
function valeurDeCle(f: FournisseurLdap, subject: string): string | Buffer | null {
  if (typeof subject !== "string" || !subject.isWellFormed()) return null;
  if (f.attrs.id.toLowerCase() === "objectguid")
    return HEX_GUID.test(subject) ? Buffer.from(subject, "hex") : null;
  return CLE_LIBRE.test(subject) ? subject : null;
}

type Lecture =
  { readonly type: "entree"; readonly entree: EntreeAnnuaire } | { readonly type: "absente" | "ambigue" };

/** Entrée relue par sa clé stable seule (égalité sur l'attribut d'identifiant) ; la clé de l'entrée trouvée doit être celle demandée. */
async function lireParCle(cnx: ConnexionAnnuaire, f: FournisseurLdap, subject: string): Promise<Lecture> {
  const valeur = valeurDeCle(f, subject);
  if (valeur === null) return { type: "absente" };
  const trouvees = await cnx.chercher(f.user_base_dn, {
    portee: "sub",
    filtre: filtreEgal(f.attrs.id, valeur),
    attributs: attributsUtilisateur(f),
    limite: 2,
  });
  const [premiere] = trouvees;
  if (premiere === undefined) return { type: "absente" };
  if (trouvees.length > 1) return { type: "ambigue" };
  try {
    return cleStable(premiere, f) === subject ? { type: "entree", entree: premiere } : { type: "absente" };
  } catch (e) {
    if (e instanceof ErreurAnnuaire && e.nature === "configuration") return { type: "absente" };
    throw e;
  }
}

async function entreeRattachee(
  dep: DependancesAnnuaire,
  f: FournisseurLdap,
  subject: string,
): Promise<boolean> {
  return (
    (await dep.base.get("SELECT 1 AS un FROM user_identities WHERE provider_id=? AND subject=?", [
      f.id,
      subject,
    ])) !== undefined
  );
}

/** Proposition d'une entrée ; `null` si l'entrée n'a pas de clé stable lisible ou si elle est déjà rattachée à un compte. */
async function proposer(
  dep: DependancesAnnuaire,
  f: FournisseurLdap,
  cnx: ConnexionAnnuaire,
  entree: EntreeAnnuaire,
): Promise<Proposition | null> {
  let subject: string;
  try {
    subject = cleStable(entree, f);
  } catch (e) {
    if (e instanceof ErreurAnnuaire && e.nature === "configuration") return null;
    throw e;
  }
  if (await entreeRattachee(dep, f, subject)) return null;
  const externe = profilExterne(entree, f);
  const groupes = await appartenance(cnx, f, entree);
  return {
    subject,
    dn: entree.dn,
    ext_username: externe.identifiant,
    ext_name: externe.nom,
    ext_email: externe.email,
    state: etatEntree(entree, f, dep.maintenant() * 1000),
    in_required_group: groupes === "inconnu" ? null : groupes === "oui",
  };
}

type LigneCompte = {
  id: number;
  username: string;
  is_admin: number | null;
  last_login_at: unknown;
  suspended_at: unknown;
};

const roleDe = (niveau: number | null): CompteAMigrer["role"] =>
  Number(niveau) === 1 ? "admin" : Number(niveau) === 2 ? "moderator" : "user";

/** Une page des comptes locaux sans identité, chacun avec l'entrée dont l'identifiant d'annuaire est égal à son nom (filtre du fournisseur, rien d'approchant). */
export async function comptesAMigrer(
  dep: DependancesAnnuaire,
  f: FournisseurLdap,
  page: { readonly offset: number; readonly limit: number },
): Promise<{ items: CompteAMigrer[]; total: number }> {
  const sansIdentite = "NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id=users.id)";
  const lignes = await dep.base.all<LigneCompte>(
    `SELECT id, username, is_admin, last_login_at, suspended_at FROM users WHERE ${sansIdentite} ORDER BY id LIMIT ? OFFSET ?`,
    [Math.min(page.limit, COMPTES_PAR_PAGE_MAX), page.offset],
  );
  const total = Number(
    (await dep.base.valeurs<[number]>(`SELECT COUNT(*) FROM users WHERE ${sansIdentite}`))[0]?.[0] ?? 0,
  );
  const propositions = await avecService(dep, f, async (cnx) => {
    const sortie: (Proposition | null)[] = [];
    for (const l of lignes) {
      let trouve: Awaited<ReturnType<typeof chercherUtilisateur>>;
      try {
        trouve = await chercherUtilisateur(cnx, f, String(l.username));
      } catch (e) {
        if (e instanceof ErreurAnnuaire && e.nature === "identifiants") {
          sortie.push(null);
          continue;
        }
        throw e;
      }
      sortie.push(typeof trouve === "string" ? null : await proposer(dep, f, cnx, trouve));
    }
    return sortie;
  });
  const items = lignes.map((l, i) => ({
    user_id: Number(l.id),
    username: String(l.username),
    role: roleDe(l.is_admin),
    last_login_at: Number(l.last_login_at ?? 0) > 0 ? Number(l.last_login_at) : null,
    suspended: Number(l.suspended_at ?? 0) !== 0,
    proposal: propositions[i] ?? null,
  }));
  return { items, total };
}

/** Entrées dont l'identifiant ou l'e-mail est égal à la requête, ou dont le nom affiché commence par elle (jokers écrits ici, jamais pris de la saisie). */
export async function chercherEntrees(
  dep: DependancesAnnuaire,
  f: FournisseurLdap,
  requete: string,
): Promise<Proposition[]> {
  const prefixe = `${filtreEgal(f.attrs.name, requete).slice(0, -1)}*)`;
  const filtre = `(|${filtreEgal(f.attrs.username, requete)}${filtreEgal(f.attrs.email, requete)}${prefixe})`;
  return avecService(dep, f, async (cnx) => {
    const trouvees = await cnx.chercher(f.user_base_dn, {
      portee: "sub",
      filtre,
      attributs: attributsUtilisateur(f),
      limite: RECHERCHE_MAX,
    });
    const sortie: Proposition[] = [];
    for (const e of trouvees.slice(0, RECHERCHE_MAX)) {
      const p = await proposer(dep, f, cnx, e);
      if (p !== null) sortie.push(p);
    }
    return sortie;
  });
}

export interface LienDemande {
  readonly user_id: number;
  readonly subject: string;
}

export interface OperateurRattachement {
  readonly id: number;
  readonly username: string | null;
  readonly ip: string | null;
}

/** Contrôles propres à l'entrée relue : état actif et groupe requis. */
async function controlerEntree(
  dep: DependancesAnnuaire,
  f: FournisseurLdap,
  cnx: ConnexionAnnuaire,
  entree: EntreeAnnuaire,
): Promise<RaisonLien | null> {
  if (etatEntree(entree, f, dep.maintenant() * 1000) !== "active") return "entry_not_active";
  const groupes = await appartenance(cnx, f, entree);
  if (groupes === "non") return "not_in_group";
  return groupes === "inconnu" ? "groups_unknown" : null;
}

/** Rattache chaque lien indépendamment des autres : entrée relue par sa clé stable et retrouvée par le chemin de la connexion, puis une écriture unique par compte qui revérifie l'annuaire actif et son ancre ; un refus n'arrête rien et laisse une ligne d'audit en échec. */
export async function rattacherComptes(
  dep: DependancesAnnuaire & {
    readonly revoquer: (uid: number) => Promise<unknown>;
    readonly acces: Pick<DependancesProvisionnement, "acces">["acces"];
  },
  f: FournisseurLdap,
  liens: readonly LienDemande[],
  confirmeAdmins: ReadonlySet<number>,
  operateur: OperateurRattachement,
  options: { readonly garderJetons?: boolean } = {},
): Promise<ResultatLien[]> {
  const ancre = ancreIdentite(f);
  const comptesVus = new Set<number>();
  const clesVues = new Set<string>();
  const resultats: ResultatLien[] = [];
  const par = `admin:${operateur.id}`;
  const garder = options.garderJetons === true;
  let indisponible = false;
  await avecService(dep, f, async (cnx) => {
    for (const lien of liens) {
      const fin = (result: ResultatLien["result"], plus: Partial<ResultatLien> = {}): void => {
        resultats.push({ ...lien, result, ...plus });
        if (result !== "linked")
          auditEvent({
            userId: operateur.id,
            username: operateur.username,
            action: "auth.identity.link",
            ip: operateur.ip,
            outcome: "failure",
            details: { target_user_id: lien.user_id, provider_id: f.id, by: par, reason: result },
          });
      };
      if (comptesVus.has(lien.user_id) || clesVues.has(lien.subject)) {
        fin("duplicate");
        continue;
      }
      comptesVus.add(lien.user_id);
      clesVues.add(lien.subject);
      if (indisponible) {
        fin("directory_unavailable");
        continue;
      }
      let entree: EntreeAnnuaire;
      try {
        const lue = await lireParCle(cnx, f, lien.subject);
        if (lue.type !== "entree") {
          fin(lue.type === "ambigue" ? "entry_ambiguous" : "entry_not_found");
          continue;
        }
        entree = lue.entree;
        const refus = await controlerEntree(dep, f, cnx, entree);
        if (refus !== null) {
          fin(refus);
          continue;
        }
        if (!(await connectable(cnx, f, entree, lien.subject))) {
          fin("entry_not_loginable");
          continue;
        }
      } catch (e) {
        if (!(e instanceof ErreurAnnuaire)) throw e;
        dep.journal.warn(`annuaire ${f.id} : rattachement, ${e.nature}`);
        fin("directory_unavailable");
        continue;
      }
      const externe = profilExterne(entree, f);
      const issue = await dep.base.ecriture(async (x) => {
        const actif = (await annuairesActifs(dep)).find((a) => a.id === f.id);
        if (actif === undefined || ancreIdentite(actif) !== ancre) return "directory_unavailable" as const;
        const obstacle = await rattacher(
          x,
          lien.user_id,
          {
            fournisseurId: f.id,
            subject: lien.subject,
            issuer: ancre,
            extUsername: externe.identifiant,
            extEmail: externe.email,
            extName: externe.nom,
          },
          { par, confirmeAdmin: confirmeAdmins.has(lien.user_id), t: dep.maintenant() },
        );
        if (obstacle !== null) return obstacle;
        return { tokens: garder ? null : await supprimerJetonsDuCompte(x, lien.user_id) };
      });
      if (typeof issue === "string") {
        if (issue === "directory_unavailable") indisponible = true;
        fin(issue);
        continue;
      }
      const oauth = garder
        ? null
        : await revoquerOauthRattachement({ acces: dep.acces, journal: dep.journal }, lien.user_id);
      const jetons =
        issue.tokens === null || oauth === null ? ("kept" as const) : { tokens: issue.tokens, oauth };
      fin(
        "linked",
        jetons === "kept" ? { kept: true } : { revoked_tokens: jetons.tokens, revoked_oauth: jetons.oauth },
      );
      const nom = await dep.base.get<{ username: string }>("SELECT username FROM users WHERE id=?", [
        lien.user_id,
      ]);
      auditerRattachement(
        {
          uid: lien.user_id,
          username: nom?.username ?? null,
          fournisseurId: f.id,
          par,
          methode: "assistant",
          subject: lien.subject,
          acteur: operateur,
          jetons,
        },
        operateur.ip,
      );
      try {
        await dep.revoquer(lien.user_id);
      } catch (e) {
        dep.journal.error({ err: e }, "[admin] publication session_revoked (rattachement) échouée");
      }
    }
  });
  return resultats;
}

/** Vrai si la connexion retrouve cette entrée (même clé stable) avec l'identifiant qu'elle taperait. */
async function connectable(
  cnx: ConnexionAnnuaire,
  f: FournisseurLdap,
  entree: EntreeAnnuaire,
  subject: string,
): Promise<boolean> {
  const cle = cleIdentifiant(profilExterne(entree, f).identifiant);
  if (cle === null) return false;
  const trouve = await chercherUtilisateur(cnx, f, cle);
  if (typeof trouve === "string") return false;
  try {
    return cleStable(trouve, f) === subject;
  } catch (e) {
    if (e instanceof ErreurAnnuaire && e.nature === "configuration") return false;
    throw e;
  }
}
