// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/markdown.ts — moteur Markdown du chat : rendu final en cache LRU, rendu incrémental par blocs pendant le flux. */
import { escapeHtml, looksLikePath } from "../../../utils/utils-purs.ts";
import { reparerFinDeBloc } from "./fin-de-bloc.ts";
import { creerFlux, etatVide, preparerTexte } from "./flux-blocs.ts";
import type { EtatFlux, JetonMarked, Liens, LexeurMarked } from "./flux-blocs.ts";
import { estBlocOrdinaire, habillerBlocsCode, habillerBloc } from "./habillage-code.ts";

interface JetonCode {
  text?: string;
  lang?: string;
}

/** Sous-ensemble de `marked` utilisé : `parse` synchrone, `use` pour le rendu et le crochet de purification, lexer et parseur pour le rendu par blocs. */
export interface Analyseur {
  parse(md: string): string | Promise<string>;
  use(extension: Readonly<Record<string, unknown>>): unknown;
  Renderer: new () => Record<string, unknown>;
  Lexer: new () => LexeurMarked;
  Parser: { parse(jetons: readonly JetonMarked[]): string };
}

export interface DependancesMoteur {
  analyseur: Analyseur | undefined;
  /** Purificateur explicite : le crochet de `marked` ne s'exécute pas quand on appelle le parseur seul. */
  purifier: (html: unknown) => string;
}

export interface ResultatFlux {
  etat: EtatFlux;
  /** HTML du bloc actif, sans caret. */
  actifHtml: string;
}

const CACHE_MAX = 300;
const CACHE_BLOCS_MAX = 600;
const PROSE_MAX = 12000;
const CARET = '<span class="elpis-stream-caret" aria-hidden="true"></span>';
const FICHIER = /---\s*FILE:\s*(.+?)\s*---\r?\n[\s\S]*?---\s*END FILE\s*---/g;

