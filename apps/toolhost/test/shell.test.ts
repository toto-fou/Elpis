// SPDX-License-Identifier: MIT
/** apps/toolhost/test/shell.test.ts — famille shell de bout en bout en mémoire (client MCP du SDK → ServeurOutils → pont) : bac local (bash de l'hôte) et vrai agent Python, profil réseau effectif, débord, relevé et historique. */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  bacDeLOutil,
  definirFabriqueAgent,
  erreurAgent,
  profilDuBac,
  profilRetenu,
  resetUserSandboxCache,
  retenirChoixProfil,
} from "@elpis/bac";
import { surchargerConfig } from "@elpis/config";
import type { ExecResult, OptionsExec, PortProfilRappel } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import { AgentClient, AgentError, fileEntry, startSession } from "@elpis/fichiers";
import { construireTable, ouvrirEnMemoire, ServeurOutils, VerificateurJetons } from "@elpis/outils-mcp";
import type { ContexteAppel, Golden } from "@elpis/outils-mcp";
import goldenShell from "@elpis/outils-mcp/goldens/shell.json" with { type: "json" };
import { avecIdentite, creerIdentite, oublierConfigurationAudit, userIdFor } from "@elpis/securite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientMcpHttp, pickToolPayload } from "../../core/src/outils/mcp/clients";
import { RAPPEL_ABSENT } from "../src/fichiers/commun";
import { NOTE_CONCURRENTE } from "../src/mcp/changements";
import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { demarrerTs } from "../../../packages/outils-mcp/test/differentiel";
import { emitCapMinTokens, oublierPlancherDebord, plancherDebord } from "../src/mcp/shell/budget";
import { brancherRappelProfil, Espace, installerFabriqueEspace } from "../src/mcp/espace";
import {
  appuisParDefaut,
  ATTENTE_ALERTE_MS,
  executeShell,
  familleShell,
  oublierPurges,
  outilsShell,
  purgerAuBesoin,
  WRAPPER_FOND,
} from "../src/mcp/shell/outil";
import type { AppuisShell } from "../src/mcp/shell/outil";
import {
  APERCU_SAUVE,
  apercu,
  partNonTexte,
  PontExec,
  reglagesPont,
  saveOutputs,
  SCRIPT_PURGE,
  sortieBinaire,
  strErreur,
  Tampon,
} from "../src/mcp/shell/pont";
import type { AgentOutils, BacShell } from "../src/mcp/shell/pont";

const ARGS_REGLAGES = { ...reglagesPont };

/** Bac local : l'agent est le vrai agent Python sur `P/work`, l'exécution est le bash de l'hôte dans ce dossier (`/work` traduit). */
class BacLocal implements BacShell {
  readonly containerName = "elpis-sb-test";
  readonly sandboxPath: string;
  readonly networkProfileId: string | null;
  readonly agent: AgentClient;
  readonly test: BacTest;
  readonly execs: { cmd: string[]; env: Record<string, string> | undefined }[] = [];
  /** Purges des journaux de l'outil (harnais SH-12), notées à part des commandes. */
  readonly purges: string[][] = [];

  constructor(test: BacTest, profil: string | null) {
    this.test = test;
    this.sandboxPath = test.sandboxPath;
    this.networkProfileId = profil;
    this.agent = new AgentClient(test);
  }

  exec(cmd: readonly string[], o: OptionsExec = {}): Promise<ExecResult> {
    if (cmd[2] === SCRIPT_PURGE) this.purges.push([...cmd]);
    else this.execs.push({ cmd: [...cmd], env: o.env ? { ...o.env } : undefined });
    const cwd = (o.workdirInContainer ?? "/work").replace(/^\/work/u, this.test.sandboxPath);
    const t0 = performance.now();
    return new Promise((fin) => {
      const p = spawn(cmd[0] ?? "", cmd.slice(1), {
        cwd,
        env: { ...o.env, PATH: process.env["PATH"] ?? "" },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let delai = false;
      const t = setTimeout(
        () => {
          delai = true;
          p.kill("SIGKILL");
        },
        (o.timeoutS ?? 30) * 1000,
      );
      p.stdout.on("data", (d: Buffer) => {
        out.push(d);
        o.onChunk?.("stdout", d);
      });
      p.stderr.on("data", (d: Buffer) => {
        err.push(d);
        o.onChunk?.("stderr", d);
      });
      if (o.stdin) p.stdin.end(o.stdin);
      else p.stdin.end();
      p.on("close", (code) => {
        clearTimeout(t);
        fin({
          returncode: delai ? 124 : (code ?? -1),
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err),
          duration_s: (performance.now() - t0) / 1000,
          timed_out: delai,
          executor_tag: "docker.user.test",
          container_id: null,
        });
      });
    });
  }
}

let racine = "";
let nettoyer: () => void = () => undefined;
let test: BacTest;
let bac: BacLocal;
const profils: string[] = [];

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-test-shell-");
  vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(racine, "fh"));
  vi.stubEnv("ELPIS_AUDIT_DIR", path.join(racine, "audit"));
  oublierConfigurationAudit();
  test = new BacTest(racine, "alice");
  bac = new BacLocal(test, null);
  profils.length = 0;
});

afterEach(async () => {
  Object.assign(reglagesPont, ARGS_REGLAGES);
  vi.unstubAllEnvs();
  oublierPlancherDebord();
  oublierConfigurationAudit();
  installerFabriqueEspace(null);
  await test.arreter();
  nettoyer();
});

interface OptionsLocal {
  readonly rappel?: PortProfilRappel;
  readonly fins?: { n: number };
  readonly alerte?: AppuisShell["alerteDisque"];
}

function serveurLocal(o: OptionsLocal = {}): ServeurOutils {
  const pont = new PontExec({
    rappel: o.rappel ?? null,
    bac: async (uid, nom, rappel) => {
      profils.push(await profilDuBac(uid, nom, rappel));
      return bac;
    },
    journal: { info: () => undefined, warn: () => undefined },
  });
  installerFabriqueEspace(async (u) => new Espace(bac.sandboxPath, await userIdFor(u), bac.agent));
  const defaut = appuisParDefaut(pont, async () => test.sandboxPath);
  const appuis: AppuisShell = {
    ...defaut,
    ...(o.alerte ? { alerteDisque: o.alerte } : {}),
    releve: (uid, nom, rac) => {
      const r = defaut.releve(uid, nom, rac);
      return {
        debut: () => r.debut(),
        fin: async () => {
          if (o.fins) o.fins.n++;
          await r.fin();
        },
        attacher: (x) => r.attacher(x),
      };
    },
  };
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("shell", outilsShell(appuis));
  return serveur;
}

