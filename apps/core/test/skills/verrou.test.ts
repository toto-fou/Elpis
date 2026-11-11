// SPDX-License-Identifier: MIT
/** apps/core/test/skills/verrou.test.ts — verrou des écritures de skills : réentrance, exclusion, verrou de fichier à la profondeur 0, désactivation et fail-open. */
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { VerrouFichier } from "@elpis/verrous";

import { cheminVerrouSkills, VERROU_DELAI_S, VerrouEcritureSkills } from "../../src/skills/verrou";
import { poserEnv } from "./arbre";

const dossiers: string[] = [];
const remises: (() => void)[] = [];

afterEach(() => {
  for (const r of remises.splice(0).reverse()) r();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(dossiers.map((d) => rm(d, { recursive: true, force: true })));
});

async function verrouDeTest(): Promise<[VerrouEcritureSkills, string]> {
  const d = await mkdtemp(path.join(os.tmpdir(), "elpis-skills-verrou-"));
  dossiers.push(d);
  const chemin = path.join(d, ".skills_write.lock");
  return [new VerrouEcritureSkills(() => chemin), chemin];
}

const existe = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("verrou des écritures de skills", () => {
  it("est réentrant dans une même chaîne d'appels", async () => {
    const [v] = await verrouDeTest();
    expect(await v.avec(() => v.avec(() => v.avec(async () => 42)))).toBe(42);
    expect(v.tenuIci()).toBe(false);
  });

  it("sérialise les appels concurrents et ne prend le fichier qu'une fois", async () => {
    const [v, chemin] = await verrouDeTest();
    let dedans = 0;
    let max = 0;
    const tache = (): Promise<void> =>
      v.avec(async () => {
        dedans++;
        max = Math.max(max, dedans);
        expect(await existe(chemin)).toBe(true);
        await v.avec(async () => {
          expect(v.tenuIci()).toBe(true);
        });
        await dormir(20);
        dedans--;
      });
    await Promise.all([tache(), tache(), tache(), tache()]);
    expect(max).toBe(1);
    expect(await existe(chemin)).toBe(false);
  });

  it("une exception rend le verrou (processus et fichier)", async () => {
    const [v, chemin] = await verrouDeTest();
    await expect(
      v.avec(async () => {
        throw new Error("boum");
      }),
    ).rejects.toThrow("boum");
    expect(await existe(chemin)).toBe(false);
    expect(await v.avec(async () => "ok")).toBe("ok");
  });

  it("SKILLS_FILELOCK=0 : verrou du processus seul", async () => {
    remises.push(poserEnv({ SKILLS_FILELOCK: " No " }));
    const [v, chemin] = await verrouDeTest();
    await v.avec(async () => {
      expect(await existe(chemin)).toBe(false);
    });
  });

  it(
    "fail-open après le délai si un autre détenteur garde le fichier (message de Python)",
    { timeout: 30_000 },
    async () => {
      const [v, chemin] = await verrouDeTest();
      const autre = new VerrouFichier(chemin);
      await autre.acquerir();
      const ecrit = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const debut = performance.now();
        expect(await v.avec(async () => "écrit quand même")).toBe("écrit quand même");
        expect(performance.now() - debut).toBeGreaterThanOrEqual(VERROU_DELAI_S * 1000 - 100);
        expect(ecrit.mock.calls.map((c) => String(c[0])).join("")).toContain(
          "WARNING [skills] flock contention > 5s — fail-open (RLock seul)",
        );
      } finally {
        ecrit.mockRestore();
        await autre.rendre();
      }
    },
  );

  it("chemin : SKILLS_LOCK_PATH, sinon à côté de la bibliothèque globale", () => {
    remises.push(poserEnv({ SKILLS_LOCK_PATH: "  /tmp//x/./verrou  " }));
    expect(cheminVerrouSkills(() => "/srv/skills")).toBe("/tmp/x/verrou");
    remises.push(poserEnv({ SKILLS_LOCK_PATH: "" }));
    expect(cheminVerrouSkills(() => "/srv/skills/")).toBe("/srv/skills/.skills_write.lock");
  });
});
