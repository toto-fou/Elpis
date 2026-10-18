// SPDX-License-Identifier: MIT
/** apps/core/src/familles/executions.ts — exécutions d'un compte : ligne et filles, chronologie, export JSON aux secrets masqués (shared_infra/observability/routes_runs.py). */
import { HttpError, pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { FastifyRequest } from "fastify";

import { enfants, exporter, runAccessible, timeline } from "../executions/chronologie";
import { getRun } from "../executions/registre";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { entrees, py, reponseJsonPy } from "@elpis/http";

export interface DependancesExecutions {
  readonly base: Base;
}

const ID = /^[a-z]{1,16}-[A-Za-z0-9_-]{1,64}$/u;

function route(chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode: "GET", chemin, processus: ["main"], acces: "session", traiter };
}

/** Réservé au compte propriétaire : identifiant inconnu, mal formé ou d'un autre compte → 404, sans distinction. */
async function runDuCompte(base: Base, req: FastifyRequest): Promise<Dict> {
  const uid = utilisateur(req);
  const runId = entrees(req, { path: { run_id: py.str() } }).path.run_id;
  if (!ID.test(runId)) throw new HttpError(404, "Exécution introuvable");
  const run = await getRun(base, runId);
  if (run === null || !runAccessible(run, uid)) throw new HttpError(404, "Exécution introuvable");
  return run;
}

export function creerFamilleExecutions(dep: DependancesExecutions): Famille {
  const base = dep.base;
  return {
    nom: "executions",
    routes: [
      route("/api/runs/:run_id", async (req, rep) => {
        const run = await runDuCompte(base, req);
        run["children"] = await enfants(base, String(run["id"]));
        return reponseJsonPy(rep, run);
      }),
      route("/api/runs/:run_id/timeline", async (req, rep) =>
        reponseJsonPy(rep, await timeline(base, await runDuCompte(base, req))),
      ),
      route("/api/runs/:run_id/export", async (req, rep) => {
        const run = await runDuCompte(base, req);
        const corps = pyJsonDumps(await exporter(base, run), { ensureAscii: false, indent: 2 });
        return rep
          .headers({
            "content-disposition": `attachment; filename="execution-${String(run["id"])}.json"`,
            "cache-control": "no-store",
          })
          .type("application/json")
          .send(corps);
      }),
    ],
  };
}
