// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/securite-annuaire-liaison.test.ts — une liaison LDAP à mot de passe ou DN vide, ou une recherche mal formée, est refusée avant toute socket ; une socket non vérifiée n'est jamais utilisée ; aucune erreur ne porte mot de passe, DN ni message du serveur. */
import type { TLSSocket } from "node:tls";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { fabriqueLdapts } from "../../../src/identite/annuaire/client";
import type { ConnexionAnnuaire } from "../../../src/identite/annuaire/client";
import { ErreurAnnuaire } from "../../../src/identite/annuaire/erreur";
import type { connexionTls } from "../../../src/identite/sortant";
import { creerAutorite, creerFeuille, effacer, OPENSSL_DISPONIBLE } from "../pki-openssl";
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
const MOT_DE_PASSE = "s3cret-Très-Long";

type Connecter = typeof connexionTls;

function espion(): { connecter: Connecter; appels: () => number } {
  const f = vi.fn(() => Promise.reject(new Error("aucune socket ne doit être demandée")));
  return { connecter: f as unknown as Connecter, appels: () => f.mock.calls.length };
}

async function ouvrir(connecter: Connecter): Promise<ConnexionAnnuaire> {
  return fabriqueLdapts({ connecter, juger: VERS_BOUCLE })(fournisseur(), "ldaps://ldap.exemple.lan");
}

describe("liaison refusée avant toute socket", () => {
  const cas: [string, unknown, unknown][] = [
    ["DN vide", "", MOT_DE_PASSE],
    ["mot de passe vide", DN, ""],
    ["les deux vides", "", ""],
    ["DN non chaîne", 42, MOT_DE_PASSE],
    ["DN nul", null, MOT_DE_PASSE],
    ["mot de passe non chaîne", DN, 12345],
    ["mot de passe nul", DN, null],
    ["mot de passe indéfini", DN, undefined],
    ["NUL dans le DN", `uid=a\0,dc=x`, MOT_DE_PASSE],
    ["NUL dans le mot de passe", DN, "abc\0def"],
    ["mot de passe de 1 025 octets", DN, "x".repeat(1025)],
    ["mot de passe multi-octets de 1 025 octets", DN, `${"é".repeat(512)}x`],
    ["nom de mécanisme SASL à la place d'un DN", "PLAIN", MOT_DE_PASSE],
    ["DN sans attribut", "svc", MOT_DE_PASSE],
    ["DN mal formé en Unicode", "uid=\ud800", MOT_DE_PASSE],
  ];

  it.each(cas)("%s", async (_nom, dn, mdp) => {
    const { connecter, appels } = espion();
    const cnx = await ouvrir(connecter);
    const err = await cnx.lier(dn as string, mdp as string).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ErreurAnnuaire);
    expect((err as ErreurAnnuaire).nature).toBe("identifiants");
    expect(appels()).toBe(0);
    await cnx.fermer();
    expect(appels()).toBe(0);
  });

  it("accepte 1 024 octets pile (la liaison part alors)", async () => {
    const { connecter, appels } = espion();
    const cnx = await ouvrir(connecter);
    await expect(cnx.lier(DN, "x".repeat(1024))).rejects.toMatchObject({ nature: "injoignable" });
    expect(appels()).toBe(1);
  });
});

describe("recherche mal formée refusée avant toute socket", () => {
  const base = { portee: "sub" as const, filtre: "(uid=a)", attributs: ["uid"], limite: 2 };
  const cas: [string, string, Partial<typeof base>][] = [
    ["attributs vides", "dc=x", { attributs: [] }],
    ["attribut *", "dc=x", { attributs: ["*"] }],
    ["attribut +", "dc=x", { attributs: ["+"] }],
    ["attribut @classe", "dc=x", { attributs: ["@person"] }],
    ["attribut avec parenthèse", "dc=x", { attributs: ["uid)"] }],
    ["limite nulle", "dc=x", { limite: 0 }],
    ["limite sans borne", "dc=x", { limite: 1_000_000 }],
    ["portée one", "dc=x", { portee: "one" as never }],
    ["filtre vide", "dc=x", { filtre: "" }],
    ["filtre illisible", "dc=x", { filtre: "(uid=a" }],
    ["base à NUL", "dc=x\0", {}],
  ];

  it.each(cas)("%s", async (_nom, b, o) => {
    const { connecter, appels } = espion();
    const cnx = await ouvrir(connecter);
    await expect(cnx.chercher(b, { ...base, ...o })).rejects.toBeInstanceOf(ErreurAnnuaire);
    expect(appels()).toBe(0);
  });
});

