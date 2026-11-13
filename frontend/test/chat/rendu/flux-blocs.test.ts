// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/flux-blocs.test.ts — découpe du flux par le lexer : les blocs concaténés égalent le rendu complet pour tout corpus et toute taille de morceau, blocs figés stables, liens de référence, reprise d'un texte final qui diffère. */
import * as marked from "marked";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { lireFence, preparerTexte } from "../../../src/features/chat/rendu/flux-blocs";
import type { EtatFlux } from "../../../src/features/chat/rendu/flux-blocs";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import type { MoteurMarkdown } from "../../../src/features/chat/rendu/markdown";
import { CORPUS } from "./corpus-flux";

let m: MoteurMarkdown;

beforeAll(() => {
  m = moteurMarkdown();
});

afterEach(() => m.clearMarkdownCache());

const norm = (h: string): string => h.replace(/\s+/g, " ").replace(/ </g, "<").trim();

interface Diffusion {
  etat: EtatFlux;
  /** Sources des blocs figés à chaque pas : un bloc figé ne change plus jamais. */
  historique: string[][];
}

/** Diffuse `texte` par morceaux de `pas` caractères, puis fige la fin comme le fait `final`. */
function diffuser(texte: string, pas: number): Diffusion {
  let etat: EtatFlux | null = null;
  const historique: string[][] = [];
  for (let n = pas; ; n += pas) {
    const fin = Math.min(n, texte.length);
    etat = m.avancerFlux(texte.slice(0, fin), etat).etat;
    historique.push(etat.blocs.map((b) => b.src));
    if (fin >= texte.length) break;
  }
  const r = m.terminerFlux(texte, etat);
  if (!r) throw new Error("le texte garde ses blocs");
  return { etat: r.etat, historique };
}

const html = (e: EtatFlux): string => e.blocs.map((b) => b.html).join("");

describe("blocs du flux = rendu complet", () => {
  const cas = Object.entries(CORPUS).flatMap(([nom, texte]) =>
    [1, 3, 7, 40].map((pas) => [nom, pas, texte] as const),
  );

  it.each(cas)("%s, morceaux de %i caractères", (_nom, pas, texte) => {
    const { etat, historique } = diffuser(texte, pas);
    expect(norm(html(etat))).toBe(norm(m.renderMarkdown(texte)));
    expect(etat.pos).toBe(preparerTexte(texte).length);
    const finales = etat.blocs.map((b) => b.src);
    for (const figes of historique) expect(figes).toEqual(finales.slice(0, figes.length));
  });

  it("le bloc actif d'un texte complet ne réécrit aucun bloc figé", () => {
    const texte = CORPUS["mixte"] ?? "";
    let etat: EtatFlux | null = null;
    let htmlVus: string[] = [];
    for (let n = 5; n <= texte.length + 4; n += 5) {
      etat = m.avancerFlux(texte.slice(0, n), etat).etat;
      const courant = etat.blocs.map((b) => b.html);
      expect(courant.slice(0, htmlVus.length)).toEqual(htmlVus);
      htmlVus = courant;
    }
  });
});

describe("liens de référence", () => {
  it("une définition qui arrive après des blocs figés les fait re-rendre une fois", () => {
    const texte = "Voir [la doc][d].\n\nUn paragraphe.\n\n[d]: https://exemple.test/doc\n\nFin [d].\n";
    let etat: EtatFlux | null = null;
    const vus: string[] = [];
    for (let n = 1; n <= texte.length; n++) {
      etat = m.avancerFlux(texte.slice(0, n), etat).etat;
      vus.push(etat.blocs[0]?.html ?? "");
    }
    expect(vus[8]).toBe("");
    expect(vus.filter((h) => h !== "" && h !== vus.at(-1)).length).toBe(
      vus.filter((h) => h.includes("[la doc][d]")).length,
    );
    expect(vus.at(-1)).toContain('<a href="https://exemple.test/doc">la doc</a>');
    expect(vus.filter((h, i) => h && h !== vus[i - 1]).length).toBe(2);
  });

  it("une définition vue plus tôt sert au bloc actif et aux blocs suivants", () => {
    const texte = "[d]: https://exemple.test/d\n\nPremier.\n\nVoir [d] ici";
    const r = m.avancerFlux(texte, null);
    expect(r.actifHtml).toContain('<a href="https://exemple.test/d">d</a>');
  });

  it("le bloc actif ne retient pas ses définitions", () => {
    const r = m.avancerFlux("Un.\n\n[d]: https://exemple.test/d", null);
    expect(Object.keys(r.etat.liens)).toEqual([]);
  });
});

