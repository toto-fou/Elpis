// SPDX-License-Identifier: MIT
/** apps/toolhost/test/disque-garde.test.ts — garde de remplissage des outils qui écrivent (harnais N-08, écart voulu au Python qui n'alertait ni ne refusait) : disk_warning, refus disk_full_risk, suppressions libres, mesure jamais bloquante, seuils de config.json. */
import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { AgentClient } from "@elpis/fichiers";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { RAPPEL_ABSENT } from "../src/fichiers/commun";
import { ATTENTE_DISQUE_MS, gardeDisque } from "../src/mcp/disque";
import type { GardeDisque } from "../src/mcp/disque";
import { Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { outilsFs } from "../src/mcp/fs/famille";
import { outilsShell } from "../src/mcp/shell/outil";
import type { AppuisShell } from "../src/mcp/shell/outil";
import type { AppuisJobs } from "../src/mcp/shell/jobs/outil";

const MIO = 1024 * 1024;
const META = { username: "alice", user_id: "7", chat_id: "c-1", call_id: "k1" };
const ALERTE = "Disk space low: the disk holding /work is 90% full.";
const PLEIN = "Disk almost full: the disk holding /work is 98% full.";

let racine = "";
let nettoyer: () => void = () => undefined;
let restaurer: () => void = () => undefined;
let bac: BacTest | null = null;
const fermetures: (() => Promise<void>)[] = [];

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-disque-garde-");
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(racine, "config.json") });
  vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(racine, "fh"));
  vi.stubEnv("FSTOOLS_FLOCK", "0");
});

afterEach(async () => {
  for (const f of fermetures.splice(0)) await f();
  installerFabriqueEspace(null);
  vi.unstubAllEnvs();
  restaurer();
  await bac?.arreter();
  bac = null;
  nettoyer();
});

type Reponse = string | null | "lente" | "panne";

/** Garde doublée : réponses réglables, mesures notées. */
function double(etat: { alerte: Reponse; refus: Reponse; lieu?: Reponse }, vus: string[]): GardeDisque {
  const repondre = (quoi: string, r: Reponse): Promise<string | null> => {
    vus.push(quoi);
    if (r === "lente") return new Promise(() => undefined);
    if (r === "panne") return Promise.reject(new Error("statfs"));
    return Promise.resolve(r);
  };
  return {
    lieu: async () => {
      if (etat.lieu === "panne") throw new Error("compte inconnu");
      if (etat.lieu === "lente") return new Promise(() => undefined);
      return [7, bac?.sandboxPath ?? racine] as const;
    },
    alerte: () => repondre("alerte", etat.alerte),
    refus: () => repondre("refus", etat.refus),
  };
}

async function connecter(serveur: ServeurOutils, famille: string): Promise<Client> {
  const cnx = await ouvrirEnMemoire(serveur, { famille });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(cnx.transport);
  fermetures.push(() => cnx.fermer());
  return c;
}

async function appeler(c: Client, outil: string, args: Dict): Promise<Dict> {
  const rep = (await c.callTool({ name: outil, arguments: args, _meta: META })) as Dict;
  const sc = rep["structuredContent"] as Dict | undefined;
  const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
  return (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict);
}

/** Famille fs sur un bac local et son vrai agent, sous la garde `g`. */
async function clientFs(g: GardeDisque | null): Promise<Client> {
  const b = new BacTest(racine, "alice");
  bac = b;
  installerFabriqueEspace(async () => new Espace(b.sandboxPath, 7, new AgentClient(b)));
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("fs", outilsFs(g));
  return connecter(serveur, "fs");
}

const travail = (rel: string): string => path.join(bac?.sandboxPath ?? racine, rel);

/** Seuils posés dans config.json comme la console les écrit (fichier remplacé). */
function seuils(warn_pct: number, refuse_pct: number): void {
  const tmp = path.join(racine, "config.json.tmp");
  writeFileSync(tmp, JSON.stringify({ executors: { disk: { warn_pct, refuse_pct } } }));
  renameSync(tmp, path.join(racine, "config.json"));
}

