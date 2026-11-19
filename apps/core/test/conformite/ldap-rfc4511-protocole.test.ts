// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/ldap-rfc4511-protocole.test.ts — RFC 4511 sur un vrai LDAPS local : liaison simple, requête de recherche, codes de résultat, références, PDU multiples, avis de déconnexion, réponses mal formées ; ce que la connexion, le balayage et le test en concluent (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { authentifierParAnnuaire } from "../../src/identite/annuaire/connexion";
import type { ConnexionAnnuaire } from "../../src/identite/annuaire/client";
import { ErreurAnnuaire } from "../../src/identite/annuaire/erreur";
import type { BancAnnuaire } from "../identite/annuaire/banc-annuaire";
import { fournisseur } from "../identite/annuaire/faux";
import { MOTEURS } from "../identite/banc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { demarrerHote, fabriqueReelle, jouerEssai, ouvrirBancReel, preparerBalayage } from "./banc-reel";
import type { Hote } from "./banc-reel";
import { MDP_PERSONNE, MDP_SERVICE, profilOpenLdap } from "./profils-annuaire";
import type { ProfilAnnuaire } from "./profils-annuaire";
import { BerWriter } from "ldapts";

const PARAMS = { portee: "sub" as const, filtre: "(uid=jean)", attributs: ["uid"], limite: 2 };

/** Codes de résultat de RFC 4511 §4.1.9 / annexe A que le produit doit toujours lire comme une panne. */
const CODES_PANNE = [1, 2, 3, 8, 10, 11, 13, 32, 34, 48, 49, 50, 51, 52, 53, 80] as const;
const NOMS: Record<number, string> = {
  1: "operationsError",
  2: "protocolError",
  3: "timeLimitExceeded",
  8: "strongerAuthRequired",
  10: "referral",
  11: "adminLimitExceeded",
  13: "confidentialityRequired",
  32: "noSuchObject",
  34: "invalidDNSyntax",
  48: "inappropriateAuthentication",
  49: "invalidCredentials",
  50: "insufficientAccessRights",
  51: "busy",
  52: "unavailable",
  53: "unwillingToPerform",
  80: "other",
};

