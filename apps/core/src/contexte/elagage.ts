// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/elagage.ts — réduction du contexte : marques d'élagage, vision, émission, hygiène, budget dur. */
import { createHash } from "node:crypto";

import {
  clesOrdonnees,
  estEntierPy,
  FlottantPy,
  intPy,
  longueurPy,
  maxPy,
  minPy,
  nonVidePy,
  poserCle,
  prefixePy,
  splitPy,
  pyJsonDumps,
  pyJsonLoads,
  stripPy,
  strPy,
  suffixePy,
  utf8Remplace,
  veritePy,
} from "@elpis/commun";
import { config } from "@elpis/config";
import { contenuElide } from "@elpis/outils-mcp";
import { neutraliserMarqueursTour } from "@elpis/securite";

import { journal } from "../journal";
import { toolPolicy } from "../outils/categories";
import { estDict, lire, splitlinesPy } from "../python";
import type { Dict } from "../python";
import { BUDGET } from "./budget";
import {
  countMessagesTokensPerMsg,
  measuredPromptTokens,
  tokensToChars,
  tokensToCharsStable,
} from "./tokens";

const log = journal("uvicorn.error");

/** Points de code (`len`, tranches et recherches Python). */
function cp(s: string): string[] {
  return Array.from(s);
}

/** `len(s)` sans parcourir le texte quand il n'a aucune demi-paire (cas courant). */
export function longueurCp(s: string): number {
  return /[\uD800-\uDFFF]/.test(s) ? longueurPy(s) : s.length;
}

/** Clé d'ensemble ou de dict à l'égalité Python (`True == 1 == 1.0`). */
export function cleHash(v: unknown): unknown {
  if (typeof v === "boolean") return Number(v);
  return v instanceof FlottantPy ? v.valeur : v;
}

/** `json.loads` sans lever : `{ok: false}` sur toute erreur de lecture. */
export function chargerJson(texte: string): { ok: true; valeur: unknown } | { ok: false } {
  try {
    return { ok: true, valeur: pyJsonLoads(texte) };
  } catch {
    return { ok: false };
  }
}

function rfindNl(c: readonly string[]): number {
  return c.lastIndexOf("\n");
}

/** `content` coupé à ≤ `limit` chars en gardant tête (≈70 %) et queue, coupes sur un saut de ligne proche. */
export function truncateHeadTail(content: string, limit: number, reason = "tool history compaction"): string {
  const c = cp(content);
  const markerReserve = cp(`\n…[${c.length} chars omitted — ${reason}]…\n`).length;
  const eff = maxPy(2, limit - markerReserve);
  const headBudget = maxPy(1, intPy(eff * BUDGET.headSplit));
  const tailBudget = maxPy(1, eff - headBudget);
  let head = c.slice(0, headBudget);
  let tail = c.slice(Math.max(0, c.length - tailBudget));
  let nl = rfindNl(head);
  if (nl > headBudget * 0.5) head = head.slice(0, nl);
  nl = tail.indexOf("\n");
  if (nl >= 0 && nl < tailBudget * 0.5) tail = tail.slice(nl + 1);
  const omitted = c.length - head.length - tail.length;
  return `${head.join("")}\n…[${omitted} chars omitted — ${reason}]…\n${tail.join("")}`;
}

/** Marqueur fixe du Python : encore reconnu (historiques, vecteurs), plus émis. */
export const PRUNE_CLEARED_MARKER = "[Old tool output cleared — use session_search to retrieve it]";
const MARQUEUR_TETE = "[Old tool output cleared";
const MARQUEUR_QUEUE = "use session_search to retrieve it]";
const PRUNE_PROTECTED_TOOL_PREFIXES = ["skill"];
const ARG_PRINCIPAL = [
  "path",
  "file_path",
  "filepath",
  "file",
  "url",
  "command",
  "cmd",
  "query",
  "pattern",
  "name",
];
const FAITS_NUMERIQUES: readonly [string, string][] = [
  ["returncode", "exit="],
  ["exit_code", "exit="],
  ["matches", " matches"],
  ["count", "count="],
  ["total", "total="],
  ["total_lines", "lines="],
];
const FAITS_LISTES = ["matches", "results", "hits", "entries", "files", "items"];
/** Seuil (caractères) au-delà duquel les arguments d'un appel d'écriture ancien sont condensés. */
export const ARGS_ELISION_MIN_CHARS = 2_000;
const ARGS_CLE_PREFIXE = "@args|";
const ARGS_GARDES = new Set([
  "path",
  "file_path",
  "action",
  "mode",
  "encoding",
  "position",
  "flags",
  "format",
]);
const ARGS_CHAMP_MIN = 80;

/** Vrai pour un marqueur d'élagage, fixe ou condensé. */
export function estMarqueurElague(c: unknown): boolean {
  return (
    typeof c === "string" && c.startsWith(MARQUEUR_TETE) && c.endsWith(MARQUEUR_QUEUE) && !c.includes("\n")
  );
}

/** Clé d'élagage d'arguments (préfixe `@args|`), à part des sorties dans le décompte affiché. */
export function estCleArguments(k: unknown): boolean {
  return typeof k === "string" && k.startsWith(ARGS_CLE_PREFIXE);
}

function enLigne(v: string, n: number): string {
  const s = splitPy(v).join(" ");
  return longueurCp(s) > n ? `${prefixePy(s, n)}…` : s;
}

function argumentsDict(appel: unknown): Dict | null {
  const brut = lire(lire(appel, "function"), "arguments");
  if (estDict(brut)) return brut;
  if (typeof brut !== "string" || !brut.trimStart().startsWith("{")) return null;
  const lu = chargerJson(brut);
  return lu.ok && estDict(lu.valeur) ? lu.valeur : null;
}

function nombre(v: unknown): string | null {
  if (typeof v === "boolean") return null;
  if (estEntierPy(v)) return strPy(v);
  return typeof v === "number" && Number.isFinite(v) ? strPy(v) : null;
}

