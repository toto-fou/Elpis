// SPDX-License-Identifier: MIT
/** frontend/test/editor/arbre.test.ts — arbre de fichiers : état partagé (dépli mémorisé par compte, sélection, cibles, pastilles Git), chemins glissés et composant ElementArbre (clic, sélection, clavier, glisser-déposer). */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ElementArbre from "../../src/components/editor/ElementArbre.vue";
import {
  ancetres,
  arbre,
  cheminsGlisses,
  creerArbre,
  MIME_GLISSER,
  partagerArbre,
} from "../../src/features/editor/arbre";
import { metaFichier } from "../../src/features/editor/meta-fichier";
import type * as MetaFichier from "../../src/features/editor/meta-fichier";

// Compteur des calculs de métadonnées : une ligne re-rendue pour un nouvel objet le refait.
const appelsMeta = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../src/features/editor/meta-fichier", async (original) => {
  const m = await original<typeof MetaFichier>();
  return {
    ...m,
    metaFichier: (nom: string) => {
      appelsMeta.n++;
      return m.metaFichier(nom);
    },
  };
});
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

/** Réponse de l'arbre telle que le serveur la renvoie : des objets neufs à chaque lecture. */
function reponse(dossiers: number, fichiers: number, renomme = ""): NoeudArbre[] {
  return Array.from({ length: dossiers }, (_, d) => ({
    name: `m${d}`,
    path: `m${d}`,
    type: "folder" as const,
    children: Array.from({ length: fichiers }, (_, f) => {
      const path = `m${d}/f${f}.py`;
      const p = path === renomme ? `m${d}/neuf.py` : path;
      return { name: p.split("/").pop() ?? p, path: p, type: "file" as const, size: f };
    }),
  }));
}

describe("rechargement de l'arbre", () => {
  it("réponse identique : même tableau, aucun nœud neuf", () => {
    const a = reponse(3, 4);
    expect(partagerArbre(a, reponse(3, 4))).toBe(a);
    expect(partagerArbre([], [])).toHaveLength(0);
  });

  it("renommage : seuls le dossier touché et la racine changent, les autres nœuds sont repris", () => {
    const a = reponse(3, 4);
    const b = partagerArbre(a, reponse(3, 4, "m1/f2.py"));
    expect(b).not.toBe(a);
    expect(b[0]).toBe(a[0]);
    expect(b[2]).toBe(a[2]);
    expect(b[1]).not.toBe(a[1]);
    expect(b[1]?.children?.[0]).toBe(a[1]?.children?.[0]);
    expect(b[1]?.children?.[2]?.path).toBe("m1/neuf.py");
    expect(b[1]?.children?.map((n) => n.path)).toEqual(["m1/f0.py", "m1/f1.py", "m1/neuf.py", "m1/f3.py"]);
  });

  it("taille changée, ordre changé, ajout et retrait : l'arbre reçu fait foi", () => {
    const a = reponse(2, 3);
    const neuf = reponse(2, 3);
    neuf[0]!.children![1]!.size = 99;
    neuf.reverse();
    neuf.push(fichier("lisez.md"));
    const b = partagerArbre(a, neuf);
    expect(b.map((n) => n.path)).toEqual(["m1", "m0", "lisez.md"]);
    expect(b[0]).toBe(a[1]);
    expect(b[1]?.children?.[1]?.size).toBe(99);
    expect(b[1]?.children?.[0]).toBe(a[0]?.children?.[0]);
    expect(partagerArbre(b, reponse(1, 3)).map((n) => n.path)).toEqual(["m0"]);
    const vide = partagerArbre(a, [{ name: "m0", path: "m0", type: "folder" }]);
    expect(vide[0]?.children).toBeUndefined();
  });

  it("dans le composant : un rechargement identique ne re-rend aucune ligne, un renommage seulement la nouvelle", async () => {
    const arbreRef = shallowRef<NoeudArbre[]>(reponse(4, 5));
    for (let d = 0; d < 4; d++) arbre().setOpen(`m${d}`, true);
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({
      render: () => arbreRef.value.map((item) => h(ElementArbre, { key: item.path, item })),
    });
    app.mount(hote);
    expect(hote.querySelectorAll('[role="treeitem"]')).toHaveLength(24);
    appelsMeta.n = 0;
    arbreRef.value = partagerArbre(arbreRef.value, reponse(4, 5));
    await nextTick();
    expect(appelsMeta.n).toBe(0);
    arbreRef.value = partagerArbre(arbreRef.value, reponse(4, 5, "m2/f3.py"));
    await nextTick();
    expect(appelsMeta.n).toBe(1);
    expect(hote.querySelector('[data-path="m2/neuf.py"]')).not.toBeNull();
    expect(arbre().isOpen("m2")).toBe(true);
    // Témoin : des objets neufs sans partage re-rendent les vingt fichiers.
    appelsMeta.n = 0;
    arbreRef.value = reponse(4, 5);
    await nextTick();
    expect(appelsMeta.n).toBe(20);
  });
});

