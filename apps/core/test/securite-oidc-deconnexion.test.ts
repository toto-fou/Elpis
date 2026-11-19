// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-deconnexion.test.ts — la déconnexion par le fournisseur OIDC ne ferme que ses propres sessions et seulement sur un jeton signé conforme (rien du jeton ne sort), et celle d'Elpis réussit toujours sans appel sortant, avec une adresse de fin de session limitée à l'origine de l'émetteur (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { schemaReponseDeconnexion } from "@elpis/contracts";
import { cheminSansCookie } from "../../../packages/auth/src/csrf";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adresseDeFinDeSession, RefusAgreges } from "../src/identite/oidc/deconnexion";
import { FabriqueConfigurations } from "../src/identite/oidc/configuration";
import { lireMetadonnees } from "../src/identite/oidc/metadonnees";
import { maintenirDecouvertesChaudes, rechaufferDecouvertes } from "../src/identite/oidc/rechauffement";
import type { DependancesRechauffement } from "../src/identite/oidc/rechauffement";
import { journalMuet, lignesAuditRecentes, lignesJournal } from "./aides";
import {
  adresseNeuve,
  cookies,
  ELPIS,
  HOTE_PUBLIC,
  ouvrirBancOidc,
  URL_PUBLIQUE,
} from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { MOTEURS } from "./identite/banc";
import { OidcFactice, VERS_BOUCLE } from "./identite/oidc-factice";
import type { PiegesJeton } from "./identite/oidc-factice";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

const REGLAGE = { logout: { rp_initiated: true, backchannel: true } };
const MARQUEUR = "MARQUEUR-DU-JETON-DE-DECONNEXION";
const maintenant = (): number => Math.floor(Date.now() / 1000);

describe("découverte : points de fin de session", () => {
  const doc = (extra: Record<string, unknown>): Record<string, unknown> => ({
    issuer: "https://idp.exemple.lan/realms/elpis",
    authorization_endpoint: "https://idp.exemple.lan/auth",
    token_endpoint: "https://idp.exemple.lan/token",
    jwks_uri: "https://idp.exemple.lan/certs",
    ...extra,
  });
  const lire = (extra: Record<string, unknown>): Record<string, unknown> => {
    const v = lireMetadonnees(doc(extra), "https://idp.exemple.lan/realms/elpis");
    if (!v.ok) throw new Error(v.raison);
    return v.metadonnees as unknown as Record<string, unknown>;
  };

  it("`end_session_endpoint` gardé seulement en https sur l'origine de l'émetteur, sinon ignoré sans refuser la découverte", () => {
    expect(lire({ end_session_endpoint: "https://idp.exemple.lan/logout" })["end_session_endpoint"]).toBe(
      "https://idp.exemple.lan/logout",
    );
    for (const v of [
      "http://idp.exemple.lan/logout",
      "https://autre.exemple.lan/logout",
      "https://idp.exemple.lan:8443/logout",
      "https://u:p@idp.exemple.lan/logout",
      "https://idp.exemple.lan/logout#x",
      5,
      null,
    ])
      expect(lire({ end_session_endpoint: v })["end_session_endpoint"], String(v)).toBeUndefined();
  });

  it("`backchannel_logout_supported` gardé seulement s'il est booléen", () => {
    expect(lire({ backchannel_logout_supported: true })["backchannel_logout_supported"]).toBe(true);
    expect(lire({ backchannel_logout_supported: "oui" })["backchannel_logout_supported"]).toBeUndefined();
  });
});

