// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-essai.test.ts — le test d'un fournisseur ne rend que des champs d'une liste blanche (jamais un corps, un en-tête ou un message d'un tiers), juge la découverte OIDC strictement et mesure l'écart d'horloge. */
import { createServer as serveurHttps } from "node:https";
import type { Server } from "node:https";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { testerFournisseur } from "../src/identite/essai";
import type { ContexteEssai, ResultatEssai } from "../src/identite/essai";
import { installerCrochetJournal } from "../src/journal";
import { ldapValide, oidcValide } from "./identite/aides";
import { creerAutorite, creerFeuille, effacer, OPENSSL_DISPONIBLE } from "./identite/pki-openssl";
import type { Autorite, Feuille } from "./identite/pki-openssl";

const NOM = "elpis-test.invalid";
const MARQUEUR = "MARQUEUR-DU-SERVEUR-DE-TEST-93f1";
const BON: ContexteEssai = { publicUrl: "https://elpis.exemple.lan", cookieSecure: true, adminsLocaux: 1 };
const VERS_BOUCLE = async (): Promise<{ motif: null; adresses: string[] }> => ({
  motif: null,
  adresses: ["127.0.0.1"],
});

interface Reponse {
  statut?: number;
  corps?: unknown;
  brut?: string;
  decalageSec?: number;
}

