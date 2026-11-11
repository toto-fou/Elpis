// SPDX-License-Identifier: MIT
/** frontend/test/admin/executions.test.ts — console › Exécutions : requêtes filtrées, dernière demande gagnante, formats de tokens et de durée. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdminRuns } from "../../src/features/admin/executions";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const COMPTE = {
  user_id: 3,
  username: "alice",
  runs: 2,
  failed: 1,
  subagents: 0,
  input_tokens: 14000,
  output_tokens: 1400,
  thinking_tokens: 900,
  cache_read_tokens: 12600,
  cache_creation_tokens: 0,
  tool_tokens: 0,
  llm_ms: 1,
  prefill_ms: 1,
  decode_ms: 1,
  wait_ms: 0,
  tool_calls: 2,
  tool_errors: 1,
  files_changed: 1,
  sandbox_cpu_peak: null,
  sandbox_mem_peak_mb: null,
  last_at: 1781000100,
};
const LIGNE = {
  id: "chat-a1",
  kind: "chat",
  user_id: 3,
  chat_id: "",
  routine_id: null,
  model: "",
  engine: "",
  started_at: 1,
  ended_at: 2,
  status: "ok",
  error_kind: "",
  input_tokens: 1000,
  output_tokens: 100,
  cache_read_tokens: 960,
  thinking_tokens: 50,
  tool_tokens: 0,
  llm_calls: 1,
  prefill_ms: 0,
  decode_ms: 0,
  wait_ms: 0,
  tool_calls: 0,
  tool_errors: 0,
  files_changed: 0,
  sandbox_cpu_peak: null,
  sandbox_mem_peak_mb: null,
  username: "alice",
};

function monter() {
  const vus: string[] = [];
  const fetch = (u: string): Promise<Response> => {
    vus.push(u);
    return Promise.resolve(
      u.startsWith("/api/admin/runs/accounts")
        ? json({ hours: 24, items: [COMPTE] })
        : json({ items: [LIGNE], total: u.includes("count=0") ? null : 120, offset: 0, limit: 50 }),
    );
  };
  return { R: setupAdminRuns(new ClientHttp(new GestionnaireSession(), fetch)), vus };
}

afterEach(() => vi.useRealTimers());

describe("setupAdminRuns", () => {
  it("charge comptes et liste ; le filtre par compte passe dans la requête et se retire au second clic", async () => {
    const { R, vus } = monter();
    await R.loadAdminRuns();
    expect(R.admRunsAccounts.value).toHaveLength(1);
    expect(vus).toContain("/api/admin/runs?hours=24&limit=50&offset=0");
    R.toggleAdmRunsAccount(R.admRunsAccounts.value[0]!);
    await new Promise((r) => setTimeout(r, 0));
    expect(R.admRunsFilter.value).toMatchObject({ userId: 3, username: "alice" });
    expect(vus.at(-1)).toBe("/api/admin/runs?hours=24&limit=50&offset=0&user_id=3");
    R.toggleAdmRunsAccount(R.admRunsAccounts.value[0]!);
    expect(R.admRunsFilter.value.userId).toBeNull();
  });

  it("période bornée à 24 h, 7 j ou 30 j", () => {
    const { R } = monter();
    R.setAdmRunsScope(168);
    expect(R.admRunsScope.value).toBe(168);
    R.setAdmRunsScope(5);
    expect(R.admRunsScope.value).toBe(24);
  });

  it("formats : entrée avec part de cache, sortie avec réflexion, durées", () => {
    const { R } = monter();
    expect(R.admRunsIn(LIGNE)).toBe("1 k · 96 % cache");
    expect(R.admRunsOut(LIGNE)).toBe("100 · 50 réflexion");
    expect(R.admRunsDuration(450)).toBe("450 ms");
    expect(R.admRunsDuration(1500)).toBe("1,5 s");
    expect(R.admRunsDuration(125000)).toBe("2 min 5 s");
    expect(R.admRunsDuration(3660000)).toBe("1 h 1 min");
  });

  it("pagination : total du serveur, décalage de 50 par page, retour page 1 quand un filtre change", async () => {
    const { R, vus } = monter();
    await R.loadAdminRuns();
    expect(R.admRunsTotal.value).toBe(120);
    R.setAdmRunsPage(3);
    await new Promise((r) => setTimeout(r, 0));
    expect(vus.at(-1)).toContain("limit=50&offset=100");
    R.setAdmRunsPage(9);
    expect(R.admRunsPage.value).toBe(3);
    R.setAdmRunsFilter({ status: "error" });
    expect(R.admRunsPage.value).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(vus.at(-1)).toContain("offset=0&status=error");
  });

  it("page et tri redemandent la liste sans total (count=0) et gardent le total courant ; un filtre le redemande", async () => {
    const { R, vus } = monter();
    await R.loadAdminRuns();
    expect(vus.filter((u) => u.includes("count=0"))).toHaveLength(0);
    R.setAdmRunsPage(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(vus.at(-1)).toContain("offset=50&count=0");
    expect(R.admRunsTotal.value).toBe(120);
    R.trierExecutions("input_tokens");
    await new Promise((r) => setTimeout(r, 0));
    expect(vus.at(-1)).toContain("count=0");
    expect(R.admRunsTotal.value).toBe(120);
    R.setAdmRunsFilter({ status: "error" });
    await new Promise((r) => setTimeout(r, 0));
    expect(vus.at(-1)).not.toContain("count=0");
  });

  it("total périmé : un tri ou une page lancés avant la réponse du total le redemandent", async () => {
    const { R, vus } = monter();
    void R.loadAdminRuns();
    R.trierExecutions("input_tokens");
    expect(vus.at(-1)).not.toContain("count=0");
    await new Promise((r) => setTimeout(r, 0));
    expect(R.admRunsTotal.value).toBe(120);
    R.setAdmRunsFilter({ status: "error" });
    R.setAdmRunsPage(1);
    expect(vus.at(-1)).not.toContain("count=0");
    await new Promise((r) => setTimeout(r, 0));
    R.trierExecutions("input_tokens");
    expect(vus.at(-1)).toContain("count=0");
  });

  it("Actualiser (frais) demande fresh=1 pour les comptes ; l'entrée sur l'onglet et la période non", async () => {
    const { R, vus } = monter();
    await R.loadAdminRuns();
    expect(vus.find((u) => u.startsWith("/api/admin/runs/accounts"))).toBe(
      "/api/admin/runs/accounts?hours=24",
    );
    await R.loadAdminRuns(true);
    expect(vus.filter((u) => u.startsWith("/api/admin/runs/accounts")).at(-1)).toBe(
      "/api/admin/runs/accounts?hours=24&fresh=1",
    );
    R.setAdmRunsScope(168);
    await new Promise((r) => setTimeout(r, 0));
    expect(vus.filter((u) => u.startsWith("/api/admin/runs/accounts")).at(-1)).toBe(
      "/api/admin/runs/accounts?hours=168",
    );
  });

  it("recherche : paramètre q encodé, lancé après 300 ms sans frappe, page 1", async () => {
    vi.useFakeTimers();
    const { R, vus } = monter();
    await R.loadAdminRuns();
    R.setAdmRunsPage(2);
    await vi.advanceTimersByTimeAsync(0);
    const avant = vus.length;
    R.rechercherExecutions("a");
    R.rechercherExecutions("100% _x");
    await vi.advanceTimersByTimeAsync(299);
    expect(vus.length).toBe(avant);
    await vi.advanceTimersByTimeAsync(2);
    expect(vus.at(-1)).toContain("offset=0&q=100%25%20_x");
    expect(R.admRunsPage.value).toBe(1);
    R.effacerFiltresExecutions();
    await vi.advanceTimersByTimeAsync(0);
    expect(vus.at(-1)).not.toContain("q=");
  });

  it("tri : sens inversé au second clic, nouvelle colonne en ordre naturel, paramètres absents au tri par défaut", async () => {
    const { R, vus } = monter();
    await R.loadAdminRuns();
    expect(vus.at(-1)).not.toContain("sort=");
    R.trierExecutions("started_at");
    await new Promise((r) => setTimeout(r, 0));
    expect(vus.at(-1)).toContain("sort=started_at&dir=asc");
    R.trierExecutions("username");
    expect(R.admRunsTri.value).toEqual({ col: "username", dir: "asc" });
    R.trierExecutions("input_tokens");
    expect(R.admRunsTri.value).toEqual({ col: "input_tokens", dir: "desc" });
    await new Promise((r) => setTimeout(r, 0));
    expect(vus.at(-1)).toContain("sort=input_tokens&dir=desc");
  });

  it("montrerExecution : filtre exact sur le run_id, autres filtres retirés, run surligné", () => {
    const { R } = monter();
    R.setAdmRunsFilter({ status: "error", q: "x" });
    R.montrerExecution("subagent-ab12");
    expect(R.admRunsFilter.value).toEqual({
      userId: null,
      username: "",
      kind: "",
      status: "",
      q: "",
      runId: "subagent-ab12",
    });
    expect(R.admRunsSurligne.value).toBe("subagent-ab12");
  });

  it("requêtes par action : comptes et liste à l'entrée, liste seule pour page, tri, filtre et recherche", async () => {
    vi.useFakeTimers();
    const { R, vus } = monter();
    const comptes = (): number => vus.filter((u) => u.startsWith("/api/admin/runs/accounts")).length;
    const liste = (): number => vus.filter((u) => u.startsWith("/api/admin/runs?")).length;
    await R.loadAdminRuns();
    expect([comptes(), liste()]).toEqual([1, 1]);
    R.setAdmRunsPage(2);
    R.trierExecutions("username");
    R.setAdmRunsFilter({ status: "ok" });
    R.rechercherExecutions("al");
    await vi.advanceTimersByTimeAsync(400);
    expect(comptes()).toBe(1);
    expect(liste()).toBe(5);
    R.setAdmRunsScope(168);
    await vi.advanceTimersByTimeAsync(0);
    expect([comptes(), liste()]).toEqual([2, 6]);
  });

  it("page devenue vide : retour à la dernière page existante", async () => {
    const vus: string[] = [];
    const fetch = (u: string): Promise<Response> => {
      vus.push(u);
      if (u.startsWith("/api/admin/runs/accounts")) return Promise.resolve(json({ hours: 24, items: [] }));
      const vide = u.includes("offset=100");
      return Promise.resolve(
        json({ items: vide ? [] : [LIGNE], total: 60, offset: vide ? 100 : 50, limit: 50 }),
      );
    };
    const R = setupAdminRuns(new ClientHttp(new GestionnaireSession(), fetch));
    R.admRunsPage.value = 3;
    await R.loadListeExecutions();
    expect(R.admRunsPage.value).toBe(2);
    expect(vus.at(-1)).toContain("offset=50");
  });
});