describe("journal agrégé des refus", () => {
  it("une seule ligne par raison et par minute, avec le nombre", () => {
    vi.useFakeTimers();
    try {
      const lignes: string[] = [];
      const a = new RefusAgreges((raison, n) => lignes.push(`${raison}:${n}`));
      for (let i = 0; i < 30; i++) a.noter("malformed");
      a.noter("bad_alg");
      expect(lignes).toEqual([]);
      vi.advanceTimersByTime(60_000);
      expect(lignes.sort()).toEqual(["bad_alg:1", "malformed:30"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("garde inter-site", () => {
  it("la route du canal arrière n'est pas une route qui ouvre une session : aucun contrôle sans cookie", () => {
    expect(cheminSansCookie("/api/auth/oidc/sso/backchannel-logout")).toBe(false);
    expect(cheminSansCookie("/api/auth/oidc/sso/start")).toBe(true);
    expect(cheminSansCookie("/api/login-lite")).toBe(true);
  });
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("déconnexion OIDC (%s)", (moteur) => {
  let b: BancOidc;

  const ouvrir = async (o: Parameters<typeof ouvrirBancOidc>[1] = {}): Promise<void> => {
    await b?.fermer().catch(() => undefined);
    b = await ouvrirBancOidc(moteur, { ...o, extra: { ...REGLAGE, ...o.extra } });
  };
  const vivante = async (cookie: string): Promise<boolean> =>
    (await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie } })).json<{
      logged_in?: boolean;
    }>().logged_in === true;
  const lignes = (sql: string): Promise<unknown[][]> => b.t.base.valeurs(sql);
  const connecter = async (sub: string, sid: string): Promise<string> =>
    (await b.connecter(ELPIS(sub, { sid }))).session;
  const poster = (
    jeton: string,
    o: {
      id?: string;
      corps?: string;
      type?: string;
      entetes?: Record<string, string>;
      adresse?: string;
    } = {},
  ): Promise<LightMyRequestResponse> =>
    b.main.inject({
      method: "POST",
      url: `/api/auth/oidc/${o.id ?? "sso"}/backchannel-logout`,
      remoteAddress: o.adresse ?? adresseNeuve(),
      headers: {
        host: HOTE_PUBLIC,
        "content-type": o.type ?? "application/x-www-form-urlencoded",
        ...o.entetes,
      },
      payload: o.corps ?? new URLSearchParams({ logout_token: jeton }).toString(),
    });
  const refuse = async (jeton: string, raison?: string): Promise<void> => {
    const r = await poster(jeton);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.body).toBe("");
    expect(r.headers["cache-control"]).toBe("no-store");
    if (raison !== undefined) {
      const denies = lignesAuditRecentes({ actionPrefix: "auth.oidc.backchannel_logout.denied" });
      expect(denies[0]?.["details"]).toMatchObject({ provider_id: "sso", reason: raison });
    }
  };

  const ouverts: AbortController[] = [];
  /** Flux `/api/system-events` ouverts avec ces cookies ; `fermes` dit lesquels ont reçu `session_expired`. */
  const ouvrirFlux = async (...cookiesDeSession: string[]): Promise<{ fermes(): Promise<boolean[]> }> => {
    const adresse = await b.main.listen({ port: 0, host: "127.0.0.1" });
    const recus = cookiesDeSession.map(() => ({ texte: "" }));
    await Promise.all(
      cookiesDeSession.map(async (cookie, i) => {
        const stop = new AbortController();
        ouverts.push(stop);
        const rep = await fetch(`${adresse}/api/system-events`, {
          headers: { host: HOTE_PUBLIC, cookie },
          signal: stop.signal,
        });
        expect(rep.status).toBe(200);
        void (async () => {
          try {
            for await (const morceau of rep.body as unknown as AsyncIterable<Uint8Array>)
              (recus[i] as { texte: string }).texte += Buffer.from(morceau).toString();
          } catch {
            // flux interrompu par le test
          }
        })();
      }),
    );
    return {
      fermes: async () => {
        await new Promise((r) => setTimeout(r, 300));
        return recus.map((r) => r.texte.includes("session_expired"));
      },
    };
  };

  beforeEach(async () => {
    lignesJournal.length = 0;
    await ouvrir();
  });
  afterEach(async () => {
    for (const c of ouverts.splice(0)) c.abort();
    vi.useRealTimers();
    await b.fermer();
  });

  describe("jeton valide", () => {
    it("`sid` : cette session meurt, une autre du même compte vit, la ligne est supprimée, audit sans jeton", async () => {
      const a = await connecter("sub-jean", "idp-1");
      const autre = await connecter("sub-jean", "idp-2");
      expect(await lignes("SELECT idp_sid FROM auth_ext_sessions ORDER BY idp_sid")).toEqual([
        ["idp-1"],
        ["idp-2"],
      ]);
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-1" });
      const r = await poster(jeton);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).toBe("");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(await vivante(a)).toBe(false);
      expect(await vivante(autre)).toBe(true);
      expect(await lignes("SELECT idp_sid FROM auth_ext_sessions")).toEqual([["idp-2"]]);
      expect(await lignes("SELECT COUNT(*) FROM revoked_sessions")).toEqual([[1]]);
      const ev = lignesAuditRecentes({ actionPrefix: "auth.oidc.backchannel_logout" }).find(
        (e) => e["action"] === "auth.oidc.backchannel_logout",
      );
      expect(ev?.["details"]).toEqual({ provider_id: "sso", sessions: 1, by: "sid" });
      expect(JSON.stringify(lignesAuditRecentes({ limit: 200 })) + lignesJournal.join("\n")).not.toContain(
        jeton,
      );
    });

    it("`sub` seul : toutes les sessions du compte ouvertes par ce fournisseur meurent, pas celles d'un autre compte", async () => {
      const a = await connecter("sub-jean", "idp-1");
      const aa = await connecter("sub-jean", "idp-2");
      const luc = await connecter("sub-luc", "idp-3");
      const r = await poster(await b.idp.jetonDeconnexion({ sub: "sub-jean" }));
      expect(r.statusCode).toBe(200);
      expect([await vivante(a), await vivante(aa), await vivante(luc)]).toEqual([false, false, true]);
      const ev = lignesAuditRecentes({ actionPrefix: "auth.oidc.backchannel_logout" }).find(
        (e) => e["action"] === "auth.oidc.backchannel_logout",
      );
      expect(ev?.["details"]).toEqual({ provider_id: "sso", sessions: 2, by: "sub" });
    });

    it("aucune session correspondante : 200 quand même", async () => {
      const a = await connecter("sub-jean", "idp-1");
      expect((await poster(await b.idp.jetonDeconnexion({ sid: "inconnu" }))).statusCode).toBe(200);
      expect((await poster(await b.idp.jetonDeconnexion({ sub: "personne" }))).statusCode).toBe(200);
      expect(await vivante(a)).toBe(true);
    });

    it("jamais la session d'un autre fournisseur ni celle d'un compte local", async () => {
      await b.ajouter("autre", REGLAGE);
      const sso = await connecter("sub-jean", "idp-1");
      const dep = await b.demarrer({ id: "autre" });
      const { retour } = b.idp.autoriser(dep.url ?? "", ELPIS("sub-paul", { sid: "idp-1" }));
      const ret = await b.retourner(retour, { id: "autre", cookie: dep.cookie });
      const autre = cookies(ret, dep.cookie);
      expect(await vivante(autre)).toBe(true);
      const local = await b.main.inject({
        method: "POST",
        url: "/api/login-lite",
        remoteAddress: adresseNeuve(),
        headers: { host: HOTE_PUBLIC },
        payload: { username: "chef", password: "mdp-chef-1" },
      });
      const cookieLocal = cookies(local);
      expect(await vivante(cookieLocal)).toBe(true);
      for (const jeton of [
        await b.idp.jetonDeconnexion({ sid: "idp-1" }),
        await b.idp.jetonDeconnexion({ sub: "sub-jean" }),
        await b.idp.jetonDeconnexion({ sub: "sub-paul" }),
        await b.idp.jetonDeconnexion({ sid: "idp-1", sub: "chef" }),
        await b.idp.jetonDeconnexion({ sub: "chef" }),
      ])
        expect((await poster(jeton)).statusCode).toBe(200);
      expect(await vivante(sso)).toBe(false);
      expect(await vivante(autre)).toBe(true);
      expect(await vivante(cookieLocal)).toBe(true);
      expect(await lignes("SELECT provider_id FROM auth_ext_sessions")).toEqual([["autre"]]);
    });

    it("un jeton déjà appliqué (`jti`) rejoué est reçu sans effet : la session ouverte depuis ne meurt pas", async () => {
      await connecter("sub-jean", "idp-1");
      const jeton = await b.idp.jetonDeconnexion({ sub: "sub-jean" });
      expect((await poster(jeton)).statusCode).toBe(200);
      const neuve = await connecter("sub-jean", "idp-9");
      expect((await poster(jeton)).statusCode).toBe(200);
      expect(await vivante(neuve)).toBe(true);
    });

    it("une erreur interne ne consomme pas le `jti` : le fournisseur peut réessayer", async () => {
      const a = await connecter("sub-jean", "idp-1");
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-1" });
      await b.t.base.run("ALTER TABLE auth_ext_sessions RENAME TO auth_ext_sessions_x");
      try {
        expect((await poster(jeton)).statusCode).toBe(500);
      } finally {
        await b.t.base.run("ALTER TABLE auth_ext_sessions_x RENAME TO auth_ext_sessions");
      }
      expect(await vivante(a)).toBe(true);
      expect((await poster(jeton)).statusCode).toBe(200);
      expect(await vivante(a)).toBe(false);
    });

    it("fermer une session ne ferme que ses flux : par `sid`, un flux d'une autre session du compte reste ouvert", async () => {
      const a = await connecter("sub-jean", "idp-1");
      const autre = await connecter("sub-jean", "idp-2");
      const evenements = await ouvrirFlux(a, autre);
      expect((await poster(await b.idp.jetonDeconnexion({ sid: "idp-1" }))).statusCode).toBe(200);
      expect(await evenements.fermes()).toEqual([true, false]);
      expect((await poster(await b.idp.jetonDeconnexion({ sub: "sub-jean" }))).statusCode).toBe(200);
      expect(await evenements.fermes()).toEqual([true, true]);
    });

    it("clé de signature tournée : relue au plus une fois par minute", async () => {
      const a = await connecter("sub-jean", "idp-1");
      await b.idp.rotation();
      const lues = b.idp.lecturesCles;
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-1" });
      await refuse(jeton, "no_key");
      await refuse(jeton, "no_key");
      expect(b.idp.lecturesCles).toBe(lues);
      expect(await vivante(a)).toBe(true);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 61_000);
      const r = await poster(await b.idp.jetonDeconnexion({ sid: "idp-1" }));
      expect(r.statusCode, r.body).toBe(200);
      expect(b.idp.lecturesCles).toBe(lues + 1);
      expect(await vivante(a)).toBe(false);
    });
  });

  describe("jeton refusé : 400 sans corps, aucune session fermée", () => {
    let a: string;
    beforeEach(async () => {
      a = await connecter("sub-jean", "idp-1");
    });
    afterEach(async () => {
      expect(await vivante(a)).toBe(true);
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[1]]);
    });
    const piege = (p: PiegesJeton): Promise<string> => b.idp.jetonDeconnexion({ sid: "idp-1" }, p);

    it("signature fausse", async () => refuse(await piege({ signerAvecAutreCle: true }), "bad_signature"));
    it("`alg` none", async () => refuse(await piege({ alg: "none" }), "bad_alg"));
    it("HS256 signé avec le secret client", async () => refuse(await piege({ alg: "HS256" }), "bad_alg"));
    it("émetteur faux", async () =>
      refuse(await piege({ claims: { iss: "https://autre.exemple.lan" } }), "bad_issuer"));
    it("public faux", async () => refuse(await piege({ claims: { aud: "autre-client" } }), "bad_audience"));
    it("événement absent", async () => refuse(await piege({ sans: ["events"] }), "no_event"));
    it("événement d'un autre type", async () =>
      refuse(await piege({ claims: { events: { "http://autre/evt": {} } } }), "no_event"));
    it("`nonce` présent", async () => refuse(await piege({ claims: { nonce: "n" } }), "nonce_present"));
    it("`iat` trop vieux", async () =>
      refuse(await piege({ claims: { iat: maintenant() - 700 } }), "iat_invalid"));
    it("`iat` dans le futur", async () =>
      refuse(await piege({ claims: { iat: maintenant() + 300 } }), "iat_invalid"));
    it("`jti` absent", async () => refuse(await piege({ sans: ["jti"] }), "jti_missing"));
    it("`iat` absent", async () => refuse(await piege({ sans: ["iat"] }), "iat_missing"));
    it("`exp` dépassé", async () => refuse(await piege({ claims: { exp: maintenant() - 300 } }), "expired"));
    it("ni `sid` ni `sub`", async () =>
      refuse(await b.idp.jetonDeconnexion({}, { claims: { x: 1 } }), "no_subject"));
    it("`sid` d'un autre type", async () => refuse(await piege({ claims: { sid: 5 } }), "bad_claim"));
    it("clé inconnue (`kid` absent des clés publiées)", async () =>
      refuse(await piege({ kid: "inconnue" }), "no_key"));
    it("jeton d'identité rejoué (`nonce`, pas d'événement)", async () => {
      const identite = b.idp.emis.at(-1) ?? "";
      expect(identite.split(".")).toHaveLength(3);
      await refuse(identite);
    });
    it("jeton d'identité avec un événement ajouté mais un `nonce`", async () => {
      const code = await b.idp.jetonDeconnexion(
        { sid: "idp-1" },
        {
          claims: {
            nonce: "n",
            sub: "sub-jean",
            events: { "http://schemas.openid.net/event/backchannel-logout": {} },
          },
        },
      );
      await refuse(code, "nonce_present");
    });
    it("jeton d'un autre fournisseur (autre émetteur, autres clés)", async () => {
      const autre = await OidcFactice.demarrer();
      try {
        await refuse(await autre.jetonDeconnexion({ sid: "idp-1" }), "bad_signature");
        await refuse(
          await autre.jetonDeconnexion({ sid: "idp-1" }, { claims: { iss: b.idp.issuer } }),
          "bad_signature",
        );
      } finally {
        await autre.fermer();
      }
    });
    it("jeton mal formé", async () => {
      for (const j of ["", "abc", "a.b.c", `${"a".repeat(50)}.${"b".repeat(50)}.`]) await refuse(j);
    });
    it("corps : type, champ absent, champ en double, jeton hors du corps", async () => {
      const bon = await b.idp.jetonDeconnexion({ sid: "idp-1" });
      for (const o of [
        { type: "application/json", corps: JSON.stringify({ logout_token: bon }) },
        { type: "text/plain", corps: `logout_token=${bon}` },
        { corps: "autre=1" },
        { corps: `logout_token=${bon}&logout_token=${bon}` },
      ]) {
        const r = await poster(bon, o);
        expect(r.statusCode, JSON.stringify(o)).toBe(400);
        expect(r.body).toBe("");
      }
      const requete = await b.main.inject({
        method: "POST",
        url: `/api/auth/oidc/sso/backchannel-logout?logout_token=${bon}`,
        remoteAddress: adresseNeuve(),
        headers: { host: HOTE_PUBLIC, "content-type": "application/x-www-form-urlencoded" },
        payload: "",
      });
      expect(requete.statusCode).toBe(400);
    });
    it("corps de plus de 16 Kio", async () => {
      const r = await poster("", { corps: `logout_token=${"a".repeat(17 * 1024)}` });
      expect(r.statusCode).toBe(413);
      expect(r.body).not.toContain("aaaa");
    });

    it("rien du jeton ni de sa signature n'atteint la réponse, le journal ou l'audit", async () => {
      const jeton = await piege({ signerAvecAutreCle: true, claims: { marqueur: MARQUEUR } });
      const r = await poster(jeton);
      expect(r.statusCode).toBe(400);
      const [entete, charge, signature] = jeton.split(".");
      const tout =
        JSON.stringify(r.headers) +
        r.body +
        lignesJournal.join("\n") +
        JSON.stringify(lignesAuditRecentes({ limit: 500 }));
      for (const m of [jeton, entete, charge, signature, MARQUEUR])
        expect(tout, String(m).slice(0, 12)).not.toContain(String(m));
    });
  });

  describe("fournisseur et débit", () => {
    it("404 : fournisseur inconnu, éteint, ou sans canal arrière", async () => {
      const jeton = await b.idp.jetonDeconnexion({ sid: "idp-1" });
      expect((await poster(jeton, { id: "inconnu" })).statusCode).toBe(404);
      await b.reglages({ logout: { rp_initiated: true, backchannel: false } });
      expect((await poster(jeton)).statusCode).toBe(404);
      await b.reglages({ logout: { rp_initiated: true, backchannel: true }, enabled: false });
      expect((await poster(jeton)).statusCode).toBe(404);
    });

    it("la console ne monte pas la route", async () => {
      const r = await b.console.inject({
        method: "POST",
        url: "/api/auth/oidc/sso/backchannel-logout",
        headers: { host: HOTE_PUBLIC, "content-type": "application/x-www-form-urlencoded" },
        payload: "logout_token=x",
      });
      expect(r.statusCode).toBe(404);
    });

    it("20 refus par minute et par adresse, puis 429 pour cette adresse seulement ; relâchée après une minute", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 22; i++) codes.push((await poster("x", { adresse: "198.51.100.7" })).statusCode);
      expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
      expect(codes.slice(20)).toEqual([429, 429]);
      expect((await poster("x")).statusCode).toBe(400);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 61_000);
      expect((await poster("x", { adresse: "198.51.100.7" })).statusCode).toBe(400);
    });

    it("200 requêtes invalides d'une adresse n'empêchent pas un jeton valide d'une autre : 200 et la session meurt", async () => {
      const a = await connecter("sub-jean", "idp-1");
      for (let i = 0; i < 200; i++) await poster("x", { adresse: "198.51.100.8" });
      const r = await poster(await b.idp.jetonDeconnexion({ sid: "idp-1" }));
      expect(r.statusCode, r.body).toBe(200);
      expect(await vivante(a)).toBe(false);
    });

    it("50 refus : pas une ligne de journal par refus (agrégation par raison et par minute)", async () => {
      lignesJournal.length = 0;
      for (let i = 0; i < 50; i++) await poster("x", { adresse: "198.51.100.9" });
      expect(lignesJournal.filter((l) => l.includes("déconnexion SSO")).length).toBeLessThan(5);
    });

    it("clés illisibles : une seule lecture sortante pour 20 jetons, relue après une minute", async () => {
      await connecter("sub-jean", "idp-1");
      await b.idp.rotation();
      b.idp.jeuDeCles = { keys: "x" };
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 301_000);
      const lues = b.idp.lecturesCles;
      for (let i = 0; i < 20; i++)
        expect((await poster(await b.idp.jetonDeconnexion({ sid: "idp-1" }))).statusCode).toBe(400);
      expect(b.idp.lecturesCles - lues).toBe(1);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await poster(await b.idp.jetonDeconnexion({ sid: "idp-1" }))).statusCode).toBe(400);
      expect(b.idp.lecturesCles - lues).toBe(2);
    });

    it("sans cookie, la garde inter-site laisse passer ; avec un cookie de session cross-site, elle refuse comme ailleurs", async () => {
      const jeton = await b.idp.jetonDeconnexion({ sid: "inconnu" });
      expect((await poster(jeton, { entetes: { "sec-fetch-site": "cross-site" } })).statusCode).toBe(200);
      expect((await poster(jeton)).statusCode).toBe(200);
      const a = await connecter("sub-jean", "idp-1");
      const avecCookie = await poster(jeton, { entetes: { cookie: a, "sec-fetch-site": "cross-site" } });
      expect(avecCookie.statusCode).toBe(403);
      const logout = await b.main.inject({
        method: "POST",
        url: "/api/logout-lite",
        headers: { host: HOTE_PUBLIC, cookie: a, "sec-fetch-site": "cross-site" },
      });
      expect(logout.statusCode).toBe(403);
      expect(await vivante(a)).toBe(true);
    });
  });

  describe("déconnexion à l'initiative d'Elpis", () => {
    const deconnecter = (cookie: string, app: "main" | "console" = "main"): Promise<LightMyRequestResponse> =>
      b[app].inject({
        method: "POST",
        url: "/api/logout-lite",
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie },
      });

    it("`logout_url` : adresse de l'émetteur avec `client_id`, retour vers `/` et indice d'identité, sans appel sortant", async () => {
      const a = await connecter("sub-jean", "idp-1");
      const avant = b.idp.traces.length;
      const r = await deconnecter(a);
      expect(r.statusCode, r.body).toBe(200);
      const corps = schemaReponseDeconnexion.parse(r.json());
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(b.idp.traces.length).toBe(avant);
      const u = new URL(corps.logout_url ?? "");
      expect(u.origin).toBe(b.idp.origine);
      expect(u.pathname).toBe("/realms/elpis/logout");
      expect(Object.fromEntries(u.searchParams)).toEqual({
        client_id: "elpis",
        post_logout_redirect_uri: `${URL_PUBLIQUE}/`,
        id_token_hint: b.idp.emis.at(-1),
      });
      expect(String(r.headers["set-cookie"])).toContain("mcpwebui_session=");
      expect(await vivante(a)).toBe(false);
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
      const salle = JSON.stringify(lignesAuditRecentes({ limit: 200 })) + lignesJournal.join("\n");
      expect(salle).not.toContain(String(b.idp.emis.at(-1)));
    });

    it("sans jeton d'identité gardé : adresse sans `id_token_hint`", async () => {
      const a = await connecter("sub-jean", "idp-1");
      await b.t.base.run("UPDATE auth_ext_sessions SET id_token_enc=NULL");
      const u = new URL((await deconnecter(a)).json<{ logout_url: string }>().logout_url);
      expect(u.searchParams.has("id_token_hint")).toBe(false);
      expect(u.searchParams.get("client_id")).toBe("elpis");
    });

    it("pas de `logout_url` si le fournisseur ne le demande pas ; la ligne de session est supprimée quand même", async () => {
      await b.reglages({ logout: { rp_initiated: false, backchannel: true } });
      const a = await connecter("sub-jean", "idp-1");
      const r = await deconnecter(a);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true });
      expect(await vivante(a)).toBe(false);
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
    });

    it("pas de `logout_url` si le fournisseur n'est plus actif", async () => {
      const a = await connecter("sub-jean", "idp-1");
      await b.reglages({ enabled: false });
      const r = await deconnecter(a);
      expect(r.json()).toEqual({ ok: true });
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
    });

    it("pas de `logout_url` sans découverte gardée par ce process, mais la déconnexion réussit", async () => {
      const a = await connecter("sub-jean", "idp-1");
      const avant = b.idp.traces.length;
      const r = await deconnecter(a, "console");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true });
      expect(b.idp.traces.length).toBe(avant);
      expect(await vivante(a)).toBe(false);
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
    });

    describe("après un redémarrage : découverte tenue chaude", () => {
      const neuve = (): FabriqueConfigurations =>
        new FabriqueConfigurations({
          base: b.t.base,
          maintenant: () => Date.now() / 1000,
          sortant: { juger: VERS_BOUCLE },
        });
      const dependances = (configurations: FabriqueConfigurations): DependancesRechauffement => ({
        base: b.t.base,
        configurations,
        cookieSecure: () => true,
        journal: journalMuet,
      });
      const fin = (configurations: FabriqueConfigurations, sid: string): Promise<string | null> =>
        adresseDeFinDeSession({ base: b.t.base, configurations, cookieSecure: () => true }, sid);
      const sidLocal = async (): Promise<string> =>
        String((await lignes("SELECT sid FROM auth_ext_sessions"))[0]?.[0]);

      it("fabrique neuve : pas d'adresse ; après le réchauffement : adresse rendue, sans appel sortant au moment de la déconnexion", async () => {
        await connecter("sub-jean", "idp-1");
        const froide = neuve();
        const sid = await sidLocal();
        expect(await fin(froide, sid)).toBeNull();
        await connecter("sub-jean", "idp-2");
        const chaude = neuve();
        await rechaufferDecouvertes(dependances(chaude));
        const avant = b.idp.traces.length;
        const url = await fin(chaude, await sidLocal());
        expect(b.idp.traces.length).toBe(avant);
        expect(new URL(url ?? "").origin).toBe(b.idp.origine);
      });

      it("fournisseur en panne : réchauffement sans erreur, pas d'adresse, déconnexion réussie, un seul appel de découverte", async () => {
        const a = await connecter("sub-jean", "idp-1");
        b.idp.decouverte = { issuer: "https://autre.exemple.lan/realms/x" };
        const chaude = neuve();
        const lues = (): number =>
          b.idp.traces.filter((t) => t.chemin.endsWith("openid-configuration")).length;
        const avant = lues();
        await rechaufferDecouvertes(dependances(chaude));
        await rechaufferDecouvertes(dependances(chaude));
        expect(lues() - avant).toBe(1);
        expect(await fin(chaude, await sidLocal())).toBeNull();
        expect((await deconnecter(a)).statusCode).toBe(200);
        expect(await vivante(a)).toBe(false);
      });

      it("fournisseur sans déconnexion initiée par Elpis : rien n'est lu", async () => {
        await b.reglages({ logout: { rp_initiated: false, backchannel: true } });
        const avant = b.idp.traces.length;
        await rechaufferDecouvertes(dependances(neuve()));
        expect(b.idp.traces.length).toBe(avant);
      });

      it("la boucle fait une passe au démarrage et s'arrête au signal", async () => {
        const arret = new AbortController();
        const chaude = neuve();
        const fini = maintenirDecouvertesChaudes(dependances(chaude), arret.signal, 3600);
        await vi.waitFor(() => expect(chaude.metadonneesGardees(b.fournisseur, URL_PUBLIQUE)).not.toBeNull());
        arret.abort();
        await fini;
      });
    });

    it("fournisseur en panne : la déconnexion locale réussit, sans appel", async () => {
      const a = await connecter("sub-jean", "idp-1");
      b.idp.muet = true;
      for (const s of (b.idp as unknown as { sockets: Set<{ destroy(): void }> }).sockets) s.destroy();
      const r = await deconnecter(a);
      expect(r.statusCode).toBe(200);
      expect(await vivante(a)).toBe(false);
    });

    it("session locale : réponse inchangée", async () => {
      const local = await b.main.inject({
        method: "POST",
        url: "/api/login-lite",
        remoteAddress: adresseNeuve(),
        headers: { host: HOTE_PUBLIC },
        payload: { username: "chef", password: "mdp-chef-1" },
      });
      const r = await deconnecter(cookies(local));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true });
    });

    it.each([
      ["autre origine", "https://autre.exemple.lan/logout"],
      ["http", "http://elpis-test.invalid/logout"],
    ])("jamais d'adresse hors de l'origine de l'émetteur (%s)", async (_nom, adresse) => {
      await ouvrir({ idp: { decouverte: { end_session_endpoint: adresse } } });
      const a = await connecter("sub-jean", "idp-1");
      const r = await deconnecter(a);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true });
    });

    it("annonce de fin de session absente : pas de `logout_url`", async () => {
      await ouvrir({ idp: { decouverte: { end_session_endpoint: undefined } } });
      const a = await connecter("sub-jean", "idp-1");
      expect((await deconnecter(a)).json()).toEqual({ ok: true });
    });
  });
});
