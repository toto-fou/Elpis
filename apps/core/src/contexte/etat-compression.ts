// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/etat-compression.ts — état persisté de la compression (porteur du résumé, ligne META, tours couverts). */
import { intPy, maxPy, minPy, stripPy, strPy, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";

import { estDict, lire } from "../python";
import type { Dict } from "../python";
import { parseLedgerLines, renderArtifactLedger } from "./compression/serialiseur";
import { CTX } from "./config-contexte";
import { isEphemeral } from "./elagage";

export const SUMMARY_MARKER_START = "[COMPRESSED_SUMMARY_V1]";
export const SUMMARY_MARKER_END = "[/COMPRESSED_SUMMARY_V1]";
export const FOLD_SEP = "\n\n---\n\n";
const META = "\\[COMPRESSION_META v=1 round=(\\p{Nd}+) covered_turns=(\\p{Nd}+)\\]";
const COMPRESSION_META_RE = new RegExp(META, "u");

export interface CompressionState {
  round: number;
  covered_turns: number;
  summary_xml: string;
  ledger_block: string;
}

/** Résumé brut (entre les marqueurs) du premier message system qui en porte un ; `null` sinon. */
export function extractPreviousSummary(messages: readonly unknown[]): string | null {
  for (const m of messages) {
    if (lire(m, "role") !== "system") continue;
    const brut = lire(m, "content");
    const content = veritePy(brut) ? brut : "";
    if (typeof content !== "string" || !content.includes(SUMMARY_MARKER_START)) continue;
    const start = content.indexOf(SUMMARY_MARKER_START) + SUMMARY_MARKER_START.length;
    const end = content.indexOf(SUMMARY_MARKER_END, start);
    if (end < 0) continue;
    return stripPy(content.slice(start, end));
  }
  return null;
}

function noteSurchargee(): string {
  try {
    return CTX.override("compression.reinjection_note", "");
  } catch {
    return "";
  }
}

/** Message system porteur : marqueurs, note de ré-injection (`compression.reinjection_note`, `{n}`), registre hors marqueurs. */
export function formatSummaryAsSystemMessage(
  summaryXml: string,
  turnsCompressed: number,
  ledgerBlock = "",
): Dict {
  let note =
    `(Compressed memory of ${strPy(turnsCompressed)} earlier turns. The facts above are the source of truth for that ` +
    "period. The messages that follow are the most recent, up-to-date ones.)";
  const ov = noteSurchargee();
  if (ov) note = ov.includes("{n}") ? ov.replaceAll("{n}", strPy(turnsCompressed)) : ov;
  let body = `${SUMMARY_MARKER_START}\n${stripPy(summaryXml)}\n${SUMMARY_MARKER_END}\n\n${note}`;
  if (stripPy(ledgerBlock || "")) body += `\n\n${stripPy(ledgerBlock)}`;
  return { role: "system", content: body };
}

/** `{round, covered_turns, summary_xml, ledger_block}` du premier porteur ; sans ligne META : round 1, 0 tour couvert. */
export function extractCompressionState(
  messages: readonly unknown[] | null | undefined,
): CompressionState | null {
  for (const m of messages ?? []) {
    if (!estDict(m) || m["role"] !== "system") continue;
    const brut = lire(m, "content");
    const content = veritePy(brut) ? brut : "";
    if (typeof content !== "string" || !content.includes(SUMMARY_MARKER_START)) continue;
    const start = content.indexOf(SUMMARY_MARKER_START) + SUMMARY_MARKER_START.length;
    const end = content.indexOf(SUMMARY_MARKER_END, start);
    if (end < 0) continue;
    const summary = stripPy(content.slice(start, end));
    const lignes = parseLedgerLines(content);
    const ledger = lignes.length ? renderArtifactLedger(lignes) : "";
    const mt = COMPRESSION_META_RE.exec(content);
    if (mt) {
      return { round: intPy(mt[1]), covered_turns: intPy(mt[2]), summary_xml: summary, ledger_block: ledger };
    }
    return { round: 1, covered_turns: 0, summary_xml: summary, ledger_block: ledger };
  }
  return null;
}

/** Message d'état : ligne META puis porteur du résumé. */
export function buildStateSystemMessage(
  summaryXml: string,
  roundNo: number,
  coveredTurns: number,
  turnsCompressed: number | null = null,
  ledgerBlock = "",
): Dict {
  const base = formatSummaryAsSystemMessage(summaryXml, turnsCompressed ?? coveredTurns, ledgerBlock);
  const meta = `[COMPRESSION_META v=1 round=${intPy(roundNo)} covered_turns=${intPy(coveredTurns)}]`;
  base["content"] = `${meta}\n${base["content"] as string}`;
  return base;
}

/** Message system dont le contenu texte porte un bloc `[COMPRESSED_SUMMARY_V1]`. */
export function isSummaryCarrier(msg: unknown): boolean {
  if (!estDict(msg) || msg["role"] !== "system") return false;
  const c = msg["content"];
  return typeof c === "string" && c.includes(SUMMARY_MARKER_START);
}

function derniereMeta(texte: string): RegExpExecArray | null {
  let dernier: RegExpExecArray | null = null;
  for (const m of texte.matchAll(new RegExp(META, "gu"))) dernier = m as RegExpExecArray;
  return dernier;
}

/** Retire les blocs résumé (META, marqueurs, note jusqu'au séparateur de fold suivant) en gardant le reste. */
export function stripSummarySpan(content: string): string {
  let out = content;
  while (out.includes(SUMMARY_MARKER_START)) {
    const s = out.indexOf(SUMMARY_MARKER_START);
    let blockStart = s;
    const meta = derniereMeta(out.slice(0, s));
    if (meta !== null && !stripPy(out.slice(meta.index + meta[0].length, s))) blockStart = meta.index;
    const sepPrev =
      blockStart >= FOLD_SEP.length ? out.lastIndexOf(FOLD_SEP, blockStart - FOLD_SEP.length) : -1;
    if (sepPrev !== -1 && !stripPy(out.slice(sepPrev + FOLD_SEP.length, blockStart))) blockStart = sepPrev;
    const e = out.indexOf(SUMMARY_MARKER_END, s);
    let blockEnd: number;
    if (e === -1) blockEnd = out.length;
    else {
      const sepNext = out.indexOf(FOLD_SEP, e + SUMMARY_MARKER_END.length);
      blockEnd = sepNext === -1 ? out.length : sepNext;
    }
    if (blockStart === 0 && blockEnd < out.length) blockEnd += FOLD_SEP.length;
    out = out.slice(0, blockStart) + out.slice(blockEnd);
  }
  return stripPy(out);
}

/** Retire tout bloc résumé : porteur autonome retiré entier, contenu fusionné réduit à son socle (copie). */
export function stripSummaryMessages(messages: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (!isSummaryCarrier(m)) {
      out.push(m);
      continue;
    }
    const stripped = stripSummarySpan(((m as Dict)["content"] as string) || "");
    if (stripped) out.push({ ...(m as Dict), content: stripped });
  }
  return out;
}

