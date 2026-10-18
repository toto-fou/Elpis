// SPDX-License-Identifier: MIT
/** apps/core/src/familles/metriques.ts — console Métriques de l'admin : tableau de bord, Prometheus et son jeton, export CSV, purge, rapport quotidien, observabilité des outils et de l'audit (routes/admin/metrics.py, routes/admin/observability.py). */
import { randomBytes } from "node:crypto";

import { exigerRole, ligneUtilisateur } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import {
  ErreurPython,
  floatPy,
  HttpError,
  intPy,
  prefixePy,
  reprFlottant,
  stripPy,
  strPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { readConfigJson, sousVerrouConfigJson, writeConfigJson } from "@elpis/config";
import { localDatetime, walCheckpoint } from "@elpis/db";
import type { Base, Executeur, Valeur } from "@elpis/db";
import { auditEvent, readRecentAuditLines } from "@elpis/securite";
import type { FastifyRequest } from "fastify";

import { journal } from "../journal";
import { echantillonsDuProcess } from "../observabilite/echantillonneur";
import type { Echantillons } from "../observabilite/echantillonneur";
import type { ContexteMetriques } from "../observabilite/fournisseurs/base";
import { scrapeAutorise, textePrometheus } from "../observabilite/prometheus";
import {
  aujourdhui,
  buildDailyReport,
  generateAndStoreDailyDigest,
  getDailyReport,
  listDailyReports,
} from "../observabilite/rapports";
import { registry as registreParDefaut } from "../observabilite/registre";
import type { MetricsRegistry } from "../observabilite/registre";
import { MesureCpu } from "../observabilite/sondes";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { analyserRequete, corpsJson, entrees, py, reponseJsonPy } from "@elpis/http";

const log = journal("metrics");

export interface DependancesMetriques {
  readonly base: Base;
  readonly auth: DependancesAuth;
  readonly contexte: ContexteMetriques;
  readonly registre?: MetricsRegistry;
  /** Session d'équipe exigée quand le jeton de scrape manque (401/403 comme `require_user_id` + rôle). */
  readonly exigerEquipe?: (req: FastifyRequest) => Promise<number>;
  readonly echantillons?: () => Echantillons;
  readonly cpuPourcent?: () => number;
  readonly pid?: number;
  /** `secrets.token_urlsafe(32)`. */
  readonly genererJeton?: () => string;
}

const PROCESSUS = ["admin"] as const;
const SANS_CACHE = { "cache-control": "no-cache" };
const SANS_STOCKAGE = { "cache-control": "no-store" };

/** Tables purgeables (liste fermée) et leur colonne de temps. */
const PURGEABLES: Readonly<Record<string, readonly [string, string]>> = {
  usage_events: ["usage_events", "ts"],
  metric_events: ["metric_events", "created_at"],
  tool_call_metrics: ["tool_call_metrics", "ts"],
  daily_usage_reports: ["daily_usage_reports", "created_at"],
  editor_routine_runs: ["editor_routine_runs", "started_at"],
};

function estDict(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `(body or {}).get(…)` : un corps vrai qui n'est pas un objet lève comme en Python (500). */
function corpsOuVide(corps: unknown): Dict {
  if (!veritePy(corps)) return {};
  if (!estDict(corps)) throw new ErreurPython("AttributeError", "object has no attribute 'get'");
  return corps;
}

/** `try: await request.json() except Exception: {}`. */
function corpsTolere(req: FastifyRequest): unknown {
  try {
    return corpsJson(req);
  } catch {
    return {};
  }
}

/** `_scrape_token` : jeton de scrape configuré, vide sinon. */
function jetonScrape(): string {
  try {
    const metrics = readConfigJson()["metrics"];
    const m = veritePy(metrics) ? metrics : {};
    if (!estDict(m)) return "";
    const jeton = m["scrape_token"];
    return stripPy(strPy(veritePy(jeton) ? jeton : ""));
  } catch {
    return "";
  }
}

async function nomDuCompte(base: Base, uid: number): Promise<string | null> {
  return (await ligneUtilisateur(base, uid))?.username ?? null;
}

/** `_purge_where` : clauses paramétrées, les seuls fragments interpolés viennent de la liste fermée. */
function clausePurge(cible: string, corps: Dict): [string, string, Valeur[]] {
  const [table, colonne] = PURGEABLES[cible] as readonly [string, string];
  const sql = ["1=1"];
  const params: Valeur[] = [];
  try {
    for (const [cle, op] of [
      ["from", ">="],
      ["to", "<="],
    ] as const) {
      const v = Object.hasOwn(corps, cle) ? corps[cle] : null;
      if (v === null || v === undefined) continue;
      sql.push(`${colonne} ${op} ?`);
      params.push(floatPy(v));
    }
  } catch {
    throw new HttpError(400, "Bornes temporelles invalides");
  }
  const types = corps["event_types"];
  if (cible === "metric_events" && Array.isArray(types) && types.length) {
    const noms = types.map((t) => prefixePy(strPy(t), 64)).slice(0, 40);
    sql.push(`event_type IN (${noms.map(() => "?").join(",")})`);
    params.push(...noms);
  }
  const sources = corps["sources"];
  if (cible === "usage_events" && Array.isArray(sources) && sources.length) {
    const noms = sources.map((s) => prefixePy(strPy(s), 32)).slice(0, 20);
    sql.push(`source IN (${noms.map(() => "?").join(",")})`);
    params.push(...noms);
  }
  return [table, sql.join(" AND "), params];
}

/** Comptes (et suppressions hors simulation) par cible ; une cible en échec compte 0. */
async function purger(x: Executeur, cibles: readonly string[], corps: Dict, simulation: boolean) {
  const comptes: Record<string, number> = {};
  const supprimees: Record<string, number> = {};
  for (const cible of cibles) {
    const [table, where, params] = clausePurge(cible, corps);
    try {
      const [r] = await x.valeurs(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, params);
      comptes[cible] = r ? intPy(r[0]) : 0;
      if (!simulation)
        supprimees[cible] = (await x.run(`DELETE FROM ${table} WHERE ${where}`, params)).changes || 0;
    } catch (e) {
      log.warn(`[metrics/purge] ${cible} : ${e instanceof Error ? e.message : strPy(e)}`);
      if (!Object.hasOwn(comptes, cible)) comptes[cible] = 0;
    }
  }
  return { comptes, supprimees };
}

/** `csv.writer` (dialecte excel) : champ cité s'il contient `,`, `"`, `\r` ou `\n`, guillemets doublés, lignes en `\r\n`. */
export function ligneCsvPy(champs: readonly unknown[]): string {
  const textes = champs.map((c) => (c === null || c === undefined ? "" : strPy(c)));
  return (
    textes
      .map((t, _i, tous) =>
        /[,"\r\n]/u.test(t) || (tous.length === 1 && t === "") ? `"${t.replaceAll('"', '""')}"` : t,
      )
      .join(",") + "\r\n"
  );
}

const COLONNES_USAGE = [
  "ts",
  "user_id",
  "source",
  "origin_id",
  "parent_id",
  "model",
  "connector",
  "path",
  "input_tokens",
  "output_tokens",
  "submitted_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "duration_ms",
  "iterations",
  "status",
  "error_kind",
  "thinking_tokens",
  "run_id",
];

/** `api_export_metrics` : CSV des événements ou du registre d'usage sur `days` jours (1 à 3650). */
async function exporterCsv(x: Executeur, cible: string, jours: number): Promise<string> {
  const depuis = Date.now() / 1000 - Math.max(1, Math.min(3650, jours)) * 86400;
  let colonnes: string[];
  let lignes: unknown[][];
  if (cible === "usage_events") {
    colonnes = COLONNES_USAGE;
    lignes = await x.valeurs(
      `SELECT ${localDatetime("ts", x.dialecte)} AS ts, ${colonnes.slice(1).join(", ")} FROM usage_events ` +
        "WHERE ts > ? ORDER BY ts ASC",
      [depuis],
    );
  } else {
    colonnes = ["event_type", "value", "tags", "user_id", "created_at"];
    lignes = (
      await x.valeurs(
        `
                SELECT event_type, value, tags_json, user_id,
                       ${localDatetime("created_at", x.dialecte)} as created_at
                FROM metric_events WHERE created_at > ?
                ORDER BY created_at ASC
            `,
        [depuis],
      )
    ).map(([type, valeur, ...reste]) => [
      type,
      typeof valeur === "number" ? reprFlottant(valeur) : valeur,
      ...reste,
    ]);
  }
  return [colonnes, ...lignes].map(ligneCsvPy).join("");
}

/** Dernière valeur d'un paramètre de requête (`QueryParams.get`). */
function parametre(req: FastifyRequest, nom: string): string | undefined {
  const brute = (req.raw.url ?? req.url).split("?").slice(1).join("?");
  return analyserRequete(brute)
    .filter(([k]) => k === nom)
    .at(-1)?.[1];
}

export function creerFamilleMetriques(dep: DependancesMetriques): Famille {
  const { base } = dep;
  const registre = dep.registre ?? registreParDefaut;
  const exigerEquipe = dep.exigerEquipe ?? ((req) => exigerRole(req, dep.auth, [1, 2], "Staff required"));
  const mesureCpu = new MesureCpu();
  const cpuPourcent = dep.cpuPourcent ?? (() => mesureCpu.pourcentage());
  const genererJeton = dep.genererJeton ?? (() => randomBytes(32).toString("base64url"));
  return {
    nom: "metriques",
    routes: [
      {
        methode: "GET",
        chemin: "/api/admin/stats-dynamic",
        processus: PROCESSUS,
        acces: "staff",
        traiter: async (req, rep) => {
          const { query } = entrees(req, {
            query: { scope_hours: py.int().defaut(24), ids: py.optional(py.str()).defaut(null) },
          });
          const portee = [24, 168, 720].includes(query.scope_hours) ? query.scope_hours : 24;
          void rep.headers(SANS_CACHE);
          if (query.ids) {
            const voulus = query.ids
              .split(",")
              .map((s) => stripPy(s))
              .filter((s) => s)
              .slice(0, 40);
            return { data: await registre.getWidgetsData(dep.contexte, voulus, portee), partial: true };
          }
          return registre.getDashboardConfig(dep.contexte, portee);
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/metrics/scrape-token",
        processus: PROCESSUS,
        acces: "admin",
        traiter: async (_req, rep) => {
          const jeton = jetonScrape();
          void rep.headers(SANS_STOCKAGE);
          return { configured: Boolean(jeton), token: jeton || null };
        },
      },
      {
        methode: "POST",
        chemin: "/api/admin/metrics/scrape-token",
        processus: PROCESSUS,
        acces: "admin",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const corps = corpsOuVide(corpsTolere(req));
          const brute = corps["action"];
          const action = strPy(veritePy(brute) ? brute : "generate");
          if (action !== "generate" && action !== "revoke") throw new HttpError(400, "Action inconnue");
          const jeton = action === "revoke" ? "" : genererJeton();
          await sousVerrouConfigJson(() => {
            const cfg = readConfigJson();
            if (!Object.hasOwn(cfg, "metrics")) cfg["metrics"] = {};
            const m = cfg["metrics"];
            if (!estDict(m))
              throw new ErreurPython("TypeError", "'metrics' does not support item assignment");
            m["scrape_token"] = jeton;
            writeConfigJson(cfg);
          });
          auditEvent({
            userId: uid,
            username: await nomDuCompte(base, uid),
            action: `admin.metrics.scrape_token.${action}`,
            details: {},
          });
          void rep.headers(SANS_STOCKAGE);
          return { configured: Boolean(jeton), token: jeton || null };
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/metrics/prometheus",
        processus: PROCESSUS,
        acces: "public",
        traiter: async (req, rep) => {
          const autorise = scrapeAutorise(
            jetonScrape(),
            strPy(req.headers.authorization ?? ""),
            parametre(req, "token"),
          );
          if (!autorise) await exigerEquipe(req);
          const texte = await textePrometheus({
            base,
            systeme: dep.contexte.systeme,
            cpuPourcent,
            echantillons: (dep.echantillons ?? echantillonsDuProcess)(),
            pid: dep.pid ?? process.pid,
            santeLlm: dep.contexte.santeLlm,
          });
          return rep.headers(SANS_CACHE).type("text/plain; version=0.0.4; charset=utf-8").send(texte);
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/export-metrics",
        processus: PROCESSUS,
        acces: "staff",
        traiter: async (req, rep) => {
          const { query } = entrees(req, {
            query: { days: py.int().defaut(7), target: py.str().defaut("metric_events") },
          });
          if (query.target !== "metric_events" && query.target !== "usage_events")
            throw new HttpError(400, "Cible d'export inconnue");
          const texte = await exporterCsv(base, query.target, query.days);
          const nom = `${query.target}_${query.days}j_${Math.trunc(Date.now() / 1000)}.csv`;
          return rep
            .header("content-disposition", `attachment; filename=${nom}`)
            .type("text/csv; charset=utf-8")
            .send(texte);
        },
      },
      {
        methode: "POST",
        chemin: "/api/admin/metrics/purge",
        processus: PROCESSUS,
        acces: "admin",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const corps = corpsTolere(req);
          if (!estDict(corps)) throw new HttpError(400, "Corps JSON attendu");
          const cibles = corps["targets"];
          if (!Array.isArray(cibles) || !cibles.length)
            throw new HttpError(400, "Aucune cible : précisez « targets »");
          if (cibles.some((c) => c !== null && typeof c === "object"))
            throw new ErreurPython("TypeError", "unhashable type");
          const inconnues = cibles.filter((c) => typeof c !== "string" || !Object.hasOwn(PURGEABLES, c));
          if (inconnues.length)
            throw new HttpError(400, `Cible inconnue : ${inconnues.slice(0, 3).map(strPy).join(", ")}`);
          const simulation = veritePy(Object.hasOwn(corps, "dry_run") ? corps["dry_run"] : true);
          const { comptes, supprimees } = simulation
            ? await purger(base, cibles as string[], corps, true)
            : await base.transaction((tx) => purger(tx, cibles as string[], corps, false));
          if (!simulation) {
            auditEvent({
              userId: uid,
              username: await nomDuCompte(base, uid),
              action: "admin.metrics.purge",
              details: {
                targets: cibles,
                deleted: supprimees,
                from: corps["from"] ?? null,
                to: corps["to"] ?? null,
                event_types: corps["event_types"] ?? null,
                sources: corps["sources"] ?? null,
              },
            });
            await walCheckpoint(base).catch(() => undefined);
          }
          void rep.headers(SANS_CACHE);
          return { dry_run: simulation, counted: comptes, deleted: supprimees };
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/report/daily",
        processus: PROCESSUS,
        acces: "staff",
        traiter: async (req, rep) => {
          const { query } = entrees(req, { query: { date: py.optional(py.str()).defaut(null) } });
          if (query.date) {
            const rapport = await getDailyReport(base, query.date);
            if (rapport === null) throw new HttpError(404, "Aucun rapport pour cette date");
            return reponseJsonPy(rep, rapport, SANS_CACHE);
          }
          const jour = aujourdhui();
          const stocke = await getDailyReport(base, jour);
          const rapport = veritePy(stocke)
            ? stocke
            : await buildDailyReport(dep.contexte, 24, jour, registre);
          return reponseJsonPy(rep, rapport, SANS_CACHE);
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/report/daily/list",
        processus: PROCESSUS,
        acces: "staff",
        traiter: async (req, rep) => {
          const { query } = entrees(req, { query: { limit: py.int().defaut(60) } });
          void rep.headers(SANS_CACHE);
          return { reports: await listDailyReports(base, Math.max(1, Math.min(366, query.limit))) };
        },
      },
      {
        methode: "POST",
        chemin: "/api/admin/report/daily/generate",
        processus: PROCESSUS,
        acces: "admin",
        traiter: async () => ({
          ok: true,
          date: await generateAndStoreDailyDigest(base, dep.contexte, null, true),
        }),
      },
      {
        methode: "GET",
        chemin: "/api/admin/report/daily/auto",
        processus: PROCESSUS,
        acces: "staff",
        traiter: async (_req, rep) => {
          const cfg = readConfigJson();
          const m = Object.hasOwn(cfg, "maintenance") ? cfg["maintenance"] : {};
          let actif = true;
          if (estDict(m))
            actif = veritePy(Object.hasOwn(m, "daily_digest_enabled") ? m["daily_digest_enabled"] : true);
          void rep.headers(SANS_CACHE);
          return { enabled: actif };
        },
      },
      {
        methode: "POST",
        chemin: "/api/admin/report/daily/auto",
        processus: PROCESSUS,
        acces: "admin",
        traiter: async (req) => {
          const corps = corpsOuVide(corpsJson(req));
          const actif = veritePy(Object.hasOwn(corps, "enabled") ? corps["enabled"] : false);
          await sousVerrouConfigJson(() => {
            const complet = readConfigJson();
            const m = estDict(complet["maintenance"]) ? (complet["maintenance"] as Dict) : {};
            m["daily_digest_enabled"] = actif;
            complet["maintenance"] = m;
            writeConfigJson(complet);
          });
          return { ok: true, enabled: actif };
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/observability/tool-failures",
        processus: PROCESSUS,
        acces: "staff",
        traiter: async (req, rep) => {
          const { query } = entrees(req, {
            query: {
              hours: py.int().defaut(24),
              limit: py.int().defaut(50),
              status: py.optional(py.str()).defaut(null),
            },
          });
          const heures = Math.max(1, Math.min(720, query.hours));
          const limite = Math.max(1, Math.min(500, query.limit));
          if (query.status && !["error", "blocked", "timeout"].includes(query.status))
            throw new HttpError(400, "status must be one of ['blocked', 'error', 'timeout']");
          const where = ["ts > ?"];
          const params: Valeur[] = [Date.now() / 1000 - heures * 3600];
          if (query.status) {
            where.push("status = ?");
            params.push(query.status);
          } else where.push("status != 'success'");
          const items: Dict[] = [];
          try {
            const lignes = await base.valeurs(
              "SELECT ts, run_id, user_id, pipeline_id, node_id, member_id, " +
                "       tool_name, server_name, status, duration_ms, error_short " +
                `FROM tool_call_metrics WHERE ${where.join(" AND ")} ` +
                "ORDER BY ts DESC LIMIT ?",
              [...params, limite],
            );
            for (const r of lignes)
              items.push({
                ts: typeof r[0] === "number" ? versFlottantPy(r[0]) : r[0],
                run_id: r[1],
                user_id: r[2],
                pipeline_id: r[3],
                node_id: r[4],
                member_id: r[5],
                tool_name: r[6],
                server_name: r[7],
                status: r[8],
                duration_ms: r[9],
                error_short: r[10],
              });
          } catch (e) {
            log.warn(`[obs/tool-failures] query failed: ${e instanceof Error ? e.message : strPy(e)}`);
          }
          void rep.headers(SANS_CACHE);
          return { items, total: items.length, hours: heures };
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/observability/tool-summary",
        processus: PROCESSUS,
        acces: "staff",
        traiter: async (req, rep) => {
          const { query } = entrees(req, {
            query: { hours: py.int().defaut(24), limit: py.int().defaut(100) },
          });
          const heures = Math.max(1, Math.min(720, query.hours));
          const limite = Math.max(1, Math.min(500, query.limit));
          const depuis = Date.now() / 1000 - heures * 3600;
          const entier = (v: unknown): number => intPy(veritePy(v) ? v : 0);
          let totals: Dict;
          let perTool: Dict[];
          try {
            const [t] = await base.valeurs(
              "SELECT COUNT(*) AS n, " +
                "       COALESCE(SUM(duration_ms),0) AS total_ms, " +
                "       SUM(CASE WHEN status='error'   THEN 1 ELSE 0 END) AS n_error, " +
                "       SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS n_blocked, " +
                "       SUM(CASE WHEN status='timeout' THEN 1 ELSE 0 END) AS n_timeout " +
                "FROM tool_call_metrics WHERE ts > ?",
              [depuis],
            );
            totals = {
              n: entier(t?.[0]),
              total_ms: entier(t?.[1]),
              n_error: entier(t?.[2]),
              n_blocked: entier(t?.[3]),
              n_timeout: entier(t?.[4]),
            };
            perTool = (
              await base.valeurs(
                "SELECT tool_name, COUNT(*) AS n, " +
                  "       COALESCE(SUM(duration_ms),0) AS total_ms, " +
                  "       SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) AS n_failed " +
                  "FROM tool_call_metrics WHERE ts > ? " +
                  "GROUP BY tool_name ORDER BY n DESC LIMIT ?",
                [depuis, limite],
              )
            ).map((r) => {
              const [n, total] = [intPy(r[1]), intPy(r[2])];
              return {
                tool_name: r[0],
                n,
                total_ms: total,
                n_failed: intPy(r[3]),
                avg_ms: n ? Math.floor(total / n) : 0,
              };
            });
          } catch (e) {
            log.warn(`[obs/tool-summary] query failed: ${e instanceof Error ? e.message : strPy(e)}`);
            totals = { n: 0 };
            perTool = [];
          }
          void rep.headers(SANS_CACHE);
          return { totals, per_tool: perTool, hours: heures };
        },
      },
      {
        methode: "GET",
        chemin: "/api/admin/observability/audit-recent",
        processus: PROCESSUS,
        acces: "staff",
        traiter: async (req, rep) => {
          const { query } = entrees(req, {
            query: {
              hours: py.int().defaut(24),
              limit: py.int().defaut(100),
              action_prefix: py.str().defaut(""),
              filter_user_id: py.optional(py.int()).defaut(null),
            },
          });
          const heures = Math.max(1, Math.min(168, query.hours));
          const limite = Math.max(1, Math.min(500, query.limit));
          const items = readRecentAuditLines({
            limit: limite,
            sinceTs: Date.now() / 1000 - heures * 3600,
            actionPrefix: stripPy(query.action_prefix || "") || null,
            userId: query.filter_user_id,
          });
          void rep.headers(SANS_CACHE);
          return { items, total: items.length, hours: heures };
        },
      },
    ],
  };
}
