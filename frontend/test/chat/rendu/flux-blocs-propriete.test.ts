// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/flux-blocs-propriete.test.ts — propriété aléatoire : un Markdown tiré au hasard, diffusé par morceaux de tailles aléatoires puis terminé (tel quel ou modifié), rend le même HTML que le rendu complet. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { EtatFlux } from "../../../src/features/chat/rendu/flux-blocs";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import type { MoteurMarkdown } from "../../../src/features/chat/rendu/markdown";

let m: MoteurMarkdown;

beforeAll(() => {
  m = moteurMarkdown();
});

afterEach(() => m.clearMarkdownCache());

// Commentaires HTML retirés : DOMPurify garde ou non un commentaire selon ce qu'il a purifié avant (sondes à état), et ils ne s'affichent pas.
const norm = (h: string): string =>
  h
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/ </g, "<")
    .trim();
const html = (e: EtatFlux): string => e.blocs.map((b) => b.html).join("");
const CAS = 250;

/** Générateur pseudo-aléatoire reproductible (xorshift32). */
function alea(graine: number): () => number {
  let s = graine >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const LIGNES = [
  "Paragraphe avec *em* et **gras** et [ref][r].",
  "Suite du paragraphe `code` ici.",
  "",
  "",
  "   ",
  "\t",
  "- puce",
  "- puce deux",
  "  - sous-puce",
  "    - sous-sous",
  "* autre",
  "1. un",
  "2. deux",
  "10) dix",
  "   continuation indentée",
  "> citation",
  ">",
  "> - puce citée",
  "> ```",
  "```js",
  "```",
  "~~~",
  "````",
  "let a = 1;",
  "    code indenté",
  "\tcode tab",
  "Titre",
  "=====",
  "-----",
  "---",
  "***",
  "# Titre 1",
  "### Titre 3",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "<details>",
  "<summary>Résumé</summary>",
  "</details>",
  "<div>",
  "</div>",
  "<!-- commentaire -->",
  "<br>",
  "[r]: https://exemple.test/r",
  '[r]: https://exemple.test/r "Titre"',
  "[s]: https://exemple.test/s",
  '"Titre seul"',
  "Voir [s] et [r].",
  "- [ ] tâche",
  "- [x] faite",
  "Texte <span>en ligne</span> fin.",
  "2",
  "3. trois",
  "\\# pas un titre",
  "https://auto.test/lien",
];

function generer(r: () => number): string {
  const n = 3 + Math.floor(r() * 22);
  const lignes: string[] = [];
  for (let i = 0; i < n; i++) lignes.push(LIGNES[Math.floor(r() * LIGNES.length)] ?? "");
  const sep = r() < 0.15 ? "\r\n" : "\n";
  return lignes.join(sep) + (r() < 0.6 ? sep : "");
}

function diffuser(texte: string, r: () => number): EtatFlux | null {
  let etat: EtatFlux | null = null;
  for (let n = 0; n < texte.length;) {
    n = Math.min(texte.length, n + 1 + Math.floor(r() * (r() < 0.5 ? 4 : 40)));
    etat = m.avancerFlux(texte.slice(0, n), etat).etat;
  }
  return etat;
}

function rendu(texte: string, etat: EtatFlux | null): string {
  const r = m.terminerFlux(texte, etat);
  return norm(r ? html(r.etat) : "");
}

describe("propriété aléatoire : blocs du flux = rendu complet", () => {
  it(`fin normale, ${CAS} textes`, { timeout: 60_000 }, () => {
    const base = Number(process.env["GRAINE"] ?? 12345);
    for (let k = 0; k < CAS; k++) {
      const r = alea(base + k);
      const texte = generer(r);
      const etat = diffuser(texte, r);
      expect(rendu(texte, etat), `graine ${base + k} ${JSON.stringify(texte)}`).toBe(
        norm(m.renderMarkdown(texte)),
      );
    }
  });

  it(`texte final modifié, raccourci ou prolongé, ${CAS} textes`, { timeout: 60_000 }, () => {
    const base = Number(process.env["GRAINE"] ?? 777);
    for (let k = 0; k < CAS; k++) {
      const r = alea(base + k);
      const texte = generer(r);
      const etat = diffuser(texte, r);
      const p = Math.floor(r() * texte.length);
      const choix = r();
      const final =
        choix < 0.25
          ? texte.slice(0, p) + "X" + texte.slice(p + 1)
          : choix < 0.5
            ? texte.slice(0, p)
            : choix < 0.75
              ? texte.slice(0, p) + "\n" + generer(r)
              : texte + generer(r);
      const attendu = final.trim() ? norm(m.renderMarkdown(final)) : "";
      expect(
        rendu(final, etat),
        `graine ${base + k} ${JSON.stringify(texte)} → ${JSON.stringify(final)}`,
      ).toBe(attendu);
    }
  });

  it(`texte terminé puis prolongé (Continuer), ${CAS} textes`, { timeout: 60_000 }, () => {
    const base = Number(process.env["GRAINE"] ?? 4242);
    for (let k = 0; k < CAS; k++) {
      const r = alea(base + k);
      const texte = generer(r) + generer(r);
      const coupe = texte.slice(0, 1 + Math.floor(r() * (texte.length - 1)));
      if (!coupe.trim()) continue;
      let etat = m.terminerFlux(coupe, diffuser(coupe, r))?.etat ?? null;
      for (let n = coupe.length; n < texte.length;) {
        n = Math.min(texte.length, n + 1 + Math.floor(r() * 20));
        etat = m.avancerFlux(texte.slice(0, n), etat).etat;
      }
      expect(
        rendu(texte, etat),
        `graine ${base + k} ${JSON.stringify(coupe)} → ${JSON.stringify(texte)}`,
      ).toBe(norm(m.renderMarkdown(texte)));
    }
  });
});
