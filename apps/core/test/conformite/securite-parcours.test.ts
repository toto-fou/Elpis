// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/securite-parcours.test.ts — le parcours d'authentification suit ASVS 5.0 V16 et la RFC 9700 : en-têtes des réponses du parcours, demandes inter-sites refusées, événements de sécurité journalisés avec qui, quand et d'où, aucun secret dans le journal ni dans l'audit (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enregistrerSecret, enregistrerTestReussi } from "../../src/identite/fournisseurs";
import { lignesAuditRecentes, lignesJournal } from "../aides";
import { MOTEURS } from "../identite/banc";
import { cookies, ELPIS, HOTE_PUBLIC, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import type { LightMyRequestResponse } from "fastify";

const SECRET_LOCAL = "mdp-chef-1";
const MAUVAIS = "MAUVAIS-MOT-DE-PASSE-MARQUEUR";

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)(
  "parcours d'authentification : référentiels (%s)",
  (moteur) => {
    let b: BancOidc;
    let rang = 0;
    const adresse = (): string => `10.88.${(rang += 1) >> 8}.${rang & 255}`;

    const loginLocal = (mot: string, extra: Record<string, string> = {}): Promise<LightMyRequestResponse> =>
      b.main.inject({
        method: "POST",
        url: "/api/login-lite",
        remoteAddress: adresse(),
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", ...extra },
        payload: { username: "chef", password: mot },
      });

    beforeEach(async () => {
      lignesJournal.length = 0;
      b = await ouvrirBancOidc(moteur);
    });
    afterEach(async () => {
      await b.fermer();
    });

    it("ASVS 5.0 V3.4.4 et V3.4.5 : les réponses du parcours SSO portent nosniff et Referrer-Policy no-referrer, sans mise en cache", async () => {
      const { depart, retour } = await b.connecter(ELPIS("sub-entetes"));
      const refus = await b.retourner("https://elpis.exemple.lan/x?code=a&state=inconnu", {
        cookie: depart.cookie,
      });
      for (const r of [depart.reponse, retour]) {
        expect(r.headers["cache-control"]).toBe("no-store");
        expect(r.headers["referrer-policy"]).toBe("no-referrer");
        expect(r.headers["x-content-type-options"]).toBe("nosniff");
      }
      expect(refus.statusCode).toBe(302);
      expect(refus.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("ASVS 5.0 V3.4.6 et RFC 9700 §4.16 : la page de retour ne peut être incorporée nulle part et n'exécute ni ne charge rien", async () => {
      const { retour } = await b.connecter(ELPIS("sub-cadre"));
      const csp = String(retour.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(retour.headers["x-frame-options"]).toBe("DENY");
    });

    it("ASVS 5.0 V3.5.3 et RFC 9700 §4.7 : une demande inter-site de départ SSO, de changement de mot de passe ou de déconnexion est refusée", async () => {
      const a = cookies(await loginLocal(SECRET_LOCAL));
      const croise = { host: HOTE_PUBLIC, "sec-fetch-site": "cross-site", cookie: a };
      const depart = await b.main.inject({
        method: "POST",
        url: "/api/auth/oidc/sso/start",
        remoteAddress: adresse(),
        headers: croise,
        payload: { target: "app" },
      });
      expect(depart.statusCode).toBe(403);
      expect(await b.t.base.valeurs("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
      const mdp = await b.main.inject({
        method: "POST",
        url: "/api/users/change-password",
        headers: croise,
        payload: { old_password: SECRET_LOCAL, new_password: "mdp-chef-2-assez-long" },
      });
      expect(mdp.statusCode).toBe(403);
      const sortie = await b.main.inject({ method: "POST", url: "/api/logout-lite", headers: croise });
      expect(sortie.statusCode).toBe(403);
      const moi = await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: a } });
      expect(moi.json<{ logged_in: boolean }>().logged_in).toBe(true);
      const connexion = await loginLocal(SECRET_LOCAL, { "sec-fetch-site": "cross-site" });
      expect(connexion.statusCode).toBe(403);
      expect(String(connexion.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session=ey");
    });

    it("ASVS 5.0 V16.3.1 et V16.2.1 : succès et échec de connexion locale, déconnexion et changement de mot de passe sont audités avec qui, quand, d'où, et jamais avec un mot de passe", async () => {
      const mauvaise = await loginLocal(MAUVAIS);
      expect(mauvaise.statusCode).toBe(401);
      const a = cookies(await loginLocal(SECRET_LOCAL));
      const entetes = { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie: a };
      const nouveau = "NOUVEAU-MOT-DE-PASSE-MARQUEUR";
      const cp = await b.main.inject({
        method: "POST",
        url: "/api/users/change-password",
        headers: entetes,
        payload: { old_password: SECRET_LOCAL, new_password: nouveau },
      });
      expect(cp.statusCode, cp.body).toBe(200);
      const sortie = await b.main.inject({
        method: "POST",
        url: "/api/logout-lite",
        headers: { ...entetes, cookie: cookies(cp, a) },
      });
      expect(sortie.statusCode).toBe(200);
      const lignes = lignesAuditRecentes({ limit: 200 });
      const actions = lignes.map((l) => `${String(l["action"])}:${String(l["outcome"])}`);
      expect(actions).toEqual(
        expect.arrayContaining([
          "auth.login.denied:failure",
          "auth.login:success",
          "auth.password.change:success",
          "auth.logout:success",
        ]),
      );
      for (const l of lignes.filter((x) => String(x["action"]).startsWith("auth."))) {
        expect(typeof l["ts"]).toBe("number");
        expect(String(l["time"])).toMatch(/Z$/u);
        expect(String(l["ip"] ?? "")).not.toBe("");
        expect(l["details"]).toBeTypeOf("object");
      }
      const succes = lignes.find((l) => l["action"] === "auth.login");
      expect(succes?.["username"]).toBe("chef");
      expect(succes?.["details"]).toMatchObject({ login_method: "password" });
      const tout = JSON.stringify(lignes) + lignesJournal.join("\n");
      for (const secret of [SECRET_LOCAL, MAUVAIS, nouveau])
        expect(tout.includes(secret), secret).toBe(false);
    });

    it("ASVS 5.0 V16.3.1 : les refus de connexion SSO sont audités avec le motif et le moyen de connexion, sans le jeton ni le secret du client", async () => {
      b.idp.pieges = { alg: "none" };
      await b.connecter(ELPIS("sub-audit"));
      const refus = lignesAuditRecentes({ actionPrefix: "auth.login.denied" });
      expect(refus.length).toBeGreaterThan(0);
      expect(refus[0]?.["outcome"]).toBe("failure");
      expect(JSON.stringify(refus[0]?.["details"])).toContain("oidc:sso");
      const tout = JSON.stringify(lignesAuditRecentes({ limit: 500 })) + lignesJournal.join("\n");
      expect(tout.includes(b.idp.clientSecret)).toBe(false);
      for (const j of b.idp.emis) expect(tout.includes(j)).toBe(false);
    });

    it("ASVS 5.0 V16.5.1 : une erreur de sécurité ne montre au navigateur qu'un code de la liste fermée et une référence", async () => {
      b.idp.pieges = { claims: { iss: "https://pirate.invalid" } };
      const { retour } = await b.connecter(ELPIS("sub-generique"));
      expect(retour.statusCode).toBe(302);
      expect(String(retour.headers.location)).toMatch(/^\/\?auth_error=[a-z_]+&ref=[A-Za-z0-9_-]{8}$/u);
      expect(retour.body).toBe("");
      expect(JSON.stringify(retour.headers)).not.toContain("pirate");
    });
    it("ASVS 5.0 V16.3.4 et V16.5.1 : un échec TLS vers le fournisseur est journalisé côté serveur et le navigateur ne reçoit qu'une réponse générique", async () => {
      const f = await b.reglages({ ca_pem: "" });
      await enregistrerSecret(b.t.base, f, b.idp.clientSecret, { userId: null, username: null, ip: null });
      await enregistrerTestReussi(b.t.base, f, "https://elpis.exemple.lan");
      lignesJournal.length = 0;
      const d = await b.demarrer();
      expect(d.reponse.statusCode).toBe(503);
      const vu = JSON.stringify([d.reponse.headers, d.reponse.body]);
      expect(vu).not.toMatch(/ca_inconnue|certificate|self.signed|UNABLE_TO|tls/iu);
      expect(vu).not.toContain(b.idp.issuer);
      expect(lignesJournal.join("\n")).toMatch(/ca_inconnue|tls|certificat|unavailable/iu);
    });
  },
);
