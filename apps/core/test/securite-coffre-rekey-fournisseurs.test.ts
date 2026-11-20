// SPDX-License-Identifier: MIT
/** apps/core/test/securite-coffre-rekey-fournisseurs.test.ts — un changement de clé du coffre garde actifs les fournisseurs dont le secret enregistré est celui du dernier test, et laisse les autres « test à refaire » (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { randomBytes } from "node:crypto";

import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { cleCoffre, configurerCoffre } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enregistrerSecret, enregistrerTestReussi, testReussiCourant } from "../src/identite/fournisseurs";
import { validerFournisseur } from "../src/identite/reglages";
import type { Fournisseur } from "../src/identite/reglages";
import { rechiffrerCoffre } from "../src/secrets/cle";
import { oidcValide } from "./identite/aides";
import { MOTEURS, URL_PUBLIQUE } from "./identite/banc";

const ACTEUR = { userId: null, username: null };

function poserCle(): void {
  configurerCoffre({
    cleEnv: randomBytes(32).toString("base64"),
    systeme: "/nonexistent/elpis-vault.key",
    repli: "/nonexistent/elpis/.vault.key",
  });
}

describe.each(MOTEURS)("changement de clé du coffre et fournisseurs (%s)", (moteur) => {
  let t: BaseDeTest;
  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
  });
  afterEach(async () => {
    await t.fermer();
  });

  const fournisseur = (id: string): Fournisseur => validerFournisseur(oidcValide({ id }));

  it("le test reste valable pour un secret inchangé, et jamais pour un autre secret", async () => {
    poserCle();
    const ancienne = cleCoffre();
    if (ancienne === null) throw new Error("clé absente");
    const [a, b, c] = [fournisseur("a"), fournisseur("b"), fournisseur("c")] as [
      Fournisseur,
      Fournisseur,
      Fournisseur,
    ];
    for (const f of [a, b, c]) {
      await enregistrerSecret(t.base, f, "meme-secret", ACTEUR);
      await enregistrerTestReussi(t.base, f, URL_PUBLIQUE, 1000);
    }
    await enregistrerSecret(t.base, c, "autre-secret", ACTEUR);
    const rangees = async (): Promise<string[]> =>
      (
        await t.base.all<{ tested_hash: string }>(
          "SELECT tested_hash FROM auth_provider_state ORDER BY provider_id",
        )
      ).map((l) => String(JSON.parse(l.tested_hash).s));
    const [sa, sb] = await rangees();
    expect(sa).not.toBe(sb);
    poserCle();
    const courante = cleCoffre();
    if (courante === null) throw new Error("clé absente");
    const r = await rechiffrerCoffre(t.base, ancienne, courante);
    expect(r).toMatchObject({ echecs: 0, restants: 0 });
    expect(await testReussiCourant(t.base, a, URL_PUBLIQUE)).toBe(true);
    expect(await testReussiCourant(t.base, b, URL_PUBLIQUE)).toBe(true);
    expect(await testReussiCourant(t.base, c, URL_PUBLIQUE)).toBe(false);
    const [na, nb, nc] = await rangees();
    expect(na).not.toBe(sa);
    expect(na).not.toBe(nb);
    expect(nc).not.toBe(undefined);
  });

  it("une base pas encore migrée (table des états absente) : le changement de clé réussit", async () => {
    poserCle();
    const ancienne = cleCoffre();
    if (ancienne === null) throw new Error("clé absente");
    await t.base.exec("DROP TABLE auth_provider_state");
    poserCle();
    const courante = cleCoffre();
    if (courante === null) throw new Error("clé absente");
    expect(await rechiffrerCoffre(t.base, ancienne, courante)).toMatchObject({ echecs: 0, restants: 0 });
  });
});
