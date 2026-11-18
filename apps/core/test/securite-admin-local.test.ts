// SPDX-License-Identifier: MIT
/** apps/core/test/securite-admin-local.test.ts — il reste toujours un administrateur actif à mot de passe local : suspension, suppression, changement de rôle et mot de passe sans effet sur un compte sans mot de passe local, vérifiés dans la même écriture que l'action (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import {
  aMotDePasseLocal,
  createUser,
  dependancesParDefaut,
  ErreurSansMotDePasseLocal,
  ligneUtilisateur,
  resetUserPassword,
  verifyUser,
} from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { suspendre } from "../src/comptes/etat";
import { deleteUserFull } from "../src/comptes/suppression";
import { creerFamilleAdminComptes } from "../src/familles/admin-comptes";
import { compterAdminsLocaux, exigerAdminLocal } from "../src/identite/etat";
import { appTest, journalMuet } from "./aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

async function refus(p: Promise<unknown>): Promise<number | string> {
  try {
    await p;
  } catch (e) {
    return e instanceof HttpError ? e.statusCode : String(e);
  }
  return 0;
}

describe.each(MOTEURS)("administrateur local (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let chef = 0;
  let chef2 = 0;
  let externe = 0;
  let modo = 0;
  let alice = 0;
  const suspensions: number[] = [];

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    chef2 = await createUser(t.base, "chef2", "mdp-chef2-1", { isAdmin: 1 });
    externe = await createUser(t.base, "externe", "mdp-externe-1", { isAdmin: 1 });
    modo = await createUser(t.base, "modo", "mdp-modo-1", { isAdmin: 2 });
    alice = await createUser(t.base, "alice", "mdp-alice-1");
    await t.base.run("UPDATE users SET pass_hash='!' WHERE id=?", [externe]);
    const auth = dependancesParDefaut(t.base);
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminComptes({
          base: t.base,
          auth,
          journal: journalMuet,
          revoquer: async () => undefined,
          publierSuspension: async (uid) => void suspensions.push(uid),
          bac: {
            supprimerSurHote: async () => null,
            retirerConteneur: async () => undefined,
            purgerTravail: async () => undefined,
            detruireConteneur: async () => undefined,
          },
        }),
      ],
      gardes: {
        admin: async (req: FastifyRequest) => {
          const uid = Number(req.headers["x-uid"]);
          const ligne = await ligneUtilisateur(t.base, uid);
          req.utilisateur = { id: uid, username: ligne ? String(ligne.username) : null };
          if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
  });

  const POST = (url: string, par: number, corps?: object): Promise<LightMyRequestResponse> =>
    app.inject({
      method: "POST",
      url,
      headers: { "x-uid": String(par) },
      ...(corps ? { payload: corps } : {}),
    });
  const etat = async (u: number): Promise<{ suspendu: boolean; admin: number; existe: boolean }> => {
    const l = await ligneUtilisateur(t.base, u);
    return {
      suspendu: Number(l?.suspended_at ?? 0) > 0,
      admin: Number(l?.is_admin ?? -1),
      existe: l !== undefined && l !== null,
    };
  };
  const hash = async (u: number): Promise<string> => String((await ligneUtilisateur(t.base, u))?.pass_hash);

  it("compte : seuls les administrateurs actifs à mot de passe local comptent", async () => {
    expect(await compterAdminsLocaux(t.base)).toBe(2);
    expect(await compterAdminsLocaux(t.base, chef)).toBe(1);
    await exigerAdminLocal(t.base);
    await exigerAdminLocal(t.base, { sauf: chef });
    await exigerAdminLocal(t.base, { sauf: externe });
    await exigerAdminLocal(t.base, { sauf: alice });
    await exigerAdminLocal(t.base, { sauf: modo });
  });

  describe("avec un seul administrateur local (chef) : le garde refuse chaque action qui le retirerait", () => {
    beforeAll(async () => {
      await t.base.run("UPDATE users SET is_admin=0 WHERE id=?", [chef2]);
    });
    afterAll(async () => {
      await t.base.run("UPDATE users SET is_admin=1 WHERE id=?", [chef2]);
    });

    it("l'administrateur sans mot de passe local, le modérateur et un compte simple ne comptent pas", async () => {
      expect(await compterAdminsLocaux(t.base)).toBe(1);
      expect(await refus(exigerAdminLocal(t.base, { sauf: chef }))).toBe(409);
      expect(await refus(exigerAdminLocal(t.base, { sauf: externe }))).toBe(0);
    });

    it("suspension : 409, aucun état posé, rien de propagé", async () => {
      suspensions.length = 0;
      const r = await POST(`/api/admin/users/${chef}/suspend`, externe);
      expect(r.statusCode).toBe(409);
      expect((await etat(chef)).suspendu).toBe(false);
      expect(
        await refus(
          suspendre(
            {
              base: t.base,
              maintenant: () => 1,
              publierSuspension: async () => undefined,
              journal: journalMuet,
            },
            chef,
            "directory:x",
          ),
        ),
      ).toBe(409);
      expect(suspensions).toEqual([]);
      expect((await POST(`/api/admin/users/${alice}/suspend`, externe)).statusCode).toBe(200);
      expect((await POST(`/api/admin/users/${externe}/suspend`, chef)).statusCode).toBe(200);
      await t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL WHERE id IN (?,?)", [
        alice,
        externe,
      ]);
    });

    it("changement de rôle : 409 et rôle gardé ; un autre rôle que celui du dernier admin passe", async () => {
      const r = await POST(`/api/admin/users/${chef}/role`, externe, { role: "user" });
      expect(r.statusCode).toBe(409);
      expect((await etat(chef)).admin).toBe(1);
      expect((await POST(`/api/admin/users/${chef}/role`, externe, { role: "moderator" })).statusCode).toBe(
        409,
      );
      expect((await POST(`/api/admin/users/${alice}/role`, externe, { role: "moderator" })).statusCode).toBe(
        200,
      );
      expect((await POST(`/api/admin/users/${alice}/role`, externe, { role: "user" })).statusCode).toBe(200);
      expect((await POST(`/api/admin/users/${externe}/role`, chef, { role: "user" })).statusCode).toBe(200);
      expect((await POST(`/api/admin/users/${externe}/role`, chef, { role: "admin" })).statusCode).toBe(200);
    });

    it("suppression : 409 et compte intact ; un autre compte se supprime", async () => {
      expect(await refus(deleteUserFull(t.base, chef))).toBe(409);
      expect((await etat(chef)).existe).toBe(true);
      const bob = await createUser(t.base, "bob", "mdp-bob-1");
      expect(await deleteUserFull(t.base, bob)).toBe(true);
      const ext2 = await createUser(t.base, "ext2", "mdp-ext2-1", { isAdmin: 1 });
      await t.base.run("UPDATE users SET pass_hash='!' WHERE id=?", [ext2]);
      expect(await deleteUserFull(t.base, ext2)).toBe(true);
    });
  });

  it("avec deux administrateurs locaux : retirer l'un passe, le second devient protégé", async () => {
    expect((await POST(`/api/admin/users/${chef}/role`, externe, { role: "user" })).statusCode).toBe(200);
    expect(await refus(deleteUserFull(t.base, chef2))).toBe(409);
    expect((await POST(`/api/admin/users/${chef2}/suspend`, externe)).statusCode).toBe(409);
    await t.base.run("UPDATE users SET is_admin=1 WHERE id=?", [chef]);
    expect((await POST(`/api/admin/users/${chef2}/suspend`, externe)).statusCode).toBe(200);
    expect((await POST(`/api/admin/users/${chef}/suspend`, externe)).statusCode).toBe(409);
    await t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL WHERE id=?", [chef2]);
    expect(await deleteUserFull(t.base, chef2)).toBe(true);
    expect(await refus(deleteUserFull(t.base, chef))).toBe(409);
  });

  it("compte sans mot de passe local : refusé par verifyUser quelle que soit la saisie, mot de passe jamais posé sauf détachement", async () => {
    expect(aMotDePasseLocal(await ligneUtilisateur(t.base, externe))).toBe(false);
    expect(aMotDePasseLocal(await ligneUtilisateur(t.base, alice))).toBe(true);
    for (const saisie of ["mdp-externe-1", "!", "", "x".repeat(200)])
      expect(await verifyUser(t.base, "externe", saisie)).toBeNull();
    expect(await verifyUser(t.base, "alice", "mdp-alice-1")).toBe(alice);
    expect(await refus(resetUserPassword(t.base, externe, "nouveau-mdp-1"))).toBe(
      "ErreurSansMotDePasseLocal",
    );
  });

  it("resetUserPassword : refus typé, rien écrit ; `detacher` pose un vrai mot de passe", async () => {
    const avant = await hash(externe);
    await expect(resetUserPassword(t.base, externe, "nouveau-mdp-1")).rejects.toBeInstanceOf(
      ErreurSansMotDePasseLocal,
    );
    expect(await hash(externe)).toBe(avant);
    expect(await resetUserPassword(t.base, 987_654, "x-mdp-123456")).toBe(false);
    const ligneAvant = await ligneUtilisateur(t.base, externe);
    expect(/^[0-9a-f]+$/u.test(String(ligneAvant?.pass_salt))).toBe(true);
    expect(await resetUserPassword(t.base, externe, "nouveau-mdp-1", { detacher: true })).toBe(true);
    expect(await verifyUser(t.base, "externe", "nouveau-mdp-1")).toBe(externe);
    await t.base.run("UPDATE users SET pass_hash='!' WHERE id=?", [externe]);
  });

  it("réinitialisation par l'administrateur : 409 sur un compte sans mot de passe local, hachage intact", async () => {
    const avant = await hash(externe);
    const r = await POST("/api/admin/reset-password", chef, {
      target_id: externe,
      new_password: "Nouveau-mdp-123",
    });
    expect([r.statusCode, await hash(externe)]).toEqual([409, avant]);
    const ok = await POST("/api/admin/reset-password", chef, {
      target_id: alice,
      new_password: "Nouveau-mdp-123",
    });
    expect(ok.statusCode).toBe(200);
  });
});
