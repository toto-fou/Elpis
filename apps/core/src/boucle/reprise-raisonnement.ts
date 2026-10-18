// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/reprise-raisonnement.ts — reprise in-run d'un raisonnement ou d'une rédaction coupés par le plafond : décisions, queue de messages, usage cumulé (pur). */
import { ErreurPython, stripPy, veritePy } from "@elpis/commun";

import { poserCle } from "../llm/dict-py";
import {
  LLAMA_CONTENT_RESUME_MAX,
  LLAMA_THINK_RESUME_MAX,
  LLAMA_THINK_RESUME_TOTAL_TOKENS,
} from "../llm/constantes";
import { entierPy, estDict, longueurPy } from "../python";
import type { Dict } from "../python";

export const THINK_PREFILL_OPEN = "<think>\n";

/** Consigne du repli, partagée avec la route (« Répondre maintenant ») : texte canonique. */
export const RESUME_AFTER_THINK_INSTRUCTION =
  "Your thinking phase is over. Now write your final answer for the user, " +
  "building on the reasoning above — without repeating or continuing it, " +
  "and without <think> tags.";

export const MAX_RESUME_THINKING_CHARS = 150_000;
export const RESUME_TRUNC_MARKER = "[…raisonnement antérieur tronqué…]\n";
/** Marge de fenêtre d'inférence exigée pour tenter une reprise (le raisonnement ne pèse pas sur le contexte de travail). */
export const RESUME_HEADROOM_TOKENS = 2048;
export const MAX_RESUME_CONTENT_CHARS = 200_000;

export type Decision = [boolean, string];

/** `s[-n:]` en points de code. */
function suffixePy(s: string, n: number): string {
  let debut = s.length;
  for (let compte = 0; compte < n && debut > 0; compte++) {
    const pas =
      debut >= 2 &&
      (s.charCodeAt(debut - 1) & 0xfc00) === 0xdc00 &&
      (s.charCodeAt(debut - 2) & 0xfc00) === 0xd800
        ? 2
        : 1;
    debut -= pas;
  }
  return s.slice(debut);
}

/** Raisonnement rejoué borné : au-delà de la limite, le suffixe seul, précédé du marqueur. */
export function clipResumeThinking(thinking: string | null | undefined): string {
  const t = thinking || "";
  if (t.length <= MAX_RESUME_THINKING_CHARS || longueurPy(t) <= MAX_RESUME_THINKING_CHARS) return t;
  return RESUME_TRUNC_MARKER + suffixePy(t, MAX_RESUME_THINKING_CHARS);
}

/** Queue de messages et drapeaux d'une reprise : natif (`continue_final_message` dans le bloc de réflexion) ou repli (réflexion close + consigne de conclusion). */
export function buildResumeTail(
  thinking: string | null | undefined,
  options: { native: boolean },
): [Dict[], Dict] {
  const borne = clipResumeThinking(thinking);
  if (options.native)
    return [
      [{ role: "assistant", content: "", reasoning_content: borne }],
      { continue_final_message: true, add_generation_prompt: false },
    ];
  return [
    [
      { role: "assistant", content: THINK_PREFILL_OPEN + borne + "\n</think>" },
      { role: "user", content: RESUME_AFTER_THINK_INSTRUCTION },
    ],
    {},
  ];
}

/** Queue d'une reprise de la PROSE, toujours native (un repli par consigne dupliquerait le texte). */
export function buildContentResumeTail(content: string): [Dict[], Dict] {
  return [[{ role: "assistant", content }], { continue_final_message: true, add_generation_prompt: false }];
}

export interface EtatReprise {
  finish: string | null | undefined;
  content: string | null | undefined;
  hadToolCalls?: boolean;
  resumesDone?: number;
  ctxSize?: number | null;
  windowTokens?: number | null;
}

/** Refus si l'occupation réelle mesurée plus la marge atteint la fenêtre ; rien n'est refusé sur une mesure absente. */
function fenetrePleine(
  ctxSize: number | null | undefined,
  windowTokens: number | null | undefined,
): string | null {
  const fenetre = entierPy(veritePy(windowTokens) ? windowTokens : 0);
  if (ctxSize && ctxSize > 0 && fenetre > 0 && fenetre + RESUME_HEADROOM_TOKENS >= ctxSize)
    return `fenêtre d'inférence pleine (${fenetre} + ${RESUME_HEADROOM_TOKENS} ≥ n_ctx=${ctxSize})`;
  return null;
}

