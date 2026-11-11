// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/graphiques.test.ts — graphiques : jetons résolus et indications « _… » retirées, formateurs posés côté client, tableau échappé et triable, KPI échappés, hôtes libérés hors du document. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disposeAll,
  fmt,
  prepare,
  render,
  renderTable,
  sweep,
  TOKENS,
} from "../../../src/features/chat/rendu/graphiques";

afterEach(() => {
  disposeAll();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("graphiques", () => {
  it("prepare : jetons de la surface claire, clés « _ » retirées, unité dans les formateurs, aria", () => {
    const o = prepare(
      {
        _elpis: { unit: "%" },
        color: "@up",
        yAxis: { _fmt: true },
        series: [{ type: "bar", _lbl: { v: null }, label: { show: true } }],
        tooltip: {},
      },
      {},
    ) as Record<string, unknown> & {
      yAxis: { axisLabel: { formatter(v: number): string } };
      series: { label: { formatter(p: { value: unknown }): string } }[];
      tooltip: { valueFormatter(v: unknown): string; confine: boolean };
    };
    expect(o.color).toBe(TOKENS.light.up);
    expect(Object.keys(o).some((k) => k.startsWith("_"))).toBe(false);
    expect(o.yAxis.axisLabel.formatter(12500)).toMatch(/^12,5\sk %$/);
    expect(o.series[0]?.label.formatter({ value: [1, 42] })).toBe("42 %");
    expect(o.tooltip.valueFormatter(3)).toBe("3 %");
    expect(o.tooltip.confine).toBe(true);
    expect(o.aria).toEqual({ enabled: true, decal: { show: false } });
    expect(fmt(null)).toBe("—");
  });

  it("tableau : contenu échappé, colonnes numériques alignées, tri au clic", () => {
    const hote = document.createElement("div");
    renderTable(
      hote,
      {
        columns: ["<b>nom</b>", "n"],
        rows: [
          ["<img src=x onerror=1>", 2],
          ["b", 10],
        ],
      },
      "Titre <i>",
    );
    expect(hote.querySelector("img, b, i")).toBeNull();
    expect(hote.textContent).toContain("<img src=x onerror=1>");
    expect(hote.querySelectorAll("td")[1]?.className).toContain("text-right");
    hote.querySelectorAll<HTMLElement>("th")[1]?.click();
    hote.querySelectorAll<HTMLElement>("th")[1]?.click();
    expect([...hote.querySelectorAll("tbody tr")].map((r) => r.firstElementChild?.textContent)).toEqual([
      "b",
      "<img src=x onerror=1>",
    ]);
  });

  it("KPI échappés ; un hôte ECharts quitté est libéré (instance et observateur)", () => {
    const k = document.createElement("div");
    render(k, {
      _elpis: { render: "kpi", kpi: [{ label: "<script>x</script>", value: 3, delta: "+1", sign: "up" }] },
    });
    expect(k.querySelector("script")).toBeNull();
    const dispose = vi.fn();
    vi.stubGlobal("echarts", {
      registerTheme: vi.fn(),
      init: () => ({ setOption: vi.fn(), resize: vi.fn(), dispose, getDataURL: () => "" }),
    });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    render(hote, { _elpis: { kind: "bar" }, series: [] });
    expect(hote.style.height).toBe("320px");
    hote.remove();
    sweep();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
