// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/compression/serialiseur.ts — entrée du résumeur (budget dérivé du n_ctx) et registre déterministe des fichiers touchés. */
import { intPy, maxPy, minPy, stripPy, strPy, veritePy } from "@elpis/commun";

import { resultIsError } from "../../boucle/contrat-resultat";
import { toolTraits } from "../../outils/traits";
import { BLANC_PY, estDict, lire, splitlinesPy } from "../../python";
import type { Dict } from "../../python";
import { chargerJson, cleHash, longueurCp, truncateHeadTail } from "../elagage";
import { tokensToChars } from "../tokens";

export const LEDGER_START = "[ARTIFACTS v=1]";
export const LEDGER_END = "[/ARTIFACTS]";
export const LEDGER_MAX_ENTRIES = 40;

const INPUT_CTX_SHARE = 0.5;
const SER_BUDGET_FLOOR_TOKENS = 600;
const SER_BUDGET_CEIL_TOKENS = 6_000;
export const SER_BUDGET_FLOOR = tokensToChars(SER_BUDGET_FLOOR_TOKENS);
const SER_TOTAL_DEFAULT_TOKENS = 4_096;
const SER_MIN_CHARS_PER_MSG = 160;
export const ARGS_MAX_CHARS = 500;

/** Chemin cible d'un appel mutant (`path`, `filename`, `target`, `paths`, `name`, préfixé du `repo`) ; `""` sinon. */
export function extractTargetPath(args: unknown): string {
  let a = args;
  if (typeof a === "string") {
    const lu = chargerJson(a);
    if (!lu.ok) return "";
    a = lu.valeur;
  }
  if (!estDict(a)) return "";
  let path: unknown = [lire(a, "path"), lire(a, "filename"), lire(a, "target")].find(veritePy) ?? "";
  if (!veritePy(path)) {
    const paths = lire(a, "paths");
    if (Array.isArray(paths) && paths.length) {
      const first = strPy(veritePy(paths[0]) ? paths[0] : "");
      path = paths.length > 1 ? `${first} (+${paths.length - 1})` : first;
    }
  }
  if (!veritePy(path)) {
    const nom = lire(a, "name");
    path = strPy(veritePy(nom) ? nom : "");
  }
  const repo = lire(a, "repo");
  if (veritePy(repo) && veritePy(path)) return `${strPy(repo)}:${strPy(path)}`;
  if (veritePy(repo)) return strPy(repo);
  return strPy(veritePy(path) ? path : "");
}

/** Budget en tokens par message : la moitié du n_ctx du résumeur répartie, bornée [600, 6000] ; plancher si inconnu. */
export function computeSerializerBudgetTokens(nMessages: number, compressorCtxTokens: number | null): number {
  if (!compressorCtxTokens || compressorCtxTokens <= 0) return SER_BUDGET_FLOOR_TOKENS;
  const perMsg = intPy((compressorCtxTokens * INPUT_CTX_SHARE) / maxPy(1, intPy(nMessages || 1)));
  return maxPy(SER_BUDGET_FLOOR_TOKENS, minPy(SER_BUDGET_CEIL_TOKENS, perMsg));
}

/** Plafond total de l'entrée : moitié de la fenêtre du résumeur, 4096 tokens si elle est inconnue. */
export function computeSerializerTotalBudgetTokens(compressorCtxTokens: number | null): number {
  if (!compressorCtxTokens || compressorCtxTokens <= 0) return SER_TOTAL_DEFAULT_TOKENS;
  return maxPy(1, intPy(compressorCtxTokens * INPUT_CTX_SHARE));
}

/** Plus grand plafond c tel que Σ min(Lᵢ, c) ≤ available, ou `null` si tout tient. */
export function waterFillCap(lengths: readonly number[], available: number): number | null {
  if (lengths.reduce((a, b) => a + b, 0) <= available) return null;
  let remaining = maxPy(0, available);
  const ordered = [...lengths].sort((a, b) => a - b);
  const k = ordered.length;
  for (let i = 0; i < k; i++) {
    const share = remaining / (k - i);
    if (ordered[i]! <= share) remaining -= ordered[i]!;
    else return intPy(share);
  }
  return null;
}

export function computeSerializerBudget(
  nMessages: number,
  compressorCtxTokens: number | null,
  modelId: string | null = null,
): number {
  return tokensToChars(computeSerializerBudgetTokens(nMessages, compressorCtxTokens), modelId);
}

export interface ArtifactEntry {
  readonly op: string;
  readonly path: string;
  readonly sizeChars: number;
  readonly ok: boolean | null;
}

export function renderEntry(e: ArtifactEntry): string {
  const status = e.ok === true ? "ok" : e.ok === false ? "ÉCHEC" : "statut inconnu";
  return `- ${e.op} ${e.path} (${e.sizeChars} chars, ${status})`;
}

