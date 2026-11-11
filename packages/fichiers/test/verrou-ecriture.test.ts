// SPDX-License-Identifier: MIT
/** packages/fichiers/test/verrou-ecriture.test.ts — verrou d'écriture par fichier : même sidecar et même `flock` que file_lock.py (Python retiré). */
import { existsSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  avecVerrouEcriture,
  lockName,
  locksBase,
  prendreVerrouEcriture,
  sha256Bytes,
  verrouillageActif,
} from "../src/verrou-ecriture";
import { dossierTemporaire } from "./aides";

let racine: string;
let nettoyer: () => void;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-verrou-ecriture-");
  vi.stubEnv("APP_SANDBOX_DIR", path.join(racine, "sb"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  nettoyer();
});

describe("verrou d'écriture", () => {
  it("sidecar sha1 du chemin dans <APP_SANDBOX_DIR résolu>/.write_locks ; demi-paire comme errors='replace'", () => {
    expect(lockName("/srv/sb/u/work/a.txt")).toMatch(/^[0-9a-f]{40}\.lock$/u);
    expect(lockName("x\ud800y")).toBe(lockName("x?y"));
    expect(lockName("😀")).not.toBe(lockName("??"));
    symlinkSync(racine, path.join(racine, "lien"));
    vi.stubEnv("APP_SANDBOX_DIR", path.join(racine, "lien", "sb"));
    expect(locksBase()).toBe(path.join(racine, "sb", ".write_locks"));
    expect(sha256Bytes(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("exclusif entre deux prises du même processus ; délai dépassé : obtenu faux ; rendu : repris aussitôt", async () => {
    const a = await prendreVerrouEcriture("/x/f");
    expect(a.obtenu).toBe(true);
    expect(readdirSync(path.join(racine, "sb", ".write_locks"))).toEqual([lockName("/x/f")]);
    const debut = performance.now();
    const b = await prendreVerrouEcriture("/x/f", { delaiS: 0.3 });
    expect(b.obtenu).toBe(false);
    expect(performance.now() - debut).toBeGreaterThan(250);
    b.rendre();
    expect((await prendreVerrouEcriture("/x/autre", { delaiS: 0 })).obtenu).toBe(true);
    a.rendre();
    a.rendre();
    const c = await prendreVerrouEcriture("/x/f", { delaiS: 0 });
    expect(c.obtenu).toBe(true);
    c.rendre();
  });

  it("avecVerrouEcriture rend le verrou même si la fonction lève", async () => {
    await expect(
      avecVerrouEcriture("/x/g", async (obtenu) => {
        expect(obtenu).toBe(true);
        throw new Error("boum");
      }),
    ).rejects.toThrow("boum");
    expect((await prendreVerrouEcriture("/x/g", { delaiS: 0 })).obtenu).toBe(true);
  });

  it("FSTOOLS_FLOCK=0 : fail-open, aucun fichier ; verrouillage déclaré inactif", async () => {
    vi.stubEnv("FSTOOLS_FLOCK", "0");
    expect(verrouillageActif()).toBe(false);
    const v = await prendreVerrouEcriture("/x/h");
    expect(v.obtenu).toBe(false);
    expect(existsSync(path.join(racine, "sb", ".write_locks"))).toBe(false);
    vi.stubEnv("FSTOOLS_FLOCK", "1");
    expect(verrouillageActif()).toBe(true);
  });

  it("annulation pendant l'attente : rien de tenu, l'erreur d'annulation remonte", async () => {
    const a = await prendreVerrouEcriture("/x/i");
    const arret = new AbortController();
    setTimeout(() => arret.abort(new Error("requête annulée")), 100);
    await expect(prendreVerrouEcriture("/x/i", { signal: arret.signal })).rejects.toThrow("requête annulée");
    a.rendre();
    expect((await prendreVerrouEcriture("/x/i", { delaiS: 0 })).obtenu).toBe(true);
  });
});
