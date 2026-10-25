// SPDX-License-Identifier: MIT
/** apps/core/src/familles/routines.ts — API des routines planifiées : CRUD, activation, run immédiat, journal et arrêt des runs, déclencheur webhook (shared_infra/scheduling/routes_routines.py). */
import { randomBytes } from "node:crypto";

import {
  estDict,
  floatPy,
  HttpError,
  intPy,
  lire,
  lowerPy,
  ouPy,
  prefixePy,
  reprPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { FastifyRequest } from "fastify";

import { validateCron } from "../routines/cron";
import {
  chargeRoutine,
  PROMPT_MAX,
  reqStr,
  validerAval,
  validerConnecteur,
  validerHistorique,
  validerSkills,
  referencesMcp,
  mcpDuCorps,
} from "../routines/validation";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  getRun,
  listRoutines,
  listRuns,
  markRunCancelled,
  setRoutineEnabled,
  setRoutineWebhook,
  updateRoutine,
} from "../routines/magasin";
import { ORPHAN_STALE_AFTER_S } from "../routines/planificateur";
import type { Planificateur } from "../routines/planificateur";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, py, reponseJsonPy } from "@elpis/http";

export interface DependancesRoutines {
  readonly base: Base;
  readonly planificateur: Planificateur;
  /** `secrets.token_hex(32)` ; injectable pour les tests. */
  readonly jetonSecret?: () => string;
}

const EVENEMENT_WEBHOOK = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const EVENEMENTS_WEBHOOK_MAX = 16;
const INTROUVABLE = "Routine introuvable";

function route(methode: DefinitionRoute["methode"], chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["main"], acces: "session", traiter };
}

const idRoutine = (req: FastifyRequest): number =>
  entrees(req, { path: { routine_id: py.int() } }).path.routine_id;

/** `_json_dict` : toute erreur de lecture → 400 « corps JSON invalide », autre chose qu'un objet → 400. */
function jsonDict(req: FastifyRequest): Dict {
  let data: unknown;
  try {
    data = corpsJsonValeurs(req);
  } catch {
    throw new HttpError(400, "corps JSON invalide");
  }
  if (!estDict(data)) throw new HttpError(400, "objet JSON attendu");
  return data;
}

/** PUT partiel : une clé absente reste inchangée ; validations dans l'ordre de Python. */
async function champsModifies(
  base: Base,
  data: Dict,
  uid: number,
  rid: number,
): Promise<Record<string, unknown>> {
  const a = (k: string): boolean => Object.hasOwn(data, k);
  const f: Record<string, unknown> = {};
  if (a("name")) {
    const nom = stripPy(reqStr(data, "name"));
    if (!nom) throw new HttpError(400, "Nom requis");
    f["name"] = prefixePy(nom, 200);
  }
  if (a("cron_expr") || a("cron")) {
    const brut = stripPy(reqStr(data, "cron_expr") || reqStr(data, "cron"));
    f["cron_expr"] = brut ? validateCron(brut) : "";
  }
  if (a("system_prompt")) f["system_prompt"] = reqStr(data, "system_prompt", PROMPT_MAX);
  if (a("task_prompt")) f["task_prompt"] = reqStr(data, "task_prompt", PROMPT_MAX);
  if (a("model")) f["model"] = reqStr(data, "model", 200);
  if (a("connector_id")) f["connector_id"] = await validerConnecteur(base, data, uid);
  for (const k of ["thinking_mode", "enabled", "agents_enabled"]) if (a(k)) f[k] = veritePy(data[k]);
  if (Object.hasOwn(f, "model") && !f["model"]) f["model"] = null;
  if (a("mcp_servers") || a("active_mcp_servers")) f["mcp_servers"] = referencesMcp(mcpDuCorps(data));
  if (a("trigger_after_id") || a("trigger_after_on")) {
    const [afterId, afterOn] = await validerAval(base, data, uid, rid);
    if (a("trigger_after_id")) f["trigger_after_id"] = afterId;
    if (a("trigger_after_on")) f["trigger_after_on"] = afterOn;
  }
  if (a("skills")) f["skills"] = await validerSkills(data, uid);
  return Object.assign(f, validerHistorique(data));
}

