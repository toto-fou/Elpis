// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/run.ts — état d'un run de la boucle : dépendances injectées, constantes du run, trace (historique d'outils borné, lot en cours, usage). */
import { config } from "@elpis/config";
import { estDict, estErreurAnnulation, intPy, longueurPy, pyJsonDumps, strPy, stripPy } from "@elpis/commun";

import { estTokensText, toolPromptTokens } from "../contexte/tokens";
import type { Slot } from "../llm/ordonnanceur";
import { journal } from "../journal";
import type { Dict } from "../python";
import { resultIsToolFailure } from "./contrat-resultat";
import type { SurEvenement } from "./evenements";
import type { ConfigMcp } from "@elpis/mcp";
import type { SousAgent } from "@elpis/securite";
import type { OutilIntegre } from "../outils/catalogue";

import type { LlamaChatFn } from "../contexte/compresseur";
import type { OptionsFlux } from "./flux-llm";

const log = journal("boucle.run");

export const THINKING_HISTORY_TRUNC_MARKER =
  "[…raisonnement des itérations antérieures omis (trop volumineux)…]";

/** Borne EN PLACE le raisonnement cumulé (suffixe gardé, dernier bloc toujours entier). */
export function clipThinkingHistory(parts: string[]): void {
  const max = Math.max(0, intPy(config.THINKING_HISTORY_MAX_CHARS || 0));
  if (max <= 0 || parts.length <= 1) return;
  const total = parts.reduce((n, p) => n + longueurPy(p), 0);
  if (total <= max) return;
  const gardes: string[] = [];
  let acc = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (gardes.length && acc + longueurPy(p) > max) break;
    gardes.push(p);
    acc += longueurPy(p);
  }
  gardes.reverse();
  if (gardes.length < parts.length) gardes.unshift(THINKING_HISTORY_TRUNC_MARKER);
  parts.splice(0, parts.length, ...gardes);
}

export const RUN_TOOL_HISTORY_MAX_BYTES = Math.max(
  262_144,
  intPy(process.env["RUN_TOOL_HISTORY_MAX_BYTES"] ?? String(8 * 1024 * 1024)),
);

function poidsJson(v: unknown): number {
  try {
    return longueurPy(pyJsonDumps(v, { ensureAscii: false }));
  } catch {
    return 0;
  }
}

/** Poids des `tool_calls` d'un message (noms + arguments). */
export function toolCallArgsWeight(msg: Dict): number {
  let total = 0;
  const appels = msg["tool_calls"];
  for (const tc of Array.isArray(appels) ? appels : []) {
    if (!estDict(tc)) continue;
    const fn = tc["function"] || {};
    if (!estDict(fn)) continue;
    if (typeof fn["name"] === "string") total += longueurPy(fn["name"]);
    const args = fn["arguments"];
    if (typeof args === "string") total += longueurPy(args);
    else if (args !== null && args !== undefined) total += poidsJson(args);
  }
  return total;
}

/** Poids d'un message de la `tool_history`, arguments compris. */
export function toolMsgWeight(msg: Dict): number {
  const c = msg["content"];
  let total = 0;
  if (typeof c === "string") total += longueurPy(c);
  else if (c !== null && c !== undefined) total += poidsJson(c);
  return total + toolCallArgsWeight(msg);
}

/** Borne la `tool_history` d'un run : vieux résultats puis vieux arguments élagués, structure intacte. */
export function capRunToolHistory(hist: Dict[], maxBytes = RUN_TOOL_HISTORY_MAX_BYTES): Dict[] {
  let total = hist.reduce((n, m) => n + toolMsgWeight(m), 0);
  if (total <= maxBytes) return hist;
  const out: Dict[] = hist.map((m) => ({ ...m }));
  let budgetQueue = Math.floor(maxBytes / 2);
  const proteges = new Set<number>();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!["role"] !== "tool") continue;
    const w = toolMsgWeight(out[i]!);
    if (w > budgetQueue) break;
    budgetQueue -= w;
    proteges.add(i);
  }
  for (let i = 0; i < out.length; i++) {
    if (total <= maxBytes) break;
    const m = out[i]!;
    if (proteges.has(i) || m["role"] !== "tool") continue;
    const w = toolMsgWeight(m);
    if (w < 2048) continue;
    m["content"] =
      `[résultat élagué — ${w} caractères ; l'historique d'outils de ce run a dépassé son budget de ${Math.floor(maxBytes / (1024 * 1024))} Mo]`;
    m["content_elided"] = true;
    total -= w - toolMsgWeight(m);
  }
  if (total > maxBytes) {
    const garde = Math.max(0, out.length - 8);
    for (let i = 0; i < garde; i++) {
      if (total <= maxBytes) break;
      const m = out[i]!;
      if (m["role"] !== "assistant" || !Array.isArray(m["tool_calls"]) || !m["tool_calls"].length) continue;
      const w = toolCallArgsWeight(m);
      if (w < 2048) continue;
      const appels = (m["tool_calls"] as unknown[]).map((tc) => {
        if (!estDict(tc)) return tc;
        const fn: Dict = { ...(estDict(tc["function"]) ? tc["function"] : {}) };
        const args = fn["arguments"];
        const n = typeof args === "string" ? longueurPy(args) : 0;
        if (n >= 512)
          fn["arguments"] = pyJsonDumps(
            { _elided: `arguments élagués — ${n} caractères (budget de tool_history atteint)` },
            { ensureAscii: false },
          );
        return { ...tc, function: fn };
      });
      out[i] = { ...m, tool_calls: appels, args_elided: true };
      total -= w - toolCallArgsWeight(out[i]!);
    }
  }
  if (total > maxBytes)
    log.warn(`[run_chat_multi_mcp] tool_history encore à ${total} o après élagage (budget ${maxBytes} o)`);
  return out;
}

