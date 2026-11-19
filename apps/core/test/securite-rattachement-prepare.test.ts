// SPDX-License-Identifier: MIT
/** apps/core/test/securite-rattachement-prepare.test.ts — un rattachement préparé ne crée jamais de compte et n'attache rien sans la preuve du titulaire (ancien mot de passe du compte de la ligne) ou une dispense courte réservée aux simples utilisateurs ; égalité stricte de l'identifiant dans l'alphabet sûr et de l'ancre du fournisseur ; ligne qui ne survit pas à ce qui l'invalide ; périmé ignoré ; ignoré pour un annuaire LDAP ; consommation revérifiée dans l'écriture (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, verifyUser } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ancreIdentite } from "../src/identite/ancre";
import {
  attenduDeRecu,
  attenduValide,
  detacher,
  prouverEtRattacher,
  preparerRattachement,
  rattacher,
} from "../src/identite/rattachement";
import type { EntreePreuve } from "../src/identite/rattachement";
import { resoudreIdentite } from "../src/identite/provisionnement";
import type { DependancesProvisionnement, ProfilIdentite } from "../src/identite/provisionnement";
import { validerFournisseur } from "../src/identite/reglages";
import type { FournisseurOidc } from "../src/identite/reglages";
import { journalMuet, lignesAuditRecentes } from "./aides";
import { ldapValide, oidcValide } from "./identite/aides";
import { MOTEURS } from "./identite/banc";

const T = 1_800_000_000;
const ISSUER_URL = "https://idp.exemple.lan/realms/elpis";
const ISSUER = `oidc:${ISSUER_URL}`;

function profil(extra: Partial<ProfilIdentite> = {}): ProfilIdentite {
  return {
    subject: "sub-1",
    issuer: ISSUER,
    extUsername: "Jean.Dupont",
    extEmail: "jean.dupont@exemple.lan",
    extName: "Jean Dupont",
    ...extra,
  };
}

describe("identifiant attendu : alphabet sûr, minuscules ASCII", () => {
  it("création : minuscules ASCII seulement ; tout autre caractère est refusé", () => {
    expect(attenduValide("Jean.Dupont@Exemple.LAN")).toBe("jean.dupont@exemple.lan");
    for (const mauvais of [
      "jean․dupont",
      "ｊean",
      "jean dupont",
      " jean",
      "jean\n",
      "\u212Aim",
      "ſam",
      "",
      "a".repeat(257),
    ])
      expect(attenduValide(mauvais), JSON.stringify(mauvais)).toBeNull();
    expect(attenduValide(7)).toBeNull();
  });

  it("réception : un identifiant hors de l'alphabet ne correspond jamais", () => {
    expect(attenduDeRecu("Jean.DUPONT")).toBe("jean.dupont");
    for (const sosie of [
      "jean․dupont",
      "ｊean.dupont",
      "𝐣ean.dupont",
      "\u212Aim",
      "ſam",
      "jean ",
      "jean\n",
      "",
    ])
      expect(attenduDeRecu(sosie), JSON.stringify(sosie)).toBeNull();
  });
});

describe.each(MOTEURS)("rattachements préparés : résolution et preuve (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let revoques: number[];
  let oauthRevoques: number[];
  let dep: DependancesProvisionnement;
  let chef: number;
  const oidc = validerFournisseur(
    oidcValide({ id: "sso", required_groups: ["elpis"], issuer: ISSUER_URL }),
  ) as FournisseurOidc;
  const ancre = ancreIdentite(oidc);
  const ldap = validerFournisseur(ldapValide({ required_groups: ["cn=elpis"] }));

  const preparer = async (
    uid: number,
    attendu: string,
    o: { dispense?: boolean; confirmeAdmin?: boolean; fournisseurId?: string; t?: number } = {},
  ): Promise<number> => {
    const r = await t.base.ecriture((x) =>
      preparerRattachement(x, {
        uid,
        fournisseurId: o.fournisseurId ?? "sso",
        ancre,
        attendu,
        dispense: o.dispense ?? false,
        confirmeAdmin: o.confirmeAdmin ?? false,
        par: chef,
        t: o.t ?? T,
      }),
    );
    if ("raison" in r) throw new Error(r.raison);
    return r.id;
  };
  const tenter = (uid: number, o: { dispense?: boolean; confirmeAdmin?: boolean } = {}) =>
    t.base.ecriture((x) =>
      preparerRattachement(x, {
        uid,
        fournisseurId: "sso",
        ancre,
        attendu: "x",
        dispense: o.dispense ?? false,
        confirmeAdmin: o.confirmeAdmin ?? false,
        par: chef,
        t: T,
      }),
    );
  const resoudre = (p: ProfilIdentite, appartenance: "oui" | "non" | "inconnu" = "oui", f = oidc) =>
    resoudreIdentite(dep, { fournisseur: f, profil: p, appartenance, maintenant: T });
  const preuve = (id: number, motDePasse: string, extra: Partial<EntreePreuve> = {}) =>
    prouverEtRattacher(dep, {
      fournisseur: oidc,
      prelinkId: id,
      profil: profil(),
      appartenance: "oui",
      motDePasse,
      ip: null,
      ...extra,
    });
  const comptes = () => t.base.valeurs("SELECT username FROM users ORDER BY id");
  const identites = () => t.base.all<Record<string, unknown>>("SELECT * FROM user_identities");
  const lignes = () => t.base.all<Record<string, unknown>>("SELECT * FROM auth_prelinks");
  const compte = (nom: string) =>
    t.base.get<Record<string, unknown>>("SELECT * FROM users WHERE username=?", [nom]);
  const jeton = (uid: number) =>
    t.base.run(
      "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
      [uid, "api", "t", `h-${uid}-${Math.random()}`, "", "", T],
    );
  const nbJetons = async (uid: number): Promise<number> =>
    Number((await t.base.valeurs("SELECT COUNT(*) FROM tool_tokens WHERE user_id=?", [uid]))[0]?.[0]);
  const audit = (prefixe: string) => lignesAuditRecentes({ actionPrefix: prefixe });

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    dossier = mkdtempSync(join(tmpdir(), "elpis-prelink-"));
    configureAudit({ service: "admin", auditDir: dossier, hmacKeyPath: join(dossier, "sans-cle") });
    revoques = [];
    oauthRevoques = [];
    dep = {
      base: t.base,
      acces: {
        ...dependancesParDefaut(t.base),
        revoquerOauth: async (uid: number) => (oauthRevoques.push(uid), 2),
      },
      maintenant: () => T,
      publierSuspension: async () => true,
      revoquer: async (uid) => void revoques.push(uid),
      journal: journalMuet,
    };
  });
  afterEach(async () => {
    oublierConfigurationAudit();
    rmSync(dossier, { recursive: true, force: true });
    await t.fermer();
  });

  describe("résolution d'une identité inconnue", () => {
    it("rattachement préparé avec preuve : `preuve`, aucun compte créé, rien attaché ni modifié", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      const avant = await t.base.all("SELECT * FROM users ORDER BY id");
      expect(await resoudre(profil())).toEqual({ type: "preuve", prelinkId: id, uid: jean });
      expect(await resoudre(profil({ extUsername: "JEAN.Dupont" }))).toMatchObject({ type: "preuve" });
      expect(await t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
      expect(await identites()).toEqual([]);
      expect(await lignes()).toHaveLength(1);
      expect(revoques).toEqual([]);
    });

    it("jamais de rattachement par ressemblance : identifiants sosies, avec ou sans dispense", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const kim = await createUser(t.base, "kim", "mdp-local-2");
      await preparer(jean, "jean.dupont", { dispense: true });
      await preparer(kim, "kim");
      const sosies: [string, string][] = [
        ["jean․dupont", "jean.dupont"],
        ["ｊｅａｎ.dupont", "jean.dupont"],
        ["𝐣ean.dupont", "jean.dupont"],
        ["jean.dupont ", "jean.dupont"],
        ["jean.dupont\n", "jean.dupont"],
        ["\u212Aim", "kim"],
        ["jean.dupont2", "jean.dupont"],
        ["jean", "jean.dupont"],
      ];
      for (const [nom] of sosies) {
        const r = await resoudre(profil({ extUsername: nom, subject: `autre-${nom}` }));
        expect(r.type, nom).not.toBe("preuve");
        if (r.type === "compte") expect([jean, kim], nom).not.toContain(r.uid);
      }
      expect(
        await t.base.valeurs("SELECT user_id FROM user_identities WHERE user_id IN (?,?)", [jean, kim]),
      ).toEqual([]);
      expect((await compte("jean-dupont"))?.["pass_hash"]).not.toBe("!");
      expect((await compte("kim"))?.["pass_hash"]).not.toBe("!");
      expect(await lignes()).toHaveLength(2);
    });

    it("sans correspondance et sans compte homonyme : le compte est créé comme avant", async () => {
      const r = await resoudre(profil({ extUsername: "Paul" }));
      expect(r).toMatchObject({ type: "compte", cree: true });
      expect(await comptes()).toEqual([["chef"], ["paul"]]);
    });

    it("avec dispense : rattaché tout de suite, ligne supprimée, flux coupés, jetons et accès révoqués, audit complet", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await t.base.run("UPDATE users SET must_change_pwd=1 WHERE id=?", [jean]);
      await jeton(jean);
      await jeton(jean);
      await preparer(jean, "jean.dupont", { dispense: true });
      const r = await resoudre(profil({ extUsername: "Jean.Dupont" }));
      expect(r).toEqual({ type: "compte", uid: jean, cree: false });
      expect(await compte("jean-dupont")).toMatchObject({ pass_hash: "!", must_change_pwd: 0 });
      expect(Number((await compte("jean-dupont"))?.["session_min_ts"])).toBe(T);
      expect(await identites()).toMatchObject([
        { user_id: jean, provider_id: "sso", subject: "sub-1", issuer: ancre, linked_by: `prelink:${chef}` },
      ]);
      expect(await lignes()).toEqual([]);
      expect(revoques).toEqual([jean]);
      expect(oauthRevoques).toEqual([jean]);
      expect(await nbJetons(jean)).toBe(0);
      const [ligne] = audit("auth.identity.link");
      expect(ligne).toMatchObject({
        details: {
          target_user_id: jean,
          provider_id: "sso",
          by: `prelink:${chef}`,
          method: "waiver",
          subject: "sub-1",
          revoked_tokens: 2,
          revoked_oauth: 2,
        },
      });
      expect(String((ligne?.["details"] as Record<string, unknown>)["identifier_hash"])).toMatch(
        /^[0-9a-f]{16}$/u,
      );
      expect(JSON.stringify(ligne)).not.toContain("Jean.Dupont");
      expect(await resoudre(profil())).toEqual({ type: "compte", uid: jean, cree: false });
    });

    it("dispense : refusée à la création pour un administrateur et un modérateur ; la confirmation vaut aussi pour un modérateur", async () => {
      const sam = await createUser(t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      const mo = await createUser(t.base, "mo", "mdp-mo-1234", { isAdmin: 2 });
      expect(await tenter(sam, { dispense: true, confirmeAdmin: true })).toEqual({
        raison: "waiver_forbidden_for_admin",
      });
      expect(await tenter(mo, { dispense: true, confirmeAdmin: true })).toEqual({
        raison: "waiver_forbidden_for_admin",
      });
      expect(await tenter(mo)).toEqual({ raison: "admin_confirmation_required" });
      expect(await tenter(sam)).toEqual({ raison: "admin_confirmation_required" });
      expect(await lignes()).toEqual([]);
      expect(await tenter(mo, { confirmeAdmin: true })).toHaveProperty("id");
      expect(await lignes()).toMatchObject([{ user_id: mo, admin_confirmed: 1, waiver: 0 }]);
    });

    it.each([1, 2])(
      "dispense posée sur un compte promu entre-temps (rôle %i) : prelink_invalid, ligne supprimée, rien ne change",
      async (role) => {
        const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
        await preparer(jean, "jean.dupont", { dispense: true });
        await t.base.run("UPDATE users SET is_admin=? WHERE id=?", [role, jean]);
        const avant = await t.base.all("SELECT * FROM users ORDER BY id");
        expect(await resoudre(profil())).toMatchObject({
          type: "refus",
          raison: "prelink_invalid",
          uid: jean,
        });
        expect(await t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
        expect(await identites()).toEqual([]);
        expect(await lignes()).toEqual([]);
        expect(revoques).toEqual([]);
      },
    );

    it("échéance : 72 heures avec dispense, 30 jours sans ; une dispense de 73 heures est périmée", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const paul = await createUser(t.base, "paul", "mdp-local-2");
      await preparer(jean, "jean.dupont", { dispense: true });
      await preparer(paul, "paul");
      const [a, b] = await lignes();
      expect(Number(a?.["expires_at"]) - Number(a?.["created_at"])).toBe(72 * 3600);
      expect(Number(b?.["expires_at"]) - Number(b?.["created_at"])).toBe(30 * 86_400);
      dep = { ...dep, maintenant: () => T + 73 * 3600 };
      const r = await resoudreIdentite(dep, {
        fournisseur: oidc,
        profil: profil(),
        appartenance: "oui",
        maintenant: T + 73 * 3600,
      });
      expect(r).toMatchObject({ type: "refus", raison: "account_conflict" });
      expect(await identites()).toEqual([]);
    });

    it("ancre du fournisseur : une ligne d'une autre ancre, ou un profil d'un autre émetteur, ne mène à rien", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await preparer(jean, "jean.dupont", { dispense: true });
      expect(await resoudre(profil({ issuer: "oidc:https://autre.exemple.lan" }))).toMatchObject({
        type: "refus",
        raison: "prelink_invalid",
      });
      await t.base.run("UPDATE auth_prelinks SET issuer=?", ["oidc:https://autre.exemple.lan"]);
      expect(await resoudre(profil())).toMatchObject({ type: "refus", raison: "prelink_invalid" });
      expect(await identites()).toEqual([]);
      expect((await compte("jean-dupont"))?.["pass_hash"]).not.toBe("!");
    });

    it("rattachement préparé périmé : ignoré, l'homonyme reste en conflit, aucun compte créé", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await preparer(jean, "jean.dupont", { dispense: true, t: T - 31 * 86_400 });
      const r = await resoudre(profil());
      expect(r).toMatchObject({ type: "refus", raison: "account_conflict" });
      expect(await identites()).toEqual([]);
      expect(await comptes()).toEqual([["chef"], ["jean-dupont"]]);
      expect((await compte("jean-dupont"))?.["pass_hash"]).not.toBe("!");
    });

    it("hors du groupe requis : refus avant tout rattachement, la ligne reste", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await preparer(jean, "jean.dupont", { dispense: true });
      expect(await resoudre(profil(), "non")).toMatchObject({ type: "refus", raison: "not_in_group" });
      expect(await resoudre(profil(), "inconnu")).toMatchObject({ type: "refus", raison: "groups_unknown" });
      expect(await identites()).toEqual([]);
      expect(await lignes()).toHaveLength(1);
    });

    it("compte suspendu : refus, rien d'écrit", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await preparer(jean, "jean.dupont", { dispense: true });
      await t.base.run("UPDATE users SET suspended_at=1, suspended_by='admin' WHERE id=?", [jean]);
      expect(await resoudre(profil())).toMatchObject({ type: "refus", raison: "suspended" });
      expect(await identites()).toEqual([]);
    });

    it("annuaire LDAP : les rattachements préparés sont ignorés, l'homonyme est refusé", async () => {
      const jean = await createUser(t.base, "jean", "mdp-local-1");
      await preparer(jean, "jean", { dispense: true, fournisseurId: "annuaire" });
      const r = await resoudreIdentite(dep, {
        fournisseur: ldap,
        profil: profil({
          subject: "cle-1",
          issuer: "ldap:cn=users,dc=exemple,dc=lan#entryuuid",
          extUsername: "jean",
        }),
        appartenance: "oui",
        maintenant: T,
      });
      expect(r).toMatchObject({ type: "refus", raison: "account_conflict" });
      expect(await identites()).toEqual([]);
      expect(await lignes()).toHaveLength(1);
    });

    it("le rattachement préparé d'un autre fournisseur ne correspond pas", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await preparer(jean, "jean.dupont", { dispense: true, fournisseurId: "autre" });
      expect(await resoudre(profil())).toMatchObject({ type: "refus", raison: "account_conflict" });
      expect(await identites()).toEqual([]);
    });
  });

  describe("une ligne préparée ne survit pas à ce qui l'invalide", () => {
    it("rattacher le compte (assistant d'annuaire) supprime sa ligne ; détacher ne la fait pas revivre", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await preparer(jean, "jean.dupont");
      const obstacle = await t.base.ecriture((x) =>
        rattacher(
          x,
          jean,
          {
            fournisseurId: "annuaire",
            subject: "cle",
            issuer: "ldap:x",
            extUsername: "jean",
            extEmail: "",
            extName: "",
          },
          { par: "admin:1", confirmeAdmin: false, t: T },
        ),
      );
      expect(obstacle).toBeNull();
      expect(await lignes()).toEqual([]);
      await t.base.ecriture((x) => detacher(x, jean, "Mdp-Temporaire-1", T + 10));
      expect(await lignes()).toEqual([]);
      expect(await resoudre(profil())).toMatchObject({ type: "refus", raison: "account_conflict" });
    });
  });

  describe("preuve du titulaire", () => {
    it("écrit l'identité sur le compte de la ligne, tue l'ancien mot de passe, garde jetons et accès, coupe les sessions, supprime la ligne et ses flux", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await t.base.run("UPDATE users SET must_change_pwd=1 WHERE id=?", [jean]);
      await jeton(jean);
      const id = await preparer(jean, "jean.dupont");
      await t.base.run(
        "INSERT INTO auth_flows(state_hash, provider_id, browser_hash, stage, prelink_id, created_at, expires_at) VALUES('s','sso','b','proof',?,?,?)",
        [id, T, T + 600],
      );
      const r = await preuve(id, "mdp-local-1", { ip: "10.1.1.1" });
      expect(r).toEqual({ type: "compte", uid: jean, cree: false });
      expect(await compte("jean-dupont")).toMatchObject({ pass_hash: "!", must_change_pwd: 0 });
      expect(Number((await compte("jean-dupont"))?.["session_min_ts"])).toBe(T);
      expect(await verifyUser(t.base, "jean-dupont", "mdp-local-1")).toBeNull();
      expect(await identites()).toMatchObject([
        { user_id: jean, subject: "sub-1", issuer: ancre, linked_by: "proof" },
      ]);
      expect(await lignes()).toEqual([]);
      expect(await t.base.valeurs("SELECT 1 FROM auth_flows")).toEqual([]);
      expect(await nbJetons(jean)).toBe(1);
      expect(oauthRevoques).toEqual([]);
      expect(revoques).toEqual([jean]);
      expect(audit("auth.identity.link")[0]).toMatchObject({
        user_id: jean,
        details: {
          target_user_id: jean,
          method: "proof",
          subject: "sub-1",
          kept: true,
          by: `prelink:${chef}`,
        },
      });
    });

    it("le compte visé est celui de la ligne : le mot de passe d'un autre compte ne prouve rien", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await createUser(t.base, "paul", "mdp-local-2");
      const id = await preparer(jean, "jean.dupont");
      expect(await preuve(id, "mdp-local-2")).toEqual({ type: "mot_de_passe", verrouille: false });
      expect(await preuve(id, "mdp-chef-1")).toEqual({ type: "mot_de_passe", verrouille: false });
      expect(await identites()).toEqual([]);
      expect((await compte("paul"))?.["pass_hash"]).not.toBe("!");
    });

    it("échecs comptés sur la ligne : à cinq, la ligne est supprimée et auditée ; la bonne réponse n'y change plus rien", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      for (let n = 1; n <= 4; n++) {
        expect(await preuve(id, "faux")).toEqual({ type: "mot_de_passe", verrouille: false });
        expect(Number((await lignes())[0]?.["attempts"])).toBe(n);
      }
      expect(await preuve(id, "faux")).toEqual({ type: "mot_de_passe", verrouille: true });
      expect(await lignes()).toEqual([]);
      expect(audit("auth.prelink.locked")[0]).toMatchObject({
        outcome: "failure",
        details: { target_user_id: jean },
      });
      expect(await preuve(id, "mdp-local-1")).toMatchObject({ type: "refus", raison: "prelink_invalid" });
      expect(await identites()).toEqual([]);
      expect((await compte("jean-dupont"))?.["pass_hash"]).not.toBe("!");
    });

    it("un nouveau passage par le fournisseur ne remet pas le compteur à zéro", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      await preuve(id, "faux");
      await preuve(id, "faux");
      expect(await resoudre(profil())).toMatchObject({ type: "preuve", prelinkId: id });
      expect(Number((await lignes())[0]?.["attempts"])).toBe(2);
    });

    it("identifiant sosie, autre ancre, autre fournisseur, ligne absente ou périmée : rien, même avec le bon mot de passe", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      const autre = validerFournisseur(
        oidcValide({ id: "autre", required_groups: ["elpis"] }),
      ) as FournisseurOidc;
      for (const e of [
        { profil: profil({ extUsername: "jean․dupont" }) },
        { profil: profil({ extUsername: "jean.dupont2" }) },
        { profil: profil({ issuer: "oidc:https://autre.exemple.lan" }) },
        { profil: profil({ subject: "" }) },
        { fournisseur: autre },
        { prelinkId: id + 50 },
      ])
        expect(await preuve(e.prelinkId ?? id, "mdp-local-1", e), JSON.stringify(e)).toMatchObject({
          type: "refus",
          raison: "prelink_invalid",
        });
      await t.base.run("UPDATE auth_prelinks SET expires_at=?", [T]);
      expect(await preuve(id, "mdp-local-1")).toMatchObject({ raison: "prelink_invalid" });
      expect(await identites()).toEqual([]);
      expect((await compte("jean-dupont"))?.["pass_hash"]).not.toBe("!");
    });

    it("hors du groupe requis : refus sans toucher au compte", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      expect(await preuve(id, "mdp-local-1", { appartenance: "non" })).toMatchObject({
        raison: "not_in_group",
      });
      expect(await preuve(id, "mdp-local-1", { appartenance: "inconnu" })).toMatchObject({
        raison: "groups_unknown",
      });
      expect(await identites()).toEqual([]);
    });

    it("sans mot de passe fourni : aucune consommation possible", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      const sansMotDePasse = {
        fournisseur: oidc,
        prelinkId: id,
        profil: profil(),
        appartenance: "oui" as const,
        ip: null,
      };
      // @ts-expect-error le mot de passe est obligatoire
      const r = await prouverEtRattacher(dep, sansMotDePasse);
      expect(r).toMatchObject({ type: "mot_de_passe" });
      expect(await identites()).toEqual([]);
      expect(await verifyUser(t.base, "jean-dupont", "mdp-local-1")).toBe(jean);
    });

    it.each([1, 2])(
      "compte promu (rôle %i) depuis la préparation sans confirmation : prelink_invalid ; avec la confirmation posée à la création : rattaché",
      async (role) => {
        const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
        const id = await preparer(jean, "jean.dupont");
        await t.base.run("UPDATE users SET is_admin=? WHERE id=?", [role, jean]);
        expect(await preuve(id, "mdp-local-1")).toMatchObject({ type: "refus", raison: "prelink_invalid" });
        expect(await identites()).toEqual([]);
        expect(await verifyUser(t.base, "jean-dupont", "mdp-local-1")).toBe(jean);
        const sam = await createUser(t.base, "sam", "mdp-sam-123", { isAdmin: role });
        const ids = await preparer(sam, "sam", { confirmeAdmin: true });
        expect(
          await preuve(ids, "mdp-sam-123", { profil: profil({ extUsername: "sam", subject: "s2" }) }),
        ).toMatchObject({
          type: "compte",
          uid: sam,
        });
      },
    );

    it("un administrateur devenu le dernier administrateur local : refus", async () => {
      const sam = await createUser(t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      const id = await preparer(sam, "sam", { confirmeAdmin: true });
      await t.base.run("UPDATE users SET is_admin=0 WHERE id=?", [chef]);
      expect(await preuve(id, "mdp-sam-123", { profil: profil({ extUsername: "sam" }) })).toMatchObject({
        type: "refus",
        raison: "no_local_admin",
      });
      expect(await identites()).toEqual([]);
      expect(await verifyUser(t.base, "sam", "mdp-sam-123")).toBe(sam);
    });

    it("compte suspendu, ou déjà rattaché à une autre entrée depuis la préparation : refus", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      await t.base.run("UPDATE users SET suspended_at=1, suspended_by='admin' WHERE id=?", [jean]);
      expect(await preuve(id, "mdp-local-1")).toMatchObject({ raison: "suspended" });
      await t.base.run("UPDATE users SET suspended_at=NULL, suspended_by=NULL WHERE id=?", [jean]);
      await t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
        [jean, "autre", "x", "i", "admin", T],
      );
      expect(await preuve(id, "mdp-local-1")).toMatchObject({ raison: "account_conflict" });
      expect(await identites()).toHaveLength(1);
    });

    /** Base dont la prochaine écriture est précédée de `avant` (course entre la vérification et l'écriture). */
    const avecCourse = (avant: () => Promise<unknown>): DependancesProvisionnement => {
      let fait = false;
      const base = new Proxy(t.base, {
        get(cible, nom) {
          if (nom === "ecriture")
            return async (f: never) => {
              if (!fait) {
                fait = true;
                await avant();
              }
              return cible.ecriture(f);
            };
          const v = Reflect.get(cible, nom) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(cible) : v;
        },
      });
      return { ...dep, base };
    };

    it("mot de passe du compte changé entre la vérification et l'écriture : refus, rien d'écrit", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      dep = avecCourse(() => t.base.run("UPDATE users SET pass_salt='autre-sel' WHERE id=?", [jean]));
      expect(await preuve(id, "mdp-local-1")).toMatchObject({ type: "refus", raison: "prelink_invalid" });
      expect(await identites()).toEqual([]);
      expect(await lignes()).toHaveLength(1);
    });

    it("ligne préparée supprimée entre la vérification et l'écriture : refus, rien d'écrit", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      dep = avecCourse(() => t.base.run("DELETE FROM auth_prelinks WHERE id=?", [id]));
      expect(await preuve(id, "mdp-local-1")).toMatchObject({ type: "refus", raison: "prelink_invalid" });
      expect(await identites()).toEqual([]);
      expect(await verifyUser(t.base, "jean-dupont", "mdp-local-1")).toBe(jean);
    });
  });
});
