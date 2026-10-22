// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/compresseur.ts — compaction de conversation : résumé ancré par LLM, compaction partielle, gardes, événements et état. */
import {
  arrondiPy,
  ErreurPython,
  estDict,
  exigerDict,
  floatPy,
  intPy,
  maxPy,
  minPy,
  nomTypePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import { config, reloadCompressionConfigFromDisk } from "@elpis/config";

import { journal } from "../journal";
import { currentTarget } from "../llm/cible";
import { ClientHttp, estAnnulation } from "../llm/client-http";
import { getModelContextSize } from "../llm/modeles";
import { lire } from "../python";
import type { Dict } from "../python";
import {
  computeSerializerBudget,
  computeSerializerBudgetTokens,
  computeSerializerTotalBudgetTokens,
  extractArtifactLedger,
  mergeLedgerLines,
  parseLedgerLines,
  renderArtifactLedger,
  renderEntry,
  serializeForCompression,
} from "./compression/serialiseur";
import {
  estMarqueurElague,
  isEphemeral,
  LEADING_ANCHOR_TEXT,
  mergeUserSuffix,
  pruneKey,
  truncateHeadTail,
} from "./elagage";
import {
  countTurns,
  extractPreviousSummary,
  formatSummaryAsSystemMessage,
  isSummaryCarrier,
  leadingTurnGroups,
  SUMMARY_MARKER_START,
  stripSummarySpan,
} from "./etat-compression";
import { usableWindow } from "./porte-compaction";
import { ligneJobsActifs, portCompresseur } from "./ports";
import type { LigneIndexSession } from "./ports";
import {
  countMessagesTokensPerMsg,
  countTokensForMessages,
  imageForfaitTokens,
  measuredPromptTokens,
  tokensToChars,
} from "./tokens";

const log = journal("elpis.compressor");

/** `llama_chat` injecté par l'appelant (slot du tour ou `withLLM`) : `[texte, méta]`. */
export type LlamaChatFn = (
  messages: Dict[],
  options: {
    userId: string;
    modelOverride: string | null;
    samplingOverride: Dict;
    usageScope: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<[string, Dict | null]>;

export type SurEvenement = (evenement: Dict) => Promise<void> | void;

let endpointClient: ClientHttp | null = null;

/** Client paresseux de l'endpoint dédié : pool propre, aucun délai global (délai par requête). */
function clientEndpoint(): ClientHttp {
  if (endpointClient === null || endpointClient.isClosed) {
    endpointClient = new ClientHttp({
      delais: null,
      limites: { maxKeepaliveConnections: 2, maxConnections: 4, keepaliveExpiry: 120 },
    });
  }
  return endpointClient;
}

export async function closeEndpointClient(): Promise<void> {
  const c = endpointClient;
  endpointClient = null;
  if (c && !c.isClosed) {
    try {
      await c.aclose();
    } catch {
      return;
    }
  }
}

/** Résumé par un endpoint OpenAI-compatible dédié (non streamé, échantillonnage conservateur). */
/** `v[0]` de Python pour une liste ou un texte ; un dict lève KeyError, un nombre n'est pas indexable. */
function premierElement(v: unknown): unknown {
  if (Array.isArray(v)) return v[0];
  if (typeof v === "string") return Array.from(v)[0];
  if (estDict(v)) throw new Error("0");
  throw new ErreurPython("TypeError", `'${nomTypePy(v)}' object is not subscriptable`);
}

async function callExternalEndpoint(
  messages: Dict[],
  options: { url: string; model: string; timeoutSec: number; signal?: AbortSignal | undefined },
): Promise<[string, Dict]> {
  const payload = {
    model: options.model,
    messages,
    stream: false,
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 4096,
  };
  const resp = await clientEndpoint().request("POST", options.url, {
    json: payload,
    timeout: options.timeoutSec,
    signal: options.signal,
  });
  resp.raiseForStatus();
  const data = exigerDict(resp.json());
  const choices = lire(data, "choices");
  if (!veritePy(choices)) return ["", { model: options.model, error: "no_choices", external_endpoint: true }];
  const message = lire(exigerDict(premierElement(choices)), "message");
  const brut = lire(exigerDict(veritePy(message) ? message : {}), "content");
  const content = veritePy(brut) ? brut : "";
  if (typeof content !== "string") {
    throw new ErreurPython("AttributeError", `'${nomTypePy(content)}' object has no attribute 'strip'`);
  }
  const usage = lire(data, "usage");
  return [
    stripPy(content),
    {
      model: options.model,
      usage: veritePy(usage) ? usage : {},
      external_endpoint: true,
      endpoint_url: options.url,
    },
  ];
}

/** Tokens exacts (`/tokenize`, + forfait image) ou estimation mesurée : `[tokens, estimé]`. */
async function countTokensAsyncEx(
  messages: readonly unknown[],
  modelId: string | null,
  signal?: AbortSignal,
): Promise<[number, boolean]> {
  const n = await countTokensForMessages(messages, modelId, { timeout: 5.0, signal });
  if (n !== null) return [n + imageForfaitTokens(messages), false];
  return [measuredPromptTokens(messages, { modelId }), true];
}

const FALLBACK_COMPRESSOR_PROMPT =
  "You compress conversations. Produce a concise, factual, telegraphic summary of what was done, the current " +
  "state, and the important technical facts (names, IDs, values). Write it in the conversation's language. Start " +
  "directly with the summary, no introduction.";

function chargerPromptCompresseur(): string {
  const p = stripPy(config.SYSTEM_PROMPT_COMPRESSOR || "");
  if (p) return p;
  log.warn(
    "[compressor] system_prompts/COMPRESSOR_SYSTEM.md absent/vide → fallback inline minimal actif. " +
      "Résumés moins structurés.",
  );
  return FALLBACK_COMPRESSOR_PROMPT;
}

const COMPRESSOR_SYSTEM_PROMPT = chargerPromptCompresseur();
const THINK = "[tT][hH][iI\\u0130\\u0131][nN][kK\\u212A](?:[iI\\u0130\\u0131][nN][gG])?";
const RE_THINK_BLOCK = new RegExp(`<${THINK}>[\\s\\S]*?</${THINK}>`, "gu");
const RE_THINK_OPEN = new RegExp(`<${THINK}>`, "u");
/** Raisonnement sans balise ouvrante (gabarit qui l'ouvre, serveur sans parseur) : tout jusqu'à la dernière fermante. */
const RE_THINK_ORPHELIN = new RegExp(`^[\\s\\S]*</${THINK}>`, "u");
const PARTIAL_TARGET_RATIO = 0.6;
const EXPECTED_SUMMARY_TOKENS = 600;
const ANCHOR_PIN_MAX_CHARS = 6000;
const ANCHOR_FALLBACK_TEXT =
  "[SYSTEM] Mission in progress — the original request is summarized above. Continue from there.";

/** Zones (system, à résumer, transition, récents) découpées par tours. */
export function splitByTurnIndex(
  messages: readonly Dict[],
  keepRecentTurns: number,
  keepBridgeTurns: number,
): [Dict[], Dict[], Dict[], Dict[]] {
  const systemMsgs = messages.filter((m) => m["role"] === "system");
  const nonSystem = messages.filter((m) => m["role"] !== "system");
  const starts: number[] = [];
  let prevWasTool = false;
  nonSystem.forEach((m, i) => {
    const role = m["role"];
    if (role === "user") {
      if (!isEphemeral(m)) starts.push(i);
      prevWasTool = false;
    } else if (role === "assistant") {
      if (veritePy(lire(m, "tool_calls")) || !prevWasTool) starts.push(i);
      prevWasTool = false;
    } else if (role === "tool") prevWasTool = true;
  });
  const total = starts.length;
  if (total <= keepRecentTurns + keepBridgeTurns) return [systemMsgs, [], [], nonSystem];
  const recentIdx = total - keepRecentTurns;
  const bridgeIdx = maxPy(0, recentIdx - keepBridgeTurns);
  const recentStart = recentIdx < total ? starts[recentIdx]! : nonSystem.length;
  const bridgeStart = keepBridgeTurns > 0 && bridgeIdx < recentIdx ? starts[bridgeIdx]! : recentStart;
  return [
    systemMsgs,
    nonSystem.slice(0, bridgeStart),
    keepBridgeTurns > 0 ? nonSystem.slice(bridgeStart, recentStart) : [],
    nonSystem.slice(recentStart),
  ];
}

/** Dernier `user` porteur de la demande (ou ancre ré-épinglée). */
function anchorMessage(messages: readonly unknown[]): Dict | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!estDict(m) || m["role"] !== "user") continue;
    if (veritePy(lire(m, "_task_anchor")) || !isEphemeral(m)) return m;
  }
  return null;
}

