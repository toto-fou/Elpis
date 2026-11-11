// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/budget.test.ts — budget de la fenêtre et porte de compaction, rejoués sur les vecteurs Python. */
import { ErreurPython } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { afterEach, describe, expect, it } from "vitest";

import { BUDGET, ContextBudget } from "../../src/contexte/budget";
import type { ValeursBudget } from "../../src/contexte/budget";
import * as G from "../../src/contexte/porte-compaction";
import { decoder, lireVecteurs } from "../vecteurs-moteur";

type Resultat = { ok: number } | { erreur: string };
type Instance = Record<string, number>;

interface Vecteurs {
  budgets: { brut: Record<string, unknown>; valeurs: Record<string, number>; calculs: unknown[][] }[];
  clamps: { valeur: unknown; pct: Resultat; tokens: Resultat; max_rounds: Resultat }[];
  runs: [unknown, number | null, number][];
  seuils: { pct: number; tokens: number; mode: string; is_set: boolean; cibles: [number, number][] }[];
  resolution: {
    instance: Instance;
    reglages: Record<string, unknown> | null;
    pct: number;
    tokens: number;
    max_rounds: number | null;
  }[];
  portes: {
    instance: Instance;
    ctx: number | null;
    thinking: boolean;
    pct: number;
    tokens: number;
    buffer: number | null;
    usable: number;
    porte: Record<string, unknown>;
  }[];
  caps: [boolean, number | null, number][];
}

const V = lireVecteurs<Vecteurs>("contexte-budget");
const NOMS: Record<string, keyof ValeursBudget> = {
  output_reserve_ratio: "outputReserveRatio",
  output_reserve_min: "outputReserveMin",
  reserve_ceiling_ratio: "reserveCeilingRatio",
  keep_recent_msgs: "keepRecentMsgs",
  emit_cap_min_tokens: "emitCapMinTokens",
  emit_cap_ratio: "emitCapRatio",
  emit_cap_max_tokens: "emitCapMaxTokens",
  sanitize_tool_max_tokens: "sanitizeToolMaxTokens",
  head_split: "headSplit",
};

const restaurations: (() => void)[] = [];
afterEach(() => {
  while (restaurations.length) restaurations.pop()?.();
});

function instance(valeurs: Instance): void {
  restaurations.push(surchargerConfig(valeurs as Parameters<typeof surchargerConfig>[0]));
}

function appel(f: () => number): Resultat {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof ErreurPython) return { erreur: e.type };
    throw e;
  }
}

describe("budget de la fenêtre", () => {
  it.each(V.budgets.map((b, i) => [i, b] as const))("surcharges budgets n° %i", (_i, b) => {
    const budget = ContextBudget.depuis((cle) => decoder(b.brut[cle] ?? null));
    for (const [cle, valeur] of Object.entries(b.valeurs)) expect(budget[NOMS[cle]!]).toBe(valeur);
    for (const [ctx, cap, surcout, reserve, dispo] of b.calculs) {
      expect(budget.reserveTokens(ctx as number, cap as number | null)).toBe(reserve);
      expect(budget.promptBudget(ctx as number, cap as number | null, (surcout ?? 0) as number)).toBe(dispo);
    }
  });

  it("objet gelé, défauts Python", () => {
    expect(Object.isFrozen(BUDGET)).toBe(true);
    expect(new ContextBudget().keepRecentMsgs).toBe(16);
  });

  it("cap de génération délégué à la source unique", () => {
    for (const [thinking, ctx, cap] of V.caps) expect(BUDGET.generationCap(thinking, ctx)).toBe(cap);
  });
});

describe("porte de compaction", () => {
  it("coercitions des réglages (int() Python)", () => {
    for (const c of V.clamps) {
      const x = decoder(c.valeur);
      expect([c.valeur, appel(() => G.clampThresholdPct(x))]).toEqual([c.valeur, c.pct]);
      expect([c.valeur, appel(() => G.clampThresholdTokens(x))]).toEqual([c.valeur, c.tokens]);
      expect([c.valeur, appel(() => G.clampMaxRounds(x))]).toEqual([c.valeur, c.max_rounds]);
    }
  });

  it("budget de compactions d'un run", () => {
    for (const [auto, mr, attendu] of V.runs) expect(G.runCompactionBudget(auto, mr)).toBe(attendu);
  });

  it("seuil réglé : mode et cible", () => {
    for (const s of V.seuils) {
      const t = new G.CompactionThreshold(s.pct, s.tokens);
      expect([t.mode, t.isSet]).toEqual([s.mode, s.is_set]);
      for (const [ctx, cible] of s.cibles) expect(t.targetTokens(ctx)).toBe(cible);
    }
  });

  it("résolution compte > instance > auto", () => {
    for (const r of V.resolution) {
      const restaurer = surchargerConfig(r.instance as Parameters<typeof surchargerConfig>[0]);
      try {
        const t = G.resolveThreshold(r.reglages);
        expect([r.reglages, r.instance, t.pct, t.tokens, G.resolveMaxRounds(r.reglages)]).toEqual([
          r.reglages,
          r.instance,
          r.pct,
          r.tokens,
          r.max_rounds,
        ]);
      } finally {
        restaurer();
      }
    }
  });

  it("plafond technique et seuil effectif", () => {
    for (const p of V.portes) {
      instance(p.instance);
      const g = G.compactionGate(p.ctx, {
        thinkingMode: p.thinking,
        threshold: G.thresholdFrom(p.pct, p.tokens),
      });
      const vu = {
        ctx_size: g.ctxSize,
        usable_tokens: g.usableTokens,
        trigger_tokens: g.triggerTokens,
        is_user_threshold: g.isUserThreshold,
        describe: g.describe(),
        gate_tokens: G.gateTokens(g),
      };
      expect([p, vu]).toEqual([p, p.porte]);
      expect(G.usableWindow(p.ctx, p.thinking)).toBe(p.usable);
      if (p.buffer !== null) expect(G.bufferTokens(p.ctx as number)).toBe(p.buffer);
      restaurations.pop()?.();
    }
  });

  it("AUTO : aucun seuil, plafond technique", () => {
    expect([G.AUTO.mode, G.AUTO.isSet, G.compactionGate(0).describe()]).toEqual(["auto", false, "auto"]);
  });
});

describe("compaction active pour un compte", () => {
  afterEach(() => surchargerConfig({}));

  it("interrupteur d'instance ET réglage du compte (éteint par défaut)", () => {
    surchargerConfig({ COMPRESSION_ENABLED: true });
    expect(G.compactionActive({ compression_enabled: true })).toBe(true);
    expect(G.compactionActive({ compression_enabled: false })).toBe(false);
    expect(G.compactionActive({})).toBe(false);
    expect(G.compactionActive(null)).toBe(false);
    surchargerConfig({ COMPRESSION_ENABLED: false });
    expect(G.compactionActive({ compression_enabled: true })).toBe(false);
  });
});
