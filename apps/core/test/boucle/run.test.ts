// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/run.test.ts — état d'un run : historique d'outils borné, raisonnement cumulé, lot interrompu (vecteurs Python), instantané sur annulation. */
import "../moteur-environnement";

import { describe, expect, it } from "vitest";

import { surchargerConfig } from "@elpis/config";

import {
  capRunToolHistory,
  clipThinkingHistory,
  RunContext,
  RunRecord,
  SENTINELLE,
} from "../../src/boucle/run";
import type { ChampsRun } from "../../src/boucle/run";
import type { Dict } from "../../src/python";
import { lireVecteurs } from "../vecteurs-moteur";
import { deplier } from "./aides";

/** Écart voulu au Python (sentinelle sans attribution, en anglais pour le modèle) : la sentinelle des vecteurs ramenée au TS. */
function sentinelleTs<T>(v: T): T {
  const py =
    "interrompu par l'utilisateur avant la fin — exécution NON confirmée (l'outil a pu agir en partie) : vérifier l'état avant de le relancer";
  return JSON.parse(
    JSON.stringify(v).replaceAll(py, (JSON.parse(SENTINELLE) as { error: string }).error),
  ) as T;
}

const V = deplier(sentinelleTs(lireVecteurs<unknown>("boucle-run"))) as {
  bornes: { hist: Dict[]; max: number; sortie: Dict[] }[];
  pensees: { max: number; parts: string[]; sortie: string[] }[];
  lots: {
    depart: Dict[];
    prepared: Dict[];
    etapes: { partiel: Record<string, string>; historique: Dict[]; delta: Dict[]; dernier_texte: string }[];
  }[];
};

describe("état d'un run", () => {
  it("historique d'outils borné : vieux résultats puis vieux arguments élagués", () => {
    for (const b of V.bornes)
      expect(capRunToolHistory(structuredClone(b.hist), b.max)).toStrictEqual(b.sortie);
  });

  it("raisonnement cumulé borné en place (suffixe, marqueur)", () => {
    for (const p of V.pensees) {
      const r = surchargerConfig({ THINKING_HISTORY_MAX_CHARS: p.max });
      try {
        const parts = [...p.parts];
        clipThinkingHistory(parts);
        expect(parts).toStrictEqual(p.sortie);
      } finally {
        r();
      }
    }
  });

  it("lot interrompu matérialisé (sentinelle puis vrai résultat), delta et dernier texte", () => {
    for (const l of V.lots) {
      const rec = new RunRecord();
      rec.runToolHistory = structuredClone(l.depart);
      const partiel = rec.ouvrirLot(l.prepared);
      for (const e of l.etapes) {
        for (const [k, v] of Object.entries(e.partiel)) partiel.set(Number(k), v);
        rec.materializeInterruptedBatch();
        expect(rec.runToolHistory).toStrictEqual(e.historique);
        expect(rec.deltaSnapshot()).toStrictEqual(e.delta);
        expect(rec.lastAssistantText()).toBe(e.dernier_texte);
      }
    }
  });

  it("annulation hors des blocs d'outils : instantané émis une fois, erreur propagée", async () => {
    const vus: Dict[] = [];
    const rec = new RunRecord();
    rec.runToolHistory = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "f" } }] },
    ];
    rec.ouvrirLot([{ call_id: "c1" }]);
    const raison = new DOMException("stop", "AbortError");
    await expect(
      rec.guardCancel((e) => {
        vus.push(e);
      }, Promise.reject(raison)),
    ).rejects.toBe(raison);
    expect(vus).toHaveLength(1);
    expect(vus[0]!["type"]).toBe("tool_history_partial");
    expect((vus[0]!["tool_history"] as Dict[])[1]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    await expect(rec.guardCancel(() => undefined, Promise.reject(new Error("panne")))).rejects.toThrow(
      "panne",
    );
  });

  it("annulation après un élagage en cours de run : les clés déjà indexées partent avec l'instantané (prune_state)", async () => {
    const vus: Dict[] = [];
    const rec = new RunRecord();
    rec.pruneKeysNew.push("c1|9|abc|abc");
    await rec.emitPartialSnapshot((e) => {
      vus.push(e);
    });
    expect(vus).toEqual([{ type: "prune_state", keys: ["c1|9|abc|abc"] }]);
  });

  it("contexte : annulation par drapeau ou par signal ; appel moteur dans le slot", async () => {
    const ctrl = new AbortController();
    let drapeau = false;
    const appels: string[] = [];
    const ctx = new RunContext({
      isCancelled: () => drapeau,
      signal: ctrl.signal,
      slot: { appelLLM: async <T>(f: () => Promise<T>) => (appels.push("slot"), f()) },
    } as unknown as ChampsRun);
    expect(ctx.cancelled()).toBe(false);
    drapeau = true;
    expect(ctx.cancelled()).toBe(true);
    drapeau = false;
    ctrl.abort();
    expect(ctx.cancelled()).toBe(true);
    expect(await ctx.appelLLM(async () => 7)).toBe(7);
    expect(appels).toEqual(["slot"]);
  });
});