/** Statut et faits triviaux d'une sortie : JSON (`ok`, `error`, code retour, nombre de résultats) ou texte brut. */
function statutEtFaits(content: string): [string, string[]] {
  const corps = sansJalonHarnais(content);
  const debut = corps.trimStart();
  const lu = debut.startsWith("{") ? chargerJson(corps) : ({ ok: false } as const);
  if (!lu.ok || !estDict(lu.valeur))
    return [/^(error|erreur|traceback|exception)\b/i.test(debut) ? "error" : "ok", []];
  const d = lu.valeur;
  const err = lire(d, "error");
  const echec =
    d["ok"] === false ||
    d["is_error"] === true ||
    d["isError"] === true ||
    (d["ok"] !== true && veritePy(err));
  const faits: string[] = [];
  if (echec && typeof err === "string" && stripPy(err)) faits.push(`error=${enLigne(err, 60)}`);
  const rendus = new Set<string>();
  for (const [cle, rendu] of FAITS_NUMERIQUES) {
    const n = nombre(lire(d, cle));
    if (n === null || rendus.has(rendu)) continue;
    rendus.add(rendu);
    faits.push(rendu.startsWith(" ") ? n + rendu : rendu + n);
  }
  for (const cle of FAITS_LISTES) {
    const v = lire(d, cle);
    if (Array.isArray(v)) faits.push(`${v.length} ${cle}`);
  }
  return [echec ? "error" : "ok", faits.slice(0, 2)];
}

const condenses = new WeakMap<object, string>();

/** Marqueur d'une ligne (anglais) : outil, ok/error, argument principal, taille, 1-2 faits ; stable pour une même sortie. */
export function condensePrunedOutput(content: string, appel: unknown): string {
  const nom = lire(lire(appel, "function"), "name");
  const [statut, faits] = statutEtFaits(content);
  const parts = [`${typeof nom === "string" && stripPy(nom) ? enLigne(nom, 60) : "tool"} ${statut}`];
  const args = argumentsDict(appel);
  const cle = args
    ? ARG_PRINCIPAL.find((k) => typeof args[k] === "string" && stripPy(args[k] as string))
    : undefined;
  if (args && cle) parts.push(`${cle}=${enLigne(args[cle] as string, 80)}`);
  parts.push(`${longueurCp(content)} chars`, ...faits);
  return `${MARQUEUR_TETE}: ${parts.join(", ")} — ${MARQUEUR_QUEUE}`;
}

/** Condensé d'un `role:tool` d'après l'appel qui le précède (mémo par message). */
function marqueurDe(m: Dict, appel: unknown): string {
  const deja = condenses.get(m);
  if (deja !== undefined) return deja;
  const marqueur = condensePrunedOutput(m["content"] as string, appel);
  condenses.set(m, marqueur);
  return marqueur;
}

/** Clé d'élagage des arguments d'un appel : id | longueur | 48 premiers | 48 derniers ; `null` sous le seuil ou sans id. */
export function argsPruneKey(tc: unknown): string | null {
  const id = lire(tc, "id");
  const args = lire(lire(tc, "function"), "arguments");
  if (!veritePy(id) || typeof args !== "string" || args.length <= ARGS_ELISION_MIN_CHARS) return null;
  const n = longueurCp(args);
  if (n <= ARGS_ELISION_MIN_CHARS) return null;
  return `${ARGS_CLE_PREFIXE}${strPy(id)}|${n}|${prefixePy(args, 48)}|${suffixePy(args, 48)}`;
}

function eliderChamps(d: Dict): void {
  for (const k of clesOrdonnees(d)) {
    const v = d[k];
    if (typeof v === "string" && !ARGS_GARDES.has(k) && longueurCp(v) > ARGS_CHAMP_MIN)
      d[k] = contenuElide(v);
    else if (Array.isArray(v)) for (const e of v) if (estDict(e)) eliderChamps(e);
  }
}

const argsCondenses = new WeakMap<object, string>();

/** Arguments condensés (JSON valide, mêmes clés) : chaque long champ de contenu devient taille + sha256 court. */
export function condenseWriteArguments(args: string): string {
  const lu = chargerJson(args);
  if (!lu.ok || !estDict(lu.valeur))
    return pyJsonDumps({ content: contenuElide(args) }, { ensureAscii: false });
  eliderChamps(lu.valeur);
  return pyJsonDumps(lu.valeur, { ensureAscii: false });
}

/** tool_calls dont les arguments marqués sont condensés ; le tableau d'origine si rien ne change. */
function eliderAppels(tcs: unknown[], ks: ReadonlySet<string>): unknown[] {
  let change = false;
  const out = tcs.map((tc) => {
    const k = argsPruneKey(tc);
    if (k === null || !ks.has(k)) return tc;
    const fn = (tc as Dict)["function"] as Dict;
    let condense = argsCondenses.get(fn);
    if (condense === undefined) {
      condense = condenseWriteArguments(fn["arguments"] as string);
      argsCondenses.set(fn, condense);
    }
    change = true;
    return { ...(tc as Dict), function: { ...fn, arguments: condense } };
  });
  return change ? out : tcs;
}

/** Politique `prune` d'un outil (registre), vide si illisible. */
function politiqueElagage(toolName: string): string {
  try {
    const p = lire(toolPolicy(toolName), "prune");
    return strPy(veritePy(p) ? p : "");
  } catch {
    return "";
  }
}

function estOutilEcriture(nom: unknown): boolean {
  if (typeof nom !== "string" || !nom) return false;
  const prune = politiqueElagage(nom);
  return prune === "diff" || (!prune && (nom === "edit_file" || nom === "write_file"));
}

/** Identité stable d'un tool_result : id | longueur | 48 premiers | 48 derniers points de code. */
export function pruneKey(m: Dict): string | null {
  const brut = m["content"];
  if (typeof brut !== "string" || !brut) return null;
  const c = sansJalonHarnais(brut);
  if (!c) return null;
  const id = lire(m, "tool_call_id");
  const demi = /[\uD800-\uDFFF]/.test(c);
  const bords = demi ? `${prefixePy(c, 48)}|${suffixePy(c, 48)}` : `${c.slice(0, 48)}|${c.slice(-48)}`;
  return `${veritePy(id) ? strPy(id) : ""}|${demi ? longueurPy(c) : c.length}|${bords}`;
}

