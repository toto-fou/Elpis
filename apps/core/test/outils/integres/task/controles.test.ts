// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/controles.test.ts — appels du harnais de `task` à l'hôte d'outils : branche relue par un seul `git_query(action="branches")`, en lecture seule, `null` sur toute panne ; navigateur des sous-agents (fix du quota, sessions orphelines fermées au démarrage). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { surchargerConfig } from "@elpis/config";
import type { ServiceNavigateur } from "@elpis/navigateur";
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

  it("démarrage : un POST /cleanup_children sans propriétaire par service de bac, nombres additionnés ; service en panne : 0", async () => {
    const corps: unknown[] = [];
    const a: ServiceNavigateur = { socket: "/a", jeton: "j" };
    const b: ServiceNavigateur = { socket: "/b", jeton: "j" };
    const services = (): ServiceNavigateur[] => [a, b];
    const n = await fermerNavigateursEnfantsOrphelins({
      ageMs: () => 4200,
      services,
      poster: async (s, c) => (corps.push([s === a ? "a" : "b", c]), { cleaned: s === a ? 3 : 1 }),
    });
    expect(n).toBe(4);
    expect(corps).toEqual([
      ["a", { older_than_ms: 4200 }],
      ["b", { older_than_ms: 4200 }],
    ]);
    expect(await fermerNavigateursEnfantsOrphelins({ services, poster: async () => null })).toBe(0);
    expect(await fermerNavigateursEnfantsOrphelins({ services, poster: async () => ({ error: "x" }) })).toBe(
      0,
    );
  });

  it("démarrage : socket de chaque bac à jeton de SANDBOX_DIR joint avec son jeton ; bac sans jeton ignoré, service arrêté : 0 sans lever", async () => {
    const sb = mkdtempSync(join(tmpdir(), "elpis-sb-"));
    const restaurer = surchargerConfig({ SANDBOX_DIR: sb });
    process.env["ELPIS_TOOLHOST_RUN_DIR"] = join(sb, "run");
    const recus: { url: string; auth: unknown; corps: unknown }[] = [];
    const serveur = createServer((req, res) => {
      let texte = "";
      req.on("data", (b: Buffer) => (texte += b.toString()));
      req.on("end", () => {
        recus.push({
          url: `${req.method} ${req.url}`,
          auth: req.headers.authorization,
          corps: JSON.parse(texte),
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ cleaned: 2 }));
      });
    });
    try {
      for (const compte of ["alice", "bob"]) mkdirSync(join(sb, compte, ".elpis-agent"), { recursive: true });
      mkdirSync(join(sb, "run", "navigateur"), { recursive: true });
      writeFileSync(join(sb, "run", "navigateur", "alice.service.token"), "jeton-a\n");
      await new Promise<void>((ok) => serveur.listen(join(sb, "alice", ".elpis-agent", "browser.sock"), ok));
      expect(await fermerNavigateursEnfantsOrphelins({ ageMs: () => 7 })).toBe(2);
      expect(recus).toEqual([
        { url: "POST /cleanup_children", auth: "Bearer jeton-a", corps: { older_than_ms: 7 } },
      ]);
      serveur.closeAllConnections();
      await new Promise<void>((ok) => serveur.close(() => ok()));
      expect(await fermerNavigateursEnfantsOrphelins({ ageMs: () => 7 })).toBe(0);
    } finally {
      delete process.env["ELPIS_TOOLHOST_RUN_DIR"];
      restaurer();
      if (serveur.listening) serveur.close();
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
