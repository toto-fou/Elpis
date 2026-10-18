// SPDX-License-Identifier: MIT
/** apps/core/src/administration/trafic-llm.ts — lecture et purge des échanges capturés dans `llm_calls` pour la console « Trafic LLM » (shared_infra/llm/debug.py). */
import {
  ErreurJsonPy,
  ErreurLecturePy,
  FlottantPy,
  intPy,
  maxPy,
  minPy,
  pyJsonLoads,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur, Valeur } from "@elpis/db";

const COLONNES_RESUME =
  "id, ts, req_id, user_id, chat_id, model, path, status, finish_reason, " +
  "prompt_tokens, completion_tokens, duration_ms, n_messages, n_tool_calls, error";

export interface FiltresTrafic {
  limit: number;
  user_id: number | null;
  model: string | null;
  status: string | null;
  chat_id: string | null;
}

/** `ts` est une colonne REAL : rendue en float Python (`1.0`), même quand la valeur est entière. */
function ligneDeTrafic(r: Dict): Dict {
  const ts = r["ts"];
  return typeof ts === "number" ? { ...r, ts: new FlottantPy(ts) } : r;
}

/** `list_llm_calls` : résumés sans les charges, filtres facultatifs, `limit` borné à [1, 1000] (0 → 100). */
export async function listLlmCalls(base: Executeur, f: FiltresTrafic): Promise<Dict[]> {
  const where: string[] = [];
  const params: Valeur[] = [];
  if (f.user_id !== null) {
    where.push("user_id=?");
    params.push(intPy(f.user_id));
  }
  if (f.model) {
    where.push("model=?");
    params.push(f.model);
  }
  if (f.status) {
    where.push("status=?");
    params.push(f.status);
  }
  if (f.chat_id) {
    where.push("chat_id=?");
    params.push(f.chat_id);
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const limite = maxPy(1, minPy(intPy(veritePy(f.limit) ? f.limit : 100), 1000));
  const lignes = await base.all(
    `SELECT ${COLONNES_RESUME} FROM llm_calls${clause} ORDER BY id DESC LIMIT ?`,
    [...params, limite],
  );
  return lignes.map(ligneDeTrafic);
}

/** `_maybe_json` : colonne JSON relue comme `json.loads`, le texte brut s'il est illisible (ValueError), `null` si vide ; RecursionError remonte. */
export function peutEtreJson(s: unknown): unknown {
  if (!veritePy(s)) return null;
  try {
    return pyJsonLoads(s as string);
  } catch (e) {
    if (e instanceof ErreurJsonPy || (e instanceof ErreurLecturePy && e.nature !== "RecursionError"))
      return s;
    throw e;
  }
}

/** `get_llm_call` puis la route : `request_json`/`response_json` retirés et rendus décodés en fin d'objet ; `null` si absent. */
export async function getLlmCall(base: Executeur, callId: number): Promise<Dict | null> {
  const r = await base.get("SELECT * FROM llm_calls WHERE id=?", [callId]);
  if (!r) return null;
  const { request_json: requete, response_json: reponse, ...reste } = ligneDeTrafic(r);
  return { ...reste, request: peutEtreJson(requete ?? null), response: peutEtreJson(reponse ?? null) };
}

/** `clear_llm_calls` : vide la table et rend le nombre de lignes supprimées. */
export async function clearLlmCalls(base: Executeur): Promise<number> {
  const ligne = await base.get<{ n: unknown }>("SELECT COUNT(*) AS n FROM llm_calls");
  const n = intPy(ligne?.n ?? 0);
  await base.run("DELETE FROM llm_calls");
  return n;
}
