// SPDX-License-Identifier: MIT
/** apps/core/test/llm/temoin-partage.test.ts — témoins de version partagés par main et la console : un témoin d'un autre compte (dates refusées hors de son propriétaire, EPERM) est remplacé par un neuf, daté et renommé à sa place. */
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refus = vi.hoisted(() => ({ chemins: new Set<string>() }));

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof Fs>();
  const utimesSync: typeof fs.utimesSync = (p, a, m) => {
    if (refus.chemins.delete(String(p)))
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    fs.utimesSync(p, a, m);
  };
  return { ...fs, utimesSync };
});

const { avancerTemoin } = await import("../../src/llm/acces-moteurs");

let dossier = "";

/** Umask du process, lue sans le changer. */
function umask(): number {
  const u = process.umask(0);
  process.umask(u);
  return u;
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-temoin-"));
});

afterEach(() => {
  refus.chemins.clear();
  rmSync(dossier, { recursive: true, force: true });
});

describe("avancerTemoin", () => {
  it("témoin de ce compte : daté sur place, même inode", () => {
    const p = join(dossier, "policies.stamp");
    writeFileSync(p, "");
    const avant = statSync(p, { bigint: true });
    avancerTemoin(p);
    const apres = statSync(p, { bigint: true });
    expect(apres.ino).toBe(avant.ino);
    expect(apres.mtimeNs).toBeGreaterThan(avant.mtimeNs);
  });

  it("témoin d'un autre compte : remplacé par un neuf plus récent, au mode demandé, sans temporaire laissé", () => {
    const p = join(dossier, "acces.stamp");
    writeFileSync(p, "");
    const avant = statSync(p, { bigint: true });
    refus.chemins.add(p);
    avancerTemoin(p, 0o640);
    const apres = statSync(p, { bigint: true });
    expect(apres.ino).not.toBe(avant.ino);
    expect(apres.mtimeNs).toBeGreaterThan(avant.mtimeNs);
    expect(Number(apres.mode) & 0o777).toBe(0o640 & ~umask());
    expect(readdirSync(dossier)).toEqual(["acces.stamp"]);
  });

  it("autre refus que EPERM : remonte", () => {
    const p = join(dossier, "absent", "x.stamp");
    expect(() => avancerTemoin(p)).toThrow();
  });
});