describe.skipIf(!OPENSSL_DISPONIBLE)("RFC 4511 : protocole LDAP v3", () => {
  let hote: Hote;
  let profil: ProfilAnnuaire;
  beforeAll(async () => {
    hote = await demarrerHote();
  });
  afterAll(async () => {
    await hote.fermer();
  });
  afterEach(() => {
    expect(hote.serveur.erreursLecture()).toBe(0);
  });
  beforeEach(async () => {
    await new Promise((ok) => setTimeout(ok, 60));
    profil = profilOpenLdap();
    const c = hote.serveur.comportement;
    c.rechercher = null;
    c.lier = null;
    c.entrees = [];
    c.comptes = { [profil.serviceDn]: MDP_SERVICE };
    c.brutRecherche = null;
    c.brutLiaison = null;
    c.fermerApresBrut = false;
    c.fermerSansReponse = false;
    c.avisDeconnexion = null;
    c.fragment = 0;
    c.renvoi = null;
    c.codeRecherche = 0;
    c.muet = false;
    hote.serveur.requetes.length = 0;
  });

  const ouvrir = (extra: Record<string, unknown> = {}): Promise<ConnexionAnnuaire> =>
    fabriqueReelle()(fournisseur({ ca_pem: hote.ca.cert, timeout_sec: 3, ...extra }), hote.url);
  const lie = async (): Promise<ConnexionAnnuaire> => {
    const cnx = await ouvrir();
    await cnx.lier(profil.serviceDn, MDP_SERVICE);
    return cnx;
  };
  const cherche = async (o = PARAMS): ReturnType<ConnexionAnnuaire["chercher"]> => {
    const cnx = await lie();
    try {
      return await cnx.chercher("dc=exemple,dc=lan", o);
    } finally {
      await cnx.fermer();
    }
  };

  describe("§4.2 liaison simple", () => {
    it("RFC 4511 §4.2 : version 3, choix simple (0x80), aucun contrôle, mot de passe envoyé tel quel", async () => {
      const cnx = await lie();
      await cnx.fermer();
      const q = hote.serveur.requetes.find((x) => x.type === "bind");
      expect(q).toMatchObject({ version: 3, choix: 0x80, dn: profil.serviceDn, controles: [] });
      expect(q?.longueurMdp).toBe(Buffer.byteLength(MDP_SERVICE));
    });

    it("RFC 4511 §4.2 + RFC 4513 §5.1.1 : liaison anonyme (nom vide, mot de passe vide) jamais envoyée", async () => {
      const cnx = await ouvrir();
      await expect(cnx.lier("", "")).rejects.toMatchObject({ nature: "identifiants" });
      await cnx.fermer();
      expect(hote.serveur.requetes.filter((q) => q.type === "bind")).toHaveLength(0);
    });

    it("RFC 4513 §5.1.2 : nom sans mot de passe (liaison non authentifiée) jamais envoyée", async () => {
      const cnx = await ouvrir();
      await expect(cnx.lier(profil.serviceDn, "")).rejects.toMatchObject({ nature: "identifiants" });
      await cnx.fermer();
      expect(hote.serveur.requetes.filter((q) => q.type === "bind")).toHaveLength(0);
    });

    it("RFC 4513 §5.1.1 : mot de passe sans nom jamais envoyé non plus", async () => {
      const cnx = await ouvrir();
      await expect(cnx.lier("", "secret")).rejects.toMatchObject({ nature: "identifiants" });
      await cnx.fermer();
      expect(hote.serveur.requetes).toHaveLength(0);
    });

    it("RFC 4511 §4.2 : un nom qui n'est pas un DN (UPN, DOMAINE\\compte) est refusé avant d'être envoyé : refusé par choix (plus strict que la norme)", async () => {
      for (const nom of ["svc@corp.example", "CORP\\svc"]) {
        const cnx = await ouvrir();
        await expect(cnx.lier(nom, "secret")).rejects.toMatchObject({ nature: "identifiants" });
        await cnx.fermer();
      }
      expect(hote.serveur.requetes.filter((q) => q.type === "bind")).toHaveLength(0);
    });

    it("RFC 4511 §4.2 (mot de passe : UTF-8) : un mot de passe non ASCII arrive en UTF-8", async () => {
      hote.serveur.comportement.comptes["uid=u,dc=x"] = "pässwörd-é€";
      const cnx = await ouvrir();
      await expect(cnx.lier("uid=u,dc=x", "pässwörd-é€")).resolves.toBeUndefined();
      await cnx.fermer();
      expect(hote.serveur.requetes.find((x) => x.type === "bind")?.longueurMdp).toBe(
        Buffer.byteLength("pässwörd-é€"),
      );
    });

    it("RFC 4511 §4.2 : une seule liaison par connexion, une 2e est refusée localement", async () => {
      const cnx = await lie();
      await expect(cnx.lier(profil.serviceDn, MDP_SERVICE)).rejects.toMatchObject({
        nature: "configuration",
      });
      await cnx.fermer();
      expect(hote.serveur.requetes.filter((q) => q.type === "bind")).toHaveLength(1);
    });
  });

  describe("§4.3 unbind", () => {
    it("RFC 4511 §4.3 : la fermeture envoie une requête unbind", async () => {
      const cnx = await lie();
      await cnx.fermer();
      await new Promise((ok) => setTimeout(ok, 50));
      expect(hote.serveur.requetes.map((q) => q.type)).toEqual(["bind", "unbind"]);
    });
  });

  describe("§4.5 recherche", () => {
    it("RFC 4511 §4.5.1 : portée, derefAliases never, typesOnly faux, délai, limite, attributs nommés, aucun contrôle de requête", async () => {
      await cherche();
      expect(hote.serveur.requetes.find((q) => q.type === "search")).toMatchObject({
        base: "dc=exemple,dc=lan",
        portee: 2,
        deref: 0,
        typesSeuls: false,
        limite: 2,
        delai: 3,
        attributs: ["uid"],
        controles: [],
      });
    });

    it("RFC 4511 §4.5.1 : aucun contrôle de pagination n'est envoyé (aucun serveur n'est obligé de les connaître)", async () => {
      await cherche();
      expect(hote.serveur.requetes.flatMap((q) => q.controles ?? [])).toEqual([]);
    });

    it("RFC 4511 §4.5.2 : entrées et références de continuation mêlées : seules les entrées sont rendues, aucune référence suivie", async () => {
      const c = hote.serveur.comportement;
      c.rechercher = () => ({
        elements: [
          { renvois: [`${hote.url}/dc=x??sub`] },
          { entree: { dn: "uid=jean,dc=exemple,dc=lan", attrs: { uid: ["jean"] } } },
          { renvois: [`${hote.url}/dc=y??sub`] },
        ],
        code: 0,
      });
      const avant = hote.serveur.connexions();
      const r = await cherche();
      expect(r.map((x) => x.dn)).toEqual(["uid=jean,dc=exemple,dc=lan"]);
      expect(hote.serveur.connexions() - avant).toBe(1);
    });

    it("RFC 4511 §4.5.2 : une réponse faite de références seules est « aucune entrée », jamais une erreur ni une suite", async () => {
      hote.serveur.comportement.rechercher = () => ({
        elements: [{ renvois: [`${hote.url}/dc=x??sub`] }],
        code: 0,
      });
      expect(await cherche()).toEqual([]);
    });

    it("RFC 4511 §4.5.2 : réponse en plusieurs PDU (une par entrée) lue en entier", async () => {
      hote.serveur.comportement.rechercher = () => ({
        elements: Array.from({ length: 50 }, (_, i) => ({
          entree: { dn: `uid=u${i},dc=x`, attrs: { uid: [`u${i}`] } },
        })),
        code: 0,
      });
      const r = await cherche({ ...PARAMS, limite: 50 });
      expect(r).toHaveLength(50);
    });

    it("RFC 4511 §5.1 : une PDU découpée en écritures de 7 octets est recomposée", async () => {
      hote.serveur.comportement.fragment = 7;
      hote.serveur.comportement.rechercher = () => ({
        elements: [{ entree: { dn: "uid=jean,dc=x", attrs: { uid: ["jean"], mail: ["jean@exemple.lan"] } } }],
        code: 0,
      });
      const r = await cherche();
      expect(r[0]?.attrs["mail"]).toEqual(["jean@exemple.lan"]);
    });

    it("RFC 4511 §4.1.4 (noms d'attributs sans égard à la casse) : les noms rendus sont ramenés en minuscules", async () => {
      hote.serveur.comportement.rechercher = () => ({
        elements: [
          { entree: { dn: "uid=jean,dc=x", attrs: { sAMAccountName: ["jean"], MAIL: ["a@b.fr"] } } },
        ],
        code: 0,
      });
      const r = await cherche();
      expect(Object.keys(r[0]?.attrs ?? {}).sort()).toEqual(["mail", "samaccountname", "uid"]);
    });

    it("RFC 4511 §4.1.7 (attribut à options) : `member;range=0-1499` garde son nom complet, l'attribut `member` n'est jamais complété à tort", async () => {
      hote.serveur.comportement.rechercher = () => ({
        elements: [
          {
            entree: {
              dn: "cn=g,dc=x",
              attrs: { "member;range=0-1499": ["uid=a,dc=x", "uid=b,dc=x"] },
            },
          },
        ],
        code: 0,
      });
      const r = await cherche();
      expect(r[0]?.attrs["member;range=0-1499"]).toHaveLength(2);
      expect(r[0]?.attrs["member"]).toBeUndefined();
    });

    it("RFC 4511 §4.1.7 : un attribut demandé et sans valeur est absent de la réponse (liste vide à la lecture)", async () => {
      hote.serveur.comportement.rechercher = () => ({
        elements: [{ entree: { dn: "uid=jean,dc=x", attrs: {} } }],
        code: 0,
      });
      const r = await cherche();
      expect(r[0]?.attrs["uid"]).toEqual([]);
    });

    it("RFC 4511 §4.5.1.7 : sizeLimit atteint (code 4) avec des entrées : entrées gardées, limite appliquée ici aussi", async () => {
      hote.serveur.comportement.rechercher = () => ({
        elements: [{ entree: { dn: "uid=a,dc=x", attrs: {} } }, { entree: { dn: "uid=b,dc=x", attrs: {} } }],
        code: 4,
      });
      expect(await cherche()).toHaveLength(2);
    });

    it("RFC 4511 §4.5.1.7 : code 4 sans limite transmise (sansLimiteServeur) : erreur, jamais une liste tronquée", async () => {
      hote.serveur.comportement.rechercher = () => ({
        elements: [{ entree: { dn: "uid=a,dc=x", attrs: {} } }],
        code: 4,
      });
      const cnx = await lie();
      await expect(
        cnx.chercher("dc=exemple,dc=lan", { ...PARAMS, sansLimiteServeur: true }),
      ).rejects.toMatchObject({ nature: "protocole", code: 4 });
      await cnx.fermer();
    });

    it.each(CODES_PANNE.map((n) => [n, NOMS[n]] as const))(
      "RFC 4511 §4.1.9 / annexe A : code %i (%s) à la recherche : erreur d'annuaire avec ce code, jamais une liste vide",
      async (code) => {
        hote.serveur.comportement.rechercher = () => ({ elements: [], code });
        const attendu = code === 49 ? "identifiants" : "protocole";
        await expect(cherche()).rejects.toMatchObject({ nature: attendu, code });
      },
    );

    it("RFC 4511 §4.1.10 : un code 10 (referral) porteur d'adresses n'est pas suivi : aucune connexion de plus", async () => {
      hote.serveur.comportement.rechercher = () => ({
        elements: [],
        code: 10,
        renvois: [`${hote.url}/dc=x??sub`],
      });
      const avant = hote.serveur.connexions();
      await expect(cherche()).rejects.toMatchObject({ nature: "protocole", code: 10 });
      expect(hote.serveur.connexions() - avant).toBe(1);
    });
  });

  describe("réponses mal formées ou coupées", () => {
    const enveloppe = (octets: number[]): Buffer => Buffer.from(octets);
    it("RFC 4511 §5.1 : PDU tronquée puis fermeture : erreur, jamais une liste vide", async () => {
      hote.serveur.comportement.brutRecherche = [enveloppe([0x30, 0x20, 0x02, 0x01, 0x02, 0x64])];
      hote.serveur.comportement.fermerApresBrut = true;
      await expect(cherche()).rejects.toBeInstanceOf(ErreurAnnuaire);
    });

    it("RFC 4511 §5.1 + BER : longueur géante annoncée : erreur sans attente, la socket est détruite", async () => {
      hote.serveur.comportement.brutRecherche = [
        enveloppe([0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 0x02, 0x01, 0x02]),
      ];
      const debut = Date.now();
      await expect(cherche()).rejects.toBeInstanceOf(ErreurAnnuaire);
      expect(Date.now() - debut).toBeLessThan(5000);
    }, 10_000);

    it("RFC 4511 §5.1 : octets sans structure BER : erreur d'annuaire", async () => {
      hote.serveur.comportement.brutRecherche = [Buffer.from("ceci n'est pas du LDAP\r\n")];
      hote.serveur.comportement.fermerApresBrut = true;
      await expect(cherche()).rejects.toBeInstanceOf(ErreurAnnuaire);
    });

    it("RFC 4511 §4.1.1 : identifiant de message inattendu : la réponse attendue ne vient pas, l'opération échoue au délai", async () => {
      const w = new BerWriter();
      w.startSequence();
      w.writeInt(9999);
      w.startSequence(0x65);
      w.writeEnumeration(0);
      w.writeString("");
      w.writeString("");
      w.endSequence();
      w.endSequence();
      hote.serveur.comportement.brutRecherche = [w.buffer];
      const cnx = await ouvrir({ timeout_sec: 2 });
      await cnx.lier(profil.serviceDn, MDP_SERVICE);
      await expect(cnx.chercher("dc=exemple,dc=lan", PARAMS)).rejects.toBeInstanceOf(ErreurAnnuaire);
      await cnx.fermer();
    }, 10_000);

    it("fermeture brutale sans réponse : « injoignable », jamais une liste vide", async () => {
      hote.serveur.comportement.fermerSansReponse = true;
      await expect(cherche()).rejects.toMatchObject({ nature: "injoignable" });
    });

    it("RFC 4511 §4.4.1 : avis de déconnexion (unavailable) en cours de recherche : erreur, jamais une liste vide", async () => {
      hote.serveur.comportement.avisDeconnexion = 52;
      await expect(cherche()).rejects.toBeInstanceOf(ErreurAnnuaire);
    });

    it("RFC 4511 §4.4.1 : avis de déconnexion (strongerAuthRequired) en cours de liaison : erreur", async () => {
      const w = new BerWriter();
      w.startSequence();
      w.writeInt(0);
      w.startSequence(0x78);
      w.writeEnumeration(8);
      w.writeString("");
      w.writeString("");
      w.writeString("1.3.6.1.4.1.1466.20036", 0x8a);
      w.endSequence();
      w.endSequence();
      hote.serveur.comportement.brutLiaison = [w.buffer];
      hote.serveur.comportement.fermerApresBrut = true;
      const cnx = await ouvrir();
      await expect(cnx.lier(profil.serviceDn, MDP_SERVICE)).rejects.toBeInstanceOf(ErreurAnnuaire);
      await cnx.fermer();
    });
  });

  describe.each(MOTEURS)("conclusion de la connexion, du balayage et du test (%s)", (moteur) => {
    let b: BancAnnuaire;
    beforeEach(async () => {
      b = await ouvrirBancReel(moteur, hote, profil);
    });
    afterEach(async () => {
      await b.fermer();
    });
    /** Après la liaison de service, toute recherche rend ce code. */
    const codeUnique = (code: number): void => {
      hote.serveur.comportement.rechercher = () => ({ elements: [], code, diagnostic: "DIAGNOSTIC-SECRET" });
    };

    it.each(CODES_PANNE.map((n) => [n, NOMS[n]] as const))(
      "RFC 4511 §4.1.9 : code %i (%s) à la recherche de l'utilisateur : connexion « indisponible », jamais « absent », aucune liaison de personne",
      async (code) => {
        codeUnique(code);
        expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toEqual({
          type: "indisponible",
        });
        expect(hote.serveur.requetes.filter((q) => q.type === "bind")).toHaveLength(1);
      },
    );

    it("RFC 4511 §4.5.1.7 : code 4 sans aucune entrée : « absent » (aucune connexion possible, aucune suspension : le balayage lit sans limite)", async () => {
      codeUnique(4);
      expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toEqual({ type: "absent" });
      expect(hote.serveur.requetes.filter((q) => q.type === "bind")).toHaveLength(1);
    });

    it.each(CODES_PANNE.map((n) => [n, NOMS[n]] as const))(
      "RFC 4511 §4.1.9 : code %i (%s) à la recherche de groupe : appartenance « inconnue », jamais « non », aucune liaison de personne",
      async (code) => {
        const normal = profil.entrees;
        hote.serveur.comportement.rechercher = (d) => {
          if (d.base === profil.serviceDn) return { elements: [], code: 0 };
          if (d.filtreTexte.includes("uid=jean)"))
            return {
              elements: [normal.find((e) => e.dn.startsWith("uid=jean,")) as never].map((entree) => ({
                entree,
              })),
              code: 0,
            };
          return { elements: [], code };
        };
        const r = await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE);
        expect(r).toMatchObject({ type: "refus", raison: "groups_unknown" });
        expect(hote.serveur.requetes.filter((q) => q.type === "bind")).toHaveLength(1);
      },
    );

    it.each(CODES_PANNE.map((n) => [n, NOMS[n]] as const))(
      "RFC 4511 §4.1.9 : code %i (%s) à la liaison du service : « indisponible », jamais « absent »",
      async (code) => {
        hote.serveur.comportement.lier = () => ({ code });
        expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toEqual({
          type: "indisponible",
        });
        expect(hote.serveur.requetes.filter((q) => q.type === "search")).toHaveLength(0);
      },
    );

    it.each(CODES_PANNE.filter((n) => ![49, 53].includes(n)).map((n) => [n, NOMS[n]] as const))(
      "RFC 4511 §4.1.9 : code %i (%s) à la liaison de la personne : « indisponible », pas « mauvais mot de passe » (l'essai est compté dès que la liaison part, panne comprise)",
      async (code) => {
        const dnJean = profil.personnes[0]?.dn ?? "";
        const normal = profil.liaison;
        hote.serveur.comportement.lier = (dn, mdp) => (dn === dnJean ? { code } : normal(dn, mdp));
        expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toEqual({
          type: "indisponible",
        });
        const essais = await b.t.base.valeurs("SELECT provider_id, subject, count FROM auth_failures");
        expect(essais.map(([, , n]) => Number(n))).toEqual([1]);
      },
    );

    it("RFC 4511 §4.1.9 : codes 49 et 53 à la liaison de la personne : mauvais mot de passe", async () => {
      const dnJean = profil.personnes[0]?.dn ?? "";
      const normal = profil.liaison;
      for (const code of [49, 53]) {
        hote.serveur.comportement.lier = (dn, mdp) => (dn === dnJean ? { code } : normal(dn, mdp));
        expect(await authentifierParAnnuaire(b.dep(), "jean", MDP_PERSONNE)).toMatchObject({
          type: "refus",
          raison: "bad_password",
        });
      }
    });

    it.each(CODES_PANNE.map((n) => [n, NOMS[n]] as const))(
      "RFC 4511 §4.1.9 : code %i (%s) pendant le balayage : passe abandonnée ou entrée inconnue, aucun compte suspendu",
      async (code) => {
        const balayage = preparerBalayage(b, fabriqueReelle());
        try {
          const id = await balayage.rattacher("jean", profil.personnes[0]?.cle ?? "");
          codeUnique(code);
          for (let i = 0; i < 2; i++) {
            const r = await balayage.passe();
            expect(r.type).toBe("bilan");
            if (r.type === "bilan") expect(r.etat.suspended).toBe(0);
            b.horloge += 600;
          }
          expect(await balayage.suspendu(id)).toBe(false);
        } finally {
          await balayage.fermer();
        }
      },
    );

    it.each(CODES_PANNE.map((n) => [n, NOMS[n]] as const))(
      "RFC 4511 §4.1.9 : code %i (%s) pendant le bouton Tester : jamais une étape verte sur la base ou les groupes",
      async (code) => {
        codeUnique(code);
        const etapes = await jouerEssai(b, hote, "jean");
        expect(etapes.find((x) => x.id === "service_bind")?.level).toBe("ok");
        expect(etapes.find((x) => x.id === "user_base")?.level).toBe("fail");
        expect(etapes.some((x) => x.id === "test_user" && x.level === "ok")).toBe(false);
        for (const x of etapes) expect(x.detail).not.toContain("DIAGNOSTIC-SECRET");
      },
    );
  });
});
