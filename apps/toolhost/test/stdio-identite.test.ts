// SPDX-License-Identifier: MIT
/** apps/toolhost/test/stdio-identite.test.ts — identité d'un appel stdio (`servirStdio` en processus) : compte, id et profil du `_meta`, `is_admin` du seul rappel au core, jeton et revendications du `_meta` ignorés, comme `IdentityCapture` du stdio Python. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { Dict } from "@elpis/commun";
import { getUsername } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { current } from "@elpis/securite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FabriqueNative } from "../src/mcp/natives";
import { servirStdio } from "../src/stdio";
import { configTest, journalMuet, SVC } from "./aides";

const ENV_AVANT = { ...process.env };
let dossier = "";
let coeur: Server;
let urlCoeur = "";
const demandes: string[] = [];

/** Famille d'essai : un outil qui rend l'identité vue par l'appel. */
const familleIdentite: FabriqueNative = () => ({
  famille: "todo",
  outils: [
    {
      nom: "todo_qui",
      famille: "todo",
      definition: {
        name: "todo_qui",
        description: "Identité de l'appel.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      signature: {},
      traiter: (_args: Dict, ctx: ContexteAppel) => {
        const i = current();
        return {
          ok: true,
          compte: getUsername(ctx),
          user_id: i?.user_id ?? null,
          is_admin: i?.is_admin ?? null,
          profil: i?.network_profile_id ?? null,
        };
      },
    },
  ],
});

beforeAll(async () => {
  dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-stdio-identite-")));
  for (const [k, v] of Object.entries({
    APP_CONFIG_PATH: path.join(dossier, "config.json"),
    APP_FILE_HISTORY_DIR: path.join(dossier, "fh"),
    ELPIS_AUDIT_DIR: path.join(dossier, "audit"),
    APP_MCP_MANIFEST: path.join(dossier, "absent-mcp.json"),
  }))
    process.env[k] = v;
  coeur = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://coeur");
    const nom = u.searchParams.get("username") ?? "";
    demandes.push(`${req.headers.authorization ?? ""}|${u.pathname}|${nom}`);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ok: true,
        user_id: nom === "chef" ? 1 : 42,
        username: nom,
        is_admin: nom === "chef",
        network_profile_id: "lan",
      }),
    );
  });
  await new Promise<void>((fin) => coeur.listen(0, "127.0.0.1", () => fin()));
  urlCoeur = `http://127.0.0.1:${(coeur.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((fin) => coeur.close(() => fin()));
  for (const k of Object.keys(process.env)) if (!(k in ENV_AVANT)) delete process.env[k];
  Object.assign(process.env, ENV_AVANT);
  if (dossier) rmSync(dossier, { recursive: true, force: true });
});

/** Session stdio en mémoire (deux flux) contre `servirStdio` ; rend les identités vues pour chaque `_meta`. */
async function identites(appUrl: string, metas: (Dict | undefined)[]): Promise<Dict[]> {
  const entree = new PassThrough();
  const sortie = new PassThrough();
  const fin = servirStdio(
    configTest({
      families: ["todo"],
      familles_natives: ["todo"],
      db_path: path.join(dossier, "toolhost.db"),
      sandbox_dir: path.join(dossier, "sb"),
      app_url: appUrl,
    }),
    { journal: journalMuet, fabriques: { todo: familleIdentite }, entree, sortie },
  );
  const client = new Client({ name: "essai-identite", version: "1" });
  await client.connect(new StdioServerTransport(sortie, entree));
  const vues: Dict[] = [];
  try {
    for (const meta of metas) {
      const r = await client.callTool({ name: "todo_qui", arguments: {}, ...(meta ? { _meta: meta } : {}) });
      vues.push(r.structuredContent as Dict);
    }
  } finally {
    await client.close();
    entree.end();
  }
  expect(await fin).toBe(0);
  return vues;
}

describe("identité d'un appel stdio (familles natives)", () => {
  it("avec rappel au core : id et profil par rappel, is_admin du rappel seul, `_meta` de confiance mais sans droits", async () => {
    demandes.length = 0;
    const vues = await identites(urlCoeur, [
      undefined,
      { username: "alice" },
      { username: "alice", user_id: 7, network_profile_id: "p1", is_admin: true },
      { username: "chef" },
      {
        username: "alice",
        token: SVC,
        is_admin: true,
        claims: { username: "chef" },
        trusted_meta: { username: "chef" },
      },
    ]);
    expect(vues).toEqual([
      { ok: true, compte: "guest", user_id: null, is_admin: null, profil: null },
      { ok: true, compte: "alice", user_id: 42, is_admin: false, profil: "lan" },
      { ok: true, compte: "alice", user_id: 7, is_admin: false, profil: "p1" },
      { ok: true, compte: "chef", user_id: 1, is_admin: true, profil: "lan" },
      { ok: true, compte: "alice", user_id: 42, is_admin: false, profil: "lan" },
    ]);
    expect(new Set(demandes)).toEqual(
      new Set([`Bearer ${SVC}|/api/internal/identity|alice`, `Bearer ${SVC}|/api/internal/identity|chef`]),
    );
  });

  it("sans rappel (pas d'URL du core) : id 0, jamais admin, même pour le compte admin du core", async () => {
    demandes.length = 0;
    expect(await identites("", [{ username: "chef" }, { username: "chef", is_admin: true }])).toEqual([
      { ok: true, compte: "chef", user_id: 0, is_admin: false, profil: "" },
      { ok: true, compte: "chef", user_id: 0, is_admin: false, profil: "" },
    ]);
    expect(demandes).toEqual([]);
  });
});
