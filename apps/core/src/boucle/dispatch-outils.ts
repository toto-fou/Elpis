// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/dispatch-outils.ts — appels d'outils de la boucle (canal natif et canal texte) : préparation, appel isolé, lot commun, post-traitement, anti-boucle. */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import { config } from "@elpis/config";
import {
  CancelledError,
  clesOrdonnees,
  decoderJsonPy,
  ErreurJsonPy,
  estDict,
  estErreurAnnulation,
  formatGabarit,
  intPy,
  jsonLoads,
  nomTypePy,
  normpathPy,
  poserCle,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  reprPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { ConfigMcp } from "@elpis/mcp";
import {
  REFUS_TACHE_SOUS_AGENT,
  refusPublicationSousAgent,
  refusSousAgent,
  sousAgentEnDict,
} from "@elpis/securite";
import type { SousAgent } from "@elpis/securite";

import { CTX } from "../contexte/config-contexte";
import { ephemeral, prepareToolResultForModel, pruneOldVisionFrames } from "../contexte/elagage";
import { measuredPromptTokens } from "../contexte/tokens";
import { LLAMA_TOOL_TIMEOUT_S, plafondParSlots } from "../llm/constantes";
import { currentEngine } from "../llm/moteurs";
import { reflexionDuTourRendue } from "../llm/parametres";
import { noterObservation } from "../llm/sonde-moteur";
import { journal } from "../journal";
import type { ContexteParent, OutilIntegre } from "../outils/catalogue";
import { categorize, isHidden, toolPolicy } from "../outils/categories";
import { err } from "../outils/erreur-outil";
import {
  executerOutilMcp,
  flattenExceptionMessage,
  TOOL_QUEUE_WAIT_S,
  toolTimeoutJson,
} from "../outils/mcp/clients";
import { reglagesAgents } from "../outils/integres/reglages-taches";
import type { Dict } from "../python";
import { fetchRelayedBytes } from "../relais/services";
import * as Analyse from "./analyse-appels";
import { looksLikePureToolCallText, stripToolCallMarkup, TOOL_MARKUP_TRACE_RE } from "./analyse-appels";
import type { AppelTexte } from "./analyse-appels";
import { resultIsToolFailure } from "./contrat-resultat";
import { emit } from "./evenements";
import { executeToolBatch } from "./execution-outils";
import type { RappelsOutil } from "./execution-outils";
import { executionEnCours, metriqueOutil, portJobsBoucle, portVisionBureau, tokenHex } from "./ports";
import type { LoopDeps, RunContext, RunRecord } from "./run";
import type { LiveText } from "./texte-direct";

const log = journal("boucle.dispatch-outils");

const DESKTOP_EVENT_KEYS = [
  "id",
  "label",
  "role",
  "auto_id",
  "box",
  "center",
  "depth",
  "unnamed",
  "source",
  "states",
  "patterns",
  "label_source",
];

function lireJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  return jsonLoads(raw);
}

/** `sig` et éléments allégés d'un `desktop_act`/`desktop_observe`, hors de la coupe à 2000 caractères de `result`. */
export function desktopEventExtra(toolName: string, raw: unknown, withElements = true): Dict | null {
  if (toolName !== "desktop_act" && toolName !== "desktop_observe") return null;
  let obj: unknown;
  try {
    obj = lireJson(raw);
  } catch {
    return null;
  }
  if (!estDict(obj)) return null;
  const out: Dict = {};
  if (obj["sig"]) out["sig"] = strPy(obj["sig"]);
  const els = withElements ? obj["elements"] : undefined;
  if (Array.isArray(els))
    out["elements"] = els
      .slice(0, 600)
      .filter(estDict)
      .map((e) =>
        Object.fromEntries(DESKTOP_EVENT_KEYS.filter((k) => Object.hasOwn(e, k)).map((k) => [k, e[k]])),
      );
  return Object.keys(out).length ? out : null;
}

/** Trame desktop d'un résultat : champs `screenshot_*` posés sur l'événement, propriétaire enregistré, événement `annotation_frame` rendu. */
async function populateDesktopFrame(
  evt: Dict,
  toolName: string,
  toolArgs: unknown,
  resultStr: string,
  username: string,
  modelHasVision: boolean,
  chatKey: string,
): Promise<Dict | null> {
  const port = portVisionBureau();
  if (port === null) return null;
  let df: Dict | null;
  try {
    df = port.extractDesktopFrame(toolName, toolArgs, resultStr);
  } catch {
    df = null;
  }
  if (!df) return null;
  evt["screenshot_url"] = df["url"];
  evt["screenshot_step"] = df["step"];
  evt["screenshot_session"] = df["session_id"];
  try {
    await port.registerDesktopFrameOwner(strPy(df["token"]), username);
  } catch (e) {
    log.debug(`populate_desktop_frame : ${String(e)}`);
  }
  const ret: Dict = {
    type: "annotation_frame",
    image_url: df["url"],
    img_w: df["img_w"],
    img_h: df["img_h"],
    boxes: df["boxes"],
    target: df["session_id"],
    sig: df["sig"] || "",
    ts: Date.now(),
  };
  if (modelHasVision) {
    try {
      const chemin = port.desktopFramePath(strPy(df["token"]));
      if (existsSync(chemin)) ret["_vision_track"] = [chatKey, chemin];
    } catch (e) {
      log.debug(`populate_desktop_frame.2 : ${String(e)}`);
    }
  }
  return ret;
}

function truthyArg(v: unknown): boolean {
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(stripPy(v).toLowerCase());
  return Boolean(v);
}

const SHA_RE = /^[0-9a-f]{64}$/u;

function sha(v: unknown): string | null {
  return typeof v === "string" && SHA_RE.test(v) ? v : null;
}

