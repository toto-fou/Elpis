// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/metriques.test.ts — tableau de bord (tous les widgets), rapport quotidien, échantillonneur, traces et purges rejoués contre le Python sur une base figée (vecteurs). */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser } from "@elpis/auth";
import { pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import { initialiserBase, viderCacheDecalage } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { lastHeartbeatAt, sampleOnce } from "../../src/observabilite/echantillonneur";
import { dbSizeBytes, dirSizeBytes } from "../../src/observabilite/fournisseurs/base";
import type { ContexteMetriques } from "../../src/observabilite/fournisseurs/base";
import { purgeOldMetrics, viderCacheNomsMetriques } from "../../src/observabilite/metriques-evenements";
import type { PointSysteme } from "../../src/observabilite/moniteur";
import {
  buildDailyReport,
  dateToRefId,
  generateAndStoreDailyDigest,
  getDailyReport,
  listDailyReports,
  purgeDailyReports,
  summaryText,
} from "../../src/observabilite/rapports";
import { creerRegistre } from "../../src/observabilite/registre";
import type { FrequenceCpu, MemoireVirtuelle, UsageDisque } from "../../src/observabilite/sondes";
import { avaler, reset, snapshot } from "../../src/observabilite/traces";
import {
  layoutTroisParts,
  masquerWidgets,
  verifierTroisParts,
  WIDGETS_CACHE,
} from "../ecart-cache-trois-parts";

const TEXTE = readFileSync(new URL("../vecteurs/observabilite-metriques.json", import.meta.url), "utf8");
const { entrees: E, sorties: S } = pyJsonLoads(TEXTE, { mode: "natif" }) as {
  entrees: {
    t0: number;
    comptes: [string, number][];
    evenements: [string, number | null, string | null, number, number | null][];
    usage: unknown[][];
    routines: [number, number, string][];
    runs: [number, string, string, number, number | null, number | null, number | null][];
    appels: [string, number, string, string, number, number][];
    chats: [string, number, string, string, number, number, number | null][];
    groupes: [string, number][];
    systeme: {
      memoire: MemoireVirtuelle;
      disque: UsageDisque;
      logiques: number;
      coeurs: number;
      frequence: FrequenceCpu;
      creation: number;
      base: number;
    };
    sante: Dict;
    historique: PointSysteme[];
    dossiers: Record<string, number>;
    portees: number[];
    widgets: [string[], number][];
    traces: [string, string, string][];
  };
  sorties: {
    ids: Record<string, number>;
    tableaux: Record<string, string>;
    widgets: string[];
    evenements_widgets: Record<string, string[]>;
    rapport: string;
    resume: string;
    resume_vide: string;
    references: (number | null)[];
    digest: (string | null)[];
    liste: string;
    relu: string;
    absent: null;
    notifications: unknown[][];
    purges_rapports: number[];
    battement: number[];
    echantillon: Record<string, number>;
    echantillon_ligne: unknown[];
    traces: string;
    traces_limite: string;
    purge_metriques: number[];
  };
};

/** Exception d'un type Python quelconque (`type(exc).__name__` lu sur `name`). */
class ErreurNommee extends Error {
  constructor(type: string, message: string) {
    super(message);
    this.name = type;
  }
}

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const registre = creerRegistre();
const tzAvant = process.env["TZ"];
let racine = "";

function horloge(t: number): void {
  vi.setSystemTime(Math.round(t * 1000));
}

/** Texte JSON Python relu puis réécrit : la référence d'un widget isolé, dans l'écriture de pyJsonDumps. */
function reecrit(texte: string): Dict {
  return pyJsonLoads(texte) as Dict;
}

/** Classements `ORDER BY n DESC LIMIT k` : l'ordre des ex aequo n'est pas défini par SQL et diffère entre SQLite et PostgreSQL. */
const ORDRE_LIBRE = new Set(["sandbox_writes_ext", "sandbox_writes_user", "tools_usage", "tool_call_volume"]);

/** Même widget aux ex aequo près : valeurs identiques, mêmes libellés par valeur (sauf le dernier groupe, tronqué par LIMIT). */
function egauxAuxExAequoPres(a: unknown, b: unknown): boolean {
  const wa = a as Dict;
  const wb = b as Dict;
  if (pyJsonDumps({ ...wa, labels: null }) !== pyJsonDumps({ ...wb, labels: null })) return false;
  const la = (wa["labels"] ?? []) as unknown[];
  const lb = (wb["labels"] ?? []) as unknown[];
  const valeurs = (((wa["datasets"] as Dict[])[0] ?? {})["data"] ?? []) as unknown[];
  if (la.length !== lb.length || la.length !== valeurs.length) return false;
  const textes = valeurs.map((v) => pyJsonDumps(v));
  const dernier = textes[textes.length - 1];
  for (const v of new Set(textes)) {
    if (v === dernier) continue;
    const groupe = (l: unknown[]): string =>
      l
        .filter((_x, i) => textes[i] === v)
        .map(String)
        .sort()
        .join("\0");
    if (groupe(la) !== groupe(lb)) return false;
  }
  return true;
}

/** Compare widget par widget (message lisible) puis le texte entier ; sur PostgreSQL, les ex aequo des classements sont libres ; widgets du cache en trois parts par invariants (écart voulu). */
function comparerWidgets(
  obtenu: Dict,
  texteBrut: string,
  cle: string | null,
  nom: string,
  moteur: "sqlite" | "postgres" = "sqlite",
  heures = 24,
): void {
  const texte = layoutTroisParts(texteBrut);
  const attendu = reecrit(texte);
  const donnees = (cle === null ? obtenu : obtenu[cle]) as Dict;
  const reference = (cle === null ? attendu : attendu[cle]) as Dict;
  expect(Object.keys(donnees), nom).toEqual(Object.keys(reference));
  let exAequo = false;
  let ecart = false;
  for (const id of Object.keys(reference)) {
    const [o, r] = [pyJsonDumps(donnees[id]), pyJsonDumps(reference[id])];
    if (WIDGETS_CACHE.has(id) && reference[id] !== null && typeof reference[id] === "object") {
      verifierTroisParts(id, donnees[id], reference[id], heures);
      ecart = true;
    } else if (o !== r && moteur === "postgres" && ORDRE_LIBRE.has(id)) {
      expect.soft(egauxAuxExAequoPres(donnees[id], reference[id]), `${id} (${nom}) : ${o} ≠ ${r}`).toBe(true);
      exAequo = true;
    } else expect.soft(o, `${id} (${nom})`).toBe(r);
  }
  if (exAequo) return;
  if (ecart) expect(masquerWidgets(pyJsonDumps(obtenu)), nom).toBe(masquerWidgets(texte));
  else expect(pyJsonDumps(obtenu), nom).toBe(texte);
}

function contexte(t: BaseDeTest): ContexteMetriques {
  const s = E.systeme;
  return {
    base: t.base,
    systeme: {
      virtualMemory: () => s.memoire,
      diskUsage: () => s.disque,
      cpuCountLogical: () => s.logiques,
      cpuCountCores: () => s.coeurs,
      cpuFreq: () => s.frequence,
      createTime: () => s.creation,
      tailleBase: () => s.base,
      tailleDossier: (c) =>
        dirSizeBytes(c === config.SANDBOX_DIR ? path.join(racine, "sb") : path.resolve(racine, c)),
    },
    historique: () => E.historique,
    santeLlm: async () => E.sante,
  };
}

async function remplir(t: BaseDeTest): Promise<void> {
  const x = t.base;
  await initialiserBase(x);
  for (const [nom, admin] of E.comptes) {
    const id = await createUser(x, nom, `mdp-${nom}`, { isAdmin: admin });
    expect(id).toBe(S.ids[nom]);
  }
  for (const ligne of E.evenements)
    await x.run(
      "INSERT INTO metric_events(event_type, value, tags_json, created_at, user_id) VALUES (?,?,?,?,?)",
      ligne,
    );
  for (const ligne of E.usage)
    await x.run(
      "INSERT INTO usage_events(ts, user_id, source, origin_id, parent_id, model, connector, path, " +
        "input_tokens, output_tokens, submitted_tokens, cache_read_tokens, cache_creation_tokens, " +
        "duration_ms, iterations, status, error_kind, thinking_tokens, run_id, tool_tokens) " +
        `VALUES (${Array(20).fill("?").join(",")})`,
      ligne as never[],
    );
  for (const [rid, uid, nom] of E.routines)
    await x.run(
      "INSERT INTO editor_routines(id, owner_user_id, name, cron_expr, task_prompt, enabled, created_at, " +
        "updated_at) VALUES (?,?,?,'0 3 * * *','p',1,?,?)",
      [rid, uid, nom, E.t0, E.t0],
    );
  for (const [rid, st, trig, debut, duree, i, o] of E.runs)
    await x.run(
      "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, trigger, started_at, " +
        "duration_ms, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?)",
      [rid, rid === 1 ? 2 : 3, st, trig, debut, duree, i, o],
    );
  for (const [run, uid, outil, st, duree, quand] of E.appels)
    await x.run(
      "INSERT INTO tool_call_metrics(run_id, user_id, tool_name, status, duration_ms, ts) VALUES (?,?,?,?,?,?)",
      [run, uid, outil, st, duree, quand],
    );
  for (const ligne of E.chats)
    await x.run(
      "INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived, archived_at) VALUES (?,?,?,?,?,?,?)",
      ligne,
    );
  for (const [nom, quand] of E.groupes)
    await x.run('INSERT INTO "groups"(name, created_at) VALUES (?,?)', [nom, quand]);
}

beforeAll(() => {
  racine = mkdtempSync(path.join(tmpdir(), "elpis-metriques-"));
  for (const [rel, taille] of Object.entries(E.dossiers)) {
    mkdirSync(path.dirname(path.join(racine, rel)), { recursive: true });
    writeFileSync(path.join(racine, rel), Buffer.alloc(taille));
  }
  process.env["TZ"] = "Europe/Paris";
  viderCacheDecalage();
});

afterAll(() => {
  rmSync(racine, { recursive: true, force: true });
  if (tzAvant === undefined) delete process.env["TZ"];
  else process.env["TZ"] = tzAvant;
  viderCacheDecalage();
});

describe("registre", () => {
  it("widgets indexés par type d'événement", () => {
    for (const [type, ids] of Object.entries(S.evenements_widgets))
      expect(registre.affectedProviderIds(type), type).toEqual(ids);
  });

  it("tailles de base et de dossier", async () => {
    const f = path.join(racine, "base.db");
    writeFileSync(f, Buffer.alloc(1000));
    writeFileSync(`${f}-wal`, Buffer.alloc(24));
    expect(dbSizeBytes(f)).toBe(1024);
    expect(dbSizeBytes(path.join(racine, "absente.db"))).toBe(0);
    expect(await dirSizeBytes(path.join(racine, "user_db"))).toBe(70_000 + 1_500_000 + 300);
    expect(await dirSizeBytes(path.join(racine, "inexistant"))).toBe(0);
    rmSync(f);
    rmSync(`${f}-wal`);
  });
});

describe.each(MOTEURS)("tableau de bord et rapports rejoués contre le Python (%s)", (moteur) => {
  let t: BaseDeTest;
  let ctx: ContexteMetriques;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await remplir(t);
    ctx = contexte(t);
    vi.useFakeTimers({ toFake: ["Date"] });
    horloge(E.t0);
    viderCacheNomsMetriques();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await t.fermer();
  });

  it.each(E.portees.map((p) => [p] as const))("get_dashboard_config(%i)", async (portee) => {
    horloge(E.t0);
    const obtenu = await registre.getDashboardConfig(ctx, portee);
    const texte = S.tableaux[String(portee)] as string;
    expect(pyJsonDumps(obtenu["layout"])).toBe(pyJsonDumps(reecrit(layoutTroisParts(texte))["layout"]));
    comparerWidgets(obtenu, texte, "data", `${portee} h`, moteur, portee);
  });

  it("get_widgets_data", async () => {
    horloge(E.t0);
    for (const [i, [ids, portee]] of E.widgets.entries())
      comparerWidgets(
        await registre.getWidgetsData(ctx, ids, portee),
        S.widgets[i] as string,
        null,
        ids.join(","),
        moteur,
        portee,
      );
  });

  it("rapport quotidien : instantané, résumé, référence de date", async () => {
    horloge(E.t0);
    const rapport = await buildDailyReport(ctx, 24, "2027-01-15", registre);
    comparerWidgets(rapport, S.rapport, "widgets", "rapport", moteur);
    expect(summaryText(rapport)).toBe(S.resume);
    expect(
      summaryText({
        widgets: {
          kpi_dau: { value: null },
          kpi_messages: { error: "x" },
          usage_tokens: { value: pyJsonLoads("1.5"), unit: "" },
        },
      }),
    ).toBe(S.resume_vide);
    expect(["2027-01-15", "x", "2027-1-5"].map(dateToRefId)).toEqual(S.references);
  });

  it("digest idempotent notifié aux admins, relu, listé puis purgé", async () => {
    const dates: (string | null)[] = [];
    horloge(E.t0);
    dates.push(await generateAndStoreDailyDigest(t.base, ctx, "2027-01-15"));
    horloge(E.t0 + 60);
    dates.push(await generateAndStoreDailyDigest(t.base, ctx, "2027-01-15"));
    dates.push(await generateAndStoreDailyDigest(t.base, ctx, "2027-01-15", true));
    horloge(E.t0 + 120);
    dates.push(await generateAndStoreDailyDigest(t.base, ctx));
    expect(dates).toEqual(S.digest);
    expect(pyJsonDumps(await listDailyReports(t.base))).toBe(S.liste);
    comparerWidgets((await getDailyReport(t.base, "2027-01-15")) as Dict, S.relu, "widgets", "relu", moteur);
    expect(await getDailyReport(t.base, "1999-01-01")).toBeNull();
    const notifs = await t.base.valeurs(
      "SELECT owner_user_id, kind, title, body, ref_type, ref_id FROM notifications ORDER BY id",
    );
    expect(notifs.map((n) => n.map((v, i) => (i === 5 && v !== null ? Number(v) : v)))).toEqual(
      S.notifications,
    );
    horloge(E.t0 + 401 * 86400);
    const purges = [];
    for (const r of [0, 400, 400]) purges.push(await purgeDailyReports(t.base, r));
    expect(purges).toEqual(S.purges_rapports);
  });

  it("échantillonneur : battement du planificateur, une ligne proc_sample", async () => {
    horloge(E.t0 + 300);
    const battements = [];
    for (const g of [undefined, "proc_rss_mb", "inconnu"]) battements.push(await lastHeartbeatAt(t.base, g));
    expect(battements).toEqual(S.battement);
    const collectees = await sampleOnce(
      t.base,
      [
        ["proc_active_chat_tasks", () => 2],
        ["proc_rss_mb", () => 312.4],
        ["proc_num_fds", () => 41],
        [
          "proc_pty_terminals",
          () => {
            throw new ErreurNommee("ZeroDivisionError", "division by zero");
          },
        ],
      ],
      999,
    );
    expect(collectees).toEqual(S.echantillon);
    const [ligne] = await t.base.valeurs(
      "SELECT event_type, value, tags_json, created_at FROM metric_events ORDER BY id DESC LIMIT 1",
    );
    expect(ligne).toEqual(S.echantillon_ligne);
  });

  it("purge_old_metrics : rétention en jours, 0 = tout ce qui précède l'instant", async () => {
    horloge(E.t0);
    const [n] = await t.base.valeurs("SELECT COUNT(*) FROM metric_events");
    const obtenus = [Number(n?.[0])];
    for (const r of [30, 30, 0]) obtenus.push(await purgeOldMetrics(t.base, r));
    expect(obtenus).toEqual(S.purge_metriques);
  });
});

describe("traces des erreurs avalées", () => {
  afterAll(() => {
    vi.useRealTimers();
    reset();
  });

  it("palmarès par fréquence puis par tag, message tronqué, limite", () => {
    reset();
    vi.useFakeTimers({ toFake: ["Date"] });
    horloge(E.t0 + 400);
    for (const [tag, type, msg] of E.traces)
      avaler(tag, () => {
        throw new ErreurNommee(type, type === "KeyError" ? `'${msg}'` : msg);
      });
    expect(snapshot()).toEqual(JSON.parse(S.traces));
    expect(snapshot(1)).toEqual(JSON.parse(S.traces_limite));
  });
});
