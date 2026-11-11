// SPDX-License-Identifier: MIT
/** apps/core/test/routines/planificateur-boucle.test.ts — boucle du planificateur rejouée contre la trace de `_routines_loop` (horloge simulée, Europe/Paris, heure d'été et d'hiver) et fonctions pures du planificateur. */
import { readFileSync } from "node:fs";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type * as Magasin from "../../src/routines/magasin";

const etat = vi.hoisted(() => ({
  trace: null as unknown[][] | null,
  pas: [] as Record<string, unknown>[],
  indice: 0,
}));

const courant = (): Record<string, unknown> => etat.pas[etat.indice - 1] ?? {};

vi.mock("../../src/routines/magasin", async (orig) => {
  const reel = await orig<typeof Magasin>();
  return {
    ...reel,
    reconcileOrphans: async (...a: Parameters<typeof reel.reconcileOrphans>) => {
      if (etat.trace === null) return reel.reconcileOrphans(...a);
      etat.trace.push(["reconcilier", a[1]]);
      const v = (etat.pas[etat.indice - 1] ?? {})["reconcilier"] ?? 0;
      if (v === "erreur") throw new Error("base verrouillée");
      return v as number;
    },
    listEnabledRoutines: async (...a: Parameters<typeof reel.listEnabledRoutines>) => {
      if (etat.trace === null) return reel.listEnabledRoutines(...a);
      etat.trace.push(["lister"]);
      if ((etat.pas[etat.indice - 1] ?? {})["lister"] === "erreur") throw new Error("lecture impossible");
      return [];
    },
  };
});

const { installerMetriquesBoucle } = await import("../../src/boucle/ports");
const { installerCrochetJournal } = await import("../../src/journal");
const P = await import("../../src/routines/planificateur");

type Scenario = { nom: string; debut: number; pas: Record<string, unknown>[] };

const V = JSON.parse(
  readFileSync(new URL("../vecteurs/routines-planificateur.json", import.meta.url), "utf-8"),
) as {
  constantes: Record<string, number>;
  fichiers_ecrits: { entree: unknown; sortie: string[] }[];
  notifier: { entree: [Record<string, unknown>, boolean]; sortie: boolean }[];
  cles_run: [unknown, unknown, string][];
  fuseau: string;
  scenarios: Scenario[];
  traces: { nom: string; trace: unknown[][] }[];
};

const tzAvant = process.env["TZ"];

beforeAll(() => {
  process.env["TZ"] = V.fuseau;
});

afterAll(() => {
  if (tzAvant === undefined) delete process.env["TZ"];
  else process.env["TZ"] = tzAvant;
});

afterEach(() => {
  etat.trace = null;
  installerMetriquesBoucle(null);
  installerCrochetJournal(null);
  vi.useRealTimers();
});

describe("fonctions pures du planificateur (vecteurs Python)", () => {
  it("constantes et réglages par défaut", () => {
    expect([
      P.TICK_SECONDS,
      P.HEARTBEAT_SECONDS,
      P.RECONCILE_EVERY_TICKS,
      P.ORPHAN_STALE_AFTER_S,
      P.REGLAGES.perUserCap,
      P.REGLAGES.runMaxAttempts,
      P.REGLAGES.runRetryBackoffS,
      P.REGLAGES.chainMaxDepth,
    ]).toEqual([
      V.constantes["tick_s"],
      V.constantes["battement_s"],
      V.constantes["reconcilier_tous"],
      V.constantes["orphelin_s"],
      V.constantes["par_compte"],
      V.constantes["essais"],
      V.constantes["attente_reprise_s"],
      V.constantes["profondeur_chaine"],
    ]);
  });

  it("fichiers produits, politique de notification, clé synthétique", () => {
    expect(V.fichiers_ecrits.map((c) => P.filesWritten(c.entree))).toEqual(
      V.fichiers_ecrits.map((c) => c.sortie),
    );
    expect(V.notifier.map((c) => P.notifyWanted(c.entree[0], c.entree[1]))).toEqual(
      V.notifier.map((c) => c.sortie),
    );
    expect(V.cles_run.map(([r, n]) => P.runChatKey(r, n))).toEqual(V.cles_run.map((c) => c[2]));
  });

  it("minutes non évaluées : arithmétique murale naïve, clé illisible refusée", () => {
    expect(P.minutesNonEvaluees(new Date(2026, 5, 12, 10, 3, 0, 50), "2026-06-12T09:59")).toBe(3);
    expect(P.minutesNonEvaluees(new Date(2026, 5, 12, 10, 0, 0, 50), "2026-06-12T09:59")).toBe(0);
    expect(P.minutesNonEvaluees(new Date(2026, 5, 12, 9, 58, 0, 50), "2026-06-12T09:59")).toBe(-2);
    expect(() => P.minutesNonEvaluees(new Date(), "2026-06-12 09:59")).toThrow(/does not match format/u);
    expect(P.cleMinute(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02T03:04");
    expect([P.delaiProchainTick(1_781_251_139.99), P.delaiProchainTick(1_781_251_110.25)]).toEqual([
      1.05, 29.8,
    ]);
  });
});

describe("boucle du planificateur : trace identique à _routines_loop", () => {
  it.each(V.scenarios.map((s, i) => [s.nom, s, V.traces[i]?.trace ?? []] as const))(
    "%s",
    async (_nom, scenario, attendue) => {
      const trace: unknown[][] = [];
      etat.trace = trace;
      etat.pas = scenario.pas;
      etat.indice = 0;
      vi.useFakeTimers({ toFake: ["Date"] });
      let t = scenario.debut;
      vi.setSystemTime(t);
      const controleur = new AbortController();
      installerMetriquesBoucle((type, valeur, tags) => void trace.push(["metrique", type, valeur, tags]));
      installerCrochetJournal((niveau, message) => {
        if (message.startsWith("[routines] [ROUTINES]")) trace.push(["journal", niveau, message.slice(11)]);
      });
      const planif = new P.Planificateur({
        base: {} as never,
        meneur: {
          tenu: true,
          essayer: async () => {
            const v = courant()["meneur"] ?? true;
            trace.push(["meneur", v]);
            return v as boolean;
          },
          rendre: async () => undefined,
        },
        horloge: {
          dormir: async (ms: number) => {
            if (etat.indice >= etat.pas.length) {
              controleur.abort();
              throw new Error("fin du scénario");
            }
            trace.push(["dormir", ms]);
            t += Math.ceil(ms) + Number(etat.pas[etat.indice]?.["travail"] ?? 0);
            vi.setSystemTime(t);
            etat.indice += 1;
          },
        },
      });
      vi.spyOn(planif, "evaluer").mockImplementation(async (_routines, maintenant, cle) => {
        trace.push([
          "evaluer",
          cle,
          [
            maintenant.getFullYear(),
            maintenant.getMonth() + 1,
            maintenant.getDate(),
            maintenant.getHours(),
            maintenant.getMinutes(),
            maintenant.getSeconds(),
            maintenant.getMilliseconds(),
          ],
        ]);
        if (courant()["evaluer"] === "erreur") throw new Error("évaluation cassée");
      });
      await planif.boucle(controleur.signal);
      expect(trace).toEqual(attendue);
    },
  );
});
