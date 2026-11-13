// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/flux-blocs-cas.test.ts — cas limites de la découpe du flux : définitions de liens, texte terminé puis prolongé, blocs figés stables, grandes régions, gros bloc actif. */
import * as marked from "marked";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { EtatFlux } from "../../../src/features/chat/rendu/flux-blocs";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import type { MoteurMarkdown } from "../../../src/features/chat/rendu/markdown";

let m: MoteurMarkdown;

beforeAll(() => {
  m = moteurMarkdown();
});

afterEach(() => m.clearMarkdownCache());

const norm = (h: string): string => h.replace(/\s+/g, " ").replace(/ </g, "<").trim();
const html = (e: EtatFlux): string => e.blocs.map((b) => b.html).join("");

function diffuser(texte: string, pas: number, etat: EtatFlux | null = null): EtatFlux | null {
  let e = etat;
  for (let n = Math.min(pas, texte.length); ; n = Math.min(n + pas, texte.length)) {
    e = m.avancerFlux(texte.slice(0, n), e).etat;
    if (n >= texte.length) return e;
  }
}

/** HTML des blocs une fois `final` reçu avec `final`, après la diffusion de `diffuse`. */
function finir(diffuse: string, final: string, pas = 3): string {
  const r = m.terminerFlux(final, diffuser(diffuse, pas));
  return r ? norm(html(r.etat)) : "";
}

describe("définitions de liens de référence", () => {
  it("une définition en tête de message sert encore après une reprise", () => {
    const diffuse = "[d]: https://exemple.test/d\n\nVoir [d].\n\nDeux.\n\nTrois fin";
    const final = "[d]: https://exemple.test/d\n\nVoir [d].\n\nDeux.\n\nTrois FIN\n";
    expect(finir(diffuse, final)).toBe(norm(m.renderMarkdown(final)));
    expect(finir(diffuse, final)).toContain('<a href="https://exemple.test/d">d</a>');
  });

  it("une définition juste après une fence sert encore après une reprise", () => {
    const diffuse = "```\nx\n```\n\n[d]: https://exemple.test/d\n\nVoir [d].\n\nDeux.\n\nTrois fin";
    const final = diffuse.slice(0, -3) + "FIN\n";
    expect(finir(diffuse, final)).toBe(norm(m.renderMarkdown(final)));
  });

  it("un titre de définition sur la ligne suivante n'est ni perdu ni rendu en paragraphe", () => {
    const texte = '[d]: https://exemple.test/d\n"Le titre"\n\nVoir [d].\n';
    expect(finir(texte, texte, 1)).toBe(norm(m.renderMarkdown(texte)));
    expect(finir(texte, texte, 1)).toContain('title="Le titre"');
  });

  it("une définition ne re-rend que les blocs qui citent son étiquette, une fois", () => {
    let texte = "";
    for (let k = 0; k < 30; k++) texte += `Phrase ${k} appuyée par [s${k % 3}].\n\n`;
    const corps = texte;
    texte +=
      "[s0]: https://exemple.test/0\n[s1]: https://exemple.test/1\n[s2]: https://exemple.test/2\n\nFin.\n";
    let etat = diffuser(corps, 7);
    const rendu = vi.spyOn(marked.Parser, "parse");
    let appels = 0;
    try {
      for (let n = corps.length + 7; n < texte.length + 7; n += 7) {
        etat = m.avancerFlux(texte.slice(0, Math.min(n, texte.length)), etat).etat;
        appels++;
      }
      // Un rendu du bloc actif par appel, le dernier paragraphe figé, puis chaque bloc cité une fois.
      expect(rendu.mock.calls.length - appels).toBeLessThanOrEqual(30 + 2);
    } finally {
      rendu.mockRestore();
    }
    const fin = m.terminerFlux(texte, etat);
    expect(norm(fin ? html(fin.etat) : "")).toBe(norm(m.renderMarkdown(texte)));
  });

  it("un bloc qui ne cite aucune étiquette nouvelle garde son objet", () => {
    const texte = "Sans renvoi.\n\nAvec [x] et [y].\n\n[x]: https://exemple.test/x\n\nFin.\n";
    const avant = diffuser(texte.slice(0, texte.indexOf("[x]:")), 4);
    const apres = m.avancerFlux(texte, avant).etat;
    expect(apres.blocs[0]).toBe(avant?.blocs[0]);
    expect(apres.blocs[1]?.html).toContain('<a href="https://exemple.test/x">x</a>');
  });
});