/** Contenu d'une question augmenté d'un suffixe réservé au modèle ; mêmes octets à l'injection et au rejeu. */
export function mergeUserSuffix(content: unknown, suffix: string): unknown {
  if (Array.isArray(content)) return [...content, { type: "text", text: suffix }];
  const txt =
    typeof content === "string" ? content : content === null || content === undefined ? "" : strPy(content);
  return stripPy(txt) ? `${txt}\n\n${suffix}` : suffix;
}

/** Rang de la question + empreinte sha1 (16 hex) de son contenu. */
export function userSuffixSig(index: number, content: unknown): string {
  let raw: string;
  if (typeof content === "string") raw = content;
  else {
    try {
      raw = pyJsonDumps(content, { ensureAscii: false, sortKeys: true });
    } catch {
      raw = strPy(content);
    }
  }
  return `${intPy(index)}:${createHash("sha1").update(utf8Remplace(raw)).digest("hex").slice(0, 16)}`;
}

/** Message de contrôle injecté mi-tour (`_ephemeral`), jamais persisté ni compté comme un tour. */
export function isEphemeral(m: unknown): boolean {
  return estDict(m) && veritePy(lire(m, "_ephemeral"));
}

export function ephemeral(role: string, content: string): Dict {
  return { role, content, _ephemeral: true };
}

/** Résultat d'outil sans la ligne `<harness_status>` que la boucle peut lui avoir ajoutée en queue (réflexion rendue au moteur) : sa clé d'élagage et son statut restent ceux du résultat. */
export function sansJalonHarnais(content: string): string {
  if (!content.endsWith("</harness_status>")) return content;
  const debut = content.lastIndexOf("<harness_status>");
  if (debut === 0) return "";
  return debut > 1 && content.slice(debut - 2, debut) === "\n\n" ? content.slice(0, debut - 2) : content;
}

function aCleInterne(m: Dict): boolean {
  return Object.keys(m).some((k) => k.startsWith("_"));
}

function clesInternes(m: Dict): Dict {
  return Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith("_")));
}

/** Copie sans les clés du harnais (`_…`) ; les messages sans telle clé passent par référence. */
export function stripInternalKeys(messages: readonly unknown[] | null | undefined): unknown[] {
  return (messages ?? []).map((m) =>
    estDict(m) && aCleInterne(m)
      ? Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("_")))
      : m,
  );
}

function versEnsemble(keys: Iterable<string> | null | undefined): ReadonlySet<string> {
  return keys instanceof Set ? keys : new Set(keys ?? []);
}

/** Appel (tool_call) de chaque id, mis à jour au fil des messages : un `role:tool` voit l'appel qui le précède. */
export class AppelsParId {
  private readonly appels = new Map<unknown, unknown>();

  noter(m: unknown): void {
    const tcs = lire(m, "tool_calls");
    if (lire(m, "role") !== "assistant" || !Array.isArray(tcs)) return;
    for (const tc of tcs) if (estDict(tc) && veritePy(tc["id"])) this.appels.set(cleHash(tc["id"]), tc);
  }

  marqueur(m: Dict): string {
    const id = lire(m, "tool_call_id");
    return marqueurDe(m, veritePy(id) ? this.appels.get(cleHash(id)) : undefined);
  }
}

/** Vue modèle (copie, stockage intact) : sorties marquées → condensé d'une ligne, arguments d'écriture marqués → condensé. */
export function applyPruneMarks(messages: unknown[], keys: Iterable<string> | null | undefined): unknown[] {
  const ks = versEnsemble(keys);
  if (!ks.size) return messages;
  const appels = new AppelsParId();
  return messages.map((m) => {
    if (!estDict(m)) return m;
    appels.noter(m);
    if (
      m["role"] === "tool" &&
      typeof m["content"] === "string" &&
      !estMarqueurElague(m["content"]) &&
      ks.has(pruneKey(m) ?? "\0")
    ) {
      return { ...m, content: appels.marqueur(m) };
    }
    const tcs = m["role"] === "assistant" ? m["tool_calls"] : undefined;
    if (Array.isArray(tcs) && tcs.length) {
      const elides = eliderAppels(tcs, ks);
      if (elides !== tcs) return { ...m, tool_calls: elides };
    }
    return m;
  });
}

function reglageEntier(v: unknown): number {
  return intPy(veritePy(v) ? v : 0);
}

/** Sorties à effacer (Python) : toutes celles au-delà des `protect` jetons récents si le gain atteint `minGain` ; un lot d'appels parallèles n'est jamais coupé. */
function choisirSorties(
  candidates: readonly number[],
  toks: readonly number[],
  lots: readonly number[],
  protect: number,
  minGain: number,
): number[] {
  let acc = 0;
  let gain = 0;
  let lotProtege: number | null = null;
  const pris: number[] = [];
  candidates.forEach((i, k) => {
    acc += toks[k]!;
    if (acc <= protect || lots[k] === lotProtege) {
      lotProtege = lots[k]!;
      return;
    }
    pris.push(i);
    gain += toks[k]!;
  });
  return pris.length && gain >= minGain ? pris : [];
}