describe("découpe", () => {
  it("ne lit que les lignes complètes : `2` reste un paragraphe tant que `2. ` ne l'a pas fait élément de liste", () => {
    const a = m.avancerFlux("1. un\n2", null);
    expect(a.etat.blocs.length).toBe(0);
    expect(a.etat.pos).toBe(0);
    const b = m.avancerFlux("1. un\n2. deux\n\nSuite\n", a.etat);
    expect(b.etat.blocs.map((x) => x.src)).toEqual(["1. un\n2. deux\n\n"]);
    expect(b.actifHtml).toContain("Suite");
  });

  it("une liste lâche reste un seul bloc, sa fence interne comprise", () => {
    const texte = CORPUS["listeLache"] ?? "";
    const { etat } = diffuser(texte, 3);
    expect(etat.blocs.length).toBe(3);
    expect(etat.blocs[1]?.html).toContain("<ol");
    expect(etat.blocs[1]?.html).toContain("code-wrapper");
  });

  it("une fence fermée est figée tout de suite, le texte qui suit n'est jamais du code", () => {
    const r = m.avancerFlux("```py\nx = 1\n```\n\nSuite en cou", null);
    expect(r.etat.blocs.length).toBe(1);
    expect(r.etat.blocs[0]?.html).toContain("code-wrapper");
    expect(r.actifHtml).toBe("<p>Suite en cou</p>\n");
  });

  it("une fence ouverte garde son corps dans le bloc actif sans analyser le texte", () => {
    const r = m.avancerFlux("Avant\n\n```py\nx = 1\n\ny = 2", null);
    expect(r.etat.blocs.map((b) => b.src)).toEqual(["Avant\n\n"]);
    expect(r.actifHtml).toContain("x = 1\n\ny = 2");
    expect(r.actifHtml).toContain("code-header");
  });

  it("un élément HTML laissé ouvert garde avec lui les blocs jusqu'à sa fermeture", () => {
    const texte = CORPUS["html"] ?? "";
    const r = m.avancerFlux(texte.slice(0, texte.indexOf("</details>")), null);
    expect(r.etat.blocs.length).toBe(0);
    const f = diffuser(texte, 4);
    expect(f.etat.blocs[0]?.html).toContain("<details>");
    expect(norm(f.etat.blocs[0]?.html ?? "")).toBe(
      norm(m.renderMarkdown(texte.slice(0, texte.indexOf("Après")))),
    );
  });

  it("les sauts de ligne Windows et les blancs de tête n'altèrent ni les décalages ni le rendu", () => {
    for (const nom of ["sautsDeLigneWindows", "blancsDeTete"]) {
      const texte = CORPUS[nom] ?? "";
      const { etat } = diffuser(texte, 2);
      expect(norm(html(etat))).toBe(norm(m.renderMarkdown(texte)));
    }
  });

  it("sans ligne complète de plus, les lignes déjà analysées ne sont pas relues", () => {
    const lex = vi.spyOn(marked.Lexer.prototype, "lex");
    try {
      const a = m.avancerFlux("Un.\n\n- a\n- b en cou", null);
      const appels = lex.mock.calls.length;
      const b = m.avancerFlux("Un.\n\n- a\n- b en cours", a.etat);
      expect(lex.mock.calls.length - appels).toBe(1);
      const c = m.avancerFlux("Un.\n\n- a\n- b en cours\n- c", b.etat);
      expect(lex.mock.calls.length - appels).toBe(3);
      expect(c.etat.pos).toBe(b.etat.pos);
    } finally {
      lex.mockRestore();
    }
  });

  it("un très gros bloc actif n'est pas relu à chaque pas", () => {
    const grosse = "- ligne de liste\n".repeat(4000);
    let etat: EtatFlux | null = null;
    const t0 = performance.now();
    for (let n = 40000; n <= grosse.length; n += 100) etat = m.avancerFlux(grosse.slice(0, n), etat).etat;
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(etat?.pos).toBe(0);
  });
});

