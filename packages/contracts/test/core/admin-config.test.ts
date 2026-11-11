// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-config.test.ts — contrats de la console (configuration d'instance, compression, vue d'ensemble, journaux) rejoués contre le core TS réel en process admin. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTRATS_REST,
  schemaConflitConfig,
  schemaReponseVueEnsemble,
  schemaRefusPossedeConfig,
} from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieModerateur = "";
let cookieLou = "";

beforeAll(async () => {
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "max", "mdp-de-max-1", 2);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieModerateur = await core.connecter("max", "mdp-de-max-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : configuration d'instance (console, core réel)", () => {
  it("compression : lecture, écriture bornée, refus à un compte ordinaire", async () => {
    expect(
      await core.appeler("GET", "/api/admin/compression-config", { cookie: cookieModerateur }),
    ).toMatchObject({
      enabled: true,
    });
    expect(
      await core.appeler("POST", "/api/admin/compression-config", {
        cookie,
        corps: { keep_recent_turns: 4, endpoint_url: "http://moteur.lan:9000" },
      }),
    ).toMatchObject({ keep_recent_turns: 4, endpoint_url: "http://moteur.lan:9000/v1/chat/completions" });
    await core.appeler("POST", "/api/admin/compression-config", { cookie: cookieModerateur, corps: {} });
    await core.appeler("GET", "/api/admin/compression-config", { cookie: cookieLou });
    await core.appeler("GET", "/api/admin/compression-config");
  });

  it("fichier config.json : lecture, écriture, JSON invalide, type inconnu", async () => {
    await core.appeler("GET", "/api/admin/config-file?type=main", { cookie });
    expect(
      await core.appeler("POST", "/api/admin/config-file", {
        cookie,
        corps: { type: "main", content: '{"app": {"x": 1}}' },
      }),
    ).toEqual({ ok: true });
    expect(await core.appeler("GET", "/api/admin/config-file?type=main", { cookie })).toMatchObject({
      content: expect.stringContaining('"x": 1'),
    });
    await core.appeler("POST", "/api/admin/config-file", { cookie, corps: { type: "main", content: "{" } });
    await core.appeler("POST", "/api/admin/config-file", { cookie, corps: { type: "main", content: "[]" } });
    await core.appeler("GET", "/api/admin/config-file?type=autre", { cookie });
    await core.appeler("GET", "/api/admin/config-file?type=main", { cookie: cookieModerateur });
  });

  it("modification par chemin : application, conflit de départ, forçage, réglage possédé par un autre écran", async () => {
    expect(
      await core.appeler("PATCH", "/api/admin/config", {
        cookie,
        corps: { changes: [{ path: "app.x", from: 1, to: 2 }] },
      }),
    ).toEqual({ ok: true, applied: 1 });
    const conflit = await core.appeler("PATCH", "/api/admin/config", {
      cookie,
      corps: { changes: [{ path: "app.x", from: 1, to: 3 }] },
    });
    expect(schemaConflitConfig.parse(conflit).conflicts).toMatchObject([{ path: "app.x", current: 2 }]);
    expect(
      await core.appeler("PATCH", "/api/admin/config", {
        cookie,
        corps: { changes: [{ path: "app.x", from: 1, to: 3 }], force: true },
      }),
    ).toEqual({ ok: true, applied: 1 });
    expect(
      await core.appeler("PATCH", "/api/admin/config", {
        cookie,
        corps: {
          changes: [
            { path: "app.y", delete: true },
            { path: "app.z", from_absent: true, to: [1] },
          ],
        },
      }),
    ).toEqual({ ok: true, applied: 2 });
    const possede = await core.appeler("PATCH", "/api/admin/config", {
      cookie,
      corps: { changes: [{ path: "security.listen.port", to: 80 }] },
    });
    expect(schemaRefusPossedeConfig.parse(possede).paths).toEqual(["security.listen.port"]);
    await core.appeler("PATCH", "/api/admin/config", { cookie, corps: { changes: [] } });
    await core.appeler("PATCH", "/api/admin/config", {
      cookie,
      corps: { changes: [{ path: "a b", to: 1 }] },
    });
    await core.appeler("PATCH", "/api/admin/config", { cookie: cookieModerateur, corps: { changes: [] } });
  });
});

describe("contrats REST : vue d'ensemble de la console (core réel)", () => {
  it("vue d'ensemble complète pour l'administrateur, actions masquées au modérateur", async () => {
    const admin = schemaReponseVueEnsemble.parse(
      await core.appeler("GET", "/api/admin/overview?refresh=1", { cookie }),
    );
    expect(admin.role).toBe("admin");
    expect(admin.alerts.some((a) => a.action !== "")).toBe(true);
    const moderateur = schemaReponseVueEnsemble.parse(
      await core.appeler("GET", "/api/admin/overview", { cookie: cookieModerateur }),
    );
    expect(moderateur).toMatchObject({ role: "moderator" });
    expect(moderateur.alerts.every((a) => a.action === "")).toBe(true);
    await core.appeler("GET", "/api/admin/overview", { cookie: cookieLou });
  });

  it("redémarrage en attente, journaux récents filtrés, terminaux", async () => {
    expect(await core.appeler("GET", "/api/admin/restart-status", { cookie })).toMatchObject({ pending: [] });
    await core.appeler("GET", "/api/admin/restart-status", { cookie: cookieModerateur });
    expect(
      await core.appeler("GET", "/api/admin/logs/recent?limit=3&levels=INFO,WARNING&since_ts=1", {
        cookie: cookieModerateur,
      }),
    ).toMatchObject({ filters_applied: { limit: 3, levels: ["INFO", "WARNING"], since_ts: 1 } });
    await core.appeler("GET", "/api/admin/logs/recent?limit=pas-un-nombre", { cookie });
    expect(await core.appeler("GET", "/api/admin/terminal/stats", { cookie })).toMatchObject({
      count: 0,
      sessions: [],
    });
    await core.appeler("GET", "/api/admin/terminal/stats", { cookie: cookieModerateur });
  });

  it("toutes les routes des domaines admin-config et admin-vue ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter(
      (r) => r.domaine === "admin-config" || r.domaine === "admin-vue",
    ).map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
