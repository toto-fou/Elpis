// SPDX-License-Identifier: MIT
/** apps/toolhost/test/sous-agents.test.ts — hôte d'outils et sous-agent (`_meta.subagent`) contre le vrai agent du bac, sans conteneur : aucun périmètre d'outils à l'hôte, shell sans fond, remote vérifié avant de brancher ou de committer (SA-21). */
import { existsSync } from "node:fs";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { AgentClient } from "@elpis/fichiers";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { arreterRelais } from "@elpis/fichiers";
import { Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { outilsFs } from "../src/mcp/fs/famille";
import { outilsGit } from "../src/mcp/git/famille";
import { appuisParDefaut, executeShell, outilsShell } from "../src/mcp/shell/outil";
import { PontExec } from "../src/mcp/shell/pont";

let racine = "";
let nettoyer: () => void = () => undefined;
let bac: BacTest;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-sous-agents-");
  bac = new BacTest(racine, "alice");
  vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(racine, "fh"));
  vi.stubEnv("FSTOOLS_FLOCK", "0");
  installerFabriqueEspace(async () => new Espace(bac.sandboxPath, 7, new AgentClient(bac)));
});

afterEach(async () => {
  installerFabriqueEspace(null);
  vi.unstubAllEnvs();
  await bac.arreter();
  await arreterRelais();
  nettoyer();
});

async function client(): Promise<{ c: Client; fermer: () => Promise<void> }> {
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("fs", outilsFs());
  serveur.enregistrerFamille("git", outilsGit(null));
  serveur.enregistrerFamille("shell", outilsShell(appuisParDefaut(new PontExec())));
  const cnx = await ouvrirEnMemoire(serveur, { famille: null });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(cnx.transport);
  return { c, fermer: () => cnx.fermer() };
}

const COMPTE = { username: "alice", user_id: "7" };

async function appeler(c: Client, outil: string, args: Dict, subagent: Dict | null = null): Promise<Dict> {
  const _meta = subagent ? { ...COMPTE, subagent } : COMPTE;
  const rep = (await c.callTool({ name: outil, arguments: args, _meta })) as Dict;
  const sc = rep["structuredContent"] as Dict | undefined;
  const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
  return (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict);
}

const travail = (rel: string): string => path.join(bac.sandboxPath, rel);

describe.skipIf(!PYTHON)("hôte d'outils et sous-agent (vrai agent du bac)", () => {
  it("le périmètre n'est plus appliqué par l'hôte : le manifeste de l'enfant décide, les anciens champs du _meta sont ignorés", async () => {
    const { c, fermer } = await client();
    try {
      const ancien = { type: "implement", read_only: true, writable_paths: ["tmp/ok"] };
      expect(await appeler(c, "write_file", { path: "tmp/ko/a", content: "x" }, ancien)).toMatchObject({
        ok: true,
      });
      expect(existsSync(travail("tmp/ko/a"))).toBe(true);
      expect(await appeler(c, "git_action", { repo: "proj", action: "init" })).toMatchObject({ ok: true });
      await appeler(c, "write_file", { path: "proj/a.py", content: "x = 1\n" });
      expect(await appeler(c, "git_commit", { repo: "proj", message: "feat: a" }, ancien)).toMatchObject({
        ok: true,
      });
    } finally {
      await fermer();
    }
  });

  it("execute_shell(background=true) refusé à tout sous-agent par l'outil (appel MCP et appel direct)", async () => {
    const { c, fermer } = await client();
    try {
      for (const t of ["implement", "verify", "custom"]) {
        const r = await appeler(
          c,
          "execute_shell",
          { command: "sleep 600", background: true },
          { type: t, read_only: false },
        );
        expect(r, t).toMatchObject({ ok: false, error: "not_available_here" });
        expect(String(r["fix"])).toContain("return status blocked");
      }
      const direct = await executeShell(
        { command: "sleep 600", background: true } as Parameters<typeof executeShell>[0],
        { meta: { ...COMPTE, subagent: { type: "implement", read_only: false } } } as never,
        appuisParDefaut(new PontExec()),
      );
      expect(direct).toMatchObject({ ok: false, error: "not_available_here" });
    } finally {
      await fermer();
    }
  });

  it("SA-21 : pr sans remote : échec no_remote AVANT de brancher ou de committer ; hors sous-agent, rien ne change", async () => {
    const { c, fermer } = await client();
    try {
      const pr = { type: "pr", read_only: false };
      expect(await appeler(c, "git_action", { repo: "proj", action: "init" })).toMatchObject({ ok: true });
      await appeler(c, "write_file", { path: "proj/a.py", content: "x = 1\n" });
      const debut = await appeler(c, "git_start_work", { repo: "proj", branch_intent: "feat" }, pr);
      expect(debut).toMatchObject({ ok: false, error: "no_remote" });
      expect(String(debut["fix"])).toContain("status blocked");
      expect(await appeler(c, "git_commit", { repo: "proj", message: "feat: a" }, pr)).toMatchObject({
        ok: false,
        error: "no_remote",
      });
      const log = await appeler(c, "git_query", { repo: "proj", action: "log" });
      expect(String(log["stdout"] ?? "")).not.toContain("feat: a");
      expect(await appeler(c, "git_commit", { repo: "proj", message: "feat: a" })).toMatchObject({
        ok: true,
      });
    } finally {
      await fermer();
    }
  });
});
