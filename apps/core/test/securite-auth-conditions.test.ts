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
    validerFournisseur(ldapValide({ required_groups: ["cn=elpis"], enabled: true, ...extra }));
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

  it("HTTPS doit être en service : cookie `Secure` seul ne suffit pas, ni à l'activation ni à la lecture ni dans les prérequis affichés", async () => {
    const f = allume();
    const ecrire = (https: boolean, enabled: boolean): void =>
      b.cfg.ecrire({
        auth: { public_url: URL_PUBLIQUE, providers: [{ ...f, enabled }] },
        security: { https: { enabled: https }, session: { same_site: "none" } },
      });
    ecrire(true, false);
    expect(
      (await b.appeler("PUT", "/api/admin/auth/providers/annuaire/secret", { secret: "secret-de-service-1" }))
        .statusCode,
    ).toBe(200);
    await enregistrerTestReussi(b.t.base, f, URL_PUBLIQUE);
    ecrire(false, false);
    const vue = (await b.appeler("GET", "/api/admin/auth")).json<{
      prerequisites: { cookie_secure: boolean };
    }>();
    expect(vue.prerequisites.cookie_secure).toBe(false);
    const refus = await b.appeler("POST", "/api/admin/auth/providers/annuaire/enable");
    expect(refus.statusCode).toBe(409);
    ecrire(false, true);
    expect(await ids(), "allumé à la main sans HTTPS").toEqual([]);
    ecrire(true, false);
    expect((await b.appeler("POST", "/api/admin/auth/providers/annuaire/enable")).statusCode).toBe(200);
    expect(await ids()).toEqual(["annuaire"]);
  });
});