function echapperFlux(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

const OUVRE_FENCE = /^(?:[ \t]*\n)*[ ]{0,3}(?:`{3}|~{3})/;
const CHIFFRES_NUS = /\n[ \t]*\d{1,3}$/;
const FENCE_PARTIELLE: Readonly<Record<string, RegExp>> = {
  "`": /(^|\n)[ \t]*`{1,2}$/,
  "~": /(^|\n)[ \t]*~{1,2}$/,
};
const FERMETURES =
  /<\/(?:p|li|h[1-6]|td|th|blockquote|pre)>(?:\s*<\/(?:ul|ol|li|table|thead|tbody|tr|td|th|blockquote|div)>)*$/i;
const QUEUE_CARET = 4096;

function ouvreFence(md: string): boolean {
  return OUVRE_FENCE.test(md);
}

/** Insère le caret de flux avant la fermeture de niveau texte la plus profonde du dernier bloc ; seule la fin du HTML est lue. */
export function injecterCaret(html: string): string {
  if (!html) return html;
  const s = html.trimEnd();
  let i = -1;
  if (s.endsWith("</code></pre>")) i = s.length - 13;
  else if (s.endsWith("</code></pre></div>")) i = s.length - 19;
  else {
    const debut = Math.max(0, s.length - QUEUE_CARET);
    const m = FERMETURES.exec(debut ? s.slice(debut) : s);
    if (m) i = debut + m.index;
  }
  return i >= 0 ? s.slice(0, i) + CARET + s.slice(i) : s + CARET;
}

/** Corps d'une fence en cours sans fermeture complète ou partielle ni dernier saut de ligne ; seules ses deux dernières lignes sont lues. */
function corpsDeFence(corps: string, car: string): string {
  let e = corps.length;
  while (e > 0 && /\s/.test(corps.charAt(e - 1))) e--;
  const derniere = corps.lastIndexOf("\n", e - 1);
  const w = derniere <= 0 ? 0 : Math.max(0, corps.lastIndexOf("\n", derniere - 1));
  const queue = (w ? corps.slice(w) : corps)
    .replace(/\n?(`{3,}|~{3,})\s*$/, "")
    .replace(FENCE_PARTIELLE[car] ?? FENCE_PARTIELLE["`"]!, "$1")
    .replace(/\n$/, "");
  return w ? corps.slice(0, w) + queue : queue;
}

/** Configure le rendu `marked` partagé : code toujours échappé (la coloration vient après), chemins cliquables, purification de toute sortie. */
export function configurerAnalyseur(analyseur: Analyseur, purifier: (html: unknown) => string): void {
  const renderer = new analyseur.Renderer();
  renderer.code = (jeton: string | JetonCode, langage?: string): string => {
    const texte = typeof jeton === "string" ? jeton : (jeton.text ?? "");
    const brut = (typeof jeton === "string" ? langage : jeton.lang) ?? "";
    const lang = /\S*/.exec(brut)?.[0] ?? "";
    return `<pre><code class="hljs${lang ? " language-" + escapeHtml(lang) : ""}">${escapeHtml(texte)}</code></pre>\n`;
  };
  renderer.codespan = (jeton: string | JetonCode): string => {
    const brut = typeof jeton === "string" ? jeton : (jeton.text ?? "");
    const html = escapeHtml(brut);
    return looksLikePath(brut)
      ? `<code class="elpis-path-link" title="Ouvrir dans l'éditeur">${html}</code>`
      : `<code>${html}</code>`;
  };
  analyseur.use({ renderer, hooks: { postprocess: (html: string) => purifier(html) } });
}

export interface MoteurMarkdown {
  renderMarkdown(text: string | null | undefined): string;
  renderMarkdownHighlight(text: string | null | undefined, query: string | null | undefined): string;
  /** Surligne la requête dans un HTML déjà rendu (blocs d'un message qui a gardé ses blocs). */
  surlignerHtml(html: string, query: string | null | undefined): string;
  renderStreamingActive(md: string, liens?: Liens): string;
  renderMarkdownLive(text: string | null | undefined): string;
  /** Avance la découpe d'un texte en flux ; l'état est repris si `texte` ne prolonge pas le texte sur lequel il repose. */
  avancerFlux(texte: string, etat: EtatFlux | null): ResultatFlux;
  /** Fige aussi le bloc actif ; `null` si le texte ne peut pas garder ses blocs (pièces jointes, texte vide). */
  terminerFlux(texte: string, etat: EtatFlux | null): ResultatFlux | null;
  injecterCaret: typeof injecterCaret;
  clearMarkdownCache(): void;
  readonly tailleCache: number;
  readonly tailleCacheBlocs: number;
}

interface Lru {
  lire(cle: string): string | undefined;
  ecrire(cle: string, v: string): string;
  vider(): void;
  readonly taille: number;
}

function creerLru(max: number): Lru {
  const cache = new Map<string, string>();
  return {
    lire(cle) {
      const v = cache.get(cle);
      if (v === undefined) return undefined;
      cache.delete(cle);
      cache.set(cle, v);
      return v;
    },
    ecrire(cle, v) {
      if (cache.size >= max) {
        const premier = cache.keys().next().value;
        if (premier !== undefined) cache.delete(premier);
      }
      cache.set(cle, v);
      return v;
    },
    vider: () => cache.clear(),
    get taille() {
      return cache.size;
    },
  };
}

/** Moteur unique de la page : ses caches (messages entiers, blocs par source) sont partagés par le legacy et les composants. */
export function creerMoteurMarkdown(dep: DependancesMoteur): MoteurMarkdown {
  const messages = creerLru(CACHE_MAX);
  const blocsCache = creerLru(CACHE_BLOCS_MAX);
  let memoSrc = "";
  let memoHtml = "";

  function analyser(md: string): string | null {
    const a = dep.analyseur;
    if (!a) return null;
    const html = a.parse(md);
    return typeof html === "string" ? habillerBlocsCode(html) : null;
  }

  // Parseur de marked appelé seul : le crochet de purification ne s'exécute pas, la purification est donc explicite.
  function rendreJetons(jetons: readonly JetonMarked[]): string {
    const a = dep.analyseur;
    if (!a) return "";
    return habillerBlocsCode(dep.purifier(a.Parser.parse(jetons)));
  }

  const flux = dep.analyseur
    ? creerFlux({
        nouveauLexeur: () => new (dep.analyseur as Analyseur).Lexer(),
        rendre: rendreJetons,
        lireCache: (cle) => blocsCache.lire(cle),
        ecrireCache: (cle, html) => void blocsCache.ecrire(cle, html),
      })
    : null;

  // Prose du bloc actif : les liens de référence déjà vus servent, ceux du bloc actif ne sont pas retenus.
  function rendreProse(texte: string, liens: Liens | undefined): string | null {
    const a = dep.analyseur;
    if (!a) return null;
    const copie = Object.assign(Object.create(null) as Liens, liens);
    const lx = new a.Lexer();
    lx.tokens.links = copie;
    return rendreJetons(lx.lex(texte));
  }

  function renderMarkdown(text: string | null | undefined): string {
    if (!text) return "";
    const deja = messages.lire(text);
    if (deja !== undefined) return deja;
    try {
      const fichiers = Array.from(text.matchAll(FICHIER), (m) => m[1] ?? "");
      // Blancs de fin gardés comme dans le flux : le dernier saut de ligne décide de la dernière ligne.
      const propre = preparerTexte(text.replace(FICHIER, ""));
      let html = analyser(propre) ?? escapeHtml(propre);
      if (fichiers.length > 0) {
        let tete = '<div class="flex flex-wrap gap-2 mb-3">';
        for (const f of fichiers) {
          tete +=
            '<span class="flex items-center gap-1 bg-blue-50 text-blue-700 px-2.5 py-1 rounded-md border border-blue-200 text-xs font-bold shadow-sm"><i class="ph ph-paperclip"></i> ' +
            escapeHtml(f) +
            "</span>";
        }
        html = tete + "</div>" + html;
      }
      return messages.ecrire(text, html);
    } catch {
      return escapeHtml(text);
    }
  }

  function surlignerHtml(html: string, query: string | null | undefined): string {
    if (!query || query.length < 2) return html;
    const re = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const parcours = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT, {
      acceptNode(noeud) {
        for (let p = noeud.parentNode; p; p = p.parentNode) {
          const tag = (p as Element).tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") return NodeFilter.FILTER_REJECT;
          const cl = (p as Element).classList;
          if (cl?.contains("code-header") || cl?.contains("copy-sticky")) return NodeFilter.FILTER_REJECT;
        }
        re.lastIndex = 0;
        return re.test(noeud.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const touches: Node[] = [];
    for (let n = parcours.nextNode(); n; n = parcours.nextNode()) touches.push(n);
    for (const noeud of touches) {
      const s = noeud.nodeValue ?? "";
      const frag = document.createDocumentFragment();
      let fin = 0;
      re.lastIndex = 0;
      for (let m = re.exec(s); m; m = re.exec(s)) {
        if (m.index > fin) frag.appendChild(document.createTextNode(s.slice(fin, m.index)));
        const mark = document.createElement("mark");
        mark.className = "elpis-search-hl rounded px-0.5";
        mark.textContent = m[0];
        frag.appendChild(mark);
        fin = m.index + m[0].length;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (fin < s.length) frag.appendChild(document.createTextNode(s.slice(fin)));
      noeud.parentNode?.replaceChild(frag, noeud);
    }
    return tpl.innerHTML;
  }

  function renderMarkdownHighlight(
    text: string | null | undefined,
    query: string | null | undefined,
  ): string {
    return surlignerHtml(renderMarkdown(text), query);
  }

  function echapperCorpsFence(corps: string): string {
    const coupe = corps.lastIndexOf("\n") + 1;
    const tete = corps.slice(0, coupe);
    const teteHtml =
      memoSrc && tete.length >= memoSrc.length && tete.startsWith(memoSrc)
        ? memoHtml + echapperFlux(tete.slice(memoSrc.length))
        : echapperFlux(tete);
    memoSrc = tete;
    memoHtml = teteHtml;
    return teteHtml + echapperFlux(corps.slice(coupe));
  }

  function renderStreamingActive(texte: string, liens?: Liens): string {
    const md = texte.replace(/^(?:[ \t]*\n)+/, "");
    if (!md) return "";
    if (ouvreFence(md)) {
      const lead = md.replace(/^\s+/, "");
      const nl = md.indexOf("\n");
      const ouvrant = (nl === -1 ? lead : md.slice(0, nl)).trim();
      const lang = ouvrant.replace(/^(`{3,}|~{3,})\s*/, "").split(/\s+/)[0] ?? "";
      // Ni fermeture partielle ni saut de ligne final : le bloc ne rétrécit pas quand la fence se ferme.
      const corps = corpsDeFence(nl === -1 ? "" : md.slice(nl + 1), lead.charAt(0));
      const cls = "hljs" + (lang ? " language-" + echapperFlux(lang) : "");
      const html = echapperCorpsFence(corps);
      return estBlocOrdinaire(lang.toLowerCase(), () => corps)
        ? habillerBloc(lang, cls, html)
        : '<pre><code class="' + cls + '">' + html + "</code></pre>";
    }
    if (md.length > PROSE_MAX) {
      const fm = /^[ \t]{0,3}(`{3,}|~{3,})/m.exec(md);
      if (fm && fm.index > 0)
        return (
          renderStreamingActive(md.slice(0, fm.index), liens) +
          renderStreamingActive(md.slice(fm.index), liens)
        );
      return '<div style="white-space:pre-wrap">' + echapperFlux(md) + "</div>";
    }
    try {
      return rendreProse(reparerFinDeBloc(md), liens) ?? echapperFlux(md);
    } catch {
      return echapperFlux(md);
    }
  }

  function reprise(t: string, etat: EtatFlux | null): EtatFlux {
    return etat && flux ? flux.reprendre(t, etat) : (etat ?? etatVide());
  }

  // Chiffres seuls sur la ligne inachevée d'un bloc qui a du texte avant : début possible d'un numéro de liste, retenu jusqu'à ce que la suite tranche.
  function sansNumeroNu(actif: string): string {
    const m = CHIFFRES_NUS.exec(actif);
    return m && !ouvreFence(actif) && actif.slice(0, m.index).trim() ? actif.slice(0, m.index) : actif;
  }

  function avancerFlux(texte: string, etat: EtatFlux | null): ResultatFlux {
    const t = preparerTexte(texte);
    const courant = reprise(t, etat);
    if (!flux) return { etat: courant, actifHtml: echapperFlux(t) };
    const r = flux.avancer(t, courant);
    const actif = sansNumeroNu(r.actif);
    return {
      etat: { ...r.etat, source: texte },
      actifHtml: actif.trim() ? renderStreamingActive(actif, r.etat.liens) : "",
    };
  }

  function terminerFlux(texte: string, etat: EtatFlux | null): ResultatFlux | null {
    const t = preparerTexte(texte);
    if (!flux || !t.trim() || texte.search(FICHIER) !== -1) return null;
    const r = flux.terminer(t, reprise(t, etat));
    return { etat: { ...r.etat, source: texte }, actifHtml: "" };
  }

  // Rendu en direct hors du chat (page Code) : la découpe du dernier texte rendu est reprise, seul le nouveau texte est analysé.
  let direct: EtatFlux | null = null;

  function renderMarkdownLive(text: string | null | undefined): string {
    if (!text) return "";
    const r = avancerFlux(text, direct);
    direct = r.etat;
    return r.etat.blocs.map((b) => b.html).join("") + r.actifHtml;
  }

  return {
    renderMarkdown,
    renderMarkdownHighlight,
    surlignerHtml,
    renderStreamingActive,
    renderMarkdownLive,
    avancerFlux,
    terminerFlux,
    injecterCaret,
    clearMarkdownCache: () => {
      messages.vider();
      blocsCache.vider();
      direct = null;
    },
    get tailleCache() {
      return messages.taille;
    },
    get tailleCacheBlocs() {
      return blocsCache.taille;
    },
  };
}
