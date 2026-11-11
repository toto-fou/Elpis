// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/usage.test.ts — contexte et registre d'usage, événements, appels d'outils et `/api/usage/me` rejoués contre le Python (vecteurs), ports de la boucle. */
import { readFileSync } from "node:fs";

import { createUser } from "@elpis/auth";
import { HttpError, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import type { Executeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  dansPortee,
  installerPorteeRun,
  enregistrerTour,
  brancherObservabilite,
} from "../../src/observabilite/branchements";
import {
  installerContexteUsage,
  installerMetriquesBoucle,
  installerMetriquesOutils,
  installerPorteeExecution,
  installerRegistreUsage,
  logMetric as logMetricBoucle,
  metriqueOutil,
  recordTurnUsage as recordTurnUsageBoucle,
  contexteUsage,
} from "../../src/boucle/ports";
import { creerFamilleUsage } from "../../src/familles/usage";
import {
  logMetric,
  purgeOldMetrics,
  viderCacheNomsMetriques,
} from "../../src/observabilite/metriques-evenements";
import {
  enregistrerAppelOutil,
  purgeToolCallMetrics,
  recordToolCallMetric,
  viderCacheComptesOutils,
} from "../../src/observabilite/outils-metriques";
import { fenetreJours, usageDuCompte } from "../../src/observabilite/usage-compte";
import {
  currentUsageCtx,
  installerExecutionUsage,
  isolerUsage,
  normalizeUsage,
  recordTurnUsage,
  setUsageContext,
  usageScope,
} from "../../src/observabilite/usage-contexte";
import type { TourUsage, UsageExecution } from "../../src/observabilite/usage-contexte";
import {
  deleteUsageEvents,
  purgeUsageEvents,
  recordUsage,
  tokenBreakdown,
  usageCacheTotals,
  usageGroup,
  usageTotals,
} from "../../src/observabilite/usage-registre";
import type { FiltresUsage, LigneUsage } from "../../src/observabilite/usage-registre";
import { appTest } from "../aides";
import { decoupeTroisParts } from "../ecart-cache-trois-parts";
import { avecRequetes } from "../ecart-usage-requetes";

type Kw = Record<string, unknown>;
type Op = ["lire"] | ["set", string, Kw] | ["scope", string, Kw, Op[]];

const TEXTE = readFileSync(new URL("../vecteurs/observabilite-usage.json", import.meta.url), "utf-8");
const FICHIER = pyJsonLoads(TEXTE, { mode: "natif" }) as {
  entrees: unknown;
  sorties: Record<string, unknown>;
};
const V = FICHIER.entrees as {
  comptes: [string, number][];
  normalisations: unknown[];
  decoupes: [unknown[], Kw][];
  portees: Op[][];
  tours: [number, [string, Kw][], Kw][];
  lignes: [number, Kw][];
  agregats: [string, unknown[], Kw][];
  evenements: [number, string, number, Kw | null, number | null][];
  appels: [number, Kw][];
  etapes: [string | null, string][];
  t0: number;
  chats: [string, string, number][];
  usage_route: [number, string, string, number, number, number, number, number][];
  messages: [number, string, string][];
  runs: [number, string, string, number | null, number | null, number][];
};
const VALEURS = (
  pyJsonLoads(TEXTE) as { entrees: { evenements: [number, string, number, Kw | null, number | null][] } }
).entrees;
const R = (cle: string): unknown => FICHIER.sorties[cle];
const IDS = R("ids") as Record<string, number>;

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

function horloge(t: number): void {
  vi.setSystemTime(Math.round(t * 1000));
}

function options(kw: Kw): {
  userId?: number | null;
  originId?: string;
  parentId?: string;
  inheritUser?: boolean;
} {
  return {
    ...(kw["user_id"] !== undefined ? { userId: kw["user_id"] as number | null } : {}),
    ...(kw["origin_id"] !== undefined ? { originId: kw["origin_id"] as string } : {}),
    ...(kw["parent_id"] !== undefined ? { parentId: kw["parent_id"] as string } : {}),
    ...(kw["inherit_user"] !== undefined ? { inheritUser: kw["inherit_user"] as boolean } : {}),
  };
}

function ctx(): Kw {
  const c = currentUsageCtx();
  return { source: c.source, user_id: c.userId, origin_id: c.originId, parent_id: c.parentId };
}

function jouer(ops: Op[], sortie: Kw[]): Kw[] {
  for (const op of ops) {
    if (op[0] === "lire") sortie.push(ctx());
    else if (op[0] === "set") setUsageContext(op[1], options(op[2]));
    else usageScope(op[1], options(op[2]), () => jouer(op[3], sortie));
  }
  return sortie;
}

function tour(kw: Kw): TourUsage {
  return {
    ...(kw["usage"] !== undefined ? { usage: kw["usage"] } : {}),
    ...(kw["model"] !== undefined ? { model: kw["model"] as string } : {}),
    ...(kw["path"] !== undefined ? { path: kw["path"] as string } : {}),
    ...(kw["connector"] !== undefined ? { connector: kw["connector"] as string } : {}),
    ...(kw["duration_ms"] !== undefined ? { durationMs: kw["duration_ms"] } : {}),
    ...(kw["iterations"] !== undefined ? { iterations: kw["iterations"] } : {}),
    ...(kw["status"] !== undefined ? { status: kw["status"] as string } : {}),
    ...(kw["error_kind"] !== undefined ? { errorKind: kw["error_kind"] as string } : {}),
    ...(kw["input_tokens"] !== undefined ? { inputTokens: kw["input_tokens"] as number } : {}),
    ...(kw["output_tokens"] !== undefined ? { outputTokens: kw["output_tokens"] as number } : {}),
    ...(kw["submitted_tokens"] !== undefined ? { submittedTokens: kw["submitted_tokens"] as number } : {}),
    ...(kw["thinking_tokens"] !== undefined ? { thinkingTokens: kw["thinking_tokens"] as number } : {}),
  };
}

const CLES_LIGNE: Readonly<Record<string, keyof LigneUsage>> = {
  user_id: "userId",
  source: "source",
  origin_id: "originId",
  parent_id: "parentId",
  model: "model",
  connector: "connector",
  path: "path",
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  submitted_tokens: "submittedTokens",
  thinking_tokens: "thinkingTokens",
  tool_tokens: "toolTokens",
  cache_read_tokens: "cacheReadTokens",
  cache_creation_tokens: "cacheCreationTokens",
  duration_ms: "durationMs",
  iterations: "iterations",
  status: "status",
  error_kind: "errorKind",
  ts: "ts",
  run_id: "runId",
};

function ligne(kw: Kw): LigneUsage {
  const l: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kw)) l[CLES_LIGNE[k] as string] = v;
  return l as LigneUsage;
}

