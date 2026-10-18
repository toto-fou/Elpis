// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/compile/parts.ts — parts d'un tout, jauge, avancement et chiffres clés (port de _chart/compile_echarts.py). */
import { arrondiPy, fixePy, FlottantPy, strPy } from "@elpis/commun";

import { num, toNumber } from "../normalise";
import { el, entier, fl, flottant, lg, maxListe, sommeTermes } from "../py";
import type { Terme } from "../py";
import { byName, dims, MAX_SERIES, measures, SpecError } from "../spec";
import type { Spec } from "../spec";
import {
  base,
  cartesian,
  highlightConnu,
  fr,
  grid,
  label,
  niceCeil,
  ORDINAL_RAMP,
  OTHER,
  sortieTerme,
  val,
  valN,
} from "./commun";
import type { Nb, Opt } from "./commun";

/** Terme d'une somme pour une valeur de série (entier Python si le nombre est un entier non flottant). */
function terme(x: Nb): Terme {
  return x instanceof FlottantPy || !Number.isInteger(x) ? flottant(val(x)) : entier(x);
}

export function cPie(spec: Spec): [Opt, string] {
  if (spec.group !== null) {
    spec.notes.warn("group ignored for a pie: values summed per category");
    spec.group = null;
  }
  const [cats, series, , ynames] = cartesian(spec, false);
  if (series.length > 1) spec.notes.warn(`a pie shows one measure: '${el(series, 0).name}' (others ignored)`);
  const vals = el(series, 0).data;
  let items: [string, Nb][] = [];
  cats.forEach((c, i) => {
    const v = vals[i];
    if (v !== null && v !== undefined) items.push([c, v]);
  });
  const neg = items.filter(([, v]) => val(v) < 0).map(([c]) => c);
  if (neg.length > 0) {
    spec.notes.warn(`negative values cannot be pie slices: ${neg.slice(0, 3).join(", ")} ignored`);
    items = items.filter(([, v]) => val(v) >= 0);
  }
  items.sort((p, q) => val(q[1]) - val(p[1]));
  if (items.length > MAX_SERIES && !spec.opts.top) {
    const keep = items.slice(0, MAX_SERIES - 1);
    const rest = items.slice(MAX_SERIES - 1);
    items = [...keep, [OTHER, sortieTerme(sommeTermes(rest.map(([, v]) => terme(v))))]];
    spec.notes.fix(`${rest.length} small slices folded into '${OTHER}'`);
  }
  const total = sommeTermes(items.map(([, v]) => terme(v)));
  const o = base(spec);
  const hl = highlightConnu(
    spec,
    items.map(([c]) => c),
  );
  const data = items.map(([c, v]) => {
    const it: Opt = { name: c, value: v };
    if (c === OTHER) it["itemStyle"] = { color: "@muted" };
    if (hl.size > 0 && !hl.has(c)) it["itemStyle"] = { color: "@muted", opacity: 0.55 };
    return it;
  });
  const kind = spec.kind;
  const ser: Opt = {
    type: "pie",
    name: ynames.length > 0 ? ynames[0] : "",
    data,
    center: ["50%", "56%"],
    avoidLabelOverlap: true,
    itemStyle: { borderColor: "@surface", borderWidth: 2, borderRadius: kind === "donut" ? 4 : 0 },
    label: { formatter: "{b}\n{d} %", color: "@ink2", fontSize: 11, lineHeight: 15 },
    _lbl: { pct: true },
    labelLine: { length: 8, length2: 10 },
    emphasis: { scale: true, scaleSize: 4 },
  };
  if (kind === "donut") {
    ser["radius"] = ["44%", "68%"];
    o["graphic"] = [
      {
        type: "text",
        left: "center",
        top: "51%",
        style: {
          text: fr(total.v, spec.opts.unit),
          fill: "@ink",
          fontSize: 20,
          fontWeight: 600,
          textAlign: "center",
        },
      },
    ];
  } else if (kind === "rose") {
    ser["radius"] = ["14%", "70%"];
    ser["roseType"] = "area";
    ser["itemStyle"].borderRadius = 4;
  } else ser["radius"] = ["0%", "68%"];
  o["series"] = [ser];
  o["tooltip"] = { trigger: "item" };
  const shares = total.v
    ? items
        .slice(0, 4)
        .map(([c, v]) => `${c} ${fixePy((100 * val(v)) / total.v, 0)} %`)
        .join(", ")
    : "";
  return [o, `${kind} · ${items.length} slices · total ${fr(total.v, spec.opts.unit)} · ${shares}`];
}

