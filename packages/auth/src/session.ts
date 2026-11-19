// SPDX-License-Identifier: MIT
/** packages/auth/src/session.ts — session de requête (lue / modifiée comme `Session` de Starlette) et portes de validité de deps.py. */
import { floatPy, intPy, veritePy } from "@elpis/commun";
import { estTableAbsente } from "@elpis/db";

import { lire, sousObjet } from "./dict";
import { compteSuspendu } from "./etat-compte";

const CLES_RESERVEES: ReadonlySet<string> = new Set([
  "uid",
  "user",
  "user_id",
  "_sid",
  "_auth",
  "_login_ts",
  "_exp",
]);
const CLES_PROTOTYPE: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Copie sans prototype des données, clés de prototype écartées. */
function sansPrototype(donnees: Record<string, unknown>): Record<string, unknown> {
  const copie: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [cle, valeur] of Object.entries(donnees)) if (!CLES_PROTOTYPE.has(cle)) copie[cle] = valeur;
  return copie;
}

/** Porte d'écriture de l'identité : exportée ici, absente de l'index du paquet, réservée à ouverture.ts. */
export const ECRIRE_IDENTITE: unique symbol = Symbol("ecrireIdentite");

export class Session {
  #donnees: Record<string, unknown>;
  lue = false;
  modifiee = false;

  constructor(donnees: Record<string, unknown> = {}) {
    this.#donnees = sansPrototype(donnees);
  }

  get(cle: string): unknown {
    this.lue = true;
    return CLES_PROTOTYPE.has(cle) ? undefined : this.#donnees[cle];
  }

  set(cle: string, valeur: unknown): void {
    if (CLES_PROTOTYPE.has(cle)) throw new Error(`session key "${cle}" is not allowed`);
    if (CLES_RESERVEES.has(cle)) throw new Error(`session key "${cle}" is reserved to ouvrirSession`);
    this.lue = true;
    this.modifiee = true;
    this.#donnees[cle] = valeur;
  }

  [ECRIRE_IDENTITE](cle: string, valeur: unknown): void {
    this.lue = true;
    this.modifiee = true;
    this.#donnees[cle] = valeur;
  }

  vider(): void {
    this.lue = true;
    this.modifiee = true;
    this.#donnees = sansPrototype({});
  }

