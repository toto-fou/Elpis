// SPDX-License-Identifier: MIT
/** apps/toolhost/test/stdio.test.ts — `main.ts --stdio` en process réel : essai par famille native (browser, desktop, fs, skill_run), compte = `_meta.username` seul comme `python -m toolhost --stdio` (ni jeton ni port) ; familles non servies refusées ou signalées, `--familles-relayees` et `--elpis-tools` sans effet. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { proprietaire } from "@elpis/navigateur";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SVC } from "./aides";
import { FauxNavigateur, SITE } from "./faux-navigateur";
import { portLibre } from "./interop/aides-python";

const RACINE = path.resolve(import.meta.dirname, "..", "..", "..");
const MAIN = path.join(RACINE, "apps", "toolhost", "src", "main.ts");

let dossier = "";
let port = 0;
let navigateur: FauxNavigateur;
const ouverts: (() => Promise<void>)[] = [];

beforeAll(async () => {
  dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-toolhost-stdio-")));
  writeFileSync(
    path.join(dossier, "toolhost.json"),
    JSON.stringify({
      familles_natives: ["browser", "desktop", "fs", "skill_run"],
      db_path: path.join(dossier, "toolhost.db"),
    }),
  );
  mkdirSync(path.join(dossier, "user_skills", "alice", "perso"), { recursive: true });
  writeFileSync(
    path.join(dossier, "user_skills", "alice", "perso", "SKILL.md"),
    "---\nname: perso\ndescription: d\n---\n\nP.\n",
  );
  writeFileSync(path.join(dossier, "user_skills", "alice", "perso", "x.rb"), "puts 1\n");
  port = await portLibre();
  navigateur = await FauxNavigateur.demarrer();
});

afterEach(async () => {
  for (const f of ouverts.splice(0).reverse()) await f();
});

afterAll(async () => {
  await navigateur?.arreter();
  if (dossier) rmSync(dossier, { recursive: true, force: true });
});

function environnement(plus: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: dossier,
    NO_PROXY: "*",
    ELPIS_RACINE: RACINE,
    TOOLHOST_CONFIG: path.join(dossier, "toolhost.json"),
    APP_CONFIG_PATH: path.join(dossier, "config.json"),
    APP_DB_PATH: path.join(dossier, "app.db"),
    APP_MCP_MANIFEST: path.join(dossier, "absent-mcp.json"),
    APP_SANDBOX_DIR: path.join(dossier, "sb"),
    APP_FILE_HISTORY_DIR: path.join(dossier, "fh"),
    APP_SKILLS_DIR: path.join(dossier, "skills"),
    APP_USER_SKILLS_DIR: path.join(dossier, "user_skills"),
    SKILLS_LOCK_PATH: path.join(dossier, "skills.lock"),
    ELPIS_AUDIT_DIR: path.join(dossier, "audit"),
    LOCAL_MCP_HOST: "127.0.0.1",
    LOCAL_MCP_PORT: String(port),
    LOCAL_MCP_TOKEN: SVC,
    PLAYWRIGHT_API_URL: navigateur.url,
    ...plus,
  };
}

async function ouvrir(familles: string): Promise<{ client: Client; journal: string[] }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", MAIN, "--stdio", "--families", familles],
    env: environnement(),
    cwd: RACINE,
    stderr: "pipe",
  });
  const journal: string[] = [];
  transport.stderr?.on("data", (m: Buffer) => journal.push(m.toString()));
  const client = new Client({ name: "essai-stdio", version: "1" });
  await client.connect(transport);
  ouverts.push(() => client.close());
  return { client, journal };
}

function lancer(
  args: string[],
  entree = "",
  plus: Record<string, string> = {},
): Promise<{ code: number | null; sortie: string; erreurs: string }> {
  const proc = spawn(process.execPath, ["--import", "tsx", MAIN, ...args], {
    env: environnement(plus),
    cwd: RACINE,
  });
  let sortie = "";
  let erreurs = "";
  proc.stdout.on("data", (m: Buffer) => (sortie += m.toString()));
  proc.stderr.on("data", (m: Buffer) => (erreurs += m.toString()));
  proc.stdin.end(entree);
  return new Promise((fin) => proc.once("exit", (code) => fin({ code, sortie, erreurs })));
}

const nomsDuGolden = (famille: string): string[] =>
  (
    JSON.parse(
      readFileSync(path.join(RACINE, "packages", "outils-mcp", "goldens", `${famille}.json`), "utf-8"),
    ) as { outils: { name: string }[] }
  ).outils.map((o) => o.name);

const texte = (r: Dict): string => (r["content"] as { text: string }[])[0]?.text ?? "";

/** Propriétaire transmis au service navigateur par le dernier `pw_session start`. */
async function proprietaireDe(client: Client, meta: Dict | undefined): Promise<string> {
  navigateur.reinitialiser();
  const r = await client.callTool({
    name: "pw_session",
    arguments: { action: "start", url: `${SITE}/` },
    ...(meta ? { _meta: meta } : {}),
  });
  expect(r.isError, texte(r)).toBeFalsy();
  const vue = navigateur.vues.find((v) => v.chemin === "/start");
  return String((JSON.parse(vue?.corps ?? "{}") as Dict)["owner"]);
}

