// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-sortant.test.ts — le client sortant des fournisseurs d'identité ne se connecte qu'aux adresses jugées et épinglées, ne désactive jamais la vérification du certificat ni du nom, ne suit aucune redirection, ignore les proxys d'environnement et borne taille et délais. */
import { readFileSync, readdirSync } from "node:fs";
import { createServer as serveurHttps } from "node:https";
import type { Server as ServeurHttps } from "node:https";
import { createServer as serveurTcp } from "node:net";
import type { AddressInfo, Server as ServeurTcp, Socket } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  classerErreur,
  clientHttps,
  connexionTls,
  ErreurSortant,
  jugeSortant,
} from "../src/identite/sortant";
import type { OptionsSortant } from "../src/identite/sortant";
import {
  creerAutoSigne,
  creerAutorite,
  creerFeuille,
  effacer,
  OPENSSL_DISPONIBLE,
} from "./identite/pki-openssl";
import type { Autorite, Feuille } from "./identite/pki-openssl";

const NOM = "elpis-test.invalid";
const VERS_BOUCLE = async (): Promise<{ motif: null; adresses: string[] }> => ({
  motif: null,
  adresses: ["127.0.0.1"],
});

interface Ecoute {
  port: number;
  fermer: () => Promise<void>;
}

async function ecouter(s: ServeurHttps | ServeurTcp): Promise<Ecoute> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const sockets = new Set<Socket>();
  s.on("connection", (x: Socket) => {
    sockets.add(x);
    x.on("close", () => sockets.delete(x));
  });
  return {
    port: (s.address() as AddressInfo).port,
    fermer: () =>
      new Promise<void>((r) => {
        for (const x of sockets) x.destroy();
        s.close(() => r());
      }),
  };
}

const ouvertes: Ecoute[] = [];
async function https(
  f: Feuille,
  traiter: Parameters<typeof serveurHttps>[1],
  extra: object = {},
): Promise<Ecoute> {
  const e = await ecouter(serveurHttps({ cert: f.cert, key: f.cle, ...extra }, traiter));
  ouvertes.push(e);
  return e;
}

const connecte = (o: OptionsSortant): OptionsSortant => ({ juger: VERS_BOUCLE, ...o });
const echec = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "aucun";
  } catch (e) {
    return e instanceof ErreurSortant ? e.code : `autre:${String(e)}`;
  }
};
async function lire(url: string, o: OptionsSortant): Promise<{ statut: number; texte: string }> {
  const c = clientHttps(o);
  try {
    const r = await c.fetch(url);
    return { statut: r.status, texte: await r.text() };
  } finally {
    await c.fermer();
  }
}