  get vide(): boolean {
    return Object.keys(this.#donnees).length === 0;
  }

  contenu(): Record<string, unknown> {
    return { ...this.#donnees };
  }
}

export interface LigneUtilisateur {
  id?: number;
  username?: string;
  is_admin?: number;
  must_change_pwd?: number;
  session_min_ts?: number | null;
  suspended_at?: number | null;
  [colonne: string]: unknown;
}

/** Ce que la revalidation d'un flux lit du compte : plancher de session et suspension. */
export interface EtatMinSession {
  min: number | null;
  suspended_at?: number | null;
  is_admin?: number | null;
}

/** Ce qu'une session porte hors de l'identité du flux : échéance figée et méthode de connexion. */
export interface MetaSession {
  exp?: unknown;
  auth?: unknown;
}

/** Échéance figée et méthode de connexion d'une session. */
export function metaSession(session: Session): MetaSession {
  return { exp: session.get("_exp"), auth: session.get("_auth") };
}

/** Faux si l'échéance figée à l'ouverture est dépassée ; absente (session d'avant) : pas de contrainte, illisible : refus. */
function echeanceRespectee(exp: unknown, maintenant: number): boolean {
  if (exp === undefined) return true;
  return typeof exp === "number" && Number.isFinite(exp) && maintenant <= exp;
}

export interface DependancesSession {
  config(): unknown;
  utilisateur(uid: number): Promise<LigneUtilisateur | null | undefined>;
  revoquee(sid: string): Promise<boolean>;
  maintenant(): number;
  /** Méthode de connexion de la session encore admise pour ce compte ; une erreur refuse la session. */
  sessionAdmise?(auth: unknown, ligne: LigneUtilisateur): boolean | Promise<boolean>;
}

function reglages(config: unknown): Record<string, unknown> {
  try {
    return sousObjet(sousObjet(config, "security"), "session");
  } catch {
    return {};
  }
}

/** `_session_validity_checks` : âge absolu, révocation globale, par compte, par `_sid`, inactivité ; vide la session sur refus. */
export async function validerSession(
  session: Session,
  uid: number,
  dep: DependancesSession,
): Promise<{ valide: boolean; ligne?: LigneUtilisateur }> {
  const cfg = reglages(dep.config());
  const maxAge = intPy(lire(cfg, "max_age_sec", 86400));
  const inactivite = intPy(lire(cfg, "idle_timeout_sec", 0));
  const minGlobal = floatPy(lire(cfg, "global_min_ts", 0.0));
  const refus = () => {
    session.vider();
    return { valide: false };
  };
  const login = session.get("_login_ts");
  if (!veritePy(login)) return refus();
  const loginTs = typeof login === "number" || typeof login === "boolean" ? Number(login) : NaN;
  if (Number.isNaN(loginTs)) return refus();
  const maintenant = dep.maintenant();
  if (maintenant - loginTs > maxAge) return refus();
  if (!echeanceRespectee(session.get("_exp"), maintenant)) return refus();
  if (minGlobal > 0 && loginTs < minGlobal) return refus();
  let ligne: LigneUtilisateur | null | undefined;
  try {
    ligne = await dep.utilisateur(uid);
    if (!ligne || compteSuspendu(ligne)) return refus();
    const minCompte = floatPy(veritePy(ligne.session_min_ts) ? ligne.session_min_ts : 0.0);
    if (minCompte > 0 && loginTs < minCompte) return refus();
    if (dep.sessionAdmise && !(await dep.sessionAdmise(session.get("_auth"), ligne))) return refus();
  } catch {
    return refus();
  }
  const sid = session.get("_sid");
  if (veritePy(sid)) {
    try {
      if (await dep.revoquee(String(sid))) return refus();
    } catch (e) {
      if (!estTableAbsente(e)) return refus();
    }
  }
  if (inactivite > 0) {
    const derniere = session.get("_last_activity_ts");
    const ecart = maintenant - (veritePy(derniere) ? Number(derniere) : loginTs);
    if (Number.isNaN(ecart) || ecart > inactivite) return refus();
    session.set("_last_activity_ts", maintenant);
  }
  return { valide: true, ligne };
}

/** Résultat du contrôle ; une panne transitoire ne refuse pas (fail-open des flux). */
async function refusSaufPanne(controle: () => Promise<boolean>): Promise<boolean> {
  try {
    return await controle();
  } catch {
    return false;
  }
}

/** `stream_session_still_valid` : revalidation d'un flux ouvert, sans inactivité ni écriture, et passante sur panne transitoire. */
export async function fluxEncoreValide(
  uid: number,
  loginTs: unknown,
  sid: unknown,
  dep: Omit<DependancesSession, "utilisateur"> & {
    sessionMinTs(uid: number): Promise<EtatMinSession | number | null | undefined>;
  },
  meta: MetaSession = {},
): Promise<boolean> {
  if (!veritePy(loginTs)) return false;
  let login: number;
  try {
    login = floatPy(loginTs);
  } catch {
    return false;
  }
  const cfg = reglages(dep.config());
  const maxAge = intPy(lire(cfg, "max_age_sec", 86400));
  const minGlobal = floatPy(lire(cfg, "global_min_ts", 0.0));
  const maintenant = dep.maintenant();
  if (maintenant - login > maxAge) return false;
  if (!echeanceRespectee(meta.exp, maintenant)) return false;
  if (minGlobal > 0 && login < minGlobal) return false;
  const compteRefuse = await refusSaufPanne(async () => {
    const etat = await dep.sessionMinTs(uid);
    if (etat === undefined) return true;
    if (typeof etat === "object" && etat !== null && compteSuspendu(etat)) return true;
    const min = typeof etat === "object" && etat !== null ? etat.min : etat;
    const m = floatPy(veritePy(min) ? min : 0.0);
    if (m > 0 && login < m) return true;
    if (!dep.sessionAdmise) return false;
    const ligne: LigneUtilisateur =
      typeof etat === "object" && etat !== null ? { is_admin: etat.is_admin ?? 0 } : {};
    return !(await dep.sessionAdmise(meta.auth, ligne));
  });
  if (compteRefuse) return false;
  return !(veritePy(sid) && (await refusSaufPanne(() => dep.revoquee(String(sid)))));
}