/** Sélection des sorties d'outils et des arguments d'écriture à marquer (unités tokens, 2 derniers tours et sorties protégées exclus). */
export async function selectPruneKeys(
  workingMessages: readonly unknown[],
  options: {
    ctxSize: number | null | undefined;
    modelId?: string | null;
    alreadyMarked?: Iterable<string> | null;
    signal?: AbortSignal | undefined;
  },
): Promise<string[]> {
  const ctxSize = options.ctxSize;
  if (!ctxSize || ctxSize <= 0 || !workingMessages.length) return [];
  const marked = versEnsemble(options.alreadyMarked);
  let protect: number;
  let minGain: number;
  try {
    if (!veritePy(config.PRUNE_ENABLED ?? true)) return [];
    protect = reglageEntier(config.PRUNE_PROTECT_TOKENS);
    minGain = reglageEntier(config.PRUNE_MIN_TOKENS);
  } catch {
    protect = 0;
    minGain = 0;
  }
  if (protect <= 0) protect = intPy(ctxSize * 0.2);
  if (minGain <= 0) minGain = minPy(20_000, intPy(ctxSize * 0.1));

  const turnIdx: number[] = [];
  let turns = 0;
  let prevWasTool = false;
  const toolNameById = new Map<unknown, unknown>();
  const lotIdx: number[] = [];
  let appelCourant = -1;
  let lastSummaryI = -1;
  workingMessages.forEach((m, i) => {
    const role = estDict(m) ? m["role"] : null;
    if (role === "user") {
      if (!isEphemeral(m)) turns++;
      prevWasTool = false;
    } else if (role === "assistant") {
      const tcs = lire(m, "tool_calls");
      if (veritePy(tcs)) {
        turns++;
        for (const tc of Array.isArray(tcs) ? tcs : []) {
          if (!estDict(tc)) continue;
          const fn = lire(tc, "function");
          const nom = lire(fn, "name");
          if (veritePy(tc["id"]) && veritePy(nom)) toolNameById.set(cleHash(tc["id"]), nom);
        }
      } else if (!prevWasTool) turns++;
      prevWasTool = false;
    } else if (role === "tool") {
      prevWasTool = true;
    } else if (role === "system") {
      const c = lire(m, "content");
      if (typeof c === "string" && c.includes("[COMPRESSED_SUMMARY_V1]")) lastSummaryI = i;
    }
    if (role === "user" || role === "assistant")
      appelCourant = role === "assistant" && veritePy(lire(m, "tool_calls")) ? i : -1;
    turnIdx.push(turns);
    lotIdx.push(role === "tool" && appelCourant >= 0 ? appelCourant : -1 - i);
  });
  const totalTurns = turns;

  const toolIndices: number[] = [];
  workingMessages.forEach((m, i) => {
    if (estDict(m) && m["role"] === "tool" && typeof m["content"] === "string") toolIndices.push(i);
  });
  const contenu = (i: number): string => (workingMessages[i] as Dict)["content"] as string;
  const dejaMarquee = (i: number): boolean =>
    estMarqueurElague(contenu(i)) ||
    (marked.size > 0 && marked.has(pruneKey(workingMessages[i] as Dict) ?? "\0"));
  let protectedDesktop = -1;
  for (const i of [...toolIndices].reverse()) {
    if (contenu(i).includes('"elements"') && !dejaMarquee(i)) {
      protectedDesktop = i;
      break;
    }
  }

  const candidates: number[] = [];
  const lots: number[] = [];
  for (const i of [...toolIndices].reverse()) {
    if (i <= lastSummaryI) break;
    if (dejaMarquee(i)) continue;
    const m = workingMessages[i] as Dict;
    if (turnIdx[i]! > totalTurns - 2) continue;
    if (i === protectedDesktop) continue;
    const id = cleHash(veritePy(lire(m, "tool_call_id")) ? lire(m, "tool_call_id") : "");
    const nom = toolNameById.get(id) ?? "";
    if (typeof nom === "string" && PRUNE_PROTECTED_TOOL_PREFIXES.some((p) => nom.startsWith(p))) continue;
    candidates.push(i);
    lots.push(lotIdx[i]!);
  }
  const appels = appelsAEliderDe(workingMessages, turnIdx, totalTurns - 2, lastSummaryI, marked);
  if (!candidates.length && !appels.length) return [];

  const perTok = await countMessagesTokensPerMsg(
    [
      ...candidates.map((i) => workingMessages[i] as Dict),
      ...appels.map(([, args]) => ({ role: "assistant", content: args })),
    ],
    options.modelId ?? null,
    { signal: options.signal },
  );
  options.signal?.throwIfAborted();
  const toMark = choisirSorties(candidates, perTok.slice(0, candidates.length), lots, protect, minGain);
  const gainArgs = perTok.slice(candidates.length).reduce((a, b) => a + b, 0);
  if (!toMark.length && (!appels.length || gainArgs < minGain)) return [];
  const marquees = new Set(toMark);
  const aGarder = new Set<string>();
  for (const i of toolIndices) {
    if (marquees.has(i)) continue;
    const m = workingMessages[i] as Dict;
    if (estMarqueurElague(m["content"])) continue;
    const k = pruneKey(m);
    if (k !== null && !(marked.size && marked.has(k))) aGarder.add(k);
  }
  const keys: string[] = [];
  for (const i of toMark) {
    const k = pruneKey(workingMessages[i] as Dict);
    if (k !== null && !aGarder.has(k)) keys.push(k);
  }
  for (const [k] of appels) if (!keys.includes(k)) keys.push(k);
  return keys;
}

/** Appels d'écriture aux arguments volumineux non encore marqués, après le dernier résumé et hors des tours protégés : `[clé, arguments]`. */
function appelsAEliderDe(
  messages: readonly unknown[],
  turnIdx: readonly number[],
  dernierTour: number,
  frontiere: number,
  marked: ReadonlySet<string>,
): [string, string][] {
  const out: [string, string][] = [];
  for (let i = messages.length - 1; i > frontiere; i--) {
    const m = messages[i];
    const tcs = lire(m, "tool_calls");
    if (lire(m, "role") !== "assistant" || !Array.isArray(tcs) || turnIdx[i]! > dernierTour) continue;
    if (veritePy(lire(m, "_pinned"))) continue;
    tcs.forEach((tc) => {
      const k = argsPruneKey(tc);
      if (k !== null && !marked.has(k) && estOutilEcriture(lire(lire(tc, "function"), "name")))
        out.push([k, lire(lire(tc, "function"), "arguments") as string]);
    });
  }
  return out;
}

const DESKTOP_EL_KEEP = ["id", "label", "role", "center", "auto_id", "value", "do"];
const DESKTOP_FRAME_DROP = new Set(["frame_token", "img_w", "img_h", "sig", "vision_used", "tree_used"]);

