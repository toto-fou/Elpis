// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/markdown.test.ts — moteur Markdown : purification au rendu partiel et final, découpe incrémentale, cache, coloration différée. */
import * as marked from "marked";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { EtatFlux } from "../../../src/features/chat/rendu/flux-blocs";
import { moteurMarkdown, purificateur } from "../../../src/features/chat/rendu/instance";
import { injecterCaret } from "../../../src/features/chat/rendu/markdown";
import type { MoteurMarkdown } from "../../../src/features/chat/rendu/markdown";
import { creerPurificateur } from "../../../src/features/chat/rendu/purification";

let m: MoteurMarkdown;
const hljsGlobal = window as unknown as { hljs?: unknown };

beforeAll(() => {
  m = moteurMarkdown();
});

afterEach(() => {
  delete hljsGlobal.hljs;
  m.clearMarkdownCache();
});

const CHARGES = [
  '<img src=x onerror="alert(1)">',
  "<script>alert(1)</script>",
  '<iframe srcdoc="<b>x</b>"></iframe>',
  "[clic](javascript:alert(1))",
  '<a href="javascript:alert(1)">x</a>',
  '<svg onload="alert(1)"><script>alert(1)</script><circle r="2"/></svg>',
  '<svg><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror="alert(1)">',
  '<div onclick="alert(1)" onmouseover="alert(1)">x</div>',
  '<form action="https://evil.example"><input name=a></form>',
  "<style>body{display:none}</style>",
];

function sansDanger(html: string): void {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const hote = tpl.content;
  expect(hote.querySelector("script, iframe, style, form, object, embed")).toBeNull();
  for (const el of Array.from(hote.querySelectorAll("*"))) {
    for (const at of Array.from(el.attributes)) {
      expect(at.name.startsWith("on"), `${el.tagName} ${at.name}`).toBe(false);
      expect(/^\s*javascript:/i.test(at.value), `${el.tagName} ${at.name}=${at.value}`).toBe(false);
    }
  }
}

