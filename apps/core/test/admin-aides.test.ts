// SPDX-License-Identifier: MIT
/** apps/core/test/admin-aides.test.ts — aides des routes de la console : entiers à la Python, bornes des identifiants, config.json illisible. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ErreurPython, FlottantPy, HttpError } from "@elpis/commun";
import { lireConfigDisque, surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entierBase, entierPy, niveauDuRole } from "../src/admin/aides";

describe("entiers", () => {
  it("`int()` exact : grands entiers en bigint, textes Python, OverflowError en 400", () => {
    expect(entierPy(" 1_000 ")).toBe(1000);
    expect(entierPy(new FlottantPy(7.9))).toBe(7);
    expect(entierPy(true)).toBe(1);
    expect(entierPy("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
    expect(entierPy(2 ** 60)).toBe(2n ** 60n);
    expect(() => entierPy(new FlottantPy(Number.POSITIVE_INFINITY))).toThrow(HttpError);
    expect(() => entierPy("abc")).toThrow(ErreurPython);
    expect(() => entierPy([1])).toThrow(ErreurPython);
  });

  it("identifiant en base : au-delà de 2^53, 400 « Paramètre hors bornes. »", () => {
    expect(entierBase(42)).toBe(42);
    expect(entierBase(2n ** 53n - 1n)).toBe(2 ** 53 - 1);
    expect(() => entierBase(2n ** 53n + 1n)).toThrow("Paramètre hors bornes.");
    expect(() => entierBase(-(2n ** 60n))).toThrow("Paramètre hors bornes.");
  });

  it("rôle : chaînes connues seulement, liste ou dict = TypeError", () => {
    expect(niveauDuRole("admin")).toBe(1);
    expect(niveauDuRole("moderator")).toBe(2);
    expect(niveauDuRole(1)).toBe(0);
    expect(() => niveauDuRole(["admin"])).toThrow(ErreurPython);
  });
});

describe("config.json relu sur disque", () => {
  let dossier: string;
  let restaurer: () => void;

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-admin-aides-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
  });

  afterEach(() => {
    restaurer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("absent = {}, JSON ou UTF-8 illisible = null, autre chose qu'un objet = {}", () => {
    expect(lireConfigDisque()).toEqual({});
    writeFileSync(join(dossier, "config.json"), "{ pas du json");
    expect(lireConfigDisque()).toBeNull();
    writeFileSync(join(dossier, "config.json"), Buffer.from([0x7b, 0xff, 0x7d]));
    expect(lireConfigDisque()).toBeNull();
    writeFileSync(join(dossier, "config.json"), "[1]");
    expect(lireConfigDisque()).toEqual({});
    writeFileSync(join(dossier, "config.json"), '{"a": 1.0}');
    expect(String((lireConfigDisque() as { a: unknown }).a)).toBe("1.0");
  });
});
