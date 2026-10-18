// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/fournisseurs/usage.ts — widgets branchés sur le registre d'usage : conso, attribution, plage de bureau, runs de routines, santé du planificateur (shared_infra/observability/metrics/_usage_providers.py). */
import {
  arrondiEntierPy,
  arrondiPy,
  estChiffresPy,
  fixePy,
  floatPy,
  intPy,
  maxPy,
  reprFlottant,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import { greatest, localPartInt } from "@elpis/db";
import type { Dialecte, Executeur } from "@elpis/db";

import { lastHeartbeatAt } from "../echantillonneur";
import { aggregateSeries, couleur, granularityFor, planBuckets, resolveTz, toChart } from "../series";
import type { Agregat } from "../series";
import { tokenBreakdown, usageCacheTotals, usageGroup, usageTotals } from "../usage-registre";
import { entierOu, flt, fournisseur, maintenant } from "./base";
import type { Fournisseur } from "./base";

export const DEFAULT_SCOPE_HOURS = 24;
export const AVAILABLE_SCOPES = [24, 168, 720] as const;

/** Libellés des sources : l'identifiant technique n'atteint jamais l'écran. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  chat: "Chat",
  routine: "Routine",
  webhook: "Webhook",
  subagent: "Sous-agent",
  title: "Titre",
  compression: "Compression",
  scenario: "Studio",
  remote: "Remote code",
  unknown: "Non attribué",
};

export const STATUS_LABELS: Readonly<Record<string, string>> = {
  ok: "Réussi",
  error: "Erreur",
  aborted: "Interrompu",
  timeout: "Timeout",
  tool_limit: "Limite outils",
  skipped: "Ignoré",
  cancelled: "Annulé",
  orphaned: "Orphelin",
  running: "En cours",
};

const PURGE_USAGE: Dict = { target: "usage_events" };
const PURGE_RUNS: Dict = { target: "editor_routine_runs", destructive: true };

/** `_scope` : 24, 168 ou 720, 24 sinon. */
export function scope(override: unknown = null): number {
  const h =
    override === null || override === undefined
      ? DEFAULT_SCOPE_HOURS
      : entierOu(override, DEFAULT_SCOPE_HOURS);
  return (AVAILABLE_SCOPES as readonly number[]).includes(h) ? h : DEFAULT_SCOPE_HOURS;
}

function since(hours: number): number {
  return maintenant() - hours * 3600;
}

/** `_fmt_tokens` : « 845 », « 12,3 k », « 245 k », « 1,2 M » (même format que le front). */
export function fmtTokens(v: unknown): string {
  let n: number;
  try {
    n = maxPy(0.0, floatPy(veritePy(v) ? v : 0));
  } catch {
    return "0";
  }
  const dec = (x: number, chiffres: number): string => {
    let s = fixePy(x, chiffres);
    if (s.includes(".")) s = s.replace(/0+$/u, "").replace(/\.$/u, "");
    return s.replace(".", ",");
  };
  if (n >= 999_500) return dec(n / 1_000_000, n >= 1e8 ? 0 : 1) + " M";
  if (n >= 1000) return dec(n / 1000, n >= 1e5 ? 0 : 1) + " k";
  return String(intPy(n));
}

/** `_usernames` : id → nom en une requête ; table illisible = aucun nom. */
async function usernames(x: Executeur): Promise<Map<number, string>> {
  try {
    return new Map(
      (await x.valeurs("SELECT id, username FROM users")).map((r) => [intPy(r[0]), strPy(r[1])]),
    );
  } catch {
    return new Map();
  }
}

/** `business_hours_cfg` : début, fin et jours ISO de la plage de bureau (lundi à vendredi par défaut). */
export function businessHoursCfg(): [number, number, number[]] {
  const jours: number[] = [];
  for (const brut of strPy(config.METRICS_BUSINESS_DAYS || "").split(",")) {
    const morceau = stripPy(brut);
    if (estChiffresPy(morceau) && intPy(morceau) >= 1 && intPy(morceau) <= 7) jours.push(intPy(morceau));
  }
  return [
    intPy(config.METRICS_BUSINESS_START),
    intPy(config.METRICS_BUSINESS_END),
    jours.length ? jours : [1, 2, 3, 4, 5],
  ];
}

/** `business_sql` : prédicat « dans la plage de bureau » à l'heure locale (`%w`, dimanche = 0). */
export function businessSql(d: Dialecte, tsCol = "ts"): string {
  const [debut, fin, jours] = businessHoursCfg();
  const wdays = jours.map((j) => String(j % 7)).join(",");
  const h = localPartInt("%H", tsCol, d);
  const dow = localPartInt("%w", tsCol, d);
  return `(${h} >= ${debut} AND ${h} < ${fin} AND ${dow} IN (${wdays}))`;
}

function entier(v: unknown): number {
  return intPy(veritePy(v) ? v : 0);
}

function libelleFenetre(h: number): string {
  return h === 24 ? "24h" : h === 168 ? "7j" : "30j";
}

const POSTES: readonly (readonly [string, "cache" | "input_new" | "thinking" | "response"])[] = [
  ["Cache", "cache"],
  ["Entrée utile", "input_new"],
  ["Réflexion", "thinking"],
  ["Réponse", "response"],
];

/** `_stacked_postes` : barres horizontales empilées des quatre postes disjoints d'une consommation. */
function stackedPostes(labels: unknown[], rows: Dict[]): Dict {
  const parts = rows.map((r) =>
    tokenBreakdown(r["input_tokens"], r["output_tokens"], {
      cacheReadTokens: r["cache_read_tokens"],
      thinkingTokens: r["thinking_tokens"],
    }),
  );
  return {
    labels,
    datasets: POSTES.map(([label, cle], i) => ({
      label,
      data: parts.map((p) => p[cle]),
      backgroundColor: `rgba(${couleur(i)},0.8)`,
      borderRadius: 2,
    })),
    meta: { horizontal: true },
  };
}

/** `_human` : `JJ/MM HH:MM` (horaire) ou `JJ/MM` (journalier). */
function humain(iso: string): string {
  if (iso.length >= 16) return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
  if (iso.length === 10) return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return iso;
}

/** Série unique d'un agrégat sans regroupement, renommée pour l'empilement. */
function serieUnique(a: Agregat): Map<unknown, number> {
  return a.get("") ?? new Map();
}

/** Widgets de _usage_providers.py, dans l'ordre de `register_all`. */
export function fournisseursUsage(): Fournisseur[] {
  return [
    fournisseur({
      id: "usage_tokens",
      title: "Tokens consommés",
      type: "value",
      width: "1/4",
      icon: "ph-lightning",
      color: "emerald",
      category: "volume",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const h = scope(s);
        const t = await usageTotals(c.base, since(h));
        const b = tokenBreakdown(t["input_tokens"], t["output_tokens"], {
          cacheReadTokens: t["cache_read_tokens"],
          thinkingTokens: t["thinking_tokens"],
        });
        let detail = `${fmtTokens(b.input)} entrée`;
        if (b.cache) detail += ` (cache ${arrondiEntierPy(b.cache_pct.valeur)} %)`;
        detail += ` · ${fmtTokens(b.output)} sortie`;
        if (b.thinking) detail += ` (réflexion ${arrondiEntierPy((100.0 * b.thinking) / b.output)} %)`;
        return {
          value: fmtTokens(t["total_tokens"]),
          unit: `tokens/${libelleFenetre(h)}`,
          color: "emerald",
          icon: "ph-lightning",
          detail,
        };
      },
    }),
    fournisseur({
      id: "usage_offhours",
      title: "Hors plage",
      type: "value",
      width: "1/4",
      icon: "ph-moon",
      color: "violet",
      category: "activity",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const h = scope(s);
        const row = await c.base.get(
          `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total,
                           COALESCE(SUM(CASE WHEN ${businessSql(c.base.dialecte)} THEN
                                        input_tokens + output_tokens ELSE 0 END), 0) AS inside
                    FROM usage_events WHERE ts > ?`,
          [since(h)],
        );
        const total = row ? floatPy(veritePy(row["total"]) ? row["total"] : 0) : 0.0;
        const dedans = row ? floatPy(veritePy(row["inside"]) ? row["inside"] : 0) : 0.0;
        const dehors = total - dedans;
        const pct = total > 0 ? arrondiPy((100.0 * dehors) / total, 1) : 0.0;
        const [debut, fin, jours] = businessHoursCfg();
        return {
          value: `${reprFlottant(pct)} %`,
          unit: "des tokens",
          color: "violet",
          icon: "ph-moon",
          detail: `${fmtTokens(dehors)} hors ${debut}h–${fin}h (${jours.length} j/sem.)`,
        };
      },
    }),
    fournisseur({
      id: "usage_turns",
      title: "Tours LLM",
      type: "value",
      width: "1/4",
      icon: "ph-arrows-clockwise",
      color: "sky",
      category: "volume",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const t = await usageTotals(c.base, since(scope(s)));
        const tours = entier(t["turns"]);
        const parTour = tours ? Math.trunc(entier(t["total_tokens"]) / tours) : 0;
        return {
          value: tours,
          unit: "tours",
          color: "sky",
          icon: "ph-arrows-clockwise",
          detail: `${fmtTokens(parTour)} tokens/tour · ${entier(t["iterations"])} itérations`,
        };
      },
    }),
    fournisseur({
      id: "usage_failure_rate",
      title: "Tours en échec",
      type: "value",
      width: "1/4",
      icon: "ph-warning-circle",
      color: "rose",
      category: "performance",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const t = await usageTotals(c.base, since(scope(s)));
        const tours = entier(t["turns"]);
        const echecs = entier(t["failures"]);
        const pct = tours ? arrondiPy((100.0 * echecs) / tours, 1) : 0.0;
        return {
          value: `${reprFlottant(pct)} %`,
          unit: `${echecs}/${tours} tours`,
          color: pct < 1 ? "emerald" : pct < 5 ? "amber" : "rose",
          icon: "ph-warning-circle",
          state: pct < 1 ? null : pct < 5 ? "warn" : "danger",
        };
      },
    }),
    fournisseur({
      id: "usage_cache",
      title: "Cache de prompt",
      type: "value",
      width: "1/4",
      icon: "ph-database",
      color: "cyan",
      category: "performance",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const t = await usageCacheTotals(c.base, since(scope(s)));
        const [lu, cree] = [t.cache_read_tokens, t.cache_creation_tokens];
        if (lu === 0 && cree === 0)
          return { value: "—", unit: "non utilisé", color: "slate", icon: "ph-database" };
        const total = t.input_total;
        const ratio = total ? arrondiPy((100.0 * lu) / total, 1) : 0.0;
        let detail = `${fmtTokens(lu)} en cache · ${fmtTokens(Math.max(0, total - lu))} utiles`;
        if (cree) detail += ` · ${fmtTokens(cree)} mis en cache`;
        return {
          value: `${reprFlottant(ratio)} %`,
          unit: "de l'entrée relue du cache",
          color: "cyan",
          icon: "ph-database",
          detail,
        };
      },
    }),
    fournisseur({
      id: "usage_thinking",
      title: "Réflexion",
      type: "value",
      width: "1/4",
      icon: "ph-brain",
      color: "amber",
      category: "volume",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const t = await usageTotals(c.base, since(scope(s)));
        const sortie = entier(t["output_tokens"]);
        const reflexion = entier(t["thinking_tokens"]);
        if (sortie <= 0) return { value: "—", unit: "aucune sortie", color: "slate", icon: "ph-brain" };
        if (reflexion <= 0)
          return {
            value: "—",
            unit: "aucun raisonnement mesuré",
            color: "slate",
            icon: "ph-brain",
            detail: `${fmtTokens(sortie)} de sortie, tout en réponse`,
          };
        return {
          value: `${reprFlottant(arrondiPy((100.0 * reflexion) / sortie, 1))} %`,
          unit: "de la sortie",
          color: "amber",
          icon: "ph-brain",
          detail: `${fmtTokens(reflexion)} de réflexion · ${fmtTokens(t["response_tokens"])} de réponse`,
        };
      },
    }),
    fournisseur({
      id: "routine_runs",
      title: "Runs de routines",
      type: "value",
      width: "1/4",
      icon: "ph-clock-countdown",
      color: "indigo",
      category: "activity",
      purgeSpec: PURGE_RUNS,
      getData: async (c, s) => {
        const row = await c.base.get(
          `SELECT COUNT(*) AS n,
                          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS ko,
                          SUM(CASE WHEN status IN ('skipped','orphaned') THEN 1 ELSE 0 END) AS lost
                   FROM editor_routine_runs WHERE started_at > ?`,
          [since(scope(s))],
        );
        const n = entier(row?.["n"]);
        const ko = entier(row?.["ko"]);
        const perdus = entier(row?.["lost"]);
        return {
          value: n,
          unit: "runs",
          icon: "ph-clock-countdown",
          color: ko ? "rose" : perdus ? "amber" : "indigo",
          state: ko ? "danger" : perdus ? "warn" : null,
          detail: `${ko} en erreur · ${perdus} non exécuté(s)`,
        };
      },
    }),
    fournisseur({
      id: "scheduler_health",
      title: "Planification",
      type: "value",
      width: "1/4",
      icon: "ph-heartbeat",
      color: "teal",
      category: "system",
      eventTypes: ["scheduler_skip", "maintenance_pass"],
      getData: async (c) => {
        const now = maintenant();
        const dernierBattement = await lastHeartbeatAt(c.base);
        const [entretien] = await c.base.valeurs(
          "SELECT MAX(created_at) FROM metric_events WHERE event_type='maintenance_pass'",
        );
        const [sauts] = await c.base.valeurs(
          "SELECT COALESCE(SUM(value),0) FROM metric_events WHERE event_type='scheduler_skip' AND created_at>?",
          [now - 86400],
        );
        const dernierEntretien = entretien && veritePy(entretien[0]) ? floatPy(entretien[0]) : 0.0;
        const nSauts = sauts ? entier(sauts[0]) : 0;
        if (!(dernierBattement > 0 && now - dernierBattement < 900))
          return {
            value: "Arrêtée",
            unit: "aucun leader actif",
            color: "rose",
            icon: "ph-heartbeat",
            state: "danger",
          };
        const texte = !dernierEntretien
          ? "jamais"
          : `il y a ${Math.trunc((now - dernierEntretien) / 3600)} h`;
        return {
          value: "Active",
          unit: `entretien : ${texte}`,
          color: nSauts ? "amber" : "teal",
          icon: "ph-heartbeat",
          state: nSauts ? "warn" : null,
          detail: nSauts ? `${nSauts} minute(s) enjambée(s) sur 24 h` : "aucune minute enjambée sur 24 h",
        };
      },
    }),
    fournisseur({
      id: "usage_timeline",
      title: "Consommation par source",
      type: "bar_stacked",
      width: "full",
      icon: "ph-chart-bar",
      color: "blue",
      category: "volume",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const h = scope(s);
        const plan = planBuckets(since(h), null, granularityFor(h));
        const agg = await aggregateSeries(c.base, {
          table: "usage_events",
          tsCol: "ts",
          valueExpr: "COALESCE(SUM(input_tokens + output_tokens),0)",
          plan,
          groupCol: "source",
        });
        return toChart(plan, agg, { kind: "bar", stacked: true, labelsMap: SOURCE_LABELS });
      },
    }),
    fournisseur({
      id: "usage_turns_timeline",
      title: "Tours LLM dans le temps",
      type: "line",
      width: "1/2",
      icon: "ph-chart-line",
      color: "sky",
      category: "volume",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const h = scope(s);
        const plan = planBuckets(since(h), null, granularityFor(h));
        const agg = await aggregateSeries(c.base, {
          table: "usage_events",
          tsCol: "ts",
          valueExpr: "COUNT(*)",
          plan,
          groupCol: "status",
        });
        return toChart(plan, agg, { kind: "line", labelsMap: STATUS_LABELS });
      },
    }),
    fournisseur({
      id: "usage_thinking_timeline",
      title: "Sortie — réflexion vs réponse",
      type: "bar_stacked",
      width: "1/2",
      icon: "ph-brain",
      color: "amber",
      category: "volume",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const h = scope(s);
        const plan = planBuckets(since(h), null, granularityFor(h));
        const series: Agregat = new Map();
        for (const [label, expr] of [
          ["Réflexion", "COALESCE(SUM(thinking_tokens),0)"],
          [
            "Réponse",
            `COALESCE(SUM(${greatest(["output_tokens - thinking_tokens", "0"], c.base.dialecte)}),0)`,
          ],
        ] as const) {
          const agg = await aggregateSeries(c.base, {
            table: "usage_events",
            tsCol: "ts",
            valueExpr: expr,
            plan,
          });
          series.set(label, serieUnique(agg));
        }
        return toChart(plan, series, { kind: "bar", stacked: true });
      },
    }),
    fournisseur({
      id: "usage_input_timeline",
      title: "Entrée — cache vs utile",
      type: "bar_stacked",
      width: "1/2",
      icon: "ph-database",
      color: "cyan",
      category: "volume",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const h = scope(s);
        const plan = planBuckets(since(h), null, granularityFor(h));
        const series: Agregat = new Map();
        for (const [label, expr] of [
          ["Cache", "COALESCE(SUM(cache_read_tokens),0)"],
          [
            "Utile",
            `COALESCE(SUM(${greatest(["input_tokens - cache_read_tokens", "0"], c.base.dialecte)}),0)`,
          ],
        ] as const) {
          const agg = await aggregateSeries(c.base, {
            table: "usage_events",
            tsCol: "ts",
            valueExpr: expr,
            plan,
          });
          series.set(label, serieUnique(agg));
        }
        return toChart(plan, series, { kind: "bar", stacked: true });
      },
    }),
    fournisseur({
      id: "usage_by_source",
      title: "Répartition par source",
      type: "doughnut",
      width: "1/4",
      icon: "ph-chart-pie",
      color: "violet",
      category: "volume",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const rows = await usageGroup(c.base, "source", since(scope(s)), null, { limit: 12 });
        return {
          labels: rows.map((r) => {
            const cle = r["key"];
            return typeof cle === "string" && Object.hasOwn(SOURCE_LABELS, cle)
              ? SOURCE_LABELS[cle]
              : veritePy(cle)
                ? cle
                : "?";
          }),
          datasets: [
            {
              label: "Tokens",
              data: rows.map((r) => r["value"]),
              backgroundColor: rows.map((_r, i) => `rgb(${couleur(i)})`),
              borderRadius: 4,
            },
          ],
        };
      },
    }),
    fournisseur({
      id: "usage_by_model",
      title: "Tokens par modèle",
      type: "bar_stacked",
      width: "1/2",
      icon: "ph-robot",
      color: "indigo",
      category: "volume",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const rows = await usageGroup(c.base, "model", since(scope(s)), null, { limit: 10 });
        return stackedPostes(
          rows.map((r) =>
            Array.from(strPy(veritePy(r["key"]) ? r["key"] : "inconnu"))
              .slice(0, 38)
              .join(""),
          ),
          rows,
        );
      },
    }),
    fournisseur({
      id: "usage_top_users",
      title: "Tokens par utilisateur",
      type: "bar_stacked",
      width: "1/2",
      icon: "ph-users",
      color: "emerald",
      category: "activity",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const rows = await usageGroup(c.base, "user_id", since(scope(s)), null, { limit: 10 });
        const noms = await usernames(c.base);
        return stackedPostes(
          rows.map((r) =>
            typeof r["key"] === "number" ? (noms.get(r["key"]) ?? "non attribué") : "non attribué",
          ),
          rows,
        );
      },
    }),
    fournisseur({
      id: "usage_heatmap",
      title: "Activité — jour × heure",
      type: "bar_stacked",
      width: "full",
      icon: "ph-calendar",
      color: "violet",
      category: "activity",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const d = c.base.dialecte;
        const rows = await c.base.all(
          `SELECT ${localPartInt("%w", "ts", d)} AS dow,
                          ${localPartInt("%H", "ts", d)} AS hh,
                          COALESCE(SUM(input_tokens + output_tokens),0) AS v
                   FROM usage_events WHERE ts > ? GROUP BY dow, hh`,
          [since(scope(s))],
        );
        const jours = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
        const grille = new Map<string, number>();
        for (const r of rows)
          grille.set(`${intPy(r["dow"])}:${intPy(r["hh"])}`, floatPy(veritePy(r["v"]) ? r["v"] : 0));
        const heures = Array.from({ length: 24 }, (_v, i) => i);
        return {
          labels: heures.map((hh) => `${String(hh).padStart(2, "0")}h`),
          datasets: [1, 2, 3, 4, 5, 6, 0].map((jour, i) => ({
            label: jours[jour],
            data: heures.map((hh) => {
              const v = grille.get(`${jour}:${hh}`);
              return v === undefined ? 0 : flt(v);
            }),
            backgroundColor: `rgba(${couleur(i)},0.75)`,
            borderRadius: 3,
            stack: "all",
          })),
          meta: { timezone: resolveTz().nom, stacked: true },
        };
      },
    }),
    fournisseur({
      id: "routine_runs_timeline",
      title: "Runs de routines",
      type: "bar_stacked",
      width: "1/2",
      icon: "ph-clock-countdown",
      color: "indigo",
      category: "activity",
      purgeSpec: PURGE_RUNS,
      getData: async (c, s) => {
        const h = scope(s);
        const plan = planBuckets(since(h), null, granularityFor(h));
        const agg = await aggregateSeries(c.base, {
          table: "editor_routine_runs",
          tsCol: "started_at",
          valueExpr: "COUNT(*)",
          plan,
          groupCol: "status",
        });
        return toChart(plan, agg, { kind: "bar", stacked: true, labelsMap: STATUS_LABELS });
      },
    }),
    fournisseur({
      id: "usage_user_peaks",
      title: "Pics par utilisateur",
      type: "table",
      width: "full",
      icon: "ph-trend-up",
      color: "amber",
      category: "activity",
      purgeSpec: PURGE_USAGE,
      getData: async (c, s) => {
        const h = scope(s);
        const debut = since(h);
        const gran = granularityFor(h);
        const plan = planBuckets(debut, null, gran);
        const noms = await usernames(c.base);
        const totaux = await c.base.all(
          `SELECT user_id,
                           COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
                           COUNT(*) AS turns,
                           COALESCE(SUM(CASE WHEN NOT ${businessSql(c.base.dialecte)} THEN
                                        input_tokens + output_tokens ELSE 0 END),0) AS off,
                           COALESCE(SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END),0) AS fails,
                           COUNT(DISTINCT source) AS n_sources
                    FROM usage_events WHERE ts > ?
                    GROUP BY user_id ORDER BY tokens DESC LIMIT 15`,
          [debut],
        );
        const pics = await aggregateSeries(c.base, {
          table: "usage_events",
          tsCol: "ts",
          valueExpr: "COALESCE(SUM(input_tokens + output_tokens),0)",
          plan,
          groupCol: "user_id",
        });
        const libelles = new Map<unknown, string>(plan.keys.map((k, i) => [k, humain(plan.labels[i] ?? "")]));
        const lignes = totaux.map((r) => {
          const uid = r["user_id"];
          const serie = pics.get(uid) ?? pics.get(strPy(uid)) ?? new Map<unknown, number>();
          let [cle, valeurPic, vu]: [unknown, number, boolean] = ["", 0.0, false];
          for (const [k, v] of serie) if (!vu || v > valeurPic) [cle, valeurPic, vu] = [k, v, true];
          const tokens = floatPy(veritePy(r["tokens"]) ? r["tokens"] : 0);
          return {
            utilisateur:
              uid === null || uid === undefined ? "non attribué" : (noms.get(intPy(uid)) ?? "non attribué"),
            tokens: fmtTokens(tokens),
            tours: entier(r["turns"]),
            pic: libelles.get(cle) ?? "—",
            pic_tokens: fmtTokens(valeurPic),
            hors_plage:
              tokens > 0
                ? `${reprFlottant(arrondiPy((100.0 * floatPy(veritePy(r["off"]) ? r["off"] : 0)) / tokens, 1))} %`
                : "—",
            echecs: entier(r["fails"]),
          };
        });
        return {
          columns: [
            { key: "utilisateur", label: "Utilisateur" },
            { key: "tokens", label: "Tokens", align: "right" },
            { key: "tours", label: "Tours", align: "right" },
            { key: "pic", label: "Pic" },
            { key: "pic_tokens", label: "Au pic", align: "right" },
            { key: "hors_plage", label: "Hors plage", align: "right" },
            { key: "echecs", label: "Échecs", align: "right" },
          ],
          rows: lignes,
          meta: { granularity: gran, timezone: plan.tzName },
        };
      },
    }),
  ];
}
