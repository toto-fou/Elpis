// SPDX-License-Identifier: MIT
/** apps/core/src/routines/validation.ts — validation partagée d'une routine (formulaire, API et outil routine_save). */
import {
  ErreurPython,
  estDict,
  estEntierPy,
  FlottantPy,
  HttpError,
  intPy,
  lire,
  longueurPy,
  lowerPy,
  ouPy,
  prefixePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { clientBuiltinRef } from "@elpis/mcp";
import { horsBornes } from "@elpis/http";

import { exigerMoteurOuvert } from "../llm/acces-moteurs";
import { EngineUnavailable, resolveLlmTarget } from "../llm/cible";
import { connectorKey } from "../llm/moteurs";
import { journal } from "../journal";
import { discoverSkills, userSkillsDir } from "../skills/bibliotheque";
import { validateCron } from "./cron";
import { getRoutine, KEEP_MAX, NOTIFY_ON_VALUES } from "./magasin";
import type { ChampsRoutine } from "./magasin";

const log = journal("routines");

export const SKILLS_MAX = 12;
export const PROMPT_MAX = 200_000;

/** `_req_str` : absent ou `null` → "", autre chose qu'une chaîne → 400, bornée en points de code. */
export function reqStr(data: Dict, cle: string, max = 0): string {
  const v = lire(data, cle);
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HttpError(400, `${cle} doit être une chaîne`);
  if (max && longueurPy(v) > max) throw new HttpError(400, `${cle} trop long (max ${max} caractères)`);
  return v;
}

/** `raw in (None, "", 0, "0")` en égalité Python (False et 0.0 valent 0). */
export function idVide(v: unknown): boolean {
  if (v === undefined || v === null || v === "" || v === "0" || v === false) return true;
  if (v instanceof FlottantPy) return v.valeur === 0;
  return v === 0;
}

/** `int(x)` d'un champ du corps : TypeError/ValueError → 400 `message` ; OverflowError ou au-delà de 2^53 → 400 « Paramètre hors bornes. » (E19). */
export function entierCorps(v: unknown, message: string): number {
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

export async function skillsConnus(uid: number): Promise<Set<string> | null> {
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
export async function validerSkills(data: Dict, uid: number): Promise<string[]> {
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
export async function validerAval(
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
export async function validerConnecteur(base: Base, data: Dict, uid: number): Promise<number | null> {
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
export function mcpDuCorps(data: Dict): unknown {
  const mcp = lire(data, "mcp_servers");
  return mcp === undefined || mcp === null ? ouPy(lire(data, "active_mcp_servers"), []) : mcp;
}

/** `_routine_payload` : champs d'une création, validés dans l'ordre de Python. */
export async function chargeRoutine(base: Base, data: Dict, uid: number): Promise<ChampsRoutine> {
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
