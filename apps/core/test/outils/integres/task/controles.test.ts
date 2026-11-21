// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/controles.test.ts — appels du harnais de `task` à l'hôte d'outils : branche relue par un seul `git_query(action="branches")`, en lecture seule, `null` sur toute panne ; navigateur des sous-agents (fix du quota, sessions orphelines fermées au démarrage). */
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Hotes from "../../../../src/relais/hotes";
import type { SandboxHost } from "../../../../src/relais/hotes";
import type { Dict } from "../../../../src/python";

const etat = vi.hoisted(() => ({
  appels: [] as { nom: string; args: unknown; categories: unknown }[],
  outils: ["git_query"] as string[],
  reponse: "" as string | Error,
  hotes: new Map<string, Dict>(),
  envois: [] as { hote: string; uid: number; username: string; chemin: string; json: unknown }[],
  repHote: (_h: string): unknown => ({ cleaned: 2 }),
}));

vi.mock("../../../../src/relais/hotes", async (orig) => {
  const vrai = await orig<typeof Hotes>();
  return {
    ...vrai,
    lireHotes: () => ({ hotes: etat.hotes, placement: {} }),
    sandboxHostFor: async () => {
      const [id, spec] = [...etat.hotes][0] ?? [];
      return id === undefined || spec === undefined ? null : vrai.hostFromSpec(id, spec);
    },
  };
});
vi.mock("../../../../src/admin/pilote-bac", async (orig) => ({
  ...(await orig<object>()),
  appelerHote: async (
    h: SandboxHost,
    uid: number,
    username: string,
    _m: string,
    chemin: string,
    o: { json: unknown },
  ) => {
    etat.envois.push({ hote: h.id, uid, username, chemin, json: o.json });
    const r = etat.repHote(h.id);
    if (r instanceof Error) throw r;
    return r;
  },
}));

vi.mock("../../../../src/outils/catalogue", async (orig) => ({
  ...(await orig<object>()),
  collectMcpTools: async (configs: Dict[]) => ({
    toolCfgMap: new Map(etat.outils.map((n) => [n, { categories: configs[0]?.["filter_categories"] }])),
  }),
}));
vi.mock("../../../../src/outils/mcp/clients", async (orig) => ({
  ...(await orig<object>()),
  executerOutilMcp: async (carte: Map<string, Dict>, nom: string, args: unknown) => {
    etat.appels.push({ nom, args, categories: carte.get(nom)?.["categories"] });
    if (etat.reponse instanceof Error) throw etat.reponse;
    return etat.reponse;
  },
}));

const { fermerNavigateursEnfantsOrphelins, hoteTacheParDefaut } =
  await import("../../../../src/outils/integres/task/controles");

const COMPTE = { username: "alice", userId: 3, chatId: "c1" };

afterEach(() => {
  etat.appels = [];
  etat.outils = ["git_query"];
  etat.reponse = "";
});

describe("branche relue en fin de run (N2)", () => {
  it("un seul git_query(action=branches) sur le dépôt, branche marquée * rendue", async () => {
    etat.reponse = JSON.stringify({ ok: true, stdout: "  main 1a2b x\n* agent/add-g 3c4d y\n" });
    expect(await hoteTacheParDefaut.brancheCourante({ ...COMPTE, repo: "hp-repo" })).toBe("agent/add-g");
    expect(etat.appels).toEqual([
      { nom: "git_query", args: { action: "branches", repo: "hp-repo" }, categories: ["git"] },
    ]);
  });

  it("échec de git, outil absent, réponse illisible ou HEAD détachée : null", async () => {
    etat.reponse = JSON.stringify({ ok: false, error: "not a git repository" });
    expect(await hoteTacheParDefaut.brancheCourante({ ...COMPTE, repo: "x" })).toBeNull();
    etat.reponse = "pas du json";
    expect(await hoteTacheParDefaut.brancheCourante({ ...COMPTE, repo: "x" })).toBeNull();
    etat.reponse = JSON.stringify({ ok: true, stdout: "* (HEAD detached at 3c4d) 3c4d y\n" });
    expect(await hoteTacheParDefaut.brancheCourante({ ...COMPTE, repo: "x" })).toBeNull();
    etat.outils = [];
    expect(await hoteTacheParDefaut.brancheCourante({ ...COMPTE, repo: "x" })).toBeNull();
  });
});

