// SPDX-License-Identifier: MIT
/** apps/core/test/graphiques/moteur-cache.test.ts — cache `<tmp>/elpis_charts` écrit au format exact que relisent `incrustation.ts` et `office` (chart_tools.py rejoué). */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ErreurPython, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lireCacheGraphique } from "../../src/graphiques/incrustation";
import { chartResource, chartsDir, pruneCharts, saveChartConfig } from "../../src/graphiques/moteur/cache";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { V } from "./vecteurs-moteur";

let racine: string;

beforeEach(() => {
  racine = mkdtempSync(path.join(tmpdir(), "elpis-cache-graphiques-"));
  vi.stubEnv("CHART_CACHE_DIR", racine);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(racine, { recursive: true, force: true });
});

/** Une option dont on connaît l'identifiant écrit par `_save_chart_config`. */
const exemples = (V.graphiques as any[]).filter(
  (e) => typeof e.id === "string" && !String(e.args.type).toLowerCase().startsWith("gantt"),
);

describe("écriture du cache des graphiques", () => {
  it("identifiant et fichier identiques à _save_chart_config (SHA-1 de la forme triée, JSON non trié sur disque)", () => {
    expect(exemples.length).toBeGreaterThan(500);
    for (const e of exemples) {
      const option = pyJsonLoads(e.option);
      const id = saveChartConfig(option, "bob");
      expect(id, e.nom).toBe(e.id);
      expect(readFileSync(path.join(racine, "bob", `${id}.json`), "utf-8"), e.nom).toBe(e.option);
    }
  });

  it("droits privés (0700 pour la base et le compte, 0600 pour le fichier) et relecture par le lecteur du core", () => {
    const e = exemples[0];
    const id = saveChartConfig(pyJsonLoads(e.option), "alice");
    expect(statSync(racine).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(racine, "alice")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(racine, "alice", `${id}.json`)).mode & 0o777).toBe(0o600);
    expect(lireCacheGraphique("alice", id)?.toString("utf-8")).toBe(e.option);
    expect(chartResource("alice", id)).toBe(e.option);
  });

  it("un même contenu n'est pas réécrit", () => {
    const option = pyJsonLoads(exemples[1].option);
    const id = saveChartConfig(option, "bob");
    const fichier = path.join(racine, "bob", `${id}.json`);
    utimesSync(fichier, 1_000, 1_000);
    expect(saveChartConfig(option, "bob")).toBe(id);
    expect(statSync(fichier).mtimeMs).toBe(1_000_000);
  });

  it("nom de compte assaini comme _safe_username", () => {
    const option = { a: 1 };
    saveChartConfig(option, "../x/é y");
    saveChartConfig(option, "");
    saveChartConfig(option, null);
    expect(readdirSync(racine).sort()).toEqual(["guest", "xéy"]);
  });

  it("nombre non fini ou texte non encodable : ValueError, rien d'écrit", () => {
    expect(() => saveChartConfig({ a: Number.NaN }, "bob")).toThrow(ErreurPython);
    expect(() => saveChartConfig({ a: "\ud800" }, "bob")).toThrow(ErreurPython);
    expect(() => saveChartConfig({ a: Number.POSITIVE_INFINITY }, "bob")).toThrow(ErreurPython);
    expect(existsSync(path.join(racine, "bob"))).toBe(false);
  });

  it("ressource chart:// absente : enveloppe chart_not_found comme json.dumps", () => {
    expect(chartResource("bob", "zz")).toBe('{"ok": false, "error": "chart_not_found", "chart_id": "zz"}');
    expect(chartResource("bob", "../../etc/passwd")).toBe(
      pyJsonDumps({ ok: false, error: "chart_not_found", chart_id: "../../etc/passwd" }),
    );
  });

  it("élagage : les plus anciennes configs partent au-delà de TOOL_CHART_CACHE_MAX (50 au minimum)", () => {
    const d = chartsDir("bob");
    for (let i = 0; i < 60; i++) {
      const f = path.join(d, `${String(i).padStart(12, "0")}.json`);
      writeFileSync(f, "{}");
      utimesSync(f, 1_000 + i, 1_000 + i);
    }
    writeFileSync(path.join(d, "autre.txt"), "x");
    pruneCharts(d, 50);
    const restants = readdirSync(d).filter((n) => n.endsWith(".json"));
    expect(restants).toHaveLength(50);
    expect(restants).not.toContain("000000000000.json");
    expect(restants).toContain("000000000059.json");
    expect(existsSync(path.join(d, "autre.txt"))).toBe(true);
    vi.stubEnv("TOOL_CHART_CACHE_MAX", "10");
    saveChartConfig({ nouveau: true }, "bob");
    expect(readdirSync(d).filter((n) => n.endsWith(".json"))).toHaveLength(50);
  });

  it("TOOL_CHART_CACHE_MAX : 0 vaut 50 comme max(50, 0), illisible ou vide vaut 1000, sans lever", () => {
    const d = chartsDir("bob");
    for (let i = 0; i < 60; i++) {
      const f = path.join(d, `${String(i).padStart(12, "0")}.json`);
      writeFileSync(f, "{}");
      utimesSync(f, 1_000 + i, 1_000 + i);
    }
    vi.stubEnv("TOOL_CHART_CACHE_MAX", "0");
    saveChartConfig({ zero: true }, "bob");
    expect(readdirSync(d).filter((n) => n.endsWith(".json"))).toHaveLength(50);
    vi.stubEnv("TOOL_CHART_CACHE_MAX", "abc");
    expect(() => saveChartConfig({ illisible: true }, "bob")).not.toThrow();
    expect(readdirSync(d).filter((n) => n.endsWith(".json"))).toHaveLength(51);
  });

  it("pruneCharts(d, 0) ne supprime rien, comme files[:-0] en Python", () => {
    const d = chartsDir("bob");
    writeFileSync(path.join(d, "a.json"), "{}");
    pruneCharts(d, 0);
    expect(readdirSync(d)).toEqual(["a.json"]);
  });

  it("échec d'écriture : l'erreur du système remonte (le .tmp n'est pas laissé en lecture seule)", () => {
    const id = saveChartConfig({ a: 1 }, "bob");
    rmSync(path.join(racine, "bob", `${id}.json`));
    mkdirSync(path.join(racine, "bob", `${id}.json.tmp`));
    expect(() => saveChartConfig({ a: 1 }, "bob")).toThrow(/EISDIR/);
    expect(existsSync(path.join(racine, "bob", `${id}.json`))).toBe(false);
    writeFileSync(path.join(racine, "pas-un-dossier"), "x");
    vi.stubEnv("CHART_CACHE_DIR", path.join(racine, "pas-un-dossier"));
    expect(() => saveChartConfig({ a: 1 }, "bob")).toThrow(/ENOTDIR|EEXIST/);
  });

  it("chmod ignoré sur un lien symbolique (base du cache)", () => {
    const cible = path.join(racine, "cible");
    mkdirSync(cible, { mode: 0o755 });
    const lien = mkdtempSync(path.join(tmpdir(), "elpis-lien-"));
    try {
      rmSync(lien, { recursive: true });
      symlinkSync(cible, lien);
      vi.stubEnv("CHART_CACHE_DIR", lien);
      saveChartConfig({ a: 1 }, "bob");
      expect(statSync(cible).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(lien, { force: true });
    }
  });
});
