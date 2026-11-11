// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-securite.test.ts — contrats de la console (sessions, HTTPS, écoute) rejoués contre le core TS réel en process admin. */
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

import { config, invalidateConfigCache } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";

beforeAll(async () => {
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
});

afterAll(async () => {
  await core.fermer();
});

/** Port libre puis refermé : rien n'y écoute, quel que soit l'hôte (Caddy présent ou non). */
function portFerme(): Promise<number> {
  return new Promise((resoudre) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resoudre(port));
    });
  });
}

describe("contrats REST : sécurité de la console (core réel)", () => {
  it("sessions : état, révocation d'un compte, fin de révocation, révocation globale", async () => {
    expect(await core.appeler("GET", "/api/admin/security/sessions", { cookie })).toMatchObject({
      revoked_user_count: 0,
    });
    expect(
      await core.appeler("POST", "/api/admin/security/sessions/revoke-user/2", { cookie }),
    ).toMatchObject({
      ok: true,
      user_id: 2,
      username: "lou",
    });
    await core.appeler("POST", "/api/admin/security/sessions/revoke-user/99", { cookie });
    expect(await core.appeler("GET", "/api/admin/security/sessions", { cookie })).toMatchObject({
      revoked_user_count: 1,
    });
    expect(
      await core.appeler("POST", "/api/admin/security/sessions/clear-user-revocation/2", { cookie }),
    ).toEqual({ ok: true, user_id: 2 });
    expect(await core.appeler("POST", "/api/admin/security/sessions/revoke-all", { cookie })).toMatchObject({
      ok: true,
    });
    await core.appeler("GET", "/api/admin/security/sessions");
  });

  it("HTTPS et écoute : état, activation refusée sans Caddy, corps invalides", async () => {
    const https = {
      main_port: await portFerme(),
      admin_port: await portFerme(),
      rag_port: await portFerme(),
    };
    writeFileSync(config.CONFIG_JSON_PATH, JSON.stringify({ security: { https } }));
    invalidateConfigCache();
    expect(await core.appeler("GET", "/api/admin/security/https", { cookie })).toMatchObject({
      enabled: false,
      caddy: { main: false },
    });
    await core.appeler("POST", "/api/admin/security/https", { cookie, corps: { enabled: true } });
    await core.appeler("POST", "/api/admin/security/listen", { cookie, corps: { listen: "autre" } });
    await core.appeler("POST", "/api/admin/security/https", { cookie, corps: { enabled: false } });
    await core.appeler("POST", "/api/admin/security/listen", { cookie, corps: { listen: "lan" } });
  });

  it("toutes les routes du domaine admin-securite ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-securite").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
