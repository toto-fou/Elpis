// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/profils-annuaire.ts — profils d'annuaires du marché (entrées, états de compte, liaison, limites) joués par le serveur LDAPS de test. */
import type { EntreeServeur, ReponseLiaison, ServeurLdap } from "../identite/annuaire/serveur-ldap";
import { creerRepertoire, dnPlie } from "./repertoire-ldap";
import type { OptionsRepertoire } from "./repertoire-ldap";

export interface PersonneProfil {
  readonly uid: string;
  readonly dn: string;
  readonly mdp: string;
  /** Clé stable que le produit doit en tirer (sujet canonique). */
  readonly cle: string;
  /** Refus attendu du produit, `null` : connexion acceptée. */
  readonly attendu: string | null;
  /** Saisie tapée à la connexion (l'identifiant par défaut). */
  readonly saisie?: string;
}

export interface ProfilAnnuaire {
  readonly id: string;
  readonly libelle: string;
  /** Adresses lues pour établir le profil. */
  readonly sources: readonly string[];
  readonly reglages: Record<string, unknown>;
  readonly serviceDn: string;
  readonly serviceMdp: string;
  readonly entrees: readonly EntreeServeur[];
  readonly options: OptionsRepertoire;
  readonly personnes: readonly PersonneProfil[];
  /** Réponse de liaison d'un compte connu dont le mot de passe est faux ou dont le compte est fermé. */
  readonly liaison: (dn: string, mdp: Buffer) => ReponseLiaison;
}

/** Copie du profil avec ces éléments remplacés (réglages fusionnés). */
export function variante(
  p: ProfilAnnuaire,
  v: {
    entrees?: readonly EntreeServeur[];
    options?: OptionsRepertoire;
    reglages?: Record<string, unknown>;
    liaison?: ProfilAnnuaire["liaison"];
  },
): ProfilAnnuaire {
  return {
    ...p,
    entrees: v.entrees ?? p.entrees,
    options: { ...p.options, ...(v.options ?? {}) },
    reglages: { ...p.reglages, ...(v.reglages ?? {}) },
    liaison: v.liaison ?? p.liaison,
  };
}

export const MDP_SERVICE = "mot-de-passe-de-service";
export const MDP_PERSONNE = "mot-de-passe-de-la-personne";

/** Pose le profil sur le serveur de test : recherche évaluée sur ses entrées, liaison selon `liaison`. */
export function installerProfil(serveur: ServeurLdap, p: ProfilAnnuaire): void {
  const c = serveur.comportement;
  c.rechercher = creerRepertoire(p.entrees, p.options);
  c.lier = (dn, mdp) => p.liaison(dn, mdp);
  serveur.requetes.length = 0;
}

type Attrs = Record<string, (string | Buffer)[]>;
const e = (dn: string, attrs: Attrs): EntreeServeur => ({ dn, attrs });

/** Liaison simple standard : succès si le DN est connu avec ce mot de passe, sinon `refus`. */
export function liaisonParTable(
  comptes: ReadonlyMap<string, string>,
  refus: (dn: string, mdp: Buffer) => ReponseLiaison,
  fermes: ReadonlyMap<string, ReponseLiaison> = new Map(),
): (dn: string, mdp: Buffer) => ReponseLiaison {
  return (dn, mdp) => {
    const cle = dnPlie(dn);
    const ferme = fermes.get(cle);
    if (ferme !== undefined) return ferme;
    const attendu = comptes.get(cle);
    if (attendu !== undefined && mdp.length > 0 && attendu === mdp.toString()) return { code: 0 };
    return refus(dn, mdp);
  };
}

const futur = "20990101000000Z";
const passe = "20200101000000Z";

// ---------------------------------------------------------------- Active Directory
const AD_RACINE = "DC=corp,DC=example";
const AD_UTILISATEURS = `CN=Users,${AD_RACINE}`;
const AD_GROUPE = `CN=Elpis,OU=Groupes,${AD_RACINE}`;
const AD_GROUPE_SOUS = `CN=Elpis-Equipe,OU=Groupes,${AD_RACINE}`;
const AD_SERVICE = `CN=svc-elpis,${AD_UTILISATEURS}`;

