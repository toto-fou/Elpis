// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/ldap-profils-autres.test.ts — FreeIPA, OpenLDAP (avec et sans surcouches), 389 DS, OpenDJ, groupes posixGroup et DN#UID, clés stables refusées (eDirectory, LLDAP, authentik) sur un vrai LDAPS local (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { BerWriter } from "ldapts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { authentifierParAnnuaire } from "../../src/identite/annuaire/connexion";
import { validerFournisseur } from "../../src/identite/reglages";
import type { BancAnnuaire } from "../identite/annuaire/banc-annuaire";
import { ldapValide } from "../identite/aides";
import { MOTEURS } from "../identite/banc";
import { OPENSSL_DISPONIBLE } from "../identite/pki-openssl";
import { demarrerHote, fabriqueReelle, jouerEssai, ouvrirBancReel, preparerBalayage } from "./banc-reel";
import type { Hote } from "./banc-reel";
import {
  IPA,
  IPA_UUID,
  MDP_PERSONNE,
  profil389,
  profilFreeipa,
  profilLldap,
  profilOpenDj,
  profilOpenLdap,
  profilOpenLdapMemberOf,
  profilUniqueMemberUid,
  variante,
} from "./profils-annuaire";
import type { ProfilAnnuaire } from "./profils-annuaire";

const OID_PPOLICY = "1.3.6.1.4.1.42.2.27.8.5.1";

/** Valeur du contrôle de réponse de politique de mot de passe : avertissement (délai ou grâce) et/ou erreur (0 expiré, 1 verrouillé, 2 changement exigé). */
function ppolicy(o: { delai?: number; grace?: number; erreur?: number }): Buffer {
  const w = new BerWriter();
  w.startSequence();
  if (o.delai !== undefined || o.grace !== undefined) {
    w.startSequence(0xa0);
    if (o.delai !== undefined) w.writeInt(o.delai, 0x80);
    else w.writeInt(o.grace ?? 0, 0x81);
    w.endSequence();
  }
  if (o.erreur !== undefined) w.writeEnumeration(o.erreur, 0x81);
  w.endSequence();
  return w.buffer;
}

