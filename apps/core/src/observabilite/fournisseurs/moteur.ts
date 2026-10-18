// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/fournisseurs/moteur.ts — widgets historiques du tableau de bord : activité, volume, performance, système et graphiques (shared_infra/observability/metrics/engine.py). */
import {
  arrondiEntierPy,
  arrondiPy,
  comparePointsDeCode,
  estDict,
  fixePy,
  intPy,
  reprFlottant,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, readConfigJson } from "@elpis/config";
import { jsonGet, localStrftime, round as roundSql } from "@elpis/db";
import type { Executeur } from "@elpis/db";

import { gaugeUnionParams, gaugeUnionSql } from "../echantillonneur";
import {
  avgMetric,
  countMetric,
  distinctUsers,
  entierOu,
  fillState,
  flt,
  fournisseur,
  maintenant,
  nomCourt,
  percentileMetric,
  scopeHours,
  scopeLabel,
} from "./base";
import type { Fournisseur } from "./base";

const GO = 1024 ** 3;
const MO = 1024 ** 2;

/** Valeur SQL REAL rendue en flottant Python, `None` gardé. */
function flottantOuNul(v: unknown): unknown {
  return v === null || v === undefined ? null : flt(Number(v));
}

function entier(v: unknown): number {
  return intPy(veritePy(v) ? v : 0);
}

async function compter(x: Executeur, sql: string): Promise<number> {
  const [r] = await x.valeurs(sql);
  return entier(r?.[0]);
}

/** Taille lisible : Go à deux décimales, Mo ou Ko arrondis à l'unité. */
function taille(n: number, color: string, icon: string): Dict {
  if (n >= GO) return { value: fixePy(n / GO, 2), unit: "Go", color, icon };
  if (n >= MO) return { value: fixePy(n / MO, 0), unit: "Mo", color, icon };
  return { value: fixePy(n / 1024, 0), unit: "Ko", color, icon };
}

function ligneDonnees(
  label: string,
  data: unknown[],
  hex: string,
  rgba: string,
  pointRadius: number,
  fill: boolean = true,
): Dict {
  return {
    label,
    data,
    borderColor: hex,
    backgroundColor: rgba,
    tension: 0.4,
    fill,
    borderWidth: 2,
    pointRadius,
  };
}

/** `_proc_trend_chart` : MAX par heure (le pire process), anciens et nouveaux échantillons réunis, ordre chronologique. */
export async function procTrendChart(
  x: Executeur,
  series: readonly (readonly [string, string, string, boolean])[],
  days = 7,
): Promise<Dict> {
  const seau = localStrftime("%d/%m %Hh", "created_at", x.dialecte);
  const datasets: Dict[] = [];
  let labels: unknown[] = [];
  const since = maintenant() - days * 86400;
  for (const [et, label, color, fill] of series) {
    const rows = await x.valeurs(
      `SELECT h, ${roundSql("MAX(v)", 1, x.dialecte)} AS v FROM (${gaugeUnionSql(seau, x.dialecte)}) AS g
                    WHERE v IS NOT NULL GROUP BY h ORDER BY MIN(ts) ASC`,
      gaugeUnionParams(et, since),
    );
    if (rows.length > labels.length) labels = rows.map((r) => r[0]);
    datasets.push({
      label,
      data: rows.map((r) => flt(Number(r[1]))),
      borderColor: `rgb(${color})`,
      backgroundColor: `rgba(${color},0.1)`,
      tension: 0.4,
      fill,
      borderWidth: 2,
      pointRadius: 0,
    });
  }
  return { labels, datasets };
}

/** `_hourly_chart` : par heure du jour (repliée sur 24 h), compte ou moyenne des valeurs positives. */
async function hourlyChart(
  x: Executeur,
  eventType: string,
  label: string,
  color: string,
  hours = 24,
  agg: "COUNT" | "AVG" = "COUNT",
): Promise<Dict> {
  const val = agg === "COUNT" ? "COUNT(*)" : roundSql("AVG(value)", 1, x.dialecte);
  let q = `SELECT ${localStrftime("%H:00", "created_at", x.dialecte)} as h, ${val} as v
                FROM metric_events WHERE event_type=? AND created_at>?`;
  if (agg !== "COUNT") q += " AND value>0";
  q += " GROUP BY h ORDER BY h ASC";
  const rows = await x.valeurs(q, [eventType, maintenant() - hours * 3600]);
  return {
    labels: rows.map((r) => r[0]),
    datasets: [
      {
        label,
        data: rows.map((r) => (agg === "COUNT" ? r[1] : flottantOuNul(r[1]))),
        backgroundColor: `rgba(${color},0.7)`,
        borderRadius: 4,
      },
    ],
  };
}

