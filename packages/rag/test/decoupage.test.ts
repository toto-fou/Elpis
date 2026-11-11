// SPDX-License-Identifier: MIT
/** packages/rag/test/decoupage.test.ts — blocs et texte brut → passages : structure, pages et rectangles, tableaux, chevauchement, méthodes, cas limites, déterminisme. */
import { describe, expect, it } from "vitest";

import {
  assemblerTexte,
  decouper,
  decouperAvecRedecoupes,
  decouperTexte,
  empreinteParams,
  empreinteTexte,
  normaliserParams,
  PARAMS_DECOUPAGE_DEFAUT,
} from "../src/decoupage";
import { debutsRegex } from "../src/decoupage-texte";
import { ErreurRag } from "../src/erreurs";
import type { Bloc, ParamsDecoupage, Passage } from "../src/decoupage";

/** Un jeton = un caractère : les tailles des tests se lisent en caractères. */
const P1: Partial<ParamsDecoupage> = { caracteresParJeton: 1 };

function mots(n: number, prefixe = "mot"): string {
  return Array.from({ length: n }, (_, i) => `${prefixe}${i}`).join(" ");
}

function para(texte: string, plus: Partial<Bloc> = {}): Bloc {
  return { kind: "paragraph", text: texte, ...plus };
}

function titre(texte: string, level: number, plus: Partial<Bloc> = {}): Bloc {
  return { kind: "heading", text: texte, level, ...plus };
}

function textes(ps: readonly Passage[]): string[] {
  return ps.map((p) => p.text);
}

function litteral(blocs: readonly Bloc[], ps: readonly Passage[]): void {
  const flat = assemblerTexte(blocs);
  for (const p of ps) expect(flat.slice(p.char_start, p.char_end)).toBe(p.text);
}

