// SPDX-License-Identifier: MIT
/** apps/core/src/executions/chronologie.ts — chronologie d'une exécution (tours LLM, appels d'outils, exécutions filles) et export aux secrets masqués (port de shared_infra/observability/runs_timeline.py). */
import {
  BLANC_PY,
  estDict,
  FlottantPy,
  motifPy,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  strPy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur, Valeur } from "@elpis/db";

import { getChat } from "../chats/stockage";
import { getRun, lignePy } from "./registre";

const PROFONDEUR_MAX = 4;
const ENFANTS_MAX = 200;
const EVENEMENTS_MAX = 2000;
const ARGUMENT_MAX = 240;
const RESULTAT_MAX = 600;
const CLES_PRINCIPALES = [
  "command",
  "cmd",
  "path",
  "file_path",
  "paths",
  "query",
  "url",
  "pattern",
  "action",
  "name",
  "repo",
  "target",
] as const;

const nombre = (v: unknown): number => (v instanceof FlottantPy ? v.valeur : Number(v ?? 0) || 0);

/** L'exécution existe et appartient au compte (ou l'appelant est admin) : l'identifiant seul ne suffit jamais. */
export function runAccessible(run: Dict | null, userId: number, isAdmin = false): boolean {
  if (!run) return false;
  return (
    isAdmin || (run["user_id"] !== null && run["user_id"] !== undefined && Number(run["user_id"]) === userId)
  );
}

async function lignes(x: Executeur, table: string, sql: string, params: Valeur[]): Promise<Dict[]> {
  return (await x.all(sql, params)).map((r) => lignePy(table, r));
}

/** `_enfants` : exécutions filles, récursives jusqu'à `PROFONDEUR_MAX`. */
export async function enfants(x: Executeur, runId: string, profondeur = 0): Promise<Dict[]> {
  if (profondeur >= PROFONDEUR_MAX) return [];
  const ids = await x.all<{ id: string }>(
    "SELECT id FROM runs WHERE parent_id = ? ORDER BY started_at LIMIT ?",
    [runId, ENFANTS_MAX],
  );
  const rendu: Dict[] = [];
  for (const r of ids) {
    const d = await getRun(x, r.id);
    if (d !== null) {
      d["children"] = await enfants(x, String(d["id"]), profondeur + 1);
      rendu.push(d);
    }
  }
  return rendu;
}

const jsonPy = (v: unknown): string => pyJsonDumps(v, { ensureAscii: false });

/** `_argument_principal` : l'argument qui résume l'appel (commande, chemin, requête…), tronqué. */
export function argumentPrincipal(argumentsBruts: unknown): string {
  let args: unknown;
  try {
    args = typeof argumentsBruts === "string" ? pyJsonLoads(argumentsBruts) : argumentsBruts;
  } catch {
    return prefixePy(String(argumentsBruts), ARGUMENT_MAX);
  }
  if (!estDict(args)) return prefixePy(strPy(args), ARGUMENT_MAX);
  for (const cle of CLES_PRINCIPALES) {
    const v = args[cle];
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    return prefixePy(`${cle}: ` + (typeof v === "string" ? v : jsonPy(v)), ARGUMENT_MAX);
  }
  return prefixePy(jsonPy(args), ARGUMENT_MAX);
}

/** `_appels_du_message` : `{call_id: {name, argument, result}}` d'après la `tool_history` du message qui porte `runId`. */
async function appelsDuMessage(
  x: Executeur,
  userId: unknown,
  chatId: unknown,
  runId: string,
): Promise<Map<string, Dict>> {
  const rendu = new Map<string, Dict>();
  if (!chatId) return rendu;
  let chat: Dict;
  try {
    chat = (await getChat(x, Math.trunc(Number(userId)), strPy(chatId))) ?? {};
  } catch {
    return rendu;
  }
  const entree = (id: string): Dict => {
    let d = rendu.get(id);
    if (d === undefined) rendu.set(id, (d = {}));
    return d;
  };
  for (const m of Array.isArray(chat["messages"]) ? chat["messages"] : []) {
    if (!estDict(m)) continue;
    const runIds = m["run_ids"];
    if (!(Array.isArray(runIds) ? runIds : []).includes(runId)) continue;
    for (const h of Array.isArray(m["tool_history"]) ? m["tool_history"] : []) {
      if (!estDict(h)) continue;
      if (h["role"] === "assistant") {
        for (const tc of Array.isArray(h["tool_calls"]) ? h["tool_calls"] : []) {
          if (!estDict(tc) || !tc["id"]) continue;
          const fn = estDict(tc["function"]) ? tc["function"] : {};
          Object.assign(entree(strPy(tc["id"])), {
            name: strPy(fn["name"] || ""),
            argument: argumentPrincipal(fn["arguments"]),
          });
        }
      } else if (h["role"] === "tool" && h["tool_call_id"]) {
        const contenu = h["content"];
        const texte = typeof contenu === "string" ? contenu : jsonPy(contenu);
        entree(strPy(h["tool_call_id"]))["result"] = prefixePy(texte || "", RESULTAT_MAX);
      }
    }
  }
  return rendu;
}

