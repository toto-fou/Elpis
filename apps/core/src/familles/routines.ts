// SPDX-License-Identifier: MIT
/** apps/core/src/familles/routines.ts — API des routines planifiées : CRUD, activation, run immédiat, journal et arrêt des runs, déclencheur webhook (shared_infra/scheduling/routes_routines.py). */
import { randomBytes } from "node:crypto";

import {
  ErreurPython,
  estDict,
  estEntierPy,
  FlottantPy,
  floatPy,
  HttpError,
  intPy,
  lire,
  longueurPy,
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
import { clientBuiltinRef } from "@elpis/mcp";
import type { FastifyRequest } from "fastify";

import { exigerMoteurOuvert } from "../llm/acces-moteurs";
import { EngineUnavailable, resolveLlmTarget } from "../llm/cible";
import { connectorKey } from "../llm/moteurs";
import { validateCron } from "../routines/cron";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  getRun,
  KEEP_MAX,
  listRoutines,
  listRuns,
  markRunCancelled,
  NOTIFY_ON_VALUES,
  setRoutineEnabled,
  setRoutineWebhook,
  updateRoutine,
} from "../routines/magasin";
import { journal } from "../journal";
import type { ChampsRoutine } from "../routines/magasin";
import { ORPHAN_STALE_AFTER_S } from "../routines/planificateur";
import type { Planificateur } from "../routines/planificateur";
import { discoverSkills, userSkillsDir } from "../skills/bibliotheque";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, horsBornes, py, reponseJsonPy } from "@elpis/http";

const log = journal("routines");

export interface DependancesRoutines {
  readonly base: Base;
  readonly planificateur: Planificateur;
  /** `secrets.token_hex(32)` ; injectable pour les tests. */
  readonly jetonSecret?: () => string;
}

const SKILLS_MAX = 12;
const PROMPT_MAX = 200_000;
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

/** `_req_str` : absent ou `null` → "", autre chose qu'une chaîne → 400, bornée en points de code. */
function reqStr(data: Dict, cle: string, max = 0): string {
  const v = lire(data, cle);
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HttpError(400, `${cle} doit être une chaîne`);
  if (max && longueurPy(v) > max) throw new HttpError(400, `${cle} trop long (max ${max} caractères)`);
  return v;
}

/** `raw in (None, "", 0, "0")` en égalité Python (False et 0.0 valent 0). */
function idVide(v: unknown): boolean {
  if (v === undefined || v === null || v === "" || v === "0" || v === false) return true;
  if (v instanceof FlottantPy) return v.valeur === 0;
  return v === 0;
}

/** `int(x)` d'un champ du corps : TypeError/ValueError → 400 `message` ; OverflowError ou au-delà de 2^53 → 400 « Paramètre hors bornes. » (E19). */
function entierCorps(v: unknown, message: string): number {
  let n: number;
  try {
    n = intPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "OverflowError") throw horsBornes();
    throw new HttpError(400, message);
  }
  if (!Number.isSafeInteger(n)) throw horsBornes();
  return n;
}

async function skillsConnus(uid: number): Promise<Set<string> | null> {
  let specs;
  try {
    specs = await discoverSkills(await userSkillsDir(uid), { includeLearned: false });
  } catch (e) {
    log.warn(`[routines.skills] compétences illisibles (${String(e)})`);
    return null;
  }
  const ids = new Set<string>();
  for (const sp of specs) {
    ids.add(sp.id || sp.name);
    ids.add(sp.name);
  }
  return ids;
}

/** `_validate_skills` : identifiants non vides, dédupliqués, 12 au plus, connus si la découverte répond. */
async function validerSkills(data: Dict, uid: number): Promise<string[]> {
  const brut = lire(data, "skills");
  if (brut === undefined || brut === null) return [];
  if (!Array.isArray(brut)) throw new HttpError(400, "skills doit être une liste d'identifiants");
  const out: string[] = [];
  for (const s0 of brut) {
    if (typeof s0 !== "string" || !stripPy(s0))
      throw new HttpError(400, "skills : identifiants (strings) non vides attendus");
    const s = stripPy(s0);
    if (longueurPy(s) > 200) throw new HttpError(400, "skills : identifiant trop long");
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > SKILLS_MAX) throw new HttpError(400, `skills : maximum ${SKILLS_MAX} skills par routine`);
  const connus = await skillsConnus(uid);
  if (connus !== null) {
    const inconnus = out.filter((s) => !connus.has(s));
    if (inconnus.length) throw new HttpError(400, "Skill introuvable : " + inconnus.join(", "));
  }
  return out;
}

/** `_mcp_refs` : instantané MCP réduit à des références (sentinelle reconstruite, id, manifeste, nom). */
export function referencesMcp(mcp: unknown): Dict[] {
  if (!Array.isArray(mcp)) throw new HttpError(400, "mcp_servers doit être une liste");
  const out: Dict[] = [];
  for (const raw of mcp.slice(0, 64)) {
    if (!estDict(raw)) continue;
    const ref = clientBuiltinRef(raw);
    if (ref !== null) {
      out.push(ref);
      continue;
    }
    const entree: Dict = {};
    if (veritePy(lire(raw, "id"))) {
      entree["id"] = prefixePy(strPy(lire(raw, "id")), 120);
      if (veritePy(lire(raw, "shared"))) entree["shared"] = true;
    } else if (veritePy(lire(raw, "manifest"))) {
      entree["manifest"] = prefixePy(strPy(lire(raw, "manifest")), 120);
      const cats = lire(raw, "filter_categories");
      if (Array.isArray(cats))
        entree["filter_categories"] = cats.filter((c) => typeof c === "string").slice(0, 64);
    } else if (veritePy(lire(raw, "url")) || veritePy(lire(raw, "name"))) {
      if (veritePy(lire(raw, "url"))) entree["url"] = prefixePy(strPy(lire(raw, "url")), 2000);
    } else continue;
    if (veritePy(lire(raw, "name"))) entree["name"] = prefixePy(strPy(lire(raw, "name")), 120);
    const type = lire(raw, "type");
    if (typeof type === "string") entree["type"] = prefixePy(type, 16);
    out.push(entree);
  }
  return out;
}

