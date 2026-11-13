// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/bloc-html.test.ts — directive `v-bloc-html` : un bloc de code qui grandit ou se ferme reçoit ses caractères en fin de nœud texte (même nœud, sélection gardée), repli sur le HTML complet sinon. */
import { createApp, h, nextTick, shallowRef, withDirectives } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { vBlocHtml } from "../../../src/features/chat/rendu/bloc-html";
import type { EtatFlux } from "../../../src/features/chat/rendu/flux-blocs";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(html: string) {
  const etat = shallowRef(html);
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({
    render: () => withDirectives(h("div", { style: "display: contents" }), [[vBlocHtml, etat.value]]),
  });
  app.mount(hote);
  return { el: hote.firstElementChild as HTMLElement, etat };
}

/** HTML du bloc actif pendant le flux (curseur compris), et l'état de découpe. */
function actif(texte: string, etat: EtatFlux | null = null): { html: string; etat: EtatFlux } {
  const m = moteurMarkdown();
  const r = m.avancerFlux(texte, etat);
  return { html: m.injecterCaret(r.actifHtml), etat: r.etat };
}

function referenceDe(html: string): string {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.innerHTML;
}

const texteCode = (el: HTMLElement): Text => el.querySelector("pre > code")?.firstChild as Text;

describe("v-bloc-html", () => {
  it("fence ouverte qui grandit : même nœud texte, caractères ajoutés au bout, DOM égal au HTML complet", async () => {
    let a = actif("```py\nx = 1 < 2");
    const { el, etat } = monter(a.html);
    const noeud = texteCode(el);
    expect(noeud.data).toBe("x = 1 < 2");
    for (const suite of ["\ny = 'a' & \"b\"", "\nz = 3", "\n# fin"]) {
      a = actif(a.etat.texte + suite, a.etat);
      etat.value = a.html;
      await nextTick();
      expect(texteCode(el)).toBe(noeud);
      expect(el.innerHTML).toBe(referenceDe(a.html));
    }
    expect(noeud.data).toBe("x = 1 < 2\ny = 'a' & \"b\"\nz = 3\n# fin");
    expect(el.querySelector(".elpis-stream-caret")?.previousSibling).toBe(noeud);
  });

  it("une sélection faite dans la fence ouverte survit à l'ajout", async () => {
    let a = actif("```js\nconst premier = 1;");
    const { el, etat } = monter(a.html);
    const noeud = texteCode(el);
    const plage = document.createRange();
    plage.setStart(noeud, 6);
    plage.setEnd(noeud, 13);
    expect(plage.toString()).toBe("premier");
    a = actif(a.etat.texte + "\nconst second = 2;", a.etat);
    etat.value = a.html;
    await nextTick();
    expect(texteCode(el)).toBe(noeud);
    expect(plage.toString()).toBe("premier");
  });

  it("la fence se ferme : le bloc figé garde le nœud, perd le curseur, égale le rendu final", async () => {
    const m = moteurMarkdown();
    const a = actif('```py\nx = 1\ny = "deux"');
    const { el, etat } = monter(a.html);
    const noeud = texteCode(el);
    const fin = m.terminerFlux('```py\nx = 1\ny = "deux"\n```\n', a.etat);
    const fige = fin?.etat.blocs[0]?.html ?? "";
    expect(fige).toContain("code-wrapper");
    etat.value = fige;
    await nextTick();
    expect(texteCode(el)).toBe(noeud);
    expect(el.querySelector(".elpis-stream-caret")).toBeNull();
    expect(el.innerHTML).toBe(referenceDe(fige));
  });

  it("repli : texte qui ne prolonge pas, code coloré, prose, entité inconnue", async () => {
    const a = actif("```py\nx = 1");
    const { el, etat } = monter(a.html);
    const noeud = texteCode(el);
    const autre = actif("```py\ny = 2").html;
    etat.value = autre;
    await nextTick();
    expect(texteCode(el)).not.toBe(noeud);
    expect(el.innerHTML).toBe(referenceDe(autre));
    // Coloration passée par là : le nœud suivi n'est plus celui du code.
    const code = el.querySelector("pre > code") as HTMLElement;
    code.setAttribute("data-hl", "1");
    code.innerHTML = '<span class="hljs-built_in">y</span> = 2';
    const suite = actif("```py\ny = 2\nz = 3").html;
    etat.value = suite;
    await nextTick();
    expect(el.innerHTML).toBe(referenceDe(suite));
    // Prose : HTML complet.
    etat.value = "<p>Bonjour</p>";
    await nextTick();
    expect(el.innerHTML).toBe("<p>Bonjour</p>");
    // Entité inconnue dans l'ajout : HTML complet, jamais un texte mal décodé.
    const base = '<pre><code class="hljs">a</code></pre>';
    etat.value = base;
    await nextTick();
    const n0 = texteCode(el);
    etat.value = '<pre><code class="hljs">a&nbsp;b</code></pre>';
    await nextTick();
    expect(texteCode(el)).not.toBe(n0);
    expect(texteCode(el).data).toBe("a b");
  });
});