/** Serveur de la famille sur le bac local, client du SDK en mémoire (portée `shell`), notifications notées. */
async function client(
  o: OptionsLocal = {},
): Promise<{ c: Client; notes: Dict[]; fermer: () => Promise<void> }> {
  const cnx = await ouvrirEnMemoire(serveurLocal(o), { famille: "shell" });
  const c = new Client({ name: "test", version: "1" });
  const notes: Dict[] = [];
  c.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    notes.push(n.params as Dict);
  });
  await c.connect(cnx.transport);
  return { c, notes, fermer: () => cnx.fermer() };
}

const META = { username: "alice", user_id: "42", call_id: "k1", log_token: "run:k1" };

async function appeler(c: Client, args: Dict, meta: Dict = META): Promise<{ r: Dict; isError: boolean }> {
  const rep = (await c.callTool({ name: "execute_shell", arguments: args, _meta: meta })) as Dict;
  const sc = rep["structuredContent"] as Dict | undefined;
  const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
  return {
    r: (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict),
    isError: rep["isError"] === true,
  };
}

describe("famille shell : définition", () => {
  it("tools/list rend la définition du golden Python, à l'identique", async () => {
    const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    serveur.enregistrerFamille("shell", outilsShell(appuisParDefaut(new PontExec())));
    const liste = serveur.lister({ jeton: null, famille: "shell" });
    expect(liste.tools).toEqual((goldenShell as Golden).outils);
    expect(familleShell({}).famille).toBe("shell");
    expect(familleShell({}).outils.map((o) => o.nom)).toEqual(["execute_shell", "shell_job"]);
  });
});

