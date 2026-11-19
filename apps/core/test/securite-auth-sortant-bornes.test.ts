// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-sortant-bornes.test.ts — le test d'un fournisseur et le client sortant sont bornés : une résolution de nom ne dépasse ni son délai ni son nombre de fils, l'échéance arrête le travail, le créneau n'est rendu qu'à la fin réelle, ldaps n'annonce aucun ALPN, les messages TLS disent la vraie cause. */
import { createServer as serveurHttps } from "node:https";
import { createServer as serveurTcp } from "node:net";
import type { AddressInfo, Server as ServeurTcp, Socket } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { lancerTest, testerFournisseur } from "../src/identite/essai";
import type { ContexteEssai } from "../src/identite/essai";
import { validerFournisseur } from "../src/identite/reglages";
import {
  classerErreur,
  clientHttps,
  connexionTls,
  creerResolutionBornee,
  ErreurSortant,
  nomCourt,
} from "../src/identite/sortant";
import { ldapValide, oidcValide } from "./identite/aides";
import { creerAutorite, creerFeuille, effacer, OPENSSL_DISPONIBLE } from "./identite/pki-openssl";
import type { Autorite, Feuille } from "./identite/pki-openssl";

const NOM = "elpis-test.invalid";
const BON: ContexteEssai = { publicUrl: "https://elpis.exemple.lan", cookieSecure: true, adminsLocaux: 1 };
const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const VERS_BOUCLE = async (): Promise<{ motif: null; adresses: string[] }> => ({
  motif: null,
  adresses: ["127.0.0.1"],
});
const echec = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "aucun";
  } catch (e) {
    return e instanceof ErreurSortant ? e.code : `autre:${String(e)}`;
  }
};

describe("résolution de nom bornée", () => {
  it("au plus N recherches du système en vol, chacune coupée à son délai, le fil n'étant rendu qu'à la fin réelle", async () => {
    const libres: (() => void)[] = [];
    let appels = 0;
    const resoudre = creerResolutionBornee({
      chercher: () => {
        appels += 1;
        return new Promise<string[]>((r) => libres.push(() => r(["10.0.0.5"])));
      },
      delaiMs: 80,
      simultanes: 2,
    });
    const rates = await Promise.allSettled([
      resoudre("a.invalid", 1),
      resoudre("b.invalid", 1),
      resoudre("c.invalid", 1),
    ]);
    expect(rates.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect((rates[0] as PromiseRejectedResult).reason).toMatchObject({ code: "EAI_AGAIN" });
    expect(appels, "la troisième n'a jamais obtenu de fil").toBe(2);
    expect(await echec(resoudre("d.invalid", 1))).not.toBe("aucun");
    expect(appels, "les deux fils ne sont pas rendus tant que les recherches ne finissent pas").toBe(2);
    for (const l of libres) l();
    await dormir(10);
    const vue = resoudre("e.invalid", 1);
    await dormir(5);
    libres.at(-1)?.();
    expect(await vue).toEqual(["10.0.0.5"]);
    expect(appels).toBe(3);
  });
});

describe("échéance globale du test d'un fournisseur", () => {
  let piege: ServeurTcp;
  let port = 0;
  let connexions = 0;
  const sockets = new Set<Socket>();
  beforeAll(async () => {
    piege = serveurTcp((x) => {
      connexions += 1;
      sockets.add(x);
      x.resume();
    });
    await new Promise<void>((r) => piege.listen(0, "127.0.0.1", () => r()));
    port = (piege.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const x of sockets) x.destroy();
    await new Promise<void>((r) => piege.close(() => r()));
  });
  afterEach(() => {
    connexions = 0;
  });

  it("résolution plus lente que l'échéance : le résultat part à l'échéance, aucune connexion ne démarre ensuite, le travail se termine après", async () => {
    let jugements = 0;
    const lent = async (): Promise<{ motif: null; adresses: string[] }> => {
      jugements += 1;
      await dormir(400);
      return { motif: null, adresses: ["127.0.0.1"] };
    };
    const t0 = Date.now();
    const lance = lancerTest(
      ldapValide({ urls: [`ldaps://serveur.invalid:${port}`, `ldaps://autre.invalid:${port}`] }),
      BON,
      { delaiGlobalMs: 100, sortant: { juger: lent } },
    );
    const r = await lance.resultat;
    expect(Date.now() - t0).toBeLessThan(350);
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ id: "timeout", level: "fail" });
    let fini = false;
    void lance.termine.then(() => (fini = true));
    await dormir(50);
    expect(fini, "le travail court encore : le créneau n'est pas rendu").toBe(false);
    await lance.termine;
    await dormir(100);
    expect(connexions, "aucune connexion après l'échéance").toBe(0);
    expect(jugements, "la deuxième adresse n'est même pas jugée").toBe(1);
  });

  it("testerFournisseur rend la même échéance", async () => {
    const lent = async (): Promise<{ motif: null; adresses: string[] }> => {
      await dormir(300);
      return { motif: null, adresses: ["127.0.0.1"] };
    };
    const r = await testerFournisseur(ldapValide({ urls: [`ldaps://serveur.invalid:${port}`] }), BON, {
      delaiGlobalMs: 80,
      sortant: { juger: lent },
    });
    expect(r.steps.at(-1)?.id).toBe("timeout");
    await dormir(400);
    expect(connexions).toBe(0);
  });

  it("connexion en cours à l'échéance : abandonnée, socket détruite", async () => {
    const r = await lancerTest(ldapValide({ urls: [`ldaps://muet.invalid:${port}`] }), BON, {
      delaiGlobalMs: 150,
      sortant: { juger: VERS_BOUCLE },
    }).resultat;
    expect(r.steps.at(-1)?.id).toBe("timeout");
    await dormir(50);
    expect([...sockets].every((x) => x.destroyed)).toBe(true);
    expect(sockets.size).toBe(1);
  });
});