/** `_validate_history` : seules les clés présentes ; jamais d'arrondi silencieux (`true`, `2.7` → 400). */
export function validerHistorique(data: Dict): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const k of ["runs_keep", "notify_keep"]) {
    if (!Object.hasOwn(data, k)) continue;
    let v = data[k];
    if (v === null || v === "") v = 0;
    if (typeof v === "boolean" || !(estEntierPy(v) || typeof v === "string"))
      throw new HttpError(400, `${k} : entier attendu`);
    let n: number | bigint;
    if (typeof v === "string") {
      try {
        n = intPy(stripPy(v));
      } catch {
        throw new HttpError(400, `${k} : entier attendu`);
      }
    } else n = v as number | bigint;
    if (n < 0 || n > KEEP_MAX) throw new HttpError(400, `${k} : entre 0 (tous) et ${KEEP_MAX}`);
    out[k] = Number(n);
  }
  if (Object.hasOwn(data, "notify_on")) {
    let v = data["notify_on"];
    v = v === null ? "all" : v;
    if (typeof v !== "string") throw new HttpError(400, "notify_on invalide (all | error | none)");
    const on = lowerPy(stripPy(v));
    if (!NOTIFY_ON_VALUES.includes(on)) throw new HttpError(400, "notify_on invalide (all | error | none)");
    out["notify_on"] = on;
  }
  return out;
}

/** `_validate_trigger_after` : routine amont du même compte, jamais elle-même ; `trigger_after_on` ∈ ok | error | always. */
async function validerAval(
  base: Base,
  data: Dict,
  uid: number,
  routineId: number | null,
): Promise<[number | null, string]> {
  const brut = lire(data, "trigger_after_id");
  let afterId: number | null = null;
  if (!idVide(brut)) {
    afterId = entierCorps(brut, "trigger_after_id invalide");
    if (routineId !== null && routineId === afterId)
      throw new HttpError(400, "Une routine ne peut pas s'enchaîner après elle-même");
    if (!(await getRoutine(base, afterId, uid))) throw new HttpError(404, "Routine amont introuvable");
  }
  const onBrut = lire(data, "trigger_after_on");
  const on = veritePy(onBrut) ? lowerPy(stripPy(strPy(onBrut))) : "ok";
  if (!["ok", "error", "always"].includes(on))
    throw new HttpError(400, "trigger_after_on invalide (ok | error | always)");
  return [afterId, on];
}

/** `_validate_connector` : serveur visible, actif et ouvert au compte (`null` = intégré). */
async function validerConnecteur(base: Base, data: Dict, uid: number): Promise<number | null> {
  const brut = lire(data, "connector_id");
  if (idVide(brut)) return null;
  const cid = entierCorps(brut, "connector_id invalide");
  try {
    await resolveLlmTarget(uid, cid, null, { strict: true, touch: false });
  } catch (e) {
    if (e instanceof EngineUnavailable) throw new HttpError(400, e.message);
    throw e;
  }
  if (!(await exigerMoteurOuvert(base, uid, connectorKey(cid))))
    throw new HttpError(403, "Ce serveur ne vous est pas ouvert.");
  return cid;
}

/** `mcp_servers`, sinon `active_mcp_servers` ou []. */
function mcpDuCorps(data: Dict): unknown {
  const mcp = lire(data, "mcp_servers");
  return mcp === undefined || mcp === null ? ouPy(lire(data, "active_mcp_servers"), []) : mcp;
}

/** `_routine_payload` : champs d'une création, validés dans l'ordre de Python. */
async function chargeRoutine(base: Base, data: Dict, uid: number): Promise<ChampsRoutine> {
  const name = stripPy(reqStr(data, "name"));
  if (!name) throw new HttpError(400, "Nom requis");
  const brutCron = stripPy(reqStr(data, "cron_expr") || reqStr(data, "cron"));
  const cronExpr = brutCron ? validateCron(brutCron) : "";
  const mcp = referencesMcp(mcpDuCorps(data));
  const [afterId, afterOn] = await validerAval(base, data, uid, null);
  const historique = validerHistorique(data);
  const model = reqStr(data, "model", 200) || null;
  const connectorId = await validerConnecteur(base, data, uid);
  const systemPrompt = reqStr(data, "system_prompt", PROMPT_MAX);
  const taskPrompt = reqStr(data, "task_prompt", PROMPT_MAX);
  const skills = await validerSkills(data, uid);
  return {
    name: prefixePy(name, 200),
    cron_expr: cronExpr,
    model,
    connector_id: connectorId,
    system_prompt: systemPrompt,
    task_prompt: taskPrompt,
    mcp_servers: mcp,
    skills,
    thinking_mode: veritePy(lire(data, "thinking_mode")),
    enabled: Object.hasOwn(data, "enabled") ? veritePy(data["enabled"]) : true,
    trigger_after_id: afterId,
    trigger_after_on: afterOn,
    agents_enabled: veritePy(lire(data, "agents_enabled")),
    runs_keep: historique["runs_keep"] ?? 0,
    notify_on: historique["notify_on"] ?? "all",
    notify_keep: historique["notify_keep"] ?? 0,
  };
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