/** Appels mutants à chemin extractible des tours à résumer, statut tiré du résultat apparié (inconnu si illisible). */
export function extractArtifactLedger(messages: readonly unknown[]): ArtifactEntry[] {
  const resultById = new Map<unknown, string>();
  for (const m of messages) {
    if (!estDict(m) || m["role"] !== "tool") continue;
    const id = lire(m, "tool_call_id");
    const c = lire(m, "content");
    if (veritePy(id) && typeof c === "string") resultById.set(cleHash(id), c);
  }
  const statut = (tcId: unknown): boolean | null => {
    const raw = resultById.get(cleHash(veritePy(tcId) ? tcId : ""));
    if (!raw || !chargerJson(raw).ok) return null;
    return !resultIsError(raw);
  };
  const entries: ArtifactEntry[] = [];
  for (const m of messages) {
    if (!estDict(m) || m["role"] !== "assistant") continue;
    const tcs = lire(m, "tool_calls");
    for (const tc of Array.isArray(tcs) ? tcs : []) {
      if (!estDict(tc)) continue;
      const fnBrut = lire(tc, "function");
      const fn: Dict = estDict(fnBrut) ? fnBrut : {};
      const nom = lire(fn, "name");
      const name = veritePy(nom) ? nom : "";
      if (!toolTraits(strPy(name)).mutates) continue;
      const args = lire(fn, "arguments");
      const path = extractTargetPath(args);
      if (!path) continue;
      const size =
        typeof args === "string" ? longueurCp(args) : longueurCp(strPy(veritePy(args) ? args : ""));
      entries.push({ op: strPy(name), path, sizeChars: size, ok: statut(lire(tc, "id")) });
    }
  }
  return entries;
}

/** Bloc déterministe `[ARTIFACTS v=1]` : les `cap` lignes les plus récentes (cap 0 = toutes, comme `lines[-0:]`). */
export function renderArtifactLedger(lines: readonly string[], cap = LEDGER_MAX_ENTRIES): string {
  const pleines = lines.filter((l) => stripPy(l));
  if (!pleines.length) return "";
  const kept = cap === 0 ? pleines : pleines.slice(-cap);
  const dropped = pleines.length - kept.length;
  let head = LEDGER_START;
  if (dropped > 0) head += `\n(… ${dropped} entrée(s) plus ancienne(s) omise(s))`;
  return `${head}\n${kept.join("\n")}\n${LEDGER_END}`;
}

const LEDGER_RE = /\[ARTIFACTS v=1\]([\s\S]*?)\[\/ARTIFACTS\]/;

/** Lignes d'entrées du bloc présent dans `text` (porteur précédent) ; `[]` sans bloc. */
export function parseLedgerLines(text: string | null | undefined): string[] {
  if (!text || !text.includes(LEDGER_START)) return [];
  const m = LEDGER_RE.exec(text);
  if (!m) return [];
  return splitlinesPy(m[1]!).filter((l) => stripPy(l).startsWith("- "));
}

