// SPDX-License-Identifier: MIT
/** apps/core/test/skills/frontmatter.test.ts — parseur de frontmatter et validation Agent Skills : vecteurs Python (valeurs, blocs, fichiers, erreurs). */
import { describe, expect, it } from "vitest";

import {
  FlottantPy,
  frontmatterEnObjet,
  parseFrontmatterBlock,
  parseValue,
  splitFrontmatter,
  strFrontmatter,
} from "../../src/skills/frontmatter";
import type { ValeurFrontmatter } from "../../src/skills/frontmatter";
import { validateDescription, validateFrontmatter, validateName } from "../../src/skills/validation";
import { lireVecteurs } from "../vecteurs-moteur";

interface Vecteurs {
  valeurs: { brut: string; valeur: unknown }[];
  blocs: { bloc: string; frontmatter: unknown }[];
  contenus: { contenu: string; frontmatter: unknown; corps: string; validation: string[] }[];
  noms: { nom: string | null; dossier: string | null; erreurs: string[] }[];
  descriptions: { description: string | null; erreurs: string[] }[];
  frontmatters: { frontmatter: unknown; dossier: string | null; erreurs: string[] }[];
}

const v = lireVecteurs<Vecteurs>("skills-frontmatter");

const NON_FINIS: Readonly<Record<string, number>> = { inf: Infinity, "-inf": -Infinity, nan: Number.NaN };

/** Valeur Python encodée (`$dict` ordonné, `$float` par son repr) → valeur TS ; `flottants` = en `FlottantPy`. */
function versTs(x: unknown, flottants = false): unknown {
  if (Array.isArray(x)) return x.map((y) => versTs(y, flottants));
  if (typeof x === "object" && x !== null) {
    const o = x as Record<string, unknown>;
    if ("$dict" in o)
      return new Map((o["$dict"] as [string, unknown][]).map(([k, y]) => [k, versTs(y, flottants)]));
    if ("$float" in o) {
      const repr = String(o["$float"]);
      return flottants ? new FlottantPy(NON_FINIS[repr] ?? Number(repr)) : repr;
    }
  }
  return x;
}

/** Valeur TS comparable à `versTs` : un flottant par son repr, l'ordre des dicts conservé. */
function comparable(x: ValeurFrontmatter | unknown): unknown {
  if (x instanceof FlottantPy) return x.toString();
  if (x instanceof Map) return new Map([...x].map(([k, y]) => [k, comparable(y)]));
  if (Array.isArray(x)) return x.map(comparable);
  return x;
}

function verifierDict(obtenu: unknown, attendu: unknown, contexte: string): void {
  const a = versTs(attendu);
  expect(comparable(obtenu), contexte).toEqual(a);
  if (a instanceof Map) expect([...(obtenu as Map<string, unknown>).keys()], contexte).toEqual([...a.keys()]);
}

describe("vecteurs Python de llm_core/_frontmatter.py", () => {
  it("valeurs : textes, nombres (repr des flottants), booléens, listes et dicts en ligne", () => {
    for (const c of v.valeurs) {
      const obtenu = parseValue(c.brut);
      expect(comparable(obtenu), JSON.stringify(c.brut)).toEqual(versTs(c.valeur));
      if (typeof c.valeur === "object" && c.valeur !== null && "$float" in c.valeur)
        expect(obtenu, JSON.stringify(c.brut)).toBeInstanceOf(FlottantPy);
    }
  });

  it("blocs : imbrication d'un niveau, commentaires, fins de ligne Unicode, ordre et clés quelconques", () => {
    for (const c of v.blocs)
      verifierDict(parseFrontmatterBlock(c.bloc), c.frontmatter, JSON.stringify(c.bloc));
  });

  it("fichiers : délimiteurs `---` au sens de re.MULTILINE, corps sans sauts de ligne de tête", () => {
    for (const c of v.contenus) {
      const [fm, corps] = splitFrontmatter(c.contenu);
      verifierDict(fm, c.frontmatter, JSON.stringify(c.contenu));
      expect(corps, JSON.stringify(c.contenu)).toBe(c.corps);
      expect(validateFrontmatter(fm, { dirName: "dossier" }), JSON.stringify(c.contenu)).toEqual(
        c.validation,
      );
    }
  });
});

describe("vecteurs Python de llm_core/_skill_validate.py", () => {
  it("nom : longueur en points de code, motif, mots réservés, nom du dossier", () => {
    for (const c of v.noms)
      expect(validateName(c.nom, { dirName: c.dossier }), JSON.stringify([c.nom, c.dossier])).toEqual(
        c.erreurs,
      );
  });

  it("description : requise, bornée, sans chevrons", () => {
    for (const c of v.descriptions)
      expect(validateDescription(c.description), JSON.stringify(c.description)?.slice(0, 40)).toEqual(
        c.erreurs,
      );
  });

  it("frontmatter : str() de Python sur les valeurs non textuelles, repli sur le nom du dossier", () => {
    for (const c of v.frontmatters) {
      const fm = versTs(c.frontmatter, true) as Map<string, unknown>;
      expect(validateFrontmatter(fm, { dirName: c.dossier }), JSON.stringify(c.frontmatter)).toEqual(
        c.erreurs,
      );
    }
  });
});

describe("comportements des tests pytest", () => {
  it("metadata imbriqué et version entre guillemets", () => {
    const [fm, corps] = splitFrontmatter(
      '---\nname: x\ndescription: d\nmetadata:\n  author: me\n  version: "1.0"\n---\nbody\n',
    );
    expect(fm.get("name")).toBe("x");
    const meta = fm.get("metadata") as Map<string, unknown>;
    expect(meta).toBeInstanceOf(Map);
    expect(meta.get("author")).toBe("me");
    expect(strFrontmatter(meta.get("version"))).toBe("1.0");
    expect(corps.trim()).toBe("body");
  });

  it("un flottant garde son repr Python (`version: 1.0` reste « 1.0 »)", () => {
    expect(strFrontmatter(parseValue("1.0"))).toBe("1.0");
    expect(strFrontmatter(parseValue("1e16"))).toBe("1e+16");
    expect(strFrontmatter(parseValue("{a: 1.0, b: x}"))).toBe("{'a': 1.0, 'b': 'x'}");
    expect(Number(parseValue("2.5"))).toBe(2.5);
    expect(JSON.stringify({ v: parseValue("2.5") })).toBe('{"v":2.5}');
  });

  it("frontmatter en JSON : Map en objet, flottant en nombre", () => {
    const [fm] = splitFrontmatter("---\nversion: 1.0\nmetadata:\n  a: 2.5\n  b: [x]\n---\n");
    expect(frontmatterEnObjet(fm)).toEqual({ version: 1, metadata: { a: 2.5, b: ["x"] } });
    expect(JSON.stringify(frontmatterEnObjet(fm))).toBe('{"version":1,"metadata":{"a":2.5,"b":["x"]}}');
  });

  it("règles du nom et de la description", () => {
    expect(validateName("pdf-processing", { dirName: "pdf-processing" })).toEqual([]);
    expect(validateName("PDF", { dirName: "PDF" }).length).toBeGreaterThan(0);
    expect(validateName("claude-x", { dirName: "claude-x" }).some((e) => e.includes("réservé"))).toBe(true);
    expect(validateName("foo", { dirName: "bar" }).some((e) => e.includes("dossier"))).toBe(true);
    expect(validateDescription("x".repeat(1025)).some((e) => e.includes("1024"))).toBe(true);
  });
});
