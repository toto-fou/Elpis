// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/client-reel.test.ts — l'adaptateur réel de bout en bout sur LDAPS local : TLS vérifié, liaison, recherche bornée, renvois ignorés, attributs binaires, aucune reconnexion, plafond d'octets, annuaire muet. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { fabriqueLdapts } from "../../../src/identite/annuaire/client";
import type { ConnexionAnnuaire } from "../../../src/identite/annuaire/client";
import { appartient } from "../../../src/identite/annuaire/appartenance";
import { ErreurAnnuaire } from "../../../src/identite/annuaire/erreur";
import { chercherUtilisateur, cleStable, etatEntree } from "../../../src/identite/annuaire/entree";
import { PRESETS } from "../../../src/identite/annuaire/presets";
import { creerAutoSigne, creerAutorite, creerFeuille, effacer, OPENSSL_DISPONIBLE } from "../pki-openssl";
import type { Autorite } from "../pki-openssl";
import { fournisseur } from "./faux";
import { demarrerServeurLdap } from "./serveur-ldap";
import type { ServeurLdap } from "./serveur-ldap";

const NOM = "elpis-test.invalid";
const VERS_BOUCLE = async (): Promise<{ motif: null; adresses: string[] }> => ({
  motif: null,
  adresses: ["127.0.0.1"],
});
const DN = "uid=svc,cn=users,dc=exemple,dc=lan";
const DN_JEAN = "uid=jdupont,cn=users,dc=exemple,dc=lan";
const GUID = Buffer.from([
  0xff, 0xfe, 0x00, 0x80, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xc3,
]);
const PARAMS = {
  portee: "sub" as const,
  filtre: "(uid=jdupont)",
  attributs: ["uid", "objectGUID", "mail"],
  limite: 2,
};

