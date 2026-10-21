// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-vue.ts — console : vue d'ensemble, réglages en attente de redémarrage, journaux récents et terminaux (admin/overview.py, logs.py, system.py). */
import { ligneUtilisateur } from "@elpis/auth";
import { floatPy, HttpError, intPy, maxPy, minPy, stripPy, versFlottantPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { lireEvenementsRecents } from "../admin/journaux";
import { CACHE_TTL, collecter } from "../admin/vue";
import type { Faits, Sondes } from "../admin/vue";
import { cheminJournalCommun } from "../evenements/journal-commun";
import type { EntreeHistorique } from "../evenements/systeme";
import type { Journal } from "../journal";
import type { Acces, DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { entrees, parametreRequete, py, reponseJsonPy } from "@elpis/http";

/** Délai d'inactivité d'un terminal et nombre maximal de sessions par compte (hôte d'outils). */
export const PTY_IDLE_TIMEOUT_SEC = 1800;
export const MAX_SESSIONS_PER_USER = 4;

export interface DependancesAdminVue {
  readonly base: Base;
  readonly journal: Journal;
  readonly racine: string;
  readonly sondes: Sondes;
  readonly faits: Faits;
  /** `restart_paths` : chemins de config.json lus une fois au démarrage. */
  readonly cheminsRedemarrage: () => string[];
  /** Tampon des dernières lignes du journal de ce process (`system_events.get_recent_logs`). */
  readonly journalRecent: () => readonly EntreeHistorique[];
  readonly maintenant?: () => number;
}

function route(methode: "GET", chemin: string, acces: Acces, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces, traiter };
}

/** `_csv` : valeurs d'un paramètre séparées par des virgules, `null` s'il est absent ou vide. */
function liste(requete: FastifyRequest, nom: string): string[] | null {
  const v = parametreRequete(requete, nom);
  if (!v) return null;
  return v
    .split(",")
    .map((x) => stripPy(x))
    .filter((x) => x);
}

export function creerFamilleAdminVue(dep: DependancesAdminVue): Famille {
  const maintenant = dep.maintenant ?? (() => Date.now() / 1000);
  const cache: { at: number; data: Dict | null } = { at: 0, data: null };
  let enCours: Promise<void> | null = null;

  async function role(requete: FastifyRequest): Promise<number> {
    const moi = await ligneUtilisateur(dep.base, utilisateur(requete));
    return Number(moi?.is_admin ?? 0);
  }

  const frais = (): boolean => cache.data !== null && maintenant() - cache.at < CACHE_TTL;

  /** Tournée partagée sous verrou : une seule collecte à la fois, refaite si périmée ou forcée. */
  async function rafraichir(force: boolean): Promise<void> {
    if (frais() && !force) return;
    while (enCours) await enCours.catch(() => undefined);
    if (frais() && !force) return;
    enCours = (async () => {
      cache.data = await collecter(dep.sondes, dep.faits, dep.journal, maintenant);
      cache.at = maintenant();
    })();
    try {
      await enCours;
    } finally {
      enCours = null;
    }
  }

  async function vueDEnsemble(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const r = await role(req);
    const { refresh } = entrees(req, { query: { refresh: py.int().defaut(0) } }).query;
    await rafraichir(Boolean(refresh) && r === 1);
    const data: Dict = { ...(cache.data as Dict) };
    data["role"] = r === 1 ? "admin" : "moderator";
    if (r !== 1) data["alerts"] = (data["alerts"] as Dict[]).map((a) => ({ ...a, action: "" }));
    return reponseJsonPy(rep, data);
  }

  async function etatRedemarrage(req: FastifyRequest): Promise<Dict> {
    if ((await role(req)) !== 1) throw new HttpError(403, "Admin required");
    const [chemins, attente] = await Promise.all([
      Promise.resolve(dep.cheminsRedemarrage()),
      dep.faits.enAttente(),
    ]);
    return { paths: chemins, pending: attente };
  }

  async function journauxRecents(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    let limite: number;
    try {
      limite = maxPy(1, minPy(intPy(parametreRequete(req, "limit") ?? "500"), 5000));
    } catch {
      limite = 500;
    }
    const services = liste(req, "services");
    const niveaux = liste(req, "levels");
    const categories = liste(req, "categories");
    let depuis: number | null = null;
    const brut = parametreRequete(req, "since_ts");
    if (brut !== null) {
      try {
        depuis = floatPy(brut);
      } catch {
        depuis = null;
      }
    }
    let evenements: unknown[] = [];
    try {
      evenements = await lireEvenementsRecents(cheminJournalCommun(dep.racine), {
        limit: limite,
        services,
        levels: niveaux,
        categories,
        sinceTs: depuis,
      });
    } catch (e) {
      dep.journal.warn(
        `[admin/logs] read_recent_events failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    let anciens: Dict[];
    try {
      anciens = dep
        .journalRecent()
        .map((l) => ({ id: versFlottantPy(l.id), message: l.message, level: l.level }));
    } catch {
      anciens = [];
    }
    return reponseJsonPy(
      rep,
      {
        logs: anciens,
        events: evenements,
        filters_applied: {
          limit: limite,
          services,
          levels: niveaux,
          categories,
          since_ts: depuis === null ? null : versFlottantPy(depuis),
        },
        available_services: ["main", "admin"],
        available_levels: ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        available_categories: ["http", "auth", "admin", "security", "system", "app"],
      },
      { "Cache-Control": "no-cache" },
    );
  }

  /** Terminaux de ce process : le process admin n'en héberge aucun (ils vivent dans main et l'hôte d'outils). */
  function terminaux(): Dict {
    return {
      worker_pid: process.pid,
      count: 0,
      idle_timeout_sec: PTY_IDLE_TIMEOUT_SEC,
      max_sessions_per_user: MAX_SESSIONS_PER_USER,
      sessions: [],
    };
  }

  return {
    nom: "admin-vue",
    routes: [
      route("GET", "/api/admin/overview", "staff", vueDEnsemble),
      route("GET", "/api/admin/restart-status", "staff", etatRedemarrage),
      route("GET", "/api/admin/logs/recent", "staff", journauxRecents),
      route("GET", "/api/admin/terminal/stats", "admin", terminaux),
    ],
  };
}