/** Fichiers modifiés décrits par un résultat (format compact du `tool_result`), au plus 50. */
export function changedFilesOf(res: unknown): Dict[] {
  if (!estDict(res) || res["ok"] === false || res["error"] || res["dry_run"]) return [];
  const un = (d: Dict, change: string | null = null): Dict | null => {
    const p = d["path"];
    if (typeof p !== "string" || !p) return null;
    const e: Dict = {
      path: prefixePy(p, 1024),
      change: prefixePy(strPy(change || d["change"] || "modified"), 16),
      before: sha(d["old_sha256"]),
      after: sha(d["new_sha256"]),
    };
    for (const [src, dst] of [
      ["lines_added", "added"],
      ["lines_removed", "removed"],
    ] as const)
      if (
        (typeof d[src] === "number" && Number.isInteger(d[src])) ||
        typeof d[src] === "boolean" ||
        typeof d[src] === "bigint"
      )
        e[dst] = d[src];
    if (typeof d["from"] === "string") e["from"] = prefixePy(d["from"], 1024);
    return e;
  };
  const fc = res["files_changed"];
  if (Array.isArray(fc)) {
    const sortie: Dict[] = [];
    for (const d of fc.slice(0, 50) as unknown[]) {
      const e = estDict(d) ? un(d) : null;
      if (e) sortie.push(e);
    }
    return sortie;
  }
  if (res["unchanged"] || res["action"] === "noop") return [];
  if (sha(res["new_sha256"]) && typeof res["path"] === "string") {
    const e = un(res, res["old_sha256"] === "" ? "created" : "modified");
    return e ? [e] : [];
  }
  return [];
}

/** Champs d'un `tool_result` pour l'éditeur : fichiers modifiés, chemin muté (`repo/path` pour `git_write`), essai à blanc, empreinte finale. */
export function writeEventExtra(toolName: string, finalArgs: unknown, resultStr: unknown): Dict {
  const out: Dict = {};
  let res: unknown;
  try {
    res = lireJson(resultStr);
  } catch {
    res = null;
  }
  try {
    const files = changedFilesOf(res);
    if (files.length) out["files"] = files;
  } catch {
    // enrichissement facultatif
  }
  try {
    if (!estDict(finalArgs)) return out;
    const tn = (toolName || "").toLowerCase();
    if (!(tn.includes("write") || tn.includes("edit") || tn.includes("save"))) return out;
    let wp = finalArgs["path"] || finalArgs["filename"];
    if (!wp || typeof wp !== "string") return out;
    if (tn.endsWith("git_write")) {
      let repo = stripPy(strPy(finalArgs["repo"] || "")).replaceAll("\\", "/");
      for (const pref of ["/work/", "work/"])
        if (repo.startsWith(pref)) {
          repo = repo.slice(pref.length);
          break;
        }
      if (repo === "/work" || repo === "work") repo = "";
      const rel = stripPy(wp).replaceAll("\\", "/").replace(/^\/+/u, "");
      const base = repo.replace(/^\/+|\/+$/gu, "");
      const joint = base ? normpathPy(`${base}/${rel}`) : normpathPy(rel);
      if (joint === "." || joint === "" || joint.startsWith("..")) return out;
      wp = joint;
    }
    out["path"] = wp;
    if (truthyArg(finalArgs["dry_run"])) {
      out["dry_run"] = true;
      return out;
    }
    if (estDict(res) && res["ok"] !== false && !res["error"]) {
      const s = res["next_expected_sha256"] || res["new_sha256"] || res["sha256"];
      if (typeof s === "string" && s.length === 64) out["sha256"] = s;
    }
  } catch {
    // enrichissement facultatif
  }
  return out;
}

/** Outil d'une catégorie cachée (aide côté modèle) : ses événements sont marqués `internal`. */
export function toolIsInternal(toolName: string): boolean {
  if (!toolName) return false;
  try {
    return isHidden(categorize(toolName));
  } catch {
    return false;
  }
}

/** Ligne `tool_call_metrics` best-effort (exécution courante, sinon la conversation). */
export function recordToolCallMetricSafe(
  username: string,
  chatId: string | null,
  toolName: string,
  status: string,
  durationMs: number,
  m: {
    errorShort?: string | null;
    callId?: unknown;
    startedAt?: number;
    exitCode?: number | null;
    argsBytes?: number;
    resultBytes?: number;
  } = {},
): void {
  const f = metriqueOutil();
  if (f === null) return;
  try {
    void Promise.resolve(
      f({
        username,
        run_id: executionEnCours()?.id ?? strPy(chatId || "chat"),
        tool_name: toolName,
        status,
        duration_ms: Math.trunc(durationMs),
        error_short: m.errorShort ?? null,
        category: categorize(toolName),
        call_id: m.callId,
        started_at: m.startedAt,
        exit_code: m.exitCode ?? null,
        args_bytes: m.argsBytes,
        result_bytes: m.resultBytes,
      }),
    ).catch(() => undefined);
  } catch (e) {
    log.debug(`[tool_call_metrics] enregistrement échoué : ${String(e)}`);
  }
}

// ── Anti-boucle desktop ──────────────────────────────────────────────────────

const CYCLE_ARG_KEYS = ["op", "id", "element_id", "query", "label", "text", "keys", "x", "y", "button"];
export const CYCLE_HARDSTOP_MAX = 2;
export const TRUNC_STREAK_MAX = 3;
const CTX_FULL_RATIO = 0.95;
const DESKTOP_OBSERVE_TOOLS = [
  "desktop_observe",
  "desktop_inspect",
  "desktop_read",
  "desktop_session",
  "desktop_screenshot",
];
const CYCLE_DECAY_ITERS = 15;

/** Signature d'une action desktop : outil | arguments stables | empreinte de l'écran résultant. */
export function actionCycleSignature(toolName: string, toolArgs: unknown, frameSig: string): string {
  const args = estDict(toolArgs) ? toolArgs : {};
  const parts = CYCLE_ARG_KEYS.filter(
    (k) => Object.hasOwn(args, k) && args[k] !== null && args[k] !== "",
  ).map((k) => `${k}=${strPy(args[k])}`);
  return `${toolName || ""}|${parts.join(",")}|${frameSig || ""}`;
}

/** Pousse la signature (fenêtre de 6) ; vrai si elle y paraît 3 fois (fenêtre vidée). */
export function detectActionCycle(buffer: string[], signature: string, threshold = 3, window = 6): boolean {
  buffer.push(signature);
  if (buffer.length > window) buffer.splice(0, buffer.length - window);
  if (signature && buffer.filter((s) => s === signature).length >= threshold) {
    buffer.length = 0;
    return true;
  }
  return false;
}

/** Fenêtre pleine (`true`), plafond de sortie (`false`) ou indécidable (`null`) pour une coupe `length`. */
export function lengthCutIsCtxFull(usage: unknown, ctxSize: number | null | undefined): boolean | null {
  let pt: number;
  let ct: number;
  let nCtx: number;
  try {
    const u = estDict(usage) ? usage : {};
    pt = intPy(u["prompt_tokens"] || 0);
    ct = intPy(u["completion_tokens"] || 0);
    nCtx = intPy(ctxSize || 0);
  } catch {
    return null;
  }
  if (nCtx <= 0 || pt <= 0) return null;
  return pt + ct >= Math.trunc(nCtx * CTX_FULL_RATIO);
}

