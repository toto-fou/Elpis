// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/prometheus.ts — exposition Prometheus de `/api/admin/metrics/prometheus` : jauges de la base, de l'usage par fenêtre, du système, du process et du serveur LLM (routes/admin/metrics.py). */
import { timingSafeEqual } from "node:crypto";

import { arrondiPy, intPy, prefixePy, reprFlottant, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur, Valeur } from "@elpis/db";

import { lastHeartbeatAt } from "./echantillonneur";
import type { Echantillons } from "./echantillonneur";
import type { SystemeMetriques } from "./fournisseurs/base";
import { businessSql } from "./fournisseurs/usage";

const FENETRES: readonly (readonly [string, number])[] = [
  ["1d", 86400],
  ["7d", 7 * 86400],
  ["30d", 30 * 86400],
];

/** Jeton présenté (`Authorization: Bearer …`, sinon `?token=`) comparé à temps constant ; jamais journalisé. */
export function scrapeAutorise(
  jeton: string,
  authorization: string,
  tokenRequete: string | undefined,
): boolean {
  if (!jeton) return false;
  let presente = "";
  if (authorization.toLowerCase().startsWith("bearer ")) presente = stripPy(authorization.slice(7));
  if (!presente) presente = stripPy(tokenRequete ?? "");
  if (!presente) return false;
  const ascii = (t: string): boolean => [...t].every((c) => c.charCodeAt(0) < 0x80);
  if (!ascii(jeton) || !ascii(presente)) return false;
  const [a, b] = [Buffer.from(jeton), Buffer.from(presente)];
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** `_esc` : valeur de label sans antislash ni guillemet, « unknown » si vide, 120 caractères au plus. */
function echapper(v: unknown): string {
  return prefixePy(
    strPy(veritePy(v) ? v : "unknown")
      .replaceAll("\\", "")
      .replaceAll('"', ""),
    120,
  );
}

function entier(v: unknown): number {
  return intPy(veritePy(v) ? v : 0);
}

/** `round(x, n)` d'un flottant écrit comme Python, `0` entier pour une valeur absente ou nulle. */
function arrondiOuZero(v: unknown, n: number): string {
  return veritePy(v) ? reprFlottant(arrondiPy(Number(v), n)) : "0";
}

/** Âge (s) arrondi à 0,1 d'un horodatage, `-1` s'il n'y en a pas. */
function age(maintenant: number, quand: unknown): string {
  return veritePy(quand) ? reprFlottant(arrondiPy(maintenant - Number(quand), 1)) : "-1";
}

export interface SourcesPrometheus {
  readonly base: Executeur;
  readonly systeme: Pick<SystemeMetriques, "virtualMemory" | "diskUsage">;
  readonly cpuPourcent: () => number;
  readonly echantillons: Echantillons;
  readonly pid: number;
  readonly santeLlm: () => Promise<Dict>;
}

async function jaugesBase(x: Executeur, lignes: string[]): Promise<void> {
  const un = async (sql: string, params: Valeur[] = []): Promise<unknown> =>
    ((await x.valeurs(sql, params))[0] ?? [])[0];
  const maintenant = (): number => Date.now() / 1000;
  const jauge = (nom: string, aide: string, valeur: string): void => {
    lignes.push(`# HELP ${nom} ${aide}`, `# TYPE ${nom} gauge`, `${nom} ${valeur}`);
  };
  jauge("elpis_users_total", "Total registered users", strPy(await un("SELECT COUNT(*) FROM users")));
  jauge(
    "elpis_chats_active",
    "Total active chats",
    strPy(await un("SELECT COUNT(*) FROM chats WHERE archived=0")),
  );
  jauge(
    "elpis_messages_total",
    "Total assistant messages",
    strPy(
      await un(`
            SELECT COUNT(*) FROM metric_events
            WHERE event_type='message_sent'
              AND tags_json LIKE '%"role": "assistant"%'
        `),
    ),
  );
  const depuis24h = maintenant() - 86400;
  const depuis1h = maintenant() - 3600;
  const tps = await un("SELECT AVG(value) FROM metric_events WHERE event_type='write_tps' AND created_at>?", [
    depuis1h,
  ]);
  jauge("elpis_avg_tps", "Average tokens per second (1h)", arrondiOuZero(tps, 2));
  const latence = await un(
    "SELECT AVG(value) FROM metric_events WHERE event_type='llm_latency' AND created_at>?",
    [depuis1h],
  );
  jauge("elpis_avg_latency_seconds", "Average LLM latency in seconds (1h)", arrondiOuZero(latence, 3));
  jauge(
    "elpis_rag_hits_24h",
    "RAG queries in last 24 hours",
    strPy(
      await un("SELECT COUNT(*) FROM metric_events WHERE event_type='rag_hit' AND created_at>?", [depuis24h]),
    ),
  );
  jauge(
    "elpis_tool_calls_24h",
    "Tool calls in last 24 hours",
    strPy(
      await un("SELECT COUNT(*) FROM metric_events WHERE event_type='tool_call' AND created_at>?", [
        depuis24h,
      ]),
    ),
  );
  for (const [nom, aide] of [
    ["elpis_tokens_total", "Tokens consumed over the window"],
    ["elpis_turns_total", "LLM turns over the window"],
    ["elpis_tokens_by_model", "Tokens per model over the window"],
    ["elpis_tokens_by_source", "Tokens per source over the window"],
    ["elpis_turns_by_source", "LLM turns per source over the window"],
    ["elpis_turns_by_status", "LLM turns per outcome over the window"],
    ["elpis_tokens_offhours", "Tokens produced outside business hours"],
  ])
    lignes.push(`# HELP ${nom} ${aide}`, `# TYPE ${nom} gauge`);
  const hors = `NOT ${businessSql(x.dialecte)}`;
  for (const [fenetre, secondes] of FENETRES) {
    const depuis = maintenant() - secondes;
    const [t] = await x.valeurs(
      "SELECT COALESCE(SUM(input_tokens+output_tokens),0), COUNT(*), " +
        `COALESCE(SUM(CASE WHEN ${hors} THEN input_tokens+output_tokens ` +
        "ELSE 0 END),0) FROM usage_events WHERE ts>?",
      [depuis],
    );
    const totaux = t ?? [0, 0, 0];
    lignes.push(`elpis_tokens_total{window="${fenetre}"} ${entier(totaux[0])}`);
    lignes.push(`elpis_turns_total{window="${fenetre}"} ${entier(totaux[1])}`);
    lignes.push(`elpis_tokens_offhours{window="${fenetre}"} ${entier(totaux[2])}`);
    for (const r of await x.valeurs(
      "SELECT model, COALESCE(SUM(input_tokens+output_tokens),0) FROM usage_events WHERE ts>? GROUP BY model",
      [depuis],
    ))
      lignes.push(`elpis_tokens_by_model{window="${fenetre}",model="${echapper(r[0])}"} ${entier(r[1])}`);
    for (const r of await x.valeurs(
      "SELECT source, COALESCE(SUM(input_tokens+output_tokens),0), COUNT(*) " +
        "FROM usage_events WHERE ts>? GROUP BY source",
      [depuis],
    )) {
      const source = echapper(r[0]);
      lignes.push(`elpis_tokens_by_source{window="${fenetre}",source="${source}"} ${entier(r[1])}`);
      lignes.push(`elpis_turns_by_source{window="${fenetre}",source="${source}"} ${entier(r[2])}`);
    }
    for (const r of await x.valeurs("SELECT status, COUNT(*) FROM usage_events WHERE ts>? GROUP BY status", [
      depuis,
    ]))
      lignes.push(`elpis_turns_by_status{window="${fenetre}",status="${echapper(r[0])}"} ${entier(r[1])}`);
  }
  lignes.push(
    "# HELP elpis_routine_runs Routine runs per status over the window",
    "# TYPE elpis_routine_runs gauge",
  );
  for (const [fenetre, secondes] of FENETRES)
    for (const r of await x.valeurs(
      "SELECT status, COUNT(*) FROM editor_routine_runs WHERE started_at>? GROUP BY status",
      [maintenant() - secondes],
    ))
      lignes.push(`elpis_routine_runs{window="${fenetre}",status="${echapper(r[0])}"} ${entier(r[1])}`);
  const vivant = await lastHeartbeatAt(x);
  lignes.push(
    "# HELP elpis_scheduler_last_seen_seconds Age of the last scheduler heartbeat (-1 = never)",
    "# TYPE elpis_scheduler_last_seen_seconds gauge",
    `elpis_scheduler_last_seen_seconds ${age(maintenant(), vivant)}`,
  );
  const entretien = await un("SELECT MAX(created_at) FROM metric_events WHERE event_type='maintenance_pass'");
  lignes.push(
    "# HELP elpis_maintenance_last_run_seconds Age of the last upkeep pass (-1 = never)",
    "# TYPE elpis_maintenance_last_run_seconds gauge",
    `elpis_maintenance_last_run_seconds ${age(maintenant(), entretien)}`,
  );
  const sautees = await un(
    "SELECT COALESCE(SUM(value),0) FROM metric_events WHERE event_type='scheduler_skip' AND created_at>?",
    [depuis24h],
  );
  lignes.push(
    "# HELP elpis_scheduler_skipped_minutes_24h Cron minutes never evaluated in last 24h",
    "# TYPE elpis_scheduler_skipped_minutes_24h gauge",
    `elpis_scheduler_skipped_minutes_24h ${entier(sautees)}`,
  );
}

/** Lignes du serveur LLM ; une santé illisible arrête la section là où Python lèverait. */
function jaugesLlm(h: Dict, lignes: string[]): void {
  lignes.push(
    "# HELP elpis_llm_server_up LLM server reachable",
    "# TYPE elpis_llm_server_up gauge",
    `elpis_llm_server_up ${veritePy(h["server_reachable"]) ? 1 : 0}`,
  );
  const kv = Object.hasOwn(h, "kv_cache") ? h["kv_cache"] : {};
  if (kv === null || typeof kv !== "object" || Array.isArray(kv)) throw new Error("kv_cache illisible");
  const k = kv as Dict;
  const total = Object.hasOwn(k, "total") ? k["total"] : 0;
  if (typeof total !== "number" || !(total > 0)) return;
  lignes.push("# HELP elpis_kv_cache_used KV cache slots used", "# TYPE elpis_kv_cache_used gauge");
  if (!Object.hasOwn(k, "used")) throw new Error("KeyError: 'used'");
  lignes.push(`elpis_kv_cache_used ${strPy(k["used"])}`);
  lignes.push(
    "# HELP elpis_kv_cache_total KV cache slots total",
    "# TYPE elpis_kv_cache_total gauge",
    `elpis_kv_cache_total ${strPy(total)}`,
  );
}

/** `api_admin_metrics_prometheus` : texte d'exposition ; une erreur de base devient une ligne `# Error`, le reste est toujours écrit. */
export async function textePrometheus(s: SourcesPrometheus): Promise<string> {
  const lignes = ["# HELP elpis_up Application is running", "# TYPE elpis_up gauge", "elpis_up 1"];
  try {
    await jaugesBase(s.base, lignes);
  } catch (e) {
    lignes.push(`# Error: ${e instanceof Error ? e.message : strPy(e)}`);
  }
  lignes.push("# HELP elpis_cpu_percent CPU usage percent", "# TYPE elpis_cpu_percent gauge");
  lignes.push(`elpis_cpu_percent ${reprFlottant(s.cpuPourcent())}`);
  const memoire = s.systeme.virtualMemory();
  lignes.push("# HELP elpis_memory_used_bytes Memory used in bytes", "# TYPE elpis_memory_used_bytes gauge");
  lignes.push(`elpis_memory_used_bytes ${memoire.used}`);
  lignes.push(
    "# HELP elpis_memory_total_bytes Total memory in bytes",
    "# TYPE elpis_memory_total_bytes gauge",
  );
  lignes.push(`elpis_memory_total_bytes ${memoire.total}`);
  const disque = s.systeme.diskUsage("/");
  lignes.push("# HELP elpis_disk_used_bytes Disk used in bytes", "# TYPE elpis_disk_used_bytes gauge");
  lignes.push(`elpis_disk_used_bytes ${disque.used}`);
  lignes.push("# HELP elpis_disk_total_bytes Disk total in bytes", "# TYPE elpis_disk_total_bytes gauge");
  lignes.push(`elpis_disk_total_bytes ${disque.total}`);
  lignes.push("# HELP elpis_proc Per-process resource & app counters (live)", "# TYPE elpis_proc gauge");
  for (const [nom, accesseur] of s.echantillons) {
    let valeur: number;
    try {
      valeur = Number(accesseur());
    } catch {
      continue;
    }
    lignes.push(`elpis_proc{metric="${nom}",pid="${s.pid}"} ${reprFlottant(valeur)}`);
  }
  await s
    .santeLlm()
    .then((h) => jaugesLlm(h, lignes))
    .catch(() => undefined);
  return lignes.join("\n") + "\n";
}
