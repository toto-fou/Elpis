// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-recreation.test.ts — un identifiant de fournisseur recréé n'hérite ni de l'état ni du secret d'avant ; les identités d'avant ne sont reprises que si l'ancre (base des utilisateurs et attribut de clé, jamais les serveurs) est la même, sinon la création est refusée ; changer d'hôte impose de ressaisir le secret et de refaire un test complet ; le secret ne s'écrit que pour un fournisseur présent. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ancreIdentite } from "../src/identite/ancre";
import { validerFournisseur } from "../src/identite/reglages";
import { MOTEURS, ouvrirBanc, URL_PUBLIQUE } from "./identite/banc";
import type { Banc } from "./identite/banc";
import { ldapValide, oidcValide } from "./identite/aides";

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
      [b.alice, "annuaire", "s-alice", "i", "admin", 1],
    );
    await b.t.base.run("INSERT INTO auth_provider_state(provider_id, tested_hash, tested_at) VALUES(?,?,?)", [
      "annuaire",
      "h",
      1,
    ]);
    const r = await b.appeler("POST", "/api/admin/auth/providers", ldapValide());
    expect(r.statusCode).toBe(409);
    expect(b.lireConfig()["auth"]).toEqual({ public_url: URL_PUBLIQUE, providers: [] });
    expect(await lignes("SELECT 1 FROM auth_provider_state WHERE provider_id='annuaire'")).toHaveLength(1);
    await b.t.base.run("DELETE FROM user_identities WHERE provider_id='annuaire'");
  });

  it("identités restantes de la même ancre (fichier perdu puis refait à l'identique) : création permise, identités et comptes gardés, compteur d'échecs remis à zéro", async () => {
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
    const f = validerFournisseur(ldapValide({ required_groups: ["cn=elpis"] }));
    const ancre = ancreIdentite(f);
    expect(ancre).toBe("ldap:cn=users,dc=exemple,dc=lan#entryuuid");
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
      [b.alice, "annuaire", "s-alice", ancre, "auto", 1],
    );
    await b.t.base.run(
      "INSERT INTO auth_failures(provider_id, subject, count, window_start, last_at) VALUES(?,?,?,?,?)",
      ["annuaire", "s-alice", 3, 1, 1],
    );
    const r = await b.appeler(
      "POST",
      "/api/admin/auth/providers",
      ldapValide({ required_groups: ["cn=elpis"] }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(await lignes("SELECT user_id FROM user_identities WHERE provider_id='annuaire'")).toEqual([
      [b.alice],
    ]);
    expect(await lignes("SELECT 1 FROM auth_failures WHERE provider_id='annuaire'")).toHaveLength(0);
    await b.t.base.run("DELETE FROM user_identities WHERE provider_id='annuaire'");
  });

  it.each([
    ["autre base d'utilisateurs", { user_base_dn: "ou=autre,dc=exemple,dc=lan" }],
    [
      "autre attribut d'identifiant",
      { attrs: { id: "ipaUniqueID", username: "uid", email: "mail", name: "cn" } },
    ],
  ])(
    "identités restantes d'une autre ancre (%s) : création refusée (409), rien n'est touché",
    async (_n, ecart) => {
      b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
      const ancienne = ancreIdentite(validerFournisseur(ldapValide({ required_groups: ["cn=elpis"] })));
      await b.t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
        [b.alice, "annuaire", "s-alice", ancienne, "auto", 1],
      );
      const r = await b.appeler(
        "POST",
        "/api/admin/auth/providers",
        ldapValide({ required_groups: ["cn=elpis"], ...ecart }),
      );
      expect(r.statusCode).toBe(409);
      expect(b.lireConfig()["auth"]).toEqual({ public_url: URL_PUBLIQUE, providers: [] });
      expect(await lignes("SELECT 1 FROM user_identities WHERE provider_id='annuaire'")).toHaveLength(1);
      await b.t.base.run("DELETE FROM user_identities WHERE provider_id='annuaire'");
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
    await b.t.base.run("DELETE FROM auth_provider_state WHERE provider_id='annuaire'");
    const f = validerFournisseur(ldapValide({ required_groups: ["cn=elpis"] }));
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [f] } });
    expect(
      (await b.appeler("PUT", "/api/admin/auth/providers/annuaire/secret", { secret: "ancien-secret-1" }))
        .statusCode,
    ).toBe(200);
    await b.t.base.run("INSERT INTO auth_provider_state(provider_id, tested_hash, tested_at) VALUES(?,?,?)", [
      "annuaire",
      "h",
      1,
    ]);
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
    expect(await lignes("SELECT 1 FROM vault_secrets WHERE name='auth-annuaire'")).toHaveLength(1);
    const r = await b.appeler(
      "POST",
      "/api/admin/auth/providers",
      ldapValide({ required_groups: ["cn=elpis"] }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(await lignes("SELECT 1 FROM vault_secrets WHERE name='auth-annuaire'")).toHaveLength(0);
    expect(await lignes("SELECT 1 FROM auth_provider_state WHERE provider_id='annuaire'")).toHaveLength(0);
    expect(r.json<{ providers: { has_secret: boolean; tested: boolean }[] }>().providers[0]).toMatchObject({
      has_secret: false,
      tested: false,
    });
  });

  it("secret d'un fournisseur sorti du fichier : refusé (404), aucun secret orphelin", async () => {
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [] } });
    const r = await b.appeler("PUT", "/api/admin/auth/providers/annuaire/secret", { secret: "orphelin-1" });
    expect(r.statusCode).toBe(404);
    expect(await lignes("SELECT 1 FROM vault_secrets WHERE name='auth-annuaire'")).toHaveLength(0);
  });
});