export class CycleGuard {
  buffer: string[] = [];
  detections = 0;
  cleanStreak = 0;

  /** Action desktop exécutée : sa signature si elle confirme un cycle, `null` sinon (observations jamais comptées). */
  observe(toolName: string, finalArgs: unknown, frameSig: string): string | null {
    if (!(toolName || "").startsWith("desktop_") || DESKTOP_OBSERVE_TOOLS.includes(toolName)) return null;
    const sig = actionCycleSignature(toolName, finalArgs, frameSig);
    if (!detectActionCycle(this.buffer, sig)) return null;
    this.detections += 1;
    this.cleanStreak = 0;
    return sig;
  }

  get hardStopDue(): boolean {
    return this.detections >= CYCLE_HARDSTOP_MAX;
  }

  onProductive(): void {
    this.cleanStreak += 1;
    if (this.detections && this.cleanStreak >= CYCLE_DECAY_ITERS) {
      this.detections = 0;
      this.cleanStreak = 0;
    }
  }
}

// ── Appel isolé ──────────────────────────────────────────────────────────────

const TOOL_TIMEOUT_DEFAULTS: Readonly<Record<string, number>> = {
  execute_shell: 610.0,
  pw_wait: 330.0,
  desktop_shell: 610.0,
};

/** Borne d'un outil : surcharge à froid, `task` (délai du sous-agent + 60 s), image, politique déclarée, repli par nom, défaut global. */
export function toolTimeoutS(toolName: string): number {
  try {
    const v = CTX.toolTimeoutS(toolName);
    if (v > 0) return v;
  } catch (e) {
    log.debug(`tool_timeout_s : ${String(e)}`);
  }
  if (toolName === "task") return Number(config.TASK_CHILD_TIMEOUT_S ?? 1800) + 60.0;
  if (toolName === "generate_image") {
    const port = portVisionBureau();
    if (port !== null) return port.imageToolTimeoutS();
  }
  try {
    const pv = toolPolicy(toolName)["timeout_s"];
    if (pv && Number(pv) > 0) return Number(pv);
  } catch (e) {
    log.debug(`tool_timeout_policy : ${String(e)}`);
  }
  return TOOL_TIMEOUT_DEFAULTS[toolName] ?? LLAMA_TOOL_TIMEOUT_S;
}

