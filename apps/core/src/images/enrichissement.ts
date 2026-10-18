// SPDX-License-Identifier: MIT
/** apps/core/src/images/enrichissement.ts — description enrichie par le modèle du chat avant le moteur ; best-effort strict (panne, délai ou sortie douteuse : demande telle quelle). */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { stripPy } from "@elpis/commun";
import { racineDepot } from "@elpis/config";

import { journal } from "../journal";
import { BLANC_PY, longueurPy, lowerPy, prefixePy, splitPy } from "../python";
import { appelEnrichissement, dansPorteeUsage } from "./ports";
import type { AppelLlmEnrichissement, MessageLlm } from "./ports";

const log = journal("image");

export const PROMPT_NAME = "IMAGE_PROMPT_ENHANCE";
export const FALLBACK =
  "You rewrite a user's image request into one prompt for a text-to-image diffusion " +
  "model. Output ONLY the prompt, in English, one paragraph, at most 120 words. Keep " +
  "every element the user asked for; add concrete visual detail (setting, lighting, " +
  "composition, medium, mood). Text to render stays verbatim inside double quotes.";
const TIMEOUT_SEC = 60.0;
const MAX_CHARS = 1500;
/** `<think>…</think>` sous `re.I` : le `i` de Python reconnaît aussi « ı » et « İ ». */
const THINK = /<th[iıİ]nk>[\s\S]*?<\/th[iıİ]nk>/giu;
const PREAMBULE = new RegExp(`^(prompt|here [iıİ]s[^:]*|vo[iıİ]c[iıİ][^:]*)${BLANC_PY}*:${BLANC_PY}*`, "iu");
const GUILLEMETS = new Set(['"', "'", "«"]);

const cacheFragments = new Map<string, [number, string]>();

/** `_load_fragment` : `system_prompts/<nom>.md` relu si sa date change ; `""` si absent ou illisible. */
function fragment(nom: string): string {
  const chemin = join(racineDepot(), "system_prompts", `${nom}.md`);
  let mtime: number;
  try {
    mtime = statSync(chemin).mtimeMs;
  } catch {
    return "";
  }
  const connu = cacheFragments.get(nom);
  if (connu !== undefined && connu[0] === mtime) return connu[1];
  let texte: string;
  try {
    texte = stripPy(readFileSync(chemin, "utf-8").replace(/\r\n?/g, "\n"));
  } catch {
    texte = "";
  }
  cacheFragments.set(nom, [mtime, texte]);
  return texte;
}

/** Prompt système éditable en console, repli embarqué si le fichier manque. */
export function systemPrompt(): string {
  return fragment(PROMPT_NAME) || FALLBACK;
}

/** `s.strip(caracteres)`. */
function stripCaracteres(s: string, c: string): string {
  let [debut, fin] = [0, s.length];
  while (debut < fin && s.charAt(debut) === c) debut++;
  while (fin > debut && s.charAt(fin - 1) === c) fin--;
  return s.slice(debut, fin);
}

/** Sortie du modèle → prompt utilisable, ou `null` si douteuse. */
export function clean(output: string, original: string): string | null {
  let t = stripPy((output || "").replace(THINK, ""));
  if (lowerPy(t).includes("<think")) return null;
  t = stripPy(t.replace(PREAMBULE, ""));
  t = stripPy(stripCaracteres(t, "`"));
  const points = Array.from(t);
  const premier = points[0] ?? "";
  if (points.length >= 2 && premier === points[points.length - 1] && GUILLEMETS.has(premier))
    t = stripPy(points.slice(1, -1).join(""));
  t = splitPy(t).join(" ");
  if (longueurPy(t) < Math.max(8, Math.trunc(Math.min(longueurPy(original), 20) / 2))) return null;
  return prefixePy(t, MAX_CHARS);
}

export type ResultatEnrichissement = { prompt: string | null; raison: string };

/** `(prompt enrichi | null, raison)` ; `llmCall` remplace l'appel du chat (tests), un Stop remonte. */
export async function enhancePrompt(
  prompt: string,
  options: { model: string | null; chatId?: string; llmCall?: AppelLlmEnrichissement; signal?: AbortSignal },
): Promise<ResultatEnrichissement> {
  const msgs: MessageLlm[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: prefixePy(prompt, 4000) },
  ];
  const appel = options.llmCall ?? appelEnrichissement();
  if (options.signal?.aborted) throw options.signal.reason;
  const controleur = new AbortController();
  const relais = (): void => controleur.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", relais, { once: true });
  let delaiDepasse = false;
  const minuterie = setTimeout(() => {
    delaiDepasse = true;
    controleur.abort();
  }, TIMEOUT_SEC * 1000);
  let sortie: string;
  try {
    if (appel === null) throw new Error("appel LLM non installé");
    const enCours = dansPorteeUsage("image_prompt", options.chatId ?? "", () =>
      appel(msgs, { model: options.model, chatId: options.chatId ?? "", signal: controleur.signal }),
    );
    sortie = await new Promise<string>((ok, ko) => {
      controleur.signal.addEventListener("abort", () => ko(controleur.signal.reason), { once: true });
      enCours.then(ok, ko);
    });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    if (delaiDepasse) return { prompt: null, raison: "délai dépassé" };
    const nom = e instanceof Error ? e.name : typeof e;
    log.info(
      `enrichissement impossible : ${nom}: ${[...String(e instanceof Error ? e.message : e)].slice(0, 160).join("")}`,
    );
    return { prompt: null, raison: "modèle indisponible" };
  } finally {
    clearTimeout(minuterie);
    options.signal?.removeEventListener("abort", relais);
  }
  const propre = clean(String(sortie || ""), prompt);
  if (!propre) return { prompt: null, raison: "réponse inutilisable" };
  return { prompt: propre, raison: "" };
}
