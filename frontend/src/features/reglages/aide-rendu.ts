// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/aide-rendu.ts — guide de la fenêtre d'aide rendu par morceaux : le haut tout de suite, la suite par tranches courtes (la partie proche de l'écran d'abord), diagrammes et coloration à l'approche de l'écran, HTML gardé pour les ouvertures suivantes. */
import * as marked from "marked";

import { escapeHtml } from "../../utils/utils-purs";
import { enrichirBloc } from "../chat/rendu/enrichissement";
import { habillerBlocsCode } from "../chat/rendu/habillage-code";
import { moteurMarkdown } from "../chat/rendu/instance";

/** Taille minimale d'un morceau, en caractères de Markdown : une tranche reste courte, même processeur ralenti. */
const TAILLE_MORCEAU = 2000;
/** Durée d'une tranche de rendu ; au-delà, la suite attend la tranche suivante. */
const TRANCHE_MS = 8;
/** Hauteur réservée par caractère d'un morceau pas encore rendu : la barre de défilement est juste dès l'ouverture. */
const PX_PAR_CARACTERE = 0.3;
/** Un morceau à moins de cette distance de l'écran est rendu et enrichi en priorité. */
const MARGE_APPROCHE = "400px 0px";
const DOCS_GARDES = 2;

const OUVERTURE = /^ {0,3}(`{3,}(?!.*`)|~{3,})/;
const FERMETURE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const TITRE = /^#{1,6}(?:[ \t]|$)/;
const ELEMENT_LISTE = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const DEFINITION_LIEN = /^ {0,3}\[[^\]\n]+\]:/m;

/** Découpe aux seules frontières qui ne changent pas le rendu (hors bloc de code, une ligne sans retrait ni puce après une ligne vide, ou un titre) ; un texte à liens de référence reste entier. */
export function decouperGuide(texte: string, taille = TAILLE_MORCEAU): string[] {
  const src = texte.replace(/\r\n?/g, "\n");
  if (DEFINITION_LIEN.test(src)) return [src];
  const morceaux: string[] = [];
  let debut = 0;
  let fence = "";
  let vide = false;
  for (let i = 0; i < src.length;) {
    const nl = src.indexOf("\n", i);
    const fin = nl === -1 ? src.length : nl;
    const ligne = src.slice(i, fin);
    if (fence) {
      const f = FERMETURE.exec(ligne)?.[1];
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = "";
    } else {
      const coupe = /^\S/.test(ligne) && !ELEMENT_LISTE.test(ligne) && (vide || TITRE.test(ligne));
      if (coupe && i - debut >= taille) {
        morceaux.push(src.slice(debut, i));
        debut = i;
      }
      fence = OUVERTURE.exec(ligne)?.[1] ?? "";
      vide = !ligne.trim();
    }
    i = fin + 1;
  }
  morceaux.push(src.slice(debut));
  return morceaux;
}

// Même `marked` que le chat, configuré pour purifier toute sortie ; hors du cache des messages, que le guide viderait.
function rendreMorceau(md: string): string {
  moteurMarkdown();
  try {
    const html = marked.parse(md);
    return typeof html === "string" ? habillerBlocsCode(html) : escapeHtml(md);
  } catch {
    return escapeHtml(md);
  }
}

interface Rendu {
  morceaux: string[];
  html: (string | undefined)[];
}

const rendus = new Map<string, Rendu>();

function renduDe(texte: string): Rendu {
  let r = rendus.get(texte);
  rendus.delete(texte);
  if (!r) {
    const morceaux = decouperGuide(texte);
    r = { morceaux, html: morceaux.map(() => undefined) };
  }
  rendus.set(texte, r);
  if (rendus.size > DOCS_GARDES) rendus.delete(rendus.keys().next().value as string);
  return r;
}

export interface GuideMonte {
  /** Pose sans attendre les morceaux restants (lien vers un titre plus bas). */
  terminer(): void;
  detacher(): void;
}

/** Pose `texte` dans `corps` (contenu de `defilement`) : premier morceau tout de suite, les suivants dans des sections de hauteur réservée remplies par tranches. */
export function monterGuide(corps: HTMLElement, defilement: HTMLElement, texte: string): GuideMonte {
  const r = renduDe(texte);
  const html = (i: number): string => (r.html[i] ??= rendreMorceau(r.morceaux[i] ?? ""));
  // Premier morceau à plat, comme avant le découpage : les règles « premier enfant » du corps le visent toujours.
  corps.innerHTML = html(0);
  enrichirBloc(corps);
  const sections = r.morceaux.slice(1).map((md) => {
    const s = document.createElement("section");
    s.style.height = Math.round(md.length * PX_PAR_CARACTERE) + "px";
    return s;
  });
  corps.append(...sections);
  const poses = new Set<number>();
  const enrichis = new Set<number>();
  const proches = new Set<number>();
  let suivant = 0;
  let actif = true;
  let annuler: (() => void) | null = null;

  const io =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entrees) => {
            for (const e of entrees) {
              const k = sections.indexOf(e.target as HTMLElement);
              if (e.isIntersecting && !enrichis.has(k)) proches.add(k);
              else proches.delete(k);
            }
            programmer();
          },
          { root: defilement, rootMargin: MARGE_APPROCHE },
        );
  for (const s of sections) io?.observe(s);

  function poser(k: number): void {
    const s = sections[k];
    if (!s || poses.has(k)) return;
    s.innerHTML = html(k + 1);
    s.style.height = "";
    poses.add(k);
    if (!io) enrichir(k);
  }

  function enrichir(k: number): void {
    const s = sections[k];
    if (!s) return;
    enrichis.add(k);
    proches.delete(k);
    io?.unobserve(s);
    enrichirBloc(s);
  }

  // Travail suivant : un morceau proche de l'écran à poser ou enrichir, sinon le premier morceau pas encore posé.
  function etape(): boolean {
    for (const k of proches) {
      if (poses.has(k)) enrichir(k);
      else poser(k);
      return true;
    }
    while (poses.has(suivant)) suivant++;
    if (suivant >= sections.length) return false;
    poser(suivant);
    return true;
  }

  function tranche(): void {
    annuler = null;
    if (!actif) return;
    const debut = performance.now();
    while (etape()) {
      if (performance.now() - debut >= TRANCHE_MS) return programmer();
    }
  }

  function programmer(): void {
    if (annuler || !actif) return;
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(tranche, { timeout: 100 });
      annuler = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(tranche, 0);
      annuler = () => clearTimeout(id);
    }
  }

  programmer();
  return {
    terminer() {
      sections.forEach((_s, k) => poser(k));
    },
    detacher() {
      actif = false;
      annuler?.();
      io?.disconnect();
    },
  };
}
