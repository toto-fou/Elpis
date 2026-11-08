// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-runs.ts — console › Supervision › Exécutions : coût par compte, liste, chronologie et export d'une exécution (routes/admin/runs.py). */
import { estDict, HttpError, pyJsonDumps } from "@elpis/commun";
import type { Executeur, Valeur } from "@elpis/db";
import type { FastifyRequest } from "fastify";

import { exporter, masquer, runAccessible, timeline } from "../executions/chronologie";
import { getRun, KINDS } from "../executions/registre";
import { CacheLecture } from "../observabilite/cache-lecture";
import { clauseTri, conditionRecherche, decalage } from "./liste-paginee";
import { auditerRequete } from "../journal-securite/auditer";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { exigerLectureConsole } from "./garde-console";
import { entrees, py, reponseJsonPy } from "@elpis/http";

type Dict = Record<string, unknown>;

const ID = /^[a-z]{1,16}-[A-Za-z0-9_-]{1,64}$/u;
const STATUT = /^[a-z_]{1,24}$/u;
const COLONNES_LISTE = [
  "id",
  "kind",
  "user_id",
  "chat_id",
  "routine_id",
  "model",
  "engine",
  "started_at",
  "ended_at",
  "status",
  "error_kind",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "thinking_tokens",
  "tool_tokens",
  "llm_calls",
  "prefill_ms",
  "decode_ms",
  "wait_ms",
  "tool_calls",
  "tool_errors",
  "files_changed",
  "sandbox_cpu_peak",
  "sandbox_mem_peak_mb",
];

/** `_masquer_objet` : secrets masqués dans chaque texte d'une chronologie (vue d'un compte tiers). */
function masquerObjet(v: unknown): unknown {
  if (typeof v === "string") return masquer(v);
  if (Array.isArray(v)) return v.map(masquerObjet);
  if (estDict(v)) {
    const out: Dict = {};
    for (const [k, x] of Object.entries(v)) out[k] = masquerObjet(x);
    return out;
  }
  return v;
}

function heures(h: number): number {
  return Math.max(1, Math.min(720, h));
}

/** Agrégat par compte : `runs` seul est groupé d'abord (≤ 500 lignes), puis `users` n'est joint que sur ces lignes (plus rapide qu'une jointure avant le groupement, mêmes lignes). */
export async function parCompte(
  x: Executeur,
  hours: number,
  maintenant = Date.now() / 1000,
): Promise<Dict[]> {
  const ordre = "llm_ms DESC, input_tokens DESC, user_id";
  const colonnes =
    "runs failed subagents input_tokens output_tokens thinking_tokens cache_read_tokens cache_creation_tokens tool_tokens llm_ms prefill_ms decode_ms wait_ms tool_calls tool_errors files_changed sandbox_cpu_peak sandbox_mem_peak_mb last_at"
      .split(" ")
      .map((c) => `a.${c}`)
      .join(", ");
  return x.all(
    `SELECT a.user_id, u.username, ${colonnes} ` +
      "FROM (SELECT r.user_id, " +
      "SUM(CASE WHEN r.parent_id = '' THEN 1 ELSE 0 END) AS runs, " +
      "SUM(CASE WHEN r.parent_id = '' AND r.status NOT IN ('ok', 'running') THEN 1 ELSE 0 END) AS failed, " +
      "SUM(CASE WHEN r.kind = 'subagent' THEN 1 ELSE 0 END) AS subagents, " +
      "COALESCE(SUM(r.input_tokens), 0) AS input_tokens, " +
      "COALESCE(SUM(r.output_tokens), 0) AS output_tokens, " +
      "COALESCE(SUM(r.thinking_tokens), 0) AS thinking_tokens, " +
      "COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens, " +
      "COALESCE(SUM(r.cache_creation_tokens), 0) AS cache_creation_tokens, " +
      "COALESCE(SUM(r.tool_tokens), 0) AS tool_tokens, " +
      "COALESCE(SUM(r.prefill_ms + r.decode_ms), 0) AS llm_ms, " +
      "COALESCE(SUM(r.prefill_ms), 0) AS prefill_ms, " +
      "COALESCE(SUM(r.decode_ms), 0) AS decode_ms, " +
      "COALESCE(SUM(r.wait_ms), 0) AS wait_ms, " +
      "COALESCE(SUM(r.tool_calls), 0) AS tool_calls, " +
      "COALESCE(SUM(r.tool_errors), 0) AS tool_errors, " +
      "COALESCE(SUM(r.files_changed), 0) AS files_changed, " +
      "MAX(r.sandbox_cpu_peak) AS sandbox_cpu_peak, " +
      "MAX(r.sandbox_mem_peak_mb) AS sandbox_mem_peak_mb, " +
      "MAX(r.started_at) AS last_at " +
      `FROM runs r WHERE r.started_at > ? GROUP BY r.user_id ORDER BY ${ordre} LIMIT 500) a ` +
      `LEFT JOIN users u ON u.id = a.user_id ORDER BY a.llm_ms DESC, a.input_tokens DESC, a.user_id`,
    [maintenant - hours * 3600],
  );
}

