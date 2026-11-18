// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/appartenance.test.ts — l'appartenance est une recherche de portée base par mode, et une erreur d'annuaire n'est jamais un « non membre ». */
import { describe, expect, it } from "vitest";

import { appartient, groupeExiste } from "../../../src/identite/annuaire/appartenance";
import { ErreurAnnuaire } from "../../../src/identite/annuaire/erreur";
import { connexionFausse, entree, fournisseur } from "./faux";

const UTILISATEUR = entree("uid=jdupont,cn=users,dc=exemple,dc=lan");
const GROUPE = "cn=admins,cn=groups,dc=exemple,dc=lan";

describe("appartient", () => {
  it("memberof : base = utilisateur, filtre memberOf", async () => {
    const cnx = connexionFausse(() => [entree(UTILISATEUR.dn)]);
    expect(await appartient(cnx, fournisseur({ groups: { mode: "memberof" } }), UTILISATEUR, GROUPE)).toBe(
      true,
    );
    expect(cnx.appels).toHaveLength(1);
    expect(cnx.appels[0]?.base).toBe(UTILISATEUR.dn);
    expect(cnx.appels[0]?.o).toMatchObject({ portee: "base", filtre: `(memberOf=${GROUPE})`, limite: 1 });
    expect(cnx.appels[0]?.o.attributs).toEqual(["1.1"]);
  });

  it("chain : règle en chaîne d'Active Directory sur l'utilisateur", async () => {
    const cnx = connexionFausse();
    expect(await appartient(cnx, fournisseur({ groups: { mode: "chain" } }), UTILISATEUR, GROUPE)).toBe(
      false,
    );
    expect(cnx.appels[0]?.base).toBe(UTILISATEUR.dn);
    expect(cnx.appels[0]?.o.filtre).toBe(`(memberOf:1.2.840.113556.1.4.1941:=${GROUPE})`);
  });

  it("member : base = groupe, filtre member ou uniqueMember", async () => {
    const cnx = connexionFausse(() => [entree(GROUPE)]);
    expect(await appartient(cnx, fournisseur({ groups: { mode: "member" } }), UTILISATEUR, GROUPE)).toBe(
      true,
    );
    expect(cnx.appels[0]?.base).toBe(GROUPE);
    expect(cnx.appels[0]?.o).toMatchObject({
      portee: "base",
      filtre: `(|(member=${UTILISATEUR.dn})(uniqueMember=${UTILISATEUR.dn}))`,
    });
  });

  it("échappe un DN de groupe hostile", async () => {
    const cnx = connexionFausse();
    await appartient(cnx, fournisseur({ groups: { mode: "memberof" } }), UTILISATEUR, "cn=a*)(uid=*,dc=x");
    expect(cnx.appels[0]?.o.filtre).toBe("(memberOf=cn=a\\2a\\29\\28uid=\\2a,dc=x)");
  });

  it.each(["memberof", "chain", "member"] as const)(
    "%s : une erreur est propagée, jamais « false »",
    async (mode) => {
      const cnx = connexionFausse(() => {
        throw new ErreurAnnuaire("injoignable");
      });
      await expect(
        appartient(cnx, fournisseur({ groups: { mode } }), UTILISATEUR, GROUPE),
      ).rejects.toMatchObject({
        nature: "injoignable",
      });
    },
  );

  it("même un « objet inexistant » du serveur reste une erreur", async () => {
    const cnx = connexionFausse(() => {
      throw new ErreurAnnuaire("protocole", { code: 32 });
    });
    await expect(
      appartient(cnx, fournisseur({ groups: { mode: "member" } }), UTILISATEUR, GROUPE),
    ).rejects.toMatchObject({
      code: 32,
    });
  });

  it("refuse un groupe vide ou un DN à NUL avant toute recherche", async () => {
    const cnx = connexionFausse();
    await expect(appartient(cnx, fournisseur(), UTILISATEUR, "")).rejects.toBeInstanceOf(ErreurAnnuaire);
    await expect(appartient(cnx, fournisseur(), UTILISATEUR, "cn=a\0")).rejects.toBeInstanceOf(
      ErreurAnnuaire,
    );
    expect(cnx.appels).toHaveLength(0);
  });
});

describe("groupeExiste", () => {
  it("vrai si l'entrée répond, faux si elle n'existe pas", async () => {
    expect(
      await groupeExiste(
        connexionFausse(() => [entree(GROUPE)]),
        GROUPE,
      ),
    ).toBe(true);
    expect(
      await groupeExiste(
        connexionFausse(() => []),
        GROUPE,
      ),
    ).toBe(false);
  });

  it("faux seulement pour le code « objet inexistant » ; toute autre erreur est propagée", async () => {
    const non = connexionFausse(() => {
      throw new ErreurAnnuaire("protocole", { code: 32 });
    });
    expect(await groupeExiste(non, GROUPE)).toBe(false);
    for (const e of [
      new ErreurAnnuaire("protocole", { code: 50 }),
      new ErreurAnnuaire("injoignable"),
      new ErreurAnnuaire("identifiants", { code: 49 }),
    ]) {
      const cnx = connexionFausse(() => {
        throw e;
      });
      await expect(groupeExiste(cnx, GROUPE)).rejects.toBe(e);
    }
  });
});
