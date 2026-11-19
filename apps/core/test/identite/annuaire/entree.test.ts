// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/entree.test.ts — recherche d'utilisateur (absent, ambigu), clé stable sans repli, état d'entrée par préréglage et profil borné. */
import { describe, expect, it } from "vitest";

import {
  attributsUtilisateur,
  chercherUtilisateur,
  cleStable,
  etatEntree,
  profilExterne,
} from "../../../src/identite/annuaire/entree";
import { ErreurAnnuaire } from "../../../src/identite/annuaire/erreur";
import { PRESETS } from "../../../src/identite/annuaire/presets";
import type { IdPreset } from "../../../src/identite/annuaire/presets";
import { connexionFausse, entree, fournisseur } from "./faux";

const MAINTENANT = Date.UTC(2026, 10, 18, 12, 0, 0);
const UUID = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";

function avec(id: IdPreset): ReturnType<typeof fournisseur> {
  const p = PRESETS[id];
  return fournisseur({ preset: id, user_filter: p.filtre, attrs: p.attrs, groups: { mode: p.mode } });
}

describe("chercherUtilisateur", () => {
  const f = avec("freeipa");

  it("cherche l'identifiant tapé échappé, limité à deux résultats, attributs nommés", async () => {
    const cnx = connexionFausse();
    await chercherUtilisateur(cnx, f, "a*)");
    const [appel] = cnx.appels;
    expect(appel?.base).toBe(f.user_base_dn);
    expect(appel?.o.filtre).toBe("(&(objectClass=person)(uid=a\\2a\\29))");
    expect(appel?.o.limite).toBe(2);
    expect(appel?.o.portee).toBe("sub");
    expect(appel?.o.attributs).toEqual([
      "ipaUniqueID",
      "uid",
      "mail",
      "cn",
      "nsAccountLock",
      "krbPasswordExpiration",
      "krbLastPwdChange",
    ]);
  });

  it("rend l'entrée unique, « absent » ou « ambigu »", async () => {
    const e = entree("uid=a,dc=x");
    expect(
      await chercherUtilisateur(
        connexionFausse(() => [e]),
        f,
        "a",
      ),
    ).toBe(e);
    expect(
      await chercherUtilisateur(
        connexionFausse(() => []),
        f,
        "a",
      ),
    ).toBe("absent");
    expect(
      await chercherUtilisateur(
        connexionFausse(() => [e, entree("uid=b,dc=x")]),
        f,
        "a",
      ),
    ).toBe("ambigu");
  });

  it("propage l'erreur d'annuaire au lieu de rendre « absent »", async () => {
    const cnx = connexionFausse(() => {
      throw new ErreurAnnuaire("injoignable");
    });
    await expect(chercherUtilisateur(cnx, f, "a")).rejects.toMatchObject({ nature: "injoignable" });
  });

  it("refuse un identifiant vide avant toute recherche", async () => {
    const cnx = connexionFausse();
    await expect(chercherUtilisateur(cnx, f, "")).rejects.toBeInstanceOf(ErreurAnnuaire);
    expect(cnx.appels).toHaveLength(0);
  });

  it("ne duplique pas un attribut commun à l'identité et à l'état", () => {
    const g = fournisseur({ attrs: { id: "entryUUID", username: "uid", email: "UID", name: "cn" } });
    expect(attributsUtilisateur(g)).toEqual(["entryUUID", "uid", "cn"]);
  });
});

