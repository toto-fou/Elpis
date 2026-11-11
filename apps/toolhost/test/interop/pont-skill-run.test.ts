// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/pont-skill-run.test.ts — essai réel (ELPIS_INTEROP_PYTHON et ELPIS_INTEROP_DOCKER=1) : core TS → pont MCP (/api/mcp-bridge/skill_run, délégation signée) → famille skill_run native de l'hôte TS (compte par rappel au core) → script du skill du compte dans le conteneur de ce compte. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser, creerJeton, dependancesParDefaut } from "@elpis/auth";
import { privdrop, resetImageLoadState, resetUserSandboxCache } from "@elpis/bac";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { composer as composerCore, creerApp, Journal } from "@elpis/core";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { fileEntry } from "@elpis/fichiers";
import { oublierManifeste } from "@elpis/mcp";
import { oublierConfigurationAudit } from "@elpis/securite";
import { invalidateSkillsScanCache } from "@elpis/skills";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { remplacerBase } from "../../../core/src/base";
import { brancherRappelProfil } from "../../src/mcp/espace";
import { configTest, hoteTest, SVC } from "../aides";
import type { HoteTest } from "../aides";
import { portLibre, PYTHON } from "./aides-python";

const CACHE = vi.hoisted(() => {
  const chemin = `${process.env["TMPDIR"] ?? "/tmp"}/elpis-pont-skill-run-categories-${process.pid}.json`;
  process.env["TOOL_CATEGORIES_CACHE_PATH"] = chemin;
  return chemin;
});

type Dict = Record<string, unknown>;

const ACTIF = Boolean(PYTHON) && process.env["ELPIS_INTEROP_DOCKER"] === "1";
const LOT = "elpis.lot=b3-04";
const suffixe = Math.random().toString(16).slice(2, 8);
const COMPTES = [`b3ra${suffixe}`, `b3rb${suffixe}`] as const;
const [ALICE, BOB] = COMPTES;

function supprimerConteneur(nom: string): void {
  const c = `elpis-sb-${nom}`;
  spawnSync("docker", ["exec", "-u", "0:0", c, "sh", "-c", "rm -rf /work/* /work/.[!.]* /work/..?*"], {
    timeout: 60_000,
  });
  spawnSync("docker", ["rm", "-f", c], { timeout: 60_000 });
}

function ecrire(p: string, contenu: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, contenu);
}

