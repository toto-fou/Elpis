// SPDX-License-Identifier: MIT
/** apps/toolhost/test/skill-run.test.ts — famille skill_run : archive du dossier telle que l'extrait GNU tar, taille de mise en place, magasin ou miroir du compte, isolation entre comptes, échecs de mise en place et d'exécution. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { invalidateSkillsScanCache } from "@elpis/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { archiverDossier, ErreurArchive, tailleDossier } from "../src/mcp/skill-run/archive";
import { dossierPersoDuCompte, familleSkillRun, RUNNER, skillRunScript } from "../src/mcp/skill-run/outil";
import type { AppuisSkillRun, ArgsSkillRun } from "../src/mcp/skill-run/outil";
import { ctxTest, membresTar } from "./aides-skill-run";

const MD = (n: string): string => `---\nname: ${n}\ndescription: d\n---\n\nCorps.\n`;

let base = "";
let restaurer: () => void = () => undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-skill-run-")));
  vi.stubEnv("APP_SKILLS_DIR", path.join(base, "skills"));
  vi.stubEnv("APP_USER_SKILLS_DIR", path.join(base, "user_skills"));
  restaurer = surchargerConfig({ SANDBOX_DIR: path.join(base, "sb") });
  mkdirSync(path.join(base, "skills"), { recursive: true });
  invalidateSkillsScanCache();
});

afterEach(() => {
  restaurer();
  vi.unstubAllEnvs();
  invalidateSkillsScanCache();
  rmSync(base, { recursive: true, force: true });
});

function ecrire(p: string, contenu: string, mode = 0o644): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, contenu);
  chmodSync(p, mode);
}

/** Arbre lu sur le disque : nature, mode, contenu ou cible, sans suivre les liens. */
function arbre(racine: string, rel = ""): Dict {
  const sortie: Dict = {};
  for (const nom of readdirSync(path.join(racine, rel)).sort()) {
    const r = rel ? `${rel}/${nom}` : nom;
    const p = path.join(racine, r);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) sortie[r] = ["l", readlinkSync(p)];
    else if (s.isDirectory()) {
      sortie[r] = ["d", s.mode & 0o7777];
      Object.assign(sortie, arbre(racine, r));
    } else sortie[r] = ["f", s.mode & 0o7777, readFileSync(p, "utf8"), s.nlink];
  }
  return sortie;
}

/** Appuis doublés : exécution notée, relevé noté. */
function appuis(
  journal: unknown[],
  resultat: Dict | Error = { returncode: 0, stdout: "ok" },
): AppuisSkillRun {
  return {
    dossierPerso: dossierPersoDuCompte,
    racine: async (u) => path.join(base, "sb", u, "work"),
    userIdFor: async () => 7,
    uidFor: async () => 7,
    releve: () => ({
      debut: async () => void journal.push("debut"),
      fin: async () => void journal.push("fin"),
      attacher: (r) => r,
    }),
    executer: async (o) => {
      journal.push(["exec", o.username, o.tokens.slice(4), o.stdin?.length ?? 0]);
      if (resultat instanceof Error) throw resultat;
      return { ...resultat };
    },
  };
}

const appel = (name: string, script: string, autres: Partial<ArgsSkillRun> = {}): ArgsSkillRun => ({
  name,
  script,
  args: null,
  env: null,
  timeout_sec: null,
  ...autres,
});