describe.skipIf(!PYTHON)("garde de remplissage des outils fichiers (harnais N-08)", () => {
  it("au-delà du refus : write_file et copy refusés (disk_full_risk + fix), rien d'écrit ; edit, mkdir, move alertés ; suppressions libres", async () => {
    // écart voulu au Python (harnais N-08) : le Python écrivait sans regarder l'espace libre
    const vus: string[] = [];
    const c = await clientFs(double({ alerte: ALERTE, refus: PLEIN }, vus));
    writeFileSync(travail("a.txt"), "a\n");
    const w = await appeler(c, "write_file", { path: "new.txt", content: "x" });
    expect(w).toEqual({
      ok: false,
      error: "disk_full_risk",
      message: PLEIN,
      fix: expect.stringMatching(
        /\/work\/\.tool-output\/.*manage_files\(action="delete"\) or rm/u,
      ) as unknown,
    });
    expect(existsSync(travail("new.txt"))).toBe(false);
    const cp = await appeler(c, "manage_files", { action: "copy", path: "a.txt", dest: "b.txt" });
    expect(cp).toMatchObject({ ok: false, error: "disk_full_risk", message: PLEIN });
    expect(existsSync(travail("b.txt"))).toBe(false);
    expect(await appeler(c, "write_file", { path: "new.txt", content: "x", dry_run: true })).toMatchObject({
      ok: true,
      disk_warning: ALERTE,
    });
    const ed = await appeler(c, "edit_file", {
      path: "a.txt",
      action: "str_replace",
      old_str: "a",
      new_str: "b",
    });
    expect(ed).toMatchObject({ ok: true, disk_warning: ALERTE });
    for (const args of [
      { action: "mkdir", path: "d" },
      { action: "move", path: "a.txt", dest: "d/a.txt" },
    ])
      expect(await appeler(c, "manage_files", args), args.action).toMatchObject({
        ok: true,
        disk_warning: ALERTE,
      });
    writeFileSync(travail("c.txt"), "c\n");
    vus.length = 0;
    const del = await appeler(c, "manage_files", { action: "delete", path: "d/a.txt" });
    const lot = await appeler(c, "manage_files", { action: "batch_delete", paths: ["c.txt"] });
    for (const r of [del, lot]) {
      expect(r["ok"]).toBe(true);
      expect(r).not.toHaveProperty("disk_warning");
    }
    expect(vus).toEqual([]);
    expect([existsSync(travail("d/a.txt")), existsSync(travail("c.txt"))]).toEqual([false, false]);
  });

  it("sous les seuils : aucun champ ; mesure ou compte en panne, ou lents : ni alerte ni refus, sans retarder l'outil", async () => {
    const etat: { alerte: Reponse; refus: Reponse; lieu?: Reponse } = { alerte: null, refus: null };
    const vus: string[] = [];
    const c = await clientFs(double(etat, vus));
    const sous = await appeler(c, "write_file", { path: "a.txt", content: "a\n" });
    expect(sous["ok"]).toBe(true);
    expect(sous).not.toHaveProperty("disk_warning");
    expect(vus).toEqual(["refus", "alerte"]);
    for (const cas of [
      { alerte: "panne", refus: "panne" },
      { alerte: "lente", refus: "lente" },
      { alerte: ALERTE, refus: PLEIN, lieu: "panne" },
      { alerte: ALERTE, refus: PLEIN, lieu: "lente" },
    ] as const) {
      Object.assign(etat, { lieu: undefined }, cas);
      const t0 = performance.now();
      const r = await appeler(c, "write_file", { path: "a.txt", content: "b\n", mode: "append" });
      expect([JSON.stringify(cas), r["ok"]]).toEqual([JSON.stringify(cas), true]);
      expect(r).not.toHaveProperty("disk_warning");
      expect(performance.now() - t0).toBeLessThan(2 * ATTENTE_DISQUE_MS + 3000);
    }
  });

  it("chemin réel : seuils de config.json relus sans redémarrage (abaissés pour l'essai), quota du compte par le rappel au core", async () => {
    const rappel = { ...RAPPEL_ABSENT, quotaCompte: async () => 1 };
    const c = await clientFs({
      ...gardeDisque(rappel),
      lieu: async () => [9301, bac?.sandboxPath ?? ""] as const,
    });
    writeFileSync(travail("gros.bin"), Buffer.alloc(Math.floor(0.95 * MIO)));
    seuils(10, 50);
    const refus = await appeler(c, "write_file", { path: "x.txt", content: "x" });
    expect(refus).toMatchObject({ ok: false, error: "disk_full_risk" });
    expect(refus["message"]).toMatch(
      /^Disk almost full: your sandbox uses 9\d% of its 1 MB quota.*refused from 50%/u,
    );
    expect(existsSync(travail("x.txt"))).toBe(false);
    seuils(10, 100);
    const alerte = await appeler(c, "write_file", { path: "x.txt", content: "x" });
    expect(alerte["ok"]).toBe(true);
    expect(alerte["disk_warning"]).toMatch(
      /^Disk space low: your sandbox uses 9\d% of its 1 MB quota.*refused from 100%/u,
    );
    seuils(95, 100);
    const calme = await appeler(c, "write_file", { path: "x.txt", content: "y" });
    expect(calme["ok"]).toBe(true);
    expect(String(calme["disk_warning"] ?? "")).not.toMatch(/quota/u);
  });
});