async function lignes(x: Executeur, table: string): Promise<Kw[]> {
  return (await x.all(`SELECT * FROM ${table} ORDER BY id`)).map((r) => {
    const { id: _id, ...reste } = r;
    return reste;
  });
}

async function agreger(x: Executeur, nom: string, args: unknown[], kw: Kw): Promise<unknown> {
  if (nom === "usage_group") {
    const [dim, since] = args as [string, number];
    return usageGroup(x, dim, since, null, {
      ...(kw["metric"] !== undefined ? { metric: kw["metric"] as string } : {}),
      ...(kw["limit"] !== undefined ? { limit: kw["limit"] as number } : {}),
    });
  }
  const [since, until = null] = args as [number, number | null];
  const filtres = kw as FiltresUsage;
  return nom === "usage_totals"
    ? usageTotals(x, since, until, filtres)
    : usageCacheTotals(x, since, until, filtres);
}

async function baseAvecComptes(moteur: "sqlite" | "postgres"): Promise<BaseDeTest> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  for (const [nom, admin] of V.comptes) await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin });
  return t;
}

describe("fonctions pures rejouées contre le Python", () => {
  it("normalize_usage", () => {
    const sortie = R("normalisations") as string[];
    V.normalisations.forEach((u, i) => {
      expect(pyJsonDumps(normalizeUsage(u)), `cas ${i}`).toBe(sortie[i]);
    });
  });

  it("token_breakdown", () => {
    const sortie = R("decoupes") as string[];
    V.decoupes.forEach(([args, kw], i) => {
      const r = tokenBreakdown(args[0], args[1], {
        cacheReadTokens: kw["cache_read_tokens"],
        cacheCreationTokens: kw["cache_creation_tokens"],
        thinkingTokens: kw["thinking_tokens"],
        toolTokens: kw["tool_tokens"],
      });
      expect(pyJsonDumps(r), `cas ${i}`).toBe(decoupeTroisParts(sortie[i] as string));
    });
  });

  it("usage_scope et set_usage_context : héritage, restauration, isolation", () => {
    const attendu = R("portees") as Kw[][];
    V.portees.forEach((ops, i) => {
      expect(
        isolerUsage(() => jouer(ops, [])),
        `scénario ${i}`,
      ).toEqual(attendu[i]);
    });
    expect(currentUsageCtx().source).toBe("unknown");
  });

  it("fenêtre de /api/usage/me ramenée à la plus proche (égalité : la plus courte)", () => {
    expect(
      ["30", "7", "12", "4", "60", "999", "-5", "abc", "7.0", "+7", " 30 ", ""].map(fenetreJours),
    ).toEqual([30, 7, 7, 1, 30, 90, 1, 30, 30, 7, 30, 30]);
  });
});

