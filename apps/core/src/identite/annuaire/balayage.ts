// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/balayage.ts — balayage d'un annuaire : chaque identité relue par sa clé stable, départ suspendu, retour réactivé, vérification rafraîchie ; une panne ou une réponse illisible n'est jamais un départ. */
import { join } from "node:path";

import { compteSuspendu } from "@elpis/auth";
import type { Base } from "@elpis/db";
import { auditEvent } from "@elpis/securite";
import { VerrouFichier } from "@elpis/verrous";

import { poserReactivation, suspendre } from "../../comptes/etat";
import type { DependancesEtat } from "../../comptes/etat";
import type { Journal } from "../../journal";
import { ancreIdentite } from "../ancre";
import { secretFournisseur } from "../fournisseurs";
import type { FournisseurLdap } from "../reglages";
import type { EntreeAnnuaire, FabriqueConnexion } from "./client";
import { appartenance, ouvrirService } from "./connexion";
import { attributsUtilisateur, cleStable, etatEntree } from "./entree";
import { ErreurAnnuaire } from "./erreur";
import { filtreEgal } from "./filtre";
import { groupeExiste } from "./appartenance";

export const LOT_RECHERCHES = 50;
export const DELAI_PASSE_MS = 300_000;
export const SEUIL_MASSE_MIN = 3;
const MASSE_PART = 5;

export type RaisonAbandon =
  | "secret_missing"
  | "directory_unreachable"
  | "bind_failed"
  | "directory_config"
  | "directory_error"
  | "group_missing"
  | "group_unreadable"
  | "timeout"
  | "internal";

export type RaisonDepart = "entry_missing" | "entry_disabled" | "not_in_group";

/** État de la dernière passe d'un annuaire, tel que rangé et rendu à la console. */
export interface EtatBalayage {
  /** Instant de la passe, en secondes. */
  readonly at: number;
  /** Identités relues avec une réponse lisible. */
  readonly seen: number;
  readonly suspended: number;
  readonly reactivated: number;
  /** Identités laissées telles quelles faute de réponse lisible. */
  readonly unknown: number;
  readonly aborted: RaisonAbandon | null;
  /** Suspensions retenues par le garde-fou de masse, en attente de confirmation. */
  readonly pending: number;
}

export interface DependancesBalayage {
  readonly base: Base;
  readonly fabrique: FabriqueConnexion;
  /** Secondes. */
  readonly maintenant: () => number;
  readonly cookieSecure: () => boolean;
  readonly journal: Journal;
  readonly etat: DependancesEtat;
  /** Fichier du verrou inter-processus d'un fournisseur. */
  readonly cheminVerrou?: (id: string) => string;
  readonly delaiMs?: number;
}

export type IssueBalayage =
  | { readonly type: "bilan"; readonly etat: EtatBalayage }
  | { readonly type: "occupe" }
  | { readonly type: "decompte_change"; readonly trouve: number };

type LigneIdentite = {
  id: number;
  user_id: number;
  subject: string;
  issuer: string;
  username: string;
  suspended_at: unknown;
  suspended_by: string | null;
};

type Verdict =
  | { readonly type: "actif" }
  | { readonly type: "present" }
  | { readonly type: "parti"; readonly raison: RaisonDepart }
  | { readonly type: "inconnu" };

const CLES_ETAT = ["at", "seen", "suspended", "reactivated", "unknown", "aborted", "pending"] as const;

/** Chemin par défaut du verrou : sous le dossier d'exécution commun aux process. */
export function cheminVerrouBalayage(id: string): string {
  return join(process.env["ELPIS_RUNTIME_DIR"] || "/tmp", `.elpis_auth_sweep_${id}.lock`);
}

/** Seuil du garde-fou : au moins 3 départs ET plus de 20 % des identités de l'annuaire. */
export function departsEnMasse(departs: number, identites: number): boolean {
  return departs >= SEUIL_MASSE_MIN && departs * MASSE_PART > identites;
}

