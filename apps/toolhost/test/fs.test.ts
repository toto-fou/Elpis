// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fs.test.ts — famille fs de l'hôte : définition du golden, outils contre le vrai agent Python (sans conteneur), historique, gros texte en flux, client MCP du core. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { compilerSchema, meilleureErreur } from "@elpis/mcp";
import { AgentClient, AgentError, fileEntry } from "@elpis/fichiers";
import { construireTable, ouvrirEnMemoire, ServeurOutils, VerificateurJetons } from "@elpis/outils-mcp";
import type { Golden } from "@elpis/outils-mcp";
import goldenFs from "@elpis/outils-mcp/goldens/fs.json" with { type: "json" };
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientMcpHttp, pickToolPayload } from "../../core/src/outils/mcp/clients";
import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { demarrerTs } from "../../../packages/outils-mcp/test/differentiel";
import { Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { errAgent, ERREURS_AGENT, INJOIGNABLE, typeAffiche } from "../src/mcp/fs/acces";
import { CODES_MESSAGE, enrichirErreur, errFs, PHRASES } from "../src/mcp/fs/edition";
import { familleFs, outilsFs } from "../src/mcp/fs/famille";
import { parseSince } from "../src/mcp/fs/liste";
import { plusLongFragment } from "../src/mcp/fs/navigation";
import { b64Strict } from "../src/mcp/fs/texte";

let racine = "";
let nettoyer: () => void = () => undefined;
let bac: BacTest;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-fs-");
  bac = new BacTest(racine, "alice");
  vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(racine, "fh"));
  vi.stubEnv("FSTOOLS_FLOCK", "0");
  installerFabriqueEspace(async () => new Espace(bac.sandboxPath, 7, new AgentClient(bac)));
});

afterEach(async () => {
  installerFabriqueEspace(null);
  vi.unstubAllEnvs();
  await bac.arreter();
  nettoyer();
});

async function client(): Promise<{ c: Client; fermer: () => Promise<void> }> {
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("fs", outilsFs());
  const cnx = await ouvrirEnMemoire(serveur, { famille: "fs" });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(cnx.transport);
  return { c, fermer: () => cnx.fermer() };
}

const META = { username: "alice", user_id: "7" };

// Schémas de sortie du golden, compilés une fois : chaque appel des tests y est validé comme par le client du core.
const SORTIES = new Map(
  (goldenFs as Golden).outils.map((d) => [d["name"] as string, d["outputSchema"]] as const),
);
const VALIDEURS = new Map<string, ReturnType<typeof compilerSchema>>();

function erreurSortie(outil: string, contenu: unknown): string | null {
  const schema = SORTIES.get(outil);
  if (schema === undefined || schema === null) return null;
  if (!VALIDEURS.has(outil)) VALIDEURS.set(outil, compilerSchema(schema));
  const e = meilleureErreur(VALIDEURS.get(outil) ?? null, schema, contenu);
  return e === null ? null : `${outil} ${JSON.stringify(args0(contenu))} : ${e.message}`;
}

const args0 = (contenu: unknown): unknown => (contenu as Dict | undefined)?.["result"] ?? contenu;

async function appeler(c: Client, outil: string, args: Dict): Promise<Dict> {
  const rep = (await c.callTool({ name: outil, arguments: args, _meta: META })) as Dict;
  const sc = rep["structuredContent"] as Dict | undefined;
  if (!rep["isError"] && sc !== undefined) expect(erreurSortie(outil, sc)).toBeNull();
  const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
  return (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict);
}

const travail = (rel: string): string => path.join(bac.sandboxPath, rel);