/** Attente bornée et annulable ; `null` à l'échéance. */
async function borne<T>(p: Promise<T>, s: number, signal?: AbortSignal): Promise<{ v: T } | null> {
  let minuterie: NodeJS.Timeout | undefined;
  let surAbandon: (() => void) | undefined;
  try {
    return await Promise.race([
      p.then((v) => ({ v })),
      new Promise<null>((ok) => {
        minuterie = setTimeout(() => ok(null), Math.max(0, s * 1000));
      }),
      new Promise<never>((_ok, ko) => {
        if (!signal) return;
        surAbandon = () => ko(signal.reason ?? new CancelledError("User cancelled"));
        if (signal.aborted) surAbandon();
        else signal.addEventListener("abort", surAbandon, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(minuterie);
    if (surAbandon) signal?.removeEventListener("abort", surAbandon);
  }
}

/** Un appel d'outil : intégré (borne et annulation) ou serveur MCP ; toujours rendu en JSON, seule l'annulation remonte. */
export async function executeSingleToolCall(
  toolName: string,
  finalArgs: Dict,
  toolCfgMap: ReadonlyMap<string, ConfigMcp>,
  builtinHandlers: ReadonlyMap<string, OutilIntegre["handler"]>,
  o: RappelsOutil = {},
): Promise<unknown> {
  const handler = builtinHandlers.get(toolName);
  if (handler) {
    const bto = toolTimeoutS(toolName);
    try {
      o.signal?.throwIfAborted();
      const t0 = performance.now();
      const bh: unknown = handler(finalArgs, {
        callId: o.callId ?? null,
        ...(o.parent ? { parent: o.parent } : {}),
        ...(o.rendreSiAnnule ? { rendreSiAnnule: o.rendreSiAnnule } : {}),
      });
      if (bh instanceof Promise) {
        const reste = Math.max(0.5, bto - (performance.now() - t0) / 1000);
        const r = await borne(bh, reste, o.signal);
        return r === null ? toolTimeoutJson(toolName, bto) : r.v;
      }
      return bh;
    } catch (e) {
      if (estErreurAnnulation(e) || o.signal?.aborted) throw e;
      return pyJsonDumps({ error: flattenExceptionMessage(e) }, { ensureAscii: false });
    }
  }
  return executerOutilMcp(toolCfgMap, toolName, finalArgs, {
    meta: o.meta ?? null,
    onProgress: o.onProgress ?? null,
    onLog: o.onLog ?? null,
    timeoutS: toolTimeoutS(toolName),
    queueTimeoutS: TOOL_QUEUE_WAIT_S,
    signal: o.signal,
  });
}

/** Actif d'un hôte d'outils DISTANT rapatrié par le relais à `chemin` ; vrai s'il est présent. */
async function ensureLocalAsset(
  userId: number | null,
  chemin: string,
  cheminRelais: string,
): Promise<boolean> {
  if (chemin && existsSync(chemin)) return true;
  if (!userId || !cheminRelais) return false;
  let data: Buffer | null;
  try {
    data = await fetchRelayedBytes(Math.trunc(userId), cheminRelais);
  } catch {
    data = null;
  }
  if (!data || !data.length) return false;
  try {
    mkdirSync(path.dirname(chemin) || ".", { recursive: true });
    writeFileSync(chemin, data);
    return true;
  } catch {
    return false;
  }
}

async function prefetchDesktopFrame(
  userId: number | null,
  toolName: string,
  resultStr: unknown,
): Promise<void> {
  const port = portVisionBureau();
  if (port === null || !userId || !strPy(toolName || "").startsWith("desktop_")) return;
  let tok: unknown;
  try {
    tok = port.extractDesktopFrame(toolName, null, resultStr)?.["token"];
  } catch {
    tok = null;
  }
  if (!tok) return;
  await ensureLocalAsset(userId, port.desktopFramePath(strPy(tok)), `/api/desktop/frame/${strPy(tok)}`);
}

/** `_meta` d'un appel d'outil LOCAL (identité hors des arguments) ; `null` pour un serveur externe. */
export function buildCallMeta(o: {
  isLocal: boolean;
  username: string;
  chatId: unknown;
  liveShell: boolean;
  callId: unknown;
  runLogTok: string;
  userId?: number | null;
  subagent?: SousAgent | null;
}): Dict | null {
  if (!o.isLocal) return null;
  const meta: Dict = { username: o.username };
  if (o.userId) meta["user_id"] = strPy(Math.trunc(o.userId));
  if (o.chatId) meta["chat_id"] = strPy(o.chatId);
  if (o.liveShell) meta["live_shell"] = "1";
  meta["call_id"] = strPy(o.callId);
  meta["log_token"] = `${o.runLogTok}:${strPy(o.callId)}`;
  if (o.subagent) meta["subagent"] = sousAgentEnDict(o.subagent);
  return meta;
}

/** Résultat vu par un sous-agent : sans `disk_warning` (le parent le reçoit déjà). */
export function sansAlerteDisque(resultat: string): string {
  if (!resultat.includes('"disk_warning"')) return resultat;
  let d: unknown;
  try {
    d = jsonLoads(resultat);
  } catch {
    return resultat;
  }
  if (!estDict(d) || !Object.hasOwn(d, "disk_warning")) return resultat;
  delete d["disk_warning"];
  return pyJsonDumps(d, { ensureAscii: false });
}

/** Outil du serveur LOCAL, reconnu par sa configuration (jamais par son nom). */
export function isLocalTool(toolCfgMap: ReadonlyMap<string, ConfigMcp>, toolName: string): boolean {
  const c = toolCfgMap.get(toolName) ?? {};
  return c["command"] === "DEFAULT_LOCAL_PYTHON" || c["identity"] === "meta";
}

/** Appel coupé par `finish=length` : ni exécuté ni persisté ; le texte est gardé et une relance compacte demandée. */
async function handleTruncatedToolCall(
  ctx: RunContext,
  workingMessages: Dict[],
  iterClean: string,
  iteration: number,
  o: { channel: string; runHistory: Dict[] | null; ctxFull: boolean | null },
): Promise<void> {
  log.warn(
    `[run_chat_multi_mcp] tool_call ${o.channel} tronqué (finish=length, iter ${iteration}) — appel(s) NON exécuté(s), relance compacte demandée`,
  );
  const pourquoi =
    o.ctxFull === true
      ? "fenêtre de contexte pleine"
      : o.ctxFull === false
        ? "plafond de génération atteint"
        : "limite de longueur de génération";
  await emit(ctx.c.onEvent, {
    type: "info",
    text: `L'appel d'outil a été coupé (${pourquoi}) — nouvelle tentative avec un appel plus compact.`,
  });
  if (iterClean) {
    const garde = { role: "assistant", content: iterClean };
    workingMessages.push(garde);
    o.runHistory?.push(garde);
  }
  const defaut =
    "[SYSTEM] Your previous tool call was cut off mid-emission when the generation hit its length limit: it is " +
    "incomplete and was NOT executed. Re-issue it MUCH more compactly — for example, to write a large file, split " +
    "it into several smaller successive write_file calls (append mode) instead of one giant write.";
  let consigne: string;
  try {
    consigne = CTX.override("context.compact_retry", defaut);
  } catch {
    consigne = defaut;
  }
  workingMessages.push(ephemeral("user", consigne));
}

export class TruncationGuard {
  streak = 0;
  ctxFull = false;
  stop: "ctx_saturated" | "gen_cap" | null = null;

  reset(): void {
    this.streak = 0;
    this.ctxFull = false;
  }

  /** Appel coupé, traité sans exécution ; vrai à la troisième coupe d'affilée (cause dans `stop`). */
  async cut(
    channel: string,
    ctx: RunContext,
    rec: RunRecord,
    workingMessages: Dict[],
    o: { usage: Dict; iterClean: string; iteration: number },
  ): Promise<boolean> {
    const plein = lengthCutIsCtxFull(o.usage, rec.ctxSize);
    await handleTruncatedToolCall(ctx, workingMessages, o.iterClean, o.iteration, {
      channel,
      runHistory: rec.runToolHistory,
      ctxFull: plein,
    });
    this.streak += 1;
    if (plein === true) this.ctxFull = true;
    if (this.streak < TRUNC_STREAK_MAX) return false;
    if (this.ctxFull) {
      this.stop = "ctx_saturated";
      await emit(ctx.c.onEvent, {
        type: "notice",
        level: "warn",
        message: "contexte saturé — arrêt des appels d'outils",
      });
      log.warn(
        `[run_chat_multi_mcp] ${this.streak} tool calls coupés d'affilée (finish=length, ${channel}) → contexte saturé, sortie par le chemin tool-limit`,
      );
      return true;
    }
    this.stop = "gen_cap";
    await emit(ctx.c.onEvent, {
      type: "notice",
      level: "warn",
      message: "appels d'outils coupés par le plafond de génération — arrêt",
    });
    log.warn(
      `[run_chat_multi_mcp] ${this.streak} tool calls coupés d'affilée (finish=length, ${channel}) par le plafond de génération — fenêtre NON pleine, sortie par le chemin tool-limit`,
    );
    return true;
  }
}

// ── Canaux et préparation des lots ───────────────────────────────────────────

export interface ChannelSpec {
  name: string;
  vision: boolean;
  fallbackWrapper: boolean;
  cycleNudge: string;
}

export const NATIF: ChannelSpec = Object.freeze({
  name: "natif",
  vision: true,
  fallbackWrapper: false,
  cycleNudge:
    "WARNING: you just repeated the same action several times with no change on screen. Stop replaying it: call " +
    "desktop_observe to re-read the real state, check you are targeting the right element (id/auto_id/label), then " +
    "try a DIFFERENT approach (another target, a keyboard shortcut, or report the blocker).",
});

export const TEXTE: ChannelSpec = Object.freeze({
  name: "texte",
  vision: false,
  fallbackWrapper: true,
  cycleNudge:
    "WARNING: you just repeated the same action several times with no change on screen. Stop replaying it: call " +
    "desktop_observe to re-read the real state, check you are targeting the right element, then try a DIFFERENT " +
    "approach.",
});

/** Arguments sans `_username`/`_chat_id` (l'identité voyage dans le `_meta`), ordre des clés gardé. */
function sansIdentite(args: Dict): Dict {
  const sortie: Dict = {};
  for (const k of clesOrdonnees(args))
    if (k !== "_username" && k !== "_chat_id") poserCle(sortie, k, args[k]);
  return sortie;
}

/** `json.loads` des arguments natifs : valeurs exactes ; en échec, le message exact de Python (`JSONDecodeError` ou `TypeError`). */
function argumentsNatifs(brut: unknown): unknown {
  const texte = veritePy(brut) ? brut : "{}";
  if (typeof texte !== "string")
    throw new TypeError(`the JSON object must be str, bytes or bytearray, not ${nomTypePy(texte)}`);
  if (texte.startsWith("﻿"))
    throw new ErreurJsonPy("Unexpected UTF-8 BOM (decode using utf-8-sig)", texte, 0);
  try {
    return pyJsonLoads(texte);
  } catch {
    decoderJsonPy(texte);
    throw new ErreurJsonPy("Expecting value", texte, 0);
  }
}

/** Canal natif : message assistant du tour (reste du texte direct émis d'abord ; réflexion rendue au moteur si « Raisonnement conservé » est activé, jamais persistée) et lot préparé. */
export async function openNativeRound(
  ctx: RunContext,
  rec: RunRecord,
  workingMessages: Dict[],
  o: {
    live: LiveText;
    msg: Dict;
    toolCalls: unknown[];
    iterClean: string;
    iteration: number;
    iterThinking?: string;
  },
): Promise<Dict[]> {
  rec.deltaPendingIter = null;
  const avant = stripToolCallMarkup(o.live.parts.join(""));
  if (avant) await o.live.emitRest(avant, { replaceOnDivergence: false });
  const round: Dict = { role: "assistant", content: o.iterClean || null, tool_calls: o.toolCalls };
  if (o.msg["_anthropic_thinking"]) round["_anthropic_thinking"] = o.msg["_anthropic_thinking"];
  const pensee = stripPy(stripToolCallMarkup(o.iterThinking || ""));
  const rendue =
    pensee !== "" &&
    (ctx.c.reflexionRendue ?? reflexionDuTourRendue(currentEngine().profil, ctx.c.samplingOverride));
  workingMessages.push(rendue ? { ...round, reasoning_content: pensee } : round);
  rec.runToolHistory.push(round);
  const prepared: Dict[] = [];
  o.toolCalls.forEach((tc, idx) => {
    if (!estDict(tc)) {
      log.warn(
        `[run_chat_multi_mcp] tool_call non-dict ignoré (iter ${o.iteration}, idx ${idx}) : ${reprPy(tc)}`,
      );
      return;
    }
    const callId = tc["id"] || `call_${o.iteration}_${idx}`;
    let fn = tc["function"] || {};
    if (!estDict(fn)) fn = {};
    const toolName = strPy((fn as Dict)["name"] || "");
    let argsError: string | null = null;
    const brut = (fn as Dict)["arguments"];
    let args: unknown;
    try {
      args = estDict(brut) ? brut : argumentsNatifs(brut);
    } catch (e) {
      if (!(e instanceof ErreurJsonPy || e instanceof TypeError)) throw e;
      args = {};
      argsError =
        `arguments JSON invalides pour '${toolName}' (${e.message}) — outil NON exécuté ; renvoyer un objet JSON ` +
        "valide (guillemets doubles, pas de virgule finale)";
    }
    if (!estDict(args)) args = {};
    prepared.push({
      call_id: callId,
      tool_name: toolName,
      final_args: sansIdentite(args as Dict),
      meta: buildCallMeta({
        isLocal: isLocalTool(ctx.c.toolCfgMap, toolName),
        username: ctx.c.username,
        chatId: ctx.c.chatId,
        liveShell: ctx.c.liveShell,
        callId,
        runLogTok: ctx.c.runLogTok,
        userId: ctx.c.userId,
        subagent: ctx.c.subagent,
      }),
      args_error: argsError,
    });
  });
  return prepared;
}

/** Réponse sans `tool_calls` natifs lue comme du texte : prose (purgée si ce n'était qu'un appel inconnu) et appels vers des outils connus. */
export interface TextReply {
  rawText: string;
  iterClean: string;
  calls: AppelTexte[] | null;
  unknownText: string;
  unknownNames: string[];
}

export function classifyTextReply(
  ctx: RunContext,
  live: LiveText,
  iterClean: string,
  iteration: number,
): TextReply {
  let rawText = iterClean;
  let legacy = rawText ? Analyse.extractToolCalls(rawText) : null;
  let unknownText = "";
  let unknownNames: string[] = [];
  if (legacy) {
    const connus = new Set([...ctx.c.toolCfgMap.keys(), ...ctx.c.builtinHandlers.keys()]);
    const retenus = legacy.filter(([n]) => typeof n === "string" && connus.has(n));
    if (!retenus.length) {
      if (looksLikePureToolCallText(rawText)) {
        log.warn(
          `[run_chat_multi_mcp] Tool call avec nom(s) inconnu(s) ${reprPy(legacy.map(([n]) => n))} — JSON supprimé du flux final (itération ${iteration})`,
        );
        unknownText = rawText;
        unknownNames = [...new Set(legacy.map(([n]) => (typeof n === "string" ? n : reprPy(n))))];
        rawText = "";
        iterClean = "";
        live.purger();
      }
      legacy = null;
    } else legacy = retenus;
  }
  if (legacy) noterObservation(currentEngine(), "outils_en_texte");
  return { rawText, iterClean, calls: legacy, unknownText, unknownNames };
}

export const MALFORMED_RETRY_MAX = 2;
const LOST_TOOL_CALL_NUDGE =
  "[SYSTEM] Your last message contained tool-call markup but NO tool call reached the tool channel — nothing was " +
  "executed. Re-emit the call now using the NATIVE tool-call mechanism of this API (do NOT write XML tags like " +
  "<tool_call> or <function=...> in your text). If you did not intend to call a tool, simply give your final answer " +
  "as plain text.";
const UNKNOWN_TOOL_ATTEMPT_MAX = 500;

function nudgeOutilInconnu(noms: readonly string[], tentative: string): string {
  return (
    `[SYSTEM] Your last message only tried to call ${noms.map((n) => `\`${n}\``).join(", ")}, which is not an ` +
    `available tool — nothing was executed. Your message was:\n${prefixePy(tentative, UNKNOWN_TOOL_ATTEMPT_MAX)}\n` +
    "Call one of the tools you were given, or give your final answer as plain text."
  );
}

/** Relances bornées d'une tentative d'appel qui n'a rien exécuté (illisible, outil inconnu, perdue dans le raisonnement). */
export async function relaunchUnparsedCall(
  rec: RunRecord,
  workingMessages: Dict[],
  reply: TextReply,
  o: { live: LiveText; iterThinking: string; iteration: number; malformedRetry: number },
): Promise<[boolean, number]> {
  let essais = o.malformedRetry;
  if (!reply.calls && reply.rawText && Analyse.LAST_PARSE_DIAGNOSTIC) {
    if (essais < MALFORMED_RETRY_MAX) {
      essais += 1;
      log.warn(
        `[run_chat_multi_mcp] tool-call non parsable (iter ${o.iteration}) — feedback de correction au modèle (${essais}/${MALFORMED_RETRY_MAX})`,
      );
      await o.live.flush();
      if (reply.iterClean) {
        const garde = { role: "assistant", content: reply.iterClean };
        workingMessages.push(garde);
        rec.runToolHistory.push(garde);
      }
      workingMessages.push(ephemeral("user", Analyse.LAST_PARSE_DIAGNOSTIC));
      return [true, essais];
    }
    log.warn(
      `[run_chat_multi_mcp] tool-call non parsable (iter ${o.iteration}) — cap de relances atteint (${MALFORMED_RETRY_MAX}), on retombe sur la réponse finale`,
    );
  }
  if (!reply.calls && reply.unknownNames.length) {
    if (essais < MALFORMED_RETRY_MAX) {
      essais += 1;
      log.warn(
        `[run_chat_multi_mcp] appel vers un outil inconnu ${reprPy(reply.unknownNames)} (iter ${o.iteration}) — relance demandée au modèle (${essais}/${MALFORMED_RETRY_MAX})`,
      );
      workingMessages.push(ephemeral("user", nudgeOutilInconnu(reply.unknownNames, reply.unknownText)));
      return [true, essais];
    }
    log.warn(
      `[run_chat_multi_mcp] appel vers un outil inconnu (iter ${o.iteration}) — cap de relances atteint (${MALFORMED_RETRY_MAX}), réponse finale`,
    );
  }
  if (!reply.calls && !stripPy(reply.rawText || "") && TOOL_MARKUP_TRACE_RE.test(o.iterThinking || "")) {
    if (essais < MALFORMED_RETRY_MAX) {
      essais += 1;
      log.warn(
        `[run_chat_multi_mcp] tentative d'appel perdue dans le reasoning (iter ${o.iteration}, aucun tool call reçu) — relance native demandée au modèle (${essais}/${MALFORMED_RETRY_MAX})`,
      );
      workingMessages.push(ephemeral("user", LOST_TOOL_CALL_NUDGE));
      return [true, essais];
    }
    log.warn(
      `[run_chat_multi_mcp] tentative d'appel perdue dans le reasoning (iter ${o.iteration}) — cap de relances atteint (${MALFORMED_RETRY_MAX}), réponse finale`,
    );
  }
  return [false, essais];
}

/** Canal texte : lot préparé et message assistant porteur de `tool_calls` SYNTHÉTIQUES (ids `legacy_*` uniques). */
export function openTextRound(
  ctx: RunContext,
  rec: RunRecord,
  workingMessages: Dict[],
  o: { rawText: string; calls: AppelTexte[]; finish: unknown; iteration: number },
): Dict[] {
  log.warn(
    `[run_chat_multi_mcp] Fallback legacy tool-call sur itération ${o.iteration} (finish_reason='${strPy(o.finish)}')`,
  );
  const prepared: Dict[] = [];
  const vus = new Set<unknown>();
  for (const m of workingMessages)
    if (estDict(m) && m["role"] === "assistant" && Array.isArray(m["tool_calls"]))
      for (const tc of m["tool_calls"]) if (estDict(tc)) vus.add(tc["id"] ?? null);
  o.calls.forEach(([nom, brut], idx) => {
    const toolName = strPy(nom);
    let callId = `legacy_${o.iteration}_${idx}`;
    if (vus.has(callId)) callId = `${callId}_${tokenHex(3)}`;
    vus.add(callId);
    let args: unknown = brut;
    if (typeof args === "string") {
      try {
        args = jsonLoads(args);
      } catch {
        args = { value: brut };
      }
    }
    if (!estDict(args)) args = {};
    prepared.push({
      call_id: callId,
      tool_name: toolName,
      final_args: sansIdentite(args as Dict),
      meta: buildCallMeta({
        isLocal: isLocalTool(ctx.c.toolCfgMap, toolName),
        username: ctx.c.username,
        chatId: ctx.c.chatId,
        liveShell: ctx.c.liveShell,
        callId,
        runLogTok: ctx.c.runLogTok,
        userId: ctx.c.userId,
        subagent: ctx.c.subagent,
      }),
    });
  });
  const round: Dict = {
    role: "assistant",
    content: stripToolCallMarkup(o.rawText) || null,
    tool_calls: prepared.map((p) => ({
      id: p["call_id"],
      type: "function",
      function: { name: p["tool_name"], arguments: pyJsonDumps(p["final_args"], { ensureAscii: false }) },
    })),
  };
  workingMessages.push(round);
  rec.runToolHistory.push(round);
  return prepared;
}

/** Événements de jobs non livrés suffixés au résultat vu par le modèle, persisté tel quel (JB-07) ; drapeau mémoire d'abord, aucune requête sinon. */
async function avecEvenementsJobs(
  uid: number | null,
  chatId: string | null,
  contenu: unknown,
): Promise<unknown> {
  const port = portJobsBoucle();
  if (port === null || !uid || !chatId || typeof contenu !== "string" || !port.enAttente(uid, chatId))
    return contenu;
  try {
    const texte = await port.prendrePourResultat(uid, chatId);
    return texte ? `${contenu}\n\n${texte}` : contenu;
  } catch (e) {
    log.warn(`[jobs] événements non joints au résultat d'outil : ${String(e)}`);
    return contenu;
  }
}

/** Ajoute `ligne` (après une ligne vide) au contenu texte du dernier résultat d'outil du lot en queue de `messages` ; faux, rien n'est changé, sans tel résultat ou si son contenu n'est pas du texte. */
export function jalonDansDernierResultat(messages: Dict[], ligne: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m["role"] === "assistant") return false;
    if (m["role"] !== "tool") continue;
    const contenu = m["content"];
    if (typeof contenu !== "string") return false;
    messages[i] = { ...m, content: stripPy(contenu) ? `${contenu}\n\n${ligne}` : ligne };
    return true;
  }
  return false;
}