/** `_daily_chart` : compte par jour (`JJ/MM`) dans l'ordre chronologique, en barres ou en courbe. */
async function dailyChart(
  x: Executeur,
  eventType: string,
  label: string,
  color: string,
  days = 7,
  chartType: "bar" | "line" = "bar",
): Promise<Dict> {
  const rows = await x.valeurs(
    `SELECT ${localStrftime("%d/%m", "created_at", x.dialecte)} as d, COUNT(*) as c
            FROM metric_events WHERE event_type=? AND created_at>? GROUP BY d ORDER BY MIN(created_at) ASC`,
    [eventType, maintenant() - days * 86400],
  );
  const ds: Dict = { label, data: rows.map((r) => r[1]) };
  if (chartType === "bar") Object.assign(ds, { backgroundColor: `rgba(${color},0.7)`, borderRadius: 4 });
  else
    Object.assign(ds, {
      borderColor: `rgb(${color})`,
      backgroundColor: `rgba(${color},0.1)`,
      tension: 0.4,
      fill: true,
      borderWidth: 2,
      pointRadius: 4,
    });
  return { labels: rows.map((r) => r[0]), datasets: [ds] };
}

/** Moyenne horaire (repliée sur 24 h) d'un type d'événement, arrondie à `chiffres`. */
async function moyenneHoraire(
  x: Executeur,
  eventType: string,
  chiffres: number,
  positives: boolean,
): Promise<unknown[][]> {
  return x.valeurs(
    `SELECT ${localStrftime("%H:00", "created_at", x.dialecte)} as h, ${roundSql("AVG(value)", chiffres, x.dialecte)} as v
                FROM metric_events WHERE event_type='${eventType}' AND created_at>?${positives ? " AND value>0" : ""} GROUP BY h ORDER BY h ASC`,
    [maintenant() - 86400],
  );
}

const COULEURS_EXT = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316", "#84cc16"];
const COULEURS_USER = [
  "#10b981",
  "#3b82f6",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#f97316",
  "#84cc16",
  "#ec4899",
  "#6366f1",
];

