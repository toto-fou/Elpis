// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-identifiant-fiable.test.ts — aucun compte n'est créé ni son identifiant affiché réécrit d'après un identifiant non fiable (e-mail non vérifié), et l'essai à blanc annonce le même refus (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createUser } from "@elpis/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lignesJournal } from "./aides";
import { MOTEURS } from "./identite/banc";
import { ELPIS, ouvrirBancOidc } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";
import { resultatEssaiBlanc } from "../src/identite/oidc/essai-blanc";
import type { RetourVerifie } from "../src/identite/oidc/echange";

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("identifiant non fiable (%s)", (moteur) => {
  let b: BancOidc;
  const mallory = (verifie: boolean) =>
    ELPIS("sub-mallory", { email: "patron@exemple.lan", email_verified: verifie, preferred_username: "x" });

  beforeEach(async () => {
    lignesJournal.length = 0;
    b = await ouvrirBancOidc(moteur);
    await b.reglages({ username_claim: "email" });
  });
  afterEach(async () => {
    await b.fermer();
  });

  it("e-mail non vérifié comme identifiant : aucun compte créé ; vérifié : compte créé", async () => {
    const non = await b.connecter(mallory(false));
    expect(String(non.retour.headers.location)).toMatch(/^\/\?auth_error=/u);
    expect(await b.utilisateurs()).toEqual(["chef"]);
    expect(await b.t.base.valeurs("SELECT COUNT(*) FROM user_identities")).toEqual([[0]]);
    const oui = await b.connecter(mallory(true));
    expect(oui.retour.statusCode, oui.retour.body).toBe(200);
    expect(await b.utilisateurs()).toEqual(["chef", "patron-exemple-lan"]);
  });

  it("identité connue : un e-mail non vérifié ne réécrit pas l'identifiant gardé", async () => {
    await b.connecter(mallory(true));
    const r = await b.connecter(
      ELPIS("sub-mallory", { email: "autre@exemple.lan", email_verified: false, preferred_username: "x" }),
    );
    expect(r.retour.statusCode, r.retour.body).toBe(200);
    expect(await b.t.base.valeurs("SELECT ext_username FROM user_identities")).toEqual([
      ["patron@exemple.lan"],
    ]);
  });

  it("l'essai à blanc annonce le refus d'un identifiant non fiable, et la création d'un identifiant fiable", async () => {
    const vue = (fiable: boolean): RetourVerifie =>
      ({
        appartenance: "oui",
        profil: {
          subject: "sub-essai",
          issuer: `oidc:${b.idp.issuer}`,
          extUsername: "patron@exemple.lan",
          identifiantFiable: fiable,
        },
        vue: {
          iss: "",
          sujet: "sub-essai",
          identifiant: "",
          nom: "",
          email: "",
          emailVerifie: fiable,
          acr: null,
          amr: [],
          groupes: [],
          sujetEstIdentifiant: false,
        },
        groupesComplets: [],
      }) as unknown as RetourVerifie;
    const non = await resultatEssaiBlanc(b.t.base, b.fournisseur, vue(false), 1);
    expect(non.decision).toEqual({ outcome: "refuse", username: null, reason: "name_invalid" });
    const oui = await resultatEssaiBlanc(b.t.base, b.fournisseur, vue(true), 1);
    expect(oui.decision.outcome).toBe("create");
  });

  it("l'essai à blanc refuse un nom qui ne diffère d'un compte existant que par les séparateurs, comme la vraie connexion", async () => {
    await createUser(b.t.base, "jean_dupont", "mdp-jean-123");
    const vue = {
      appartenance: "oui",
      profil: { subject: "sub-homonyme", issuer: `oidc:${b.idp.issuer}`, extUsername: "jean-dupont" },
      vue: { sujetEstIdentifiant: false },
      groupesComplets: [],
    } as unknown as RetourVerifie;
    const r = await resultatEssaiBlanc(b.t.base, b.fournisseur, vue, 1);
    expect(r.decision).toEqual({ outcome: "refuse", username: null, reason: "account_conflict" });
  });
});