function lireEtat(brut: unknown, at: unknown): EtatBalayage | null {
  if (typeof brut !== "string") return null;
  try {
    const o = JSON.parse(brut) as Record<string, unknown>;
    const nombres = CLES_ETAT.filter((k) => k !== "at" && k !== "aborted").every(
      (k) => typeof o[k] === "number" && Number.isFinite(o[k]),
    );
    const a = o["aborted"];
    if (!nombres || (a !== null && typeof a !== "string")) return null;
    return {
      at: Number(at),
      seen: o["seen"] as number,
      suspended: o["suspended"] as number,
      reactivated: o["reactivated"] as number,
      unknown: o["unknown"] as number,
      aborted: a as RaisonAbandon | null,
      pending: o["pending"] as number,
    };
  } catch {
    return null;
  }
}

/** Dernière passe rangée pour ce fournisseur, `null` s'il n'y en a pas ou si elle ne se lit pas. */
export async function etatBalayage(
  x: Pick<Base, "get">,
  fournisseurId: string,
): Promise<EtatBalayage | null> {
  const l = await x.get<{ sweep_at: unknown; sweep_result: unknown }>(
    "SELECT sweep_at, sweep_result FROM auth_provider_state WHERE provider_id=?",
    [fournisseurId],
  );
  return l === undefined ? null : lireEtat(l.sweep_result, l.sweep_at);
}

async function ranger(base: Base, id: string, e: EtatBalayage): Promise<void> {
  const { at, ...reste } = e;
  await base.run(
    "INSERT INTO auth_provider_state(provider_id, sweep_at, sweep_result) VALUES(?,?,?) " +
      "ON CONFLICT(provider_id) DO UPDATE SET sweep_at=excluded.sweep_at, sweep_result=excluded.sweep_result",
    [id, at, JSON.stringify(reste)],
  );
}

function raisonDeErreur(e: ErreurAnnuaire): RaisonAbandon {
  if (e.nature === "injoignable") return "directory_unreachable";
  if (e.nature === "identifiants") return "bind_failed";
  return e.nature === "configuration" ? "directory_config" : "directory_error";
}

/** Entrée de la clé stable de l'identité : l'entrée, `"absent"`, ou `"illisible"` (réponse ambiguë ou clé qui ne correspond pas). */
async function chercherParCle(
  cnx: Parameters<typeof appartenance>[0],
  f: FournisseurLdap,
  sujet: string,
): Promise<EntreeAnnuaire | "absent" | "illisible"> {
  const binaire = f.attrs.id.toLowerCase() === "objectguid";
  const valeur = binaire ? Buffer.from(sujet, "hex") : sujet;
  const trouvees = await cnx.chercher(f.user_base_dn, {
    portee: "sub",
    filtre: filtreEgal(f.attrs.id, valeur),
    attributs: attributsUtilisateur(f),
    limite: 2,
  });
  if (trouvees.length === 0) return "absent";
  const [premiere] = trouvees;
  if (trouvees.length !== 1 || premiere === undefined) return "illisible";
  try {
    return cleStable(premiere, f) === sujet ? premiere : "illisible";
  } catch (e) {
    if (e instanceof ErreurAnnuaire) return "illisible";
    throw e;
  }
}

async function juger(
  cnx: Parameters<typeof appartenance>[0],
  f: FournisseurLdap,
  ligne: LigneIdentite,
  maintenantMs: number,
): Promise<Verdict> {
  const entree = await chercherParCle(cnx, f, ligne.subject);
  if (entree === "illisible") return { type: "inconnu" };
  if (entree === "absent") return { type: "parti", raison: "entry_missing" };
  const etat = etatEntree(entree, f, maintenantMs);
  if (etat === "inconnu") return { type: "inconnu" };
  if (etat === "desactivee") return { type: "parti", raison: "entry_disabled" };
  const groupes = await appartenance(cnx, f, entree);
  if (groupes === "inconnu") return { type: "inconnu" };
  if (groupes === "non") return { type: "parti", raison: "not_in_group" };
  return { type: etat === "active" ? "actif" : "present" };
}

