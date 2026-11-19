// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/referentiels.test.ts — la matrice des référentiels de sécurité est tenue : aucune exigence en double, chaque exigence applicable a une preuve, chaque preuve désigne le titre d'un test actif et unique d'un fichier qui existe, sans skip, todo ni only. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { EXIGENCES } from "./referentiels";
import { defautDePreuve, lireTests } from "./referentiels-garde";

const RACINE = join(import.meta.dirname, "..", "..", "..", "..");
const lecture = new Map<string, string>();
function contenu(fichier: string): string | null {
  const chemin = join(RACINE, fichier);
  if (!existsSync(chemin)) return null;
  if (!lecture.has(chemin)) lecture.set(chemin, readFileSync(chemin, "utf8"));
  return lecture.get(chemin) ?? null;
}

describe("matrice des référentiels de sécurité", () => {
  it("aucun identifiant n'est en double dans un référentiel", () => {
    const vus = new Set<string>();
    const doubles: string[] = [];
    for (const e of EXIGENCES) {
      const cle = `${e.referentiel} ${e.id}`;
      if (vus.has(cle)) doubles.push(cle);
      vus.add(cle);
    }
    expect(doubles).toEqual([]);
  });

  it("chaque exigence porte un intitulé ; une exigence non applicable dit pourquoi", () => {
    const sans = EXIGENCES.filter(
      (e) => e.intitule.trim() === "" || (!e.applicable && (e.pourquoi ?? "").trim() === ""),
    ).map((e) => `${e.referentiel} ${e.id}`);
    expect(sans).toEqual([]);
  });

  it("chaque exigence applicable a au moins une preuve", () => {
    const sans = EXIGENCES.filter((e) => e.applicable && e.preuves.length === 0).map(
      (e) => `${e.referentiel} ${e.id}`,
    );
    expect(sans).toEqual([]);
  });

  it("les preuves demandent la commande openssl : sans elle, les tests qui les portent seraient sautés sans bruit", () => {
    expect(OPENSSL_DISPONIBLE, "installer la commande openssl pour lancer les preuves").toBe(true);
  });

  it("un fichier cité comme preuve ne contient ni skip, ni todo, ni only", () => {
    const fautifs: string[] = [];
    for (const f of new Set(EXIGENCES.flatMap((e) => e.preuves.map((p) => p.fichier)))) {
      const texte = contenu(f);
      if (texte !== null && lireTests(texte).interdits.length > 0) fautifs.push(f);
    }
    expect(fautifs).toEqual([]);
  });

  it("chaque preuve désigne le titre d'un test actif, unique dans un fichier de test existant", () => {
    const manques: string[] = [];
    for (const e of EXIGENCES)
      for (const p of e.preuves) {
        const texte = /\.test\.ts$/u.test(p.fichier) ? contenu(p.fichier) : null;
        if (texte === null) manques.push(`${e.referentiel} ${e.id} : fichier absent ${p.fichier}`);
        else {
          const defaut = defautDePreuve(texte, p.titre);
          if (defaut !== null)
            manques.push(`${e.referentiel} ${e.id} : ${defaut} : ${p.fichier} : ${p.titre}`);
        }
      }
    expect(manques).toEqual([]);
  });

  it("une portée, quand elle est donnée, n'est jamais vide", () => {
    const vides = EXIGENCES.filter((e) => e.portee !== undefined && e.portee.trim() === "").map(
      (e) => `${e.referentiel} ${e.id}`,
    );
    expect(vides).toEqual([]);
  });

  it("une exigence applicable n'a pas pour seule preuve le fichier de la matrice", () => {
    const circulaires = EXIGENCES.filter((e) => e.preuves.some((p) => p.fichier.includes("referentiels")));
    expect(circulaires).toEqual([]);
  });

  it("chaque référentiel de la mission est présent", () => {
    const presents = new Set(EXIGENCES.map((e) => e.referentiel));
    for (const r of [
      "ANSSI-PA-080",
      "RFC 9700",
      "OpenID Connect Core 1.0",
      "OpenID Connect Back-Channel Logout 1.0",
      "OWASP ASVS 5.0",
      "ANSSI TLS SDE-NT-35 v1.2",
      "ANSSI-PG-078",
      "RFC 4513",
    ])
      expect(presents.has(r), r).toBe(true);
  });
});

describe("garde-fou : lecture des fichiers de test", () => {
  const TITRE = "le titre d'un vrai test de plus de vingt caractères";

  it("un titre écrit dans un commentaire ou dans un tableau de cas n'est pas un test", () => {
    const texte = `// ${TITRE}\nconst cas = ["${TITRE}"];\nit("autre chose", () => {});`;
    expect(defautDePreuve(texte, TITRE)).not.toBeNull();
  });

  it("un titre d'it, d'it.each et d'it.skipIf est reconnu", () => {
    const texte = [
      `it("${TITRE} (simple)", () => {});`,
      "it.each([1, 2])(\n  `gabarit de titre d'un it.each : %s`,\n  () => {},\n);",
      `it.skipIf(false)("${TITRE} (conditionnel)", () => {});`,
      `test("${TITRE} (test)", () => {});`,
    ].join("\n");
    expect(defautDePreuve(texte, `${TITRE} (simple)`)).toBeNull();
    expect(defautDePreuve(texte, "gabarit de titre d'un it.each")).toBeNull();
    expect(defautDePreuve(texte, `${TITRE} (conditionnel)`)).toBeNull();
    expect(defautDePreuve(texte, `${TITRE} (test)`)).toBeNull();
    expect(lireTests(texte).interdits).toEqual([]);
  });

  it("it.skip, it.todo, it.only et describe.skip sont relevés, pas skipIf", () => {
    const texte = `it.skip("a", () => {});\nit.todo("b");\nit.only("c", () => {});\ndescribe.skip("d", () => {});\ndescribe.skipIf(true)("e", () => {});`;
    expect(lireTests(texte).interdits).toEqual(["it.skip", "it.todo", "it.only", "describe.skip"]);
  });

  it("un titre cité en double dans le fichier est refusé", () => {
    const texte = `it("${TITRE} (a)", () => {});\nit("${TITRE} (b)", () => {});`;
    expect(defautDePreuve(texte, TITRE)).not.toBeNull();
    expect(defautDePreuve(texte, `${TITRE} (a)`)).toBeNull();
  });

  it("une sous-chaîne de moins de vingt caractères est refusée, un titre de describe n'est pas un test", () => {
    expect(defautDePreuve(`it("${TITRE}", () => {});`, "titre court")).not.toBeNull();
    expect(defautDePreuve(`describe("${TITRE}", () => {});`, TITRE)).not.toBeNull();
  });
});
