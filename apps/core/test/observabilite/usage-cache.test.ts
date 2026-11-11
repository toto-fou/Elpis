// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/usage-cache.test.ts — widgets du cache sur des tours connus (SQLite, PostgreSQL si configuré) : entrée en trois parts (lu, écrit, hors cache) et requêtes servies par le cache. */
import type { Dict } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ContexteMetriques, Fournisseur } from "../../src/observabilite/fournisseurs/base";
import { fournisseursMoteur } from "../../src/observabilite/fournisseurs/moteur";
import { fournisseursUsage } from "../../src/observabilite/fournisseurs/usage";
import { recordUsage } from "../../src/observabilite/usage-registre";

const MAINTENANT = 1_800_000_000;
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

/** Tours : [il y a (s), modèle, entrée, lu, écrit, sortie, réflexion, requêtes mesurées, servies par le cache]. */
const TOURS: readonly [number, string, number, number, number, number, number, number, number][] = [
  [600, "claude", 1000, 800, 150, 20, 5, 3, 2],
  [1200, "llama", 500, 300, 0, 10, 0, 2, 1],
  [1800, "claude", 100, 60, 70, 4, 0, 1, 1],
  [2 * 86400, "claude", 999, 999, 0, 1, 0, 5, 5],
];

function widget(id: string): Fournisseur {
  const f = [...fournisseursUsage(), ...fournisseursMoteur()].find((p) => p.id === id);
  if (f === undefined) throw new Error(id);
  return f;
}

const somme = (ds: Dict): number => (ds["data"] as unknown[]).reduce<number>((a, v) => a + Number(v), 0);

describe.each(MOTEURS)("widgets du cache (%s)", (moteur) => {
  let t: BaseDeTest;
  let ctx: ContexteMetriques;
  const donnees = async (id: string): Promise<Dict> => (await widget(id).getData(ctx, 24)) as Dict;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MAINTENANT * 1000);
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [age, model, entree, lu, ecrit, sortie, reflexion, mesurees, servies] of TOURS)
      await recordUsage(t.base, {
        ts: MAINTENANT - age,
        userId: 1,
        source: "chat",
        model,
        inputTokens: entree,
        outputTokens: sortie,
        thinkingTokens: reflexion,
        cacheReadTokens: lu,
        cacheCreationTokens: ecrit,
        cacheReportedCalls: mesurees,
        cacheHitCalls: servies,
      });
    ctx = {
      base: t.base,
      systeme: {} as ContexteMetriques["systeme"],
      historique: () => [],
      santeLlm: async () => ({}),
    };
  });

  afterAll(async () => {
    vi.useRealTimers();
    await t.fermer();
  });

  it("Cache de prompt : part de l'entrée lue du cache, puis lu, écrit et hors cache", async () => {
    expect(await donnees("usage_cache")).toEqual({
      value: "72.5 %",
      unit: "de l'entrée relue du cache",
      color: "cyan",
      icon: "ph-database",
      detail: "1,2 k lus · 220 écrits · 220 hors cache",
    });
  });

  it("graphe de l'entrée : écrit borné ligne à ligne, les trois séries recomposent l'entrée", async () => {
    const g = await donnees("usage_input_timeline");
    expect((g["datasets"] as Dict[]).map((d) => [d["label"], somme(d)])).toEqual([
      ["Lu du cache", 1160],
      ["Écrit en cache", 190],
      ["Hors cache", 250],
    ]);
  });

  it("tokens par modèle : cinq postes disjoints, l'entrée retrouvée", async () => {
    const g = await donnees("usage_by_model");
    expect(g["labels"]).toEqual(["claude", "llama"]);
    expect((g["datasets"] as Dict[]).map((d) => [d["label"], (d["data"] as unknown[]).map(Number)])).toEqual([
      ["Lu du cache", [860, 300]],
      ["Écrit en cache", [220, 0]],
      ["Hors cache", [20, 200]],
      ["Réflexion", [5, 0]],
      ["Réponse", [19, 10]],
    ]);
  });

  it("requêtes servies par le cache : part des requêtes mesurées de la fenêtre, sans bouton de purge", async () => {
    expect(await donnees("kpi_kv_prefix_reuse")).toEqual({
      value: "66.7 %",
      unit: "des requêtes",
      color: "emerald",
      icon: "ph-recycle",
      detail: "4 sur 6 requêtes mesurées · 24 h",
    });
    expect(widget("kpi_kv_prefix_reuse")).toMatchObject({
      title: "Requêtes servies par le cache",
      purgeSpec: null,
      eventTypes: [],
    });
  });

  it("aucune requête mesurée dans la fenêtre (lignes d'avant le comptage) : pas de pourcentage", async () => {
    vi.setSystemTime((MAINTENANT + 30 * 86400) * 1000);
    try {
      expect(await donnees("kpi_kv_prefix_reuse")).toEqual({
        value: "—",
        unit: "aucune requête mesurée",
        color: "slate",
        icon: "ph-recycle",
        detail: "sur 24 h",
      });
    } finally {
      vi.setSystemTime(MAINTENANT * 1000);
    }
  });
});