/** `timeline` : événements triés par instant (tours LLM, appels d'outils, filles), puis les exécutions filles. */
export async function timeline(x: Executeur, run: Dict): Promise<Dict> {
  const rid = strPy(run["id"]);
  const evenements: Dict[] = [];
  for (const u of await lignes(
    x,
    "usage_events",
    "SELECT ts, source, model, connector, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, tool_tokens, duration_ms, iterations, status, error_kind FROM usage_events WHERE run_id = ? ORDER BY ts LIMIT ?",
    [rid, EVENEMENTS_MAX],
  )) {
    const debut = nombre(u["ts"]) - Math.trunc(nombre(u["duration_ms"])) / 1000.0;
    evenements.push({ type: "llm", at: versFlottantPy(debut), ...u });
  }
  const appels = await appelsDuMessage(x, run["user_id"] || 0, run["chat_id"] || "", rid);
  for (const t of await lignes(
    x,
    "tool_call_metrics",
    "SELECT call_id, started_at, ts, tool_name, category, status, duration_ms, exit_code, args_bytes, result_bytes, error_short FROM tool_call_metrics WHERE run_id = ? ORDER BY ts LIMIT ?",
    [rid, EVENEMENTS_MAX],
  )) {
    const debut = nombre(t["started_at"]) || nombre(t["ts"]) - Math.trunc(nombre(t["duration_ms"])) / 1000.0;
    const detail = appels.get(strPy(t["call_id"] || "")) ?? {};
    evenements.push({
      type: "tool",
      at: versFlottantPy(debut),
      ...t,
      argument: detail["argument"] ?? "",
      result: detail["result"] ?? "",
    });
  }
  const filles = await enfants(x, rid);
  for (const e of filles) {
    const debut = nombre(e["started_at"]);
    const fin = nombre(e["ended_at"]) || debut;
    evenements.push({
      type: "child",
      at: versFlottantPy(debut),
      run_id: e["id"],
      kind: e["kind"] ?? null,
      status: e["status"] ?? null,
      duration_ms: Math.trunc((fin - debut) * 1000),
    });
  }
  evenements.sort((a, b) => nombre(a["at"]) - nombre(b["at"]));
  return { run, events: evenements, children: filles };
}

// ── Export : secrets masqués ────────────────────────────────────────────────
const BL = BLANC_PY;
const BL_INTERIEUR = BLANC_PY.slice(1, -1);
const DEBUT_MOT = "(?<![\\p{L}\\p{N}_])";
/** `[a-z0-9_]` sous `re.IGNORECASE` : majuscules, K de Kelvin, ſ, İ et ı compris. */
const ALNUM_I = "[a-zA-Z0-9_\\u212a\\u017f\\u0130\\u0131]";
const SECRETS = [
  new RegExp(
    `${DEBUT_MOT}(${motifPy("proxy-authorization")}|${motifPy("authorization")})${BL}*[:=]${BL}*(${motifPy("bearer")}|${motifPy("basic")}|${motifPy("token")})?${BL}*[^${BL_INTERIEUR}"',;]+`,
    "gu",
  ),
  new RegExp(
    `${DEBUT_MOT}(${ALNUM_I}*(?:${["token", "secret", "password", "passwd"].map(motifPy).join("|")}|${motifPy("api")}[_-]?${motifPy("key")}|${motifPy("access")}[_-]?${motifPy("key")})${ALNUM_I}*)` +
      `(\\\\?["']?${BL}*[:=]${BL}*)` +
      `(\\\\?"(?:[^"\\\\]|\\\\(?!"))*\\\\?"|'[^']*'|[^${BL_INTERIEUR}"',;&\\\\]+)`,
    "gu",
  ),
  new RegExp(
    `${DEBUT_MOT}(?:pcr|ept|evt|ghp|gho|ghs|glpat|xox[abp]|sk|sk-ant)[-_][A-Za-z0-9_\\-]{12,}`,
    "gu",
  ),
  new RegExp(`(${motifPy("http")}[sS\\u017f]?://)[^/${BL_INTERIEUR}:@]+:[^/${BL_INTERIEUR}@]+@`, "gu"),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/gu,
] as const;

/** `masquer` : en-têtes d'authentification, `clé=valeur` sensibles, jetons connus, identifiants d'URL et clés privées remplacés. */
export function masquer(texte: string): string {
  let t = texte;
  t = t.replace(SECRETS[0], (_m, g1: string) => `${g1}: ***`);
  t = t.replace(SECRETS[1], (_m, g1: string, g2: string) => `${g1}${g2}***`);
  t = t.replace(SECRETS[2], "***");
  t = t.replace(SECRETS[3], (_m, g1: string) => `${g1}***@`);
  t = t.replace(SECRETS[4], "-----PRIVATE KEY (masquée)-----");
  return t;
}

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

/** `export` : chronologie complète (filles comprises), secrets masqués. */
export async function exporter(x: Executeur, run: Dict): Promise<Dict> {
  const t = await timeline(x, run);
  const filles = t["children"] as Dict[];
  const enfantsChronologies: Dict[] = [];
  for (const e of filles) enfantsChronologies.push(await timeline(x, e));
  return masquerObjet({ format: "elpis-run/1", ...t, children_timelines: enfantsChronologies }) as Dict;
}