describe.skipIf(!OPENSSL_DISPONIBLE)("client sortant : confiance, adresses, bornes", () => {
  let ca: Autorite;
  let autre: Autorite;
  let bonne: Feuille;
  let autreNom: Feuille;
  let expiree: Feuille;
  let futur: Feuille;
  let autoSigne: Feuille & { dossier: string };

  beforeAll(() => {
    ca = creerAutorite("Test CA");
    autre = creerAutorite("Test CA autre");
    bonne = creerFeuille(ca, { noms: [NOM], ips: ["127.0.0.1"] });
    autreNom = creerFeuille(ca, { noms: ["autre.invalid"] });
    expiree = creerFeuille(ca, { noms: [NOM], avant: "20200101000000Z", apres: "20200201000000Z" });
    futur = creerFeuille(ca, { noms: [NOM], avant: "20990101000000Z", apres: "20990201000000Z" });
    autoSigne = creerAutoSigne(NOM);
  });
  afterAll(async () => {
    for (const e of ouvertes) await e.fermer();
    effacer(ca, autre, autoSigne);
  });

  describe("ancres de confiance", () => {
    it("autorité collée : la connexion aboutit, nom d'origine vérifié alors que l'adresse est celle du juge", async () => {
      const e = await https(bonne, (_q, r) => void r.end("bonjour"));
      const r = await lire(`https://${NOM}:${e.port}/`, connecte({ caPem: ca.cert, magasin: [] }));
      expect(r).toEqual({ statut: 200, texte: "bonjour" });
    });

    it("autorité inconnue : refusée", async () => {
      const e = await https(bonne, (_q, r) => void r.end("x"));
      expect(await echec(lire(`https://${NOM}:${e.port}/`, connecte({ magasin: [] })))).toBe("ca_inconnue");
    });

    it("l'autorité collée seule fait foi : un certificat d'une autre autorité, présente dans le magasin, est refusé", async () => {
      const e = await https(bonne, (_q, r) => void r.end("x"));
      const url = `https://${NOM}:${e.port}/`;
      const magasin = [ca.cert];
      expect(await echec(lire(url, connecte({ caPem: autre.cert, magasin })))).toBe("ca_inconnue");
      expect((await lire(url, connecte({ magasin }))).statut).toBe(200);
    });

    it("autorité collée illisible : erreur de configuration, jamais de repli sur le magasin", async () => {
      const e = await https(bonne, (_q, r) => void r.end("x"));
      const url = `https://${NOM}:${e.port}/`;
      for (const caPem of [
        "pas un certificat",
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
      ])
        expect(await echec(lire(url, connecte({ caPem, magasin: [ca.cert] }))), caPem).toBe("ca_illisible");
      expect(await echec(connexionTls(NOM, e.port, connecte({ caPem: "x", magasin: [ca.cert] })))).toBe(
        "ca_illisible",
      );
    });

    it("nom qui ne correspond pas : refusé", async () => {
      const e = await https(autreNom, (_q, r) => void r.end("x"));
      expect(await echec(lire(`https://${NOM}:${e.port}/`, connecte({ caPem: ca.cert })))).toBe(
        "nom_certificat",
      );
    });

    it("certificat expiré, pas encore valide, auto-signé : refusés", async () => {
      const a = await https(expiree, (_q, r) => void r.end("x"));
      const b = await https(futur, (_q, r) => void r.end("x"));
      const c = await https(autoSigne, (_q, r) => void r.end("x"));
      expect(await echec(lire(`https://${NOM}:${a.port}/`, connecte({ caPem: ca.cert })))).toBe(
        "cert_expire",
      );
      expect(await echec(lire(`https://${NOM}:${b.port}/`, connecte({ caPem: ca.cert })))).toBe("cert_futur");
      expect(await echec(lire(`https://${NOM}:${c.port}/`, connecte({ magasin: [ca.cert] })))).toBe(
        "auto_signe",
      );
    });

    it("hôte donné en adresse IP : vérifié contre les adresses du certificat", async () => {
      const bon = await https(bonne, (_q, r) => void r.end("ip"));
      const sansIp = await https(creerFeuille(ca, { noms: [NOM] }), (_q, r) => void r.end("x"));
      expect((await lire(`https://127.0.0.1:${bon.port}/`, connecte({ caPem: ca.cert }))).texte).toBe("ip");
      expect(await echec(lire(`https://127.0.0.1:${sansIp.port}/`, connecte({ caPem: ca.cert })))).toBe(
        "nom_certificat",
      );
    });

    it("TLS 1.1 refusé", async () => {
      const e = await https(bonne, (_q, r) => void r.end("x"), {
        minVersion: "TLSv1",
        maxVersion: "TLSv1.1",
        ciphers: "ALL:@SECLEVEL=0",
      });
      expect(await echec(lire(`https://${NOM}:${e.port}/`, connecte({ caPem: ca.cert })))).toBe(
        "version_tls",
      );
      expect(await echec(connexionTls(NOM, e.port, connecte({ caPem: ca.cert })))).toBe("version_tls");
    });

    it("aucune variable d'environnement n'éteint la vérification", async () => {
      const e = await https(bonne, (_q, r) => void r.end("x"));
      const avant = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
      process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
      try {
        expect(await echec(lire(`https://${NOM}:${e.port}/`, connecte({ magasin: [] })))).toBe("ca_inconnue");
        expect(await echec(connexionTls(NOM, e.port, connecte({ magasin: [] })))).toBe("ca_inconnue");
      } finally {
        if (avant === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
        else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = avant;
      }
    });

    it("le code du client ne contient aucun moyen d'éteindre la vérification", () => {
      const dossier = join(import.meta.dirname, "..", "src", "identite");
      for (const nom of readdirSync(dossier).filter((n) => n.endsWith(".ts"))) {
        const t = readFileSync(join(dossier, nom), "utf8");
        expect(t, nom).not.toMatch(
          /rejectUnauthorized\s*:\s*(?:false|0|undefined|!)|checkServerIdentity\s*:(?!\s*(?:typeof\s+)?verifierNomServeur\b|\s*options\.checkServerIdentity\b)|\.checkServerIdentity\s*=[^=]|NODE_TLS_REJECT_UNAUTHORIZED/u,
        );
      }
    });

    it("connexion TLS brute : socket authentifiée, certificat décrit", async () => {
      const e = await https(bonne, (_q, r) => void r.end("x"));
      const { socket, certificat } = await connexionTls(NOM, e.port, connecte({ caPem: ca.cert }));
      socket.destroy();
      expect(socket.authorized).toBe(true);
      expect(certificat.sujet).toBe(NOM);
      expect(certificat.emetteur).toMatch(/^Test CA \d+$/u);
      expect(certificat.version_tls).toMatch(/^TLSv1\.[23]$/u);
      expect(certificat.adresse).toBe("127.0.0.1");
      expect(certificat.valide_au).toBeGreaterThan(Date.now() / 1000);
    });
  });

  describe("adresses", () => {
    it("une seule résolution par connexion, et la connexion va à l'adresse validée (le nom ne se résout pas)", async () => {
      const e = await https(bonne, (_q, r) => void r.end("ok"));
      const appels: string[] = [];
      const juger = async (h: string, p: number): Promise<{ motif: null; adresses: string[] }> => {
        appels.push(`${h}:${p}`);
        return { motif: null, adresses: ["127.0.0.1"] };
      };
      const r = await lire(`https://${NOM}:${e.port}/`, { caPem: ca.cert, juger });
      expect(r.statut).toBe(200);
      expect(appels).toEqual([`${NOM}:${e.port}`]);
    });

    it("résolution injectée : le juge réel refuse boucle, lien local, non spécifiée, multidiffusion ; le réseau local passe", async () => {
      const juge = (adresses: string[]): ReturnType<typeof jugeSortant> => jugeSortant(async () => adresses);
      for (const a of ["127.0.0.1", "::1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "fe80::1"]) {
        const v = await juge([a])("ldap.exemple.lan", 636);
        expect(v.motif, a).not.toBeNull();
        expect(v.adresses).toEqual([]);
      }
      expect((await juge(["10.0.0.5", "127.0.0.1"])("ldap.exemple.lan", 636)).motif).not.toBeNull();
      expect(await juge(["192.168.1.10"])("ldap.exemple.lan", 636)).toEqual({
        motif: null,
        adresses: ["192.168.1.10"],
      });
    });

    it("adresses littérales : jugées aussi", async () => {
      const juge = jugeSortant(async () => {
        throw new Error("pas de résolution pour une adresse");
      });
      for (const h of ["127.0.0.1", "169.254.1.1", "0.0.0.0", "::1"])
        expect((await juge(h, 443)).motif, h).not.toBeNull();
      expect(await juge("10.1.2.3", 443)).toEqual({ motif: null, adresses: ["10.1.2.3"] });
    });

    it("nom qui ne se résout pas : refusé", async () => {
      const v = await jugeSortant(async () => {
        throw new Error("ENOTFOUND");
      })("introuvable.exemple.lan", 636);
      expect(v.motif).toMatch(/^unresolvable_host/u);
    });

    it("juge réel de bout en bout : un nom qui résout vers la boucle locale est refusé avant toute connexion", async () => {
      let connexions = 0;
      const piege = await ecouter(serveurTcp(() => void (connexions += 1)));
      ouvertes.push(piege);
      const resoudre = async (): Promise<string[]> => ["127.0.0.1"];
      expect(await echec(lire(`https://${NOM}:${piege.port}/`, { caPem: ca.cert, resoudre }))).toBe(
        "adresse_refusee",
      );
      expect(await echec(connexionTls(NOM, piege.port, { caPem: ca.cert, resoudre }))).toBe(
        "adresse_refusee",
      );
      for (const h of ["127.0.0.1", "169.254.169.254", "0.0.0.0"])
        expect(await echec(lire(`https://${h}:${piege.port}/`, { caPem: ca.cert })), h).toBe(
          "adresse_refusee",
        );
      expect(connexions).toBe(0);
    });
  });

  describe("réponses et délais", () => {
    it("redirection : jamais suivie, c'est un échec", async () => {
      let cible = 0;
      const b = await https(bonne, (_q, r) => {
        cible += 1;
        r.end("cible");
      });
      const a = await https(
        bonne,
        (_q, r) => void r.writeHead(302, { location: `https://${NOM}:${b.port}/` }).end(),
      );
      expect(await echec(lire(`https://${NOM}:${a.port}/`, connecte({ caPem: ca.cert })))).toBe(
        "redirection",
      );
      expect(cible).toBe(0);
    });

    it("corps de plus de 1 Mio : coupé, échec ; annoncé ou non", async () => {
      const e = await https(bonne, (q, r) => {
        if (q.url === "/annonce")
          r.writeHead(200, { "content-length": 2 * 1024 * 1024 }).end(Buffer.alloc(2 * 1024 * 1024));
        else {
          r.writeHead(200);
          const bloc = Buffer.alloc(64 * 1024, 97);
          for (let i = 0; i < 40; i++) r.write(bloc);
          r.end();
        }
      });
      for (const chemin of ["annonce", "flux"])
        expect(
          await echec(lire(`https://${NOM}:${e.port}/${chemin}`, connecte({ caPem: ca.cert }))),
          chemin,
        ).toBe("taille");
    });

    it("corps d'1 Mio exactement : accepté", async () => {
      const e = await https(bonne, (_q, r) => void r.end(Buffer.alloc(1024 * 1024, 97)));
      expect((await lire(`https://${NOM}:${e.port}/`, connecte({ caPem: ca.cert }))).texte).toHaveLength(
        1024 * 1024,
      );
    });

    it("réponse qui ne vient pas : délai total", async () => {
      const e = await https(bonne, () => undefined);
      expect(
        await echec(lire(`https://${NOM}:${e.port}/`, connecte({ caPem: ca.cert, delaiTotalMs: 400 }))),
      ).toBe("delai");
    });

    it("poignée de main qui ne vient pas : délai de connexion, pour https comme pour ldaps", async () => {
      const muet = await ecouter(serveurTcp(() => undefined));
      ouvertes.push(muet);
      expect(
        await echec(
          lire(`https://${NOM}:${muet.port}/`, connecte({ caPem: ca.cert, delaiConnexionMs: 300 })),
        ),
      ).toBe("delai");
      expect(
        await echec(connexionTls(NOM, muet.port, connecte({ caPem: ca.cert, delaiConnexionMs: 300 }))),
      ).toBe("delai");
    });

    it("port fermé : connexion refusée", async () => {
      const t = await ecouter(serveurTcp(() => undefined));
      await t.fermer();
      expect(await echec(lire(`https://${NOM}:${t.port}/`, connecte({ caPem: ca.cert })))).toBe("refusee");
    });

    it("proxy d'environnement ignoré", async () => {
      let passages = 0;
      const proxy = await ecouter(serveurTcp(() => void (passages += 1)));
      ouvertes.push(proxy);
      const e = await https(bonne, (_q, r) => void r.end("direct"));
      const env = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "HTTP_PROXY", "NODE_USE_ENV_PROXY"] as const;
      const avant = env.map((k) => process.env[k]);
      for (const k of env)
        process.env[k] = k === "NODE_USE_ENV_PROXY" ? "1" : `http://127.0.0.1:${proxy.port}`;
      try {
        expect((await lire(`https://${NOM}:${e.port}/`, connecte({ caPem: ca.cert }))).texte).toBe("direct");
      } finally {
        env.forEach((k, i) => {
          const v = avant[i];
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        });
      }
      expect(passages).toBe(0);
    });

    it("http:// et identifiants dans l'adresse : refusés sans connexion", async () => {
      let connexions = 0;
      const piege = await ecouter(serveurTcp(() => void (connexions += 1)));
      ouvertes.push(piege);
      for (const u of [
        `http://${NOM}:${piege.port}/`,
        `https://u:p@${NOM}:${piege.port}/`,
        "pas une adresse",
      ])
        expect(await echec(lire(u, connecte({ caPem: ca.cert }))), u).toBe("schema");
      expect(connexions).toBe(0);
    });
  });

  it("classerErreur : seul le code compte, jamais le message", () => {
    const piege = Object.assign(new Error("message hostile du pair : secret-xyz"), {
      code: "CERT_HAS_EXPIRED",
    });
    expect(classerErreur(new TypeError("fetch failed", { cause: piege }))).toBe("cert_expire");
    expect(classerErreur(new Error("quelque chose"))).toBe("reseau");
    expect(new ErreurSortant("delai").message).toBe("delai");
  });
});
