// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-correctifs.test.ts — la connexion SSO reste disponible pour tous (plafonds IPv6 au /64, par fournisseur, panne de découverte gardée, jetons rendus après une réussite), refuse un `azp` étranger, range la ligne de session avant l'audit de succès et n'en garde pas après fermeture, coupe sans révoquer les accès quand l'annuaire retire la personne du groupe (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { cleAdresse, cleAdresseExacte } from "@elpis/auth";
import { configurerCoffre } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightMyRequestResponse } from "fastify";

import { FabriqueConfigurations } from "../src/identite/oidc/configuration";
import {
  empreinte,
  empreinteAdresses,
  FLUX_PAR_FOURNISSEUR_MAX,
  FLUX_PAR_PREFIXE_MAX,
  noterSessionExterne,
} from "../src/identite/oidc/flux";
import { lignesAuditRecentes, lignesJournal } from "./aides";
import {
  adresseNeuve,
  COOKIE_LIAISON,
  ELPIS,
  HOTE_PUBLIC,
  ouvrirBancOidc,
  URL_PUBLIQUE,
} from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { MOTEURS } from "./identite/banc";
import { VERS_BOUCLE } from "./identite/oidc-factice";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

const SQL_FLUX =
  "INSERT INTO auth_flows(state_hash, provider_id, browser_hash, ip_hash, nonce, code_verifier, target, oauth_next, trial_admin, stage, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)";

function code(r: LightMyRequestResponse): string {
  return /auth_error=([a-z_]+)/u.exec(String(r.headers.location))?.[1] ?? `statut ${r.statusCode}`;
}

