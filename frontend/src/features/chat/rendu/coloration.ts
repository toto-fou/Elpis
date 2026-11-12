// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/coloration.ts — coloration différée des blocs de code : un bloc par tranche de temps libre, blocs visibles d'abord, détection de langue bornée, cache langue + texte. */
import { ensureVendor } from "../../../platform/vendor.ts";

export interface Coloreur {
  getLanguage(nom: string): unknown;
  highlight(code: string, options: { language: string }): { value: string };
  highlightAuto(code: string, sousEnsemble?: readonly string[]): { value: string };
}

interface Echeance {
  timeRemaining(): number;
}

/** Langues essayées pour un bloc sans langue connue : les plus courantes des réponses (scripts, données, web, SQL, correctifs), prises parmi les 36 de la distribution livrée. */
export const LANGUES_AUTO: readonly string[] = [
  "bash",
  "json",
  "python",
  "javascript",
  "typescript",
  "xml",
  "yaml",
  "sql",
  "css",
  "diff",
  "ini",
  "java",
];
/** Au-delà de cette taille, un bloc sans langue connue reste en texte simple. */
export const AUTO_MAX = 4000;
/** Au-delà de cette taille, aucun bloc n'est coloré : la tranche de temps libre ne doit pas devenir une longue tâche. */
export const TEXTE_MAX = 100_000;

const ATTRIBUT_FAIT = "data-hl";
const SELECTEUR = ".code-wrapper > pre.custom-style-applied > code:not([" + ATTRIBUT_FAIT + "])";
const CACHE_MAX = 150;
const HTML_MAX = 120_000;
const DELAI_MAX = 1000;
const MARGE_MS = 3;
const file = new Set<HTMLElement>();
const cache = new Map<string, string | null>();
const chauffees = new Set<string>();
let programme = false;
let ordonne = true;
let chargement = false;
let balayagePrevu = false;

function coloreur(): Coloreur | undefined {
  return (window as unknown as { hljs?: Coloreur }).hljs;
}

function langueDe(code: Element): string {
  const classe = Array.from(code.classList).find((c) => c.startsWith("language-"));
  return classe ? classe.slice(9).toLowerCase() : "";
}

function cleDe(lang: string, texte: string): string {
  return lang + "\0" + texte;
}

function retenir(cle: string, html: string | null): void {
  if (html !== null && html.length > HTML_MAX) return;
  if (cache.size >= CACHE_MAX) {
    const ancien = cache.keys().next().value;
    if (ancien !== undefined) cache.delete(ancien);
  }
  cache.set(cle, html);
}

/** HTML coloré d'un texte, ou null pour le laisser en texte simple (langue inconnue et bloc trop long, erreur du coloreur). */
function htmlColore(hl: Coloreur, lang: string, texte: string): string | null {
  const cle = cleDe(lang, texte);
  if (cache.has(cle)) {
    const connu = cache.get(cle) ?? null;
    cache.delete(cle);
    cache.set(cle, connu);
    return connu;
  }
  let html: string | null = null;
  try {
    if (lang && hl.getLanguage(lang)) html = hl.highlight(texte, { language: lang }).value;
    else if (texte.length <= AUTO_MAX) html = hl.highlightAuto(texte, LANGUES_AUTO).value;
  } catch {
    html = null;
  }
  retenir(cle, html);
  return html;
}

function colorerBloc(code: HTMLElement, hl: Coloreur): void {
  if (!code.isConnected || code.hasAttribute(ATTRIBUT_FAIT) || code.querySelector("mark")) return;
  const texte = code.textContent ?? "";
  const html = texte && texte.length <= TEXTE_MAX ? htmlColore(hl, langueDe(code), texte) : null;
  code.setAttribute(ATTRIBUT_FAIT, "1");
  if (html === null) return;
  const caret = code.querySelector(".elpis-stream-caret");
  code.innerHTML = html;
  if (caret) code.appendChild(caret);
}

/** Met en tête de file les blocs affichés à l'écran, puis les autres dans l'ordre du document ; écarte les blocs détachés. */
function ordonner(): void {
  ordonne = true;
  const hauteur = window.innerHeight;
  const visibles: HTMLElement[] = [];
  const autres: HTMLElement[] = [];
  for (const code of file) {
    if (!code.isConnected) continue;
    const r = file.size > 1 ? code.getBoundingClientRect() : null;
    (r && r.bottom > 0 && r.top < hauteur ? visibles : autres).push(code);
  }
  file.clear();
  for (const code of [...visibles, ...autres]) file.add(code);
}

function charger(): void {
  if (chargement) return;
  chargement = true;
  ensureVendor("highlight").then(
    () => {
      chargement = false;
      if (coloreur()) programmer();
      else file.clear();
    },
    () => {
      chargement = false;
      file.clear();
    },
  );
}

/** Langue dont la grammaire n'est pas encore compilée et dont ce bloc a besoin : la compiler dans sa propre unité de travail évite une tâche longue. */
function langueFroide(hl: Coloreur, code: HTMLElement): string | null {
  if (!code.isConnected || code.hasAttribute(ATTRIBUT_FAIT) || code.querySelector("mark")) return null;
  const texte = code.textContent ?? "";
  const lang = langueDe(code);
  if (!texte || texte.length > TEXTE_MAX || cache.has(cleDe(lang, texte))) return null;
  const possibles = lang && hl.getLanguage(lang) ? [lang] : texte.length <= AUTO_MAX ? LANGUES_AUTO : [];
  return possibles.find((l) => !chauffees.has(l) && hl.getLanguage(l)) ?? null;
}

function chauffer(hl: Coloreur, lang: string): void {
  chauffees.add(lang);
  try {
    hl.highlight("", { language: lang });
  } catch {
    /* grammaire inutilisable : elle échouera de même au passage du bloc */
  }
}

function tranche(echeance: Echeance): void {
  programme = false;
  if (typeof window === "undefined") return;
  const hl = coloreur();
  if (!hl) {
    if (file.size) charger();
    return;
  }
  if (!ordonne) ordonner();
  let unites = 0;
  while (file.size && (unites === 0 || echeance.timeRemaining() >= MARGE_MS)) {
    const code = file.values().next().value as HTMLElement;
    const froide = langueFroide(hl, code);
    if (froide) chauffer(hl, froide);
    else {
      file.delete(code);
      colorerBloc(code, hl);
    }
    unites++;
  }
  if (file.size) programmer();
}

function programmer(): void {
  if (programme) return;
  programme = true;
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(tranche, { timeout: DELAI_MAX });
    return;
  }
  const debut = performance.now();
  setTimeout(() => tranche({ timeRemaining: () => 8 - (performance.now() - debut) }), 16);
}

/** Met en file la coloration des blocs de code ordinaires de `racine` pas encore colorés ; elle se fait après l'affichage, hors du chemin de rendu. */
export function planifierColoration(racine: ParentNode): void {
  const avant = file.size;
  for (const code of racine.querySelectorAll<HTMLElement>(SELECTEUR)) file.add(code);
  if (file.size === avant) return;
  ordonne = false;
  programmer();
}

/** Planifie la coloration de tous les blocs de la page, une fois le HTML posé : pour les vues dont le rendu ne passe pas par un composant du chat. */
export function planifierBalayage(): void {
  if (balayagePrevu) return;
  balayagePrevu = true;
  const balayer = (): void => {
    balayagePrevu = false;
    if (typeof document !== "undefined") planifierColoration(document);
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(balayer, { timeout: 300 });
  else setTimeout(balayer, 50);
}