describe.skipIf(!PYTHON)("famille shell : bac local et vrai agent", () => {
  it("commande, sortie live (shell_output, done) et avertissement de code de retour", async () => {
    const { c, notes, fermer } = await client();
    try {
      const { r } = await appeler(
        c,
        { command: "printf 'a\\n'; printf 'b\\n' >&2; exit 3" },
        { ...META, live_shell: "1" },
      );
      expect(r).toMatchObject({ ok: false, cmd: "printf 'a\\n'; printf 'b\\n' >&2; exit 3", returncode: 3 });
      expect([r["stdout"], r["stderr"], r["executor"]]).toEqual(["a\n", "b\n", "docker.user.test"]);
      const vivants = notes
        .filter((n) => n["logger"] === "elpis.shell")
        .map((n) => (n["data"] as Dict)["extra"] as Dict);
      const fin = vivants.at(-1) as Dict;
      expect(fin).toMatchObject({
        kind: "shell_output",
        done: true,
        returncode: 3,
        call_id: "k1",
        log_token: "run:k1",
      });
      expect(
        vivants
          .slice(0, -1)
          .map((v) => v["chunk"])
          .join(""),
      ).toContain("a\n");
      expect(notes[0]).toMatchObject({
        level: "info",
        data: { msg: "shell → elpis-sb-test: bash -c printf 'a\\n'; printf 'b\\n' >&2; exit 3" },
      });
      expect(notes.at(-1)).toMatchObject({ level: "warning" });
      expect(new Set(profils)).toEqual(new Set(["isolated"]));
      expect(bac.execs[0]?.env).toMatchObject({ HOME: "/work", GIT_TERMINAL_PROMPT: "0" });
      const audit = readdirSync(path.join(racine, "audit")).map((f) =>
        readFileSync(path.join(racine, "audit", f), "utf8"),
      );
      const ligne = JSON.parse(audit.join("").trim().split("\n")[0] ?? "{}") as Dict;
      expect(ligne).toMatchObject({ action: "code.exec.tools.shell", user_id: 42, username: "alice" });
      expect(ligne["details"]).toMatchObject({
        run_id: "tool-alice",
        node_id: "tools.shell",
        executor: "elpis-sb-test",
      });
      expect((ligne["details"] as Dict)["cmd_argv"]).toEqual([
        "bash",
        "-c",
        "printf 'a\\n'; printf 'b\\n' >&2; exit 3",
      ]);
    } finally {
      await fermer();
    }
  });

  it("audit d'une commande à secret et demi-paire : ligne écrite, argv masqué, empreinte du texte masqué", async () => {
    const { c, fermer } = await client();
    try {
      const { r } = await appeler(c, { command: "true --password hunter2 \ud800; echo fin" });
      expect(r).toMatchObject({ ok: true, returncode: 0 });
      const brut = readdirSync(path.join(racine, "audit"))
        .map((f) => readFileSync(path.join(racine, "audit", f), "utf8"))
        .join("");
      expect(brut).not.toContain("hunter2");
      const ligne = JSON.parse(brut.trim().split("\n")[0] ?? "{}") as Dict;
      expect(ligne["action"]).toBe("code.exec.tools.shell");
      const details = ligne["details"] as Dict;
      const argv = ["bash", "-c", "true --password **** \ufffd; echo fin"];
      expect(details["cmd_argv"]).toEqual(argv);
      expect(details["code_sha256"]).toBe(createHash("sha256").update(argv.join(" ")).digest("hex"));
    } finally {
      await fermer();
    }
  });

  it("cwd vérifié par l'agent : dossier accepté, absent, fichier et lien hors de /work refusés", async () => {
    mkdirSync(path.join(test.sandboxPath, "src"));
    writeFileSync(path.join(test.sandboxPath, "f.txt"), "x");
    const ailleurs = path.join(racine, "ailleurs");
    mkdirSync(ailleurs);
    symlinkSync(ailleurs, path.join(test.sandboxPath, "lien"));
    const { c, fermer } = await client();
    try {
      const ok = await appeler(c, { command: "ls", cwd: "/work/src" });
      expect(ok.isError).toBe(false);
      for (const [cwd, code] of [
        ["absent", "cwd_not_a_directory"],
        ["f.txt", "cwd_not_a_directory"],
        ["lien", "cwd_outside_sandbox"],
        ["lien/x", "cwd_outside_sandbox"],
        ["../x", "cwd_outside_sandbox"],
      ] as const) {
        const { r, isError } = await appeler(c, { command: "ls", cwd });
        expect([cwd, isError, r["error"]]).toEqual([cwd, true, code]);
      }
    } finally {
      await fermer();
    }
  });

  it("fichiers modifiés par la commande : files_changed et historique (source shell)", async () => {
    writeFileSync(path.join(test.sandboxPath, "m.py"), "a\nb\n");
    writeFileSync(path.join(test.sandboxPath, "old.txt"), "bye\n");
    await startSession(42);
    const { c, fermer } = await client();
    try {
      const { r } = await appeler(c, {
        command: "printf 'a\\nB\\nc\\n' > m.py; rm old.txt; printf 'hi\\n' > new.txt",
      });
      const par = Object.fromEntries((r["files_changed"] as Dict[]).map((e) => [e["path"], e]));
      expect(Object.keys(par).sort()).toEqual(["/work/m.py", "/work/new.txt", "/work/old.txt"]);
      expect(par["/work/m.py"]).toMatchObject({ change: "modified", lines_added: 2, lines_removed: 1 });
      expect(par["/work/old.txt"]).toMatchObject({ change: "deleted", new_sha256: null });
      expect(par["/work/new.txt"]).toMatchObject({
        change: "created",
        old_sha256: null,
        lines_added: 1,
        lines_removed: 0,
      });
      const versions = (await fileEntry(42, "m.py"))?.["versions"] as Dict[];
      expect(versions.at(-1)?.["source"]).toBe("shell");
    } finally {
      await fermer();
    }
  });

  it("débord automatique : sortie complète (stdout, marque, stderr) écrite par l'agent sous .tool-output", async () => {
    const { c, fermer } = await client();
    try {
      const { r } = await appeler(c, { command: "seq 1 3000; echo fin >&2" });
      // écart voulu au Python (harnais B-04) : sortie sauvée, seules sa tête et sa queue sont injectées
      expect(r["truncated"]).toBe(true);
      expect(String(r["saved_to"])).toMatch(/^\/work\/\.tool-output\/shell-\d+-[0-9a-f]{6}\.log$/u);
      const sortie = String(r["stdout"]);
      expect(sortie.startsWith("1\n2\n3\n")).toBe(true);
      expect(sortie.endsWith("2999\n3000\n")).toBe(true);
      expect(sortie).toMatch(/\n… \d+ chars omitted …\n/u);
      expect(sortie.length).toBeLessThan(4100);
      expect(r["stderr"]).toBe("fin\n");
      expect(String(r["hint"])).toContain(`read_file(path="${String(r["saved_to"])}", grep="...")`);
      const fichier = path.join(test.sandboxPath, String(r["saved_to"]).slice("/work/".length));
      const attendu =
        Array.from({ length: 3000 }, (_, i) => `${i + 1}\n`).join("") + "\n--- STDERR ---\nfin\n";
      expect(readFileSync(fichier, "utf8")).toBe(attendu);
      expect(r["saved_bytes"]).toBe(attendu.length);
      expect(Object.hasOwn(r, "auto_saved")).toBe(false);
    } finally {
      await fermer();
    }
  });

  it("débord de stderr seul : stderr prend tout le budget de l'aperçu (tête 1 500, queue 2 500)", async () => {
    const { c, fermer } = await client();
    try {
      const { r } = await appeler(c, { command: "seq 1 3000 >&2" });
      const err = String(r["stderr"]);
      expect([r["truncated"], r["stdout"]]).toEqual([true, ""]);
      expect(err.startsWith("1\n2\n3\n")).toBe(true);
      expect(err.endsWith("2999\n3000\n")).toBe(true);
      expect(err.length).toBeGreaterThan(4000);
      expect(err.length).toBeLessThan(4100);
    } finally {
      await fermer();
    }
  });

  it("save_stdout : stdout COMPLET au-delà de la troncature, même passé par le disque de l'hôte", async () => {
    reglagesPont.tamponMemoire = 1024;
    const avant = readdirSync(tmpdir()).filter((n) => n.startsWith("elpis-shell-"));
    const { c, fermer } = await client();
    try {
      const { r } = await appeler(c, { command: "seq 1 20000", save_stdout: "out/full.txt" });
      expect(r["truncated"]).toBe(true);
      expect(r["saved_to"]).toBe("/work/out/full.txt");
      expect(String(r["stdout"]).length).toBeLessThan(4100);
      expect(String(r["stdout"]).endsWith("19999\n20000\n")).toBe(true);
      expect(String(r["hint"])).toContain("the FULL stdout was saved to /work/out/full.txt");
      const complet = Array.from({ length: 20000 }, (_, i) => `${i + 1}\n`).join("");
      expect(readFileSync(path.join(test.sandboxPath, "out/full.txt"), "utf8")).toBe(complet);
      expect(r["saved_bytes"]).toBe(complet.length);
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith("elpis-shell-"))).toEqual(avant);
    } finally {
      await fermer();
    }
  });

  it("stdin texte et binaire, variables d'environnement, refus avant exécution", async () => {
    const { c, fermer } = await client();
    try {
      expect((await appeler(c, { command: "cat", stdin: "entrée" })).r["stdout"]).toBe("entrée");
      const bin = await appeler(c, {
        command: "od -An -tx1",
        stdin_b64: Buffer.from([0, 255, 10]).toString("base64"),
      });
      expect(String(bin.r["stdout"]).trim()).toBe("00 ff 0a");
      expect((await appeler(c, { command: "echo $FOO", env: { FOO: "bar" } })).r["stdout"]).toBe("bar\n");
      expect(bac.execs.at(-1)?.env).toMatchObject({ FOO: "bar", GIT_TERMINAL_PROMPT: "0" });
      const n = bac.execs.length;
      expect((await appeler(c, { command: "cat", stdin: "x", stdin_b64: "eA==" })).r["error"]).toBe(
        "stdin_conflict",
      );
      expect((await appeler(c, { command: "env", env: { foo: "x" } })).r["error"]).toBe("env_key_invalid");
      expect((await appeler(c, { command: "  " })).r["error"]).toBe("empty_command");
      // Au-delà de 100 000 caractères, refus avant le masquage : execve refuse déjà un argument de 128 Kio.
      expect((await appeler(c, { command: `echo ${"x".repeat(100_000)}` })).r).toMatchObject({
        error: "command_too_long",
        message: "command too long (100005 characters, max 100000)",
      });
      expect(bac.execs.length).toBe(n);
    } finally {
      await fermer();
    }
  });

  it("client MCP du core (HTTP, routeur des journaux, sortie validée par le schéma) → famille servie par l'hôte", async () => {
    const svc = "svc-shell-core-0123456789";
    const cible = await demarrerTs({
      serveur: serveurLocal(),
      verificateur: new VerificateurJetons({ table: construireTable(svc, {}, {}) }),
      transport: "http",
    });
    const cl = new ClientMcpHttp(`${cible.base}/mcp/shell`, { Authorization: `Bearer ${svc}` });
    const signal = AbortSignal.timeout(30_000);
    try {
      await cl.connecter(signal);
      expect((await cl.listerOutils(signal)).map((o) => o["name"])).toEqual(["execute_shell", "shell_job"]);
      const journaux: Dict[] = [];
      const meta = {
        username: "alice",
        user_id: "42",
        chat_id: "c1",
        live_shell: "1",
        call_id: "call_1",
        log_token: "r1:call_1",
      };
      const res = await cl.appelerOutil(
        "execute_shell",
        { command: "echo un; sleep 0.3; echo deux >&2; exit 4" },
        { meta, onLog: (p) => void journaux.push(p), signal },
      );
      expect(pickToolPayload(res)).toMatchObject({
        ok: false,
        returncode: 4,
        stdout: "un\n",
        stderr: "deux\n",
      });
      const vivants = journaux
        .filter((p) => p["logger"] === "elpis.shell")
        .map((p) => (p["data"] as Dict)["extra"] as Dict);
      expect(vivants.map((v) => [v["stream"] ?? null, v["chunk"] ?? null, v["done"]])).toEqual([
        ["stdout", "un\n", false],
        ["stderr", "deux\n", false],
        [null, null, true],
      ]);
      expect(vivants.every((v) => v["log_token"] === "r1:call_1")).toBe(true);
      const ok = await cl.appelerOutil("execute_shell", { command: "echo fini" }, { meta, signal });
      expect(pickToolPayload(ok)).toMatchObject({
        ok: true,
        stdout: "fini\n",
        cwd: "/work",
        truncated: false,
      });
    } finally {
      await cl.fermer();
      await cible.arreter();
    }
  });

  it("panne du bac : enveloppe executor unavailable, relevé fermé", async () => {
    bac.exec = () => Promise.reject(new Error("Container elpis-sb-test n'a pas pu démarrer"));
    const fins = { n: 0 };
    const { c, fermer } = await client({ fins });
    try {
      const { r, isError } = await appeler(c, { command: "ls" });
      expect(isError).toBe(true);
      expect(r).toMatchObject({
        error: "executor_unavailable",
        // écart voulu au Python (harnais B-13) : panne du bac rendue en anglais
        message: "executor unavailable: container elpis-sb-test could not start",
        cmd: "ls",
      });
      expect(fins.n).toBe(1);
    } finally {
      await fermer();
    }
  });
});

