// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/catalogue-comptes-admin.test.ts — journal de sécurité des comptes, groupes et clients OAuth de la console. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { oublierOccupations } from "../../src/admin/bac";
import type { PortBac } from "../../src/admin/bac";
import { creerFamilleAdminComptes } from "../../src/familles/admin-comptes";
import { appTest, journalMuet } from "../aides";
import { journalDeTest } from "./aides-journal";
import type { JournalDeTest } from "./aides-journal";

const port: PortBac = {
  async supprimerSurHote() {
    return null;
  },
  async retirerConteneur() {},
  async purgerTravail() {},
  async detruireConteneur() {},
};

describe("journal de sécurité : comptes et groupes de la console", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let j: JournalDeTest;
  let dossier: string;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "root", "mdp-root", { isAdmin: 1 });
    dossier = mkdtempSync(join(tmpdir(), "elpis-cat-comptes-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json"), SANDBOX_DIR: dossier });
    invalidateConfigCache();
    oublierOccupations();
    j = journalDeTest("admin");
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminComptes({
          base: t.base,
          auth: dependancesParDefaut(t.base),
          journal: journalMuet,
          revoquer: async () => null,
          bac: port,
        }),
      ],
      gardes: {
        admin: async (req) => {
          const ligne = await ligneUtilisateur(t.base, 1);
          req.utilisateur = { id: 1, username: ligne ? String(ligne.username) : null };
          if (req.headers["x-uid"] !== "1") throw new HttpError(401, "not logged in");
        },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    restaurer?.();
    invalidateConfigCache();
    j?.fermer();
    await t?.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const appeler = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({ method, url, headers: { "x-uid": "1" }, ...(payload === undefined ? {} : { payload }) });

  it("création, rôle, mot de passe, groupes et suppression d'un compte", async () => {
    const cree = await appeler("POST", "/api/admin/users/new", {
      username: "zoe",
      password: "Secret-Zoe-1",
      role: "moderator",
    });
    expect(cree.statusCode).toBe(200);
    const zoe = Number((await ligneUtilisateur(t.base, 2))?.id);
    expect(j.derniere("admin.user.create")).toMatchObject({
      outcome: "success",
      user_id: 1,
      username: "root",
      details: { target_user_id: zoe, target_username: "zoe", role: "moderator" },
    });
    expect(j.derniere("admin.user.create").ip).not.toBeNull();

    await appeler("POST", `/api/admin/users/${zoe}/role`, { role: "admin" });
    expect(j.derniere("admin.user.role").details).toEqual({
      target_user_id: zoe,
      before: "moderator",
      after: "admin",
    });

    await appeler("POST", "/api/admin/reset-password", { target_id: zoe, new_password: "Secret-Reset-2" });
    expect(j.derniere("admin.user.password_reset").details).toEqual({
      target_user_id: zoe,
      must_change: true,
    });
    const reinitialisations = j.de("admin.user.password_reset").length;
    const absent = await appeler("POST", "/api/admin/reset-password", {
      target_id: 999,
      new_password: "Secret-Reset-3",
    });
    // Compte inexistant : `ok` comme le Python, mais aucune ligne de succès.
    expect(absent.json()).toEqual({ ok: true });
    expect(j.de("admin.user.password_reset")).toHaveLength(reinitialisations);

    const groupe = (
      await appeler("POST", "/api/admin/groups", { name: "equipe", description: "d" })
    ).json() as {
      id: number;
    };
    expect(j.derniere("admin.group.create").details).toEqual({ group_id: groupe.id, group_name: "equipe" });
    await appeler("PUT", `/api/admin/groups/${groupe.id}`, { name: "equipe2", description: "d" });
    expect(j.derniere("admin.group.update").details).toEqual({
      group_id: groupe.id,
      before: { name: "equipe" },
      after: { name: "equipe2" },
    });
    await appeler("PUT", `/api/admin/users/${zoe}/groups`, { group_ids: [groupe.id] });
    expect(j.derniere("admin.user.groups").details).toEqual({
      target_user_id: zoe,
      before: [],
      after: [groupe.id],
    });
    await appeler("DELETE", `/api/admin/groups/${groupe.id}`);
    expect(j.derniere("admin.group.delete").details).toEqual({ group_id: groupe.id, group_name: "equipe2" });

    await appeler("DELETE", `/api/admin/users/${zoe}`);
    expect(j.derniere("admin.user.delete").details).toEqual({ target_user_id: zoe, target_username: "zoe" });

    await t.base.run(
      "INSERT INTO oauth_clients(client_id, kind, name, secret_hash, auth_method, redirect_uris, metadata, created_at) VALUES(?,?,?,?,?,?,?,?)",
      ["elpis-test", "dcr", "Client", "", "none", "[]", "{}", 0],
    );
    await appeler("DELETE", "/api/admin/oauth/clients?client_id=elpis-test");
    expect(j.derniere("admin.oauth_client.delete").details).toEqual({ client_id: "elpis-test" });

    const brut = j.brut();
    for (const secret of ["Secret-Zoe-1", "Secret-Reset-2", "mdp-root"]) expect(brut).not.toContain(secret);
  });
});