describe("famille fs : définition et aides", () => {
  it("tools/list rend les définitions du golden Python, à l'identique et dans l'ordre", () => {
    const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    const fam = familleFs({});
    serveur.enregistrerFamille(fam.famille, fam.outils);
    expect(fam.famille).toBe("fs");
    expect(serveur.lister({ jeton: null, famille: "fs" }).tools).toEqual((goldenFs as Golden).outils);
  });

  it("base64 strict (binascii) : messages de Python", () => {
    expect(b64Strict("YWJj").toString()).toBe("abc");
    const msg = (s: string): string => {
      try {
        b64Strict(s);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(msg("YWJ")).toBe("Incorrect padding");
    expect(msg("YW Jj")).toBe("Only base64 data is allowed");
    expect(msg("YQ==YQ==")).toBe("Excess data after padding");
    expect(msg("Y===")).toBe(
      "Invalid base64-encoded string: number of data characters (1) cannot be 1 more than a multiple of 4",
    );
    expect(msg("é")).toBe(
      "'ascii' codec can't encode character '\\xe9' in position 0: ordinal not in range(128)",
    );
    expect(msg("=YQ")).toBe("Leading padding not allowed");
  });

  it("since : epoch, durée, date ISO locale ; illisible → null", () => {
    expect(parseSince("1700000000.5")).toBe(1700000000.5);
    expect(parseSince("2h", 10_000)).toBe(10_000 - 7200);
    expect(parseSince(" 3 D ", 1e6)).toBe(1e6 - 3 * 86400);
    expect(parseSince("2025-01-02")).toBe(new Date(2025, 0, 2).getTime() / 1000);
    expect(parseSince("2025-01-02T03:04:05")).toBe(new Date(2025, 0, 2, 3, 4, 5).getTime() / 1000);
    expect(parseSince("2025-02-30")).toBeNull();
    expect(parseSince("hier")).toBeNull();
  });

  it("fragment le plus long d'un symbole (préfiltre Robot)", () => {
    expect(plusLongFragment("Open Browser_To page")).toBe("Browser");
    expect(plusLongFragment("+++")).toBe("");
  });
});

describe.skipIf(!PYTHON)("outils fs : vrai agent, sans conteneur", () => {
  it("write_file puis read_file : conventions, sha, no-op, historique de session", async () => {
    const { c, fermer } = await client();
    try {
      const w = await appeler(c, "write_file", { path: "src/a.py", content: "def f():\n    return 1\n" });
      expect(w).toMatchObject({
        ok: true,
        path: "/work/src/a.py",
        action: "write",
        lines_added: 2,
        lines_removed: 0,
      });
      const r = await appeler(c, "read_file", { path: "/work/src/a.py" });
      expect(r).toMatchObject({
        ok: true,
        name: "a.py",
        type: "text",
        mime: "text/x-python",
        encoding: "utf-8",
        sha256: w["new_sha256"],
        line_endings: "lf",
        bom: false,
        total_lines: 2,
        format: "text",
        content: "1\tdef f():\n2\t    return 1",
      });
      const n = await appeler(c, "write_file", { path: "src/a.py", content: "def f():\n    return 1\n" });
      expect(n).toMatchObject({ action: "noop", unchanged: true });
      const h = await fileEntry(7, "src/a.py");
      expect(JSON.stringify(h?.["versions"])).toContain('"source":"assistant"');

      writeFileSync(travail("crlf.txt"), Buffer.from("\ufeffun\r\ndeux\r\n"));
      const ap = await appeler(c, "write_file", { path: "crlf.txt", content: "trois\n", mode: "append" });
      expect(ap).toMatchObject({ ok: true, line_endings: "crlf" });
      expect(readFileSync(travail("crlf.txt")).toString()).toBe("\ufeffun\r\ndeux\r\ntrois\r\n");
      const ec = await appeler(c, "write_file", { path: "crlf.txt", content: "x\ny\n" });
      expect(ec).toMatchObject({ bom: true, line_endings: "crlf" });
      expect(readFileSync(travail("crlf.txt"))).toEqual(Buffer.from("\ufeffx\r\ny\r\n"));

      writeFileSync(travail("latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      expect(await appeler(c, "write_file", { path: "latin.txt", content: "x" })).toMatchObject({
        ok: false,
        error: "encoding_mismatch",
        offset: 3,
      });
      expect(await appeler(c, "read_file", { path: "latin.txt" })).toMatchObject({
        lossy: true,
        encoding: "unknown (non-UTF-8, decoded with replacement)",
        content: "1\tcaf\ufffd",
      });
      expect(await appeler(c, "write_file", { path: "b.bin", mode: "b64", b64: "YWJ" })).toMatchObject({
        error: "bad_b64", // écart voulu au Python : code stable sans donnée
        message: "bad_b64: Incorrect padding",
      });
      const b = await appeler(c, "write_file", { path: "b.bin", mode: "b64", b64: "AAEC/w==" });
      expect(b).toMatchObject({ ok: true, bytes: 4, action: "b64_write" });
      expect(await appeler(c, "read_file", { path: "b.bin" })).toMatchObject({
        type: "binary",
        format: "base64",
        b64: "AAEC/w==",
      });
      expect(
        await appeler(c, "write_file", { path: "src/a.py", content: "z", expected_sha256: "0".repeat(64) }),
      ).toMatchObject({ error: "hash_mismatch", expected: "0".repeat(64), actual: w["new_sha256"] });
      expect(await appeler(c, "write_file", { path: "../x", content: "z" })).toMatchObject({
        ok: false,
        message: "path outside the sandbox root: '../x'",
      });
    } finally {
      await fermer();
    }
  });

  it("read_file : modes, lot, JSON, YAML, erreurs", async () => {
    writeFileSync(travail("l.txt"), Array.from({ length: 30 }, (_, i) => `ligne ${i + 1}`).join("\n"));
    writeFileSync(travail("c.json"), '{"b": [1, 2.5, 1e400], "a": "é"}');
    writeFileSync(travail("c.yaml"), "a: 1\nb: [x, yes, 1.5]\nc: {d: null}\n");
    const { c, fermer } = await client();
    try {
      expect(await appeler(c, "read_file", { path: "l.txt", head: 2 })).toMatchObject({
        format: "head",
        content: "1\tligne 1\n2\tligne 2",
        shown_lines: 2,
      });
      expect(
        await appeler(c, "read_file", { path: "l.txt", tail: 2, with_line_numbers: false }),
      ).toMatchObject({
        format: "tail",
        start_line: 29,
        content: "ligne 29\nligne 30",
      });
      expect(
        await appeler(c, "read_file", { path: "l.txt", grep: "ligne 1[05]$", grep_context: 1 }),
      ).toMatchObject({
        format: "grep",
        matches: 2,
        content: "9-ligne 9\n10:ligne 10\n11-ligne 11\n--\n14-ligne 14\n15:ligne 15\n16-ligne 16",
      });
      expect(
        await appeler(c, "read_file", {
          path: "l.txt",
          line_ranges: [
            [1, 2],
            [5, 5],
          ],
          with_line_numbers: false,
        }),
      ).toMatchObject({
        format: "ranges",
        content: "ligne 1\nligne 2\n...[lines 3-4 omitted]...\nligne 5",
        shown_lines: 3,
      });
      expect(await appeler(c, "read_file", { path: "l.txt", max_chars: 20 })).toMatchObject({
        format: "auto_truncated",
        head_lines: 30,
      });
      expect(await appeler(c, "read_file", { path: "c.json", format: "json" })).toMatchObject({
        format: "json",
        valid: true,
        content: '{\n  "b": [\n    1,\n    2.5,\n    Infinity\n  ],\n  "a": "é"\n}',
      });
      expect(await appeler(c, "read_file", { path: "c.yaml", format: "yaml" })).toMatchObject({
        format: "yaml",
        content: "a: 1\nb:\n- x\n- true\n- 1.5\nc:\n  d: null\n",
      });
      expect(await appeler(c, "read_file", { path: "l.txt", grep: "(a+)+" })).toMatchObject({
        error: "bad_regex", // écart voulu au Python : code stable sans donnée
      });
      const lot = await appeler(c, "read_file", { paths: ["l.txt", "absent.txt", "c.json"], head: 1 });
      expect(lot).toMatchObject({ action: "batch_read", count: 3, succeeded: 2, failed: 1 });
      expect(Object.keys(lot["files"] as Dict)).toEqual(["l.txt", "absent.txt", "c.json"]);
      expect((lot["files"] as Dict)["absent.txt"]).toMatchObject({
        error: "not_found",
        fix: "Check path; nearest existing parent: /work",
      });
      expect(await appeler(c, "read_file", { path: "." })).toMatchObject({ error: "is_directory" });
      expect(await appeler(c, "read_file", {})).toMatchObject({ error: "path_required" });
    } finally {
      await fermer();
    }
  });

  it("read_file en flux au-delà de 16 Mio : tête, queue, grep, plage, aperçu", async () => {
    const lignes = Array.from({ length: 400_000 }, (_, i) => `ligne numéro ${i + 1} ${"x".repeat(30)}`);
    writeFileSync(travail("gros.log"), `${lignes.join("\n")}\n`);
    const { c, fermer } = await client();
    try {
      const t = await appeler(c, "read_file", { path: "gros.log", tail: 2, with_line_numbers: false });
      expect(t).toMatchObject({ streamed: true, total_lines: 400_000, format: "tail", start_line: 399_999 });
      expect(t["content"]).toBe(lignes.slice(-2).join("\n"));
      const g = await appeler(c, "read_file", { path: "gros.log", grep: "numéro 123456 " });
      expect(g).toMatchObject({ format: "grep", matches: 1, content: `123456:${lignes[123_455] as string}` });
      const r = await appeler(c, "read_file", { path: "gros.log", start_line: 10, end_line: 11 });
      expect(r).toMatchObject({ format: "range", start: 10, end: 11, shown_lines: 2 });
      const a = await appeler(c, "read_file", { path: "gros.log", max_chars: 200 });
      expect(a).toMatchObject({ format: "auto_truncated", truncated: true });
      expect(String(a["content"])).toContain("lines omitted — file is");
      expect(await appeler(c, "read_file", { path: "gros.log", format: "json" })).toMatchObject({
        error: "too_large_for_mode",
      });
    } finally {
      await fermer();
    }
  }, 60_000);

  it("edit_file : str_replace, introuvable, lot multi, CRLF gardé, dry_run", async () => {
    writeFileSync(travail("e.py"), "a = 1\nb = 2\nc = 3\n");
    writeFileSync(travail("w.txt"), "un\r\ndeux\r\n");
    const { c, fermer } = await client();
    try {
      const r = await appeler(c, "edit_file", {
        path: "e.py",
        action: "str_replace",
        old_str: "b = 2",
        new_str: "b = 20",
      });
      expect(r).toMatchObject({ ok: true, lines_added: 1, lines_removed: 1, bytes_after: 19 });
      expect(String(r["diff"])).toContain("-b = 2\n+b = 20\n");
      expect(
        await appeler(c, "edit_file", { path: "e.py", action: "str_replace", old_str: "zz", new_str: "" }),
      ).toMatchObject({
        error: "old_str_not_found",
      });
      const m = await appeler(c, "edit_file", {
        path: "e.py",
        action: "multi",
        edits: [
          { action: "insert", start_line: 0, content: "# tête" },
          { action: "str_replace", old_str: "c = 3", new_str: "c = 30" },
        ],
      });
      expect(m).toMatchObject({ ok: true, applied: [{ index: 0 }, { index: 1 }] });
      expect(readFileSync(travail("e.py"), "utf8")).toBe("# tête\na = 1\nb = 20\nc = 30\n");
      const w = await appeler(c, "edit_file", {
        path: "w.txt",
        action: "replace",
        start_line: 2,
        end_line: 2,
        content: "DEUX\n",
      });
      expect(w).toMatchObject({ line_endings: "crlf" });
      expect(readFileSync(travail("w.txt"), "utf8")).toBe("un\r\nDEUX\r\n");
      const d = await appeler(c, "edit_file", {
        path: "w.txt",
        action: "delete",
        start_line: 1,
        dry_run: true,
      });
      expect(d).toMatchObject({ dry_run: true, lines_removed: 1 });
      expect(readFileSync(travail("w.txt"), "utf8")).toBe("un\r\nDEUX\r\n");
      expect(
        await appeler(c, "edit_file", { path: "rien.py", action: "insert", content: "x" }),
      ).toMatchObject({
        error: "not_found",
        fix: "Create with write_file first.",
      });
    } finally {
      await fermer();
    }
  });

  it("list_files : liste, glob, détails, recherche, fichier, résumé, curseur", async () => {
    mkdirSync(travail("src/sub"), { recursive: true });
    mkdirSync(travail("node_modules/x"), { recursive: true });
    writeFileSync(travail("src/a.py"), "import os\nVALEUR = 1\n");
    writeFileSync(travail("src/sub/b.py"), "print(VALEUR)\n");
    writeFileSync(travail("README.md"), "# Titre\n");
    writeFileSync(travail("node_modules/x/i.js"), "VALEUR\n");
    const { c, fermer } = await client();
    try {
      const l = await appeler(c, "list_files", {});
      expect(l).toMatchObject({
        action: "list",
        path: "/work",
        items: ["src/", "README.md"],
        truncated: false,
      });
      expect(l["excluded_default"]).toContain("node_modules");
      expect(await appeler(c, "list_files", { pattern: "**/*.py" })).toMatchObject({
        items: ["src/a.py", "src/sub/b.py"],
      });
      const s = await appeler(c, "list_files", { search_text: "valeur" });
      expect(s).toMatchObject({
        action: "grep",
        path: "/work",
        count: 2,
        hits: [
          { file: "src/a.py", line: 2, text: "VALEUR = 1" },
          { file: "src/sub/b.py", line: 1, text: "print(VALEUR)" },
        ],
      });
      expect(await appeler(c, "list_files", { path: "src/a.py", search_text: "valeur" })).toMatchObject({
        action: "grep",
        path: "/work/src/a.py",
        count: 1,
      });
      expect(await appeler(c, "list_files", { path: "src/a.py", details: true })).toMatchObject({
        action: "stat",
        name: "a.py",
        content_type: "text",
        encoding: "utf-8",
      });
      const r = await appeler(c, "list_files", {
        recursive: true,
        summary: true,
        details: true,
        exclude: ["sub"],
      });
      expect(r["summary"]).toMatchObject({ files: 3, dirs: 3, extensions: { ".py": 1, ".md": 1, ".js": 1 } });
      const p1 = await appeler(c, "list_files", { recursive: true, max_results: 2 });
      expect(p1).toMatchObject({ truncated: true, next_cursor: "src/sub" });
      expect(await appeler(c, "list_files", { recursive: true, cursor: "src/sub" })).toMatchObject({
        items: ["src/a.py", "src/sub/b.py", "README.md"],
      });
      expect(await appeler(c, "list_files", { since: "2000-01-01" })).toMatchObject({ count: 2 });
    } finally {
      await fermer();
    }
  });

  it("manage_files : mkdir, copie, déplacement, suppression (historique), chmod, lot", async () => {
    writeFileSync(travail("f.txt"), "contenu\n");
    symlinkSync("/etc", travail("lien"));
    const { c, fermer } = await client();
    try {
      expect(await appeler(c, "manage_files", { action: "mkdir", path: "d/e" })).toMatchObject({
        created: true,
      });
      const cp = await appeler(c, "manage_files", { action: "copy", path: "f.txt", dest: "d/" });
      expect(cp).toMatchObject({ ok: true, dest: "/work/d/f.txt", files_changed: [{ change: "created" }] });
      expect(
        await appeler(c, "manage_files", {
          action: "copy",
          path: "f.txt",
          dest: "d/f.txt",
          overwrite: false,
        }),
      ).toMatchObject({
        error: "dest_exists",
      });
      const mv = await appeler(c, "manage_files", { action: "move", path: "d/f.txt", dest: "g.txt" });
      expect(mv).toMatchObject({
        files_changed: [{ change: "moved", from: "/work/d/f.txt", path: "/work/g.txt" }],
      });
      const del = await appeler(c, "manage_files", { action: "delete", path: "g.txt" });
      expect(del).toMatchObject({
        files_changed: [{ change: "deleted", path: "/work/g.txt", new_sha256: null }],
      });
      chmodSync(travail("f.txt"), 0o644);
      expect(await appeler(c, "manage_files", { action: "chmod", path: "f.txt" })).toMatchObject({
        mode: "0o755",
      });
      expect(
        await appeler(c, "manage_files", { action: "delete", path: "lien", dry_run: true }),
      ).toMatchObject({
        type: "symlink",
      });
      expect(await appeler(c, "manage_files", { action: "delete", path: "/work" })).toMatchObject({
        error: "root_refused", // écart voulu au Python : code et texte en anglais
      });
      const lot = await appeler(c, "manage_files", {
        action: "batch_delete",
        paths: ["f.txt", "x.txt", "d"],
        recursive: true,
      });
      expect(lot).toMatchObject({ deleted: ["/work/f.txt", "/work/d"], count: 2 });
    } finally {
      await fermer();
    }
  });

  it("code : plan, symboles, définition et références sous un dossier", async () => {
    mkdirSync(travail("pkg"), { recursive: true });
    writeFileSync(
      travail("pkg/m.py"),
      "class A:\n    def run(self):\n        return helper()\n\ndef helper():\n    return 1\n",
    );
    writeFileSync(travail("pkg/n.py"), "from m import helper\nhelper()\n");
    const { c, fermer } = await client();
    try {
      const o = await appeler(c, "code", { action: "outline", path: "pkg/m.py" });
      expect(o).toMatchObject({ language: "python", summary: "1 classes, 1 functions, 1 methods" });
      expect(await appeler(c, "code", { action: "symbols", path: "pkg/m.py" })).toMatchObject({ count: 3 });
      expect(await appeler(c, "code", { action: "definition", symbol: "helper" })).toMatchObject({
        count: 1,
        files_scanned: 2,
        matches: [{ file: "pkg/m.py", line: 5 }],
      });
      expect(
        await appeler(c, "code", { action: "references", symbol: "helper", scope: "pkg" }),
      ).toMatchObject({
        count: 4,
      });
      expect(await appeler(c, "code", { action: "symbols", path: "pkg" })).toMatchObject({
        error: "not_a_file",
      });
    } finally {
      await fermer();
    }
  });

  it("client MCP du core (HTTP) → famille fs servie par l'hôte", async () => {
    const svc = "svc-fs-core-0123456789";
    const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    serveur.enregistrerFamille("fs", outilsFs());
    const cible = await demarrerTs({
      serveur,
      verificateur: new VerificateurJetons({ table: construireTable(svc, {}, {}) }),
      transport: "http",
    });
    const cl = new ClientMcpHttp(`${cible.base}/mcp/fs`, { Authorization: `Bearer ${svc}` });
    const signal = AbortSignal.timeout(30_000);
    try {
      await cl.connecter(signal);
      expect((await cl.listerOutils(signal)).map((o) => o["name"])).toEqual([
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "manage_files",
        "code",
      ]);
      const meta = { username: "alice", user_id: "7", chat_id: "c1" };
      const w = await cl.appelerOutil("write_file", { path: "n.md", content: "# x\n" }, { meta, signal });
      expect(pickToolPayload(w)).toMatchObject({ ok: true, path: "/work/n.md" });
      const r = await cl.appelerOutil("read_file", { path: "n.md" }, { meta, signal });
      expect(pickToolPayload(r)).toMatchObject({ ok: true, content: "1\t# x" });
    } finally {
      await cl.fermer();
      await cible.arreter();
    }
  });
});

describe("famille fs : codes stables, plages, type des liens, dossiers écartés", () => {
  it("codes d'erreur stables et sans donnée (écart voulu au Python : plus de slug du message)", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("l.txt"), "a\nb\n");
    expect((await appeler(c, "read_file", { path: "/etc/passwd" }))["error"]).toBe("path_outside_sandbox");
    expect((await appeler(c, "read_file", { path: "l.txt", grep: "(" }))["error"]).toBe("bad_regex");
    expect((await appeler(c, "read_file", { path: "../x" }))["error"]).toBe("path_outside_sandbox");
    const i = await appeler(c, "edit_file", {
      path: "l.txt",
      action: "insert",
      start_line: -5,
      content: "x",
    });
    expect(i["error"]).toBe("invalid_line");
    await fermer();
  });

  it("expected_sha256 mal formé : bad_sha256 ; valide mais périmé : hash_mismatch", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("l.txt"), "a\nb\n");
    for (const outil of ["edit_file", "write_file"]) {
      const args: Dict =
        outil === "edit_file"
          ? { path: "l.txt", action: "str_replace", old_str: "a", new_str: "z", expected_sha256: "deadbeef" }
          : { path: "l.txt", content: "q", expected_sha256: "deadbeef" };
      expect((await appeler(c, outil, args))["error"]).toBe("bad_sha256");
      expect((await appeler(c, outil, { ...args, expected_sha256: "0".repeat(64) }))["error"]).toBe(
        "hash_mismatch",
      );
    }
    expect(readFileSync(travail("l.txt"), "utf-8")).toBe("a\nb\n");
    await fermer();
  });

  it("line_ranges : plages chevauchantes ou contiguës fusionnées, bornes ramenées et signalées", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("l.txt"), Array.from({ length: 20 }, (_, k) => `line${k + 1}`).join("\n") + "\n");
    const r = await appeler(c, "read_file", {
      path: "l.txt",
      line_ranges: [
        [10, 12],
        [11, 13],
        [14, 15],
        [19, 99],
        [50, 60],
      ],
    });
    expect(r["spans"]).toEqual([
      { start: 10, end: 15, lines: 6 },
      { start: 19, end: 20, lines: 2 },
    ]);
    const lignes = String(r["content"])
      .split("\n")
      .filter((l) => /^\d+\t/u.test(l));
    expect(lignes.map((l) => l.split("\t")[0])).toEqual(["10", "11", "12", "13", "14", "15", "19", "20"]);
    expect(r["shown_lines"]).toBe(8);
    const aj = (r["adjusted"] as string[]).join("|");
    expect(aj).toMatch(/merged/u);
    expect(aj).toMatch(/clamped to 20/u);
    expect(aj).toMatch(/dropped/u);
    const simple = await appeler(c, "read_file", { path: "l.txt", line_ranges: [[1, 2]] });
    expect(simple["adjusted"]).toBeUndefined();
    await fermer();
  });

  it("type MIME d'un lien interne tiré de sa cible", async () => {
    const { c, fermer } = await client();
    mkdirSync(travail("tmp"), { recursive: true });
    writeFileSync(travail("tmp/notes.md"), "# t\n");
    symlinkSync("notes.md", travail("tmp/lien"));
    expect((await appeler(c, "read_file", { path: "tmp/lien" }))["mime"]).toBe("text/markdown");
    expect((await appeler(c, "read_file", { path: "tmp/notes.md" }))["mime"]).toBe("text/markdown");
    await fermer();
  });

  it("list_files : excluded_default seulement si des dossiers sont vraiment écartés, hint exact en anglais", async () => {
    const { c, fermer } = await client();
    mkdirSync(travail("p/node_modules/x"), { recursive: true });
    mkdirSync(travail("q"), { recursive: true });
    writeFileSync(travail("p/node_modules/x/i.js"), "1");
    writeFileSync(travail("p/a.txt"), "1");
    writeFileSync(travail("q/a.txt"), "1");
    const propre = await appeler(c, "list_files", { path: "q" });
    expect(propre["excluded_default"]).toBeUndefined();
    expect(propre["hint_excluded"]).toBeUndefined();
    const ecarte = await appeler(c, "list_files", { path: "p", recursive: true });
    expect(ecarte["items"]).toEqual(["a.txt"]);
    expect(ecarte["excluded_default"]).toEqual(["node_modules"]);
    expect(String(ecarte["hint_excluded"])).toMatch(/^Dependency\/build folders skipped by default/u);
    const vide = await appeler(c, "list_files", { path: "p", exclude: [] });
    expect(vide["items"]).toEqual(["a.txt"]);
    const inclus = await appeler(c, "list_files", { path: "p", exclude: [".git"] });
    expect(inclus["items"]).toEqual(["node_modules/", "a.txt"]);
    expect(inclus["excluded_default"]).toBeUndefined();
    await fermer();
  });
});

