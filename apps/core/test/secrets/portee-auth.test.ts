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
import { hote, nomReserveAuth, normaliserPortee } from "../../src/secrets/portee";
import { creerSecret, modifierSecret, rotation, supprimerSecret } from "../../src/secrets/stockage";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const INSTANCE = { proprietaire: null, nom: "auth-sso" };
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
  it("hôte normalisé avec port explicite", () => {
    expect(hote(normaliserPortee("token", { host: "IDP.Exemple.lan:443" }, INSTANCE))).toBe(
      "idp.exemple.lan:443",
    );
    expect(hote(normaliserPortee("token", { host: "[::1]:8443" }, INSTANCE))).toBe("[::1]:8443");
  });

  it.each([
    ["sans port", { host: "idp.exemple.lan" }],
    ["liste d'hôtes", { host: ["a.lan:443"] }],
    ["ancienne clé", { hosts: ["a.lan:443"] }],
    ["origines à la place", { origins: ["https://idp.lan"] }],
    ["clé en plus", { host: "a.lan:443", x: 1 }],
    ["DN de liaison", { host: "a.lan:443", bind_dn: "uid=x,dc=y" }],
    ["chemin", { host: "a.lan:443/x" }],
    ["adresse complète", { host: "https://a.lan:443" }],
    ["port nul", { host: "a.lan:0" }],
    ["objet vide", {}],
  ])("refusée : %s", (_nom, brut) => {
    expect(() => normaliserPortee("token", brut, INSTANCE)).toThrow(ErreurSecret);
  });

  it("un secret de compte nommé `auth-x` n'a pas de portée par hôtes ; un jeton ordinaire reste sans portée", () => {
    expect(() =>
      normaliserPortee("token", { host: "a.lan:443" }, { proprietaire: 3, nom: "auth-x" }),
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

  it("un compte garde le droit de nommer un secret `auth-*` ; celui de l'instance reste hors des routes : rotation et suppression refusées", async () => {
    const uid = await createUser(t.base, "alice", "mdp-alice-1");
    const compte = { value: "v", kind: "token" };
    const propre = await creerSecret(t.base, uid, { name: "auth-sso", ...compte }, ACTEUR);
    expect(propre.name).toBe("auth-sso");
    const perso = await creerSecret(t.base, uid, { name: "perso", ...compte }, ACTEUR);
    expect((await modifierSecret(t.base, uid, perso.id, { name: "auth-perso" }, ACTEUR)).name).toBe(
      "auth-perso",
    );
    const s = await creerSecret(
      t.base,
      null,
      { name: "auth-sso", kind: "token", scope: { host: "idp.lan:443" }, value: "v" },
      ACTEUR,
    );
    expect(s.scope).toEqual({ host: "idp.lan:443" });
    expect(await code(rotation(t.base, null, s.id, "autre", ACTEUR, { refuserGeres: true }))).toBe(
      "404 secret_unknown",
    );
    expect(await code(supprimerSecret(t.base, null, s.id, ACTEUR, { refuserGeres: true }))).toBe(
      "404 secret_unknown",
    );
    expect(await code(supprimerSecret(t.base, null, s.id, ACTEUR))).toBe("aucune erreur");
  });
});
