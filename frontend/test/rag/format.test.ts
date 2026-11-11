// SPDX-License-Identifier: MIT
/** frontend/test/rag/format.test.ts — page RAG, affichage : tailles, nombres, dates, états d'un document, bande de passages, estimations, surlignage. */
import { describe, expect, it } from "vitest";

import {
  accorder,
  celluleDuPassage,
  cellulesBande,
  dossierDe,
  emplacementPassage,
  estimerRestant,
  etatDocument,
  formaterDateCourte,
  formaterDuree,
  formaterJetons,
  formaterModification,
  formaterNombre,
  formaterQuotaMo,
  formaterScore,
  formaterTaille,
  iconeFichier,
  initiales,
  libelleVisibilite,
  pourcentage,
  racinesDeRequete,
  surlignerTexte,
} from "../../src/features/rag/format";

const nb = (s: string): string => s.replaceAll(" ", " ");

describe("tailles et nombres", () => {
  it("écrit les tailles avec les unités et la virgule françaises", () => {
    expect(nb(formaterTaille(0))).toBe("0 o");
    expect(nb(formaterTaille(900))).toBe("900 o");
    expect(nb(formaterTaille(9 * 1024))).toBe("9 Ko");
    expect(nb(formaterTaille(380 * 1024))).toBe("380 Ko");
    expect(nb(formaterTaille(18.2 * 1024 * 1024))).toBe("18,2 Mo");
    expect(nb(formaterTaille(2 * 1024 * 1024 * 1024))).toBe("2 Go");
    expect(nb(formaterTaille(1.5 * 1024 * 1024 * 1024))).toBe("1,5 Go");
  });

  it("exprime un quota en Mo comme une taille", () => {
    expect(nb(formaterQuotaMo(2048))).toBe("2 Go");
    expect(nb(formaterQuotaMo(200))).toBe("200 Mo");
  });

  it("groupe les milliers par une espace insécable", () => {
    expect(nb(formaterNombre(1532))).toBe("1 532");
    expect(formaterNombre(1532)).toContain(" ");
    expect(formaterNombre(12)).toBe("12");
  });

  it("accorde au singulier jusqu'à un, au pluriel au-delà", () => {
    expect(nb(accorder(0, "document"))).toBe("0 document");
    expect(nb(accorder(1, "document"))).toBe("1 document");
    expect(nb(accorder(48, "document"))).toBe("48 documents");
    expect(nb(accorder(3, "fichier choisi", "fichiers choisis"))).toBe("3 fichiers choisis");
  });
});

describe("dates", () => {
  const maintenant = new Date(2026, 9, 19, 15, 30);
  const ts = (d: Date): number => d.getTime() / 1000;

  it("date courte : aujourd'hui, hier, jour et mois, avec l'année hors de l'année courante", () => {
    expect(formaterDateCourte(ts(new Date(2026, 9, 19, 8, 0)), maintenant)).toBe("Aujourd’hui");
    expect(formaterDateCourte(ts(new Date(2026, 9, 18, 23, 0)), maintenant)).toBe("Hier");
    expect(nb(formaterDateCourte(ts(new Date(2026, 9, 14)), maintenant))).toBe("14 oct.");
    expect(nb(formaterDateCourte(ts(new Date(2026, 8, 30)), maintenant))).toBe("30 sept.");
    expect(nb(formaterDateCourte(ts(new Date(2025, 11, 2)), maintenant))).toBe("2 déc. 2025");
  });

  it("dernière modification : heure aujourd'hui, « Mise à jour » pour un lecteur", () => {
    expect(formaterModification(ts(new Date(2026, 9, 19, 10, 42)), maintenant)).toBe(
      "Modifiée aujourd’hui à 10:42",
    );
    expect(formaterModification(ts(new Date(2026, 9, 18, 10, 42)), maintenant)).toBe("Modifiée hier");
    expect(nb(formaterModification(ts(new Date(2026, 9, 1)), maintenant))).toBe("Modifiée le 1 oct.");
    expect(formaterModification(ts(new Date(2026, 9, 18, 10, 42)), maintenant, true)).toBe(
      "Mise à jour hier",
    );
    expect(formaterModification(ts(new Date(2026, 9, 19, 9, 0)), maintenant, true)).toBe(
      "Mise à jour aujourd’hui",
    );
  });
});

