// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/fournisseurs/outils.ts — widgets des appels d'outils : taux d'erreur, volume, latence, échecs (shared_infra/observability/metrics/_v17_providers.py). */
import { arrondiPy, floatPy, intPy, strPy, veritePy } from "@elpis/commun";
import { jsonGet } from "@elpis/db";

import { journal } from "../../journal";
import { entierOu, flt, fournisseur, maintenant } from "./base";
import type { Fournisseur } from "./base";

const log = journal("metrics");

export const AVAILABLE_SCOPES_HOURS = [24, 168, 720] as const;

export function scopeLabelOutils(hours: number): string {
  if (hours <= 24) return "24h";
  if (hours <= 168) return "7j";
  if (hours <= 720) return "30j";
  return `${hours}h`;
}

/** `_read_scope_hours` : la fenêtre passée telle quelle (sans liste blanche), 24 h à défaut. */
export function readScopeHours(override: unknown): number {
  if (override !== null && override !== undefined) {
    const h = entierOu(override, Number.NaN);
    if (!Number.isNaN(h)) return h;
  }
  return 24;
}

function couleurTaux(taux: number): string {
  if (taux >= 30) return "#DC2626";
  if (taux >= 10) return "#F59E0B";
  if (taux >= 3) return "#FACC15";
  return "#10B981";
}

function couleurDuree(ms: number): string {
  if (ms >= 5000) return "#DC2626";
  if (ms >= 1000) return "#F59E0B";
  if (ms >= 200) return "#FACC15";
  return "#10B981";
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Widgets de _v17_providers.py, dans l'ordre de `register_all`. */
export function fournisseursOutils(): Fournisseur[] {
  return [
    fournisseur({
      id: "tool_error_rate",
      title: "Outils — taux d'erreur",
      type: "bar",
      width: "full",
      icon: "ph-wrench",
      color: "rose",
      category: "performance",
      eventTypes: ["tool_call"],
      getData: async (c, s) => {
        const hours = readScopeHours(s);
        const comptes = new Map<string, { ok: number; error: number; total: number }>();
        try {
          const d = c.base.dialecte;
          const rows = await c.base.valeurs(
            `
                    SELECT ${jsonGet("tags_json", "tool", d)}   AS tool,
                           ${jsonGet("tags_json", "status", d)} AS st,
                           COUNT(*) AS n
                    FROM metric_events
                    WHERE event_type='tool_call' AND created_at > ?
                    GROUP BY tool, st
                    ORDER BY tool, st
                `,
            [maintenant() - hours * 3600],
          );
          for (const [tool, st, n] of rows) {
            const nom = veritePy(tool) ? strPy(tool) : "unknown";
            const nombre = intPy(n);
            let seau = comptes.get(nom);
            if (seau === undefined) comptes.set(nom, (seau = { ok: 0, error: 0, total: 0 }));
            if ((veritePy(st) ? st : "ok") === "error") seau.error += nombre;
            else seau.ok += nombre;
            seau.total += nombre;
          }
        } catch (e) {
          log.warn(`[v17/tool_error_rate] query failed: ${message(e)}`);
        }
        const triables: [string, number, number][] = [];
        for (const [outil, b] of comptes) {
          if (b.total < 5) continue;
          triables.push([outil, (b.error / b.total) * 100.0, b.total]);
        }
        triables.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
        const top = triables.slice(0, 10);
        const taux = top.map(([, r]) => arrondiPy(r, 1));
        return {
          labels: top.map(([t]) => t),
          datasets: [
            {
              label: `% erreur / ${scopeLabelOutils(hours)}`,
              data: taux.map(flt),
              backgroundColor: taux.map(couleurTaux),
            },
          ],
          tooltips: top.map(([t, r, n]) => ({ tool: t, rate: flt(arrondiPy(r, 1)), calls: n })),
          scope_hours: hours,
          scopes_available: [...AVAILABLE_SCOPES_HOURS],
        };
      },
    }),
    fournisseur({
      id: "tool_call_volume",
      title: "Outils — volume d'appels",
      type: "bar",
      width: "full",
      icon: "ph-stack",
      color: "blue",
      category: "performance",
      getData: async (c, s) => {
        const hours = readScopeHours(s);
        let rows: unknown[][] = [];
        try {
          rows = await c.base.valeurs(
            `
                    SELECT tool_name, COUNT(*) AS n
                    FROM tool_call_metrics
                    WHERE ts > ?
                    GROUP BY tool_name
                    ORDER BY n DESC
                    LIMIT 10
                `,
            [maintenant() - hours * 3600],
          );
        } catch (e) {
          log.warn(`[v17/tool_call_volume] query failed: ${message(e)}`);
        }
        return {
          labels: rows.map((r) => r[0]),
          datasets: [
            {
              label: `appels / ${scopeLabelOutils(hours)}`,
              data: rows.map((r) => intPy(r[1])),
              backgroundColor: "#3B82F6",
            },
          ],
          scope_hours: hours,
          scopes_available: [...AVAILABLE_SCOPES_HOURS],
        };
      },
    }),
    fournisseur({
      id: "tool_call_latency",
      title: "Outils — latence moyenne",
      type: "bar",
      width: "full",
      icon: "ph-gauge",
      color: "amber",
      category: "performance",
      getData: async (c, s) => {
        const hours = readScopeHours(s);
        let rows: unknown[][] = [];
        try {
          rows = await c.base.valeurs(
            `
                    SELECT tool_name,
                           AVG(duration_ms) AS avg_ms,
                           COUNT(*)         AS n
                    FROM tool_call_metrics
                    WHERE ts > ? AND status='success'
                    GROUP BY tool_name
                    HAVING COUNT(*) >= 3
                    ORDER BY avg_ms DESC
                    LIMIT 10
                `,
            [maintenant() - hours * 3600],
          );
        } catch (e) {
          log.warn(`[v17/tool_call_latency] query failed: ${message(e)}`);
        }
        const moyennes = rows.map((r) => arrondiPy(floatPy(r[1]), 1));
        return {
          labels: rows.map((r) => r[0]),
          datasets: [
            {
              label: `durée moyenne (ms) / ${scopeLabelOutils(hours)}`,
              data: moyennes.map(flt),
              backgroundColor: moyennes.map(couleurDuree),
            },
          ],
          tooltips: rows.map((r) => ({
            tool: r[0],
            avg_ms: flt(arrondiPy(floatPy(r[1]), 1)),
            calls: intPy(r[2]),
          })),
          scope_hours: hours,
          scopes_available: [...AVAILABLE_SCOPES_HOURS],
        };
      },
    }),
    fournisseur({
      id: "kpi_tool_failures",
      title: "Outils en échec",
      type: "value",
      width: "1/4",
      icon: "ph-warning-octagon",
      color: "rose",
      category: "performance",
      getData: async (c, s) => {
        const hours = readScopeHours(s);
        let n = 0;
        try {
          const [r] = await c.base.valeurs(
            "SELECT COUNT(*) FROM tool_call_metrics WHERE ts > ? AND status != 'success'",
            [maintenant() - hours * 3600],
          );
          n = intPy(r?.[0]);
        } catch (e) {
          log.warn(`[v17/kpi_tool_failures] query failed: ${message(e)}`);
        }
        return {
          value: n,
          unit: `échecs / ${scopeLabelOutils(hours)}`,
          color: "rose",
          icon: "ph-warning-octagon",
          state: n ? "warn" : null,
          scope_hours: hours,
          scopes_available: [...AVAILABLE_SCOPES_HOURS],
        };
      },
    }),
  ];
}
