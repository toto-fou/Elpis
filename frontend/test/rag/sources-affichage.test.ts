// SPDX-License-Identifier: MIT
/** frontend/test/rag/sources-affichage.test.ts — sources d'une réponse, fonctions pures : renvois [n], documents cités et leur détail, droit d'ouverture, bande du document, rectangles de la page. */
import type { SourceCiteeRag } from "@elpis/contracts";
import { describe, expect, it } from "vitest";

import {
  bandeDuDocument,
  collectionAffichee,
  collectionsDesSources,
  decouperRenvois,
  detailDocument,
  documentsCites,
  droitSources,
  libelleAccessibleSource,
  numerosDuCrochet,
  pagesDesBoites,
  passagesNonCites,
  rectanglesEnPourcent,
} from "../../src/features/rag/sources-affichage";
import { source } from "./aides-sources";

describe("renvois [n]", () => {
  it("un crochet, une liste et une plage donnent leurs numéros", () => {
    expect(numerosDuCrochet("3")).toEqual([3]);
    expect(numerosDuCrochet("2, 5")).toEqual([2, 5]);
    expect(numerosDuCrochet("4-6")).toEqual([4, 5, 6]);
    expect(numerosDuCrochet("4–6, 9")).toEqual([4, 5, 6, 9]);
  });

  it("zéro, plage à l'envers, plage trop longue ou texte : pas un renvoi", () => {
    expect(numerosDuCrochet("0")).toBeNull();
    expect(numerosDuCrochet("6-4")).toBeNull();
    expect(numerosDuCrochet("1-80")).toBeNull();
    expect(numerosDuCrochet("a")).toBeNull();
    expect(numerosDuCrochet("")).toBeNull();
  });

  it("le texte est découpé en morceaux de texte et renvois, un crochet invalide reste du texte", () => {
    expect(decouperRenvois("Voir [1] et [2, 3] ; tab[0] et [x].")).toEqual([
      { texte: "Voir " },
      { renvois: [1], brut: "[1]" },
      { texte: " et " },
      { renvois: [2, 3], brut: "[2, 3]" },
      { texte: " ; tab[0] et [x]." },
    ]);
    expect(decouperRenvois("sans renvoi")).toEqual([{ texte: "sans renvoi" }]);
    expect(decouperRenvois("")).toEqual([]);
  });

  it("deux renvois côte à côte restent deux renvois", () => {
    expect(decouperRenvois("a[1][2]")).toEqual([
      { texte: "a" },
      { renvois: [1], brut: "[1]" },
      { renvois: [2], brut: "[2]" },
    ]);
  });
});

describe("documents cités", () => {
  const sources: SourceCiteeRag[] = [
    source(1, {
      document: "renouvellement-certificats.md",
      doc: "d1",
      page: null,
      section: "Renouvellement › Tunnels IPsec",
    }),
    source(2, { document: "procedure-vpn-ipsec-sites.docx", doc: "d2", page: 7 }),
    source(3, { document: "renouvellement-certificats.md", doc: "d1", page: null, section: "Vérifications" }),
    source(4, { document: "procedure-vpn-ipsec-sites.docx", doc: "d2", page: 8 }),
    source(5, { document: "guide.pdf", doc: "d3", cited: false }),
    source(6, { document: "guide.pdf", doc: "d3", cited: false }),
  ];

  it("regroupés par document dans l'ordre du premier renvoi, avec leurs numéros", () => {
    const docs = documentsCites(sources);
    expect(docs.map((d) => [d.nom, d.sources.map((s) => s.n)])).toEqual([
      ["renouvellement-certificats.md", [1, 3]],
      ["procedure-vpn-ipsec-sites.docx", [2, 4]],
    ]);
  });

  it("le détail dit les pages, à défaut les sections", () => {
    const [md, docx] = documentsCites(sources);
    expect(md?.detail).toBe("§ Tunnels IPsec · § Vérifications");
    expect(docx?.detail).toBe("pages 7 et 8");
    expect(detailDocument([source(1, { page: 7 })])).toBe("page 7");
    expect(detailDocument([7, 8, 12, 14, 20].map((p, i) => source(i + 1, { page: p })))).toBe(
      "pages 7, 8, 12 et 14…",
    );
    expect(detailDocument([source(1, { page: null, section: "" })])).toBe("");
  });

  it("les passages lus et non cités sont à part, par numéro", () => {
    expect(passagesNonCites(sources).map((s) => s.n)).toEqual([5, 6]);
  });

  it("noms des collections sans doublon", () => {
    expect(collectionsDesSources(sources)).toBe("Procédures réseau");
    expect(
      collectionsDesSources([
        source(1, { collection: "A" }),
        source(2, { collection: "B" }),
        source(3, { collection: "A" }),
      ]),
    ).toBe("A, B");
  });

  it("libellé lu à voix haute", () => {
    expect(libelleAccessibleSource(source(2, { document: "x.docx", page: 7 }))).toBe(
      "Source 2 : x.docx, page 7",
    );
    expect(libelleAccessibleSource(source(2, { document: "x.md", page: null, section: "A › B" }))).toBe(
      "Source 2 : x.md, B",
    );
  });
});