describe.skipIf(!ACTIF)(
  "core TS → pont MCP → famille skill_run native de l'hôte TS → conteneur du compte",
  () => {
    let dossier = "";
    let h: HoteTest;
    let t: BaseDeTest;
    let app: FastifyInstance;
    let core = "";
    let restaurer: () => void = () => undefined;
    const jetons: Record<string, string> = {};
    const uids: Record<string, number> = {};

    beforeAll(async () => {
      dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-b3-04-pont-")));
      const config = path.join(dossier, "config.json");
      writeFileSync(config, JSON.stringify({ executors: { extra_run_args: ["--label", LOT] } }));
      ecrire(
        path.join(dossier, "user_skills", ALICE, "perso", "SKILL.md"),
        "---\nname: perso\ndescription: d\n---\n\nP.\n",
      );
      ecrire(
        path.join(dossier, "user_skills", ALICE, "perso", "run.sh"),
        'printf "%s\\n" "$1" > rapport.txt; id -u; cat "$SKILL_DIR/note.txt"\n',
      );
      ecrire(path.join(dossier, "user_skills", ALICE, "perso", "note.txt"), "note d'alice\n");
      ecrire(
        path.join(dossier, "skills", "commun", "SKILL.md"),
        "---\nname: commun\ndescription: d\n---\n\nG.\n",
      );
      ecrire(path.join(dossier, "skills", "commun", "run.py"), "import os; print('commun', os.getcwd())\n");
      restaurer = surchargerConfig({ SANDBOX_DIR: path.join(dossier, "sb"), CONFIG_JSON_PATH: config });
      vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
      vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(dossier, "fh"));
      vi.stubEnv("ELPIS_AUDIT_DIR", path.join(dossier, "audit"));
      vi.stubEnv("APP_SKILLS_DIR", path.join(dossier, "skills"));
      vi.stubEnv("APP_USER_SKILLS_DIR", path.join(dossier, "user_skills"));
      vi.stubEnv("SKILLS_LOCK_PATH", path.join(dossier, "skills.lock"));
      oublierConfigurationAudit();
      invalidateSkillsScanCache();
      const portCore = await portLibre();
      core = `http://127.0.0.1:${portCore}`;
      h = await hoteTest(
        configTest({ families: ["fs", "git", "skill_run"], familles_natives: ["skill_run"], app_url: core }),
      );
      await h.app.listen({ port: 0, host: "127.0.0.1" });
      const hote = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
      writeFileSync(
        path.join(dossier, "mcp.json"),
        JSON.stringify({
          version: 1,
          toolHosts: { main: { url: hote, token: SVC } },
          mcpServers: {
            "elpis-tools": {
              type: "http",
              url: `${hote}/mcp`,
              headers: { Authorization: `Bearer ${SVC}` },
              "x-elpis": { role: "toolhost", host: "main", families: ["fs", "git", "skill_run"] },
            },
          },
        }),
      );
      vi.stubEnv("APP_MCP_MANIFEST", path.join(dossier, "mcp.json"));
      oublierManifeste();
      t = ouvrirBaseDeTest("sqlite");
      await initialiserBase(t.base);
      remplacerBase(t.base);
      const dep = dependancesParDefaut(t.base);
      for (const nom of COMPTES) {
        const uid = await createUser(t.base, nom, `mdp-${nom}-pont-skill-run`, { isAdmin: 0 });
        uids[nom] = uid;
        [jetons[nom] = ""] = await creerJeton(dep, uid, "tools", "pont", ["skill_run"]);
      }
      const journal = new Journal({ niveau: "warn", sortie: () => undefined });
      const composition = await composerCore("main", t.base, journal);
      app = await creerApp({ mode: "main", journal, ...composition });
      await app.listen({ port: portCore, host: "127.0.0.1" });
    }, 60_000);

    afterAll(async () => {
      try {
        app?.server.closeAllConnections();
        await app?.close();
        await h?.fermer();
      } finally {
        for (const nom of COMPTES) supprimerConteneur(nom);
        brancherRappelProfil(null);
        resetUserSandboxCache();
        privdrop.oublierSondes();
        resetImageLoadState();
        oublierConfigurationAudit();
        restaurer();
        vi.unstubAllEnvs();
        invalidateSkillsScanCache();
        remplacerBase(undefined);
        oublierManifeste();
        invalidateConfigCache();
        await t?.fermer();
        rmSync(CACHE, { force: true });
        try {
          if (dossier) rmSync(dossier, { recursive: true, force: true });
        } catch {
          spawnSync(
            "docker",
            [
              "run",
              "--rm",
              "--name",
              `elpis-b3-04-nettoyage-${suffixe}`,
              "--label",
              LOT,
              "--network",
              "none",
              "--entrypoint",
              "rm",
              "-v",
              `${dossier}:/d`,
              "elpis/sandbox:1.7.0",
              "-rf",
              "/d/sb",
            ],
            { timeout: 60_000 },
          );
          rmSync(dossier, { recursive: true, force: true });
        }
      }
    }, 180_000);

    async function client(nom: string): Promise<Client> {
      const c = new Client({ name: "pont", version: "1" });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${core}/api/mcp-bridge/skill_run`), {
          requestInit: { headers: { authorization: `Bearer ${jetons[nom] ?? ""}` } },
        }),
      );
      return c;
    }

    const resultat = (r: Dict): Dict =>
      ((r["structuredContent"] as Dict | undefined)?.["result"] as Dict | undefined) ??
      (JSON.parse(((r["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}") as Dict);

    it("le script d'un skill du compte tourne dans SON conteneur ; un autre compte ne le trouve pas ; le global sert à tous", async () => {
      const alice = await client(ALICE);
      try {
        expect((await alice.listTools()).tools.map((x) => x.name)).toEqual(["skill_run_script"]);
        const r = resultat(
          (await alice.callTool({
            name: "skill_run_script",
            arguments: { name: "perso", script: "run.sh", args: ["bonjour"] },
          })) as Dict,
        );
        expect(r).toMatchObject({
          ok: true,
          name: "perso",
          script: "run.sh",
          returncode: 0,
          stdout: "10001\nnote d'alice",
          note: null,
        });
        expect(r["files_changed"]).toMatchObject([
          { path: "/work/rapport.txt", change: "created", lines_added: 1 },
        ]);
      } finally {
        await alice.close();
      }
      const versions = ((await fileEntry(uids[ALICE] ?? 0, "rapport.txt"))?.["versions"] ?? []) as Dict[];
      expect(versions.map((v) => v["source"])).toEqual(["shell"]);
      const bob = await client(BOB);
      try {
        const refus = (await bob.callTool({
          name: "skill_run_script",
          arguments: { name: "perso", script: "run.sh" },
        })) as Dict;
        expect(refus["isError"]).toBe(true);
        expect(resultat(refus)).toMatchObject({ ok: false, error: "skill_not_found" });
        const r = resultat(
          (await bob.callTool({
            name: "skill_run_script",
            arguments: { name: "commun", script: "run.py" },
          })) as Dict,
        );
        expect(r).toMatchObject({ ok: true, name: "commun", returncode: 0, stdout: "commun /work" });
        const lu = resultat(
          (await bob.callTool({
            name: "skill_run_script",
            arguments: { name: "commun", script: "run.py" },
          })) as Dict,
        );
        expect(lu["files_changed"]).toBeUndefined();
      } finally {
        await bob.close();
      }
      for (const nom of COMPTES) {
        const inspect = spawnSync("docker", [
          "inspect",
          "--format",
          '{{index .Config.Labels "elpis.lot"}} {{.HostConfig.NetworkMode}}',
          `elpis-sb-${nom}`,
        ]);
        expect(inspect.stdout.toString().trim()).toBe("b3-04 none");
      }
      const travailBob = spawnSync("docker", [
        "exec",
        `elpis-sb-${BOB}`,
        "ls",
        "-A",
        "/work",
      ]).stdout.toString();
      expect(travailBob).not.toContain("rapport.txt");
    }, 180_000);
  },
);