function anchorPin(content: string): Dict {
  return { role: "user", content, _ephemeral: true, _task_anchor: true };
}

/** Messages à ré-insérer en tête de la fenêtre conservée pour qu'elle s'ouvre sur l'énoncé de la tâche ; `jobs` : ligne des tâches de fond actives ajoutée à l'ancre épinglée. */
export function pinTaskAnchor(kept: readonly unknown[], dropped: readonly unknown[], jobs = ""): Dict[] {
  const avecJobs = (t: string): string => (jobs ? `${t}\n\n${jobs}` : t);
  if (anchorMessage(kept) !== null) {
    const first = kept.find(estDict);
    if (first !== undefined && (first["role"] === "assistant" || first["role"] === "tool")) {
      return [{ role: "user", content: avecJobs(LEADING_ANCHOR_TEXT), _ephemeral: true }];
    }
    return [];
  }
  const src = anchorMessage(dropped);
  if (src === null) return [anchorPin(avecJobs(ANCHOR_FALLBACK_TEXT))];
  let content: unknown = src["content"];
  if (Array.isArray(content)) {
    content = content
      .filter((b) => estDict(b) && typeof b["text"] === "string")
      .map((b) => (b as Dict)["text"] as string)
      .join(" ");
  }
  let texte = stripPy(strPy(veritePy(content) ? content : "")) || ANCHOR_FALLBACK_TEXT;
  if (Array.from(texte).length > ANCHOR_PIN_MAX_CHARS) {
    texte = truncateHeadTail(texte, ANCHOR_PIN_MAX_CHARS, "mission épinglée");
  }
  return [anchorPin(avecJobs(texte))];
}

