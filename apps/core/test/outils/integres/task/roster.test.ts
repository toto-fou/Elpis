// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/roster.test.ts — agents du compte et définition de `task` contre les vecteurs de la référence des tests (écarts voulus déclarés). */
import "../../../moteur-environnement";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErreurPython } from "@elpis/commun";

import { installerFileLlm, installerTokenHex } from "../../../../src/boucle/ports";
import * as T from "../../../../src/outils/integres/task";
import { installerManifesteMcp } from "../../../../src/outils/ports";
import type { Dict } from "../../../../src/python";
import { lireVecteurs } from "../../../vecteurs-moteur";
import { deplier } from "../../../boucle/aides";
import { ecartDefinitionTache } from "./ecart-tache";

const V = deplier(lireVecteurs<unknown>("outils-taches")) as {
  defaut: string[];
  validations: { entree: unknown; sortie: Dict[] | null; erreur: string | null }[];
  rosters: { entree: unknown[]; roster: [string, Dict][]; definition: Dict; actifs: boolean }[];
  apercus: [unknown, number, string][];
  historiques: [unknown[], Dict[]][];
  noms_libres: [string, string[], string][];
  budgets: [unknown, number | null][];
};

function compteurHex(): (n: number) => string {
  let i = 0;
  return (n) =>
    (++i)
      .toString(16)
      .padStart(2 * n, "0")
      .slice(-2 * n);
}

const RESUME_PR_REFERENCE = "branches, commits and opens the pull request for work already in the tree";

/** Spec de la référence portée au TS (écarts voulus) : plus d'`inherit_config` (aucun agent ne reprend la configuration du parent) ; `pr` rend la commande de publication au lieu de publier. */
function sansHeritageConfig(d: Dict): Dict {
  const spec = Object.fromEntries(Object.entries(d).filter(([k]) => k !== "inherit_config"));
  if (spec["persona_stem"] === "AGENT_TASK_PR" && spec["summary"] === RESUME_PR_REFERENCE)
    spec["summary"] = "branches and commits work already in the tree, then hands back the publish command";
  return spec;
}

function versPython(s: T.AgentSpec): Dict {
  return {
    persona_stem: s.personaStem,
    summary: s.summary,
    filter_categories: s.filterCategories,
    allowed_tool_names: s.allowedToolNames ? [...s.allowedToolNames].sort() : null,
    max_iters: s.maxIters,
    persona_text: s.personaText,
    mcp_server_ids: s.mcpServerIds,
  };
}

beforeEach(() => {
  installerManifesteMcp({ defaultOnCategories: () => [] });
  process.env["ELPIS_TASK_RESUME_DIR"] = mkdtempSync(path.join(tmpdir(), "elpis-reprise-"));
});
afterEach(() => {
  installerManifesteMcp(null);
  installerTokenHex(null);
  installerFileLlm(null);
  rmSync(process.env["ELPIS_TASK_RESUME_DIR"]!, { recursive: true, force: true });
  delete process.env["ELPIS_TASK_RESUME_DIR"];
});

describe("agents du compte et définition (vecteurs Python)", () => {
  it("validation des custom_agents : liste canonique ou ValueError au message exact", () => {
    expect(T.customDefaultCategories()).toEqual(V.defaut);
    for (const v of V.validations) {
      installerTokenHex(compteurHex());
      if (v.erreur === null)
        expect(T.validateCustomAgents(structuredClone(v.entree)), JSON.stringify(v.entree)).toStrictEqual(
          v.sortie,
        );
      else {
        let leve: unknown = null;
        try {
          T.validateCustomAgents(structuredClone(v.entree));
        } catch (e) {
          leve = e;
        }
        expect(leve, JSON.stringify(v.entree)).toBeInstanceOf(ErreurPython);
        expect((leve as ErreurPython).message).toBe(v.erreur);
      }
    }
  });

  it("roster effectif, définition de l'outil et présence d'agents", () => {
    for (const r of V.rosters) {
      installerTokenHex(compteurHex());
      const roster = T.agentsRoster(structuredClone(r.entree));
      expect([...roster].map(([n, s]) => [n, versPython(s)])).toStrictEqual(
        (r.roster as [string, Dict][]).map(([n, d]) => [n, sansHeritageConfig(d)]),
      );
      expect(T.buildDefinition(roster)).toStrictEqual(ecartDefinitionTache(r.definition));
      expect(T.hasActiveAgents(r.entree)).toBe(r.actifs);
    }
    expect(
      T.hasActiveAgents(
        ["explore", "implement", "verify", "web", "pr"].map((name) => ({ name, enabled: false })),
      ),
    ).toBe(false);
  });

  it("aperçus, noms libres, budgets", () => {
    for (const [v, m, attendu] of V.apercus) expect(T.preview(v, m)).toBe(attendu);
    for (const [b, t, attendu] of V.noms_libres) {
      installerTokenHex(compteurHex());
      expect(T.freeAgentName(b, new Set(t))).toBe(attendu);
    }
    for (const [v, attendu] of V.budgets) expect(T.normMaxIters(v)).toBe(attendu);
  });

  it("normMaxIters : seuls TypeError et ValueError donnent null, l'OverflowError d'un infini remonte comme en Python", () => {
    for (const v of ["abc", Number.NaN, [], {}, "1e3"]) expect(T.normMaxIters(v), String(v)).toBeNull();
    for (const v of [Infinity, -Infinity])
      expect(() => T.normMaxIters(v), String(v)).toThrow(expect.objectContaining({ type: "OverflowError" }));
    expect(() => T.validateCustomAgents([{ name: "explore", max_iters: Infinity }])).toThrow(
      expect.objectContaining({ type: "OverflowError" }),
    );
  });
});