describe("droit d'ouverture", () => {
  const liste = [
    { id: "a", role: "proprietaire" as const, allow_source_open: false },
    { id: "b", role: "lecteur" as const, allow_source_open: true },
    { id: "c", role: "lecteur" as const, allow_source_open: false },
  ];

  it("propriétaire ou ouverture permise : ouvert ; lecteur sans ouverture : fermé ; inconnue : inconnu", () => {
    expect(droitSources("a", liste)).toBe("ouvert");
    expect(droitSources("b", liste)).toBe("ouvert");
    expect(droitSources("c", liste)).toBe("ferme");
    expect(droitSources("z", liste)).toBe("inconnu");
  });

  it("la bulle dit l'auteur d'une collection partagée", () => {
    const s = source(1, { collection: "Base support", auteur: "Sophie Laurent", collectionId: "c" });
    expect(collectionAffichee(s.passage, liste)).toBe("Base support · partagée par Sophie Laurent");
    const mienne = source(1, { collection: "Procédures", collectionId: "a" });
    expect(collectionAffichee(mienne.passage, liste)).toBe("Procédures");
  });
});

describe("bande du document", () => {
  it("une cellule par passage, marquée aux passages cités, la courante repérée", () => {
    const b = bandeDuDocument(
      64,
      [
        { chunk_index: 26, n: 2 },
        { chunk_index: 29, n: 4 },
      ],
      2,
    );
    expect(b).toHaveLength(64);
    expect(b[26]).toEqual({ renvois: [2], courante: true });
    expect(b[29]).toEqual({ renvois: [4], courante: false });
    expect(b.filter((c) => c.renvois.length > 0)).toHaveLength(2);
  });

  it("au-delà de 64 passages les cellules regroupent ; deux renvois dans une cellule la partagent", () => {
    const b = bandeDuDocument(
      640,
      [
        { chunk_index: 300, n: 1 },
        { chunk_index: 301, n: 2 },
      ],
      null,
    );
    expect(b).toHaveLength(64);
    const marquee = b.find((c) => c.renvois.length > 0);
    expect(marquee?.renvois).toEqual([1, 2]);
  });

  it("aucun passage : pas de bande", () => {
    expect(bandeDuDocument(0, [], null)).toEqual([]);
  });
});

describe("rectangles de la page", () => {
  it("points PDF en pourcentages de la page, les boîtes d'une autre page écartées", () => {
    const r = rectanglesEnPourcent(
      [
        [7, 59.5, 84.1, 297.5, 168.3],
        [8, 10, 10, 20, 20],
      ],
      7,
      595,
      841,
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.gauche).toBeCloseTo(10, 1);
    expect(r[0]?.haut).toBeCloseTo(10, 1);
    expect(r[0]?.largeur).toBeCloseTo(40, 1);
    expect(r[0]?.hauteur).toBeCloseTo(10, 1);
  });

  it("bornées à la page ; taille inconnue : rien", () => {
    const r = rectanglesEnPourcent([[1, -10, -5, 700, 900]], 1, 595, 841);
    expect(r[0]).toEqual({ gauche: 0, haut: 0, largeur: 100, hauteur: 100 });
    expect(rectanglesEnPourcent([[1, 0, 0, 10, 10]], 1, 0, 0)).toEqual([]);
  });

  it("pages d'un passage", () => {
    expect(
      pagesDesBoites([
        [8, 0, 0, 1, 1],
        [7, 0, 0, 1, 1],
        [8, 0, 0, 1, 1],
      ]),
    ).toEqual([7, 8]);
  });
});