describe("navigateur des sous-agents", () => {
  it("groupe plein : le fix préfère stop d'une session précise et réserve cleanup au cas où aucun enfant ne tourne dans aucune conversation", async () => {
    etat.outils = ["pw_session"];
    etat.reponse = JSON.stringify({ ok: true, child_slots_left: 0, max_sessions_per_group: 4 });
    const r = await hoteTacheParDefaut.santeNavigateur({ ...COMPTE, isolee: true });
    expect(etat.appels).toEqual([{ nom: "pw_session", args: { action: "health" }, categories: ["browser"] }]);
    expect(r).toMatchObject({ raison: expect.stringContaining("(4 sessions, sub-agents included)") });
    const fix = (r as { fix: string }).fix;
    expect(fix).toContain(
      "If you hold several browser sessions of your own, pw_session(action='stop', session_id=...) closes one you no longer need.",
    );
    expect(fix).toContain(
      "pw_session(action='cleanup') also closes the browsers of this account's sub-agents in every conversation: use it only when no browser sub-agent is running in any conversation of this account",
    );
    expect(fix.indexOf("action='stop'")).toBeLessThan(fix.indexOf("action='cleanup'"));
  });

  it("démarrage : un nettoyage par compte, quatre comptes à la fois, âge relu avant chaque lot, nombres additionnés ; panne, réponse sans nombre ou liste illisible : 0", async () => {
    const corps: unknown[] = [];
    const comptes = async () => [1, 2, 3, 4, 5].map((id) => ({ id, username: `c${id}` }));
    const n = await fermerNavigateursEnfantsOrphelins({
      ageMs: () => 4200,
      comptes,
      poster: async (c, x) => (corps.push([c.username, x]), { cleaned: c.id === 1 ? 3 : 1 }),
    });
    expect(n).toBe(7);
    expect(corps).toEqual([1, 2, 3, 4, 5].map((id) => [`c${id}`, { older_than_ms: 4200 }]));
    let horloge = 100;
    const vus: number[] = [];
    await fermerNavigateursEnfantsOrphelins({
      ageMs: () => (horloge += 50),
      comptes,
      poster: async (_c, x) => void vus.push(x["older_than_ms"] as number),
    });
    expect(vus).toEqual([150, 150, 150, 150, 200]);
    expect(await fermerNavigateursEnfantsOrphelins({ comptes, poster: async () => null })).toBe(0);
    expect(await fermerNavigateursEnfantsOrphelins({ comptes, poster: async () => ({ error: "x" }) })).toBe(
      0,
    );
    const illisible = async (): Promise<never> => Promise.reject(new Error("base"));
    expect(await fermerNavigateursEnfantsOrphelins({ comptes: illisible })).toBe(0);
    expect(await fermerNavigateursEnfantsOrphelins({})).toBe(0);
  });

  it("démarrage : POST /api/internal/browser/cleanup-children à l'hôte du bac de chaque compte, enveloppe à l'identité du compte (jamais uid 0) ; hôte sans jeton ignoré, hôte muet : 0 sans lever", async () => {
    etat.hotes = new Map<string, Dict>([["local", { url: "http://127.0.0.1:1/", token: "j1" }]]);
    etat.envois = [];
    const comptes = async () => [{ id: 3, username: "alice" }];
    expect(await fermerNavigateursEnfantsOrphelins({ ageMs: () => 7, comptes })).toBe(2);
    expect(etat.envois).toEqual([
      {
        hote: "local",
        uid: 3,
        username: "alice",
        chemin: "/api/internal/browser/cleanup-children",
        json: { older_than_ms: 7 },
      },
    ]);
    etat.repHote = () => new Error("hors ligne");
    expect(await fermerNavigateursEnfantsOrphelins({ ageMs: () => 7, comptes })).toBe(0);
    etat.hotes = new Map<string, Dict>([["sans", { url: "http://127.0.0.1:2/" }]]);
    etat.envois = [];
    expect(await fermerNavigateursEnfantsOrphelins({ ageMs: () => 7, comptes })).toBe(0);
    expect(etat.envois).toEqual([]);
  });
});
