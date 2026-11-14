// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/prolonger-actif.test.ts — chemin rapide du bloc actif : un ajout de caractères simples inséré avant le curseur donne le même DOM qu'un rendu complet, sur tout le corpus et à toutes les découpes ; refus pour ce qui peut changer le rendu. */
import { describe, expect, it } from "vitest";

import { prolongerActif } from "../../../src/features/chat/coeur/rendu-flux";
import type { EtatFlux } from "../../../src/features/chat/rendu/flux-blocs";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import { CORPUS } from "../rendu/corpus-flux";

const CARET = '<span class="elpis-stream-caret" aria-hidden="true"></span>';

/** DOM d'un HTML, sans les blancs juste avant le curseur (un rendu complet retire ceux de fin de paragraphe). */
function dom(html: string): string {
  const t = document.createElement("template");
  t.innerHTML = html.replace(/\s+(?=<span class="elpis-stream-caret")/, "");
  return t.innerHTML;
}

/** Diffuse `texte` par tranches de `pas` caractères comme le battement : chemin rapide quand il s'applique, rendu sinon. */
function diffuser(texte: string, pas: number): { rapides: number; ecarts: string[] } {
  const m = moteurMarkdown();
  let etat: EtatFlux | null = null;
  let html = "";
  let base = "";
  let rapides = 0;
  const ecarts: string[] = [];
  for (let n = pas; n < texte.length + pas; n += pas) {
    const t = texte.slice(0, Math.min(n, texte.length));
    const rapide = prolongerActif(html, base, t);
    const r = m.avancerFlux(t, etat);
    const complet = m.injecterCaret(r.actifHtml);
    if (rapide !== null) {
      rapides++;
      if (dom(rapide) !== dom(complet)) ecarts.push(JSON.stringify(t.slice(-60)));
      html = rapide;
      base = t;
    } else {
      etat = r.etat;
      html = complet;
      base = /\s$/.test(t) ? "" : t;
    }
  }
  return { rapides, ecarts };
}

describe("prolongerActif", () => {
  it("même DOM qu'un rendu complet, pour tout le corpus et toutes les tailles de tranche", () => {
    let rapides = 0;
    for (const [nom, texte] of Object.entries(CORPUS))
      for (const pas of [1, 4, 9]) {
        const r = diffuser(texte, pas);
        rapides += r.rapides;
        expect(r.ecarts, nom + " / " + pas).toEqual([]);
      }
    expect(rapides).toBeGreaterThan(1000);
  }, 120000);

  it("textes choisis : définition de lien et son titre, tableau, bloc HTML, citation, guillemets, blancs, setext, numéros, liens", () => {
    const CAS: Record<string, string> = {
      tableSansBarre: "| a |\n|---|\n| b |\nsuite de ligne de table",
      defLienTitre: 'Voir [x].\n\n[x]: /url\n"un titre complet"',
      defLienTitreSeul: "[x]: /url\n'un titre qui s'écrit'",
      blocHtmlP: "<p>\nTexte dans un bloc HTML qui grandit",
      citationListe: "> - un élément de liste citée qui grandit encore",
      attributQuote: 'Texte avec guillemets " onmouseover=alert(1) x=" et apostrophes',
      blancsFin: "Un mot   puis d'autres mots   encore",
      titreSetext: "Titre long\npuis du texte",
      numeroPuisTexte: "Liste :\n10) dix éléments ici",
      lienAuto: "Voir le site exemple point org/chemin puis www exemple",
    };
    for (const [nom, texte] of Object.entries(CAS))
      for (const pas of [1, 3]) expect(diffuser(texte, pas).ecarts, nom + " / " + pas).toEqual([]);
  });

  it("insère avant le curseur pour une prose simple, refuse ce qui peut changer le rendu", () => {
    const html = "<p>Bonjour le" + CARET + "</p>";
    expect(prolongerActif(html, "Bonjour le", "Bonjour le monde, ça va ?")).toBe(
      "<p>Bonjour le monde, ça va ?" + CARET + "</p>",
    );
    for (const ajout of [
      " *gras",
      " _x",
      " `code`",
      " [lien]",
      " <b>",
      " a & b",
      "\nSuite",
      " www",
      " https:",
      " a|b",
      " ~x",
    ])
      expect(prolongerActif(html, "Bonjour le", "Bonjour le" + ajout), ajout).toBeNull();
    // Ligne sans lettre (numéro retenu, marqueur nu), ligne d'un tableau, curseur après une balise, bloc de code.
    expect(prolongerActif("<p>Texte" + CARET + "</p>", "Texte\n12", "Texte\n123")).toBeNull();
    expect(prolongerActif("<p>Texte" + CARET + "</p>", "Texte\n| a", "Texte\n| ab")).toBeNull();
    expect(prolongerActif("<p><em>a</em>" + CARET + "</p>", "*a* b", "*a* bc")).toBeNull();
    expect(
      prolongerActif('<pre><code class="hljs">x' + CARET + "</code></pre>", "```\nx", "```\nxy"),
    ).toBeNull();
    // Texte qui ne prolonge pas, base vide (rendu d'un texte fini par un blanc).
    expect(prolongerActif(html, "Bonjour le", "Bonsoir")).toBeNull();
    expect(prolongerActif(html, "", "Bonjour le monde")).toBeNull();
  });
});