describe("cas vides et forme d'un passage", () => {
  it("ne rend rien pour des blocs vides, blancs ou un texte vide", () => {
    expect(decouper([])).toEqual([]);
    expect(decouper([para("  \n "), para("")])).toEqual([]);
    expect(decouperTexte("")).toEqual([]);
    expect(decouperTexte(" \n\n \t ")).toEqual([]);
  });

  it("décrit un passage unique avec tous ses champs", () => {
    const blocs = [
      titre("Intro", 1, { page: 2 }),
      para("Un seul paragraphe court.", { page: 2, boxes: [[1, 2, 3, 4]] }),
    ];
    const [p, ...reste] = decouper(blocs);
    expect(reste).toEqual([]);
    expect(p).toEqual({
      text: "Intro\n\nUn seul paragraphe court.",
      heading_path: "Intro",
      page: 2,
      boxes: [{ page: 2, rects: [[1, 2, 3, 4]] }],
      char_start: 0,
      char_end: 32,
      chunk_index: 0,
      hash: empreinteTexte("Intro\n\nUn seul paragraphe court."),
      jetons: Math.ceil(32 / 3.3),
    });
    expect(p?.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("est déterministe", () => {
    const blocs = [titre("A", 1), para(mots(300)), titre("B", 2), para(mots(200, "z")), para(mots(100, "y"))];
    const a = decouper(blocs, { tailleJetons: 60, chevauchementJetons: 10 });
    const b = decouper(blocs, { tailleJetons: 60, chevauchementJetons: 10 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.map((p) => p.chunk_index)).toEqual(a.map((_, i) => i));
  });
});

describe("structure : titres, pages, rectangles", () => {
  it("suit la pile des titres imbriqués", () => {
    const blocs = [
      titre("A", 1),
      para("p-a ".repeat(7).trim()),
      titre("A1", 2),
      para("p-a1 ".repeat(6).trim()),
      titre("A2", 2),
      para("p-a2 ".repeat(6).trim()),
      titre("B", 1),
      para("p-b ".repeat(7).trim()),
    ];
    const ps = decouper(blocs, { ...P1, tailleJetons: 60, chevauchementJetons: 0 });
    const chemin = (marque: string): string | undefined =>
      ps.find((p) => p.text.includes(marque))?.heading_path;
    expect(chemin("p-a p-a")).toBe("A");
    expect(chemin("p-a1")).toBe("A › A1");
    expect(chemin("p-a2")).toBe("A › A2");
    expect(chemin("p-b")).toBe("B");
    litteral(blocs, ps);
  });

  it("garde la page du premier bloc et les rectangles de chaque page", () => {
    const rect: [number, number, number, number] = [10, 20, 30, 40];
    const blocs = [
      para(mots(5, "a"), { page: 1, boxes: [rect, [0, 0, 5, 5]] }),
      para(mots(5, "b"), { page: 2, boxes: [[1, 1, 2, 2]] }),
      para(mots(5, "c"), { page: 2, boxes: [[3, 3, 4, 4]] }),
      para(mots(5, "d")),
    ];
    const [p] = decouper(blocs);
    expect(p?.page).toBe(1);
    expect(p?.boxes).toEqual([
      { page: 1, rects: [rect, [0, 0, 5, 5]] },
      {
        page: 2,
        rects: [
          [1, 1, 2, 2],
          [3, 3, 4, 4],
        ],
      },
    ]);
    expect(p?.boxes[0]?.rects[0]).not.toBe(rect);
  });

  it("ignore les rectangles invalides ou sans page et prend la diapositive comme page", () => {
    const blocs = [
      para("sans page", { boxes: [[1, 2, 3, 4]] }),
      para("diapo trois", {
        slide: 3,
        boxes: [
          [1, 2, 3],
          [1, 2, 3, Number.NaN],
          [4, 5, 6, 7],
        ] as unknown as Bloc["boxes"],
      }),
    ];
    const [p] = decouper(blocs);
    expect(p?.page).toBe(3);
    expect(p?.boxes).toEqual([{ page: 3, rects: [[4, 5, 6, 7]] }]);
  });

  it("sépare les feuilles d'un classeur et les met en tête du chemin", () => {
    const blocs = [
      para("a1 a2", { sheet: "Budget" }),
      titre("Total", 1, { sheet: "Budget" }),
      para("b1 b2", { sheet: "Ventes" }),
    ];
    const ps = decouper(blocs, P1);
    expect(ps.map((p) => p.heading_path)).toEqual(["Budget", "Ventes"]);
    expect(ps[0]?.text).toContain("Total");
    expect(ps[1]?.text).toBe("b1 b2");
  });

  it("coupe entre deux diapositives quand le passage est à moitié plein, pas avant", () => {
    const params = { ...P1, tailleJetons: 100, chevauchementJetons: 0 };
    const plein = [para("a".repeat(55), { slide: 1 }), para("b".repeat(30), { slide: 2 })];
    expect(decouper(plein, params).map((p) => p.page)).toEqual([1, 2]);
    const leger = [para("a".repeat(30), { slide: 1 }), para("b".repeat(30), { slide: 2 })];
    expect(decouper(leger, params).map((p) => p.page)).toEqual([1]);
  });

  it("ne laisse jamais un titre seul en fin de passage", () => {
    const blocs = [para("court"), titre("Suite", 1), para(mots(60, "corps"))];
    const ps = decouper(blocs, { ...P1, tailleJetons: 150, chevauchementJetons: 0 });
    expect(ps.map((p) => p.text.endsWith("Suite"))).not.toContain(true);
    expect(ps.find((p) => p.text.includes("corps0"))?.text.startsWith("Suite")).toBe(true);
    litteral(blocs, ps);
  });
});

describe("tableaux", () => {
  const entete = "| nom | valeur |\n|---|---|";
  const lignes = Array.from({ length: 12 }, (_, i) => `| ligne${i} | v${i} |`);
  const tableau = [entete, ...lignes].join("\n");

  it("garde un tableau entier quand il tient dans la cible, avec le texte voisin", () => {
    const blocs = [para("Avant le tableau."), { kind: "table", text: tableau } as Bloc, para("Après.")];
    const ps = decouper(blocs, { ...P1, tailleJetons: 400, chevauchementJetons: 0 });
    expect(textes(ps)).toEqual([`Avant le tableau.\n\n${tableau}\n\nAprès.`]);
  });

  it("isole un tableau plus grand que la cible mais plus petit que le maximum", () => {
    const blocs = [para("Avant."), { kind: "table", text: tableau } as Bloc, para("Après.")];
    const ps = decouper(blocs, { ...P1, tailleJetons: 150, tailleMaxJetons: 600, chevauchementJetons: 0 });
    expect(textes(ps)).toEqual(["Avant.", tableau, "Après."]);
  });

  it("coupe un tableau trop grand par lignes et répète l'en-tête et la ligne de tirets", () => {
    const blocs: Bloc[] = [titre("Données", 1), { kind: "table", text: tableau }];
    const ps = decouper(blocs, { ...P1, tailleJetons: 80, tailleMaxJetons: 120, chevauchementJetons: 0 });
    expect(ps.length).toBeGreaterThan(2);
    for (const p of ps) expect(p.text.includes(entete)).toBe(true);
    const rendues = ps.flatMap((p) => p.text.split("\n").filter((l) => l.startsWith("| ligne")));
    expect(rendues).toEqual(lignes);
    expect(ps.every((p) => p.heading_path === "Données")).toBe(true);
  });

  it("répète la première ligne seule quand le tableau n'a pas de ligne de tirets", () => {
    const brut = ["a ; b", ...Array.from({ length: 30 }, (_, i) => `x${i} ; y${i}`)].join("\n");
    const ps = decouper([{ kind: "table", text: brut }], {
      ...P1,
      tailleJetons: 40,
      tailleMaxJetons: 60,
      chevauchementJetons: 0,
    });
    expect(ps.length).toBeGreaterThan(3);
    for (const p of ps) expect(p.text.startsWith("a ; b\n")).toBe(true);
  });
});

describe("chevauchement et découpage des gros blocs", () => {
  it("fait se recouvrir les morceaux d'un long paragraphe, sur des débuts de mot", () => {
    const blocs = [para(mots(400))];
    const ps = decouper(blocs, { ...P1, tailleJetons: 200, chevauchementJetons: 50 });
    expect(ps.length).toBeGreaterThan(5);
    litteral(blocs, ps);
    for (let i = 1; i < ps.length; i++) {
      const avant = ps[i - 1];
      const apres = ps[i];
      if (!avant || !apres) throw new Error("passage attendu");
      const recouvrement = avant.char_end - apres.char_start;
      expect(recouvrement).toBeGreaterThan(0);
      expect(recouvrement).toBeLessThanOrEqual(50);
      expect(apres.text.startsWith("mot")).toBe(true);
    }
    expect(ps[0]?.char_start).toBe(0);
    expect(ps[ps.length - 1]?.char_end).toBe(assemblerTexte(blocs).length);
  });

  it("reporte en début de passage les derniers paragraphes entiers qui tiennent dans le chevauchement", () => {
    const blocs = [para(mots(10, "a")), para(mots(10, "b")), para(mots(10, "c")), para(mots(10, "d"))];
    const sans = decouper(blocs, { ...P1, tailleJetons: 80, chevauchementJetons: 0 });
    const avec = decouper(blocs, { ...P1, tailleJetons: 80, chevauchementJetons: 40 });
    expect(sans.map((p) => p.text.split("\n\n").length)).toEqual([2, 2]);
    expect(avec.map((p) => p.text.split("\n\n").map((t) => t[0]))).toEqual([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ]);
    litteral(blocs, avec);
  });

  it("coupe un mot géant sans espace sans boucler ni dépasser la cible", () => {
    const geant = Array.from({ length: 5000 }, (_, i) =>
      String.fromCharCode(97 + ((i * 7 + (i >> 3)) % 26)),
    ).join("");
    const ps = decouper([para(geant)], {
      ...P1,
      tailleJetons: 100,
      tailleMaxJetons: 300,
      chevauchementJetons: 30,
    });
    expect(ps.every((p) => p.text.length <= 100)).toBe(true);
    expect(ps.map((p) => p.text).join("")).toBe(geant);
  });

  it("ne coupe pas une paire de substitution", () => {
    const pile = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆"];
    let graine = 12345;
    const emoji = Array.from({ length: 2000 }, () => {
      graine = (graine * 1103515245 + 12345) & 0x7fffffff;
      return pile[(graine >> 8) % pile.length];
    }).join("");
    for (const methode of ["auto", "taille", "phrase"] as const) {
      const ps = decouper([para(emoji)], { ...P1, methode, tailleJetons: 101, chevauchementJetons: 0 });
      expect(ps.length).toBeGreaterThan(10);
      for (const p of ps)
        expect(p.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });

  it("recoupe un passage plus long que le maximum", () => {
    const blocs = [para(mots(300))];
    const ps = decouper(blocs, {
      ...P1,
      methode: "separateur",
      valeur: "###",
      tailleJetons: 100,
      tailleMaxJetons: 200,
      chevauchementJetons: 20,
    });
    expect(ps.length).toBeGreaterThan(5);
    expect(ps.every((p) => p.text.length <= 200)).toBe(true);
    litteral(blocs, ps);
  });

  it("garde une liste ou du code par lignes entières", () => {
    const code = Array.from({ length: 40 }, (_, i) => `ligne de code ${i};`).join("\n");
    const ps = decouper([{ kind: "code", text: code }], { ...P1, tailleJetons: 120, chevauchementJetons: 0 });
    expect(ps.length).toBeGreaterThan(3);
    for (const p of ps) for (const l of p.text.split("\n")) expect(l).toMatch(/^ligne de code \d+;$/);
    expect(ps.flatMap((p) => p.text.split("\n"))).toEqual(code.split("\n"));
  });
});

describe("paramètres", () => {
  it("applique les valeurs par défaut et les gardes anti-boucle", () => {
    const d = PARAMS_DECOUPAGE_DEFAUT;
    expect(normaliserParams()).toEqual({ ...d, valeur: undefined });
    expect(normaliserParams({ tailleJetons: 0 }).tailleJetons).toBe(512);
    expect(normaliserParams({ tailleJetons: -10 }).tailleJetons).toBe(512);
    expect(normaliserParams({ tailleJetons: Number.NaN }).tailleJetons).toBe(512);
    expect(normaliserParams({ tailleJetons: 100, chevauchementJetons: 100 }).chevauchementJetons).toBe(50);
    expect(normaliserParams({ tailleJetons: 100, chevauchementJetons: 5000 }).chevauchementJetons).toBe(50);
    expect(normaliserParams({ chevauchementJetons: -3 }).chevauchementJetons).toBe(0);
    expect(normaliserParams({ tailleJetons: 800, tailleMaxJetons: 100 }).tailleMaxJetons).toBe(800);
    expect(normaliserParams({ methode: "inconnue" as unknown as "auto" }).methode).toBe("auto");
    expect(normaliserParams({ caracteresParJeton: -1 }).caracteresParJeton).toBe(d.caracteresParJeton);
    expect(normaliserParams({ valeur: "" }).valeur).toBeUndefined();
  });

  it("termine avec un chevauchement supérieur à la taille, et une taille négative", () => {
    const blocs = [para(mots(300))];
    const a = decouper(blocs, { ...P1, tailleJetons: 100, chevauchementJetons: 1000 });
    expect(a.length).toBeLessThan(60);
    litteral(blocs, a);
    const b = decouper(blocs, { ...P1, tailleJetons: -5 });
    expect(b.length).toBeGreaterThan(0);
  });

  it("refuse un découpage qui produirait trop de passages, sans le calculer", () => {
    const enorme = "mot ".repeat(250_000);
    const debut = Date.now();
    expect(() =>
      decouperTexte(enorme, {
        ...P1,
        methode: "taille",
        tailleJetons: 2,
        chevauchementJetons: 0,
        maxPassages: 1000,
      }),
    ).toThrow(expect.objectContaining({ code: "trop_de_passages" }));
    expect(Date.now() - debut).toBeLessThan(2000);
  });

  it("empreinte : stable, sensible au découpage, insensible aux valeurs normalisées", () => {
    const e = empreinteParams();
    expect(e).toMatch(/^[0-9a-f]{12}$/);
    expect(empreinteParams({ tailleJetons: 0 })).toBe(e);
    expect(empreinteParams({ tailleJetons: 512 })).toBe(e);
    expect(empreinteParams({ tailleJetons: 256 })).not.toBe(e);
    expect(empreinteParams({ chevauchementJetons: 10 })).not.toBe(e);
    expect(empreinteParams({ methode: "phrase" })).not.toBe(e);
    expect(empreinteParams({ methode: "regex", valeur: "a" })).not.toBe(
      empreinteParams({ methode: "regex", valeur: "b" }),
    );
    expect(empreinteParams({ maxPassages: 5 })).toBe(e);
  });
});

describe("blocs mal formés", () => {
  it("traite un genre inconnu comme un paragraphe et ignore les blocs sans texte", () => {
    const blocs = [
      { kind: "citation", text: "Un passage cité." },
      null,
      { kind: "paragraph" },
      { kind: "heading", text: 12 },
    ] as unknown as Bloc[];
    const ps = decouper(blocs);
    expect(textes(ps)).toEqual(["Un passage cité."]);
  });
});

describe("déduplication", () => {
  it("garde une seule fois un texte répété et renumérote", () => {
    const blocs = [
      para("Pied de page"),
      para(mots(20, "u")),
      para("Pied de page"),
      para(mots(20, "v")),
      para("Pied de page"),
    ];
    const ps = decouper(blocs, {
      ...P1,
      tailleJetons: 130,
      chevauchementJetons: 0,
      methode: "separateur",
      valeur: "\n\n",
    });
    expect(ps.filter((p) => p.text === "Pied de page")).toHaveLength(1);
    expect(ps.map((p) => p.chunk_index)).toEqual(ps.map((_, i) => i));
    expect(new Set(ps.map((p) => p.hash)).size).toBe(ps.length);
  });
});

describe("méthodes sur le texte assemblé", () => {
  const texte =
    "# Titre\n\nUn paragraphe. Deux phrases ici! Et une troisième?\n\n## Sous\n\nAutre paragraphe.\n";
  const methodes = (plus: Partial<ParamsDecoupage>): Passage[] =>
    decouperTexte(texte, { ...P1, tailleJetons: 30, chevauchementJetons: 6, ...plus });

  it("toutes les méthodes rendent des passages littéraux dans le texte d'origine", () => {
    for (const methode of ["auto", "taille", "phrase", "markdown", "separateur", "regex"] as const) {
      const ps = methodes({
        methode,
        valeur: methode === "separateur" ? "\n\n" : methode === "regex" ? "^##? " : undefined,
      });
      expect(ps.length).toBeGreaterThan(1);
      for (const p of ps) expect(texte.slice(p.char_start, p.char_end)).toBe(p.text);
    }
  });

  it("taille : fenêtres de la taille demandée, fin sur un blanc", () => {
    const ps = methodes({ methode: "taille" });
    expect(ps.every((p) => p.text.length <= 30)).toBe(true);
    expect(ps.map((p) => p.text).join(" ")).toContain("Deux phrases ici!");
  });

  it("phrase : regroupe des phrases entières", () => {
    const ps = methodes({ methode: "phrase", tailleJetons: 45, chevauchementJetons: 0 });
    expect(textes(ps)).toEqual([
      "# Titre\n\nUn paragraphe. Deux phrases ici!",
      "Et une troisième?",
      "## Sous\n\nAutre paragraphe.",
    ]);
  });

  it("markdown : une section par titre, avec le chemin des titres", () => {
    const ps = methodes({ methode: "markdown", tailleJetons: 500, tailleMaxJetons: 900 });
    expect(textes(ps)).toEqual([
      "# Titre\n\nUn paragraphe. Deux phrases ici! Et une troisième?",
      "## Sous\n\nAutre paragraphe.",
    ]);
    expect(ps.map((p) => p.heading_path)).toEqual(["Titre", "Titre › Sous"]);
  });

  it("markdown : un titre dans un bloc de code balisé ne coupe pas, et les titres de l'extracteur coupent", () => {
    const code = "Avant\n\n```\n# commentaire\n```\n\nAprès";
    expect(decouperTexte(code, { methode: "markdown" })).toHaveLength(1);
    const blocs = [titre("Un", 1), para("alpha"), titre("Deux", 1), para("beta")];
    expect(textes(decouper(blocs, { methode: "markdown" }))).toEqual(["Un\n\nalpha", "Deux\n\nbeta"]);
  });

  it("separateur : garde le séparateur en tête des morceaux suivants et comprend les échappements", () => {
    const ps = decouperTexte("un|deux||trois", { ...P1, methode: "separateur", valeur: "|" });
    expect(textes(ps)).toEqual(["un", "|deux", "|trois"]);
    const avecNl = decouperTexte("a\n---\nb\n---\nc", { methode: "separateur", valeur: "\\n---\\n" });
    expect(textes(avecNl)).toEqual(["a", "---\nb", "---\nc"]);
    expect(
      decouperTexte(mots(50), { ...P1, methode: "separateur", tailleJetons: 60, chevauchementJetons: 0 })
        .length,
    ).toBeGreaterThan(2);
  });

  it("regex : un passage par correspondance, et repli sur la taille si le motif est invalide, absent, trop long ou trop lent", () => {
    const t = "Article 1\nTexte un\nArticle 2\nTexte deux\nArticle 3\nTexte trois";
    expect(textes(decouperTexte(t, { ...P1, methode: "regex", valeur: "^Article \\d" }))).toEqual([
      "Article 1\nTexte un",
      "Article 2\nTexte deux",
      "Article 3\nTexte trois",
    ]);
    const long = mots(100);
    for (const valeur of ["(", "ZZZ", "a".repeat(600), undefined]) {
      const ps = decouperTexte(long, {
        ...P1,
        methode: "regex",
        valeur,
        tailleJetons: 100,
        chevauchementJetons: 0,
      });
      expect(ps.length).toBeGreaterThan(2);
    }
  });

  it("regex : un motif refusé en mode unicode (erreur d'un autre royaume) est repris sans `u`", () => {
    expect(new RegExp("Art\\-", "m").test("Art-")).toBe(true);
    const unicode = ["m", "u"].join("");
    expect(() => new RegExp("Art\\-", unicode)).toThrow(SyntaxError);
    expect(debutsRegex("^Art\\-", "Art-1\nx\nArt-2")).toEqual([0, 8]);
    const t = "Art-1\nTexte un\nArt-2\nTexte deux";
    expect(textes(decouperTexte(t, { ...P1, methode: "regex", valeur: "^Art\\-" }))).toEqual([
      "Art-1\nTexte un",
      "Art-2\nTexte deux",
    ]);
  });

  it("regex : un motif à rebours catastrophique est interrompu et le texte découpé quand même", () => {
    const piege = `${"a".repeat(45)}!`;
    const debut = Date.now();
    const ps = decouperTexte(piege.repeat(5), {
      ...P1,
      methode: "regex",
      valeur: "^(a+)+$",
      tailleJetons: 40,
      chevauchementJetons: 0,
    });
    expect(ps.length).toBeGreaterThan(1);
    expect(Date.now() - debut).toBeLessThan(8000);
  }, 15_000);
});

describe("redécoupes et regex stricte", () => {
  const blocs = [
    titre("Un", 1, { page: 1, boxes: [[1, 1, 2, 2]] }),
    para("Article 1 alpha. Article 2 beta. Article 3 gamma.", { page: 1, boxes: [[1, 3, 9, 4]] }),
    titre("Deux", 1, { page: 2, boxes: [[1, 1, 2, 2]] }),
    para("Article 4 delta. Article 5 epsilon.", { page: 2, boxes: [[1, 3, 9, 4]] }),
  ];
  const base = { ...P1, methode: "markdown" as const, tailleJetons: 500, tailleMaxJetons: 900 };

  it("remplace un passage de base par ses sous-passages, renumérote et garde positions, page et rectangles", () => {
    const { passages, ignores } = decouperAvecRedecoupes(blocs, base, [
      { index: 0, params: { ...P1, methode: "regex", valeur: "Article \\d" } },
      { index: 7, params: { methode: "taille" } },
    ]);
    expect(ignores).toEqual([7]);
    expect(passages.map((p) => [p.chunk_index, p.redecoupe_de, p.text])).toEqual([
      [0, 0, "Un"],
      [1, 0, "Article 1 alpha."],
      [2, 0, "Article 2 beta."],
      [3, 0, "Article 3 gamma."],
      [4, null, "Deux\n\nArticle 4 delta. Article 5 epsilon."],
    ]);
    litteral(blocs, passages);
    expect(passages[2]?.page).toBe(1);
    expect(passages[2]?.heading_path).toBe("Un");
    expect(passages[2]?.boxes).toEqual([{ page: 1, rects: [[1, 3, 9, 4]] }]);
    expect(passages[4]?.boxes.map((b) => b.page)).toEqual([2]);
  });

  it("sans redécoupe applicable, rend le découpage de base tel quel", () => {
    const seul = decouper(blocs, base);
    const r = decouperAvecRedecoupes(blocs, base, []);
    expect(r.passages.map((p) => ({ ...p, redecoupe_de: undefined }))).toEqual(
      seul.map((p) => ({ ...p, redecoupe_de: undefined })),
    );
    expect(r.passages.every((p) => p.redecoupe_de === null)).toBe(true);
  });

  it("regex stricte : un motif invalide est refusé au lieu de retomber sur la taille", () => {
    const params = { ...P1, methode: "regex" as const, valeur: "(" };
    expect(decouper(blocs, params).length).toBeGreaterThan(0);
    expect(() => decouper(blocs, params, { regexStricte: true })).toThrow(ErreurRag);
    try {
      decouper(blocs, params, { regexStricte: true });
    } catch (e) {
      expect((e as ErreurRag).code).toBe("regex_invalide");
    }
  });

  it("regex stricte : un motif catastrophique est interrompu et refusé", () => {
    const piege = [para(`${"a".repeat(45)}!`.repeat(5))];
    const debut = Date.now();
    expect(() =>
      decouper(piege, { ...P1, methode: "regex", valeur: "^(a+)+$" }, { regexStricte: true }),
    ).toThrow(/trop lente/u);
    expect(Date.now() - debut).toBeLessThan(8000);
  }, 15_000);

  it("une échéance dépassée interrompt les redécoupes", () => {
    expect(() =>
      decouperAvecRedecoupes(blocs, base, [{ index: 0, params: { methode: "taille" } }], {
        echeance: Date.now() - 1,
      }),
    ).toThrow(/trop long/u);
  });

  it("caractères exacts : un ratio de 1 donne des passages d'au plus la taille demandée", () => {
    const ps = decouper([para(mots(200))], { methode: "taille", tailleJetons: 100, caracteresParJeton: 1 });
    expect(ps.every((p) => p.text.length <= 100)).toBe(true);
    expect(ps.some((p) => p.text.length >= 90)).toBe(true);
  });
});

describe("texte brut", () => {
  it("reconnaît titres, paragraphes et code balisé, avec les positions du texte d'origine", () => {
    const t = "# Guide\n\nIntro courte.\n\n## Installation\n\n```sh\n# pas un titre\nnpm i\n```\n\nFin.";
    const ps = decouperTexte(t, { ...P1, tailleJetons: 25, chevauchementJetons: 0 });
    for (const p of ps) expect(t.slice(p.char_start, p.char_end)).toBe(p.text);
    expect(ps.find((p) => p.text.includes("npm i"))?.heading_path).toBe("Guide › Installation");
    expect(ps.find((p) => p.text.includes("Intro"))?.heading_path).toBe("Guide");
    expect(ps.some((p) => p.heading_path.includes("pas un titre"))).toBe(false);
  });
});

describe("volume", () => {
  it("découpe un gros document en un temps raisonnable", () => {
    const blocs: Bloc[] = [];
    for (let i = 0; i < 3000; i++) {
      if (i % 50 === 0) blocs.push(titre(`Chapitre ${i / 50}`, 1));
      blocs.push(para(`${mots(30, `p${i}x`)}. ${mots(10, `q${i}y`)}.`));
    }
    const debut = Date.now();
    const ps = decouper(blocs);
    expect(ps.length).toBeGreaterThan(100);
    expect(Date.now() - debut).toBeLessThan(5000);
    litteral(blocs, ps);
    const gros = mots(300_000);
    const t0 = Date.now();
    expect(decouperTexte(gros, { methode: "taille" }).length).toBeGreaterThan(500);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
