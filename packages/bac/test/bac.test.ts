// SPDX-License-Identifier: MIT
/** packages/bac/test/bac.test.ts — comportement du bac (portage des tests pytest) : cache de disponibilité, registre, verrou de cycle de vie, migration de /work, exec en flux, chargeur d'image, CLI Docker. */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

import { brancherJournal, journalStderr } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { VerrouFichier } from "@elpis/verrous";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appelDocker,
  DockerCli,
  ensureContainerRunning,
  ensureImageLoaded,
  ensureWorkSubdir,
  getImageLoadState,
  getUserSandbox,
  imageStateDict,
  ipConteneurApercu,
  previewContainerIp,
  privdrop,
  profilRetenu,
  ReadinessCache,
  reglagesChargement,
  reglagesCycle,
  resetImageLoadState,
  resetUserSandboxCache,
  retenirChoixProfil,
  runningContainerStats,
  sandboxAdminConfigDepuis,
  sousVerrouDeCycle,
  UserSandbox,
  WORK_MARKER,
  WORK_RESERVED,
} from "../src/index";
import type { CliDocker, ProcessusDocker } from "../src/index";
import { dossierTemporaire, FauxCli } from "./aides";

let tmp = "";
let nettoyer: () => void = () => undefined;
let restaurer: () => void = () => undefined;
let avertis: string[] = [];

beforeEach(() => {
  [tmp, nettoyer] = dossierTemporaire("elpis-bac-");
  restaurer = surchargerConfig({
    SANDBOX_DIR: path.join(tmp, "sb"),
    CONFIG_JSON_PATH: path.join(tmp, "config.json"),
  });
  avertis = [];
  brancherJournal((d) => ({ ...journalStderr(d), warn: (...a: unknown[]) => avertis.push(a.join(" ")) }));
  vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
});

afterEach(() => {
  vi.unstubAllEnvs();
  brancherJournal(null);
  restaurer();
  nettoyer();
  resetUserSandboxCache();
  privdrop.oublierSondes();
});

describe("ReadinessCache (test_readiness_cache.py)", () => {
  function horloge(): { t: number; f: () => number } {
    const h = { t: 1000, f: () => h.t };
    return h;
  }

  it("confirmation : flux sain exigé, TTL, arrêt, inconnu, invalidation, coupure par l'environnement", () => {
    vi.stubEnv("SANDBOX_READINESS_CACHE", "1");
    const h = horloge();
    const c = new ReadinessCache(10, h.f);
    c.recordRunning("x");
    expect(c.confirmedRunning("x")).toBe(false);
    c.setEventsHealthy(true);
    expect(c.confirmedRunning("x")).toBe(true);
    h.t += 9.9;
    expect(c.confirmedRunning("x")).toBe(true);
    h.t += 0.2;
    expect(c.confirmedRunning("x")).toBe(false);
    c.recordRunning("x");
    c.recordStopped("x");
    expect(c.confirmedRunning("x")).toBe(false);
    expect(c.confirmedRunning("jamais-vu")).toBe(false);
    c.recordRunning("x");
    c.invalidate("x");
    expect(c.confirmedRunning("x")).toBe(false);
    c.recordRunning("x");
    c.setEventsHealthy(false);
    expect(c.confirmedRunning("x")).toBe(false);
    c.setEventsHealthy(true);
    for (const [v, attendu] of [
      [" off ", false],
      ["0", false],
      ["false", false],
      ["", true],
      ["oui", true],
    ] as const) {
      vi.stubEnv("SANDBOX_READINESS_CACHE", v);
      expect(c.confirmedRunning("x"), v).toBe(attendu);
    }
  });

  it("écart voulu au Python : TTL de 5 min par défaut (15 s en Python, un inspect par commande espacée)", () => {
    vi.stubEnv("SANDBOX_READINESS_CACHE", "1");
    const h = horloge();
    const c = new ReadinessCache(undefined, h.f);
    c.setEventsHealthy(true);
    c.recordRunning("x");
    h.t += 299;
    expect(c.confirmedRunning("x")).toBe(true);
    h.t += 2;
    expect(c.confirmedRunning("x")).toBe(false);
  });

  it("événements : start/unpause/restart en marche, die/stop/kill/pause/destroy/oom arrêtés, le reste ignoré", () => {
    vi.stubEnv("SANDBOX_READINESS_CACHE", "1");
    const c = new ReadinessCache(10, horloge().f);
    c.setEventsHealthy(true);
    for (const [action, attendu] of [
      ["start", true],
      ["die", false],
      ["unpause", true],
      ["kill", false],
      ["restart", true],
      ["exec_create", true],
      [" OOM ", false],
    ] as const) {
      c.applyEvent("x", action);
      expect(c.confirmedRunning("x"), action).toBe(attendu);
    }
  });

  it("stateStamp suit les événements et la santé du flux (cache d'IP d'aperçu)", () => {
    const h = horloge();
    h.t = 100;
    const c = new ReadinessCache(15, h.f);
    c.applyEvent("sb", "start");
    expect(c.stateStamp("sb")).toBeNull();
    c.setEventsHealthy(true);
    const premier = c.stateStamp("sb");
    expect(premier).toEqual([true, 100]);
    h.t = 101;
    c.applyEvent("sb", "die");
    c.applyEvent("sb", "start");
    expect(c.stateStamp("sb")).not.toEqual(premier);
  });
});