export interface FiltreListe {
  hours: number;
  userId: number | null;
  kind: string;
  status: string;
  limit: number;
  offset?: number;
  q?: string;
  /** Identifiant exact d'une exécution (remplace genre et premier niveau). */
  runId?: string;
  sort?: string;
  dir?: string;
}

/** Tri permis : clé de la requête vers expression SQL (liste blanche). */
export const TRIS_LISTE: Readonly<Record<string, string>> = {
  started_at: "r.started_at",
  username: "u.username",
  kind: "r.kind",
  status: "r.status",
  duration: "(r.ended_at - r.started_at)",
  input_tokens: "r.input_tokens",
  output_tokens: "r.output_tokens",
  tool_calls: "r.tool_calls",
  engine: "r.engine",
};

/** Conditions communes à la liste et au total (un run_id se lit par clé primaire, sans période) ; `jointure` : la recherche lit `users`. */
function conditions(
  filtre: FiltreListe,
  maintenant: number,
): { where: string[]; params: Valeur[]; jointure: boolean } {
  const where: string[] = [];
  const params: Valeur[] = [];
  if (filtre.runId) {
    where.push("r.id = ?");
    params.push(filtre.runId);
  } else {
    where.push("r.started_at > ?");
    params.push(maintenant - filtre.hours * 3600);
    if (filtre.kind) {
      where.push("r.kind = ?");
      params.push(filtre.kind);
    } else where.push("(r.parent_id || '') = ''"); // `|| ''` : sinon SQLite préfère `idx_runs_parent`.
  }
  if (filtre.userId !== null) {
    where.push("r.user_id = ?");
    params.push(filtre.userId);
  }
  if (filtre.status) {
    where.push("r.status = ?");
    params.push(filtre.status);
  }
  const rech = conditionRecherche(filtre.q ?? "", ["u.username", "r.model", "r.engine", "r.id"]);
  if (rech !== null) {
    where.push(rech.sql);
    params.push(...rech.params);
  }
  return { where, params, jointure: rech !== null };
}

/** SQL et paramètres du total : la jointure `users` n'y figure que si la recherche en a besoin. */
export function requeteTotal(filtre: FiltreListe, maintenant: number): { sql: string; params: Valeur[] } {
  const { where, params, jointure } = conditions(filtre, maintenant);
  const from = jointure ? "runs r LEFT JOIN users u ON u.id = r.user_id" : "runs r";
  return { sql: `SELECT COUNT(*) AS n FROM ${from} WHERE ${where.join(" AND ")}`, params };
}

export async function liste(
  x: Executeur,
  filtre: FiltreListe,
  maintenant = Date.now() / 1000,
): Promise<Dict[]> {
  const { where, params } = conditions(filtre, maintenant);
  const ordre = clauseTri(
    filtre.sort ?? "",
    filtre.dir ?? "",
    TRIS_LISTE,
    { expr: "r.started_at", sens: "DESC" },
    "r.id",
  );
  return x.all(
    `SELECT ${COLONNES_LISTE.map((c) => `r.${c}`).join(", ")}, u.username ` +
      `FROM runs r LEFT JOIN users u ON u.id = r.user_id WHERE ${where.join(" AND ")} ` +
      `${ordre} LIMIT ? OFFSET ?`,
    [...params, filtre.limit, decalage(filtre.offset ?? 0)],
  );
}

/** Nombre de lignes de la liste pour les mêmes filtres (toujours bornée par la période). */
export async function total(
  x: Executeur,
  filtre: FiltreListe,
  maintenant = Date.now() / 1000,
): Promise<number> {
  const { sql, params } = requeteTotal(filtre, maintenant);
  const ligne = await x.all(sql, params);
  return Number(ligne[0]?.["n"] ?? 0);
}

