// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/instance.ts — moteur Markdown et purificateur uniques de la page, branchés sur `marked` et DOMPurify. */
import DOMPurify from "dompurify";
import * as marked from "marked";

import { installerDelegationCode } from "./habillage-code.ts";
import { configurerAnalyseur, creerMoteurMarkdown } from "./markdown.ts";
import type { Analyseur, MoteurMarkdown } from "./markdown.ts";
import { creerPurificateur } from "./purification.ts";
import { sanitizeSvg } from "./svg.ts";
import type { PurifySvg } from "./svg.ts";

let moteur: MoteurMarkdown | null = null;
let purifier: ((html: unknown) => string) | null = null;

/** Purificateur HTML de la page (crochet de position installé une fois). */
export function purificateur(): (html: unknown) => string {
  purifier ??= creerPurificateur(DOMPurify);
  return purifier;
}

/** Moteur de la page ; la première demande configure `marked` (rendu et purification de toute sortie). */
export function moteurMarkdown(): MoteurMarkdown {
  if (moteur) return moteur;
  const analyseur = marked as unknown as Analyseur;
  const m = creerMoteurMarkdown({ analyseur, purifier: purificateur() });
  configurerAnalyseur(analyseur, purificateur());
  installerDelegationCode();
  moteur = m;
  return m;
}

/** SVG purifié, ou null (le code est alors affiché, jamais du SVG non nettoyé). */
export function purifierSvg(src: unknown): string | null {
  return sanitizeSvg(src, DOMPurify as unknown as PurifySvg);
}
