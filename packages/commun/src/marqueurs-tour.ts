// SPDX-License-Identifier: MIT
/** packages/commun/src/marqueurs-tour.ts — marqueurs de tour des gabarits de chat les plus courants (ChatML, Harmony, Llama, DeepSeek, Gemma, Mistral, MiniMax, Seed-OSS, Nemotron, GLM…) rendus inertes dans un texte tiers : un gluon invisible après le premier signe les empêche d'être lus comme jetons spéciaux par llama.cpp, vLLM et SGLang. */

/** Joint de mots (U+2060) : sans largeur, absent de tout jeton spécial, conservé par les tokenizers. */
export const GLUON = "\u2060";

/** Jetons de rôle entre crochets quelconques (`[INST]`, `[/INST]`, `[SYSTEM_PROMPT]`, `[TOOL_CALLS]`…) : texte de documents et de passages (RAG), où un nom en majuscules entre crochets n'a pas de raison d'être. */
const JETON_CROCHETS = /\[(?=\/?[A-Z][A-Z0-9_]{1,31}\])/gu;

/** Jetons de rôle entre crochets des gabarits : Mistral et Llama 2 (`[INST]`…), MiniMax (`[e~[`, `]~!b[`, `]~b]`), GLM (`[gMASK]`) ; une liste fermée, pour ne pas toucher les `[INFO]`, `[ERROR]` ou `[OK]` d'une sortie de commande. */
const CROCHETS_CONNUS = String.raw`\[(?=\/?(?:INST|SYSTEM_PROMPT|AVAILABLE_TOOLS|TOOL_RESULTS|TOOL_CALLS|TOOL_CONTENT|ARGS|CALL_ID|IMG|IMG_BREAK|IMG_END|THINK|PREFIX|MIDDLE|SUFFIX)\]|e~\[|[gs]MASK\])|\](?=~!b\[|~b\])`;

/** Débuts de marqueur à chevron, chacun vu par un `(?=…)` : ChatML, Qwen, gpt-oss Harmony, Llama 3, Phi, Cohere `<|nom|>` ; DeepSeek `<｜nom｜>` ; Gemma, FunctionGemma et Gemma 4 (`<|turn>`, `<tool_call|>`) ; Llama 2 et Mistral `<s>`, `</s>`, `<<SYS>>` ; Qwen et GLM `<think>`, `<tool_call>`, `<tool_response>`, `<tools>`, `<arg_key>`, `<sop>` ; MiniMax `<minimax:tool_call>` ; Seed-OSS `<seed:…>` ; Nemotron `<extra_id_N>`, `<SPECIAL_N>`, `<TOOLCALL>`. Un `<` ordinaire (code, HTML, génériques) n'en est pas un. */
const ANGLE_APRES = [
  String.raw`\|[^|<>\s]{1,64}\|>`,
  String.raw`｜[^｜<>\s]{1,64}｜>`,
  String.raw`\/?(?:start_of_turn|end_of_turn|start_of_image|end_of_image|start_of_audio|end_of_audio|image_soft_token|bos|eos)>`,
  String.raw`\/?s>`,
  String.raw`<\/?SYS>>`,
  String.raw`\/?(?:think|tool_call|tool_response|tools)>`,
  String.raw`\/?arg_(?:key|value)>`,
  String.raw`\/?[se]op>`,
  String.raw`\/?minimax:tool_calls?>`,
  String.raw`\/?seed:[a-z_]{1,32}>`,
  String.raw`(?:extra_id_|SPECIAL_)[0-9]{1,4}>`,
  String.raw`\/?(?:TOOLCALL|AVAILABLE_TOOLS|TOOL_RESPONSE)>`,
  String.raw`(?:start|end)_function_(?:declaration|call|response)>|escape>`,
  String.raw`\|(?:turn|channel|tool|tool_call|tool_response)>`,
  String.raw`(?:turn|channel|tool|tool_call|tool_response)\|>`,
].join("|");

const NEUTRALISER = new RegExp(`<(?=${ANGLE_APRES})|${CROCHETS_CONNUS}`, "gu");
const RESTAURER = new RegExp(
  `<${GLUON}(?=${ANGLE_APRES})|\\[${GLUON}(?=\\/?[A-Z][A-Z0-9_]{1,31}\\]|e~\\[|[gs]MASK\\])|\\]${GLUON}(?=~!b\\[|~b\\])`,
  "gu",
);

/** Texte d'un document rendu inerte face aux gabarits de chat : jetons de rôle entre crochets neutralisés (les chevrons sont échappés à part). */
export function neutraliserJetonsRole(texte: string): string {
  return texte.replace(JETON_CROCHETS, `[${GLUON}`);
}

/** Texte tiers (page, fichier, sortie de commande, rapport d'un sous-agent) rendu inerte face aux gabarits : les marqueurs d'une liste fermée de familles courantes reçoivent un gluon, le reste du texte est inchangé, octet pour octet ; déterministe et idempotent (le cache de préfixe du moteur en dépend). */
export function neutraliserMarqueursTour(texte: string): string {
  return texte.replace(NEUTRALISER, (m) => m + GLUON);
}

/** Inverse de `neutraliserMarqueursTour` (et de `neutraliserJetonsRole`), pour ce que le modèle recopie d'un résultat vers un outil qui écrit dans le bac : le fichier garde le texte d'origine. */
export function restaurerMarqueursTour(texte: string): string {
  return texte.includes(GLUON) ? texte.replace(RESTAURER, (m) => m.slice(0, -GLUON.length)) : texte;
}

/** Outils dont les arguments finissent dans un prompt (mémoire, skills, liste de tâches, brief d'un sous-agent, routine) : ils gardent le gluon, un marqueur recopié y reste inerte. */
export const OUTILS_SANS_RESTAURATION: ReadonlySet<string> = new Set([
  "memory",
  "skill_save",
  "skill_add_file",
  "todowrite",
  "task",
  "routine_save",
]);

/** Objet simple (littéral ou sans prototype), pas un tampon, une carte ou une date. */
function estObjetNu(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Même inverse sur toutes les chaînes d'une valeur d'arguments (objets et listes parcourus) ; le reste passe tel quel. */
export function restaurerMarqueursArgs<T>(valeur: T): T {
  if (typeof valeur === "string") return restaurerMarqueursTour(valeur) as T;
  if (Array.isArray(valeur)) return valeur.map((v) => restaurerMarqueursArgs(v)) as T;
  if (valeur !== null && typeof valeur === "object" && estObjetNu(valeur))
    return Object.fromEntries(
      Object.entries(valeur as Record<string, unknown>).map(([k, v]) => [k, restaurerMarqueursArgs(v)]),
    ) as T;
  return valeur;
}

/** Arguments d'un appel tels que l'outil doit les exécuter : le gluon des marqueurs retiré, sauf pour un outil dont la sortie finit dans un prompt (`OUTILS_SANS_RESTAURATION`). */
export function restaurerArgsOutil<T>(outil: string, args: T): T {
  return OUTILS_SANS_RESTAURATION.has(outil) ? args : restaurerMarqueursArgs(args);
}