describe("purification", () => {
  it.each(CHARGES)("rendu final purifié : %s", (charge) => {
    sansDanger(m.renderMarkdown("Avant\n\n" + charge + "\n\nAprès"));
  });

  it.each(CHARGES)("bloc actif du flux purifié : %s", (charge) => {
    sansDanger(m.renderStreamingActive("Texte " + charge));
    sansDanger((m.terminerFlux(charge, null)?.etat.blocs ?? []).map((b) => b.html).join(""));
    sansDanger(m.renderMarkdownLive("a\n\n" + charge + "\n\nb"));
    sansDanger(m.renderMarkdownLive("a\n\nb " + charge));
  });

  it.each(CHARGES)("recherche surlignée sans réinjection : %s", (charge) => {
    sansDanger(m.renderMarkdownHighlight("alert " + charge, "alert"));
  });

  it("fence en cours : le corps est échappé, la fermeture forgée ne sort pas du bloc", () => {
    const html = m.renderStreamingActive(
      '```html\n</code></pre><img src=x onerror="alert(1)">\n<script>x</script>',
    );
    expect(html.startsWith('<div class="code-wrapper')).toBe(true);
    expect(html).toContain('<code class="hljs language-html">&lt;/code&gt;&lt;/pre&gt;&lt;img');
    sansDanger(html);
  });

  it("langue de fence forgée échappée", () => {
    const html = m.renderStreamingActive('```"><img/src=x/onerror=alert(1)>\ncode');
    sansDanger(html);
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("prose pathologique de plus de 12 000 caractères : texte échappé", () => {
    const html = m.renderStreamingActive("<b>" + "x".repeat(12001) + '<img src=x onerror="alert(1)">');
    expect(html.startsWith('<div style="white-space:pre-wrap">&lt;b&gt;')).toBe(true);
    sansDanger(html);
  });

  it("étiquette de fichier joint échappée", () => {
    const html = m.renderMarkdown(
      "--- FILE: <img src=x onerror=alert(1)>.txt ---\ncontenu\n--- END FILE ---\nTexte",
    );
    expect(html).toContain("ph-paperclip");
    expect(html).not.toContain("contenu");
    sansDanger(html);
  });

  it("image distante remplacée par un lien, image en ligne gardée", () => {
    const html = m.renderMarkdown(
      "![logo](https://tiers.example/p.png?x=secret) ![ok](data:image/png;base64,AAAA)",
    );
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const hote = tpl.content;
    expect(hote.querySelector('img[src^="https://tiers"]')).toBeNull();
    const lien = hote.querySelector<HTMLAnchorElement>("a.elpis-ext-img");
    expect(lien?.getAttribute("href")).toBe("https://tiers.example/p.png?x=secret");
    expect(lien?.textContent).toContain("image externe (tiers.example)");
    expect(hote.querySelector('img[src^="data:image/png"]')).not.toBeNull();
  });

  it("image data: d'un autre type que image : retirée, jamais changée en lien", () => {
    const html = m.renderMarkdown('<img src="data:text/html;base64,PHA+eDwvcD4=" alt="piège"> fin');
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    expect(tpl.content.querySelector('a[href^="data:"], img[src^="data:text"]')).toBeNull();
    expect(tpl.content.textContent).toContain("piège");
  });

  it("lien ouvert dans un autre onglet : jamais d'accès à window.opener", () => {
    const html = m.renderMarkdown('<a href="https://tiers.example/" target="_blank" rel="opener">x</a>');
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    expect(tpl.content.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("style en ligne : hors SVG, seules les propriétés de présentation restent ; dans un SVG, position fixed ramenée à static", () => {
    const html = m.renderMarkdown(
      '<div style="position: fixed; top:0; color: red; background: url(https://tiers/x.png); font-weight: bold">faux dialogue</div>',
    );
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    expect(tpl.content.querySelector("div")?.getAttribute("style")).toBe("color:red;font-weight:bold");
    expect(html).not.toMatch(/position|top\s*:|url\(/);
    const svg = m.renderMarkdown(
      '<svg><rect style="position: fixed; fill: red" width="2" height="2"></rect></svg>',
    );
    expect(svg).toContain("position:static");
    expect(svg).not.toMatch(/position\s*:\s*fixed/);
  });

  it("sans DOMPurify : texte échappé, jamais de HTML brut", () => {
    const sans = creerPurificateur(undefined);
    expect(sans('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(sans(null)).toBe("");
    expect(purificateur()("<b>gras</b>")).toBe("<b>gras</b>");
  });
});

describe("blocs figés : purification explicite", () => {
  const bloc = (md: string): string =>
    (m.terminerFlux(md, null)?.etat.blocs ?? []).map((b) => b.html).join("");

  it("le parseur de marked appelé seul laisse passer le HTML dangereux : le crochet ne s'exécute pas", () => {
    const html = marked.Parser.parse(
      marked.Lexer.lex('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">'),
    );
    expect(html).toContain("<script>");
    expect(html).toContain("onerror");
  });

  it.each(CHARGES)("bloc figé par le flux : %s", (charge) => {
    const texte = "Avant\n\n" + charge + "\n\nAprès\n\nFin";
    const r = m.avancerFlux(texte, null);
    expect(r.etat.blocs.length).toBe(2);
    for (const b of r.etat.blocs) sansDanger(b.html);
    sansDanger(bloc(texte));
    sansDanger(bloc("- liste\n\n  " + charge + "\n\nFin"));
  });

  it("contrôle d'habillage forgé : l'attribut des commandes n'atteint jamais le HTML d'un bloc figé", () => {
    const forge =
      '<button type="button" class="copy-btn" elpis-act="copier">x</button>\n\n<div class="code-wrapper"><div class="copy-sticky"><button elpis-act="apercu">y</button></div></div>';
    const html = bloc(forge + "\n\n```py\nx = 1\n```\n");
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    expect(tpl.content.querySelectorAll("[elpis-act]").length).toBe(1);
    expect(
      tpl.content.querySelector("[elpis-act]")?.closest(".code-wrapper")?.querySelector("pre"),
    ).not.toBeNull();
  });

  it("lien javascript: et image à gestionnaire retirés d'un bloc figé", () => {
    const html = bloc('[clic](javascript:alert(1)) et <img src=x onerror="alert(1)>" alt="a">\n\nSuite\n');
    sansDanger(html);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("un texte déjà vu repasse par le cache par source, sans nouveau rendu", () => {
    const texte = "Un paragraphe **gras**.\n\nUne liste :\n\n- a\n- b\n\nFin\n";
    m.terminerFlux(texte, null);
    const taille = m.tailleCacheBlocs;
    expect(taille).toBeGreaterThanOrEqual(2);
    const encore = m.terminerFlux(texte, null);
    expect(m.tailleCacheBlocs).toBe(taille);
    expect(encore?.etat.blocs.map((b) => b.html).join("")).toBe(m.renderMarkdown(texte));
  });

  it("le cache par source ne sert pas un bloc à crochets quand des liens de référence existent", () => {
    m.terminerFlux("Voir [x].\n\nFin\n", null);
    const avec = m.terminerFlux("[x]: https://exemple.test/x\n\nVoir [x].\n\nFin\n", null);
    expect(avec?.etat.blocs.map((b) => b.html).join("")).toContain('<a href="https://exemple.test/x">x</a>');
  });
});

describe("rendu incrémental", () => {
  it("découpe monotone : le décalage ne recule jamais, un bloc figé ne change plus, jamais de coupe dans une fence", () => {
    const texte = "Titre\n\n```py\na = 1\n\nb = 2\n```\n\nFin du texte";
    let etat: EtatFlux | null = null;
    let pos = 0;
    const figes: string[] = [];
    for (let n = 1; n <= texte.length; n++) {
      etat = m.avancerFlux(texte.slice(0, n), etat).etat;
      expect(etat.pos).toBeGreaterThanOrEqual(pos);
      pos = etat.pos;
      const srcs = etat.blocs.map((b) => b.src);
      expect(srcs.slice(0, figes.length)).toEqual(figes);
      figes.splice(0, figes.length, ...srcs);
    }
    expect(figes).toEqual(["Titre\n\n", "```py\na = 1\n\nb = 2\n```\n"]);
    expect(texte.slice(pos)).toBe("Fin du texte");
  });

  it("blocs figés mis en cache une fois, le delta ne repasse que le bloc actif", () => {
    const prose = "Paragraphe **un**.\n\nParagraphe deux.\n\nTrois.\n\n";
    m.renderMarkdownLive(prose + "en cours");
    const taille = m.tailleCacheBlocs;
    expect(taille).toBe(2);
    for (let i = 0; i < 20; i++) m.renderMarkdownLive(prose + "en cours" + "x".repeat(i));
    expect(m.tailleCacheBlocs).toBe(taille);
    expect(m.renderMarkdown("Paragraphe **un**.")).toBe(m.renderMarkdown("Paragraphe **un**."));
  });

  it("le rendu live converge vers le rendu final pour de la prose", () => {
    const texte = "# Titre\n\nUn *paragraphe*.\n\n- a\n- b";
    expect(m.renderMarkdownLive(texte).replace(/\s+/g, "")).toBe(m.renderMarkdown(texte).replace(/\s+/g, ""));
  });

  it("cache LRU borné à 300 entrées", () => {
    for (let i = 0; i < 320; i++) m.renderMarkdown("ligne " + i);
    expect(m.tailleCache).toBe(300);
  });

  it("le rendu n'appelle jamais highlight.js : code échappé, flux comme rendu final", () => {
    let appels = 0;
    hljsGlobal.hljs = {
      getLanguage: () => true,
      highlight: () => {
        appels++;
        return { value: "<span>x</span>" };
      },
      highlightAuto: () => {
        appels++;
        return { value: "<span>x</span>" };
      },
    };
    const source = "Voici :\n```js\nconst a = 1 < 2;\n```\n\n```\nsans langue\n```\n";
    const final = m.renderMarkdown(source);
    const actif = m.renderStreamingActive("```js\nconst a = 1 < 2;");
    const live = m.renderMarkdownLive(source + "suite");
    expect(appels).toBe(0);
    for (const html of [final, actif, live]) {
      expect(html).not.toContain("<span>x</span>");
      expect(html).not.toContain("hljs-");
    }
    expect(final).toContain('<code class="hljs language-js">const a = 1 &lt; 2;</code>');
    expect(final).toContain('<code class="hljs">sans langue</code>');
  });

  it("chemin en code en ligne rendu cliquable", () => {
    expect(m.renderMarkdown("Voir `src/app.py:12`.")).toContain('class="elpis-path-link"');
  });
});

describe("caret de flux", () => {
  it("injecté dans le dernier bloc de texte ou de code", () => {
    const caret = '<span class="elpis-stream-caret" aria-hidden="true"></span>';
    expect(injecterCaret("<p>abc</p>\n")).toBe("<p>abc" + caret + "</p>");
    expect(injecterCaret("<ul><li>a</li></ul>")).toBe("<ul><li>a" + caret + "</li></ul>");
    expect(injecterCaret('<pre><code class="hljs">x</code></pre>')).toBe(
      '<pre><code class="hljs">x' + caret + "</code></pre>",
    );
    expect(injecterCaret("brut")).toBe("brut" + caret);
    expect(injecterCaret("")).toBe("");
  });
});
