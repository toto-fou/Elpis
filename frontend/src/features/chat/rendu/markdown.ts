// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/markdown.ts — moteur Markdown du chat : rendu final en cache LRU, rendu incrémental par blocs pendant le flux. */
import { escapeHtml, looksLikePath } from "../../../utils/utils-purs.ts";

export interface Coloreur {
  getLanguage(nom: string): unknown;
  highlight(code: string, options: { language: string }): { value: string };
  highlightAuto(code: string): { value: string };
}

interface JetonCode {
  text?: string;
  lang?: string;
}

/** Sous-ensemble de `marked` utilisé : un `parse` synchrone et `use` pour le rendu et le crochet de purification. */
export interface Analyseur {
  parse(md: string): string | Promise<string>;
  use(extension: Readonly<Record<string, unknown>>): unknown;
  Renderer: new () => Record<string, unknown>;
}

export interface DependancesMoteur {
  analyseur: Analyseur | undefined;
}

export interface Decoupe {
  blocks: string[];
  scanPos: number;
  fence: boolean;
  blockStart: number;
}

const CACHE_MAX = 300;
const PROSE_MAX = 12000;
const CARET = '<span class="elpis-stream-caret" aria-hidden="true"></span>';
const FICHIER = /---\s*FILE:\s*(.+?)\s*---\r?\n[\s\S]*?---\s*END FILE\s*---/g;

