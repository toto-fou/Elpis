// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/admin.test.ts — routes de la console Métriques rejouées contre le routeur FastAPI (vecteurs) : statut, corps à l'octet, en-têtes, audit, config.json et base après coup. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser, ligneUtilisateur } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase, viderCacheDecalage } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit, viderRafalesAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { creerFamilleMetriques, ligneCsvPy } from "../../src/familles/metriques";
import type { ContexteMetriques } from "../../src/observabilite/fournisseurs/base";
import type { FrequenceCpu, MemoireVirtuelle, UsageDisque } from "../../src/observabilite/sondes";
import { ACTIONS_PROPRES_AU_TS, appTest } from "../aides";
import { layoutTroisParts, masquerWidgets, verifierCorps } from "../ecart-cache-trois-parts";

type Kw = Record<string, unknown>;

/** Écart voulu : les lectures du journal sont tracées par le TS (`admin.audit.search`), absentes des réponses de la référence. */
function sansTracesTs(url: string, corps: string): string {
  if (url.startsWith("/api/admin/observability/tool-failures")) {
    // Écart voulu : `total` compte toutes les lignes des filtres, et la fenêtre (`offset`, `limit`) est renvoyée.
    const lignes = (corps.match(/"tool_name":/gu) ?? []).length;
    return corps.replace(/"total":\d+,"offset":\d+,"limit":\d+/u, `"total":${lignes}`);
  }
  if (!url.startsWith("/api/admin/observability/audit-recent")) return corps;
  const j = JSON.parse(corps) as { items?: Kw[] };
  if (!Array.isArray(j.items)) return corps;
  const items = j.items.filter((e) => !ACTIONS_PROPRES_AU_TS.has(String(e["action"])));
  return items.length === j.items.length ? corps : JSON.stringify({ ...j, items, total: items.length });
}

const { entrees: E, sorties: S } = JSON.parse(
  readFileSync(new URL("../vecteurs/observabilite-admin.json", import.meta.url), "utf8"),
) as {
  entrees: {
    t0: number;
    comptes: [string, number][];
    evenements: [string, number, string | null, number, number | null][];
    usage: [number, number | null, string, string, number, number, string][];
    runs: [number, string][];
    appels: [number, string, string, number, string | null, string | null][];
    chats: [string, number, number][];
    etapes: [string | null, string, string, Record<string, string>, string | null][];
    systeme: {
      memoire: MemoireVirtuelle;
      disque: UsageDisque;
      logiques: number;
      coeurs: number;
      frequence: FrequenceCpu;
      creation: number;
      base: number;
      cpu: number;
    };
    sante: Dict;
    echantillons: [string, number | null][];
    jeton: string;
  };
  sorties: {
    ids: Record<string, number>;
    reponses: {
      statut: number;
      corps: string;
      type: string | null;
      cache: string | null;
      fichier: string | null;
    }[];
    audit: string[];
    config: string;
    restants: Record<string, number>;
    notifications: unknown[][];
  };
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const tzAvant = process.env["TZ"];

/** PostgreSQL ordonne autrement les ex aequo d'un `GROUP BY … ORDER BY n DESC` (Python compris) : tableaux et lignes triés, données égales exigées. */
function canonPg(corps: string): string {
  const trier = (v: unknown): unknown => {
    if (Array.isArray(v))
      return v.map(trier).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v as Kw).map(([k, x]) => [k, trier(x)]));
    return v;
  };
  try {
    return JSON.stringify(trier(JSON.parse(corps)));
  } catch {
    return corps.split("\n").sort().join("\n");
  }
}

function horloge(t: number): void {
  vi.setSystemTime(Math.round(t * 1000));
}

/** `require_user_id` puis rôle relu en base, comme le stub du vecteur (`x-uid`). */
function exigerRoleEssai(t: BaseDeTest, roles: readonly number[], message: string) {
  return async (req: FastifyRequest): Promise<number> => {
    const brut = req.headers["x-uid"];
    if (!brut) throw new HttpError(401, "not logged in");
    const uid = Number(brut);
    const moi = await ligneUtilisateur(t.base, uid);
    if (!moi || !roles.includes(Number(moi.is_admin))) throw new HttpError(403, message);
    req.utilisateur = { id: uid, username: moi.username ?? null };
    return uid;
  };
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
      tailleDossier: async () => 0,
    },
    historique: () => [],
    santeLlm: async () => E.sante,
  };
}

