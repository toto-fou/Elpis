// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-sortant-nom.test.ts — le nom du serveur se vérifie selon RFC 9525 (subjectAltName seul, joker entier à gauche, adresse IP comparée à une entrée iPAddress) pour la connexion TLS du test comme pour le client HTTPS. */
import { createServer } from "node:https";
import type { Server } from "node:https";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clientHttps,
  connexionTls,
  ErreurSortant,
  sansNomAlternatif,
  verifierNomServeur,
} from "../src/identite/sortant";
import { creerFeuilleSpeciale } from "./conformite/pki-conformite";
import { creerAutorite, creerFeuille, effacer, OPENSSL_DISPONIBLE } from "./identite/pki-openssl";
import type { Autorite, Feuille } from "./identite/pki-openssl";

const VERS_BOUCLE = async (): Promise<{ motif: null; adresses: string[] }> => ({
  motif: null,
  adresses: ["127.0.0.1"],
});

describe.skipIf(!OPENSSL_DISPONIBLE)("nom du serveur sortant : RFC 9525", () => {
  let ca: Autorite;
  const serveurs: Server[] = [];
  beforeAll(() => {
    ca = creerAutorite("Test CA nom");
  });
  afterAll(async () => {
    for (const s of serveurs) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    effacer(ca);
  });

  const servir = async (f: Feuille): Promise<number> => {
    const s = createServer({ cert: f.cert, key: f.cle }, (_q, r) => void r.end("x"));
    serveurs.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    return (s.address() as AddressInfo).port;
  };
  const options = { juger: VERS_BOUCLE, caPem: "", magasin: [] as string[] };
  const tls = async (port: number, hote: string): Promise<ErreurSortant | null> => {
    try {
      const { socket } = await connexionTls(hote, port, { ...options, caPem: ca.cert });
      socket.destroy();
      return null;
    } catch (e) {
      return e as ErreurSortant;
    }
  };
  const https = async (port: number, hote: string): Promise<string> => {
    const c = clientHttps({ ...options, caPem: ca.cert });
    try {
      await c.fetch(`https://${hote.includes(":") ? `[${hote}]` : hote}:${port}/`);
      return "accepte";
    } catch (e) {
      return e instanceof ErreurSortant ? e.code : `autre:${String(e)}`;
    } finally {
      await c.fermer();
    }
  };
  const verdict = async (f: Feuille, hote: string): Promise<[string, string]> => {
    const port = await servir(f);
    const l = await tls(port, hote);
    return [l === null ? "accepte" : l.code, await https(port, hote)];
  };

  it("RFC 9525 §2 : certificat sans subjectAltName refusé même si le CN est le nom demandé, en TLS brut et en HTTPS", async () => {
    const f = creerFeuilleSpeciale(ca, { cn: "idp.exemple.lan", san: null, eku: "serverAuth" });
    const port = await servir(f);
    const l = await tls(port, "idp.exemple.lan");
    expect(l?.code).toBe("nom_certificat");
    expect(sansNomAlternatif(l)).toBe(true);
    expect(await https(port, "idp.exemple.lan")).toBe("nom_certificat");
  });

  it("RFC 9525 §6.3 : joker partiel refusé, joker hors de l'étiquette de gauche refusé, `*` seul et `*.lan` refusés", async () => {
    for (const nom of ["i*.exemple.lan", "idp.*.lan", "*", "*.lan", "*.*.lan"]) {
      const f = creerFeuille(ca, { noms: [nom] });
      expect(await verdict(f, "idp.exemple.lan"), nom).toEqual(["nom_certificat", "nom_certificat"]);
    }
  });

  it("RFC 9525 §6.3 : `*.exemple.lan` couvre `a.exemple.lan` seulement, ni `a.b.exemple.lan` ni `exemple.lan`", async () => {
    const f = creerFeuille(ca, { noms: ["*.exemple.lan"] });
    expect(await verdict(f, "a.exemple.lan")).toEqual(["accepte", "accepte"]);
    expect(await verdict(f, "a.b.exemple.lan")).toEqual(["nom_certificat", "nom_certificat"]);
    expect(await verdict(f, "exemple.lan")).toEqual(["nom_certificat", "nom_certificat"]);
  });

  it("RFC 9525 §6.3 : un joker ignoré n'empêche pas un nom exact du même certificat", async () => {
    const f = creerFeuille(ca, { noms: ["i*.exemple.lan", "idp.exemple.lan"] });
    expect(await verdict(f, "idp.exemple.lan")).toEqual(["accepte", "accepte"]);
  });

  it("RFC 9525 §6.3 : nom DNS exact du subjectAltName accepté, autre nom refusé", async () => {
    const f = creerFeuille(ca, { noms: ["idp.exemple.lan"] });
    expect(await verdict(f, "idp.exemple.lan")).toEqual(["accepte", "accepte"]);
    expect(await verdict(f, "intrus.exemple.lan")).toEqual(["nom_certificat", "nom_certificat"]);
  });

  it("RFC 9525 §6.2 : adresse IP acceptée avec une entrée iPAddress, refusée avec le seul nom DNS « 127.0.0.1 »", async () => {
    expect(
      await verdict(creerFeuille(ca, { noms: ["idp.exemple.lan"], ips: ["127.0.0.1"] }), "127.0.0.1"),
    ).toEqual(["accepte", "accepte"]);
    expect(await verdict(creerFeuille(ca, { noms: ["127.0.0.1"] }), "127.0.0.1")).toEqual([
      "nom_certificat",
      "nom_certificat",
    ]);
  });
});

describe("nom du serveur sortant : subjectAltName tel que la plateforme l'écrit", () => {
  const juger = (hote: string, san: string | undefined): string => {
    const e = verifierNomServeur(hote, { subject: { CN: hote }, subjectaltname: san } as never);
    return e === undefined ? "accepte" : String((e as { code?: unknown }).code);
  };

  it("une valeur entre guillemets qui contient « , DNS: » ne fabrique jamais un nom : refusé, sans exception", () => {
    expect(juger("mechant.exemple.lan", 'DNS:"x*, DNS:mechant.exemple.lan"')).toBe(
      "ERR_TLS_CERT_ALTNAME_INVALID",
    );
    expect(juger("mechant.exemple.lan", 'DNS:"a.exemple.lan, DNS:mechant.exemple.lan"')).toBe(
      "ERR_TLS_CERT_ALTNAME_INVALID",
    );
    expect(juger("a.exemple.lan", 'DNS:"a.exemple.lan')).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("une entrée d'un autre type entre guillemets n'empêche pas le nom DNS exact, et n'en fabrique pas", () => {
    const san = 'DirName:"CN=a.exemple.lan, DNS:b.exemple.lan", DNS:a.exemple.lan, IP Address:10.0.0.1';
    expect(juger("a.exemple.lan", san)).toBe("accepte");
    expect(juger("b.exemple.lan", san)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(juger("10.0.0.1", san)).toBe("accepte");
    expect(juger("10.0.0.2", san)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("le nom commun n'est jamais lu : sans subjectAltName, ou avec des adresses seulement, un nom DNS est refusé", () => {
    expect(juger("a.exemple.lan", undefined)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(juger("a.exemple.lan", "")).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(juger("a.exemple.lan", "IP Address:10.0.0.1")).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("adresse IPv6 : comparée à une entrée iPAddress, quelle que soit son écriture", () => {
    const san = "IP Address:2001:DB8:0:0:0:0:0:1, DNS:a.exemple.lan";
    expect(juger("2001:db8::1", san)).toBe("accepte");
    expect(juger("2001:db8::2", san)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });
});