describe("famille fs : lot 2 (lignes longues, binaires, .git, ergonomie, anglais)", () => {
  it("B-02 : lignes affichées coupées à 2000 car. avec marqueur et hint ; max_chars explicite les rend entières", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("mini.js"), `${"x".repeat(5000)}\nfin\n`);
    for (const args of [
      { head: 1 },
      { tail: 2 },
      { start_line: 1, end_line: 1 },
      { line_ranges: [[1, 1]] },
      { grep: "^x" },
    ]) {
      const r = await appeler(c, "read_file", { path: "mini.js", ...args });
      expect(String(r["content"])).toContain("…[+3000 chars]");
      expect(String(r["content"]).length).toBeLessThan(2100);
      expect(String(r["hint"])).toContain("max_chars above 20000");
    }
    const entiere = await appeler(c, "read_file", { path: "mini.js", head: 1, max_chars: 30000 });
    expect(String(entiere["content"])).not.toContain("…[+");
    expect(String(entiere["content"]).length).toBeGreaterThan(5000);
    await fermer();
  });

  it("B-03 : binaire > 4 Ko sans argument = hexdump de 512 octets ; base64 sur demande", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("g.bin"), Buffer.from(Array.from({ length: 5000 }, (_, k) => (k * 7) % 256)));
    writeFileSync(travail("p.bin"), Buffer.from(Array.from({ length: 4096 }, (_, k) => (k * 7) % 256)));
    const g = await appeler(c, "read_file", { path: "g.bin" });
    expect(g["format"]).toBe("preview");
    expect((g["preview_hex"] as string).length).toBe(1024);
    expect(g["b64"]).toBeUndefined();
    expect(String(g["hint"])).toContain("offset/length");
    expect((await appeler(c, "read_file", { path: "p.bin" }))["format"]).toBe("base64");
    expect((await appeler(c, "read_file", { path: "g.bin", offset: 0, length: 16 }))["format"]).toBe(
      "bytes_range",
    );
    expect((await appeler(c, "read_file", { path: "g.bin", as_base64: true }))["format"]).toBe("base64");
    await fermer();
  });

  it("écriture dans .git refusée (toute profondeur, toute casse), sauf info/exclude en write/edit", async () => {
    const { c, fermer } = await client();
    mkdirSync(travail("r/.git/info"), { recursive: true });
    writeFileSync(travail("r/.git/config"), "[core]\n");
    writeFileSync(travail("r/.git/info/exclude"), "a\n");
    writeFileSync(travail("r/f.txt"), "x");
    for (const p of ["r/.git/config", "r/.GIT/hooks/pre-commit", ".git/x", "a/b/.Git/y"]) {
      expect((await appeler(c, "write_file", { path: p, content: "z" }))["error"]).toBe("path_in_git_dir");
    }
    expect(
      (
        await appeler(c, "edit_file", {
          path: "r/.git/config",
          action: "str_replace",
          old_str: "core",
          new_str: "c",
        })
      )["error"],
    ).toBe("path_in_git_dir");
    expect((await appeler(c, "manage_files", { action: "delete", path: "r/.git/config" }))["error"]).toBe(
      "path_in_git_dir",
    );
    expect((await appeler(c, "manage_files", { action: "mkdir", path: "r/.git/z" }))["error"]).toBe(
      "path_in_git_dir",
    );
    expect((await appeler(c, "manage_files", { action: "chmod", path: "r/.git/config" }))["error"]).toBe(
      "path_in_git_dir",
    );
    expect(
      (await appeler(c, "manage_files", { action: "copy", path: "r/f.txt", dest: "r/.git/f.txt" }))["error"],
    ).toBe("path_in_git_dir");
    expect(
      (await appeler(c, "manage_files", { action: "move", path: "r/f.txt", dest: "r/.git/f.txt" }))["error"],
    ).toBe("path_in_git_dir");
    expect(
      (await appeler(c, "manage_files", { action: "batch_delete", paths: ["r/f.txt", "r/.git/config"] }))[
        "error"
      ],
    ).toBe("path_in_git_dir");
    expect(readFileSync(travail("r/f.txt"), "utf-8")).toBe("x");
    expect(readFileSync(travail("r/.git/config"), "utf-8")).toBe("[core]\n");
    expect((await appeler(c, "write_file", { path: "r/.git/info/exclude", content: "b\n" }))["ok"]).toBe(
      true,
    );
    expect(
      (
        await appeler(c, "edit_file", {
          path: "r/.git/info/exclude",
          action: "str_replace",
          old_str: "b",
          new_str: "c",
        })
      )["ok"],
    ).toBe(true);
    expect(
      (await appeler(c, "manage_files", { action: "delete", path: "r/.git/info/exclude" }))["error"],
    ).toBe("path_in_git_dir");
    await fermer();
  });

  it("dossier git sur le chemin réel : lien vers .git, dépôt nu, copie d'un .git dans un dossier existant", async () => {
    const { c, fermer } = await client();
    mkdirSync(travail("r/.git/hooks"), { recursive: true });
    mkdirSync(travail("r/.git/info"), { recursive: true });
    writeFileSync(travail("r/.git/config"), "[core]\n");
    writeFileSync(travail("r/.git/info/exclude"), "a\n");
    symlinkSync("r/.git", travail("g"));
    symlinkSync("r/.git/hooks/pre-commit", travail("r/.git/info/x"));
    for (const d of ["nu.git/objects", "nu.git/refs"]) mkdirSync(travail(d), { recursive: true });
    writeFileSync(travail("nu.git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(travail("b"), { recursive: true });
    writeFileSync(travail("f.txt"), "x");
    for (const p of ["g/hooks/pre-commit", "nu.git/hooks/pre-commit", "nu.git/config"])
      expect([p, (await appeler(c, "write_file", { path: p, content: "z" }))["error"]]).toEqual([
        p,
        "path_in_git_dir",
      ]);
    const edit = { action: "str_replace", old_str: "core", new_str: "c" };
    expect((await appeler(c, "edit_file", { path: "g/config", ...edit }))["error"]).toBe("path_in_git_dir");
    for (const dest of ["g/hooks/x", "nu.git/x"])
      expect((await appeler(c, "manage_files", { action: "move", path: "f.txt", dest }))["error"]).toBe(
        "path_in_git_dir",
      );
    expect((await appeler(c, "manage_files", { action: "delete", path: "g/config" }))["error"]).toBe(
      "path_in_git_dir",
    );
    expect(
      (await appeler(c, "manage_files", { action: "copy", path: "r/.git", dest: "b/", recursive: true }))[
        "error"
      ],
    ).toBe("path_in_git_dir");
    expect(existsSync(travail("b/.git"))).toBe(false);
    expect(existsSync(travail("r/.git/hooks/pre-commit"))).toBe(false);
    expect(readFileSync(travail("r/.git/config"), "utf-8")).toBe("[core]\n");
    expect((await appeler(c, "write_file", { path: "g/info/exclude", content: "b\n" }))["ok"]).toBe(true);
    expect(readFileSync(travail("r/.git/info/exclude"), "utf-8")).toBe("b\n");
    expect((await appeler(c, "write_file", { path: "r/.git/info/x", content: "z" }))["error"]).toBe(
      "path_in_git_dir",
    );
    expect((await appeler(c, "write_file", { path: "f.txt", content: "y" }))["ok"]).toBe(true);
    await fermer();
  });

  it("écriture par un lien interne au bac : verrou et contrôles résolus par l'agent, jamais sur l'hôte (invariant 9)", async () => {
    const { c, fermer } = await client();
    mkdirSync(travail("src"), { recursive: true });
    writeFileSync(travail("src/a.txt"), "a = 1\n");
    symlinkSync("src", travail("s"));
    expect((await appeler(c, "write_file", { path: "s/b.txt", content: "b\n" }))["ok"]).toBe(true);
    const edit = { action: "str_replace", old_str: "a = 1", new_str: "a = 2" };
    expect((await appeler(c, "edit_file", { path: "s/a.txt", ...edit }))["ok"]).toBe(true);
    expect(
      (await appeler(c, "manage_files", { action: "copy", path: "s/a.txt", dest: "s/c.txt" }))["ok"],
    ).toBe(true);
    expect([
      readFileSync(travail("src/a.txt"), "utf-8"),
      readFileSync(travail("src/b.txt"), "utf-8"),
      readFileSync(travail("src/c.txt"), "utf-8"),
    ]).toEqual(["a = 2\n", "b\n", "a = 2\n"]);
    await fermer();
  });

  it("B-09 hint, B-11 warning, B-14 libellé, B-15 occurrences", async () => {
    const { c, fermer } = await client();
    mkdirSync(travail("d/sub"), { recursive: true });
    writeFileSync(travail("d/sub/a.py"), "1");
    const vide = await appeler(c, "list_files", { path: "d", pattern: "*.py" });
    expect(vide["count"]).toBe(0);
    expect(vide["hint"]).toBe("0 match at depth 1; retry with recursive=True");
    expect(
      (await appeler(c, "list_files", { path: "d", pattern: "*.py", recursive: true }))["hint"],
    ).toBeUndefined();
    const w = await appeler(c, "list_files", { path: "d", since: "bogus" });
    expect(w["ok"]).toBe(true);
    expect(String(w["warning"])).toMatch(/not understood.*30m, 1h, 7d, 2w/su);
    expect((await appeler(c, "list_files", { path: "d", since: "1h" }))["warning"]).toBeUndefined();
    writeFileSync(travail("l.txt"), Array.from({ length: 20 }, (_, k) => `line${k + 1}`).join("\n") + "\n");
    const m = await appeler(c, "edit_file", {
      path: "l.txt",
      action: "multi",
      edits: [
        { action: "str_replace", old_str: "line1\n", new_str: "L1\n" },
        { action: "str_replace", old_str: "nope", new_str: "z" },
      ],
    });
    expect(m["message"]).toContain("edit #2 (index 1) failed");
    expect(m["failed_index"]).toBe(1);
    const amb = await appeler(c, "edit_file", {
      path: "l.txt",
      action: "str_replace",
      old_str: "line",
      new_str: "z",
    });
    expect(amb["error"]).toBe("old_str_ambiguous");
    expect(amb["total"]).toBe(20);
    expect(amb["occurrences"]).toHaveLength(5);
    expect((amb["occurrences"] as Dict[])[1]).toEqual({ line: 2, text: "line2" });
    expect(String(amb["message"])).toContain("lines 1, 2, 3, 4, 5, …");
    await fermer();
  });

  it("B-23 : files_changed sans détail sous .git/, agrégé par dossier au-delà de 10 entrées", async () => {
    const { c, fermer } = await client();
    const { execSync } = await import("node:child_process");
    mkdirSync(travail("repo"), { recursive: true });
    writeFileSync(travail("repo/a.txt"), "a");
    execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=n commit -qm x", {
      cwd: travail("repo"),
    });
    const x = await appeler(c, "manage_files", { action: "batch_delete", paths: ["repo"], recursive: true });
    const fc = x["files_changed"] as Dict[];
    expect(fc.filter((e) => String(e["path"]).includes(".git/") && e["files"] === undefined)).toEqual([]);
    expect(fc.find((e) => e["path"] === "/work/repo/.git/")?.["files"]).toBeGreaterThan(5);
    mkdirSync(travail("gros/s"), { recursive: true });
    for (let k = 0; k < 12; k++) writeFileSync(travail(`gros/s/f${k}.txt`), `${k}`);
    const y = await appeler(c, "manage_files", { action: "delete", path: "gros", recursive: true });
    expect(y["files_changed"]).toEqual([{ path: "/work/gros/s/", change: "deleted", files: 12 }]);
    await fermer();
  });

  it("B-13 : textes destinés au modèle en anglais", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("l.txt"), "a\nb\n");
    const r = await appeler(c, "edit_file", {
      path: "l.txt",
      action: "str_replace",
      old_str: "zzz",
      new_str: "q",
    });
    expect(String(r["fix"])).toMatch(/^Re-read the file/u);
    const root = await appeler(c, "manage_files", { action: "delete", path: "." });
    expect(root["error"]).toBe("root_refused");
    expect(String(root["message"])).toMatch(/^The sandbox root/u);
    expect(String(root["fix"])).toMatch(/^Act on an item INSIDE/u);
    writeFileSync(travail("g.txt"), "y".repeat(100));
    const t = await appeler(c, "read_file", { path: "g.txt", grep: "y", max_chars: 40 });
    expect(JSON.stringify(t)).not.toMatch(/tronqué|caractères/u);
    expect(String(t["content"])).toContain("[truncated:");
    await fermer();
  });
});

