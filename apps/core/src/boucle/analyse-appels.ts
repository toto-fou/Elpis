// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/analyse-appels.ts — appels d'outils écrits en texte (Qwen, GLM, `<function=…>`, JSON) et nettoyage de leur balisage visible. */
import {
  BLANC_PY,
  ErreurPython,
  estBlancPy,
  estDict,
  FlottantPy,
  JSONDecodeError,
  jsonLoads,
  motifPy,
  poserCle,
  prefixePy,
  pyJsonDumps,
  rawDecodePy,
  splitlinesPy,
  stripPy,
} from "@elpis/commun";

import { journal } from "../journal";

const log = journal("boucle.analyse-appels");

/** Diagnostic d'un appel détecté mais illisible, relu par la boucle juste après `extractToolCalls`. */
export let LAST_PARSE_DIAGNOSTIC = "";

const PARSE_DIAGNOSTIC_MSG =
  "A tool call was detected in your reply but could not be parsed " +
  "(invalid JSON/markup). Re-issue it in EXACTLY this format, one valid " +
  "JSON object per block, with no text between the braces:\n" +
  '<tool_call>{"name": "<tool_name>", "arguments": {<key>: <value>}}</tool_call>';

export type AppelTexte = [unknown, unknown];

const B = BLANC_PY;
const NOM = "[\\p{L}\\p{N}_.\\-]";
const FIN_PY = "(?=\\n?$)";
const GLM_NAME_RE = new RegExp(`^${NOM}{1,128}$`, "u");
const GLM_ARG_RE = new RegExp(
  `${motifPy("<arg_key>")}${B}*(.*?)${B}*${motifPy("</arg_key>")}${B}*${motifPy("<arg_value>")}${B}*(.*?)${B}*${motifPy("</arg_value>")}`,
  "gsu",
);
const ARG_KEY_RE = new RegExp(motifPy("<arg_key>"), "u");
const TOOL_CALL_BLOCK_RE = new RegExp(`<tool_call>${B}*(.*?)${B}*</tool_call>`, "gsu");
const FUNCTION_RE = new RegExp(`<function=(${NOM}+)>(.*?)(?:</function>|${FIN_PY})`, "gsu");
const PARAMETER_RE = new RegExp(`<parameter=(${NOM}+)>(.*?)(?:</parameter>|${FIN_PY})`, "gsu");
const DEBUT_APPEL_JSON = new RegExp(`^\\{${B}*"(?:name|tool_call)"`, "u");

function estErreurValeur(e: unknown): boolean {
  return e instanceof JSONDecodeError || (e instanceof ErreurPython && e.type === "ValueError");
}

/** Corps GLM-4.5/4.6 : `nom <arg_key>k</arg_key><arg_value>v</arg_value>…`, valeurs dé-JSON-ifiées si possible. */
export function parseGlmToolBlock(block: string): AppelTexte | null {
  const m = ARG_KEY_RE.exec(block);
  const head = stripPy(m ? block.slice(0, m.index) : block);
  const name = head ? stripPy(splitlinesPy(head)[0] ?? "") : "";
  if (!name || !GLM_NAME_RE.test(name)) return null;
  const args: Record<string, unknown> = {};
  for (const [, k, v] of block.matchAll(GLM_ARG_RE)) {
    const valeur = stripPy(v ?? "");
    let lu: unknown;
    try {
      lu = jsonLoads(valeur);
    } catch (e) {
      if (!estErreurValeur(e)) throw e;
      lu = valeur;
    }
    poserCle(args, stripPy(k ?? ""), lu);
  }
  return [name, args];
}

/** Un seul `\n` (ou `\r\n`) retiré en tête et en fin ; une valeur sans saut de ligne est strippée. */
export function stripParamValue(v: string): string {
  if (!v.includes("\n")) return stripPy(v);
  let s = v.startsWith("\r\n") ? v.slice(2) : v.startsWith("\n") ? v.slice(1) : v;
  s = s.endsWith("\r\n") ? s.slice(0, -2) : s.endsWith("\n") ? s.slice(0, -1) : s;
  return s;
}

const CLOTURE_DEBUT = new RegExp(`^${B}*\`\`\`(?:${motifPy("json")})?${B}*`, "u");
const CLOTURE_FIN = new RegExp(`${B}*\`\`\`${B}*${FIN_PY}`, "u");
const BALISE_TOOL_CALL = /<\/?tool_call>/gu;
const BORDS_JSON = "` \n\r\t";