/** `content` en texte : chaîne, ou blocs d'un fournisseur multimodal réduits à leur texte. */
export function contentText(content: unknown): string {
  if (Array.isArray(content))
    return content.map((b) => (estDict(b) ? strPy(b["text"] || "") : strPy(b))).join("");
  return typeof content === "string"
    ? content
    : content === null || content === undefined
      ? ""
      : strPy(content);
}

export type FluxFn = (
  messages: readonly unknown[],
  tools: readonly unknown[] | null,
  o: OptionsFlux,
) => Promise<Dict>;

/** Dépendances injectées dans les sous-routines (points de substitution des tests). */
export interface LoopDeps {
  stream: FluxFn;
  recordMetric: (...args: unknown[]) => unknown;
  /** Résumé de la compaction dans le tour (appel unique sans outils, dans le slot du tour). */
  llamaChat: LlamaChatFn;
}

export interface ChampsRun {
  onEvent: SurEvenement;
  username: string;
  model: string | null;
  chatId: string | null;
  userId: number | null;
  samplingOverride: Dict | null;
  thinkingMode: boolean;
  isCancelled: (() => boolean) | null;
  signal: AbortSignal | undefined;
  slot: Slot | null;
  compressionEnabled: boolean | null;
  /** Tour éphémère : aucune indexation pour session_search. */
  ephemeral?: boolean;
  compactionMaxRounds: number | null;
  priority: string;
  liveShell: boolean;
  /** Périmètre du sous-agent qui fait ce run, `null` pour un tour de premier niveau. */
  subagent?: SousAgent | null;
  /** Un humain a ouvert ce tour (jamais un réveil de tâche, une routine ni un sous-agent). */
  humanTurn?: boolean;
  wrapupSuffix?: string | null;
  startTime: number;
  modelHasVision: boolean;
  chatKeySuffix: string;
  runLogTok: string;
  toolsPayload: Dict[];
  toolCfgMap: ReadonlyMap<string, ConfigMcp>;
  builtinHandlers: ReadonlyMap<string, OutilIntegre["handler"]>;
  toolsPayloadChars: number;
  maxIter: number;
  effectiveIterBudget: number;
  hardIterCap: number;
}

/** Constantes d'un run, résolues par le prélude ; le slot du tour porte chaque appel au moteur. */
export class RunContext {
  readonly c: Readonly<ChampsRun>;

  constructor(c: ChampsRun) {
    this.c = Object.freeze({ ...c });
  }

  /** Annulation demandée par l'appelant (Stop, client parti). */
  cancelled(): boolean {
    return Boolean((this.c.isCancelled && this.c.isCancelled()) || this.c.signal?.aborted);
  }

  /** Un appel au moteur dans le slot du tour (créneau repris puis rendu en optimized). */
  appelLLM<T>(fn: () => Promise<T>): Promise<T> {
    return this.c.slot ? this.c.slot.appelLLM(fn) : fn();
  }
}

const SENTINELLE = pyJsonDumps(
  {
    error:
      "interrompu par l'utilisateur avant la fin — exécution NON confirmée (l'outil a pu agir en partie) : vérifier l'état avant de le relancer",
  },
  { ensureAscii: false },
);

/** Trace d'un run, complétée par chaque phase de la boucle. */
export class RunRecord {
  usageAcc: Dict | null = null;
  events: Dict[] = [];
  runToolHistory: Dict[] = [];
  allThinking: string[] = [];
  lastRaw: Dict = {};
  cumulIn = 0;
  cumulOut = 0;
  cumulCacheRead = 0;
  cumulCacheCreation = 0;
  cumulToolIn = 0;
  toolDefsTokens: number | null = null;
  cumulReasoning: number | null = null;
  batchPartial = new Map<number, string>();
  batchPrepared: Dict[] = [];
  deltaPendingIter: number | null = null;
  ctxSize = 0;
  gaugeCtxTotal = 0;
  toolsTokCounted: [number, boolean] | null = null;
  budgetDropFloor = 0;
  runPruneKeys = new Set<string>();
  pruneKeysNew: string[] = [];