describe("contexte d'usage à travers l'asynchrone", () => {
  it("une tâche fille hérite du contexte de sa création ; le parent est restauré en sortie", async () => {
    const vus: Kw[] = [];
    await isolerUsage(() =>
      usageScope("chat", { userId: 1, originId: "c1" }, async () => {
        const enfant = new Promise<void>((fin) =>
          setTimeout(() => {
            usageScope("subagent", { originId: "c1#a", parentId: "c1" }, () => vus.push(ctx()));
            fin();
          }, 5),
        );
        await enfant;
        vus.push(ctx());
      }),
    );
    expect(vus).toEqual([
      { source: "subagent", user_id: 1, origin_id: "c1#a", parent_id: "c1" },
      { source: "chat", user_id: 1, origin_id: "c1", parent_id: "" },
    ]);
  });

  it("deux requêtes concurrentes ne se voient pas", async () => {
    const lire = (source: string, uid: number): Promise<Kw> =>
      isolerUsage(async () => {
        setUsageContext(source, { userId: uid });
        await new Promise((fin) => setTimeout(fin, uid));
        return ctx();
      });
    const [a, b] = await Promise.all([lire("chat", 7), lire("routine", 2)]);
    expect([a["source"], a["user_id"], b["source"], b["user_id"]]).toEqual(["chat", 7, "routine", 2]);
  });
});