/** Texte libre prêt pour la lecture JSON : clôture ```json et balises `<tool_call>` retirées. */
export function cleanJsonText(text: string): string {
  let s = stripPy(text);
  s = s.replace(CLOTURE_DEBUT, "");
  s = s.replace(CLOTURE_FIN, "");
  s = s.replace(BALISE_TOOL_CALL, "");
  let debut = 0;
  let fin = s.length;
  while (debut < fin && BORDS_JSON.includes(s[debut]!)) debut++;
  while (fin > debut && BORDS_JSON.includes(s[fin - 1]!)) fin--;
  return s.slice(debut, fin);
}

function normArgs(args: unknown): unknown {
  if (typeof args === "string") {
    try {
      args = jsonLoads(args);
    } catch (e) {
      if (!estErreurValeur(e)) throw e;
      return { value: args };
    }
  }
  return estDict(args) ? args : {};
}

function processObj(obj: unknown, trouves: AppelTexte[]): void {
  if (estDict(obj)) {
    if (Object.hasOwn(obj, "tool_call")) {
      const tc = obj["tool_call"];
      if (estDict(tc) && Object.hasOwn(tc, "name"))
        trouves.push([tc["name"], normArgs(Object.hasOwn(tc, "arguments") ? tc["arguments"] : {})]);
    } else if (Object.hasOwn(obj, "name") && Object.hasOwn(obj, "arguments")) {
      trouves.push([obj["name"], normArgs(obj["arguments"])]);
    } else if (Object.hasOwn(obj, "name") && Object.hasOwn(obj, "parameters")) {
      trouves.push([obj["name"], normArgs(obj["parameters"])]);
    }
  } else if (Array.isArray(obj)) {
    for (const x of obj) processObj(x, trouves);
  }
}

function argumentsDeBloc(obj: Record<string, unknown>): unknown {
  let args = Object.hasOwn(obj, "arguments")
    ? obj["arguments"]
    : Object.hasOwn(obj, "parameters")
      ? obj["parameters"]
      : {};
  if (typeof args === "string") {
    try {
      args = jsonLoads(args);
    } catch (e) {
      if (!estErreurValeur(e)) throw e;
      args = {};
    }
  }
  return args;
}

/** Appels d'outils lus dans le texte (balises Qwen/GLM, `<function=…>`, JSON propre, objets JSON dans la prose), ou `null`. */
export function extractToolCalls(text: string | null | undefined): AppelTexte[] | null {
  LAST_PARSE_DIAGNOSTIC = "";
  if (!text) return null;
  const trouves: AppelTexte[] = [];
  const blocsRates: string[] = [];

  for (const [, brut] of text.matchAll(TOOL_CALL_BLOCK_RE)) {
    const block = stripPy(brut ?? "");
    let lu = false;
    try {
      const obj = jsonLoads(block);
      if (estDict(obj) && Object.hasOwn(obj, "name")) {
        trouves.push([obj["name"], argumentsDeBloc(obj)]);
        lu = true;
      }
    } catch (e) {
      if (!(e instanceof JSONDecodeError)) throw e;
    }
    if (!lu) {
      const glm = parseGlmToolBlock(block);
      if (glm) {
        trouves.push(glm);
        lu = true;
      }
    }
    if (!lu) {
      blocsRates.push(block);
      log.warn(
        `[tool_parsing] bloc <tool_call> non parsable (ni JSON ni GLM-XML) ignoré (${Array.from(block).length} chars): ${prefixePy(block, 120)}…`,
      );
    }
  }
  if (trouves.length) return trouves;

  for (const [, nom, corps] of text.matchAll(FUNCTION_RE)) {
    const params: Record<string, unknown> = {};
    for (const [, cle, valeur] of (corps ?? "").matchAll(PARAMETER_RE))
      poserCle(params, cle ?? "", stripParamValue(valeur ?? ""));
    const plein = stripPy(corps ?? "");
    trouves.push([nom, Object.keys(params).length === 0 && plein ? { input: plein } : params]);
  }
  if (trouves.length) return trouves;

  const cleaned = cleanJsonText(text);
  try {
    processObj(jsonLoads(cleaned), trouves);
    if (trouves.length) return trouves;
  } catch (e) {
    if (!(e instanceof JSONDecodeError)) throw e;
  }

  let pos = 0;
  let debutsRates = 0;
  const pas = (i: number): number => ((cleaned.codePointAt(i) ?? 0) > 0xffff ? 2 : 1);
  while (pos < cleaned.length) {
    while (pos < cleaned.length && estBlancPy(cleaned.codePointAt(pos) ?? 0)) pos += pas(pos);
    if (pos >= cleaned.length) break;
    try {
      const [obj, fin] = rawDecodePy(cleaned, pos);
      processObj(obj, trouves);
      pos = fin;
    } catch (e) {
      if (!(e instanceof JSONDecodeError)) throw e;
      if (cleaned[pos] === "{" && DEBUT_APPEL_JSON.test(prefixePy(cleaned.slice(pos), 40))) debutsRates++;
      pos += pas(pos);
    }
  }
  if (debutsRates && !trouves.length) {
    log.warn(
      `[tool_parsing] ${debutsRates} début(s) d'objet JSON non parsable(s) dans le texte libre, aucun tool-call extrait — tool-call mal formé probablement perdu (${prefixePy(cleaned, 120)}…)`,
    );
  }
  if (!trouves.length && (blocsRates.length || debutsRates)) LAST_PARSE_DIAGNOSTIC = PARSE_DIAGNOSTIC_MSG;
  return trouves.length ? trouves : null;
}

