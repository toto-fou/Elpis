// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/ldap-tls.test.ts — TLS de l'annuaire (RFC 5246 / 8446, RFC 9525, RFC 4513 §3.1.3 et §6.3.1) contre un vrai LDAPS local : versions, nom du serveur, chaîne, validité, usage de clé, ancre unique, SNI, aucun octet LDAP avant la vérification. */
import { createServer } from "node:net";
import type { Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { fabriqueLdapts } from "../../src/identite/annuaire/client";
import { fournisseur } from "../identite/annuaire/faux";
import { demarrerServeurLdap } from "../identite/annuaire/serveur-ldap";
import type { OptionsServeurLdap, ServeurLdap } from "../identite/annuaire/serveur-ldap";
import {
  creerAutoSigne,
  creerAutorite,
  creerFeuille,
  effacer,
  OPENSSL_DISPONIBLE,
} from "../identite/pki-openssl";
import type { Autorite, OptionsFeuille } from "../identite/pki-openssl";
import { VERS_BOUCLE } from "./banc-reel";
import { creerFeuilleSpeciale, creerIntermediaire } from "./pki-conformite";

const DN = "uid=svc,dc=exemple,dc=lan";
const MDP = "mot-de-passe-de-service";

describe.skipIf(!OPENSSL_DISPONIBLE)("TLS de l'annuaire", () => {
  const aFermer: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const f of aFermer.splice(0)) await f();
  });

  const autorite = (): Autorite => {
    const ca = creerAutorite("Autorité TLS de conformité");
    aFermer.push(() => effacer(ca));
    return ca;
  };
  const demarrer = async (cert: string, cle: string, o: OptionsServeurLdap = {}): Promise<ServeurLdap> => {
    const s = await demarrerServeurLdap(cert, cle, o);
    s.comportement.comptes[DN] = MDP;
    aFermer.push(() => s.fermer());
    return s;
  };
  /** Liaison de service vers `hote` (nom demandé) sur ce serveur, avec cette ancre collée. */
  const lier = async (s: ServeurLdap, hote: string, ancre: string): Promise<void> => {
    const cnx = await fabriqueLdapts({ juger: VERS_BOUCLE })(
      fournisseur({ ca_pem: ancre, timeout_sec: 3 }),
      `ldaps://${hote}:${s.port}`,
    );
    try {
      await cnx.lier(DN, MDP);
    } finally {
      await cnx.fermer();
    }
  };
  const feuille = async (
    ca: Autorite,
    o: OptionsFeuille,
    tls: OptionsServeurLdap = {},
  ): Promise<ServeurLdap> => {
    const f = creerFeuille(ca, o);
    return demarrer(f.cert, f.cle, tls);
  };
  const refus = (sortant: string | string[]) => ({
    nature: "injoignable",
    sortant: expect.stringMatching(new RegExp(`^(${[sortant].flat().join("|")})$`, "u")) as unknown as string,
  });
  const aucuneLiaison = (s: ServeurLdap): void => expect(s.requetes).toHaveLength(0);

  describe("versions du protocole (RFC 8446, RFC 5246, RFC 8996)", () => {
    it.each([
      ["TLS 1.2", "TLSv1.2", "TLSv1.2"],
      ["TLS 1.3", "TLSv1.3", "TLSv1.3"],
    ] as const)(
      "RFC 8446 / 5246 : %s accepté, version négociée vérifiée sur le serveur",
      async (_n, min, attendu) => {
        const ca = autorite();
        const s = await feuille(ca, { noms: ["ldap.exemple.lan"] }, { minVersion: min, maxVersion: min });
        await lier(s, "ldap.exemple.lan", ca.cert);
        expect(s.poignees.at(-1)?.protocole).toBe(attendu);
      },
    );

    it.each([
      ["TLS 1.0", "TLSv1"],
      ["TLS 1.1", "TLSv1.1"],
    ] as const)("RFC 8996 : %s refusé, aucun octet LDAP envoyé", async (_n, v) => {
      const ca = autorite();
      const s = await feuille(
        ca,
        { noms: ["ldap.exemple.lan"] },
        { minVersion: v, maxVersion: v, ciphers: "DEFAULT@SECLEVEL=0" },
      );
      await expect(lier(s, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus(["version_tls", "tls"]));
      aucuneLiaison(s);
    });
  });

  describe("nom du serveur (RFC 9525, RFC 4513 §3.1.3)", () => {
    it("RFC 6125 §6.4.4 : nom présent dans le SAN DNS : accepté, nom envoyé en SNI", async () => {
      const ca = autorite();
      const s = await feuille(ca, { noms: ["ldap.exemple.lan", "autre.exemple.lan"] });
      await lier(s, "autre.exemple.lan", ca.cert);
      expect(s.poignees.at(-1)?.servername).toBe("autre.exemple.lan");
    });
    it("RFC 6125 §6.4.4 : SAN IP accepté pour une adresse IP littérale, pas de SNI pour une adresse IP (RFC 6066 §3)", async () => {
      const ca = autorite();
      const s = await feuille(ca, { noms: ["ldap.exemple.lan"], ips: ["127.0.0.1"] });
      await lier(s, "127.0.0.1", ca.cert);
      expect(s.poignees.at(-1)?.servername).toBeNull();
    });
    it("RFC 6125 §6.4.4 : adresse IP absente des SAN IP (seul un SAN DNS la porte) : refusée", async () => {
      const ca = autorite();
      const s = await feuille(ca, { noms: ["127.0.0.1"] });
      await expect(lier(s, "127.0.0.1", ca.cert)).rejects.toMatchObject(refus(["nom_certificat", "tls"]));
      aucuneLiaison(s);
    });
    it("RFC 6125 §6.4.3 : joker `*.exemple.lan` couvre un seul niveau", async () => {
      const ca = autorite();
      const s = await feuille(ca, { noms: ["*.exemple.lan"] });
      await lier(s, "ldap.exemple.lan", ca.cert);
      await expect(lier(s, "a.b.exemple.lan", ca.cert)).rejects.toMatchObject(refus("nom_certificat"));
      await expect(lier(s, "exemple.lan", ca.cert)).rejects.toMatchObject(refus("nom_certificat"));
    });
    it("RFC 9525 §6.3 : joker partiel `l*.exemple.lan` ignoré, joker hors de l'étiquette de gauche ignoré : refusés", async () => {
      const ca = autorite();
      const partiel = await feuille(ca, { noms: ["l*.exemple.lan"] });
      await expect(lier(partiel, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus("nom_certificat"));
      aucuneLiaison(partiel);
      const milieu = await feuille(ca, { noms: ["ldap.*.lan"] });
      await expect(lier(milieu, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus("nom_certificat"));
      aucuneLiaison(milieu);
    });
    it("RFC 6125 §6.4.4 : nom du serveur différent de tous les noms du certificat : refusé, aucun octet LDAP", async () => {
      const ca = autorite();
      const s = await feuille(ca, { noms: ["ldap.exemple.lan"] });
      await expect(lier(s, "intrus.exemple.lan", ca.cert)).rejects.toMatchObject(refus("nom_certificat"));
      aucuneLiaison(s);
    });
    it("RFC 9525 §2 : CN seul, sans SAN : refusé même quand le CN est le nom demandé, aucun octet LDAP", async () => {
      const ca = autorite();
      const f = creerFeuilleSpeciale(ca, { cn: "ldap.exemple.lan", san: null, eku: "serverAuth" });
      const s = await demarrer(f.cert, f.cle);
      await expect(lier(s, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus("nom_certificat"));
      aucuneLiaison(s);
    });
    it("RFC 6125 §6.4.4 : le SAN prime sur le CN : CN correct mais SAN d'un autre nom : refusé", async () => {
      const ca = autorite();
      const f = creerFeuilleSpeciale(ca, {
        cn: "ldap.exemple.lan",
        san: "DNS:autre.exemple.lan",
        eku: "serverAuth",
      });
      const s = await demarrer(f.cert, f.cle);
      await expect(lier(s, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus("nom_certificat"));
    });
    it("RFC 6125 §6.4.1 (casse du nom) : nom demandé en majuscules : accepté", async () => {
      const ca = autorite();
      const s = await feuille(ca, { noms: ["ldap.exemple.lan"] });
      await lier(s, "LDAP.Exemple.LAN", ca.cert);
    });
  });

  describe("chaîne, validité, usage (RFC 5280)", () => {
    it("RFC 5280 §6 : chaîne avec intermédiaire envoyé par le serveur, racine seule collée : acceptée", async () => {
      const racine = autorite();
      const inter = creerIntermediaire(racine, "Intermédiaire de conformité");
      aFermer.push(() => effacer(inter));
      const f = creerFeuille(inter, { noms: ["ldap.exemple.lan"] });
      const s = await demarrer(`${f.cert}\n${inter.cert}`, f.cle);
      await lier(s, "ldap.exemple.lan", racine.cert);
    });
    it("RFC 5280 §6 : intermédiaire non envoyé par le serveur : refusé (aucune récupération de certificat)", async () => {
      const racine = autorite();
      const inter = creerIntermediaire(racine, "Intermédiaire de conformité");
      aFermer.push(() => effacer(inter));
      const f = creerFeuille(inter, { noms: ["ldap.exemple.lan"] });
      const s = await demarrer(f.cert, f.cle);
      await expect(lier(s, "ldap.exemple.lan", racine.cert)).rejects.toMatchObject(
        refus(["ca_inconnue", "tls"]),
      );
      aucuneLiaison(s);
    });
    it("RFC 5280 §6.1.3 : certificat expiré : refusé en `cert_expire`", async () => {
      const ca = autorite();
      const s = await feuille(ca, {
        noms: ["ldap.exemple.lan"],
        avant: "20200101000000Z",
        apres: "20200201000000Z",
      });
      await expect(lier(s, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus("cert_expire"));
      aucuneLiaison(s);
    });
    it("RFC 5280 §6.1.3 : certificat pas encore valide : refusé en `cert_futur`", async () => {
      const ca = autorite();
      const s = await feuille(ca, {
        noms: ["ldap.exemple.lan"],
        avant: "20990101000000Z",
        apres: "21000101000000Z",
      });
      await expect(lier(s, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus("cert_futur"));
      aucuneLiaison(s);
    });
    it("RFC 5280 §4.2.1.12 : usage étendu clientAuth seul (pas serverAuth) : refusé", async () => {
      const ca = autorite();
      const f = creerFeuilleSpeciale(ca, {
        cn: "ldap.exemple.lan",
        san: "DNS:ldap.exemple.lan",
        eku: "clientAuth",
      });
      const s = await demarrer(f.cert, f.cle);
      await expect(lier(s, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus(["tls", "reseau"]));
      aucuneLiaison(s);
    });
    it("RFC 5280 §4.2.1.12 : aucun usage étendu déclaré : accepté (tout usage permis)", async () => {
      const ca = autorite();
      const f = creerFeuilleSpeciale(ca, { cn: "ldap.exemple.lan", san: "DNS:ldap.exemple.lan", eku: null });
      const s = await demarrer(f.cert, f.cle);
      await lier(s, "ldap.exemple.lan", ca.cert);
    });
    it("RFC 5280 §4.2.1.3 : usage de clé keyCertSign seul sur une feuille : refusé", async () => {
      const ca = autorite();
      const f = creerFeuilleSpeciale(ca, {
        cn: "ldap.exemple.lan",
        san: "DNS:ldap.exemple.lan",
        eku: "serverAuth",
        usage: "keyCertSign",
      });
      const s = await demarrer(f.cert, f.cle);
      await expect(lier(s, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus(["tls", "reseau"]));
      aucuneLiaison(s);
    });
  });

  describe("ancre de confiance (RFC 4513 §3.1.3, RFC 5280 §6)", () => {
    it("autorité collée = seule ancre : un certificat signé par une autre autorité (même nom) est refusé", async () => {
      const autre = autorite();
      const ca = autorite();
      const s = await feuille(autre, { noms: ["ldap.exemple.lan"] });
      await expect(lier(s, "ldap.exemple.lan", ca.cert)).rejects.toMatchObject(refus("ca_inconnue"));
      aucuneLiaison(s);
    });
    it("certificat auto-signé non collé : refusé en `auto_signe`", async () => {
      const as = creerAutoSigne("ldap.exemple.lan");
      aFermer.push(() => effacer(as));
      const s = await demarrer(as.cert, as.cle);
      await expect(lier(s, "ldap.exemple.lan", autorite().cert)).rejects.toMatchObject(
        refus(["auto_signe", "ca_inconnue"]),
      );
      aucuneLiaison(s);
    });
    it("certificat auto-signé collé comme autorité : accepté (le propriétaire de l'annuaire l'a désigné)", async () => {
      const as = creerAutoSigne("ldap.exemple.lan");
      aFermer.push(() => effacer(as));
      const s = await demarrer(as.cert, as.cle);
      await lier(s, "ldap.exemple.lan", as.cert);
    });
    it("autorité collée illisible : refusée dès l'enregistrement des réglages, aucune connexion possible", () => {
      expect(() =>
        fournisseur({ ca_pem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----" }),
      ).toThrowError();
    });
  });

  describe("RFC 4513 §6.3.1 : mot de passe en clair seulement sous TLS", () => {
    it("port qui ne parle pas TLS : aucune liaison, aucun octet LDAP ni mot de passe envoyé", async () => {
      const reçus: Buffer[] = [];
      const brut: Server = createServer((sock) => {
        sock.on("data", (d: Buffer) => reçus.push(d));
        sock.on("error", () => undefined);
        setTimeout(() => sock.destroy(), 200);
      });
      await new Promise<void>((ok) => brut.listen(0, "127.0.0.1", () => ok()));
      aFermer.push(() => new Promise<void>((ok) => brut.close(() => ok())));
      const port = (brut.address() as { port: number }).port;
      const cnx = await fabriqueLdapts({ juger: VERS_BOUCLE })(
        fournisseur({ ca_pem: autorite().cert, timeout_sec: 2 }),
        `ldaps://ldap.exemple.lan:${port}`,
      );
      await expect(cnx.lier(DN, MDP)).rejects.toMatchObject({ nature: "injoignable" });
      await cnx.fermer();
      const tout = Buffer.concat(reçus);
      expect(tout.includes(Buffer.from(MDP))).toBe(false);
      expect(tout.includes(Buffer.from(DN))).toBe(false);
    });
    it("l'adaptateur n'offre aucune voie sans TLS : adresses ldap:// et ldapi:// refusées", async () => {
      for (const url of ["ldap://ldap.exemple.lan", "ldap://ldap.exemple.lan:389", "ldapi://%2Frun%2Fldapi"])
        await expect(fabriqueLdapts({ juger: VERS_BOUCLE })(fournisseur(), url)).rejects.toMatchObject({
          nature: "configuration",
        });
    });
  });
});
