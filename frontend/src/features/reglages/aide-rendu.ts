// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/aide-rendu.ts — guide de la fenêtre d'aide : découpe en sections par titre, rendu de la seule section affichée, liens vers un clip (`media/aide/*.webm`) posés en lecteurs chargés à l'approche de l'écran. */
import * as marked from "marked";

import { mouvementReduit } from "../../platform/mouvement";
import { escapeHtml } from "../../utils/utils-purs";
import { enrichirBloc } from "../chat/rendu/enrichissement";
import { habillerBlocsCode } from "../chat/rendu/habillage-code";
import { moteurMarkdown } from "../chat/rendu/instance";

const CLE = /^<!--\s*aide:\s*([a-z0-9-]+)\s*-->\s*$/;
/** Lien d'un clip du guide : seul le nom du fichier compte, le dossier est fixe côté serveur. */
const CLIP = /(?:^|\/)media\/aide\/([a-z0-9-]{1,64}\.webm)$/;
const ROUTE_CLIPS = "/api/help/media/";
/** Un clip à moins de cette distance de l'écran est chargé. */
const MARGE_APPROCHE = "300px 0px";
/** Part d'un clip (ou de l'écran, pour un clip plus haut que lui) à voir pour qu'il joue. */
const PART_VISIBLE = 0.6;
const SECTIONS_GARDEES = 12;

export interface SectionAide {
  /** Ancre du titre, celle des liens `#…` du guide. */
  id: string;
  /** Clé d'ouverture en contexte (`<!-- aide: cle -->` sous le titre), vide sinon. */
  cle: string;
  titre: string;
  /** Titre de premier niveau qui coiffe la section, vide avant le premier. */
  groupe: string;
  md: string;
  /** Ancres des sous-titres de la section, dans l'ordre du texte. */
  ancres: string[];
  /** Titre et texte sans accents ni casse, pour la recherche. */
  recherche: string;
}

interface Jeton {
  type: string;
  raw: string;
  depth?: number;
  text?: string;
}

/** Texte d'un titre Markdown sans son balisage en ligne. */
function texteTitre(brut: string): string {
  return brut
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}

