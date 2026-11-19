// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/echecs.test.ts — le compteur d'essais par entrée vit en base : deux connexions à la base (deux processus) le voient et l'incrémentent sans perte, le seau se vide en continu, sans effet de bord de fenêtre (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { initialiserBase, ouvrirBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, reglagesPgDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compterEssai, oublierEssais } from "../../../src/identite/annuaire/echecs";
import { validerFournisseur } from "../../../src/identite/reglages";
import type { FournisseurLdap } from "../../../src/identite/reglages";
import { MOTEURS } from "../banc";
import { ldapValide } from "../aides";

describe.each(MOTEURS)("compteur d'essais par entrée (%s)", (moteur) => {
  let t: BaseDeTest;
  let autre: Base;
  const f = validerFournisseur(ldapValide({ max_failures: 3, failure_window_sec: 100 })) as FournisseurLdap;

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    autre = ouvrirBase(
      moteur === "sqlite"
        ? { backend: "sqlite", path: t.emplacement, lockTimeoutMs: 2000 }
        : reglagesPgDeTest(t.emplacement),
    );
  });
  afterEach(async () => {
    await autre.fermer();
    await t.fermer();
  });

  const lignes = (): Promise<unknown[][]> =>
    t.base.valeurs("SELECT provider_id, subject, count, window_start FROM auth_failures");
  const niveau = async (): Promise<number> =>
    Number((await t.base.valeurs("SELECT window_start FROM auth_failures"))[0]?.[0]);

  it("le seuil est dépassé au quatrième essai, quelle que soit la connexion qui compte", async () => {
    expect(await compterEssai(t.base, f, "cle", 10)).toBe(false);
    expect(await compterEssai(autre, f, "cle", 11)).toBe(false);
    expect(await compterEssai(t.base, f, "cle", 12)).toBe(false);
    expect(await compterEssai(autre, f, "cle", 13)).toBe(true);
    expect(await t.base.valeurs("SELECT count FROM auth_failures")).toEqual([[3]]);
    expect(await niveau()).toBeCloseTo(2.91, 6);
  });

  it("essais simultanés depuis deux connexions : aucun n'est perdu", async () => {
    const f2 = validerFournisseur(ldapValide({ max_failures: 20 })) as FournisseurLdap;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => compterEssai(i % 2 === 0 ? t.base : autre, f2, "cle", 10 + i)),
    );
    expect(await t.base.valeurs("SELECT count FROM auth_failures")).toEqual([[12]]);
  });

  it("le niveau baisse avec le temps : un essai espacé repart de zéro, jamais d'effet de bord de fenêtre", async () => {
    await compterEssai(t.base, f, "cle", 10);
    await compterEssai(t.base, f, "cle", 11);
    expect(await compterEssai(t.base, f, "cle", 111)).toBe(false);
    expect(await niveau()).toBeCloseTo(1, 6);
  });

  it("à cheval sur deux fenêtres : trois essais à la fin de la première, trois au début de la suivante, un seul de plus passe", async () => {
    const permis: boolean[] = [];
    for (const t0 of [97, 98, 99, 101, 102, 103]) permis.push(!(await compterEssai(t.base, f, "cle", t0)));
    expect(permis).toEqual([true, true, true, false, false, false]);
  });

  it("jamais plus que la rafale puis le débit : sur 400 s, un essai par seconde laisse passer au plus max + 400·max/fenêtre", async () => {
    let passes = 0;
    for (let s = 0; s < 400; s++) if (!(await compterEssai(t.base, f, "cle", s))) passes++;
    expect(passes).toBeLessThanOrEqual(3 + (400 * 3) / 100);
    expect(passes).toBeGreaterThanOrEqual(3);
  });

  it("l'essai refusé n'ajoute rien : le niveau reste sous max et le blocage retombe après une fenêtre", async () => {
    for (let s = 0; s < 1000; s++) await compterEssai(t.base, f, "cle", s * 0.01);
    expect(await niveau()).toBeLessThanOrEqual(3);
    expect(await compterEssai(t.base, f, "cle", 10 + 100)).toBe(false);
  });

  it.each([
    [1, 86400],
    [1, 900],
    [4, 900],
  ])(
    "(%i essai, %i s) : après l'arrêt d'une attaque, un essai passe au plus tard après fenêtre / max",
    async (max, fenetre) => {
      const g = validerFournisseur(
        ldapValide({ max_failures: max, failure_window_sec: fenetre }),
      ) as FournisseurLdap;
      for (let i = 0; i < max; i++) expect(await compterEssai(t.base, g, "cle", 1000)).toBe(false);
      expect(await compterEssai(t.base, g, "cle", 1000)).toBe(true);
      expect(await compterEssai(t.base, g, "cle", 1000 + fenetre / max - 1)).toBe(true);
      expect(await compterEssai(t.base, g, "cle", 1000 + fenetre / max + 1)).toBe(false);
    },
  );

  it("chaque entrée a son compteur ; la réussite remet à zéro celui de l'entrée seule", async () => {
    await compterEssai(t.base, f, "a", 10);
    await compterEssai(t.base, f, "b", 10);
    await oublierEssais(autre, f, "a");
    expect(await lignes()).toEqual([["annuaire", "b", 1, 1]]);
  });

  it("une seule ligne par (fournisseur, entrée) : l'index est unique", async () => {
    await t.base.run(
      "INSERT INTO auth_failures(provider_id, subject, count, window_start, last_at) VALUES('p','s',1,1,1)",
    );
    await expect(
      t.base.run(
        "INSERT INTO auth_failures(provider_id, subject, count, window_start, last_at) VALUES('p','s',1,1,1)",
      ),
    ).rejects.toThrow();
  });
});