/** JB-16 : sans ancre épinglée, la fenêtre gardée qui s'ouvre sur une question porte la ligne des jobs (copie, jamais deux `user` d'affilée). */
export function jobsSurLaQuestion(kept: readonly Dict[], pins: readonly Dict[], jobs: string): Dict[] {
  const tete = kept[0];
  if (!jobs || pins.length || tete === undefined || tete["role"] !== "user") return [...kept];
  return [{ ...tete, content: mergeUserSuffix(tete["content"], jobs) }, ...kept.slice(1)];
}

/** Ligne des jobs actifs de la conversation pour l'ancre (JB-16) ; best-effort, `""` sans port ni job. */
async function jobsDeLAncre(o: OptionsCompress): Promise<string> {
  const f = ligneJobsActifs();
  if (f === null || !o.userId || !o.ftsSessionId) return "";
  try {
    return await f(o.userId, o.ftsSessionId);
  } catch (e) {
    log.debug(`[compressor] jobs actifs non lus pour l'ancre : ${String(e)}`);
    return "";
  }
}

function messageErreur(e: unknown): string {
  return Array.from(e instanceof Error ? e.message : strPy(e))
    .slice(0, 200)
    .join("");
}

/** Ligne d'index d'une sortie d'outil (format commun à la compression et à l'élagage) : 4 000 premiers caractères. */
function ligneSortie(uid: number, app: string, sid: string, ts: number, c: string): LigneIndexSession {
  return {
    user_id: uid,
    app,
    session_id: sid,
    scope_key: "",
    role: "tool",
    content: Array.from(c).slice(0, 4000).join(""),
    ts,
  };
}

/** Indexe (recherche d'historique) les sorties et appels d'outils des tours sur le point d'être résumés, sauf marqueurs et sorties déjà indexées à l'élagage ; best-effort. */
async function indexCoveredTurnsFts(
  toCompress: readonly unknown[],
  username: string,
  sessionId: string | null,
  dejaIndexees: ReadonlySet<string> | null,
  app = "chat",
): Promise<void> {
  try {
    const port = portCompresseur();
    const uid = username ? await port.userIdParNom(username) : null;
    if (uid === null) return;
    const sid = sessionId || "compressed";
    const now = Date.now() / 1000;
    const rows: LigneIndexSession[] = [];
    for (const m of toCompress) {
      if (!estDict(m)) continue;
      if (m["role"] === "tool") {
        const c = m["content"];
        if (typeof c !== "string" || !stripPy(c) || estMarqueurElague(c)) continue;
        if (dejaIndexees?.size && dejaIndexees.has(pruneKey(m) ?? "\0")) continue;
        rows.push(ligneSortie(uid, app, sid, now, c));
      } else if (m["role"] === "assistant") {
        const tcs = lire(m, "tool_calls");
        for (const tc of Array.isArray(tcs) ? tcs : []) {
          if (!estDict(tc)) continue;
          const fnBrut = lire(tc, "function");
          const fn: Dict = estDict(fnBrut) ? fnBrut : {};
          const name = lire(fn, "name");
          if (!veritePy(name)) continue;
          const args = lire(fn, "arguments");
          const txt = stripPy(`${strPy(name)} ${typeof args === "string" ? args : ""}`);
          rows.push({
            user_id: uid,
            app,
            session_id: sid,
            scope_key: "",
            role: "tool_call",
            content: Array.from(txt).slice(0, 1000).join(""),
            ts: now,
          });
        }
      }
    }
    const n = rows.length ? await port.sessionIndexMessages(rows) : 0;
    if (n)
      log.info(
        `[compressor] ${n} ligne(s) outil indexée(s) en FTS avant compression (session ${sid.slice(0, 12)})`,
      );
  } catch (e) {
    if (estAnnulation(e)) throw e;
    log.debug(`[compressor] FTS pré-compression échoué (non-fatal) : ${String(e)}`);
  }
}

/** Indexe, avant leur effacement de la vue, les sorties d'outils dont la clé d'élagage est dans `cles` (même format que la compression) ; best-effort. */
export async function indexPrunedToolOutputs(
  messages: readonly unknown[],
  cles: readonly string[],
  username: string,
  sessionId: string | null,
  app = "chat",
): Promise<number> {
  const voulues = new Set(cles);
  const sorties = messages.filter(
    (m): m is Dict =>
      estDict(m) &&
      m["role"] === "tool" &&
      typeof m["content"] === "string" &&
      stripPy(m["content"]) !== "" &&
      voulues.has(pruneKey(m) ?? "\0"),
  );
  if (!sorties.length) return 0;
  try {
    const port = portCompresseur();
    const uid = username ? await port.userIdParNom(username) : null;
    if (uid === null) return 0;
    const sid = sessionId || "compressed";
    const now = Date.now() / 1000;
    const n = await port.sessionIndexMessages(
      sorties.map((m) => ligneSortie(uid, app, sid, now, m["content"] as string)),
    );
    if (n)
      log.info(
        `[élagage] ${n} sortie(s) d'outil indexée(s) en FTS avant effacement (session ${sid.slice(0, 12)})`,
      );
    return n;
  } catch (e) {
    if (estAnnulation(e)) throw e;
    log.debug(`[élagage] FTS avant effacement échoué (non-fatal) : ${String(e)}`);
    return 0;
  }
}