/** Tours : user (non éphémère), assistant à tool_calls, assistant pur sauf réponse finale après outils. */
export function countTurns(messages: readonly unknown[]): number {
  let turns = 0;
  let prevWasTool = false;
  for (const m of messages) {
    if (!estDict(m)) continue;
    const role = m["role"];
    if (role === "user") {
      if (!isEphemeral(m)) turns++;
      prevWasTool = false;
    } else if (role === "assistant") {
      if (veritePy(lire(m, "tool_calls"))) turns++;
      else if (!prevWasTool) turns++;
      prevWasTool = false;
    } else if (role === "tool") prevWasTool = true;
  }
  return turns;
}

/** Groupes de messages par tour (même découpage que `countTurns`), messages non-dict rattachés au tour courant. */
export function leadingTurnGroups(messages: readonly unknown[]): unknown[][] {
  const groups: unknown[][] = [];
  let cur: unknown[] = [];
  let prevWasTool = false;
  for (const m of messages) {
    const role = estDict(m) ? m["role"] : null;
    let isNew = false;
    if (role === "user") {
      isNew = !isEphemeral(m);
      prevWasTool = false;
    } else if (role === "assistant") {
      isNew = veritePy(lire(m, "tool_calls")) || !prevWasTool;
      prevWasTool = false;
    } else if (role === "tool") prevWasTool = true;
    if (isNew && cur.length) {
      groups.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Retire les `nTurns` premiers tours non-system. */
export function dropLeadingTurns(messages: readonly unknown[], nTurns: number): unknown[] {
  const out: unknown[] = [];
  let turns = 0;
  let prevWasTool = false;
  for (const m of messages) {
    const role = estDict(m) ? m["role"] : null;
    if (role === "system") {
      out.push(m);
      continue;
    }
    if (role === "user") {
      if (!isEphemeral(m)) turns++;
      prevWasTool = false;
    } else if (role === "assistant") {
      if (veritePy(lire(m, "tool_calls"))) turns++;
      else if (!prevWasTool) turns++;
      prevWasTool = false;
    } else if (role === "tool") prevWasTool = true;
    if (turns > nTurns) out.push(m);
  }
  return out;
}

/** Zones conservées après le drop : `COMPRESSION_KEEP_RECENT + COMPRESSION_KEEP_BRIDGE` (9 si illisible). */
function toursConserves(): number {
  try {
    return intPy(config.COMPRESSION_KEEP_RECENT) + intPy(config.COMPRESSION_KEEP_BRIDGE);
  } catch {
    return 9;
  }
}

/** Ré-applique l'état : résumé dédoublonné, tours couverts retirés (drop partiel si l'historique a bougé), porteur inséré après les system de tête. */
export function applyPersistedState(
  messages: readonly unknown[] | null | undefined,
  state: Dict | null | undefined,
): [unknown[], Dict | null | undefined] {
  const summary = state ? lire(state, "summary_xml") : undefined;
  if (!state || !stripPy(veritePy(summary) ? (summary as string) : "")) return [messages as unknown[], state];
  let msgs = stripSummaryMessages([...(messages ?? [])]);
  const covered = maxPy(0, intPy(veritePy(state["covered_turns"]) ? state["covered_turns"] : 0));
  let appliedDrop = false;
  let droppedTurns = 0;
  if (covered > 0) {
    droppedTurns = minPy(covered, maxPy(0, countTurns(msgs) - toursConserves()));
    if (droppedTurns > 0) {
      msgs = dropLeadingTurns(msgs, droppedTurns);
      appliedDrop = true;
    }
  }
  const ledger = lire(state, "ledger_block");
  const stateMsg = buildStateSystemMessage(
    summary as string,
    intPy(veritePy(state["round"]) ? state["round"] : 1),
    covered,
    null,
    veritePy(ledger) ? (ledger as string) : "",
  );
  let insertAt = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (lire(msgs[i], "role") === "system") insertAt = i + 1;
    else break;
  }
  msgs.splice(insertAt, 0, stateMsg);
  return [msgs, { ...state, applied_drop: appliedDrop, applied_drop_turns: droppedTurns }];
}