describe("texte final qui diffère du texte diffusé", () => {
  const diffuse = "Un paragraphe.\n\nUne **liste** :\n\n- a\n- b\n\nUn dernier para";

  function reprise(final: string): { etat: EtatFlux; src: string[] } {
    let etat: EtatFlux | null = null;
    for (let n = 4; n < diffuse.length; n += 4) etat = m.avancerFlux(diffuse.slice(0, n), etat).etat;
    etat = m.avancerFlux(diffuse, etat).etat;
    const r = m.terminerFlux(final, etat);
    if (!r) throw new Error("terminerFlux");
    return { etat: r.etat, src: r.etat.blocs.map((b) => b.src) };
  }

  it("le texte final qui prolonge le texte diffusé réutilise tous les blocs figés", () => {
    const { etat } = reprise(diffuse + " qui continue.\n");
    expect(norm(html(etat))).toBe(norm(m.renderMarkdown(diffuse + " qui continue.\n")));
  });

  it("une divergence tardive garde les blocs de tête et refait la suite", () => {
    const final = "Un paragraphe.\n\nUne **liste** :\n\n- a\n- c\n\nAutre fin\n";
    const { etat } = reprise(final);
    expect(norm(html(etat))).toBe(norm(m.renderMarkdown(final)));
    expect(etat.blocs[0]?.html).toBe(m.renderMarkdown("Un paragraphe.").replace(/\n$/, "\n"));
  });

  it("une divergence dès le début redécoupe tout", () => {
    const final = "# Autre\n\nTexte entièrement différent\n";
    const { etat } = reprise(final);
    expect(norm(html(etat))).toBe(norm(m.renderMarkdown(final)));
    expect(etat.blocs.length).toBe(2);
  });

  it("un texte final plus court que le texte diffusé est redécoupé", () => {
    const { etat } = reprise("Un paragraphe.\n\nUne **li");
    expect(norm(html(etat))).toBe(norm(m.renderMarkdown("Un paragraphe.\n\nUne **li")));
  });

  it("pièces jointes ou texte vide : aucun bloc gardé", () => {
    expect(m.terminerFlux("", null)).toBeNull();
    expect(m.terminerFlux("--- FILE: a.txt ---\nx\n--- END FILE ---\nTexte", null)).toBeNull();
  });
});

describe("reprise sur un texte modifié à n'importe quelle position", () => {
  it.each(Object.entries(CORPUS).filter(([nom]) => !/^(mixte|paragrapheLong|html)/.test(nom)))(
    "%s : le rendu final égale le rendu complet",
    (_nom, texte) => {
      for (let p = 0; p < texte.length; p += 3) {
        let etat: EtatFlux | null = null;
        for (let n = 5; n < texte.length + 5; n += 5) etat = m.avancerFlux(texte.slice(0, n), etat).etat;
        for (const final of [
          texte.slice(0, p) + "X" + texte.slice(p + 1),
          texte.slice(0, p) + texte.slice(p + 2),
          texte.slice(0, p) + " " + texte.slice(p),
        ]) {
          const r = m.terminerFlux(final, etat);
          expect(
            norm(r ? html(r.etat) : ""),
            `${p} ${JSON.stringify(final.slice(Math.max(0, p - 12), p + 12))}`,
          ).toBe(norm(m.renderMarkdown(final)));
        }
      }
    },
  );
});

describe("lireFence", () => {
  it("fence fermée par une ligne complète, ouverte sinon", () => {
    expect(lireFence("```py\nx\n```\nsuite", 0)).toEqual({ fermee: true, fin: 11 });
    expect(lireFence("```py\nx\n```", 0)).toEqual({ fermee: false, fin: -1 });
    expect(lireFence("```py", 0)).toEqual({ fermee: false, fin: -1 });
    expect(lireFence("\n  \n~~~\nx\n~~~\n", 0)).toEqual({ fermee: true, fin: 13 });
  });

  it("la fermeture a au moins la longueur et le caractère de l'ouverture", () => {
    expect(lireFence("````\n```\n````\n", 0)?.fermee).toBe(true);
    expect(lireFence("````\n```\nx\n", 0)?.fermee).toBe(false);
    expect(lireFence("```\n~~~\n", 0)?.fermee).toBe(false);
  });

  it("pas une fence : texte, quatre espaces de retrait, information avec accent grave", () => {
    expect(lireFence("texte\n```\n", 0)).toBeNull();
    expect(lireFence("    ```\ncode\n```\n", 0)).toBeNull();
    expect(lireFence("```a`b\nx\n```\n", 0)).toBeNull();
    expect(lireFence("``\n", 0)).toBeNull();
  });
});
