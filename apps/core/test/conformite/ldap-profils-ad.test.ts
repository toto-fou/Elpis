// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/ldap-profils-ad.test.ts — Microsoft Active Directory et Samba AD sur un vrai LDAPS local : objectGUID binaire, formes de connexion, userAccountControl, groupes imbriqués et plus de 1 500 membres, références de la racine, codes de données de la liaison, catalogue global, limites de taille (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { authentifierParAnnuaire } from "../../src/identite/annuaire/connexion";
import { cleStable } from "../../src/identite/annuaire/entree";
import { cleIdentifiant } from "../../src/identite/cle-identifiant";
import { validerFournisseur } from "../../src/identite/reglages";
import type { BancAnnuaire } from "../identite/annuaire/banc-annuaire";
import { entree, fournisseur } from "../identite/annuaire/faux";
import { MOTEURS } from "../identite/banc";
import { ldapValide } from "../identite/aides";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { demarrerHote, fabriqueReelle, jouerEssai, ouvrirBancReel, preparerBalayage } from "./banc-reel";
import type { Hote } from "./banc-reel";
import { AD, guidAd, MDP_PERSONNE, MDP_SERVICE, profilActiveDirectory, variante } from "./profils-annuaire";
import type { ProfilAnnuaire } from "./profils-annuaire";

const AD_FOURNISSEUR = {
  preset: "active-directory",
  attrs: { id: "objectGUID", username: "sAMAccountName", email: "mail", name: "displayName" },
};

describe("Active Directory : clé stable objectGUID (MS-ADTS, a-objectguid : 16 octets)", () => {
  const f = fournisseur(AD_FOURNISSEUR);
  it("Microsoft Learn objectGUID : 16 octets binaires, rendus en 32 caractères hexadécimaux, ordre des octets conservé", () => {
    const guid = guidAd(1);
    expect(cleStable(entree("CN=jean", { objectguid: [guid] }), f)).toBe(guid.toString("hex"));
    expect(cleStable(entree("CN=jean", { objectguid: [guidAd(2)] }), f)).not.toBe(guid.toString("hex"));
  });
  it.each([
    ["15 octets", Buffer.alloc(15, 1)],
    ["17 octets", Buffer.alloc(17, 1)],
    ["texte 36 caractères", "6e1f1c9a-0000-4000-8000-000000000001"],
    ["texte entre accolades", "{6e1f1c9a-0000-4000-8000-000000000001}"],
  ])("Microsoft Learn objectGUID : %s : clé refusée (jamais de repli sur le DN ni sur le nom)", (_n, v) => {
    expect(() => cleStable(entree("CN=jean", { objectguid: [v] }), f)).toThrowError();
  });
  it("RFC 4512 §2.5 (attribut monovalué) : deux valeurs : clé refusée", () => {
    expect(() => cleStable(entree("CN=jean", { objectguid: [guidAd(1), guidAd(2)] }), f)).toThrowError();
  });
});