describe.skipIf(!PYTHON)(
  "sous-agent (`_meta.subagent`) : verify sans cache Python, délai sans réveil (SA-13, SA-18)",
  () => {
    it("SA-13, N9 : verify lance Python sans écrire de __pycache__ et pytest sans cache ; implement sans __pycache__ seulement ; un autre type n'a rien d'ajouté", async () => {
      const { c, fermer } = await client();
      try {
        const verify = { ...META, subagent: { type: "verify", read_only: false } };
        writeFileSync(path.join(test.sandboxPath, "m.py"), "X = 1\n");
        const r = await appeler(
          c,
          {
            command:
              "python3 -c \"import m, sys, os; print(sys.dont_write_bytecode, os.environ.get('PYTEST_ADDOPTS'))\"",
          },
          verify,
        );
        expect(r.r["stdout"]).toBe("True -p no:cacheprovider\n");
        expect(readdirSync(test.sandboxPath)).not.toContain("__pycache__");
        expect(bac.execs.at(-1)?.env).toMatchObject({ PYTHONDONTWRITEBYTECODE: "1" });
        await appeler(c, { command: "true" }, { ...META, subagent: { type: "implement", read_only: false } });
        expect(bac.execs.at(-1)?.env).toMatchObject({ PYTHONDONTWRITEBYTECODE: "1" });
        expect(bac.execs.at(-1)?.env).not.toHaveProperty("PYTEST_ADDOPTS");
        await appeler(c, { command: "true" }, { ...META, subagent: { type: "pr", read_only: false } });
        expect(bac.execs.at(-1)?.env).not.toHaveProperty("PYTHONDONTWRITEBYTECODE");
        await appeler(c, { command: "true", env: { PYTEST_ADDOPTS: "-q" } }, verify);
        expect(bac.execs.at(-1)?.env).toMatchObject({ PYTEST_ADDOPTS: "-q" });
      } finally {
        await fermer();
      }
    });

    it("SA-18 : délai dépassé d'un sous-agent : conseil de découpage, ni shell_job ni detach_and_wake (repli kill)", async () => {
      const { c, fermer } = await client();
      try {
        const sa = { ...META, subagent: { type: "verify", read_only: false } };
        const r = await appeler(c, { command: "sleep 3", timeout_sec: 1, on_timeout: "detach_and_wake" }, sa);
        expect(r.r["error"]).toBe("timeout");
        expect(String(r.r["fix"])).toContain("cannot run background jobs or be woken");
        expect(String(r.r["fix"])).not.toContain("shell_job(");
        expect(String(r.r["on_timeout_fallback"])).toContain("not_available_here");
        expect(r.r).not.toHaveProperty("job_id");
      } finally {
        await fermer();
      }
    });
  },
);

describe.skipIf(!PYTHON)("strict=true : set -euo pipefail (harnais B-22)", () => {
  it("une étape de tube en échec ou une variable absente fait échouer la commande ; sans strict, rien ne change", async () => {
    const { c, fermer } = await client();
    try {
      for (const [command, strict, ok, rc] of [
        ["false | true; echo suite", false, true, 0],
        ["false | true; echo suite", true, false, 1],
        ["echo $VARIABLE_ABSENTE_B22; echo suite", true, false, 1],
        ["false; echo suite", true, false, 1],
        ["echo un | cat", true, true, 0],
      ] as const) {
        const { r } = await appeler(c, { command, strict });
        expect([command, strict, r["ok"], r["returncode"], r["cmd"]]).toEqual([
          command,
          strict,
          ok,
          rc,
          command,
        ]);
        if (ok) expect(String(r["stdout"]).length).toBeGreaterThan(0);
        else expect(String(r["stdout"])).not.toContain("suite");
      }
    } finally {
      await fermer();
    }
  });
});

