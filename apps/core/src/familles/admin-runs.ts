// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-runs.ts — console › Supervision › Exécutions : coût par compte, liste, chronologie et export d'une exécution (routes/admin/runs.py). */
import { estDict, HttpError, pyJsonDumps } from "@elpis/commun";
import type { Executeur, Valeur } from "@elpis/db";
import type { FastifyRequest } from "fastify";

import { exporter, masquer, runAccessible, timeline } from "../executions/chronologie";
import { getRun, KINDS } from "../executions/registre";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
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

export async function parCompte(
  x: Executeur,
  hours: number,
  maintenant = Date.now() / 1000,
): Promise<Dict[]> {
  return x.all(
    "SELECT r.user_id, u.username, " +
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
      "FROM runs r LEFT JOIN users u ON u.id = r.user_id " +
      "WHERE r.started_at > ? GROUP BY r.user_id, u.username " +
      "ORDER BY llm_ms DESC, input_tokens DESC LIMIT 500",
    [maintenant - hours * 3600],
  );
}

export async function liste(
  x: Executeur,
  filtre: { hours: number; userId: number | null; kind: string; status: string; limit: number },
  maintenant = Date.now() / 1000,
): Promise<Dict[]> {
  const sql = [
    `SELECT ${COLONNES_LISTE.map((c) => `r.${c}`).join(", ")}, u.username ` +
      "FROM runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.started_at > ?",
  ];
  const params: Valeur[] = [maintenant - filtre.hours * 3600];
  if (filtre.kind) {
    sql.push("AND r.kind = ?");
    params.push(filtre.kind);
  } else {
    sql.push("AND r.parent_id = ''");
  }
  if (filtre.userId !== null) {
    sql.push("AND r.user_id = ?");
    params.push(filtre.userId);
  }
  if (filtre.status) {
    sql.push("AND r.status = ?");
    params.push(filtre.status);
  }
  sql.push("ORDER BY r.started_at DESC LIMIT ?");
  params.push(filtre.limit);
  return x.all(sql.join(" "), params);
}

export interface DependancesAdminRuns {
  readonly base: Executeur;
  readonly maintenant?: () => number;
}

export function creerFamilleAdminRuns(dep: DependancesAdminRuns): Famille {
  const maintenant = (): number => (dep.maintenant ? dep.maintenant() : Date.now() / 1000);
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
          const { query } = entrees(req, { query: { hours: py.int().defaut(24) } });
          const h = heures(query.hours);
          return { hours: h, items: await parCompte(dep.base, h, maintenant()) };
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
            },
          });
          if (query.kind && !(KINDS as readonly string[]).includes(query.kind))
            throw new HttpError(400, "Genre d'exécution inconnu");
          if (query.status && !STATUT.test(query.status)) throw new HttpError(400, "Statut inconnu");
          const items = await liste(
            dep.base,
            {
              hours: heures(query.hours),
              userId: query.user_id,
              kind: query.kind,
              status: query.status,
              limit: Math.max(1, Math.min(1000, query.limit)),
            },
            maintenant(),
          );
          return { items };
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
          const run = await runAdmin(req);
          const corps = await exporter(dep.base, run);
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