export interface BatchOutcome {
  hadSuccess: boolean;
  cycleHardStopped: boolean;
}

/** Sous-agents lancés ensemble par le lot : `agents.max_parallel`, plafonné par les slots du moteur quand le lot en lance plusieurs. */
async function tachesSimultanees(prepared: readonly Dict[]): Promise<number> {
  const voulu = reglagesAgents().max_parallel;
  if (voulu <= 1 || prepared.filter((p) => strPy(p["tool_name"]) === "task").length < 2) return voulu;
  const effectif = await plafondParSlots(voulu);
  if (effectif < voulu)
    log.info(
      `[execute_tool_batch] sous-agents simultanés plafonnés à ${effectif} par les slots du moteur (max_parallel=${voulu})`,
    );
  return effectif;
}

/** Liste des outils permis rendue au modèle dans le `fix` d'un refus (bornée). */
function listeOutils(permis: ReadonlySet<string>): string {
  const noms = [...permis].sort();
  return noms.length > 80 ? `${noms.slice(0, 80).join(", ")}, …` : noms.join(", ");
}

/** Appel hors du périmètre d'un run au catalogue figé (enfant `fork`) : erreur JSON sans exécution, la liste des outils permis dans `fix` ; `null` si l'outil est permis. */
function refusHorsPerimetre(ctx: RunContext, nom: string): string | null {
  const permis = ctx.c.outilsPermis;
  if (!permis || permis.has(nom)) return null;
  const sa = ctx.c.subagent ?? null;
  const base = refusSousAgent(
    sa && { ...sa, writable_paths: null },
    nom,
    {},
    ctx.c.lectureSeule?.get(nom) ?? false,
    isLocalTool(ctx.c.toolCfgMap, nom),
  );
  const message = base?.message ?? `${nom} is not part of the '${sa?.type ?? "sub-agent"}' sub-agent profile`;
  const suite = base?.fix ?? "Leave this step to the parent: list it under 'Left open' in your report.";
  return pyJsonDumps(
    err(base?.code ?? "not_available_for_subagent", message, {
      fix: `Only these tools work in this run: ${listeOutils(permis)}. ${suite}`,
    }),
  );
}

