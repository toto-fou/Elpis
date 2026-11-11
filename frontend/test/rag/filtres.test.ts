// SPDX-License-Identifier: MIT
/** frontend/test/rag/filtres.test.ts — page RAG, listes : filtre des collections et des documents (texte, état), tri, insertion, fenêtre virtualisée. */
import { describe, expect, it } from "vitest";

import {
  HAUTEUR_LIGNE,
  SEUIL_VIRTUALISATION,
  correspondEtat,
  fenetreVirtuelle,
  filtrerCollections,
  filtrerDocuments,
  inserer,
  trierDocuments,
} from "../../src/features/rag/filtres";
import type { FILTRES_ETAT } from "../../src/features/rag/filtres";
import { collection, document, idRag, partagee } from "./aides";

describe("filtre des collections", () => {
  const liste = [
    collection(1, { name: "Procédures réseau", description: "Exploitation des VPN" }),
    collection(2, { name: "Contrats fournisseurs" }),
    partagee(3, "Sophie Laurent", { name: "Base support" }),
  ];

  it("sans texte, tout", () => {
    expect(filtrerCollections(liste, "  ")).toHaveLength(3);
  });

  it("nom, description et auteur, sans accents ni casse", () => {
    expect(filtrerCollections(liste, "PROCEDURES").map((c) => c.name)).toEqual(["Procédures réseau"]);
    expect(filtrerCollections(liste, "vpn").map((c) => c.name)).toEqual(["Procédures réseau"]);
    expect(filtrerCollections(liste, "sophie").map((c) => c.name)).toEqual(["Base support"]);
    expect(filtrerCollections(liste, "zzz")).toEqual([]);
  });
});

describe("filtre des documents", () => {
  const c = idRag(1);
  const docs = [
    document(1, c, { rel_path: "VPN/Procédure-IPsec.docx", status: "ready" }),
    document(2, c, { rel_path: "Réseau/plan.xlsx", status: "pending" }),
    document(3, c, { rel_path: "PKI/certificats.md", status: "indexing" }),
    document(4, c, { rel_path: "Sites/scan.pdf", status: "error", error: { code: "no_text", message: "x" } }),
    document(5, c, { rel_path: "HA/bascule.docx", status: "extracting" }),
  ];

  it("par texte dans le chemin, sans accents", () => {
    expect(filtrerDocuments(docs, "procedure", "tous").map((d) => d.rel_path)).toEqual([
      "VPN/Procédure-IPsec.docx",
    ]);
    expect(filtrerDocuments(docs, "reseau/", "tous")).toHaveLength(1);
  });

  it("par état", () => {
    const etats = (f: (typeof FILTRES_ETAT)[number]): string[] =>
      filtrerDocuments(docs, "", f).map((d) => d.status);
    expect(etats("prets")).toEqual(["ready"]);
    expect(etats("en_cours")).toEqual(["indexing", "extracting"]);
    expect(etats("attente")).toEqual(["pending"]);
    expect(etats("erreurs")).toEqual(["error"]);
    expect(etats("tous")).toHaveLength(5);
  });

  it("texte et état se combinent", () => {
    expect(filtrerDocuments(docs, "docx", "prets").map((d) => d.rel_path)).toEqual([
      "VPN/Procédure-IPsec.docx",
    ]);
    expect(correspondEtat({ status: "ready" }, "erreurs")).toBe(false);
  });
});

describe("tri et insertion", () => {
  const c = idRag(1);
  const docs = [
    document(1, c, { rel_path: "b/doc10.md", bytes: 10, created_at: 5 }),
    document(2, c, { rel_path: "b/doc2.md", bytes: 500, created_at: 9 }),
    document(3, c, { rel_path: "a/zzz.md", bytes: 500, created_at: 1 }),
  ];

  it("chemin en ordre naturel (doc2 avant doc10)", () => {
    expect(trierDocuments(docs, "chemin").map((d) => d.rel_path)).toEqual([
      "a/zzz.md",
      "b/doc2.md",
      "b/doc10.md",
    ]);
  });

  it("taille décroissante puis chemin, plus récent d'abord, sans toucher à l'entrée", () => {
    expect(trierDocuments(docs, "taille").map((d) => d.rel_path)).toEqual([
      "a/zzz.md",
      "b/doc2.md",
      "b/doc10.md",
    ]);
    expect(trierDocuments(docs, "recent").map((d) => d.rel_path)).toEqual([
      "b/doc2.md",
      "b/doc10.md",
      "a/zzz.md",
    ]);
    expect(docs.map((d) => d.rel_path)).toEqual(["b/doc10.md", "b/doc2.md", "a/zzz.md"]);
  });

  it("insère un document inconnu, remplace le connu", () => {
    const neuf = document(9, c);
    expect(inserer(docs, neuf)).toHaveLength(4);
    const maj = { ...docs[1]!, status: "indexing" as const };
    const r = inserer(docs, maj);
    expect(r).toHaveLength(3);
    expect(r[1]?.status).toBe("indexing");
    expect(docs[1]?.status).toBe("ready");
  });
});

describe("tableau virtualisé", () => {
  it("seuil à 500 lignes", () => {
    expect(SEUIL_VIRTUALISATION).toBe(500);
  });

  it("fenêtre au sommet : lignes visibles plus un surplus, espaceur du bas", () => {
    const f = fenetreVirtuelle(1200, 0, 420);
    expect(f.debut).toBe(0);
    expect(f.haut).toBe(0);
    // 420 / 42 = 10 lignes visibles, +1, +8 de surplus.
    expect(f.fin).toBe(19);
    expect(f.bas).toBe((1200 - 19) * HAUTEUR_LIGNE);
  });

  it("fenêtre au milieu : espaceurs de part et d'autre, somme constante", () => {
    const f = fenetreVirtuelle(1200, 42 * 600, 420);
    expect(f.debut).toBe(592);
    expect(f.fin).toBe(619);
    expect(f.haut + (f.fin - f.debut) * HAUTEUR_LIGNE + f.bas).toBe(1200 * HAUTEUR_LIGNE);
  });

  it("fenêtre en bas de liste : bornée au total, défilement négatif ramené à zéro", () => {
    const f = fenetreVirtuelle(1200, 42 * 5000, 420);
    expect(f.fin).toBe(1200);
    expect(f.bas).toBe(0);
    expect(fenetreVirtuelle(50, -300, 420).debut).toBe(0);
    expect(fenetreVirtuelle(0, 0, 420)).toEqual({ debut: 0, fin: 0, haut: 0, bas: 0 });
  });
});