describe.skipIf(!OPENSSL_DISPONIBLE)("adaptateur réel sur LDAPS local", () => {
  let ca: Autorite;
  let serveur: ServeurLdap;

  beforeAll(async () => {
    ca = creerAutorite("Annuaire de test");
    const f = creerFeuille(ca, { noms: [NOM] });
    serveur = await demarrerServeurLdap(f.cert, f.cle);
    serveur.comportement.comptes[DN] = "mot-de-passe-service";
    serveur.comportement.comptes[DN_JEAN] = "mot-de-passe-jean";
  });
  afterAll(async () => {
    await serveur.fermer();
    effacer(ca);
  });

  const url = (): string => `ldaps://${NOM}:${serveur.port}`;
  const ouvrir = (extra: Record<string, unknown> = {}, ca_pem = ca.cert): Promise<ConnexionAnnuaire> =>
    fabriqueLdapts({ juger: VERS_BOUCLE })(fournisseur({ ca_pem, ...extra }), url());

  it("lie, cherche, rend des attributs en minuscules et l'objectGUID en octets, ignore les renvois", async () => {
    serveur.comportement.entrees = [
      { dn: DN_JEAN, attrs: { uid: ["jdupont"], objectGUID: [GUID], mail: ["a@x.fr", "b@x.fr"] } },
    ];
    serveur.comportement.renvoi = "ldaps://autre.exemple.lan/dc=x";
    serveur.requetes.length = 0;
    const cnx = await ouvrir();
    await cnx.lier(DN, "mot-de-passe-service");
    const r = await cnx.chercher("cn=users,dc=exemple,dc=lan", PARAMS);
    await cnx.fermer();
    serveur.comportement.renvoi = null;
    expect(r).toHaveLength(1);
    expect(r[0]?.dn).toBe(DN_JEAN);
    expect(Object.keys(r[0]?.attrs ?? {}).sort()).toEqual(["mail", "objectguid", "uid"]);
    expect(r[0]?.attrs["uid"]).toEqual(["jdupont"]);
    expect(r[0]?.attrs["mail"]).toEqual(["a@x.fr", "b@x.fr"]);
    const guid = r[0]?.attrs["objectguid"]?.[0];
    expect(Buffer.isBuffer(guid) && guid.equals(GUID)).toBe(true);
    const types = serveur.requetes.map((q) => q.type);
    expect(types.slice(0, 2)).toEqual(["bind", "search"]);
  });

  it("borne la recherche : limite, délai du serveur, attributs nommés, `derefAliases` « never » sur le fil (ce que ldapts envoie aussi par défaut)", async () => {
    serveur.requetes.length = 0;
    const cnx = await ouvrir({ timeout_sec: 7 });
    await cnx.lier(DN, "mot-de-passe-service");
    await cnx.chercher("cn=users,dc=exemple,dc=lan", { ...PARAMS, portee: "base", limite: 2 });
    await cnx.fermer();
    const q = serveur.requetes.find((x) => x.type === "search");
    expect(q).toMatchObject({
      base: "cn=users,dc=exemple,dc=lan",
      portee: 0,
      deref: 0,
      limite: 2,
      delai: 7,
      attributs: ["uid", "objectGUID", "mail"],
    });
    expect(q?.attributs).not.toContain("*");
  });

  it("sansLimiteServeur : la limite n'est pas transmise, la réponse est tronquée ici, et « limite atteinte » du serveur lève une erreur au lieu d'un « absent »", async () => {
    serveur.comportement.entrees = [
      { dn: "uid=a,dc=x", attrs: { uid: ["a"] } },
      { dn: "uid=b,dc=x", attrs: { uid: ["b"] } },
      { dn: "uid=c,dc=x", attrs: { uid: ["c"] } },
    ];
    serveur.requetes.length = 0;
    const cnx = await ouvrir();
    await cnx.lier(DN, "mot-de-passe-service");
    const deux = await cnx.chercher("cn=users,dc=exemple,dc=lan", { ...PARAMS, sansLimiteServeur: true });
    expect(deux).toHaveLength(2);
    expect(serveur.requetes.find((q) => q.type === "search")?.limite).toBe(0);
    serveur.comportement.entrees = [];
    serveur.comportement.codeRecherche = 4;
    await expect(
      cnx.chercher("cn=users,dc=exemple,dc=lan", { ...PARAMS, sansLimiteServeur: true }),
    ).rejects.toMatchObject({ nature: "protocole", code: 4 });
    serveur.comportement.codeRecherche = 0;
    await cnx.fermer();
  });

  it("un filtre d'identifiant hostile arrive échappé", async () => {
    serveur.comportement.entrees = [];
    serveur.requetes.length = 0;
    const cnx = await ouvrir();
    await cnx.lier(DN, "mot-de-passe-service");
    const f = fournisseur({ preset: "openldap", ca_pem: ca.cert, user_filter: PRESETS.openldap.filtre });
    expect(await chercherUtilisateur(cnx, f, "*)(uid=*")).toBe("absent");
    await cnx.fermer();
    const q = serveur.requetes.find((x) => x.type === "search");
    expect(q?.filtre).toBe("(&(objectclass=inetorgperson)(uid=\\2a\\29\\28uid=\\2a))");
  });

  it("deux entrées : « ambigu » ; entrée unique : clé stable et état", async () => {
    const uuid = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
    serveur.comportement.entrees = [
      { dn: DN_JEAN, attrs: { uid: ["jdupont"], entryUUID: [uuid.toUpperCase()] } },
    ];
    const f = fournisseur({ preset: "openldap", ca_pem: ca.cert, user_filter: PRESETS.openldap.filtre });
    const cnx = await ouvrir();
    await cnx.lier(DN, "mot-de-passe-service");
    const e = await chercherUtilisateur(cnx, f, "jdupont");
    await cnx.fermer();
    expect(e).not.toBe("absent");
    expect(e).not.toBe("ambigu");
    if (typeof e === "string") return;
    expect(cleStable(e, f)).toBe(uuid);
    expect(etatEntree(e, f, Date.now())).toBe("active");
    serveur.comportement.entrees = [
      { dn: "uid=a,dc=x", attrs: {} },
      { dn: "uid=b,dc=x", attrs: {} },
    ];
    const cnx2 = await ouvrir();
    await cnx2.lier(DN, "mot-de-passe-service");
    expect(await chercherUtilisateur(cnx2, f, "jdupont")).toBe("ambigu");
    await cnx2.fermer();
  });

  it("appartenance : une entrée renvoyée vaut oui, aucune vaut non", async () => {
    const f = fournisseur({ ca_pem: ca.cert, groups: { mode: "memberof" } });
    const cnx = await ouvrir();
    await cnx.lier(DN, "mot-de-passe-service");
    serveur.comportement.entrees = [{ dn: DN_JEAN, attrs: {} }];
    expect(await appartient(cnx, f, { dn: DN_JEAN, attrs: {} }, "cn=g,dc=x")).toBe(true);
    serveur.comportement.entrees = [];
    expect(await appartient(cnx, f, { dn: DN_JEAN, attrs: {} }, "cn=g,dc=x")).toBe(false);
    serveur.comportement.codeRecherche = 51;
    await expect(appartient(cnx, f, { dn: DN_JEAN, attrs: {} }, "cn=g,dc=x")).rejects.toMatchObject({
      nature: "protocole",
      code: 51,
    });
    serveur.comportement.codeRecherche = 0;
    await cnx.fermer();
  });

  it("mauvais mot de passe : « identifiants » ; une seule liaison par connexion", async () => {
    const cnx = await ouvrir();
    await expect(cnx.lier(DN_JEAN, "faux")).rejects.toMatchObject({ nature: "identifiants", code: 49 });
    await expect(cnx.lier(DN_JEAN, "mot-de-passe-jean")).rejects.toMatchObject({ nature: "configuration" });
    await cnx.fermer();
    const bonne = await ouvrir();
    await expect(bonne.lier(DN_JEAN, "mot-de-passe-jean")).resolves.toBeUndefined();
    await bonne.fermer();
  });

  it("aucune reconnexion : le serveur ferme la connexion, aucune nouvelle socket n'est ouverte, l'opération échoue", async () => {
    const cnx = await ouvrir();
    await cnx.lier(DN, "mot-de-passe-service");
    const avant = serveur.connexions();
    serveur.couper();
    await new Promise((ok) => setTimeout(ok, 100));
    serveur.requetes.length = 0;
    await expect(cnx.chercher("dc=x", PARAMS)).rejects.toBeInstanceOf(ErreurAnnuaire);
    await cnx.fermer();
    expect(serveur.connexions()).toBe(avant);
    expect(serveur.requetes.filter((q) => q.type !== "unbind")).toHaveLength(0);
    expect(serveur.erreursLecture()).toBe(0);
    const ferme = await ouvrir();
    await ferme.fermer();
    await expect(ferme.chercher("dc=x", PARAMS)).rejects.toMatchObject({ nature: "injoignable" });
  });

  describe("plafond d'octets reçus par opération", () => {
    const gros = (n: number): void => {
      serveur.comportement.entrees = Array.from({ length: n }, (_, i) => ({
        dn: `uid=u${i},cn=users,dc=exemple,dc=lan`,
        attrs: { uid: [`u${i}`], mail: ["x".repeat(200_000)] },
      }));
    };
    afterEach(() => {
      serveur.comportement.entrees = [];
    });

    it("une réponse de plus de 1 Mio : socket détruite, l'opération échoue en « protocole »", async () => {
      gros(8);
      const cnx = await ouvrir();
      await cnx.lier(DN, "mot-de-passe-service");
      await expect(cnx.chercher("cn=users,dc=exemple,dc=lan", PARAMS)).rejects.toMatchObject({
        nature: "protocole",
      });
      await cnx.fermer();
    });

    it("le compteur repart à chaque opération : des réponses de 600 Kio à la suite passent", async () => {
      gros(3);
      const cnx = await ouvrir();
      await cnx.lier(DN, "mot-de-passe-service");
      for (let i = 0; i < 4; i++)
        expect(await cnx.chercher("cn=users,dc=exemple,dc=lan", PARAMS)).toHaveLength(2);
      await cnx.fermer();
    });
  });

  it("une autorité inconnue : « injoignable », jamais une liaison", async () => {
    serveur.requetes.length = 0;
    const autre = creerAutorite("Autre autorité");
    try {
      const cnx = await ouvrir({}, autre.cert);
      await expect(cnx.lier(DN, "mot-de-passe-service")).rejects.toMatchObject({
        nature: "injoignable",
        sortant: "ca_inconnue",
      });
      expect(serveur.requetes.filter((q) => q.type !== "unbind")).toHaveLength(0);
      expect(serveur.erreursLecture()).toBe(0);
    } finally {
      effacer(autre);
    }
  });

  it("un certificat auto-signé n'est pas accepté", async () => {
    const as = creerAutoSigne(NOM);
    try {
      const cnx = await ouvrir({}, as.cert);
      await expect(cnx.lier(DN, "mot-de-passe-service")).rejects.toMatchObject({ nature: "injoignable" });
    } finally {
      effacer(as);
    }
  });

  it("un annuaire muet : « injoignable » au délai, pas d'attente infinie", async () => {
    serveur.comportement.muet = true;
    try {
      const cnx = await ouvrir({ timeout_sec: 2 });
      const debut = Date.now();
      await expect(cnx.lier(DN, "mot-de-passe-service")).rejects.toMatchObject({ nature: "injoignable" });
      expect(Date.now() - debut).toBeLessThan(5000);
      await cnx.fermer();
    } finally {
      serveur.comportement.muet = false;
    }
  }, 10_000);
});