describe("strict=true en mode détaché (harnais B-22)", () => {
  it("la commande détachée tourne aussi sous bash -euo pipefail ; sans strict, l'enveloppe reste celle du Python", async () => {
    const vus: string[][] = [];
    const appuis: AppuisShell = {
      racine: async () => "/sb/alice/work",
      stats: async () => [],
      userIdFor: async () => 7,
      releve: () => ({ debut: async () => undefined, fin: async () => undefined, attacher: (r) => r }),
      executer: async (o) => {
        vus.push([...o.tokens]);
        return { ok: true, stdout: "4242\n", stderr: "" };
      },
      plancherDebord: () => 7920,
    };
    const ctx = { meta: { username: "alice" } } as unknown as ContexteAppel;
    const base = { cwd: null, timeout_sec: null, stdin: "", stdin_b64: "", env: {}, save_stdout: "" };
    for (const strict of [false, true])
      expect(
        await executeShell({ ...base, command: "make", background: true, strict }, ctx, appuis),
      ).toMatchObject({ ok: true, pid: 4242 });
    await executeShell({ ...base, command: "make", background: false, strict: true }, ctx, appuis);
    expect(vus[0]?.[2]).toBe(WRAPPER_FOND);
    expect(vus[1]?.[2]).toContain('nohup setsid bash -euo pipefail -c "$1"');
    expect(vus[2]?.slice(0, 5)).toEqual(["bash", "-euo", "pipefail", "-c", "make"]);
  });

  it("background=true : refusé au seuil de refus comme shell_job(start), sinon disk_warning joint", async () => {
    const lances: string[][] = [];
    let plein: string | null = "Disk almost full: the disk holding /work is 98% full.";
    const appuis: AppuisShell = {
      racine: async () => "/sb/alice/work",
      stats: async () => [],
      userIdFor: async () => 7,
      releve: () => ({ debut: async () => undefined, fin: async () => undefined, attacher: (r) => r }),
      executer: async (o) => {
        lances.push([...o.tokens]);
        return { ok: true, stdout: "4242\n", stderr: "" };
      },
      plancherDebord: () => 7920,
      alerteDisque: async () => "Disk space low: the disk holding /work is 90% full.",
      refusDisque: async () => plein,
    };
    const ctx = { meta: { username: "alice" } } as unknown as ContexteAppel;
    const args = { cwd: null, timeout_sec: null, stdin: "", stdin_b64: "", env: {}, save_stdout: "" };
    const refus = await executeShell({ ...args, command: "npm run dev", background: true }, ctx, appuis);
    expect(refus).toMatchObject({ ok: false, error: "disk_full_risk" });
    expect(lances).toEqual([]);
    plein = null;
    expect(
      await executeShell({ ...args, command: "npm run dev", background: true }, ctx, appuis),
    ).toMatchObject({
      ok: true,
      pid: 4242,
      disk_warning: "Disk space low: the disk holding /work is 90% full.",
    });
  });
});

describe.skipIf(!PYTHON)("profil réseau sur le chemin réel (_meta sans profil, rappel vers main)", () => {
  it("le bac de l'appel suit le profil effectif rendu par main ; un choix retenu après POST /me ne passe pas outre", async () => {
    const vus: string[] = [];
    const rappel: PortProfilRappel = {
      actif: true,
      identityForUsername: async (u) => {
        vus.push(u);
        return { network_profile_id: "web" };
      },
    };
    retenirChoixProfil(42, "open");
    const { c, fermer } = await client({ rappel });
    try {
      await appeler(c, { command: "true" });
      expect(new Set(profils)).toEqual(new Set(["web"]));
      expect(new Set(vus)).toEqual(new Set(["alice"]));
    } finally {
      profilRetenu(42, "open");
      await fermer();
    }
  });
});

describe("erreurs et refus", () => {
  it("str(e) : AgentError de toute forme en « code: message »", () => {
    expect(strErreur(erreurAgent("agent_unavailable", "client absent"))).toBe(
      "agent_unavailable: client absent",
    );
    expect(strErreur(new AgentError("timeout"))).toBe("timeout");
    expect(strErreur(new AgentError("changed", "x"))).toBe("changed: x");
    expect(strErreur(new Error("boom"))).toBe("boom");
    expect(strErreur("brut")).toBe("brut");
  });

  it("refus outside_root d'un agent de forme ErreurAgent : cwd outside sandbox", async () => {
    const appuis: AppuisShell = {
      racine: async () => "/sb/alice/work",
      stats: async () => {
        throw erreurAgent("outside_root", "lien");
      },
      userIdFor: async () => 7,
      releve: () => ({ debut: async () => undefined, fin: async () => undefined, attacher: (r) => r }),
      executer: async () => ({}),
      plancherDebord: () => 7920,
    };
    const ctx = { meta: { username: "alice" } } as unknown as ContexteAppel;
    const args = {
      command: "ls",
      cwd: "lien",
      timeout_sec: null,
      stdin: "",
      stdin_b64: "",
      env: {},
      save_stdout: "",
      background: false,
    };
    expect(await executeShell(args, ctx, appuis)).toMatchObject({ error: "cwd_outside_sandbox" });
  });
});

describe("profil réseau commun aux familles de l'hôte (@elpis/bac › bacDeLOutil)", () => {
  it("familleShell branche le rappel : l'espace (relevé, cwd) et le pont prennent le même bac, sous le profil de main", async () => {
    const [sb, fin] = dossierTemporaire("elpis-test-shell-sb-");
    const restaurer = surchargerConfig({ SANDBOX_DIR: sb });
    definirFabriqueAgent((b) => new AgentClient(b));
    const rappel: PortProfilRappel = {
      actif: true,
      identityForUsername: async () => ({ network_profile_id: "web" }),
    };
    try {
      familleShell({ rappel, journal: { info: () => undefined, warn: () => undefined } });
      const ident = creerIdentite({ user_id: 5, username: "eve" });
      const espace = await avecIdentite(ident, () => Espace.pour("eve"));
      const duPont = await avecIdentite(ident, () => new PontExec({ rappel }).bac(5, "eve"));
      const uneAutre = await avecIdentite(ident, () => bacDeLOutil(5, "eve", rappel));
      expect(duPont).toBe(uneAutre);
      expect([espace.uid, espace.racine, espace.agent]).toEqual([5, uneAutre.sandboxPath, uneAutre.agent]);
      expect([uneAutre.networkProfileId, uneAutre.configVerified]).toEqual(["web", false]);
    } finally {
      brancherRappelProfil(null);
      definirFabriqueAgent(null);
      resetUserSandboxCache();
      restaurer();
      fin();
    }
  });
});

