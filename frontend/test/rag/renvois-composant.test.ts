// SPDX-License-Identifier: MIT
/** frontend/test/rag/renvois-composant.test.ts — ContenuMarkdown avec renvois [n] : pastilles à la fin et pendant le flux, rien dans le code ni les liens, survol, focus, clic, pastille pleine pour la source ouverte, renvoi inconnu qui devient connu. */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ContenuMarkdown from "../../src/components/chat/ContenuMarkdown.vue";
import type { MessageMarkdown } from "../../src/components/chat/ContenuMarkdown.vue";
import type { AffichageBlocs } from "../../src/features/chat/rendu/porteur-flux";
import { poserPastilles } from "../../src/features/rag/renvois";
import type { RenvoisMessage } from "../../src/features/rag/renvois";
import type * as Renvois from "../../src/features/rag/renvois";
import { source } from "./aides-sources";

vi.mock("../../src/features/rag/renvois", async (origine) => {
  const m = await origine<typeof Renvois>();
  return { ...m, poserPastilles: vi.fn(m.poserPastilles) };
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const TEXTE =
  "Générez la demande [1], importez-la [2].\n\nExemple : `liste[1]` et [un lien [1]](https://exemple.fr).\n\n```\nx = a[1]\n```\n\nRenvoi perdu [9].";

function fabrique(connues: Map<number, ReturnType<typeof source>>) {
  const courante = shallowRef<number | null>(null);
  const r: RenvoisMessage = {
    resoudre: (n) => connues.get(n) ?? null,
    survol: vi.fn(),
    sortie: vi.fn(),
    ouvrir: vi.fn(),
    courante: () => courante.value,
  };
  return { r, courante };
}

function monter(msg: MessageMarkdown, r: RenvoisMessage | null) {
  const etat = shallowRef(msg);
  const rn = shallowRef(r);
  const clics: MouseEvent[] = [];
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({
    render: () =>
      h(ContenuMarkdown, {
        msg: etat.value,
        renvois: rn.value,
        onClickMarkdown: (e: MouseEvent) => clics.push(e),
      }),
  });
  app.mount(hote);
  return { hote, etat, rn, clics };
}

const MSG: MessageMarkdown = { content: TEXTE, isStreaming: false };

describe("ContenuMarkdown : renvois", () => {
  it("pastilles pour les renvois du texte, rien dans le code, le lien et le bloc de code", async () => {
    const { r } = fabrique(
      new Map([
        [1, source(1)],
        [2, source(2)],
      ]),
    );
    const { hote } = monter(MSG, r);
    await nextTick();
    expect([...hote.querySelectorAll("button.rag-cite")].map((b) => b.textContent)).toEqual(["1", "2"]);
    expect(hote.querySelector("code")?.textContent).toBe("liste[1]");
    expect(hote.querySelector("pre")?.textContent).toContain("a[1]");
    expect(hote.querySelector("a")?.textContent).toBe("un lien [1]");
    const inconnu = hote.querySelector(".rag-cite-inconnu");
    expect(inconnu?.textContent).toBe("[9]");
    expect(hote.querySelector("button.rag-cite[data-rag-n='9']")).toBeNull();
  });

  it("sans renvois (hors RAG) : le texte reste du texte", async () => {
    const { hote } = monter(MSG, null);
    await nextTick();
    expect(hote.querySelector(".rag-cite")).toBeNull();
    expect(hote.textContent).toContain("[1]");
  });

  it("survol et focus ouvrent la bulle, la sortie la ferme, le clic ouvre la visionneuse sans toucher aux clics du Markdown", async () => {
    const { r } = fabrique(
      new Map([
        [1, source(1)],
        [2, source(2)],
      ]),
    );
    const { hote, clics } = monter(MSG, r);
    await nextTick();
    const b = hote.querySelector<HTMLElement>("button.rag-cite[data-rag-n='2']") as HTMLElement;
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(r.survol).toHaveBeenCalledWith(2, b);
    b.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    expect(r.sortie).toHaveBeenCalledOnce();
    b.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(r.survol).toHaveBeenCalledTimes(2);
    b.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(r.sortie).toHaveBeenCalledTimes(2);
    b.click();
    expect(r.ouvrir).toHaveBeenCalledWith(2, b);
    expect(clics).toHaveLength(0);
    hote.querySelector("p")?.click();
    expect(clics).toHaveLength(1);
  });

  it("le renvoi inconnu n'ouvre rien ni ne montre de bulle", async () => {
    const { r } = fabrique(new Map());
    const { hote } = monter(MSG, r);
    await nextTick();
    const x = hote.querySelector<HTMLElement>(".rag-cite-inconnu") as HTMLElement;
    x.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    x.click();
    expect(r.survol).not.toHaveBeenCalled();
    expect(r.ouvrir).not.toHaveBeenCalled();
  });

  it("la pastille de la source ouverte est pleine, et suit la visionneuse", async () => {
    const { r, courante } = fabrique(
      new Map([
        [1, source(1)],
        [2, source(2)],
      ]),
    );
    const { hote } = monter(MSG, r);
    await nextTick();
    expect(hote.querySelectorAll("button.rag-cite.is-on")).toHaveLength(0);
    courante.value = 2;
    await nextTick();
    expect([...hote.querySelectorAll("button.rag-cite.is-on")].map((b) => b.textContent)).toEqual(["2"]);
    courante.value = 1;
    await nextTick();
    expect([...hote.querySelectorAll("button.rag-cite.is-on")].map((b) => b.textContent)).toEqual(["1"]);
  });

  it("les sources qui arrivent après le texte transforment un renvoi inconnu en pastille", async () => {
    const connues = new Map<number, ReturnType<typeof source>>();
    const { r } = fabrique(connues);
    const { hote, etat } = monter({ content: "Réponse [1].", isStreaming: false }, r);
    await nextTick();
    expect(hote.querySelector(".rag-cite-inconnu")).not.toBeNull();
    connues.set(1, source(1));
    etat.value = { ...etat.value, rag_sources: [source(1)] };
    await nextTick();
    expect(hote.querySelector(".rag-cite-inconnu")).toBeNull();
    expect(hote.querySelector("button.rag-cite")?.textContent).toBe("1");
  });

  it("pendant le flux, les renvois du bloc actif deviennent aussi des pastilles", async () => {
    const { r } = fabrique(new Map([[1, source(1)]]));
    const { hote } = monter(
      {
        content: "Début.\n\nLe préavis est de 90 jours [1]",
        isStreaming: true,
        _mdBlocks: [{ i: 0, html: "<p>Début.</p>" }],
        _mdActiveHtml: "<p>Le préavis est de 90 jours [1]</p>",
      },
      r,
    );
    await nextTick();
    expect(hote.querySelector("button.rag-cite")?.textContent).toBe("1");
  });
});

describe("ContenuMarkdown : renvois pendant le flux", () => {
  it("pastilles et marquage : seulement les blocs qui viennent d'être figés et le bloc actif", async () => {
    const { r, courante } = fabrique(new Map([[1, source(1)]]));
    const corps = shallowRef<AffichageBlocs>({
      blocs: [{ i: 0, html: "<p>Premier [1].</p>" }],
      actif: "<p>Second [1]</p>",
    });
    const { hote } = monter({ content: "x", isStreaming: true, _flux: { corps } }, r);
    await nextTick();
    const racine = hote.firstElementChild as HTMLElement;
    const wrappers = (): Element[] => [...racine.children];
    expect(hote.querySelectorAll("button.rag-cite").length).toBe(2);
    const poses = vi.mocked(poserPastilles);
    const lectures: Element[] = [];
    const natif = Element.prototype.querySelectorAll;
    const espion = vi.spyOn(Element.prototype, "querySelectorAll").mockImplementation(function (
      this: Element,
      s: string,
    ) {
      if (s === "[data-rag-n]") lectures.push(this);
      return natif.call(this, s);
    } as typeof natif);
    try {
      // Le bloc actif grandit : lui seul est repris.
      poses.mockClear();
      corps.value = { blocs: corps.value.blocs, actif: "<p>Second [1] et la suite</p>" };
      await nextTick();
      expect(poses.mock.calls.map(([b]) => wrappers().indexOf(b))).toEqual([1]);
      expect([...new Set(lectures)].map((b) => wrappers().indexOf(b))).toEqual([1]);
      // Un bloc se fige : lui et le nouveau bloc actif, jamais le premier ni le corps entier.
      poses.mockClear();
      lectures.length = 0;
      corps.value = {
        blocs: [...(corps.value.blocs ?? []), { i: 1, html: "<p>Second [1] et la suite.</p>" }],
        actif: "<p>Troisième</p>",
      };
      await nextTick();
      expect(poses.mock.calls.map(([b]) => wrappers().indexOf(b))).toEqual([1, 2]);
      expect([...new Set(lectures)].map((b) => wrappers().indexOf(b))).toEqual([1, 2]);
    } finally {
      espion.mockRestore();
    }
    // La source ouverte change : tout le corps est marqué.
    courante.value = 1;
    await nextTick();
    expect(hote.querySelectorAll("button.rag-cite.is-on").length).toBe(2);
  });
});