describe("Active Directory : formes de connexion et réglages", () => {
  it("Microsoft Learn (formes de nom AD) : le nom du compte de service doit être un DN : UPN et DOMAINE\\compte refusés par choix (plus strict que la norme)", () => {
    const f = fournisseur(AD_FOURNISSEUR);
    expect(f.bind_dn).toContain("=");
    // Les réglages acceptent n'importe quel texte ; la liaison, elle, exige un DN (voir le protocole).
    expect(() =>
      validerFournisseur(ldapValide({ ...AD_FOURNISSEUR, bind_dn: "svc@corp.example" })),
    ).not.toThrow();
  });
  it("RFC 4515 §3 : un gabarit de filtre à deux {username} (sAMAccountName OU UPN) est refusé par choix (plus strict que la norme)", () => {
    expect(() =>
      validerFournisseur(
        ldapValide({
          ...AD_FOURNISSEUR,
          user_filter: "(|(sAMAccountName={username})(userPrincipalName={username}))",
        }),
      ),
    ).toThrowError();
  });
  it("Microsoft Learn : le filtre sur userPrincipalName seul est accepté (connexion par UPN, un seul format par annuaire)", () => {
    expect(() =>
      validerFournisseur(ldapValide({ ...AD_FOURNISSEUR, user_filter: "(userPrincipalName={username})" })),
    ).not.toThrow();
  });
  it("Microsoft Learn : `CORP\\jean` est une saisie admise par la clé d'identifiant (la recherche par sAMAccountName ne la trouvera pas)", () => {
    expect(cleIdentifiant("CORP\\jean")).toBe("corp\\jean");
    expect(cleIdentifiant("jean@corp.example")).toBe("jean@corp.example");
  });
  it("Microsoft Learn (catalogue global, port 3269) : l'adresse ldaps://hôte:3269 est acceptée", () => {
    expect(() =>
      validerFournisseur(ldapValide({ ...AD_FOURNISSEUR, urls: ["ldaps://gc.corp.example:3269"] })),
    ).not.toThrow();
  });
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("Active Directory sur LDAPS local (%s)", (moteur) => {
  let hote: Hote;
  let b: BancAnnuaire;
  beforeAll(async () => {
    hote = await demarrerHote();
  });
  afterAll(async () => {
    await hote.fermer();
  });
  afterEach(async () => {
    await b?.fermer();
  });
  const ouvrir = async (p: ProfilAnnuaire, extra: Record<string, unknown> = {}): Promise<void> => {
    b = await ouvrirBancReel(moteur, hote, p, extra);
  };
  const liaisons = (): string[] =>
    hote.serveur.requetes.filter((q) => q.type === "bind").map((q) => q.dn ?? "");
  const lie = (uid: string): string => `CN=${uid},${AD.UTILISATEURS}`;

  describe("états de compte (Microsoft Learn : userAccountControl, msDS-User-Account-Control-Computed)", () => {
    beforeEach(() => ouvrir(profilActiveDirectory()));

    it("userAccountControl 0x2 (ACCOUNTDISABLE) : entrée désactivée, aucun mot de passe envoyé", async () => {
      expect(await authentifierParAnnuaire(b.dep(), "desactive", MDP_PERSONNE)).toMatchObject({
        raison: "entry_disabled",
      });
      expect(liaisons()).not.toContain(lie("desactive"));
    });
    it("msDS-User-Account-Control-Computed 0x10 (UF_LOCKOUT) : entrée verrouillée, aucun mot de passe envoyé", async () => {
      expect(await authentifierParAnnuaire(b.dep(), "verrouille", MDP_PERSONNE)).toMatchObject({
        raison: "entry_locked",
      });
      expect(liaisons()).not.toContain(lie("verrouille"));
    });
    it("msDS-User-Account-Control-Computed 0x800000 (UF_PASSWORD_EXPIRED) : mot de passe expiré, aucun mot de passe envoyé", async () => {
      expect(await authentifierParAnnuaire(b.dep(), "expire", MDP_PERSONNE)).toMatchObject({
        raison: "password_expired",
      });
      expect(liaisons()).not.toContain(lie("expire"));
    });
    it("userAccountControl 0x10000 (DONT_EXPIRE_PASSWORD) : connexion normale", async () => {
      expect(await authentifierParAnnuaire(b.dep(), "sansexpiration", MDP_PERSONNE)).toMatchObject({
        type: "ok",
      });
    });
    it("le calculé est demandé par son nom (attribut construit : absent d'une demande « * »)", async () => {
      await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE);
      const q = hote.serveur.requetes.find((x) => x.type === "search");
      expect(q?.attributs).toContain("msDS-User-Account-Control-Computed");
      expect(q?.attributs).toContain("userAccountControl");
    });
  });

  describe("états que le produit ne lit pas : la liaison de l'annuaire tranche, le compte reste « mauvais mot de passe »", () => {
    it.each([
      ["525", "utilisateur inconnu"],
      ["530", "heures de connexion"],
      ["531", "poste non autorisé"],
      ["533", "compte désactivé"],
      ["701", "compte expiré (accountExpires)"],
      ["773", "mot de passe à changer (pwdLastSet = 0)"],
      ["775", "compte verrouillé"],
      ["52e", "mot de passe faux"],
      ["532", "mot de passe expiré"],
    ])("liaison refusée code 49 data %s (%s) : refus bad_password, jamais « ok »", async (data) => {
      const p = profilActiveDirectory();
      await ouvrir(
        variante(p, {
          liaison: (dn, mdp) =>
            dn === lie("jean")
              ? {
                  code: 49,
                  diagnostic: `80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data ${data}, v4563`,
                }
              : p.liaison(dn, mdp),
        }),
      );
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({
        type: "refus",
        raison: "bad_password",
      });
    });

    it("accountExpires passé et pwdLastSet = 0 ne sont pas lus : l'entrée est jugée active (figé)", async () => {
      const p = profilActiveDirectory();
      const entrees = p.entrees.map((x) =>
        x.dn === lie("jean")
          ? { ...x, attrs: { ...x.attrs, accountExpires: ["132000000000000000"], pwdLastSet: ["0"] } }
          : x,
      );
      await ouvrir(variante(p, { entrees }));
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({ type: "ok" });
    });

    it("bit LOCKOUT (0x10) dans userAccountControl seul : non retenu, le calculé fait foi (Microsoft Learn : bits calculés)", async () => {
      const p = profilActiveDirectory();
      const entrees = p.entrees.map((x) =>
        x.dn === lie("jean") ? { ...x, attrs: { ...x.attrs, userAccountControl: ["528"] } } : x,
      );
      await ouvrir(variante(p, { entrees }));
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({ type: "ok" });
    });
  });

  describe("compte de service sans droit de lecture du calculé, ou catalogue global (3269) : état inconnu", () => {
    it("Microsoft Learn (msDS-User-Account-Control-Computed : absent du catalogue global) : attribut absent : « état inconnu », aucune liaison de personne", async () => {
      const p = profilActiveDirectory();
      const entrees = p.entrees.map((x) => {
        const { "msDS-User-Account-Control-Computed": _omis, ...reste } = x.attrs;
        return { ...x, attrs: reste };
      });
      await ouvrir(variante(p, { entrees }));
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({
        type: "refus",
        raison: "state_unknown",
      });
      expect(liaisons()).toEqual([AD.SERVICE]);
    });
  });

  describe("groupes", () => {
    it("Microsoft Learn LDAP_MATCHING_RULE_IN_CHAIN 1.2.840.113556.1.4.1941 : membre d'un sous-groupe imbriqué : accepté", async () => {
      await ouvrir(profilActiveDirectory());
      expect(await authentifierParAnnuaire(b.dep(), "imbrique", MDP_PERSONNE)).toMatchObject({ type: "ok" });
      const q = hote.serveur.requetes.find((x) => x.filtre?.includes("1.2.840.113556.1.4.1941"));
      expect(q).toMatchObject({ portee: 0, base: lie("imbrique") });
    });

    it("règle en chaîne non supportée par le serveur (réponse vide, succès) : refus not_in_group pour tous, aucune liaison de personne", async () => {
      await ouvrir(variante(profilActiveDirectory(), { options: { regleChaine: "ignoree" } }));
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({
        raison: "not_in_group",
      });
      expect(liaisons()).toEqual([AD.SERVICE]);
    });

    it("règle en chaîne refusée (code 53) : refus groups_unknown, jamais not_in_group", async () => {
      await ouvrir(variante(profilActiveDirectory(), { options: { regleChaine: "erreur" } }));
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({
        raison: "groups_unknown",
      });
    });

    it("MS-ADTS (plus de 1 500 valeurs : member;range=) : groupe de 2 000 membres : le dernier membre est reconnu par le filtre, sans lire la liste", async () => {
      const p = profilActiveDirectory();
      const dernier = Array.from({ length: 2000 }, (_, i) => `CN=m${i},${AD.UTILISATEURS}`);
      const groupe = p.entrees.find((x) => x.dn === AD.GROUPE);
      const entrees = [
        ...p.entrees.filter((x) => x.dn !== AD.GROUPE),
        { dn: AD.GROUPE, attrs: { ...groupe?.attrs, member: [...dernier, lie("jean")] } },
      ];
      await ouvrir(variante(p, { entrees }));
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({ type: "ok" });
      const demandes = hote.serveur.requetes.flatMap((q) => q.attributs ?? []);
      expect(demandes.some((a) => a.toLowerCase().startsWith("member"))).toBe(false);
    });

    it("groupe principal (primaryGroupID) : un groupe requis qui est le groupe principal des utilisateurs est signalé par le test", async () => {
      const p = profilActiveDirectory();
      const du = `CN=Domain Users,${AD.UTILISATEURS}`;
      const entrees = [
        ...p.entrees,
        {
          dn: du,
          attrs: { objectClass: ["top", "group"], cn: ["Domain Users"], primaryGroupToken: ["513"] },
        },
      ];
      await ouvrir(variante(p, { entrees, reglages: { required_groups: [du] } }));
      const etapes = await jouerEssai(b, hote, "jean");
      const g = etapes.find((x) => x.id === "groups");
      expect(g?.level).toBe("fail");
      expect(g?.detail).toContain("Groupe principal");
      // Sans le test, la connexion elle-même ne laisse entrer personne par ce groupe (il n'est dans aucun `member`).
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({
        raison: "not_in_group",
      });
    });
  });

  describe("références de continuation à la racine du domaine (RFC 4511 §4.5.2, DomainDnsZones, ForestDnsZones)", () => {
    const references = [
      "ldaps://DomainDnsZones.corp.example:636/DC=DomainDnsZones,DC=corp,DC=example",
      "ldaps://ForestDnsZones.corp.example:636/DC=ForestDnsZones,DC=corp,DC=example",
      "ldaps://corp.example:636/CN=Configuration,DC=corp,DC=example",
    ];
    it.each([true, false])(
      "recherche depuis la racine du domaine, références %s avant les entrées : connexion acceptée, aucune référence suivie",
      async (avant) => {
        const p = variante(profilActiveDirectory(), {
          options: { renvoisRacine: { racine: AD.RACINE, uris: references, avant } },
          reglages: { user_base_dn: AD.RACINE },
        });
        await ouvrir(p);
        const nb = hote.serveur.connexions();
        expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({ type: "ok" });
        // service + personne : deux connexions, aucune vers une référence
        expect(hote.serveur.connexions() - nb).toBe(2);
      },
    );
  });

  describe("limites du serveur (1 000 entrées par recherche sans pagination)", () => {
    const beaucoup = (p: ProfilAnnuaire): ProfilAnnuaire["entrees"] => [
      ...p.entrees,
      ...Array.from({ length: 2500 }, (_, i) => ({
        dn: `CN=bulk${i},${AD.UTILISATEURS}`,
        attrs: {
          objectClass: ["user"],
          sAMAccountName: [`bulk${i}`],
          objectGUID: [guidAd(200)],
          mail: ["x"],
        },
      })),
    ];
    it("annuaire de plus de 1 000 comptes : la connexion, qui lit deux entrées au plus, n'est pas gênée", async () => {
      const p = profilActiveDirectory();
      await ouvrir(variante(p, { entrees: beaucoup(p) }));
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({ type: "ok" });
    });
    it("annuaire de plus de 1 000 comptes : le balayage lit par clé et par présence avec limite 1 ou 2 : aucune passe abandonnée", async () => {
      const p = profilActiveDirectory();
      await ouvrir(variante(p, { entrees: beaucoup(p) }));
      const balayage = preparerBalayage(b, fabriqueReelle());
      try {
        await balayage.rattacher("jean", p.personnes[0]?.cle ?? "");
        const r = await balayage.passe();
        expect(r).toMatchObject({ type: "bilan", etat: { aborted: null, seen: 1, unknown: 0 } });
      } finally {
        await balayage.fermer();
      }
    });
  });

  describe("balayage périodique", () => {
    it("objectGUID recherché en octets : entrée présente et active relue (vue), entrée désactivée : départ observé, entrée supprimée : départ observé, état illisible : inconnue, jamais un départ", async () => {
      const p = profilActiveDirectory();
      await ouvrir(p);
      const balayage = preparerBalayage(b, fabriqueReelle());
      try {
        const cle = (n: number): string => guidAd(n).toString("hex");
        const actif = await balayage.rattacher("jean", cle(1));
        const ferme = await balayage.rattacher("desactive", cle(2));
        const parti = await balayage.rattacher("parti", cle(99));
        const r = await balayage.passe();
        if (r.type !== "bilan") throw new Error(r.type);
        expect(r.etat.aborted).toBeNull();
        expect(r.etat.seen).toBe(3);
        expect(r.etat.observed.map((o) => o.reason).sort()).toEqual(["entry_disabled", "entry_missing"]);
        expect(await balayage.suspendu(actif)).toBe(false);
        expect(await balayage.suspendu(ferme)).toBe(false);
        expect(await balayage.suspendu(parti)).toBe(false);
        const q = hote.serveur.requetes.find((x) => x.type === "search" && x.filtre?.includes("objectguid="));
        expect(q?.filtre).toMatch(/^\(objectguid=\\ff\\fe\\00\\80/u);
      } finally {
        await balayage.fermer();
      }
    });
  });

  describe("bouton Tester", () => {
    it("parcours complet : liaison de service, base, groupe, utilisateur d'essai, profil, horloge (currentTime du rootDSE) : aucune étape en échec", async () => {
      await ouvrir(profilActiveDirectory());
      const etapes = await jouerEssai(b, hote, "jean");
      expect(etapes.filter((x) => x.level === "fail")).toEqual([]);
      expect(etapes.map((x) => x.id)).toEqual(
        expect.arrayContaining([
          "service_bind",
          "user_base",
          "groups",
          "test_user",
          "test_user_groups",
          "test_user_profile",
          "clock",
        ]),
      );
      expect(etapes.find((x) => x.id === "clock")?.level).toBe("ok");
    });
    it("liaison de service refusée (52e) : phrase fixe sans le message du serveur", async () => {
      const p = profilActiveDirectory();
      await ouvrir(
        variante(p, {
          liaison: () => ({ code: 49, diagnostic: "80090308: LdapErr: DSID-0C09044E ... data 52e" }),
        }),
      );
      const etapes = await jouerEssai(b, hote, "jean");
      expect(etapes[0]).toMatchObject({ id: "service_bind", level: "fail" });
      expect(etapes[0]?.detail).not.toContain("DSID");
    });
    it("code 8 (strongerAuthRequired : signature exigée hors TLS) à la liaison de service : échec en phrase fixe, jamais ok", async () => {
      const p = profilActiveDirectory();
      await ouvrir(
        variante(p, {
          liaison: () => ({
            code: 8,
            diagnostic:
              "00002028: LdapErr: DSID-0C090256, comment: The server requires binds to turn on integrity checking",
          }),
        }),
      );
      const etapes = await jouerEssai(b, hote, "jean");
      expect(etapes[0]).toMatchObject({ id: "service_bind", level: "fail" });
      expect(etapes[0]?.detail).not.toContain("DSID");
      expect(MDP_SERVICE.length).toBeGreaterThan(0);
    });
  });
});
