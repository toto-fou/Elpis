// SPDX-License-Identifier: MIT
/** packages/auth/src/session.ts — session de requête (lue / modifiée comme `Session` de Starlette) et portes de validité de deps.py. */
import { floatPy, intPy, veritePy } from "@elpis/commun";
import { estTableAbsente } from "@elpis/db";

import { lire, sousObjet } from "./dict";

export class Session {
  private donnees: Record<string, unknown>;
  lue = false;
  modifiee = false;

  constructor(donnees: Record<string, unknown> = {}) {
    this.donnees = { ...donnees };
  }

  get(cle: string): unknown {
    this.lue = true;
    return this.donnees[cle];
  }

  set(cle: string, valeur: unknown): void {
    this.lue = true;
    this.modifiee = true;
    this.donnees[cle] = valeur;
  }

  vider(): void {
    this.lue = true;
    this.modifiee = true;
    this.donnees = {};
  }

  get vide(): boolean {
    return Object.keys(this.donnees).length === 0;
  }

  contenu(): Record<string, unknown> {
    return { ...this.donnees };
  }
}

export interface LigneUtilisateur {
  id?: number;
  username?: string;
  is_admin?: number;
  must_change_pwd?: number;
  session_min_ts?: number | null;
  [colonne: string]: unknown;
}

export interface DependancesSession {
  config(): unknown;
  utilisateur(uid: number): Promise<LigneUtilisateur | null | undefined>;
  revoquee(sid: string): Promise<boolean>;
  maintenant(): number;
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
  if (minGlobal > 0 && loginTs < minGlobal) return refus();
  let ligne: LigneUtilisateur | null | undefined;
  try {
    ligne = await dep.utilisateur(uid);
    if (!ligne) return refus();
    const minCompte = floatPy(veritePy(ligne.session_min_ts) ? ligne.session_min_ts : 0.0);
    if (minCompte > 0 && loginTs < minCompte) return refus();
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
    sessionMinTs(uid: number): Promise<number | null | undefined>;
  },
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
  if (dep.maintenant() - login > maxAge) return false;
  if (minGlobal > 0 && login < minGlobal) return false;
  const compteRefuse = await refusSaufPanne(async () => {
    const min = await dep.sessionMinTs(uid);
    if (min === undefined) return true;
    const m = floatPy(veritePy(min) ? min : 0.0);
    return m > 0 && login < m;
  });
  if (compteRefuse) return false;
  return !(veritePy(sid) && (await refusSaufPanne(() => dep.revoquee(String(sid)))));
}
