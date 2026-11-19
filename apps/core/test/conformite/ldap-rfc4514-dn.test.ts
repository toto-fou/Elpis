// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/ldap-rfc4514-dn.test.ts — RFC 4514 : comparaison des DN (échappements équivalents, blancs, RDN multivalués) et DN renvoyés par le serveur repris tels quels pour la liaison et l'appartenance (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { authentifierParAnnuaire } from "../../src/identite/annuaire/connexion";
import { dnNormalise, memeDn } from "../../src/identite/annuaire/dn";
import type { BancAnnuaire } from "../identite/annuaire/banc-annuaire";
import { MOTEURS } from "../identite/banc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { demarrerHote, ouvrirBancReel } from "./banc-reel";
import type { Hote } from "./banc-reel";
import { MDP_PERSONNE, profilOpenLdap, variante } from "./profils-annuaire";

describe("RFC 4514 §2.4 et §3 : DN équivalents, DN différents", () => {
  it.each([
    ["virgule : paire et forme hexadécimale", "cn=a\\,b,dc=x", "cn=a\\2Cb,dc=x"],
    ["hexadécimal en minuscules", "cn=a\\,b,dc=x", "cn=a\\2cb,dc=x"],
    ["guillemet", 'cn=a\\"b,dc=x', "cn=a\\22b,dc=x"],
    ["plus", "cn=a\\+b,dc=x", "cn=a\\2Bb,dc=x"],
    ["point-virgule", "cn=a\\;b,dc=x", "cn=a\\3Bb,dc=x"],
    ["inférieur et supérieur", "cn=a\\<b\\>,dc=x", "cn=a\\3Cb\\3E,dc=x"],
    ["barre oblique inverse", "cn=a\\\\b,dc=x", "cn=a\\5Cb,dc=x"],
    ["UTF-8 : caractère et octets hexadécimaux", "cn=é,dc=x", "cn=\\C3\\A9,dc=x"],
    ["casse du type et de la valeur", "CN=Jean,DC=X", "cn=jean,dc=x"],
    ["blancs autour de = et de ,", "cn = a , dc = x", "cn=a,dc=x"],
    ["RDN multivalué : ordre des valeurs", "cn=a+uid=b,dc=x", "uid=b+cn=a,dc=x"],
    ["espace de tête échappé", "cn=\\ a,dc=x", "cn=\\20a,dc=x"],
    ["espace de fin échappé", "cn=a\\ ,dc=x", "cn=a\\20,dc=x"],
    ["dièse de tête échappé", "cn=\\#a,dc=x", "cn=\\23a,dc=x"],
  ])("RFC 4514 §3 : %s : même DN", (_n, a, b) => {
    expect(memeDn(a, b)).toBe(true);
    expect(dnNormalise(a)).toBe(dnNormalise(b));
  });

  it.each([
    ["virgule échappée contre séparateur", "cn=a\\,b,dc=x", "cn=a,b,dc=x"],
    ["espace de fin échappé contre retiré", "cn=a\\ ,dc=x", "cn=a,dc=x"],
    ["plus échappé contre séparateur de RDN", "cn=a\\+b,dc=x", "cn=a+b,dc=x"],
    ["valeurs voisines", "uid=svc,dc=x", "uid=svc2,dc=x"],
    ["octet hexadécimal invalide en UTF-8", "cn=\\C3,dc=x", "cn=\\C4,dc=x"],
    ["dièse de tête échappé contre forme hexadécimale", "cn=\\#41,dc=x", "cn=#41,dc=x"],
  ])("RFC 4514 §2.4 : %s : DN différents", (_n, a, b) => {
    expect(memeDn(a, b)).toBe(false);
  });

  it("RFC 4514 §2.4 : une espace de fin échappée ne laisse jamais une barre oblique inverse pendante", () => {
    expect(dnNormalise("cn=a\\ ,dc=x")).toBe("cn=a\\ ,dc=x");
    expect(dnNormalise("cn=a\\ ,dc=x").includes("\\,")).toBe(false);
  });
});

const TORTUEUX: readonly [string, string][] = [
  ["virgule", "cn=Dupont\\, Jean"],
  ["plus", "cn=a\\+b"],
  ["guillemets", 'cn=\\"x\\"'],
  ["point-virgule", "cn=a\\;b"],
  ["inférieur supérieur", "cn=\\<x\\>"],
  ["barre oblique inverse", "cn=a\\\\b"],
  ["espace de tête", "cn=\\ lead"],
  ["espace de fin", "cn=trail\\ "],
  ["dièse de tête", "cn=\\#hash"],
  ["UTF-8 littéral", "cn=Éléonore Bœuf"],
  ["UTF-8 en hexadécimal", "cn=\\C3\\89l\\C3\\A9onore"],
  ["RDN multivalué", "cn=a+sn=b"],
];

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("RFC 4514 : DN renvoyés par le serveur (%s)", (moteur) => {
  let hote: Hote;
  let b: BancAnnuaire;
  beforeAll(async () => {
    hote = await demarrerHote();
  });
  afterAll(async () => {
    await hote.fermer();
  });
  afterEach(async () => {
    await b?.fermer();
  });

  it.each(TORTUEUX)(
    "RFC 4514 §2.4 : DN avec %s : repris tel quel pour la liaison et pour l'appartenance au groupe",
    async (_n, rdn) => {
      const p = profilOpenLdap();
      const ancien = p.personnes[0]?.dn ?? "";
      const dn = `${rdn},ou=people,dc=exemple,dc=lan`;
      const entrees = p.entrees.map((x) => {
        if (x.dn === ancien) return { ...x, dn };
        const membres = x.attrs["member"];
        if (membres === undefined) return x;
        return { ...x, attrs: { ...x.attrs, member: membres.map((m) => (m === ancien ? dn : m)) } };
      });
      const liaison = (d: string, m: Buffer): { code: number } =>
        d === dn ? { code: m.toString() === MDP_PERSONNE ? 0 : 49 } : p.liaison(d, m);
      b = await ouvrirBancReel(moteur, hote, variante(p, { entrees, liaison }));
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({ type: "ok" });
      const liees = hote.serveur.requetes.filter((q) => q.type === "bind").map((q) => q.dn);
      expect(liees).toContain(dn);
    },
  );
});