/** Reprise de la prose : finish=length, prose présente, sans appel d'outil, canal natif, plafond, taille renvoyable intacte, fenêtre. */
export function shouldAutoResumeContent(e: EtatReprise & { nativeOk?: boolean }): Decision {
  const resumesDone = e.resumesDone ?? 0;
  if ((e.finish || "") !== "length") return [false, "finish!=length"];
  if (!stripPy(e.content || "")) return [false, "aucune prose à continuer"];
  if (e.hadToolCalls) return [false, "tool_calls présents (reprise mi-séquence interdite)"];
  if (!e.nativeOk)
    return [
      false,
      "canal natif continue_final_message indisponible — pas de reprise de prose par consigne (risque de redite)",
    ];
  if (LLAMA_CONTENT_RESUME_MAX <= 0) return [false, "reprise de contenu désactivée (content_resume_max=0)"];
  if (resumesDone >= LLAMA_CONTENT_RESUME_MAX)
    return [false, `plafond de reprises atteint (${resumesDone}/${LLAMA_CONTENT_RESUME_MAX})`];
  const longueur = longueurPy(e.content || "");
  if (longueur > MAX_RESUME_CONTENT_CHARS)
    return [
      false,
      `prose trop longue pour être renvoyée intacte (${longueur} > ${MAX_RESUME_CONTENT_CHARS} chars)`,
    ];
  const pleine = fenetrePleine(e.ctxSize, e.windowTokens);
  if (pleine) return [false, pleine];
  return [true, `reprise de prose ${resumesDone + 1}/${LLAMA_CONTENT_RESUME_MAX}`];
}

/** Reprise du raisonnement : finish=length en pleine réflexion sans prose ni appel, plafonds de reprises et de tokens, fenêtre ; un partiel de transport reste éligible. */
export function shouldAutoResume(
  e: EtatReprise & { thinking: string | null | undefined; partial?: boolean; thinkTokensDone?: number },
): Decision {
  const resumesDone = e.resumesDone ?? 0;
  const thinkTokensDone = e.thinkTokensDone ?? 0;
  if ((e.finish || "") !== "length") return [false, "finish!=length"];
  if (stripPy(e.content || "")) return [false, "contenu visible présent"];
  if (!stripPy(e.thinking || "")) return [false, "aucun raisonnement accumulé"];
  if (e.hadToolCalls) return [false, "tool_calls présents (reprise mi-séquence interdite)"];
  if (LLAMA_THINK_RESUME_MAX <= 0) return [false, "auto-reprise désactivée (think_resume_max=0)"];
  if (resumesDone >= LLAMA_THINK_RESUME_MAX)
    return [false, `plafond de reprises atteint (${resumesDone}/${LLAMA_THINK_RESUME_MAX})`];
  if (LLAMA_THINK_RESUME_TOTAL_TOKENS > 0 && thinkTokensDone >= LLAMA_THINK_RESUME_TOTAL_TOKENS)
    return [
      false,
      `budget total de thinking atteint (${thinkTokensDone}/${LLAMA_THINK_RESUME_TOTAL_TOKENS} tk)`,
    ];
  const pleine = fenetrePleine(e.ctxSize, e.windowTokens);
  if (pleine) return [false, pleine];
  const suffixe = e.partial ? " — après coupure transport" : "";
  return [true, `reprise ${resumesDone + 1}/${LLAMA_THINK_RESUME_MAX}${suffixe}`];
}

function entierOuZero(v: unknown): number {
  return entierPy(veritePy(v) ? v : 0);
}

/** Usage cumulé des segments : `completion_tokens` et `total_tokens` s'additionnent, le reste (prompt…) vient du dernier segment. */
export function mergeSegmentUsage<A>(acc: A, seg: unknown): A | Dict {
  if (!estDict(seg) || Object.keys(seg).length === 0) return acc;
  if (!estDict(acc) || Object.keys(acc).length === 0) return { ...seg };
  const sortie: Dict = { ...acc };
  for (const [k, v] of Object.entries(seg)) {
    if (k !== "completion_tokens" && k !== "total_tokens") {
      poserCle(sortie, k, v);
      continue;
    }
    try {
      poserCle(sortie, k, entierOuZero(Object.hasOwn(sortie, k) ? sortie[k] : null) + entierOuZero(v));
    } catch (err) {
      if (!(err instanceof ErreurPython) || (err.type !== "TypeError" && err.type !== "ValueError"))
        throw err;
      poserCle(sortie, k, v);
    }
  }
  return sortie;
}
