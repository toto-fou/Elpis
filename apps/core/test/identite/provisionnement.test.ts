// SPDX-License-Identifier: MIT
/** apps/core/test/identite/provisionnement.test.ts — profil externe → compte : création sans mot de passe local, identité connue (suspension, réactivation, ancre), refus sans rien modifier, rien par ressemblance de nom, deux premières connexions simultanées (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resoudreIdentite } from "../../src/identite/provisionnement";
import type {
  Appartenance,
  DependancesProvisionnement,
  ProfilIdentite,
} from "../../src/identite/provisionnement";
import { validerFournisseur } from "../../src/identite/reglages";
import { journalMuet, lignesAuditRecentes } from "../aides";
import { oidcValide } from "./aides";
import { MOTEURS } from "./banc";

const ANCRE = "oidc:https://idp.exemple.lan/realms/elpis";
const T = 1_800_000_000;

function profil(extra: Partial<ProfilIdentite> = {}): ProfilIdentite {
  return {
    subject: "cle-1",
    issuer: ANCRE,
    extUsername: "jdupont",
    extEmail: "jdupont@exemple.lan",
    extName: "Jean Dupont",
    ...extra,
  };
}

describe.each(MOTEURS)("provisionnement (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let publiees: number[];
  let dep: DependancesProvisionnement;
  const fournisseur = validerFournisseur(oidcValide({ required_groups: ["elpis"] }));

  const resoudre = (p: ProfilIdentite, appartenance: Appartenance, maintenant = T) =>
    resoudreIdentite(dep, { fournisseur, profil: p, appartenance, maintenant });
  const comptes = (): Promise<unknown[][]> => t.base.valeurs("SELECT username FROM users ORDER BY id");
  const ligne = (username: string) =>
    t.base.get<Record<string, unknown>>("SELECT * FROM users WHERE username=?", [username]);
  const identites = (): Promise<unknown[][]> => t.base.valeurs("SELECT user_id FROM user_identities");

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    dossier = mkdtempSync(join(tmpdir(), "elpis-prov-"));
    configureAudit({ service: "admin", auditDir: dossier, hmacKeyPath: join(dossier, "sans-cle") });
    publiees = [];
    dep = {
      base: t.base,
      acces: dependancesParDefaut(t.base),
      maintenant: () => T,
      publierSuspension: async (uid) => (publiees.push(uid), true),
      revoquer: async () => undefined,
      journal: journalMuet,
    };
  });
  afterEach(async () => {
    oublierConfigurationAudit();
    rmSync(dossier, { recursive: true, force: true });
    await t.fermer();
  });

  it("première connexion dans le groupe : compte créé sans mot de passe local, identité liée « auto »", async () => {
    const r = await resoudre(profil({ extUsername: "Jean.Dupont" }), "oui");
    expect(r).toMatchObject({ type: "compte", cree: true });
    const u = await ligne("jean-dupont");
    expect(u).toMatchObject({ pass_hash: "!", is_admin: 0, must_change_pwd: 0 });
    expect(String(u?.["pass_salt"])).toMatch(/^[0-9a-f]{32}$/u);
    const i = await t.base.get<Record<string, unknown>>("SELECT * FROM user_identities");
    expect(i).toMatchObject({
      user_id: u?.["id"],
      provider_id: "sso",
      subject: "cle-1",
      issuer: ANCRE,
      ext_username: "Jean.Dupont",
      ext_email: "jdupont@exemple.lan",
      ext_name: "Jean Dupont",
      linked_by: "auto",
    });
    const ev = lignesAuditRecentes({ actionPrefix: "auth.identity.create" })[0];
    expect(ev).toMatchObject({ username: "jean-dupont", outcome: "success" });
    expect(ev?.["details"]).toMatchObject({ provider_id: "sso", linked_by: "auto" });
  });

  it("seconde connexion : même compte, nom affiché et e-mail mis à jour, aucun doublon", async () => {
    const a = await resoudre(profil(), "oui");
    const b = await resoudre(profil({ extName: "J. Dupont", extEmail: "j@exemple.lan" }), "oui", T + 60);
    expect(a.type === "compte" && b.type === "compte" && a.uid === b.uid && !b.cree).toBe(true);
    expect(await comptes()).toEqual([["chef"], ["jdupont"]]);
    expect(await t.base.get("SELECT ext_name, ext_email, checked_at FROM user_identities")).toEqual({
      ext_name: "J. Dupont",
      ext_email: "j@exemple.lan",
      checked_at: T + 60,
    });
  });

  it("identifiant externe rebaptisé : même clé stable, même compte, nom Elpis inchangé", async () => {
    const a = await resoudre(profil(), "oui");
    const b = await resoudre(profil({ extUsername: "jean.dupont" }), "oui");
    expect(b).toEqual({ type: "compte", uid: a.type === "compte" ? a.uid : -1, cree: false });
    expect(await comptes()).toEqual([["chef"], ["jdupont"]]);
  });

  it.each([
    ["Jean-Dupont", "Jean.Dupont"],
    ["Jean-Dupont", "jean-dupont"],
    ["Jean_Dupont", "jean_dupont"],
    ["JDUPONT", "jdupont"],
  ])(
    "homonyme du compte « %s » (identifiant %s) : refus, rien n'est créé ni modifié",
    async (existant, ext) => {
      await createUser(t.base, existant, "mdp-existant-1");
      const avant = await t.base.all("SELECT * FROM users ORDER BY id");
      const r = await resoudre(profil({ extUsername: ext }), "oui");
      expect(r).toEqual({ type: "refus", raison: "account_conflict" });
      expect(await t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
      expect(await identites()).toEqual([]);
    },
  );

  it("jamais de rattachement par e-mail ni par nom affiché : un compte du même nom d'affichage reste intact", async () => {
    await createUser(t.base, "jean", "mdp-jean-1");
    const r = await resoudre(
      profil({ extUsername: "jdupont", extEmail: "jean@exemple.lan", extName: "jean" }),
      "oui",
    );
    expect(r).toMatchObject({ type: "compte", cree: true });
    expect(await comptes()).toEqual([["chef"], ["jean"], ["jdupont"]]);
    expect(await t.base.valeurs("SELECT user_id FROM user_identities")).not.toContainEqual([
      (await ligne("jean"))?.["id"],
    ]);
  });

  it.each(["admin", "Root", "system", "elpis", "guest", "user_42", "!!!", "a", ""])(
    "nom dérivé invalide ou réservé (%j) : refus name_invalid, rien créé",
    async (ext) => {
      expect(await resoudre(profil({ extUsername: ext }), "oui")).toEqual({
        type: "refus",
        raison: "name_invalid",
      });
      expect(await comptes()).toEqual([["chef"]]);
      expect(await identites()).toEqual([]);
    },
  );

  it("aucun administrateur local actif : refus no_local_admin, rien créé", async () => {
    await t.base.run("UPDATE users SET pass_hash='!' WHERE username='chef'");
    expect(await resoudre(profil(), "oui")).toEqual({ type: "refus", raison: "no_local_admin" });
    expect(await comptes()).toEqual([["chef"]]);
  });

  it.each([
    ["non", "not_in_group"],
    ["inconnu", "groups_unknown"],
  ] as const)("identité inconnue, appartenance %s : refus %s, rien créé", async (appartenance, raison) => {
    expect(await resoudre(profil(), appartenance)).toEqual({ type: "refus", raison });
    expect(await comptes()).toEqual([["chef"]]);
    expect(await identites()).toEqual([]);
    const ev = lignesAuditRecentes({ actionPrefix: "auth.identity.refused" })[0];
    expect(ev).toMatchObject({ outcome: "failure" });
    expect(ev?.["details"]).toEqual({ provider_id: "sso", reason: raison });
  });

  describe("identité connue", () => {
    let uid: number;
    beforeEach(async () => {
      const r = await resoudre(profil(), "oui");
      uid = r.type === "compte" ? r.uid : -1;
    });
    const etat = () =>
      t.base.get<{ suspended_at: number; suspended_by: string | null }>(
        "SELECT suspended_at, suspended_by FROM users WHERE id=?",
        [uid],
      );

    it("retiré du groupe : refus et compte suspendu `provider:<id>`, coupure propagée", async () => {
      expect(await resoudre(profil(), "non", T + 10)).toEqual({ type: "refus", raison: "not_in_group", uid });
      expect(await etat()).toMatchObject({ suspended_at: T + 10, suspended_by: "provider:sso" });
      await vi.waitFor(() => expect(publiees).toEqual([uid]));
      const ev = lignesAuditRecentes({ actionPrefix: "auth.account.suspend" })[0];
      expect(ev).toMatchObject({ user_id: uid, username: "jdupont" });
      expect(ev?.["details"]).toMatchObject({ origin: "provider:sso", provider_id: "sso" });
    });

    it("la coupure d'accès n'est pas attendue : une panne de publication ne change pas la réponse et est journalisée", async () => {
      dep = {
        ...dep,
        publierSuspension: () => new Promise(() => undefined),
      };
      const r = await Promise.race([
        resoudre(profil(), "non", T + 10),
        new Promise<string>((ok) => setTimeout(() => ok("bloque"), 3000)),
      ]);
      expect(r).toEqual({ type: "refus", raison: "not_in_group", uid });
      expect(await etat()).toMatchObject({ suspended_by: "provider:sso" });
    });

    it("groupes illisibles : refus sans rien modifier (ni suspension, ni mise à jour, ni coupure)", async () => {
      const avant = await t.base.all("SELECT * FROM user_identities");
      const u = await t.base.all("SELECT * FROM users ORDER BY id");
      expect(await resoudre(profil({ extName: "Autre" }), "inconnu", T + 10)).toEqual({
        type: "refus",
        raison: "groups_unknown",
        uid,
      });
      expect(await t.base.all("SELECT * FROM user_identities")).toEqual(avant);
      expect(await t.base.all("SELECT * FROM users ORDER BY id")).toEqual(u);
      expect(publiees).toEqual([]);
    });

    it("remis dans le groupe : suspension du fournisseur levée, `session_min_ts` remonté, audit de réactivation", async () => {
      await resoudre(profil(), "non", T + 10);
      expect(await resoudre(profil(), "oui", T + 20)).toEqual({ type: "compte", uid, cree: false });
      expect(await etat()).toMatchObject({ suspended_by: null });
      expect(Number((await etat())?.suspended_at)).toBe(0);
      expect(await t.base.get("SELECT session_min_ts FROM users WHERE id=?", [uid])).toEqual({
        session_min_ts: T + 20,
      });
      const ev = lignesAuditRecentes({ actionPrefix: "auth.account.reactivate" })[0];
      expect(ev?.["details"]).toMatchObject({ origin: "provider:sso" });
    });

    it("suspension par péremption du même fournisseur (`stale:<id>`) : levée", async () => {
      await t.base.run("UPDATE users SET suspended_at=?, suspended_by=? WHERE id=?", [T, "stale:sso", uid]);
      expect(await resoudre(profil(), "oui", T + 5)).toMatchObject({ type: "compte" });
      expect(Number((await etat())?.suspended_at)).toBe(0);
    });

    it.each(["admin", "provider:autre", "stale:autre", ""])(
      "suspendu par `%s` : refus suspended, l'état reste",
      async (par) => {
        await t.base.run("UPDATE users SET suspended_at=?, suspended_by=? WHERE id=?", [T, par, uid]);
        expect(await resoudre(profil(), "oui", T + 5)).toEqual({ type: "refus", raison: "suspended", uid });
        expect(await etat()).toMatchObject({ suspended_at: T, suspended_by: par });
      },
    );

    it("suspendu par un administrateur puis sorti du groupe : la suspension de l'administrateur n'est pas écrasée", async () => {
      await t.base.run("UPDATE users SET suspended_at=?, suspended_by=? WHERE id=?", [T, "admin", uid]);
      await resoudre(profil(), "non", T + 5);
      expect(await etat()).toMatchObject({ suspended_by: "admin" });
      expect(publiees).toEqual([]);
    });

    it("ancre différente (fournisseur repointé) : refus issuer_mismatch, rien n'est modifié", async () => {
      const avant = await t.base.all("SELECT * FROM user_identities");
      expect(
        await resoudre(profil({ issuer: "oidc:https://autre.exemple.lan/realms/elpis" }), "oui", T + 5),
      ).toEqual({ type: "refus", raison: "issuer_mismatch", uid });
      expect(await t.base.all("SELECT * FROM user_identities")).toEqual(avant);
      expect(await etat()).toMatchObject({ suspended_by: null });
    });

    it("ancre différente et hors groupe : aucune suspension", async () => {
      await resoudre(profil({ issuer: "autre" }), "non", T + 5);
      expect(Number((await etat())?.suspended_at)).toBe(0);
    });

    it("clé stable seule : un autre sujet avec le même nom externe est une autre personne (refus homonyme)", async () => {
      expect(await resoudre(profil({ subject: "cle-2" }), "oui")).toEqual({
        type: "refus",
        raison: "account_conflict",
      });
      expect(await identites()).toHaveLength(1);
    });
  });

  it("deux premières connexions simultanées : un seul compte, les deux obtiennent le même", async () => {
    const [a, b] = await Promise.all([resoudre(profil(), "oui"), resoudre(profil(), "oui")]);
    expect(a.type === "compte" && b.type === "compte" && a.uid === b.uid).toBe(true);
    expect([a, b].filter((r) => r.type === "compte" && r.cree)).toHaveLength(1);
    expect(await comptes()).toEqual([["chef"], ["jdupont"]]);
    expect(await identites()).toHaveLength(1);
  });

  it("deux personnes du fournisseur qui donnent le même nom, simultanément : un compte, un refus account_conflict", async () => {
    const rs = await Promise.all([
      resoudre(profil({ subject: "cle-1", extUsername: "jean.dupont" }), "oui"),
      resoudre(profil({ subject: "cle-2", extUsername: "jean-dupont" }), "oui"),
    ]);
    expect(rs.filter((r) => r.type === "compte")).toHaveLength(1);
    expect(rs.filter((r) => r.type === "refus")).toEqual([{ type: "refus", raison: "account_conflict" }]);
    expect(await identites()).toHaveLength(1);
  });

  it("une exception pendant l'écriture n'en laisse rien (compte et identité vont ensemble)", async () => {
    const espion = vi.spyOn(t.base, "transaction").mockRejectedValueOnce(new Error("panne"));
    await expect(resoudre(profil(), "oui")).rejects.toThrow("panne");
    espion.mockRestore();
    expect(await comptes()).toEqual([["chef"]]);
    expect(await identites()).toEqual([]);
  });
});
