// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/registre-cache.test.ts — résultats des widgets gardés selon la période, calcul partagé, erreurs jamais gardées, purge, mise en page seule. */
import type { DependancesAuth } from "@elpis/auth";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerFamilleMetriques } from "../../src/familles/metriques";
import { fournisseur } from "../../src/observabilite/fournisseurs/base";
import type { ContexteMetriques, DefinitionFournisseur } from "../../src/observabilite/fournisseurs/base";
import { MetricsRegistry } from "../../src/observabilite/registre";
import { appTest } from "../aides";

const audit = vi.hoisted(() => vi.fn());
vi.mock("@elpis/securite", async (orig) => ({ ...(await orig<object>()), auditEvent: audit }));

function contexte(garder: boolean): ContexteMetriques {
  return {
    base: {} as ContexteMetriques["base"],
    systeme: {} as ContexteMetriques["systeme"],
    historique: () => [],
    santeLlm: async () => ({}),
    ...(garder ? { garderResultats: true } : {}),
  };
}

/** Registre d'un widget qui compte ses calculs ; `donnees` fixe ce que rend chaque calcul. */
function registreCompteur(
  extra: Partial<DefinitionFournisseur> = {},
  donnees: () => Promise<Dict> = async () => ({ value: 1 }),
): { registre: MetricsRegistry; appels: () => number } {
  let n = 0;
  const registre = new MetricsRegistry();
  registre.register(
    fournisseur({
      id: "w",
      title: "W",
      type: "value",
      ...extra,
      getData: async () => {
        n += 1;
        return donnees();
      },
    }),
  );
  return { registre, appels: () => n };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(1_800_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("résultats gardés du registre", () => {
  it("24 h : gardé 20 s ; 30 j : gardé 60 s ; les périodes ne se mélangent pas", async () => {
    const { registre, appels } = registreCompteur();
    const ctx = contexte(true);
    await registre.getWidgetsData(ctx, ["w"], 24);
    await registre.getWidgetsData(ctx, ["w"], 24);
    expect(appels()).toBe(1);
    vi.advanceTimersByTime(20_001);
    await registre.getWidgetsData(ctx, ["w"], 24);
    expect(appels()).toBe(2);
    await registre.getWidgetsData(ctx, ["w"], 720);
    vi.advanceTimersByTime(59_000);
    await registre.getWidgetsData(ctx, ["w"], 720);
    expect(appels()).toBe(3);
    vi.advanceTimersByTime(2_000);
    await registre.getDashboardConfig(ctx, 720);
    expect(appels()).toBe(4);
  });

  it("deux demandes simultanées partagent un seul calcul", async () => {
    let liberer: () => void = () => undefined;
    const attente = new Promise<void>((r) => (liberer = r));
    const { registre, appels } = registreCompteur({}, async () => {
      await attente;
      return { value: 7 };
    });
    const ctx = contexte(true);
    const a = registre.getWidgetsData(ctx, ["w"], 24);
    const b = registre.getDashboardConfig(ctx, 24);
    liberer();
    expect((await a)["w"]).toEqual({ value: 7 });
    expect(((await b)["data"] as Dict)["w"]).toEqual({ value: 7 });
    expect(appels()).toBe(1);
  });

  it("une erreur n'est jamais gardée", async () => {
    let echec = true;
    const { registre, appels } = registreCompteur({}, async () => {
      if (echec) throw new Error("base occupée");
      return { value: 3 };
    });
    const ctx = contexte(true);
    expect((await registre.getWidgetsData(ctx, ["w"], 24))["w"]).toEqual({ error: "base occupée" });
    echec = false;
    expect((await registre.getWidgetsData(ctx, ["w"], 24))["w"]).toEqual({ value: 3 });
    expect(appels()).toBe(2);
  });

  it("invalider() force un nouveau calcul, même pendant un calcul en cours", async () => {
    let liberer: () => void = () => undefined;
    let attente: Promise<void> = Promise.resolve();
    const { registre, appels } = registreCompteur({}, async () => {
      await attente;
      return { value: 1 };
    });
    const ctx = contexte(true);
    await registre.getWidgetsData(ctx, ["w"], 24);
    registre.invalider();
    await registre.getWidgetsData(ctx, ["w"], 24);
    expect(appels()).toBe(2);
    registre.invalider();
    attente = new Promise<void>((r) => (liberer = r));
    const enCours = registre.getWidgetsData(ctx, ["w"], 24);
    registre.invalider();
    liberer();
    await enCours;
    await registre.getWidgetsData(ctx, ["w"], 24);
    expect(appels()).toBe(4);
  });

  it("la durée propre au widget l'emporte (live : 1 s)", async () => {
    const { registre, appels } = registreCompteur({ ttlMs: 1_000 });
    const ctx = contexte(true);
    await registre.getWidgetsData(ctx, ["w"], 720);
    vi.advanceTimersByTime(1_001);
    await registre.getWidgetsData(ctx, ["w"], 720);
    expect(appels()).toBe(2);
  });

  it("sans garderResultats (tests, rapports à la demande) : chaque demande recalcule", async () => {
    const { registre, appels } = registreCompteur();
    const ctx = contexte(false);
    await registre.getWidgetsData(ctx, ["w"], 24);
    await registre.getWidgetsData(ctx, ["w"], 24);
    expect(appels()).toBe(2);
  });

  it("widget sans période : un seul calcul pour les trois périodes, gardé 5 s", async () => {
    const { registre, appels } = registreCompteur({ ttlMs: 5_000, sansPeriode: true });
    const ctx = contexte(true);
    for (const h of [24, 168, 720]) await registre.getWidgetsData(ctx, ["w"], h);
    expect(appels()).toBe(1);
    vi.advanceTimersByTime(5_001);
    await registre.getWidgetsData(ctx, ["w"], 720);
    expect(appels()).toBe(2);
  });

  it("une horloge murale qui recule ne prolonge pas un résultat gardé", async () => {
    const { registre, appels } = registreCompteur();
    const ctx = contexte(true);
    await registre.getWidgetsData(ctx, ["w"], 24);
    vi.advanceTimersByTime(20_001);
    vi.setSystemTime(Date.now() - 3_600_000);
    await registre.getWidgetsData(ctx, ["w"], 24);
    expect(appels()).toBe(2);
  });

  it("getLayout ne calcule aucun widget", () => {
    const { registre, appels } = registreCompteur({ category: "system" });
    expect(registre.getLayout()).toEqual([
      { id: "w", title: "W", type: "value", width: "1/2", category: "system", default: false, purge: null },
    ]);
    expect(appels()).toBe(0);
  });
});

describe("route /api/admin/stats-dynamic", () => {
  it("layout=1 rend la seule mise en page ; un calcul porte l'en-tête Server-Timing", async () => {
    const { registre, appels } = registreCompteur();
    const famille = creerFamilleMetriques({
      base: {} as Base,
      auth: {} as DependancesAuth,
      contexte: contexte(true),
      registre,
    });
    const app = await appTest({
      mode: "admin",
      familles: [famille],
      gardes: { staff: async () => undefined, admin: async () => undefined },
    });
    try {
      const mise = await app.inject({ method: "GET", url: "/api/admin/stats-dynamic?layout=1" });
      expect(mise.statusCode).toBe(200);
      expect(Object.keys(mise.json() as Dict)).toEqual(["layout"]);
      expect(appels()).toBe(0);
      const partiel = await app.inject({
        method: "GET",
        url: "/api/admin/stats-dynamic?ids=w&scope_hours=168",
      });
      expect(partiel.json()).toEqual({ data: { w: { value: 1 } }, partial: true });
      expect(String(partiel.headers["server-timing"])).toMatch(/^calc;dur=\d+(\.\d)?$/);
    } finally {
      await app.close();
    }
  });
});

describe("route /api/admin/metrics/purge", () => {
  it("nom du compte absent de la session : cache invalidé, audit écrit sans nom, réponse 200", async () => {
    const { registre, appels } = registreCompteur();
    const ctx = contexte(true);
    await registre.getWidgetsData(ctx, ["w"], 24);
    const t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    const casse = new Proxy(t.base, {
      get: (cible, cle) =>
        cle === "get"
          ? () => Promise.reject(new Error("pool saturé"))
          : (cible as unknown as Record<string | symbol, unknown>)[cle],
    });
    audit.mockClear();
    const famille = creerFamilleMetriques({
      base: casse,
      auth: {} as DependancesAuth,
      contexte: ctx,
      registre,
    });
    const app = await appTest({
      mode: "admin",
      familles: [famille],
      gardes: {
        staff: async () => undefined,
        admin: (req: { utilisateur?: unknown }) => {
          req.utilisateur = { id: 1, username: null };
        },
      },
    });
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/admin/metrics/purge",
        payload: { targets: ["metric_events"], dry_run: false },
      });
      expect(r.statusCode).toBe(200);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "admin.metrics.purge", username: null }),
      );
      await registre.getWidgetsData(ctx, ["w"], 24);
      expect(appels()).toBe(2);
    } finally {
      await app.close();
      await t.fermer();
    }
  });
});
