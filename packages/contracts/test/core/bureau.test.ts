// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/bureau.test.ts — contrats du Studio (machines, cible active, écrans) rejoués contre le core TS réel sans agent de bureau : les réponses d'un agent connecté sont vérifiées sur des exemples. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTRATS_REST,
  schemaErreurBureau,
  schemaReponseActionBureau,
  schemaReponseAttenteFenetreBureau,
  schemaReponseCaptureBureau,
  schemaReponseEcransBureau,
  schemaReponseExecutionBureau,
  schemaReponseLancementBureau,
  schemaReponseLectureBureau,
  schemaReponseLocaliserBureau,
} from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";

beforeAll(async () => {
  core = await demarrerCore();
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : Studio (core réel, aucun agent connecté)", () => {
  it("machines autorisées, cible active : choix, effacement, cible inconnue", async () => {
    expect(await core.appeler("GET", "/api/desktop/targets", { cookie })).toEqual({ targets: [], count: 0 });
    expect(await core.appeler("GET", "/api/desktop/active-target", { cookie })).toMatchObject({
      target: expect.anything(),
    });
    expect(
      await core.appeler("POST", "/api/desktop/active-target", { cookie, corps: { target: "" } }),
    ).toEqual({
      ok: true,
      target: "",
    });
    await core.appeler("POST", "/api/desktop/active-target", { cookie, corps: { target: "inconnue" } });
    await core.appeler("GET", "/api/desktop/targets");
    await core.appeler("GET", "/api/desktop/active-target");
  });

  it("écrans : refus sans agent, formes de réponse d'un agent connecté", async () => {
    const refus = await core.appeler("GET", "/api/desktop/monitors", { cookie });
    expect(
      schemaErreurBureau.safeParse(refus).success || (refus as { detail?: unknown }).detail !== undefined,
    ).toBe(true);
    await core.appeler("POST", "/api/desktop/select-monitor", { cookie, corps: { target: "x", monitor: 2 } });
    const ecrans = { ok: true, monitors: [{ index: 1, width: 1920, height: 1080 }], selected: 1 };
    expect(schemaReponseEcransBureau.parse(ecrans)).toEqual(ecrans);
    const erreur = { ok: false, error: "agent_offline", message: "Agent hors ligne" };
    expect(schemaErreurBureau.parse(erreur)).toEqual(erreur);
  });

  it("capture, lecture, action, lancement, attente, exécution : refus sans agent ou corps invalide", async () => {
    const m = "/api/desktop";
    await core.appeler("POST", `${m}/capture`, { cookie, corps: { target: "x" } });
    await core.appeler("POST", `${m}/read`, { cookie, corps: { target: "x", query: "q" } });
    await core.appeler("POST", `${m}/act`, { cookie, corps: {} });
    await core.appeler("POST", `${m}/act`, { cookie, corps: { op: "click", x: 1, y: 2 } });
    await core.appeler("POST", `${m}/launch`, { cookie, corps: {} });
    await core.appeler("POST", `${m}/launch`, { cookie, corps: { app: "calc" } });
    await core.appeler("POST", `${m}/wait-window`, { cookie, corps: {} });
    await core.appeler("POST", `${m}/wait-window`, { cookie, corps: { title_re: "x" } });
    await core.appeler("POST", `${m}/run-automation`, { cookie, corps: { code: "" } });
    await core.appeler("POST", `${m}/run-automation`, { cookie, corps: { code: "print(1)", target: "x" } });
    await core.appeler("GET", `${m}/run-automation/status`, { cookie });
    await core.appeler("GET", `${m}/run-automation/status?target=x&run_id=r1`, { cookie });
    await core.appeler("POST", `${m}/run-automation/stop`, { cookie, corps: { target: "x", run_id: "r1" } });
    await core.appeler("POST", `${m}/run-automation-matrix`, { cookie, corps: { code: "", targets: [] } });
    await core.appeler("POST", `${m}/locate`, { corps: { describe: "bouton", image_b64: "AAAA" } });
    await core.appeler("POST", `${m}/locate`, { cookie, corps: { describe: "" } });
  });

  it("formes de réponse d'un agent connecté (exemples tirés du code du core)", () => {
    const trame = {
      image_url: "/api/desktop/frame/t?t=1",
      img_w: 10,
      img_h: 20,
      target: "pc",
      sig: "s",
      ts: 1,
    };
    expect(() =>
      schemaReponseCaptureBureau.parse({
        ok: true,
        ...trame,
        boxes: [],
        note: null,
        tree_nodes: 0,
        tree_capped: false,
      }),
    ).not.toThrow();
    expect(() =>
      schemaReponseLectureBureau.parse({ ok: true, text: "a", region: null, box: null, chars: 1 }),
    ).not.toThrow();
    expect(() =>
      schemaReponseActionBureau.parse({ ok: true, op: "click", method: "uia", point: [1, 2], ...trame }),
    ).not.toThrow();
    expect(() =>
      schemaReponseActionBureau.parse({
        ok: true,
        warning: "type_no_effect",
        op: "type",
        method: null,
        ...trame,
      }),
    ).not.toThrow();
    expect(() =>
      schemaReponseLancementBureau.parse({
        ok: true,
        launched: "calc",
        found: true,
        title: "Calc",
        auto_id: "",
        interaction_state: "ready",
        ...trame,
      }),
    ).not.toThrow();
    expect(() =>
      schemaReponseAttenteFenetreBureau.parse({
        ok: true,
        found: true,
        interaction_state: "",
        title: "",
        auto_id: "",
      }),
    ).not.toThrow();
    expect(() =>
      schemaReponseExecutionBureau.parse({ ok: true, run_id: "r", target: "pc", name: "a", push_errors: [] }),
    ).not.toThrow();
    expect(() =>
      schemaReponseLocaliserBureau.parse({ ok: true, box: [1, 2, 3, 4], confidence: 0.9, label: "ok" }),
    ).not.toThrow();
  });

  it("toutes les routes du domaine bureau ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "bureau").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