describe("garde de remplissage de execute_shell et shell_job (harnais N-08)", () => {
  const etat: { alerte: Reponse; refus: Reponse } = { alerte: ALERTE, refus: PLEIN };
  const vus: string[] = [];
  const lances: string[][] = [];
  const jobs: string[] = [];

  beforeEach(() => {
    Object.assign(etat, { alerte: ALERTE, refus: PLEIN });
    vus.length = 0;
    lances.length = 0;
    jobs.length = 0;
  });

  /** Appuis de shell_job qui notent tout usage et échouent : seul compte ce qui est atteint. */
  function jobsFactices(): AppuisJobs {
    const noter = (quoi: string): never => {
      jobs.push(quoi);
      throw new Error(`pas de bac de tâches (${quoi})`);
    };
    return {
      racine: async () => racine,
      userIdFor: async () => 42,
      stats: async () => noter("stats"),
      bac: async () => noter("bac"),
      rappel: {
        enregistrerJob: async () => noter("enregistrerJob"),
        etatJob: async () => noter("etatJob"),
        jobsDuCompte: async () => noter("jobsDuCompte"),
      },
      veilleur: () => null,
      auditer: () => undefined,
    };
  }

  async function clientShell(): Promise<Client> {
    const g = double(etat, vus);
    const appuis: AppuisShell = {
      racine: async () => racine,
      stats: async () => [],
      userIdFor: async () => 42,
      releve: () => ({ debut: async () => undefined, fin: async () => undefined, attacher: (r) => r }),
      executer: async (o) => {
        lances.push([...o.tokens]);
        return { ok: true, returncode: 0, stdout: "x", stderr: "", cmd: o.tokens, cwd: "/work" };
      },
      plancherDebord: () => 1_000_000,
      alerteDisque: (uid, rac) => g.alerte(uid, rac),
      refusDisque: (uid, rac) => g.refus(uid, rac),
      jobs: jobsFactices(),
    };
    const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    serveur.enregistrerFamille("shell", outilsShell(appuis));
    return connecter(serveur, "shell");
  }

  it("execute_shell ordinaire jamais refusé, alerté ; détaché qui lancerait une tâche : refusé avant tout lancement", async () => {
    // écart voulu au Python (harnais N-08) : le Python lançait sans regarder l'espace libre
    const c = await clientShell();
    const simple = await appeler(c, "execute_shell", { command: "du -sh ." });
    expect(simple).toMatchObject({ ok: true, stdout: "x", disk_warning: ALERTE });
    expect(vus).toEqual(["alerte"]);
    expect(lances).toHaveLength(1);
    const detache = await appeler(c, "execute_shell", { command: "make", on_timeout: "detach_and_wake" });
    expect(detache).toMatchObject({ ok: false, error: "disk_full_risk", message: PLEIN });
    expect(String(detache["fix"])).toContain(".tool-output/");
    expect([lances.length, jobs]).toEqual([1, []]);
    const repli = await appeler(c, "execute_shell", {
      command: "cat",
      stdin: "a",
      on_timeout: "detach_and_wake",
    });
    expect(repli).toMatchObject({ ok: true, disk_warning: ALERTE });
    expect(String(repli["on_timeout_fallback"])).toMatch(/^invalid_argument: stdin/u);
    etat.refus = null;
    const libre = await appeler(c, "execute_shell", { command: "make", on_timeout: "detach_and_wake" });
    expect(libre["error"]).not.toBe("disk_full_risk");
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("shell_job(start) refusé au-delà du seuil, sans rien lancer ; status/list/logs/kill jamais mesurés ; sous le seuil, lancement tenté", async () => {
    const c = await clientShell();
    const start = await appeler(c, "shell_job", { action: "start", command: "sleep 100" });
    expect(start).toMatchObject({ ok: false, error: "disk_full_risk", message: PLEIN });
    expect(String(start["fix"])).toContain('manage_files(action="delete")');
    expect([vus, jobs]).toEqual([["refus"], []]);
    vus.length = 0;
    await appeler(c, "shell_job", { action: "list" });
    expect(vus).toEqual([]);
    etat.refus = null;
    const tente = await appeler(c, "shell_job", { action: "start", command: "sleep 100" });
    expect(tente["error"]).not.toBe("disk_full_risk");
    expect(vus).toEqual(["refus", "alerte"]);
  });
});