/** Instantané du run pour un outil intégré qui lance un enfant `fork` (cf. `ContexteParent`). */
function contexteParent(
  channel: ChannelSpec,
  ctx: RunContext,
  rec: RunRecord,
  assistant: Dict | null,
): ContexteParent {
  const usage = (rec.lastRaw["usage"] ?? {}) as Dict;
  const modele = ctx.c.model || config.LLAMA_MODEL || null;
  const entree =
    intPy(usage["prompt_tokens"] || 0) ||
    measuredPromptTokens(rec.envoye, { modelId: modele, extraFixed: rec.toolsTokCounted?.[0] ?? 0 });
  return {
    natif: channel === NATIF,
    sousAgent: Boolean(ctx.c.subagent),
    envoye: structuredClone(rec.envoye),
    assistant: assistant === null ? null : structuredClone(assistant),
    toolsPayload: ctx.c.toolsPayload,
    toolCfgMap: ctx.c.toolCfgMap,
    builtinHandlers: ctx.c.builtinHandlers,
    lectureSeule: ctx.c.lectureSeule ?? new Map<string, boolean>(),
    thinkingMode: ctx.c.thinkingMode,
    samplingOverride: ctx.c.samplingOverride,
    jetons: entree + intPy(usage["completion_tokens"] || 0),
    fenetre: rec.ctxSize,
    seuilCompaction: ctx.c.compactionThreshold ?? null,
    slotKey: ctx.c.slotKey || ctx.c.chatId || null,
  };
}

