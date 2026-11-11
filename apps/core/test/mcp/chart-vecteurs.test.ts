// SPDX-License-Identifier: MIT
/** apps/core/test/mcp/chart-vecteurs.test.ts — outils chart_<type> et ressource chart:// rejoués contre les vecteurs du Python (résultat, exceptions, fichiers de cache écrits). */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ErreurPython, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { validerArguments } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { reinitialiserRefus } from "../../src/graphiques/moteur/index";
import { outilsChart, ressourcesChart } from "../../src/outils/mcp/famille-chart";

interface Cas {
  nom: string;
  type: "outil" | "ressource";
  outil?: string;
  args?: string;
  meta?: Dict | null;
  limites?: { rows: number; cells: number };
  dossier?: string;
  username?: string;
  chart_id?: string;
  resultat: string;
  fichiers?: Record<string, string>;
}

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/outils-chart.json", import.meta.url), "utf-8")) as {
  cas: Cas[];
};

let racine = "";

beforeAll(() => {
  racine = mkdtempSync(join(tmpdir(), "elpis-chart-vecteurs-"));
  mkdirSync(join(racine, "cache"));
  writeFileSync(join(racine, "fichier"), "x");
  reinitialiserRefus();
});

afterAll(() => {
  rmSync(racine, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function fichiers(dossier: string): Record<string, string> {
  const sortie: Record<string, string> = {};
  const parcourir = (rel: string): void => {
    for (const e of readdirSync(join(dossier, rel), { withFileTypes: true })) {
      const chemin = join(rel, e.name);
      if (e.isDirectory()) parcourir(chemin);
      else if (e.name.endsWith(".json")) sortie[chemin] = readFileSync(join(dossier, chemin), "utf-8");
    }
  };
  parcourir("");
  return sortie;
}

function rejouer(c: Cas): { resultat: string; fichiers: Record<string, string> } {
  const cache = join(racine, "cache");
  vi.stubEnv("CHART_CACHE_DIR", c.dossier ? join(racine, c.dossier) : cache);
  vi.stubEnv("TOOL_CHART_MAX_ROWS", c.limites ? String(c.limites.rows) : "");
  vi.stubEnv("TOOL_CHART_MAX_CELLS", c.limites ? String(c.limites.cells) : "");
  const avant = fichiers(cache);
  let obtenu: unknown;
  const outil = outilsChart().find((o) => o.nom === c.outil);
  if (outil === undefined) throw new Error(`outil absent : ${c.outil}`);
  const args = pyJsonLoads(c.args ?? "{}") as Dict;
  const r = validerArguments({ fonction: outil.nom, parametres: outil.signature, motsClesSeuls: true }, args);
  if (!r.ok) throw new Error(r.texte);
  try {
    obtenu = outil.traiter(r.valeurs, (c.meta ? { meta: c.meta } : null) as unknown as ContexteAppel, args);
  } catch (e) {
    obtenu = e instanceof ErreurPython ? { exception: e.type, message: e.message } : { exception: String(e) };
  }
  const apres = fichiers(cache);
  return {
    resultat: pyJsonDumps(obtenu, { ensureAscii: false }),
    fichiers: Object.fromEntries(Object.entries(apres).filter(([k, v]) => avant[k] !== v)),
  };
}

describe("outils chart_<type> et ressource chart:// rejoués contre le Python", () => {
  it("le fichier de vecteurs couvre les 30 types, les échecs et la ressource", () => {
    const noms = V.cas.filter((c) => c.type === "outil").map((c) => c.outil);
    expect(new Set(noms).size).toBeGreaterThanOrEqual(30);
    expect(V.cas.filter((c) => c.type === "ressource").length).toBeGreaterThanOrEqual(8);
    expect(V.cas.length).toBeGreaterThan(80);
  });

  for (const c of V.cas)
    it(`${c.type} ${c.nom}`, () => {
      if (c.type === "ressource") {
        vi.stubEnv("CHART_CACHE_DIR", join(racine, "cache"));
        const lu = ressourcesChart()[0]?.lire({ username: c.username ?? "", chart_id: c.chart_id ?? "" });
        expect(lu).toBe(c.resultat);
        return;
      }
      const o = rejouer(c);
      expect(o.resultat).toBe(c.resultat.replaceAll("<RACINE>", racine));
      expect(o.fichiers).toEqual(c.fichiers);
    });
});
