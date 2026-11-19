// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/connexion.test.ts — l'authentification par annuaire : l'annuaire qui contient l'identifiant décide, l'utilisateur se lie sur sa propre connexion, le compteur par entrée coupe avant l'annuaire, l'état et l'appartenance sont jugés avant toute liaison de l'utilisateur, tout est fermé (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  annuairesActifs,
  authentifierParAnnuaire,
  AUTHENTIFICATIONS_EN_ATTENTE_MAX,
  AUTHENTIFICATIONS_EN_COURS_MAX,
} from "../../../src/identite/annuaire/connexion";
import { supprimerSecretFournisseur } from "../../../src/identite/fournisseurs";
import { ErreurAnnuaire } from "../../../src/identite/annuaire/erreur";
import { MOTEURS } from "../banc";
import { AnnuaireFactice, BASE, DN_SERVICE, GROUPE, UUID } from "./annuaire-factice";
import { ouvrirBancAnnuaire } from "./banc-annuaire";
import type { BancAnnuaire } from "./banc-annuaire";

const MDP = "mot-de-passe-de-jean";
const ANCRE = "ldap:cn=users,dc=exemple,dc=lan#entryuuid";

describe.each(MOTEURS)("authentifierParAnnuaire (%s)", (moteur) => {
  let b: BancAnnuaire;
  let annuaire: AnnuaireFactice;

  const auth = (id: string, mdp: string = MDP) => authentifierParAnnuaire(b.dep(), id, mdp);
  const echecs = () => b.t.base.valeurs("SELECT provider_id, subject, count FROM auth_failures");

  async function ouvrir(extras: Record<string, unknown>[] = [{}]): Promise<void> {
    annuaire = new AnnuaireFactice();
    annuaire.ajouter({ uid: "jean", cle: UUID(1), mdp: MDP, groupes: [GROUPE] });
    b = await ouvrirBancAnnuaire(moteur, extras, annuaire);
  }
  beforeEach(() => ouvrir());
  afterEach(async () => {
    await b.fermer();
  });

  it("succès : profil de l'entrée, ancre, appartenance ; service et utilisateur sur deux connexions, toutes fermées", async () => {
    expect(await auth("jean")).toMatchObject({
      type: "ok",
      appartenance: "oui",
      profil: {
        subject: UUID(1),
        issuer: ANCRE,
        extUsername: "jean",
        extEmail: "jean@exemple.lan",
        extName: "Nom jean",
      },
    });
    expect(annuaire.traces.map((t) => t.liaisons)).toEqual([[DN_SERVICE], [`uid=jean,${BASE}`]]);
    expect(annuaire.traces.every((t) => t.ferme)).toBe(true);
    expect(await echecs()).toEqual([]);
  });

  it("la casse de l'identifiant tapé ne change pas l'entrée", async () => {
    expect(await auth("JEAN")).toMatchObject({
      type: "ok",
      profil: { subject: UUID(1), extUsername: "jean" },
    });
  });

  it("mauvais mot de passe : refus bad_password, compté ; la réussite remet le compteur à zéro", async () => {
    expect(await auth("jean", "faux")).toEqual({
      type: "refus",
      raison: "bad_password",
      fournisseurId: "annuaire",
    });
    expect(await echecs()).toEqual([["annuaire", UUID(1), 1]]);
    expect(await auth("jean")).toMatchObject({ type: "ok" });
    expect(await echecs()).toEqual([]);
  });

  it("identifiant inconnu : absent, aucun mot de passe d'utilisateur n'est envoyé", async () => {
    expect(await auth("personne")).toEqual({ type: "absent" });
    expect(annuaire.liaisonsUtilisateur).toEqual([]);
    expect(annuaire.traces.every((t) => t.ferme)).toBe(true);
  });

  it("code 49 reçu sur la RECHERCHE : l'annuaire est indisponible, jamais « absent » (le suivant n'est pas essayé)", async () => {
    await b.fermer();
    await ouvrir([{}, {}]);
    annuaire.rechercheUtilisateurEnErreur = new ErreurAnnuaire("identifiants", { code: 49 });
    expect(await auth("jean")).toEqual({ type: "indisponible" });
    expect(annuaire.liaisonsUtilisateur).toEqual([]);
    expect(annuaire.traces.every((t) => t.url === "ldaps://ldap.exemple.lan")).toBe(true);
  });

  it("identifiant à métacaractères de filtre : échappé, aucune entrée trouvée", async () => {
    expect(await auth("*)(uid=*")).toEqual({ type: "absent" });
    expect(await auth("jean*")).toEqual({ type: "absent" });
    expect(annuaire.liaisonsUtilisateur).toEqual([]);
  });

  it("deux entrées pour l'identifiant : refus ambiguous, aucun mot de passe envoyé", async () => {
    annuaire.ajouter({ uid: "jean", cle: UUID(2), mdp: "autre", groupes: [GROUPE] });
    expect(await auth("jean")).toEqual({ type: "refus", raison: "ambiguous", fournisseurId: "annuaire" });
    expect(annuaire.liaisonsUtilisateur).toEqual([]);
    expect(await echecs()).toEqual([]);
  });

  it.each([
    ["vide", ""],
    ["de 1 025 octets", "x".repeat(1025)],
    ["à caractère nul", "ab\0cd"],
  ])("mot de passe %s : refus sans contacter l'annuaire", async (_n, mdp) => {
    expect(await auth("jean", mdp)).toEqual({ type: "refus", raison: "bad_password", fournisseurId: null });
    expect(annuaire.traces).toEqual([]);
  });

  it("mot de passe de 1 024 octets pile : la liaison part", async () => {
    expect(await auth("jean", "x".repeat(1024))).toMatchObject({ type: "refus", raison: "bad_password" });
    expect(annuaire.liaisonsUtilisateur).toHaveLength(1);
  });

  describe("compteur d'essais par entrée", () => {
    beforeEach(async () => {
      await b.fermer();
      await ouvrir([{ max_failures: 3, failure_window_sec: 600 }]);
    });

    it("au-delà du seuil : refus throttled sans contacter l'annuaire, même avec le bon mot de passe", async () => {
      for (let i = 0; i < 3; i++)
        expect(await auth("jean", "faux")).toMatchObject({ raison: "bad_password" });
      const traces = annuaire.traces.length;
      for (const mdp of ["faux", MDP])
        expect(await auth("jean", mdp)).toEqual({
          type: "refus",
          raison: "throttled",
          fournisseurId: "annuaire",
        });
      expect(annuaire.liaisonsUtilisateur).toHaveLength(3);
      expect(annuaire.traces.length).toBe(traces + 2);
      expect(annuaire.traces.slice(traces).every((t) => t.liaisons.every((dn) => dn === DN_SERVICE))).toBe(
        true,
      );
    });

    it("le compteur est celui de l'entrée : une autre entrée reste libre, et la casse du nom tapé compte pour la même", async () => {
      annuaire.ajouter({ uid: "paul", cle: UUID(3), mdp: "mdp-paul", groupes: [GROUPE] });
      for (const nom of ["jean", "JEAN", "Jean"]) await auth(nom, "faux");
      expect(await auth("jean")).toMatchObject({ raison: "throttled" });
      expect(await auth("paul", "mdp-paul")).toMatchObject({ type: "ok" });
    });

    it("la fenêtre passée, l'entrée est de nouveau essayée", async () => {
      for (let i = 0; i < 4; i++) await auth("jean", "faux");
      expect(await auth("jean")).toMatchObject({ raison: "throttled" });
      b.horloge += 601;
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });

    it("le compteur est en base : un autre process (autre connexion à la base) voit le même seuil", async () => {
      for (let i = 0; i < 3; i++) await auth("jean", "faux");
      const autre = { ...b.dep(), base: b.t.base };
      expect(await authentifierParAnnuaire(autre, "jean", MDP)).toMatchObject({ raison: "throttled" });
    });

    it("liaison sans réponse (délai dépassé) : comptée, annuaire tenu pour indisponible", async () => {
      annuaire.liaisonsSansReponse.add(`uid=jean,${BASE}`);
      expect(await auth("jean")).toEqual({ type: "indisponible" });
      expect(await echecs()).toEqual([["annuaire", UUID(1), 1]]);
      expect(annuaire.traces.every((t) => t.ferme)).toBe(true);
    });

    it.each([19, 53])(
      "liaison refusée par le code %i (entrée verrouillée ou désactivée) : refus d'identifiants compté, pas « indisponible »",
      async (code) => {
        annuaire.liaisonsEnErreur.set(`uid=jean,${BASE}`, new ErreurAnnuaire("protocole", { code }));
        expect(await auth("jean")).toEqual({
          type: "refus",
          raison: "bad_password",
          fournisseurId: "annuaire",
        });
        expect(await echecs()).toEqual([["annuaire", UUID(1), 1]]);
      },
    );

    it("rafale simultanée : jamais plus de liaisons que le seuil", async () => {
      const rs = await Promise.all(Array.from({ length: 6 }, () => auth("jean", "faux")));
      expect(rs.filter((r) => r.type === "refus" && r.raison === "throttled")).toHaveLength(3);
      expect(annuaire.liaisonsUtilisateur).toHaveLength(3);
    });
  });

  describe("état de l'entrée, lu seulement après une liaison réussie", () => {
    const freeipa = {
      preset: "freeipa",
      attrs: { id: "ipaUniqueID", username: "uid", email: "mail", name: "cn" },
    };
    const sain = { krbpasswordexpiration: ["20990101000000Z"] };

    it.each([
      ["désactivée", { nsaccountlock: ["TRUE"], ...sain }, "entry_disabled"],
      ["mot de passe expiré", { krbpasswordexpiration: ["20000101000000Z"] }, "password_expired"],
      ["état illisible", { nsaccountlock: ["peut-être"], ...sain }, "state_unknown"],
      ["expiration illisible", { krbpasswordexpiration: ["demain"] }, "state_unknown"],
    ])("FreeIPA, %s : refus %s", async (_n, attrs, raison) => {
      await b.fermer();
      await ouvrir([freeipa]);
      annuaire.personnes[0]!.attrs = attrs;
      expect(await auth("jean")).toEqual({ type: "refus", raison, fournisseurId: "annuaire" });
      expect(await auth("jean", "faux")).toMatchObject({ raison });
      // L'état est jugé avant la liaison : aucun mot de passe n'est envoyé pour cette entrée.
      expect(annuaire.traces.flatMap((t) => t.liaisons).some((dn) => dn.includes("jean"))).toBe(false);
    });

    it("FreeIPA : entrée saine, ouverte", async () => {
      await b.fermer();
      await ouvrir([freeipa]);
      annuaire.personnes[0]!.attrs = { nsaccountlock: ["false"], ...sain };
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });

    it("Active Directory : verrouillée → entry_locked, désactivée → entry_disabled, active → ouverte", async () => {
      await b.fermer();
      await ouvrir([
        {
          preset: "active-directory",
          attrs: { id: "objectGUID", username: "uid", email: "mail", name: "cn" },
        },
      ]);
      const p = annuaire.personnes[0]!;
      const guid = [Buffer.alloc(16, 7)];
      p.attrs = {
        objectguid: guid,
        useraccountcontrol: ["512"],
        "msds-user-account-control-computed": ["16"],
      };
      expect(await auth("jean")).toMatchObject({ raison: "entry_locked" });
      p.attrs = {
        objectguid: guid,
        useraccountcontrol: ["514"],
        "msds-user-account-control-computed": ["0"],
      };
      expect(await auth("jean")).toMatchObject({ raison: "entry_disabled" });
      p.attrs = {
        objectguid: guid,
        useraccountcontrol: ["512"],
        "msds-user-account-control-computed": ["0"],
      };
      expect(await auth("jean")).toMatchObject({
        type: "ok",
        profil: { subject: Buffer.alloc(16, 7).toString("hex") },
      });
    });
  });

  describe("appartenance aux groupes requis", () => {
    const sansLiaison = async (): Promise<void> => {
      expect(annuaire.liaisonsUtilisateur).toEqual([]);
      expect(await echecs()).toEqual([]);
      expect(annuaire.traces.every((t) => t.ferme)).toBe(true);
    };

    it("hors du groupe : refus not_in_group avant toute liaison, rien n'est compté", async () => {
      annuaire.personnes[0]!.groupes = [];
      expect(await auth("jean")).toEqual({
        type: "refus",
        raison: "not_in_group",
        fournisseurId: "annuaire",
      });
      await sansLiaison();
    });

    it("groupe requis disparu de l'annuaire : inconnu, jamais non ; aucune liaison", async () => {
      annuaire.personnes[0]!.groupes = [];
      annuaire.groupesExistants.delete(GROUPE);
      expect(await auth("jean")).toEqual({
        type: "refus",
        raison: "groups_unknown",
        fournisseurId: "annuaire",
      });
      await sansLiaison();
    });

    it("groupes illisibles : refus groups_unknown, aucune liaison, aucun compteur", async () => {
      annuaire.groupesLisibles = false;
      expect(await auth("jean")).toEqual({
        type: "refus",
        raison: "groups_unknown",
        fournisseurId: "annuaire",
      });
      await sansLiaison();
    });

    it("une entrée hors des groupes n'est ni devinable ni verrouillable : mille essais, aucune liaison ni compteur", async () => {
      annuaire.personnes[0]!.groupes = [];
      for (let i = 0; i < 20; i++) await auth("jean", `faux-${i}`);
      await sansLiaison();
    });

    it("un groupe suffit parmi plusieurs", async () => {
      await b.fermer();
      await ouvrir([{ required_groups: ["cn=autre,dc=exemple,dc=lan", GROUPE] }]);
      expect(await auth("jean")).toMatchObject({ appartenance: "oui" });
    });
  });

  describe("plusieurs annuaires", () => {
    beforeEach(async () => {
      await b.fermer();
      await ouvrir([{}, {}]);
      annuaire.ajouter({ uid: "marie", cle: UUID(5), mdp: "mdp-marie", groupes: [GROUPE] });
    });
    const liaisonsPar = (hote: string): number =>
      annuaire.traces.filter((t) => t.url === `ldaps://${hote}`).length;

    it("l'identifiant est lu dans l'ordre : le premier qui le contient décide, le second n'est jamais essayé", async () => {
      expect(await auth("jean", "faux")).toEqual({
        type: "refus",
        raison: "bad_password",
        fournisseurId: "annuaire",
      });
      expect(liaisonsPar("ldap2.exemple.lan")).toBe(0);
    });

    it("annuaire en panne devant : indisponible, le suivant n'est pas essayé", async () => {
      annuaire.urlsInjoignables.add("ldaps://ldap.exemple.lan");
      expect(await auth("jean")).toEqual({ type: "indisponible" });
      expect(liaisonsPar("ldap2.exemple.lan")).toBe(0);
    });

    it("secret du compte de service disparu après le choix des annuaires actifs : indisponible, jamais une liaison vide", async () => {
      const actifs = await annuairesActifs(b.dep());
      await supprimerSecretFournisseur(b.t.base, "annuaire", { userId: null, username: null, ip: null });
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP, actifs)).toEqual({ type: "indisponible" });
      expect(annuaire.traces).toEqual([]);
    });

    it("secret absent : l'annuaire n'est pas actif, le suivant décide", async () => {
      await supprimerSecretFournisseur(b.t.base, "annuaire", { userId: null, username: null, ip: null });
      expect(await auth("jean")).toMatchObject({ type: "ok", fournisseur: { id: "annuaire2" } });
    });
  });

  it("plusieurs adresses : la suivante seulement sur « injoignable »", async () => {
    await b.fermer();
    await ouvrir([{ urls: ["ldaps://ldap.exemple.lan", "ldaps://ldap-bis.exemple.lan"] }]);
    annuaire.urlsInjoignables.add("ldaps://ldap.exemple.lan");
    expect(await auth("jean")).toMatchObject({ type: "ok" });
    expect(annuaire.traces.at(-1)?.url).toBe("ldaps://ldap-bis.exemple.lan");
    annuaire.urlsInjoignables.clear();
    const avant = annuaire.traces.length;
    annuaire.personnes[0]!.mdp = "autre";
    expect(await auth("jean")).toMatchObject({ raison: "bad_password" });
    expect(annuaire.traces.slice(avant).every((t) => t.url === "ldaps://ldap.exemple.lan")).toBe(true);
  });

  it("mot de passe de service refusé : indisponible (pas un échec de l'utilisateur), rien n'est compté", async () => {
    annuaire.personnes[0]!.cle = UUID(1);
    const f = b.fournisseurs[0]!;
    const { enregistrerSecret, enregistrerTestReussi } = await import("../../../src/identite/fournisseurs");
    await enregistrerSecret(b.t.base, f, "mauvais", { userId: null, username: null, ip: null });
    expect(await auth("jean")).toEqual({ type: "absent" });
    await enregistrerTestReussi(b.t.base, f, "https://elpis.exemple.lan");
    expect(await auth("jean")).toEqual({ type: "indisponible" });
    expect(await echecs()).toEqual([]);
    expect(annuaire.liaisonsUtilisateur).toEqual([]);
  });

  it("aucun annuaire actif : absent, aucune connexion", async () => {
    b.cfg.ecrire({ auth: { public_url: "https://elpis.exemple.lan", providers: [] } });
    expect(await auth("jean")).toEqual({ type: "absent" });
    expect(annuaire.traces).toEqual([]);
  });

  it("échéance globale : un annuaire qui ne répond jamais donne « indisponible », les connexions sont fermées et la place de la porte rendue", async () => {
    annuaire.pause = new Promise(() => undefined);
    const dep = { ...b.dep(), echeanceMs: 150 };
    const rs = await Promise.all(
      Array.from({ length: AUTHENTIFICATIONS_EN_COURS_MAX + 2 }, () =>
        authentifierParAnnuaire(dep, "jean", MDP),
      ),
    );
    expect(rs.every((r) => r.type === "indisponible")).toBe(true);
    expect(annuaire.traces.every((t) => t.ferme)).toBe(true);
    annuaire.pause = null;
    expect(await authentifierParAnnuaire(dep, "jean", MDP)).toMatchObject({ type: "ok" });
  });

  it("au plus 8 authentifications en cours et 32 en attente ; au-delà : indisponible sans attendre", async () => {
    let lacher!: () => void;
    annuaire.pause = new Promise<void>((r) => (lacher = r));
    const total = AUTHENTIFICATIONS_EN_COURS_MAX + AUTHENTIFICATIONS_EN_ATTENTE_MAX;
    for (let i = 0; i < total; i++)
      annuaire.ajouter({ uid: `p${i}`, cle: UUID(100 + i), mdp: MDP, groupes: [GROUPE] });
    const lancees = Array.from({ length: total }, (_, i) => auth(`p${i}`));
    const debordement = await auth("p0");
    expect(debordement).toEqual({ type: "indisponible" });
    for (
      let i = 0;
      i < 100 && annuaire.traces.filter((t) => t.liaisons.length > 0).length < AUTHENTIFICATIONS_EN_COURS_MAX;
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    expect(annuaire.traces.filter((t) => t.liaisons.length > 0)).toHaveLength(AUTHENTIFICATIONS_EN_COURS_MAX);
    lacher();
    const rs = await Promise.all(lancees);
    expect(rs.every((r) => r.type === "ok")).toBe(true);
    expect(annuaire.traces.every((t) => t.ferme)).toBe(true);
  }, 60_000);
});
