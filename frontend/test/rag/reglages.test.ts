// SPDX-License-Identifier: MIT
/** frontend/test/rag/reglages.test.ts — onglet Réglages : brouillon, validation du nom, de la description, du découpage et des règles par extension, corps du PATCH réduit à la différence. */
import { describe, expect, it } from "vitest";

import { DECOUPAGE_RAG_DEFAUT } from "@elpis/contracts";

import { paramsDe } from "../../src/features/rag/decoupage";
import {
  aDesErreurs,
  brouillonDe,
  corpsDifference,
  erreursBrouillon,
} from "../../src/features/rag/rag-reglages";
import { collection, decoupage } from "./aides";

describe("brouillon", () => {
  it("copie la collection : découpage de base, règles par extension, OCR", () => {
    const pdf = { ...paramsDe(DECOUPAGE_RAG_DEFAUT), methode: "phrase" as const, taille: 300 };
    const c = collection(1, {
      name: "Réseau",
      description: "Notes",
      ocr: true,
      chunking: decoupage({ methode: "markdown", par_extension: { pdf } }),
    });
    const b = brouillonDe(c);
    expect(b).toMatchObject({ name: "Réseau", description: "Notes", ocr: true });
    expect(b.decoupage).toEqual({
      methode: "markdown",
      unite: "jetons",
      taille: 512,
      chevauchement: 64,
      taille_max: 1200,
    });
    expect(b.regles).toHaveLength(1);
    expect(b.regles[0]).toMatchObject({ ext: "pdf", params: pdf });
  });
});

describe("validation", () => {
  const ok = brouillonDe(collection(1, { name: "Réseau" }));

  it("brouillon valide : aucune erreur", () => {
    expect(aDesErreurs(erreursBrouillon(ok))).toBe(false);
  });

  it("nom obligatoire, 80 caractères au plus (espaces retirés)", () => {
    expect(erreursBrouillon({ ...ok, name: "   " }).name).toBe("Le nom est obligatoire.");
    expect(erreursBrouillon({ ...ok, name: "x".repeat(81) }).name).toBe("80 caractères au plus.");
    expect(erreursBrouillon({ ...ok, name: " " + "x".repeat(80) + " " }).name).toBeUndefined();
  });

  it("description de 500 caractères au plus", () => {
    expect(erreursBrouillon({ ...ok, description: "d".repeat(501) }).description).toBe(
      "500 caractères au plus.",
    );
    expect(erreursBrouillon({ ...ok, description: "d".repeat(500) }).description).toBeUndefined();
  });

  it("découpage de base invalide : taille hors bornes", () => {
    const e = erreursBrouillon({ ...ok, decoupage: { ...ok.decoupage, taille: 10 } });
    expect(e.decoupage.taille).toMatch(/^Entre 20 et 20\s000 jetons\.$/);
    expect(aDesErreurs(e)).toBe(true);
  });

  it("règles : extension vide, mal formée ou en double, et valeurs invalides d'une règle", () => {
    const regle = (cle: number, ext: string, taille = 512) => ({
      cle,
      ext,
      params: { ...ok.decoupage, taille },
    });
    const e = erreursBrouillon({
      ...ok,
      regles: [regle(1, ""), regle(2, "p d f"), regle(3, ".PDF"), regle(4, "pdf"), regle(5, "md", 5)],
    });
    expect(e.regles[1]).toBe("Choisissez un type de fichier.");
    expect(e.regles[2]).toBe("Ce type de fichier n’est pas pris en charge.");
    expect(e.regles[3]).toBeUndefined();
    expect(e.regles[4]).toBe("Une règle existe déjà pour ce type de fichier.");
    expect(e.reglesParams[5]?.taille).toBeDefined();
    expect(aDesErreurs(e)).toBe(true);
  });
});

describe("corps du PATCH", () => {
  const c = collection(1, { name: "Réseau", description: "Notes", ocr: false });

  it("rien n'a changé : corps vide", () => {
    expect(corpsDifference(brouillonDe(c), c)).toEqual({});
  });

  it("seulement les champs modifiés, nom nettoyé", () => {
    expect(corpsDifference({ ...brouillonDe(c), name: "  Réseau 2 ", description: "Autre" }, c)).toEqual({
      name: "Réseau 2",
      description: "Autre",
    });
    expect(corpsDifference({ ...brouillonDe(c), ocr: true }, c)).toEqual({ ocr: true });
  });

  it("découpage : tout le découpage de la collection part, règles comprises", () => {
    const b = brouillonDe(c);
    const corps = corpsDifference(
      {
        ...b,
        decoupage: { ...b.decoupage, methode: "regex", valeur: "^#{1,3} ", chevauchement: 5000 },
        regles: [{ cle: 9, ext: " .PDF ", params: { ...b.decoupage, methode: "phrase", taille: 300 } }],
      },
      c,
    );
    expect(corps.chunking).toEqual({
      methode: "regex",
      valeur: "^#{1,3} ",
      unite: "jetons",
      taille: 512,
      // chevauchement caché pour une expression : ramené sous la moitié de la taille
      chevauchement: 255,
      taille_max: 1200,
      par_extension: {
        pdf: { methode: "phrase", unite: "jetons", taille: 300, chevauchement: 64, taille_max: 1200 },
      },
    });
  });

  it("une valeur inutile ou un ordre de règles différent ne change rien", () => {
    const avec = collection(2, {
      chunking: decoupage({
        par_extension: {
          md: { ...paramsDe(DECOUPAGE_RAG_DEFAUT), methode: "markdown" },
          pdf: { ...paramsDe(DECOUPAGE_RAG_DEFAUT), taille: 300 },
        },
      }),
    });
    const b = brouillonDe(avec);
    expect(corpsDifference({ ...b, regles: [...b.regles].reverse() }, avec)).toEqual({});
    expect(corpsDifference({ ...b, decoupage: { ...b.decoupage, valeur: "inutile" } }, avec)).toEqual({});
  });

  it("retirer une règle est un changement", () => {
    const avec = collection(2, {
      chunking: decoupage({
        par_extension: { pdf: { ...paramsDe(DECOUPAGE_RAG_DEFAUT), taille: 300 } },
      }),
    });
    const b = brouillonDe(avec);
    expect(corpsDifference({ ...b, regles: [] }, avec).chunking?.par_extension).toEqual({});
  });
});
