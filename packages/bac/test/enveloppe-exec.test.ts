// SPDX-License-Identifier: MIT
/** packages/bac/test/enveloppe-exec.test.ts — enveloppe des `docker exec` jouée par le `sh` local, sans conteneur : échéance, groupe de processus et descendants marqués tués, stdin, code et umask gardés (harnais SH-10). */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENVELOPPE_EXEC } from "../src/conteneur";
import { dossierTemporaire } from "./aides";

let dossier = "";
let nettoyer: () => void = () => undefined;

beforeEach(() => {
  [dossier, nettoyer] = dossierTemporaire("elpis-enveloppe-exec-");
});

afterEach(() => nettoyer());

/** `sh -c ENVELOPPE_EXEC -- <délai> <cmd…>` comme le lance `docker exec` ; code, sortie et durée. */
function lancer(
  delai: number,
  cmd: string[],
  entree = "",
): Promise<{ rc: number | null; out: string; ms: number }> {
  return new Promise((fin, echec) => {
    const t0 = Date.now();
    const p = spawn("sh", ["-c", ENVELOPPE_EXEC, "--", String(delai), ...cmd], { cwd: dossier });
    let out = "";
    p.stdout.on("data", (b: Buffer) => (out += b.toString()));
    p.once("error", echec);
    p.once("close", (rc) => fin({ rc, out, ms: Date.now() - t0 }));
    p.stdin.end(entree);
  });
}

/** Vrai si le processus `pid` tourne encore (un zombie pas encore récolté compte pour mort). */
function vivant(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf-8").split(") ").at(-1)?.[0] !== "Z";
  } catch {
    return false;
  }
}

/** Attend, sondage borné, que `pid` ne tourne plus ; faux si l'échéance passe d'abord. */
async function disparait(pid: number, echeanceMs: number): Promise<boolean> {
  const fin = Date.now() + echeanceMs;
  while (vivant(pid)) {
    if (Date.now() > fin) return false;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return true;
}

describe.skipIf(process.platform !== "linux")("enveloppe des exec du bac (SH-10)", () => {
  it("échéance : un petit-enfant qui ignore TERM ne survit pas à la commande", async () => {
    const pid = path.join(dossier, "pid");
    const r = await lancer(3, [
      "bash",
      "-c",
      `bash -c 'trap "" TERM; echo $$ > ${pid}; exec sleep 120' >/dev/null 2>&1 & wait`,
    ]);
    const orphelin = Number(readFileSync(pid, "utf-8"));
    const parti = await disparait(orphelin, 20_000);
    if (!parti) process.kill(orphelin, "SIGKILL");
    expect([r.rc, parti]).toEqual([124, true]);
    expect(r.ms).toBeLessThan(60_000);
  }, 90_000);

  it.each([
    ["un `timeout` intérieur (setpgid)", "timeout 60"],
    ["setsid", "setsid"],
  ])(
    "échéance : un descendant sorti du groupe par %s ne survit pas à la commande",
    async (_n, sortie) => {
      const pid = path.join(dossier, "pid");
      const r = await lancer(1, ["bash", "-c", `${sortie} bash -c 'echo $$ > ${pid}; exec sleep 60' & wait`]);
      const echappe = Number(readFileSync(pid, "utf-8"));
      const parti = await disparait(echappe, 15_000);
      if (!parti) process.kill(echappe, "SIGKILL");
      expect([r.rc, parti]).toEqual([124, true]);
    },
    30_000,
  );

  it("hors échéance : un processus détaché par setsid garde la main (tâche de fond voulue)", async () => {
    const pid = path.join(dossier, "pid");
    const r = await lancer(5, [
      "bash",
      "-c",
      `setsid bash -c 'echo $$ > ${pid}; exec sleep 30' >/dev/null 2>&1 &`,
    ]);
    for (let n = 0; n < 100 && !existsSync(pid); n++) await new Promise((ok) => setTimeout(ok, 50));
    await new Promise((ok) => setTimeout(ok, 200));
    const detache = Number(readFileSync(pid, "utf-8"));
    expect([r.rc, vivant(detache)]).toEqual([0, true]);
    process.kill(detache, "SIGKILL");
  }, 20_000);

  it("échéance : un enfant qui respecte TERM part aussitôt", async () => {
    const r = await lancer(1, ["bash", "-c", "sleep 30 & wait"]);
    expect(r.rc).toBe(124);
    expect(r.ms).toBeLessThan(5_500);
  }, 20_000);

  it("hors échéance : stdin transmis, code rendu, umask 0022, INT et QUIT non ignorés", async () => {
    const r = await lancer(
      5,
      ["sh", "-c", "cat; echo; umask; grep SigIgn /proc/self/status; exit 3"],
      "entrée",
    );
    const masque = BigInt("0x" + (/SigIgn:\s*([0-9a-f]+)/u.exec(r.out)?.[1] ?? "ff"));
    expect([r.rc, r.out.split("\n").slice(0, 2), masque & 0x6n]).toEqual([3, ["entrée", "0022"], 0n]);
  }, 10_000);
});