const NON_BLANC = BLANC_PY.replace(/^\[/, "[^");
const LEDGER_KEY_RE = new RegExp(`^- (${NON_BLANC}+) ([^\\n]+?) \\(\\p{Nd}+ chars`, "u");

/** `s.split(sep, n)` de Python : au plus n coupes, le reste en dernier morceau. */
function splitN(s: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let reste = s;
  while (out.length < n) {
    const i = reste.indexOf(sep);
    if (i < 0) break;
    out.push(reste.slice(0, i));
    reste = reste.slice(i + sep.length);
  }
  out.push(reste);
  return out;
}

function cleLedger(line: string): string {
  const l = stripPy(line);
  const m = LEDGER_KEY_RE.exec(l);
  if (m) return `${m[1]} ${m[2]}`;
  const parts = splitN(l, " ", 3);
  return parts.length >= 3 ? parts.slice(1, 3).join(" ") : l;
}

/** Cumul dédupliqué par (op, chemin complet) : la plus récente remplace à la même position ; cap sur les plus récentes. */
export function mergeLedgerLines(
  prevLines: readonly string[],
  newLines: readonly string[],
  cap = LEDGER_MAX_ENTRIES,
): string[] {
  const merged: string[] = [];
  const seen = new Map<string, number>();
  for (const line of [...prevLines, ...newLines]) {
    const k = cleLedger(line);
    const pos = seen.get(k);
    if (pos !== undefined) merged[pos] = line;
    else {
      seen.set(k, merged.length);
      merged.push(line);
    }
  }
  return cap === 0 ? merged : merged.slice(-cap);
}

/** Texte d'un message tel que sérialisé : parts texte jointes, images comptées. */
export function contentText(m: Dict): string {
  let content: unknown = veritePy(m["content"]) ? m["content"] : "";
  if (Array.isArray(content)) {
    const txt = content
      .filter((p) => estDict(p) && p["type"] === "text")
      .map((p) => {
        const t = lire(p, "text");
        return t === undefined ? "" : (t as string);
      })
      .join(" ");
    const nImg = content.filter(
      (p) => estDict(p) && (p["type"] === "image_url" || p["type"] === "image"),
    ).length;
    content = stripPy(txt + (nImg ? ` [${nImg} image(s) omise(s)]` : ""));
  }
  return typeof content === "string" ? content : strPy(content);
}

function serializeCapped(messages: readonly Dict[], maxCharsPerMsg: number, argsMaxChars: number): string {
  const idToName = new Map<unknown, unknown>();
  for (const m of messages) {
    if (m["role"] !== "assistant") continue;
    const tcs = lire(m, "tool_calls");
    for (const tc of Array.isArray(tcs) && veritePy(tcs) ? tcs : []) {
      if (!estDict(tc)) continue;
      const id = lire(tc, "id");
      const nom = lire(lire(tc, "function"), "name");
      if (veritePy(id) && veritePy(nom)) idToName.set(cleHash(id), nom);
    }
  }
  const lines: string[] = [];
  for (const m of messages) {
    const role = Object.hasOwn(m, "role") ? m["role"] : "unknown";
    let content = contentText(m);
    const tcsBrut = lire(m, "tool_calls");
    const toolCalls = veritePy(tcsBrut) && Array.isArray(tcsBrut) ? tcsBrut : [];
    const c = Array.from(content);
    if (c.length > maxCharsPerMsg) {
      content = c.slice(0, maxCharsPerMsg).join("") + ` …[tronqué ${c.length - maxCharsPerMsg} chars]`;
    }
    if (role === "user") lines.push(`[USER] ${content}`);
    else if (role === "assistant") {
      if (toolCalls.length) {
        for (const tc of toolCalls as Dict[]) {
          const fnBrut = lire(tc, "function");
          const fn: Dict = estDict(fnBrut) && veritePy(fnBrut) ? fnBrut : {};
          const nom = Object.hasOwn(fn, "name") ? fn["name"] : "?";
          let args: unknown = Object.hasOwn(fn, "arguments") ? fn["arguments"] : "";
          const path = toolTraits(typeof nom === "string" ? nom : null).mutates
            ? extractTargetPath(args)
            : "";
          if (path) {
            const sz = typeof args === "string" ? longueurCp(args) : 0;
            lines.push(
              `[ASSISTANT→TOOL] ${strPy(nom)}(path=${path} — arguments ${sz} chars omitted, see ARTIFACTS v=1)`,
            );
            continue;
          }
          if (typeof args === "string" && longueurCp(args) > argsMaxChars) {
            args = Array.from(args).slice(0, argsMaxChars).join("") + "…";
          }
          lines.push(`[ASSISTANT→TOOL] ${strPy(nom)}(${strPy(args)})`);
        }
        if (content) lines.push(`[ASSISTANT] ${content}`);
      } else lines.push(`[ASSISTANT] ${content}`);
    } else if (role === "tool") {
      const nom = lire(m, "name");
      const parId = idToName.get(cleHash(lire(m, "tool_call_id") ?? null));
      const toolName = veritePy(nom) ? nom : veritePy(parId) ? parId : "tool";
      lines.push(`[TOOL:${strPy(toolName)}] ${content}`);
    }
  }
  return lines.join("\n");
}

/** Historique en texte dense pour le résumeur : plafond par message, contenu des appels mutants remplacé par une référence au registre. */
export function serializeForCompression(
  messages: readonly Dict[],
  options: { maxCharsPerMsg?: number; argsMaxChars?: number; maxTotalChars?: number | null } = {},
): string {
  const maxPerMsg = options.maxCharsPerMsg ?? SER_BUDGET_FLOOR;
  const argsMax = options.argsMaxChars ?? ARGS_MAX_CHARS;
  const maxTotal = options.maxTotalChars ?? null;
  let text = serializeCapped(messages, maxPerMsg, argsMax);
  if (!maxTotal || maxTotal <= 0 || longueurCp(text) <= maxTotal) return text;
  const overhead = longueurCp(serializeCapped(messages, 0, argsMax));
  let cap = waterFillCap(
    messages.filter(estDict).map((m) => longueurCp(contentText(m))),
    maxTotal - overhead,
  );
  if (cap !== null) {
    cap = maxPy(SER_MIN_CHARS_PER_MSG, minPy(maxPerMsg, cap));
    text = serializeCapped(messages, cap, argsMax);
  }
  if (longueurCp(text) > maxTotal) text = truncateHeadTail(text, maxTotal, "compression input over budget");
  return text;
}