describe.skipIf(!OPENSSL_DISPONIBLE)("test d'un fournisseur : étapes", () => {
  let ca: Autorite;
  let autre: Autorite;
  let feuille: Feuille;
  let serveur: Server;
  let port = 0;
  let reponse: Reponse = {};
  let lignes: string[] = [];

  beforeAll(async () => {
    ca = creerAutorite("Test CA essai");
    autre = creerAutorite("Test CA essai autre");
    feuille = creerFeuille(ca, { noms: [NOM] });
    serveur = serveurHttps({ cert: feuille.cert, key: feuille.cle }, (_q, r) => {
      const entetes: Record<string, string> = {
        "content-type": "application/json",
        "x-secret": MARQUEUR,
        server: MARQUEUR,
        "set-cookie": `sid=${MARQUEUR}`,
      };
      if (reponse.decalageSec !== undefined)
        entetes["date"] = new Date(Date.now() + reponse.decalageSec * 1000).toUTCString();
      r.writeHead(reponse.statut ?? 200, entetes);
      r.end(reponse.brut ?? JSON.stringify(reponse.corps ?? {}));
    });
    await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", () => r()));
    port = (serveur.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => {
      serveur.closeAllConnections();
      serveur.close(() => r());
    });
    effacer(ca, autre);
  });
  beforeEach(() => {
    reponse = {};
    lignes = [];
    installerCrochetJournal((_n, m) => lignes.push(m));
  });
  afterEach(() => installerCrochetJournal(null));

  const issuer = (): string => `https://${NOM}:${port}/realms/x`;
  const origine = (): string => `https://${NOM}:${port}`;
  const bonneDecouverte = (): Record<string, unknown> => ({
    issuer: issuer(),
    authorization_endpoint: `${origine()}/auth`,
    token_endpoint: `${origine()}/token`,
    jwks_uri: `${origine()}/jwks`,
    marqueur: MARQUEUR,
  });
  const oidc = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    oidcValide({ issuer: issuer(), ca_pem: ca.cert, ...extra });
  const ldap = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ldapValide({ urls: [`ldaps://${NOM}:${port}`], ca_pem: ca.cert, ...extra });
  const tester = (r: unknown, c: ContexteEssai = BON, magasin: string[] = []): Promise<ResultatEssai> =>
    testerFournisseur(r, c, { sortant: { juger: VERS_BOUCLE, magasin } });
  const etape = (r: ResultatEssai, id: string): ResultatEssai["steps"][number] | undefined =>
    r.steps.find((s) => s.id === id);

  it("LDAP : réglages, prérequis, résolution, adresse, certificat ; jamais complet", async () => {
    const r = await tester(ldap());
    expect(r.steps.map((s) => [s.id, s.level])).toEqual([
      ["settings", "ok"],
      ["prerequisites", "ok"],
      ["resolve", "ok"],
      ["address", "ok"],
      ["tls", "ok"],
    ]);
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    const tls = etape(r, "tls");
    expect(tls?.target).toBe(`${NOM}:${port}`);
    expect(tls?.detail).toMatch(
      /TLSv1\.[23].*sujet elpis-test\.invalid.*émis par Test CA essai \d+.*jours restants/u,
    );
  });

  it("chaque adresse LDAP a ses étapes", async () => {
    const r = await tester(ldap({ urls: [`ldaps://${NOM}:${port}`, `ldaps://${NOM}:${port + 1}`] }));
    expect(r.steps.filter((s) => s.id === "tls").map((s) => [s.target, s.level])).toEqual([
      [`${NOM}:${port}`, "ok"],
      [`${NOM}:${port + 1}`, "fail"],
    ]);
    expect(r.ok).toBe(false);
  });

  it("réglages invalides : échec dit en clair, rien d'autre n'est tenté ; l'état du formulaire est toléré", async () => {
    const r = await tester({ ...ldap(), verify_tls: false });
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.id)).toEqual(["settings", "prerequisites"]);
    expect((await tester("pas un objet")).steps[0]?.level).toBe("fail");
    const forme = await tester({ ...ldap(), has_secret: true, tested: true, active: false, identities: 2 });
    expect(etape(forme, "settings")?.level).toBe("ok");
  });

  it("prérequis manquants : échec, sans effet sur les autres étapes", async () => {
    const r = await tester(ldap(), { publicUrl: "", cookieSecure: false, adminsLocaux: 0 });
    const p = etape(r, "prerequisites");
    expect(p?.level).toBe("fail");
    expect(p?.detail).toMatch(/adresse publique.*connexion sécurisée.*administrateur/u);
    expect(r.ok).toBe(false);
  });

  it("autorité inconnue : phrase utile à l'administrateur", async () => {
    const r = await tester(ldap({ ca_pem: autre.cert }));
    expect(etape(r, "tls")).toMatchObject({ level: "fail" });
    expect(etape(r, "tls")?.detail).toContain("collez l'autorité de certification de votre organisation");
    const sans = await tester(ldap({ ca_pem: "" }));
    expect(etape(sans, "tls")?.detail).toContain("Autorité de certification inconnue");
  });

  it("adresse refusée par le juge réel : étape adresse en échec, aucune connexion", async () => {
    const r = await testerFournisseur(ldap(), BON, { sortant: { resoudre: async () => ["127.0.0.1"] } });
    expect(etape(r, "address")).toMatchObject({ level: "fail" });
    expect(etape(r, "address")?.detail).toContain("127.0.0.1");
    expect(etape(r, "tls")).toBeUndefined();
    const nu = await testerFournisseur(ldap(), BON, {
      sortant: {
        resoudre: async () => {
          throw new Error("ENOTFOUND");
        },
      },
    });
    expect(etape(nu, "resolve")).toMatchObject({ level: "fail" });
    expect(etape(nu, "address")).toBeUndefined();
  });

  describe("découverte OIDC", () => {
    it("document conforme : découverte et horloge en règle", async () => {
      reponse = { corps: bonneDecouverte() };
      const r = await tester(oidc());
      expect(r.steps.map((s) => [s.id, s.level])).toEqual([
        ["settings", "ok"],
        ["prerequisites", "ok"],
        ["resolve", "ok"],
        ["address", "ok"],
        ["tls", "ok"],
        ["discovery", "ok"],
        ["clock", "ok"],
      ]);
      expect(r.complete).toBe(false);
    });

    it("émetteur différent d'un caractère : échec", async () => {
      reponse = { corps: { ...bonneDecouverte(), issuer: `${issuer()}x` } };
      expect(etape(await tester(oidc()), "discovery")).toMatchObject({ level: "fail" });
      reponse = { corps: { ...bonneDecouverte(), issuer: `${issuer()}/` } };
      expect(etape(await tester(oidc()), "discovery")).toMatchObject({ level: "fail" });
    });

    it("point de terminaison sur une autre origine, en http ou absent : échec", async () => {
      for (const ecart of [
        { token_endpoint: "https://autre.invalid/token" },
        { token_endpoint: `${origine()}:1/token`.replace(`:${port}:1`, `:${port + 1}`) },
        { jwks_uri: `http://${NOM}:${port}/jwks` },
        { authorization_endpoint: undefined },
        { jwks_uri: "pas une adresse" },
      ]) {
        reponse = { corps: { ...bonneDecouverte(), ...ecart } };
        expect(etape(await tester(oidc()), "discovery"), JSON.stringify(ecart)).toMatchObject({
          level: "fail",
        });
      }
    });

    it("réponse non JSON, tableau, statut différent de 200 : échec", async () => {
      for (const r of [
        { brut: "<html>nope</html>" },
        { brut: "[]" },
        { brut: "null" },
        { statut: 404, corps: bonneDecouverte() },
      ]) {
        reponse = r;
        expect(etape(await tester(oidc()), "discovery"), JSON.stringify(r)).toMatchObject({ level: "fail" });
      }
    });

    it("redirection : échec, jamais suivie", async () => {
      reponse = { statut: 302, corps: bonneDecouverte() };
      const r = await tester(oidc());
      expect(etape(r, "discovery")?.detail).toContain("redirection");
    });

    it("écart d'horloge : tolérance, moitié de tolérance, au-delà", async () => {
      reponse = { corps: bonneDecouverte(), decalageSec: 5 };
      expect(etape(await tester(oidc({ clock_skew_sec: 60 })), "clock")?.level).toBe("ok");
      reponse = { corps: bonneDecouverte(), decalageSec: 45 };
      expect(etape(await tester(oidc({ clock_skew_sec: 60 })), "clock")?.level).toBe("warn");
      reponse = { corps: bonneDecouverte(), decalageSec: -600 };
      const r = await tester(oidc({ clock_skew_sec: 60 }));
      expect(etape(r, "clock")?.level).toBe("fail");
      expect(etape(r, "clock")?.detail).toMatch(/Écart de -?\d+ s/u);
      expect(r.ok).toBe(false);
    });

    it("port fermé : découverte non tentée si le certificat échoue", async () => {
      const r = await tester(oidc({ ca_pem: autre.cert }));
      expect(etape(r, "tls")?.level).toBe("fail");
      expect(etape(r, "discovery")).toBeUndefined();
    });
  });

  describe("sortie : liste blanche", () => {
    it("aucun marqueur du serveur (corps, en-têtes, document) ne se retrouve dans les étapes ni dans le journal", async () => {
      const cas: Reponse[] = [
        { corps: bonneDecouverte() },
        { corps: { ...bonneDecouverte(), issuer: MARQUEUR } },
        { corps: { ...bonneDecouverte(), token_endpoint: `https://${MARQUEUR}.invalid/t` } },
        { brut: `${MARQUEUR} <html>` },
        { statut: 500, brut: MARQUEUR },
        { statut: 302, brut: MARQUEUR },
        { corps: bonneDecouverte(), decalageSec: 9999 },
      ];
      for (const c of cas) {
        reponse = c;
        const sortie = JSON.stringify([await tester(oidc()), await tester(ldap())]);
        expect(sortie, JSON.stringify(c)).not.toContain(MARQUEUR);
      }
      expect(lignes.join("\n")).not.toContain(MARQUEUR);
    });

    it("chaque détail est borné et sans caractère de contrôle", async () => {
      reponse = { corps: bonneDecouverte() };
      const r = await tester(oidc());
      for (const s of r.steps) {
        expect(s.detail.length).toBeLessThanOrEqual(300);
        expect(s.detail).not.toMatch(/\p{Cc}/u);
      }
    });
  });

  it("délai global : étape en échec, le test rend la main", async () => {
    const t0 = Date.now();
    const r = await testerFournisseur(ldap(), BON, {
      delaiGlobalMs: 50,
      sortant: {
        juger: async () => {
          await new Promise((res) => setTimeout(res, 400));
          return { motif: null, adresses: ["127.0.0.1"] };
        },
      },
    });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(etape(r, "timeout")).toMatchObject({ level: "fail" });
    expect(r.ok).toBe(false);
  });
});