describe("famille fs : retest harnais n°2 (N-02, B-07, B-23, B-34, N-07, N-15, N-09, N-05)", () => {
  it("N-02 : read_file(paths) refuse un chemin sortant sans perdre les valides", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("a.txt"), "A\n");
    writeFileSync(travail("b.txt"), "B\n");
    const r = await appeler(c, "read_file", { paths: ["a.txt", "b.txt", "../../etc/hostname"] });
    expect(r).toMatchObject({ ok: true, count: 3, succeeded: 2, failed: 1 });
    const f = r["files"] as Record<string, Dict>;
    expect(f["a.txt"]).toMatchObject({ ok: true });
    expect(f["../../etc/hostname"]).toMatchObject({ ok: false, error: "path_outside_sandbox" });
    expect(String(f["../../etc/hostname"]?.["fix"])).toMatch(/inside \/work/u);
    await fermer();
  });

  it("B-07 : copy d'un lien sortant → path_outside_sandbox avec fix, plus de « Verify path »", async () => {
    const { c, fermer } = await client();
    symlinkSync("/etc/hostname", travail("sortant"));
    const r = await appeler(c, "manage_files", { action: "copy", path: "sortant", dest: "x.txt" });
    expect(r).toMatchObject({ ok: false, error: "path_outside_sandbox" });
    expect(String(r["fix"])).toMatch(/leaves \/work/u);
    const v = await appeler(c, "read_file", { path: "a\0b" });
    expect(String(v["fix"])).not.toMatch(/Verify path/u);
    expect(v["error"]).toBe("invalid_path");
    expect(String(v["fix"])).toMatch(/control characters/u);
    await fermer();
  });

  it("B-23 : copy d'un dépôt résume .git/ en une entrée comptée", async () => {
    const { c, fermer } = await client();
    mkdirSync(travail("depot/.git/objects"), { recursive: true });
    for (let k = 0; k < 30; k++) writeFileSync(travail(`depot/.git/objects/o${k}`), `x${k}`);
    writeFileSync(travail("depot/main.txt"), "m\n");
    const r = await appeler(c, "manage_files", { action: "copy", path: "depot", dest: "copie" });
    const fc = r["files_changed"] as Dict[];
    expect(fc).toHaveLength(2);
    expect(fc).toContainEqual({ path: "/work/copie/.git/", change: "created", files: 30 });
    expect(fc.some((x) => String(x["path"]).endsWith("main.txt"))).toBe(true);
    await fermer();
  });

  it("B-34 / N-07 : message en phrase anglaise (code court inchangé), fix de hash_mismatch adapté", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("l.txt"), "a\n");
    mkdirSync(travail("d"));
    const nf = await appeler(c, "read_file", { path: "absent.txt" });
    expect(nf).toMatchObject({ error: "not_found" });
    expect(String(nf["message"])).toBe("No such file or directory '/work/absent.txt'.");
    const dir = await appeler(c, "read_file", { path: "d" });
    expect(String(dir["message"])).toMatch(/is a directory/u);
    writeFileSync(travail("l2.txt"), "b\n");
    const dx = await appeler(c, "manage_files", {
      action: "copy",
      path: "l.txt",
      dest: "l2.txt",
      overwrite: false,
    });
    expect(dx).toMatchObject({ error: "dest_exists" });
    expect(String(dx["message"])).toMatch(/already exists/u);
    const bad = await appeler(c, "write_file", { path: "l.txt", content: "q", expected_sha256: "zz" });
    expect(String(bad["message"])).toMatch(/64-character/u);
    const hm = await appeler(c, "write_file", {
      path: "l.txt",
      content: "q",
      expected_sha256: "0".repeat(64),
    });
    expect(hm["error"]).toBe("hash_mismatch");
    expect(String(hm["message"])).toMatch(/differs from expected_sha256/u);
    expect(String(hm["fix"])).not.toMatch(/changed since read\. Re-read/u);
    expect(String(hm["fix"])).toMatch(/read_file to get the current sha256/u);
    await fermer();
  });

  it("N-15 : auto_format dit si le formateur est absent, en échec ou appliqué", async () => {
    const { c, fermer } = await client();
    const bin = path.join(racine, "faux-bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "black"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(bin, "black"), 0o755);
    writeFileSync(path.join(bin, "yamlfmt"), "#!/bin/sh\ncat\n");
    chmodSync(path.join(bin, "yamlfmt"), 0o755);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    writeFileSync(travail("bad.py"), "x = 1\n");
    writeFileSync(travail("c.sh"), "echo a\n");
    writeFileSync(travail("y.yaml"), "a: 1\n");
    const edit = (p: string): Promise<Dict> =>
      appeler(c, "edit_file", {
        path: p,
        action: "str_replace",
        old_str: p === "y.yaml" ? "1" : "x",
        new_str: p === "y.yaml" ? "2" : "z",
        auto_format: true,
      });
    const echec = await edit("bad.py");
    expect(echec["format"]).toMatchObject({ tool: "black", status: "failed" });
    expect(echec["ok"]).toBe(true);
    const absent = await appeler(c, "edit_file", {
      path: "c.sh",
      action: "insert",
      start_line: -1,
      content: "\n",
      auto_format: true,
    });
    expect(absent["format"]).toMatchObject({ tool: "shfmt", status: "unavailable" });
    const bon = await edit("y.yaml");
    expect(bon["format"]).toMatchObject({ tool: "yamlfmt", status: "applied" });
    expect(bon["formatter"]).toBe("yamlfmt");
    await fermer();
  });

  it("N-09 : references sans fichier parcouru explique les extensions", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("n.txt"), "two\n");
    writeFileSync(travail("a.py"), "two = 1\n");
    const vide = await appeler(c, "code", { action: "references", symbol: "two", include_glob: "*.txt" });
    expect(vide).toMatchObject({ files_scanned: 0 });
    expect(String(vide["hint"])).toMatch(/only these extensions.*\.py/u);
    const plein = await appeler(c, "code", { action: "references", symbol: "two" });
    expect(plein["hint"]).toBeUndefined();
    await fermer();
  });

  it("N-05 : outline Python fidèle (défauts, annotations, retour) et saut de titre Markdown signalé", async () => {
    const { c, fermer } = await client();
    writeFileSync(travail("s.py"), "def f(a, b=2, *, c: int = 3, **k) -> int:\n    pass\n");
    writeFileSync(travail("t.md"), "# T\n### trop bas\n");
    const py = await appeler(c, "code", { action: "outline", path: "s.py" });
    expect(JSON.stringify(py)).toContain("def f(a, b=2, *, c: int = 3, **k) -> int");
    const md = await appeler(c, "code", { action: "outline", path: "t.md" });
    expect(JSON.stringify(md)).toContain("Heading level jumps from h1 to h3.");
    await fermer();
  });
});

