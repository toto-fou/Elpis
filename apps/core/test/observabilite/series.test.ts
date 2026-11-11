// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/series.test.ts — fuseaux (zoneinfo, heure locale de la libc) et calendrier des séries rejoués contre le Python (vecteurs). */
import { readFileSync } from "node:fs";

import { FlottantPy, pyJsonDumps } from "@elpis/commun";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { heureLocale, zoneNommee } from "../../src/observabilite/fuseau";
import {
  aggregateSeries,
  divisionEntierePy,
  granularityFor,
  planBuckets,
  resolveTz,
  toChart,
} from "../../src/observabilite/series";
import type { Agregat, Fuseau, PlanSeaux } from "../../src/observabilite/series";

type FuseauVecteur = string | [number, string];

const { entrees, sorties } = JSON.parse(
  readFileSync(new URL("../vecteurs/observabilite-series.json", import.meta.url), "utf8"),
) as {
  entrees: {
    zones: string[];
    tz_libc: string[];
    ts_libc: number[];
    plans: [FuseauVecteur, number, number, "hour" | "day"][];
    divisions: [number, number][];
    graphiques: [number, [string | number, [string | number, number][]][], Record<string, unknown>][];
    granularites: (number | string)[];
  };
  sorties: {
    instants: Record<string, [number, number, string, 0 | 1][]>;
    murales: Record<string, [number, number, number][]>;
    libc: [number, string][][];
    plans: string[];
    divisions: string[];
    graphiques: string[];
    granularites: string[];
  };
};

function fuseau(f: FuseauVecteur): Fuseau {
  if (typeof f === "string") return { zone: zoneNommee(f), decalageFixe: 0, nom: f, serveur: false };
  return { zone: null, decalageFixe: f[0], nom: f[1], serveur: true };
}

function plan(i: number): PlanSeaux {
  const [f, since, until, gran] = entrees.plans[i] as [FuseauVecteur, number, number, "hour" | "day"];
  return planBuckets(since, until, gran, fuseau(f));
}

describe.each(entrees.zones)("zone %s", (nom) => {
  const zone = zoneNommee(nom);

  it("fromutc : décalage, abréviation et repli de chaque instant", () => {
    const obtenus = (sorties.instants[nom] ?? []).map(([ts]) => {
      const i = zone.versLocal(ts);
      return [ts, i.decalage, i.abbr, i.fold];
    });
    expect(obtenus).toEqual(sorties.instants[nom]);
  });

  it("utcoffset d'une heure murale (trous et replis, fold 0 et 1)", () => {
    const obtenus = (sorties.murales[nom] ?? []).map(([w]) => [
      w,
      zone.decalageMural(w, 0),
      zone.decalageMural(w, 1),
    ]);
    expect(obtenus).toEqual(sorties.murales[nom]);
  });
});

describe("heure locale de la libc", () => {
  it.each(entrees.tz_libc.map((tz, i) => [tz, i] as const))("TZ=%j", (tz, i) => {
    const obtenus = entrees.ts_libc.map((ts) => {
      const h = heureLocale(ts, { TZ: tz });
      return [h.decalage, h.abbr];
    });
    expect(obtenus).toEqual(sorties.libc[i]);
  });

  it("clé de zone invalide ou inconnue : refusée", () => {
    for (const cle of ["Mars/Olympus", "../etc/passwd", "/etc/localtime", "", "Europe/../Europe/Paris"])
      expect(() => zoneNommee(cle)).toThrow();
  });

  it("resolve_tz : zone nommée (blancs retirés), sinon le fuseau du serveur", () => {
    expect(resolveTz(" Europe/Paris ")).toMatchObject({ nom: "Europe/Paris", serveur: false });
    const repli = resolveTz("Mars/Olympus");
    expect(repli.serveur).toBe(true);
    expect(repli.zone).toBeNull();
    expect(resolveTz("").serveur).toBe(true);
  });
});

describe("plan_buckets", () => {
  it.each(entrees.plans.map((p, i) => [JSON.stringify(p), i] as const))("%s", (_nom, i) => {
    const p = plan(i);
    const rendu = pyJsonDumps({
      granularity: p.granularity,
      edges: p.edges.map((e) => new FlottantPy(e)),
      keys: p.keys,
      labels: p.labels,
      tz_name: p.tzName,
      is_server_tz: p.isServerTz,
      origin: new FlottantPy(p.origin),
    });
    expect(rendu).toBe(sorties.plans[i]);
  });
});

describe("agrégat journalier et changement d'heure", () => {
  afterEach(() => vi.useRealTimers());

  it("l'événement de 23:30 locale du dernier jour d'heure d'été reste dans son jour (décalage de chaque jour)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
    const t = ouvrirBaseDeTest("sqlite");
    try {
      await t.base.exec("CREATE TABLE ev (ts REAL, v REAL)");
      // 25/10 23:30 CET (22:30Z) et 24/10 23:30 CEST (21:30Z)
      await t.base.run("INSERT INTO ev VALUES (?, 1), (?, 1)", [
        Date.parse("2026-10-25T22:30:00Z") / 1000,
        Date.parse("2026-10-24T21:30:00Z") / 1000,
      ]);
      const p = planBuckets(
        Date.parse("2026-10-20T00:00:00Z") / 1000,
        Date.parse("2026-10-27T00:00:00Z") / 1000,
        "day",
        resolveTz("Europe/Paris"),
      );
      const ag = await aggregateSeries(t.base, { table: "ev", tsCol: "ts", valueExpr: "SUM(v)", plan: p });
      expect([...(ag.get("") ?? new Map()).keys()].sort()).toEqual(["2026-10-24", "2026-10-25"]);
    } finally {
      await t.fermer();
    }
  });
});

describe("calculs", () => {
  it("division entière des flottants de Python", () => {
    const obtenus = entrees.divisions.map(([a, b]) => divisionEntierePy(a, b));
    obtenus.forEach((v, i) => expect(Object.is(v, JSON.parse(sorties.divisions[i] as string))).toBe(true));
  });

  it("granularity_for", () => {
    expect(entrees.granularites.map((h) => granularityFor(h as number))).toEqual(sorties.granularites);
  });

  it.each(entrees.graphiques.map((g, i) => [i, g] as const))("to_chart n°%i", (i, [indice, series, opts]) => {
    const data: Agregat = new Map(series.map(([cle, points]) => [cle, new Map(points)]));
    const rendu = toChart(plan(indice), data, {
      kind: opts["kind"] as "line" | "bar" | undefined,
      labelsMap: opts["labels_map"] as Record<string, string> | undefined,
      stacked: opts["stacked"] as boolean | undefined,
      roundTo: opts["round_to"] as number | undefined,
    });
    expect(pyJsonDumps(rendu, { ensureAscii: false })).toBe(sorties.graphiques[i]);
  });
});
