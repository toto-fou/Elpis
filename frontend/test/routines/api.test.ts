// SPDX-License-Identifier: MIT
/** frontend/test/routines/api.test.ts — lecture des routines et des runs : validation C2, réseau, refus. */
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { creerApiRoutines } from "../../src/features/routines/api";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const RUN = {
  id: 7,
  routine_id: 3,
  owner_user_id: 1,
  status: "running",
  trigger: "manuel",
  started_at: 1781000000,
  ended_at: null,
  duration_ms: null,
  input_tokens: null,
  output_tokens: null,
  summary: null,
  error: null,
  tool_limit_reached: 0,
  worker_boot_id: null,
  heartbeat_at: null,
  files: [],
};

function api(fetch: (u: string, i?: RequestInit) => Promise<Response>) {
  return creerApiRoutines(new ClientHttp(new GestionnaireSession(), fetch));
}

describe("api routines", () => {
  it("lit les runs d'une routine avec la limite demandée", async () => {
    const urls: string[] = [];
    const a = api((u) => {
      urls.push(u);
      return Promise.resolve(json({ items: [RUN] }));
    });
    const r = await a.runs(3, 50);
    expect(urls).toEqual(["/api/routines/3/runs?limit=50"]);
    expect(r).toEqual({ ok: true, items: [RUN] });
  });

  it("refuse une réponse hors contrat", async () => {
    const a = api(() => Promise.resolve(json({ items: [{ id: "x" }] })));
    expect(await a.lister()).toEqual({ ok: false, echec: "refuse" });
  });

  it("distingue l'erreur réseau et le refus HTTP", async () => {
    expect(await api(() => Promise.reject(new Error("coupé"))).lister()).toEqual({
      ok: false,
      echec: "reseau",
    });
    expect(await api(() => Promise.resolve(json({ detail: "non" }, 500))).lister()).toEqual({
      ok: false,
      echec: "refuse",
    });
  });
});

describe("api routines : écritures", () => {
  it("crée une routine (POST) et rend l'id validé", async () => {
    const appels: Array<[string, RequestInit | undefined]> = [];
    const a = api((u, i) => {
      appels.push([u, i]);
      return Promise.resolve(json({ id: 9, ok: true }));
    });
    const r = await a.enregistrer(null, { name: "x" });
    expect(r).toEqual({ ok: true, valeur: { id: 9 } });
    expect(appels[0]?.[0]).toBe("/api/routines");
    expect(appels[0]?.[1]?.method).toBe("POST");
    expect(appels[0]?.[1]?.body).toBe('{"name":"x"}');
  });

  it("modifie (PUT) et rend le détail du serveur en cas de refus", async () => {
    const a = api(() => Promise.resolve(json({ detail: "nom pris" }, 409)));
    expect(await a.enregistrer(4, { name: "x" })).toEqual({ ok: false, echec: "refuse", detail: "nom pris" });
  });

  it("classe l'erreur réseau", async () => {
    const a = api(() => Promise.reject(new Error("coupé")));
    expect(await a.supprimer(1)).toEqual({ ok: false, echec: "reseau", detail: null });
  });

  it("valide lancement, arrêt et webhook", async () => {
    const urls: string[] = [];
    const a = api((u) => {
      urls.push(u);
      if (u.endsWith("run-now")) return Promise.resolve(json({ ok: false, skipped: true, reason: "plein" }));
      if (u.endsWith("/stop")) return Promise.resolve(json({ ok: true, stopping: true }));
      if (u.endsWith("rotate")) return Promise.resolve(json({ ok: true, secret: "s", path: "/p" }));
      if (u.endsWith("disable")) return Promise.resolve(json({ ok: true, webhook_enabled: false }));
      return Promise.resolve(json({ ok: true, webhook_filter: { events: [], branch: "", repo: "" } }));
    });
    expect(await a.lancer(1)).toEqual({ ok: true, valeur: { ok: false, skipped: true, reason: "plein" } });
    expect((await a.arreter(1, 7)).ok).toBe(true);
    expect(await a.tournerWebhook(1)).toEqual({ ok: true, valeur: { ok: true, secret: "s", path: "/p" } });
    expect((await a.couperWebhook(1)).ok).toBe(true);
    expect((await a.filtrerWebhook(1, { events: [], branch: "", repo: "" })).ok).toBe(true);
    expect(urls).toContain("/api/routines/1/runs/7/stop");
  });

  it("refuse une activation hors contrat", async () => {
    const a = api(() => Promise.resolve(json({ ok: true })));
    expect((await a.basculer(1, true)).ok).toBe(false);
  });
});
