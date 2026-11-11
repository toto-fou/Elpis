// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/pont-fs.test.ts — essai réel core TS → pont MCP (/api/mcp-bridge/fs, délégation signée) → famille fs native de l'hôte TS → vrai agent Python du bac de chaque compte : écriture, lecture, liste et édition dans le /work du compte délégué, jamais dans celui d'un autre. */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser, creerJeton, dependancesParDefaut } from "@elpis/auth";
import { invalidateConfigCache } from "@elpis/config";
import { composer as composerCore, creerApp, Journal } from "@elpis/core";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { AgentClient } from "@elpis/fichiers";
import { oublierManifeste } from "@elpis/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BacTest, PYTHON } from "../../../../packages/fichiers/test/aides";
import { remplacerBase } from "../../../core/src/base";
import { Espace, installerFabriqueEspace } from "../../src/mcp/espace";
import { configTest, hoteTest, SVC } from "../aides";
import type { HoteTest } from "../aides";

const CACHE = vi.hoisted(() => {
  const chemin = `${process.env["TMPDIR"] ?? "/tmp"}/elpis-pont-fs-categories-${process.pid}.json`;
  process.env["TOOL_CATEGORIES_CACHE_PATH"] = chemin;
  return chemin;
});

type Dict = Record<string, unknown>;

describe.skipIf(!PYTHON)("core TS → pont MCP → famille fs native de l'hôte TS → agent du bac", () => {
  let dossier: string;
  let h: HoteTest;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let core = "";
  const jetons: Record<string, string> = {};
  const bacs = new Map<string, BacTest>();
  const uids = new Map<string, number>();
  const demandes: string[] = [];

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-pont-fs-")));
    vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(dossier, "fh"));
    vi.stubEnv("FSTOOLS_FLOCK", "0");
    installerFabriqueEspace(async (username) => {
      demandes.push(username);
      let bac = bacs.get(username);
      if (bac === undefined) {
        bac = new BacTest(dossier, username);
        bacs.set(username, bac);
      }
      return new Espace(bac.sandboxPath, uids.get(username) ?? 0, new AgentClient(bac));
    });
    h = await hoteTest(configTest({ families: ["fs", "git"], familles_natives: ["fs"] }));
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
            "x-elpis": { role: "toolhost", host: "main", families: ["fs", "git"] },
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
    for (const nom of ["alice", "bob"]) {
      const uid = await createUser(t.base, nom, `mdp-${nom}-pont-fs`, { isAdmin: 0 });
      uids.set(nom, uid);
      [jetons[nom] = ""] = await creerJeton(dep, uid, "tools", "pont", ["fs"]);
    }
    const journal = new Journal({ niveau: "warn", sortie: () => undefined });
    const composition = await composerCore("main", t.base, journal);
    app = await creerApp({ mode: "main", journal, ...composition });
    await app.listen({ port: 0, host: "127.0.0.1" });
    core = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    try {
      app?.server.closeAllConnections();
      await app?.close();
      await h?.fermer();
      for (const b of bacs.values()) await b.arreter();
    } finally {
      installerFabriqueEspace(null);
      vi.unstubAllEnvs();
      remplacerBase(undefined);
      oublierManifeste();
      invalidateConfigCache();
      await t?.fermer();
      rmSync(CACHE, { force: true });
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  }, 30_000);

  async function client(nom: string): Promise<Client> {
    const c = new Client({ name: "pont", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${core}/api/mcp-bridge/fs`), {
        requestInit: { headers: { authorization: `Bearer ${jetons[nom] ?? ""}` } },
      }),
    );
    return c;
  }

  const resultat = (r: Dict): Dict =>
    ((r["structuredContent"] as Dict | undefined)?.["result"] as Dict | undefined) ??
    (JSON.parse(((r["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}") as Dict);

  it("alice écrit, lit, liste et édite dans son /work ; bob ne voit rien d'alice", async () => {
    const alice = await client("alice");
    try {
      expect((await alice.listTools()).tools.map((x) => x.name)).toEqual([
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "manage_files",
        "code",
      ]);
      const w = resultat(
        (await alice.callTool({
          name: "write_file",
          arguments: { path: "notes/a.md", content: "# Titre\nligne\n" },
        })) as Dict,
      );
      expect(w).toMatchObject({ ok: true, path: "/work/notes/a.md", action: "write", lines_added: 2 });
      expect(
        resultat((await alice.callTool({ name: "read_file", arguments: { path: "notes/a.md" } })) as Dict),
      ).toMatchObject({ ok: true, type: "text", content: "1\t# Titre\n2\tligne", sha256: w["new_sha256"] });
      expect(
        resultat(
          (await alice.callTool({
            name: "edit_file",
            arguments: { path: "notes/a.md", action: "str_replace", old_str: "ligne", new_str: "ligne 2" },
          })) as Dict,
        ),
      ).toMatchObject({ ok: true, lines_added: 1, lines_removed: 1 });
      expect(
        resultat((await alice.callTool({ name: "list_files", arguments: { recursive: true } })) as Dict),
      ).toMatchObject({ ok: true, items: ["notes/", "notes/a.md"] });
      expect(readFileSync(path.join(bacs.get("alice")?.sandboxPath ?? "", "notes/a.md"), "utf8")).toBe(
        "# Titre\nligne 2\n",
      );
    } finally {
      await alice.close();
    }
    const bob = await client("bob");
    try {
      const r = (await bob.callTool({ name: "read_file", arguments: { path: "notes/a.md" } })) as Dict;
      expect(r["isError"]).toBe(true);
      expect(JSON.stringify(r["content"])).toContain("not_found");
    } finally {
      await bob.close();
    }
    expect(new Set(demandes)).toEqual(new Set(["alice", "bob"]));
  }, 60_000);
});