/** objectGUID binaire : 16 octets (ordre mixte d'AD), le dernier octet distingue les comptes. */
export const guidAd = (n: number): Buffer =>
  Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, n]);

function ad(
  nom: string,
  uac: number,
  calcule: number,
  extra: Attrs = {},
  groupes: string[] = [],
  n = 1,
): { entree: EntreeServeur; groupes: string[] } {
  const dn = `CN=${nom},${AD_UTILISATEURS}`;
  return {
    groupes,
    entree: e(dn, {
      objectClass: ["top", "person", "organizationalPerson", "user"],
      objectCategory: [`CN=Person,CN=Schema,CN=Configuration,${AD_RACINE}`],
      cn: [nom],
      sAMAccountName: [nom],
      userPrincipalName: [`${nom}@corp.example`],
      displayName: [`Nom ${nom}`],
      mail: [`${nom}@corp.example`],
      objectGUID: [guidAd(n)],
      userAccountControl: [String(uac)],
      "msDS-User-Account-Control-Computed": [String(calcule)],
      primaryGroupID: ["513"],
      pwdLastSet: ["133000000000000000"],
      accountExpires: ["9223372036854775807"],
      lockoutTime: ["0"],
      ...extra,
    }),
  };
}

export function profilActiveDirectory(): ProfilAnnuaire {
  const comptes = [
    ad("jean", 512, 0, {}, [AD_GROUPE], 1),
    ad("desactive", 514, 0, {}, [AD_GROUPE], 2),
    ad("verrouille", 512, 0x10, {}, [AD_GROUPE], 3),
    ad("expire", 512, 0x800000, {}, [AD_GROUPE], 4),
    ad("horsgroupe", 512, 0, {}, [], 5),
    ad("imbrique", 512, 0, {}, [AD_GROUPE_SOUS], 6),
    ad("sansexpiration", 512 | 0x10000, 0, {}, [AD_GROUPE], 7),
  ];
  const service = e(AD_SERVICE, {
    objectClass: ["top", "person", "organizationalPerson", "user"],
    cn: ["svc-elpis"],
  });
  const membres = (g: string): string[] =>
    comptes.filter((c) => c.groupes.includes(g)).map((c) => c.entree.dn);
  const entrees: EntreeServeur[] = [
    e(AD_RACINE, { objectClass: ["top", "domain", "domainDNS"] }),
    e(AD_UTILISATEURS, { objectClass: ["top", "container"] }),
    e(`OU=Groupes,${AD_RACINE}`, { objectClass: ["top", "organizationalUnit"] }),
    service,
    ...comptes.map((c) => ({
      dn: c.entree.dn,
      attrs: {
        ...c.entree.attrs,
        memberOf: [...c.groupes],
      },
    })),
    e(AD_GROUPE, {
      objectClass: ["top", "group"],
      cn: ["Elpis"],
      groupType: ["-2147483646"],
      primaryGroupToken: ["1105"],
      member: [...membres(AD_GROUPE), AD_GROUPE_SOUS],
    }),
    e(AD_GROUPE_SOUS, {
      objectClass: ["top", "group"],
      cn: ["Elpis-Equipe"],
      member: membres(AD_GROUPE_SOUS),
      memberOf: [AD_GROUPE],
    }),
  ];
  const ferme = (dn: string, data: string): [string, ReponseLiaison] => [
    dnPlie(dn),
    {
      code: 49,
      diagnostic: `80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data ${data}, v4563`,
    },
  ];
  const table = new Map<string, string>([[dnPlie(AD_SERVICE), MDP_SERVICE]]);
  for (const c of comptes) table.set(dnPlie(c.entree.dn), MDP_PERSONNE);
  const liaison = liaisonParTable(
    table,
    () => ({
      code: 49,
      diagnostic: "80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563",
    }),
    new Map([
      ferme(`CN=desactive,${AD_UTILISATEURS}`, "533"),
      ferme(`CN=verrouille,${AD_UTILISATEURS}`, "775"),
      ferme(`CN=expire,${AD_UTILISATEURS}`, "532"),
    ]),
  );
  const cle = (n: number): string => guidAd(n).toString("hex");
  const p = (uid: string, n: number, attendu: string | null): PersonneProfil => ({
    uid,
    dn: `CN=${uid},${AD_UTILISATEURS}`,
    mdp: MDP_PERSONNE,
    cle: cle(n),
    attendu,
  });
  return {
    id: "active-directory",
    libelle: "Microsoft Active Directory (2016 à 2022)",
    sources: [
      "https://learn.microsoft.com/en-us/windows/win32/adschema/a-useraccountcontrol",
      "https://learn.microsoft.com/en-us/windows/win32/adschema/a-msds-user-account-control-computed",
      "https://learn.microsoft.com/en-us/windows/win32/adschema/a-objectguid",
      "https://learn.microsoft.com/en-us/windows/win32/adsi/search-filter-syntax",
      "https://knowledge.broadcom.com/external/article/51487/common-active-directory-ldap-bind-errors.html",
    ],
    reglages: {
      preset: "active-directory",
      bind_dn: AD_SERVICE,
      user_base_dn: AD_UTILISATEURS,
      user_filter: "(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))",
      attrs: { id: "objectGUID", username: "sAMAccountName", email: "mail", name: "displayName" },
      groups: { mode: "chain" },
      required_groups: [AD_GROUPE],
    },
    serviceDn: AD_SERVICE,
    serviceMdp: MDP_SERVICE,
    entrees,
    options: {
      limiteServeur: 1000,
      binaires: ["objectguid"],
      construits: ["msds-user-account-control-computed"],
      regleChaine: "supportee",
      plageMembres: 1500,
      racineDse: e("", { currentTime: ["20270115080000.0Z"], defaultNamingContext: [AD_RACINE] }),
    },
    personnes: [
      p("jean", 1, null),
      p("desactive", 2, "entry_disabled"),
      p("verrouille", 3, "entry_locked"),
      p("expire", 4, "password_expired"),
      p("horsgroupe", 5, "not_in_group"),
      p("imbrique", 6, null),
      p("sansexpiration", 7, null),
    ],
    liaison,
  };
}

