// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-recreation.test.ts — un identifiant de fournisseur recréé n'hérite ni des comptes liés, ni de l'état, ni du secret d'avant ; le secret ne s'écrit que pour un fournisseur présent. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validerFournisseur } from "../src/identite/reglages";
import { MOTEURS, ouvrirBanc, URL_PUBLIQUE } from "./identite/banc";
import type { Banc } from "./identite/banc";
import { ldapValide } from "./identite/aides";

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

  it("sans identité : état et secret d'avant disparaissent à la création", async () => {
    await b.t.base.run("DELETE FROM auth_provider_state WHERE provider_id='annuaire'");
    const f = validerFournisseur(ldapValide({ required_groups: ["elpis"] }));
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
      ldapValide({ required_groups: ["elpis"] }),
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
