// SPDX-License-Identifier: MIT
/** packages/verrous/test/balayage.test.ts — fichiers-verrous `flock` périmés : table `/proc/locks` lue, verrous libres de plus de 24 h retirés, jamais un verrou tenu. */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { balayerVerrousPerimes, inodesVerrouilles, JOUR_S } from "../src/balayage";

const AVEC_FLOCK = spawnSync("flock", ["--version"]).status === 0 && existsSync("/proc/locks");
const MAINTENANT = Date.now() / 1000;

let dossier = "";
const detenteurs: ChildProcess[] = [];

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-balayage-"));
});

function lacherVerrous(): void {
  for (const d of detenteurs.splice(0)) if (d.pid !== undefined) process.kill(-d.pid, "SIGKILL");
}

afterEach(() => {
  lacherVerrous();
  rmSync(dossier, { recursive: true, force: true });
});

function fichier(chemin: string, jours: number): string {
  mkdirSync(join(chemin, ".."), { recursive: true });
  writeFileSync(chemin, "");
  const t = MAINTENANT - jours * JOUR_S;
  utimesSync(chemin, t, t);
  return chemin;
}

/** Tient un `flock` exclusif sur le fichier tant que le test dure (binaire `flock` de util-linux). */
async function tenirVerrou(chemin: string): Promise<void> {
  detenteurs.push(spawn("flock", ["-x", chemin, "sleep", "60"], { stdio: "ignore", detached: true }));
  const inode = String(statSync(chemin).ino);
  const limite = Date.now() + 10_000;
  while (!(await inodesVerrouilles())?.has(inode)) {
    if (Date.now() > limite) throw new Error("flock non visible dans /proc/locks");
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

describe("inodesVerrouilles (/proc/locks)", () => {
  it("ne retient que les flock, y compris ceux qui attendent ; table illisible : null", async () => {
    const source = join(dossier, "locks");
    writeFileSync(
      source,
      [
        "1: FLOCK  ADVISORY  WRITE 1017595 08:01:1729042 0 EOF",
        "2: -> FLOCK  ADVISORY  WRITE 1050692 08:01:1729063 0 EOF",
        "3: POSIX  ADVISORY  WRITE 1724 08:01:917506 0 EOF",
        "4: OFDLCK ADVISORY  READ -1 08:01:99 0 EOF",
        "5: LEASE  ACTIVE    READ 3021 08:01:5 0 EOF",
        "n'importe quoi",
        "",
      ].join("\n"),
    );
    expect([...((await inodesVerrouilles(source)) ?? [])]).toEqual(["1729042", "1729063"]);
    expect(await inodesVerrouilles(join(dossier, "absent"))).toBeNull();
  });
});

describe.skipIf(!AVEC_FLOCK)("balayerVerrousPerimes", () => {
  it("retire les fichiers de plus de 24 h dont le flock est libre, jamais un verrou tenu, récent, lien ou dossier", async () => {
    const d = join(dossier, "verrous");
    const ancien = fichier(join(d, "ancien.lock"), 3);
    const tenu = fichier(join(d, "tenu.lock"), 3);
    const recent = fichier(join(d, "recent.lock"), 0.5);
    fichier(join(dossier, "cible"), 3);
    symlinkSync(join(dossier, "cible"), join(d, "lien.lock"));
    mkdirSync(join(d, "sous-dossier"));
    await tenirVerrou(tenu);
    expect(await balayerVerrousPerimes([d, join(dossier, "absent")], JOUR_S)).toBe(1);
    expect(
      [ancien, tenu, recent, join(d, "lien.lock"), join(d, "sous-dossier")].map((f) => existsSync(f)),
    ).toEqual([false, true, true, true, true]);
    expect(await balayerVerrousPerimes([d], JOUR_S)).toBe(0);
  });

  it("verrou relâché : retiré à la passe suivante", async () => {
    const d = join(dossier, "verrous");
    const f = fichier(join(d, "a.lock"), 3);
    await tenirVerrou(f);
    expect(await balayerVerrousPerimes([d], JOUR_S)).toBe(0);
    lacherVerrous();
    const limite = Date.now() + 10_000;
    while ((await inodesVerrouilles())?.has(String(statSync(f).ino))) {
      if (Date.now() > limite) throw new Error("flock toujours tenu");
      await new Promise((ok) => setTimeout(ok, 50));
    }
    expect(await balayerVerrousPerimes([d], JOUR_S)).toBe(1);
  });
});
