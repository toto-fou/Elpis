// SPDX-License-Identifier: MIT
/** apps/core/test/secrets/portee-auth.test.ts — secrets d'instance `auth-*` : portée par hôtes et ports explicites, noms réservés aux fournisseurs d'identité (jamais créés ni renommés par un compte). */
import { randomBytes } from "node:crypto";

import { createUser } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErreurSecret } from "../../src/secrets/erreurs";
import { hotes, nomReserveAuth, normaliserPortee } from "../../src/secrets/portee";
import { creerSecret, modifierSecret, rotation, supprimerSecret } from "../../src/secrets/stockage";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const INSTANCE = { proprietaire: null, nom: "auth-annuaire" };
const ACTEUR = { userId: null, username: null, ip: null };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ErreurSecret) return `${e.statut} ${e.code}`;
    throw e;
  }
  return "aucune erreur";
}

describe("portée par hôtes (sans base)", () => {
  it("hôtes normalisés avec port explicite, dédoublonnés, trois au plus", () => {
    const p = normaliserPortee(
      "token",
      { hosts: ["LDAP.Exemple.lan:636", "ldap.exemple.lan:636", "[::1]:6360"] },
      INSTANCE,
    );
    expect(hotes(p)).toEqual(["ldap.exemple.lan:636", "[::1]:6360"]);
  });

  it.each([
    ["sans port", { hosts: ["ldap.exemple.lan"] }],
    ["vide", { hosts: [] }],
    ["origines à la place", { origins: ["https://idp.lan"] }],
    ["clé en plus", { hosts: ["a.lan:636"], x: 1 }],
    ["chemin", { hosts: ["a.lan:636/x"] }],
    ["adresse complète", { hosts: ["ldaps://a.lan:636"] }],
    ["port nul", { hosts: ["a.lan:0"] }],
    ["quatre hôtes", { hosts: ["a:1", "b:1", "c:1", "d:1"] }],
    ["objet vide", {}],
  ])("refusée : %s", (_nom, brut) => {
    expect(() => normaliserPortee("token", brut, INSTANCE)).toThrow(ErreurSecret);
  });

  it("un secret de compte nommé `auth-x` n'a pas de portée par hôtes ; un jeton ordinaire reste sans portée", () => {
    expect(() =>
      normaliserPortee("token", { hosts: ["a.lan:636"] }, { proprietaire: 3, nom: "auth-x" }),
    ).toThrow(ErreurSecret);
    expect(normaliserPortee("token", {}, { proprietaire: 3, nom: "perso" })).toEqual({});
    expect(nomReserveAuth("auth-x")).toBe(true);
    expect(nomReserveAuth("x-auth-")).toBe(false);
  });
});

describe.each(MOTEURS)("noms réservés (%s)", (moteur) => {
  let t: BaseDeTest;
  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: "/nonexistent/k",
      repli: "/nonexistent/r",
    });
  });
  afterEach(async () => t.fermer());

  it("un compte ne crée ni ne renomme vers `auth-*` ; l'instance (code interne) le peut, rotation et suppression par les routes refusées", async () => {
    const uid = await createUser(t.base, "alice", "mdp-alice-1");
    const compte = { value: "v", kind: "token" };
    expect(await code(creerSecret(t.base, uid, { name: "auth-annuaire", ...compte }, ACTEUR))).toBe(
      "422 secret_name_invalid",
    );
    const perso = await creerSecret(t.base, uid, { name: "perso", ...compte }, ACTEUR);
    expect(await code(modifierSecret(t.base, uid, perso.id, { name: "auth-perso" }, ACTEUR))).toBe(
      "422 secret_name_invalid",
    );
    const s = await creerSecret(
      t.base,
      null,
      { name: "auth-annuaire", kind: "token", scope: { hosts: ["ldap.lan:636"] }, value: "v" },
      ACTEUR,
    );
    expect(s.scope).toEqual({ hosts: ["ldap.lan:636"] });
    expect(await code(rotation(t.base, null, s.id, "autre", ACTEUR, { refuserGeres: true }))).toBe(
      "404 secret_unknown",
    );
    expect(await code(supprimerSecret(t.base, null, s.id, ACTEUR, { refuserGeres: true }))).toBe(
      "404 secret_unknown",
    );
    expect(await code(supprimerSecret(t.base, null, s.id, ACTEUR))).toBe("aucune erreur");
  });
});
