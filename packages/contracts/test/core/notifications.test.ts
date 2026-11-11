// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/notifications.test.ts — contrats du centre de notifications et des skins, rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNotification } from "../../../../apps/core/src/notifications/stockage";
import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let uid = 0;

beforeAll(async () => {
  core = await demarrerCore();
  uid = await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : notifications (core réel)", () => {
  it("liste, compteur, lu / non lu, suppression, tout lire, tout effacer", async () => {
    expect(await core.appeler("GET", "/api/notifications", { cookie })).toEqual({ items: [], unread: 0 });
    const a = await createNotification(core.base, uid, "routine", "Fin de routine", "ok", "routine", 3);
    const b = await createNotification(core.base, uid, "chat", "Réponse prête", "", "chat", "abc");
    await createNotification(core.base, uid, "info", "Sans référence");
    expect(await core.appeler("GET", "/api/notifications/unread-count", { cookie })).toEqual({ count: 3 });
    const liste = (await core.appeler("GET", "/api/notifications?limit=2", { cookie })) as {
      items: unknown[];
    };
    expect(liste.items).toHaveLength(2);
    await core.appeler("GET", `/api/notifications?before=${b}`, { cookie });
    expect(await core.appeler("PATCH", `/api/notifications/${a}/read`, { cookie })).toEqual({
      ok: true,
      unread: 2,
    });
    expect(await core.appeler("PATCH", `/api/notifications/${a}/unread`, { cookie })).toEqual({
      ok: true,
      unread: 3,
    });
    await core.appeler("PATCH", "/api/notifications/pas-un-nombre/read", { cookie });
    expect(await core.appeler("DELETE", `/api/notifications/${b}`, { cookie })).toEqual({
      ok: true,
      unread: 2,
    });
    expect(await core.appeler("POST", "/api/notifications/read-all", { cookie })).toEqual({
      ok: true,
      marked: 2,
      unread: 0,
    });
    expect(await core.appeler("POST", "/api/notifications/clear", { cookie })).toEqual({
      ok: true,
      cleared: 2,
      unread: 0,
    });
    await core.appeler("GET", "/api/notifications");
  });
});

describe("contrats REST : skins (core réel)", () => {
  it("skins activés, mascottes et défaut d'instance", async () => {
    expect(await core.appeler("GET", "/api/skins", { cookie })).toMatchObject({ default: "elpis" });
    await core.appeler("GET", "/api/skins");
  });

  it("habillages personnels : vérification, création, liste, suppression", async () => {
    const jetons = {
      "--app-bg": "#f1f5f9",
      "--surface": "#ffffff",
      "--text-900": "#0f172a",
      "--text-600": "#475569",
      "--border": "#e2e8f0",
      "--accent": "#2563eb",
      "--rail-bg": "#0f172a",
      "--rail-text": "#cbd5e1",
    };
    const corps = { id: "contrat", label: "Contrat", darkBase: true, tokens: { light: jetons } };
    expect(await core.appeler("POST", "/api/skins/perso/verifier", { cookie, corps })).toMatchObject({
      ok: true,
    });
    expect(await core.appeler("POST", "/api/skins/perso", { cookie, corps })).toMatchObject({ ok: true });
    expect(await core.appeler("GET", "/api/skins/perso", { cookie })).toMatchObject({
      skins: [{ id: "contrat" }],
    });
    await core.appeler("POST", "/api/skins/perso", { cookie, corps: { ...corps, tokens: {} } });
    expect(await core.appeler("DELETE", "/api/skins/perso/contrat", { cookie })).toEqual({ ok: true });
  });

  it("toutes les routes des domaines notifications et apparence ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter(
      (r) => r.domaine === "notifications" || r.domaine === "apparence",
    ).map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