async function remplir(t: BaseDeTest): Promise<void> {
  const x = t.base;
  const T0 = E.t0;
  await initialiserBase(x);
  for (const [nom, admin] of E.comptes)
    expect(await createUser(x, nom, `mdp-${nom}`, { isAdmin: admin })).toBe(S.ids[nom]);
  const alice = S.ids["alice"] as number;
  for (const [typ, val, tags, age, uid] of E.evenements)
    await x.run(
      "INSERT INTO metric_events(event_type, value, tags_json, created_at, user_id) VALUES (?,?,?,?,?)",
      [typ, val, tags, T0 - age, uid],
    );
  for (const [age, uid, src, model, i, o, st] of E.usage)
    await x.run(
      "INSERT INTO usage_events(ts, user_id, source, model, input_tokens, output_tokens, status) VALUES (?,?,?,?,?,?,?)",
      [T0 - age, uid, src, model, i, o, st],
    );
  await x.run(
    "INSERT INTO editor_routines(id, owner_user_id, name, cron_expr, task_prompt, enabled, created_at, updated_at) " +
      "VALUES (1, ?, 'r', '0 3 * * *', 'p', 1, ?, ?)",
    [alice, T0, T0],
  );
  for (const [age, st] of E.runs)
    await x.run(
      "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, started_at) VALUES (1,?,?,?)",
      [alice, st, T0 - age],
    );
  for (const [age, outil, st, duree, err, noeud] of E.appels)
    await x.run(
      "INSERT INTO tool_call_metrics(run_id, user_id, tool_name, status, duration_ms, error_short, ts, node_id) " +
        "VALUES ('r1',?,?,?,?,?,?,?)",
      [alice, outil, st, duree, err, T0 - age, noeud],
    );
  for (const [cid, uid, arch] of E.chats)
    await x.run(
      "INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived) VALUES (?,?,?,?,?,?)",
      [cid, uid, "t", "[1, 2]", T0, arch],
    );
}

describe("csv.writer", () => {
  it("champs cités au besoin, guillemets doublés, None vide, fin de ligne CRLF", () => {
    expect(ligneCsvPy(["a", 1, null, 'q"x', "a,b", "l\nm", "r\rs", ""])).toBe(
      'a,1,,"q""x","a,b","l\nm","r\rs",\r\n',
    );
    expect(ligneCsvPy([""])).toBe('""\r\n');
  });
});