/** Perception desktop réduite à l'essentiel par élément ; original si non parsable ou sans `elements`. */
export function compactDesktopElements(contentStr: unknown): unknown {
  if (typeof contentStr !== "string" || !contentStr.includes('"elements"')) return contentStr;
  const lu = chargerJson(contentStr);
  if (!lu.ok || !estDict(lu.valeur) || !Array.isArray(lu.valeur["elements"])) return contentStr;
  const data = lu.valeur;
  const slim: Dict[] = [];
  for (const e of data["elements"] as unknown[]) {
    if (!estDict(e)) continue;
    const se: Dict = {};
    for (const k of DESKTOP_EL_KEEP) if (Object.hasOwn(e, k) && nonVidePy(e[k])) se[k] = e[k];
    const v = se["value"];
    if (typeof v === "string" && longueurCp(v) > 300) se["value"] = prefixePy(v, 300) + "…";
    const st = lire(e, "states");
    if (Array.isArray(st) && st.length) se["states"] = st.map(strPy).slice(0, 6);
    slim.push(se);
  }
  const out: Dict = {};
  for (const k of clesOrdonnees(data)) if (!DESKTOP_FRAME_DROP.has(k)) poserCle(out, k, data[k]);
  out["elements"] = slim;
  return pyJsonDumps(out, { ensureAscii: false });
}

const VISION_FRAME_PLACEHOLDER =
  "[previous screenshot elided to save context — call desktop_observe to see the current screen]";

function porteImage(m: unknown): boolean {
  const c = lire(m, "content");
  return Array.isArray(c) && c.some((b) => estDict(b) && b["type"] === "image_url");
}

/** Copie où seules les `keep` dernières images restent ; les plus anciennes deviennent un court texte. */
export function pruneOldVisionFrames(messages: unknown[], keep = 2): unknown[] {
  const imgIdx = messages.flatMap((m, i) => (porteImage(m) ? [i] : []));
  if (imgIdx.length <= maxPy(0, keep)) return messages;
  const toStrip = new Set(keep <= 0 ? imgIdx : imgIdx.slice(0, -keep));
  return messages.map((m, i) => {
    if (!toStrip.has(i)) return m;
    const d = m as Dict;
    const kept: unknown[] = [];
    let stripped = false;
    for (const b of d["content"] as unknown[]) {
      if (estDict(b) && b["type"] === "image_url") {
        stripped = true;
        continue;
      }
      kept.push(b);
    }
    if (stripped) kept.push({ type: "text", text: VISION_FRAME_PLACEHOLDER });
    return { ...d, content: kept };
  });
}

/** Cap d'émission d'un résultat d'outil en tokens : clamp(plancher, ratio × n_ctx, plafond). */
export function emitCapTokens(ctxTokens: number | null | undefined): number {
  if (ctxTokens && ctxTokens > 0) {
    return minPy(
      BUDGET.emitCapMaxTokens,
      maxPy(BUDGET.emitCapMinTokens, intPy(ctxTokens * BUDGET.emitCapRatio)),
    );
  }
  return BUDGET.emitCapMinTokens;
}

/** Cap d'émission en chars (ratio mesuré), borné sous le filet de l'hygiène. */
export function emitCapChars(ctxTokens: number | null | undefined, modelId: string | null = null): number {
  const cap = tokensToChars(emitCapTokens(ctxTokens), modelId);
  const filet = tokensToCharsStable(BUDGET.sanitizeToolMaxTokens);
  return maxPy(200, minPy(cap, filet - 5_000));
}

/** Diff unifié retiré du résultat vu par le modèle (stats et sha gardés) ; inchangé si non JSON ou sans `diff`. */
function stripModelDiff(content: string): string {
  const lu = chargerJson(content);
  if (!lu.ok || !estDict(lu.valeur) || !Object.hasOwn(lu.valeur, "diff")) return content;
  const d = lu.valeur;
  const diff = d["diff"];
  delete d["diff"];
  const added = lire(d, "lines_added");
  const removed = lire(d, "lines_removed");
  if ((added !== null && added !== undefined) || (removed !== null && removed !== undefined)) {
    poserCle(
      d,
      "diff_stat",
      `+${strPy(veritePy(added) ? added : 0)}/-${strPy(veritePy(removed) ? removed : 0)} lines`,
    );
  } else {
    poserCle(d, "diff_stat", `${splitlinesPy(strPy(diff)).length} diff lines`);
  }
  poserCle(d, "diff_note", "full diff shown to the user; re-read the file if you need the exact content");
  return pyJsonDumps(d, { ensureAscii: false });
}

/** Lien ou fichier spécial relevé (harnais B-10) : `symlink -> cible`, et ce qu'il était (`was …`). */
function bitsAutre(e: Dict): string[] {
  const type = lire(e, "type");
  if (typeof type !== "string" || !type || type === "file" || type === "dir") return [];
  const cible = (t: unknown): string => (typeof t === "string" ? ` -> ${t}` : "");
  const bits = [`${type}${cible(e["target"])}`];
  const avant = lire(e, "old_type");
  if (typeof avant === "string" || typeof lire(e, "old_target") === "string")
    bits.push(`was ${typeof avant === "string" ? avant : type}${cible(e["old_target"])}`);
  return bits;
}

/** `files_changed` vu par le modèle : une ligne courte par fichier. */
function compactFilesChanged(content: string): string {
  if (!content.includes('"files_changed"')) return content;
  const lu = chargerJson(content);
  if (!lu.ok) return content;
  const d = lu.valeur;
  const fc = estDict(d) ? d["files_changed"] : undefined;
  if (!estDict(d) || !Array.isArray(fc)) return content;
  const out: string[] = [];
  for (const e of fc) {
    if (!estDict(e) || !veritePy(lire(e, "path"))) continue;
    const change = lire(e, "change");
    const bits = [strPy(veritePy(change) ? change : "modified"), ...bitsAutre(e)];
    if (veritePy(lire(e, "from"))) bits.push(`from ${strPy(e["from"])}`);
    if (estEntierPy(lire(e, "lines_added"))) {
      const rem = lire(e, "lines_removed");
      bits.push(`+${strPy(e["lines_added"])}/-${strPy(veritePy(rem) ? rem : 0)}`);
    }
    out.push(`${strPy(e["path"])} (${bits.join(", ")})`);
  }
  d["files_changed"] = out;
  return pyJsonDumps(d, { ensureAscii: false });
}