describe("registre (get_user_sandbox)", () => {
  it("une instance par (id, nom) : deux comptes non résolus ne partagent rien, oubli par compte", () => {
    const a = getUserSandbox(0, "alice", path.join(tmp, "alice", "work"));
    const b = getUserSandbox(0, "bob", path.join(tmp, "bob", "work"));
    expect(a).not.toBe(b);
    expect(b.sandboxPath).toBe(path.join(tmp, "bob", "work"));
    expect(getUserSandbox(0, "alice", path.join(tmp, "x"))).toBe(a);
    const c = getUserSandbox(2, "carol", "/c", "web");
    expect(getUserSandbox(2, "carol", "/c").networkProfileId).toBe("web");
    expect(getUserSandbox(2, "carol", "/c", "lan").networkProfileId).toBe("lan");
    resetUserSandboxCache(0);
    expect(getUserSandbox(0, "alice", "/autre")).not.toBe(a);
    expect(getUserSandbox(2, "carol", "/c")).toBe(c);
    resetUserSandboxCache();
    expect(getUserSandbox(2, "carol", "/c")).not.toBe(c);
  });

  it("profil changé sur l'instance : options du conteneur revérifiées au prochain ensureRunning", () => {
    const a = getUserSandbox(4, "eve", "/e", "web");
    a.configVerified = true;
    getUserSandbox(4, "eve", "/e", "web");
    expect(a.configVerified).toBe(true);
    getUserSandbox(4, "eve", "/e", "isolated");
    expect([a.networkProfileId, a.configVerified, a.configRetryAt]).toEqual(["isolated", false, 0]);
  });

  it("choix de profil retenu tant que l'enveloppe ne le porte pas ; enveloppe à jour ou expiration : oublié", () => {
    expect(profilRetenu(11, "isolated")).toBe("isolated");
    retenirChoixProfil(11, "web");
    expect(profilRetenu(11, "isolated")).toBe("web");
    expect(profilRetenu(11, "web")).toBe("web");
    expect(profilRetenu(11, "isolated")).toBe("isolated");
  });

  it("configuration relue à chaque appel (console admin)", () => {
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ executors: { exec_user: "0:0" } }));
    const a = getUserSandbox(3, "dan", "/d");
    expect(a.cfg.exec_user).toBe("0:0");
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ executors: { image: "autre/img:2" } }));
    expect(getUserSandbox(3, "dan", "/d").cfg).toMatchObject({
      exec_user: "10001:10001",
      image: "autre/img:2",
    });
  });
});