describe.each(MOTEURS)("console Métriques rejouée contre FastAPI (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier = "";
  const restaurations: (() => void)[] = [];

  beforeAll(async () => {
    // Lectures du bloc précédent (autre moteur) écrites tout de suite : la même lecture redevient une première ici.
    viderRafalesAudit();
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-admin-metriques-"));
    writeFileSync(path.join(dossier, "config.json"), "{}");
    mkdirSync(path.join(dossier, "audit"));
    restaurations.push(surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") }));
    invalidateConfigCache();
    configureAudit({
      service: "admin",
      auditDir: path.join(dossier, "audit"),
      hmacKeyPath: path.join(dossier, "absente.key"),
    });
    process.env["TZ"] = "Europe/Paris";
    viderCacheDecalage();
    t = ouvrirBaseDeTest(moteur);
    await remplir(t);
    const famille = creerFamilleMetriques({
      base: t.base,
      auth: {} as DependancesAuth,
      contexte: contexte(t),
      exigerEquipe: exigerRoleEssai(t, [1, 2], "Staff required"),
      echantillons: () =>
        E.echantillons.map(([nom, v]) => [
          nom,
          () => {
            if (v === null) throw new Error("indisponible");
            return v;
          },
        ]),
      cpuPourcent: () => E.systeme.cpu,
      pid: 4242,
      genererJeton: () => E.jeton,
    });
    app = await appTest({
      mode: "admin",
      familles: [famille],
      gardes: {
        staff: async (req) => void (await exigerRoleEssai(t, [1, 2], "Staff required")(req)),
        admin: async (req) => void (await exigerRoleEssai(t, [1], "Admin required")(req)),
      },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    horloge(E.t0);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
    await t.fermer();
    oublierConfigurationAudit();
    while (restaurations.length) restaurations.pop()?.();
    invalidateConfigCache();
    if (tzAvant === undefined) delete process.env["TZ"];
    else process.env["TZ"] = tzAvant;
    viderCacheDecalage();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("chaque étape : statut, corps, Content-Type, Cache-Control, Content-Disposition", async () => {
    for (const [i, [nom, methode, url, entetes, corps]] of E.etapes.entries()) {
      // Écart voulu : le journal de sécurité est réservé aux admins (ANSSI R27), rejoué ici en admin.
      const qui = nom === "modo" && url.startsWith("/api/admin/observability/audit-recent") ? "admin" : nom;
      const r = await app.inject({
        method: methode as "GET",
        url,
        headers: {
          ...entetes,
          // Écart voulu : la lecture du journal exige l'en-tête de la console (jamais envoyé par la référence Python).
          ...(/^\/api\/admin\/(observability\/audit-recent|export-metrics)/u.test(url)
            ? { "x-elpis-console": "1" }
            : {}),
          ...(qui ? { "x-uid": String(S.ids[qui]) } : {}),
        },
        ...(corps === null ? {} : { payload: corps }),
      });
      const attendu = S.reponses[i] as (typeof S.reponses)[0];
      const corpsTs = sansTracesTs(url, r.body);
      const attenduEcart = layoutTroisParts(attendu.corps);
      verifierCorps(
        corpsTs,
        attenduEcart,
        Number(new URL(url, "http://x").searchParams.get("scope_hours") || 24),
      );
      const [masqueTs, masqueAttendu] = [masquerWidgets(corpsTs), masquerWidgets(attenduEcart)];
      const [corpsObtenu, corpsAttendu] =
        moteur === "postgres" ? [canonPg(masqueTs), canonPg(masqueAttendu)] : [masqueTs, masqueAttendu];
      expect
        .soft(
          {
            statut: r.statusCode,
            corps: corpsObtenu,
            type: String(r.headers["content-type"] ?? null).replace(
              "application/json; charset=utf-8",
              "application/json",
            ),
            cache: r.headers["cache-control"] ?? null,
            fichier: r.headers["content-disposition"] ?? null,
          },
          `étape ${i} : ${methode} ${url}`,
        )
        .toEqual({ ...attendu, corps: corpsAttendu });
    }
  });

  it("journal de sécurité récent : refusé au modérateur", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/observability/audit-recent",
      headers: { "x-uid": String(S.ids["modo"]) },
    });
    expect([r.statusCode, r.json()]).toEqual([403, { detail: "Admin required" }]);
  });

  it("après coup : journal d'audit, config.json, lignes restantes, notifications du digest", async () => {
    const toutes = readdirSync(path.join(dossier, "audit"))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .flatMap((f) =>
        readFileSync(path.join(dossier, "audit", f), "utf8")
          .trim()
          .split("\n"),
      )
      .map((l) => JSON.parse(l) as Kw);
    // Export CSV : une ligne par export réussi, avec le compte et l'IP.
    const exports = toutes.filter((r) => r["action"] === "admin.metrics.export");
    expect(exports.length).toBeGreaterThan(0);
    expect(exports[0]).toMatchObject({
      details: { days: expect.any(Number), target: expect.any(String), format: "csv" },
      user_id: expect.any(Number),
      ip: expect.any(String),
    });
    // Lectures du journal par `audit-recent` : tracées comme une recherche de la page Audit.
    expect(toutes.filter((r) => r["action"] === "admin.audit.search")).toContainEqual(
      expect.objectContaining({
        user_id: S.ids["admin"],
        details: expect.objectContaining({ source: "audit-recent", filters: { action: "admin." } }),
      }),
    );
    const audit = toutes
      // Les actions ajoutées par le TS sont un écart voulu à la référence Python.
      .filter((r) => !ACTIONS_PROPRES_AU_TS.has(String(r["action"])))
      .map((r) => [r["action"], r["details"], r["user_id"], r["username"]]);
    expect(audit).toEqual(S.audit.map((l) => JSON.parse(l) as unknown));
    expect(readFileSync(path.join(dossier, "config.json"), "utf8")).toBe(S.config);
    const restants: Record<string, number> = {};
    for (const table of Object.keys(S.restants)) {
      const [n] = await t.base.valeurs(`SELECT COUNT(*) FROM ${table}`);
      restants[table] = Number(n?.[0]);
    }
    expect(restants).toEqual(S.restants);
    const notifs = await t.base.valeurs(
      "SELECT owner_user_id, kind, title, ref_id FROM notifications ORDER BY id",
    );
    expect(notifs.map(([a, b, c, d]) => [a, b, c, Number(d)])).toEqual(S.notifications);
  });

  it("journal de sécurité récent : sans l'en-tête de la console ou venu d'un autre site, 403 et aucune trace écrite", async () => {
    const lignes = (): number =>
      readdirSync(path.join(dossier, "audit"))
        .filter((f) => f.endsWith(".jsonl"))
        .reduce((n, f) => n + readFileSync(path.join(dossier, "audit", f), "utf8").split("\n").length, 0);
    const avant = lignes();
    const url = "/api/admin/observability/audit-recent?action_prefix=admin.";
    const base = { "x-uid": String(S.ids["admin"]) };
    for (const entetes of [
      base,
      { ...base, "x-elpis-console": "0" },
      { ...base, "x-elpis-console": "1", "sec-fetch-site": "cross-site" },
    ]) {
      const r = await app.inject({ method: "GET", url, headers: entetes });
      expect(r.statusCode).toBe(403);
    }
    expect(lignes()).toBe(avant);
  });
});
