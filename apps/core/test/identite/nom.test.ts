// SPDX-License-Identifier: MIT
/** apps/core/test/identite/nom.test.ts — le nom Elpis dérivé d'un identifiant externe : forme stricte, noms réservés refusés, jamais de suffixe ; un nom pris seulement par des comptes rattachés est repéré (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createUser } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { describe, expect, it } from "vitest";

import { nomDerive, nomPris, nomPrisParRattaches } from "../../src/identite/nom";
import { MOTEURS } from "./banc";

describe("nomDerive", () => {
  it.each([
    ["jdupont", "jdupont"],
    ["Jean.Dupont", "jean-dupont"],
    ["JEAN_DUPONT", "jean_dupont"],
    ["jean--dupont", "jean-dupont"],
    ["--jean.dupont--", "jean-dupont"],
    ["j.dupont@exemple.lan", "j-dupont-exemple-lan"],
    ["ＪＥＡＮ", "jean"],
    ["a1", "a1"],
    ["x".repeat(64), "x".repeat(64)],
  ])("%s → %s", (entree, attendu) => {
    expect(nomDerive(entree)).toBe(attendu);
  });

  it.each([
    ["vide", ""],
    ["un seul caractère", "a"],
    ["65 caractères", "x".repeat(65)],
    ["que des séparateurs", "..."],
    ["commence par un tiret bas", "_jean"],
    ["admin", "admin"],
    ["ADMIN", "ADMIN"],
    ["root", "root"],
    ["system", "system"],
    ["elpis", "elpis"],
    ["guest", "guest"],
    ["Admin.", "Admin."],
    ["user_12", "user_12"],
    ["USER_007", "USER_007"],
    ["demi-paire isolée", "jean\ud800"],
  ])("refusé : %s", (_nom, entree) => {
    expect(nomDerive(entree)).toBeNull();
  });

  it("user_ suivi d'autre chose que des chiffres reste valide ; aucun suffixe pour lever une collision", () => {
    expect(nomDerive("user_abc")).toBe("user_abc");
    expect(nomDerive("administrateur")).toBe("administrateur");
    expect(nomDerive("jean.dupont")).toBe(nomDerive("Jean-Dupont"));
  });
});

describe.each(MOTEURS)("nom pris par des comptes rattachés (%s)", (moteur) => {
  it("vrai seulement si tout compte qui porte le nom est rattaché : un homonyme local peut encore être préparé", async () => {
    const t = ouvrirBaseDeTest(moteur);
    try {
      await initialiserBase(t.base);
      const lier = (uid: number, sub: string): Promise<unknown> =>
        t.base.run(
          "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?, 'autre', ?, 'oidc:https://autre.exemple.lan', 'auto', 1)",
          [uid, sub],
        );
      expect(await nomPrisParRattaches(t.base, "chloe-martin")).toBe(false);
      const tiret = await createUser(t.base, "chloe-martin", "mdp-chloe-1");
      expect([
        await nomPris(t.base, "chloe-martin"),
        await nomPrisParRattaches(t.base, "chloe-martin"),
      ]).toEqual([true, false]);
      await lier(tiret, "s-tiret");
      expect(await nomPrisParRattaches(t.base, "Chloe.Martin")).toBe(true);
      const souligne = await createUser(t.base, "chloe_martin", "mdp-chloe-2");
      expect(await nomPrisParRattaches(t.base, "chloe-martin")).toBe(false);
      await lier(souligne, "s-souligne");
      expect(await nomPrisParRattaches(t.base, "chloe-martin")).toBe(true);
      expect(await nomPrisParRattaches(t.base, "chloe-martine")).toBe(false);
    } finally {
      await t.fermer();
    }
  });
});
