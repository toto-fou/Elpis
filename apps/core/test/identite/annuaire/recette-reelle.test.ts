// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/recette-reelle.test.ts — recette à la main contre de vrais annuaires LDAPS (389-DS, OpenLDAP…) décrits par le fichier JSON de `ELPIS_RECETTE_LDAP` ; sautée sans lui. */
import { readFileSync } from "node:fs";

import { createUser } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { groupeExiste } from "../../../src/identite/annuaire/appartenance";
import { fabriqueLdapts } from "../../../src/identite/annuaire/client";
import { authentifierParAnnuaire, PorteAnnuaire } from "../../../src/identite/annuaire/connexion";
import type { DependancesAnnuaire, ResultatAnnuaire } from "../../../src/identite/annuaire/connexion";
import { testerFournisseur } from "../../../src/identite/essai";
import { enregistrerSecret } from "../../../src/identite/fournisseurs";
import { validerFournisseur } from "../../../src/identite/reglages";
import type { FournisseurLdap } from "../../../src/identite/reglages";
import { journalMuet } from "../../aides";
import { cleCoffreDeTest, configDeTest, ldapValide } from "../aides";
import type { ConfigDeTest } from "../aides";

interface Compte {
  readonly login: string;
  readonly mdp: string;
}

interface AnnuaireReel {
  readonly nom: string;
  readonly preset: string;
  readonly url: string;
  readonly url_sans_tls?: string;
  readonly bind_dn: string;
  readonly secret: string;
  readonly user_base_dn: string;
  readonly user_filter: string;
  readonly attrs: Record<string, string>;
  readonly mode: string;
  readonly groupe: string;
  readonly groupe_absent: string;
  readonly membre: Compte;
  readonly hors_groupe: Compte;
  readonly expire?: Compte;
  readonly desactive?: Compte;
}

interface Recette {
  readonly ca: string;
  readonly annuaires: readonly AnnuaireReel[];
}

const CHEMIN = process.env["ELPIS_RECETTE_LDAP"] ?? "";
const RECETTE: Recette | null = CHEMIN ? (JSON.parse(readFileSync(CHEMIN, "utf8")) as Recette) : null;
const ACTEUR = { userId: null, username: null, ip: null };

