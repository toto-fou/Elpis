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
