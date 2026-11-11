// SPDX-License-Identifier: MIT
/** frontend/test/rag/depot.test.ts — page RAG, dépôt : refus avant envoi, lots de 1000 fichiers, corps multipart, bilan, nom proposé, lecture des fichiers et dossiers glissés. */
import { describe, expect, it } from "vitest";

import {
  OCTETS_PAR_LOT,
  bilanDepot,
  corpsDepot,
  decouperEnLots,
  depuisSelecteur,
  estFichierIgnore,
  extensionDe,
  glissePorteDesFichiers,
  libelleResultat,
  lireEntreesGlissees,
  nomProposeCollection,
  phraseBilan,
  preparerDepot,
} from "../../src/features/rag/depot";
import type { FichierADeposer } from "../../src/features/rag/depot";

const fichier = (chemin: string, taille = 10): FichierADeposer => ({
  file: new File([new Uint8Array(taille)], chemin.split("/").pop() ?? chemin),
  chemin,
});

describe("noms et fichiers ignorés", () => {
  it("extension en minuscules, vide sans point", () => {
    expect(extensionDe("Rapport.PDF")).toBe("pdf");
    expect(extensionDe("archive.tar.gz")).toBe("gz");
    expect(extensionDe("Makefile")).toBe("");
  });

  it("ignore les fichiers cachés et ceux du bureau, à tout niveau", () => {
    expect(estFichierIgnore(".DS_Store")).toBe(true);
    expect(estFichierIgnore("dossier/.git/config")).toBe(true);
    expect(estFichierIgnore("a/Thumbs.db")).toBe(true);
    expect(estFichierIgnore("a/desktop.ini")).toBe(true);
    expect(estFichierIgnore("a/rapport.pdf")).toBe(false);
  });

  it("le sélecteur de dossier donne le chemin relatif, le sélecteur de fichiers le nom", () => {
    const f = new File(["x"], "a.md");
    Object.defineProperty(f, "webkitRelativePath", { value: "docs/sous/a.md" });
    const g = new File(["y"], "b.md");
    expect(depuisSelecteur([f, g]).map((e) => e.chemin)).toEqual(["docs/sous/a.md", "b.md"]);
  });
});

describe("préparation du dépôt", () => {
  it("écarte l'extension inconnue, le fichier vide et le fichier trop gros avec un message", () => {
    const entrees = [
      fichier("a.pdf"),
      fichier("virus.exe"),
      fichier("vide.md", 0),
      fichier("gros.docx", 3 * 1024 * 1024),
      fichier("sans-extension"),
    ];
    const p = preparerDepot(entrees, 2);
    expect(p.aEnvoyer.map((e) => e.chemin)).toEqual(["a.pdf"]);
    expect(p.refus.map((r) => [r.name, r.code])).toEqual([
      ["virus.exe", "extension_refusee"],
      ["vide.md", "fichier_vide"],
      ["gros.docx", "fichier_trop_gros"],
      ["sans-extension", "extension_refusee"],
    ]);
    expect(p.refus[0]?.message).toBe("Format .exe non pris en charge");
    expect(p.refus[2]?.message).toMatch(/^Dépasse 2.Mo par fichier$/u);
    expect(p.refus.every((r) => r.status === "refuse")).toBe(true);
  });

  it("laisse de côté sans bruit les fichiers cachés, en les comptant", () => {
    const p = preparerDepot([fichier(".DS_Store"), fichier("a/.cache/x.md"), fichier("b.md")], 200);
    expect(p.aEnvoyer.map((e) => e.chemin)).toEqual(["b.md"]);
    expect(p.refus).toEqual([]);
    expect(p.ignores).toBe(2);
  });

  it("sans plafond configuré (0), aucune taille n'est refusée", () => {
    const p = preparerDepot([fichier("a.md", 5 * 1024 * 1024)], 0);
    expect(p.aEnvoyer).toHaveLength(1);
  });
});

describe("lots", () => {
  it("1000 fichiers au plus par envoi", () => {
    const entrees = Array.from({ length: 2300 }, (_, i) => fichier(`d/f${i}.md`, 1));
    const lots = decouperEnLots(entrees);
    expect(lots.map((l) => l.length)).toEqual([1000, 1000, 300]);
    expect(lots.flat().map((e) => e.chemin)).toEqual(entrees.map((e) => e.chemin));
  });

  it("plafond d'octets par envoi, un fichier seul passe toujours", () => {
    const entrees = [fichier("a.md", 60), fichier("b.md", 60), fichier("c.md", 500), fichier("d.md", 10)];
    expect(decouperEnLots(entrees, 1000, 100).map((l) => l.map((e) => e.chemin))).toEqual([
      ["a.md"],
      ["b.md"],
      ["c.md"],
      ["d.md"],
    ]);
    expect(decouperEnLots(entrees, 1000, 130).map((l) => l.map((e) => e.chemin))).toEqual([
      ["a.md", "b.md"],
      ["c.md"],
      ["d.md"],
    ]);
    expect(decouperEnLots([])).toEqual([]);
    expect(OCTETS_PAR_LOT).toBe(200 * 1024 * 1024);
  });

  it("corps multipart : champ « files », nom de partie = chemin logique", () => {
    const fd = corpsDepot([fichier("dossier/sous/a.pdf"), fichier("b.md")]);
    const parties = fd.getAll("files") as File[];
    expect(parties.map((p) => p.name)).toEqual(["dossier/sous/a.pdf", "b.md"]);
  });
});

