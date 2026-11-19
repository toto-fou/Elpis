// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/balayage.ts — balayage d'un annuaire : chaque identité relue par sa clé stable, départ suspendu, retour réactivé, vérification rafraîchie ; une panne ou une réponse illisible n'est jamais un départ. */
import { lstatSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { compteSuspendu, revoquerTousAcces } from "@elpis/auth";
import { config } from "@elpis/config";
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
import { filtreEgal, filtrePresence } from "./filtre";
import { groupeAMembreVisible, groupeExiste } from "./appartenance";

export const LOT_RECHERCHES = 50;
export const DELAI_PASSE_MS = 300_000;
export const SEUIL_MASSE_MIN = 3;
const MASSE_PART = 5;
/** Durée d'une suspension d'annuaire sans interruption après laquelle les jetons d'API et accès OAuth du compte sont supprimés, en secondes. */
export const DUREE_AVANT_REVOCATION_S = 7 * 86_400;
export const RETENUS_MAX = 200;
export const DELAI_VERROU_MS = 10_000;

export type RaisonAbandon =
  | "secret_missing"
  | "directory_unreachable"
  | "bind_failed"
  | "directory_config"
  | "directory_error"
  | "group_missing"
  | "group_unreadable"
  | "users_unreadable"
  | "membership_unreadable"
  | "timeout"
  | "internal";

export type RaisonDepart = "entry_missing" | "entry_disabled" | "not_in_group";

/** Compte retenu en attente de confirmation. */
export interface DepartRetenu {
  readonly user_id: number;
  readonly username: string;
  readonly reason: RaisonDepart;
}

/** Départ vu par une passe aboutie, en attente d'une seconde observation. */
export interface DepartObserve {
  readonly user_id: number;
  readonly reason: RaisonDepart;
}

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
  /** Suspensions retenues (garde-fou de masse, annuaire sans aucun présent), en attente de confirmation. */
  readonly pending: number;
  /** Comptes retenus (200 au plus, par identifiant croissant) ; la confirmation porte sur cette liste. */
  readonly held: readonly DepartRetenu[];
  readonly held_total: number;
  /** Départs vus par la dernière passe aboutie, suspendus si la suivante les voit encore. */
  readonly observed: readonly DepartObserve[];
  /** Instant de la dernière passe aboutie (secondes), `null` s'il n'y en a pas. */
  readonly ok_at: number | null;
}

export interface DependancesBalayage {
  readonly base: Base;
  readonly fabrique: FabriqueConnexion;
  /** Secondes. */
  readonly maintenant: () => number;
  readonly cookieSecure: () => boolean;
  readonly journal: Journal;
  readonly etat: DependancesEtat;
  /** Fichier du verrou inter-processus d'un fournisseur ; lève si son dossier est inutilisable. */
  readonly cheminVerrou?: (id: string) => string;
  readonly delaiMs?: number;
  /** Durée maximale de la prise du verrou, en millisecondes. */
  readonly delaiVerrouMs?: number;
}

export type IssueBalayage =
  | { readonly type: "bilan"; readonly etat: EtatBalayage }
  | { readonly type: "occupe" }
  | { readonly type: "verrou_indisponible" }
  | { readonly type: "decompte_change"; readonly etat: EtatBalayage };

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

const CLES_ETAT = ["seen", "suspended", "reactivated", "unknown", "pending"] as const;
const MODE_PRIVE = 0o700;

/** Chemin du verrou d'un fournisseur dans un dossier privé (0700) sous le dossier de données de l'instance, créé au besoin ; lève s'il n'est pas à nous ou s'il n'est pas privé. */
export function cheminVerrouBalayage(
  id: string,
  donnees: string = join(config.PROJECT_ROOT, "user_db"),
): string {
  const dossier = join(donnees, ".verrous");
  mkdirSync(dossier, { recursive: true, mode: MODE_PRIVE });
  const st = lstatSync(dossier);
  if (!st.isDirectory() || (process.getuid !== undefined && st.uid !== process.getuid()))
    throw new Error("dossier des verrous inutilisable");
  if ((st.mode & 0o077) !== 0) chmodSync(dossier, MODE_PRIVE);
  return join(dossier, `.elpis_auth_sweep_${id}.lock`);
}

/** Seuil du garde-fou : au moins 3 départs ET plus de 20 % des identités non suspendues de l'annuaire ; tous les départs retenus si c'est la totalité d'entre elles. */
export function departsEnMasse(departs: number, identites: number): boolean {
  return (
    (departs >= SEUIL_MASSE_MIN && departs * MASSE_PART > identites) || (departs > 0 && departs >= identites)
  );
}