describe("auteurs, chemins et icônes", () => {
  it("initiales d'une pastille", () => {
    expect(initiales("Sophie Laurent")).toBe("SL");
    expect(initiales("alice")).toBe("AL");
    expect(initiales("  Jean de La Fontaine ")).toBe("JF");
    expect(initiales("")).toBe("?");
  });

  it("dossier d'un chemin logique avec barre finale", () => {
    expect(dossierDe("Constructeur/guide.pdf")).toBe("Constructeur/");
    expect(dossierDe("a/b/c.md")).toBe("a/b/");
    expect(dossierDe("seul.md")).toBe("");
  });

  it("icône par extension, repli sur un fichier générique", () => {
    expect(iconeFichier("pdf")).toBe("ph-file-pdf");
    expect(iconeFichier("DOCX")).toBe("ph-file-doc");
    expect(iconeFichier("xyz")).toBe("ph-file");
  });

  it("libellé de la visibilité", () => {
    expect(libelleVisibilite({ visibility: "private", groups: [] })).toBe("Privée");
    expect(libelleVisibilite({ visibility: "all", groups: [] })).toBe("Tous les comptes");
    expect(libelleVisibilite({ visibility: "groups", groups: [{ id: 1, name: "Réseau", members: 6 }] })).toBe(
      "Réseau",
    );
    expect(
      nb(
        libelleVisibilite({
          visibility: "groups",
          groups: [
            { id: 1, name: "Réseau", members: 6 },
            { id: 2, name: "Support", members: 11 },
          ],
        }),
      ),
    ).toBe("2 groupes");
  });
});

describe("états d'un document", () => {
  it("prête, en attente, en cours", () => {
    expect(etatDocument({ status: "ready", error: null })).toMatchObject({ cle: "prete", libelle: "Prête" });
    expect(etatDocument({ status: "pending", error: null })).toMatchObject({
      cle: "attente",
      libelle: "En attente",
    });
    expect(etatDocument({ status: "extracting", error: null })).toMatchObject({ cle: "extraction" });
    expect(etatDocument({ status: "indexing", error: null })).toMatchObject({ cle: "indexation" });
  });

  it("en attente avec une erreur : attente d'un service, message gardé en détail", () => {
    const e = etatDocument({
      status: "pending",
      error: { code: "extractor_unavailable", message: "Extracteur injoignable" },
    });
    expect(e).toMatchObject({
      cle: "service",
      libelle: "En attente d’un service",
      detail: "Extracteur injoignable",
    });
  });

  it("échec : libellé lisible par code, message du serveur pour un code inconnu", () => {
    expect(etatDocument({ status: "error", error: { code: "no_text", message: "x" } }).libelle).toBe(
      "Sans texte : activez l’OCR",
    );
    expect(
      etatDocument({
        status: "error",
        error: { code: "cancelled", message: "Indexation annulée : relancez-la pour indexer ce document." },
      }),
    ).toMatchObject({
      libelle: "Indexation annulée",
      detail: "Indexation annulée : relancez-la pour indexer ce document.",
    });
    expect(
      etatDocument({ status: "error", error: { code: "bizarre", message: "Message du serveur." } }).libelle,
    ).toBe("Message du serveur.");
    expect(etatDocument({ status: "error", error: null }).libelle).toBe("Échec de l’indexation");
  });
});

describe("bande de passages", () => {
  it("une cellule par passage jusqu'à 24, puis regroupées", () => {
    expect(cellulesBande(0)).toBe(1);
    expect(cellulesBande(18)).toBe(18);
    expect(cellulesBande(412)).toBe(24);
    expect(cellulesBande(412, 48)).toBe(48);
  });

  it("cellule d'un passage dans une bande regroupée, bornée à la dernière", () => {
    expect(celluleDuPassage(0, 100, 10)).toBe(0);
    expect(celluleDuPassage(55, 100, 10)).toBe(5);
    expect(celluleDuPassage(99, 100, 10)).toBe(9);
    expect(celluleDuPassage(3, 18, 18)).toBe(3);
    expect(celluleDuPassage(5, 0, 4)).toBe(0);
  });
});