/** Arbre du harnais (`tmp/x`) : 2 dossiers, 1 fichier, 5 liens (dedans, dehors, cassé), 1 FIFO, 1 socket ; `dehors` hors du bac. */
function arbreLiens(): string {
  const dehors = path.join(racine, "dehors");
  mkdirSync(dehors, { recursive: true });
  writeFileSync(path.join(dehors, "hostname"), "secret\n");
  mkdirSync(travail("tmp/x/d1/deep"), { recursive: true });
  mkdirSync(travail("tmp/x/d2"), { recursive: true });
  writeFileSync(travail("tmp/x/real.txt"), "hello\n");
  for (const d of ["d1", "d1/deep", "d2"])
    writeFileSync(travail(`tmp/x/${d}/a.py`), "def zed():\n    return 1\n");
  symlinkSync("real.txt", travail("tmp/x/link_file_in"));
  symlinkSync("d1", travail("tmp/x/link_dir_in"));
  symlinkSync(path.join(dehors, "hostname"), travail("tmp/x/link_file_out"));
  symlinkSync(dehors, travail("tmp/x/link_dir_out"));
  symlinkSync("nope", travail("tmp/x/dangling"));
  execFileSync(
    PYTHON as string,
    ["-c", "import os,socket; os.mkfifo('fifo1'); socket.socket(socket.AF_UNIX).bind('sock1')"],
    {
      cwd: travail("tmp/x"),
    },
  );
  return dehors;
}

