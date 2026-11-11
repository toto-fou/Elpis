// SPDX-License-Identifier: MIT
/** frontend/test/editor/arbre.test.ts — arbre de fichiers : état partagé (dépli mémorisé par compte, sélection, cibles, pastilles Git), chemins glissés et composant ElementArbre (clic, sélection, clavier, glisser-déposer). */
import { createApp, h, nextTick } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ElementArbre from "../../src/components/editor/ElementArbre.vue";
import { ancetres, arbre, cheminsGlisses, creerArbre, MIME_GLISSER } from "../../src/features/editor/arbre";
import { metaFichier } from "../../src/features/editor/meta-fichier";
import type { NoeudArbre } from "../../src/features/editor/schemas-bac";

function stockageMemoire(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("état de l'arbre", () => {
  it("dossiers dépliés mémorisés par compte, sélection remise à zéro au changement de compte", () => {
    vi.useFakeTimers();
    const st = stockageMemoire();
    const a = creerArbre(() => st);
    a.setUser(1);
    a.setOpen("src", true);
    a.select("src/a.py", "single");
    vi.advanceTimersByTime(300);
    expect(JSON.parse(st.getItem("elpis.tree.open.1") ?? "[]")).toEqual(["src"]);
    a.setUser(2);
    expect(a.isOpen("src")).toBe(false);
    expect(a.state.selected.size).toBe(0);
    a.setUser(1);
    expect(a.isOpen("src")).toBe(true);
    vi.useRealTimers();
  });

  it("sélection simple, bascule, plage ; cibles sans descendants d'un dossier sélectionné", () => {
    const a = creerArbre(() => null);
    a.select("a", "single");
    a.select("c", "range", ["a", "b", "c", "d"]);
    expect([...a.state.selected]).toEqual(["a", "b", "c"]);
    a.select("src", "single");
    a.select("src/x.py", "toggle");
    a.select("lib/y.py", "toggle");
    expect(a.targetsFor("src/x.py").sort()).toEqual(["lib/y.py", "src"]);
    expect(a.targetsFor("ailleurs")).toEqual(["ailleurs"]);
    a.clearSelection();
    expect(a.targetsFor("src")).toEqual(["src"]);
  });

  it("pastilles Git propagées aux dossiers ancêtres ; « Localiser » déplie les ancêtres", () => {
    const a = creerArbre(() => null);
    a.setGit({ "a/b/c.py": "M" });
    expect([...a.state.gitDirs].sort()).toEqual(["a", "a/b"]);
    a.reveal("x/y/z.py");
    expect(a.isOpen("x") && a.isOpen("x/y") && !a.isOpen("x/y/z.py")).toBe(true);
    expect(a.state.revealPath).toBe("x/y/z.py");
    expect(ancetres("x/y/z.py")).toEqual(["x", "x/y"]);
  });

  it("chemins glissés : liste interne, sinon texte brut", () => {
    const dt = new DataTransfer();
    dt.setData(MIME_GLISSER, JSON.stringify(["a", 3, "b"]));
    expect(cheminsGlisses(dt)).toEqual(["a", "b"]);
    const dt2 = new DataTransfer();
    dt2.setData("text/plain", "seul.py");
    expect(cheminsGlisses(dt2)).toEqual(["seul.py"]);
    expect(cheminsGlisses(null)).toEqual([]);
  });

  it("métadonnées de fichier par extension", () => {
    expect(metaFichier("a.PY").lang).toBe("python");
    expect(metaFichier("sans")).toEqual({ icon: "ph-file", color: "text-gray-400", lang: "plaintext" });
  });
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  arbre().clearSelection();
  arbre().collapseAll();
});

const fichier = (path: string): NoeudArbre => ({ name: path.split("/").pop() ?? path, path, type: "file" });
const RACINE: NoeudArbre[] = [
  { name: "src", path: "src", type: "folder", children: [fichier("src/a.py"), fichier("src/b.py")] },
  fichier("lisez.md"),
];

function monter(evts: string[]): HTMLElement {
  const hote = document.createElement("div");
  hote.setAttribute("role", "tree");
  document.body.appendChild(hote);
  app = createApp({
    render: () =>
      RACINE.map((item) =>
        h(ElementArbre, {
          key: item.path,
          item,
          "onOpen-file": (p: string) => evts.push("ouvrir:" + p),
          onDelete: (p: string) => evts.push("suppr:" + p),
          onRename: (p: string) => evts.push("renommer:" + p),
          "onMove-item": (c: { oldPath: string; newParent: string }) =>
            evts.push("deplacer:" + c.oldPath + ">" + c.newParent),
          "onContext-menu": (c: { item: NoeudArbre }) => evts.push("menu:" + c.item.path),
        }),
      ),
  });
  app.mount(hote);
  return hote;
}

const ligne = (hote: HTMLElement, p: string): HTMLElement => {
  const el = hote.querySelector<HTMLElement>(`[data-path="${p}"]`);
  if (!el) throw new Error("ligne absente : " + p);
  return el;
};

describe("ElementArbre", () => {
  it("clic : dossier déplié, fichier ouvert (événement remonté depuis un enfant)", async () => {
    const evts: string[] = [];
    const hote = monter(evts);
    expect(hote.querySelector('[data-path="src/a.py"]')).toBeNull();
    ligne(hote, "src").click();
    await nextTick();
    expect(ligne(hote, "src").getAttribute("aria-expanded")).toBe("true");
    ligne(hote, "src/a.py").click();
    expect(evts).toEqual(["ouvrir:src/a.py"]);
    expect(ligne(hote, "lisez.md").getAttribute("aria-expanded")).toBeNull();
  });

  it("Ctrl + clic sélectionne sans ouvrir ; Suppr, F2 et clic droit remontent", async () => {
    const evts: string[] = [];
    const hote = monter(evts);
    ligne(hote, "lisez.md").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    ligne(hote, "src").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();
    expect(ligne(hote, "lisez.md").getAttribute("aria-selected")).toBe("true");
    const md = ligne(hote, "lisez.md");
    md.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    md.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    md.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(evts).toEqual(["suppr:lisez.md", "renommer:lisez.md", "menu:lisez.md"]);
    expect(arbre().state.selected.size).toBe(2);
  });

  it("flèches : ligne suivante, dépli à droite", async () => {
    const hote = monter([]);
    const src = ligne(hote, "src");
    src.focus();
    src.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    expect(arbre().isOpen("src")).toBe(true);
    src.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(ligne(hote, "src/a.py"));
  });

  it("dépôt interne sur un dossier : déplacement émis, dossier lui-même écarté", () => {
    const evts: string[] = [];
    const hote = monter(evts);
    const dt = new DataTransfer();
    dt.setData(MIME_GLISSER, JSON.stringify(["lisez.md", "src"]));
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    ligne(hote, "src").dispatchEvent(ev);
    expect(evts).toEqual(["deplacer:lisez.md>src"]);
    expect(arbre().isOpen("src")).toBe(true);
  });
});
