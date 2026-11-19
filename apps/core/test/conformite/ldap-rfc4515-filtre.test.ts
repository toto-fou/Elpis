// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/ldap-rfc4515-filtre.test.ts — RFC 4515 : échappement des valeurs de filtre (identifiant hostile, DN, octets) vérifié sur le fil contre un vrai LDAPS local (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { echapperFiltre } from "../../src/identite/annuaire/client";
import { authentifierParAnnuaire } from "../../src/identite/annuaire/connexion";
import { filtreEgal, filtrePresence, rendreFiltre } from "../../src/identite/annuaire/filtre";
import type { BancAnnuaire } from "../identite/annuaire/banc-annuaire";
import { MOTEURS } from "../identite/banc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { demarrerHote, ouvrirBancReel } from "./banc-reel";
import type { Hote } from "./banc-reel";
import { MDP_PERSONNE, profilOpenLdap, variante } from "./profils-annuaire";

describe("RFC 4515 §3 : échappement des valeurs", () => {
  it.each([
    ["astérisque", "*", "\\2a"],
    ["parenthèse ouvrante", "(", "\\28"],
    ["parenthèse fermante", ")", "\\29"],
    ["barre oblique inverse", "\\", "\\5c"],
    ["NUL", "\0", "\\00"],
  ])("RFC 4515 §3 : %s échappé en \\xx", (_n, brut, attendu) => {
    expect(echapperFiltre(brut)).toBe(attendu);
  });

  it("RFC 4515 §3 : tous les octets d'une valeur binaire (objectGUID) sont rendus en \\xx", () => {
    const guid = Buffer.from([
      0xff, 0xfe, 0x00, 0x80, 0x28, 0x29, 0x2a, 0x5c, 0x41, 0x42, 0x01, 0x02, 0x03, 0x04, 0x05, 0xc3,
    ]);
    const f = filtreEgal("objectGUID", guid);
    expect(f.startsWith("(objectGUID=")).toBe(true);
    const unescaped = Buffer.from(
      f
        .slice("(objectGUID=".length, -1)
        .replace(/\\([0-9a-f]{2})/gu, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
      "latin1",
    );
    expect(unescaped.equals(guid)).toBe(true);
    expect(f).not.toMatch(/[()*](?!.*$)/u);
  });

  it("RFC 4515 §3 : une valeur UTF-8 valide est acceptée telle quelle ou en octets échappés, jamais corrompue", () => {
    const f = filtreEgal("cn", "Éléonore");
    const decode = f
      .slice("(cn=".length, -1)
      .replace(/(\\[0-9a-f]{2})+/gu, (m) => Buffer.from(m.replace(/\\/gu, ""), "hex").toString("utf8"));
    expect(decode).toBe("Éléonore");
  });

  it("RFC 4515 §3 : une valeur qui n'est pas de l'UTF-8 bien formé (substitut isolé) est refusée", () => {
    expect(() => filtreEgal("cn", "a\uD800b")).toThrowError();
    expect(() => rendreFiltre("(uid={username})", "a\uD800b")).toThrowError();
  });

  it("RFC 4515 §2 : un nom d'attribut hors grammaire est refusé (injection par le nom)", () => {
    expect(() => filtreEgal("cn)(uid=*", "x")).toThrowError();
    expect(() => filtrePresence("cn)(uid")).toThrowError();
  });

  it("RFC 4515 §2 : le gabarit contient {username} une fois, le résultat est un filtre lisible", () => {
    expect(rendreFiltre("(&(objectClass=person)(uid={username}))", "jean")).toBe(
      "(&(objectClass=person)(uid=jean))",
    );
    expect(() => rendreFiltre("(uid=x)", "jean")).toThrowError();
    expect(() => rendreFiltre("(|(uid={username})(mail={username}))", "jean")).toThrowError();
  });

  it.each(["", "a\0b", "a\nb", "x".repeat(257)])("identifiant refusé avant tout envoi : %j", (v) => {
    expect(() => rendreFiltre("(uid={username})", v)).toThrowError();
  });
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)(
  "RFC 4515 : identifiant hostile sur le fil (%s)",
  (moteur) => {
    let hote: Hote;
    let b: BancAnnuaire;
    beforeAll(async () => {
      hote = await demarrerHote();
    });
    afterAll(async () => {
      await hote.fermer();
    });
    afterEach(async () => {
      expect(hote.serveur.erreursLecture()).toBe(0);
      await b?.fermer();
    });
    const recherchesUtilisateur = (): string[] =>
      hote.serveur.requetes.filter((q) => q.type === "search" && q.portee === 2).map((q) => q.filtre ?? "");

    it.each(["*", "j*", "*)(uid=*", "jean)(|(uid=*", "jean\\", "(", ")", "\\2a", "jean*)(objectClass=*"])(
      "identifiant %j : un seul filtre d'égalité sur le fil, aucune entrée trouvée, aucune liaison de personne",
      async (id) => {
        const p = profilOpenLdap();
        b = await ouvrirBancReel(moteur, hote, p);
        expect(await authentifierParAnnuaire(b.dep(), id, MDP_PERSONNE)).toEqual({ type: "absent" });
        const [filtre] = recherchesUtilisateur();
        expect(filtre).toMatch(/^\(&\(objectclass=inetorgperson\)\(uid=[^()]*\)\)$/u);
        expect(hote.serveur.requetes.filter((q) => q.type === "bind")).toHaveLength(1);
      },
    );

    it.each(["jé", "j*an", "j(an)", "j\\an", "日本語", "ÀÉÎ"])(
      "identifiant %j égal à celui de l'entrée : trouvé, filtre décodé identique par le serveur",
      async (uid) => {
        const p = profilOpenLdap();
        const entrees = p.entrees.map((x) =>
          x.dn.startsWith("uid=jean,") ? { ...x, attrs: { ...x.attrs, uid: [uid] } } : x,
        );
        b = await ouvrirBancReel(moteur, hote, variante(p, { entrees }));
        const r = await authentifierParAnnuaire(b.dep(), uid, MDP_PERSONNE);
        expect(r).toMatchObject({ type: "ok" });
      },
    );

    it("RFC 4518 + RFC 4515 : casse de l'identifiant ignorée par l'annuaire, l'entrée trouvée est la même", async () => {
      b = await ouvrirBancReel(moteur, hote, profilOpenLdap());
      expect(await authentifierParAnnuaire(b.dep(), "JEAN", MDP_PERSONNE)).toMatchObject({
        type: "ok",
        profil: { extUsername: "jean" },
      });
    });
  },
);