interface Analyse {
  vus: number;
  inconnus: number;
  /** Identités dont l'entrée est présente (checked_at à rafraîchir). */
  presents: LigneIdentite[];
  /** Parmi elles, entrées actives dans un groupe (réactivation possible). */
  actifs: LigneIdentite[];
  departs: { ligne: LigneIdentite; raison: RaisonDepart }[];
}

class Abandon extends Error {
  readonly raison: RaisonAbandon;
  constructor(raison: RaisonAbandon) {
    super(raison);
    this.raison = raison;
  }
}

async function analyser(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  identites: readonly LigneIdentite[],
  secret: string,
): Promise<Analyse> {
  const { cnx } = await ouvrirService(dep, f, secret).catch((e: unknown) => {
    if (e instanceof ErreurAnnuaire) throw new Abandon(raisonDeErreur(e));
    throw e;
  });
  try {
    for (const g of f.required_groups) {
      try {
        if (!(await groupeExiste(cnx, g))) throw new Abandon("group_missing");
      } catch (e) {
        if (e instanceof ErreurAnnuaire) throw new Abandon("group_unreadable");
        throw e;
      }
    }
    const fin = performance.now() + (dep.delaiMs ?? DELAI_PASSE_MS);
    const ancre = ancreIdentite(f);
    const a: Analyse = { vus: 0, inconnus: 0, presents: [], actifs: [], departs: [] };
    for (let i = 0; i < identites.length; i += LOT_RECHERCHES) {
      if (performance.now() > fin) throw new Abandon("timeout");
      for (const ligne of identites.slice(i, i + LOT_RECHERCHES)) {
        if (ligne.issuer !== ancre) {
          a.inconnus++;
          continue;
        }
        let v: Verdict;
        try {
          v = await juger(cnx, f, ligne, dep.maintenant() * 1000);
        } catch (e) {
          if (!(e instanceof ErreurAnnuaire)) throw e;
          if (e.nature === "injoignable") throw new Abandon("directory_unreachable");
          v = { type: "inconnu" };
        }
        if (v.type === "inconnu") a.inconnus++;
        else a.vus++;
        if (v.type === "actif" || v.type === "present") a.presents.push(ligne);
        if (v.type === "actif") a.actifs.push(ligne);
        if (v.type === "parti") a.departs.push({ ligne, raison: v.raison });
      }
    }
    return a;
  } finally {
    await cnx.fermer();
  }
}

function auditer(
  action: string,
  ligne: LigneIdentite,
  f: FournisseurLdap,
  details: Record<string, unknown>,
): void {
  auditEvent({
    userId: Number(ligne.user_id),
    username: ligne.username,
    action,
    details: { target_user_id: Number(ligne.user_id), provider_id: f.id, ...details },
  });
}

/** Comptes réactivés : suspendus par CET annuaire (relu dans l'écriture), les anciennes sessions restent mortes. */
async function reactiver(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  lignes: readonly LigneIdentite[],
): Promise<number> {
  const origines = [`directory:${f.id}`, `stale:${f.id}`];
  let n = 0;
  for (const ligne of lignes) {
    if (!compteSuspendu(ligne) || !origines.includes(String(ligne.suspended_by))) continue;
    const t = dep.maintenant();
    const levee = await dep.base.ecriture(async (x) => {
      const l = await x.get<{ suspended_by: string | null }>("SELECT suspended_by FROM users WHERE id=?", [
        ligne.user_id,
      ]);
      if (l === undefined || !origines.includes(String(l.suspended_by))) return null;
      return (await poserReactivation(x, Number(ligne.user_id), t)) ? String(l.suspended_by) : null;
    });
    if (levee === null) continue;
    n++;
    auditer("auth.account.reactivate", ligne, f, { origin: levee });
  }
  return n;
}