export interface OptionsCompress {
  modelOverride?: string | null;
  userId?: string;
  endpointUrl?: string | null;
  endpointModel?: string | null;
  endpointTimeoutSec?: number;
  ctxSizeTokens?: number | null;
  usableTokens?: number | null;
  force?: boolean;
  precomputedTokensBefore?: [number, boolean] | null;
  countExact?: boolean;
  extraFixedTokens?: number;
  requireProjectedGain?: boolean;
  ftsSessionId?: string | null;
  /** Clés d'élagage des sorties déjà indexées (pas de doublon dans l'index). */
  ftsDejaIndexees?: ReadonlySet<string> | null;
  /** `false` : rien d'indexé (tour éphémère). */
  ftsIndexer?: boolean;
  countModel?: string | null;
  signal?: AbortSignal | undefined;
}

const THINK_TAGS = ["<context>", "<facts>", "<state>", "<actions_done>", "<pitfalls>"];

/** Compresseur sans état : le résumé précédent vit dans la conversation. */
export class ConversationCompressor {
  readonly llamaChat: LlamaChatFn;
  readonly keepRecentTurns: number;
  readonly keepBridgeTurns: number;

  constructor(
    llamaChatFn: LlamaChatFn,
    options: { keepRecentTurns?: number; keepBridgeTurns?: number } = {},
  ) {
    this.llamaChat = llamaChatFn;
    this.keepRecentTurns = options.keepRecentTurns ?? 6;
    this.keepBridgeTurns = options.keepBridgeTurns ?? 3;
  }

  minMatterTurns(): number {
    return this.keepRecentTurns + this.keepBridgeTurns + 2;
  }

