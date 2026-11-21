// SPDX-License-Identifier: MIT
/** apps/core/test/securite-droits-second-facteur.test.ts — devenir administrateur par SSO exige que le jeton reçu prouve un second facteur (`amr` fort, ou niveau `acr` déclaré par l'administrateur), jamais le seul réglage du fournisseur ni le nom d'un niveau (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { secondFacteurPourTous } from "@elpis/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adminAdmis, adminSansPreuve } from "../src/identite/correspondance";
import { connecterParOidc } from "../src/identite/oidc/connexion";
import { resultatEssaiBlanc } from "../src/identite/oidc/essai-blanc";
import { RefusOidc } from "../src/identite/oidc/refus";
import { preuveSecondFacteur, secondFacteurSatisfait } from "../src/identite/oidc/revendications";
import { validerFournisseur } from "../src/identite/reglages";
import type { Fournisseur } from "../src/identite/reglages";
import { appliquerDroits } from "../src/identite/droits";
import { ELPIS, ouvrirBancOidc } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { MOTEURS } from "./identite/banc";
import { oidcValide } from "./identite/aides";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

const ROLES = { roles: { enabled: true, admin_groups: ["admins"], moderator_groups: [] } };
const f = (extra: Record<string, unknown> = {}): Fournisseur =>
  validerFournisseur(oidcValide({ required_groups: ["elpis"], ...ROLES, ...extra })) as Fournisseur;
const prouve = (claims: Record<string, unknown>, g: Fournisseur): boolean =>
  preuveSecondFacteur(claims, g) !== null;

describe("second facteur prouvé par le jeton", () => {
  it("le jeton prouve un second facteur avec `mfa` / `mca`, deux familles RFC 8176 différentes, ou un `acr` déclaré par l'administrateur", () => {
    const g = f({ required_acr: ["loa-2", "loa-5"], mfa_acr: ["loa-5"] });
    for (const amr of [["mfa"], ["MCA"], ["pwd", "otp"], ["pin", "hwk"], ["otp", "face"], ["kba", "fpt"]])
      expect(preuveSecondFacteur({ amr }, g), amr.join()).toBe("amr");
    expect(preuveSecondFacteur({ acr: "loa-5" }, g)).toBe("acr");
    expect(preuveSecondFacteur({ acr: "loa-5", amr: ["pwd"] }, g)).toBe("acr");
  });

  it("un seul facteur, deux méthodes d'une même famille, des méthodes sans famille ou un `acr` non déclaré ne prouvent rien, quel que soit le nom du niveau", () => {
    const g = f({ required_acr: ["0", "1", "2", "3", "loa-2", "loa-5", "urn:gold", "mfa"] });
    for (const amr of [["pwd"], ["otp"], ["pwd", "pin"], ["otp", "sms"], ["pwd", "geo"], ["geo", "rba"], []])
      expect(prouve({ amr }, g), amr.join()).toBe(false);
    for (const acr of ["0", "1", "2", "3", "loa-2", "loa-5", "urn:gold", "mfa"])
      expect(prouve({ acr }, g), acr).toBe(false);
    for (const claims of [{ amr: "mfa" }, {}]) expect(prouve(claims, g), JSON.stringify(claims)).toBe(false);
    const declare = f({ required_acr: ["loa-2", "loa-5"], mfa_acr: ["loa-5"] });
    for (const claims of [{ acr: "loa-2" }, { acr: "LOA-5" }, { acr: " loa-5" }, { acr: ["loa-5"] }])
      expect(prouve(claims, declare), JSON.stringify(claims)).toBe(false);
  });

  it("les groupes d'administrateurs ne sont admis que si le fournisseur est invité à un second facteur : possession, inhérence, `mfa` / `mca` en `amr`, ou au moins un niveau `acr` déclaré comme preuve", () => {
    for (const ok of [
      { required_amr: ["mfa"] },
      { required_amr: ["MFA", "mca"] },
      { required_amr: ["pwd", "otp"] },
      { required_amr: ["otp"] },
      { required_amr: ["pwd", "mfa"] },
      { required_amr: ["face"] },
      { mfa_acr: ["loa-5"] },
      { required_acr: ["loa-2", "loa-5"], mfa_acr: ["loa-5"] },
      { required_acr: ["1", "2"], mfa_acr: ["2"] },
    ])
      expect(adminAdmis(f(ok)), JSON.stringify(ok)).toBe(true);
    for (const non of [
      {},
      { required_amr: ["pwd"] },
      { required_amr: ["pwd", "pin", "kba"] },
      { required_amr: ["geo"] },
      { required_acr: ["1"] },
      { required_acr: ["0", "1"] },
      { required_acr: ["2"] },
      { required_acr: ["urn:gold"] },
      { required_acr: ["loa-2", "loa-5"] },
      { required_acr: ["loa-5"], required_amr: ["pwd"] },
    ])
      expect(adminAdmis(f(non)), JSON.stringify(non)).toBe(false);
  });

  it("second facteur garanti pour tous les comptes seulement si chaque jeton admis à la connexion le prouve : tous les `acr` exigés déclarés comme preuve, ou tous les `amr` exigés `mfa` / `mca`", () => {
    const VECTEURS: [string[], string[], string[], boolean][] = [
      [[], ["pwd", "otp"], [], false],
      [[], ["otp", "hwk"], [], false],
      [[], ["pwd", "mfa"], [], false],
      [[], ["mfa"], [], true],
      [[], ["MFA", "mca"], [], true],
      [["urn:gold"], [], [], false],
      [["urn:gold"], [], ["urn:gold"], true],
      [["2"], [], [], false],
      [["2"], [], ["2"], true],
      [["1", "2"], [], ["2"], false],
      [["loa-2", "loa-5"], [], [], false],
      [["loa-2", "loa-5"], [], ["loa-5"], false],
      [["loa-5"], [], ["loa-5"], true],
      [["loa-2", "loa-5"], [], ["loa-2", "loa-5"], true],
      [["urn:gold"], ["pwd"], ["urn:gold"], true],
      [["0", "urn:gold"], ["mfa"], [], true],
      [["0", "urn:gold"], ["pwd", "otp"], ["urn:gold"], false],
      [["1"], ["pwd", "otp"], [], false],
      [["0"], ["pwd"], [], false],
      [[], [], ["loa-5"], false],
      [[], ["pwd"], ["loa-5"], false],
      [[], [], [], false],
    ];
    for (const [acr, amr, mfa, tous] of VECTEURS) {
      const g = f({ required_acr: acr, required_amr: amr, mfa_acr: mfa });
      const nom = JSON.stringify([acr, amr, mfa]);
      expect(secondFacteurPourTous(g), nom).toBe(tous);
      const niveaux = acr.length ? acr : [undefined, "autre", ...mfa];
      const jetons = niveaux.flatMap((a) =>
        (amr.length ? amr.map((m) => [m]) : [undefined]).map((m) => ({
          ...(a === undefined ? {} : { acr: a }),
          ...(m === undefined ? {} : { amr: m }),
        })),
      );
      const admis = jetons.filter((c) => secondFacteurSatisfait(c, g));
      expect(admis.length, nom).toBe(jetons.length);
      expect(
        admis.every((c) => prouve(c, g)),
        nom,
      ).toBe(tous);
    }
  });

  it("un jeton qui liste un groupe d'administrateurs sans preuve est repéré, avec preuve ou sans ce groupe non", () => {
    const g = f({ mfa_acr: ["urn:gold"] });
    expect(adminSansPreuve(g, ["elpis", "admins"], false)).toBe(true);
    expect(adminSansPreuve(g, ["elpis", "admins"], true)).toBe(false);
    expect(adminSansPreuve(g, ["elpis"], false)).toBe(false);
    expect(adminSansPreuve(g, null, false)).toBe(false);
  });

  it("une connexion SSO dont le jeton liste un groupe d'administrateurs sans preuve est refusée `mfa_required` (cause `admin_without_mfa`), avant tout compte", async () => {
    const g = f({ mfa_acr: ["urn:gold"] });
    const retour = (secondFacteur: boolean) => ({ groupesComplets: ["elpis", "admins"], secondFacteur });
    const echec = await connecterParOidc(
      {} as never,
      { fournisseur: g, retour: retour(false) } as never,
    ).catch((e: unknown) => e);
    expect(echec).toBeInstanceOf(RefusOidc);
    expect(echec).toMatchObject({ code: "mfa_required", cause_: "admin_without_mfa" });
  });

  it("l'essai à blanc dit la vérité : refusé `mfa_required` sans preuve", async () => {
    const g = f({ mfa_acr: ["urn:gold"] });
    const retour = (secondFacteur: boolean) =>
      ({
        profil: { subject: "s", issuer: "i", extUsername: "s" },
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
          preuveSecondFacteur: null,
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
    const g = f({ mfa_acr: ["urn:gold"] });
    const dep = { base: {} } as never;
    const r = await appliquerDroits(dep, {
      fournisseur: g,
      uid: 1,
      groupes: ["elpis", "admins"],
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

    const refuseMfa = async (nom: string, claims: { groups: string[]; amr?: string[]; acr?: string }) => {
      const r = await b.connecter(ELPIS(nom, claims));
      expect(String(r.retour.headers.location)).toMatch(/^\/\?auth_error=mfa_required&ref=/u);
      expect(String(r.retour.headers["set-cookie"] ?? "")).not.toContain("mcpwebui_session");
      expect(await b.t.base.all("SELECT id FROM users WHERE username=?", [nom])).toEqual([]);
    };

    it("réglage `pwd otp` et jeton `amr` `pwd` : refusé `mfa_required`, aucun compte", async () => {
      await b.reglages({ ...ROLES, required_amr: ["pwd", "otp"] });
      await refuseMfa("sub-a", { groups: ["elpis", "admins"], amr: ["pwd"] });
    });

    it("réglage `pwd otp` et jeton `amr` `pwd` `otp` : administrateur", async () => {
      await b.reglages({ ...ROLES, required_amr: ["pwd", "otp"] });
      await b.connecter(ELPIS("sub-f", { groups: ["elpis", "admins"], amr: ["pwd", "otp"] }));
      expect(await niveau("sub-f")).toBe(1);
    });

    it("réglage `otp` seul et jeton `otp` : refusé `mfa_required` (un seul facteur), aucun compte", async () => {
      await b.reglages({ ...ROLES, required_amr: ["otp"] });
      await refuseMfa("sub-b", { groups: ["elpis", "admins"], amr: ["otp"] });
    });

    it("réglage `pwd` seul : le fournisseur n'est pas invité à un second facteur, groupes d'administrateurs ignorés", async () => {
      await b.reglages({ ...ROLES, required_amr: ["pwd"] });
      const r = await b.connecter(ELPIS("sub-g", { groups: ["elpis", "admins"], amr: ["pwd"] }));
      expect(r.retour.statusCode).toBe(200);
      expect(await niveau("sub-g")).toBe(0);
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

    it("réglage `PWD OTP` en capitales : la casse des `amr` ne compte pas, jeton `pwd` `otp` administrateur", async () => {
      await b.reglages({ ...ROLES, required_amr: ["PWD", "OTP"] });
      await b.connecter(ELPIS("sub-h", { groups: ["elpis", "admins"], amr: ["pwd", "otp"] }));
      expect(await niveau("sub-h")).toBe(1);
    });

    it("niveaux exigés `loa-2 loa-5` sans niveau déclaré comme preuve : groupes d'administrateurs ignorés, ni `loa-2` ni `loa-5` ne donnent l'administration", async () => {
      await b.reglages({ ...ROLES, required_acr: ["loa-2", "loa-5"] });
      for (const [nom, acr] of [
        ["sub-i", "loa-2"],
        ["sub-j", "loa-5"],
      ] as const) {
        const r = await b.connecter(ELPIS(nom, { groups: ["elpis", "admins"], acr }));
        expect(r.retour.statusCode, String(r.retour.headers.location)).toBe(200);
        expect(await niveau(nom), acr).toBe(0);
      }
    });

    it("`loa-5` déclaré comme preuve : jeton `loa-2` refusé `mfa_required`, aucun compte ; jeton `loa-5` administrateur", async () => {
      await b.reglages({ ...ROLES, required_acr: ["loa-2", "loa-5"], mfa_acr: ["loa-5"] });
      await refuseMfa("sub-k", { groups: ["elpis", "admins"], acr: "loa-2" });
      await b.connecter(ELPIS("sub-l", { groups: ["elpis", "admins"], acr: "loa-5" }));
      expect(await niveau("sub-l")).toBe(1);
    });

    it("un `acr` « 2 » non déclaré ne prouve rien : refusé `mfa_required` ; le même jeton avec `pwd` `otp` administrateur", async () => {
      await b.reglages({ ...ROLES, required_acr: ["1", "2"], required_amr: ["pwd", "otp"] });
      await refuseMfa("sub-m", { groups: ["elpis", "admins"], acr: "2", amr: ["pwd"] });
      await b.connecter(ELPIS("sub-n", { groups: ["elpis", "admins"], acr: "2", amr: ["pwd", "otp"] }));
      expect(await niveau("sub-n")).toBe(1);
    });

    it("un niveau déclaré n'empêche pas la preuve par `amr` : jeton d'un niveau non déclaré avec `pwd` et `otp` administrateur", async () => {
      await b.reglages({ ...ROLES, required_acr: ["urn:gold", "urn:silver"], mfa_acr: ["urn:silver"] });
      await b.connecter(
        ELPIS("sub-e", { groups: ["elpis", "admins"], acr: "urn:gold", amr: ["pwd", "otp"] }),
      );
      expect(await niveau("sub-e")).toBe(1);
    });
  },
);