const RAISONS_DEPART: readonly string[] = ["entry_missing", "entry_disabled", "not_in_group"];

function entierPositif(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function lireRetenus(v: unknown): DepartRetenu[] {
  if (!Array.isArray(v)) return [];
  const r: DepartRetenu[] = [];
  for (const x of v as Record<string, unknown>[]) {
    if (
      x !== null &&
      typeof x === "object" &&
      entierPositif(x["user_id"]) &&
      typeof x["username"] === "string"
    )
      if (typeof x["reason"] === "string" && RAISONS_DEPART.includes(x["reason"]))
        r.push({ user_id: x["user_id"], username: x["username"], reason: x["reason"] as RaisonDepart });
  }
  return r;
}

function lireObserves(v: unknown): DepartObserve[] {
  if (!Array.isArray(v)) return [];
  const r: DepartObserve[] = [];
  for (const x of v as Record<string, unknown>[])
    if (x !== null && typeof x === "object" && entierPositif(x["user_id"]))
      if (typeof x["reason"] === "string" && RAISONS_DEPART.includes(x["reason"]))
        r.push({ user_id: x["user_id"], reason: x["reason"] as RaisonDepart });
  return r;
}

function lireEtat(brut: unknown, at: unknown): EtatBalayage | null {
  if (typeof brut !== "string") return null;
  try {
    const o = JSON.parse(brut) as Record<string, unknown>;
    const nombres = CLES_ETAT.every((k) => typeof o[k] === "number" && Number.isFinite(o[k]));
    const a = o["aborted"];
    if (!nombres || (a !== null && typeof a !== "string")) return null;
    const held = lireRetenus(o["held"]);
    const ok = o["ok_at"];
    return {
      at: Number(at),
      seen: o["seen"] as number,
      suspended: o["suspended"] as number,
      reactivated: o["reactivated"] as number,
      unknown: o["unknown"] as number,
      aborted: a as RaisonAbandon | null,
      pending: o["pending"] as number,
      held,
      held_total: typeof o["held_total"] === "number" ? (o["held_total"] as number) : held.length,
      observed: lireObserves(o["observed"]),
      ok_at: typeof ok === "number" && Number.isFinite(ok) ? ok : a === null ? Number(at) : null,
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
    sansLimiteServeur: true,
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

/** Entrées et appartenance lisibles par le compte de service, avant de juger un départ : une perte de droits rend « succès, aucune entrée ». */
async function verifierCanaris(cnx: Parameters<typeof appartenance>[0], f: FournisseurLdap): Promise<void> {
  const lire = async (raison: RaisonAbandon, preuve: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await preuve();
    } catch (e) {
      if (!(e instanceof ErreurAnnuaire)) throw e;
      throw new Abandon(e.nature === "injoignable" ? "directory_unreachable" : raison);
    }
  };
  const entrees = await lire("users_unreadable", async () => {
    const r = await cnx.chercher(f.user_base_dn, {
      portee: "sub",
      filtre: filtrePresence(f.attrs.id),
      attributs: [f.attrs.id],
      limite: 1,
    });
    return r.length > 0;
  });
  if (!entrees) throw new Abandon("users_unreadable");
  let membre = false;
  for (const g of f.required_groups)
    if (await lire("membership_unreadable", () => groupeAMembreVisible(cnx, f, g))) membre = true;
  if (!membre) throw new Abandon("membership_unreadable");
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
    if (identites.some((l) => l.issuer === ancreIdentite(f))) await verifierCanaris(cnx, f);
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

/** Suspension d'annuaire : sessions, flux et bac coupés tout de suite, jetons d'API et accès OAuth gardés (déjà refusés) ; rend les comptes dont la pose a échoué. */
async function suspendreDeparts(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  departs: Analyse["departs"],
): Promise<{ n: number; echoues: Analyse["departs"] }> {
  const origine = `directory:${f.id}`;
  let n = 0;
  const echoues: Analyse["departs"] = [];
  for (const d of departs) {
    try {
      const bilan = await suspendre(
        { ...dep.etat, maintenant: dep.maintenant },
        Number(d.ligne.user_id),
        origine,
        { revoquerAcces: false },
      );
      if (!bilan.change) continue;
      n++;
      auditer("auth.account.suspend", d.ligne, f, { origin: origine, reason: d.raison });
    } catch (e) {
      echoues.push(d);
      dep.journal.warn({ err: e }, `annuaire ${f.id} : suspension d'un compte sorti non posée`);
    }
  }
  return { n, echoues };
}

/** Jetons d'API et accès OAuth supprimés pour les comptes suspendus par cet annuaire depuis plus de 7 jours et toujours partis. */
async function revoquerAnciens(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  departs: Analyse["departs"],
  at: number,
): Promise<void> {
  const origine = `directory:${f.id}`;
  for (const { ligne } of departs) {
    const depuis = Number(ligne.suspended_at);
    if (
      ligne.suspended_by !== origine ||
      !compteSuspendu(ligne) ||
      !(depuis <= at - DUREE_AVANT_REVOCATION_S)
    )
      continue;
    try {
      const r = await revoquerTousAcces(dep.etat.acces, Number(ligne.user_id));
      if (r.tokens + r.oauth > 0)
        auditer("auth.account.access_revoke", ligne, f, {
          origin: origine,
          tokens_revoked: r.tokens,
          oauth_revoked: r.oauth,
        });
    } catch (e) {
      dep.journal.warn({ err: e }, `annuaire ${f.id} : révocation des accès d'un compte sorti non posée`);
    }
  }
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

const lignesRetenues = (departs: Analyse["departs"]): DepartRetenu[] =>
  departs
    .map(({ ligne, raison }) => ({
      user_id: Number(ligne.user_id),
      username: String(ligne.username),
      reason: raison,
    }))
    .sort((x, y) => x.user_id - y.user_id)
    .slice(0, RETENUS_MAX);

/** La confirmation porte sur des comptes vus dans la liste rangée et encore partis ; sans troncature, sur exactement l'ensemble des partis. */
function confirmationAcceptee(
  confirmes: readonly number[],
  avant: EtatBalayage | null,
  partis: ReadonlySet<number>,
): boolean {
  const vus = new Set(avant?.held.map((h) => h.user_id));
  const tronque = (avant?.held_total ?? 0) > (avant?.held.length ?? 0);
  if (confirmes.length === 0 || !confirmes.every((id) => vus.has(id) && partis.has(id))) return false;
  return tronque || confirmes.length === partis.size;
}

async function passe(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  confirmes: readonly number[] | undefined,
): Promise<IssueBalayage> {
  const at = dep.maintenant();
  const avant = await etatBalayage(dep.base, f.id);
  const reprise = { observed: avant?.observed ?? [], ok_at: avant?.ok_at ?? null };
  const vide = { at, seen: 0, suspended: 0, reactivated: 0, unknown: 0, pending: 0, held: [], held_total: 0 };
  const termine = async (e: EtatBalayage): Promise<EtatBalayage> => {
    await ranger(dep.base, f.id, e);
    signaler(dep, f, avant, e);
    return e;
  };
  const abandon = async (raison: RaisonAbandon): Promise<IssueBalayage> => ({
    type: "bilan",
    etat: await termine({ ...vide, ...reprise, aborted: raison }),
  });
  const secret = await secretFournisseur(dep.base, f);
  if (secret === null) return abandon("secret_missing");
  const identites = await identitesDe(dep, f);
  let a: Analyse;
  try {
    a = await analyser(dep, f, identites, secret);
  } catch (e) {
    if (e instanceof Abandon) return abandon(e.raison);
    dep.journal.warn({ err: e }, `annuaire ${f.id} : passe interrompue par une erreur interne`);
    return abandon("internal");
  }
  const ancre = ancreIdentite(f);
  const denominateur = identites.filter((l) => l.issuer === ancre && !compteSuspendu(l)).length;
  const departs = a.departs.filter(({ ligne }) => !compteSuspendu(ligne));
  const partis = new Set(departs.map((d) => Number(d.ligne.user_id)));
  const confirmation = confirmes !== undefined && confirmationAcceptee(confirmes, avant, partis);
  const retenus =
    departs.length > 0 &&
    (confirmes !== undefined
      ? !confirmation
      : a.presents.length === 0 || departsEnMasse(departs.length, denominateur));
  const maj = a.presents.map((l) => l.id);
  if (maj.length > 0)
    await dep.base.ecriture(async (x) => {
      for (const id of maj) await x.run("UPDATE user_identities SET checked_at=? WHERE id=?", [at, id]);
    });
  const reactives = await reactiver(dep, f, a.actifs);
  const dejaVus = new Set(avant?.observed.map((o) => o.user_id));
  const aSuspendre = retenus
    ? []
    : departs.filter((d) => {
        const id = Number(d.ligne.user_id);
        return confirmation ? (confirmes ?? []).includes(id) : dejaVus.has(id);
      });
  const { n: suspendus, echoues } = await suspendreDeparts(dep, f, aSuspendre);
  if (!retenus) await revoquerAnciens(dep, f, a.departs, at);
  const suspendusIds = new Set(aSuspendre.map((d) => Number(d.ligne.user_id)));
  const restants = departs.filter((d) => !suspendusIds.has(Number(d.ligne.user_id)) || echoues.includes(d));
  const attente = retenus || confirmation ? restants : [];
  const observes = retenus || confirmation ? [] : restants;
  const etat = await termine({
    at,
    seen: a.vus,
    suspended: suspendus,
    reactivated: reactives,
    unknown: a.inconnus,
    aborted: null,
    pending: attente.length,
    held: lignesRetenues(attente),
    held_total: attente.length,
    observed: observes
      .map((d) => ({ user_id: Number(d.ligne.user_id), reason: d.raison }))
      .sort((x, y) => x.user_id - y.user_id),
    ok_at: at,
  });
  return confirmes !== undefined && !confirmation
    ? { type: "decompte_change", etat }
    : { type: "bilan", etat };
}

/** Prise du verrou bornée dans le temps : une prise qui ne rend pas la main est relâchée si elle aboutit plus tard. */
async function prendre(verrou: VerrouFichier, delaiMs: number): Promise<"pris" | "occupe" | "indisponible"> {
  const essai = verrou.essayer().then(
    (pris) => (pris ? ("pris" as const) : ("occupe" as const)),
    () => "indisponible" as const,
  );
  let minuteur: NodeJS.Timeout | undefined;
  const delai = new Promise<"delai">((fin) => {
    minuteur = setTimeout(() => fin("delai"), delaiMs);
  });
  try {
    const r = await Promise.race([essai, delai]);
    if (r !== "delai") return r;
    void essai.then((x) => (x === "pris" ? verrou.rendre() : undefined)).catch(() => undefined);
    return "indisponible";
  } finally {
    clearTimeout(minuteur);
  }
}

/** Une passe sur cet annuaire sous son verrou inter-processus ; `confirmer` liste les comptes que l'administrateur a vus : seuls ceux qui sont encore partis sont suspendus, et rien si l'ensemble des partis a changé. */
export async function balayerAnnuaire(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  options: { readonly confirmer?: readonly number[] } = {},
): Promise<IssueBalayage> {
  let chemin: string;
  try {
    chemin = (dep.cheminVerrou ?? cheminVerrouBalayage)(f.id);
  } catch (e) {
    dep.journal.warn({ err: e }, `annuaire ${f.id} : dossier du verrou inutilisable, passe abandonnée`);
    return { type: "verrou_indisponible" };
  }
  const verrou = new VerrouFichier(chemin, { battement: true });
  const pris = await prendre(verrou, dep.delaiVerrouMs ?? DELAI_VERROU_MS);
  if (pris === "occupe") return { type: "occupe" };
  if (pris === "indisponible") {
    dep.journal.warn(`annuaire ${f.id} : verrou du balayage inutilisable, passe abandonnée`);
    return { type: "verrou_indisponible" };
  }
  try {
    return await passe(dep, f, options.confirmer);
  } finally {
    await verrou.rendre();
  }
}

const dernieresAlertes = new Map<string, number>();

/** Alerte (journal et audit, raison `stale`) quand la dernière passe aboutie d'un annuaire actif date de plus de deux intervalles ; une fois par passe aboutie. */
export async function alerterSiPerime(
  dep: DependancesBalayage,
  f: FournisseurLdap,
  intervalleMs: number,
): Promise<void> {
  const e = await etatBalayage(dep.base, f.id);
  if (e === null || e.ok_at === null) return;
  if (dep.maintenant() - e.ok_at <= (2 * intervalleMs) / 1000) {
    dernieresAlertes.delete(f.id);
    return;
  }
  if (dernieresAlertes.get(f.id) === e.ok_at) return;
  dernieresAlertes.set(f.id, e.ok_at);
  dep.journal.warn(`annuaire ${f.id} : aucune passe aboutie depuis plus de deux intervalles`);
  auditEvent({
    userId: null,
    username: null,
    action: "auth.sweep.alert",
    outcome: "failure",
    details: { provider_id: f.id, reason: "stale", last_ok_at: e.ok_at },
  });
}
