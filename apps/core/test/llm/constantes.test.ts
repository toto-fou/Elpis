// SPDX-License-Identifier: MIT
/** apps/core/test/llm/constantes.test.ts — constantes du moteur lues au chargement (env, config) et bornes de génération : vecteurs Python. */
import { sortieSansPlafondExplicite } from "../ecart-longueur-explicite";
import { ENV_MOTEUR } from "../moteur-environnement";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as ModuleConstantes from "../../src/llm/constantes";
import { decoder, lireVecteurs, rejouer } from "../vecteurs-moteur";
import type { Attendu } from "../vecteurs-moteur";

type Constantes = typeof ModuleConstantes;
type Dict = Record<string, unknown>;

interface Scenario {
  nom: string;
  env: Record<string, string>;
  config: Dict;
  constantes: Dict;
  slots: ({ chat: unknown; total: number | null; occupes: number[] | null; eviter: boolean } & Attendu)[];
  kv: { payload: Dict; sortie: Dict }[];
  caps: ({ thinking: boolean; ctx: number | null } & Attendu)[];
  clamps: ({ payload: Dict; sampling: Dict; thinking: boolean; ctx: number | null; uncap: boolean } & (
    { sortie: Dict } | { erreur: string }
  ))[];
}

const vecteurs = lireVecteurs<{ scenarios: Scenario[] }>("moteur-constantes");