  /** Compresse (le déclenchement appartient à l'appelant) : `[messages, stats]`, `stats.compressed` dit si quelque chose a changé. */
  async compress(messages: Dict[], o: OptionsCompress = {}): Promise<[Dict[], Dict]> {
    const modelOverride = o.modelOverride ?? null;
    const endpointUrl = o.endpointUrl ?? null;
    const endpointModel = o.endpointModel ?? null;
    const extraFixed = intPy(o.extraFixedTokens || 0);
    const targetModel = o.countModel || modelOverride || endpointModel || config.LLAMA_MODEL || "";
    const avant =
      o.precomputedTokensBefore ?? (await countTokensAsyncEx(messages, targetModel || null, o.signal));
    o.signal?.throwIfAborted();
    let tokensBefore = avant[0];
    const tokensBeforeEst = avant[1];
    const [systemMsgs, compressible, bridge, recent] = splitByTurnIndex(
      messages,
      this.keepRecentTurns,
      this.keepBridgeTurns,
    );
    let toCompress = compressible;
    if (!toCompress.length) return [messages, { compressed: false, reason: "nothing_to_compress" }];

    let keptVerbatim: Dict[] = [];
    let targetAfter = 0;
    let zoneTokens = 0;
    const usable = o.usableTokens ?? null;
    if (!o.force && usable && usable > 0) {
      let ratio: number;
      try {
        ratio = floatPy(config.COMPACTION_PARTIAL_TARGET_RATIO);
      } catch {
        ratio = PARTIAL_TARGET_RATIO;
      }
      targetAfter = intPy(usable * ratio);
      const excess = tokensBefore + extraFixed - targetAfter;
      if (excess > 0) {
        const groups = leadingTurnGroups(toCompress) as Dict[][];
        const perMsg = await countMessagesTokensPerMsg(toCompress, targetModel || null, { signal: o.signal });
        o.signal?.throwIfAborted();
        const sizes: number[] = [];
        let i = 0;
        for (const g of groups) {
          sizes.push(perMsg.slice(i, i + g.length).reduce((a, b) => a + b, 0));
          i += g.length;
        }
        let freed = 0;
        let nTake = 0;
        for (const sz of sizes) {
          if (freed >= excess) break;
          freed += sz;
          nTake++;
        }
        if (nTake >= 2 && nTake < groups.length) {
          keptVerbatim = groups.slice(nTake).flat();
          toCompress = groups.slice(0, nTake).flat();
          zoneTokens = freed;
        } else zoneTokens = sizes.reduce((a, b) => a + b, 0);
      }
    }

    if (o.requireProjectedGain && zoneTokens > 0 && zoneTokens - EXPECTED_SUMMARY_TOKENS <= 0) {
      log.info(
        `[compressor] compaction abandonnée avant l'appel : la zone compressible ne pèse que ${zoneTokens} tk, ` +
          `soit moins que le résumé qui la remplacerait (~${EXPECTED_SUMMARY_TOKENS} tk) — la garde no-gain l'aurait ` +
          `annulée après coup (occupation ${tokensBefore + extraFixed} tk, cible ${targetAfter} tk)`,
      );
      return [
        messages,
        {
          compressed: false,
          reason: "gain_too_small",
          defer_retry: true,
          zone_tokens: zoneTokens,
          target_after_tokens: targetAfter,
          tokens_before: tokensBefore + extraFixed,
        },
      ];
    }

    const turnsCompressed = countTurns(toCompress);
    const prevSummary = extractPreviousSummary(messages);
    const modeleResumeur = modelOverride || config.LLAMA_MODEL || "";
    let serBudget = tokensToChars(computeSerializerBudgetTokens(toCompress.length, null));
    let serTotal = tokensToChars(computeSerializerTotalBudgetTokens(null));
    if (!endpointUrl) {
      try {
        const comprCtx = await getModelContextSize(modeleResumeur);
        serBudget = computeSerializerBudget(toCompress.length, comprCtx, modeleResumeur || null);
        serTotal = tokensToChars(computeSerializerTotalBudgetTokens(comprCtx), modeleResumeur || null);
      } catch (e) {
        if (estAnnulation(e)) throw e;
      }
      o.signal?.throwIfAborted();
    }
    let prevLedger: string[] = [];
    const porteur = messages.find(isSummaryCarrier);
    if (porteur !== undefined) prevLedger = parseLedgerLines((porteur["content"] as string) || "");
    const ledgerBlock = renderArtifactLedger(
      mergeLedgerLines(prevLedger, extractArtifactLedger(toCompress).map(renderEntry)),
    );
    const conversationText = serializeForCompression(toCompress, {
      maxCharsPerMsg: serBudget,
      maxTotalChars: serTotal,
    });
    const userPayload = prevSummary
      ? `<anchored_summary>\n${prevSummary}\n</anchored_summary>\n\n` +
        "Update the anchored summary above: merge in the facts from the new turns below, keep still-relevant " +
        "entries, move finished work to Done, drop obsolete Next Steps. On contradiction, the new turns win. " +
        "Output the FULL updated summary in the same anchored format.\n\n" +
        conversationText
      : conversationText;
    const compressionPrompt: Dict[] = [
      { role: "system", content: COMPRESSOR_SYSTEM_PROMPT },
      { role: "user", content: userPayload },
    ];

    const tStart = Date.now();
    let usedPath = "self";
    let summaryText: string;
    let meta: Dict | null;
    try {
      if (endpointUrl) {
        usedPath = "endpoint";
        const modele = endpointModel || modelOverride || "";
        [summaryText, meta] = await callExternalEndpoint(compressionPrompt, {
          url: endpointUrl,
          model: modele,
          timeoutSec: o.endpointTimeoutSec ?? 120,
          signal: o.signal,
        });
        try {
          portCompresseur().recordTurnUsage(lire(meta, "usage") ?? null, {
            model: modele,
            path: "compression",
            durationMs: Date.now() - tStart,
            iterations: 1,
          });
        } catch (e) {
          log.debug(`[compressor] usage non enregistré : ${String(e)}`);
        }
      } else {
        usedPath = modelOverride ? "external_model" : "self";
        [summaryText, meta] = await this.llamaChat(compressionPrompt, {
          userId: o.userId ?? "system",
          modelOverride,
          samplingOverride: { max_tokens: 4096 },
          usageScope: "compression",
          signal: o.signal,
        });
        if (lire(meta, "error")) throw new Error(summaryText);
      }
    } catch (e) {
      if (estAnnulation(e) || o.signal?.aborted) throw e;
      log.warn(`[compressor] LLM call failed (path=${usedPath}): ${messageErreur(e)}`);
      return [messages, { compressed: false, reason: `llm_error: ${messageErreur(e)}`, path: usedPath }];
    }
    o.signal?.throwIfAborted();
    const durationMs = Date.now() - tStart;

    summaryText = stripPy((summaryText || "").replace(RE_THINK_BLOCK, "").replace(RE_THINK_ORPHELIN, ""));
    const ouvrant = RE_THINK_OPEN.exec(summaryText);
    if (ouvrant) summaryText = stripPy(summaryText.slice(0, ouvrant.index));
    if (!summaryText || Array.from(summaryText).length < 30) {
      return [
        messages,
        { compressed: false, reason: "summary_too_short", path: usedPath, duration_ms: durationMs },
      ];
    }
    let summaryCoerced = false;
    if (!(summaryText.includes("## ") || THINK_TAGS.some((t) => summaryText.includes(t)))) {
      log.warn(
        `[compressor] résumé sans structure (ni sections ## ni balises, path=${usedPath}) → enveloppé dans <context> (coerce)`,
      );
      summaryText = `<context>\n${summaryText}\n</context>`;
      summaryCoerced = true;
    }

    const systemSansResume: Dict[] = [];
    for (const m of systemMsgs) {
      const c = veritePy(m["content"]) ? m["content"] : "";
      if (!(typeof c === "string" && c.includes(SUMMARY_MARKER_START))) {
        systemSansResume.push(m);
        continue;
      }
      const kept = stripSummarySpan(c);
      if (kept) systemSansResume.push({ ...m, content: kept });
    }
    const gardes = [...keptVerbatim, ...bridge, ...recent];
    const jobs = await jobsDeLAncre(o);
    const pins = pinTaskAnchor(gardes, toCompress, jobs);
    const compressed: Dict[] = [
      ...systemSansResume,
      formatSummaryAsSystemMessage(summaryText, turnsCompressed, ledgerBlock),
      ...pins,
      ...jobsSurLaQuestion(gardes, pins, jobs),
    ];

    const chars = (ms: readonly Dict[]): number =>
      ms.reduce((a, m) => a + Array.from(strPy(veritePy(m["content"]) ? m["content"] : "")).length, 0);
    const originalChars = chars(messages);
    const compressedChars = chars(compressed);
    let tokensAfter: number;
    let tokensAfterEst: boolean;
    if (o.countExact ?? true)
      [tokensAfter, tokensAfterEst] = await countTokensAsyncEx(compressed, targetModel || null, o.signal);
    else
      [tokensAfter, tokensAfterEst] = [
        measuredPromptTokens(compressed, { modelId: targetModel || null }),
        true,
      ];
    o.signal?.throwIfAborted();
    const tokensEstimated = tokensBeforeEst || tokensAfterEst;
    if (extraFixed) {
      tokensBefore += extraFixed;
      tokensAfter += extraFixed;
    }
    if (tokensAfter >= tokensBefore) {
      log.warn(
        `[compressor] compression sans gain (${tokensBefore} → ${tokensAfter} tokens, path=${usedPath}) → rollback`,
      );
      return [
        messages,
        {
          compressed: false,
          reason: "no_token_gain",
          tokens_before: tokensBefore,
          tokens_after: tokensAfter,
          tokens_estimated: tokensEstimated,
          path: usedPath,
          duration_ms: durationMs,
        },
      ];
    }
    const asked = targetAfter > 0 ? tokensBefore - targetAfter : 0;
    const got = tokensBefore - tokensAfter;
    const targetReached = targetAfter <= 0 || tokensAfter <= targetAfter;
    const targetMissed = asked > 0 && !targetReached && got * 2 < asked;
    if (targetMissed) {
      log.warn(
        `[compressor] cible manquée : ${tokensBefore} → ${tokensAfter} tk (−${got}) alors que la cible était ` +
          `${targetAfter} tk — il manque ${tokensAfter - targetAfter} tk. Zone compressible : ${zoneTokens} tk. La ` +
          "matière compactable ne suffit pas à ramener l'occupation sous la cible (tours protégés = " +
          `${this.keepRecentTurns} récents + ${this.keepBridgeTurns} de transition) ; prochaine tentative différée.`,
      );
    }
    const stats: Dict = {
      compressed: true,
      turns_compressed: turnsCompressed,
      messages_before: messages.length,
      messages_after: compressed.length,
      chars_before: originalChars,
      chars_after: compressedChars,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      tokens_saved: maxPy(0, tokensBefore - tokensAfter),
      tokens_estimated: tokensEstimated,
      ratio: arrondiPy(compressedChars / maxPy(originalChars, 1), 3),
      had_previous_summary: prevSummary !== null,
      summary_coerced: summaryCoerced,
      model_used: estDict(meta) ? (lire(meta, "model") ?? null) : null,
      path: usedPath,
      duration_ms: durationMs,
      ledger_block: ledgerBlock,
      target_after_tokens: targetAfter,
      target_reached: targetReached,
      zone_tokens: zoneTokens,
      defer_retry: targetMissed,
    };
    if (o.ftsIndexer !== false)
      await indexCoveredTurnsFts(
        toCompress,
        o.userId ?? "system",
        o.ftsSessionId ?? null,
        o.ftsDejaIndexees ?? null,
      );
    o.signal?.throwIfAborted();
    log.info(
      `[compressor] OK path=${usedPath} — ${turnsCompressed} tours résumés, ${tokensBefore}→${tokensAfter} tokens ` +
        `(−${stats["tokens_saved"] as number}), ${durationMs}ms, cumulatif=${prevSummary !== null ? "True" : "False"}`,
    );
    return [compressed, stats];
  }
}