describe("clés stables : attributs refusés par choix (plus strict que la norme)", () => {
  it.each([
    ["NetIQ eDirectory : GUID (chaîne d'octets)", "GUID", "cn"],
    [
      "LLDAP, attribut `uuid` (LLDAP se configure avec entryUUID, voir le profil LLDAP plus bas)",
      "uuid",
      "cn",
    ],
    ["authentik (outpost LDAP) : uid (identifiant unique de l'utilisateur)", "uid", "cn"],
    ["Oracle Internet Directory : orclguid", "orclguid", "cn"],
    ["IBM Security Directory Server : ibm-entryUuid", "ibm-entryUuid", "cn"],
    ["sAMAccountName ou DN comme clé", "sAMAccountName", "cn"],
  ])("%s : refusé comme clé stable (jamais de repli sur le nom, l'e-mail ou le DN)", (_n, cle, nom) => {
    expect(() =>
      validerFournisseur(
        ldapValide({ attrs: { id: cle, username: "uid2", email: "mail", name: nom }, required_groups: [] }),
      ),
    ).toThrowError();
  });
  it.each(["entryUUID", "ipaUniqueID", "objectGUID", "nsUniqueId"])(
    "%s : accepté comme clé stable",
    (cle) => {
      expect(() =>
        validerFournisseur(ldapValide({ attrs: { id: cle, username: "uid", email: "mail", name: "cn" } })),
      ).not.toThrow();
    },
  );
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("autres annuaires sur LDAPS local (%s)", (moteur) => {
  let hote: Hote;
  let b: BancAnnuaire;
  beforeAll(async () => {
    hote = await demarrerHote();
  });
  afterAll(async () => {
    await hote.fermer();
  });
  afterEach(async () => {
    expect(hote.serveur.erreursLecture()).toBe(0);
    await b?.fermer();
  });
  const ouvrir = async (p: ProfilAnnuaire, extra: Record<string, unknown> = {}): Promise<void> => {
    b = await ouvrirBancReel(moteur, hote, p, extra);
  };
  const auth = (uid: string, mdp = MDP_PERSONNE) => authentifierParAnnuaire(b.dep(), uid, mdp);
  const liaisons = (): string[] =>
    hote.serveur.requetes.filter((q) => q.type === "bind").map((q) => q.dn ?? "");
  const entreesModifiees = (
    p: ProfilAnnuaire,
    uid: string,
    f: (a: Record<string, readonly (string | Buffer)[]>) => Record<string, readonly (string | Buffer)[]>,
  ) => p.entrees.map((x) => (x.dn.startsWith(`uid=${uid},`) ? { ...x, attrs: f(x.attrs) } : x));

  describe("FreeIPA / Red Hat IdM (preset freeipa)", () => {
    it.each(["TRUE", "true", "True"])(
      "nsAccountLock %s : entrée désactivée, aucun mot de passe envoyé",
      async (v) => {
        const p = profilFreeipa();
        await ouvrir(
          variante(p, { entrees: entreesModifiees(p, "jean", (a) => ({ ...a, nsAccountLock: [v] })) }),
        );
        expect(await auth("jean")).toMatchObject({ raison: "entry_disabled" });
        expect(liaisons()).toEqual([IPA.SERVICE]);
      },
    );
    it("nsAccountLock illisible (« oui ») : état inconnu, aucun mot de passe envoyé", async () => {
      const p = profilFreeipa();
      await ouvrir(
        variante(p, { entrees: entreesModifiees(p, "jean", (a) => ({ ...a, nsAccountLock: ["oui"] })) }),
      );
      expect(await auth("jean")).toMatchObject({ raison: "state_unknown" });
      expect(liaisons()).toEqual([IPA.SERVICE]);
    });
    it("ni krbPasswordExpiration ni krbLastPwdChange lisibles (droits du compte de service) : état inconnu, jamais actif", async () => {
      const p = profilFreeipa();
      await ouvrir(
        variante(p, {
          entrees: entreesModifiees(p, "jean", (a) => {
            const { krbPasswordExpiration: _e, krbLastPwdChange: _d, ...reste } = a;
            return reste;
          }),
        }),
      );
      expect(await auth("jean")).toMatchObject({ raison: "state_unknown" });
    });
    it("krbPasswordExpiration échu : mot de passe expiré, aucun mot de passe envoyé", async () => {
      await ouvrir(profilFreeipa());
      expect(await auth("expire")).toMatchObject({ raison: "password_expired" });
      expect(liaisons()).toEqual([IPA.SERVICE]);
    });
    it("compte de service sous cn=sysaccounts : liaison acceptée par DN complet", async () => {
      await ouvrir(profilFreeipa());
      expect(await auth("jean")).toMatchObject({ type: "ok" });
      expect(liaisons()[0]).toBe(IPA.SERVICE);
    });
    it("membre d'un sous-groupe : accepté quand memberOf liste aussi le groupe parent (membership indirect)", async () => {
      await ouvrir(profilFreeipa());
      expect(await auth("imbrique")).toMatchObject({ type: "ok" });
    });
    it("memberOf direct seul (le groupe parent n'apparaît pas) : refus not_in_group, aucune liaison (à confirmer sur un serveur réel)", async () => {
      const p = profilFreeipa();
      await ouvrir(
        variante(p, {
          entrees: entreesModifiees(p, "imbrique", (a) => ({
            ...a,
            memberOf: [IPA.GROUPE.replace("elpis", "elpis-equipe")],
          })),
        }),
      );
      expect(await auth("imbrique")).toMatchObject({ raison: "not_in_group" });
    });
    it("mot de passe suivi du code à usage unique : envoyé tel quel, accepté", async () => {
      const p = profilFreeipa();
      const dn = p.personnes[0]?.dn ?? "";
      await ouvrir(
        variante(p, {
          liaison: (d, m) =>
            d === dn
              ? m.toString() === `${MDP_PERSONNE}123456`
                ? { code: 0 }
                : { code: 49 }
              : p.liaison(d, m),
        }),
      );
      expect(await auth("jean", `${MDP_PERSONNE}123456`)).toMatchObject({ type: "ok" });
      expect(await auth("jean")).toMatchObject({ raison: "bad_password" });
    });
    it("test complet, sans étape en échec", async () => {
      await ouvrir(profilFreeipa());
      expect((await jouerEssai(b, hote, "jean")).filter((x) => x.level === "fail")).toEqual([]);
    });
    it("balayage : compte désactivé = départ observé, compte actif = vu, jamais de suspension à la première passe", async () => {
      await ouvrir(profilFreeipa());
      const balayage = preparerBalayage(b, fabriqueReelle());
      try {
        const a = await balayage.rattacher("jean", IPA_UUID(1));
        const d = await balayage.rattacher("desactive", IPA_UUID(2));
        const r = await balayage.passe();
        expect(r).toMatchObject({ type: "bilan", etat: { aborted: null, seen: 2, unknown: 0 } });
        if (r.type === "bilan") expect(r.etat.observed.map((o) => o.reason)).toEqual(["entry_disabled"]);
        expect(await balayage.suspendu(a)).toBe(false);
        expect(await balayage.suspendu(d)).toBe(false);
      } finally {
        await balayage.fermer();
      }
    });
  });

  describe("OpenLDAP", () => {
    it("groupOfNames, mode member, sans surcouche : parcours complet accepté", async () => {
      await ouvrir(profilOpenLdap());
      expect(await auth("jean")).toMatchObject({ type: "ok" });
      expect(await auth("horsgroupe")).toMatchObject({ raison: "not_in_group" });
      expect(liaisons()).not.toContain(profilOpenLdap().personnes[2]?.dn);
    });
    it("avec la surcouche memberof, mode memberof : parcours complet accepté", async () => {
      await ouvrir(profilOpenLdapMemberOf());
      expect(await auth("jean")).toMatchObject({ type: "ok" });
      expect(await auth("horsgroupe")).toMatchObject({ raison: "not_in_group" });
    });
    it("sans la surcouche, mode memberof : personne n'entre (refus not_in_group), le balayage s'abandonne sans suspendre", async () => {
      await ouvrir(variante(profilOpenLdap(), { reglages: { groups: { mode: "memberof" } } }));
      expect(await auth("jean")).toMatchObject({ raison: "not_in_group" });
      const balayage = preparerBalayage(b, fabriqueReelle());
      try {
        const id = await balayage.rattacher("jean", profilOpenLdap().personnes[0]?.cle ?? "");
        const r = await balayage.passe();
        expect(r).toMatchObject({ type: "bilan", etat: { aborted: "membership_unreadable", suspended: 0 } });
        expect(await balayage.suspendu(id)).toBe(false);
      } finally {
        await balayage.fermer();
      }
    });
    it("contrôle de politique de mot de passe (avertissement d'expiration) joint à une liaison réussie : connexion acceptée", async () => {
      const p = profilOpenLdap();
      const dn = p.personnes[0]?.dn ?? "";
      await ouvrir(
        variante(p, {
          liaison: (d, m) =>
            d === dn
              ? { code: 0, controles: [{ oid: OID_PPOLICY, valeur: ppolicy({ delai: 3600 }) }] }
              : p.liaison(d, m),
        }),
      );
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });
    it.each([
      [0, "passwordExpired"],
      [1, "accountLocked"],
      [2, "changeAfterReset"],
    ])(
      "contrôle de politique erreur %i (%s) joint à un code 49 : refus bad_password, rien d'autre",
      async (erreur) => {
        const p = profilOpenLdap();
        const dn = p.personnes[0]?.dn ?? "";
        await ouvrir(
          variante(p, {
            liaison: (d, m) =>
              d === dn
                ? { code: 49, controles: [{ oid: OID_PPOLICY, valeur: ppolicy({ erreur }) }] }
                : p.liaison(d, m),
          }),
        );
        expect(await auth("jean")).toMatchObject({ type: "refus", raison: "bad_password" });
      },
    );
    it("connexions de grâce (contrôle d'avertissement graceAuthNsRemaining) : connexion acceptée", async () => {
      const p = profilOpenLdap();
      const dn = p.personnes[0]?.dn ?? "";
      await ouvrir(
        variante(p, {
          liaison: (d, m) =>
            d === dn
              ? { code: 0, controles: [{ oid: OID_PPOLICY, valeur: ppolicy({ grace: 2 }) }] }
              : p.liaison(d, m),
        }),
      );
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });
    it("contrôle critique inconnu joint à une réponse de liaison : ignoré, la connexion suit le code de résultat", async () => {
      const p = profilOpenLdap();
      const dn = p.personnes[0]?.dn ?? "";
      await ouvrir(
        variante(p, {
          liaison: (d, m) =>
            d === dn
              ? { code: 0, controles: [{ oid: "1.2.3.4.5.6", valeur: Buffer.from([1, 2]) }] }
              : p.liaison(d, m),
        }),
      );
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });
    it("posixGroup / memberUid (RFC 2307) : le mode member ne le lit pas, personne n'entre : LIMITE d'interopérabilité", async () => {
      const p = profilOpenLdap();
      const entrees = p.entrees.map((x) =>
        x.dn.startsWith("cn=elpis,")
          ? {
              dn: x.dn,
              attrs: {
                objectClass: ["top", "posixGroup"],
                cn: ["elpis"],
                gidNumber: ["1001"],
                memberUid: ["jean", "ferme"],
              },
            }
          : x,
      );
      await ouvrir(variante(p, { entrees }));
      expect(await auth("jean")).toMatchObject({ raison: "not_in_group" });
    });
    it("groupOfUniqueNames, valeurs DN#UID (uniqueMemberMatch d'OpenLDAP : une valeur avec UID ne correspond pas à une assertion sans UID) : personne n'entre en mode member", async () => {
      await ouvrir(profilUniqueMemberUid());
      expect(await auth("jean")).toMatchObject({ raison: "not_in_group" });
      expect(liaisons()).not.toContain(profilUniqueMemberUid().personnes[0]?.dn);
    });
  });

  describe("serveur non identifié", () => {
    it("groupOfUniqueNames, valeurs DN#UID, serveur qui ignore l'UID absent de l'assertion : accepté", async () => {
      await ouvrir(variante(profilUniqueMemberUid(), { options: { uniqueMemberStrict: false } }));
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });
  });

  describe("389 Directory Server / Red Hat Directory Server (nsUniqueId, préréglage « other »)", () => {
    it("parcours complet : clé nsUniqueId, greffon memberOf présent, mode memberof", async () => {
      await ouvrir(profil389());
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });
    it("compte désactivé (code 53) : refus bad_password, état non lu par ce préréglage", async () => {
      await ouvrir(profil389());
      expect(await auth("ferme")).toMatchObject({ raison: "bad_password" });
    });
    it("verrou par échecs répétés (code 19, « Exceed password retry limit ») : refus bad_password", async () => {
      const p = profil389();
      const dn = p.personnes[1]?.dn ?? "";
      await ouvrir(
        variante(p, {
          liaison: (d, m) =>
            d === dn ? { code: 19, diagnostic: "Exceed password retry limit." } : p.liaison(d, m),
        }),
      );
      expect(await auth("ferme")).toMatchObject({ raison: "bad_password" });
    });
    it("greffon MemberOf absent, mode memberof : personne n'entre ; mode member : tous les membres entrent", async () => {
      const p = profil389();
      const sans = p.entrees.map((x) => {
        const { memberOf: _m, ...reste } = x.attrs;
        return { ...x, attrs: reste };
      });
      await ouvrir(variante(p, { entrees: sans }));
      expect(await auth("jean")).toMatchObject({ raison: "not_in_group" });
      await b.fermer();
      await ouvrir(variante(p, { entrees: sans, reglages: { groups: { mode: "member" } } }));
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });
    it("groupe imbriqué avec memberOf transitif : admis en mode memberof, refusé en mode member", async () => {
      await ouvrir(profil389());
      expect(await auth("imbrique")).toMatchObject({ type: "ok" });
      await b.fermer();
      await ouvrir(variante(profil389(), { reglages: { groups: { mode: "member" } } }));
      expect(await auth("imbrique")).toMatchObject({ type: "refus", raison: "not_in_group" });
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });
    it("test complet, sans étape en échec", async () => {
      await ouvrir(profil389());
      expect((await jouerEssai(b, hote, "jean")).filter((x) => x.level === "fail")).toEqual([]);
    });
  });

  describe("LLDAP (entryUUID, memberOf, code 32 sur une recherche de portée base sans correspondance)", () => {
    it("membre du groupe : connexion acceptée", async () => {
      await ouvrir(profilLldap());
      expect(await auth("jean")).toMatchObject({ type: "ok" });
    });
    it("non-membre : refus groups_unknown (le code 32 se lit « inconnu », jamais « non »), aucune liaison de personne", async () => {
      await ouvrir(profilLldap());
      expect(await auth("horsgroupe")).toMatchObject({ type: "refus", raison: "groups_unknown" });
      expect(liaisons()).toEqual([profilLldap().serviceDn]);
    });
    it("balayage : un membre retiré du groupe est « inconnu » (jamais observé comme parti), il n'est pas suspendu", async () => {
      const p = profilLldap();
      const sans = entreesModifiees(p, "jean", (a) => {
        const { memberOf: _m, ...reste } = a;
        return reste;
      });
      await ouvrir(variante(p, { entrees: sans }));
      const balayage = preparerBalayage(b, fabriqueReelle());
      try {
        const id = await balayage.rattacher("jean", p.personnes[0]?.cle ?? "");
        const r = await balayage.passe();
        expect(r).toMatchObject({
          type: "bilan",
          etat: { aborted: null, seen: 0, unknown: 1, suspended: 0 },
        });
        if (r.type === "bilan") expect(r.etat.observed).toEqual([]);
        expect(await balayage.suspendu(id)).toBe(false);
      } finally {
        await balayage.fermer();
      }
    });
    it("test complet, sans étape en échec", async () => {
      await ouvrir(profilLldap());
      expect((await jouerEssai(b, hote, "jean")).filter((x) => x.level === "fail")).toEqual([]);
    });
  });

  describe("OpenDJ / ForgeRock DS / Ping DS (entryUUID, groupOfUniqueNames, isMemberOf)", () => {
    it("mode member : parcours complet accepté", async () => {
      await ouvrir(profilOpenDj());
      expect(await auth("jean")).toMatchObject({ type: "ok" });
      expect(await auth("horsgroupe")).toMatchObject({ raison: "not_in_group" });
    });
    it("mode memberof : le produit lit `memberOf`, pas `isMemberOf` : personne n'entre : LIMITE d'interopérabilité", async () => {
      await ouvrir(variante(profilOpenDj(), { reglages: { groups: { mode: "memberof" } } }));
      expect(await auth("jean")).toMatchObject({ raison: "not_in_group" });
    });
    it("test complet, sans étape en échec", async () => {
      await ouvrir(profilOpenDj());
      expect((await jouerEssai(b, hote, "jean")).filter((x) => x.level === "fail")).toEqual([]);
    });
  });
});