describe("travaux et estimations", () => {
  it("pourcentage entier borné", () => {
    expect(pourcentage(3, 0, 8)).toBe(38);
    expect(pourcentage(3, 2, 10)).toBe(50);
    expect(pourcentage(0, 0, 0)).toBe(0);
    expect(pourcentage(12, 0, 10)).toBe(100);
  });

  it("reste estimé : rien tant qu'aucun document n'est fini", () => {
    const t = { created_at: 1000, done: 0, failed: 0, total: 9 };
    expect(estimerRestant(t, 1_100_000)).toBeNull();
    expect(estimerRestant({ ...t, done: 9 }, 1_100_000)).toBeNull();
  });

  it("reste estimé : moins d'une minute, minutes, heures", () => {
    // 3 documents sur 9 en 60 s : 120 s restantes.
    expect(nb(estimerRestant({ created_at: 1000, done: 3, failed: 0, total: 9 }, 1_060_000) ?? "")).toBe(
      "environ 2 min restantes",
    );
    expect(estimerRestant({ created_at: 1000, done: 8, failed: 0, total: 9 }, 1_060_000)).toBe(
      "moins d’une minute restante",
    );
    expect(nb(estimerRestant({ created_at: 1000, done: 1, failed: 0, total: 41 }, 1_090_000) ?? "")).toBe(
      "environ 1 h restantes",
    );
  });

  it("jetons arrondis, score et durée à la française", () => {
    expect(nb(formaterJetons(1934))).toBe("environ 1 900 jetons");
    expect(nb(formaterJetons(437))).toBe("environ 440 jetons");
    expect(formaterScore(0.8649)).toBe("0,86");
    expect(formaterScore(1)).toBe("1,00");
    expect(nb(formaterDuree(412))).toBe("0,4 s");
  });
});

describe("passages trouvés", () => {
  it("emplacement : page et titres, titres seuls, page seule", () => {
    expect(emplacementPassage({ page: 7, heading_path: "3.2 Renouvellement" })).toBe(
      "page 7 · 3.2 Renouvellement",
    );
    expect(emplacementPassage({ page: null, heading_path: "Tunnels IPsec" })).toBe("§ Tunnels IPsec");
    expect(emplacementPassage({ page: 12, heading_path: "" })).toBe("page 12");
    expect(emplacementPassage({ page: null, heading_path: "" })).toBe("");
  });

  it("racines des mots de la question : quatre lettres au moins, sans accents, queue coupée", () => {
    expect(racinesDeRequete("Comment renouveler le certificat du tunnel IPsec ?")).toEqual([
      "comm",
      "renouve",
      "certifi",
      "tunn",
      "ipse",
    ]);
    expect(racinesDeRequete("Éléphant très grand")).toEqual(["eleph", "tres", "gran"]);
    expect(racinesDeRequete("a b")).toEqual([]);
  });

  it("surligne les mots qui commencent par une racine, sans toucher au texte", () => {
    const segments = surlignerTexte(
      "Le certificat du tunnel IPsec expire en 12 mois ; le renouvellement est annuel.",
      "renouveler le certificat IPsec",
    );
    expect(segments.map((s) => s.texte).join("")).toBe(
      "Le certificat du tunnel IPsec expire en 12 mois ; le renouvellement est annuel.",
    );
    expect(segments.filter((s) => s.marque).map((s) => s.texte)).toEqual([
      "certificat",
      "IPsec",
      "renouvellement",
    ]);
  });

  it("ne surligne rien sans mot assez long, et n'interprète jamais le HTML", () => {
    expect(surlignerTexte("un <b>texte</b> simple", "a b")).toEqual([
      { texte: "un <b>texte</b> simple", marque: false },
    ]);
    const s = surlignerTexte("<script>alert(1)</script> texte", "texte");
    expect(s.map((x) => x.texte).join("")).toBe("<script>alert(1)</script> texte");
    expect(s.find((x) => x.marque)?.texte).toBe("texte");
    expect(surlignerTexte("", "texte")).toEqual([{ texte: "", marque: false }]);
  });
});
