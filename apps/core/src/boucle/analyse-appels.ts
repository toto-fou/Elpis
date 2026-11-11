// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/analyse-appels.ts — appels d'outils écrits en texte (Qwen, GLM, `<function=…>`, JSON) et nettoyage de leur balisage visible. */
import {
  BLANC_PY,
  ErreurPython,
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
  "JSON object per block, with no text between the braces and nothing else in your reply:\n" +
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

/** Lit `obj` dans `trouves` ; `true` seulement si la valeur entière n'est faite que d'appels. */
function processObj(obj: unknown, trouves: AppelTexte[]): boolean {
  if (estDict(obj)) {
    if (Object.hasOwn(obj, "tool_call")) {
      const tc = obj["tool_call"];
      if (!estDict(tc) || !Object.hasOwn(tc, "name")) return false;
      trouves.push([tc["name"], normArgs(Object.hasOwn(tc, "arguments") ? tc["arguments"] : {})]);
      return true;
    }
    if (!Object.hasOwn(obj, "name")) return false;
    if (Object.hasOwn(obj, "arguments")) trouves.push([obj["name"], normArgs(obj["arguments"])]);
    else if (Object.hasOwn(obj, "parameters")) trouves.push([obj["name"], normArgs(obj["parameters"])]);
    else return false;
    return true;
  }
  return Array.isArray(obj) && obj.length > 0 && obj.every((x) => processObj(x, trouves));
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

/** Appels en balisage explicite : blocs `<tool_call>` (JSON ou GLM), sinon `<function=…>` ; les blocs illisibles vont dans `blocsRates`. */
function lireBalisage(text: string, blocsRates: string[]): AppelTexte[] {
  const trouves: AppelTexte[] = [];
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
  return trouves;
}

const SEPARATEUR_JSON = new RegExp(`(?:${B}|;)*`, "uy");

/** Appels d'une réponse qui n'est que JSON nu (objets séparés par des blancs ou `;`) ; un seul morceau étranger, clôture de code comprise, en fait du texte. */
function lireJsonEntier(text: string): { appels: AppelTexte[]; debutRate: boolean } {
  const nu = stripPy(text.replace(BALISE_TOOL_CALL, ""));
  const appels: AppelTexte[] = [];
  let pos = 0;
  for (;;) {
    SEPARATEUR_JSON.lastIndex = pos;
    SEPARATEUR_JSON.exec(nu);
    pos = SEPARATEUR_JSON.lastIndex;
    if (pos >= nu.length) return { appels, debutRate: false };
    try {
      const [obj, fin] = rawDecodePy(nu, pos);
      if (!processObj(obj, appels)) return { appels: [], debutRate: false };
      pos = fin;
    } catch (e) {
      if (!(e instanceof JSONDecodeError)) throw e;
      return { appels: [], debutRate: DEBUT_APPEL_JSON.test(prefixePy(nu.slice(pos), 40)) };
    }
  }
}

/** Appels d'une réponse qui n'est QUE des appels (balisage explicite ou JSON nu), sinon `null` : du JSON ou des balises dans la prose sont du texte. */
export function extractToolCalls(text: string | null | undefined): AppelTexte[] | null {
  LAST_PARSE_DIAGNOSTIC = "";
  if (!text) return null;
  const blocsRates: string[] = [];
  const debut = debutBalisageFinal(text);
  if (debut !== null && !stripPy(text.slice(0, debut))) {
    const trouves = lireBalisage(text, blocsRates);
    if (trouves.length) return trouves;
  }
  const { appels, debutRate } = lireJsonEntier(text);
  if (appels.length) return appels;
  if (debutRate)
    log.warn(`[tool_parsing] appel JSON non parsable, aucun tool-call extrait (${prefixePy(text, 120)}…)`);
  if (blocsRates.length || debutRate) LAST_PARSE_DIAGNOSTIC = PARSE_DIAGNOSTIC_MSG;
  return null;
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

const SEGMENT_APPEL = new RegExp(`<${TC}>.*?</${TC}>|<${FN}=[^>]*>(?:.*?</${FN}>|.*$)|</?${TC}>`, "gsu");

/** Indice du balisage d'appel qui termine le texte, `null` si autre chose le suit ; un `<tool_call>` non fermé n'avale pas la prose qui vient après. */
function debutBalisageFinal(text: string): number | null {
  let debut: number | null = null;
  let fin = 0;
  for (const m of text.matchAll(SEGMENT_APPEL)) {
    if (debut === null || stripPy(text.slice(fin, m.index))) debut = m.index;
    fin = m.index + m[0].length;
  }
  return debut !== null && !stripPy(text.slice(fin)) ? debut : null;
}

/** Appels du balisage explicite qui termine une prose (réflexion, moteur sans parseur d'outils) ; suivi d'autre chose, c'est une citation. */
export function extractTrailingToolCalls(text: string | null | undefined): AppelTexte[] | null {
  if (!text) return null;
  const debut = debutBalisageFinal(text);
  if (debut === null) return null;
  const trouves = lireBalisage(text.slice(debut), []);
  return trouves.length ? trouves : null;
}

const BALISE_APPEL = new RegExp(`(<${TC}>)|(</${TC}>)|<${FN}=(${NOM}+)>|</${FN}>`, "gu");
const CORPS_FONCTION = new RegExp(`^${B}*(?:$|<${motifPy("parameter")}=)`, "u");
const CORPS_BLOC = new RegExp(
  `^${B}*(?:$|\\{(?:${B}*"name"${B}*:${B}*"(${NOM}+)")?|<${FN}=(${NOM}+)>|(${NOM}+)${B}*(?:$|<${motifPy("arg_key")}>))`,
  "u",
);

/** Nom de l'appel où le texte s'arrête, balise ouverte jamais refermée hors bloc de code (`""` si le nom n'est pas encore écrit) ; sinon `null`. */
export function openCallAtEnd(text: string): string | null {
  let bloc: number | null = null;
  let fonction: { nom: string; corps: number } | null = null;
  let ouverture = 0;
  for (const m of text.matchAll(BALISE_APPEL)) {
    const fin = m.index + m[0].length;
    if (m[1]) [bloc, fonction, ouverture] = [fin, null, m.index];
    else if (m[2]) [bloc, fonction] = [null, null];
    else if (m[3]) [fonction, ouverture] = [{ nom: m[3], corps: fin }, m.index];
    else fonction = null;
  }
  if (text.slice(0, ouverture).split("```").length % 2 === 0) return null;
  if (fonction) return CORPS_FONCTION.test(text.slice(fonction.corps)) ? fonction.nom : null;
  if (bloc === null) return null;
  const corps = CORPS_BLOC.exec(text.slice(bloc));
  return corps ? (corps[1] ?? corps[2] ?? corps[3] ?? "") : null;
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

/** Appels piégés à la fin du raisonnement (balisage explicite seulement), restreints aux noms connus, au format OpenAI. */
export function recoverToolCallsFromReasoning(
  reasoningText: string | null | undefined,
  knownNames: ReadonlySet<string> | null = null,
): Record<string, unknown>[] {
  if (!reasoningText || !MARQUE_APPEL.test(reasoningText)) return [];
  let rec: AppelTexte[] | null;
  try {
    rec = extractTrailingToolCalls(reasoningText);
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