function prng(graine: number): () => number {
  let s = graine >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function arbreAleatoire(rnd: () => number, prefixe = "", prof = 0): NoeudArbre[] {
  const n = Math.floor(rnd() * (prof === 0 ? 8 : 5));
  const out: NoeudArbre[] = [];
  const noms = new Set<string>();
  for (let i = 0; i < n; i++) {
    const nom = "n" + Math.floor(rnd() * 6);
    if (noms.has(nom)) continue;
    noms.add(nom);
    const path = prefixe + nom;
    if (rnd() < 0.4 && prof < 4) {
      const noeud: NoeudArbre = { name: nom, path, type: "folder" };
      if (rnd() < 0.8) noeud.children = arbreAleatoire(rnd, path + "/", prof + 1);
      out.push(noeud);
    } else {
      const noeud: NoeudArbre = { name: nom, path, type: "file" };
      if (rnd() < 0.8) noeud.size = Math.floor(rnd() * 3);
      out.push(noeud);
    }
  }
  return out;
}

const copie = (a: NoeudArbre[]): NoeudArbre[] => JSON.parse(JSON.stringify(a)) as NoeudArbre[];
/** Mutation aléatoire : renommage, suppression, ajout, changement de taille ou de type, enfants retirés. */
function muter(a: NoeudArbre[], rnd: () => number): NoeudArbre[] {
  const out: NoeudArbre[] = [];
  for (const n of a) {
    const r = rnd();
    if (r < 0.05) continue;
    const m: NoeudArbre = { ...n };
    if (r < 0.1) {
      m.name = n.name + "x";
      m.path = n.path + "x";
    } else if (r < 0.15) m.size = (n.size ?? 0) + 1;
    else if (r < 0.18) m.type = n.type === "file" ? "folder" : "file";
    else if (r < 0.2) delete m.children;
    if (m.children) m.children = muter(m.children, rnd);
    out.push(m);
  }
  if (rnd() < 0.1) out.push({ name: "neuf", path: "neuf" + Math.floor(rnd() * 1e6), type: "file" });
  if (rnd() < 0.1) out.reverse();
  return out;
}

describe("rechargement de l'arbre : tirages aléatoires", () => {
  it("le résultat a toujours le contenu de l'arbre reçu (2 000 tirages, graine 9)", () => {
    const rnd = prng(9);
    for (let t = 0; t < 2000; t++) {
      const ancien = arbreAleatoire(rnd);
      const neuf = rnd() < 0.3 ? copie(ancien) : muter(copie(ancien), rnd);
      const r = partagerArbre(ancien, copie(neuf));
      expect(JSON.parse(JSON.stringify(r))).toEqual(JSON.parse(JSON.stringify(neuf)));
      if (JSON.stringify(neuf) === JSON.stringify(ancien)) expect(r).toBe(ancien);
    }
  });
});