describe("socket non vérifiée", () => {
  it.each([
    ["non authorized", { authorized: false, destroyed: false, readyState: "open" }],
    ["détruite", { authorized: true, destroyed: true, readyState: "closed" }],
    ["pas ouverte", { authorized: true, destroyed: false, readyState: "opening" }],
  ])("%s : jamais confiée à la bibliothèque, détruite", async (_nom, etat) => {
    const destroy = vi.fn();
    const socket = { ...etat, destroy, write: vi.fn(), on: vi.fn(), once: vi.fn() } as unknown as TLSSocket;
    const connecter = (() => Promise.resolve({ socket, certificat: {} })) as unknown as Connecter;
    const cnx = await ouvrir(connecter);
    await expect(cnx.lier(DN, MOT_DE_PASSE)).rejects.toMatchObject({ nature: "injoignable", sortant: "tls" });
    expect(destroy).toHaveBeenCalled();
    expect(socket.write).not.toHaveBeenCalled();
  });
});

describe("adresse refusée", () => {
  it.each([
    "ldap://ldap.exemple.lan",
    "http://ldap.exemple.lan",
    "ldaps://u:p@ldap.exemple.lan",
    "ldaps://h/dc=x",
    "",
  ])("%j", async (url) => {
    const { connecter, appels } = espion();
    await expect(fabriqueLdapts({ connecter })(fournisseur(), url)).rejects.toMatchObject({
      nature: "configuration",
    });
    expect(appels()).toBe(0);
  });
});

describe.skipIf(!OPENSSL_DISPONIBLE)("erreurs rendues sur un annuaire réel", () => {
  let ca: Autorite;
  let serveur: ServeurLdap;

  beforeAll(async () => {
    ca = creerAutorite("Annuaire de test");
    const f = creerFeuille(ca, { noms: [NOM] });
    serveur = await demarrerServeurLdap(f.cert, f.cle);
    serveur.comportement.comptes[DN] = MOT_DE_PASSE;
    serveur.comportement.diagnostic = "DIAGNOSTIC-SECRET-DU-SERVEUR";
  });
  afterAll(async () => {
    await serveur.fermer();
    effacer(ca);
  });

  const url = (): string => `ldaps://${NOM}:${serveur.port}`;
  const fabrique = (): ReturnType<typeof fabriqueLdapts> => fabriqueLdapts({ juger: VERS_BOUCLE });

  it("mauvais mot de passe : nature « identifiants », code 49, rien de secret dans l'erreur", async () => {
    const mauvais = "Mauvais-mdp-ÉPROUVÉ";
    const cnx = await fabrique()(fournisseur({ ca_pem: ca.cert }), url());
    const err = (await cnx.lier(DN, mauvais).then(
      () => null,
      (e: unknown) => e,
    )) as ErreurAnnuaire;
    await cnx.fermer();
    expect(err).toBeInstanceOf(ErreurAnnuaire);
    expect(err).toMatchObject({ nature: "identifiants", code: 49 });
    const tout = [
      err.message,
      err.stack ?? "",
      JSON.stringify(err),
      String(err),
      Object.getOwnPropertyNames(err).join(),
    ].join("\n");
    for (const interdit of [mauvais, MOT_DE_PASSE, DN, "svc", "DIAGNOSTIC-SECRET-DU-SERVEUR"])
      expect(tout).not.toContain(interdit);
    expect(err.cause).toBeUndefined();
  });

  it("une erreur de recherche garde son code sans le message du serveur", async () => {
    serveur.comportement.codeRecherche = 50;
    try {
      const cnx = await fabrique()(fournisseur({ ca_pem: ca.cert }), url());
      await cnx.lier(DN, MOT_DE_PASSE);
      const err = (await cnx
        .chercher("dc=exemple,dc=lan", { portee: "sub", filtre: "(uid=a)", attributs: ["uid"], limite: 2 })
        .then(
          () => null,
          (e: unknown) => e,
        )) as ErreurAnnuaire;
      await cnx.fermer();
      expect(err).toMatchObject({ nature: "protocole", code: 50 });
      expect(`${err.message}${err.stack}${JSON.stringify(err)}`).not.toContain(
        "DIAGNOSTIC-SECRET-DU-SERVEUR",
      );
    } finally {
      serveur.comportement.codeRecherche = 0;
    }
  });

  it("une erreur de recherche n'est jamais une liste vide", async () => {
    serveur.comportement.codeRecherche = 1;
    try {
      const cnx = await fabrique()(fournisseur({ ca_pem: ca.cert }), url());
      await cnx.lier(DN, MOT_DE_PASSE);
      await expect(
        cnx.chercher("dc=exemple,dc=lan", {
          portee: "sub",
          filtre: "(uid=a)",
          attributs: ["uid"],
          limite: 2,
        }),
      ).rejects.toMatchObject({ nature: "protocole", code: 1 });
      await cnx.fermer();
    } finally {
      serveur.comportement.codeRecherche = 0;
    }
  });
});