describe("bilan par fichier", () => {
  const resultats = [
    { name: "a", status: "ajoute" as const },
    { name: "b", status: "ajoute" as const },
    { name: "c", status: "remplace" as const },
    { name: "d", status: "deja_present" as const },
    { name: "e", status: "refuse" as const, code: "extension_refusee", message: "Non" },
  ];

  it("compte et écrit les états", () => {
    const b = bilanDepot(resultats);
    expect(b).toEqual({ ajoutes: 2, remplaces: 1, dejaPresents: 1, refuses: 1 });
    expect(phraseBilan(b)).toBe("2 ajoutés · 1 remplacé · 1 déjà présent · 1 refusé");
    expect(phraseBilan({ ajoutes: 1, remplaces: 0, dejaPresents: 3, refuses: 0 })).toBe(
      "1 ajouté · 3 déjà présents",
    );
    expect(phraseBilan({ ajoutes: 0, remplaces: 0, dejaPresents: 0, refuses: 0 })).toBe("");
  });

  it("libellés des quatre états", () => {
    expect(resultats.map(libelleResultat)).toEqual([
      "Ajouté",
      "Ajouté",
      "Remplacé",
      "Déjà présent",
      "Refusé",
    ]);
  });
});

describe("nom proposé", () => {
  it("le dossier déposé, sinon « Mes documents »", () => {
    expect(nomProposeCollection([fichier("Procédures/a.md"), fichier("Procédures/sous/b.md")])).toBe(
      "Procédures",
    );
    expect(nomProposeCollection([fichier("A/a.md"), fichier("B/b.md")])).toBe("Mes documents");
    expect(nomProposeCollection([fichier("A/a.md"), fichier("b.md")])).toBe("Mes documents");
    expect(nomProposeCollection([fichier("a.md")])).toBe("Mes documents");
    expect(nomProposeCollection([fichier(`${"x".repeat(120)}/a.md`)])).toHaveLength(80);
  });
});

/** Entrée de système de fichiers simulée (FileSystemEntry). */
function entreeFichier(nom: string, contenu = "x") {
  return {
    isFile: true,
    isDirectory: false,
    name: nom,
    file: (ok: (f: File) => void) => ok(new File([contenu], nom)),
  };
}
function entreeDossier(nom: string, enfants: unknown[], parLot = 2) {
  return {
    isFile: false,
    isDirectory: true,
    name: nom,
    createReader: () => {
      let i = 0;
      return {
        readEntries: (ok: (e: unknown[]) => void) => {
          const lot = enfants.slice(i, i + parLot);
          i += parLot;
          ok(lot);
        },
      };
    },
  };
}
function glisser(entrees: unknown[], fichiers: File[] = []): DataTransfer {
  return {
    items: entrees.map((e) => ({ kind: "file", webkitGetAsEntry: () => e })),
    files: fichiers,
    types: ["Files"],
  } as unknown as DataTransfer;
}

describe("fichiers et dossiers glissés", () => {
  it("parcourt un dossier en plusieurs lectures, chemins relatifs sous le dossier", async () => {
    const dossier = entreeDossier("Docs", [
      entreeFichier("a.md"),
      entreeFichier("b.pdf"),
      entreeDossier("sous", [entreeFichier("c.txt")]),
      entreeFichier("d.html"),
    ]);
    const lus = await lireEntreesGlissees(glisser([dossier, entreeFichier("seul.md")]));
    expect(lus.map((e) => e.chemin)).toEqual([
      "Docs/a.md",
      "Docs/b.pdf",
      "Docs/sous/c.txt",
      "Docs/d.html",
      "seul.md",
    ]);
  });

  it("repli sur la liste de fichiers quand le navigateur n'a pas d'entrées", async () => {
    const f = new File(["x"], "a.md");
    const dt = {
      items: [{ kind: "file", webkitGetAsEntry: () => null }],
      files: [f],
      types: ["Files"],
    } as unknown as DataTransfer;
    expect((await lireEntreesGlissees(dt)).map((e) => e.chemin)).toEqual(["a.md"]);
  });

  it("ignore ce qui n'est pas un fichier", async () => {
    const dt = { items: [{ kind: "string" }], files: [], types: ["text/plain"] } as unknown as DataTransfer;
    expect(await lireEntreesGlissees(dt)).toEqual([]);
  });

  it("reconnaît un glisser de fichiers, pas de texte", () => {
    expect(glissePorteDesFichiers({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(glissePorteDesFichiers({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(glissePorteDesFichiers(null)).toBe(false);
  });
});