/** `_validate_webhook_filter` : events normalisés (16 au plus), branche et dépôt bornés. */
export function filtreWebhook(data: Dict): Dict {
  const events = ouPy(lire(data, "events"), []);
  if (!Array.isArray(events)) throw new HttpError(400, "events doit être une liste");
  const norm: string[] = [];
  for (const brut of events) {
    const e = lowerPy(stripPy(strPy(brut)));
    if (!e) continue;
    if (!EVENEMENT_WEBHOOK.test(e))
      throw new HttpError(400, `event invalide : ${reprPy(e)} (minuscules, chiffres, . _ : - ; 64 car. max)`);
    if (!norm.includes(e)) norm.push(e);
  }
  if (norm.length > EVENEMENTS_WEBHOOK_MAX)
    throw new HttpError(400, `trop d'events (max ${EVENEMENTS_WEBHOOK_MAX})`);
  const borne = (k: string): string => prefixePy(stripPy(strPy(ouPy(lire(data, k), ""))), 200);
  return { events: norm, branch: borne("branch"), repo: borne("repo") };
}

/** Routines du compte seulement : la routine d'un autre répond 404, jamais 403. */
export function creerFamilleRoutines(dep: DependancesRoutines): Famille {
  const { base, planificateur } = dep;
  const jetonSecret = dep.jetonSecret ?? ((): string => randomBytes(32).toString("hex"));
  const exiger = async (rid: number, uid: number): Promise<Dict> => {
    const r = await getRoutine(base, rid, uid);
    if (!r) throw new HttpError(404, INTROUVABLE);
    return r;
  };
  return {
    nom: "routines",
    routes: [
      route("GET", "/api/routines", async (req, rep) =>
        reponseJsonPy(rep, { items: await listRoutines(base, utilisateur(req)) }),
      ),
      route("POST", "/api/routines", async (req, rep) => {
        const uid = utilisateur(req);
        const p = await chargeRoutine(base, jsonDict(req), uid);
        return reponseJsonPy(rep, { id: await createRoutine(base, uid, p), ok: true });
      }),
      route("GET", "/api/routines/:routine_id", async (req, rep) => {
        const rid = idRoutine(req);
        return reponseJsonPy(rep, await exiger(rid, utilisateur(req)));
      }),
      route("PUT", "/api/routines/:routine_id", async (req) => {
        const rid = idRoutine(req);
        const uid = utilisateur(req);
        const champs = await champsModifies(base, jsonDict(req), uid, rid);
        if (!(await updateRoutine(base, rid, uid, champs))) throw new HttpError(404, INTROUVABLE);
        return { ok: true };
      }),
      route("POST", "/api/routines/:routine_id/enable", async (req) => {
        const rid = idRoutine(req);
        if (!(await setRoutineEnabled(base, rid, utilisateur(req), true)))
          throw new HttpError(404, INTROUVABLE);
        return { ok: true, enabled: true };
      }),
      route("POST", "/api/routines/:routine_id/disable", async (req) => {
        const rid = idRoutine(req);
        if (!(await setRoutineEnabled(base, rid, utilisateur(req), false)))
          throw new HttpError(404, INTROUVABLE);
        return { ok: true, enabled: false };
      }),
      route("DELETE", "/api/routines/:routine_id", async (req) => {
        const rid = idRoutine(req);
        if (!(await deleteRoutine(base, rid, utilisateur(req)))) throw new HttpError(404, INTROUVABLE);
        return { ok: true };
      }),
      route("POST", "/api/routines/:routine_id/run-now", async (req, rep) => {
        const rid = idRoutine(req);
        const uid = utilisateur(req);
        const r = await exiger(rid, uid);
        if (!veritePy(r["enabled"]))
          throw new HttpError(400, "Routine désactivée — réactivez-la pour l'exécuter");
        const runId = await planificateur.lancerRun(r, { trigger: "manual" });
        if (runId === null) {
          let raison = "cap de runs simultanés atteint";
          try {
            const dernier = (await listRuns(base, rid, uid, { limit: 1 }))[0];
            if (dernier && dernier["status"] === "skipped" && veritePy(dernier["error"]))
              raison = strPy(dernier["error"]);
          } catch {
            // libellé par défaut
          }
          return reponseJsonPy(rep, { ok: false, skipped: true, reason: raison });
        }
        return { ok: true, run_id: runId };
      }),
      route("GET", "/api/routines/:routine_id/runs", async (req, rep) => {
        const { path, query } = entrees(req, {
          path: { routine_id: py.int() },
          query: { limit: py.int().defaut(50), offset: py.int().defaut(0) },
        });
        const uid = utilisateur(req);
        await exiger(path.routine_id, uid);
        return reponseJsonPy(rep, {
          items: await listRuns(base, path.routine_id, uid, { limit: query.limit, offset: query.offset }),
        });
      }),
      route("POST", "/api/routines/:routine_id/runs/:run_id/stop", async (req, rep) => {
        const { path } = entrees(req, { path: { routine_id: py.int(), run_id: py.int() } });
        const uid = utilisateur(req);
        const rid = path.routine_id;
        await exiger(rid, uid);
        const run = await getRun(base, path.run_id, uid);
        if (!run || intPy(ouPy(run["routine_id"], 0)) !== rid) throw new HttpError(404, "Run introuvable");
        const statut = run["status"] ?? null;
        if (statut !== "running") return reponseJsonPy(rep, { ok: true, stopping: false, status: statut });
        const hb = run["heartbeat_at"] ?? null;
        if (hb === null || Date.now() / 1000 - floatPy(hb) > ORPHAN_STALE_AFTER_S) {
          const debut = floatPy(ouPy(run["started_at"], Date.now() / 1000));
          const duree = Math.trunc(Math.max(0, (hb !== null ? floatPy(hb) : debut) - debut) * 1000);
          const marque = await markRunCancelled(base, path.run_id, duree);
          return reponseJsonPy(rep, { ok: true, stopping: false, status: marque ? "cancelled" : statut });
        }
        planificateur.demanderArret(uid, rid, path.run_id);
        return { ok: true, stopping: true };
      }),
      route("POST", "/api/routines/:routine_id/webhook/rotate", async (req) => {
        const rid = idRoutine(req);
        const uid = utilisateur(req);
        await exiger(rid, uid);
        const secret = jetonSecret();
        if (!(await setRoutineWebhook(base, rid, uid, { enabled: true, secret })))
          throw new HttpError(404, INTROUVABLE);
        return { ok: true, secret, path: `/api/webhooks/routines/${rid}` };
      }),
      route("POST", "/api/routines/:routine_id/webhook/disable", async (req) => {
        const rid = idRoutine(req);
        const uid = utilisateur(req);
        await exiger(rid, uid);
        if (!(await setRoutineWebhook(base, rid, uid, { enabled: false })))
          throw new HttpError(404, INTROUVABLE);
        return { ok: true, webhook_enabled: false };
      }),
      route("POST", "/api/routines/:routine_id/webhook/filter", async (req, rep) => {
        const rid = idRoutine(req);
        const uid = utilisateur(req);
        await exiger(rid, uid);
        const flt = filtreWebhook(jsonDict(req));
        if (!(await setRoutineWebhook(base, rid, uid, { filter: flt })))
          throw new HttpError(404, INTROUVABLE);
        return reponseJsonPy(rep, { ok: true, webhook_filter: flt });
      }),
    ],
  };
}
