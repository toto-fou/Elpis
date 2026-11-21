// SPDX-License-Identifier: MIT
/** apps/core/test/identite/reglages.test.ts — réglages `auth` : lecteur tolérant (section absente ou corrompue, fournisseur invalide écarté) et validateur strict (une valeur fausse par champ sensible). */
import { HttpError } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import {
  lireReglagesAuth,
  reglagesAuthDepuis,
  validerCreation,
  validerFournisseur,
  validerModification,
  validerReglagesGeneraux,
} from "../../src/identite/reglages";
import { empreinteFournisseur, porteeDuFournisseur } from "../../src/identite/fournisseurs";
import { CA_PEM, configDeTest, oidcValide } from "./aides";

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
        oidcValide(),
        { ...oidcValide(), id: "clair", issuer: "http://clair.lan", enabled: true },
        oidcValide({ label: "Doublon" }),
        "pas un objet",
        { ...oidcValide(), id: "autre", enabled: true, scopes: ["profile"] },
      ],
    });
    expect(r.providers.map((p) => p.id)).toEqual(["sso"]);
    expect(r.invalides).toEqual([
      { id: "clair", label: "SSO", enabled: true },
      { id: "sso", label: "Doublon", enabled: false },
      { id: null, label: null, enabled: false },
      { id: "autre", label: "SSO", enabled: true },
    ]);
  });

  it("un champ inconnu, `preset` compris, rend le fournisseur invalide à la lecture et est refusé à l'écriture", () => {
    const r = reglagesAuthDepuis({ providers: [{ ...oidcValide(), preset: "keycloak" }] });
    expect(r.providers).toEqual([]);
    expect(r.invalides).toEqual([{ id: "sso", label: "SSO", enabled: false }]);
    expect(refus(() => validerFournisseur({ ...oidcValide(), preset: "keycloak" }))).toBe(
      "400 Champ « fournisseur.preset » : champ inconnu.",
    );
  });

  it("nombres écrits à la main : entier flottant accepté, texte refusé", () => {
    const ok = reglagesAuthDepuis({ providers: [oidcValide({ max_age_sec: 4.0 })] });
    expect(ok.providers).toHaveLength(1);
    const non = reglagesAuthDepuis({ providers: [oidcValide({ max_age_sec: "4" })] });
    expect(non.providers).toHaveLength(0);
  });
});