/** Noyau commun aux deux canaux : annulation, `tool_call`, exécution (série ou parallèle), post-traitement dans l'ordre du modèle, anti-boucle. */
export async function runToolBatch(
  channel: ChannelSpec,
  ctx: RunContext,
  rec: RunRecord,
  deps: LoopDeps,
  workingMessages: Dict[],
  prepared: Dict[],
  o: { iteration: number; cycle: CycleGuard },
): Promise<BatchOutcome> {
  const { onEvent, username, signal } = ctx.c;
  const instantane = (): Promise<void> => rec.emitPartialSnapshot(onEvent);
  const garde = <T>(p: Promise<T>): Promise<T> => rec.guardCancel(onEvent, p, signal);
  await Promise.resolve();
  if (ctx.cancelled()) {
    log.info("[run_chat_multi_mcp] Cancellation avant tool_call");
    await instantane();
    throw new CancelledError("User cancelled");
  }
  for (const p of prepared) {
    const evt: Dict = {
      type: "tool_call",
      name: p["tool_name"],
      args: p["final_args"],
      call_id: p["call_id"] ?? null,
    };
    if (toolIsInternal(strPy(p["tool_name"]))) evt["internal"] = true;
    await emit(onEvent, evt);
  }
  const resultsOut = rec.ouvrirLot(prepared);
  const simultanees = await tachesSimultanees(prepared);
  const dernier = workingMessages[workingMessages.length - 1];
  const assistantDuLot =
    dernier?.["role"] === "assistant" && Array.isArray(dernier["tool_calls"]) ? dernier : null;
  const lecteurParent = (): ContexteParent => contexteParent(channel, ctx, rec, assistantDuLot);
  const resultats = await executeToolBatch(prepared, {
    resultsOut,
    executeSingle: (nom, args, r) => {
      if (ctx.c.subagent && nom === "task")
        return Promise.resolve(
          pyJsonDumps(
            err(REFUS_TACHE_SOUS_AGENT.code, REFUS_TACHE_SOUS_AGENT.message, {
              fix: REFUS_TACHE_SOUS_AGENT.fix,
            }),
          ),
        );
      const hors = refusHorsPerimetre(ctx, nom);
      if (hors !== null) return Promise.resolve(hors);
      const publication = isLocalTool(ctx.c.toolCfgMap, nom)
        ? refusPublicationSousAgent(ctx.c.subagent, nom)
        : null;
      if (publication !== null)
        return Promise.resolve(
          pyJsonDumps(err(publication.code, publication.message, { fix: publication.fix })),
        );
      return executeSingleToolCall(nom, args, ctx.c.toolCfgMap, ctx.c.builtinHandlers, {
        ...r,
        ...(nom === "task" ? { parent: lecteurParent } : {}),
      });
    },
    recordMetric: deps.recordMetric,
    isToolFailure: resultIsToolFailure,
    onEvent,
    username,
    chatId: ctx.c.chatId,
    onCancelSnapshot: instantane,
    iteration: o.iteration,
    emitProgressLog: true,
    isCancelled: ctx.c.isCancelled,
    signal,
    tachesSimultanees: simultanees,
    classer: (nom, args) => ctx.c.classeurs.get(nom)?.(args) ?? null,
  });

  const port = portVisionBureau();
  let hadSuccess = false;
  let nudgeCycle = false;
  const visionsDifferees: Dict[] = [];
  const chatKey = `${username}:${ctx.c.chatKeySuffix}`;
  for (const [idx, p] of prepared.entries()) {
    const toolName = strPy(p["tool_name"]);
    const finalArgs = p["final_args"];
    const callId = p["call_id"];
    const brut = resultats.get(idx) ?? pyJsonDumps({ error: "no_result" });
    const resultat = ctx.c.subagent ? sansAlerteDisque(brut) : brut;
    if (!resultIsToolFailure(resultat)) hadSuccess = true;
    const evt: Dict = {
      type: "tool_result",
      name: toolName,
      call_id: callId,
      result: prefixePy(resultat, 2000),
      duration_ms: p["duration_ms"] ?? null,
    };
    const dk = desktopEventExtra(toolName, resultat, strPy(ctx.c.chatKeySuffix).startsWith("studio_"));
    if (dk) evt["desktop"] = dk;
    Object.assign(evt, writeEventExtra(toolName, finalArgs, resultat));
    const fichiers = evt["files"];
    if (Array.isArray(fichiers) && fichiers.length)
      try {
        executionEnCours()?.ajouterFichiers(fichiers);
      } catch (e) {
        log.debug(`[runs] fichiers modifiés non comptés : ${String(e)}`);
      }
    if (toolIsInternal(toolName)) evt["internal"] = true;
    const ss = port?.extractPwScreenshotUrl(toolName, finalArgs, resultat) ?? null;
    if (ss) {
      evt["screenshot_url"] = ss.url;
      evt["screenshot_step"] = ss.step;
      evt["screenshot_session"] = ss.session_id;
      if (channel.vision && ctx.c.modelHasVision && port) {
        const dossier = process.env["PW_SCREENS_DIR"] || "/tmp/pw_screens";
        const png = path.join(dossier, `step_${strPy(ss.session_id)}_${strPy(ss.step)}.png`);
        const relais = `/api/playwright/screenshot/step_${strPy(ss.session_id)}_${strPy(ss.step)}.png`;
        if (await garde(ensureLocalAsset(ctx.c.userId, png, relais)))
          await garde(port.trackLastScreenshotForVision(chatKey, png));
      }
    }
    await garde(prefetchDesktopFrame(ctx.c.userId, toolName, resultat));
    const af = await populateDesktopFrame(
      evt,
      toolName,
      finalArgs,
      resultat,
      username,
      ctx.c.modelHasVision,
      chatKey,
    );
    if (af) {
      const suivi = af["_vision_track"] as [string, string] | undefined;
      delete af["_vision_track"];
      if (suivi && port) await garde(port.trackLastScreenshotForVision(suivi[0], suivi[1]));
      await garde(emit(onEvent, af));
      const sig = o.cycle.observe(toolName, finalArgs, strPy(af["sig"] || ""));
      if (sig !== null) {
        nudgeCycle = true;
        await garde(
          emit(onEvent, {
            type: "notice",
            level: "warn",
            message: "boucle d'action détectée — relance d'observation suggérée",
          }),
        );
        log.warn(`[run_chat_multi_mcp] cycle d'action desktop détecté (${sig}) — canal ${channel.name}`);
      }
    }
    if (port) await garde(port.trackPwSessionOwnership(toolName, finalArgs, resultat, username));
    await garde(emit(onEvent, evt));
    rec.recordFileMutation(evt, resultat);

    let contenu = prepareToolResultForModel(
      toolName,
      resultat,
      rec.ctxSize,
      ctx.c.model || config.LLAMA_MODEL || null,
    );
    if (channel.fallbackWrapper) {
      try {
        const gabarit = CTX.override("result_formatting.fallback_wrapper", "");
        if (gabarit) contenu = formatGabarit(gabarit, { tool: toolName, result: strPy(contenu) });
      } catch (e) {
        log.debug(`fallback_wrapper : ${String(e)}`);
      }
    }
    contenu = await avecEvenementsJobs(ctx.c.userId, ctx.c.chatId, contenu);
    const toolMsg: Dict = { role: "tool", tool_call_id: callId, content: contenu };
    workingMessages.push(toolMsg);
    rec.runToolHistory.push(toolMsg);

    if (!channel.vision) continue;
    const inspect =
      (toolName === "pw_page" && estDict(finalArgs) && port?.pwVerbOf("pw_page", finalArgs) === "inspect") ||
      toolName === "desktop_observe";
    if (ctx.c.modelHasVision && inspect && port) {
      const img = port.getLastScreenshotB64(chatKey);
      if (img) {
        const defaut =
          "Here is the current screenshot of the page (compressed to 1024px wide). Use it alongside the 'inspect' " +
          "text to precisely locate visual elements.";
        let legende: string;
        try {
          legende = CTX.override("vision.image_caption", defaut);
        } catch {
          legende = defaut;
        }
        visionsDifferees.push({
          role: "user",
          content: [
            { type: "text", text: legende },
            { type: "image_url", image_url: { url: img } },
          ],
          _ephemeral: true,
        });
        log.info(
          `[vision] Screenshot injectée après pw_page('inspect') (~${Math.floor(img.length / 1024)} KB)`,
        );
      }
    }
  }
  if (visionsDifferees.length) {
    workingMessages.push(...visionsDifferees);
    const elague = pruneOldVisionFrames(workingMessages, 2) as Dict[];
    workingMessages.splice(0, workingMessages.length, ...elague);
  }
  let cycleHardStopped = false;
  if (nudgeCycle) {
    if (o.cycle.hardStopDue) {
      cycleHardStopped = true;
      await emit(onEvent, {
        type: "notice",
        level: "warn",
        message: "boucle d'action persistante — arrêt automatique des actions",
      });
      log.warn(
        `[run_chat_multi_mcp] hard-stop anti-boucle desktop (${channel.name}) après ${o.cycle.detections} cycles`,
      );
    } else workingMessages.push(ephemeral("user", channel.cycleNudge));
  }
  return { hadSuccess, cycleHardStopped };
}
