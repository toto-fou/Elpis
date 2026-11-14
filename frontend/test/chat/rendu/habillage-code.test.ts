// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/habillage-code.test.ts — habillage des blocs de code : même HTML sur les trois chemins, commandes forgées inertes, Copier et Aperçu lus au clic, langues spéciales exclues. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clicMarkdown, enrichirBlocs } from "../../../src/features/chat/rendu/enrichissement";
import {
  agirSurHabillage,
  ATTRIBUT_ACTION,
  habillerBlocsCode,
} from "../../../src/features/chat/rendu/habillage-code";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import type { MoteurMarkdown } from "../../../src/features/chat/rendu/markdown";

vi.mock("../../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));

let m: MoteurMarkdown;
const ecrits: string[] = [];

beforeEach(() => {
  m = moteurMarkdown();
  ecrits.length = 0;
  vi.stubGlobal("navigator", {
    clipboard: { writeText: (t: string) => Promise.resolve(void ecrits.push(t)) },
  });
  vi.stubGlobal("isSecureContext", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  m.clearMarkdownCache();
});

function monter(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "markdown-body";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const actions = {};

/** Bloc figé par le flux : rendu du texte donné comme un bloc complet. */
const fige = (md: string): string =>
  (moteurMarkdown().terminerFlux(md, null)?.etat.blocs ?? []).map((b) => b.html).join("");

describe("même habillage sur les trois chemins", () => {
  const SOURCE = "x = 1\ny = '<b>'";

  it("fence active, fence figée et rendu final donnent le même HTML", () => {
    const actif = m.renderStreamingActive("```py\n" + SOURCE);
    const fige1 = fige("```py\n" + SOURCE + "\n```\n");
    const final = m.renderMarkdown("```py\n" + SOURCE + "\n```");
    expect(actif.trim()).toBe(final.trim());
    expect(fige1.trim()).toBe(final.trim());
    const hote = monter(final);
    expect(hote.querySelector(".code-wrapper > .copy-sticky > .code-actions > .copy-btn")).not.toBeNull();
    expect(hote.querySelector(".code-wrapper > .code-header > span")?.textContent).toBe("PY");
    expect(hote.querySelector(".code-wrapper > pre code")?.textContent).toBe(SOURCE);
  });

  it("bloc sans langue et bloc HTML : même HTML partout, Aperçu seulement pour HTML", () => {
    for (const [info, label, apercu] of [
      ["", "CODE", false],
      ["html", "HTML", true],
    ] as const) {
      const corps = "<p>salut</p>";
      const actif = m.renderStreamingActive("```" + info + "\n" + corps);
      const final = m.renderMarkdown("```" + info + "\n" + corps + "\n```");
      expect(actif.trim()).toBe(final.trim());
      const hote = monter(final);
      expect(hote.querySelector(".code-header span")?.textContent).toBe(label);
      expect(hote.querySelectorAll(".code-actions button").length).toBe(apercu ? 2 : 1);
      hote.remove();
    }
  });

  it("rendu live d'une réponse : bloc figé et bloc final identiques", () => {
    const texte = "Avant\n\n```js\nconst a = 1;\n```\n\nAprès";
    const live = m.renderMarkdownLive(texte);
    expect(live.replace(/\s+/g, "")).toBe(m.renderMarkdown(texte).replace(/\s+/g, ""));
  });

  it("bloc dans une liste (rendu par le moteur sur le texte de la liste) : habillé aussi", () => {
    const html = m.renderStreamingActive("- étape\n\n  ```sh\n  ls\n  ```\n");
    expect(html).toContain('class="code-wrapper');
    expect(html).toBe(m.renderMarkdown("- étape\n\n  ```sh\n  ls\n  ```\n"));
  });

  it("langue forgée : échappée dans l'en-tête, sans balise ni commande en plus", () => {
    const html = m.renderMarkdown("```<img/src=x/onerror=alert(1)>\ncode\n```");
    const hote = monter(html);
    expect(hote.querySelector("img")).toBeNull();
    expect(hote.querySelectorAll("[" + ATTRIBUT_ACTION + "]").length).toBe(1);
    const html2 = m.renderStreamingActive('```"><img/src=x/onerror=alert(1)>\ncode');
    const hote2 = monter(html2);
    expect(hote2.querySelector("img")).toBeNull();
    expect(hote2.querySelectorAll("[" + ATTRIBUT_ACTION + "]").length).toBe(1);
  });

  it("caret de flux : placé au bout du code, dans le bloc habillé", () => {
    const html = m.injecterCaret(m.renderStreamingActive("```py\nx = 1"));
    expect(html).toMatch(
      /x = 1<span class="elpis-stream-caret" aria-hidden="true"><\/span><\/code><\/pre><\/div>$/,
    );
  });
});

describe("langues spéciales : pas d'habillage, traitement inchangé", () => {
  const SPECIALES = ["mermaid", "svg", "chart-ref", "elpis-skin", "Mermaid"];

  it.each(SPECIALES)("%s : bloc nu sur les trois chemins", (langue) => {
    const corps = langue === "svg" ? '<svg xmlns="http://www.w3.org/2000/svg"></svg>' : "contenu";
    for (const html of [
      m.renderStreamingActive("```" + langue + "\n" + corps),
      fige("```" + langue + "\n" + corps + "\n```\n"),
      m.renderMarkdown("```" + langue + "\n" + corps + "\n```"),
    ]) {
      expect(html).not.toContain("code-wrapper");
      expect(html).not.toContain(ATTRIBUT_ACTION);
      expect(html).toContain("<pre><code");
    }
  });

  it.each(["", "xml", "html", "plaintext"])(
    "code qui ressemble à du SVG (langue « %s ») : bloc nu",
    (langue) => {
      const corps = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
      expect(m.renderMarkdown("```" + langue + "\n" + corps + "\n```")).not.toContain("code-wrapper");
      expect(m.renderStreamingActive("```" + langue + "\n" + corps)).not.toContain("code-wrapper");
    },
  );

  it("le bloc nu devient toujours une carte à l'enrichissement", () => {
    const hote = monter(
      m.renderMarkdown('```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n```'),
    );
    enrichirBlocs(hote);
    expect(hote.querySelector(".svg-render")).not.toBeNull();
    expect(hote.querySelector("pre")).toBeNull();
    const hote2 = monter(m.renderMarkdown('```\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n```'));
    enrichirBlocs(hote2);
    expect(hote2.querySelector(".svg-render")).not.toBeNull();
    expect(hote2.querySelector(".code-wrapper")).toBeNull();
  });

  it("un bloc ordinaire n'est plus reconstruit : enrichirBlocs le laisse tel quel, sans doublon", () => {
    const hote = monter(m.renderMarkdown("```py\nx\n```"));
    const pre = hote.querySelector("pre");
    const enveloppe = hote.querySelector(".code-wrapper");
    enrichirBlocs(hote);
    enrichirBlocs(hote);
    expect(hote.querySelectorAll(".code-wrapper").length).toBe(1);
    expect(hote.querySelector(".code-wrapper")).toBe(enveloppe);
    expect(hote.querySelector("pre")).toBe(pre);
    expect(hote.querySelectorAll(".copy-btn").length).toBe(1);
  });
});

describe("balisage forgé par le modèle : aucune commande ne fonctionne", () => {
  const FORGE =
    '<div class="code-wrapper relative group mb-4"><div class="copy-sticky"><div class="code-actions">' +
    '<button class="copy-btn" elpis-act="copier" data-act="copier" onclick="window.__xss=1" type="button">Copier</button>' +
    '<button elpis-act="apercu" data-act="apercu">Aperçu</button></div></div>' +
    '<div class="code-header">HTML</div><div>contenu secret</div></div>';

  function cliquer(cible: Element): MouseEvent {
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    cible.dispatchEvent(ev);
    return ev;
  }

  it("la purification retire l'attribut de commande, le moteur n'en pose aucun sans bloc de code", () => {
    const hote = monter(m.renderMarkdown("Avant\n\n" + FORGE + "\n\nAprès"));
    expect(hote.querySelector(".code-wrapper")).not.toBeNull();
    expect(hote.querySelector("[" + ATTRIBUT_ACTION + "]")).toBeNull();
    expect(hote.querySelector("[onclick]")).toBeNull();
  });

  it("cliquer les faux boutons : rien n'est copié, aucun aperçu, clic non consommé", () => {
    const hote = monter(m.renderMarkdown(FORGE));
    for (const bouton of hote.querySelectorAll("button")) {
      const ev = cliquer(bouton);
      expect(agirSurHabillage(ev)).toBe(false);
      clicMarkdown(ev, actions);
    }
    expect(ecrits).toEqual([]);
    expect(hote.querySelector("iframe")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("à côté d'un vrai bloc : seule la commande du moteur agit, sur son propre texte", () => {
    const hote = monter(m.renderMarkdown(FORGE + "\n\n```py\nvrai = 1\n```"));
    const boutons = [...hote.querySelectorAll("button")];
    expect(boutons.length).toBe(3);
    for (const b of boutons) cliquer(b);
    expect(ecrits).toEqual(["vrai = 1"]);
    expect(hote.querySelectorAll("[" + ATTRIBUT_ACTION + "]").length).toBe(1);
  });

  it("un faux bloc `pre` enveloppé de faux habillage ne reçoit pas de commande qui lirait un autre texte", () => {
    const forge =
      '<div class="code-wrapper"><button class="copy-btn" elpis-act="copier">Copier</button>' +
      '<pre><code class="language-html" data-act="copier">&lt;i&gt;a&lt;/i&gt;</code></pre></div>';
    const hote = monter(m.renderMarkdown(forge));
    const faux = hote.querySelector<HTMLElement>(".code-wrapper > .copy-btn");
    expect(faux?.hasAttribute(ATTRIBUT_ACTION)).toBe(false);
    if (faux) cliquer(faux);
    expect(ecrits).toEqual([]);
  });

  it("langue de fence forgée pour injecter la commande : une seule commande, celle du moteur", () => {
    const html = m.renderMarkdown('```python"elpis-act="copier\ncode\n```');
    const hote = monter(html);
    expect(hote.querySelectorAll("code[" + ATTRIBUT_ACTION + "]").length).toBe(0);
    expect(hote.querySelectorAll("[" + ATTRIBUT_ACTION + "]").length).toBe(1);
  });

  it("le texte d'un bloc est lu sans ses balises de coloration : un SVG coloré reste une image, un XML coloré est habillé", () => {
    const colore = (texte: string): string =>
      `<pre><code class="hljs language-xml"><span class="hljs-tag">${texte}</span></code></pre>`;
    const svg = colore("&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot;&gt;&lt;/svg&gt;");
    expect(habillerBlocsCode(svg)).toBe(svg);
    expect(habillerBlocsCode(colore("&lt;note&gt;à faire&lt;/note&gt;"))).toContain("code-wrapper");
  });

  it("l'habillage ne s'applique qu'au HTML déjà produit : du HTML brut non purifié n'est jamais habillé en dehors du moteur", () => {
    const brut = habillerBlocsCode('<pre><code class="language-py">a</code></pre>');
    expect(brut).toContain(ATTRIBUT_ACTION);
    expect(m.renderMarkdown('<pre><code class="language-py" onclick="x()">a</code></pre>')).not.toContain(
      "onclick",
    );
  });
});

describe("Copier et Aperçu lisent le texte au moment du clic", () => {
  function clic(cible: Element): void {
    cible.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  it("Copier pendant que le bloc s'écrit : le texte courant est copié", async () => {
    const hote = monter(m.renderStreamingActive("```py\nx = 1"));
    const copier = hote.querySelector<HTMLElement>(".copy-btn");
    expect(copier).not.toBeNull();
    if (copier) clic(copier);
    await vi.waitFor(() => expect(ecrits).toEqual(["x = 1"]));
    expect(copier?.querySelector(".sr-only")?.textContent).toBe("Copié");
    hote.innerHTML = m.renderStreamingActive("```py\nx = 1\ny = 2\nz = 3");
    clic(hote.querySelector(".copy-btn") as HTMLElement);
    await vi.waitFor(() => expect(ecrits).toEqual(["x = 1", "x = 1\ny = 2\nz = 3"]));
  });

  it("le texte copié est le contenu exact du code, caractères spéciaux compris", async () => {
    const source = '<div class="a">&amp; \'x\' "y"</div>\n\ttabulé';
    const hote = monter(m.renderMarkdown("```html\n" + source + "\n```"));
    clic(hote.querySelector(".copy-btn") as HTMLElement);
    await vi.waitFor(() => expect(ecrits).toEqual([source]));
  });

  it("après coloration, le texte copié est inchangé", async () => {
    const hote = monter(m.renderMarkdown("```py\nx = 1\n```"));
    const code = hote.querySelector("code") as HTMLElement;
    code.innerHTML = '<span class="hljs-attr">x</span> = <span class="hljs-number">1</span>';
    clic(hote.querySelector(".copy-btn") as HTMLElement);
    await vi.waitFor(() => expect(ecrits).toEqual(["x = 1"]));
  });

  it("repli sans presse-papiers sécurisé : copie par zone de texte", async () => {
    vi.stubGlobal("isSecureContext", false);
    const copie = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = copie;
    const hote = monter(m.renderMarkdown("```\nabc\n```"));
    clic(hote.querySelector(".copy-btn") as HTMLElement);
    await vi.waitFor(() => expect(copie).toHaveBeenCalledWith("copy"));
    expect(ecrits).toEqual([]);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("Aperçu : iframe isolée à la place du code, retour au code au second clic", () => {
    const hote = monter(m.renderMarkdown("```html\n<b>x</b>\n```"));
    const apercu = hote.querySelector<HTMLElement>(".code-actions button:not(.copy-btn)") as HTMLElement;
    clic(apercu);
    const cadre = hote.querySelector("iframe");
    expect(cadre?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(hote.querySelector<HTMLElement>("pre")?.style.display).toBe("none");
    expect(apercu.textContent).toBe("Code");
    expect(apercu.title).toBe("Revenir au code");
    clic(apercu);
    expect(hote.querySelector("iframe")).toBeNull();
    expect(hote.querySelector<HTMLElement>("pre")?.style.display).toBe("");
    expect(apercu.textContent).toBe("Aperçu");
  });

  it("clic traité une fois : la délégation du conteneur et celle du document ne se cumulent pas", async () => {
    const hote = monter(m.renderMarkdown("```\nabc\n```"));
    hote.addEventListener("click", (e) => clicMarkdown(e, actions));
    clic(hote.querySelector(".copy-btn") as HTMLElement);
    await vi.waitFor(() => expect(ecrits).toEqual(["abc"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(ecrits).toEqual(["abc"]);
  });

  it("hors habillage, le clic reste à clicMarkdown (chemin cliquable)", () => {
    const hote = monter('<p><code class="elpis-path-link">src/a.py:3</code></p>');
    const ouverts: string[] = [];
    hote.addEventListener("click", (e) =>
      clicMarkdown(e, {
        ouvrirDansEditeur: (p) => ouverts.push(p),
        analyserChemin: (t) => ({ path: t.split(":")[0] ?? "" }),
      }),
    );
    clic(hote.querySelector("code") as HTMLElement);
    expect(ouverts).toEqual(["src/a.py"]);
  });
});

describe("recherche dans la conversation", () => {
  it("le surlignage ne touche ni l'en-tête ni les commandes de l'habillage", () => {
    const html = m.renderMarkdownHighlight("Voici du code\n\n```python\nprint('code')\n```", "code");
    const hote = monter(html);
    expect(hote.querySelector(".code-header mark")).toBeNull();
    expect(hote.querySelector(".copy-sticky mark")).toBeNull();
    expect(hote.querySelector("pre mark")?.textContent).toBe("code");
    expect(hote.querySelectorAll("[" + ATTRIBUT_ACTION + "]").length).toBe(1);
  });
});
