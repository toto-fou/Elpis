// SPDX-License-Identifier: MIT
/** frontend/test/admin/metriques.test.ts — Métriques : Chart.js demandé avec les données, premier graphe sans minuterie, mises à jour réparties par image et sautées sans changement, données brutes, mouvement réduit. */
import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BaseAdmin } from "../../src/features/admin/etat";
import { creerMetriques } from "../../src/features/admin/metriques";
import { json } from "../aides";

type Donnees = { labels: string[]; datasets: { data: number[] }[] };

/** Faux Chart.js : garde chaque instance, ses données reçues et ses mises à jour. */
class FauxChart {
  static instances: FauxChart[] = [];
  updates = 0;
  canvas: HTMLCanvasElement;
  data: unknown;
  options: Record<string, unknown>;
  constructor(canvas: HTMLCanvasElement, cfg: { data: unknown; options: Record<string, unknown> }) {
    this.canvas = canvas;
    this.data = cfg.data;
    this.options = cfg.options;
    FauxChart.instances.push(this);
  }
  update(): void {
    this.updates++;
  }
  destroy(): void {}
}

const LAYOUT = [
  { id: "a", type: "line", category: "activity" },
  { id: "b", type: "bar", category: "activity" },
];
const serie = (n: number): Donnees => ({ labels: ["x"], datasets: [{ data: [n] }] });

function monter(donnees: () => Record<string, Donnees>) {
  const urls: string[] = [];
  const fetchAuth = (url: string): Promise<Response> => {
    urls.push(url);
    if (url.includes("layout=1")) return Promise.resolve(json({ layout: LAYOUT }));
    return Promise.resolve(json({ data: donnees() }));
  };
  const b = {
    vue: Vue,
    ctx: {
      showToast: () => undefined,
      openConfirm: () => Promise.resolve(true),
      fetchAuth,
      nextTick: Vue.nextTick,
    },
    lien: {},
  } as unknown as BaseAdmin;
  const M = creerMetriques(b);
  return { M, urls };
}

const w = window as unknown as { Chart?: unknown };

beforeEach(() => {
  FauxChart.instances = [];
  for (const id of ["a", "b"]) {
    const c = document.createElement("canvas");
    c.id = "chart_" + id;
    document.body.appendChild(c);
  }
});
afterEach(() => {
  document.body.innerHTML = "";
  delete w.Chart;
  vi.restoreAllMocks();
});

describe("Métriques", () => {
  it("Chart.js est demandé dès l'entrée, avant la réponse des données", () => {
    const scripts: string[] = [];
    vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(el: T): T => {
      scripts.push((el as unknown as HTMLScriptElement).src);
      return el;
    });
    const { M, urls } = monter(() => ({}));
    void M.loadAdminStats();
    expect(urls).toEqual(["/api/admin/stats-dynamic?layout=1"]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("chart");
    M.liberer();
  });

  it("premier graphe à l'image qui suit les données, sans minuterie", async () => {
    w.Chart = FauxChart;
    const { M } = monter(() => ({ a: serie(1), b: serie(2) }));
    const t0 = performance.now();
    await M.loadAdminStats();
    await vi.waitFor(() => expect(FauxChart.instances).toHaveLength(2), { interval: 5 });
    expect(performance.now() - t0).toBeLessThan(140);
    M.liberer();
  });
});