/** Vue modèle d'un résultat d'outil à l'émission : desktop compacté, diff retiré, marqueurs de tour des gabarits rendus inertes (page, fichier, sortie ou rapport tiers), cap dérivé du n_ctx. */
export function prepareToolResultForModel(
  toolName: string,
  content: unknown,
  ctxTokens: number | null = null,
  modelId: string | null = null,
): unknown {
  if (typeof content !== "string") return content;
  let texte = compactFilesChanged(content);
  let cap = emitCapChars(ctxTokens, modelId);
  const prune = politiqueElagage(toolName);
  if (prune === "desktop" || (!prune && (toolName || "").startsWith("desktop_"))) {
    texte = compactDesktopElements(texte) as string;
    const dkTokens = intPy(
      veritePy(config.DESKTOP_TOOL_RESULT_MAX_TOKENS) ? config.DESKTOP_TOOL_RESULT_MAX_TOKENS : 0,
    );
    const dkFloor = dkTokens > 0 ? tokensToCharsStable(dkTokens) : config.DESKTOP_TOOL_RESULT_MAX_CHARS;
    cap = maxPy(cap, dkFloor);
  } else if (prune === "diff" || (!prune && (toolName === "edit_file" || toolName === "write_file"))) {
    texte = stripModelDiff(texte);
  }
  texte = neutraliserMarqueursTour(texte);
  const longueur = texte.length > cap ? longueurCp(texte) : texte.length;
  if (longueur > cap) {
    if (prune === "head_tail" || toolName === "task" || (!prune && toolName === "execute_shell")) {
      texte = truncateHeadTail(texte, cap, "result truncated at emission, tail preserved");
    } else {
      texte = prefixePy(texte, cap) + `\n…[result truncated, ${longueur - cap} chars omitted]`;
    }
  }
  return texte;
}

function argumentsValides(args: string): boolean {
  return chargerJson(args).ok;
}

/** Hygiène structurelle : tool_calls réparés, résultats orphelins ou en double retirés, appels sans réponse retirés, ancre `user`. */
export function sanitizeMessageHistory(messages: unknown[]): unknown[] {
  if (!messages.length) return messages;
  let out: unknown[] = [];
  const openIds = new Set<unknown>();
  const seenIds = new Set<unknown>();
  const anonOpen: string[] = [];
  const maxToolContent = tokensToCharsStable(BUDGET.sanitizeToolMaxTokens);
  for (const m of messages) {
    if (!estDict(m)) continue;
    const role = m["role"];
    if (role === "assistant" && veritePy(lire(m, "tool_calls"))) {
      const tcs: Dict[] = [];
      const brut = m["tool_calls"];
      for (const tc of Array.isArray(brut) ? brut : []) {
        if (!estDict(tc)) continue;
        const fnBrut = lire(tc, "function");
        const fn: Dict = estDict(fnBrut) ? { ...fnBrut } : {};
        if (!veritePy(lire(fn, "name"))) continue;
        const args = lire(fn, "arguments");
        if (estDict(args)) fn["arguments"] = pyJsonDumps(args, { ensureAscii: false });
        else if (typeof args === "string") {
          if (!argumentsValides(args)) fn["arguments"] = "{}";
        } else fn["arguments"] = "{}";
        let tcId = lire(tc, "id");
        if (!veritePy(tcId)) {
          tcId = `hist_${out.length}_${tcs.length}`;
          anonOpen.push(tcId as string);
        }
        const type = lire(tc, "type");
        tcs.push({
          id: tcId,
          type: veritePy(type) ? type : "function",
          function: { name: fn["name"], arguments: fn["arguments"] },
        });
        openIds.add(cleHash(tcId));
        seenIds.add(cleHash(tcId));
      }
      const nm: Dict = clesInternes(m);
      if (veritePy(lire(m, "reasoning_content"))) nm["reasoning_content"] = m["reasoning_content"];
      Object.assign(nm, { role: "assistant", content: lire(m, "content") ?? null });
      if (tcs.length) nm["tool_calls"] = tcs;
      else if (!veritePy(nm["content"])) nm["content"] = "";
      out.push(nm);
    } else if (role === "tool") {
      let tcid = lire(m, "tool_call_id");
      if (veritePy(tcid) && seenIds.has(cleHash(tcid)) && !openIds.has(cleHash(tcid))) continue;
      if (!veritePy(tcid) || !openIds.has(cleHash(tcid))) {
        while (anonOpen.length && !openIds.has(anonOpen[0])) anonOpen.shift();
        if (!anonOpen.length) continue;
        tcid = anonOpen.shift();
      }
      let content = lire(m, "content") ?? null;
      if (
        typeof content === "string" &&
        content.length > maxToolContent &&
        longueurCp(content) > maxToolContent
      ) {
        content = truncateHeadTail(content, maxToolContent, "oversized tool result");
      }
      const nt: Dict = clesInternes(m);
      if (veritePy(lire(m, "name"))) nt["name"] = m["name"];
      Object.assign(nt, { role: "tool", tool_call_id: tcid, content });
      out.push(nt);
      openIds.delete(cleHash(tcid));
    } else out.push(m);
  }
  if (openIds.size) out = dropUnansweredCalls(out, openIds);
  return ensureUserAnchor(out);
}

/** Retire des assistants les tool_calls restés sans résultat (OpenAI et Anthropic répondent 400 sinon). */
function dropUnansweredCalls(out: unknown[], unanswered: ReadonlySet<unknown>): unknown[] {
  return out.map((m) => {
    if (!estDict(m) || m["role"] !== "assistant" || !veritePy(lire(m, "tool_calls"))) return m;
    const tcs = m["tool_calls"] as Dict[];
    const kept = tcs.filter((tc) => !unanswered.has(cleHash(lire(tc, "id"))));
    if (kept.length === tcs.length) return m;
    const nm: Dict = Object.fromEntries(Object.entries(m).filter(([k]) => k !== "tool_calls"));
    if (kept.length) nm["tool_calls"] = kept;
    else if (!veritePy(lire(nm, "content"))) nm["content"] = "";
    return nm;
  });
}