const ATTEMPTED_FAILURE_PREFIXES = [
  "llm_error",
  "summary_too_short",
  "summary_invalid_format",
  "no_token_gain",
  "exception",
];
let reloadWarnedOnce = false;

/** Vrai si la compression a été tentée pour de bon (succès ou échec coûteux) : sert au recul des échecs de la boucle. */
export function compressionWasAttempted(stats: Dict): boolean {
  if (veritePy(stats["compressed"])) return true;
  const reason = strPy(stats["reason"] ?? "");
  return ATTEMPTED_FAILURE_PREFIXES.some((p) => reason.startsWith(p));
}

export interface OptionsMaybeCompress {
  llamaChatFn: LlamaChatFn;
  onEvent?: SurEvenement | null;
  model?: string | null;
  userId?: string;
  logPrefix?: string;
  ctxSizeTokens?: number | null;
  realTokens?: number | null;
  usableTokens?: number | null;
  triggerTokens?: number | null;
  maxRounds?: number | null;
  triggeredByOverflow?: boolean;
  prevState?: Dict | null;
  manual?: boolean;
  extraFixedTokens?: number;
  ftsSessionId?: string | null;
  ftsDejaIndexees?: ReadonlySet<string> | null;
  ftsIndexer?: boolean;
  autoEnabled?: boolean | null;
  signal?: AbortSignal | undefined;
}

