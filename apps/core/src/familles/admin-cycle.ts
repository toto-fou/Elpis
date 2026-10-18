// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-cycle.ts — redémarrage de main depuis la console, `restart-self` (canal interne) et invalidation des caches de modèles (routes/admin/lifecycle.py). */
import { getUsernameById } from "@elpis/auth";
import type { Executeur } from "@elpis/db";

import type { CycleDeVie } from "../cycle";
import type { SystemEvents } from "../evenements";
import type { Journal } from "../journal";
import { invalidateAllModelCaches } from "../llm/modeles";
import {
  activeGenerations,
  appelerRestartSelf,
  CHEMIN_GENERATIONS,
  DELAI_RECHARGEMENT_MS,
  gracefulDrainSeconds,
  messageErreurReseau,
  planifierRechargement,
  urlMainRedemarrage,
} from "../ops/redemarrage";
import type { ReponseMain, SourceGenerations } from "../ops/redemarrage";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { HttpError } from "@elpis/commun";

export interface DependancesAdminCycle {
  readonly base: Executeur;
  readonly cycle: CycleDeVie;
  readonly journal: Journal;
  readonly systemEvents: SystemEvents;
  /** Jeton interne vers main (process admin) ; absent dans main. */
  readonly jetonMain?: () => string;
  readonly fetch?: typeof fetch;
  readonly env?: Record<string, string | undefined>;
  /** Générations en cours vues par ce process (admin : celles de main) ; défaut : celles de ce process. */
  readonly generations?: SourceGenerations;
  /** Pour les tests : `invalidate_all_model_caches`. */
  readonly invaliderCaches?: () => Record<string, unknown>;
}

/** `resp.json() or {}` puis `.get` : un JSON vrai qui n'est pas un objet lève (500) comme en Python. */
function corpsDeMain(texte: string): Record<string, unknown> {
  let corps: unknown;
  try {
    corps = JSON.parse(texte);
  } catch {
    return {};
  }
  if (corps === null || corps === false || corps === 0 || corps === "") return {};
  if (Array.isArray(corps) && corps.length === 0) return {};
  if (typeof corps !== "object" || Array.isArray(corps))
    throw new TypeError(`'${Array.isArray(corps) ? "list" : typeof corps}' object has no attribute 'get'`);
  return corps as Record<string, unknown>;
}

export function creerFamilleAdminCycle(dep: DependancesAdminCycle): Famille {
  const journal = dep.journal;
  const generations = dep.generations ?? activeGenerations;
  return {
    nom: "admin-cycle",
    routes: [
      {
        methode: "POST",
        chemin: "/api/admin/restart",
        processus: ["admin"],
        acces: "admin",
        traiter: async () => {
          const mainUrl = urlMainRedemarrage(dep.env);
          let r: ReponseMain;
          try {
            r = await appelerRestartSelf(mainUrl, dep.jetonMain?.() ?? "", { fetch: dep.fetch });
          } catch (e) {
            journal.warn(`[admin/restart] HTTP call to main failed: ${messageErreurReseau(e)}`);
            return { ok: false, target: "main", error: messageErreurReseau(e) };
          }
          if (r.statut !== 200) {
            journal.warn(
              `[admin/restart] main returned ${r.statut} for restart-self: ${r.texte.slice(0, 200)}`,
            );
            return { ok: false, target: "main", main_status: r.statut };
          }
          const corps = corpsDeMain(r.texte);
          return {
            ok: true,
            target: "main",
            main_url: mainUrl,
            active_generations: Object.hasOwn(corps, "active_generations")
              ? corps["active_generations"]
              : null,
            drain_max_s: Object.hasOwn(corps, "drain_max_s") ? corps["drain_max_s"] : null,
          };
        },
      },
      {
        methode: "POST",
        chemin: "/api/admin/internal/restart-self",
        processus: ["main", "admin"],
        acces: "interne",
        traiter: async () => {
          planifierRechargement(dep.cycle, journal, DELAI_RECHARGEMENT_MS, generations);
          return {
            ok: true,
            scheduled_in_sec: 5,
            pid: process.pid,
            method: "sighup",
            active_generations: (await generations()) ?? 0,
            drain_max_s: gracefulDrainSeconds(),
          };
        },
      },
      {
        methode: "GET",
        chemin: CHEMIN_GENERATIONS,
        processus: ["main"],
        acces: "interne",
        traiter: async () => ({ active_generations: await activeGenerations() }),
      },
      {
        methode: "POST",
        chemin: "/api/admin/cache/invalidate",
        processus: ["admin"],
        acces: "admin",
        traiter: async (req) => {
          const uid = utilisateur(req);
          let resume: Record<string, unknown>;
          try {
            resume = (dep.invaliderCaches ?? invalidateAllModelCaches)();
          } catch (e) {
            throw new HttpError(
              500,
              `Erreur invalidation cache : ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          const nom = (await getUsernameById(dep.base, uid)) || `user_${uid}`;
          dep.systemEvents.broadcast({
            type: "log",
            message: `[CACHE] Invalidation globale demandée par ${nom}`,
            level: "INFO",
          });
          return { ok: true, cleared: resume };
        },
      },
    ],
  };
}