describe("verrou de cycle de vie par compte", () => {
  it("sérialise un compte dans le process, pas deux comptes ; fichier rendu ensuite", async () => {
    const ordre: string[] = [];
    const tache = (uid: number, nom: string, ms: number) =>
      sousVerrouDeCycle(uid, async () => {
        ordre.push(`${nom}+`);
        expect(existsSync(path.join(tmp, "sb", ".lifecycle_locks", `u${uid}.lock`))).toBe(true);
        await new Promise((r) => setTimeout(r, ms));
        ordre.push(`${nom}-`);
      });
    await Promise.all([tache(7, "a", 40), tache(7, "b", 1), tache(8, "c", 1)]);
    expect(ordre.indexOf("a-")).toBeLessThan(ordre.indexOf("b+"));
    expect(ordre.indexOf("c-")).toBeLessThan(ordre.indexOf("a-"));
    expect(readdirSync(path.join(tmp, "sb", ".lifecycle_locks"))).toEqual([]);
    expect(statSync(path.join(tmp, "sb", ".lifecycle_locks")).mode & 0o777).toBe(0o700);
  });

  it("annulation pendant l'attente (file du process ou fichier) : raison levée, file libérée", async () => {
    let lacher = (): void => undefined;
    let entre = (): void => undefined;
    const dedans = new Promise<void>((ok) => (entre = ok));
    const tenu = sousVerrouDeCycle(
      12,
      () =>
        new Promise<void>((ok) => {
          lacher = ok;
          entre();
        }),
    );
    await dedans;
    const ac = new AbortController();
    const attente = sousVerrouDeCycle(12, async () => "jamais", ac.signal);
    ac.abort(new Error("requête abandonnée"));
    await expect(attente).rejects.toThrow("requête abandonnée");
    lacher();
    await tenu;
    expect(await sousVerrouDeCycle(12, async () => "libre")).toBe("libre");
    const chemin = path.join(tmp, "sb", ".lifecycle_locks", "u13.lock");
    const autre = new VerrouFichier(chemin);
    await autre.acquerir();
    const ac2 = new AbortController();
    const fichier = sousVerrouDeCycle(13, async () => "jamais", ac2.signal);
    setTimeout(() => ac2.abort(new Error("client parti")), 50);
    await expect(fichier).rejects.toThrow("client parti");
    await autre.rendre();
  });

  it("tenu ailleurs : au-delà du délai on continue sans (fail-open, journalisé)", async () => {
    const chemin = path.join(tmp, "sb", ".lifecycle_locks", "u9.lock");
    mkdirSync(path.dirname(chemin), { recursive: true });
    const autre = new VerrouFichier(chemin);
    await autre.acquerir();
    const delai = reglagesCycle.delaiMs;
    reglagesCycle.delaiMs = 300;
    try {
      const t0 = performance.now();
      const vu = await sousVerrouDeCycle(9, async () => existsSync(chemin));
      expect(vu).toBe(true);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(290);
      expect(avertis.join("\n")).toContain("verrou de cycle de vie inter-process non obtenu (user_id=9)");
    } finally {
      reglagesCycle.delaiMs = delai;
      await autre.rendre();
    }
  });
});