describe("type affiché d'une entrée de l'agent (harnais B-10)", () => {
  it("fifo, socket, périphérique (caractère ou bloc) ; spécial sans genre exact (agent ancien) ou inconnu : special", () => {
    expect(["fifo", "socket", "char_device", "block_device"].map((x) => typeAffiche("other", x))).toEqual([
      "fifo",
      "socket",
      "device",
      "device",
    ]);
    expect([typeAffiche("other"), typeAffiche("other", "door"), typeAffiche("other", "dir")]).toEqual([
      "special",
      "special",
      "special",
    ]);
    expect([typeAffiche("link"), typeAffiche("dir"), typeAffiche("file", "fifo"), typeAffiche("?")]).toEqual([
      "symlink",
      "dir",
      "file",
      "file",
    ]);
    expect([typeAffiche("fifo"), typeAffiche("char_device")]).toEqual(["fifo", "device"]);
  });
});

describe.skipIf(!PYTHON)("famille fs : retest harnais n°5 (B-10, B-12/B-33, B-34)", () => {
  it("B-10 : list_files montre liens (cible, dedans/dehors, cassé) et fichiers spéciaux sans jamais les suivre", async () => {
    const { c, fermer } = await client();
    const dehors = arbreLiens();
    const d = await appeler(c, "list_files", { path: "tmp/x", details: true });
    const parNom = new Map((d["items"] as Dict[]).map((x) => [x["name"], x]));
    expect(d["count"]).toBe(10);
    expect([...parNom.keys()].sort()).toEqual([
      "d1",
      "d2",
      "dangling",
      "fifo1",
      "link_dir_in",
      "link_dir_out",
      "link_file_in",
      "link_file_out",
      "real.txt",
      "sock1",
    ]);
    expect(parNom.get("link_file_in")).toMatchObject({
      type: "symlink",
      target: "real.txt",
      target_in_sandbox: true,
      broken: false,
      rel: "tmp/x/link_file_in",
    });
    expect(parNom.get("link_dir_in")).toMatchObject({ type: "symlink", target: "d1", broken: false });
    expect(parNom.get("link_file_out")).toMatchObject({
      type: "symlink",
      target: path.join(dehors, "hostname"),
      target_in_sandbox: false,
      broken: null,
    });
    expect(parNom.get("link_dir_out")).toMatchObject({
      type: "symlink",
      target: dehors,
      target_in_sandbox: false,
    });
    expect(parNom.get("dangling")).toMatchObject({
      type: "symlink",
      target: "nope",
      target_in_sandbox: true,
      broken: true,
    });
    expect(parNom.get("fifo1")?.["type"]).toBe("fifo");
    expect(parNom.get("sock1")?.["type"]).toBe("socket");
    expect(parNom.get("real.txt")?.["type"]).toBe("file");
    expect(parNom.get("d1")?.["type"]).toBe("dir");

    const court = await appeler(c, "list_files", { path: "tmp/x" });
    expect(court["items"]).toEqual([
      "d1/", "d2/", "dangling", "fifo1", "link_dir_in", "link_dir_out", "link_file_in", "link_file_out", "real.txt", "sock1",
    ]); // prettier-ignore
    expect(court["symlinks"]).toMatchObject({
      link_file_in: { target: "real.txt", target_in_sandbox: true, broken: false },
      link_dir_out: { target: dehors, target_in_sandbox: false, broken: null },
      dangling: { target: "nope", broken: true },
    });
    expect(court["special_files"]).toEqual(["fifo1", "sock1"]);

    const motif = await appeler(c, "list_files", { path: "tmp/x", recursive: true, pattern: "link*" });
    expect(motif["items"]).toEqual(["link_dir_in", "link_dir_out", "link_file_in", "link_file_out"]);
    const tout = await appeler(c, "list_files", { path: "tmp/x", recursive: true, include_hidden: true });
    expect((tout["items"] as string[]).filter((x) => x.startsWith("link_dir_"))).toEqual([
      "link_dir_in",
      "link_dir_out",
    ]);
    expect((tout["items"] as string[]).filter((x) => x.includes("link_dir_") && x.includes("/"))).toEqual([]);
    const resume = await appeler(c, "list_files", { path: "tmp/x", recursive: true, summary: true });
    expect(resume["summary"]).toMatchObject({
      total_items: 14,
      files: 4,
      dirs: 3,
      symlinks: 5,
      special_files: 2,
    });

    const grep = await appeler(c, "list_files", { path: "tmp/x", search_text: "hello" });
    expect((grep["hits"] as Dict[]).map((h) => h["file"])).toEqual(["real.txt"]);
    expect(
      JSON.stringify(await appeler(c, "list_files", { path: "tmp/x", search_text: "secret" })),
    ).not.toContain("secret\\n");

    const stat = await appeler(c, "list_files", { path: "tmp/x/link_file_in" });
    expect(stat).toMatchObject({ action: "stat", type: "file", symlink: true, target: "real.txt" });
    const viaLien = await appeler(c, "list_files", { path: "tmp/x/link_dir_in" });
    expect(viaLien).toMatchObject({ action: "list", symlink: true, target: "d1", items: ["deep/", "a.py"] });
    expect(await appeler(c, "read_file", { path: "tmp/x/link_file_out" })).toMatchObject({
      ok: false,
      error: "not_a_regular_file",
    });
    await fermer();
  });

  it("B-12 / B-33 : code et recherche de list_files ajoutent rel (racine du bac) et path, utilisables par read_file", async () => {
    const { c, fermer } = await client();
    arbreLiens();
    const attendu = ["tmp/x/d1/a.py", "tmp/x/d1/deep/a.py", "tmp/x/d2/a.py"];
    for (const scope of ["tmp/x", "", "/work/tmp/x/"]) {
      const r = await appeler(c, "code", {
        action: "definition",
        symbol: "zed",
        ...(scope ? { scope } : {}),
      });
      const m = r["matches"] as Dict[];
      expect(m.map((x) => x["rel"])).toEqual(attendu);
      expect(m.map((x) => x["path"])).toEqual(attendu.map((x) => `/work/${x}`));
    }
    const profond = await appeler(c, "code", { action: "references", symbol: "zed", scope: "tmp/x/d1/deep" });
    expect(profond["matches"]).toEqual([
      {
        file: "a.py",
        rel: "tmp/x/d1/deep/a.py",
        path: "/work/tmp/x/d1/deep/a.py",
        line: 1,
        text: "def zed():",
      },
    ]);
    for (const x of (profond["matches"] as Dict[]).map((h) => String(h["rel"])))
      expect(await appeler(c, "read_file", { path: x })).toMatchObject({ ok: true });
    const grep = await appeler(c, "list_files", { path: "tmp/x", search_text: "hello" });
    expect(grep["hits"]).toEqual([
      { file: "real.txt", rel: "tmp/x/real.txt", path: "/work/tmp/x/real.txt", line: 1, text: "hello" },
    ]);
    const un = await appeler(c, "list_files", { path: "tmp/x/d2/a.py", search_text: "zed" });
    expect(un["hits"]).toEqual([
      { file: "a.py", rel: "tmp/x/d2/a.py", path: "/work/tmp/x/d2/a.py", line: 1, text: "def zed():" },
    ]);
    await fermer();
  });

  it("B-34 : un dossier intermédiaire qui sort du bac donne path_outside_sandbox, le lien et sa cible", async () => {
    const { c, fermer } = await client();
    const dehors = arbreLiens();
    const attendu = `Path leaves the sandbox through a symlink: 'tmp/x/link_dir_out' -> '${dehors}'`;
    for (const [outil, args] of [
      ["read_file", { path: "tmp/x/link_dir_out/hostname" }],
      ["list_files", { path: "tmp/x/link_dir_out/hostname" }],
      ["code", { action: "outline", path: "tmp/x/link_dir_out/a.py" }],
    ] as const) {
      const r = await appeler(c, outil, args);
      expect(r, outil).toMatchObject({ ok: false, error: "path_outside_sandbox", message: attendu });
      expect(String(r["fix"]), outil).toMatch(/inside \/work/u);
    }
    const lot = await appeler(c, "read_file", { paths: ["tmp/x/real.txt", "tmp/x/link_dir_out/hostname"] });
    expect((lot["files"] as Record<string, Dict>)["tmp/x/link_dir_out/hostname"]).toMatchObject({
      error: "path_outside_sandbox",
      message: attendu,
    });
    const w = await appeler(c, "write_file", { path: "tmp/x/link_dir_out/n.txt", content: "z" });
    expect(w).toMatchObject({ ok: false, error: "path_outside_sandbox" });
    expect(String(w["message"])).toMatch(/leaves the sandbox through a symlink/u);
    await fermer();
  });
});

