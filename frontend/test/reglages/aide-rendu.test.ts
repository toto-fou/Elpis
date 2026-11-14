// SPDX-License-Identifier: MIT
/** frontend/test/reglages/aide-rendu.test.ts — guide de la fenêtre d'aide par morceaux : découpe sans effet sur le rendu, premier morceau posé tout de suite, suite par tranches, diagrammes à l'approche de l'écran, HTML gardé, lien d'ancre sur tout le guide. */
import fs from "node:fs";
import path from "node:path";

import type * as Marked from "marked";
import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModaleAide from "../../src/components/chat/modales/ModaleAide.vue";
import { CLE_MODALES } from "../../src/features/chat/modales/domaine";
import { moteurMarkdown } from "../../src/features/chat/rendu/instance";
import { decouperGuide, monterGuide } from "../../src/features/reglages/aide-rendu";
import type { GuideMonte } from "../../src/features/reglages/aide-rendu";
import { appelsDe, demonter, etat, monter } from "../chat/page/montage";

const marked = vi.hoisted(() => ({ analyses: 0 }));
vi.mock("marked", async (original) => {
  const m = await original<typeof Marked>();
  return {
    ...m,
    parse: (...args: Parameters<typeof m.parse>) => {
      marked.analyses++;
      return m.parse(...args);
    },
  };
});

const RACINE = path.resolve(import.meta.dirname, "../../..");
const lire = (f: string): string => fs.readFileSync(path.join(RACINE, f), "utf8");
const GUIDE = lire("docs/fr/user-guide.md");
const guides: GuideMonte[] = [];

afterEach(() => {
  for (const g of guides.splice(0)) g.detacher();
  vi.unstubAllGlobals();
  demonter();
});

function poser(texte: string): { corps: HTMLElement; guide: GuideMonte } {
  const defilement = document.createElement("div");
  const corps = document.createElement("div");
  corps.className = "markdown-body";
  defilement.appendChild(corps);
  document.body.appendChild(defilement);
  const guide = monterGuide(corps, defilement, texte);
  guides.push(guide);
  return { corps, guide };
}

const sections = (corps: HTMLElement): HTMLElement[] => [
  ...corps.querySelectorAll<HTMLElement>(":scope > section"),
];
const enAttente = (corps: HTMLElement): HTMLElement[] => sections(corps).filter((s) => s.style.height);
// HTML du corps, sections déballées : ce que le rendu d'un bloc aurait posé.
const deballe = (corps: HTMLElement): string => corps.innerHTML.replace(/<\/?section[^>]*>/g, "");
const normalise = (html: string): string => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.innerHTML;
};

describe("découpe du guide", () => {
  it("les morceaux recomposent le texte ; le premier, court, porte le haut, les autres ont au moins la taille demandée", () => {
    for (const f of ["docs/fr/user-guide.md", "docs/user-guide.md", "docs/architecture.md"]) {
      const texte = lire(f);
      const morceaux = decouperGuide(texte);
      expect(morceaux.join(""), f).toBe(texte.replace(/\r\n?/g, "\n"));
      expect(morceaux.length, f).toBeGreaterThan(10);
      expect(morceaux[0]!.length, f).toBeGreaterThanOrEqual(500);
      expect(morceaux[0]!.length, f).toBeLessThan(1500);
      for (const m of morceaux.slice(1, -1)) expect(m.length).toBeGreaterThanOrEqual(2000);
    }
  });

  it("ne coupe ni dans un bloc de code, ni dans une liste, ni avant une ligne en retrait", () => {
    const texte = [
      "# Titre",
      "",
      "```md",
      "",
      "# pas un titre",
      "```",
      "",
      "- un",
      "",
      "- deux",
      "",
      "  suite de deux",
      "",
      "1. premier",
      "",
      "Paragraphe",
      "",
      "## Fin",
      "",
    ].join("\n");
    const morceaux = decouperGuide(texte, 1, 1);
    expect(morceaux).toEqual([
      "# Titre\n\n",
      "```md\n\n# pas un titre\n```\n\n- un\n\n- deux\n\n  suite de deux\n\n1. premier\n\n",
      "Paragraphe\n\n",
      "## Fin\n",
    ]);
  });

  it("du code en ligne en tête de ligne n'ouvre pas de bloc", () => {
    expect(decouperGuide("A\n\n```x``` y\n\n# T\n", 1, 1)).toEqual(["A\n\n", "```x``` y\n\n", "# T\n"]);
  });

  it("un texte à liens de référence reste entier", () => {
    const texte = "# A\n\nVoir [la suite][s].\n\n## B\n\n[s]: https://exemple.org\n";
    expect(decouperGuide(texte, 1, 1)).toEqual([texte]);
  });
});