describe("ensureWorkSubdir (test_work_subdir_migration.py)", () => {
  function semer(p: string, noms: string[]): void {
    mkdirSync(p, { recursive: true });
    for (const n of noms) {
      if (n.endsWith("/")) {
        mkdirSync(path.join(p, n), { recursive: true });
        writeFileSync(path.join(p, n, "child.txt"), "x");
      } else writeFileSync(path.join(p, n), `content-of-${n}`);
    }
  }

  it("compte neuf : work vide créé, marqueur posé", async () => {
    const p = path.join(tmp, "alice");
    const work = await ensureWorkSubdir(p);
    expect(work).toBe(path.join(p, "work"));
    expect(readdirSync(work)).toEqual([]);
    expect(statSync(path.join(p, WORK_MARKER)).isFile()).toBe(true);
    expect(readFileSync(path.join(p, WORK_MARKER), "utf-8")).toBe("1");
  });

  it("disposition à plat migrée, entrées réservées gardées à P", async () => {
    const p = path.join(tmp, "bob");
    semer(p, [
      "main.py",
      ".bashrc",
      ".git-credentials.json",
      "src/",
      "skills/",
      ".memory/",
      ".skills-mirror.tmp/",
    ]);
    writeFileSync(path.join(p, ".memory", "MEMORY.md"), "souvenir");
    const work = await ensureWorkSubdir(p);
    for (const n of ["skills", ".memory", ".skills-mirror.tmp"]) {
      expect(existsSync(path.join(p, n)), n).toBe(true);
      expect(existsSync(path.join(work, n)), n).toBe(false);
    }
    for (const n of ["main.py", ".bashrc", ".git-credentials.json", "src"]) {
      expect(existsSync(path.join(work, n)), n).toBe(true);
      expect(existsSync(path.join(p, n)), n).toBe(false);
    }
    expect(readFileSync(path.join(work, "src", "child.txt"), "utf-8")).toBe("x");
  });

  it("idempotent, reprise d'une migration interrompue, garde de collision", async () => {
    const p = path.join(tmp, "dave");
    semer(p, ["one.txt", "two.txt"]);
    mkdirSync(path.join(p, "work"));
    writeFileSync(path.join(p, "work", "one.txt"), "DEJA");
    await ensureWorkSubdir(p);
    expect(readFileSync(path.join(p, "work", "one.txt"), "utf-8")).toBe("DEJA");
    expect(existsSync(path.join(p, "one.txt"))).toBe(true);
    expect(readFileSync(path.join(p, "work", "two.txt"), "utf-8")).toBe("content-of-two.txt");
    writeFileSync(path.join(p, "work", "two.txt"), "EDITE");
    await ensureWorkSubdir(p);
    expect(readFileSync(path.join(p, "work", "two.txt"), "utf-8")).toBe("EDITE");
    const q = path.join(tmp, "erin");
    semer(q, ["keep.txt"]);
    writeFileSync(path.join(q, "work"), "un fichier");
    await ensureWorkSubdir(q);
    expect(readFileSync(path.join(q, "work"), "utf-8")).toBe("un fichier");
    expect(existsSync(path.join(q, "keep.txt"))).toBe(true);
    expect(existsSync(path.join(q, WORK_MARKER))).toBe(false);
  });

  it("migrations concurrentes : chaque fichier déplacé une fois, aucun reste", async () => {
    const p = path.join(tmp, "frank");
    const fichiers = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
    semer(p, fichiers);
    await Promise.all(Array.from({ length: 5 }, () => ensureWorkSubdir(p)));
    for (const n of fichiers) expect(readFileSync(path.join(p, "work", n), "utf-8")).toBe(`content-of-${n}`);
    expect(readdirSync(p).filter((n) => !WORK_RESERVED.has(n))).toEqual([]);
  });
});

/** CLI qui exécute LOCALEMENT la commande enveloppée d'un `docker exec` (après `sh -c ENVELOPPE -- délai`). */
class CliLocale extends FauxCli implements CliDocker {
  tues = 0;