function echapperFlux(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

function ouvreFence(md: string): boolean {
  const m3 = md.replace(/^\s+/, "").slice(0, 3);
  return m3 === "```" || m3 === "~~~";
}

/** Découpe incrémentale en blocs de premier niveau, sans couper une fence ; coût proportionnel au nouveau texte. */
export function scanStreamBlocks(
  content: string,
  scanPos: number,
  fence: boolean,
  blockStart: number,
): Decoupe {
  const blocks: string[] = [];
  let i = scanPos;
  while (i < content.length) {
    const nl = content.indexOf("\n", i);
    if (nl === -1) break;
    const t = content.slice(i, nl).trim();
    const m3 = t.slice(0, 3);
    if (m3 === "```" || m3 === "~~~") fence = !fence;
    else if (!fence && t === "") {
      const bloc = content.slice(blockStart, nl);
      if (bloc.trim()) blocks.push(bloc);
      blockStart = nl + 1;
    }
    i = nl + 1;
  }
  return { blocks, scanPos: i, fence, blockStart };
}

/** Insère le caret de flux avant la fermeture de niveau texte la plus profonde du dernier bloc. */
export function injecterCaret(html: string): string {
  if (!html) return html;
  const s = html.replace(/\s+$/, "");
  const m =
    /<\/code><\/pre>$/i.exec(s) ??
    /<\/(?:p|li|h[1-6]|td|th|blockquote|pre)>(?:\s*<\/(?:ul|ol|li|table|thead|tbody|tr|td|th|blockquote|div)>)*$/i.exec(
      s,
    );
  return m ? s.slice(0, m.index) + CARET + s.slice(m.index) : s + CARET;
}

/** Configure le rendu `marked` partagé : code échappé ou coloré, chemins cliquables, purification de toute sortie. */
export function configurerAnalyseur(
  analyseur: Analyseur,
  purifier: (html: unknown) => string,
  coloreur: () => Coloreur | undefined,
  colorationCoupee: () => boolean,
): void {
  const renderer = new analyseur.Renderer();
  renderer.code = (jeton: string | JetonCode, langage?: string): string => {
    const texte = typeof jeton === "string" ? jeton : (jeton.text ?? "");
    const brut = (typeof jeton === "string" ? langage : jeton.lang) ?? "";
    const lang = /\S*/.exec(brut)?.[0] ?? "";
    const hljs = coloreur();
    let html: string;
    if (hljs && !colorationCoupee()) {
      try {
        html =
          lang && hljs.getLanguage(lang)
            ? hljs.highlight(texte, { language: lang }).value
            : hljs.highlightAuto(texte).value;
      } catch {
        html = texte;
      }
    } else html = escapeHtml(texte);
    return `<pre><code class="hljs ${lang ? "language-" + lang : ""}">${html}</code></pre>\n`;
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
  renderStreamingActive(md: string): string;
  renderStreamBlock(md: string): string;
  renderMarkdownLive(text: string | null | undefined): string;
  scanStreamBlocks: typeof scanStreamBlocks;
  injecterCaret: typeof injecterCaret;
  clearMarkdownCache(): void;
  colorationCoupee(): boolean;
  readonly tailleCache: number;
}

/** Moteur unique de la page : son cache est partagé par le legacy et les composants. */
export function creerMoteurMarkdown(dep: DependancesMoteur): MoteurMarkdown {
  const cache = new Map<string, string>();
  let sansColoration = false;
  let memoSrc = "";
  let memoHtml = "";

  function analyser(md: string): string | null {
    const a = dep.analyseur;
    if (!a) return null;
    const html = a.parse(md);
    return typeof html === "string" ? html : null;
  }

  function lire(cle: string): string | undefined {
    const v = cache.get(cle);
    if (v === undefined) return undefined;
    cache.delete(cle);
    cache.set(cle, v);
    return v;
  }

  function ecrire(cle: string, v: string): string {
    if (cache.size >= CACHE_MAX) {
      const premier = cache.keys().next().value;
      if (premier !== undefined) cache.delete(premier);
    }
    cache.set(cle, v);
    return v;
  }

  function renderMarkdown(text: string | null | undefined): string {
    if (!text) return "";
    const deja = lire(text);
    if (deja !== undefined) return deja;
    try {
      const fichiers = Array.from(text.matchAll(FICHIER), (m) => m[1] ?? "");
      const propre = text.replace(FICHIER, "").trim();
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
      return ecrire(text, html);
    } catch {
      return escapeHtml(text);
    }
  }

  function renderMarkdownHighlight(
    text: string | null | undefined,
    query: string | null | undefined,
  ): string {
    const html = renderMarkdown(text);
    if (!query || query.length < 2) return html;
    const re = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const parcours = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT, {
      acceptNode(noeud) {
        for (let p = noeud.parentNode; p; p = p.parentNode) {
          const tag = (p as Element).tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") return NodeFilter.FILTER_REJECT;
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

  function renderStreamingActive(md: string): string {
    if (!md) return "";
    if (ouvreFence(md)) {
      const lead = md.replace(/^\s+/, "");
      const nl = md.indexOf("\n");
      const ouvrant = (nl === -1 ? lead : md.slice(0, nl)).trim();
      const lang = ouvrant.replace(/^(`{3,}|~{3,})\s*/, "").split(/\s+/)[0] ?? "";
      const corps = (nl === -1 ? "" : md.slice(nl + 1)).replace(/\n?(`{3,}|~{3,})\s*$/, "");
      const cls = "hljs" + (lang ? " language-" + echapperFlux(lang) : "");
      return '<pre><code class="' + cls + '">' + echapperCorpsFence(corps) + "</code></pre>";
    }
    if (md.length > PROSE_MAX) {
      const fm = /^[ \t]{0,3}(`{3,}|~{3,})/m.exec(md);
      if (fm && fm.index > 0)
        return renderStreamingActive(md.slice(0, fm.index)) + renderStreamingActive(md.slice(fm.index));
      return '<div style="white-space:pre-wrap">' + echapperFlux(md) + "</div>";
    }
    try {
      sansColoration = true;
      return analyser(md) ?? echapperFlux(md);
    } catch {
      return echapperFlux(md);
    } finally {
      sansColoration = false;
    }
  }

  function renderStreamBlock(md: string): string {
    return ouvreFence(md || "") ? renderStreamingActive(md) : renderMarkdown(md);
  }

  function renderMarkdownLive(text: string | null | undefined): string {
    if (!text) return "";
    const r = scanStreamBlocks(text, 0, false, 0);
    let html = "";
    for (const b of r.blocks) html += renderStreamBlock(b);
    const actif = text.slice(r.blockStart);
    if (actif.trim()) html += renderStreamingActive(actif);
    return html;
  }

  return {
    renderMarkdown,
    renderMarkdownHighlight,
    renderStreamingActive,
    renderStreamBlock,
    renderMarkdownLive,
    scanStreamBlocks,
    injecterCaret,
    clearMarkdownCache: () => cache.clear(),
    colorationCoupee: () => sansColoration,
    get tailleCache() {
      return cache.size;
    },
  };
}
