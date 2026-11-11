// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/taille-dossiers.test.ts — taille d'un dossier du tableau de bord : sans geler la boucle, plafond de 32 000 fichiers. */
import "../moteur-environnement";

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dirSizeBytes } from "../../src/observabilite/fournisseurs/base";

let dossier = "";

beforeEach(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-tailles-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dossier, { recursive: true, force: true });
});

describe("dirSizeBytes", () => {
  it("les dossiers comptent dans le plafond : des dizaines de milliers de dossiers vides sont vite abandonnés", async () => {
    const vides = path.join(dossier, "vides");
    mkdirSync(vides);
    for (let i = 0; i < 40_000; i++) mkdirSync(path.join(vides, `d${i}`));
    const debut = performance.now();
    expect(await dirSizeBytes(vides)).toBe(0);
    expect(performance.now() - debut).toBeLessThan(5_000);
  }, 60_000);

  it("dossiers imbriqués : au-delà de 4 000 dossiers ouverts, la valeur partielle est rendue vite", async () => {
    const racine = path.join(dossier, "imbriques");
    for (let i = 0; i < 70; i++)
      for (let j = 0; j < 70; j++) {
        const d = path.join(racine, `a${i}`, `b${j}`);
        mkdirSync(d, { recursive: true });
        writeFileSync(path.join(d, "f"), "x");
      }
    const debut = performance.now();
    const total = await dirSizeBytes(racine);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(4_000);
    expect(performance.now() - debut).toBeLessThan(5_000);
  }, 60_000);

  it("sous-dossiers comptés, liens vers des dossiers ni suivis ni comptés, dossier absent = 0", async () => {
    mkdirSync(path.join(dossier, "s", "t"), { recursive: true });
    writeFileSync(path.join(dossier, "a"), "x".repeat(7));
    writeFileSync(path.join(dossier, "s", "t", "b"), "x".repeat(5));
    symlinkSync(path.join(dossier, "s"), path.join(dossier, "lien"));
    expect(await dirSizeBytes(dossier)).toBe(12);
    expect(await dirSizeBytes(path.join(dossier, "absent"))).toBe(0);
  });

  it("la boucle d'événements tourne pendant le parcours", async () => {
    for (let i = 0; i < 2_000; i++) writeFileSync(path.join(dossier, `f${i}`), "x");
    let tours = 0;
    const minuterie = setInterval(() => (tours += 1), 0);
    try {
      expect(await dirSizeBytes(dossier)).toBe(2_000);
    } finally {
      clearInterval(minuterie);
    }
    expect(tours).toBeGreaterThan(0);
  });

  it("au-delà de 32 000 fichiers, seuls les 32 000 premiers sont comptés", async () => {
    const plein = path.join(dossier, "plein");
    mkdirSync(plein);
    for (let i = 0; i < 32_010; i++) writeFileSync(path.join(plein, `f${i}`), "");
    writeFileSync(path.join(plein, "f0"), "x".repeat(3));
    const total = await dirSizeBytes(plein);
    expect(total === 3 || total === 0).toBe(true);
    mkdirSync(path.join(plein, "apres"));
    writeFileSync(path.join(plein, "apres", "gros"), "x".repeat(1000));
    expect(await dirSizeBytes(plein)).toBeLessThan(1000);
  }, 60_000);
});
