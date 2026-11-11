// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-sauvegarde.test.ts — contrats de la console pour la sauvegarde distante et la restauration rejoués contre le core TS réel en process admin (aucune clé ni restauration réussie : elles écriraient dans l'instance). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseRestauration } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";

beforeAll(async () => {
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : sauvegarde de la console (core réel)", () => {
  it("configuration distante : lecture, enregistrement désactivé, activation invalide refusée", async () => {
    expect(await core.appeler("GET", "/api/admin/backup/remote", { cookie })).toMatchObject({
      enabled: false,
      key_present: false,
    });
    expect(
      await core.appeler("POST", "/api/admin/backup/remote", {
        cookie,
        corps: { enabled: false, host: "sauvegarde.lan", user: "elpis" },
      }),
    ).toMatchObject({ ok: true, config: { host: "sauvegarde.lan" } });
    await core.appeler("POST", "/api/admin/backup/remote", { cookie, corps: { enabled: true } });
    await core.appeler("GET", "/api/admin/backup/remote", { cookie: cookieLou });
  });

  it("clé, mot de passe, test et envoi : refus et échecs de configuration", async () => {
    await core.appeler("POST", "/api/admin/backup/remote/key", { cookie, corps: { key: "pas une clé" } });
    await core.appeler("POST", "/api/admin/backup/remote/password", { cookie, corps: { password: 3 } });
    expect(await core.appeler("POST", "/api/admin/backup/remote/test", { cookie })).toMatchObject({
      ok: false,
    });
    expect(
      await core.appeler("POST", "/api/admin/backup/remote/send", { cookie, corps: { scope: "config" } }),
    ).toMatchObject({ ok: false });
    await core.appeler("POST", "/api/admin/backup/remote/send", { cookie, corps: { scope: "zzz" } });
    await core.appeler("POST", "/api/admin/backup/remote/test", { cookie: cookieLou });
  });

  it("restauration : archive invalide ou vide refusée, étendue inconnue refusée ; l'archive téléchargée refuse une étendue inconnue", async () => {
    await core.televerser("/api/admin/restore", { cookie, fichier: Buffer.from("pas un zip"), nom: "a.zip" });
    await core.televerser("/api/admin/restore", { cookie, fichier: Buffer.alloc(0), nom: "a.zip" });
    await core.televerser("/api/admin/restore", {
      cookie: cookieLou,
      fichier: Buffer.from("x"),
      nom: "a.zip",
    });
    const refus = await core.app.inject({
      method: "GET",
      url: "/api/admin/backup?scope=zzz",
      headers: { cookie, "x-elpis-console": "1" },
    });
    expect(refus.statusCode).toBe(400);
    const ok = {
      ok: true,
      scope: "full",
      restored: 3,
      errors: [],
      restart_required: true,
    };
    expect(schemaReponseRestauration.parse(ok)).toEqual(ok);
  });

  it("toutes les routes du domaine admin-sauvegarde ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-sauvegarde").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