/** Widgets de engine.py, dans l'ordre d'enregistrement du registre. */
export function fournisseursMoteur(): Fournisseur[] {
  const valeur = (value: unknown, unit: string, color: string, icon: string, autres: Dict = {}): Dict => ({
    value,
    unit,
    color,
    icon,
    ...autres,
  });
  return [
    fournisseur({
      id: "kpi_users",
      title: "Utilisateurs",
      type: "value",
      width: "1/4",
      icon: "ph-users",
      color: "blue",
      category: "activity",
      getData: async (c) =>
        valeur(await compter(c.base, "SELECT COUNT(*) FROM users"), "comptes", "blue", "ph-users"),
    }),
    fournisseur({
      id: "kpi_dau",
      title: "Utilisateurs actifs",
      type: "value",
      width: "1/4",
      icon: "ph-user-circle",
      color: "emerald",
      category: "activity",
      eventTypes: ["message_sent"],
      getData: async (c, s) => {
        const h = scopeHours(s);
        return valeur(
          await distinctUsers(c.base, h),
          `actifs / ${scopeLabel(h)}`,
          "emerald",
          "ph-user-circle",
        );
      },
    }),
    fournisseur({
      id: "kpi_wau",
      title: "Actifs (7j)",
      type: "value",
      width: "1/4",
      icon: "ph-users-three",
      color: "emerald",
      category: "activity",
      eventTypes: ["message_sent"],
      getData: async (c) =>
        valeur(await distinctUsers(c.base, 24 * 7), "users / 7j", "emerald", "ph-users-three"),
    }),
    fournisseur({
      id: "kpi_mau",
      title: "Actifs (30j)",
      type: "value",
      width: "1/4",
      icon: "ph-users-four",
      color: "emerald",
      category: "activity",
      eventTypes: ["message_sent"],
      getData: async (c) =>
        valeur(await distinctUsers(c.base, 24 * 30), "users / 30j", "emerald", "ph-users-four"),
    }),
    fournisseur({
      id: "kpi_chats",
      title: "Conversations actives",
      type: "value",
      width: "1/4",
      icon: "ph-chat-dots",
      color: "purple",
      category: "activity",
      getData: async (c) =>
        valeur(
          await compter(c.base, "SELECT COUNT(*) FROM chats WHERE archived=0"),
          "actives",
          "purple",
          "ph-chat-dots",
        ),
    }),
    fournisseur({
      id: "kpi_new_chats",
      title: "Nouveaux chats",
      type: "value",
      width: "1/4",
      icon: "ph-plus-circle",
      color: "violet",
      category: "activity",
      eventTypes: ["new_chat"],
      getData: async (c) =>
        valeur(await countMetric(c.base, "new_chat"), "chats/24h", "violet", "ph-plus-circle"),
    }),
    fournisseur({
      id: "kpi_logins",
      title: "Connexions",
      type: "value",
      width: "1/4",
      icon: "ph-sign-in",
      color: "blue",
      category: "activity",
      eventTypes: ["user_login"],
      getData: async (c) =>
        valeur(await countMetric(c.base, "user_login"), "logins/24h", "blue", "ph-sign-in"),
    }),
    fournisseur({
      id: "kpi_groups",
      title: "Groupes",
      type: "value",
      width: "1/4",
      icon: "ph-users-three",
      color: "teal",
      category: "activity",
      getData: async (c) => {
        let n: number;
        try {
          n = await compter(c.base, 'SELECT COUNT(*) FROM "groups"');
        } catch {
          n = 0;
        }
        return valeur(n, "groupes", "teal", "ph-users-three");
      },
    }),
    fournisseur({
      id: "kpi_archived",
      title: "Chats archivés",
      type: "value",
      width: "1/4",
      icon: "ph-archive",
      color: "slate",
      category: "activity",
      getData: async (c) =>
        valeur(
          await compter(c.base, "SELECT COUNT(*) FROM chats WHERE archived=1"),
          "archivés",
          "slate",
          "ph-archive",
        ),
    }),
    fournisseur({
      id: "kpi_messages",
      title: "Messages",
      type: "value",
      width: "1/4",
      icon: "ph-chat-text",
      color: "sky",
      category: "volume",
      eventTypes: ["message_sent"],
      getData: async (c, s) => {
        const h = scopeHours(s);
        return valeur(
          await countMetric(c.base, "message_sent", h),
          `messages / ${scopeLabel(h)}`,
          "sky",
          "ph-chat-text",
        );
      },
    }),
    fournisseur({
      id: "kpi_avg_msgs_per_chat",
      title: "Msgs / chat (moy.)",
      type: "value",
      width: "1/4",
      icon: "ph-conversation",
      color: "sky",
      category: "volume",
      eventTypes: ["message_sent", "new_chat"],
      getData: async (c) => {
        let moyenne: unknown;
        try {
          const tableau = c.base.dialecte === "postgres" ? "messages_json::json" : "messages_json";
          const [r] = await c.base.valeurs(`SELECT AVG(json_array_length(${tableau})) FROM chats`);
          const v = r?.[0];
          moyenne = typeof v === "number" && v ? flt(arrondiPy(v, 1)) : 0;
        } catch {
          moyenne = 0;
        }
        return valeur(moyenne, "msgs/chat", "sky", "ph-conversation");
      },
    }),
    fournisseur({
      id: "kpi_sandbox_writes",
      title: "Fichiers écrits",
      type: "value",
      width: "1/4",
      icon: "ph-file-code",
      color: "emerald",
      category: "volume",
      eventTypes: ["sandbox_write"],
      getData: async (c) =>
        valeur(await countMetric(c.base, "sandbox_write"), "fichiers/24h", "emerald", "ph-file-code"),
    }),
    fournisseur({
      id: "kpi_tool_calls",
      title: "Appels outils",
      type: "value",
      width: "1/4",
      icon: "ph-wrench",
      color: "amber",
      category: "volume",
      eventTypes: ["tool_call"],
      getData: async (c) =>
        valeur(await countMetric(c.base, "tool_call"), "appels/24h", "amber", "ph-wrench"),
    }),
    fournisseur({
      id: "kpi_rag_hits",
      title: "Requêtes RAG",
      type: "value",
      width: "1/4",
      icon: "ph-database",
      color: "cyan",
      category: "volume",
      eventTypes: ["rag_hit"],
      getData: async (c) =>
        valeur(await countMetric(c.base, "rag_hit"), "requêtes/24h", "cyan", "ph-database"),
    }),
    fournisseur({
      id: "kpi_model_loads",
      title: "Chargements modèle",
      type: "value",
      width: "1/4",
      icon: "ph-upload",
      color: "blue",
      category: "volume",
      eventTypes: ["model_load"],
      getData: async (c) => valeur(await countMetric(c.base, "model_load"), "loads/24h", "blue", "ph-upload"),
    }),
    fournisseur({
      id: "kpi_total_messages",
      title: "Messages totaux",
      type: "value",
      width: "1/4",
      icon: "ph-chats",
      color: "emerald",
      category: "volume",
      eventTypes: ["message_sent"],
      getData: async (c) => {
        const n = await compter(c.base, "SELECT COUNT(*) FROM metric_events WHERE event_type='message_sent'");
        return valeur(n >= 1000 ? `${fixePy(n / 1000, 1)}k` : String(n), "messages", "emerald", "ph-chats");
      },
    }),
    fournisseur({
      id: "kpi_avg_tps",
      title: "Vitesse moy.",
      type: "value",
      width: "1/4",
      icon: "ph-speedometer",
      color: "orange",
      category: "performance",
      eventTypes: ["write_tps"],
      getData: async (c, s) => {
        const h = scopeHours(s);
        return valeur(await avgMetric(c.base, "write_tps", h), "tokens/s", "orange", "ph-speedometer", {
          detail: `moyenne sur ${scopeLabel(h)}`,
        });
      },
    }),
    fournisseur({
      id: "kpi_latency",
      title: "Latence moy. LLM",
      type: "value",
      width: "1/4",
      icon: "ph-timer",
      color: "rose",
      category: "performance",
      eventTypes: ["llm_latency"],
      getData: async (c) => valeur(await avgMetric(c.base, "llm_latency"), "sec/réponse", "rose", "ph-timer"),
    }),
    fournisseur({
      id: "kpi_latency_p95",
      title: "Latence P95",
      type: "value",
      width: "1/4",
      icon: "ph-arrow-up-right",
      color: "rose",
      category: "performance",
      eventTypes: ["llm_latency"],
      getData: async (c, s) => {
        const h = scopeHours(s);
        return valeur(
          await percentileMetric(c.base, "llm_latency", h, 95),
          "sec (95e)",
          "rose",
          "ph-arrow-up-right",
          {
            detail: `sur ${scopeLabel(h)}`,
          },
        );
      },
    }),
    fournisseur({
      id: "kpi_latency_p99",
      title: "Latence P99",
      type: "value",
      width: "1/4",
      icon: "ph-warning",
      color: "red",
      category: "performance",
      eventTypes: ["llm_latency"],
      getData: async (c) =>
        valeur(await percentileMetric(c.base, "llm_latency", 24, 99), "sec (99e)", "red", "ph-warning"),
    }),
    fournisseur({
      id: "kpi_llm_wait",
      title: "Attente d'un créneau LLM",
      type: "value",
      width: "1/4",
      icon: "ph-hourglass-medium",
      color: "amber",
      category: "performance",
      eventTypes: ["llm_wait_time_ms"],
      getData: async (c, s) => {
        const h = scopeHours(s);
        const p95 = await percentileMetric(c.base, "llm_wait_time_ms", h, 95);
        return valeur(
          await avgMetric(c.base, "llm_wait_time_ms", h),
          "ms (moy.)",
          "amber",
          "ph-hourglass-medium",
          {
            detail: `P95 ${arrondiEntierPy(Number(p95))} ms · attentes non nulles sur ${scopeLabel(h)}`,
          },
        );
      },
    }),
    fournisseur({
      id: "kpi_kv_prefix_reuse",
      title: "Réutilisation du cache KV",
      type: "value",
      width: "1/4",
      icon: "ph-recycle",
      color: "emerald",
      category: "performance",
      eventTypes: ["kv_prefix_reuse_pct"],
      getData: async (c, s) => {
        const h = scopeHours(s);
        return valeur(
          await avgMetric(c.base, "kv_prefix_reuse_pct", h, false),
          "% du prompt",
          "emerald",
          "ph-recycle",
          {
            detail: `moyenne des pré-remplissages sur ${scopeLabel(h)}`,
          },
        );
      },
    }),
    fournisseur({
      id: "kpi_top_model",
      title: "Modèle dominant",
      type: "value",
      width: "1/4",
      icon: "ph-robot",
      color: "indigo",
      category: "performance",
      getData: async (c, s) => {
        const hours = entierOu(veritePy(s) ? s : 24, 24);
        const [row] = await c.base.valeurs(
          `SELECT model, COUNT(*) AS c FROM usage_events
                   WHERE ts > ? AND model NOT IN ('', 'rag', 'RAG')
                   GROUP BY model ORDER BY c DESC LIMIT 1`,
          [maintenant() - hours * 3600],
        );
        const brut = row?.[0];
        const nom = row && veritePy(brut) ? (strPy(brut).split("/").pop() ?? "") : "—";
        return valeur(nomCourt(nom), "modèle dominant", "indigo", "ph-robot");
      },
    }),
    fournisseur({
      id: "kpi_llm_status",
      title: "LLM Server",
      type: "value",
      width: "1/4",
      icon: "ph-hard-drives",
      color: "blue",
      category: "performance",
      getData: async (c) => {
        try {
          const h = await c.santeLlm();
          if (!veritePy(h["server_reachable"]))
            return {
              value: "Hors ligne",
              unit: "serveur",
              color: "red",
              icon: "ph-hard-drives",
              state: "danger",
            };
          const modeles = Object.hasOwn(h, "models_loaded") ? h["models_loaded"] : [];
          let nom = "—";
          if (veritePy(modeles)) {
            const premier = (modeles as unknown[])[0];
            const id = estDict(premier) && Object.hasOwn(premier, "id") ? premier["id"] : undefined;
            if (typeof id !== "string") throw new Error("models_loaded illisible");
            nom = id.split("/").pop() ?? "";
          }
          return {
            value: nomCourt(nom),
            unit: Object.hasOwn(h, "status") ? h["status"] : "ok",
            color: "emerald",
            icon: "ph-hard-drives",
          };
        } catch {
          return { value: "Erreur", unit: "serveur", color: "red", icon: "ph-hard-drives", state: "danger" };
        }
      },
    }),
    fournisseur({
      id: "kpi_disk",
      title: "Disque",
      type: "value",
      width: "1/4",
      icon: "ph-hard-drive",
      color: "amber",
      category: "system",
      getData: async (c) => {
        const d = c.systeme.diskUsage("/");
        return {
          value: reprFlottant(arrondiPy(d.used / GO, 1)),
          unit: `/ ${reprFlottant(arrondiPy(d.total / GO, 1))} Go`,
          color: d.percent < 80 ? "amber" : "red",
          icon: "ph-hard-drive",
          state: fillState(d.percent),
        };
      },
    }),
    fournisseur({
      id: "kpi_ram",
      title: "RAM",
      type: "value",
      width: "1/4",
      icon: "ph-memory",
      color: "purple",
      category: "system",
      getData: async (c) => {
        const m = c.systeme.virtualMemory();
        return {
          value: reprFlottant(arrondiPy(m.used / GO, 1)),
          unit: `/ ${reprFlottant(arrondiPy(m.total / GO, 1))} Go`,
          color: m.percent < 80 ? "purple" : "red",
          icon: "ph-memory",
          state: fillState(m.percent),
        };
      },
    }),
    fournisseur({
      id: "kpi_db_size",
      title: "Base de données",
      type: "value",
      width: "1/4",
      icon: "ph-database",
      color: "cyan",
      category: "system",
      getData: async (c) => taille(c.systeme.tailleBase(), "cyan", "ph-database"),
    }),
    fournisseur({
      id: "kpi_sandbox_storage",
      title: "Stockage sandbox",
      type: "value",
      width: "1/4",
      icon: "ph-folder",
      color: "orange",
      category: "system",
      getData: async (c) => {
        let n: number;
        try {
          n = c.systeme.tailleDossier(config.SANDBOX_DIR);
        } catch {
          n = 0;
        }
        return taille(n, "orange", "ph-folder");
      },
    }),
    fournisseur({
      id: "kpi_uptime",
      title: "Uptime application",
      type: "value",
      width: "1/4",
      icon: "ph-clock-clockwise",
      color: "teal",
      category: "system",
      getData: async (c) => {
        try {
          const secs = Math.trunc(maintenant() - c.systeme.createTime());
          const d = Math.floor(secs / 86400);
          const h = Math.floor((secs - d * 86400) / 3600);
          const m = Math.floor((secs - d * 86400 - h * 3600) / 60);
          const label = d > 0 ? `${d}j ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
          return { value: label, unit: "depuis le démarrage", color: "teal", icon: "ph-clock-clockwise" };
        } catch {
          return { value: "—", unit: "depuis le démarrage", color: "slate", icon: "ph-clock-clockwise" };
        }
      },
    }),
    fournisseur({
      id: "system_load",
      title: "Charge Système Live — CPU / RAM (10 min)",
      type: "line",
      width: "full",
      getData: async (c) => {
        const h = [...c.historique()];
        let logiques: number;
        let physiques: number;
        let ramGo: unknown;
        let ghz: unknown;
        try {
          logiques = c.systeme.cpuCountLogical() || 1;
          physiques = c.systeme.cpuCountCores() || logiques;
          ramGo = flt(arrondiPy(c.systeme.virtualMemory().total / GO, 1));
          const f = c.systeme.cpuFreq();
          ghz = f && f.current ? flt(arrondiPy(f.current / 1000, 2)) : null;
        } catch {
          logiques = physiques = 0;
          ramGo = 0;
          ghz = null;
        }
        const freq = ghz !== null && Number(ghz) ? ` @ ${String(ghz)} GHz` : "";
        return {
          title: `Charge Système Live — ${physiques}c/${logiques}t${freq} · ${String(ramGo)} Go RAM (10 min)`,
          host: { cores_logical: logiques, cores_physical: physiques, ram_total_gb: ramGo, cpu_ghz: ghz },
          labels: h.map((p) => p.time),
          datasets: [
            {
              label: "CPU %",
              data: h.map((p) => flt(p.cpu)),
              borderColor: "#3b82f6",
              backgroundColor: "rgba(59,130,246,0.08)",
              borderWidth: 2,
              tension: 0.4,
              fill: true,
              pointRadius: 0,
            },
            {
              label: "RAM %",
              data: h.map((p) => flt(p.ram)),
              borderColor: "#8b5cf6",
              backgroundColor: "rgba(139,92,246,0.08)",
              borderWidth: 2,
              tension: 0.4,
              fill: true,
              pointRadius: 0,
            },
          ],
        };
      },
    }),
    fournisseur({
      id: "disk_io",
      title: "Disque I/O Live (Mo/s)",
      type: "line",
      width: "full",
      getData: async (c) => {
        const h = [...c.historique()];
        return {
          labels: h.map((p) => p.time),
          datasets: [
            {
              label: "Lecture Mo/s",
              data: h.map((p) => flt(p.disk_read)),
              borderColor: "#10b981",
              backgroundColor: "rgba(16,185,129,0.08)",
              borderWidth: 2,
              tension: 0.4,
              fill: true,
              pointRadius: 0,
            },
            {
              label: "Écriture Mo/s",
              data: h.map((p) => flt(p.disk_write)),
              borderColor: "#ef4444",
              backgroundColor: "rgba(239,68,68,0.08)",
              borderWidth: 2,
              tension: 0.4,
              fill: true,
              pointRadius: 0,
            },
          ],
        };
      },
    }),
    fournisseur({
      id: "proc_live",
      title: "Process worker — RSS Mo / fd ouverts (live, 10 min)",
      type: "line",
      width: "full",
      category: "system",
      getData: async (c) => {
        const h = [...c.historique()];
        return {
          labels: h.map((p) => p.time),
          datasets: [
            {
              label: "RSS Mo",
              data: h.map((p) => flt(p.rss_mb)),
              borderColor: "#8b5cf6",
              backgroundColor: "rgba(139,92,246,0.08)",
              borderWidth: 2,
              tension: 0.4,
              fill: true,
              pointRadius: 0,
            },
            {
              label: "fd ouverts",
              data: h.map((p) => p.num_fds),
              borderColor: "#f59e0b",
              backgroundColor: "rgba(245,158,11,0.08)",
              borderWidth: 2,
              tension: 0.4,
              fill: false,
              pointRadius: 0,
            },
            {
              label: "threads",
              data: h.map((p) => p.num_threads),
              borderColor: "#10b981",
              backgroundColor: "rgba(16,185,129,0.08)",
              borderWidth: 2,
              tension: 0.4,
              fill: false,
              pointRadius: 0,
            },
          ],
        };
      },
    }),
    fournisseur({
      id: "proc_resources",
      title: "Process — RSS Mo / fd / threads (tendance 7j, pire worker)",
      type: "line",
      width: "full",
      category: "system",
      getData: (c) =>
        procTrendChart(c.base, [
          ["proc_rss_mb", "RSS Mo", "139,92,246", true],
          ["proc_num_fds", "fd ouverts", "245,158,11", false],
          ["proc_num_threads", "threads", "16,185,129", false],
        ]),
    }),
    fournisseur({
      id: "proc_app_counters",
      title: "Process — tasks chat / PTY / SSE / bg / routines (tendance 7j)",
      type: "line",
      width: "full",
      category: "system",
      getData: (c) =>
        procTrendChart(c.base, [
          ["proc_active_chat_tasks", "tasks chat", "59,130,246", false],
          ["proc_pty_terminals", "PTY", "239,68,68", false],
          ["proc_sse_clients", "clients SSE", "16,185,129", false],
          ["proc_bg_tasks", "bg tasks", "245,158,11", false],
          ["proc_routine_tasks", "routines", "168,85,247", false],
          ["proc_sqlite_wal_mb", "WAL Mo", "6,182,212", true],
        ]),
    }),
    fournisseur({
      id: "write_tps_history",
      title: "Vitesse tokens/s (24h)",
      type: "line",
      width: "1/2",
      eventTypes: ["write_tps"],
      getData: async (c) => {
        const rows = await moyenneHoraire(c.base, "write_tps", 1, true);
        return {
          labels: rows.map((r) => r[0]),
          datasets: [
            ligneDonnees(
              "t/s moyen",
              rows.map((r) => flottantOuNul(r[1])),
              "#f97316",
              "rgba(249,115,22,0.1)",
              3,
            ),
          ],
        };
      },
    }),
    fournisseur({
      id: "llm_latency_history",
      title: "Latence LLM/heure (sec)",
      type: "line",
      width: "1/2",
      eventTypes: ["llm_latency"],
      getData: async (c) => {
        const rows = await moyenneHoraire(c.base, "llm_latency", 2, true);
        return {
          labels: rows.map((r) => r[0]),
          datasets: [
            ligneDonnees(
              "Latence (s)",
              rows.map((r) => flottantOuNul(r[1])),
              "#ec4899",
              "rgba(236,72,153,0.1)",
              3,
            ),
          ],
        };
      },
    }),
    fournisseur({
      id: "latency_percentiles",
      title: "Latence LLM — percentiles",
      type: "bar",
      width: "1/2",
      eventTypes: ["llm_latency"],
      getData: async (c, s) => {
        const h = scopeHours(s);
        const ps = [50, 75, 95, 99];
        const vals: unknown[] = [];
        for (const p of ps) vals.push(await percentileMetric(c.base, "llm_latency", h, p));
        return {
          labels: ps.map((p) => `P${p}`),
          datasets: [
            {
              label: "Secondes",
              data: vals,
              backgroundColor: ["#10b981", "#3b82f6", "#f59e0b", "#ef4444"],
              borderRadius: 6,
            },
          ],
        };
      },
    }),
    fournisseur({
      id: "rag_usage",
      title: "Requêtes RAG/heure (24h)",
      type: "bar",
      width: "1/2",
      eventTypes: ["rag_hit"],
      getData: (c) => hourlyChart(c.base, "rag_hit", "Requêtes RAG", "6,182,212"),
    }),
    fournisseur({
      id: "code_write_time",
      title: "Temps écriture fichiers (24h)",
      type: "line",
      width: "1/2",
      eventTypes: ["code_write_time"],
      getData: async (c) => {
        const rows = await moyenneHoraire(c.base, "code_write_time", 2, false);
        return {
          labels: rows.map((r) => r[0]),
          datasets: [
            ligneDonnees(
              "sec/fichier",
              rows.map((r) => flottantOuNul(r[1])),
              "#10b981",
              "rgba(16,185,129,0.1)",
              4,
            ),
          ],
        };
      },
    }),
    fournisseur({
      id: "chats_per_day",
      title: "Nouveaux chats/jour (7j)",
      type: "line",
      width: "1/2",
      eventTypes: ["new_chat"],
      getData: (c) => dailyChart(c.base, "new_chat", "Nouveaux chats", "99,102,241", 7, "line"),
    }),
    fournisseur({
      id: "messages_per_day",
      title: "Messages/jour (7j)",
      type: "bar",
      width: "1/2",
      eventTypes: ["message_sent"],
      getData: (c) => dailyChart(c.base, "message_sent", "Messages", "99,102,241"),
    }),
    fournisseur({
      id: "sandbox_writes_history",
      title: "Fichiers sandbox/jour (7j)",
      type: "bar",
      width: "1/2",
      eventTypes: ["sandbox_write"],
      getData: (c) => dailyChart(c.base, "sandbox_write", "Fichiers", "16,185,129"),
    }),
    fournisseur({
      id: "sandbox_writes_ext",
      title: "Fichiers par extension (7j)",
      type: "doughnut",
      width: "1/4",
      eventTypes: ["sandbox_write"],
      getData: async (c) => {
        const ext = jsonGet("tags_json", "ext", c.base.dialecte);
        const rows = await c.base.valeurs(
          `SELECT ${ext} as e, COUNT(*) as c
                FROM metric_events WHERE event_type='sandbox_write' AND created_at>?
                AND ${ext} IS NOT NULL GROUP BY e ORDER BY c DESC LIMIT 8`,
          [maintenant() - 604800],
        );
        return {
          labels: rows.map((r) => (veritePy(r[0]) ? "." + strPy(r[0]) : "autre")),
          datasets: [{ data: rows.map((r) => r[1]), backgroundColor: COULEURS_EXT.slice(0, rows.length) }],
        };
      },
    }),
    fournisseur({
      id: "sandbox_writes_user",
      title: "Fichiers par utilisateur (7j)",
      type: "bar",
      width: "1/2",
      eventTypes: ["sandbox_write"],
      getData: async (c) => {
        const user = jsonGet("tags_json", "user", c.base.dialecte);
        const rows = await c.base.valeurs(
          `SELECT ${user} as u, COUNT(*) as c
                FROM metric_events WHERE event_type='sandbox_write' AND created_at>?
                AND ${user} IS NOT NULL GROUP BY u ORDER BY c DESC LIMIT 10`,
          [maintenant() - 604800],
        );
        return {
          labels: rows.map((r) => r[0]),
          datasets: [
            {
              label: "Fichiers",
              data: rows.map((r) => r[1]),
              backgroundColor: COULEURS_USER.slice(0, rows.length),
              borderRadius: 4,
            },
          ],
        };
      },
    }),
    fournisseur({
      id: "logins_per_day",
      title: "Connexions/jour (7j)",
      type: "bar",
      width: "1/2",
      eventTypes: ["user_login"],
      getData: (c) => dailyChart(c.base, "user_login", "Connexions", "59,130,246"),
    }),
    fournisseur({
      id: "active_users_day",
      title: "Utilisateurs actifs/jour (7j)",
      type: "line",
      width: "1/2",
      eventTypes: ["message_sent"],
      getData: async (c) => {
        const user = jsonGet("tags_json", "user", c.base.dialecte);
        const rows = await c.base.valeurs(
          `SELECT ${localStrftime("%d/%m", "created_at", c.base.dialecte)} as d,
                COUNT(DISTINCT ${user}) as c
                FROM metric_events WHERE event_type='message_sent' AND created_at>?
                AND ${user} IS NOT NULL GROUP BY d ORDER BY MIN(created_at) ASC`,
          [maintenant() - 604800],
        );
        return {
          labels: rows.map((r) => r[0]),
          datasets: [
            ligneDonnees(
              "Actifs",
              rows.map((r) => r[1]),
              "#10b981",
              "rgba(16,185,129,0.1)",
              4,
            ),
          ],
        };
      },
    }),
    fournisseur({
      id: "tools_usage",
      title: "Top Outils MCP (7j)",
      type: "doughnut",
      width: "1/4",
      eventTypes: ["tool_call"],
      getData: async (c) => {
        const rows = await c.base.valeurs(
          `SELECT ${jsonGet("tags_json", "tool", c.base.dialecte)} as t, COUNT(*) as c
                FROM metric_events WHERE event_type='tool_call' AND created_at>? GROUP BY t ORDER BY c DESC LIMIT 6`,
          [maintenant() - 604800],
        );
        return {
          labels: rows.map((r) => (veritePy(r[0]) ? r[0] : "?")),
          datasets: [
            {
              data: rows.map((r) => r[1]),
              backgroundColor: ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#06b6d4", "#8b5cf6"],
            },
          ],
        };
      },
    }),
    fournisseur({
      id: "messages_history_30d",
      title: "Messages échangés (30 jours)",
      type: "line",
      width: "1/2",
      eventTypes: ["message_sent"],
      getData: async (c) => {
        const rows = await c.base.valeurs(
          `SELECT ${localStrftime("%d/%m", "created_at", c.base.dialecte)} as d, COUNT(*) as c
                FROM metric_events WHERE event_type='message_sent' AND created_at>?
                GROUP BY d ORDER BY MIN(created_at) ASC`,
          [maintenant() - 30 * 86400],
        );
        return {
          labels: rows.map((r) => r[0]),
          datasets: [
            ligneDonnees(
              "Messages",
              rows.map((r) => r[1]),
              "#3b82f6",
              "rgba(59,130,246,0.1)",
              3,
            ),
          ],
        };
      },
    }),
    fournisseur({
      id: "chat_lifecycle",
      title: "Chats : création vs archivage (30j)",
      type: "line",
      width: "1/2",
      eventTypes: ["new_chat"],
      getData: async (c) => {
        const cutoff = maintenant() - 30 * 86400;
        const nouveaux = new Map<string, unknown>();
        for (const r of await c.base.valeurs(
          `SELECT ${localStrftime("%d/%m", "created_at", c.base.dialecte)} as d, COUNT(*) as c
                FROM metric_events WHERE event_type='new_chat' AND created_at>?
                GROUP BY d ORDER BY MIN(created_at) ASC`,
          [cutoff],
        ))
          nouveaux.set(strPy(r[0]), r[1]);
        const archives = new Map<string, unknown>();
        try {
          for (const r of await c.base.valeurs(
            `SELECT ${localStrftime("%d/%m", "archived_at", c.base.dialecte)} as d, COUNT(*) as c
                    FROM chats WHERE archived=1 AND archived_at IS NOT NULL AND archived_at>?
                    GROUP BY d ORDER BY MIN(archived_at) ASC`,
            [cutoff],
          ))
            archives.set(strPy(r[0]), r[1]);
        } catch {
          archives.clear();
        }
        const labels = [...new Set([...nouveaux.keys(), ...archives.keys()])].sort(comparePointsDeCode);
        return {
          labels,
          datasets: [
            {
              label: "Créés",
              data: labels.map((d) => nouveaux.get(d) ?? 0),
              borderColor: "#10b981",
              backgroundColor: "rgba(16,185,129,0.1)",
              tension: 0.4,
              fill: true,
              borderWidth: 2,
              pointRadius: 3,
            },
            {
              label: "Archivés",
              data: labels.map((d) => archives.get(d) ?? 0),
              borderColor: "#94a3b8",
              backgroundColor: "rgba(148,163,184,0.1)",
              tension: 0.4,
              fill: false,
              borderWidth: 2,
              pointRadius: 3,
            },
          ],
        };
      },
    }),
    fournisseur({
      id: "storage_breakdown",
      title: "Stockage : répartition",
      type: "doughnut",
      width: "1/4",
      getData: async (c) => {
        const tailles: [string, number][] = [["Base de données", c.systeme.tailleBase()]];
        const auMieux = (f: () => number): number => {
          try {
            return f();
          } catch {
            return 0;
          }
        };
        tailles.push(["Sandboxes", auMieux(() => c.systeme.tailleDossier(config.SANDBOX_DIR))]);
        tailles.push([
          "Uploads",
          auMieux(() => {
            const app = readConfigJsonSur()["app"];
            const cfg = veritePy(app) ? app : {};
            if (!estDict(cfg)) throw new Error("app n'est pas un dict");
            const dossier = Object.hasOwn(cfg, "upload_dir") ? cfg["upload_dir"] : "user_db/uploads";
            return c.systeme.tailleDossier(strPy(dossier));
          }),
        ]);
        tailles.push(["Logs", auMieux(() => c.systeme.tailleDossier("user_db/logs"))]);
        return {
          labels: tailles.map(([l]) => l),
          datasets: [
            {
              data: tailles.map(([, v]) => flt(arrondiPy(v / MO, 2))),
              backgroundColor: ["#06b6d4", "#f97316", "#8b5cf6", "#94a3b8"],
              label: "Mo",
            },
          ],
        };
      },
    }),
  ];
}

/** `(read_config_json() or {})` : config.json illisible = dict vide. */
function readConfigJsonSur(): Dict {
  try {
    return readConfigJson();
  } catch {
    return {};
  }
}
