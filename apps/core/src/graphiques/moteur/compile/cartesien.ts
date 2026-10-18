// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/compile/cartesien.ts — barres, courbes, aires et flux temporel (port de _chart/compile_echarts.py, c_bar_line et c_stream). */
import { arrondiPy, fixePy, longueurPy } from "@elpis/commun";

import { monthKey, toDate } from "../normalise";
import { el, fl, sommeTermes } from "../py";
import { dims } from "../spec";
import type { Spec } from "../spec";
import {
  base,
  cartesian,
  highlightConnu,
  fr,
  grid,
  legend,
  markLines,
  ou0,
  regression,
  val,
  valN,
  valueLabel,
  zoom,
} from "./commun";
import type { Nb, Opt } from "./commun";

/** `x or 0` sur une valeur de série : l'entier 0 pour l'absence ou un zéro, sinon la valeur. */
export function ou0Nb(x: Nb | null): Nb {
  return x === null || val(x) === 0 ? 0 : x;
}

export function cBarLine(spec: Spec): [Opt, string] {
  const kind = spec.kind;
  const [cats, series, xname, ynames] = cartesian(spec);
  const o = base(spec);
  let unit = spec.opts.unit;
  const stack = spec.opts.stack;
  if (stack === "percent") {
    for (let i = 0; i < cats.length; i++) {
      const tot = sommeTermes(series.map((s) => ou0(Math.abs(valN(el(s.data, i)) ?? 0)))).v;
      for (const s of series) {
        const v = el(s.data, i);
        s.data[i] = v === null || !tot ? null : fl(arrondiPy((100 * val(v)) / tot, 2));
      }
    }
    unit = "%";
    o["_elpis"].unit = "%";
  }
  let horizontal = spec.opts.horizontal && kind === "bar";
  if (
    kind === "bar" &&
    !horizontal &&
    cats.length > 8 &&
    cats.reduce((acc, c) => acc + longueurPy(c), 0) / Math.max(1, cats.length) > 14
  ) {
    horizontal = true;
    spec.notes.fix("long labels: horizontal bars");
  }
  const catAxis: Opt = {
    type: "category",
    data: cats,
    axisTick: { show: false },
    boundaryGap: kind === "bar",
  };
  if (xname) catAxis["name"] = !horizontal ? xname : "";
  const valAxis: Opt = { type: "value", _fmt: true };
  if (stack === "percent") valAxis["max"] = 100;
  if (ynames.length === 1 && spec.group === null) valAxis["name"] = ynames[0];
  const hl = highlightConnu(spec, cats);
  const out: Opt[] = [];
  series.forEach((s, si) => {
    const ser: Opt = {
      type: kind === "bar" ? "bar" : "line",
      name: s.name,
      data: s.data,
      emphasis: { focus: "series" },
    };
    if (kind === "bar") {
      ser["barMaxWidth"] = 44;
      const last = si === series.length - 1 || stack === "none";
      const r = last ? 4 : 0;
      ser["itemStyle"] = { borderRadius: horizontal ? [0, r, r, 0] : [r, r, 0, 0] };
      if (stack !== "none") {
        ser["stack"] = "total";
        Object.assign(ser["itemStyle"], { borderColor: "@surface", borderWidth: 1 });
      }
      if (hl.size > 0)
        ser["data"] = cats.map((c, i) => {
          const v = el(s.data, i);
          return hl.has(c) ? v : { value: v, itemStyle: { color: "@muted" } };
        });
    } else {
      Object.assign(ser, {
        showSymbol: cats.length <= 24,
        symbolSize: 7,
        lineStyle: { width: 2 },
        smooth: spec.opts.smooth,
        connectNulls: false,
      });
      if (spec.opts.step) ser["step"] = "middle";
      if (kind === "area" || stack !== "none") {
        ser["areaStyle"] = { opacity: stack !== "none" ? 0.85 : 0.16 };
        if (stack !== "none") {
          ser["stack"] = "total";
          ser["lineStyle"] = { width: 1 };
          ser["showSymbol"] = false;
        }
      }
    }
    if (spec.opts.showValues) {
      const pos = horizontal ? "right" : stack !== "none" ? "inside" : "top";
      ser["label"] = valueLabel(pos);
      ser["_lbl"] = { v: null };
      ser["labelLayout"] = { hideOverlap: true };
    }
    out.push(ser);
  });
  const ml = markLines(spec, horizontal ? "xAxis" : "yAxis");
  if (ml !== null) el(out, 0)["markLine"] = ml;
  if (spec.opts.trend && ["line", "area", "bar"].includes(kind)) {
    for (const s of series.slice(0, 3)) {
      const reg = regression(
        cats.map((_, i) => i),
        s.data.map(valN),
      );
      if (reg !== null) {
        const [a, b, r2] = reg;
        out.push({
          type: "line",
          name: `Tendance ${s.name}`,
          symbol: "none",
          data: cats.map((_, i) => fl(arrondiPy(a * i + b, 4))),
          lineStyle: { type: "dashed", width: 1.5, color: "@ink2" },
          itemStyle: { color: "@ink2" },
          tooltip: { show: false },
          silent: true,
        });
        spec.notes.fix(`trend '${s.name}': slope ${fr(a, unit)}/step, R² = ${fixePy(r2, 2)}`);
      }
    }
  }
  o["series"] = out;
  legend(o, series.length);
  o["tooltip"] = { trigger: "axis", axisPointer: { type: kind === "bar" ? "shadow" : "line" } };
  let bottom: number;
  if (horizontal) {
    catAxis["inverse"] = true;
    o["xAxis"] = valAxis;
    o["yAxis"] = catAxis;
    bottom = zoom(o, cats.length, "y", 40);
  } else {
    o["xAxis"] = catAxis;
    o["yAxis"] = valAxis;
    bottom = zoom(o, cats.length);
  }
  grid(o, bottom);
  const summ =
    `${kind}${horizontal ? " horizontal" : ""}${stack === "none" ? "" : " " + stack} · ` +
    `x=${xname || "row number"} (${cats.length}) · series: ${series.map((s) => s.name).join(", ")}`;
  return [o, summ];
}

export function cStream(spec: Spec): [Opt, string] {
  const [cats, series] = cartesian(spec);
  const x = spec.x ?? dims(spec.cols).find((c) => c.dates || c.months) ?? null;
  if (x === null) {
    spec.kind = "area";
    spec.opts.stack = "stacked";
    spec.notes.fix("stream without dates: stacked areas instead");
    return cBarLine(spec);
  }
  const o = base(spec);
  const iso = (k: string): string => {
    const mois = monthKey(k);
    return toDate(k) ?? (mois ? mois + "-01" : k);
  };
  const data = series.flatMap((s) => cats.map((c, i) => [iso(c), ou0Nb(el(s.data, i)), s.name]));
  o["singleAxis"] = {
    type: "time",
    top: o["title"] ? 60 : 40,
    bottom: 30,
    left: 20,
    right: 20,
    axisTick: { show: false },
  };
  o["series"] = [{ type: "themeRiver", data, emphasis: { focus: "self" }, label: { show: false } }];
  o["tooltip"] = { trigger: "axis", axisPointer: { type: "line" } };
  legend(o, series.length, true);
  return [o, `stream · ${cats.length} dates · ${series.length} series`];
}
