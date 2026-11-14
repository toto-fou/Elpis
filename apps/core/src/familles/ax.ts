// SPDX-License-Identifier: MIT
/** apps/core/src/familles/ax.ts — mémoire AX des sites (interfaces apprises par le navigateur) : lecture pour tout compte (identifiants d'un site lus dans son coffre « Secrets »), purges pour l'équipe, effacement total pour l'admin (shared_infra/memory/routes_ax.py). */
import { ligneUtilisateur } from "@elpis/auth";
import { HttpError, veritePy } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { FastifyRequest } from "fastify";

import { journal } from "../journal";
import { auditerRefus } from "../journal-securite/auditer";
import {
  deleteCredentials,
  deleteSite,
  deleteSitesBulk,
  getSiteStats,
  getTreeJson,
  listSitesWithStats,
  markSiteStale,
  normalizeUrl,
  renderFullDomForPrompt,
  wipeAll,
} from "@elpis/navigateur";
import type { IdentifiantSite, IdentifiantsDesSites } from "@elpis/navigateur";
import type { Famille } from "../routes";
import { genreAttachable } from "../secrets/attache";
import { origines } from "../secrets/portee";
import { listerSecrets } from "../secrets/stockage";
import { utilisateur } from "./comptes";
import { entrees, py, reponseJsonPy } from "@elpis/http";

export interface DependancesAx {
  readonly base: Base;
}

const PROCESSUS = ["main", "admin"] as const;
const LOT_SITES = py.model({ sites: py.list(py.str()), include_credentials: py.bool().defaut(false) });

/** Rôle relu en base (`is_admin` : 1 admin, 2 modérateur) ; 403 avec le message du Python sinon. */
async function exigerRole(
  base: Base,
  req: FastifyRequest,
  roles: readonly number[],
  message: string,
): Promise<number> {
  const uid = utilisateur(req);
  const moi = await ligneUtilisateur(base, uid);
  if (!moi || !roles.includes(Number(moi.is_admin))) {
    auditerRefus(req, "auth.role.denied", { required: roles.includes(2) ? "staff" : "admin" });
    throw new HttpError(403, message);
  }
  return uid;
}

const exigerEquipe = (base: Base, req: FastifyRequest): Promise<number> =>
  exigerRole(base, req, [1, 2], "Admin or moderator required");

/** Identifiants des sites du compte de la session, lus dans son coffre (`web-login`, `http-auth`, vérifiés d'abord puis les plus récemment utilisés) : nom de connexion, origine, usages ; jamais de valeur. */
async function identifiantsDuCoffre(base: Base, req: FastifyRequest): Promise<IdentifiantsDesSites> {
  const uid = req.utilisateur?.id;
  if (!uid) return () => undefined;
  const secrets = (await listerSecrets(base, uid))
    .filter((s) => genreAttachable(s.kind))
    .sort(
      (a, b) =>
        Number(b.state === "active") - Number(a.state === "active") ||
        (b.last_used_at ?? 0) - (a.last_used_at ?? 0),
    );
  const parSite = new Map<string, IdentifiantSite>();
  for (const s of secrets)
    for (const origin of origines(s.scope)) {
      const [site] = normalizeUrl(origin);
      if (site && !parSite.has(site))
        parSite.set(site, { username: s.username, origin, use_count: s.use_count, last_ok: s.last_used_at });
    }
  return (site) => parSite.get(site);
}

function site(req: FastifyRequest): string {
  return entrees(req, { path: { site: py.str() } }).path.site;
}

function introuvable(s: string): HttpError {
  return new HttpError(404, `Site '${s}' not found`);
}

export function creerFamilleAx(dep: DependancesAx): Famille {
  const base = dep.base;
  return {
    nom: "ax",
    routes: [
      {
        methode: "GET",
        chemin: "/api/ax/sites",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req, rep) => {
          utilisateur(req);
          const sites = await listSitesWithStats(base, await identifiantsDuCoffre(base, req));
          return reponseJsonPy(rep, { sites, count: sites.length });
        },
      },
      {
        methode: "GET",
        chemin: "/api/ax/sites/:site/stats",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req, rep) => {
          utilisateur(req);
          const s = site(req);
          const stats = await getSiteStats(base, s, await identifiantsDuCoffre(base, req));
          if (stats === null) throw introuvable(s);
          return reponseJsonPy(rep, stats);
        },
      },
      {
        methode: "GET",
        chemin: "/api/ax/sites/:site/tree",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req) => {
          utilisateur(req);
          const s = site(req);
          const arbre = await getTreeJson(base, s);
          if (!veritePy(arbre.paths) && (await getSiteStats(base, s)) === null) throw introuvable(s);
          return arbre;
        },
      },
      {
        methode: "GET",
        chemin: "/api/ax/sites/:site/tree-ascii",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req) => {
          utilisateur(req);
          const s = site(req);
          const ascii = await renderFullDomForPrompt(base, s, 50000);
          if (ascii) return { site: s, ascii };
          if ((await getSiteStats(base, s)) === null) throw introuvable(s);
          return { site: s, ascii: "(no DOM recorded yet)" };
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/ax/sites/:site",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req) => {
          await exigerEquipe(base, req);
          const { path, query } = entrees(req, {
            path: { site: py.str() },
            query: { include_credentials: py.bool().defaut(false) },
          });
          const r = await deleteSite(base, path.site, query.include_credentials);
          if ("error" in r) throw new HttpError(500, r.error);
          return r;
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/ax/sites/:site/credentials",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req) => {
          await exigerEquipe(base, req);
          return { deleted: (await deleteCredentials(base, site(req))) ? 1 : 0 };
        },
      },
      {
        methode: "POST",
        chemin: "/api/ax/sites/:site/mark-stale",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req) => {
          await exigerEquipe(base, req);
          const r = await markSiteStale(base, site(req));
          if ("error" in r) throw new HttpError(500, r.error);
          return r;
        },
      },
      {
        methode: "POST",
        chemin: "/api/ax/bulk-delete",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req) => {
          await exigerEquipe(base, req);
          const corps = entrees(req, { body: LOT_SITES }).body;
          if (corps.sites.length === 0) throw new HttpError(400, "No sites provided");
          return deleteSitesBulk(base, corps.sites, corps.include_credentials);
        },
      },
      {
        methode: "POST",
        chemin: "/api/ax/bulk-mark-stale",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req) => {
          await exigerEquipe(base, req);
          const corps = entrees(req, { body: LOT_SITES }).body;
          if (corps.sites.length === 0) throw new HttpError(400, "No sites provided");
          let total = 0;
          for (const s of corps.sites) {
            const r = await markSiteStale(base, s);
            total += "marked" in r ? r.marked : 0;
          }
          return { marked: total, sites_processed: corps.sites.length };
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/ax/all",
        processus: PROCESSUS,
        acces: "session",
        traiter: async (req) => {
          const uid = await exigerRole(base, req, [1], "Full admin required for wipe");
          const { confirm } = entrees(req, { query: { confirm: py.str().defaut("") } }).query;
          if (confirm !== "WIPE") throw new HttpError(400, "confirmation required : pass confirm=WIPE");
          const r = await wipeAll(base);
          if ("error" in r) throw new HttpError(500, r.error);
          journal("ax").warn(`[ax] WIPE ALL requested by user_id=${uid}`);
          return r;
        },
      },
    ],
  };
}
