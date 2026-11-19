// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/echecs.test.ts — le compteur d'essais par entrée vit en base : deux connexions à la base (deux processus) le voient et l'incrémentent sans perte, la fenêtre ne se prolonge pas (SQLite, PostgreSQL si ELPIS_TEST_PG). */
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

  it("le seuil est dépassé au quatrième essai, quelle que soit la connexion qui compte", async () => {
    expect(await compterEssai(t.base, f, "cle", 10)).toBe(false);
    expect(await compterEssai(autre, f, "cle", 11)).toBe(false);
    expect(await compterEssai(t.base, f, "cle", 12)).toBe(false);
    expect(await compterEssai(autre, f, "cle", 13)).toBe(true);
    expect(await lignes()).toEqual([["annuaire", "cle", 4, 10]]);
  });

  it("essais simultanés depuis deux connexions : aucun n'est perdu", async () => {
    const f2 = validerFournisseur(ldapValide({ max_failures: 20 })) as FournisseurLdap;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => compterEssai(i % 2 === 0 ? t.base : autre, f2, "cle", 10 + i)),
    );
    expect(await t.base.valeurs("SELECT count FROM auth_failures")).toEqual([[12]]);
  });

  it("la fenêtre s'ouvre au premier essai et ne se prolonge pas ; passée, elle repart de un", async () => {
    await compterEssai(t.base, f, "cle", 10);
    await compterEssai(t.base, f, "cle", 100);
    await compterEssai(t.base, f, "cle", 110);
    expect(await lignes()).toEqual([["annuaire", "cle", 3, 10]]);
    expect(await compterEssai(t.base, f, "cle", 111)).toBe(false);
    expect(await lignes()).toEqual([["annuaire", "cle", 1, 111]]);
  });

  it("chaque entrée a son compteur ; la réussite remet à zéro celui de l'entrée seule", async () => {
    await compterEssai(t.base, f, "a", 10);
    await compterEssai(t.base, f, "b", 10);
    await oublierEssais(autre, f, "a");
    expect(await lignes()).toEqual([["annuaire", "b", 1, 10]]);
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