describe("cleStable", () => {
  it("met un UUID en minuscules (FreeIPA, OpenLDAP)", () => {
    expect(cleStable(entree("x", { ipauniqueid: [UUID.toUpperCase()] }), avec("freeipa"))).toBe(UUID);
    expect(cleStable(entree("x", { entryuuid: [UUID] }), avec("openldap"))).toBe(UUID);
  });

  it("rend les 16 octets d'objectGUID en hexadécimal", () => {
    const octets = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    expect(cleStable(entree("x", { objectguid: [octets] }), avec("active-directory"))).toBe(
      "00112233445566778899aabbccddeeff",
    );
  });

  it.each([
    ["absente", {}],
    ["vide", { ipauniqueid: [] }],
    ["double", { ipauniqueid: [UUID, UUID] }],
    ["mal formée", { ipauniqueid: ["pas-un-uuid"] }],
    ["trop longue", { ipauniqueid: [`${UUID}0`] }],
    ["binaire", { ipauniqueid: [Buffer.from(UUID)] }],
  ])("FreeIPA, clé %s : erreur", (_nom, attrs) => {
    expect(() => cleStable(entree("uid=a,dc=x", attrs), avec("freeipa"))).toThrow(ErreurAnnuaire);
  });

  it.each([
    ["15 octets", Buffer.alloc(15, 1)],
    ["17 octets", Buffer.alloc(17, 1)],
    ["chaîne", "00112233445566778899aabbccddeeff"],
  ])("Active Directory, objectGUID %s : erreur", (_nom, v) => {
    expect(() => cleStable(entree("x", { objectguid: [v] }), avec("active-directory"))).toThrow(
      ErreurAnnuaire,
    );
  });

  it("ne retombe jamais sur le DN, l'e-mail ni le nom", () => {
    const e = entree("uid=a,dc=x", { mail: ["a@x.fr"], cn: ["A"], uid: ["a"] });
    expect(() => cleStable(e, avec("freeipa"))).toThrow(ErreurAnnuaire);
    expect(() => cleStable(e, avec("openldap"))).toThrow(ErreurAnnuaire);
    expect(() => cleStable(e, avec("active-directory"))).toThrow(ErreurAnnuaire);
  });

  it("accepte une clé libre simple pour nsUniqueId, la refuse avec espaces", () => {
    const f = fournisseur({
      preset: "other",
      attrs: { id: "nsUniqueId", username: "uid", email: "mail", name: "cn" },
    });
    expect(cleStable(entree("x", { nsuniqueid: ["AB-12"] }), f)).toBe("ab-12");
    expect(() => cleStable(entree("x", { nsuniqueid: ["AB 12"] }), f)).toThrow(ErreurAnnuaire);
  });
});