async function emettre(
  onEvent: SurEvenement | null | undefined,
  evenement: Dict,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!onEvent) return;
  try {
    await onEvent(evenement);
  } catch (e) {
    if (estAnnulation(e)) throw e;
  }
  signal?.throwIfAborted();
}

function resynchroniser(logPrefix: string): void {
  try {
    reloadCompressionConfigFromDisk();
  } catch (e) {
    const msg = Array.from(String(e instanceof Error ? e.message : e))
      .slice(0, 120)
      .join("");
    if (!reloadWarnedOnce) {
      reloadWarnedOnce = true;
      log.warn(
        `[${logPrefix}] reload_compression_config_from_disk a échoué : ${msg} — ce worker continue avec ses valeurs ` +
          "en mémoire (les changements admin ne sont PAS appliqués ici). Averti une seule fois par process.",
      );
    } else {
      log.debug(
        `[${logPrefix}] reload_compression_config_from_disk a échoué : ${msg} (on continue avec les valeurs en mémoire)`,
      );
    }
  }
}

/** Le moteur de la cible compte les jetons exactement (sinon l'estimation mesurée suffit). */
function cibleTokenisationExacte(): boolean {
  try {
    return currentTarget().profil.capacites.tokenisation !== null;
  } catch {
    return true;
  }
}