describe("archive du dossier d'un skill", () => {
  it("GNU tar extrait le même arbre : modes, dossiers vides, liens gardés en liens, noms longs et non ASCII, liens durs, dates à la nanoseconde", async () => {
    const d = path.join(base, "s");
    ecrire(path.join(d, "SKILL.md"), MD("s"));
    ecrire(path.join(d, "scripts", "run.sh"), "echo hi\n", 0o755);
    ecrire(path.join(d, "scripts", "secret"), "s", 0o600);
    ecrire(path.join(d, "données é", `${"n".repeat(120)}.py`), "print(1)\n");
    mkdirSync(path.join(d, "vide"), { mode: 0o700 });
    chmodSync(path.join(d, "vide"), 0o700);
    symlinkSync("scripts/run.sh", path.join(d, "lien.sh"));
    symlinkSync(`/${"x".repeat(150)}`, path.join(d, "lien-long"));
    linkSync(path.join(d, "scripts", "run.sh"), path.join(d, "dur.sh"));
    utimesSync(path.join(d, "SKILL.md"), 1_700_000_000.25, 1_700_000_000.25);
    const cible = path.join(base, "extrait");
    mkdirSync(cible);
    execFileSync("tar", ["-xpf", "-", "-C", cible], { input: await archiverDossier(d) });
    expect(arbre(cible)).toEqual(arbre(d));
    expect(lstatSync(path.join(cible, "SKILL.md")).mtimeMs).toBe(1_700_000_000_250);
    const archive = await archiverDossier(d);
    expect(archive.length % 10_240).toBe(0);
  });

  it("tube gardé en membre de type 6, comme tarfile", async () => {
    const d = path.join(base, "tube");
    ecrire(path.join(d, "SKILL.md"), MD("tube"));
    execFileSync("mkfifo", [path.join(d, "tube")]);
    const membres = membresTar(await archiverDossier(d));
    expect(membres.map((m) => [m["nom"], m["nature"]])).toEqual([
      [".", "d"],
      ["./SKILL.md", "f"],
      ["./tube", "6"],
    ]);
  });

  it("taille : fichiers et cibles des liens vers un fichier, dossiers liés non parcourus", async () => {
    const d = path.join(base, "t");
    ecrire(path.join(d, "a"), "12345");
    ecrire(path.join(base, "dehors", "gros"), "x".repeat(100));
    symlinkSync(path.join(base, "dehors", "gros"), path.join(d, "lien"));
    symlinkSync(path.join(base, "dehors"), path.join(d, "dossier-lie"));
    symlinkSync(path.join(base, "absent"), path.join(d, "mort"));
    expect(await tailleDossier(d)).toBe(105);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fichier illisible : erreur au texte de Python, outil en skill_run_failed (réessayable)",
    async () => {
      const d = path.join(base, "user_skills", "alice", "pkg");
      ecrire(path.join(d, "SKILL.md"), MD("pkg"));
      ecrire(path.join(d, "run.py"), "x");
      ecrire(path.join(d, "ferme"), "x", 0o000);
      await expect(archiverDossier(d)).rejects.toThrow(
        new ErreurArchive(`[Errno 13] Permission denied: '${path.join(d, "ferme")}'`),
      );
      const journal: unknown[] = [];
      const r = await skillRunScript(appel("pkg", "run.py"), ctxTest({ username: "alice" }), appuis(journal));
      expect(r).toEqual({
        ok: false,
        error: "skill_run_failed",
        message: `staging failed: [Errno 13] Permission denied: '${path.join(d, "ferme")}'`,
        fix: null,
        next_action: null,
        retryable: true,
      });
      expect(journal).toEqual([]);
    },
  );
});

describe("skills du compte : magasin, miroir, isolation", () => {
  it("magasin protégé s'il existe ; sinon miroir <compte>/skills lu sur place ; sinon le magasin (global seul)", () => {
    const magasin = path.join(base, "user_skills", "alice");
    const miroir = path.join(base, "sb", "alice", "skills");
    expect(dossierPersoDuCompte("alice")).toBe(magasin);
    ecrire(path.join(miroir, "m", "SKILL.md"), MD("m"));
    expect(dossierPersoDuCompte("alice")).toBe(miroir);
    mkdirSync(magasin, { recursive: true });
    expect(dossierPersoDuCompte("alice")).toBe(magasin);
    expect(lstatSync(path.join(miroir, "m", "SKILL.md")).isFile()).toBe(true);
    expect(dossierPersoDuCompte("Jean.Dupont!")).toBe(path.join(base, "user_skills", "JeanDupont"));
  });

  it("le script d'un autre compte n'est jamais trouvé ; le global l'est pour tous ; l'archive part dans le bac de l'appelant", async () => {
    ecrire(path.join(base, "user_skills", "alice", "perso", "SKILL.md"), MD("perso"));
    ecrire(path.join(base, "user_skills", "alice", "perso", "run.py"), "print('alice')\n");
    ecrire(path.join(base, "skills", "commun", "SKILL.md"), MD("commun"));
    ecrire(path.join(base, "skills", "commun", "run.sh"), "echo commun\n");
    const journal: unknown[] = [];
    const bob = await skillRunScript(appel("perso", "run.py"), ctxTest({ username: "bob" }), appuis(journal));
    expect(bob).toMatchObject({ ok: false, error: "skill_not_found", message: "no skill named 'perso'." });
    const alice = await skillRunScript(
      appel("perso", "run.py"),
      ctxTest({ username: "alice" }),
      appuis(journal),
    );
    expect(alice).toMatchObject({ ok: true, name: "perso", script: "run.py", returncode: 0, stdout: "ok" });
    const commun = await skillRunScript(
      appel("commun", "run.sh"),
      ctxTest({ username: "bob" }),
      appuis(journal),
    );
    expect(commun).toMatchObject({ ok: true, name: "commun" });
    expect(journal.filter((x) => Array.isArray(x)).map((x) => (x as unknown[]).slice(0, 3))).toEqual([
      ["exec", "alice", ["python3", "run.py"]],
      ["exec", "bob", ["bash", "run.sh"]],
    ]);
  });

  it("exécution en panne : relevé fermé, enveloppe réessayable sans fichiers notés", async () => {
    ecrire(path.join(base, "user_skills", "alice", "p", "SKILL.md"), MD("p"));
    ecrire(path.join(base, "user_skills", "alice", "p", "run.py"), "x");
    const journal: unknown[] = [];
    const r = await skillRunScript(
      appel("p", "run.py"),
      ctxTest({ username: "alice" }),
      appuis(journal, new Error("agent_unavailable")),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "skill_run_failed",
      message: "execution failed: agent_unavailable",
    });
    expect(journal.filter((x) => typeof x === "string")).toEqual(["debut", "fin"]);
  });

  it("arguments de 100 000 caractères au plus en tout : au-delà, refus avant toute exécution", async () => {
    ecrire(path.join(base, "user_skills", "alice", "p", "SKILL.md"), MD("p"));
    ecrire(path.join(base, "user_skills", "alice", "p", "run.py"), "x");
    const journal: unknown[] = [];
    const args = ["a".repeat(60_000), "b".repeat(40_000)];
    const r = await skillRunScript(
      appel("p", "run.py", { args }),
      ctxTest({ username: "alice" }),
      appuis(journal),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "skill_run_rejected",
      message: "args too long (100002 characters, max 100000).",
    });
    expect(journal).toEqual([]);
    const ok = await skillRunScript(
      appel("p", "run.py", { args: ["a".repeat(60_000), "b".repeat(39_998)] }),
      ctxTest({ username: "alice" }),
      appuis(journal),
    );
    expect(ok).toMatchObject({ ok: true });
  });

  it("dossier de 8 Mio au plus : au-delà, refus avant toute exécution", async () => {
    const d = path.join(base, "user_skills", "alice", "gros");
    ecrire(path.join(d, "SKILL.md"), MD("gros"));
    ecrire(path.join(d, "run.py"), "x");
    writeFileSync(path.join(d, "data"), "");
    truncateSync(path.join(d, "data"), 8 * 1024 * 1024);
    const journal: unknown[] = [];
    const r = await skillRunScript(appel("gros", "run.py"), ctxTest({ username: "alice" }), appuis(journal));
    expect(r).toMatchObject({ error: "skill_run_too_large" });
    expect(journal).toEqual([]);
  });
});

describe("famille", () => {
  it("un seul outil, défini par le golden ; runner du Python (staging hors de /work, script lancé depuis /work)", () => {
    const f = familleSkillRun({});
    expect(f.famille).toBe("skill_run");
    expect(f.outils.map((o) => o.nom)).toEqual(["skill_run_script"]);
    expect(f.outils[0]?.definition["_meta"]).toMatchObject({ policy: { serial: true, timeout_s: 330 } });
    expect(RUNNER).toContain('cd /work || exit 94; SKILL_DIR="$d" "$i" "$d/$r" "$@" </dev/null');
  });
});