export interface DependancesAdminRuns {
  readonly base: Executeur;
  readonly maintenant?: () => number;
  /** Horloge (ms) du cache des comptes : injectée par les tests. */
  readonly horlogeCache?: () => number;
}

/** Durée de vie du cache des comptes (agrégat lourd, relancé à chaque entrée sur l'onglet). */
const TTL_COMPTES_MS = 30_000;

export function creerFamilleAdminRuns(dep: DependancesAdminRuns): Famille {
  const maintenant = (): number => (dep.maintenant ? dep.maintenant() : Date.now() / 1000);
  const comptes = new CacheLecture<Dict[]>(TTL_COMPTES_MS, dep.horlogeCache);
  /** `_run_admin` : identifiant au format, exécution existante (l'admin voit celles de tous les comptes). */
  const runAdmin = async (req: FastifyRequest): Promise<Dict> => {
    const uid = utilisateur(req);
    const runId = (req.params as { run_id: string }).run_id;
    if (!ID.test(runId)) throw new HttpError(404, "Exécution introuvable");
    const run = await getRun(dep.base, runId);
    if (run === null || !runAccessible(run, uid, true)) throw new HttpError(404, "Exécution introuvable");
    return run;
  };
  return {
    nom: "admin-runs",
    routes: [
      {
        methode: "GET",
        chemin: "/api/admin/runs/accounts",
        processus: ["admin"],
        acces: "staff",
        traiter: async (req) => {
          const { query } = entrees(req, {
            query: { hours: py.int().defaut(24), fresh: py.int().defaut(0) },
          });
          const h = heures(query.hours);
          const items = await comptes.lire(
            String(h),
            () => parCompte(dep.base, h, maintenant()),
            query.fresh === 1,
          );
          return { hours: h, items };
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/runs",
        processus: ["admin"],
        acces: "staff",
        traiter: async (req) => {
          const { query } = entrees(req, {
            query: {
              hours: py.int().defaut(24),
              user_id: py.optional(py.int()).defaut(null),
              kind: py.str().defaut(""),
              status: py.str().defaut(""),
              limit: py.int().defaut(200),
              offset: py.int().defaut(0),
              q: py.str().defaut(""),
              run_id: py.str().defaut(""),
              sort: py.str().defaut(""),
              dir: py.str().defaut(""),
              count: py.int().defaut(1),
            },
          });
          if (query.kind && !(KINDS as readonly string[]).includes(query.kind))
            throw new HttpError(400, "Genre d'exécution inconnu");
          if (query.status && !STATUT.test(query.status)) throw new HttpError(400, "Statut inconnu");
          if (query.run_id && !ID.test(query.run_id))
            throw new HttpError(400, "Identifiant d'exécution invalide");
          const filtre: FiltreListe = {
            hours: heures(query.hours),
            userId: query.user_id,
            kind: query.kind,
            status: query.status,
            limit: Math.max(1, Math.min(1000, query.limit)),
            offset: decalage(query.offset),
            q: query.q,
            runId: query.run_id,
            sort: query.sort,
            dir: query.dir,
          };
          const now = maintenant();
          // `count=0` : page ou tri seuls changent, le client garde son total (`total: null`) et le COUNT n'est pas refait.
          const [items, nb] = await Promise.all([
            liste(dep.base, filtre, now),
            query.count === 0 ? Promise.resolve(null) : total(dep.base, filtre, now),
          ]);
          return { items, total: nb, offset: filtre.offset, limit: filtre.limit };
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/runs/:run_id/timeline",
        processus: ["admin"],
        acces: "admin",
        traiter: async (req, rep) =>
          reponseJsonPy(rep, masquerObjet(await timeline(dep.base, await runAdmin(req)))),
      },
      {
        methode: "GET",
        chemin: "/api/admin/runs/:run_id/export",
        processus: ["admin"],
        acces: "admin",
        traiter: async (req, rep) => {
          exigerLectureConsole(req);
          const run = await runAdmin(req);
          const corps = await exporter(dep.base, run);
          auditerRequete(req, "admin.runs.export", { run_id: run["id"] });
          return rep
            .type("application/json")
            .headers({
              "content-disposition": `attachment; filename="execution-${String(run["id"])}.json"`,
              "cache-control": "no-store",
            })
            .send(pyJsonDumps(corps, { ensureAscii: false, indent: 2 }));
        },
      },
    ],
  };
}