describe.skipIf(!PYTHON)("purge de .tool-output et .bg (harnais SH-12)", () => {
  it("âge puis volume, plus anciens d'abord ; jamais un journal ouvert, un fichier récent ni un autre nom", async () => {
    const jour = 86_400;
    const maintenant = Math.floor(Date.now() / 1000);
    const fichiers: [string, number, number][] = [
      [".tool-output/shell-1-aaaaaa.log", 1000, 10 * jour],
      [".tool-output/shell-2-bbbbbb.log", 1000, 3 * 3600],
      [".tool-output/shell-3-cccccc.log", 1000, 2 * 3600],
      [".tool-output/shell-4-dddddd.log", 1000, 60],
      [".tool-output/notes.log", 1000, 30 * jour],
      [".bg/bg-5-eeeeee.log", 1000, 10 * jour],
      [".bg/bg-6-ffffff.log", 1000, 10 * jour],
      // Fichiers des jobs de fond (shell_job, agent du bac) : jamais purgés ici.
      [".bg/job-j-0123abcd.log", 1000, 10 * jour],
      [".bg/job-j-0123abcd.json", 1000, 10 * jour],
      [".bg/job-j-0123abcd.exit", 1000, 10 * jour],
      [".bg/jobs-events.ndjson", 1000, 10 * jour],
    ];
    for (const d of [".tool-output", ".bg"]) mkdirSync(path.join(test.sandboxPath, d), { recursive: true });
    for (const [rel, taille] of fichiers) writeFileSync(path.join(test.sandboxPath, rel), "x".repeat(taille));
    const actif = spawn("sleep", ["30"], {
      stdio: ["ignore", openSync(path.join(test.sandboxPath, ".bg/bg-6-ffffff.log"), "a"), "ignore"],
    });
    try {
      for (const [rel, , age] of fichiers)
        utimesSync(path.join(test.sandboxPath, rel), maintenant - age, maintenant - age);
      reglagesPont.purgeMaxOctets = 3000;
      const pont = new PontExec({
        bac: async () => bac,
        journal: { info: () => undefined, warn: () => undefined },
      });
      await pont.purger(42, "alice");
      const restent = fichiers
        .map(([rel]) => rel)
        .filter((rel) => existsSync(path.join(test.sandboxPath, rel)));
      expect(restent).toEqual([
        ".tool-output/shell-3-cccccc.log",
        ".tool-output/shell-4-dddddd.log",
        ".tool-output/notes.log",
        ".bg/bg-6-ffffff.log",
        ".bg/job-j-0123abcd.log",
        ".bg/job-j-0123abcd.json",
        ".bg/job-j-0123abcd.exit",
        ".bg/jobs-events.ndjson",
      ]);
      expect(bac.purges).toHaveLength(1);
      expect(bac.execs).toHaveLength(0);
    } finally {
      actif.kill("SIGKILL");
    }
  });
});

describe("purge déclenchée au plus une fois par heure et par compte (harnais SH-12)", () => {
  it("premier exec du compte : purge lancée sans attendre ; ensuite rien avant l'intervalle ; panne ignorée", async () => {
    oublierPurges();
    const purges: string[] = [];
    let echec = false;
    const appuis: AppuisShell = {
      racine: async () => "/sb/alice/work",
      stats: async () => [],
      userIdFor: async () => 7,
      releve: () => ({ debut: async () => undefined, fin: async () => undefined, attacher: (r) => r }),
      executer: async () => ({ ok: true, returncode: 0, stdout: "", stderr: "" }),
      plancherDebord: () => 7920,
      purger: async (uid, username) => {
        purges.push(`${uid}:${username}`);
        if (echec) throw new Error("bac injoignable");
      },
    };
    const args = {
      command: "true",
      cwd: null,
      timeout_sec: null,
      stdin: "",
      stdin_b64: "",
      env: {},
      save_stdout: "",
      background: false,
    };
    const ctx = (u: string): ContexteAppel => ({ meta: { username: u } }) as unknown as ContexteAppel;
    let t = 1_000_000;
    const horloge = vi.spyOn(Date, "now").mockImplementation(() => t);
    try {
      await executeShell(args, ctx("alice"), appuis);
      await executeShell(args, ctx("alice"), appuis);
      await executeShell(args, ctx("bob"), appuis);
      expect(purges).toEqual(["7:alice", "7:bob"]);
      t += reglagesPont.purgeIntervalleMs - 1;
      await executeShell(args, ctx("alice"), appuis);
      expect(purges).toHaveLength(2);
      t += 1;
      echec = true;
      expect(await executeShell(args, ctx("alice"), appuis)).toMatchObject({ ok: true });
      expect(purges).toEqual(["7:alice", "7:bob", "7:alice"]);
      expect(purgerAuBesoin({ ...appuis, purger: undefined }, 7, "carol")).toBeNull();
    } finally {
      horloge.mockRestore();
      oublierPurges();
    }
  });
});

describe("aperçu d'une sortie sauvée (harnais B-04)", () => {
  it("tête 1 500 et queue 2 500 caractères, la ligne du milieu compte ce qui manque ; rien au-dessous du budget", () => {
    const s = "x".repeat(1500) + "m".repeat(6000) + "y".repeat(2500);
    expect(apercu(s, APERCU_SAUVE.tete, APERCU_SAUVE.queue)).toBe(
      "x".repeat(1500) + "\n… 6000 chars omitted …\n" + "y".repeat(2500),
    );
    expect(apercu("z".repeat(4000), 1500, 2500)).toBeNull();
  });
});