  override lancer(args: readonly string[], options: { entree: boolean }): ProcessusDocker {
    this.lances.push([this.bin, ...args]);
    const i = args.findIndex((a) => a.startsWith("umask 0022"));
    const cmd = args.slice(i + 3);
    const p = spawn(cmd[0] ?? "true", cmd.slice(1), {
      stdio: [options.entree ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const fin = new Promise<number>((ok) => p.once("exit", (code, sig) => ok(code ?? (sig ? -9 : -1))));
    return {
      stdin: p.stdin,
      stdout: p.stdout as Readable,
      stderr: p.stderr as Readable,
      fin,
      tuer: () => {
        this.tues += 1;
        p.kill("SIGKILL");
      },
    };
  }
}

function bacLocal(
  cli: CliDocker = new CliLocale([{ motif: ["container", "inspect"], out: "cid|/elpis-sb-t|true|i|d" }]),
) {
  const sb = new UserSandbox(1, "t", path.join(tmp, "t", "work"), sandboxAdminConfigDepuis({}), null, {
    cli,
  });
  sb.mountVerified = sb.configVerified = sb.modesVerified = true;
  return sb;
}

describe("exec en flux (test_user_sandbox_stream.py)", () => {
  it("paquets relayés dans l'ordre, résultat identique au tampon final", async () => {
    const paquets: [string, string][] = [];
    const r = await bacLocal().exec(["bash", "-c", "printf 'out1\\n'; printf 'err1\\n' >&2; printf 'out2'"], {
      timeoutS: 10,
      onChunk: (f, d) => paquets.push([f, d.toString()]),
    });
    expect([r.returncode, r.stdout.toString(), r.stderr.toString(), r.timed_out]).toEqual([
      0,
      "out1\nout2",
      "err1\n",
      false,
    ]);
    expect(
      paquets
        .filter(([f]) => f === "stdout")
        .map(([, d]) => d)
        .join(""),
    ).toBe("out1\nout2");
    expect(
      paquets
        .filter(([f]) => f === "stderr")
        .map(([, d]) => d)
        .join(""),
    ).toBe("err1\n");
    expect(r.container_id).toBe("cid");
  });

  it("rappel cassé sans effet ; entrée écrite puis fermée", async () => {
    const r = await bacLocal().exec(["bash", "-c", "echo survie"], {
      timeoutS: 10,
      onChunk: () => {
        throw new Error("cassé");
      },
    });
    expect(r.stdout.toString()).toBe("survie\n");
    const r2 = await bacLocal().exec(["cat"], { timeoutS: 10, stdin: Buffer.from("ping\0pong") });
    expect(r2.stdout).toEqual(Buffer.from("ping\0pong"));
  });

  it("délai de l'hôte (délai + 10 s) : processus tué, sortie partielle gardée", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cli = new CliLocale([{ motif: ["container", "inspect"], out: "cid|/n|true|i|d" }]);
    try {
      const promesse = bacLocal(cli).exec(["bash", "-c", "printf partiel; sleep 30"], { timeoutS: 1 });
      await vi.waitFor(() => expect(cli.lances.length).toBe(1));
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(11_500);
      const r = await promesse;
      expect([r.timed_out, r.stdout.toString(), cli.tues]).toEqual([true, "partiel", 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("annulation : docker exec tué, raison levée", async () => {
    const cli = new CliLocale([{ motif: ["container", "inspect"], out: "cid|/n|true|i|d" }]);
    const ac = new AbortController();
    const promesse = bacLocal(cli).exec(["sleep", "30"], { signal: ac.signal });
    await vi.waitFor(() => expect(cli.lances.length).toBe(1));
    ac.abort(new Error("tour annulé"));
    await expect(promesse).rejects.toThrow("tour annulé");
    expect(cli.tues).toBe(1);
  });

  it("délai démesuré : pas de filet de l'hôte armé (pas de dépassement du minuteur de Node)", async () => {
    const r = await bacLocal().exec(["sh", "-c", "sleep 0.1; echo fini"], { timeoutS: 3_000_000 });
    expect([r.returncode, r.timed_out, r.stdout.toString()]).toEqual([0, false, "fini\n"]);
  });

  it("sortie bornée : tête et queue gardées, milieu signalé", async () => {
    vi.stubEnv("SANDBOX_EXEC_CAPTURE_MAX_BYTES", "65536");
    const r = await bacLocal().exec(["bash", "-c", "head -c 200000 /dev/zero | tr '\\0' a; printf FIN"], {
      timeoutS: 10,
    });
    const s = r.stdout.toString();
    expect(s.startsWith("a".repeat(32768))).toBe(true);
    expect(s.endsWith("FIN")).toBe(true);
    expect(s).toContain("bytes omitted: output exceeded the 65536 bytes capture limit");
  });
});

/** Faux binaire docker (script shell) : `image inspect` selon un fichier, `load` qui attend puis réussit ou échoue. */
function fauxDocker(etat: { charge?: boolean; load?: "ok" | "ko" | "lent" }): string {
  const bin = path.join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const marque = path.join(tmp, "image-chargee");
  if (etat.charge) writeFileSync(marque, "1");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
echo "$*" >> "${path.join(tmp, "appels.log")}"
case "$1" in
  image) [ -f "${marque}" ] && exit 0; exit 1 ;;
  load) ${etat.load === "lent" ? "sleep 0.3;" : ""} ${etat.load === "ko" ? 'echo "erreur de chargement" >&2; exit 1' : `touch "${marque}"; echo "Loaded image"; exit 0`} ;;
esac
exit 0
`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
  return bin;
}

describe("chargeur d'image (_image_loader.py)", () => {
  beforeEach(() => resetImageLoadState());
  afterEach(() => resetImageLoadState());

  it("déjà présente : loaded sans docker load", async () => {
    fauxDocker({ charge: true });
    const s = await ensureImageLoaded("elpis/sandbox:9");
    expect([s.status, s.progress_msg]).toEqual(["loaded", "Image déjà présente"]);
    expect(await ensureImageLoaded("elpis/sandbox:9")).toBe(s);
  });

  it("archive introuvable : not_found, chemins cherchés listés", async () => {
    fauxDocker({});
    vi.stubEnv("ELPIS_SANDBOX_IMAGE_TAR", path.join(tmp, "absente.tar"));
    const s = await ensureImageLoaded("elpis/sandbox:9");
    expect(s.status).toBe("not_found");
    expect(s.error).toContain(`  • ${path.join(tmp, "absente.tar")}`);
    expect(imageStateDict(s)).toEqual({
      status: "not_found",
      image: "elpis/sandbox:9",
      archive_path: null,
      progress_msg: "Archive introuvable",
      error: s.error,
    });
  });

  it("chargement de fond unique pour des appels concurrents ; blocking attend la fin", async () => {
    fauxDocker({ load: "lent" });
    const archive = path.join(tmp, "img.tar.gz");
    writeFileSync(archive, Buffer.alloc(3 * 1024 * 1024));
    vi.stubEnv("ELPIS_SANDBOX_IMAGE_TAR", archive);
    const [a, b] = await Promise.all([ensureImageLoaded("img:1"), ensureImageLoaded("img:1")]);
    expect([a.status, b.status, a.progress_msg]).toEqual([
      "loading",
      "loading",
      "Chargement de l'image (3 MB)…",
    ]);
    expect(Object.keys(imageStateDict(getImageLoadState()))).toContain("elapsed_s");
    const fin = await ensureImageLoaded("img:1", { blocking: true });
    expect([fin.status, fin.progress_msg]).toEqual(["loaded", "Image chargée"]);
    expect(Object.keys(imageStateDict(fin))).toContain("duration_s");
    const loads = readFileSync(path.join(tmp, "appels.log"), "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("load"));
    expect(loads).toEqual([`load -i ${archive}`]);
  });

  it("docker load en échec : error et message ; chargement périmé requalifié puis relancé", async () => {
    fauxDocker({ load: "ko" });
    const archive = path.join(tmp, "img.tar");
    writeFileSync(archive, "x");
    vi.stubEnv("ELPIS_SANDBOX_IMAGE_TAR", archive);
    const s = await ensureImageLoaded("img:2", { blocking: true });
    expect([s.status, s.error]).toEqual(["error", "docker load échec : erreur de chargement"]);
    const perime = reglagesChargement.perimeS;
    reglagesChargement.perimeS = -1;
    try {
      fauxDocker({ load: "lent" });
      const t = await ensureImageLoaded("img:2");
      expect(t.status).toBe("loading");
      const u = await ensureImageLoaded("img:2");
      expect(u.status).toBe("loading");
    } finally {
      reglagesChargement.perimeS = perime;
      await ensureImageLoaded("img:2", { blocking: true });
    }
  });
});

describe("CLI Docker", () => {
  it("délai : 124 et « docker call timeout » ; entrée standard écrite ; annulation tue le processus", async () => {
    const bin = path.join(tmp, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "docker"),
      '#!/bin/sh\ncase "$1" in\n  dort) exec sleep 5 ;;\n  chat) cat ;;\nesac\n',
    );
    chmodSync(path.join(bin, "docker"), 0o755);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    const cli = new DockerCli();
    expect(cli.bin).toBe(path.join(bin, "docker"));
    const [rc, out, err] = await cli.call(["dort"], { timeoutS: 0.2 });
    expect([rc, out.toString(), err.toString()]).toEqual([124, "", "docker call timeout"]);
    const [rc2, out2] = await cli.call(["chat"], { entree: Buffer.from("bonjour") });
    expect([rc2, out2.toString()]).toEqual([0, "bonjour"]);
    const ac = new AbortController();
    const appel = cli.call(["dort"], { signal: ac.signal });
    ac.abort(new Error("annulé"));
    await expect(appel).rejects.toThrow("annulé");
    const r = await appelDocker(["dort"], 100, { binaire: path.join(bin, "docker") });
    expect([r.delaiDepasse, r.code]).toEqual([true, null]);
  });

  it("binaire absent : erreur de lancement au texte d'OSError", async () => {
    const absent = path.join(tmp, "absent", "docker");
    const cli = new DockerCli(absent);
    await expect(cli.call(["version"])).rejects.toThrow(`[Errno 2] No such file or directory: '${absent}'`);
  });
});

describe("compte courant, statistiques, IP d'aperçu", () => {
  it("ensureContainerRunning : 503 si le conteneur ne tourne pas", async () => {
    fauxDocker({});
    await expect(ensureContainerRunning(5)).rejects.toMatchObject({ statusCode: 503 });
    expect(existsSync(path.join(tmp, "sb", "user_5", "work"))).toBe(true);
  });

  it("running_container_stats : conteneur en marche du compte, CPU et mémoire en Mio", async () => {
    const cli = new FauxCli([
      { motif: ["ps"], out: "elpis-sb-a\nelpis-sb-b\n" },
      { motif: ["stats"], out: " 12.5%| 1.5GiB / 2GiB \n" },
    ]);
    expect(await runningContainerStats(4, cli)).toEqual({ cpu_pct: 12.5, mem_mb: 1536 });
    expect(cli.appels[0]).toEqual([
      "ps",
      "--filter",
      "label=elpis.user_id=4",
      "--filter",
      "status=running",
      "--format",
      "{{.Names}}",
      5,
    ]);
    expect(await runningContainerStats(4, new FauxCli([{ motif: ["ps"], out: " " }]))).toBeNull();
    const illisible = new FauxCli([
      { motif: ["ps"], out: "n" },
      { motif: ["stats"], out: "x%|1MiB" },
    ]);
    expect(await runningContainerStats(4, illisible)).toBeNull();
    const sansMem = new FauxCli([
      { motif: ["ps"], out: "n" },
      { motif: ["stats"], out: "1|?" },
    ]);
    expect(await runningContainerStats(4, sansMem)).toEqual({ cpu_pct: 1, mem_mb: 0 });
  });

  it("previewContainerIp : pas de mémoire sans flux d'événements sain", async () => {
    fauxDocker({});
    expect(await previewContainerIp(6, "zoe")).toBeNull();
    expect(await ipConteneurApercu.ip(6, "zoe")).toBeNull();
    expect(ipConteneurApercu.oublier(6)).toBeUndefined();
  });
});

describe("privdrop sur un vrai bac (test_privdrop_net_admin.py)", () => {
  it("arrêt et destruction oublient le verdict du conteneur", async () => {
    const sb = new UserSandbox(1, "alice", path.join(tmp, "a", "work"), sandboxAdminConfigDepuis({}), null, {
      cli: new FauxCli(),
    });
    privdrop.remember(sb.containerName, "10001:10001", true);
    privdrop.remember("elpis-sb-autre", "10001:10001", true);
    await sb.stop();
    expect(privdrop.cached(sb.containerName, "10001:10001")).toBeNull();
    expect(privdrop.cached("elpis-sb-autre", "10001:10001")).toBe(true);
    privdrop.remember(sb.containerName, "10001:10001", true);
    await sb.destroy();
    expect(privdrop.cached(sb.containerName, "10001:10001")).toBeNull();
  });
});
