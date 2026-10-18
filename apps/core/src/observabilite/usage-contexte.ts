// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/usage-contexte.ts — qui consomme, pour le compte de quoi : contexte d'usage porté par l'appel et enregistrement d'un tour (shared_infra/observability/usage_ctx.py). */
import { AsyncLocalStorage } from "node:async_hooks";

import { estDict, estErreurPython, intPy, maxPy, minPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Executeur } from "@elpis/db";

import { journal } from "../journal";
import { currentEngine } from "../llm/moteurs";
import { recordUsage } from "./usage-registre";

const log = journal("usage");

export interface UsageContext {
  readonly source: string;
  readonly userId: number | null;
  readonly originId: string;
  readonly parentId: string;
}

const INCONNU: UsageContext = Object.freeze({ source: "unknown", userId: null, originId: "", parentId: "" });
const stockage = new AsyncLocalStorage<UsageContext>();

export function currentUsageCtx(): UsageContext {
  return stockage.getStore() ?? INCONNU;
}

export interface OptionsPorteeUsage {
  readonly userId?: number | null;
  readonly originId?: string;
  readonly parentId?: string;
  readonly inheritUser?: boolean;
}

function nomSource(source: string | null | undefined): string {
  return stripPy(source || "unknown") || "unknown";
}

/** Contexte d'un `usage_scope` imbriqué : compte hérité, origine et parent gardés tant qu'aucune origine n'est donnée. */
export function contexteImbrique(source: string, o: OptionsPorteeUsage = {}): UsageContext {
  const prev = currentUsageCtx();
  return {
    source: nomSource(source),
    userId: o.userId ?? ((o.inheritUser ?? true) ? prev.userId : null),
    originId: o.originId || prev.originId || "",
    parentId: o.parentId || (o.originId ? "" : prev.parentId) || "",
  };
}

/** `usage_scope` : l'appelant déclaré pour la durée de `fn` et des tâches qu'il lance, rétabli ensuite. */
export function usageScope<T>(source: string, options: OptionsPorteeUsage, fn: () => T): T {
  return stockage.run(contexteImbrique(source, options), fn);
}

/** Exécute `fn` dans un contexte vierge (« unknown ») : point d'entrée d'une tâche dont `setUsageContext` ne doit pas déborder. */
export function isolerUsage<T>(fn: () => T): T {
  return stockage.run(INCONNU, fn);
}

/** `set_usage_context` : pose le contexte pour la suite de la tâche courante, sans héritage (à réserver à une tâche déjà isolée). */
export function setUsageContext(
  source: string,
  o: { userId?: number | null; originId?: string; parentId?: string } = {},
): void {
  stockage.enterWith({
    source: nomSource(source),
    userId: o.userId ?? null,
    originId: o.originId || "",
    parentId: o.parentId || "",
  });
}

export interface UsageNormalise {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tool_tokens: number;
  thinking_tokens: number;
}

/** `int(x or 0)` borné à zéro ; une valeur illisible vaut 0. */
function compteur(u: Record<string, unknown>, cle: string): number {
  let v: number;
  try {
    const brut = Object.hasOwn(u, cle) ? u[cle] : null;
    v = intPy(veritePy(brut) ? brut : 0);
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return 0;
    throw e;
  }
  return v > 0 ? v : 0;
}

/** `normalize_usage` : compteurs réels d'un `usage` (forme OpenAI) ; cache et outils restent des sous-ensembles de l'entrée. */
export function normalizeUsage(usage: unknown): UsageNormalise {
  const u = estDict(usage) ? usage : {};
  const det = Object.hasOwn(u, "completion_tokens_details") ? u["completion_tokens_details"] : null;
  let raisonnement = 0;
  if (estDict(det)) {
    try {
      const brut = Object.hasOwn(det, "reasoning_tokens") ? det["reasoning_tokens"] : null;
      raisonnement = maxPy(0, intPy(veritePy(brut) ? brut : 0));
    } catch (e) {
      if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
      raisonnement = 0;
    }
  }
  return {
    input_tokens: compteur(u, "prompt_tokens") || compteur(u, "input_tokens"),
    output_tokens: compteur(u, "completion_tokens") || compteur(u, "output_tokens"),
    cache_read_tokens: compteur(u, "cache_read_input_tokens"),
    cache_creation_tokens: compteur(u, "cache_creation_input_tokens"),
    tool_tokens: compteur(u, "tool_input_tokens"),
    thinking_tokens: raisonnement,
  };
}