describe("plancher de débord et tampon", () => {
  it("budgets.emit_cap_min_tokens de context_config.json, converti par int(), 2400 par défaut", () => {
    expect(emitCapMinTokens({})).toBe(2400);
    expect(emitCapMinTokens({ budgets: { emit_cap_min_tokens: "100" } })).toBe(100);
    expect(emitCapMinTokens({ budgets: { emit_cap_min_tokens: "x" } })).toBe(2400);
    expect(emitCapMinTokens({ budgets: { emit_cap_min_tokens: 99.9 } })).toBe(99);
    const f = path.join(racine, "ctx.json");
    writeFileSync(f, JSON.stringify({ budgets: { emit_cap_min_tokens: 1000 } }));
    vi.stubEnv("APP_CONTEXT_CONFIG", f);
    oublierPlancherDebord();
    expect(plancherDebord()).toBe(3300);
    vi.stubEnv("APP_CONTEXT_CONFIG", path.join(racine, "absent.json"));
    oublierPlancherDebord();
    expect(plancherDebord()).toBe(7920);
  });

  it("tampon : mémoire puis fichier anonyme 0600 de l'hôte (rien dans tmp), recopie, fermeture", async () => {
    const lire = async (d: unknown): Promise<string> => {
      if (d instanceof Uint8Array) return Buffer.from(d).toString();
      const parts: Buffer[] = [];
      for await (const m of (d as { flux: AsyncIterable<Uint8Array> }).flux) parts.push(Buffer.from(m));
      return Buffer.concat(parts).toString();
    };
    const avant = readdirSync(tmpdir()).filter((n) => n.startsWith("elpis-shell-"));
    reglagesPont.tamponMemoire = 8;
    const a = new Tampon();
    a.ecrire(Buffer.from("abcd"));
    expect(a.descripteur).toBeNull();
    expect(await lire(a.envoi())).toBe("abcd");
    a.ecrire(Buffer.from("efghij"));
    const fd = a.descripteur as number;
    expect(fstatSync(fd).mode & 0o777).toBe(0o600);
    expect(fstatSync(fd).nlink).toBe(0);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("elpis-shell-"))).toEqual(avant);
    expect(a.envoi()).toMatchObject({ taille: 10 });
    expect(await lire(a.envoi())).toBe("abcdefghij");
    const b = new Tampon();
    b.ecrire(Buffer.from("<"));
    b.recopier(a);
    expect(await lire(b.envoi())).toBe("<abcdefghij");
    a.fermer();
    b.fermer();
    expect([a.descripteur, b.descripteur]).toEqual([null, null]);
    expect(() => fstatSync(fd)).toThrow();
  });

  it("copie au-delà du plafond : abandonnée, rien n'est écrit, save_error dit pourquoi", async () => {
    reglagesPont.tamponMax = 10;
    const out = new Tampon();
    out.ecrire(Buffer.from("123456"));
    out.ecrire(Buffer.from("7890ab"));
    expect(out.echec).toBe("output larger than 10 bytes: not saved");
    const ecrits: string[] = [];
    const agent = () =>
      ({
        write: async (rel: string) => {
          ecrits.push(rel);
          return {};
        },
      }) as unknown as AgentOutils;
    const r = {
      stdout: Buffer.from("123456"),
      stderr: Buffer.alloc(0),
      returncode: 0,
      duration_s: 0.1,
      timed_out: false,
      executor_tag: "t",
    };
    const f1: Dict = { truncated: true };
    expect(
      await saveOutputs(
        f1,
        r,
        agent,
        { saveStdoutRel: "o.txt", autoSpillRel: null, spillOverChars: null },
        { out, err: null },
      ),
    ).toBe(true);
    const f2: Dict = { truncated: true };
    expect(
      await saveOutputs(
        f2,
        r,
        agent,
        { saveStdoutRel: null, autoSpillRel: "s.log", spillOverChars: 5 },
        { out, err: new Tampon() },
      ),
    ).toBe(true);
    expect([f1, f2, ecrits]).toEqual([
      { truncated: true, save_error: "output larger than 10 bytes: not saved" },
      { truncated: true, save_error: "output larger than 10 bytes: not saved" },
      [],
    ]);
  });
});

describe("shell_job sans registre de jobs (hôte sans rappel au core)", () => {
  it("refus stable not_available_here, rien n'est lancé", async () => {
    const shellJob = outilsShell(appuisParDefaut(new PontExec())).find((o) => o.nom === "shell_job")!;
    const r = await shellJob.traiter(
      { action: "start", command: "sleep 600" },
      {} as unknown as ContexteAppel,
      {},
    );
    expect(r).toMatchObject({ ok: false, error: "not_available_here" });
  });
});

describe("sortie non textuelle : détection (harnais N-18)", () => {
  it("NUL, contrôles et octets UTF-8 invalides comptent ; tabulations, retours et couleurs ANSI non", () => {
    expect(sortieBinaire(randomBytes(3000))).toBe(true);
    expect(sortieBinaire(Buffer.alloc(100))).toBe(true);
    expect(sortieBinaire(Buffer.from("hello\n".repeat(50), "utf16le"))).toBe(true);
    expect(sortieBinaire(Buffer.alloc(0))).toBe(false);
    const ansi = Buffer.from(
      "\x1b[31mred\x1b[0m\tx\r\n\x1b[1;32mok\x1b[0m 50%\b\b\b60%\x07\f\v\n".repeat(40),
    );
    expect(partNonTexte(ansi)).toBe(0);
    expect(sortieBinaire(ansi)).toBe(false);
    expect(
      sortieBinaire(Buffer.from("Le cœur à l'été, déjà très chaud ; où êtes-vous ?\n".repeat(30), "latin1")),
    ).toBe(false);
  });

  it("au-delà de 16 Kio, la tête et la queue sont examinées, pas le milieu", () => {
    const texte = Buffer.from("ligne de texte\n".repeat(3000));
    expect(sortieBinaire(Buffer.concat([texte, randomBytes(8192)]))).toBe(true);
    expect(sortieBinaire(Buffer.concat([randomBytes(8192), texte]))).toBe(true);
    expect(sortieBinaire(Buffer.concat([texte, randomBytes(4096), texte]))).toBe(false);
  });
});

describe.skipIf(!PYTHON)("sortie non textuelle d'execute_shell (harnais N-18)", () => {
  it("stdout binaire : résumé, hexdump des 512 premiers octets, sortie complète sauvée, hint vers read_file", async () => {
    // écart voulu au Python (harnais N-18) : le Python injectait la sortie binaire décodée telle quelle
    const { c, fermer } = await client();
    try {
      const { r } = await appeler(c, { command: "head -c 3000 /dev/urandom" });
      expect(r["stdout"]).toBe("[binary output: 3000 bytes, not shown]");
      expect(r).toMatchObject({
        ok: true,
        truncated: true,
        stdout_binary: true,
        stdout_bytes: 3000,
        stderr: "",
      });
      const ct = String(r["saved_to"]);
      expect(ct).toMatch(/^\/work\/\.tool-output\/shell-\d+-[0-9a-f]{6}\.log$/u);
      const octets = readFileSync(path.join(test.sandboxPath, ct.slice("/work/".length)));
      expect([octets.length, r["saved_bytes"]]).toEqual([3000, 3000]);
      expect(r["stdout_preview_hex"]).toBe(octets.subarray(0, 512).toString("hex"));
      expect(String(r["hint"])).toContain(`read_file(path="${ct}", offset=0, length=4096)`);
      expect(String(r["hint"])).not.toContain("COMPLETE");
      expect(JSON.stringify(r).length).toBeLessThan(2000);
    } finally {
      await fermer();
    }
  });

  it("stderr binaire derrière un stdout texte ; save_stdout d'une sortie binaire", async () => {
    const { c, fermer } = await client();
    try {
      const { r } = await appeler(c, { command: "echo ok; head -c 600 /dev/zero >&2" });
      expect(r).toMatchObject({
        stdout: "ok\n",
        stderr: "[binary output: 600 bytes, not shown]",
        stderr_bytes: 600,
      });
      expect(r["stderr_preview_hex"]).toBe("00".repeat(512));
      expect(r).not.toHaveProperty("stdout_binary");
      const ct = String(r["saved_to"]);
      const octets = readFileSync(path.join(test.sandboxPath, ct.slice("/work/".length)));
      expect(octets.equals(Buffer.concat([Buffer.from("ok\n\n--- STDERR ---\n"), Buffer.alloc(600)]))).toBe(
        true,
      );
      expect(String(r["hint"])).toContain(
        `It was saved to ${ct} from byte 19: read a byte range with read_file(path="${ct}", offset=19,`,
      );

      const s = (await appeler(c, { command: "head -c 2000 /dev/urandom", save_stdout: "out/x.bin" })).r;
      expect(s).toMatchObject({ saved_to: "/work/out/x.bin", saved_bytes: 2000, stdout_bytes: 2000 });
      expect(s["stdout"]).toBe("[binary output: 2000 bytes, not shown]");
      expect(String(s["hint"])).toContain('read_file(path="/work/out/x.bin", offset=0, length=4096)');
      expect(String(s["hint"])).not.toContain("head and tail");
    } finally {
      await fermer();
    }
  });

  it("une sortie texte ne change pas : tabulations, retours, couleurs ANSI, retour arrière, bip, octet latin-1 isolé", async () => {
    const { c, fermer } = await client();
    try {
      const { r } = await appeler(c, {
        command: "printf 'a\\tb\\r\\n\\033[31mred\\033[0m 5%%\\b\\a caf\\xe9 été\\n'",
      });
      expect(r["stdout"]).toBe("a\tb\r\n\x1b[31mred\x1b[0m 5%\b\x07 caf\ufffd été\n");
      expect(Object.keys(r).filter((k) => /binary|preview|saved/u.test(k))).toEqual([]);
      expect(r["truncated"]).toBe(false);
    } finally {
      await fermer();
    }
  });
});

