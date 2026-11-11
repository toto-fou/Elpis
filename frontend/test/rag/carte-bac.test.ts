// SPDX-License-Identifier: MIT
/** frontend/test/rag/carte-bac.test.ts — carte « Où se trouvent les passages » (bande de passages par document) et arbre du bac de l'import. */
import type { NoeudArbre } from "@elpis/contracts";
import { describe, expect, it } from "vitest";

import { estAdmis, fichiersAdmis, lignesBac } from "../../src/features/rag/rag-bac";
import { CELLULES_CARTE_MAX, lignesCarte } from "../../src/features/rag/rag-tester";
import type { RechercheRag } from "../../src/features/rag/api";
import { idRag } from "./aides";

function recherche(map: RechercheRag["map"]): RechercheRag {
  return {
    mode: "mixte",
    reranked: false,
    passages: [],
    map,
    duration_ms: 400,
    tokens: 1900,
    warnings: [],
    errors: [],
  };
}
const doc = (n: number, nom: string, chunks: number, hits: [number, number, boolean][]) => ({
  document_id: idRag(n),
  document_name: nom,
  rel_path: nom,
  chunk_count: chunks,
  hits: hits.map(([chunk_index, rank, retained]) => ({ chunk_index, rank, retained })),
});

describe("carte des passages", () => {
  it("une cellule par passage, le rang du passage trouvé sur sa cellule, retenu ou hors limite", () => {
    const lignes = lignesCarte(
      recherche([
        doc(1, "certificats.md", 18, [
          [3, 1, true],
          [6, 3, true],
        ]),
        doc(2, "scan.pdf", 11, [[2, 7, false]]),
      ]),
    );
    expect(lignes).toHaveLength(2);
    const a = lignes[0]!;
    expect(a.nom).toBe("certificats.md");
    expect(a.cellules).toHaveLength(18);
    expect(a.cellules[3]).toEqual({ rang: 1, retenu: true, etiquette: true });
    expect(a.cellules[6]).toEqual({ rang: 3, retenu: true, etiquette: true });
    expect(a.cellules.filter((c) => c.rang !== null)).toHaveLength(2);
    expect(a.passages).toBe(2);
    expect(lignes[1]!.cellules[2]).toEqual({ rang: 7, retenu: false, etiquette: false });
  });

  it("lignes ordonnées par meilleur rang, documents sans passage écartés", () => {
    const lignes = lignesCarte(
      recherche([
        doc(1, "b.md", 5, [[1, 4, true]]),
        doc(2, "vide.md", 5, []),
        doc(3, "a.md", 5, [[0, 1, true]]),
      ]),
    );
    expect(lignes.map((l) => l.nom)).toEqual(["a.md", "b.md"]);
  });

  it("des passages voisins ne portent pas tous leur numéro : seul le mieux classé de la série, jamais un passage hors limite", () => {
    const [l] = lignesCarte(
      recherche([
        doc(1, "a.md", 20, [
          [4, 3, true],
          [5, 1, true],
          [6, 4, true],
          [12, 2, true],
          [13, 9, false],
        ]),
      ]),
    );
    const etiquettes = l!.cellules
      .map((c, i) => [i, c.etiquette])
      .filter(([, e]) => e)
      .map(([i]) => i);
    expect(etiquettes).toEqual([5, 12]);
    expect(l!.cellules[13]).toEqual({ rang: 9, retenu: false, etiquette: false });
  });

  it("un grand document est regroupé : cellules plafonnées, meilleur rang gardé par cellule", () => {
    const [l] = lignesCarte(
      recherche([
        doc(1, "guide.pdf", 960, [
          [100, 5, true],
          [101, 2, true],
          [102, 9, false],
        ]),
      ]),
    );
    expect(l!.cellules).toHaveLength(CELLULES_CARTE_MAX);
    const portees = l!.cellules.filter((c) => c.rang !== null);
    expect(portees).toHaveLength(1);
    expect(portees[0]).toEqual({ rang: 2, retenu: true, etiquette: true });
  });
});

describe("arbre du bac", () => {
  const arbre: NoeudArbre[] = [
    {
      name: "docs",
      path: "docs",
      type: "folder",
      children: [
        { name: "a.pdf", path: "docs/a.pdf", type: "file", size: 2048 },
        { name: "b.exe", path: "docs/b.exe", type: "file", size: 10 },
        {
          name: "sous",
          path: "docs/sous",
          type: "folder",
          children: [{ name: "c.md", path: "docs/sous/c.md", type: "file", size: 5 }],
        },
      ],
    },
    {
      name: "vide",
      path: "vide",
      type: "folder",
      children: [{ name: "x.bin", path: "vide/x.bin", type: "file" }],
    },
    { name: "notes.txt", path: "notes.txt", type: "file", size: 100 },
  ];

  it("extensions acceptées, fichiers d'un dossier récursivement", () => {
    expect(estAdmis("a.PDF")).toBe(true);
    expect(estAdmis("a.exe")).toBe(false);
    expect(fichiersAdmis(arbre[0]!)).toEqual(["docs/a.pdf", "docs/sous/c.md"]);
    expect(fichiersAdmis(arbre[1]!)).toEqual([]);
  });

  it("dossiers repliés : seuls les nœuds qui contiennent un fichier accepté apparaissent", () => {
    const l = lignesBac(arbre, new Set(), new Set(), "");
    expect(l.map((x) => x.chemin)).toEqual(["docs", "notes.txt"]);
    expect(l[0]).toMatchObject({ dossier: true, fichiers: 2, ouvert: false, etat: "aucun" });
  });

  it("dossier déplié : enfants indentés, fichiers refusés cachés, état coché ou partiel", () => {
    const l = lignesBac(arbre, new Set(["docs", "docs/sous"]), new Set(["docs/a.pdf"]), "");
    expect(l.map((x) => [x.chemin, x.profondeur])).toEqual([
      ["docs", 0],
      ["docs/a.pdf", 1],
      ["docs/sous", 1],
      ["docs/sous/c.md", 2],
      ["notes.txt", 0],
    ]);
    expect(l[0]!.etat).toBe("partiel");
    expect(l[1]!.etat).toBe("tous");
    expect(l[2]!.etat).toBe("aucun");
    const tous = lignesBac(arbre, new Set(), new Set(["docs/a.pdf", "docs/sous/c.md"]), "");
    expect(tous[0]!.etat).toBe("tous");
  });

  it("filtre : liste à plat des fichiers acceptés dont le chemin contient le texte", () => {
    const l = lignesBac(arbre, new Set(), new Set(), "SOUS");
    expect(l.map((x) => x.chemin)).toEqual(["docs/sous/c.md"]);
    expect(l[0]!.dossier).toBe(false);
  });
});