describe("pose du guide", () => {
  it("même HTML que le rendu d'un bloc, avec la même purification (guide et documentation développeur)", () => {
    for (const texte of [GUIDE, lire("docs/architecture.md")]) {
      const { corps, guide } = poser(texte);
      guide.terminer();
      expect(deballe(corps)).toBe(normalise(moteurMarkdown().renderMarkdown(texte)));
    }
  });

  it("le haut est posé tout de suite, la suite par tranches dans des sections de hauteur réservée", async () => {
    const { corps } = poser(GUIDE);
    expect(corps.querySelector(":scope > h1")?.textContent).toContain("Guide utilisateur");
    const reservees = enAttente(corps);
    expect(reservees.length).toBe(sections(corps).length);
    expect(reservees.every((s) => s.childElementCount === 0 && parseInt(s.style.height) > 0)).toBe(true);
    await vi.waitFor(() => expect(enAttente(corps)).toEqual([]));
    expect(sections(corps).every((s) => s.childElementCount > 0)).toBe(true);
  });

  it("une ouverture suivante reprend le HTML gardé, sans nouvelle analyse", () => {
    const texte = GUIDE + "\n\nVariante gardée.\n";
    poser(texte).guide.terminer();
    const avant = marked.analyses;
    const { corps, guide } = poser(texte);
    guide.terminer();
    expect(marked.analyses).toBe(avant);
    expect(corps.textContent).toContain("Variante gardée.");
  });

  it("detacher arrête les tranches", async () => {
    const { corps, guide } = poser(GUIDE + "\n\nDétaché.\n");
    guide.detacher();
    await new Promise((r) => setTimeout(r, 30));
    expect(enAttente(corps).length).toBe(sections(corps).length);
  });

  it("un diagramme n'est tracé qu'à l'approche de l'écran, et ce morceau passe avant les autres", async () => {
    const observes: Element[] = [];
    let signaler: ((e: Partial<IntersectionObserverEntry>[]) => void) | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (e: Partial<IntersectionObserverEntry>[]) => void) {
          signaler = cb;
        }
        observe(el: Element): void {
          observes.push(el);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const rendus: string[] = [];
    vi.stubGlobal("mermaid", {
      initialize: () => {},
      render: (_id: string, src: string) => {
        rendus.push(src);
        return Promise.resolve({ svg: "<svg></svg>" });
      },
    });
    const bloc = (n: number): string =>
      `## Partie ${n}\n\n${"Texte de la partie. ".repeat(120)}\n\n\`\`\`mermaid\ngraph TD; A${n}-->B${n}\n\`\`\`\n\n`;
    const texte = Array.from({ length: 6 }, (_, i) => bloc(i)).join("");
    const { corps } = poser(texte);
    const cible = sections(corps)[decouperGuide(texte).findIndex((m) => m.includes("A5-->")) - 1];
    signaler!([{ target: cible!, isIntersecting: true }]);
    await vi.waitFor(() => expect(rendus).toEqual(["graph TD; A5-->B5"]));
    expect(cible!.querySelector(".mermaid-render")).not.toBeNull();
    await vi.waitFor(() => expect(enAttente(corps)).toEqual([]));
    expect(corps.querySelectorAll(".mermaid-render").length).toBe(1);
    expect(corps.querySelectorAll("pre > code.language-mermaid").length).toBe(5);
  });
});

describe("fenêtre d'aide", () => {
  it("pose le guide à l'ouverture ; un lien du sommaire pose toute la suite avant de chercher son titre", async () => {
    const dom = etat({ showHelpModal: true, isLoadingReadme: false, helpDoc: "user", readmeContent: GUIDE });
    const hote = monter(ModaleAide, [[CLE_MODALES as InjectionKey<object>, dom]]);
    await nextTick();
    const corps = hote.ownerDocument.querySelector<HTMLElement>('[role="dialog"] .markdown-body')!;
    expect(corps.querySelector(":scope > h1")).not.toBeNull();
    expect(enAttente(corps).length).toBeGreaterThan(0);
    const lien = corps.querySelector<HTMLAnchorElement>(':scope > ul a[href^="#"]')!;
    lien.click();
    expect(enAttente(corps)).toEqual([]);
    expect(appelsDe("handleMarkdownClick").length).toBe(1);
  });
});