describe.skipIf(!PYTHON)("files_changed d'appels parallèles (harnais N-10)", () => {
  it("fenêtres chevauchées : note et attribution incertaine sur chaque résultat, renommage visible ; en séquentiel, liste exacte sans l'une ni l'autre", async () => {
    // écart voulu au Python (harnais N-10) : le Python attribuait les changements sans signaler le chevauchement
    writeFileSync(path.join(test.sandboxPath, "r1.txt"), "r\n");
    const { c, fermer } = await client();
    try {
      const [a, b, m] = await Promise.all([
        appeler(c, { command: "sleep 0.4; echo a > s1.txt" }),
        appeler(c, { command: "echo b > s2.txt; sleep 0.8" }),
        appeler(c, { command: "sleep 0.2; mv r1.txt r2.txt" }),
      ]);
      const chemins = (r: Dict): Dict =>
        Object.fromEntries((r["files_changed"] as Dict[]).map((e) => [e["path"], e["change"]]));
      for (const x of [a, b, m])
        expect([x.r["files_changed_note"], x.r["files_changed_attribution"]]).toEqual([
          NOTE_CONCURRENTE,
          "uncertain",
        ]);
      expect(chemins(a.r)).toMatchObject({ "/work/s1.txt": "created" });
      expect(chemins(b.r)).toMatchObject({ "/work/s2.txt": "created" });
      expect(chemins(m.r)).toMatchObject({ "/work/r1.txt": "deleted", "/work/r2.txt": "created" });

      const seul = (await appeler(c, { command: "mv s1.txt s3.txt; rm s2.txt; echo t > t.txt; rm t.txt" })).r;
      expect(seul).not.toHaveProperty("files_changed_note");
      expect(seul).not.toHaveProperty("files_changed_attribution");
      expect((seul["files_changed"] as Dict[]).map((e) => [e["path"], e["change"]])).toEqual([
        ["/work/s1.txt", "deleted"],
        ["/work/s2.txt", "deleted"],
        ["/work/s3.txt", "created"],
      ]);
    } finally {
      await fermer();
    }
  });
});

describe.skipIf(!PYTHON)("alerte de remplissage dans execute_shell (harnais N-08)", () => {
  it("disk_warning seulement au-delà du seuil ; mesure lente ou en panne : rien, sans retarder la commande", async () => {
    // écart voulu au Python (harnais N-08) : le Python n'alertait jamais
    const vus: [number, string][] = [];
    let reponse: () => Promise<string | null> = async () =>
      "Disk space low: the disk holding /work is 93% full.";
    const { c, fermer } = await client({
      alerte: (uid, rac) => {
        vus.push([uid, rac]);
        return reponse();
      },
    });
    try {
      const plein = (await appeler(c, { command: "echo hi" })).r;
      expect(plein).toMatchObject({
        stdout: "hi\n",
        disk_warning: "Disk space low: the disk holding /work is 93% full.",
      });
      expect(vus).toEqual([[42, test.sandboxPath]]);
      reponse = async () => null;
      expect((await appeler(c, { command: "echo hi" })).r).not.toHaveProperty("disk_warning");
      reponse = () => Promise.reject(new Error("statfs"));
      expect((await appeler(c, { command: "echo hi" })).r).not.toHaveProperty("disk_warning");
      reponse = () => new Promise(() => undefined);
      const t0 = performance.now();
      expect((await appeler(c, { command: "echo hi" })).r).not.toHaveProperty("disk_warning");
      expect(performance.now() - t0).toBeLessThan(ATTENTE_ALERTE_MS + 3000);
      const avant = vus.length;
      reponse = async () => "Disk space low: the disk holding /work is 93% full.";
      expect((await appeler(c, { command: "sleep 1", background: true })).r).toMatchObject({
        background: true,
        disk_warning: "Disk space low: the disk holding /work is 93% full.",
      });
      expect(vus.length).toBe(avant + 1);
    } finally {
      await fermer();
    }
  });

  it("chemin réel : le quota du compte vient du rappel au core, l'usage du bac est mesuré en pourcentage", async () => {
    writeFileSync(path.join(test.sandboxPath, "gros.bin"), Buffer.alloc(980 * 1024));
    const rappel = { ...RAPPEL_ABSENT, quotaCompte: async () => 1 };
    const pont = new PontExec({
      bac: async () => bac,
      journal: { info: () => undefined, warn: () => undefined },
    });
    const a = appuisParDefaut(pont, async () => test.sandboxPath, rappel);
    expect(await a.alerteDisque?.(4242, test.sandboxPath)).toMatch(
      /your sandbox uses \d+% of its 1 MB quota/u,
    );
    expect(
      String(
        await appuisParDefaut(pont, async () => test.sandboxPath).alerteDisque?.(4242, test.sandboxPath),
      ),
    ).not.toMatch(/quota/u);
  });
});
