// SPDX-License-Identifier: MIT
/** apps/core/test/securite-droits-second-facteur.test.ts — devenir administrateur par SSO exige que le jeton reçu prouve un second facteur, jamais le seul réglage du fournisseur (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adminAdmis, adminSansPreuve } from "../src/identite/correspondance";
import { connecterParOidc } from "../src/identite/oidc/connexion";
import { resultatEssaiBlanc } from "../src/identite/oidc/essai-blanc";
import { RefusOidc } from "../src/identite/oidc/refus";
import { secondFacteurProuve } from "../src/identite/oidc/revendications";
import { validerFournisseur } from "../src/identite/reglages";
import type { FournisseurOidc } from "../src/identite/reglages";
import { appliquerDroits } from "../src/identite/droits";
import { lectureOidc } from "../src/identite/correspondance";
import { ELPIS, ouvrirBancOidc } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { MOTEURS } from "./identite/banc";
import { oidcValide } from "./identite/aides";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

const ROLES = { roles: { enabled: true, admin_groups: ["admins"], moderator_groups: [] } };
const f = (extra: Record<string, unknown> = {}): FournisseurOidc =>
  validerFournisseur(oidcValide({ required_groups: ["elpis"], ...ROLES, ...extra })) as FournisseurOidc;

describe("second facteur prouvé par le jeton", () => {
  it("le jeton prouve un second facteur avec `mfa` / `mca`, deux familles RFC 8176 différentes, ou un `acr` exigé et non faible", () => {
    const g = f({ required_acr: ["urn:gold"] });
    for (const amr of [["mfa"], ["MCA"], ["pwd", "otp"], ["pin", "hwk"], ["otp", "face"], ["kba", "fpt"]])
      expect(secondFacteurProuve({ amr }, g), amr.join()).toBe(true);
    expect(secondFacteurProuve({ acr: "urn:gold" }, g)).toBe(true);
  });

  it("un seul facteur, deux méthodes d'une même famille, des méthodes sans famille ou un `acr` faible ou non exigé ne prouvent rien", () => {
    const g = f({ required_acr: ["1", "0"] });
    for (const amr of [["pwd"], ["otp"], ["pwd", "pin"], ["otp", "sms"], ["pwd", "geo"], ["geo", "rba"], []])
      expect(secondFacteurProuve({ amr }, g), amr.join()).toBe(false);
    for (const claims of [{ acr: "1" }, { acr: "0" }, { acr: "urn:gold" }, { amr: "mfa" }, {}])
      expect(secondFacteurProuve(claims, g), JSON.stringify(claims)).toBe(false);
  });

  it("les groupes d'administrateurs ne sont admis qu'avec `mfa` / `mca` seuls en `amr` ou un `acr` sans niveau faible", () => {
    for (const ok of [
      { required_amr: ["mfa"] },
      { required_amr: ["MFA", "mca"] },
      { required_acr: ["urn:gold"] },
    ])
      expect(adminAdmis(f(ok)), JSON.stringify(ok)).toBe(true);
    for (const non of [
      {},
      { required_amr: ["pwd", "otp"] },
      { required_amr: ["otp"] },
      { required_amr: ["pwd", "mfa"] },
      { required_acr: ["1"] },
      { required_acr: ["0", "urn:gold"] },
    ])
      expect(adminAdmis(f(non)), JSON.stringify(non)).toBe(false);
  });

  it("un jeton qui liste un groupe d'administrateurs sans preuve est repéré, avec preuve ou sans ce groupe non", () => {
    const g = f({ required_acr: ["urn:gold"] });
    expect(adminSansPreuve(g, ["elpis", "admins"], false)).toBe(true);
    expect(adminSansPreuve(g, ["elpis", "admins"], true)).toBe(false);
    expect(adminSansPreuve(g, ["elpis"], false)).toBe(false);
    expect(adminSansPreuve(g, null, false)).toBe(false);
  });

  it("une connexion SSO dont le jeton liste un groupe d'administrateurs sans preuve est refusée `mfa_required` (cause `admin_without_mfa`), avant tout compte", async () => {
    const g = f({ required_acr: ["urn:gold"] });
    const retour = (secondFacteur: boolean) => ({ groupesComplets: ["elpis", "admins"], secondFacteur });
    const echec = await connecterParOidc(
      {} as never,
      { fournisseur: g, retour: retour(false) } as never,
    ).catch((e: unknown) => e);
    expect(echec).toBeInstanceOf(RefusOidc);
    expect(echec).toMatchObject({ code: "mfa_required", cause_: "admin_without_mfa" });
  });

  it("l'essai à blanc dit la vérité : refusé `mfa_required` sans preuve", async () => {
    const g = f({ required_acr: ["urn:gold"] });
    const retour = (secondFacteur: boolean) =>
      ({
        profil: { subject: "s", issuer: "i", extUsername: "s", extEmail: "", extName: "" },
        appartenance: "oui",
        vue: {
          iss: "",
          sujet: "s",
          identifiant: "s",
          nom: "",
          email: "",
          emailVerifie: false,
          acr: null,
          amr: [],
          groupes: null,
          sujetEstIdentifiant: false,
        },
        groupesComplets: ["elpis", "admins"],
        secondFacteur,
        idToken: null,
        idpSid: null,
        sub: "s",
      }) as Parameters<typeof resultatEssaiBlanc>[2];
    const base = { all: async () => [], get: async () => undefined } as never;
    const sans = await resultatEssaiBlanc(base, g, retour(false), 1);
    expect(sans.decision).toMatchObject({ outcome: "refuse", reason: "mfa_required" });
    expect(sans.ok).toBe(false);
  });

  it("les droits ne bougent pas quand le jeton reçu liste un groupe d'administrateurs sans preuve", async () => {
    const g = f({ required_acr: ["urn:gold"] });
    const lecture = lectureOidc(g, ["elpis", "admins"]);
    const dep = { base: {} } as never;
    const r = await appliquerDroits(dep, {
      fournisseur: g,
      uid: 1,
      lecture,
      mode: "connexion",
      secondFacteur: false,
    });
    expect(r).toEqual({ role: null, ajoutes: [], retires: [] });
  });
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)(
  "administrateur par SSO selon le jeton reçu (%s)",
  (moteur) => {
    let b: BancOidc;
    const niveau = async (nom: string): Promise<number> =>
      Number(
        (await b.t.base.get<{ is_admin: number }>("SELECT is_admin FROM users WHERE username=?", [nom]))
          ?.is_admin,
      );

    beforeEach(async () => {
      b = await ouvrirBancOidc(moteur);
    });
    afterEach(async () => {
      await b.fermer();
    });

    it("réglage `pwd otp` et jeton `amr` `pwd` : pas administrateur", async () => {
      await b.reglages({ ...ROLES, required_amr: ["pwd", "otp"] });
      const r = await b.connecter(ELPIS("sub-a", { groups: ["elpis", "admins"], amr: ["pwd"] }));
      expect(r.retour.statusCode).toBe(200);
      expect(await niveau("sub-a")).toBe(0);
    });

    it("réglage `otp` seul et jeton `otp` : pas administrateur", async () => {
      await b.reglages({ ...ROLES, required_amr: ["otp"] });
      await b.connecter(ELPIS("sub-b", { groups: ["elpis", "admins"], amr: ["otp"] }));
      expect(await niveau("sub-b")).toBe(0);
    });

    it("réglage `acr` `1` et jeton `acr` `1` : pas administrateur", async () => {
      await b.reglages({ ...ROLES, required_acr: ["1"] });
      const rc = await b.connecter(ELPIS("sub-c", { groups: ["elpis", "admins"], acr: "1" }));
      expect(rc.retour.statusCode, String(rc.retour.headers.location)).toBe(200);
      expect(await niveau("sub-c")).toBe(0);
    });

    it("réglage `mfa` et jeton `mfa` : administrateur", async () => {
      await b.reglages({ ...ROLES, required_amr: ["mfa"] });
      await b.connecter(ELPIS("sub-d", { groups: ["elpis", "admins"], amr: ["mfa"] }));
      expect(await niveau("sub-d")).toBe(1);
    });

    it("réglage `acr` exigé et jeton avec `pwd` et `otp` reçus : administrateur", async () => {
      await b.reglages({ ...ROLES, required_acr: ["urn:gold"] });
      await b.connecter(
        ELPIS("sub-e", { groups: ["elpis", "admins"], acr: "urn:gold", amr: ["pwd", "otp"] }),
      );
      expect(await niveau("sub-e")).toBe(1);
    });
  },
);