/** Usage versé à l'exécution courante (`runs`, lot B1-20b) : mêmes compteurs que la ligne du registre. */
export interface UsageExecution {
  source: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  thinking_tokens: number;
  tool_tokens: number;
  error_kind: string;
}

/** `current_run()` vu du registre d'usage : identifiant et cumul des jetons ; posé par le lot des exécutions. */
export interface ExecutionPourUsage {
  readonly id: string;
  ajouterUsage(u: UsageExecution): void;
}

let executionCourante: (() => ExecutionPourUsage | null) | null = null;

export function installerExecutionUsage(f: (() => ExecutionPourUsage | null) | null): void {
  executionCourante = f;
}

function execution(): ExecutionPourUsage | null {
  try {
    return executionCourante ? executionCourante() : null;
  } catch {
    return null;
  }
}

/** `_engine_key` : `builtin`, `conn:<id>` ou `url:<racine>`, vide si le moteur est illisible. */
function cleMoteur(): string {
  try {
    return strPy(currentEngine().key || "");
  } catch {
    return "";
  }
}

function explicite(v: number | null | undefined, defaut: number): number {
  if (v === null || v === undefined) return defaut;
  return maxPy(0, intPy(veritePy(v) ? v : 0));
}

export interface TourUsage {
  usage?: unknown;
  model?: string;
  path?: string;
  connector?: string;
  durationMs?: unknown;
  iterations?: unknown;
  status?: string;
  errorKind?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  submittedTokens?: number | null;
  thinkingTokens?: number | null;
}

/** `record_turn_usage` : UNE ligne de registre par tour, contexte lu à l'appel, écriture hors de la boucle ; jamais d'exception. */
export function recordTurnUsage(x: Executeur, t: TourUsage): Promise<boolean> {
  let ligne: Parameters<typeof recordUsage>[1];
  try {
    const ctx = currentUsageCtx();
    const connector = t.connector || cleMoteur();
    const norm = normalizeUsage(t.usage);
    const inT = explicite(t.inputTokens, norm.input_tokens);
    const outT = explicite(t.outputTokens, norm.output_tokens);
    let thinkT = explicite(t.thinkingTokens, norm.thinking_tokens);
    if (outT) thinkT = minPy(thinkT, outT);
    const toolT = minPy(norm.tool_tokens, inT);
    const status = t.status ?? "ok";
    const errorKind = t.errorKind ?? "";
    const run = execution();
    if (run !== null) {
      run.ajouterUsage({
        source: ctx.source,
        status,
        input_tokens: inT,
        output_tokens: outT,
        cache_read_tokens: norm.cache_read_tokens,
        cache_creation_tokens: norm.cache_creation_tokens,
        thinking_tokens: thinkT,
        tool_tokens: toolT,
        error_kind: errorKind,
      });
    }
    ligne = {
      runId: run !== null ? run.id : "",
      userId: ctx.userId,
      source: ctx.source,
      originId: ctx.originId,
      parentId: ctx.parentId,
      model: t.model ?? "",
      connector,
      path: t.path ?? "",
      inputTokens: inT,
      outputTokens: outT,
      submittedTokens:
        t.submittedTokens === null || t.submittedTokens === undefined ? inT : t.submittedTokens,
      thinkingTokens: thinkT,
      toolTokens: toolT,
      cacheReadTokens: norm.cache_read_tokens,
      cacheCreationTokens: norm.cache_creation_tokens,
      durationMs: t.durationMs ?? 0,
      iterations: t.iterations ?? 0,
      status,
      errorKind,
    };
  } catch (e) {
    log.debug({ err: e }, "[usage] record_turn_usage failed (non-fatal)");
    return Promise.resolve(false);
  }
  return recordUsage(x, ligne).catch((e: unknown) => {
    log.debug({ err: e }, "[usage] record_turn_usage failed (non-fatal)");
    return false;
  });
}