/** Un démarrage : env posée, réglages de config, puis import neuf du module (lu au chargement, comme l'import Python). */
async function demarrer(scenario: Pick<Scenario, "env" | "config">): Promise<Constantes> {
  vi.resetModules();
  for (const nom of ENV_MOTEUR) vi.stubEnv(nom, scenario.env[nom]);
  const cfg = await import("@elpis/config");
  cfg.surchargerConfig(scenario.config as Parameters<typeof cfg.surchargerConfig>[0]);
  return import("../../src/llm/constantes");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Constantes Python sans équivalent TS (écart voulu) : `TASK_SUBAGENT_DEPTH`, aucun sous-agent n'en lance (ecarts-python.md de la v0.1.2). */
const CONSTANTES_RETIREES: ReadonlySet<string> = new Set(["TASK_SUBAGENT_DEPTH"]);

function nomTs(nomPython: string): string {
  return nomPython.startsWith("_") ? nomPython.slice(1) : nomPython;
}

describe("vecteurs Python de llm_core/_constants.py", () => {
  it("couvre tous les scénarios générés", () => {
    expect(vecteurs.scenarios.length).toBeGreaterThan(15);
  });

  for (const scenario of vecteurs.scenarios) {
    it(`scénario ${scenario.nom}`, async () => {
      const C = await demarrer(scenario);
      for (const [nom, valeur] of Object.entries(scenario.constantes))
        if (!CONSTANTES_RETIREES.has(nom))
          expect(C[nomTs(nom) as keyof Constantes], nom).toEqual(decoder(valeur));
      for (const c of scenario.slots) {
        const occupes = c.occupes === null ? null : new Set(c.occupes);
        rejouer(
          () => C.resolveSlotId(c.chat, c.total, occupes, { avoidOwn: c.eviter }),
          c,
          JSON.stringify(c),
        );
      }
      for (const c of scenario.kv) {
        const p = { ...c.payload };
        C.applyKvCacheParams(p);
        expect(p).toEqual(c.sortie);
        expect(Object.keys(p)).toEqual(Object.keys(c.sortie));
      }
      for (const c of scenario.caps)
        rejouer(() => C.effectiveGenerationCap(c.thinking, c.ctx), c, JSON.stringify(c));
      for (const c of scenario.clamps) {
        const p = structuredClone(c.payload);
        const appel = (): void =>
          C.clampGenerationBudget(p, c.sampling, c.thinking, c.ctx, { uncapOutput: c.uncap });
        if ("erreur" in c) {
          rejouer(appel, c, JSON.stringify(c));
          continue;
        }
        appel();
        const sortie = sortieSansPlafondExplicite(c.payload, c.sampling, c.sortie);
        expect(p, JSON.stringify(c)).toEqual(sortie);
        expect(Object.keys(p), JSON.stringify(c)).toEqual(Object.keys(sortie));
      }
    });
  }
});

describe("longueur explicite bornée à la fenêtre (écart voulu au Python)", () => {
  it("fenêtre inconnue ou place nulle : rien de changé", async () => {
    const C = await demarrer(vecteurs.scenarios[0] as Scenario);
    expect(C.placeDeSortie(0, 100)).toBe(0);
    expect(C.placeDeSortie(-5, 100)).toBe(0);
    expect(C.placeDeSortie(1000, 5000)).toBe(0);
    const p: Dict = { max_tokens: 9999 };
    expect(C.bornerLongueurALaFenetre(p, 0, 100)).toEqual([]);
    expect(C.bornerLongueurALaFenetre(p, 1000, 5000)).toEqual([]);
    expect(p).toEqual({ max_tokens: 9999 });
  });

  it("place de sortie : fenêtre - prompt - marge (512 au moins, 2 % sinon)", async () => {
    const C = await demarrer(vecteurs.scenarios[0] as Scenario);
    expect(C.placeDeSortie(4096, 1000)).toBe(4096 - 1000 - 512);
    expect(C.placeDeSortie(100_000, 1000)).toBe(100_000 - 1000 - 2000);
    expect(C.placeDeSortie(4096, -10)).toBe(4096 - 512);
  });

  it("valeur au-dessus de la place : ramenée ; au plus égale : intacte ; les trois clés", async () => {
    const C = await demarrer(vecteurs.scenarios[0] as Scenario);
    const place = C.placeDeSortie(8192, 2000);
    const p: Dict = { max_tokens: place + 1, max_completion_tokens: 10, n_predict: 999_999, autre: 5 };
    const bornees = C.bornerLongueurALaFenetre(p, 8192, 2000);
    expect(p).toEqual({ max_tokens: place, max_completion_tokens: 10, n_predict: place, autre: 5 });
    expect(bornees).toEqual([
      { cle: "max_tokens", demandee: place + 1, envoyee: place },
      { cle: "n_predict", demandee: 999_999, envoyee: place },
    ]);
    const egal: Dict = { max_completion_tokens: place };
    expect(C.bornerLongueurALaFenetre(egal, 8192, 2000)).toEqual([]);
    const tout: Dict = { max_tokens: 1e9, max_completion_tokens: 1e9, n_predict: 1e9 };
    expect(C.bornerLongueurALaFenetre(tout, 8192, 2000).map((b) => b.cle)).toEqual([
      "max_tokens",
      "max_completion_tokens",
      "n_predict",
    ]);
  });
});

describe("comportements des tests pytest", () => {
  const defaut = vecteurs.scenarios[0] as Scenario;

  it("réutilisation KV : le champ reconnu par llama-server est n_cache_reuse, à 256 par défaut", async () => {
    const C = await demarrer(defaut);
    const p: Dict = {};
    C.applyKvCacheParams(p);
    expect(p).toEqual({ cache_prompt: true, n_cache_reuse: 256 });
    expect("cache_reuse" in p).toBe(false);
  });

  it("budget : cap injecté, longueur explicite non plafonnée, n_predict illimité retiré, sortie non plafonnée", async () => {
    const C = await demarrer(defaut);
    const borne = (sampling: Dict, thinking = false, ctx: number | null = null, uncap = false): Dict => {
      const p: Dict = uncap ? { max_tokens: 1234 } : {};
      C.clampGenerationBudget(p, sampling, thinking, ctx, { uncapOutput: uncap });
      return p;
    };
    expect(borne({})).toEqual({ max_tokens: C.LLAMA_MAX_TOKENS_CHAT });
    expect(borne({ max_tokens: 1_000_000 })).toEqual({});
    expect(borne({ n_predict: -1 })).toEqual({ max_tokens: C.LLAMA_MAX_TOKENS_CHAT });
    expect(borne({}, true, 32768)).toEqual({ max_tokens: Math.trunc(32768 * C.LLAMA_GEN_CAP_CTX_RATIO) });
    expect(borne({}, true, null, true)).toEqual({});
    expect(borne({ max_tokens: 1_000_000 }, true, 32768, true)).toEqual({ max_tokens: 1234 });
    expect(C.effectiveGenerationCap(false, 4096)).toBe(C.LLAMA_GEN_CAP_FLOOR);
    expect(C.effectiveGenerationCap(true, 131072)).toBe(C.LLAMA_MAX_TOKENS_THINKING);
  });

  it("slot annexe : jamais celui du chat, déterministe, jamais occupé ; celui du chat si tout est pris", async () => {
    const C = await demarrer(defaut);
    for (const cid of ["c-1", "c-2", "chat-xyz", "42"]) {
      const propre = C.resolveSlotId(cid, 4, new Set());
      const ailleurs = C.resolveSlotId(cid, 4, new Set(), { avoidOwn: true });
      expect(ailleurs).not.toBe(propre);
      expect(C.resolveSlotId(cid, 4, [], { avoidOwn: true })).toBe(ailleurs);
      const autres = [0, 1, 2, 3].filter((s) => s !== propre);
      expect(C.resolveSlotId(cid, 4, autres, { avoidOwn: true })).toBe(propre);
    }
    expect(C.resolveSlotId("c-1", 1, null, { avoidOwn: true })).toBe(C.resolveSlotId("c-1", 1, null));
  });

  it("slots évités (parent en attente, frères en cours) : écartés tant qu'un autre est libre, sinon slot préféré", async () => {
    const C = await demarrer(defaut);
    for (const cle of ["c1#task-explore", "c1#task-verify", "42"]) {
      const propre = C.resolveSlotId(cle, 4, new Set());
      const autres = [0, 1, 2, 3].filter((s) => s !== propre);
      const ecarte = C.resolveSlotId(cle, 4, new Set(), { avoid: [propre] });
      expect(autres).toContain(ecarte);
      expect(C.resolveSlotId(cle, 4, null, { avoid: [propre] })).toBe(ecarte);
      expect(C.resolveSlotId(cle, 4, new Set([autres[0]!]), { avoid: [propre, autres[1]!] })).toBe(autres[2]);
      expect(C.resolveSlotId(cle, 4, new Set(autres), { avoid: [propre] })).toBe(propre);
      expect(C.resolveSlotId(cle, 4, new Set(), { avoid: [autres[0]!] })).toBe(propre);
    }
  });

  it("état partagé de la vision : caches modifiables en place", async () => {
    const C = await demarrer(defaut);
    C.VISION_CAPABILITY_CACHE.set("m", true);
    C.LAST_SCREENSHOT.set("u:c", new Uint8Array([1]));
    expect(C.VISION_CAPABILITY_CACHE.get("m")).toBe(true);
    expect(C.LAST_SCREENSHOT.size).toBe(1);
  });
});
