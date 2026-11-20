// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-recreation.test.ts — un identifiant de fournisseur recréé n'hérite ni de l'état ni du secret d'avant ; les identités d'avant ne sont reprises que si l'ancre (l'émetteur exact) est la même, sinon la création est refusée ; changer d'adresse impose de ressaisir le secret et de refaire un test complet ; le secret ne s'écrit que pour un fournisseur présent. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ancreIdentite } from "../src/identite/ancre";
import { validerFournisseur } from "../src/identite/reglages";
import { MOTEURS, ouvrirBanc, URL_PUBLIQUE } from "./identite/banc";
import type { Banc } from "./identite/banc";
import { oidcValide } from "./identite/aides";

describe.each(MOTEURS)("recréation d'un fournisseur (%s)", (moteur) => {
  let b: Banc;
  beforeAll(async () => {
    b = await ouvrirBanc(moteur);
  });
  afterAll(async () => {
    await b.fermer();
  });

  const lignes = (sql: string): Promise<unknown[][]> => b.t.base.valeurs(sql);

  it("identités restantes : création refusée (409), rien n'est touché", async () => {
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
      [b.alice, "sso", "s-alice", "i", "admin", 1],
    );
    await b.t.base.run("INSERT INTO auth_provider_state(provider_id, tested_hash) VALUES(?,?)", ["sso", "h"]);
    const r = await b.appeler("POST", "/api/admin/auth/providers", oidcValide());
    expect(r.statusCode).toBe(409);
    expect(b.lireConfig()["auth"]).toEqual({ public_url: URL_PUBLIQUE, providers: [] });
    expect(await lignes("SELECT 1 FROM auth_provider_state WHERE provider_id='sso'")).toHaveLength(1);
    await b.t.base.run("DELETE FROM user_identities WHERE provider_id='sso'");
  });

  it("identités restantes de la même ancre (fichier perdu puis refait à l'identique) : création permise, identités et comptes gardés", async () => {
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
    const f = validerFournisseur(oidcValide({ required_groups: ["cn=elpis"] }));
    const ancre = ancreIdentite(f);
    expect(ancre).toBe("oidc:https://idp.exemple.lan/realms/elpis");
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
      [b.alice, "sso", "s-alice", ancre, "auto", 1],
    );
    const r = await b.appeler(
      "POST",
      "/api/admin/auth/providers",
      oidcValide({ required_groups: ["cn=elpis"] }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(await lignes("SELECT user_id FROM user_identities WHERE provider_id='sso'")).toEqual([[b.alice]]);
    await b.t.base.run("DELETE FROM user_identities WHERE provider_id='sso'");
  });

  it.each([["autre émetteur", { issuer: "https://autre.exemple.lan/realms/elpis" }]])(
    "identités restantes d'une autre ancre (%s) : création refusée (409), rien n'est touché",
    async (_n, ecart) => {
      b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
      const ancienne = ancreIdentite(validerFournisseur(oidcValide({ required_groups: ["cn=elpis"] })));
      await b.t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
        [b.alice, "sso", "s-alice", ancienne, "auto", 1],
      );
      const r = await b.appeler(
        "POST",
        "/api/admin/auth/providers",
        oidcValide({ required_groups: ["cn=elpis"], ...ecart }),
      );
      expect(r.statusCode).toBe(409);
      expect(b.lireConfig()["auth"]).toEqual({ public_url: URL_PUBLIQUE, providers: [] });
      expect(await lignes("SELECT 1 FROM user_identities WHERE provider_id='sso'")).toHaveLength(1);
      await b.t.base.run("DELETE FROM user_identities WHERE provider_id='sso'");
    },
  );

  it("identités restantes d'un fournisseur OIDC : création refusée (409), aucune ancre ne les couvre", async () => {
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
      [b.alice, "sso", "s-alice", "https://idp.exemple.lan/realms/elpis", "auto", 1],
    );
    const r = await b.appeler(
      "POST",
      "/api/admin/auth/providers",
      oidcValide({ required_groups: ["cn=elpis"] }),
    );
    expect(r.statusCode).toBe(409);
    await b.t.base.run("DELETE FROM user_identities WHERE provider_id='sso'");
  });

  it("sans identité : état et secret d'avant disparaissent à la création", async () => {
    await b.t.base.run("DELETE FROM auth_provider_state WHERE provider_id='sso'");
    const f = validerFournisseur(oidcValide({ required_groups: ["cn=elpis"] }));
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [f] } });
    expect(
      (await b.appeler("PUT", "/api/admin/auth/providers/sso/secret", { secret: "ancien-secret-1" }))
        .statusCode,
    ).toBe(200);
    await b.t.base.run("INSERT INTO auth_provider_state(provider_id, tested_hash) VALUES(?,?)", ["sso", "h"]);
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
    expect(await lignes("SELECT 1 FROM vault_secrets WHERE name='auth-sso'")).toHaveLength(1);
    const r = await b.appeler(
      "POST",
      "/api/admin/auth/providers",
      oidcValide({ required_groups: ["cn=elpis"] }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(await lignes("SELECT 1 FROM vault_secrets WHERE name='auth-sso'")).toHaveLength(0);
    expect(await lignes("SELECT 1 FROM auth_provider_state WHERE provider_id='sso'")).toHaveLength(0);
    expect(r.json<{ providers: { has_secret: boolean; tested: boolean }[] }>().providers[0]).toMatchObject({
      has_secret: false,
      tested: false,
    });
  });

  it("secret d'un fournisseur sorti du fichier : refusé (404), aucun secret orphelin", async () => {
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
    const r = await b.appeler("PUT", "/api/admin/auth/providers/sso/secret", { secret: "orphelin-1" });
    expect(r.statusCode).toBe(404);
    expect(await lignes("SELECT 1 FROM vault_secrets WHERE name='auth-sso'")).toHaveLength(0);
  });
});
