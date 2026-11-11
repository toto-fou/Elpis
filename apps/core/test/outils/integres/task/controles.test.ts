// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/controles.test.ts — appels du harnais de `task` à l'hôte d'outils : branche relue par un seul `git_query(action="branches")`, en lecture seule, `null` sur toute panne ; navigateur des sous-agents (fix du quota, sessions orphelines fermées au démarrage). */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Dict } from "../../../../src/python";

const etat = vi.hoisted(() => ({
  appels: [] as { nom: string; args: unknown; categories: unknown }[],
  outils: ["git_query"] as string[],
  reponse: "" as string | Error,
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

  it("démarrage : un seul POST /cleanup_children sans propriétaire, quel que soit le nombre de comptes ; service absent : 0", async () => {
    const corps: unknown[] = [];
    const n = await fermerNavigateursEnfantsOrphelins({
      ageMs: () => 4200,
      poster: async (c) => (corps.push(c), { cleaned: 3 }),
    });
    expect(n).toBe(3);
    expect(corps).toEqual([{ older_than_ms: 4200 }]);
    expect(await fermerNavigateursEnfantsOrphelins({ poster: async () => null })).toBe(0);
    expect(await fermerNavigateursEnfantsOrphelins({ poster: async () => ({ error: "x" }) })).toBe(0);
  });

  it("démarrage : la requête part sans propriétaire vers PLAYWRIGHT_API_URL ; service injoignable : 0 sans lever", async () => {
    const recus: { url: string; corps: unknown }[] = [];
    const serveur = createServer((req, res) => {
      let texte = "";
      req.on("data", (b: Buffer) => (texte += b.toString()));
      req.on("end", () => {
        recus.push({ url: `${req.method} ${req.url}`, corps: JSON.parse(texte) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ cleaned: 2 }));
      });
    });
    await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
    const avant = process.env["PLAYWRIGHT_API_URL"];
    try {
      process.env["PLAYWRIGHT_API_URL"] = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
      expect(await fermerNavigateursEnfantsOrphelins({ ageMs: () => 7 })).toBe(2);
      expect(recus).toEqual([{ url: "POST /cleanup_children", corps: { older_than_ms: 7 } }]);
      serveur.closeAllConnections();
      await new Promise<void>((ok) => serveur.close(() => ok()));
      expect(await fermerNavigateursEnfantsOrphelins({ ageMs: () => 7 })).toBe(0);
    } finally {
      if (avant === undefined) delete process.env["PLAYWRIGHT_API_URL"];
      else process.env["PLAYWRIGHT_API_URL"] = avant;
      if (serveur.listening) serveur.close();
    }
  });
});