describe("clé d'adresse des plafonds", () => {
  it("IPv4 telle quelle, `::ffff:` ramenée à l'IPv4, préfixe /64 en IPv6", () => {
    expect(cleAdresse("10.1.2.3")).toBe("10.1.2.3");
    expect(cleAdresse("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(cleAdresse("::ffff:0a01:0203")).toBe("10.1.2.3");
    const a = cleAdresse("2001:db8:0:1::1");
    expect(cleAdresse("2001:db8:0:1:ffff:ffff:ffff:ffff")).toBe(a);
    expect(cleAdresse("2001:0db8:0000:0001:0:0:0:7")).toBe(a);
    expect(cleAdresse("2001:db8:0:2::1")).not.toBe(a);
    expect(cleAdresse("?")).toBe("?");
  });

  it("adresse exacte : IPv4 telle quelle, `::ffff:` ramenée, IPv6 en huit groupes complets distincts d'une adresse du même /64", () => {
    expect(cleAdresseExacte("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(cleAdresseExacte("2001:db8:0:1::1")).toBe("2001:db8:0:1:0:0:0:1");
    expect(cleAdresseExacte("2001:0db8:0000:0001:0:0:0:1")).toBe(cleAdresseExacte("2001:db8:0:1::1"));
    expect(cleAdresseExacte("2001:db8:0:1::2")).not.toBe(cleAdresseExacte("2001:db8:0:1::1"));
    expect(cleAdresseExacte("?")).toBe("?");
  });
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("correctifs du SSO OIDC (%s)", (moteur) => {
  let b: BancOidc;

  const lignes = (sql: string, p?: (string | number)[]): Promise<unknown[][]> => b.t.base.valeurs(sql, p);
  const decouvertes = (): number =>
    b.idp.traces.filter((t) => t.chemin.endsWith("openid-configuration")).length;
  const remplir = async (
    id: string,
    n: number,
    essai: number | null,
    ip: (i: number) => string = (i) => `ip${i}`,
  ): Promise<void> => {
    await b.t.base.runMany(
      SQL_FLUX,
      Array.from({ length: n }, (_v, i) => [
        `h-${id}-${essai}-${i}`,
        id,
        "b",
        ip(i),
        "n",
        "v",
        "app",
        null,
        essai,
        "auth",
        1,
        4_000_000_000,
      ]),
    );
  };

  beforeEach(async () => {
    lignesJournal.length = 0;
    b = await ouvrirBancOidc(moteur);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await b.fermer();
  });

  describe("disponibilité de la connexion pour tous", () => {
    it("25 départs d'une même adresse IPv6 : tous passent, 20 flux gardés ; 25 adresses d'un même /64 passent toutes ; un autre /64 reste servi", async () => {
      const statuts: number[] = [];
      for (let i = 1; i <= 25; i++)
        statuts.push((await b.demarrer({ adresse: "2001:db8:0:1::1" })).reponse.statusCode);
      expect(statuts.filter((s) => s === 200)).toHaveLength(25);
      expect(
        await b.t.base.valeurs("SELECT COUNT(*) FROM auth_flows WHERE ip_hash LIKE ?", [
          `${empreinteAdresses("2001:db8:0:1::1").slice(0, 64)}:%`,
        ]),
      ).toEqual([[20]]);
      for (let i = 1; i <= 25; i++)
        expect((await b.demarrer({ adresse: `2001:db8:0:2::${i.toString(16)}` })).reponse.statusCode).toBe(
          200,
        );
      expect((await b.demarrer({ adresse: "2001:db8:0:3::1" })).reponse.statusCode).toBe(200);
      expect((await b.demarrer({ adresse: "::ffff:10.9.9.9" })).reponse.statusCode).toBe(200);
    });

    it("600 adresses d'un même /64 : 500 flux au plus pour le préfixe, un autre /64 reste servi", async () => {
      const statuts: number[] = [];
      for (let i = 1; i <= 600; i++)
        statuts.push((await b.demarrer({ adresse: `2001:db8:0:4::${i.toString(16)}` })).reponse.statusCode);
      expect(statuts.filter((s) => s === 200)).toHaveLength(FLUX_PAR_PREFIXE_MAX);
      expect(new Set(statuts.slice(FLUX_PAR_PREFIXE_MAX))).toEqual(new Set([429]));
      expect((await b.demarrer({ adresse: "2001:db8:0:5::1" })).reponse.statusCode).toBe(200);
    });

    it("le seau de débit est celui de l'adresse exacte : 50 départs, puis refus pour elle seule", async () => {
      for (let i = 1; i <= 50; i++) {
        const r = await b.demarrer({ adresse: "2001:db8:0:6::1" });
        expect(r.reponse.statusCode, String(i)).toBe(200);
        await b.t.base.run("DELETE FROM auth_flows");
      }
      const r = await b.demarrer({ adresse: "2001:db8:0:6::1" });
      expect(r.reponse.statusCode).toBe(429);
      expect(r.reponse.headers["retry-after"]).not.toBe("60");
      expect((await b.demarrer({ adresse: "2001:db8:0:6::2" })).reponse.statusCode).toBe(200);
    });

    it("le seau du préfixe : 500 départs d'adresses différentes d'un /64, puis refus pour tout le préfixe", async () => {
      for (let i = 1; i <= 500; i++) {
        const r = await b.demarrer({ adresse: `2001:db8:0:7::${i.toString(16)}` });
        expect(r.reponse.statusCode, String(i)).toBe(200);
        await b.t.base.run("DELETE FROM auth_flows");
      }
      // Le seau se recharge d'un jeton toutes les trois secondes : sur un moteur lent, la boucle a pu en rendre un ou deux.
      let refuse = false;
      for (let i = 0; i < 20 && !refuse; i++) {
        const r = await b.demarrer({ adresse: `2001:db8:0:7::f${i.toString(16)}` });
        refuse = r.reponse.statusCode === 429;
        await b.t.base.run("DELETE FROM auth_flows");
      }
      expect(refuse).toBe(true);
      expect((await b.demarrer({ adresse: "2001:db8:0:8::1" })).reponse.statusCode).toBe(200);
    });

    it("plafond de flux PAR fournisseur : A saturé par un préfixe, B utilisable, un autre préfixe passe en évinçant le plus ancien du préfixe le plus représenté", async () => {
      await b.ajouter("autre");
      await remplir("sso", FLUX_PAR_FOURNISSEUR_MAX, null, (i) => `${empreinte("gros")}:${i}`);
      expect((await b.demarrer({ id: "autre" })).reponse.statusCode).toBe(200);
      const avant = await lignes(
        "SELECT state_hash FROM auth_flows WHERE provider_id='sso' AND created_at=1",
      );
      expect(avant).toHaveLength(FLUX_PAR_FOURNISSEUR_MAX);
      await b.t.base.run("UPDATE auth_flows SET created_at=2 WHERE state_hash=?", [`h-sso-null-7`]);
      expect((await b.demarrer({ id: "sso", adresse: "2001:db8:0:9::1" })).reponse.statusCode).toBe(200);
      expect(await lignes("SELECT COUNT(*) FROM auth_flows WHERE provider_id='sso'")).toEqual([
        [FLUX_PAR_FOURNISSEUR_MAX],
      ]);
      expect(await lignes("SELECT COUNT(*) FROM auth_flows WHERE state_hash='h-sso-null-7'")).toEqual([[1]]);
    });

    it("plafond de flux PAR fournisseur : un préfixe qui détient déjà plus de 20 flux est refusé, sans rien évincer", async () => {
      const adresse = "2001:db8:0:a::1";
      await remplir(
        "sso",
        FLUX_PAR_FOURNISSEUR_MAX,
        null,
        (i) => `${empreinteAdresses(adresse).slice(0, 64)}:${i}`,
      );
      expect((await b.demarrer({ id: "sso", adresse })).reponse.statusCode).toBe(429);
      expect(await lignes("SELECT COUNT(*) FROM auth_flows WHERE provider_id='sso'")).toEqual([
        [FLUX_PAR_FOURNISSEUR_MAX],
      ]);
    });

    it("les flux d'essai d'un administrateur ne comptent pas dans le plafond du fournisseur", async () => {
      await remplir("sso", FLUX_PAR_FOURNISSEUR_MAX, b.chef);
      expect((await b.demarrer()).reponse.statusCode).toBe(200);
    });

    it("fournisseur en panne : un seul appel sortant pour 20 départs, 503 ; relu après 60 secondes", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      b.idp.decouverte = { issuer: "https://autre.exemple.lan/realms/x" };
      const avant = decouvertes();
      for (let i = 0; i < 20; i++) expect((await b.demarrer()).reponse.statusCode).toBe(503);
      expect(decouvertes() - avant).toBe(1);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await b.demarrer()).reponse.statusCode).toBe(503);
      expect(decouvertes() - avant).toBe(2);
      b.idp.decouverte = {};
      vi.setSystemTime(Date.now() + 61_000);
      expect((await b.demarrer()).reponse.statusCode).toBe(200);
    });

    it("30 connexions réussies de suite depuis une même adresse passent toutes", async () => {
      const adresse = adresseNeuve();
      for (let i = 0; i < 30; i++) {
        const r = await b.connecter(ELPIS(`sub-${i}`), { adresse });
        expect(r.retour.statusCode, String(i)).toBe(200);
      }
      expect((await b.utilisateurs()).length).toBe(31);
    });

    it("les échecs restent limités : après 50 retours refusés, l'adresse est refusée", async () => {
      const adresse = adresseNeuve();
      const cookie = `${COOKIE_LIAISON}=${"a".repeat(43)}`;
      const url = `${URL_PUBLIQUE}/x?code=a&state=${"A".repeat(43)}`;
      const codes: string[] = [];
      for (let i = 0; i < 60; i++) codes.push(code(await b.retourner(url, { cookie, adresse })));
      expect(codes.slice(0, 50).every((c) => c === "expired")).toBe(true);
      expect(codes.slice(50).every((c) => c === "unavailable")).toBe(true);
    });

    it("un départ dont le flux n'aboutit jamais garde son jeton", async () => {
      const adresse = adresseNeuve();
      for (let i = 0; i < 50; i++) {
        expect((await b.demarrer({ adresse })).reponse.statusCode).toBe(200);
        await b.t.base.run("DELETE FROM auth_flows");
      }
      expect((await b.demarrer({ adresse })).reponse.statusCode).toBe(429);
    });
  });

  describe("jeton d'identité : azp", () => {
    it("`azp` d'un autre client refusé (`failed`, cause `azp_mismatch`), `azp` égal au client accepté", async () => {
      b.idp.pieges = { claims: { azp: "autre-client" } };
      const r = await b.connecter(ELPIS("sub-azp"));
      expect(code(r.retour)).toBe("failed");
      expect(
        lignesAuditRecentes({ actionPrefix: "auth.login.denied" }).some(
          (e) => (e["details"] as Record<string, unknown>)["reason"] === "azp_mismatch",
        ),
      ).toBe(true);
      expect(await b.utilisateurs()).toEqual(["chef"]);
      b.idp.pieges = { claims: { azp: b.idp.clientId } };
      expect((await b.connecter(ELPIS("sub-azp"))).retour.statusCode).toBe(200);
    });
  });

  describe("clés de signature", () => {
    it("le cache des clés suit l'empreinte des réglages : des réglages changés relisent les clés", async () => {
      const fabrique = new FabriqueConfigurations({
        base: b.t.base,
        maintenant: () => Date.now() / 1000,
        sortant: { juger: VERS_BOUCLE },
      });
      await fabrique.clesDeSignature(b.fournisseur, URL_PUBLIQUE, undefined);
      await fabrique.clesDeSignature(b.fournisseur, URL_PUBLIQUE, undefined);
      expect(b.idp.lecturesCles).toBe(1);
      await fabrique.clesDeSignature({ ...b.fournisseur, clock_skew_sec: 9 }, URL_PUBLIQUE, undefined);
      expect(b.idp.lecturesCles).toBe(2);
    });
  });

  describe("ligne de session du fournisseur", () => {
    it("écrite avant l'audit de succès : si l'écriture échoue, aucun `auth.login` de succès, aucune session", async () => {
      await b.t.base.run("ALTER TABLE auth_ext_sessions RENAME TO auth_ext_sessions_x");
      try {
        const r = await b.connecter(ELPIS("sub-ext"));
        expect(code(r.retour)).toBe("unavailable");
        expect(String(r.retour.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session=ey");
        const reussis = lignesAuditRecentes({ actionPrefix: "auth.login" }).filter(
          (e) => e["action"] === "auth.login",
        );
        expect(reussis).toEqual([]);
      } finally {
        await b.t.base.run("ALTER TABLE auth_ext_sessions_x RENAME TO auth_ext_sessions");
      }
    });

    it("le `sub` du jeton est rangé même si le sujet Elpis est une autre revendication ; le canal arrière s'en sert", async () => {
      await b.reglages({ subject_claim: "email", logout: { rp_initiated: true, backchannel: true } });
      const session = (await b.connecter(ELPIS("sub-jean"))).session;
      expect(await lignes("SELECT subject FROM auth_ext_sessions")).toEqual([["sub-jean"]]);
      expect(await lignes("SELECT subject FROM user_identities")).toEqual([["sub-jean@exemple.lan"]]);
      const jeton = await b.idp.jetonDeconnexion({ sub: "sub-jean" });
      const r = await b.main.inject({
        method: "POST",
        url: "/api/auth/oidc/sso/backchannel-logout",
        remoteAddress: adresseNeuve(),
        headers: { host: HOTE_PUBLIC, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ logout_token: jeton }).toString(),
      });
      expect(r.statusCode).toBe(200);
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
      const moi = await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: session } });
      expect(moi.json<{ logged_in?: boolean }>().logged_in).toBe(false);
    });

    it("jeton d'identité non chiffrable (clé du coffre indisponible) : avertissement sans le jeton", async () => {
      configurerCoffre({ systeme: "/nonexistent/a", repli: "/nonexistent/b" });
      const avis: string[] = [];
      await noterSessionExterne(b.t.base, {
        sid: "sid-1",
        uid: b.chef,
        providerId: "sso",
        idpSid: null,
        subject: "s",
        idToken: "JETON-SECRET",
        maintenant: 1,
        expire: 2,
        avertir: (m) => avis.push(m),
      });
      expect(avis).toHaveLength(1);
      expect(avis[0]).not.toContain("JETON-SECRET");
      expect(await lignes("SELECT id_token_enc FROM auth_ext_sessions")).toEqual([[null]]);
    });

    it("supprimée quand Elpis ferme la session : déconnexion, « tout déconnecter », coupure du compte", async () => {
      const entetes = { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" };
      const a = (await b.connecter(ELPIS("sub-a"))).session;
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[1]]);
      const sortie = await b.main.inject({
        method: "POST",
        url: "/api/logout-lite",
        headers: { ...entetes, cookie: a },
      });
      expect(sortie.statusCode).toBe(200);
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
      await b.connecter(ELPIS("sub-b"));
      await b.connecter(ELPIS("sub-b"));
      const { leverMinSession } = await import("@elpis/auth");
      const uid = Number((await lignes("SELECT id FROM users WHERE username='sub-b'"))[0]?.[0]);
      await leverMinSession(b.t.base, uid, Date.now() / 1000 + 1);
      expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
    });
  });

  describe("sorti du groupe au retour SSO", () => {
    it("sessions et lignes de session coupées tout de suite, jetons d'API et accès OAuth gardés", async () => {
      const a = (await b.connecter(ELPIS("sub-jean"))).session;
      const uid = Number((await lignes("SELECT id FROM users WHERE username='sub-jean'"))[0]?.[0]);
      await b.t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
        [uid, "api", "t", "h-sortie", "", "", 1],
      );
      const r = await b.connecter(ELPIS("sub-jean", { groups: ["autres"] }));
      expect(code(r.retour)).toBe("not_in_group");
      await vi.waitFor(async () =>
        expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions WHERE user_id=?", [uid])).toEqual([[0]]),
      );
      expect(await lignes("SELECT COUNT(*) FROM tool_tokens WHERE user_id=?", [uid])).toEqual([[1]]);
      const moi = await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: a } });
      expect(moi.json<{ logged_in?: boolean }>().logged_in).toBe(false);
    });
  });
});