export const ORPHAN_ANCHOR_TEXT =
  "[SYSTEM] Mission in progress — the original request was summarized into the context above. Continue from there.";
export const LEADING_ANCHOR_TEXT =
  "[SYSTEM] Earlier turns of this conversation were summarized or trimmed to fit the context window. Continue from there.";

/** Filet : la conversation (après les `system`) s'ouvre sur un `user` ; sinon un `user` éphémère est posé. */
export function ensureUserAnchor(messages: unknown[]): unknown[] {
  let insertAt = 0;
  for (const m of messages) {
    if (estDict(m) && m["role"] === "system") insertAt++;
    else break;
  }
  if (messages.some((m) => estDict(m) && m["role"] === "user")) {
    const first = insertAt < messages.length ? messages[insertAt] : null;
    if (!(estDict(first) && (first["role"] === "assistant" || first["role"] === "tool"))) return messages;
    log.info(
      `[sanitize] la conversation commence par un ${strPy(first["role"])} après les system — ancre user posée en ` +
        `position ${insertAt} (gabarits à alternance stricte)`,
    );
    const out = [...messages];
    out.splice(insertAt, 0, { role: "user", content: LEADING_ANCHOR_TEXT, _ephemeral: true });
    return out;
  }
  if (!messages.some((m) => estDict(m) && (m["role"] === "assistant" || m["role"] === "tool")))
    return messages;
  log.warn(
    `[sanitize] historique sans aucun message user (${messages.length} messages) — ancre de tâche posée en ` +
      `position ${insertAt} ; sans elle le rendu du gabarit échoue en 500.`,
  );
  const out = [...messages];
  out.splice(insertAt, 0, {
    role: "user",
    content: ORPHAN_ANCHOR_TEXT,
    _ephemeral: true,
    _task_anchor: true,
  });
  return out;
}

const ANCHOR_MAX_RATIO = 0.15;
const KEEP_RECENT_MIN = 6;

/** Queue protégée : un tiers de la conversation, entre 6 et `keepRecentMsgs`. */
export function effectiveKeepRecent(nMsgs: number): number {
  return maxPy(KEEP_RECENT_MIN, minPy(BUDGET.keepRecentMsgs, Math.floor(nMsgs / 3)));
}

/** Dernier `user` non éphémère (ou ancre ré-épinglée `_task_anchor`) : l'énoncé de la tâche en cours. */
export function taskAnchorIndex(messages: readonly unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!estDict(m) || m["role"] !== "user") continue;
    if (veritePy(lire(m, "_task_anchor")) || !isEphemeral(m)) return i;
  }
  return -1;
}

/** Indices jamais retirés : `system`, épinglés, ancre de tâche (sauf si elle pèse plus de 15 % du budget). */
export function protectedIndices(
  messages: readonly unknown[],
  perMsg: readonly number[] | null = null,
  budget: number | null = null,
): Set<number> {
  const out = new Set<number>();
  messages.forEach((m, i) => {
    if (estDict(m) && (m["role"] === "system" || veritePy(lire(m, "_pinned")))) out.add(i);
  });
  const anchor = taskAnchorIndex(messages);
  if (anchor >= 0) {
    const tooHeavy =
      perMsg !== null &&
      budget !== null &&
      budget > 0 &&
      anchor < perMsg.length &&
      perMsg[anchor]! > budget * ANCHOR_MAX_RATIO;
    if (!tooHeavy) out.add(anchor);
  }
  return out;
}

/** Groupes retirés d'un bloc : un assistant à tool_calls avec ses résultats ; tout autre message seul. */
export function atomicGroups(messages: readonly unknown[]): number[][] {
  const n = messages.length;
  const owner = new Map<number, number>();
  const groups = new Map<number, number[]>();
  messages.forEach((m, i) => {
    if (owner.has(i) || !estDict(m)) return;
    const grp = [i];
    if (m["role"] === "assistant" && veritePy(lire(m, "tool_calls"))) {
      const brut = m["tool_calls"];
      const ids = new Set<unknown>(
        (Array.isArray(brut) ? brut : [])
          .filter((tc) => estDict(tc) && veritePy(tc["id"]))
          .map((tc) => cleHash((tc as Dict)["id"])),
      );
      let contiguous = true;
      const found = new Set<unknown>();
      for (let j = i + 1; j < n; j++) {
        if (!contiguous && [...ids].every((x) => found.has(x))) break;
        const mj = messages[j];
        if (!(estDict(mj) && mj["role"] === "tool")) {
          contiguous = false;
          continue;
        }
        if (owner.has(j)) continue;
        const tcid = lire(mj, "tool_call_id");
        if ((veritePy(tcid) && ids.has(cleHash(tcid))) || (contiguous && !veritePy(tcid))) {
          grp.push(j);
          owner.set(j, i);
          if (veritePy(tcid)) found.add(cleHash(tcid));
        }
      }
    }
    groups.set(i, grp);
  });
  return [...groups.keys()].sort((a, b) => a - b).map((i) => groups.get(i)!);
}

const DROP_LOW_WATERMARK = 0.75;

export interface OptionsBudgetDur {
  modelId?: string | null;
  genCapTokens?: number | null;
  fixedOverheadTokens?: number | null;
  statsOut?: Dict | null;
  dropFloor?: number | null;
  signal?: AbortSignal | undefined;
}

function role(m: unknown): unknown {
  return lire(m, "role");
}