async function suspendreDeparts(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  departs: Analyse["departs"],
): Promise<number> {
  const origine = `directory:${f.id}`;
  let n = 0;
  for (const { ligne, raison } of departs) {
    try {
      const bilan = await suspendre(
        { ...dep.etat, maintenant: dep.maintenant },
        Number(ligne.user_id),
        origine,
      );
      if (!bilan.change) continue;
      n++;
      auditer("auth.account.suspend", ligne, f, { origin: origine, reason: raison });
    } catch (e) {
      dep.journal.warn({ err: e }, `annuaire ${f.id} : suspension d'un compte sorti non posée`);
    }
  }
  return n;
}

function signaler(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  avant: EtatBalayage | null,
  e: EtatBalayage,
): void {
  const alerte = e.aborted !== null || e.pending > 0;
  if (!alerte || (avant?.aborted === e.aborted && avant?.pending === e.pending)) return;
  dep.journal.warn(
    e.aborted !== null
      ? `annuaire ${f.id} : passe abandonnée (${e.aborted}), rien n'a été modifié`
      : `annuaire ${f.id} : ${e.pending} suspensions retenues par le garde-fou, confirmation de l'administrateur attendue`,
  );
  auditEvent({
    userId: null,
    username: null,
    action: "auth.sweep.alert",
    outcome: "failure",
    details: { provider_id: f.id, reason: e.aborted ?? "mass_departure", pending: e.pending },
  });
}

async function identitesDe(dep: DependancesBalayage, f: FournisseurLdap): Promise<LigneIdentite[]> {
  return dep.base.all<LigneIdentite>(
    "SELECT i.id, i.user_id, i.subject, i.issuer, u.username, u.suspended_at, u.suspended_by " +
      "FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider_id=? ORDER BY i.id",
    [f.id],
  );
}

async function passe(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  confirmer: number | undefined,
): Promise<IssueBalayage> {
  const at = dep.maintenant();
  const avant = await etatBalayage(dep.base, f.id);
  const vide = { at, seen: 0, suspended: 0, reactivated: 0, unknown: 0, pending: 0 };
  const termine = async (e: EtatBalayage): Promise<IssueBalayage> => {
    await ranger(dep.base, f.id, e);
    signaler(dep, f, avant, e);
    return { type: "bilan", etat: e };
  };
  const secret = await secretFournisseur(dep.base, f);
  if (secret === null) return termine({ ...vide, aborted: "secret_missing" });
  const identites = await identitesDe(dep, f);
  let a: Analyse;
  try {
    a = await analyser(dep, f, identites, secret);
  } catch (e) {
    if (e instanceof Abandon) return termine({ ...vide, aborted: e.raison });
    dep.journal.warn({ err: e }, `annuaire ${f.id} : passe interrompue par une erreur interne`);
    return termine({ ...vide, aborted: "internal" });
  }
  const departs = a.departs.filter(({ ligne }) => !compteSuspendu(ligne));
  if (confirmer !== undefined && confirmer !== departs.length)
    return { type: "decompte_change", trouve: departs.length };
  const retenus = confirmer === undefined && departsEnMasse(departs.length, identites.length);
  const maj = a.presents.map((l) => l.id);
  if (maj.length > 0)
    await dep.base.ecriture(async (x) => {
      for (const id of maj) await x.run("UPDATE user_identities SET checked_at=? WHERE id=?", [at, id]);
    });
  const reactives = await reactiver(dep, f, a.actifs);
  const suspendus = retenus ? 0 : await suspendreDeparts(dep, f, departs);
  return termine({
    at,
    seen: a.vus,
    suspended: suspendus,
    reactivated: reactives,
    unknown: a.inconnus,
    aborted: null,
    pending: retenus ? departs.length : 0,
  });
}

/** Une passe sur cet annuaire sous son verrou inter-processus ; `confirmer` accepte le dépassement du garde-fou pour ce décompte exactement. */
export async function balayerAnnuaire(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  options: { readonly confirmer?: number } = {},
): Promise<IssueBalayage> {
  const verrou = new VerrouFichier((dep.cheminVerrou ?? cheminVerrouBalayage)(f.id), { battement: true });
  if (!(await verrou.essayer())) return { type: "occupe" };
  try {
    return await passe(dep, f, options.confirmer);
  } finally {
    await verrou.rendre();
  }
}