export function cFunnel(spec: Spec): [Opt, string] {
  const [cats, series] = cartesian(spec, false);
  const items: [string, Nb][] = [];
  cats.forEach((c, i) => {
    const v = el(series, 0).data[i];
    if (v !== null && v !== undefined) items.push([c, v]);
  });
  const croissant = items.some((it, i) => i > 0 && val(it[1]) > val(el(items, i - 1)[1]));
  if (croissant)
    spec.notes.warn("stages are not decreasing: input order kept, percentages relative to the largest stage");
  const first: Nb =
    items.length > 0
      ? croissant
        ? items.reduce((m, it) => (val(it[1]) > val(m) ? it[1] : m), el(items, 0)[1])
        : el(items, 0)[1]
      : 1;
  const o = base(spec);
  const unit = spec.opts.unit;
  const data = items.map(([c, v], i) => {
    const pct = val(first) ? (100 * val(v)) / val(first) : 0;
    return {
      name: c,
      value: v,
      itemStyle: { color: ORDINAL_RAMP[Math.min(i, ORDINAL_RAMP.length - 1)] },
      label: { formatter: `${c}  ${fr(val(v), unit)} · ${fixePy(pct, 0)} %` },
    };
  });
  o["series"] = [
    {
      type: "funnel",
      data,
      sort: croissant ? "none" : "descending",
      gap: 2,
      left: "4%",
      width: "56%",
      top: o["title"] ? 60 : 20,
      bottom: 10,
      minSize: "14%",
      label: { position: "right", color: "@ink", fontSize: 12 },
      labelLine: { length: 12, lineStyle: { color: "@grid" } },
      itemStyle: { borderColor: "@surface", borderWidth: 0 },
    },
  ];
  o["tooltip"] = { trigger: "item" };
  const dernier = items.length > 0 ? val(el(items, -1)[1]) : 0;
  const conv = items.length > 0 && val(first) ? fr((100 * dernier) / val(first), "%", 1) : "—";
  return [o, `funnel · ${items.length} stages · final conversion ${conv}`];
}

export function cGauge(spec: Spec): [Opt, string] {
  const m = spec.ys.length > 0 ? spec.ys : measures(spec.cols);
  const mxCol = byName(spec.cols, "max", ["number"]);
  const vals = m.filter((c) => c !== mxCol);
  if (vals.length === 0)
    throw new SpecError("gauge: no numeric value", "", [
      { indicateur: "Taux de service", valeur: 72, max: 100 },
    ]);
  if (spec.rows.length > 1) {
    spec.notes.fix("several rows: progress bars instead of a gauge");
    spec.kind = "progress";
    return cProgress(spec);
  }
  const r = el(spec.rows, 0);
  const vNum = num(lg(r, el(vals, 0).name));
  const v: Nb = vNum ? fl(vNum) : 0;
  const unit = spec.opts.unit;
  const mxLu = mxCol !== null ? num(lg(r, mxCol.name)) : null;
  let mx: Nb | bigint;
  let mxN: number;
  if (mxLu) {
    mx = fl(mxLu);
    mxN = mxLu;
  } else if (unit === "%" || (val(v) >= 0 && val(v) <= 100)) {
    mx = 100;
    mxN = 100;
  } else {
    const nc = niceCeil(val(v) * 1.1);
    mx = nc.sortie;
    mxN = nc.valeur();
  }
  if (val(v) > mxN) spec.notes.warn(`value exceeds max (${fr(val(v), unit)} > ${fr(mxN, unit)}): gauge full`);
  const d = dims(spec.cols);
  const d0 = d[0];
  const name = d0 !== undefined ? strPy(lg(r, d0.name)) : el(vals, 0).name;
  const o = base(spec);
  const ser: Opt = {
    type: "gauge",
    startAngle: 210,
    endAngle: -30,
    min: 0,
    max: mx,
    radius: "88%",
    center: ["50%", "58%"],
    progress: { show: true, width: 16, roundCap: true, itemStyle: { color: "@series1" } },
    axisLine: { roundCap: true, lineStyle: { width: 16, color: [[1, "@track"]] } },
    pointer: { show: false },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { show: false },
    anchor: { show: false },
    title: { offsetCenter: [0, "34%"], color: "@ink2", fontSize: 13 },
    detail: {
      valueAnimation: true,
      offsetCenter: [0, "0%"],
      fontSize: 30,
      fontWeight: 600,
      color: "@ink",
      formatter: fr(val(v), unit) + `\n{sub|sur ${fr(mxN, unit)}}`,
      rich: { sub: { fontSize: 12, color: "@ink2", padding: [6, 0, 0, 0] } },
    },
    data: [{ value: v, name }],
  };
  if (spec.opts.lines.length > 0) {
    ser["axisTick"] = { show: false };
    spec.notes.warn("reference lines are not drawn on a gauge");
  }
  o["series"] = [ser];
  return [
    o,
    `gauge · ${name} = ${fr(val(v), unit)} of ${fr(mxN, unit)} (${fixePy((100 * val(v)) / mxN, 0)} %)`,
  ];
}