describe("texte terminé puis prolongé (Continuer après Stop ou troncature)", () => {
  // Le message arrêté garde l'état de `terminerFlux` ; la suite prolonge son texte par morceaux.
  function continuer(coupe: string, complet: string): string {
    let etat = m.terminerFlux(coupe, diffuser(coupe, 3))?.etat ?? null;
    for (let n = coupe.length + 3; n < complet.length; n += 3)
      etat = m.avancerFlux(complet.slice(0, n), etat).etat;
    const r = m.terminerFlux(complet, etat);
    return r ? norm(html(r.etat)) : "";
  }

  it("une phrase coupée au milieu d'un mot reste un seul paragraphe", () => {
    const complet = "Intro.\n\nVoici le début de la réponse complète.\n\nFin.\n";
    expect(continuer("Intro.\n\nVoici le début de la répo", complet)).toBe(norm(m.renderMarkdown(complet)));
  });

  it("une fence coupée se poursuit, le texte qui suit n'est pas du code", () => {
    const complet = "Texte\n\n```py\nx = 1\ny = 2\n```\n\nAprès le code, du **texte**.\n\nFin.\n";
    expect(continuer("Texte\n\n```py\nx = 1\n", complet)).toBe(norm(m.renderMarkdown(complet)));
  });

  it("terminer deux fois le même texte rend le même HTML", () => {
    const texte = "Un.\n\n- a\n- b\n\nFin";
    const a = m.terminerFlux(texte, diffuser(texte, 2));
    const b = m.terminerFlux(texte, a?.etat ?? null);
    expect(html(b?.etat ?? a!.etat)).toBe(html(a!.etat));
  });
});

describe("blocs figés stables", () => {
  it("un tableau qui interrompt un paragraphe décide du paragraphe jusqu'à sa deuxième ligne", () => {
    const diffuse = "Para\n| a | b |\n|---|---|\n| 1 | 2 |\n\nFin du texte";
    const final = "Para\n| a | b |\nplus une ligne\n| 1 | 2 |\n\nFin du texte\n";
    expect(finir(diffuse, final)).toBe(norm(m.renderMarkdown(final)));
  });

  it.each([
    ["règle", "Un\n***\n===\n"],
    ["puce en retrait", "Para\n  - puce\nsuite\n---\n"],
    ["balise", "Texte\n<summary>R</summary>\n=====\n"],
  ])("un soulignement qui arrive plus tard fait un titre comme dans le rendu complet (%s)", (_n, texte) => {
    expect(finir(texte, texte, 1)).toBe(norm(m.renderMarkdown(texte)));
  });

  it("un paragraphe suivi d'une fence ou d'une liste est figé tout de suite", () => {
    expect(m.avancerFlux("Voici le code :\n```py\nx", null).etat.blocs.length).toBe(1);
    expect(m.avancerFlux("Intro :\n- a\n- b", null).etat.blocs.length).toBe(1);
  });

  it.each([
    ["fence ouverte en dernière ligne", "Voici le code :\n```\n"],
    ["puce vide en dernière ligne", "Liste :\n\n- "],
  ])("le saut de ligne final compte comme dans le rendu complet (%s)", (_n, texte) => {
    expect(finir(texte, texte, 1)).toBe(norm(m.renderMarkdown(texte)));
  });
});
