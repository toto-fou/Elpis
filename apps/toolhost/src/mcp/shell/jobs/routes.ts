// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/shell/jobs/routes.ts — routes internes des jobs de fond appelées par le core (jeton de service, identité signée du compte) : veille confiée, arrêt de jobs (interface, `/jobs stop`, plafond de durée, suppression). */
import { estErreurAgent, getUserSandbox, racineTravail } from "@elpis/bac";
import { HttpError } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { entrees, py } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute, Famille } from "../../../app";
import type { CompteSigne } from "../../../rappel";
import { reponseJson } from "../../../socle";
import { agentJobs, ID_JOB, reglagesShellJob } from "./outil";
import type { AgentJobs } from "./outil";
import type { VeilleurJobs } from "./veilleur";

const VEILLE = py.model({
  job_ids: py.list(py.str({ max_length: 32 }), { max_length: 500 }).defaut([]),
  since_seq: py.int({ ge: 0 }).defaut(0),
});
const ARRET = py.model({
  job_ids: py.list(py.str({ max_length: 32 }), { max_length: 500 }),
  by: py.literal("user", "core").defaut("core"),
  purge: py.bool().defaut(false),
});

export interface DependancesRoutesJobs {
  readonly veilleur: () => VeilleurJobs | null;
  /** Agent du bac du compte ; défaut : l'instance du registre (profil inchangé), appelée en mode passif. */
  readonly agent?: (compte: CompteSigne) => Promise<AgentJobs>;
}

/** Agent du bac d'un compte (registre du process), sans démarrer le conteneur ici. */
async function agentDuCompte(compte: CompteSigne): Promise<AgentJobs> {
  return agentJobs(
    getUserSandbox(compte.user_id, compte.username, await racineTravail(compte.username)).agent,
  );
}

/** Compte de l'enveloppe signée (vérifiée par la porte). */
function compteDe(requete: FastifyRequest): CompteSigne {
  const id = requete.identite;
  if (!id || id.user_id <= 0 || !id.username)
    throw new HttpError(401, "enveloppe d'identité absente ou invalide");
  return { user_id: Math.trunc(id.user_id), username: id.username };
}

/** Issue d'un arrêt : résultat, ou le conteneur arrêté ; toute autre panne lève. */
async function arreterUn(
  agent: AgentJobs,
  id: string,
  par: "user" | "core",
  purge: boolean,
): Promise<Dict | "conteneur" | "inconnu"> {
  try {
    const r = await agent.jobsKill({
      id,
      by: par,
      purge,
      graceS: reglagesShellJob.graceKillS,
      passive: true,
    });
    return {
      job_id: id,
      killed_pids: Array.isArray(r["killed_pids"]) ? r["killed_pids"] : [],
      state: r["state"] ?? null,
      exit_code: r["exit_code"] ?? null,
      signal: r["signal"] ?? null,
    };
  } catch (e) {
    if (!estErreurAgent(e)) throw e;
    if (e.code === "container_down") return "conteneur";
    if (e.code === "job_not_found") return "inconnu";
    if (e.code === "job_not_running") return { job_id: id, killed_pids: [], state: e.data["state"] ?? null };
    if (e.code === "busy") return { job_id: id, killed_pids: [], state: "running", error: "busy" };
    throw e;
  }
}

/** `POST /api/internal/jobs/kill` : `{job_ids, by, purge}` → `{ok, results:[{job_id, killed_pids, state}]}` ; purge impossible (conteneur arrêté) → 503. */
async function arreter(
  requete: FastifyRequest,
  reponse: FastifyReply,
  dep: DependancesRoutesJobs,
): Promise<FastifyReply> {
  const compte = compteDe(requete);
  const c = entrees(requete, { body: ARRET }).body;
  const ids = [...new Set(c.job_ids)].filter((id) => ID_JOB.test(id));
  let issues: (Dict | "conteneur" | "inconnu")[];
  try {
    const agent = await (dep.agent ?? agentDuCompte)(compte);
    const par = c.by === "user" ? "user" : "core";
    issues = await Promise.all(ids.map((id) => arreterUn(agent, id, par, c.purge)));
  } catch (e) {
    if (estErreurAgent(e) && e.code === "container_down") issues = ids.map(() => "conteneur" as const);
    else throw new HttpError(502, `sandbox_unavailable: ${estErreurAgent(e) ? e.code : "error"}`);
  }
  const arretes = ids.filter((_, i) => issues[i] === "conteneur");
  if (arretes.length && c.purge)
    throw new HttpError(503, "sandbox_unavailable: container stopped, purge postponed");
  if (arretes.length) dep.veilleur()?.veiller(compte, arretes);
  const inconnus = ids.filter((_, i) => issues[i] === "inconnu");
  if (inconnus.length) await dep.veilleur()?.declarerPerdus(compte, inconnus);
  const results = ids.map((id, i) => {
    const r = issues[i];
    return typeof r === "object" ? r : { job_id: id, killed_pids: [], state: "lost" };
  });
  return reponseJson(reponse, { ok: true, results });
}

/** `POST /api/internal/jobs/watch` : veille du compte (re)démarrée si elle ne tourne pas (idempotent) → `{ok, watching}`. */
async function veiller(
  requete: FastifyRequest,
  reponse: FastifyReply,
  dep: DependancesRoutesJobs,
): Promise<FastifyReply> {
  const compte = compteDe(requete);
  const c = entrees(requete, { body: VEILLE }).body;
  const v = dep.veilleur();
  const ids = c.job_ids.filter((id) => ID_JOB.test(id));
  return reponseJson(reponse, { ok: true, watching: v !== null && v.veiller(compte, ids, c.since_seq) });
}

export function routesJobs(dep: DependancesRoutesJobs): DefinitionRoute[] {
  return [
    {
      methode: "POST",
      chemin: "/api/internal/jobs/watch",
      processus: ["toolhost"],
      acces: "enveloppe",
      traiter: (q, r) => veiller(q, r, dep),
    },
    {
      methode: "POST",
      chemin: "/api/internal/jobs/kill",
      processus: ["toolhost"],
      acces: "enveloppe",
      traiter: (q, r) => arreter(q, r, dep),
    },
  ];
}

export function creerFamilleJobs(dep: DependancesRoutesJobs): Famille {
  return { nom: "jobs", routes: routesJobs(dep) };
}