const TC = motifPy("tool_call");
const FN = motifPy("function");
const NETTOYAGES: readonly RegExp[] = [
  new RegExp(`<${TC}>.*?</${TC}>`, "gsu"),
  new RegExp(`<${FN}=[^>]*>.*?</${FN}>`, "gsu"),
  new RegExp(`<${TC}>.*$`, "su"),
  new RegExp(`<${FN}=[^>]*>.*$`, "su"),
  new RegExp(`</?${TC}>`, "gu"),
  new RegExp(`</?${FN}(?:=[^>]*)?>`, "gu"),
  new RegExp(`</?${motifPy("parameter")}(?:=[^>]*)?>`, "gu"),
  new RegExp(`</?${motifPy("arg_key")}>`, "gu"),
  new RegExp(`</?${motifPy("arg_value")}>`, "gu"),
];

/** Le texte sans aucun bloc ni balise d'appel d'outil (y compris un bloc resté ouvert en fin de flux). */
export function stripToolCallMarkup<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  let s: string = text;
  for (const re of NETTOYAGES) s = s.replace(re, "");
  return stripPy(s) as T;
}

/** Traces de balisage d'appel (ouvrantes ou fermantes) ; pas de drapeau `g` : `test` sans état. */
export const TOOL_MARKUP_TRACE_RE = new RegExp(
  `</?${TC}>|</?${FN}(?:=[^>]*)?>|</${motifPy("parameter")}>`,
  "u",
);

const PUR_TOOL_CALL = new RegExp(`^${B}*<${TC}>.*?</${TC}>${B}*$`, "su");
const PUR_FUNCTION = new RegExp(`^${B}*<${FN}=[^>]+>.*?</${FN}>${B}*$`, "su");

/** Texte qui n'est qu'une tentative d'appel (bloc `<tool_call>`, `<function=…>`, ou JSON pur). */
export function looksLikePureToolCallText(rawText: string | null | undefined): boolean {
  if (!rawText) return false;
  const s = stripPy(rawText);
  if (!s) return false;
  if (PUR_TOOL_CALL.test(s) || PUR_FUNCTION.test(s)) return true;
  try {
    jsonLoads(cleanJsonText(s));
    return true;
  } catch {
    return false;
  }
}

const MARQUE_APPEL = new RegExp(`<${TC}>|<${FN}=`, "u");

/** Appels piégés dans le raisonnement (balisage explicite seulement), restreints aux noms connus, au format OpenAI. */
export function recoverToolCallsFromReasoning(
  reasoningText: string | null | undefined,
  knownNames: ReadonlySet<string> | null = null,
): Record<string, unknown>[] {
  if (!reasoningText || !MARQUE_APPEL.test(reasoningText)) return [];
  let rec: AppelTexte[] | null;
  try {
    rec = extractToolCalls(reasoningText);
  } catch {
    return [];
  }
  if (!rec) return [];
  if (knownNames !== null) {
    rec = rec.filter(([n]) => {
      if (typeof n === "object" && n !== null && !(n instanceof FlottantPy))
        throw new ErreurPython("TypeError", `unhashable type: '${Array.isArray(n) ? "list" : "dict"}'`);
      return typeof n === "string" && knownNames.has(n);
    });
    if (!rec.length) return [];
  }
  return rec.map(([n, a], i) => ({
    id: `call_${i}`,
    type: "function",
    function: { name: n, arguments: pyJsonDumps(a, { ensureAscii: false }) },
  }));
}
