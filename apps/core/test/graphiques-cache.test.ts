// SPDX-License-Identifier: MIT
/** apps/core/test/graphiques-cache.test.ts — cache des graphiques lu par descripteurs sans suivre les liens, dossiers et fichier de l'uid du process seulement (lecteur et incrustation). */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { embedChartConfigs, lireCacheGraphique } from "../src/graphiques/incrustation";

describe("cache des graphiques lu sans suivre les liens", () => {
  let t: BaseDeTest;
  let cache: string;
  let ailleurs: string;
  let journalCapte: string[];

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "bob", "mdp-bob");
    cache = mkdtempSync(join(tmpdir(), "elpis-graphiques-durci-"));
    ailleurs = mkdtempSync(join(tmpdir(), "elpis-graphiques-ailleurs-"));
    mkdirSync(join(cache, "bob"), { mode: 0o700 });
    writeFileSync(join(ailleurs, "a.json"), '{"hors": 1}');
    writeFileSync(join(cache, "bob", "aaaaaaaaaaaa.json"), '{"ok": 1}');
    vi.stubEnv("CHART_CACHE_DIR", cache);
    journalCapte = [];
    vi.spyOn(process.stderr, "write").mockImplementation((morceau: string | Uint8Array) => {
      journalCapte.push(String(morceau));
      return true;
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await t.fermer();
    rmSync(cache, { recursive: true, force: true });
    rmSync(ailleurs, { recursive: true, force: true });
  });

  it("fichier ordinaire du compte de service : lu", () => {
    expect(lireCacheGraphique("bob", "aaaaaaaaaaaa")?.toString()).toBe('{"ok": 1}');
    expect(lireCacheGraphique("bob", "aaaa-aaaa-aaaa")?.toString()).toBe('{"ok": 1}');
    writeFileSync(join(cache, "bob", "ABCDEF012345.json"), '{"maj": 1}');
    expect(lireCacheGraphique("bob", "ABCDEF012345")?.toString()).toBe('{"maj": 1}');
  });

  it("identifiant non hexadécimal : cache jamais lu, même si le fichier existe (écart voulu au Python de référence)", () => {
    for (const id of ["zzzzzz", "été٣", "abcdefg1"]) {
      writeFileSync(
        join(
          cache,
          "bob",
          `${Array.from(id)
            .filter((c) => /[\p{L}\p{N}]/u.test(c))
            .join("")}.json`,
        ),
        "{}",
      );
      expect(lireCacheGraphique("bob", id), id).toBeNull();
    }
    expect(journalCapte.join("")).toBe("");
  });

  it("lien symbolique à la place du fichier : écarté", () => {
    symlinkSync(join(ailleurs, "a.json"), join(cache, "bob", "bbbbbbbbbbbb.json"));
    expect(lireCacheGraphique("bob", "bbbbbbbbbbbb")).toBeNull();
    expect(journalCapte.join("")).toContain("cache écarté bbbbbbbbbbbb.json : lien symbolique");
  });

  it("dossier du compte ou base du cache en lien symbolique : écartés", () => {
    symlinkSync(ailleurs, join(cache, "carol"));
    expect(lireCacheGraphique("carol", "a")).toBeNull();
    const lien = `${cache}-lien`;
    symlinkSync(cache, lien);
    try {
      for (const base of [lien, `${lien}/`, `${lien}//`]) {
        vi.stubEnv("CHART_CACHE_DIR", base);
        expect(lireCacheGraphique("bob", "aaaaaaaaaaaa"), base).toBeNull();
      }
    } finally {
      rmSync(lien);
    }
  });

  it("dossier d'un autre compte que celui du service : écarté", () => {
    const vrai = process.geteuid?.() ?? 0;
    if (vrai === 0) return;
    vi.spyOn(process, "geteuid").mockReturnValue(vrai + 4242);
    expect(lireCacheGraphique("bob", "aaaaaaaaaaaa")).toBeNull();
    expect(journalCapte.join("")).toContain("cache écarté aaaaaaaaaaaa.json");
  });

  it.skipIf((process.geteuid?.() ?? 0) === 0 || !existsSync("/usr/share/nodejs/onetime/package.json"))(
    "fichier d'un autre propriétaire dans des dossiers de root : écarté",
    () => {
      vi.stubEnv("CHART_CACHE_DIR", "/usr/share/nodejs");
      expect(lireCacheGraphique("onetime", "eeeeeeeeeeee")).toBeNull();
      expect(journalCapte.join("")).toContain("dossier d'un autre propriétaire");
    },
  );

  it("dossier modifiable par le groupe ou les autres, ou fichier à liens multiples : écartés", () => {
    for (const mode of [0o777, 0o775, 0o720, 0o702]) {
      chmodSync(join(cache, "bob"), mode);
      expect(lireCacheGraphique("bob", "aaaaaaaaaaaa"), mode.toString(8)).toBeNull();
      chmodSync(join(cache, "bob"), 0o700);
      chmodSync(cache, mode);
      expect(lireCacheGraphique("bob", "aaaaaaaaaaaa"), `base ${mode.toString(8)}`).toBeNull();
      chmodSync(cache, 0o700);
    }
    expect(journalCapte.join("")).toContain("modifiable par le groupe ou les autres");
    chmodSync(join(cache, "bob"), 0o755);
    chmodSync(cache, 0o755);
    expect(lireCacheGraphique("bob", "aaaaaaaaaaaa")?.toString()).toBe('{"ok": 1}');
    linkSync(join(cache, "bob", "aaaaaaaaaaaa.json"), join(cache, "bob", "ffffffffffff.json"));
    expect(lireCacheGraphique("bob", "aaaaaaaaaaaa")).toBeNull();
    expect(lireCacheGraphique("bob", "ffffffffffff")).toBeNull();
    expect(journalCapte.join("")).toContain("plusieurs liens vers le fichier");
  });

  it.skipIf(
    !existsSync("/tmp") || (lstatSync("/tmp").mode & 0o1002) !== 0o1002 || lstatSync("/tmp").uid !== 0,
  )(
    "base de root modifiable par tous, même à sticky bit (comme /tmp) : refusée (écart voulu au Python de référence)",
    () => {
      const nom = `elpis-test-${process.pid}`;
      mkdirSync(join("/tmp", nom), { mode: 0o700 });
      try {
        writeFileSync(join("/tmp", nom, "aaaaaaaaaaaa.json"), '{"tmp": 1}');
        vi.stubEnv("CHART_CACHE_DIR", "/tmp");
        expect(lireCacheGraphique(nom, "aaaaaaaaaaaa")).toBeNull();
      } finally {
        rmSync(join("/tmp", nom), { recursive: true, force: true });
      }
    },
  );

  it("ancêtre de la base en lien symbolique : admis (seule la base et ce qu'elle contient sont jugés)", () => {
    const parent = `${ailleurs}-parent`;
    symlinkSync(cache, parent);
    try {
      vi.stubEnv("CHART_CACHE_DIR", join(parent, "."));
      expect(lireCacheGraphique("bob", "aaaaaaaaaaaa")).toBeNull();
      mkdirSync(join(cache, "sous"), { mode: 0o700 });
      mkdirSync(join(cache, "sous", "bob"), { mode: 0o700 });
      writeFileSync(join(cache, "sous", "bob", "aaaaaaaaaaaa.json"), '{"sous": 1}');
      vi.stubEnv("CHART_CACHE_DIR", join(parent, "sous"));
      expect(lireCacheGraphique("bob", "aaaaaaaaaaaa")?.toString()).toBe('{"sous": 1}');
    } finally {
      rmSync(parent);
    }
  });

  it("aucun descripteur laissé ouvert (lu, lien, dossier refusé, absent)", () => {
    symlinkSync(join(ailleurs, "a.json"), join(cache, "bob", "bbbbbbbbbbbb.json"));
    const ouverts = () => readdirSync("/proc/self/fd").length;
    const avant = ouverts();
    for (let i = 0; i < 20; i++) {
      lireCacheGraphique("bob", "aaaaaaaaaaaa");
      lireCacheGraphique("bob", "bbbbbbbbbbbb");
      lireCacheGraphique("absent", "aaaaaaaaaaaa");
      chmodSync(join(cache, "bob"), 0o770);
      lireCacheGraphique("bob", "aaaaaaaaaaaa");
      chmodSync(join(cache, "bob"), 0o700);
    }
    expect(ouverts()).toBe(avant);
  });

  it("tube nommé ou dossier au nom du fichier : ignorés sans attente", () => {
    execFileSync("mkfifo", [join(cache, "bob", "cccccccccccc.json")]);
    mkdirSync(join(cache, "bob", "dddddddddddd.json"));
    expect(lireCacheGraphique("bob", "cccccccccccc")).toBeNull();
    expect(lireCacheGraphique("bob", "dddddddddddd")).toBeNull();
  });

  it("cache ou dossier du compte absents : rien, sans erreur", () => {
    expect(lireCacheGraphique("inconnu", "aaaaaaaaaaaa")).toBeNull();
    vi.stubEnv("CHART_CACHE_DIR", join(cache, "absent"));
    expect(lireCacheGraphique("bob", "aaaaaaaaaaaa")).toBeNull();
    expect(journalCapte.join("")).toBe("");
  });

  it("incrustation dans la conversation : même règle", async () => {
    symlinkSync(join(ailleurs, "a.json"), join(cache, "bob", "eeeeeeeeeeee.json"));
    const messages = [{ role: "assistant", content: "!aaaaaaaaaaaa et !eeeeeeeeeeee" }];
    await embedChartConfigs(t.base, 1, "c1", messages, null);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: "!aaaaaaaaaaaa et !eeeeeeeeeeee",
      charts: { aaaaaaaaaaaa: { ok: 1 } },
    });
  });
});
