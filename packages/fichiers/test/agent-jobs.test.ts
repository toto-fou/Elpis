// SPDX-License-Identifier: MIT
/** packages/fichiers/test/agent-jobs.test.ts — méthodes `jobs*` du client de l'agent contre le vrai agent Python : lancement, veille NDJSON passive, statut, liste, arrêt, conteneur arrêté. */
import { existsSync } from "node:fs";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentClient, AgentError } from "../src/agent";
import { BacTest, dossierTemporaire, PYTHON } from "./aides";

let racine: string;
let nettoyer: () => void;
let bac: BacTest;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-agent-jobs-");
  bac = new BacTest(racine);
});

afterEach(async () => {
  await bac.arreter();
  nettoyer();
});

async function refus(p: Promise<unknown>): Promise<AgentError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error("refus attendu");
}

/** Événements relevés jusqu'à `fin` (curseur avancé à chaque bilan), 20 s au plus. */
async function jusqua(
  c: AgentClient,
  depuis: number,
  fin: (e: Dict[]) => boolean,
): Promise<[Dict[], number]> {
  const vus: Dict[] = [];
  let curseur = depuis;
  const echeance = Date.now() + 20_000;
  while (!fin(vus) && Date.now() < echeance) {
    const r = await c.jobsWatch(curseur, { waitS: 5 });
    vus.push(...r.events);
    curseur = Number(r.done["last_seq"]);
  }
  return [vus, curseur];
}

describe.skipIf(!PYTHON)("jobs de fond par l'agent réel", () => {
  it("lancement, veille (ticks ignorés, bilan), statut et liste ; code de sortie et fin du journal", async () => {
    const c = new AgentClient(bac);
    const r = await c.jobsStart({
      id: "j-0000000a",
      command: "echo debut; sleep 0.3; echo fin; exit 3",
      env: { PATH: "/usr/bin:/bin", MARQUE: "x" },
      label: "essai",
      wakeOn: ["match:debut"],
    });
    expect(r).toMatchObject({ id: "j-0000000a", state: "running", log: ".bg/job-j-0000000a.log" });
    expect(r["wake_on"]).toEqual(["exit", "match:debut"]);
    const [vus, curseur] = await jusqua(c, 0, (e) => e.some((x) => x["trigger"] === "exit"));
    expect(vus.map((e) => e["trigger"])).toEqual(["match", "exit"]);
    const sortie = vus[1] as Dict;
    expect(sortie).toMatchObject({
      job_id: "j-0000000a",
      state: "exited",
      exit_code: 3,
      still_running: false,
    });
    expect(sortie["tail"]).toEqual(["debut", "fin"]);
    expect(typeof sortie["seq"]).toBe("number");
    const vide = await c.jobsWatch(curseur, { waitS: 0 });
    expect(vide).toEqual({ events: [], done: { last_seq: curseur, running: 0, reset: false } });
    const [fiche] = await c.jobsStatus("j-0000000a", { passive: true });
    expect(fiche).toMatchObject({ id: "j-0000000a", state: "exited", exit_code: 3, log_lines: 2 });
    expect((await c.jobsList()).map((j) => j["id"])).toEqual(["j-0000000a"]);
    expect((await refus(c.jobsStatus("j-0000000b"))).code).toBe("job_not_found");
    const reprise = await c.jobsWatch(curseur + 100, { waitS: 0 });
    expect(reprise.done["reset"]).toBe(true);
    expect(reprise.events.map((e) => e["trigger"])).toEqual(["match", "exit"]);
  });

  it("arrêt du groupe (JB-12) : pids rendus, état killed ; job fini : job_not_running ; purge des fichiers", async () => {
    const c = new AgentClient(bac);
    await c.jobsStart({
      id: "j-0000000c",
      command: "sleep 30 & sleep 30; wait",
      env: { PATH: "/usr/bin:/bin" },
    });
    const k = await c.jobsKill({ id: "j-0000000c", graceS: 1, by: "agent" });
    expect(k).toMatchObject({ id: "j-0000000c", state: "killed" });
    expect((k["killed_pids"] as number[]).length).toBeGreaterThanOrEqual(2);
    const [vus] = await jusqua(c, 0, (e) => e.some((x) => x["trigger"] === "killed"));
    expect(vus.at(-1)).toMatchObject({ trigger: "killed", by: "agent", spec: null });
    const deja = await refus(c.jobsKill({ id: "j-0000000c" }));
    expect([deja.code, deja.status, deja.data["state"]]).toEqual(["job_not_running", 409, "killed"]);
    await c.jobsKill({ id: "j-0000000c", purge: true });
    expect(existsSync(path.join(bac.sandboxPath, ".bg", "job-j-0000000c.log"))).toBe(false);
    expect((await refus(c.jobsKill({ id: "j-0000000d" }))).code).toBe("job_not_found");
  });

  it("refus typés de l'agent : chemin hors de /work (JB-19), regex dangereuse", async () => {
    const c = new AgentClient(bac);
    const hors = await refus(
      c.jobsStart({ id: "j-0000000e", command: "true", wakeOn: ["file:../../etc/passwd"] }),
    );
    expect([hors.code, hors.status]).toEqual(["outside_root", 403]);
    const re = await refus(c.jobsStart({ id: "j-0000000e", command: "true", wakeOn: ["regex:(a+)+$"] }));
    expect([re.code, re.status]).toEqual(["bad_request", 400]);
  });

  it("veille passive : conteneur arrêté → container_down, jamais démarré", async () => {
    bac.running = false;
    const c = new AgentClient(bac);
    expect((await refus(c.jobsWatch(0, { waitS: 0 }))).code).toBe("container_down");
    expect(bac.demarrages).toBe(0);
  });

  it("veille coupée par l'arrêt du process : cancelled, sans attendre l'échéance", async () => {
    const c = new AgentClient(bac);
    await c.hello();
    const arret = new AbortController();
    const t0 = Date.now();
    setTimeout(() => arret.abort(), 300);
    expect((await refus(c.jobsWatch(0, { waitS: 20, arret: arret.signal }))).code).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
