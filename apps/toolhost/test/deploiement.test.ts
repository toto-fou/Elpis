// SPDX-License-Identifier: MIT
/** apps/toolhost/test/deploiement.test.ts — bundle de production de l'hôte : construit, licences à jour, modules natifs pour la cible (base, terminal ; `--natif`), démarré tel quel par Node (base ouverte, santé, porte, façade MCP, terminal), stdio exporté, refus du lanceur, arrêt propre. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { ouvrirBase, tableNames } from "@elpis/db";
import { commandeStdioHote, reglerEnvironnementManifeste } from "@elpis/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import WebSocket from "ws";

import {
  blocsDeLicence,
  CIBLE_LOCALE,
  construireHote,
  tableHoteDansNotices,
  tableLicencesHote,
  texteLicencesDepot,
} from "../scripts/construire";
import type { ConstructionHote } from "../scripts/construire";
import { entetes, SVC } from "./aides";
import { portLibre } from "./interop/aides-python";
import { creerFauxDockerTerminal } from "./terminal-aides";

let dossier: string;
let fait: ConstructionHote;
let docker: ReturnType<typeof creerFauxDockerTerminal>;

beforeAll(async () => {
  dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-toolhost-bundle-")));
  fait = await construireHote(path.join(dossier, "dist"));
  docker = creerFauxDockerTerminal(path.join(dossier, "docker"));
}, 120_000);

afterAll(() => {
  if (dossier) rmSync(dossier, { recursive: true, force: true });
});

function environnement(port: number, plus: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: dossier,
    ELPIS_RACINE: path.resolve(import.meta.dirname, "..", "..", ".."),
    TOOLHOST_CONFIG: path.join(dossier, "absent.json"),
    APP_CONFIG_PATH: path.join(dossier, "config.json"),
    APP_DB_PATH: path.join(dossier, "app.db"),
    APP_MCP_MANIFEST: path.join(dossier, "absent-mcp.json"),
    APP_SANDBOX_DIR: path.join(dossier, "sb"),
    APP_FILE_HISTORY_DIR: path.join(dossier, "fh"),
    ELPIS_AUDIT_DIR: path.join(dossier, "audit"),
    LOCAL_MCP_HOST: "127.0.0.1",
    LOCAL_MCP_PORT: String(port),
    LOCAL_MCP_TOKEN: SVC,
    PATH: `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    ...plus,
  };
}

function lancer(
  env: NodeJS.ProcessEnv,
  args: string[] = [],
): { proc: ChildProcess; journal: string[]; fin: Promise<number | null> } {
  const journal: string[] = [];
  const proc = spawn(
    process.execPath,
    ["--enable-source-maps", path.join(fait.sortie, "main.mjs"), ...args],
    { env },
  );
  proc.stdout?.on("data", (m: Buffer) => journal.push(m.toString()));
  proc.stderr?.on("data", (m: Buffer) => journal.push(m.toString()));
  return { proc, journal, fin: new Promise((ok) => proc.once("exit", (code) => ok(code))) };
}

describe("bundle de l'hôte d'outils", () => {
  it("THIRD_PARTY_LICENSES/npm-toolhost.txt et la table de l'hôte dans THIRD_PARTY_NOTICES.md sont à jour (npm run licences)", () => {
    const racine = path.resolve(import.meta.dirname, "..", "..", "..");
    expect(readFileSync(path.join(racine, "THIRD_PARTY_LICENSES", "npm-toolhost.txt"), "utf-8")).toBe(
      texteLicencesDepot(fait.paquets),
    );
    expect(tableHoteDansNotices(readFileSync(path.join(racine, "THIRD_PARTY_NOTICES.md"), "utf-8"))).toBe(
      tableLicencesHote(fait.paquets),
    );
  });

  it("sorties, sources et licences : chaque paquet livré a son texte dans THIRD_PARTY_LICENSES/npm-toolhost.txt", () => {
    for (const f of [
      "main.mjs",
      "main.mjs.map",
      "pixels.mjs",
      "calcul-fil.mjs",
      "webp/dec/webp_dec.wasm",
      "LICENCES-TIERS.txt",
      "construction.json",
    ])
      expect(existsSync(path.join(fait.sortie, f)), f).toBe(true);
    const construction = JSON.parse(readFileSync(path.join(fait.sortie, "construction.json"), "utf-8")) as {
      empreinte: string;
      cibles: string[];
      sources: string[];
    };
    expect(construction.empreinte).toBe(fait.empreinte);
    expect(construction.cibles).toEqual([CIBLE_LOCALE]);
    expect(construction.sources).toEqual(
      expect.arrayContaining([
        "apps/toolhost/src/main.ts",
        "packages/http/src/app.ts",
        "apps/core/scripts/construire.ts",
      ]),
    );
    expect(construction.sources.filter((s) => s.startsWith("apps/core/"))).toEqual([
      "apps/core/scripts/construire.ts",
    ]);
    expect(fait.paquets.map((p) => p.nom)).toEqual(
      expect.arrayContaining([
        "fastify",
        "undici",
        "@modelcontextprotocol/sdk",
        "better-sqlite3",
        "node-addon-api",
        "pngjs",
        "jpeg-js",
        "libwebp",
      ]),
    );
    const livre = blocsDeLicence(readFileSync(path.join(fait.sortie, "LICENCES-TIERS.txt"), "utf-8"));
    expect([...livre.keys()].sort()).toEqual(fait.paquets.map((p) => `${p.nom} ${p.version}`).sort());
    expect(fait.paquets.map((p) => `${p.nom} ${p.version}`)).toEqual(
      expect.arrayContaining(["node-pty 1.1.0", "node-addon-api 7.1.1", "better-sqlite3 13.0.3"]),
    );
    expect(livre.get("node-pty 1.1.0")).toContain("Copyright (c) 2012-2015, Christopher Jeffrey");
    for (const f of [
      `node_modules/node-pty/prebuilds/${CIBLE_LOCALE}/pty.node`,
      "node_modules/node-pty/lib/index.js",
      "node_modules/node-pty/LICENSE",
      `node_modules/better-sqlite3/prebuilds/${CIBLE_LOCALE}.node`,
    ])
      expect(existsSync(path.join(fait.sortie, f)), f).toBe(true);
  });

  it("--natif : node-pty ouvre un PTY et better-sqlite3 une base depuis le bundle ; cible sans binaire refusée", async () => {
    const { journal, fin } = lancer(environnement(await portLibre()), ["--natif"]);
    expect(await fin, journal.join("")).toBe(0);
    expect(journal.join("")).toMatch(
      /^node-pty 1\.1\.0, better-sqlite3 13\.0\.3, SQLite 3\.\d+\.\d+ \(linux-/u,
    );
    const autre = CIBLE_LOCALE === "linux-x64" ? "linux-arm64" : "linux-x64";
    await expect(construireHote(path.join(dossier, "autre"), { cibles: [autre] })).rejects.toThrow(
      `node-pty : pas de binaire précompilé pour ${autre}`,
    );
    await expect(construireHote(path.join(dossier, "autre"), { cibles: ["win32-x64"] })).rejects.toThrow(
      /cibles/,
    );
    expect(existsSync(path.join(dossier, "autre"))).toBe(false);
  }, 120_000);

  it("--empreinte : bundle à jour des sources du dépôt ; construction.json d'autres sources ou illisible refusé (code 1)", async () => {
    const env = environnement(await portLibre());
    const juste = lancer(env, ["--empreinte"]);
    expect(await juste.fin, juste.journal.join("")).toBe(0);
    expect(juste.journal.join("")).toBe(`à jour des sources (${fait.empreinte.slice(0, 12)})\n`);
    const fichier = path.join(fait.sortie, "construction.json");
    const original = readFileSync(fichier, "utf-8");
    try {
      writeFileSync(fichier, original.replace(fait.empreinte, "0".repeat(64)));
      const autre = lancer(env, ["--empreinte"]);
      expect(await autre.fin).toBe(1);
      expect(autre.journal.join("")).toMatch(
        /^construit pour d'autres sources \(000000000000 ≠ [0-9a-f]{12}\)\n$/u,
      );
      writeFileSync(fichier, "pas du json");
      const illisible = lancer(env, ["--empreinte"]);
      expect(await illisible.fin).toBe(1);
      expect(illisible.journal.join("")).toMatch(/^construction\.json illisible : /u);
    } finally {
      writeFileSync(fichier, original);
    }
  }, 120_000);

  it("démarré par Node : base de l'hôte ouverte (module natif du bundle), /health ouvert, porte de l'API, façade MCP (famille servie, famille non servie), amont obsolète signalé, terminal, SIGTERM : sortie 0", async () => {
    const port = await portLibre();
    const config = path.join(dossier, "fs-git.json");
    writeFileSync(config, JSON.stringify({ families: ["fs", "git"], db_path: path.join(dossier, "app.db") }));
    const { proc, journal, fin } = lancer(
      environnement(port, { TOOLHOST_CONFIG: config, TOOLHOST_MCP_UPSTREAM: "http://127.0.0.1:1/mcp" }),
    );
    try {
      let sante: Response | null = null;
      for (let i = 0; i < 200 && sante === null; i++) {
        try {
          sante = await fetch(`http://127.0.0.1:${port}/health`);
        } catch {
          await new Promise((ok) => setTimeout(ok, 50));
        }
      }
      expect(sante?.status, journal.join("")).toBe(200);
      expect(journal.join("")).not.toMatch(/init_db :/u);
      const ouverte = ouvrirBase({ backend: "sqlite", path: path.join(dossier, "app.db") });
      try {
        expect(await tableNames(ouverte)).toEqual(expect.arrayContaining(["ax_nodes", "schema_migrations"]));
      } finally {
        await ouverte.fermer();
      }
      expect(await sante?.json()).toMatchObject({
        ok: true,
        service: "elpis-toolhost",
        auth: true,
        families: ["fs", "git"],
      });
      expect(journal.join("")).toContain("mcp_upstream ignoré : elpis-tools n'existe plus");
      expect((await fetch(`http://127.0.0.1:${port}/manifest`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/manifest`, { headers: entetes() })).status).toBe(200);
      const sansJeton = await fetch(`http://127.0.0.1:${port}/mcp/fs`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(sansJeton.status).toBe(401);
      const office = await fetch(`http://127.0.0.1:${port}/mcp/office`, {
        method: "POST",
        headers: { authorization: `Bearer ${SVC}` },
        body: "{}",
      });
      expect([office.status, await office.json()]).toEqual([
        503,
        { detail: "MCP service unavailable: family not served by the tool host" },
      ]);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`, { headers: entetes() });
      let sortie = "";
      ws.on("message", (d: Buffer, binaire: boolean) => {
        if (binaire) sortie += d.toString("utf-8");
        else if (d.toString().includes("hello")) ws.send(Buffer.from("echo bun$((1+1))dle\r"));
      });
      for (let i = 0; i < 200 && !sortie.includes("bun2dle"); i++)
        await new Promise((ok) => setTimeout(ok, 25));
      expect(sortie, journal.join("")).toContain("bun2dle");
      ws.close();
    } finally {
      proc.kill("SIGTERM");
    }
    expect(await fin).toBe(0);
    expect(journal.join("")).toContain("arrêt terminé");
    expect(journal.join("")).not.toContain(SVC);
  }, 60_000);

  it("SIGHUP : arrêt gracieux puis sortie 75, la relance que demandent relance.sh et l'unité (SuccessExitStatus=75)", async () => {
    const port = await portLibre();
    const { proc, journal, fin } = lancer(environnement(port));
    let pret = false;
    for (let i = 0; i < 200 && !pret; i++) {
      pret = await fetch(`http://127.0.0.1:${port}/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (!pret) await new Promise((ok) => setTimeout(ok, 50));
    }
    expect(pret, journal.join("")).toBe(true);
    proc.kill("SIGHUP");
    expect(await fin, journal.join("")).toBe(75);
    expect(journal.join("")).toContain("SIGHUP reçu : arrêt gracieux");
    expect(journal.join("")).toContain("arrêt terminé");
  }, 60_000);

  it("--familles-natives : familles portées servies par l'hôte (configuration, puis --families), sans démarrer, office compris ; --familles-relayees : ligne vide ; familles_natives de toolhost.json ignoré", async () => {
    const env = environnement(await portLibre(), { LOCAL_MCP_TOOL_FAMILIES: "git,fs,office" });
    const sortie = async (args: string[], e = env): Promise<string> => {
      const p = lancer(e, args);
      expect(await p.fin).toBe(0);
      return p.journal.join("");
    };
    expect(await sortie(["--familles-relayees"])).toBe("\n");
    expect(await sortie(["--familles-natives"])).toBe("fs,git,office\n");
    expect(await sortie(["--familles-natives", "--families", "shell,office"])).toBe("shell,office\n");
    const avecCompte = await sortie(["--familles-natives", "--families", "shell,todo"]);
    expect(avecCompte).toContain("shell\n");
    expect(avecCompte).toContain("famille todo non servie par l'hôte d'outils : ignorée");
    writeFileSync(path.join(dossier, "relais.json"), JSON.stringify({ familles_natives: [] }));
    const relais = { ...env, TOOLHOST_CONFIG: path.join(dossier, "relais.json") };
    expect(await sortie(["--familles-natives"], relais)).toBe("fs,git,office\n");
  }, 60_000);

  it("stdio exporté (`commandeStdioHote`) : le bundle sert sa famille native sans port, les outils du golden", async () => {
    writeFileSync(
      path.join(dossier, "natives.json"),
      JSON.stringify({ familles_natives: ["fs"], db_path: path.join(dossier, "natives.db") }),
    );
    const racine = path.join(dossier, "racine");
    mkdirSync(path.join(racine, "apps", "toolhost"), { recursive: true });
    symlinkSync(fait.sortie, path.join(racine, "apps", "toolhost", "dist"));
    const restaurer = reglerEnvironnementManifeste({ racine });
    const repli = commandeStdioHote(["fs"]);
    restaurer();
    expect([repli.command, ...repli.args]).toEqual([
      process.execPath,
      path.join(racine, "apps", "toolhost", "dist", "main.mjs"),
      "--stdio",
      "--families",
      "fs",
    ]);
    const port = await portLibre();
    const client = new Client({ name: "essai-bundle", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: repli.command,
        args: repli.args,
        env: {
          ...(environnement(port, {
            TOOLHOST_CONFIG: path.join(dossier, "natives.json"),
          }) as Record<string, string>),
          ...repli.env,
        },
        stderr: "ignore",
      }),
    );
    try {
      expect((await client.listTools()).tools.map((o) => o.name)).toEqual([
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "manage_files",
        "code",
      ]);
      const essai = await new Promise<string>((fin) => {
        const s = connect(port, "127.0.0.1");
        s.once("connect", () => {
          s.destroy();
          fin("ouvert");
        });
        s.once("error", (e: NodeJS.ErrnoException) => fin(e.code ?? "erreur"));
      });
      expect(essai).toBe("ECONNREFUSED");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("refus du lanceur : bind hors boucle locale sans jeton (code 2)", async () => {
    const port = await portLibre();
    const sansJeton = lancer(environnement(port, { LOCAL_MCP_HOST: "0.0.0.0", LOCAL_MCP_TOKEN: "" }));
    expect(await sansJeton.fin).toBe(2);
    expect(sansJeton.journal.join("")).toContain("REFUS : bind 0.0.0.0");
  }, 60_000);
});