describe("famille fs : aucun message d'erreur ne répète son code (B-34)", () => {
  const source = (rel: string): string =>
    readFileSync(path.join(import.meta.dirname, "../../..", rel), "utf8");
  const tous = (texte: string, re: RegExp): string[] => [...texte.matchAll(re)].map((m) => m[1] as string);

  it("codes des outils fs, de CODES_MESSAGE et de PHRASES : phrase anglaise", () => {
    const dossier = path.join(import.meta.dirname, "../src/mcp/fs");
    const fichiers = readdirSync(dossier, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".ts"),
    );
    const codes = new Set([
      ...CODES_MESSAGE.map(([, code]) => code),
      ...Object.keys(PHRASES),
      ...fichiers.flatMap((f) =>
        tous(readFileSync(path.join(dossier, f), "utf8"), /\berrFs\(\s*"([a-z_]+)"/gu),
      ),
    ]);
    expect(codes.size).toBeGreaterThan(40);
    for (const code of codes)
      for (const kw of [{}, { path: "/work/x" }]) {
        const r = enrichirErreur(errFs(code, "", kw));
        expect(r["error"]).toBe(code);
        expect(r["message"], code).not.toBe(code);
        expect(String(r["message"]), code).toMatch(/^[A-Za-z_].*[a-z0-9.)'"]$/u);
      }
  });

  it("codes émis par l'agent du bac (Refus, errno) et pannes du transport : message anglais, jamais le code", () => {
    const agent = source("sandbox-agent/server.py");
    const codes = new Set([
      ...tous(agent, /Refus\(\d+, "([a-z_]+)"/gu),
      ...tous(agent, /\(\d+, "([a-z_]+)"\)/gu),
      ...Object.keys(ERREURS_AGENT),
      ...INJOIGNABLE,
    ]);
    expect(codes.has("outside_root") && codes.has("not_empty") && codes.has("io_error")).toBe(true);
    for (const code of codes) {
      const r = enrichirErreur(errAgent(new AgentError(code, "message de l'agent en français"), "tmp/x"));
      expect(r["message"], code).not.toBe(r["error"]);
      expect(`${String(r["message"])} ${String(r["fix"])}`, code).not.toMatch(/français/u);
    }
    expect(
      enrichirErreur(errAgent(new AgentError("outside_root", "un lien sort de /work"), "a/b")),
    ).toMatchObject({
      error: "path_outside_sandbox",
      message: "Path '/work/a/b' leaves the sandbox through a symlink.",
    });
    expect(errAgent(new AgentError("not_empty", "Directory not empty"), "d")["message"]).toBe(
      "Directory not empty: '/work/d'.",
    );
  });
});