describe("messages TLS et connexion ldaps", () => {
  let ca: Autorite;
  let feuille: Feuille;
  const fermer: (() => Promise<void>)[] = [];
  beforeAll(() => {
    if (!OPENSSL_DISPONIBLE) return;
    ca = creerAutorite("Test CA bornes");
    feuille = creerFeuille(ca, { noms: [NOM] });
  });
  afterAll(async () => {
    for (const f of fermer) await f();
    if (OPENSSL_DISPONIBLE) effacer(ca);
  });

  async function clair(): Promise<number> {
    const ouverts = new Set<Socket>();
    const s = serveurTcp((x) => {
      ouverts.add(x);
      x.on("error", () => undefined);
      x.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    fermer.push(
      () =>
        new Promise<void>((r) => {
          for (const x of ouverts) x.destroy();
          s.close(() => r());
        }),
    );
    return (s.address() as AddressInfo).port;
  }

  it("classement : le service qui ne parle pas TLS, la version et le refus d'ALPN sont trois causes distinctes", () => {
    const code = (c: string): string => classerErreur(Object.assign(new Error("x"), { code: c }));
    expect(code("ERR_SSL_WRONG_VERSION_NUMBER")).toBe("pas_tls");
    expect(code("ERR_SSL_HTTP_REQUEST")).toBe("pas_tls");
    expect(code("ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION")).toBe("version_tls");
    expect(code("ERR_SSL_UNSUPPORTED_PROTOCOL")).toBe("version_tls");
    expect(code("ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL")).toBe("tls");
    expect(code("ERR_SSL_TLSV1_ALERT_UNKNOWN_CA")).toBe("tls");
  });

  it("un ldaps:// pointé sur un port en clair : « ce port ne parle pas TLS », au client https comme à la connexion brute et au bouton Tester", async () => {
    const port = await clair();
    expect(await echec(connexionTls(NOM, port, { juger: VERS_BOUCLE, magasin: [] }))).toBe("pas_tls");
    const c = clientHttps({ juger: VERS_BOUCLE, magasin: [] });
    expect(await echec(c.fetch(`https://${NOM}:${port}/`))).toBe("pas_tls");
    await c.fermer();
    const r = await testerFournisseur(ldapValide({ urls: [`ldaps://${NOM}:${port}`] }), BON, {
      sortant: { juger: VERS_BOUCLE, magasin: [] },
    });
    expect(r.steps.at(-1)?.detail).toContain("Ce port ne parle pas TLS");
  });

  it("magasin du système illisible sans autorité collée : message distinct de « autorité collée illisible »", async () => {
    const avant = process.env["SSL_CERT_FILE"];
    process.env["SSL_CERT_FILE"] = "/nonexistent/elpis-ca.pem";
    try {
      expect(await echec(connexionTls(NOM, 1, { juger: VERS_BOUCLE }))).toBe("magasin_illisible");
      expect(await echec(connexionTls(NOM, 1, { juger: VERS_BOUCLE, caPem: "pas un certificat" }))).toBe(
        "ca_illisible",
      );
      const r = await testerFournisseur(ldapValide({ urls: [`ldaps://${NOM}:1`] }), BON, {
        sortant: { juger: VERS_BOUCLE },
      });
      const detail = r.steps.at(-1)?.detail ?? "";
      expect(detail).toContain("autorités de certification de ce serveur sont illisibles");
      expect(detail).not.toContain("collée est illisible");
    } finally {
      if (avant === undefined) delete process.env["SSL_CERT_FILE"];
      else process.env["SSL_CERT_FILE"] = avant;
    }
  });

  it.skipIf(!OPENSSL_DISPONIBLE)(
    "ldaps n'annonce aucun protocole ALPN (le client https annonce http/1.1 seul, même si le serveur préfère h2)",
    async () => {
      const vus: (string | false | null | undefined)[] = [];
      const s = serveurHttps(
        { cert: feuille?.cert, key: feuille?.cle, ALPNProtocols: ["h2", "http/1.1"] },
        (_q, r) => void r.end("x"),
      );
      s.on("secureConnection", (t) => void vus.push(t.alpnProtocol));
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
      fermer.push(
        () =>
          new Promise<void>((r) => {
            s.closeAllConnections();
            s.close(() => r());
          }),
      );
      const port = (s.address() as AddressInfo).port;
      const { socket, certificat } = await connexionTls(NOM, port, { juger: VERS_BOUCLE, caPem: ca.cert });
      expect(socket.authorized).toBe(true);
      expect(certificat.adresse).toBe("127.0.0.1");
      await dormir(50);
      socket.destroy();
      expect(vus).toEqual([false]);
      const c = clientHttps({ juger: VERS_BOUCLE, caPem: ca.cert });
      await (await c.fetch(`https://${NOM}:${port}/`)).text();
      await c.fermer();
      expect(vus[1]).toBe("http/1.1");
    },
  );
});

describe("champs du certificat présenté", () => {
  it("contrôle, mise en forme invisible et séparateurs de ligne ou de paragraphe sont retirés", () => {
    const brut = "a\u0000b​c‮d e f­g﻿h";
    const propre = nomCourt({ CN: brut });
    expect(propre).toBe("a?b?c?d?e?f?g?h");
    expect(propre).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(nomCourt({ O: ["x".repeat(300)] })).toHaveLength(120);
  });
});

describe("adresses saisies", () => {
  it("port 0 : refusé pour l'émetteur OIDC", () => {
    for (const issuer of ["https://idp.exemple.lan:0/realms/x", "https://idp.exemple.lan:00"])
      expect(() => validerFournisseur(oidcValide({ issuer })), issuer).toThrow(/port invalide/u);
    expect(validerFournisseur(oidcValide({ issuer: "https://idp.exemple.lan:8443/realms/x" })).type).toBe(
      "oidc",
    );
  });

  it("hôte entre crochets : seulement une adresse IPv6 valide", () => {
    for (const hote of ["[abc]", "[1.2.3.4]", "[zz::1]", "[:::]", "[1:2:3]", "[::g]"])
      expect(() => validerFournisseur(ldapValide({ urls: [`ldaps://${hote}`] })), hote).toThrow();
    for (const hote of ["[::1]", "[2001:db8::10]:6360"])
      expect(validerFournisseur(ldapValide({ urls: [`ldaps://${hote}`] })).type, hote).toBe("ldap");
  });

  it("l'étape « adresse » reconnaît une adresse littérale avec l'analyseur d'adresses, pas avec une expression régulière", async () => {
    const detailResolve = async (hote: string): Promise<string | undefined> =>
      (
        await testerFournisseur(ldapValide({ urls: [`ldaps://${hote}:1`] }), BON, {
          sortant: { juger: async () => ({ motif: "blocked_ip", adresses: [] }) },
        })
      ).steps.find((s) => s.id === "resolve")?.detail;
    expect(await detailResolve("1234")).toBe("Nom résolu.");
    expect(await detailResolve("1.2.3")).toBe("Nom résolu.");
    expect(await detailResolve("10.1.2.3")).toBe("Adresse IP donnée telle quelle.");
    expect(await detailResolve("[2001:db8::10]")).toBe("Adresse IP donnée telle quelle.");
  });

  it("une adresse de cette machine : avertissement, jamais un refus", async () => {
    const juger = async (): Promise<{ motif: null; adresses: string[] }> => ({
      motif: null,
      adresses: ["192.168.50.7"],
    });
    const lancer = (locales: string[]): ReturnType<typeof testerFournisseur> =>
      testerFournisseur(oidcValide({ issuer: "https://idp.invalid:9" }), BON, {
        adressesLocales: () => locales,
        sortant: { juger, delaiConnexionMs: 200 },
      });
    const etape = (r: Awaited<ReturnType<typeof lancer>>): { level: string; detail: string } | undefined =>
      r.steps.find((s) => s.id === "address");
    const sur = await lancer(["192.168.50.7", "fe80::1"]);
    expect(etape(sur)).toMatchObject({ level: "warn" });
    expect(etape(sur)?.detail).toContain("Cette adresse est celle de cette machine.");
    const autre = await lancer(["10.9.9.9"]);
    expect(etape(autre)).toMatchObject({ level: "ok" });
    expect(etape(autre)?.detail).not.toContain("cette machine");
  });
});