  recordFileMutation(evt: Dict, resultStr: unknown): void {
    const path = evt["path"];
    if (!path) return;
    this.events.push({ type: "tool_result", name: evt["name"], path, ok: !resultIsToolFailure(resultStr) });
  }

  /** Part OUTILS de l'entrée d'un appel abouti, bornée par son entrée réelle ; best-effort. */
  noteToolInput(
    msgs: readonly unknown[],
    toolsPayload: readonly unknown[] | null,
    model: unknown,
    promptTokens: unknown,
  ): void {
    try {
      if (this.toolDefsTokens === null) {
        if (this.toolsTokCounted) this.toolDefsTokens = intPy(this.toolsTokCounted[0]);
        else if (toolsPayload && toolsPayload.length)
          this.toolDefsTokens = estTokensText(pyJsonDumps(toolsPayload, { ensureAscii: false }));
        else this.toolDefsTokens = 0;
      }
      const p = Math.max(0, intPy(promptTokens || 0));
      const n = toolPromptTokens(msgs, model ? strPy(model) : null, { defsTokens: this.toolDefsTokens });
      this.cumulToolIn += Math.min(n, p);
    } catch (e) {
      log.debug(`tool_input_tokens : ${String(e)}`);
    }
  }

  usageNote(o: { effectiveIter: number; model: unknown; recorded?: boolean }): void {
    if (this.usageAcc === null) return;
    Object.assign(this.usageAcc, {
      in: this.cumulIn,
      out: this.cumulOut,
      cache_read: this.cumulCacheRead,
      cache_creation: this.cumulCacheCreation,
      tool_in: this.cumulToolIn,
      iterations: o.effectiveIter,
      model: o.model,
      inflight_in: 0,
    });
    if (o.recorded) this.usageAcc["recorded"] = true;
  }

  /** Delta du run sans `assistant.tool_calls` terminal orphelin, borné. */
  deltaSnapshot(): Dict[] {
    const hist = [...this.runToolHistory];
    while (hist.length) {
      const d = hist[hist.length - 1]!;
      if (d["role"] !== "assistant" || !Array.isArray(d["tool_calls"]) || !d["tool_calls"].length) break;
      hist.pop();
    }
    return capRunToolHistory(hist);
  }

  /** Pose le lot EN COURS avant son exécution ; rend la table des résultats à remplir. */
  ouvrirLot(prepared: Dict[]): Map<number, string> {
    this.batchPartial = new Map();
    this.batchPrepared = prepared;
    return this.batchPartial;
  }

  /** Matérialise le round interrompu : vrai résultat ou sentinelle pour chaque appel (idempotente). */
  materializeInterruptedBatch(): void {
    if (!this.batchPrepared.length) return;
    const deja = new Map<unknown, Dict>();
    for (const m of this.runToolHistory) if (m["role"] === "tool") deja.set(m["tool_call_id"], m);
    let reels = 0;
    this.batchPrepared.forEach((p, i) => {
      const cid = p["call_id"];
      if (!cid) return;
      let res = this.batchPartial.get(i);
      const prev = deja.get(cid);
      if (prev !== undefined) {
        if (res !== undefined && prev["content"] === SENTINELLE) {
          prev["content"] = res;
          reels++;
        }
        return;
      }
      if (res === undefined) res = SENTINELLE;
      else reels++;
      this.runToolHistory.push({ role: "tool", tool_call_id: cid, content: res });
    });
    if (reels)
      log.warn(
        `[run_chat_multi_mcp] annulation en plein lot : ${reels} outil(s) déjà exécuté(s) matérialisé(s) dans la tool_history du partiel (sinon « Continuer » les rejouait).`,
      );
  }

  /** Instantané de la `tool_history` émis sur annulation en pleine boucle d'outils ; tout échec est tu. */
  async emitPartialSnapshot(onEvent: SurEvenement): Promise<void> {
    try {
      this.materializeInterruptedBatch();
      const ph = this.deltaSnapshot();
      if (ph.length && onEvent) await onEvent({ type: "tool_history_partial", tool_history: ph });
      if (this.pruneKeysNew.length && onEvent)
        await onEvent({ type: "prune_state", keys: [...this.pruneKeysNew] });
    } catch (e) {
      log.debug(`emit_partial_tool_history_snapshot : ${String(e)}`);
    }
  }

  /** Attente hors des blocs d'annulation : une annulation ici émet l'instantané avant de remonter. */
  async guardCancel<T>(onEvent: SurEvenement, p: Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await p;
    } catch (e) {
      if (estErreurAnnulation(e) || signal?.aborted) await this.emitPartialSnapshot(onEvent);
      throw e;
    }
  }

  /** Dernier texte assistant de CE run (jamais celui du tour précédent). */
  lastAssistantText(): string {
    for (let i = this.runToolHistory.length - 1; i >= 0; i--) {
      const m = this.runToolHistory[i];
      if (estDict(m) && m["role"] === "assistant") {
        const t = contentText(m["content"]);
        if (stripPy(t)) return t;
      }
    }
    return "";
  }
}