describe.each(MOTEURS)("registre et magasins rejoués contre le Python (%s)", (moteur) => {
  let t: BaseDeTest;

  beforeAll(async () => {
    t = await baseAvecComptes(moteur);
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterAll(async () => {
    vi.useRealTimers();
    installerExecutionUsage(null);
    await t.fermer();
  });

  it("record_turn_usage sous ses portées : lignes identiques", async () => {
    const resultats: boolean[] = [];
    for (const [quand, portees, kw] of V.tours) {
      horloge(quand);
      const appel = (): Promise<boolean> => recordTurnUsage(t.base, tour(kw));
      const emboite = portees.reduceRight<() => Promise<boolean>>(
        (fn, [source, o]) =>
          () =>
            usageScope(source, options(o), fn),
        appel,
      );
      resultats.push(await isolerUsage(emboite));
    }
    expect(resultats).toEqual(R("tours_resultats"));
    const usages = V.tours.filter((_t, i) => resultats[i]).map(([, , kw]) => kw["usage"]);
    expect(await lignes(t.base, "usage_events")).toEqual(avecRequetes(R("tours") as Kw[], usages));
    await t.base.run("DELETE FROM usage_events");
  });

  it("record_usage : bornes, conversions, tour vide ignoré", async () => {
    const resultats: boolean[] = [];
    for (const [quand, kw] of V.lignes) {
      horloge(quand);
      resultats.push(await recordUsage(t.base, ligne(kw)));
    }
    expect(resultats).toEqual(R("lignes_resultats"));
    expect(await lignes(t.base, "usage_events")).toEqual(avecRequetes(R("lignes") as Kw[], null));
  });

  it("agrégats, regroupements et purges", async () => {
    horloge(1_800_000_500);
    const attendus = R("agregats") as string[];
    for (const [i, [nom, args, kw]] of V.agregats.entries()) {
      const r = await agreger(t.base, nom, args, kw);
      if (moteur === "postgres" && nom === "usage_group") {
        const tri = (v: unknown): string[] => (v as unknown[]).map((l) => pyJsonDumps(l)).sort();
        expect(tri(r), `agrégat ${i}`).toEqual(tri(JSON.parse(attendus[i] ?? "[]")));
      } else {
        expect(pyJsonDumps(r), `agrégat ${i}`).toBe(attendus[i]);
      }
    }
    const purges = [
      await deleteUsageEvents(t.base, 1_800_000_103.0, 1_800_000_104.0),
      await purgeUsageEvents(t.base, 0),
      await purgeUsageEvents(t.base, -1),
    ];
    horloge(1_800_000_100.0 + 86400);
    purges.push(await purgeUsageEvents(t.base, 1), await deleteUsageEvents(t.base));
    expect(purges).toEqual(R("purges"));
  });

  it("log_metric : tags en JSON ASCII, compte d'après le tag user", async () => {
    viderCacheNomsMetriques();
    for (const [quand, type, valeur, tags, uid] of VALEURS.evenements) {
      horloge(quand);
      await logMetric(t.base, type, Number(valeur), tags, uid);
    }
    expect(await lignes(t.base, "metric_events")).toEqual(R("evenements"));
    horloge(1_800_000_203.5 + 86400);
    expect(await purgeOldMetrics(t.base, 1)).toBe(4);
    await t.base.run("DELETE FROM metric_events");
  });

  it("tool_call_metrics : bornes et conversions, purge de rétention", async () => {
    for (const [quand, kw] of V.appels) {
      horloge(quand);
      await recordToolCallMetric(t.base, {
        runId: kw["run_id"] as string,
        userId: kw["user_id"] as number,
        toolName: kw["tool_name"] as string,
        status: kw["status"] as string,
        durationMs: kw["duration_ms"] as number,
        errorShort: (kw["error_short"] as string | undefined) ?? null,
        callId: kw["call_id"],
        startedAt: (kw["started_at"] as number | undefined) ?? null,
        category: (kw["category"] as string | undefined) ?? null,
        exitCode: (kw["exit_code"] as number | undefined) ?? null,
        argsBytes: (kw["args_bytes"] as number | undefined) ?? null,
        resultBytes: (kw["result_bytes"] as number | undefined) ?? null,
        nodeId: kw["node_id"],
      });
    }
    expect(await lignes(t.base, "tool_call_metrics")).toEqual(R("appels"));
    horloge(1_800_000_301.5 + 86400);
    expect([await purgeToolCallMetrics(t.base, 0), await purgeToolCallMetrics(t.base, 1)]).toEqual(
      R("purge_appels"),
    );
    expect((await lignes(t.base, "tool_call_metrics")).length).toBe(R("appels_restants"));
    await t.base.run("DELETE FROM tool_call_metrics");
  });
});

/** Garde de session des tests : compte lu dans `x-uid`, 401 sans lui. */
const gardes = {
  session: (req: { headers: Record<string, unknown>; utilisateur?: unknown }) => {
    const uid = req.headers["x-uid"];
    if (!uid) throw new HttpError(401, "not logged in");
    req.utilisateur = { id: Number(uid), username: null };
  },
};

describe.each(MOTEURS)("GET /api/usage/me rejoué contre FastAPI (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;

  beforeAll(async () => {
    t = await baseAvecComptes(moteur);
    const id = (nom: string): number => IDS[nom] as number;
    const T0 = V.t0;
    for (const [cid, nom, archive] of V.chats)
      await t.base.run(
        "INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived) VALUES (?,?,?,?,?,?)",
        [cid, id(nom), "t", "[]", T0, archive],
      );
    for (const [ts, nom, src, i, o, c, th, tl] of V.usage_route)
      await t.base.run(
        "INSERT INTO usage_events(ts, user_id, source, input_tokens, output_tokens, cache_read_tokens, " +
          "thinking_tokens, tool_tokens) VALUES (?,?,?,?,?,?,?,?)",
        [ts, id(nom), src, i, o, c, th, tl],
      );
    for (const [ts, role, nom] of V.messages)
      await t.base.run(
        "INSERT INTO metric_events(event_type, value, tags_json, created_at) VALUES (?,?,?,?)",
        ["message_sent", 1, pyJsonDumps({ role, user: nom }), ts],
      );
    await t.base.run(
      "INSERT INTO editor_routines(id, owner_user_id, name, cron_expr, task_prompt, enabled, created_at, updated_at) " +
        "VALUES (1, ?, 'r', '0 3 * * *', 'p', 1, ?, ?)",
      [id("alice"), T0, T0],
    );
    for (const [ts, nom, st, i, o, dur] of V.runs)
      await t.base.run(
        "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, started_at, input_tokens, " +
          "output_tokens, duration_ms) VALUES (1,?,?,?,?,?,?)",
        [id(nom), st, ts, i, o, dur],
      );
    app = await appTest({ familles: [creerFamilleUsage({ base: t.base })], gardes });
    vi.useFakeTimers({ toFake: ["Date"] });
    horloge(T0);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
    await t.fermer();
  });

  it("chaque étape identique : statut, corps à l'octet, Cache-Control ; jamais les données d'un autre compte", async () => {
    const attendues = R("reponses") as { statut: number; corps: string; cache: string | null }[];
    for (const [i, [nom, chemin]] of V.etapes.entries()) {
      const r = await app.inject({
        method: "GET",
        url: chemin,
        headers: nom ? { "x-uid": String(IDS[nom]) } : {},
      });
      expect(
        { statut: r.statusCode, corps: r.body, cache: r.headers["cache-control"] ?? null },
        `étape ${i} : ${chemin}`,
      ).toEqual(attendues[i]);
    }
  });
});

describe.each(MOTEURS)(
  "/api/usage/me : messages comptés par compte, écart au Python : user_id et non tags.user (%s)",
  (moteur) => {
    let t: BaseDeTest;
    let alice: number;
    let bob: number;
    const messages = async (uid: number): Promise<{ sent: number; received: number }> =>
      (await usageDuCompte(t.base, uid, 30))["messages"] as { sent: number; received: number };
    const ajouter = async (role: string, nom: string, uid: number | null): Promise<void> => {
      await t.base.run(
        "INSERT INTO metric_events(event_type, value, tags_json, created_at, user_id) VALUES (?,?,?,?,?)",
        ["message_sent", 1, pyJsonDumps({ role, user: nom }), Date.now() / 1000 - 60, uid],
      );
    };

    beforeAll(async () => {
      t = await baseAvecComptes(moteur);
      alice = IDS["alice"] as number;
      bob = IDS["bob"] as number;
      await ajouter("user", "alice", alice);
      await ajouter("assistant", "alice", alice);
      await ajouter("user", "ancien-nom-d-alice", alice);
      await ajouter("user", "alice", bob);
      await ajouter("user", "alice", null);
      await ajouter("assistant", "ancien-nom-de-bob", null);
    });

    afterAll(async () => {
      await t.fermer();
    });

    it("un compte renommé garde ses messages, un nom repris par un autre compte n'en prend pas", async () => {
      expect(await messages(alice)).toEqual({ sent: 3, received: 1 });
      expect(await messages(bob)).toEqual({ sent: 1, received: 0 });
    });

    it("les lignes sans user_id (d'avant l'attribution par identifiant) restent comptées par leur nom", async () => {
      await t.base.run("UPDATE metric_events SET user_id = NULL");
      expect(await messages(alice)).toEqual({ sent: 3, received: 1 });
      expect(await messages(bob)).toEqual({ sent: 0, received: 0 });
    });

    it("message_sent écrit avec l'uid du tour : le cache nom-compte n'y change rien (nom repris, compte renommé)", async () => {
      viderCacheNomsMetriques();
      await t.base.run("DELETE FROM metric_events");
      await logMetric(t.base, "message_sent", 1, { role: "user", user: "alice" });
      await logMetric(t.base, "message_sent", 1, { role: "user", user: "alice" }, bob);
      await logMetric(t.base, "message_sent", 1, { role: "assistant", user: "ancien-nom-de-bob" }, bob);
      expect(await t.base.valeurs("SELECT user_id FROM metric_events ORDER BY id")).toEqual([
        [alice],
        [bob],
        [bob],
      ]);
      expect(await messages(alice)).toEqual({ sent: 1, received: 0 });
      expect(await messages(bob)).toEqual({ sent: 1, received: 1 });
    });
  },
);

describe("ports de la boucle branchés", () => {
  let t: BaseDeTest;

  beforeAll(async () => {
    t = await baseAvecComptes("sqlite");
    brancherObservabilite(t.base);
  });

  afterEach(() => {
    installerPorteeRun(null);
    installerExecutionUsage(null);
  });

  afterAll(async () => {
    installerRegistreUsage(null);
    installerContexteUsage(null);
    installerMetriquesBoucle(null);
    installerMetriquesOutils(null);
    installerPorteeExecution(null);
    await t.fermer();
  });

  it("un tour d'une portée nommée hérite du compte et de l'origine du tour parent", async () => {
    await isolerUsage(() =>
      usageScope("chat", { userId: 2, originId: "c7" }, async () => {
        expect(contexteUsage().utilisateurCourant()).toBe(2);
        await enregistrerTour(t.base, {
          model: "m",
          path: "classic",
          inputTokens: 5,
          outputTokens: 1,
          submittedTokens: 5,
          thinkingTokens: 0,
          usage: {},
          durationMs: 3,
          iterations: 1,
          status: "ok",
          scope: "title",
        });
      }),
    );
    const [l] = await t.base.all("SELECT source, user_id, origin_id, parent_id FROM usage_events");
    expect(l).toEqual({ source: "title", user_id: 2, origin_id: "c7", parent_id: "" });
    await t.base.run("DELETE FROM usage_events");
  });

  it("requêtes mesurées : celles du tour, sinon une par appel unique qui rapporte le cache ; jamais plus de servies que de mesurées", async () => {
    const base = {
      model: "m",
      path: "classic",
      inputTokens: 50,
      outputTokens: 1,
      submittedTokens: 50,
      thinkingTokens: 0,
      durationMs: 1,
      iterations: 1,
      status: "ok",
    };
    await enregistrerTour(t.base, {
      ...base,
      usage: { cache_read_input_tokens: 900 },
      cacheReportedCalls: 3,
      cacheHitCalls: 2,
    });
    await enregistrerTour(t.base, { ...base, usage: { cache_read_input_tokens: 40 } });
    await enregistrerTour(t.base, { ...base, usage: { prompt_tokens_details: { cached_tokens: 0 } } });
    await enregistrerTour(t.base, { ...base, usage: {} });
    await enregistrerTour(t.base, { ...base, inputTokens: 0, outputTokens: 0, status: "error", usage: {} });
    await recordTurnUsage(t.base, {
      inputTokens: 10,
      outputTokens: 1,
      cacheReportedCalls: 1,
      cacheHitCalls: 5,
    });
    expect(
      await t.base.valeurs("SELECT cache_reported_calls, cache_hit_calls FROM usage_events ORDER BY id"),
    ).toEqual([
      [3, 2],
      [1, 1],
      [1, 0],
      [0, 0],
      [0, 0],
      [1, 1],
    ]);
    await t.base.run("DELETE FROM usage_events");
  });

  it("la métrique de la boucle reçoit l'uid du tour et l'écrit tel quel dans metric_events", async () => {
    await t.base.run("DELETE FROM metric_events");
    try {
      logMetricBoucle("message_sent", 1, { role: "user", user: "alice" }, 2);
      logMetricBoucle("tool_call", 1, { tool: "fs_read", user: "alice" });
      await vi.waitFor(async () =>
        expect(await t.base.valeurs("SELECT event_type, user_id FROM metric_events ORDER BY id")).toEqual([
          ["message_sent", 2],
          ["tool_call", IDS["alice"]],
        ]),
      );
    } finally {
      await t.base.run("DELETE FROM metric_events");
    }
  });

  it("l'exécution courante reçoit l'usage et porte l'identifiant de la ligne", async () => {
    const recus: UsageExecution[] = [];
    installerExecutionUsage(() => ({ id: "run-1", ajouterUsage: (u) => recus.push(u) }));
    await recordTurnUsage(t.base, {
      model: "m",
      inputTokens: 100,
      outputTokens: 10,
      usage: { tool_input_tokens: 900 },
    });
    const [l] = await t.base.all("SELECT run_id, tool_tokens FROM usage_events");
    expect(l).toEqual({ run_id: "run-1", tool_tokens: 100 });
    expect(recus).toEqual([
      {
        source: "unknown",
        status: "ok",
        input_tokens: 100,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        thinking_tokens: 0,
        tool_tokens: 100,
        error_kind: "",
      },
    ]);
    await t.base.run("DELETE FROM usage_events");
  });

  it("portée d'un sous-agent : exécution autour, usage dedans, compte hérité", async () => {
    const ordre: string[] = [];
    installerPorteeRun(async (p, fn) => {
      ordre.push(`run:${p.genre}`);
      return fn();
    });
    const vu = await isolerUsage(() =>
      usageScope("chat", { userId: 4, originId: "c1" }, () =>
        dansPortee(
          { genre: "subagent", userId: null, chatId: "c1#x", model: "m", engine: "builtin", parentId: "c1" },
          async () => {
            ordre.push("corps");
            return ctx();
          },
        ),
      ),
    );
    expect(ordre).toEqual(["run:subagent", "corps"]);
    expect(vu).toEqual({ source: "subagent", user_id: 4, origin_id: "c1#x", parent_id: "c1" });
  });

  it("métriques de la boucle et appels d'outils écrits en arrière-plan ; compte inconnu ignoré", async () => {
    viderCacheComptesOutils();
    logMetricBoucle("tool_call", 1, { tool: "read_file", user: "alice", status: "ok" });
    const f = metriqueOutil();
    expect(f).not.toBeNull();
    await f?.({
      username: "alice",
      run_id: "c1",
      tool_name: "read_file",
      status: "success",
      duration_ms: 12.7,
      error_short: null,
      category: "fs",
    });
    await f?.({
      username: "personne",
      run_id: "c1",
      tool_name: "x",
      status: "error",
      duration_ms: 1,
      error_short: "e",
      category: "y",
    });
    await vi.waitFor(async () =>
      expect(await t.base.all("SELECT event_type, user_id FROM metric_events")).toEqual([
        { event_type: "tool_call", user_id: 2 },
      ]),
    );
    expect(
      await t.base.all("SELECT user_id, tool_name, duration_ms, category FROM tool_call_metrics"),
    ).toEqual([{ user_id: 2, tool_name: "read_file", duration_ms: 12, category: "fs" }]);
    recordTurnUsageBoucle({
      model: "m",
      path: "tools",
      inputTokens: 1,
      outputTokens: 1,
      submittedTokens: 1,
      thinkingTokens: 0,
      usage: {},
      durationMs: 1,
      iterations: 1,
      status: "ok",
    });
    await vi.waitFor(async () => expect((await t.base.all("SELECT 1 FROM usage_events")).length).toBe(1));
  });

  it("base indisponible : rien ne lève, faux rendu", async () => {
    const cassee = {
      dialecte: "sqlite",
      run: () => Promise.reject(new Error("base indisponible")),
      get: () => Promise.reject(new Error("base indisponible")),
      all: () => Promise.reject(new Error("base indisponible")),
    } as unknown as Executeur;
    expect(await recordUsage(cassee, { userId: 1, source: "chat", inputTokens: 10 })).toBe(false);
    expect(await recordTurnUsage(cassee, { inputTokens: 1, outputTokens: 1 })).toBe(false);
    await expect(logMetric(cassee, "x", 1, { user: "alice" })).resolves.toBeUndefined();
    await expect(
      recordToolCallMetric(cassee, { runId: "r", userId: 1, toolName: "t" }),
    ).resolves.toBeUndefined();
    await expect(
      enregistrerAppelOutil(cassee, {
        username: "z",
        run_id: "r",
        tool_name: "t",
        status: "s",
        duration_ms: 1,
        error_short: null,
        category: "c",
      }),
    ).resolves.toBeUndefined();
    expect(await purgeUsageEvents(cassee, 3)).toBe(0);
    expect(await purgeToolCallMetrics(cassee, 3)).toBe(0);
  });
});
