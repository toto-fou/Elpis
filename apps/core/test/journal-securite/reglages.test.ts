// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/reglages.test.ts — réglages du journal de sécurité : défauts, bornes, valeur écrite à la main, validation d'un PUT. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpError } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import {
  lireTemoinGel,
  lireTemoinReglages,
  reglagesDepuis,
  validerReglagesJournal,
} from "../../src/journal-securite/reglages";

const DEFAUTS = { retention_days: 365, hold: false, hold_reason: "", forwarding_expected: false };

describe("reglagesDepuis", () => {
  it("section absente ou invalide : défauts", () => {
    expect(reglagesDepuis(undefined)).toEqual({
      ...DEFAUTS,
      hors_bornes: false,
      invalide: false,
      depuis_temoin: false,
    });
    expect(reglagesDepuis({ hold: null })).toEqual({
      ...DEFAUTS,
      hors_bornes: false,
      invalide: false,
      depuis_temoin: false,
    });
  });

  it("durée écrite en texte ou en flottant : arrondie vers le haut ; illisible : signalée (purge suspendue)", () => {
    expect(reglagesDepuis({ retention_days: "1095" })).toMatchObject({
      retention_days: 1095,
      invalide: false,
    });
    expect(reglagesDepuis({ retention_days: 730.2 })).toMatchObject({ retention_days: 731, invalide: false });
    expect(reglagesDepuis({ retention_days: "x" })).toMatchObject({ retention_days: 365, invalide: true });
    expect(reglagesDepuis({ retention_days: [] })).toMatchObject({ invalide: true });
  });

  it("durée écrite à la main : relevée à 180 en dessous, gardée au-dessus de 1095, signalée hors bornes", () => {
    expect(reglagesDepuis({ retention_days: 30 })).toMatchObject({ retention_days: 180, hors_bornes: true });
    expect(reglagesDepuis({ retention_days: 2000 })).toMatchObject({
      retention_days: 2000,
      hors_bornes: true,
    });
    expect(reglagesDepuis({ retention_days: 730 })).toMatchObject({
      retention_days: 730,
      hors_bornes: false,
    });
  });

  it("toute valeur vraie gèle ; le motif est borné à 500 caractères", () => {
    const r = reglagesDepuis({ hold: 1, hold_reason: "x".repeat(800) });
    expect(r.hold).toBe(true);
    expect(r.hold_reason).toHaveLength(500);
  });
});

describe("validerReglagesJournal", () => {
  const refus = (corps: unknown): number => {
    try {
      validerReglagesJournal(corps, DEFAUTS);
    } catch (e) {
      return e instanceof HttpError ? e.statusCode : -1;
    }
    return 0;
  };

  it("bornes [180 ; 1095], entier exigé, types stricts, objet exigé", () => {
    expect(validerReglagesJournal({ retention_days: 180 }, DEFAUTS).retention_days).toBe(180);
    expect(validerReglagesJournal({ retention_days: 1095 }, DEFAUTS).retention_days).toBe(1095);
    for (const corps of [
      { retention_days: 179 },
      { retention_days: 1096 },
      { retention_days: 365.5 },
      { retention_days: "365" },
      { hold: "true" },
      { forwarding_expected: 1 },
      { hold_reason: 3 },
      [],
      null,
    ])
      expect(refus(corps)).toBe(400);
  });

  it("gel : motif exigé ; levée : motif effacé ; champs absents gardés", () => {
    expect(refus({ hold: true })).toBe(400);
    expect(refus({ hold: true, hold_reason: "   " })).toBe(400);
    const gele = validerReglagesJournal({ hold: true, hold_reason: " Enquête 2026-17 " }, DEFAUTS);
    expect(gele).toEqual({ ...DEFAUTS, hold: true, hold_reason: "Enquête 2026-17" });
    expect(validerReglagesJournal({ forwarding_expected: true }, gele)).toEqual({
      ...gele,
      forwarding_expected: true,
    });
    expect(validerReglagesJournal({ hold: false }, gele)).toEqual(DEFAUTS);
  });
});

describe("témoins du dossier du journal", () => {
  it("lus normalement ; une FIFO ou un dossier posés à leur place sont ignorés sans bloquer", () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-temoins-"));
    try {
      writeFileSync(join(dossier, ".settings"), '{"retention_days": 400, "forwarding_expected": true}');
      writeFileSync(join(dossier, ".hold"), "  enquête en cours \n");
      expect(lireTemoinReglages(dossier)).toEqual({ retention_days: 400, forwarding_expected: true });
      expect(lireTemoinGel(dossier)).toBe("enquête en cours");
      rmSync(join(dossier, ".settings"));
      rmSync(join(dossier, ".hold"));
      execFileSync("mkfifo", [join(dossier, ".settings"), join(dossier, ".hold")]);
      expect(lireTemoinReglages(dossier)).toBeNull();
      expect(lireTemoinGel(dossier)).toBeNull();
      rmSync(join(dossier, ".hold"));
      execFileSync("mkdir", [join(dossier, ".hold")]);
      expect(lireTemoinGel(dossier)).toBeNull();
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});
