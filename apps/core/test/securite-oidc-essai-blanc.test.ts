// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-essai-blanc.test.ts — l'essai à blanc d'un fournisseur SSO ne crée ni compte ni session : il exige la session de l'administrateur qui l'a lancé, le drapeau vient de la ligne en base, le résultat ne garde que des revendications d'une liste blanche, et la branche n'importe ni la résolution d'identité ni l'ouverture de session (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { readFileSync } from "node:fs";

import { createUser } from "@elpis/auth";
import { schemaReponseDernierEssai, schemaReponseLancementEssai } from "@elpis/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { secretFournisseur, testReussiCourant } from "../src/identite/fournisseurs";
import { lignesAuditRecentes, lignesJournal } from "./aides";
import { CA_PEM } from "./identite/aides";
import { MOTEURS } from "./identite/banc";
import { cookies, ELPIS, HOTE_PUBLIC, ouvrirBancOidc, URL_PUBLIQUE } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

interface Lancement {
  ok: boolean;
  steps: { id: string; level: string }[];
  url: string | null;
}

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("essai à blanc d'un fournisseur SSO (%s)", (moteur) => {
  let b: BancOidc;
  let admin: string;

  beforeEach(async () => {
    lignesJournal.length = 0;
    b = await ouvrirBancOidc(moteur, { actif: false });
    await b.t.base.run("DELETE FROM auth_provider_state");
    admin = await connexionLocale("chef", "mdp-chef-1");
  });
  afterEach(async () => {
    await b.fermer();
  });

  async function connexionLocale(nom: string, mdp: string): Promise<string> {
    const r = await b.console.inject({
      method: "POST",
      url: "/api/login-lite",
      headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" },
      payload: { username: nom, password: mdp },
    });
    expect(r.statusCode, r.body).toBe(200);
    return cookies(r);
  }

  const lancer = (cookie = admin, id = "sso", hote = HOTE_PUBLIC) =>
    b.console.inject({
      method: "POST",
      url: `/api/admin/auth/providers/${id}/trial`,
      headers: { host: hote, cookie, "sec-fetch-site": "same-origin" },
      payload: {},
    });
  const lire = (cookie = admin) =>
    b.console.inject({
      method: "GET",
      url: "/api/admin/auth/providers/sso/trial",
      headers: { host: HOTE_PUBLIC, cookie },
    });
  const lignes = (sql: string): Promise<unknown[][]> => b.t.base.valeurs(sql);
  const sansCompte = async (): Promise<void> => {
    expect(await b.utilisateurs()).toEqual(["chef"]);
    expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
    expect(await lignes("SELECT COUNT(*) FROM user_identities")).toEqual([[0]]);
  };

  /** Départ de l'essai puis retour du navigateur avec les cookies donnés. */
  async function parcours(
    u = ELPIS("sub-essai"),
    cookieRetour?: (liaison: string) => string,
  ): Promise<{ lancement: Lancement; retour: Awaited<ReturnType<BancOidc["retourner"]>> }> {
    const l = await lancer();
    expect(l.statusCode, l.body).toBe(200);
    const lancement = l.json<Lancement>();
    const liaison = cookies(l);
    const { retour } = b.idp.autoriser(lancement.url ?? "", u);
    const retourne = await b.retourner(retour, {
      cookie: (cookieRetour ?? ((c) => `${c}; ${admin}`))(liaison),
    });
    return { lancement, retour: retourne };
  }

  it("lancement : les étapes du test d'abord, puis l'adresse d'autorisation et le cookie de liaison ; un flux marqué pour cet administrateur", async () => {
    const l = await lancer();
    expect(l.statusCode, l.body).toBe(200);
    const r = l.json<Lancement>();
    expect(schemaReponseLancementEssai.safeParse(r).success).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps.map((e) => e.id)).toEqual(
      expect.arrayContaining(["settings", "prerequisites", "discovery", "jwks", "secret"]),
    );
    expect(r.url).toContain("/realms/elpis/auth?");
    expect(String(l.headers["set-cookie"])).toMatch(/^__Host-elpis-sso=/u);
    expect(await lignes(`SELECT trial_admin, stage FROM auth_flows`)).toEqual([[b.chef, "auth"]]);
  });

  it("l'essai ne crée ni compte ni session, enregistre le résultat et le test réussi", async () => {
    const { retour } = await parcours();
    expect(retour.statusCode, retour.body).toBe(200);
    expect(retour.body).not.toMatch(/<script|http-equiv="refresh"/iu);
    expect(String(retour.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session");
    await sansCompte();
    expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
    const g = (await lire()).json<{ result: Record<string, unknown> }>().result;
    expect(schemaReponseDernierEssai.safeParse({ result: g }).success).toBe(true);
    expect(g).toMatchObject({
      ok: true,
      claims: {
        iss: b.idp.issuer,
        subject: "sub-essai",
        identifier: "sub-essai",
        name: "Nom de sub-essai",
        email: "sub-essai@exemple.lan",
        email_verified: true,
        groups: ["elpis"],
      },
      decision: { outcome: "create", username: "sub-essai", reason: null },
    });
    expect((g["warnings"] as string[]).join(" ")).toContain("sujet est égal à l'identifiant");
    expect(await testReussiCourant(b.t.base, b.fournisseur, URL_PUBLIQUE)).toBe(true);
  });

  it("la décision dit ce qui se passerait : compte connu, refus de groupe, nom déjà pris, groupes illisibles", async () => {
    await createUser(b.t.base, "sub-pris", "mdp-pris-1");
    const decisions: [ReturnType<typeof ELPIS>, Record<string, unknown>][] = [
      [ELPIS("sub-pris"), { outcome: "refuse", reason: "account_conflict" }],
      [ELPIS("sub-autre", { groups: ["autres"] }), { outcome: "refuse", reason: "not_in_group" }],
      [ELPIS("sub-sansgroupe", { groups: undefined }), { outcome: "refuse", reason: "groups_unknown" }],
      [ELPIS("sub-nom", { preferred_username: "!!" }), { outcome: "refuse", reason: "name_invalid" }],
    ];
    for (const [u, attendu] of decisions) {
      b.idp.userinfo = (x) => ({ sub: x.sub });
      await parcours(u);
      const g = (await lire()).json<{ result: { decision: Record<string, unknown> } }>().result;
      expect(g.decision, u.sub).toMatchObject(attendu);
    }
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) SELECT id, 'sso', 'sub-connu', ?, 'auto', 1 FROM users WHERE username='sub-pris'",
      [`oidc:${b.idp.issuer}`],
    );
    await parcours(ELPIS("sub-connu", { preferred_username: "autre" }));
    expect((await lire()).json<{ result: { decision: unknown } }>().result.decision).toEqual({
      outcome: "login",
      username: "sub-pris",
      reason: null,
    });
    expect(await b.utilisateurs()).toEqual(["chef", "sub-pris"]);
  });

  it("groupes illisibles : l'essai est rendu mais le test n'est pas retenu", async () => {
    b.idp.userinfo = (x) => ({ sub: x.sub });
    await parcours(ELPIS("sub-sansgroupe", { groups: undefined }));
    expect((await lire()).json<{ result: { ok: boolean } }>().result.ok).toBe(false);
    expect(await testReussiCourant(b.t.base, b.fournisseur, URL_PUBLIQUE)).toBe(false);
  });

  it("jeton refusé pendant l'essai : résultat d'erreur à code fermé, rien d'autre", async () => {
    b.idp.pieges = { alg: "none" };
    const { retour } = await parcours();
    expect(retour.statusCode).toBe(200);
    const g = (await lire()).json<{ result: Record<string, unknown> }>().result;
    expect(g).toMatchObject({ ok: false, claims: null, decision: { outcome: "error", reason: "failed" } });
    expect(await testReussiCourant(b.t.base, b.fournisseur, URL_PUBLIQUE)).toBe(false);
    await sansCompte();
  });

  it("la session de l'administrateur qui l'a lancé est exigée au retour", async () => {
    await createUser(b.t.base, "chef2", "mdp-chef-2", { isAdmin: 1 });
    await createUser(b.t.base, "alice", "mdp-alice-1");
    const autre = await connexionLocale("chef2", "mdp-chef-2");
    const simple = await b.main.inject({
      method: "POST",
      url: "/api/login-lite",
      headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" },
      payload: { username: "alice", password: "mdp-alice-1" },
    });
    const refusees: [string, (c: string) => string][] = [
      ["sans session", (c) => c],
      ["autre administrateur", (c) => `${c}; ${autre}`],
      ["compte ordinaire", (c) => `${c}; ${cookies(simple)}`],
    ];
    for (const [nom, cookie] of refusees) {
      const { retour } = await parcours(ELPIS("sub-essai"), cookie);
      expect(retour.statusCode, nom).toBe(302);
      expect(String(retour.headers.location), nom).toMatch(/^\/\?auth_error=failed&ref=/u);
      expect((await lire()).json<{ result: unknown }>().result, nom).toBeNull();
    }
    expect(await b.utilisateurs()).toEqual(["chef", "chef2", "alice"]);
    expect(await lignes("SELECT COUNT(*) FROM auth_ext_sessions")).toEqual([[0]]);
    expect(await lignes("SELECT COUNT(*) FROM user_identities")).toEqual([[0]]);
  });

  it("le drapeau d'essai vient de la ligne en base, jamais de l'adresse : un paramètre `trial` ne change rien", async () => {
    const d = await b.demarrer();
    expect(d.reponse.statusCode).toBe(404);
    await b.reglages({ enabled: true });
    const o = await b.demarrer();
    const { retour } = b.idp.autoriser(o.url ?? "", ELPIS("sub-reel"));
    const r = await b.retourner(`${retour}&trial=1&trial_admin=${b.chef}`, {
      cookie: `${o.cookie}; ${admin}`,
    });
    expect(r.statusCode).toBe(200);
    expect(await b.utilisateurs()).toEqual(["chef", "sub-reel"]);
  });

  it("refus de lancer : fournisseur actif, inconnu, de l'autre type, hôte non canonique, non administrateur", async () => {
    expect((await lancer(admin, "inconnu")).statusCode).toBe(404);
    const h = await lancer(admin, "sso", "10.1.2.3:8002");
    expect([h.statusCode, h.json()]).toMatchObject([409, { canonical: URL_PUBLIQUE }]);
    const sans = await b.console.inject({
      method: "POST",
      url: "/api/admin/auth/providers/sso/trial",
      headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" },
      payload: {},
    });
    expect([401, 403]).toContain(sans.statusCode);
    expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
    await b.reglages({ enabled: true });
    expect((await lancer()).statusCode).toBe(409);
  });

  it("autorité de certification changée dans les réglages enregistrés : le secret client est hors de portée, l'essai est refusé sans flux", async () => {
    expect(await secretFournisseur(b.t.base, b.fournisseur)).not.toBeNull();
    const modifie = await b.reglages({ ca_pem: CA_PEM });
    expect(await secretFournisseur(b.t.base, modifie)).toBeNull();
    const l = await lancer();
    expect(l.statusCode).toBe(200);
    expect(l.json<Lancement>()).toMatchObject({ ok: false, url: null });
    expect(l.headers["set-cookie"]).toBeUndefined();
    expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
  });

  it("une étape en échec : pas de flux, pas d'adresse", async () => {
    b.idp.decouverte = { token_endpoint: "https://autre.exemple.lan/token" };
    await b.reglages({ label: "x" });
    const l = await lancer();
    expect(l.statusCode).toBe(200);
    expect(l.json<Lancement>()).toMatchObject({ ok: false, url: null });
    expect(l.headers["set-cookie"]).toBeUndefined();
    expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
  });

  it("le résultat ne garde que la liste blanche, jamais un jeton, un secret ou une revendication hors liste", async () => {
    await parcours(
      ELPIS("sub-essai", {
        secret_interne: "MARQUEUR-HORS-LISTE",
        groups: ["elpis", ...Array.from({ length: 80 }, (_v, i) => `g${i}`)],
      }),
    );
    const brut = await lignes("SELECT result_json FROM auth_trials");
    const json = String(brut[0]?.[0]);
    for (const x of ["MARQUEUR-HORS-LISTE", "secret-client-de-test", ...b.idp.emis])
      expect(json).not.toContain(x);
    const r = JSON.parse(json) as { claims: Record<string, unknown> };
    expect(Object.keys(r.claims).sort()).toEqual(
      ["acr", "amr", "email", "email_verified", "groups", "iss", "identifier", "name", "subject"].sort(),
    );
    expect((r.claims["groups"] as string[]).length).toBe(50);
    const audit = JSON.stringify(lignesAuditRecentes({ limit: 100 }));
    expect(audit).not.toContain("MARQUEUR-HORS-LISTE");
    const essais = lignesAuditRecentes({ actionPrefix: "admin.auth.provider.trial" });
    expect(essais.find((l) => l["action"] === "admin.auth.provider.trial")?.["details"]).toMatchObject({
      provider_id: "sso",
      ok: true,
      started: true,
    });
    expect(essais.find((l) => l["action"] === "admin.auth.provider.trial.result")?.["details"]).toMatchObject(
      {
        provider_id: "sso",
        ok: true,
        outcome: "create",
        reason: null,
      },
    );
  });

  it("réglages changés entre le départ et le retour : échec `settings_changed`, test non enregistré, issue journalisée", async () => {
    const l = await lancer();
    const { retour } = b.idp.autoriser(l.json<Lancement>().url ?? "", ELPIS("sub-essai"));
    await b.reglages({ clock_skew_sec: 7 });
    await b.t.base.run("DELETE FROM auth_provider_state");
    const r = await b.retourner(retour, { cookie: `${cookies(l)}; ${admin}` });
    expect(r.statusCode).toBe(200);
    const g = (await lire()).json<{ result: { ok: boolean; decision: Record<string, unknown> } }>().result;
    expect(g.ok).toBe(false);
    expect(g.decision).toEqual({ outcome: "error", username: null, reason: "settings_changed" });
    expect(await testReussiCourant(b.t.base, b.fournisseur, URL_PUBLIQUE)).toBe(false);
    await sansCompte();
    const ev = lignesAuditRecentes({ actionPrefix: "admin.auth.provider.trial.result" })[0];
    expect(ev?.["details"]).toMatchObject({
      provider_id: "sso",
      ok: false,
      outcome: "error",
      reason: "settings_changed",
    });
  });

  it("modifier le fournisseur supprime ses flux d'essai en cours", async () => {
    await lancer();
    expect(await lignes("SELECT COUNT(*) FROM auth_flows WHERE trial_admin IS NOT NULL")).toEqual([[1]]);
    const m = await b.console.inject({
      method: "PUT",
      url: "/api/admin/auth/providers/sso",
      headers: { host: HOTE_PUBLIC, cookie: admin, "sec-fetch-site": "same-origin" },
      payload: { label: "Autre libellé" },
    });
    expect(m.statusCode, m.body).toBe(200);
    expect(await lignes("SELECT COUNT(*) FROM auth_flows")).toEqual([[0]]);
  });

  it("décision de refus (nom invalide, groupe) : essai rendu, test non retenu ; connexion ou création : retenu", async () => {
    b.idp.userinfo = (x) => ({ sub: x.sub });
    await parcours(ELPIS("sub-nom", { preferred_username: "!!" }));
    expect((await lire()).json<{ result: { ok: boolean } }>().result.ok).toBe(false);
    expect(await testReussiCourant(b.t.base, b.fournisseur, URL_PUBLIQUE)).toBe(false);
    await parcours(ELPIS("sub-autre", { groups: ["autres"] }));
    expect(await testReussiCourant(b.t.base, b.fournisseur, URL_PUBLIQUE)).toBe(false);
    await parcours(ELPIS("sub-bon"));
    expect((await lire()).json<{ result: { ok: boolean } }>().result.ok).toBe(true);
    expect(await testReussiCourant(b.t.base, b.fournisseur, URL_PUBLIQUE)).toBe(true);
    const evs = lignesAuditRecentes({ actionPrefix: "admin.auth.provider.trial.result" });
    expect(evs.map((e) => (e["details"] as Record<string, unknown>)["reason"]).sort()).toEqual(
      ["name_invalid", "not_in_group", null].sort(),
    );
  });

  it("ouverture de la configuration impossible au retour : résultat d'échec rangé pour la console", async () => {
    const l = await lancer();
    const { retour } = b.idp.autoriser(l.json<Lancement>().url ?? "", ELPIS("sub-essai"));
    await b.t.base.run("DELETE FROM vault_secrets");
    const r = await b.retourner(retour, { cookie: `${cookies(l)}; ${admin}` });
    expect(r.statusCode).toBe(200);
    const g = (await lire()).json<{ result: { ok: boolean; decision: Record<string, unknown> } }>().result;
    expect(g.ok).toBe(false);
    expect(g.decision).toEqual({ outcome: "error", username: null, reason: "unavailable" });
    await sansCompte();
  });

  it("le dernier résultat remplace le précédent ; sans essai : `null`", async () => {
    expect((await lire()).json<{ result: unknown }>().result).toBeNull();
    await parcours(ELPIS("sub-un"));
    await parcours(ELPIS("sub-deux"));
    expect(await lignes("SELECT COUNT(*) FROM auth_trials")).toEqual([[1]]);
    expect((await lire()).json<{ result: { claims: { subject: string } } }>().result.claims.subject).toBe(
      "sub-deux",
    );
  });

  it("éteindre ou supprimer le fournisseur par la console supprime ses flux, sessions de fournisseur et résultat d'essai", async () => {
    await createUser(b.t.base, "alice", "mdp-alice-1");
    const poser = async (): Promise<void> => {
      await b.demarrer({ id: "sso" });
      await b.t.base.run(
        "INSERT INTO auth_ext_sessions(sid, user_id, provider_id, subject, created_at, expires_at) SELECT 'sid-' || id, id, 'sso', 's', 1, 4000000000 FROM users WHERE username='alice'",
      );
      await b.t.base.run("DELETE FROM auth_trials");
      await b.t.base.run(
        "INSERT INTO auth_trials(provider_id, admin_id, result_json, created_at) VALUES('sso', 1, '{}', 1)",
      );
    };
    const vide = async (): Promise<void> => {
      for (const t of ["auth_flows", "auth_ext_sessions", "auth_trials"])
        expect(await lignes(`SELECT COUNT(*) FROM ${t}`), t).toEqual([[0]]);
    };
    const action = (methode: "POST" | "DELETE", url: string) =>
      b.console.inject({
        method: methode,
        url,
        headers: { host: HOTE_PUBLIC, cookie: admin, "sec-fetch-site": "same-origin" },
      });
    await poser();
    expect((await action("POST", "/api/admin/auth/providers/sso/disable")).statusCode).toBe(200);
    await vide();
    await poser();
    expect((await action("DELETE", "/api/admin/auth/providers/sso")).statusCode).toBe(200);
    await vide();
  });

  it("la branche d'essai n'importe ni la résolution d'identité ni l'ouverture de session", () => {
    const interdits =
      /provisionnement|ouverture|connexion"|comptes\/etat|createExternalUser|ouvrirSession|etablirConnexion|resoudreIdentite/u;
    for (const f of ["essai-blanc.ts", "echange.ts"]) {
      const src = readFileSync(new URL(`../src/identite/oidc/${f}`, import.meta.url), "utf8");
      const imports = src.split("\n").filter((l) => /^import /u.test(l));
      for (const l of imports) {
        const type = /^import type /u.test(l);
        if (f === "echange.ts" && type) continue;
        expect(l, `${f} : ${l}`).not.toMatch(interdits);
      }
      expect(src, f).not.toMatch(/resoudreIdentite|etablirConnexion|ouvrirSession|createExternalUser/u);
    }
  });
});