describe("etatEntree", () => {
  const ipa = avec("freeipa");
  const ad = avec("active-directory");
  const etat = (f: typeof ipa, attrs: Record<string, string[]>): string =>
    etatEntree(entree("x", attrs), f, MAINTENANT);

  it("FreeIPA : actif quand l'échéance du mot de passe est lisible et future, verrou absent ou faux", () => {
    expect(etat(ipa, { krbpasswordexpiration: ["20270101000000Z"] })).toBe("active");
    expect(etat(ipa, { nsaccountlock: ["FALSE"], krbpasswordexpiration: ["20270101000000Z"] })).toBe(
      "active",
    );
  });

  it("FreeIPA : politique sans expiration (dernier changement lisible, échéance absente) : l'entrée n'est pas expirée", () => {
    const dernier = { krblastpwdchange: ["20250101000000Z"] };
    expect(etat(ipa, dernier)).toBe("active");
    expect(etat(ipa, { ...dernier, nsaccountlock: ["FALSE"] })).toBe("active");
    expect(etat(ipa, { ...dernier, nsaccountlock: ["TRUE"] })).toBe("desactivee");
    expect(etat(ipa, { ...dernier, nsaccountlock: ["peut-être"] })).toBe("inconnu");
  });

  it.each([
    ["expiration et dernier changement absents", {}],
    ["dernier changement absent, verrou lisible", { nsaccountlock: ["FALSE"] }],
    ["dernier changement illisible", { krblastpwdchange: ["hier"] }],
    ["dernier changement double", { krblastpwdchange: ["20250101000000Z", "20250101000000Z"] }],
  ])("FreeIPA : %s : « inconnu » (échec fermé)", (_nom, attrs) => {
    expect(etat(ipa, attrs)).toBe("inconnu");
  });

  it("FreeIPA : le verrou prime même quand l'expiration n'est pas lisible", () => {
    expect(etat(ipa, { nsaccountlock: ["TRUE"] })).toBe("desactivee");
  });

  it("FreeIPA : désactivé par l'administrateur de l'annuaire", () => {
    expect(etat(ipa, { nsaccountlock: ["TRUE"] })).toBe("desactivee");
    expect(etat(ipa, { nsaccountlock: ["true"], krbpasswordexpiration: ["n'importe quoi"] })).toBe(
      "desactivee",
    );
  });

  it("FreeIPA : expiré à l'instant exact et après, pas avant", () => {
    expect(etat(ipa, { krbpasswordexpiration: ["20261118120000Z"] })).toBe("expiree");
    expect(etat(ipa, { krbpasswordexpiration: ["20260101000000Z"] })).toBe("expiree");
    expect(etat(ipa, { krbpasswordexpiration: ["20261118120001Z"] })).toBe("active");
  });

  it.each([
    ["verrou illisible", { nsaccountlock: ["peut-être"], krbpasswordexpiration: ["20300101000000Z"] }],
    ["verrou double", { nsaccountlock: ["FALSE", "FALSE"], krbpasswordexpiration: ["20300101000000Z"] }],
    ["expiration illisible", { krbpasswordexpiration: ["demain"] }],
    ["expiration impossible", { krbpasswordexpiration: ["20261340250000Z"] }],
    ["expiration double", { krbpasswordexpiration: ["20300101000000Z", "20300101000000Z"] }],
  ])("FreeIPA : %s donne « inconnu »", (_nom, attrs) => {
    expect(etat(ipa, attrs)).toBe("inconnu");
  });

  it("Active Directory : actif, désactivé, verrouillé, expiré", () => {
    expect(etat(ad, { useraccountcontrol: ["512"], "msds-user-account-control-computed": ["0"] })).toBe(
      "active",
    );
    expect(etat(ad, { useraccountcontrol: ["514"], "msds-user-account-control-computed": ["0"] })).toBe(
      "desactivee",
    );
    expect(etat(ad, { useraccountcontrol: ["514"], "msds-user-account-control-computed": ["16"] })).toBe(
      "desactivee",
    );
    expect(etat(ad, { useraccountcontrol: ["512"], "msds-user-account-control-computed": ["16"] })).toBe(
      "verrouillee",
    );
    expect(etat(ad, { useraccountcontrol: ["512"], "msds-user-account-control-computed": ["8388608"] })).toBe(
      "expiree",
    );
    expect(etat(ad, { useraccountcontrol: ["512"], "msds-user-account-control-computed": ["8388624"] })).toBe(
      "verrouillee",
    );
  });

  it.each([
    ["tout absent", {}],
    ["calculé absent", { useraccountcontrol: ["512"] }],
    ["drapeaux absents", { "msds-user-account-control-computed": ["0"] }],
    ["non numérique", { useraccountcontrol: ["abc"], "msds-user-account-control-computed": ["0"] }],
    ["négatif", { useraccountcontrol: ["512"], "msds-user-account-control-computed": ["-1"] }],
    ["double", { useraccountcontrol: ["512", "512"], "msds-user-account-control-computed": ["0"] }],
  ])("Active Directory : %s donne « inconnu »", (_nom, attrs) => {
    expect(etat(ad, attrs)).toBe("inconnu");
  });

  it("OpenLDAP et « other » : actif (l'état vient de l'échec de liaison)", () => {
    expect(etat(avec("openldap"), {})).toBe("active");
    expect(etat(avec("other"), {})).toBe("active");
  });
});

describe("profilExterne", () => {
  const f = avec("openldap");

  it("lit les premières valeurs", () => {
    const p = profilExterne(
      entree("x", { uid: ["jdupont", "autre"], cn: ["Jean Dupont"], mail: ["j@x.fr"] }),
      f,
    );
    expect(p).toEqual({ identifiant: "jdupont", nom: "Jean Dupont", email: "j@x.fr" });
  });

  it("retire les caractères de contrôle et borne les tailles", () => {
    const p = profilExterne(
      entree("x", { uid: ["a\u0000b\nc"], cn: ["n".repeat(400)], mail: ["m".repeat(500)] }),
      f,
    );
    expect(p.identifiant).toBe("abc");
    expect(p.nom).toHaveLength(256);
    expect(p.email).toHaveLength(320);
  });

  it("rend du texte vide pour un attribut absent ou binaire, jamais le DN", () => {
    const p = profilExterne(entree("uid=secret,dc=x", { uid: [Buffer.from("a")] }), f);
    expect(p).toEqual({ identifiant: "", nom: "", email: "" });
  });
});
