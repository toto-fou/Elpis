// SPDX-License-Identifier: MIT
/** apps/core/test/securite-oidc-refus-retour.test.ts — au retour SSO, les refus hostiles ne remplissent ni l'audit ni le journal, un fournisseur éteint reste un 404 silencieux, et les requêtes hostiles d'une adresse ne bloquent pas les retours légitimes de la même adresse (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lignesAuditRecentes, lignesJournal } from "./aides";
import { MOTEURS } from "./identite/banc";
import { adresseNeuve, COOKIE_LIAISON, ELPIS, ouvrirBancOidc, URL_PUBLIQUE } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

const BORNE_AUDIT = 2;
const BORNE_JOURNAL = 2;

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("refus du retour SSO (%s)", (moteur) => {
  let b: BancOidc;
  const denies = (): Record<string, unknown>[] => lignesAuditRecentes({ actionPrefix: "auth.login.denied" });
  const sso = (): string[] => lignesJournal.filter((l) => l.includes("connexion SSO"));
  const hostile = (i: number, cookie: string | undefined, adresse: string) =>
    b.retourner(`${URL_PUBLIQUE}/x?code=x&state=${String(i).padStart(43, "A")}`, { cookie, adresse });

  beforeEach(async () => {
    lignesJournal.length = 0;
  });
  afterEach(async () => {
    await b.fermer();
  });

  it("300 retours hostiles d'une adresse (sans cookie, avec cookie inventé) : lignes d'audit et de journal bornées", async () => {
    b = await ouvrirBancOidc(moteur);
    const adresse = adresseNeuve();
    const inventé = `${COOKIE_LIAISON}=${"a".repeat(43)}`;
    for (let i = 0; i < 300; i++) await hostile(i, i % 2 === 0 ? undefined : inventé, adresse);
    expect(denies().length).toBeLessThanOrEqual(BORNE_AUDIT);
    expect(sso().length).toBeLessThanOrEqual(BORNE_JOURNAL);
  });

  it("fournisseur éteint : 404 à chaque retour, quel que soit leur nombre, sans audit ni journal", async () => {
    b = await ouvrirBancOidc(moteur, { actif: false });
    const adresse = adresseNeuve();
    const inventé = `${COOKIE_LIAISON}=${"a".repeat(43)}`;
    const codes = new Set<number>();
    for (let i = 0; i < 120; i++) codes.add((await hostile(i, inventé, adresse)).statusCode);
    expect([...codes]).toEqual([404]);
    expect(denies()).toEqual([]);
    expect(sso()).toEqual([]);
  });

  it("derrière une même adresse, des retours hostiles ne bloquent pas le retour d'un flux vivant de son navigateur", async () => {
    b = await ouvrirBancOidc(moteur);
    const adresse = adresseNeuve();
    const d = await b.demarrer({ adresse });
    const { retour } = b.idp.autoriser(d.url ?? "", ELPIS("sub-collegue"));
    for (let i = 0; i < 80; i++) await hostile(i, undefined, adresse);
    const r = await b.retourner(retour, { cookie: d.cookie, adresse });
    expect(r.statusCode, r.body).toBe(200);
    expect(await b.utilisateurs()).toEqual(["chef", "sub-collegue"]);
  });
});
