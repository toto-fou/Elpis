// SPDX-License-Identifier: MIT
/** apps/core/test/securite-rattachement-prepare.test.ts — un rattachement préparé ne crée jamais de compte et n'attache rien sans la preuve prévue ou une dispense (interdite à un administrateur) ; périmé ignoré ; ignoré pour un annuaire LDAP ; consommation revérifiée dans la transaction (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { preparerRattachement, consommerRattachement } from "../src/identite/rattachement";
import { resoudreIdentite } from "../src/identite/provisionnement";
import type { DependancesProvisionnement, ProfilIdentite } from "../src/identite/provisionnement";
import { validerFournisseur } from "../src/identite/reglages";
import { journalMuet, lignesAuditRecentes } from "./aides";
import { ldapValide, oidcValide } from "./identite/aides";
import { MOTEURS } from "./identite/banc";

const T = 1_800_000_000;
const ISSUER = "https://idp.exemple.lan/realms/elpis";

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

describe.each(MOTEURS)("rattachements préparés : résolution et consommation (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let revoques: number[];
  let dep: DependancesProvisionnement;
  let chef: number;
  const oidc = validerFournisseur(oidcValide({ id: "sso", required_groups: ["elpis"] }));
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
  const resoudre = (p: ProfilIdentite, appartenance: "oui" | "non" | "inconnu" = "oui", f = oidc) =>
    resoudreIdentite(dep, { fournisseur: f, profil: p, appartenance, maintenant: T });
  const comptes = () => t.base.valeurs("SELECT username FROM users ORDER BY id");
  const identites = () => t.base.all<Record<string, unknown>>("SELECT * FROM user_identities");
  const lignes = () => t.base.all<Record<string, unknown>>("SELECT * FROM auth_prelinks");
  const compte = (nom: string) =>
    t.base.get<Record<string, unknown>>("SELECT * FROM users WHERE username=?", [nom]);

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    dossier = mkdtempSync(join(tmpdir(), "elpis-prelink-"));
    configureAudit({ service: "admin", auditDir: dossier, hmacKeyPath: join(dossier, "sans-cle") });
    revoques = [];
    dep = {
      base: t.base,
      acces: dependancesParDefaut(t.base),
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
      expect(await t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
      expect(await identites()).toEqual([]);
      expect(await lignes()).toHaveLength(1);
      expect(revoques).toEqual([]);
    });

    it("la correspondance est l'égalité de l'identifiant normalisé, jamais une ressemblance", async () => {
      const jean = await createUser(t.base, "jean", "mdp-local-1");
      await preparer(jean, "jean.dupont");
      for (const nom of ["jean.dupont2", "jean", "dupont", "jean.dupont "]) {
        const r = await resoudre(profil({ extUsername: nom, subject: `autre-${nom}` }));
        expect(r.type, nom).not.toBe("preuve");
      }
      expect((await resoudre(profil({ extUsername: "JEAN.ＤUPONT" }))).type).toBe("preuve");
      expect((await compte("jean"))?.["pass_hash"]).not.toBe("!");
      expect(await t.base.valeurs("SELECT 1 FROM user_identities WHERE user_id=?", [jean])).toEqual([]);
    });

    it("sans correspondance et sans compte homonyme : le compte est créé comme avant", async () => {
      const r = await resoudre(profil({ extUsername: "Paul" }));
      expect(r).toMatchObject({ type: "compte", cree: true });
      expect(await comptes()).toEqual([["chef"], ["paul"]]);
    });

    it("avec dispense : rattaché tout de suite (même écriture que le lien LDAP), ligne supprimée, flux coupés", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      await t.base.run("UPDATE users SET must_change_pwd=1 WHERE id=?", [jean]);
      await preparer(jean, "jean.dupont", { dispense: true });
      const r = await resoudre(profil());
      expect(r).toEqual({ type: "compte", uid: jean, cree: false });
      expect(await compte("jean-dupont")).toMatchObject({ pass_hash: "!", must_change_pwd: 0 });
      expect(Number((await compte("jean-dupont"))?.["session_min_ts"])).toBe(T);
      expect(await identites()).toMatchObject([
        { user_id: jean, provider_id: "sso", subject: "sub-1", issuer: ISSUER, linked_by: `prelink:${chef}` },
      ]);
      expect(await lignes()).toEqual([]);
      expect(revoques).toEqual([jean]);
      expect(await comptes()).toEqual([["chef"], ["jean-dupont"]]);
      expect(lignesAuditRecentes({ actionPrefix: "auth.identity.link" })[0]).toMatchObject({
        details: { target_user_id: jean, provider_id: "sso", by: `prelink:${chef}` },
      });
      expect(await resoudre(profil())).toEqual({ type: "compte", uid: jean, cree: false });
    });

    it("dispense posée sur un compte administrateur (ligne forcée en base) : refusée, rien ne change", async () => {
      const sam = await createUser(t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      await t.base.run(
        "INSERT INTO auth_prelinks(user_id, provider_id, expected, waiver, created_by, created_at, expires_at) VALUES(?,?,?,?,?,?,?)",
        [sam, "sso", "sam", 1, chef, T, T + 1000],
      );
      const avant = await t.base.all("SELECT * FROM users ORDER BY id");
      const r = await resoudre(profil({ extUsername: "sam" }));
      expect(r).toMatchObject({ type: "refus", raison: "prelink_invalid", uid: sam });
      expect(await t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
      expect(await identites()).toEqual([]);
      expect(await lignes()).toHaveLength(1);
      expect(revoques).toEqual([]);
    });

    it("le préparé d'un administrateur passe par la preuve, jamais par un rattachement direct", async () => {
      const sam = await createUser(t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      const id = await preparer(sam, "sam", { confirmeAdmin: true });
      expect(await resoudre(profil({ extUsername: "sam" }))).toEqual({
        type: "preuve",
        prelinkId: id,
        uid: sam,
      });
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

    it("compte suspendu ou dernier administrateur : refus, rien d'écrit", async () => {
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

  describe("consommation de la preuve", () => {
    it("écrit l'identité, retire le mot de passe local, coupe les sessions, supprime la ligne, en une transaction", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      const r = await consommerRattachement(dep, id, profil(), { fournisseurId: "sso" });
      expect(r).toEqual({ type: "compte", uid: jean, cree: false });
      expect(await compte("jean-dupont")).toMatchObject({ pass_hash: "!", must_change_pwd: 0 });
      expect(Number((await compte("jean-dupont"))?.["session_min_ts"])).toBe(T);
      expect(await identites()).toMatchObject([
        { user_id: jean, linked_by: `prelink:${chef}`, subject: "sub-1" },
      ]);
      expect(await lignes()).toEqual([]);
      expect(revoques).toEqual([jean]);
    });

    it("une ligne déjà consommée, absente, périmée ou d'un autre identifiant : refus, rien d'écrit", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const id = await preparer(jean, "jean.dupont");
      const avant = await t.base.all("SELECT * FROM users ORDER BY id");
      expect(await consommerRattachement(dep, id + 50, profil())).toMatchObject({
        type: "refus",
        raison: "prelink_invalid",
      });
      expect(await consommerRattachement(dep, id, profil({ extUsername: "jean.dupont2" }))).toMatchObject({
        type: "refus",
        raison: "prelink_invalid",
      });
      expect(await consommerRattachement(dep, id, profil(), { fournisseurId: "autre" })).toMatchObject({
        type: "refus",
        raison: "prelink_invalid",
      });
      expect(await consommerRattachement(dep, id, profil({ subject: "" }))).toMatchObject({
        raison: "prelink_invalid",
      });
      await t.base.run("UPDATE auth_prelinks SET expires_at=?", [T]);
      expect(await consommerRattachement(dep, id, profil())).toMatchObject({ raison: "prelink_invalid" });
      expect(await t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
      expect(await identites()).toEqual([]);
      await t.base.run("UPDATE auth_prelinks SET expires_at=?", [T + 100]);
      expect(await consommerRattachement(dep, id, profil())).toMatchObject({ type: "compte" });
      expect(await consommerRattachement(dep, id, profil())).toMatchObject({ raison: "prelink_invalid" });
      expect(await identites()).toHaveLength(1);
    });

    it("l'entrée déjà rattachée à un autre compte, ou le compte suspendu, depuis la préparation : refus", async () => {
      const jean = await createUser(t.base, "jean-dupont", "mdp-local-1");
      const paul = await createUser(t.base, "paul", "mdp-local-2");
      const id = await preparer(jean, "jean.dupont");
      await t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
        [paul, "sso", "sub-1", ISSUER, "x", T],
      );
      expect(await consommerRattachement(dep, id, profil())).toMatchObject({
        type: "refus",
        raison: "account_conflict",
      });
      await t.base.run("DELETE FROM user_identities");
      await t.base.run("UPDATE users SET suspended_at=1, suspended_by='admin' WHERE id=?", [jean]);
      expect(await consommerRattachement(dep, id, profil())).toMatchObject({
        type: "refus",
        raison: "suspended",
      });
      expect((await compte("jean-dupont"))?.["pass_hash"]).not.toBe("!");
    });

    it("un administrateur devenu le dernier administrateur local : refus", async () => {
      const sam = await createUser(t.base, "sam", "mdp-sam-123", { isAdmin: 1 });
      const id = await preparer(sam, "sam", { confirmeAdmin: true });
      await t.base.run("UPDATE users SET is_admin=0 WHERE id=?", [chef]);
      expect(await consommerRattachement(dep, id, profil({ extUsername: "sam" }))).toMatchObject({
        type: "refus",
        raison: "no_local_admin",
      });
      expect(await identites()).toEqual([]);
    });
  });
});