describe("validateur strict (une valeur fausse par champ sensible)", () => {
  const fautes: [string, () => unknown, RegExp][] = [
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
    ["id invalide (majuscule)", () => validerFournisseur(oidcValide({ id: "Sso" })), /id/u],
    ["id invalide (tiret initial)", () => validerFournisseur(oidcValide({ id: "-a" })), /id/u],
    ["id trop long", () => validerFournisseur(oidcValide({ id: "a".repeat(32) })), /id/u],
    ["type inconnu", () => validerFournisseur({ ...oidcValide(), type: "saml" }), /type/u],
    ["type retiré", () => validerFournisseur({ ...oidcValide(), type: "ldap" }), /type/u],
    ["libellé vide", () => validerFournisseur(oidcValide({ label: "  " })), /label/u],
    ["libellé trop long", () => validerFournisseur(oidcValide({ label: "x".repeat(41) })), /label/u],
    [
      "fraîcheur hors bornes",
      () => validerFournisseur(oidcValide({ freshness_days: 91 })),
      /freshness_days/u,
    ],
    [
      "vingt et un groupes requis",
      () =>
        validerFournisseur(oidcValide({ required_groups: Array.from({ length: 21 }, (_, i) => `cn=g${i}`) })),
      /required_groups/u,
    ],
    [
      "groupe requis trop long",
      () => validerFournisseur(oidcValide({ required_groups: ["cn=".concat("g".repeat(510))] })),
      /required_groups/u,
    ],
    [
      "PEM invalide",
      () =>
        validerFournisseur(
          oidcValide({ ca_pem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----" }),
        ),
      /ca_pem/u,
    ],
    ["PEM trop gros", () => validerFournisseur(oidcValide({ ca_pem: "A".repeat(70_000) })), /ca_pem/u],
    ["clé inconnue", () => validerFournisseur(oidcValide({ verify_tls: false })), /verify_tls/u],
    [
      "clé inconnue imbriquée",
      () => validerFournisseur(oidcValide({ logout: { rp_initiated: false, backchannel: false, x: "y" } })),
      /logout\.x/u,
    ],
    ["clé d'un ancien type", () => validerFournisseur(oidcValide({ urls: ["ldaps://a.lan"] })), /urls/u],
    ["activation en texte", () => validerFournisseur(oidcValide({ enabled: "true" })), /enabled/u],
    [
      "onze niveaux qui prouvent un second facteur",
      () => validerFournisseur(oidcValide({ mfa_acr: Array.from({ length: 11 }, (_, i) => `n${i}`) })),
      /mfa_acr/u,
    ],
    [
      "niveau déclaré trop long",
      () => validerFournisseur(oidcValide({ mfa_acr: ["x".repeat(129)] })),
      /mfa_acr/u,
    ],
    ["niveau déclaré vide", () => validerFournisseur(oidcValide({ mfa_acr: [""] })), /mfa_acr/u],
    [
      "niveaux déclarés absents",
      () => validerFournisseur({ ...oidcValide(), mfa_acr: undefined }),
      /mfa_acr/u,
    ],
  ];
  it.each(fautes)("%s : 400", (_nom, f, motif) => {
    const r = refus(f);
    expect(r).toMatch(/^400 /u);
    expect(r).toMatch(motif);
  });

  it("autorité PEM : un ou plusieurs certificats lisibles passent, vide aussi", () => {
    expect(validerFournisseur(oidcValide({ ca_pem: CA_PEM })).ca_pem).toBe(CA_PEM);
    expect(validerFournisseur(oidcValide({ ca_pem: `${CA_PEM}${CA_PEM}` })).ca_pem).toBe(
      `${CA_PEM}${CA_PEM}`,
    );
    expect(validerFournisseur(oidcValide({ ca_pem: "" })).ca_pem).toBe("");
  });

  it("un fournisseur correct passe, avec ses valeurs par défaut à la création", () => {
    expect(validerFournisseur(oidcValide()).type).toBe("oidc");
    const cree = validerCreation({
      type: "oidc",
      id: "sso",
      label: "SSO",
      issuer: "https://idp.lan",
      client_id: "c",
    });
    expect([cree.enabled, cree.scopes, cree.freshness_days, cree.mfa_acr]).toEqual([
      false,
      ["openid", "profile", "email"],
      14,
      [],
    ]);
  });

  it("création : toujours éteint ; sixième fournisseur géré par la route, doublon d'id par la route", () => {
    expect(refus(() => validerCreation({ ...oidcValide(), enabled: true }))).toMatch(/^400 .*éteint/u);
    expect(validerCreation({ ...oidcValide(), enabled: false }).enabled).toBe(false);
    expect(refus(() => validerCreation("x"))).toMatch(/^400 /u);
    expect(refus(() => validerCreation({ id: "a" }))).toMatch(/^400 .*type/u);
  });

  it("modification : id, type et activation ne bougent pas ; objets imbriqués fusionnés", () => {
    const actuel = validerFournisseur(oidcValide());
    expect(refus(() => validerModification({ id: "autre" }, actuel))).toMatch(/identifiant/u);
    expect(refus(() => validerModification({ type: "ldap" }, actuel))).toMatch(/type/u);
    expect(refus(() => validerModification({ enabled: true }, actuel))).toMatch(/Activer/u);
    const m = validerModification({ logout: { backchannel: true }, label: " Autre " }, actuel);
    expect(m.logout).toEqual({ rp_initiated: false, backchannel: true });
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

describe("adresse du fournisseur : l'émetteur OIDC se compare exactement", () => {
  it("l'émetteur OIDC ne se normalise pas", () => {
    const f = validerFournisseur(oidcValide({ issuer: "https://Idp.exemple.lan/Realm" }));
    expect(f.issuer).toBe("https://Idp.exemple.lan/Realm");
  });

  it("même portée de secret et même empreinte de test pour deux écritures identiques", () => {
    const a = validerFournisseur(oidcValide());
    const b = validerFournisseur(oidcValide());
    expect(porteeDuFournisseur(a)).toEqual(porteeDuFournisseur(b));
    expect(porteeDuFournisseur(a)).toEqual({ host: "idp.exemple.lan:443", ca: "system" });
    expect(empreinteFournisseur(a, "https://elpis.lan")).toBe(empreinteFournisseur(b, "https://elpis.lan"));
  });
});

describe("réglages lus à chaud", () => {
  it("validés une fois par instantané du fichier, gelés, relus dès que le fichier change", () => {
    const cfg = configDeTest();
    try {
      cfg.ecrire({ auth: { public_url: "https://elpis.lan", providers: [oidcValide()] } });
      const a = lireReglagesAuth();
      expect(lireReglagesAuth()).toBe(a);
      expect(Object.isFrozen(a)).toBe(true);
      expect(Object.isFrozen(a.providers[0])).toBe(true);
      cfg.ecrire({ auth: { public_url: "https://autre.lan", providers: [oidcValide()] } });
      expect(lireReglagesAuth().public_url).toBe("https://autre.lan");
    } finally {
      cfg.fermer();
    }
  });
});