export const AD = {
  RACINE: AD_RACINE,
  UTILISATEURS: AD_UTILISATEURS,
  GROUPE: AD_GROUPE,
  SERVICE: AD_SERVICE,
};

// ---------------------------------------------------------------- FreeIPA / Red Hat IdM
const IPA_RACINE = "dc=ipa,dc=exemple,dc=lan";
const IPA_UTILISATEURS = `cn=users,cn=accounts,${IPA_RACINE}`;
const IPA_GROUPE = `cn=elpis,cn=groups,cn=accounts,${IPA_RACINE}`;
const IPA_GROUPE_SOUS = `cn=elpis-equipe,cn=groups,cn=accounts,${IPA_RACINE}`;
const IPA_SERVICE = `uid=elpis,cn=sysaccounts,cn=etc,${IPA_RACINE}`;
export const IPA_UUID = (n: number): string => `1b2c3d4e-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function profilFreeipa(): ProfilAnnuaire {
  const user = (
    uid: string,
    n: number,
    verrou: string | null,
    expiration: string | null,
    dernier: string | null,
    groupes: string[],
  ): EntreeServeur =>
    e(`uid=${uid},${IPA_UTILISATEURS}`, {
      objectClass: [
        "top",
        "person",
        "organizationalperson",
        "inetorgperson",
        "inetuser",
        "posixaccount",
        "krbprincipalaux",
        "ipaobject",
      ],
      uid: [uid],
      cn: [`Nom ${uid}`],
      mail: [`${uid}@ipa.exemple.lan`],
      ipaUniqueID: [IPA_UUID(n)],
      ...(verrou === null ? {} : { nsAccountLock: [verrou] }),
      ...(expiration === null ? {} : { krbPasswordExpiration: [expiration] }),
      ...(dernier === null ? {} : { krbLastPwdChange: [dernier] }),
      memberOf: groupes,
    });
  const jean = user("jean", 1, null, futur, passe, [IPA_GROUPE]);
  const desactive = user("desactive", 2, "TRUE", futur, passe, [IPA_GROUPE]);
  const expire = user("expire", 3, null, passe, passe, [IPA_GROUPE]);
  const horsgroupe = user("horsgroupe", 4, null, futur, passe, []);
  // Sans krbPasswordExpiration (politique sans échéance) la date du dernier changement suffit.
  const sansecheance = user("sansecheance", 5, "FALSE", null, passe, [IPA_GROUPE]);
  // IPA publie memberOf direct et indirect : le membre d'un sous-groupe porte les deux groupes.
  const imbrique = user("imbrique", 6, null, futur, passe, [IPA_GROUPE_SOUS, IPA_GROUPE]);
  const tous = [jean, desactive, expire, horsgroupe, sansecheance, imbrique];
  const service = e(IPA_SERVICE, { objectClass: ["account", "simplesecurityobject"], uid: ["elpis"] });
  const entrees: EntreeServeur[] = [
    e(IPA_RACINE, { objectClass: ["top", "domain"] }),
    e(IPA_UTILISATEURS, { objectClass: ["nsContainer"] }),
    service,
    ...tous,
    e(IPA_GROUPE, {
      objectClass: ["top", "groupofnames", "nestedgroup", "ipausergroup"],
      cn: ["elpis"],
      member: [jean.dn, desactive.dn, expire.dn, sansecheance.dn, IPA_GROUPE_SOUS],
    }),
    e(IPA_GROUPE_SOUS, { objectClass: ["top", "groupofnames"], cn: ["elpis-equipe"], member: [imbrique.dn] }),
  ];
  const table = new Map<string, string>([[dnPlie(IPA_SERVICE), MDP_SERVICE]]);
  for (const t of tous) table.set(dnPlie(t.dn), MDP_PERSONNE);
  const p = (uid: string, n: number, attendu: string | null): PersonneProfil => ({
    uid,
    dn: `uid=${uid},${IPA_UTILISATEURS}`,
    mdp: MDP_PERSONNE,
    cle: IPA_UUID(n),
    attendu,
  });
  return {
    id: "freeipa",
    libelle: "FreeIPA / Red Hat IdM",
    sources: [
      "https://www.authelia.com/integration/ldap/freeipa/",
      "https://freeipa.readthedocs.io/en/latest/designs/sysaccounts.html",
      "https://computingforgeeks.com/keycloak-freeipa-ldap-federation/",
    ],
    reglages: {
      preset: "freeipa",
      bind_dn: IPA_SERVICE,
      user_base_dn: IPA_UTILISATEURS,
      user_filter: "(&(objectClass=person)(uid={username}))",
      attrs: { id: "ipaUniqueID", username: "uid", email: "mail", name: "cn" },
      groups: { mode: "memberof" },
      required_groups: [IPA_GROUPE],
    },
    serviceDn: IPA_SERVICE,
    serviceMdp: MDP_SERVICE,
    entrees,
    options: {},
    personnes: [
      p("jean", 1, null),
      p("desactive", 2, "entry_disabled"),
      p("expire", 3, "password_expired"),
      p("horsgroupe", 4, "not_in_group"),
      p("sansecheance", 5, null),
      p("imbrique", 6, null),
    ],
    liaison: liaisonParTable(table, () => ({ code: 49 })),
  };
}

export const IPA = {
  RACINE: IPA_RACINE,
  UTILISATEURS: IPA_UTILISATEURS,
  GROUPE: IPA_GROUPE,
  SERVICE: IPA_SERVICE,
};

// ---------------------------------------------------------------- OpenLDAP, 389 DS, OpenDJ (annuaires à état non lu)
export interface OptionsAnnuaireSimple {
  readonly id: string;
  readonly libelle: string;
  readonly sources: readonly string[];
  readonly racine: string;
  readonly attrCle: string;
  readonly cle: (n: number) => string;
  readonly classeGroupe: "groupOfNames" | "groupOfUniqueNames";
  readonly attrMembre: "member" | "uniqueMember";
  /** Valeur de `memberOf` posée sur l'entrée (greffon ou surcouche), `null` : absent. */
  readonly avecMemberOf: boolean;
  readonly mode: "member" | "memberof";
  readonly preset: string;
  readonly codeCompteFerme: number;
  readonly diagnosticFerme?: string;
  readonly suffixeUniqueMember?: (n: number) => string;
  readonly attrMemberOf?: string;
}

export function profilSimple(o: OptionsAnnuaireSimple): ProfilAnnuaire {
  const users = `ou=people,${o.racine}`;
  const groupe = `cn=elpis,ou=groups,${o.racine}`;
  const service = `uid=elpis,ou=services,${o.racine}`;
  const noms = ["jean", "ferme", "horsgroupe"];
  const dn = (uid: string): string => `uid=${uid},${users}`;
  const membres = ["jean", "ferme"];
  const entrees: EntreeServeur[] = [
    e(o.racine, { objectClass: ["top", "domain"] }),
    e(users, { objectClass: ["organizationalUnit"] }),
    e(service, { objectClass: ["account"], uid: ["elpis"] }),
    ...noms.map((uid, i) =>
      e(dn(uid), {
        objectClass: ["top", "person", "organizationalPerson", "inetOrgPerson"],
        uid: [uid],
        cn: [`Nom ${uid}`],
        mail: [`${uid}@exemple.lan`],
        [o.attrCle]: [o.cle(i + 1)],
        ...(o.avecMemberOf && membres.includes(uid) ? { [o.attrMemberOf ?? "memberOf"]: [groupe] } : {}),
      }),
    ),
    e(groupe, {
      objectClass: ["top", o.classeGroupe],
      cn: ["elpis"],
      [o.attrMembre]: membres.map((m, i) =>
        o.suffixeUniqueMember === undefined ? dn(m) : `${dn(m)}${o.suffixeUniqueMember(i + 1)}`,
      ),
    }),
  ];
  const table = new Map<string, string>([[dnPlie(service), MDP_SERVICE]]);
  for (const uid of noms) table.set(dnPlie(dn(uid)), MDP_PERSONNE);
  const fermes = new Map<string, ReponseLiaison>([
    [dnPlie(dn("ferme")), { code: o.codeCompteFerme, diagnostic: o.diagnosticFerme ?? "" }],
  ]);
  const p = (uid: string, n: number, attendu: string | null): PersonneProfil => ({
    uid,
    dn: dn(uid),
    mdp: MDP_PERSONNE,
    cle: o.cle(n),
    attendu,
  });
  return {
    id: o.id,
    libelle: o.libelle,
    sources: o.sources,
    reglages: {
      preset: o.preset,
      bind_dn: service,
      user_base_dn: users,
      user_filter: "(&(objectClass=inetOrgPerson)(uid={username}))",
      attrs: { id: o.attrCle, username: "uid", email: "mail", name: "cn" },
      groups: { mode: o.mode },
      required_groups: [groupe],
    },
    serviceDn: service,
    serviceMdp: MDP_SERVICE,
    entrees,
    options: { regleChaine: "ignoree" },
    personnes: [p("jean", 1, null), p("ferme", 2, "bad_password"), p("horsgroupe", 3, "not_in_group")],
    liaison: liaisonParTable(table, () => ({ code: 49 }), fermes),
  };
}

const hex = (n: number, long: number): string => n.toString(16).padStart(long, "0");
const uuid = (n: number): string => `5f0e6c1a-3b2d-103f-9a44-${hex(n, 12)}`;

export const profilOpenLdap = (): ProfilAnnuaire =>
  profilSimple({
    id: "openldap",
    libelle: "OpenLDAP (groupOfNames, sans surcouche memberof)",
    sources: [
      "https://www.openldap.org/software/man.cgi?query=slapo-memberof&sektion=5&manpath=OpenLDAP+2.6-Release",
    ],
    racine: "dc=exemple,dc=lan",
    attrCle: "entryUUID",
    cle: uuid,
    classeGroupe: "groupOfNames",
    attrMembre: "member",
    avecMemberOf: false,
    mode: "member",
    preset: "openldap",
    codeCompteFerme: 49,
  });

export const profilOpenLdapMemberOf = (): ProfilAnnuaire =>
  profilSimple({
    id: "openldap-memberof",
    libelle: "OpenLDAP avec la surcouche memberof",
    sources: [
      "https://www.openldap.org/software/man.cgi?query=slapo-memberof&sektion=5&manpath=OpenLDAP+2.6-Release",
    ],
    racine: "dc=exemple,dc=lan",
    attrCle: "entryUUID",
    cle: uuid,
    classeGroupe: "groupOfNames",
    attrMembre: "member",
    avecMemberOf: true,
    mode: "memberof",
    preset: "openldap",
    codeCompteFerme: 49,
  });

export const profil389 = (): ProfilAnnuaire =>
  profilSimple({
    id: "389ds",
    libelle: "389 Directory Server / Red Hat Directory Server",
    sources: [
      "https://www.port389.org/docs/389ds/design/memberof-plugin.html",
      "https://www.golinuxcloud.com/fix-389-directory-server-invalid-credentials-49/",
    ],
    racine: "dc=exemple,dc=lan",
    attrCle: "nsUniqueId",
    cle: (n) => `a1b2c3d4-${hex(n, 8)}-c9d0e1f2-a3b4c5d6`,
    classeGroupe: "groupOfNames",
    attrMembre: "member",
    avecMemberOf: true,
    mode: "memberof",
    preset: "other",
    codeCompteFerme: 53,
    diagnosticFerme: "Account inactivated. Contact system administrator.",
  });

export const profilOpenDj = (): ProfilAnnuaire =>
  profilSimple({
    id: "opendj",
    libelle: "OpenDJ / ForgeRock DS / Ping DS (groupOfUniqueNames)",
    sources: ["https://docs.pingidentity.com/pingds/7.5/config-guide/groups.html (non lu : redirection)"],
    racine: "dc=exemple,dc=lan",
    attrCle: "entryUUID",
    cle: uuid,
    classeGroupe: "groupOfUniqueNames",
    attrMembre: "uniqueMember",
    avecMemberOf: true,
    attrMemberOf: "isMemberOf",
    mode: "member",
    preset: "openldap",
    codeCompteFerme: 49,
  });

export const profilUniqueMemberUid = (): ProfilAnnuaire =>
  profilSimple({
    id: "unique-member-uid",
    libelle: "groupOfUniqueNames avec valeurs DN#UID (RFC 4519)",
    sources: ["https://www.rfc-editor.org/rfc/rfc4519.txt"],
    racine: "dc=exemple,dc=lan",
    attrCle: "entryUUID",
    cle: uuid,
    classeGroupe: "groupOfUniqueNames",
    attrMembre: "uniqueMember",
    avecMemberOf: false,
    suffixeUniqueMember: (n) => `#'${n.toString(2).padStart(8, "0")}'B`,
    mode: "member",
    preset: "openldap",
    codeCompteFerme: 49,
  });

/** Samba AD DC : mêmes attributs et mêmes règles qu'Active Directory (écarts propres non sourcés). */
export const profilSamba = (): ProfilAnnuaire => ({
  ...profilActiveDirectory(),
  id: "samba-ad",
  libelle: "Samba AD DC (profil Active Directory, écarts non sourcés)",
  sources: [
    "https://wiki.samba.org/index.php/Setting_up_Samba_as_an_Active_Directory_Domain_Controller (AD DC depuis 4.0, serveur LDAP intégré)",
  ],
});

export const PROFILS: readonly (() => ProfilAnnuaire)[] = [
  profilActiveDirectory,
  profilSamba,
  profilFreeipa,
  profilOpenLdap,
  profilOpenLdapMemberOf,
  profil389,
  profilOpenDj,
  profilUniqueMemberUid,
];