/** Dernier rempart : retire les plus anciens groupes jusqu'au filigrane bas, sans toucher `system`, ancre, queue protégée. */
export async function enforceContextBudget(
  messages: unknown[],
  ctxSize: number | null | undefined,
  options: OptionsBudgetDur = {},
): Promise<unknown[]> {
  const note = (kw: Dict): void => {
    if (options.statsOut) Object.assign(options.statsOut, kw);
  };
  if (!ctxSize || ctxSize <= 0 || !messages.length) {
    if (messages.length) note({ ctx_unknown: true });
    return messages;
  }
  const fixed = maxPy(0, intPy(options.fixedOverheadTokens || 0));
  const reserve = BUDGET.reserveTokens(ctxSize, options.genCapTokens ?? null);
  const budget = ctxSize - reserve - fixed;
  if (budget <= 0) {
    note({ over_budget: true, over_reason: "overhead", budget, ctx_size: ctxSize });
    return messages;
  }
  const perMsg = await countMessagesTokensPerMsg(messages as Dict[], options.modelId ?? null, {
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  let total = perMsg.reduce((a, b) => a + b, 0);
  if (total <= budget) {
    note({ drop_floor: 0 });
    return messages;
  }
  const n = messages.length;
  const keepTailFrom = maxPy(0, n - effectiveKeepRecent(n));
  const prot = protectedIndices(messages, perMsg, budget);
  const droppable = atomicGroups(messages).filter(
    (grp) => !grp.some((j) => j >= keepTailFrom || prot.has(j) || role(messages[j]) === "system"),
  );
  const dropped = new Set<number>();
  let k = 0;
  const anchor = taskAnchorIndex(messages);
  const target = intPy(budget * DROP_LOW_WATERMARK);
  const floor = droppable.slice(0, maxPy(0, intPy(options.dropFloor || 0)));
  const dansCourant = (g: readonly number[]): boolean => anchor >= 0 && Math.min(...g) >= anchor;
  const retirer = (grp: readonly number[]): void => {
    for (const j of grp) dropped.add(j);
    total -= grp.reduce((a, j) => a + perMsg[j]!, 0);
    k++;
  };
  const floorCur = floor.filter(dansCourant);
  for (const grp of floor.filter((g) => !dansCourant(g))) retirer(grp);
  if (floorCur.length && total > target) for (const grp of floorCur) retirer(grp);
  if (total > budget) {
    let cutCourant = false;
    for (const grp of droppable.slice(k)) {
      if (total <= target) break;
      if (dansCourant(grp)) {
        if (total > budget) cutCourant = true;
        else if (!cutCourant) break;
      }
      retirer(grp);
    }
  }
  note({ drop_floor: k });
  if (dropped.size) {
    for (let i = 0; i < n; i++) {
      const m = messages[i];
      if (dropped.has(i) || role(m) === "system") continue;
      if (role(m) !== "assistant" || veritePy(lire(m, "tool_calls")) || i >= keepTailFrom || prot.has(i))
        break;
      dropped.add(i);
      total -= perMsg[i]!;
    }
  }
  if (!dropped.size) {
    log.warn(
      `[run_chat_multi_mcp] contexte au-dessus du budget (~${perMsg.reduce((a, b) => a + b, 0)} > ${budget}) mais ` +
        "rien de retirable (system + ancre de tâche + tour courant protégés)",
    );
    note({
      over_budget: true,
      over_reason: "nothing_droppable",
      estimated: total,
      budget,
      ctx_size: ctxSize,
    });
    return messages;
  }
  if (total > budget) {
    log.warn(
      `[run_chat_multi_mcp] contexte toujours au-dessus du budget après élagage complet (~${total} > ${budget}) — ` +
        "queue protégée trop lourde",
    );
    note({ over_budget: true, over_reason: "tail_too_heavy", estimated: total, budget, ctx_size: ctxSize });
  }
  const kept = messages.filter((_m, j) => !dropped.has(j));
  note({ dropped: dropped.size });
  log.info(
    `[run_chat_multi_mcp] fit contexte : ${dropped.size} ancien(s) message(s) retiré(s) de l'envoi pour tenir dans ` +
      `~${budget} tokens (n_ctx=${ctxSize}, réserve=${reserve}, tools=${fixed})`,
  );
  return sanitizeMessageHistory(kept);
}

const FASTPATH_MARGIN = 0.85;

export interface OptionsFit {
  ctxSize: number | null | undefined;
  modelId: string | null | undefined;
  thinkingMode: boolean;
  toolsFixedTokens: number;
  visionKeep?: number;
  realCtxTokens?: number | null;
  realCtxMsgCount?: number | null;
  statsOut?: Dict | null;
  pruneKeys?: Iterable<string> | null;
  dropFloor?: number;
  signal?: AbortSignal | undefined;
}

/** Pipeline par itération : marques d'élagage → vision → budget dur (sauté si la projection mesurée tient largement). */
export async function fitContext(workingMessages: unknown[], options: OptionsFit): Promise<unknown[]> {
  const { ctxSize, statsOut } = options;
  let out = applyPruneMarks(workingMessages, options.pruneKeys);
  out = pruneOldVisionFrames(out, options.visionKeep ?? 2);
  if (statsOut) {
    statsOut["fastpath"] = false;
    statsOut["dropped"] = 0;
  }
  const genCap = BUDGET.generationCap(options.thinkingMode, ctxSize);
  const reel = options.realCtxTokens;
  const compte = options.realCtxMsgCount;
  if (
    reel &&
    reel > 0 &&
    compte !== null &&
    compte !== undefined &&
    compte >= 0 &&
    compte <= out.length &&
    ctxSize &&
    ctxSize > 0
  ) {
    const budget = BUDGET.promptBudget(ctxSize, genCap, options.toolsFixedTokens);
    if (budget > 0) {
      const projected =
        intPy(reel) + measuredPromptTokens(out.slice(compte), { modelId: options.modelId ?? null });
      if (projected <= budget * FASTPATH_MARGIN) {
        if (statsOut) {
          statsOut["fastpath"] = true;
          statsOut["drop_floor"] = 0;
        }
        return out;
      }
    }
  }
  const fitted = await enforceContextBudget(out, ctxSize, {
    modelId: options.modelId ?? null,
    genCapTokens: genCap,
    fixedOverheadTokens: options.toolsFixedTokens,
    statsOut,
    dropFloor: options.dropFloor ?? 0,
    signal: options.signal,
  });
  if (statsOut) {
    statsOut["dropped"] = maxPy(
      intPy(veritePy(statsOut["dropped"]) ? statsOut["dropped"] : 0),
      out.length - fitted.length,
      0,
    );
  }
  return fitted;
}
