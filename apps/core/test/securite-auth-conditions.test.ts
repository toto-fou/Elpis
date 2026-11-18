// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-conditions.test.ts — chaque condition d'activation d'un fournisseur est aussi une condition de lecture : posé à la main dans le fichier, un fournisseur allumé auquel une condition manque n'est pas actif. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { enregistrerTestReussi, fournisseursActifs } from "../src/identite/fournisseurs";
import { validerFournisseur } from "../src/identite/reglages";
import { ldapValide } from "./identite/aides";
import { MOTEURS, ouvrirBanc, URL_PUBLIQUE } from "./identite/banc";
import type { Banc } from "./identite/banc";

describe.each(MOTEURS)("conditions de lecture d'un fournisseur allumé (%s)", (moteur) => {
  let b: Banc;
  beforeAll(async () => {
    b = await ouvrirBanc(moteur);
  });
  afterAll(async () => {
    await b.fermer();
  });

  const allume = (extra: Record<string, unknown> = {}) =>
    validerFournisseur(ldapValide({ required_groups: ["elpis"], enabled: true, ...extra }));
  const ids = async (secure = true): Promise<string[]> =>
    (await fournisseursActifs(b.t.base, () => secure)).map((f) => f.id);

  it("toutes les conditions réunies : actif ; une condition retirée à la fois : écarté", async () => {
    const f = allume();
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [{ ...f, enabled: false }] } });
    expect(
      (await b.appeler("PUT", "/api/admin/auth/providers/annuaire/secret", { secret: "secret-de-service-1" }))
        .statusCode,
    ).toBe(200);
    await enregistrerTestReussi(b.t.base, f, URL_PUBLIQUE);
    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [f] } });
    expect(await ids()).toEqual(["annuaire"]);

    expect(await ids(false), "cookie non sécurisé").toEqual([]);

    b.cfg.ecrire({ auth: { public_url: "", providers: [f] } });
    expect(await ids(), "adresse publique").toEqual([]);

    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [allume({ required_groups: [] })] } });
    expect(await ids(), "groupe requis").toEqual([]);

    b.cfg.ecrire({
      auth: {
        public_url: URL_PUBLIQUE,
        providers: [allume({ label: "Autre", bind_dn: "uid=autre,dc=exemple,dc=lan" })],
      },
    });
    expect(await ids(), "test réussi sur les réglages courants").toEqual([]);

    b.cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [f] } });
    await b.t.base.run("UPDATE users SET suspended_at=1 WHERE id=?", [b.chef]);
    expect(await ids(), "administrateur local actif").toEqual([]);
    await b.t.base.run("UPDATE users SET suspended_at=0 WHERE id=?", [b.chef]);
    expect(await ids()).toEqual(["annuaire"]);

    await b.t.base.run("DELETE FROM vault_secrets WHERE name='auth-annuaire'");
    expect(await ids(), "secret").toEqual([]);
  });
});
