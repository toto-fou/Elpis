// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/securite-tls-sortant.test.ts — les connexions sortantes vers l'annuaire (LDAPS) et le fournisseur d'identité suivent le guide TLS de l'ANSSI et OWASP ASVS 5.0 V12 : TLS 1.2 au moins et 1.3 préféré, suites à confidentialité persistante et chiffrement authentifié seulement, certificat et nom vérifiés, aucun repli en clair. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as serveurHttps } from "node:https";
import type { Server } from "node:https";
import { createServer as serveurTcp } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clientHttps, connexionTls, ErreurSortant } from "../../src/identite/sortant";
import type { OptionsSortant } from "../../src/identite/sortant";
import { creerAutorite, creerFeuille, effacer, OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import type { Autorite, Feuille } from "../identite/pki-openssl";

const NOM = "elpis-test.invalid";
const VERS_BOUCLE = async (): Promise<{ motif: null; adresses: string[] }> => ({
  motif: null,
  adresses: ["127.0.0.1"],
});
const connecte = (o: OptionsSortant): OptionsSortant => ({ juger: VERS_BOUCLE, ...o });

describe.skipIf(!OPENSSL_DISPONIBLE)("TLS sortant : guide TLS de l'ANSSI et ASVS V12", () => {
  let ca: Autorite;
  let feuille: Feuille;
  const serveurs: Server[] = [];

  beforeAll(() => {
    ca = creerAutorite("Test CA TLS");
    feuille = creerFeuille(ca, { noms: [NOM], ips: ["127.0.0.1"] });
  });
  afterAll(async () => {
    for (const s of serveurs) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    effacer(ca);
  });

  async function serveur(extra: object = {}): Promise<number> {
    const s = serveurHttps({ cert: feuille.cert, key: feuille.cle, ...extra }, (_q, r) => void r.end("x"));
    serveurs.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    return (s.address() as AddressInfo).port;
  }
  const tls = async (port: number): Promise<string> => {
    const { socket, certificat } = await connexionTls(NOM, port, connecte({ caPem: ca.cert, magasin: [] }));
    socket.destroy();
    return certificat.version_tls;
  };
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "aucun";
    } catch (e) {
      return e instanceof ErreurSortant ? e.code : `autre:${String(e)}`;
    }
  };

  it("ANSSI TLS R3 : TLS 1.3 est négocié quand le serveur le propose", async () => {
    expect(await tls(await serveur())).toBe("TLSv1.3");
  });

  it("ANSSI TLS R3 et ASVS 5.0 V12.1.1 : TLS 1.2 reste accepté face à un serveur qui ne propose pas mieux", async () => {
    expect(await tls(await serveur({ maxVersion: "TLSv1.2" }))).toBe("TLSv1.2");
  });

  it("ANSSI TLS R4 et ASVS 5.0 V12.1.1 : SSLv3, TLS 1.0 et TLS 1.1 sont refusés, par le client https comme par la connexion brute", async () => {
    const port = await serveur({ minVersion: "TLSv1", maxVersion: "TLSv1.1", ciphers: "ALL:@SECLEVEL=0" });
    expect(await code(tls(port))).toBe("version_tls");
    const c = clientHttps(connecte({ caPem: ca.cert, magasin: [] }));
    try {
      expect(await code(c.fetch(`https://${NOM}:${port}/`))).toBe("version_tls");
    } finally {
      await c.fermer();
    }
  });

  it("ANSSI TLS R8 et ASVS 5.0 V12.3.2 : le certificat du serveur doit être signé par l'autorité de confiance, sinon refus", async () => {
    const port = await serveur();
    expect(await code(connexionTls(NOM, port, connecte({ magasin: [] })))).toBe("ca_inconnue");
  });

  it("ANSSI-PA-080 R6 : le nom demandé doit figurer dans le certificat présenté", async () => {
    const port = await serveur();
    const autre = "autre-nom.invalid";
    expect(await code(connexionTls(autre, port, connecte({ caPem: ca.cert, magasin: [] })))).toBe(
      "nom_certificat",
    );
  });

  it("ASVS 5.0 V12.2.1 et V12.3.1 : un port qui ne parle pas TLS est refusé, jamais utilisé en clair", async () => {
    const sockets = new Set<Socket>();
    const s = serveurTcp((x) => {
      sockets.add(x);
      x.end("220 en clair\r\n");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (s.address() as AddressInfo).port;
      expect(await code(connexionTls(NOM, port, connecte({ caPem: ca.cert, magasin: [] })))).not.toBe(
        "aucun",
      );
    } finally {
      for (const x of sockets) x.destroy();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
  describe("suites cryptographiques (certificat RSA)", () => {
    let dossier: string;
    let rsa: { cert: string; key: string };
    beforeAll(() => {
      dossier = mkdtempSync(join(tmpdir(), "elpis-tls-rsa-"));
      const r = spawnSync(
        "openssl",
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "k.pem", "-out", "c.pem", "-subj", `/CN=${NOM}`, "-days", "2", "-addext", `subjectAltName=DNS:${NOM},IP:127.0.0.1`],
        { cwd: dossier },
      ); // prettier-ignore
      if (r.status !== 0) throw new Error("openssl indisponible");
      rsa = {
        cert: readFileSync(join(dossier, "c.pem"), "utf8"),
        key: readFileSync(join(dossier, "k.pem"), "utf8"),
      };
    });
    afterAll(() => rmSync(dossier, { recursive: true, force: true }));

    const serveurRsa = async (ciphers: string): Promise<number> => {
      const s = serveurHttps(
        { cert: rsa.cert, key: rsa.key, maxVersion: "TLSv1.2", ciphers: `${ciphers}:@SECLEVEL=0` },
        (_q, r) => void r.end("x"),
      );
      serveurs.push(s);
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
      return (s.address() as AddressInfo).port;
    };
    const essai = async (port: number): Promise<string> => {
      const o = connecte({ caPem: rsa.cert, magasin: [] });
      const brut = await code(connexionTls(NOM, port, o).then(({ socket }) => socket.destroy()));
      const c = clientHttps(o);
      try {
        const https = await code(c.fetch(`https://${NOM}:${port}/`));
        return brut === https ? brut : `${brut}/${https}`;
      } finally {
        await c.fermer();
      }
    };

    it("ANSSI TLS R6 et ASVS 5.0 V12.1.2 : un serveur qui n'offre que l'échange de clés RSA, sans confidentialité persistante, est refusé", async () => {
      expect(await essai(await serveurRsa("AES128-GCM-SHA256"))).toBe("tls");
    });

    it("ANSSI TLS R10 et ASVS 5.0 V12.1.2 : un serveur qui n'offre que le mode CBC, sans chiffrement authentifié, est refusé", async () => {
      expect(await essai(await serveurRsa("ECDHE-RSA-AES128-SHA256"))).toBe("tls");
    });

    it("ANSSI TLS R7 et R10 : ECDHE avec AES-GCM reste accepté en TLS 1.2", async () => {
      expect(await essai(await serveurRsa("ECDHE-RSA-AES128-GCM-SHA256"))).toBe("aucun");
    });
  });
});
