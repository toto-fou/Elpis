// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/referentiels.test.ts — la matrice des référentiels de sécurité est tenue : aucune exigence en double, chaque exigence applicable a une preuve, chaque preuve désigne un fichier de test qui existe et porte ce titre. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIGENCES } from "./referentiels";

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

  it("chaque preuve désigne un fichier de test existant qui contient ce titre", () => {
    const manques: string[] = [];
    for (const e of EXIGENCES)
      for (const p of e.preuves) {
        const texte = /\.test\.ts$/u.test(p.fichier) ? contenu(p.fichier) : null;
        if (texte === null) manques.push(`${e.referentiel} ${e.id} : fichier absent ${p.fichier}`);
        else if (p.titre.trim() === "" || !texte.includes(p.titre))
          manques.push(`${e.referentiel} ${e.id} : titre absent de ${p.fichier} : ${p.titre}`);
      }
    expect(manques).toEqual([]);
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
