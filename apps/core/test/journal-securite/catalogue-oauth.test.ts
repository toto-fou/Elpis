// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/catalogue-oauth.test.ts — journal de sécurité d'OAuth : enregistrement, consentement, jetons, révocation et autorisations du compte. */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut } from "@elpis/auth";
import { configView, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { signClaims } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleOAuth } from "../../src/familles/oauth";
import { appTest } from "../aides";
import { journalDeTest } from "./aides-journal";
import type { JournalDeTest } from "./aides-journal";

const SECRET = "secret-de-test-oauth";
const RURI = "http://localhost:9/cb";

describe("journal de sécurité : OAuth", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let j: JournalDeTest;
  let dossier: string;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
    dossier = mkdtempSync(join(tmpdir(), "elpis-cat-oauth-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    j = journalDeTest();
    const auth = { ...dependancesParDefaut(t.base), secret: () => SECRET };
    app = await appTest({
      familles: [
        creerFamilleOAuth({
          auth,
          oauth: { base: t.base, config: () => configView() },
          compteConnecte: async (req) => (req.headers["x-uid"] ? Number(req.headers["x-uid"]) : null),
        }),
      ],
      gardes: {
        session: (req) => {
          req.utilisateur = { id: 1, username: "alice" };
        },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    restaurer?.();
    invalidateConfigCache();
    j?.fermer();
    await t?.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("parcours complet : enregistrement, refus, accord, jeton, révocation, retrait de l'autorisation", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { client_name: "Mon client", redirect_uris: [RURI], token_endpoint_auth_method: "none" },
    });
    expect(reg.statusCode).toBe(201);
    const cid = (reg.json() as { client_id: string }).client_id;
    expect(j.derniere("oauth.client.register")).toMatchObject({
      outcome: "success",
      user_id: null,
      details: { client_id: cid, client_name: "Mon client" },
    });
    expect(j.derniere("oauth.client.register").ip).not.toBeNull();

    const verifier = "verifier-de-test-0123456789-0123456789-0123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const cle = createHash("sha256").update(`elpis-oauth-consent:${SECRET}`, "utf8").digest("hex");
    const consentement = (): string =>
      signClaims(
        { uid: 1, cid, ruri: RURI, imp: false, st: "s", cc: challenge, res: "", fams: ["fs"] },
        cle,
        { aud: "elpis-oauth-consent", now: Date.now() / 1000 },
      );
    const formulaire = (corps: Record<string, string>) => ({
      method: "POST" as const,
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-uid": "1" },
      payload: new URLSearchParams(corps).toString(),
    });

    await app.inject(formulaire({ req: consentement(), decision: "deny" }));
    expect(j.derniere("oauth.authorize.denied")).toMatchObject({
      outcome: "failure",
      user_id: 1,
      username: "alice",
      details: { client_id: cid, scope: ["fs"] },
    });

    const accord = await app.inject(formulaire({ req: consentement(), decision: "allow", fam: "fs" }));
    expect(accord.statusCode).toBe(302);
    expect(j.derniere("oauth.authorize")).toMatchObject({
      outcome: "success",
      user_id: 1,
      details: { client_id: cid, scope: ["fs"] },
    });
    const code = new URL(String(accord.headers.location)).searchParams.get("code") ?? "";

    const jeton = (corps: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ client_id: cid, ...corps }).toString(),
      });
    await jeton({
      grant_type: "authorization_code",
      code: "inconnu",
      redirect_uri: RURI,
      code_verifier: verifier,
    });
    expect(j.derniere("oauth.token.denied")).toMatchObject({
      outcome: "failure",
      details: { client_id: cid, grant_type: "authorization_code", error: "invalid_grant" },
    });
    const ok = await jeton({
      grant_type: "authorization_code",
      code,
      redirect_uri: RURI,
      code_verifier: verifier,
    });
    expect(ok.statusCode).toBe(200);
    const paire = ok.json() as { access_token: string; refresh_token: string };
    expect(j.derniere("oauth.token")).toMatchObject({
      outcome: "success",
      user_id: 1,
      username: "alice",
      details: { client_id: cid, grant_type: "authorization_code" },
    });

    const revoquer = (corps: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/oauth/revoke",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(corps).toString(),
      });
    await revoquer({ client_id: cid, token: paire.access_token });
    expect(j.derniere("oauth.revoke")).toMatchObject({
      user_id: 1,
      username: "alice",
      details: { client_id: cid },
    });
    const revocations = j.de("oauth.revoke").length;
    for (let i = 0; i < 5; i++) {
      expect((await revoquer({ token: `eoa_faux-${i}` })).statusCode).toBe(200);
      await revoquer({ token: "n-importe-quoi" });
    }
    await revoquer({ client_id: cid, token: paire.access_token });
    expect(j.de("oauth.revoke")).toHaveLength(revocations);

    const grant = String((await t.base.valeurs("SELECT grant_id FROM oauth_tokens LIMIT 1"))[0]?.[0]);
    const retrait = await app.inject({ method: "DELETE", url: `/api/oauth/grants/${grant}` });
    expect(retrait.statusCode).toBe(200);
    expect(j.derniere("oauth.grant.delete")).toMatchObject({
      user_id: 1,
      details: { grant_id: grant, client_id: cid },
    });

    const brut = j.brut();
    for (const secret of [paire.access_token, paire.refresh_token, code, verifier])
      expect(brut).not.toContain(secret);
  });

  it("révocation : authentification du client refusée, oauth.revoke.denied agrégé, secret jamais écrit", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/oauth/register",
      remoteAddress: "10.7.7.7",
      payload: {
        client_name: "Confidentiel",
        redirect_uris: [RURI],
        token_endpoint_auth_method: "client_secret_post",
      },
    });
    const { client_id: cid, client_secret: secret } = reg.json() as {
      client_id: string;
      client_secret: string;
    };
    expect(secret).toBeTruthy();
    const revoquer = (corps: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/oauth/revoke",
        remoteAddress: "10.7.7.7",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(corps).toString(),
      });
    const avant = j.de("oauth.revoke.denied").length;
    expect(
      (await revoquer({ client_id: cid, client_secret: "Mauvais-Secret-1", token: "x" })).statusCode,
    ).toBe(401);
    expect(j.derniere("oauth.revoke.denied")).toMatchObject({
      outcome: "failure",
      user_id: null,
      ip: "10.7.7.7",
      details: { method: "POST", route: "/oauth/revoke", client_id: cid, error: "invalid_client" },
    });
    // La relecture du journal vide l'agrégat : la première ligne a clos sa fenêtre.
    for (let i = 0; i < 3; i++)
      await revoquer({ client_id: cid, client_secret: `Mauvais-Secret-${i}`, token: "x" });
    expect(
      j
        .de("oauth.revoke.denied")
        .slice(avant)
        .map((l) => l.details["repeated"] ?? null),
    ).toEqual([null, null, 2]);
    await revoquer({
      client_id: `inconnu-${"z".repeat(300)}`,
      client_secret: "Mauvais-Secret-9",
      token: "x",
    });
    expect(Array.from(String(j.derniere("oauth.revoke.denied").details["client_id"]))).toHaveLength(100);
    expect(j.brut()).not.toContain("Mauvais-Secret");
  });

  it("enregistrements dynamiques : un par un jusqu'à 10 par adresse et par minute, agrégés au-delà", async () => {
    const avant = j.de("oauth.client.register").length;
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/oauth/register",
        remoteAddress: "10.9.9.9",
        payload: { client_name: `c${i}`, redirect_uris: [RURI], token_endpoint_auth_method: "none" },
      });
      ids.push((r.json() as { client_id: string }).client_id);
    }
    const lignes = j.de("oauth.client.register").slice(avant);
    expect(lignes.slice(0, 10).map((l) => l.details["client_id"])).toEqual(ids.slice(0, 10));
    expect(lignes.slice(10).map((l) => l.details["repeated"] ?? null)).toEqual([null, 2]);
  });
});