/** Ancre d'un titre, comme celle d'un Markdown publié : casse basse, ponctuation retirée, chaque espace en tiret. */
export function ancreTitre(titre: string): string {
  return texteTitre(titre)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Texte plié pour la recherche : sans accents ni casse. */
export function plier(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Ancre libre pour ce titre : un titre déjà vu prend un suffixe, dans l'ordre du document.
function ancreLibre(titre: string, vues: Map<string, number>): string {
  const base = ancreTitre(titre);
  let ancre = base;
  while (vues.has(ancre)) {
    const n = (vues.get(base) ?? 0) + 1;
    vues.set(base, n);
    ancre = `${base}-${n}`;
  }
  vues.set(ancre, 0);
  return ancre;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLOC_BRUT = /^ {0,3}<(pre|script|style|textarea)\b/i;

// Morceaux du guide, coupés avant un titre de niveau 1 ou 2 qui suit une ligne vide, hors bloc de code, commentaire ou bloc HTML brut : le moteur les lit un par un sans que le résultat change.
function morceaux(texte: string): string[] {
  const sortie: string[] = [];
  let debut = 0;
  let fence = "";
  let fermeture = "";
  let vide = true;
  for (let i = 0; i < texte.length;) {
    const nl = texte.indexOf("\n", i);
    const fin = nl === -1 ? texte.length : nl + 1;
    const ligne = texte.slice(i, fin);
    if (fence) {
      const f = FENCE.exec(ligne)?.[1];
      if (
        f &&
        f[0] === fence[0] &&
        f.length >= fence.length &&
        !ligne.slice(ligne.indexOf(f) + f.length).trim()
      )
        fence = "";
    } else if (fermeture) {
      if (ligne.toLowerCase().includes(fermeture)) fermeture = "";
    } else {
      if (vide && i > debut && /^#{1,2}[ \t]/.test(ligne)) {
        sortie.push(texte.slice(debut, i));
        debut = i;
      }
      fence = FENCE.exec(ligne)?.[1] ?? "";
      const brut = BLOC_BRUT.exec(ligne)?.[1]?.toLowerCase();
      const attendue = brut ? `</${brut}>` : /^ {0,3}<!--/.test(ligne) ? "-->" : "";
      if (attendue && !ligne.toLowerCase().includes(attendue)) fermeture = attendue;
    }
    vide = !ligne.trim();
    i = fin;
  }
  sortie.push(texte.slice(debut));
  return sortie;
}

// Fin de section sans lignes vides ni filets de séparation.
function sansFilets(md: string): string {
  let fin = md.length;
  while (fin > 0) {
    const debut = md.lastIndexOf("\n", fin - 1) + 1;
    const ligne = md.slice(debut, fin).trim();
    if (ligne && !/^(?:-{3,}|\*{3,}|_{3,})$/.test(ligne)) break;
    fin = Math.max(0, debut - 1);
  }
  return md.slice(0, fin).trimEnd();
}

export interface LectureGuide {
  /** Lit le guide pendant `budget` millisecondes au plus ; vrai quand tout est lu. */
  avancer(budget: number): boolean;
  /** Sections lues, à demander une fois la lecture finie. */
  sections(): SectionAide[];
}

/** Lecture du guide en sections, par tranches : une section par titre de niveau 2 (le titre du document est écarté, un titre de niveau 1 nomme le groupe des sections qui le suivent) ; les définitions de liens valent pour toutes. */
export function lireGuide(texte: string): LectureGuide {
  const reste = texte.trim() ? morceaux(texte.replace(/\r\n|\r/g, "\n")) : [];
  const sections: SectionAide[] = [];
  const vues = new Map<string, number>();
  let definitions = "";
  let groupe = "";
  let documentNomme = false;
  let courante: SectionAide | null = null;
  let rang = 0;
  const ouvrir = (titre: string, id: string): SectionAide => {
    const section = { id, cle: "", titre, groupe, md: "", ancres: [], recherche: "" };
    sections.push(section);
    return section;
  };
  // Blocs seuls : le texte en ligne d'une section n'est lu qu'à son affichage.
  const lire = (morceau: string): void => {
    const lecteur = new marked.Lexer();
    const jetons = lecteur.blockTokens(morceau) as Jeton[];
    for (const [nom, l] of Object.entries(lecteur.tokens.links))
      definitions += `[${nom}]: <${l.href}>${l.title ? ` "${l.title.replace(/"/g, '\\"')}"` : ""}\n`;
    for (const j of jetons) {
      if (j.type === "heading" && (j.depth === 1 || j.depth === 2)) {
        const titre = texteTitre(j.text ?? "");
        const id = ancreLibre(titre, vues);
        if (j.depth === 1) {
          if (documentNomme) groupe = titre;
          documentNomme = true;
          courante = null;
        } else {
          courante = ouvrir(titre, id);
          courante.md = j.raw;
        }
        continue;
      }
      if (!courante) {
        if (j.type === "space" || j.type === "hr") continue;
        courante = ouvrir(groupe || "Présentation", `_${sections.length}`);
        courante.md = `## ${courante.titre}\n\n`;
      }
      const cle = j.type === "html" ? CLE.exec(j.raw)?.[1] : undefined;
      if (cle) {
        courante.cle ||= cle;
        continue;
      }
      if (j.type === "heading") courante.ancres.push(ancreLibre(j.text ?? "", vues));
      courante.md += j.raw;
    }
  };
  return {
    avancer(budget) {
      if (rang < reste.length) moteurMarkdown();
      const debut = performance.now();
      while (rang < reste.length) {
        lire(reste[rang++]!);
        if (performance.now() - debut >= budget) break;
      }
      if (rang < reste.length) return false;
      if (rang === reste.length) {
        rang++;
        for (const s of sections) {
          s.md = sansFilets(s.md);
          s.recherche = plier(s.md);
          if (definitions) s.md += "\n\n" + definitions;
        }
      }
      return true;
    },
    sections: () => sections,
  };
}

/** Sections du guide, lues d'une traite. */
export function decouperGuide(texte: string): SectionAide[] {
  const lecture = lireGuide(texte);
  lecture.avancer(Infinity);
  return lecture.sections();
}

/** Section visée par une clé de contexte, sinon par une ancre (titre de section ou sous-titre). */
export function trouverSection(sections: readonly SectionAide[], cible: string): SectionAide | undefined {
  if (!cible) return undefined;
  const ancre = cible.replace(/^#/, "");
  return (
    sections.find((s) => s.cle === cible) ??
    sections.find((s) => s.id === ancre) ??
    sections.find((s) => s.ancres.includes(ancre))
  );
}

/** Titre de la section posée dans `corps` : son titre, ou le sous-titre d'ancre `ancre`. */
export function titreVise(corps: Element, section: SectionAide, ancre: string): Element | null {
  const rang = section.ancres.indexOf(ancre);
  if (rang < 0) return corps.querySelector(":scope > h2");
  return corps.querySelectorAll(":scope > h3, :scope > h4, :scope > h5, :scope > h6")[rang] ?? null;
}

const rendus = new Map<string, string>();

// Même `marked` que le chat, configuré pour purifier toute sortie ; hors du cache des messages, que le guide viderait.
function rendreSection(md: string): string {
  let html = rendus.get(md);
  if (html !== undefined) return html;
  moteurMarkdown();
  try {
    const sortie = marked.parse(md);
    html = typeof sortie === "string" ? habillerBlocsCode(sortie) : escapeHtml(md);
  } catch {
    html = escapeHtml(md);
  }
  rendus.set(md, html);
  if (rendus.size > SECTIONS_GARDEES) rendus.delete(rendus.keys().next().value as string);
  return html;
}

// Lecteur d'un clip : bouton lecture/pause autour d'une vidéo muette en boucle, légende dessous ; l'adresse n'est posée qu'à l'approche de l'écran.
function lecteur(nom: string, legende: string): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "aide-clip";
  figure.dataset["etat"] = "pause";
  const cadre = document.createElement("button");
  cadre.type = "button";
  cadre.className = "aide-clip-cadre";
  cadre.setAttribute("aria-label", "Lire la démonstration : " + legende);
  cadre.setAttribute("aria-pressed", "false");
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "none";
  video.tabIndex = -1;
  video.dataset["src"] = ROUTE_CLIPS + nom;
  const repere = document.createElement("span");
  repere.className = "aide-clip-repere";
  repere.setAttribute("aria-hidden", "true");
  repere.innerHTML = '<i class="ph ph-play"></i>';
  cadre.append(video, repere);
  const texte = document.createElement("figcaption");
  texte.textContent = legende;
  figure.append(cadre, texte);
  return figure;
}

// Un clip joue quand sa plus grande part est à l'écran : 60 % de lui-même, ou de l'écran s'il est plus haut que lui.
function assezVisible(e: IntersectionObserverEntry): boolean {
  if (!e.isIntersecting) return false;
  if (e.intersectionRatio >= PART_VISIBLE) return true;
  const ecran = e.rootBounds?.height ?? 0;
  return ecran > 0 && e.intersectionRect.height >= PART_VISIBLE * ecran;
}

// Remplace chaque paragraphe fait d'un seul lien vers un clip par son lecteur (retiré si le clip manque ou n'est pas lu par ce navigateur) ; rend l'arrêt de l'observation.
function poserClips(corps: HTMLElement, defilement: HTMLElement): () => void {
  const figures: HTMLElement[] = [];
  for (const a of Array.from(corps.querySelectorAll<HTMLAnchorElement>("p > a[href$='.webm']"))) {
    const p = a.parentElement;
    const nom = CLIP.exec(a.getAttribute("href") ?? "")?.[1];
    if (!p || !nom || (p.textContent ?? "").trim() !== (a.textContent ?? "").trim()) continue;
    const figure = lecteur(nom, (a.textContent ?? "").trim());
    p.replaceWith(figure);
    figures.push(figure);
  }
  if (!figures.length) return () => {};
  const video = (f: Element): HTMLVideoElement => f.querySelector("video")!;
  const charger = (f: HTMLElement): void => {
    const v = video(f);
    if (v.getAttribute("src") || !v.dataset["src"]) return;
    v.preload = "auto";
    v.src = v.dataset["src"];
  };
  // L'adresse est posée avant la lecture : la poser après annulerait la lecture demandée.
  const lire = (f: HTMLElement): void => {
    charger(f);
    void video(f)
      .play()
      .catch(() => {});
  };
  for (const f of figures) {
    const v = video(f);
    const bouton = f.querySelector("button")!;
    // L'état suit la vidéo elle-même : une pause décidée par le navigateur (onglet caché) se voit aussi.
    const suivre = (): void => {
      f.dataset["etat"] = v.paused ? "pause" : "lecture";
      bouton.setAttribute("aria-pressed", v.paused ? "false" : "true");
    };
    v.addEventListener("play", suivre);
    v.addEventListener("pause", suivre);
    v.addEventListener("error", () => f.remove());
    bouton.addEventListener("click", () => {
      if (v.paused) {
        delete f.dataset["arret"];
        lire(f);
      } else {
        f.dataset["arret"] = "1";
        v.pause();
      }
    });
  }
  const liberer = (): void => {
    for (const f of figures) {
      const v = video(f);
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
  };
  if (typeof IntersectionObserver === "undefined") {
    for (const f of figures) charger(f);
    return liberer;
  }
  const proches = new IntersectionObserver(
    (entrees) => {
      for (const e of entrees) if (e.isIntersecting) charger(e.target as HTMLElement);
    },
    { root: defilement, rootMargin: MARGE_APPROCHE },
  );
  const visibles = new IntersectionObserver(
    (entrees) => {
      for (const e of entrees) {
        const f = e.target as HTMLElement;
        if (!assezVisible(e)) video(f).pause();
        else if (!mouvementReduit() && !f.dataset["arret"]) lire(f);
      }
    },
    { root: defilement, threshold: [0, PART_VISIBLE] },
  );
  for (const f of figures) {
    proches.observe(f);
    visibles.observe(f);
  }
  return () => {
    proches.disconnect();
    visibles.disconnect();
    liberer();
  };
}

/** Lance `f` dans la tâche suivante. */
export function tacheSuivante(f: () => void): void {
  setTimeout(f, 0);
}

/** Lance `f` dans une tâche à part, après la prochaine peinture de la page : un travail lourd ne retarde pas ce qui vient de s'afficher. */
export function apresPeinture(f: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(f, 0));
  else setTimeout(f, 0);
}

export interface SectionMontee {
  detacher(): void;
}

/** Pose une section dans `corps` (contenu de `defilement`) : Markdown purifié, code coloré, clips en lecteurs. */
export function monterSection(corps: HTMLElement, defilement: HTMLElement, md: string): SectionMontee {
  corps.innerHTML = rendreSection(md);
  enrichirBloc(corps);
  return { detacher: poserClips(corps, defilement) };
}