/** Cycle complet « vérifier → compresser → émettre » partagé par la boucle et la compaction manuelle ; jamais fatal. */
export async function maybeCompressConversation(
  messages: Dict[],
  o: OptionsMaybeCompress,
): Promise<[Dict[], Dict]> {
  const logPrefix = o.logPrefix ?? "chat";
  const manual = o.manual ?? false;
  const overflow = o.triggeredByOverflow ?? false;
  const extraFixed = intPy(o.extraFixedTokens || 0);
  try {
    resynchroniser(logPrefix);
    const autoOn =
      o.autoEnabled === null || o.autoEnabled === undefined
        ? veritePy(config.COMPRESSION_ENABLED)
        : o.autoEnabled;
    if (!autoOn && !manual) return [messages, { compressed: false, reason: "disabled" }];
    const compressor = new ConversationCompressor(o.llamaChatFn, {
      keepRecentTurns: config.COMPRESSION_KEEP_RECENT,
      keepBridgeTurns: config.COMPRESSION_KEEP_BRIDGE,
    });
    const endpointUrl = config.COMPRESSION_ENDPOINT_URL;
    const endpointModel = config.COMPRESSION_ENDPOINT_MODEL;
    let usable = o.usableTokens ?? null;
    const ctx = o.ctxSizeTokens ?? null;
    if (usable === null && ctx && ctx > 0) usable = usableWindow(ctx, false);
    let trigger = usable;
    if (o.triggerTokens && o.triggerTokens > 0 && usable && usable > 0)
      trigger = minPy(intPy(o.triggerTokens), intPy(usable));
    const modelForCount =
      o.model || endpointModel || config.COMPRESSION_EXTERNAL_MODEL || config.LLAMA_MODEL || "";
    const real = o.realTokens;
    const avecReel = typeof real === "number" && real > 0;
    if (!manual) {
      if (countTurns(messages) < compressor.minMatterTurns()) {
        return [messages, { compressed: false, reason: "threshold_not_reached" }];
      }
      if (!(usable && usable > 0)) return [messages, { compressed: false, reason: "ctx_unknown" }];
      if (!overflow) {
        const occ = avecReel
          ? intPy(real)
          : measuredPromptTokens(messages, { modelId: modelForCount || null, extraFixed });
        if (occ < trigger!) {
          return [
            messages,
            {
              compressed: false,
              reason: "threshold_not_reached",
              occupancy_tokens: occ,
              usable_tokens: usable,
              trigger_tokens: trigger,
            },
          ];
        }
      }
    }
    const countExact = cibleTokenisationExacte();
    const [tokensBefore, tokensBeforeEst] = countExact
      ? await countTokensAsyncEx(messages, modelForCount || null, o.signal)
      : [measuredPromptTokens(messages, { modelId: modelForCount || null }), true];
    o.signal?.throwIfAborted();
    if (!manual && !overflow && !avecReel) {
      const occExact = tokensBefore + extraFixed;
      if (occExact < trigger!) {
        return [
          messages,
          {
            compressed: false,
            reason: "threshold_not_reached",
            occupancy_tokens: occExact,
            usable_tokens: usable,
            trigger_tokens: trigger,
          },
        ];
      }
    }
    const maxRounds =
      o.maxRounds !== null && o.maxRounds !== undefined
        ? intPy(o.maxRounds)
        : intPy(config.COMPRESSION_MAX_PER_CHAT || 0);
    const roundsDone = intPy(veritePy(lire(o.prevState ?? {}, "round")) ? lire(o.prevState, "round") : 0);
    if (maxRounds > 0 && roundsDone >= maxRounds) {
      log.info(
        `[${logPrefix}] compression bloquée : cap atteint (${roundsDone}/${maxRounds})${manual ? " [manuel]" : ""}`,
      );
      await emettre(o.onEvent, { type: "compression_capped", round: roundsDone, max: maxRounds }, o.signal);
      return [
        messages,
        { compressed: false, reason: "max_rounds_reached", round: roundsDone, max: maxRounds },
      ];
    }
    let compressModel: string;
    let usesExternal: boolean;
    let pathKind: string;
    if (endpointUrl) {
      compressModel = endpointModel || o.model || "";
      usesExternal = true;
      pathKind = "endpoint";
    } else if (config.COMPRESSION_EXTERNAL_MODEL) {
      compressModel = config.COMPRESSION_EXTERNAL_MODEL;
      usesExternal = true;
      pathKind = "external_model";
    } else {
      compressModel = o.model || "";
      usesExternal = false;
      pathKind = "self";
    }
    const turnsBefore = countTurns(messages);
    await emettre(
      o.onEvent,
      {
        type: "compression_start",
        external: usesExternal,
        path: pathKind,
        model: compressModel,
        turns: turnsBefore,
        tokens: tokensBefore + extraFixed,
        ctx_size: ctx || 0,
        threshold: intPy(trigger || 0),
        reason: manual ? "manual" : overflow ? "overflow" : "threshold",
      },
      o.signal,
    );
    log.info(
      `[${logPrefix}] compression triggered : path=${pathKind}, model=${compressModel}, turns=${turnsBefore}, ` +
        `tokens≈${tokensBefore + extraFixed}, n_ctx=${strPy(ctx)}, seuil=${strPy(trigger)}` +
        (trigger === usable ? "" : ` (plafond technique ${strPy(usable)})`),
    );
    const [compressed, stats] = await compressor.compress(messages, {
      modelOverride: config.COMPRESSION_EXTERNAL_MODEL || (o.model ?? null),
      userId: o.userId ?? "system",
      endpointUrl: endpointUrl || null,
      endpointModel: endpointModel || null,
      endpointTimeoutSec: config.COMPRESSION_ENDPOINT_TIMEOUT_SEC,
      ctxSizeTokens: ctx,
      usableTokens: trigger,
      force: manual,
      countExact,
      precomputedTokensBefore: [tokensBefore, tokensBeforeEst],
      extraFixedTokens: extraFixed,
      requireProjectedGain: !manual && !overflow,
      ftsSessionId: o.ftsSessionId ?? null,
      ftsDejaIndexees: o.ftsDejaIndexees ?? null,
      ...(o.ftsIndexer === false ? { ftsIndexer: false } : {}),
      countModel: modelForCount || null,
      signal: o.signal,
    });
    if (veritePy(stats["compressed"])) {
      const newRound = roundsDone + 1;
      const ps = o.prevState ?? {};
      const prevCov = Object.hasOwn(ps, "applied_drop_turns")
        ? intPy(veritePy(ps["applied_drop_turns"]) ? ps["applied_drop_turns"] : 0)
        : veritePy(ps["applied_drop"])
          ? intPy(veritePy(ps["covered_turns"]) ? ps["covered_turns"] : 0)
          : 0;
      const turnsCompressed = intPy(veritePy(stats["turns_compressed"]) ? stats["turns_compressed"] : 0);
      const newCovered = prevCov + turnsCompressed;
      stats["round"] = newRound;
      stats["max_rounds"] = maxRounds;
      const summaryXml = extractPreviousSummary(compressed) ?? "";
      const ledger = veritePy(stats["ledger_block"]) ? stats["ledger_block"] : "";
      stats["new_state"] = {
        round: newRound,
        covered_turns: newCovered,
        summary_xml: summaryXml,
        turns_compressed: turnsCompressed,
        ledger_block: ledger,
      };
      if (summaryXml) {
        await emettre(
          o.onEvent,
          {
            type: "compression_state",
            round: newRound,
            covered_turns: newCovered,
            summary_xml: summaryXml,
            turns_compressed: turnsCompressed,
            ledger_block: ledger,
          },
          o.signal,
        );
      }
    }
    await emettre(
      o.onEvent,
      { type: "compression_done", external: usesExternal, path: pathKind, stats },
      o.signal,
    );
    if (veritePy(stats["compressed"])) {
      log.info(
        `[${logPrefix}] compression OK : ${strPy(stats["messages_before"])} → ${strPy(stats["messages_after"])} msgs, ` +
          `${strPy(stats["tokens_before"])} → ${strPy(stats["tokens_after"])} tokens (−${strPy(stats["tokens_saved"])}), ` +
          `${strPy(stats["duration_ms"])}ms, cumulatif=${strPy(stats["had_previous_summary"])}`,
      );
      return [compressed, stats];
    }
    log.warn(`[${logPrefix}] compression attempted but not applied : ${strPy(stats["reason"] ?? "unknown")}`);
    return [messages, stats];
  } catch (e) {
    if (estAnnulation(e) || o.signal?.aborted) throw e;
    log.warn(`[${logPrefix}] compression failed (non-fatal): ${String(e instanceof Error ? e.message : e)}`);
    return [messages, { compressed: false, reason: `exception: ${messageErreur(e)}` }];
  }
}
