// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/rapports.ts — rapport quotidien d'usage : instantané des widgets curés, stockage par jour, digest idempotent notifié aux admins (daily_report.py, daily_reports_store.py). */
import { FlottantPy, intPy, pyJsonDumps, pyJsonLoads, stripPy, strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { getAllUsers } from "@elpis/auth";
import type { Base, Executeur } from "@elpis/db";

import { journal } from "../journal";
import { pousserNotification } from "../notifications/envoi";
import type { ContexteMetriques } from "./fournisseurs/base";
import { registry as registreParDefaut } from "./registre";
import type { MetricsRegistry } from "./registre";

const log = journal("maintenance");

/** Sections ordonnées du rapport → widgets (tous présents dans le registre). */
export const REPORT_SECTIONS: readonly { id: string; label: string; widgets: readonly string[] }[] = [
  { id: "adoption", label: "Adoption", widgets: ["kpi_dau", "kpi_chats", "kpi_new_chats", "kpi_logins"] },
  {
    id: "volume",
    label: "Volume",
    widgets: [
      "kpi_messages",
      "usage_tokens",
      "usage_turns",
      "usage_cache",
      "usage_thinking",
      "kpi_tool_calls",
      "kpi_rag_hits",
    ],
  },
  {
    id: "performance",
    label: "Performance",
    widgets: ["kpi_avg_tps", "kpi_latency", "kpi_latency_p95", "usage_failure_rate"],
  },
  { id: "models", label: "Modèles", widgets: ["kpi_top_model", "kpi_model_loads"] },
  {
    id: "exploitation",
    label: "Exploitation",
    widgets: ["routine_runs", "scheduler_health", "usage_offhours"],
  },
  {
    id: "health",
    label: "Santé plateforme",
    widgets: ["kpi_uptime", "kpi_db_size", "kpi_ram", "kpi_llm_status"],
  },
  {
    id: "charts",
    label: "Graphiques",
    widgets: [
      "usage_timeline",
      "usage_input_timeline",
      "usage_thinking_timeline",
      "usage_by_model",
      "tools_usage",
      "usage_top_users",
      "latency_percentiles",
      "active_users_day",
      "routine_runs_timeline",
    ],
  },
];

export const REPORT_WIDGET_IDS: readonly string[] = [...new Set(REPORT_SECTIONS.flatMap((s) => s.widgets))];

function deux(n: number): string {
  return String(n).padStart(2, "0");
}

/** `_today` : date locale `AAAA-MM-JJ`. */
export function aujourdhui(d = new Date()): string {
  return `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}`;
}

/** `store_daily_report` : insère ou remplace le rapport du jour (JSON non ASCII, horodaté). */
export async function storeDailyReport(x: Executeur, date: string, payload: Dict): Promise<void> {
  await x.run(
    "INSERT INTO daily_usage_reports(date, payload_json, created_at) VALUES(?,?,?) " +
      "ON CONFLICT(date) DO UPDATE SET payload_json=excluded.payload_json, " +
      "created_at=excluded.created_at",
    [date, pyJsonDumps(payload, { ensureAscii: false }), Date.now() / 1000],
  );
}

export async function reportExists(x: Executeur, date: string): Promise<boolean> {
  return (await x.get("SELECT 1 FROM daily_usage_reports WHERE date=? LIMIT 1", [date])) !== undefined;
}

/** `get_daily_report` : le rapport relu avec les nombres Python (flottants entiers gardés), `null` s'il est absent ou illisible. */
export async function getDailyReport(x: Executeur, date: string): Promise<unknown> {
  const r = await x.get<{ payload_json: string }>(
    "SELECT payload_json FROM daily_usage_reports WHERE date=?",
    [date],
  );
  if (r === undefined) return null;
  try {
    return pyJsonLoads(r.payload_json);
  } catch {
    return null;
  }
}

/** `list_daily_reports` : dates et horodatages des rapports récents, sans leur contenu. */
export async function listDailyReports(x: Executeur, limit = 60): Promise<Dict[]> {
  const rows = await x.all("SELECT date, created_at FROM daily_usage_reports ORDER BY date DESC LIMIT ?", [
    intPy(limit),
  ]);
  return rows.map((r) => ({
    date: r["date"],
    created_at: typeof r["created_at"] === "number" ? new FlottantPy(r["created_at"]) : r["created_at"],
  }));
}

/** `purge_daily_reports` : rétention de la maintenance, `<= 0` désactive ; ne lève jamais. */
export async function purgeDailyReports(x: Executeur, retentionDays = 400): Promise<number> {
  if (retentionDays <= 0) return 0;
  try {
    const r = await x.run("DELETE FROM daily_usage_reports WHERE created_at < ?", [
      Date.now() / 1000 - retentionDays * 86400,
    ]);
    const count = r.changes || 0;
    if (count) log.info(`[maintenance] ${count} daily_usage_reports purgé(s) (>${retentionDays}j).`);
    return count;
  } catch (e) {
    log.debug({ err: e }, "[maintenance] purge_daily_reports failed (non-fatal)");
    return 0;
  }
}

/** `build_daily_report` : instantané des widgets curés (un widget en échec garde sa clé `error`), sans le persister. */
export async function buildDailyReport(
  ctx: ContexteMetriques,
  scopeHours = 24,
  date: string | null = null,
  registre: MetricsRegistry = registreParDefaut,
): Promise<Dict> {
  const widgets = await registre.getWidgetsData(ctx, REPORT_WIDGET_IDS, scopeHours);
  const voulus = new Set(REPORT_WIDGET_IDS);
  const titles: Dict = {};
  for (const p of registre.providers) if (voulus.has(p.id)) titles[p.id] = p.title;
  return {
    date: date || aujourdhui(),
    generated_at: new FlottantPy(Date.now() / 1000),
    scope_hours: scopeHours,
    sections: REPORT_SECTIONS.map((s) => ({ id: s.id, label: s.label, widgets: [...s.widgets] })),
    titles,
    widgets,
  };
}

/** `_val` : valeur affichable d'un KPI (avec unité), « — » si absente ou en erreur. */
function valeurAffichee(widgets: unknown, wid: string): string {
  const d = widgets !== null && typeof widgets === "object" ? (widgets as Dict)[wid] : undefined;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return "—";
  const w = d as Dict;
  if (Object.hasOwn(w, "error") || w["value"] === null || w["value"] === undefined) return "—";
  const unit = w["unit"] ? strPy(w["unit"]) : "";
  return stripPy(`${strPy(w["value"])} ${unit}`);
}

/** `_summary_text` : corps court de la notification aux admins. */
export function summaryText(payload: Dict): string {
  const w = payload["widgets"] ?? {};
  const v = (id: string): string => valeurAffichee(w, id);
  return (
    `Utilisateurs actifs : ${v("kpi_dau")} · Messages : ${v("kpi_messages")} · Tokens : ${v("usage_tokens")}\n` +
    `Appels outils : ${v("kpi_tool_calls")} · RAG : ${v("kpi_rag_hits")} · Vitesse : ${v("kpi_avg_tps")} · ` +
    `Latence : ${v("kpi_latency")} · Échecs : ${v("usage_failure_rate")}\n` +
    `Runs de routines : ${v("routine_runs")} · Hors plage : ${v("usage_offhours")} · Modèle dominant : ${v("kpi_top_model")}`
  );
}

/** `_date_to_ref_id` : `AAAA-MM-JJ` → `AAAAMMJJ` (lien vers ce rapport), `null` si la date est inattendue. */
export function dateToRefId(date: string): number | null {
  try {
    return intPy(strPy(date).replaceAll("-", ""));
  } catch {
    return null;
  }
}

/** `_notify_admins` : une notification « Rapport d'usage IA » par admin ou modérateur ; rend leur nombre. */
async function notifierAdmins(base: Base, date: string, payload: Dict): Promise<number> {
  const titre = `Rapport d'usage IA — ${date}`;
  const corps = summaryText(payload);
  const refId = dateToRefId(date);
  const admins = (await getAllUsers(base)).filter((u) => [1, 2].includes(Number(u.is_admin)));
  for (const u of admins)
    await pousserNotification(base, intPy(u.id), "daily_report", titre, {
      body: corps,
      refType: "daily_report",
      refId,
    });
  return admins.length;
}

/** `generate_and_store_daily_digest` : génère, persiste et notifie le rapport du jour ; déjà présent sans `force` = rien (null). */
export async function generateAndStoreDailyDigest(
  base: Base,
  ctx: ContexteMetriques,
  date: string | null = null,
  force = false,
): Promise<string | null> {
  const jour = date || aujourdhui();
  if (!force && (await reportExists(base, jour))) return null;
  const payload = await buildDailyReport(ctx, 24, jour);
  await storeDailyReport(base, jour, payload);
  const n = await notifierAdmins(base, jour, payload);
  log.info(`[digest] rapport quotidien ${jour} généré + notifié à ${n} admin(s).`);
  return jour;
}
