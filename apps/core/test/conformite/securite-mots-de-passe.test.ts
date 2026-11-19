// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/securite-mots-de-passe.test.ts — le mot de passe d'un compte local suit ASVS 5.0 V6.2 et le guide de l'ANSSI sur les mots de passe : vérifié tel que saisi, longs mots de passe acceptés, aucune expiration imposée (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createUser } from "@elpis/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOTEURS } from "../identite/banc";
import { HOTE_PUBLIC, ouvrirBancOidc } from "../identite/banc-oidc";
import type { BancOidc } from "../identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("mots de passe locaux : référentiels (%s)", (moteur) => {
  let b: BancOidc;
  let rang = 0;

  const connexion = async (nom: string, mot: string): Promise<number> =>
    (
      await b.main.inject({
        method: "POST",
        url: "/api/login-lite",
        remoteAddress: `10.99.${(rang += 1) >> 8}.${rang & 255}`,
        headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" },
        payload: { username: nom, password: mot },
      })
    ).statusCode;

  beforeEach(async () => {
    b = await ouvrirBancOidc(moteur);
  });
  afterEach(async () => {
    await b.fermer();
  });

  it("ASVS 5.0 V6.2.8 et V6.2.5 : le mot de passe est vérifié exactement tel que saisi (espaces, casse, Unicode), sans troncature ni normalisation", async () => {
    const exact = `  Žlutý kůň, Pěl e${String.fromCharCode(0x301)} ódy 🙂 `;
    await createUser(b.t.base, "exact", exact);
    expect(await connexion("exact", exact)).toBe(200);
    for (const proche of [
      exact.trim(),
      exact.toLowerCase(),
      exact.normalize("NFC"),
      exact.slice(0, -1),
      `${exact}x`,
    ])
      expect(await connexion("exact", proche), JSON.stringify(proche)).toBe(401);
  });

  it("ASVS 5.0 V6.2.9 et ANSSI PG-078 R22 : un mot de passe de 128 caractères est accepté à la création du compte, au changement et à la connexion", async () => {
    const long = "Tr0ub4dor&3-".repeat(11).slice(0, 128);
    expect(long.length).toBe(128);
    await createUser(b.t.base, "long", "mot-de-passe-initial-1");
    const c = await b.main.inject({
      method: "POST",
      url: "/api/login-lite",
      remoteAddress: "10.99.250.1",
      headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin" },
      payload: { username: "long", password: "mot-de-passe-initial-1" },
    });
    const cookie = String(c.headers["set-cookie"]).split(";")[0] ?? "";
    const r = await b.main.inject({
      method: "POST",
      url: "/api/users/change-password",
      headers: { host: HOTE_PUBLIC, "sec-fetch-site": "same-origin", cookie },
      payload: { old_password: "mot-de-passe-initial-1", new_password: long },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(await connexion("long", long)).toBe(200);
    expect(await connexion("long", long.slice(0, 64))).toBe(401);
  });

  it("ASVS 5.0 V6.2.10 et ANSSI PG-078 R24 : aucun mécanisme n'expire un mot de passe de lui-même", async () => {
    const colonnes = await b.t.base.valeurs<[string]>(
      moteur === "sqlite"
        ? "SELECT name FROM pragma_table_info('users')"
        : "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'",
    );
    const noms = colonnes.map((l) => l[0]);
    expect(noms).toContain("must_change_pwd");
    expect(
      noms.filter((n) => /expir|rotat|pass.*(age|until|valid)|pwd.*(age|until|valid)/iu.test(n)),
    ).toEqual([]);
  });
});
