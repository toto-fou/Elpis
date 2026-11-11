// SPDX-License-Identifier: MIT
/** frontend/test/rag/decoupage.test.ts — découpage avancé, logique pure : champs par méthode, validation, normalisation, règles par extension, redécoupes, rang d'un passage, antirebond. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  avecValeur,
  champsVisibles,
  clePourCollection,
  clePourDocument,
  clePourParams,
  creerAntirebond,
  debutDeRedecoupe,
  decoupageDeBrouillon,
  decoupageDeDocument,
  empilerRedecoupe,
  erreursParams,
  erreursRegles,
  extensionNormalisee,
  indexDeBase,
  jetonsMax,
  largeurRelative,
  messageEchecDecoupage,
  normaliserParams,
  paramsDe,
  paramsEgaux,
  paramsParDefaut,
  paramsPourExtension,
  resumeParams,
  retirerRedecoupe,
} from "../../src/features/rag/decoupage";
import { DECOUPAGE_RAG_DEFAUT } from "@elpis/contracts";
import type { ParamsDecoupageRag, PassageListeRag } from "@elpis/contracts";

const base = (o: Partial<ParamsDecoupageRag> = {}): ParamsDecoupageRag => ({ ...paramsParDefaut(), ...o });
const passage = (index: number, redecoupe_de: number | null = null, jetons = 100): PassageListeRag => ({
  index,
  texte: `passage ${index}`,
  caracteres: jetons * 4,
  jetons,
  page: null,
  section: null,
  redecoupe_de,
});

afterEach(() => vi.useRealTimers());

describe("champs selon la méthode", () => {
  it("séparateur et expression prennent une valeur ; le chevauchement ne vaut que pour trois méthodes", () => {
    expect(champsVisibles("separateur")).toEqual({ valeur: true, chevauchement: false });
    expect(champsVisibles("regex")).toEqual({ valeur: true, chevauchement: false });
    expect(champsVisibles("markdown")).toEqual({ valeur: false, chevauchement: false });
    for (const m of ["auto", "taille", "phrase"] as const)
      expect(champsVisibles(m)).toEqual({ valeur: false, chevauchement: true });
    expect(avecValeur("regex") && avecValeur("separateur") && !avecValeur("auto")).toBe(true);
  });
});

describe("validation des paramètres", () => {
  it("les défauts du serveur sont valides", () => {
    expect(erreursParams(paramsParDefaut())).toEqual({});
    expect(paramsParDefaut()).toEqual(paramsDe(DECOUPAGE_RAG_DEFAUT));
  });

  it("taille : entier de 20 à 20 000", () => {
    expect(erreursParams(base({ taille: 19 })).taille).toBeDefined();
    expect(erreursParams(base({ taille: 20, chevauchement: 0 })).taille).toBeUndefined();
    expect(erreursParams(base({ taille: 20_000, taille_max: 20_000 })).taille).toBeUndefined();
    expect(erreursParams(base({ taille: 20_001 })).taille).toBeDefined();
    expect(erreursParams(base({ taille: 12.5 })).taille).toBeDefined();
    expect(erreursParams(base({ taille: Number.NaN })).taille).toBeDefined();
  });

  it("chevauchement : de 0 à 10 000 et strictement sous la moitié de la taille", () => {
    expect(
      erreursParams(base({ taille: 100, chevauchement: 49, taille_max: 200 })).chevauchement,
    ).toBeUndefined();
    expect(erreursParams(base({ taille: 100, chevauchement: 50, taille_max: 200 })).chevauchement).toBe(
      "Moins de la moitié de la taille d’un passage.",
    );
    expect(erreursParams(base({ chevauchement: -1 })).chevauchement).toBeDefined();
    expect(erreursParams(base({ chevauchement: 10_001 })).chevauchement).toBeDefined();
  });

  it("chevauchement caché (markdown, séparateur, expression) : jamais une erreur", () => {
    expect(erreursParams(base({ methode: "markdown", chevauchement: 9999 }))).toEqual({});
  });

  it("taille maximale : de 20 à 40 000 et au moins la taille", () => {
    expect(erreursParams(base({ taille_max: 19 })).tailleMax).toBeDefined();
    expect(erreursParams(base({ taille_max: 40_001 })).tailleMax).toBeDefined();
    expect(erreursParams(base({ taille: 600, taille_max: 599 })).tailleMax).toBe(
      "Au moins la taille d’un passage.",
    );
    expect(erreursParams(base({ taille: 600, taille_max: 600 })).tailleMax).toBeUndefined();
  });

  it("unité en caractères : les messages le disent", () => {
    expect(erreursParams(base({ unite: "caracteres", taille: 5 })).taille).toMatch(
      /^Entre 20 et 20\s000 caractères\.$/,
    );
  });

  it("séparateur : obligatoire, 200 caractères au plus ; expression : obligatoire et compilable", () => {
    expect(erreursParams(base({ methode: "separateur" })).valeur).toBe("Indiquez le séparateur.");
    expect(erreursParams(base({ methode: "separateur", valeur: "" })).valeur).toBe("Indiquez le séparateur.");
    expect(erreursParams(base({ methode: "separateur", valeur: "\\n\\n" })).valeur).toBeUndefined();
    expect(erreursParams(base({ methode: "separateur", valeur: "x".repeat(201) })).valeur).toBe(
      "200 caractères au plus.",
    );
    expect(erreursParams(base({ methode: "regex" })).valeur).toBe("Indiquez l’expression.");
    expect(erreursParams(base({ methode: "regex", valeur: "(?=Article \\d+)" })).valeur).toBeUndefined();
    expect(erreursParams(base({ methode: "regex", valeur: "^#{1,3} " })).valeur).toBeUndefined();
    expect(erreursParams(base({ methode: "regex", valeur: "(abc" })).valeur).toMatch(/^Expression invalide/);
    // La valeur d'une méthode qui n'en prend pas n'est jamais jugée.
    expect(erreursParams(base({ methode: "phrase", valeur: "(abc" }))).toEqual({});
  });
});

describe("normalisation et comparaison", () => {
  it("la valeur n'est gardée que pour séparateur et expression", () => {
    expect(normaliserParams(base({ methode: "phrase", valeur: "x" }))).not.toHaveProperty("valeur");
    expect(normaliserParams(base({ methode: "regex", valeur: "^a" })).valeur).toBe("^a");
    expect(normaliserParams(base({ methode: "separateur" })).valeur).toBe("");
  });

  it("chevauchement caché ramené sous la moitié de la taille, visible laissé tel quel", () => {
    expect(
      normaliserParams(base({ methode: "regex", valeur: "a", taille: 100, chevauchement: 300 }))
        .chevauchement,
    ).toBe(49);
    expect(
      normaliserParams(base({ methode: "regex", valeur: "a", taille: 100, chevauchement: 10 })).chevauchement,
    ).toBe(10);
    expect(normaliserParams(base({ methode: "markdown", taille: 20, chevauchement: 64 })).chevauchement).toBe(
      9,
    );
    expect(normaliserParams(base({ methode: "phrase", taille: 100, chevauchement: 300 })).chevauchement).toBe(
      300,
    );
  });

  it("deux jeux sont égaux sans tenir compte d'une valeur inutile", () => {
    expect(paramsEgaux(base({ methode: "phrase", valeur: "x" }), base({ methode: "phrase" }))).toBe(true);
    expect(paramsEgaux(base({ taille: 300 }), base())).toBe(false);
    expect(clePourParams(base())).toBe(clePourParams({ ...base() }));
  });

  it("résumé en une ligne", () => {
    expect(resumeParams(base())).toBe("Automatique · 512 jetons · chevauchement 64");
    expect(resumeParams(base({ methode: "regex", valeur: "^#", unite: "caracteres", taille: 800 }))).toBe(
      "Expression régulière · « ^# » · 800 caractères",
    );
  });
});

describe("règles par type de fichier", () => {
  it("extension ramenée à sa clé : sans point ni espace, en minuscules", () => {
    expect(extensionNormalisee(" .PDF ")).toBe("pdf");
    expect(extensionNormalisee("..Md")).toBe("md");
  });

  it("erreurs : vide, forme, doublon (insensible à la casse et au point)", () => {
    const r = (cle: number, ext: string) => ({ cle, ext, params: base() });
    expect(erreursRegles([r(1, "pdf"), r(2, "md")])).toEqual({});
    const e = erreursRegles([r(1, ""), r(2, "p-d"), r(3, "x".repeat(11)), r(4, "pdf"), r(5, ".PDF")]);
    expect(Object.keys(e)).toEqual(["1", "2", "3", "5"]);
    expect(e[5]).toBe("Une règle existe déjà pour ce type de fichier.");
  });

  it("découpage de collection : base normalisée et règles par clé d'extension, dans l'ordre de saisie", () => {
    const d = decoupageDeBrouillon(base({ methode: "markdown" }), [
      { cle: 1, ext: ".MD", params: base({ methode: "phrase", valeur: "x" }) },
      { cle: 2, ext: "pdf", params: base({ taille: 300 }) },
    ]);
    expect(Object.keys(d.par_extension)).toEqual(["md", "pdf"]);
    expect(d.par_extension["md"]).not.toHaveProperty("valeur");
    expect(d.methode).toBe("markdown");
  });

  it("clé canonique : l'ordre des règles ne compte pas, une règle en plus si", () => {
    const a = decoupageDeBrouillon(base(), [
      { cle: 1, ext: "md", params: base({ taille: 300 }) },
      { cle: 2, ext: "pdf", params: base({ taille: 400 }) },
    ]);
    const b = decoupageDeBrouillon(base(), [
      { cle: 2, ext: "pdf", params: base({ taille: 400 }) },
      { cle: 1, ext: "md", params: base({ taille: 300 }) },
    ]);
    const c = decoupageDeBrouillon(base(), [{ cle: 1, ext: "md", params: base({ taille: 300 }) }]);
    expect(clePourCollection(a)).toBe(clePourCollection(b));
    expect(clePourCollection(a)).not.toBe(clePourCollection(c));
  });

  it("paramètres d'un document : la règle de son extension, sinon la base", () => {
    const d = decoupageDeBrouillon(base(), [{ cle: 1, ext: "pdf", params: base({ taille: 300 }) }]);
    expect(paramsPourExtension(d, "pdf").taille).toBe(300);
    expect(paramsPourExtension(d, ".PDF").taille).toBe(300);
    expect(paramsPourExtension(d, "md").taille).toBe(512);
  });

  it("règle sur un type de fichier inconnu : refusée ; absente du découpage envoyé", () => {
    const regles = [{ cle: 1, ext: "rtf", params: base() }];
    expect(erreursRegles(regles)[1]).toBe("Ce type de fichier n’est pas pris en charge.");
    expect(decoupageDeBrouillon(base(), regles).par_extension).toEqual({});
  });
});

describe("découpage d'un document", () => {
  it("hérite et sans redécoupe : rien à envoyer (null)", () => {
    expect(decoupageDeDocument(null, [])).toBeNull();
  });

  it("propre et/ou redécoupes : paramètres normalisés, redécoupes normalisées", () => {
    const r = { index: 3, params: base({ methode: "regex", valeur: "^a", chevauchement: 900 }) };
    expect(decoupageDeDocument(null, [r])).toEqual({
      redecoupes: [{ index: 3, params: { ...r.params, chevauchement: 255 } }],
    });
    const d = decoupageDeDocument(base({ methode: "phrase" }), []);
    expect(d).toEqual({ params: base({ methode: "phrase" }), redecoupes: [] });
  });

  it("clé canonique : hériter vaut « heritage », l'ordre des redécoupes ne compte pas", () => {
    expect(clePourDocument(null)).toBe("heritage");
    expect(clePourDocument({ redecoupes: [] })).toBe("heritage");
    const a = { index: 1, params: base({ taille: 300 }) };
    const b = { index: 4, params: base({ taille: 400 }) };
    expect(clePourDocument({ redecoupes: [a, b] })).toBe(clePourDocument({ redecoupes: [b, a] }));
    expect(clePourDocument({ params: base(), redecoupes: [] })).not.toBe("heritage");
  });
});

describe("redécoupes d'un aperçu", () => {
  it("elles s'empilent, triées ; une seconde sur le même passage remplace la première", () => {
    const a = { index: 5, params: base({ taille: 300 }) };
    const b = { index: 2, params: base({ taille: 400 }) };
    let l = empilerRedecoupe(empilerRedecoupe([], a), b);
    expect(l.map((r) => r.index)).toEqual([2, 5]);
    l = empilerRedecoupe(l, { index: 5, params: base({ taille: 800 }) });
    expect(l).toHaveLength(2);
    expect(l[1]?.params.taille).toBe(800);
    expect(retirerRedecoupe(l, 2).map((r) => r.index)).toEqual([5]);
    expect(retirerRedecoupe(l, 9)).toHaveLength(2);
  });

  it("rang d'un passage dans le découpage de base : les passages redécoupés portent celui de leur origine", () => {
    // base 0, 1, [2 redécoupé en trois], 3, 4
    const l = [passage(0), passage(1), passage(2, 2), passage(3, 2), passage(4, 2), passage(5), passage(6)];
    expect(indexDeBase(l, 0)).toBe(0);
    expect(indexDeBase(l, 1)).toBe(1);
    expect(indexDeBase(l, 2)).toBe(2);
    expect(indexDeBase(l, 4)).toBe(2);
    expect(indexDeBase(l, 5)).toBe(3);
    expect(indexDeBase(l, 6)).toBe(4);
  });

  it("deux groupes redécoupés de suite restent distincts", () => {
    const l = [passage(0), passage(1, 1), passage(2, 1), passage(3, 2), passage(4)];
    expect(indexDeBase(l, 3)).toBe(2);
    expect(indexDeBase(l, 4)).toBe(3);
    expect(debutDeRedecoupe(l, 1)).toBe(true);
    expect(debutDeRedecoupe(l, 2)).toBe(false);
    expect(debutDeRedecoupe(l, 3)).toBe(true);
    expect(debutDeRedecoupe(l, 0)).toBe(false);
    expect(debutDeRedecoupe(l, 9)).toBe(false);
  });

  it("barre de taille relative : le plus long vaut 100, un petit reste visible, sans mesure 0", () => {
    const l = [passage(0, null, 200), passage(1, null, 100), passage(2, null, 1)];
    const max = jetonsMax(l);
    expect(max).toBe(200);
    expect(largeurRelative(200, max)).toBe(100);
    expect(largeurRelative(100, max)).toBe(50);
    expect(largeurRelative(1, max)).toBe(2);
    expect(largeurRelative(5, 0)).toBe(0);
    expect(jetonsMax([])).toBe(0);
  });
});

describe("messages et réponse du serveur", () => {
  it("codes stables en clair, sinon le message du serveur, sinon le défaut", () => {
    expect(messageEchecDecoupage("regex_invalide", "x", "d")).toBe("L’expression régulière est invalide.");
    expect(messageEchecDecoupage("sources_fermees", "", "d")).toContain(
      "n’a pas ouvert les documents sources",
    );
    expect(messageEchecDecoupage(null, "Erreur réseau", "d")).toBe("Erreur réseau");
    expect(messageEchecDecoupage(null, "", "défaut")).toBe("défaut");
  });

  it("codes du serveur pour l'aperçu : extrait absent, trop de passages, calcul trop long", () => {
    expect(messageEchecDecoupage("extrait_indisponible", "", "d")).toBe(
      "Réindexez le document pour obtenir l’aperçu.",
    );
    expect(messageEchecDecoupage("trop_de_passages", "", "d")).toContain("trop de passages");
    expect(messageEchecDecoupage("decoupage_trop_long", "", "d")).toContain("trop long");
  });
});

describe("antirebond", () => {
  it("plusieurs appels rapprochés n'en font qu'un, après la pause", () => {
    vi.useFakeTimers();
    const rappel = vi.fn();
    const a = creerAntirebond(rappel, 400);
    a.planifier();
    vi.advanceTimersByTime(300);
    a.planifier();
    vi.advanceTimersByTime(300);
    expect(rappel).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(rappel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(rappel).toHaveBeenCalledTimes(1);
  });

  it("annuler abandonne l'appel en attente ; on peut replanifier ensuite", () => {
    vi.useFakeTimers();
    const rappel = vi.fn();
    const a = creerAntirebond(rappel, 100);
    a.planifier();
    a.annuler();
    vi.advanceTimersByTime(500);
    expect(rappel).not.toHaveBeenCalled();
    a.planifier();
    vi.advanceTimersByTime(100);
    expect(rappel).toHaveBeenCalledTimes(1);
  });
});
