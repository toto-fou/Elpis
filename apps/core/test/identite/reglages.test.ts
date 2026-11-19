// SPDX-License-Identifier: MIT
/** apps/core/test/identite/reglages.test.ts — réglages `auth` : lecteur tolérant (section absente ou corrompue, fournisseur invalide écarté) et validateur strict (une valeur fausse par champ sensible). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpError } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import {
  reglagesAuthDepuis,
  validerCreation,
  validerFournisseur,
  validerModification,
  validerReglagesGeneraux,
} from "../../src/identite/reglages";
import { PRESETS } from "../../src/identite/annuaire/presets";
import { empreinteFournisseur, porteeDuFournisseur } from "../../src/identite/fournisseurs";
import { CA_PEM, ldapValide, oidcValide } from "./aides";

function refus(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof HttpError) return `${e.statusCode} ${e.message}`;
    throw e;
  }
  return "aucun refus";
}

describe("lecteur tolérant", () => {
  it("section absente, illisible ou d'un autre type : réglages d'aujourd'hui", () => {
    for (const s of [undefined, null, "x", 3, [], { providers: "x", local: 5 }]) {
      const r = reglagesAuthDepuis(s);
      expect([r.public_url, r.local.mode, r.providers, r.invalides]).toEqual(["", "all", [], []]);
    }
  });

  it("adresse publique : seule une origine https sans chemin, requête ni identifiants est gardée, normalisée", () => {
    const lire = (u: unknown): string => reglagesAuthDepuis({ public_url: u }).public_url;
    expect(lire("https://Elpis.exemple.lan/")).toBe("https://elpis.exemple.lan");
    expect(lire("https://elpis.exemple.lan:8443")).toBe("https://elpis.exemple.lan:8443");
    for (const mauvais of [
      "http://elpis.lan",
      "https://elpis.lan/chemin",
      "https://elpis.lan/?x=1",
      "https://elpis.lan/#f",
      "https://u:p@elpis.lan",
      "ftp://elpis.lan",
      "elpis.lan",
      42,
      null,
    ])
      expect(lire(mauvais), String(mauvais)).toBe("");
  });

  it("mode local : `admins` seulement s'il est écrit tel quel", () => {
    expect(reglagesAuthDepuis({ local: { mode: "admins" } }).local.mode).toBe("admins");
    for (const m of ["Admins", "admin", "all", "", 1, null])
      expect(reglagesAuthDepuis({ local: { mode: m } }).local.mode).toBe("all");
  });

  it("un fournisseur valide est lu ; un invalide, un doublon ou un excédent sont mis à part, jamais lus", () => {
    const r = reglagesAuthDepuis({
      providers: [
        ldapValide(),
        { ...ldapValide(), id: "casse", urls: ["ldap://clair.lan"], enabled: true },
        ldapValide({ label: "Doublon" }),
        "pas un objet",
        { ...oidcValide(), enabled: true, scopes: ["profile"] },
      ],
    });
    expect(r.providers.map((p) => p.id)).toEqual(["annuaire"]);
    expect(r.invalides).toEqual([
      { id: "casse", label: "Annuaire", enabled: true },
      { id: "annuaire", label: "Doublon", enabled: false },
      { id: null, label: null, enabled: false },
      { id: "sso", label: "SSO", enabled: true },
    ]);
  });

  it("nombres écrits à la main : entier flottant accepté, texte refusé", () => {
    const ok = reglagesAuthDepuis({ providers: [ldapValide({ max_failures: 4.0 })] });
    expect(ok.providers).toHaveLength(1);
    const non = reglagesAuthDepuis({ providers: [ldapValide({ max_failures: "4" })] });
    expect(non.providers).toHaveLength(0);
  });
});

describe("validateur strict (une valeur fausse par champ sensible)", () => {
  const fautes: [string, () => unknown, RegExp][] = [
    ["schéma ldap://", () => validerFournisseur(ldapValide({ urls: ["ldap://ldap.lan"] })), /urls/u],
    ["schéma http://", () => validerFournisseur(ldapValide({ urls: ["http://ldap.lan"] })), /urls/u],
    [
      "adresse avec chemin",
      () => validerFournisseur(ldapValide({ urls: ["ldaps://ldap.lan/dc=x"] })),
      /urls/u,
    ],
    [
      "adresse avec identifiants",
      () => validerFournisseur(ldapValide({ urls: ["ldaps://u:p@ldap.lan"] })),
      /urls/u,
    ],
    [
      "quatre adresses",
      () =>
        validerFournisseur(
          ldapValide({ urls: ["ldaps://a.lan", "ldaps://b.lan", "ldaps://c.lan", "ldaps://d.lan"] }),
        ),
      /urls/u,
    ],
    [
      "adresses en double",
      () => validerFournisseur(ldapValide({ urls: ["ldaps://a.lan", "ldaps://A.lan:636"] })),
      /double/u,
    ],
    ["port hors bornes", () => validerFournisseur(ldapValide({ urls: ["ldaps://a.lan:70000"] })), /port/u],
    [
      "filtre sans {username}",
      () => validerFournisseur(ldapValide({ user_filter: "(uid=jean)" })),
      /user_filter/u,
    ],
    [
      "filtre avec deux {username}",
      () => validerFournisseur(ldapValide({ user_filter: "(|(uid={username})(mail={username}))" })),
      /user_filter/u,
    ],
    [
      "filtre sans parenthèses",
      () => validerFournisseur(ldapValide({ user_filter: "uid={username}" })),
      /user_filter/u,
    ],
    ["bind_dn vide", () => validerFournisseur(ldapValide({ bind_dn: "" })), /bind_dn/u],
    [
      "mode de groupes inconnu",
      () => validerFournisseur(ldapValide({ groups: { mode: "tous" } })),
      /groups\.mode/u,
    ],
    ["max_failures hors bornes", () => validerFournisseur(ldapValide({ max_failures: 21 })), /max_failures/u],
    [
      "failure_window_sec hors bornes",
      () => validerFournisseur(ldapValide({ failure_window_sec: 59 })),
      /failure_window_sec/u,
    ],
    ["timeout_sec hors bornes", () => validerFournisseur(ldapValide({ timeout_sec: 1 })), /timeout_sec/u],
    ["issuer http://", () => validerFournisseur(oidcValide({ issuer: "http://idp.lan" })), /issuer/u],
    [
      "issuer avec requête",
      () => validerFournisseur(oidcValide({ issuer: "https://idp.lan/?x=1" })),
      /issuer/u,
    ],
    [
      "issuer avec fragment",
      () => validerFournisseur(oidcValide({ issuer: "https://idp.lan/#x" })),
      /issuer/u,
    ],
    [
      "issuer avec identifiants",
      () => validerFournisseur(oidcValide({ issuer: "https://u:p@idp.lan" })),
      /issuer/u,
    ],
    ["scopes sans openid", () => validerFournisseur(oidcValide({ scopes: ["profile", "email"] })), /openid/u],
    ["scopes vide", () => validerFournisseur(oidcValide({ scopes: [] })), /scopes/u],
    ["client_auth inconnu", () => validerFournisseur(oidcValide({ client_auth: "none" })), /client_auth/u],
    [
      "clock_skew_sec hors bornes",
      () => validerFournisseur(oidcValide({ clock_skew_sec: 301 })),
      /clock_skew_sec/u,
    ],
    ["id invalide (majuscule)", () => validerFournisseur(ldapValide({ id: "Annuaire" })), /id/u],
    ["id invalide (tiret initial)", () => validerFournisseur(ldapValide({ id: "-a" })), /id/u],
    ["id trop long", () => validerFournisseur(ldapValide({ id: "a".repeat(32) })), /id/u],
    ["type inconnu", () => validerFournisseur({ ...ldapValide(), type: "saml" }), /type/u],
    ["libellé vide", () => validerFournisseur(ldapValide({ label: "  " })), /label/u],
    ["libellé trop long", () => validerFournisseur(ldapValide({ label: "x".repeat(41) })), /label/u],
    [
      "fraîcheur hors bornes",
      () => validerFournisseur(ldapValide({ freshness_days: 91 })),
      /freshness_days/u,
    ],
    [
      "vingt et un groupes requis",
      () =>
        validerFournisseur(ldapValide({ required_groups: Array.from({ length: 21 }, (_, i) => `cn=g${i}`) })),
      /required_groups/u,
    ],
    [
      "groupe requis trop long",
      () => validerFournisseur(ldapValide({ required_groups: ["cn=".concat("g".repeat(510))] })),
      /required_groups/u,
    ],
    [
      "PEM invalide",
      () =>
        validerFournisseur(
          ldapValide({ ca_pem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----" }),
        ),
      /ca_pem/u,
    ],
    ["PEM trop gros", () => validerFournisseur(ldapValide({ ca_pem: "A".repeat(70_000) })), /ca_pem/u],
    ["clé inconnue", () => validerFournisseur(ldapValide({ verify_tls: false })), /verify_tls/u],
    [
      "clé inconnue imbriquée",
      () =>
        validerFournisseur(ldapValide({ attrs: { id: "a", username: "u", email: "e", name: "n", x: "y" } })),
      /attrs\.x/u,
    ],
    ["clé d'un autre type", () => validerFournisseur(ldapValide({ issuer: "https://idp.lan" })), /issuer/u],
    ["activation en texte", () => validerFournisseur(ldapValide({ enabled: "true" })), /enabled/u],
  ];
  it.each(fautes)("%s : 400", (_nom, f, motif) => {
    const r = refus(f);
    expect(r).toMatch(/^400 /u);
    expect(r).toMatch(motif);
  });

  it("autorité PEM : un ou plusieurs certificats lisibles passent, vide aussi", () => {
    expect(validerFournisseur(ldapValide({ ca_pem: CA_PEM })).ca_pem).toBe(CA_PEM);
    expect(validerFournisseur(ldapValide({ ca_pem: `${CA_PEM}${CA_PEM}` })).ca_pem).toBe(
      `${CA_PEM}${CA_PEM}`,
    );
    expect(validerFournisseur(ldapValide({ ca_pem: "" })).ca_pem).toBe("");
  });

  it("un fournisseur correct passe, avec ses valeurs par défaut à la création", () => {
    expect(validerFournisseur(ldapValide()).type).toBe("ldap");
    const cree = validerCreation({
      type: "oidc",
      id: "sso",
      label: "SSO",
      issuer: "https://idp.lan",
      client_id: "c",
    });
    expect([cree.enabled, cree.type === "oidc" && cree.scopes, cree.freshness_days]).toEqual([
      false,
      ["openid", "profile", "email"],
      14,
    ]);
  });

  it("création : toujours éteint ; sixième fournisseur géré par la route, doublon d'id par la route", () => {
    expect(refus(() => validerCreation({ ...ldapValide(), enabled: true }))).toMatch(/^400 .*éteint/u);
    expect(validerCreation({ ...ldapValide(), enabled: false }).enabled).toBe(false);
    expect(refus(() => validerCreation("x"))).toMatch(/^400 /u);
    expect(refus(() => validerCreation({ id: "a" }))).toMatch(/^400 .*type/u);
  });

  it("modification : id, type et activation ne bougent pas ; objets imbriqués fusionnés", () => {
    const actuel = validerFournisseur(ldapValide());
    expect(refus(() => validerModification({ id: "autre" }, actuel))).toMatch(/identifiant/u);
    expect(refus(() => validerModification({ type: "oidc" }, actuel))).toMatch(/type/u);
    expect(refus(() => validerModification({ enabled: true }, actuel))).toMatch(/Activer/u);
    const m = validerModification({ attrs: { id: "ipaUniqueID" }, label: " Autre " }, actuel);
    expect(m.type === "ldap" && m.attrs).toEqual({
      id: "ipaUniqueID",
      username: "uid",
      email: "mail",
      name: "cn",
    });
    expect(m.label).toBe("Autre");
  });

  it("réglages généraux : clé inconnue, adresse non https, mode inconnu : 400 ; champs absents gardés", () => {
    const base = { public_url: "https://elpis.lan", local: { mode: "all" as const } };
    expect(refus(() => validerReglagesGeneraux({ providers: [] }, base))).toMatch(/^400 .*providers/u);
    expect(refus(() => validerReglagesGeneraux({ public_url: "http://elpis.lan" }, base))).toMatch(
      /public_url/u,
    );
    expect(refus(() => validerReglagesGeneraux({ public_url: "https://elpis.lan/x" }, base))).toMatch(
      /public_url/u,
    );
    expect(refus(() => validerReglagesGeneraux({ local: { mode: "none" } }, base))).toMatch(/local\.mode/u);
    expect(refus(() => validerReglagesGeneraux({ local: { mode: "all", x: 1 } }, base))).toMatch(/local\.x/u);
    expect(validerReglagesGeneraux({ local: { mode: "admins" } }, base)).toEqual({
      public_url: "https://elpis.lan",
      local: { mode: "admins" },
    });
    expect(validerReglagesGeneraux({ public_url: "" }, base).public_url).toBe("");
  });
});

describe("adresse d'annuaire : schéma et hôte insensibles à la casse (RFC 3986 §3.1, §3.2.2)", () => {
  const urls = (u: string): string[] =>
    (validerFournisseur(ldapValide({ urls: [u] })) as { urls: string[] }).urls;

  it("`LDAPS://Annuaire.Exemple.LAN:636` est enregistrée en minuscules, par le validateur strict comme par le lecteur tolérant", () => {
    expect(urls("LDAPS://Annuaire.Exemple.LAN:636")).toEqual(["ldaps://annuaire.exemple.lan:636"]);
    const lu = reglagesAuthDepuis({ providers: [ldapValide({ urls: ["Ldaps://Annuaire.Exemple.LAN"] })] });
    expect(lu.invalides).toEqual([]);
    expect((lu.providers[0] as { urls: string[] }).urls).toEqual(["ldaps://annuaire.exemple.lan"]);
  });

  it("`ldap://` reste refusé quelle que soit la casse, et une adresse qui ne diffère que par la casse est un doublon", () => {
    for (const u of ["ldap://a.lan", "LDAP://a.lan", "Ldap://a.lan"])
      expect(
        refus(() => urls(u)),
        u,
      ).toMatch(/urls/u);
    expect(
      refus(() => validerFournisseur(ldapValide({ urls: ["LDAPS://A.lan", "ldaps://a.lan:636"] }))),
    ).toMatch(/double/u);
  });

  it("même portée de secret et même empreinte de test pour une adresse qui ne diffère que par la casse", () => {
    const a = validerFournisseur(ldapValide({ urls: ["LDAPS://Annuaire.Exemple.LAN"] }));
    const b = validerFournisseur(ldapValide({ urls: ["ldaps://annuaire.exemple.lan"] }));
    expect(porteeDuFournisseur(a)).toEqual(porteeDuFournisseur(b));
    expect(empreinteFournisseur(a, "https://elpis.lan")).toBe(empreinteFournisseur(b, "https://elpis.lan"));
  });

  it("l'émetteur OIDC ne se normalise pas : il se compare exactement", () => {
    const f = validerFournisseur(oidcValide({ issuer: "https://Idp.exemple.lan/Realm" }));
    expect((f as { issuer: string }).issuer).toBe("https://Idp.exemple.lan/Realm");
  });
});

describe("adresse d'annuaire : ASCII imprimable seulement, repli de casse Unicode refusé", () => {
  const urls = (u: string): string[] =>
    (validerFournisseur(ldapValide({ urls: [u] })) as { urls: string[] }).urls;

  it.each(["ldapſ://hote", "ldaps://ſerver.lan", "ldaps://Kerber.lan", "ldaps://hôte.lan", "ldaps://a.lan "])(
    "%j : refusé",
    (u) => {
      expect(refus(() => urls(u))).toMatch(/urls/u);
    },
  );

  it("`LDAPS://Hote.LAN:636` reste accepté et normalisé", () => {
    expect(urls("LDAPS://Hote.LAN:636")).toEqual(["ldaps://hote.lan:636"]);
  });
});

describe("noms distinctifs : grammaire de RFC 4514 exigée des réglages", () => {
  const MESSAGE =
    "Champ « bind_dn » : écrivez le nom distinctif avec les noms d'attribut usuels (cn, uid, ou, dc…).";
  const bind = (bind_dn: string): string => refus(() => validerFournisseur(ldapValide({ bind_dn })));

  it.each([
    "2.5.4.3=svc,dc=x",
    "cn=#0403737663,dc=x",
    "uid=\\svc,dc=x",
    "cn=svc\\",
    "cn=a;dc=x",
    'cn="a,b",dc=x',
    "svc@corp.example",
    "cn=#41\\,dc=x",
  ])("bind_dn %j : refusé avec le message pour l'administrateur", (dn) => {
    expect(bind(dn)).toBe(`400 ${MESSAGE}`);
  });

  it("bind_dn usuel accepté, y compris avec un RDN multivalué et des échappements valides", () => {
    for (const dn of ["uid=svc,cn=users,dc=exemple,dc=lan", "cn=a\\, b+uid=x,dc=x", "cn=\\C3\\A9,dc=x"])
      expect(bind(dn)).toBe("aucun refus");
  });

  it("base des utilisateurs, groupe requis, groupes de rôles et de correspondance : refusés hors grammaire", () => {
    const f = (extra: Record<string, unknown>): string => refus(() => validerFournisseur(ldapValide(extra)));
    expect(f({ user_base_dn: "cn=a;dc=x" })).toMatch(/user_base_dn/u);
    expect(f({ required_groups: ["elpis"] })).toMatch(/required_groups/u);
    expect(f({ required_groups: ["cn=elpis,dc=x"] })).toBe("aucun refus");
    const roles = (admin: string[], moderateur: string[]): Record<string, unknown> => ({
      roles: { enabled: true, admin_groups: admin, moderator_groups: moderateur },
    });
    expect(f(roles(["admins"], []))).toMatch(/roles\.admin_groups/u);
    expect(f(roles([], ["cn=m\\"]))).toMatch(/roles\.moderator_groups/u);
    expect(f(roles(["cn=a,dc=x"], ["cn=m,dc=x"]))).toBe("aucun refus");
    expect(f({ group_map: { enabled: true, map: [{ external: "g", group_id: 1 }] } })).toMatch(
      /group_map\.map/u,
    );
    expect(f({ group_map: { enabled: true, map: [{ external: "cn=g,dc=x", group_id: 1 }] } })).toBe(
      "aucun refus",
    );
  });

  it("le lecteur tolérant tient pour mal configuré un fournisseur dont le bind_dn est hors grammaire", () => {
    const lu = reglagesAuthDepuis({ providers: [ldapValide({ bind_dn: "2.5.4.3=svc,dc=x" })] });
    expect(lu.providers).toEqual([]);
    expect(lu.invalides).toHaveLength(1);
  });
});

describe("gabarit du filtre : {username} est la valeur entière d'une égalité, hors de tout « non »", () => {
  const filtre = (user_filter: string): string =>
    refus(() => validerFournisseur(ldapValide({ user_filter })));

  it.each([
    "(uid={username}*)",
    "(uid=*{username})",
    "(uid=*{username}*)",
    "(uid~={username})",
    "(uid>={username})",
    "(uid<={username})",
    "(!(uid={username}))",
    "(&(objectClass=person)(!(uid={username})))",
    "(!(!(uid={username})))",
    "(uid:caseExactMatch:={username})",
    "(uid=x{username})",
    "(uid={username}x)",
  ])("%s : refusé", (g) => {
    expect(filtre(g)).toMatch(/user_filter/u);
  });

  it("gabarit qui ne se lit pas : refusé", () => {
    expect(filtre("(uid={username}")).toMatch(/user_filter/u);
    expect(filtre("(&(uid={username}))x)")).toMatch(/user_filter/u);
  });

  it("égalité seule, ou dans un « et » / « ou » : acceptée", () => {
    for (const g of ["(uid={username})", "(&(objectClass=person)(uid={username}))", "(|(uid={username}))"])
      expect(filtre(g)).toBe("aucun refus");
  });

  it("gabarits des préréglages et du tableau de la section Directory du guide : acceptés", () => {
    const racine = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const ligne = readFileSync(join(racine, "docs/enterprise-sign-in.md"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("| **Filtre**"));
    const guide = [...(ligne ?? "").matchAll(/`([^`]*\{username\}[^`]*)`/gu)].map((m) => m[1] as string);
    expect(guide.length).toBeGreaterThanOrEqual(3);
    for (const g of [...Object.values(PRESETS).map((p) => p.filtre), ...guide])
      expect(filtre(g), g).toBe("aucun refus");
  });
});