describe.skipIf(RECETTE === null)("recette sur annuaires réels", () => {
  const recette = RECETTE ?? { ca: "", annuaires: [] };
  const caPem = recette.ca ? readFileSync(recette.ca, "utf8") : "";
  let t: BaseDeTest;
  let cfg: ConfigDeTest;
  const porte = new PorteAnnuaire();
  const dep = (): DependancesAnnuaire => ({
    base: t.base,
    fabrique: fabriqueLdapts(),
    maintenant: () => Date.now() / 1000,
    cookieSecure: () => true,
    journal: journalMuet,
    porte,
  });

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    cleCoffreDeTest();
    cfg = configDeTest({ https: true });
  });

  afterAll(async () => {
    cfg?.fermer();
    await t?.fermer();
  });

  /** Fournisseur validé par le vrai validateur, secret rangé au coffre avec la portée de son adresse. */
  async function fournisseur(
    a: AnnuaireReel,
    extra: Record<string, unknown> = {},
    secret = a.secret,
  ): Promise<FournisseurLdap> {
    const f = validerFournisseur(
      ldapValide({
        id: "recette",
        preset: a.preset,
        urls: [a.url],
        ca_pem: caPem,
        bind_dn: a.bind_dn,
        user_base_dn: a.user_base_dn,
        user_filter: a.user_filter,
        attrs: a.attrs,
        groups: { mode: a.mode },
        required_groups: [a.groupe],
        max_failures: 20,
        ...extra,
      }),
    );
    if (f.type !== "ldap") throw new Error("LDAP attendu");
    await enregistrerSecret(t.base, f, secret, ACTEUR);
    return f;
  }

  const auth = (f: FournisseurLdap, c: Compte): Promise<ResultatAnnuaire> =>
    authentifierParAnnuaire(dep(), c.login, c.mdp, [f]);

  describe.each(recette.annuaires.map((a) => [a.nom, a] as const))("%s", (_nom, a) => {
    it("un membre du groupe requis se connecte : clé stable, profil, appartenance", async () => {
      const f = await fournisseur(a);
      const r = await auth(f, a.membre);
      expect(r).toMatchObject({ type: "ok", appartenance: "oui" });
      if (r.type !== "ok") return;
      expect(r.profil.subject.length).toBeGreaterThanOrEqual(8);
      expect(r.profil.extUsername.toLowerCase()).toBe(a.membre.login.toLowerCase());
      const encore = await auth(f, { login: a.membre.login.toUpperCase(), mdp: a.membre.mdp });
      expect(encore).toMatchObject({ type: "ok", profil: { subject: r.profil.subject } });
    });

    it("mauvais mot de passe : refusé", async () => {
      const f = await fournisseur(a);
      expect(await auth(f, { login: a.membre.login, mdp: `${a.membre.mdp}x` })).toMatchObject({
        type: "refus",
        raison: "bad_password",
      });
    });

    it("identifiants hostiles : aucune entrée, aucun succès", async () => {
      const f = await fournisseur(a);
      for (const login of ["*", `${a.membre.login})(uid=*`, `*)(objectClass=*`, `${a.membre.login}*`])
        expect((await auth(f, { login, mdp: a.membre.mdp })).type, login).toBe("absent");
    });

    it("hors du groupe requis : la liaison réussit mais l'appartenance est « non »", async () => {
      const f = await fournisseur(a);
      expect(await auth(f, a.hors_groupe)).toMatchObject({ type: "ok", appartenance: "non" });
    });

    it("groupe requis qui n'existe pas : appartenance « inconnu » (jamais « non », qui suspendrait)", async () => {
      const f = await fournisseur(a, { required_groups: [a.groupe_absent] });
      expect(await auth(f, a.membre)).toMatchObject({ type: "ok", appartenance: "inconnu" });
      const cnx = await fabriqueLdapts()(f, a.url);
      try {
        await cnx.lier(a.bind_dn, a.secret);
        expect(await groupeExiste(cnx, a.groupe_absent)).toBe(false);
        expect(await groupeExiste(cnx, a.groupe)).toBe(true);
      } finally {
        await cnx.fermer();
      }
    });

    it("secret du compte de service faux : indisponible, jamais de liaison anonyme", async () => {
      const f = await fournisseur(a, {}, "pas-le-bon-secret");
      expect((await auth(f, a.membre)).type).toBe("indisponible");
    });

    it("sans l'autorité de l'annuaire : indisponible (certificat non reconnu)", async () => {
      const f = await fournisseur(a, { ca_pem: "" });
      expect((await auth(f, a.membre)).type).toBe("indisponible");
    });

    it.skipIf(a.url_sans_tls === undefined)("port sans TLS : indisponible", async () => {
      const f = await fournisseur(a, { urls: [a.url_sans_tls ?? a.url] });
      expect((await auth(f, a.membre)).type).toBe("indisponible");
    });

    it.skipIf(a.expire === undefined)(
      "mot de passe expiré : refusé par Elpis même si l'annuaire accepte la liaison",
      async () => {
        const f = await fournisseur(a);
        expect(await auth(f, a.expire ?? a.membre)).toMatchObject({
          type: "refus",
          raison: "password_expired",
        });
      },
    );

    it("bouton Tester : toutes les étapes passent avec un utilisateur d'essai, et le test est complet", async () => {
      const f = await fournisseur(a);
      const { type: _type, ...reglages } = f;
      const r = await testerFournisseur(
        { type: "ldap", ...reglages },
        { publicUrl: "https://elpis.exemple.lan", cookieSecure: true, adminsLocaux: 1 },
        {
          annuaire: {
            fabrique: (sortant) => fabriqueLdapts(sortant),
            secretEnregistre: () => Promise.resolve(null),
            utilisateur: a.membre.login,
            secret: a.secret,
          },
        },
      );
      expect(r.steps.filter((e) => e.level === "fail").map((e) => `${e.id} : ${e.detail}`)).toEqual([]);
      expect(r.steps.map((e) => e.id)).toEqual(
        expect.arrayContaining([
          "tls",
          "service_bind",
          "user_base",
          "groups",
          "test_user",
          "test_user_profile",
        ]),
      );
      expect(r).toMatchObject({ ok: true, complete: true });
    });

    it("bouton Tester : sans utilisateur d'essai, ou avec un secret faux, le test n'est pas complet", async () => {
      const f = await fournisseur(a);
      const { type: _type, ...reglages } = f;
      const contexte = { publicUrl: "https://elpis.exemple.lan", cookieSecure: true, adminsLocaux: 1 };
      const annuaire = { fabrique: fabriqueLdapts, secretEnregistre: () => Promise.resolve(null) };
      const sansUtilisateur = await testerFournisseur({ type: "ldap", ...reglages }, contexte, {
        annuaire: { ...annuaire, secret: a.secret },
      });
      expect(sansUtilisateur.complete).toBe(false);
      const secretFaux = await testerFournisseur({ type: "ldap", ...reglages }, contexte, {
        annuaire: { ...annuaire, secret: "pas-le-bon-secret", utilisateur: a.membre.login },
      });
      expect(secretFaux).toMatchObject({ ok: false, complete: false });
      expect(secretFaux.steps.find((e) => e.id === "service_bind")?.level).toBe("fail");
    });

    it.skipIf(a.desactive === undefined)("compte désactivé dans l'annuaire : aucune session", async () => {
      const f = await fournisseur(a);
      expect((await auth(f, a.desactive ?? a.membre)).type).not.toBe("ok");
    });
  });
});