describe("hôte d'outils en stdio (familles natives)", () => {
  it("browser : les 14 outils du golden, appel réel pour le compte du `_meta`", async () => {
    const { client } = await ouvrir("browser");
    expect((await client.listTools()).tools.map((o) => o.name)).toEqual(nomsDuGolden("browser"));
    expect(await proprietaireDe(client, { username: "alice" })).toBe(proprietaire("alice"));
  }, 60_000);

  it("desktop : outils exposés du golden, appel réel sans cible configurée (erreur du Python)", async () => {
    const { client } = await ouvrir("desktop");
    expect((await client.listTools()).tools.map((o) => o.name)).toEqual(nomsDuGolden("desktop"));
    const r = await client.callTool({ name: "desktop_session", arguments: {}, _meta: { username: "hugo" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(texte(r))).toMatchObject({ ok: false, error: "no_target" });
  }, 60_000);

  it("fs : les outils du golden, appel réel sans chemin (erreur du Python)", async () => {
    const { client } = await ouvrir("fs");
    expect((await client.listTools()).tools.map((o) => o.name)).toEqual(nomsDuGolden("fs"));
    const r = await client.callTool({ name: "read_file", arguments: {}, _meta: { username: "hugo" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(texte(r))).toMatchObject({ ok: false, error: "path_required" });
  }, 60_000);

  it("skill_run : l'outil du golden, skill résolu dans le magasin du compte du `_meta` (sans exécution)", async () => {
    const { client } = await ouvrir("skill_run");
    expect((await client.listTools()).tools.map((o) => o.name)).toEqual(nomsDuGolden("skill_run"));
    const appel = (username: string): Promise<Dict> =>
      client.callTool({
        name: "skill_run_script",
        arguments: { name: "perso", script: "x.rb" },
        _meta: { username },
      }) as Promise<Dict>;
    expect(JSON.parse(texte(await appel("alice")))).toMatchObject({
      ok: false,
      error: "skill_run_unsupported",
    });
    expect(JSON.parse(texte(await appel("bob")))).toMatchObject({ ok: false, error: "skill_not_found" });
  }, 60_000);

  it("compte = `_meta.username` (guest sans lui) ; jeton de service, is_admin et jeton du `_meta` sans effet ; aucun port ouvert", async () => {
    const { client, journal } = await ouvrir("browser");
    expect(await proprietaireDe(client, undefined)).toBe(proprietaire("guest"));
    expect(await proprietaireDe(client, { username: "  " })).toBe(proprietaire("guest"));
    expect(await proprietaireDe(client, { username: "alice" })).toBe(proprietaire("alice"));
    expect(
      await proprietaireDe(client, {
        username: "alice",
        user_id: 1,
        is_admin: true,
        token: SVC,
        claims: { username: "bob", families: [] },
        trusted_meta: { username: "bob" },
      }),
    ).toBe(proprietaire("alice"));
    expect(await proprietaireDe(client, { username: "bob" })).toBe(proprietaire("bob"));
    const refus = await new Promise<string>((fin) => {
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        fin("ouvert");
      });
      s.once("error", (e: NodeJS.ErrnoException) => fin(e.code ?? "erreur"));
    });
    expect(refus).toBe("ECONNREFUSED");
    expect(journal.join("")).not.toContain("hôte d'outils : http");
  }, 60_000);
});

describe("hôte d'outils en stdio (familles non servies, options retirées)", () => {
  it("familles que l'hôte ne sert pas (chart, todo) : refus (code 2), chacune signalée, rien de lancé", async () => {
    const r = await lancer(["--stdio", "--families", "chart,todo"]);
    expect(r.code).toBe(2);
    expect(r.sortie).toBe("");
    expect(r.erreurs).toContain("stdio : aucune des familles demandées n'est servie (--families <famille>)");
    expect(r.erreurs).toContain("famille chart non servie par l'hôte d'outils : ignorée");
    expect(r.erreurs).toContain("famille todo non servie par l'hôte d'outils : ignorée");
  }, 60_000);

  it("familles servies et non servies mêlées : les natives servies (git, shell portées), l'autre signalée ; familles_natives de toolhost.json ignoré", async () => {
    const { client, journal } = await ouvrir("git,todo");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(nomsDuGolden("git"));
    expect(journal.join("")).toContain("famille todo non servie par l'hôte d'outils : ignorée");
    expect(journal.join("")).toContain("familles_natives ignoré");
  }, 60_000);

  it("--familles-relayees (anciens ./elpis) : ligne vide, sortie 0 ; --elpis-tools (anciennes unités) : rien de lancé, sortie 0", async () => {
    expect(await lancer(["--familles-relayees"])).toMatchObject({ code: 0, sortie: "\n" });
    expect(await lancer(["--familles-relayees", "--families", "fs,git"])).toMatchObject({
      code: 0,
      sortie: "\n",
    });
    const r = await lancer(["--elpis-tools", "--families", "fs,browser"]);
    expect([r.code, r.sortie]).toEqual([0, ""]);
    expect(r.erreurs).toContain("elpis-tools est retiré : rien à servir");
  }, 60_000);
});