export function cProgress(spec: Spec): [Opt, string] {
  const mxCol = byName(spec.cols, "max", ["number"]);
  if (mxCol !== null && spec.ys.includes(mxCol)) spec.ys = spec.ys.filter((c) => c !== mxCol);
  if (spec.ys.length === 0 && mxCol !== null)
    spec.ys = measures(spec.cols)
      .filter((c) => c !== mxCol)
      .slice(0, 1);
  const [cats, series, xname] = cartesian(spec, false);
  const vals = el(series, 0).data;
  let maxes: number[];
  if (mxCol !== null) {
    const byCat = new Map<string, number | null>();
    spec.rows.forEach((r, i) => {
      const key = xname ? label(lg(r, xname)) : `#${i + 1}`;
      byCat.set(key, num(lg(r, mxCol.name)));
    });
    maxes = cats.map((c) => byCat.get(c) || 100);
  } else {
    const nums = vals.map((v) => valN(v) || 0);
    const g = nums.every((v) => v <= 100) ? 100 : niceCeil(maxListe(nums)).valeur();
    maxes = cats.map(() => g);
  }
  const pct: Nb[] = vals.map((v, i) => {
    const mi = el(maxes, i);
    return mi ? fl(arrondiPy((100 * (valN(v) || 0)) / mi, 1)) : 0;
  });
  const depasse = cats.filter((_, i) => val(el(pct, i)) > 100);
  if (depasse.length > 0)
    spec.notes.warn(
      `done exceeds total for ${depasse.slice(0, 5).join(", ")}: bar cut at 100 %, label shows the real value`,
    );
  const unit = spec.opts.unit;
  const o = base(spec);
  o["_elpis"].unit = "%";
  o["xAxis"] = { type: "value", max: 100, show: false };
  o["yAxis"] = {
    type: "category",
    data: cats,
    inverse: true,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: "@ink2", fontSize: 12 },
  };
  o["series"] = [
    {
      type: "bar",
      data: pct.map((p, i) => ({
        value: p,
        label: {
          formatter: `${fr(valN(el(vals, i)), unit)} / ${fr(el(maxes, i), unit)}  (${fixePy(val(p), 0)} %)`,
        },
      })),
      barWidth: 14,
      showBackground: true,
      backgroundStyle: { color: "@track", borderRadius: 7 },
      itemStyle: { borderRadius: 7 },
      label: { show: true, position: "right", color: "@ink2", fontSize: 11 },
    },
  ];
  o["tooltip"] = { trigger: "axis", axisPointer: { type: "none" } };
  grid(o);
  o["grid"].right = 150;
  const resume = cats
    .map((c, i) => `${c} ${fixePy(val(el(pct, i)), 0)} %`)
    .slice(0, 4)
    .join(", ");
  return [o, `progress · ${cats.length} bars · ${resume}`];
}

export function cKpi(spec: Spec): [Opt, string] {
  const d = dims(spec.cols);
  const m = measures(spec.cols);
  const prev = byName(spec.cols, "previous", ["number"]);
  const mx = byName(spec.cols, "max", ["number"]);
  const vcols = spec.ys.length > 0 ? spec.ys : m.filter((c) => c !== prev && c !== mx);
  if (vcols.length === 0)
    throw new SpecError("kpi: no numeric value", "", [
      { indicateur: "Chiffre d'affaires", valeur: 1250000, précédent: 1100000 },
    ]);
  const unit = spec.opts.unit;
  const tiles: Opt[] = [];
  if (spec.rows.length === 1 && vcols.length > 1 && d.length === 0) {
    const r = el(spec.rows, 0);
    for (const c of vcols.slice(0, 8))
      tiles.push({ label: c.name, value: fr(num(lg(r, c.name)), c.unit || unit) });
  } else {
    for (const r of spec.rows.slice(0, 8)) {
      const v0 = el(vcols, 0);
      const raw = toNumber(lg(r, v0.name));
      const v = raw.value;
      const ru = raw.unit || v0.unit || unit;
      const d0 = d[0];
      const t: Opt = { label: d0 !== undefined ? strPy(lg(r, d0.name)) : v0.name, value: fr(v, ru) };
      if (prev !== null) {
        const p = num(lg(r, prev.name));
        if (p === 0) spec.notes.warn(`previous = 0 for '${strPy(t["label"])}': change not computable`);
        if (p !== null && p !== 0 && v !== null) {
          const delta = (100 * (v - p)) / Math.abs(p);
          t["delta"] = (delta >= 0 ? "+" : "−") + fr(Math.abs(delta), "%", 1);
          t["sign"] = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
          t["ref"] = `vs ${fr(p, ru)}`;
        }
      }
      tiles.push(t);
    }
  }
  const o = base(spec);
  o["_elpis"].render = "kpi";
  o["_elpis"].kpi = tiles;
  return [
    o,
    "kpi · " +
      tiles
        .slice(0, 4)
        .map((t) => `${t["label"]} ${t["value"]}`)
        .join(" · "),
  ];
}
