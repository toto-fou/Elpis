// SPDX-License-Identifier: MIT
/** apps/core/test/routines/magasin.test.ts — magasin des routines (tests/db/test_routines_db.py et parties magasin des tests de routes) : cloisonnement, admission atomique entre connexions, garde par minute, transitions gardées, rétention, récap, dédup. */
import { randomBytes } from "node:crypto";
import { initialiserBase, ouvrirBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNotification, listNotifications } from "../../src/notifications/stockage";
import * as R from "../../src/routines/magasin";

/** Clé du coffre de l'essai (secrets de webhook chiffrés), jamais celle du système. */
configurerCoffre({
  cleEnv: randomBytes(32).toString("base64"),
  systeme: "/nonexistent/vault.key",
  repli: "/nonexistent/.vault.key",
});

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

function routine(nom = "r1", sur: Partial<R.ChampsRoutine> = {}): R.ChampsRoutine {
  return {
    name: nom,
    cron_expr: "* * * * *",
    model: null,
    system_prompt: "",
    task_prompt: "do it",
    mcp_servers: [],
    ...sur,
  };
}

async function run(base: Base, rid: number, statut = "ok"): Promise<number> {
  const id = await R.admitAndInsertRun(base, rid, 1, { trigger: "schedule", cap: 10, workerBootId: "t" });
  if (id === null) throw new Error("admission refusée");
  if (statut === "ok") expect(await R.markRunOk(base, id, { summary: "s" })).toBe(true);
  else if (statut === "error") expect(await R.markRunError(base, id, { error: "e" })).toBe(true);
  else if (statut === "cancelled") expect(await R.markRunCancelled(base, id)).toBe(true);
  else if (statut === "skipped") expect(await R.markRunSkipped(base, id, { reason: "r" })).toBe(true);
  vi.setSystemTime(Date.now() + 2);
  return id;
}

describe.each(MOTEURS)("magasin des routines (%s)", (moteur) => {
  let t: BaseDeTest;
  let b: Base;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    t = ouvrirBaseDeTest(moteur);
    b = t.base;
    await initialiserBase(b);
    for (const nom of ["alice", "bob"])
      await b.run("INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES (?, 's', 'h', 0)", [
        nom,
      ]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await t.fermer();
  });

  it("secrets MCP retirés à la création, cloisonnement par propriétaire", async () => {
    const rid = await R.createRoutine(
      b,
      1,
      routine("s", {
        mcp_servers: [
          {
            type: "sse",
            name: "x",
            url: "http://h",
            auth: "Bearer S",
            headers: { k: "v" },
            filter_categories: ["a"],
          },
        ],
      }),
    );
    expect((await R.getRoutine(b, rid, 1))?.["mcp_snapshot"]).toEqual([
      { type: "sse", name: "x", url: "http://h", filter_categories: ["a"] },
    ]);
    expect(await R.getRoutine(b, rid, 2)).toBeNull();
    expect(await R.updateRoutine(b, rid, 2, { name: "hacked" })).toBe(false);
    expect(await R.setRoutineEnabled(b, rid, 2, false)).toBe(false);
    expect(await R.deleteRoutine(b, rid, 2)).toBe(false);
    expect(await R.updateRoutine(b, rid, 1, { name: "renamed" })).toBe(true);
    expect((await R.getRoutine(b, rid, 1))?.["name"]).toBe("renamed");
  });

  it("admission : plafond par compte atomique (requêtes concurrentes), id distincts, place rendue à la fin d'un run", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    const ids = await Promise.all(
      Array.from({ length: 12 }, () =>
        R.admitAndInsertRun(b, rid, 1, { trigger: "schedule", cap: 5, workerBootId: "t" }),
      ),
    );
    const admis = ids.filter((i) => i !== null);
    expect([admis.length, new Set(admis).size]).toEqual([5, 5]);
    expect(
      await R.admitAndInsertRun(b, rid, 1, { trigger: "schedule", cap: 5, workerBootId: "t" }),
    ).toBeNull();
    const r2 = await R.createRoutine(b, 2, routine("r2"));
    expect(
      await R.admitAndInsertRun(b, r2, 2, { trigger: "schedule", cap: 1, workerBootId: "t" }),
    ).not.toBeNull();
    expect(await R.markRunOk(b, admis[0] as number, { outputTokens: 3, summary: "ok" })).toBe(true);
    expect(
      await R.admitAndInsertRun(b, rid, 1, { trigger: "schedule", cap: 5, workerBootId: "t" }),
    ).not.toBeNull();
  });

  it("garde anti-chevauchement dans la transaction d'admission (F10) ; sans elle, le plafond seul", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    const a = { trigger: "manual", cap: 10, workerBootId: "t", overlapFreshAfterS: 300 };
    expect(await R.admitAndInsertRun(b, rid, 1, a)).toBeTypeOf("number");
    expect(await R.admitAndInsertRun(b, rid, 1, a)).toBeNull();
    expect(await R.admitAndInsertRun(b, rid, 1, { ...a, overlapFreshAfterS: null })).toBeTypeOf("number");
    vi.setSystemTime(Date.now() + 301_000);
    expect(await R.admitAndInsertRun(b, rid, 1, a)).toBeTypeOf("number");
    expect(await R.countRunningForRoutine(b, rid)).toBe(3);
    expect(await R.countRunningForRoutine(b, rid, 300)).toBe(1);
  });

  it("garde par minute : une seule prise par routine et par minute", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    expect(await R.claimMinuteFire(b, rid, "2026-06-04T10:00")).toBe(true);
    expect(await R.claimMinuteFire(b, rid, "2026-06-04T10:00")).toBe(false);
    expect(await R.claimMinuteFire(b, rid, "2026-06-04T10:01")).toBe(true);
    expect(await R.claimMinuteFire(b, 9999, "2026-06-04T10:02")).toBe(false);
  });

  it("transitions gardées WHERE status='running', orphelins réconciliés par battement", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    const perime = await R.admitAndInsertRun(b, rid, 1, { trigger: "schedule", cap: 5, workerBootId: "t" });
    vi.setSystemTime(Date.now() + 400_000);
    const frais = await R.admitAndInsertRun(b, rid, 1, { trigger: "schedule", cap: 5, workerBootId: "t" });
    expect(await R.reconcileOrphans(b, 300)).toBe(1);
    const statuts = Object.fromEntries((await R.listRuns(b, rid, 1)).map((r) => [r["id"], r["status"]]));
    expect(statuts).toEqual({ [String(perime)]: "orphaned", [String(frais)]: "running" });
    expect(await R.markRunOk(b, perime as number, { summary: "x" })).toBe(false);
    expect(await R.markRunOk(b, frais as number, { summary: "done" })).toBe(true);
    expect(await R.markRunOk(b, frais as number, { summary: "again" })).toBe(false);
    expect(await R.markRunCancelled(b, frais as number)).toBe(false);
    expect(await R.heartbeatRun(b, frais as number)).toBe(false);
  });

  it("annulation et requalification en skipped : statuts dédiés, propriétaire seul", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    const id = await R.admitAndInsertRun(b, rid, 1, { trigger: "manual", cap: 10, workerBootId: "t" });
    expect(await R.markRunCancelled(b, id as number, 1234)).toBe(true);
    const r = await R.getRun(b, id as number, 1);
    expect([r?.["status"], r?.["duration_ms"], r?.["ended_at"] !== null]).toEqual(["cancelled", 1234, true]);
    expect(await R.getRun(b, id as number, 2)).toBeNull();
    const id2 = await R.admitAndInsertRun(b, rid, 1, { trigger: "manual", cap: 10, workerBootId: "t" });
    expect(await R.markRunSkipped(b, id2 as number, { reason: "routine désactivée avant démarrage" })).toBe(
      true,
    );
    expect((await R.getRun(b, id2 as number, 1))?.["error"]).toBe("routine désactivée avant démarrage");
    expect(await R.markRunSkipped(b, id2 as number, { reason: "x" })).toBe(false);
  });

  it("échec avec bilan conservé ; échec sans bilan compatible", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    const id = await R.admitAndInsertRun(b, rid, 1, { trigger: "manual", cap: 10, workerBootId: "b" });
    expect(
      await R.markRunError(b, id as number, {
        error: "génération interrompue",
        durationMs: 1234,
        summary: "travail partiel",
        inputTokens: 40,
        outputTokens: 12,
        files: ["/work/a.txt"],
      }),
    ).toBe(true);
    const r = await R.getRun(b, id as number, 1);
    expect([r?.["status"], r?.["summary"], r?.["input_tokens"], r?.["output_tokens"], r?.["files"]]).toEqual([
      "error",
      "travail partiel",
      40,
      12,
      '["/work/a.txt"]',
    ]);
    const id2 = await R.admitAndInsertRun(b, rid, 1, { trigger: "manual", cap: 10, workerBootId: "b" });
    expect(await R.markRunError(b, id2 as number, { error: "boum" })).toBe(true);
    expect([
      (await R.getRun(b, id2 as number, 1))?.["error"],
      (await R.getRun(b, id2 as number, 1))?.["summary"],
    ]).toEqual(["boum", ""]);
  });

  it("fichiers d'un run : liste décodée, dédupliquée, bornée ; [] par défaut", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    const id = await R.admitAndInsertRun(b, rid, 1, { trigger: "manual", cap: 10, workerBootId: "b" });
    await R.markRunOk(b, id as number, {
      summary: "ok",
      files: ["/work/a.md", " /work/a.md ", "", "/work/b.md"],
    });
    const id2 = await R.admitAndInsertRun(b, rid, 1, { trigger: "manual", cap: 10, workerBootId: "b" });
    await R.markRunOk(b, id2 as number, { summary: "sans fichier" });
    const parId = Object.fromEntries((await R.listRuns(b, rid, 1)).map((r) => [r["id"], r["files"]]));
    expect(parId).toEqual({ [String(id)]: ["/work/a.md", "/work/b.md"], [String(id2)]: [] });
    await b.run("UPDATE editor_routine_runs SET files='{' WHERE id=?", [id as number]);
    expect((await R.listRuns(b, rid, 1)).find((r) => r["id"] === id)?.["files"]).toEqual([]);
  });

  it("pagination du journal : borne et ordre (départ puis id décroissants), cloisonnée", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(await run(b, rid));
    expect((await R.listRuns(b, rid, 1)).map((r) => r["id"])).toEqual([...ids].reverse());
    expect((await R.listRuns(b, rid, 1, { limit: 2, offset: 1 })).map((r) => r["id"])).toEqual([
      ids[2],
      ids[1],
    ]);
    expect((await R.listRuns(b, rid, 1, { limit: 0 })).length).toBe(4);
    expect((await R.listRuns(b, rid, 1, { limit: -5 })).length).toBe(1);
    expect(await R.listRuns(b, rid, 2)).toEqual([]);
  });

  it("skills : désinfectés à la création, PUT absent inchangé, [] vide", async () => {
    const rid = await R.createRoutine(
      b,
      1,
      routine("s", { skills: ["jenkins/deploy", " veille ", "jenkins/deploy", "", 42, null] }),
    );
    expect((await R.getRoutine(b, rid, 1))?.["skills"]).toEqual(["jenkins/deploy", "veille"]);
    expect(await R.updateRoutine(b, rid, 1, { skills: [] })).toBe(true);
    expect((await R.getRoutine(b, rid, 1))?.["skills"]).toEqual([]);
    expect(await R.updateRoutine(b, rid, 1, { skills: ["x"], name: "n2" })).toBe(true);
    expect(await R.updateRoutine(b, rid, 1, { name: "n3" })).toBe(true);
    expect((await R.getRoutine(b, rid, 1))?.["skills"]).toEqual(["x"]);
  });

  it("champs nullables écrits à NULL, absents inchangés ; aucun champ = existence", async () => {
    const rid = await R.createRoutine(b, 1, routine("m", { model: "qwen", trigger_after_id: null }));
    expect(await R.updateRoutine(b, rid, 1, { model: null, name: null })).toBe(true);
    const r = await R.getRoutine(b, rid, 1);
    expect([r?.["model"], r?.["name"]]).toEqual([null, "m"]);
    expect(await R.updateRoutine(b, rid, 1, {})).toBe(true);
    expect(await R.updateRoutine(b, 999999, 1, {})).toBe(false);
    expect(await R.updateRoutine(b, rid, 1, { agents_enabled: true })).toBe(true);
    expect((await R.getRoutine(b, rid, 1))?.["agents_enabled"]).toBe(false);
  });

  it("historique par routine : défauts, normalisation, création", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    const h = async (id: number): Promise<unknown[]> => {
      const r = await R.getRoutine(b, id, 1);
      return [r?.["runs_keep"], r?.["notify_on"], r?.["notify_keep"]];
    };
    expect(await h(rid)).toEqual([0, "all", 0]);
    await R.updateRoutine(b, rid, 1, { runs_keep: 25, notify_on: "ERROR", notify_keep: 3 });
    expect(await h(rid)).toEqual([25, "error", 3]);
    await R.updateRoutine(b, rid, 1, { runs_keep: 99999, notify_on: "maybe", notify_keep: -4 });
    expect(await h(rid)).toEqual([R.KEEP_MAX, "all", 0]);
    await R.updateRoutine(b, rid, 1, { runs_keep: true, notify_keep: "12" });
    expect((await h(rid)).filter((_v, i) => i !== 1)).toEqual([0, 12]);
    const rid2 = await R.createRoutine(
      b,
      1,
      routine("h", { runs_keep: 2, notify_on: "none", notify_keep: 1 }),
    );
    expect(await h(rid2)).toEqual([2, "none", 1]);
    expect(
      Object.fromEntries((await R.listEnabledRoutines(b)).map((x) => [x["id"], x["runs_keep"]])),
    ).toEqual({
      [String(rid)]: 0,
      [String(rid2)]: 2,
    });
  });

  it("runs_keep : toutes les transitions terminales l'appliquent ; un run vivant n'est ni compté ni supprimé ; par routine", async () => {
    const a = await R.createRoutine(b, 1, routine("A"));
    const c = await R.createRoutine(b, 1, routine("B"));
    await R.updateRoutine(b, a, 1, { runs_keep: 1 });
    await run(b, a, "ok");
    let dernier = await run(b, a, "error");
    expect((await R.listRuns(b, a, 1)).map((r) => r["id"])).toEqual([dernier]);
    dernier = await run(b, a, "cancelled");
    expect((await R.listRuns(b, a, 1)).map((r) => r["id"])).toEqual([dernier]);
    dernier = await run(b, a, "skipped");
    expect((await R.listRuns(b, a, 1)).map((r) => r["id"])).toEqual([dernier]);
    dernier = await R.insertSkippedRun(b, a, 1, { trigger: "schedule", reason: "cap" });
    expect((await R.listRuns(b, a, 1)).map((r) => r["id"])).toEqual([dernier]);
    const vivant = await R.admitAndInsertRun(b, a, 1, { trigger: "manual", cap: 10, workerBootId: "t" });
    vi.setSystemTime(Date.now() + 2);
    const saute = await R.insertSkippedRun(b, a, 1, { trigger: "schedule", reason: "cap" });
    expect(Object.fromEntries((await R.listRuns(b, a, 1)).map((r) => [r["id"], r["status"]]))).toEqual({
      [String(vivant)]: "running",
      [String(saute)]: "skipped",
    });
    expect(await R.markRunOk(b, vivant as number, { summary: "fin" })).toBe(true);
    expect((await R.listRuns(b, a, 1)).map((r) => r["id"])).toEqual([saute]);
    for (let i = 0; i < 3; i++) await run(b, c);
    expect((await R.listRuns(b, c, 1)).length).toBe(3);
  });

  it("suppression : runs en cascade, pointeurs d'aval, dédup et récap de la routine ; renommage : titres réécrits", async () => {
    const a = await R.createRoutine(b, 1, routine("Veille"));
    const c = await R.createRoutine(b, 1, routine("Backup", { cron_expr: "", trigger_after_id: a }));
    await R.admitAndInsertRun(b, a, 1, { trigger: "schedule", cap: 5, workerBootId: "t" });
    expect(await R.recordWebhookDelivery(b, "d-1", a)).toBe(true);
    await createNotification(
      b,
      1,
      "routine_ok",
      R.routineNotificationTitle("Veille", a, true),
      "corps 1",
      "routine",
      a,
    );
    await createNotification(
      b,
      1,
      "routine_error",
      R.routineNotificationTitle("Veille", a, false),
      "",
      "routine",
      a,
    );
    await createNotification(
      b,
      1,
      "routine_ok",
      R.routineNotificationTitle("Backup", c, true),
      "",
      "routine",
      c,
    );
    await createNotification(b, 2, "routine_ok", "Routine « X » terminée", "", "routine", a);
    expect(await R.updateRoutine(b, a, 1, { name: "Veille v2" })).toBe(true);
    const titres = async (): Promise<string[]> =>
      (await listNotifications(b, 1, 50)).map((n) => String(n["title"])).sort();
    expect(await titres()).toEqual([
      "Routine « Backup » terminée",
      "Routine « Veille v2 » en échec",
      "Routine « Veille v2 » terminée",
    ]);
    expect(await R.updateRoutine(b, a, 1, { task_prompt: "autre" })).toBe(true);
    expect(await R.deleteRoutine(b, a, 1)).toBe(true);
    expect(await R.getRoutine(b, a, 1)).toBeNull();
    expect(await R.listRuns(b, a, 1)).toEqual([]);
    expect((await R.getRoutine(b, c, 1))?.["trigger_after_id"]).toBeNull();
    expect(await R.recordWebhookDelivery(b, "d-1", a)).toBe(true);
    expect(await titres()).toEqual(["Routine « Backup » terminée"]);
    expect((await listNotifications(b, 2, 50)).map((n) => n["title"])).toEqual(["Routine « X » terminée"]);
  });

  it("webhook : secret jamais rendu, rotation, dédup des livraisons purgée au TTL, retrait ciblé", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    expect(await R.setRoutineWebhook(b, rid, 1, {})).toBe(false);
    expect(await R.setRoutineWebhook(b, rid, 1, { enabled: true, secret: "s3cr3t" })).toBe(true);
    expect(await R.setRoutineWebhook(b, rid, 2, { enabled: false })).toBe(false);
    const r = await R.getRoutine(b, rid, 1);
    expect([
      r?.["webhook_enabled"],
      r?.["webhook_has_secret"],
      Object.hasOwn(r ?? {}, "webhook_secret"),
    ]).toEqual([true, true, false]);
    expect(await R.getRoutineWebhookSecret(b, rid)).toBe("s3cr3t");
    expect(await R.getRoutineWebhookSecret(b, 9999)).toBeNull();
    expect(
      await R.setRoutineWebhook(b, rid, 1, { filter: { events: ["push"], branch: "main", repo: "" } }),
    ).toBe(true);
    expect((await R.getRoutine(b, rid, 1))?.["webhook_filter"]).toEqual({
      events: ["push"],
      branch: "main",
      repo: "",
    });
    expect(await R.recordWebhookDelivery(b, "shared-id", 1)).toBe(true);
    expect(await R.recordWebhookDelivery(b, "shared-id", 2)).toBe(true);
    expect(await R.recordWebhookDelivery(b, "shared-id", 1)).toBe(false);
    expect(await R.forgetWebhookDelivery(b, "shared-id", 1)).toBe(true);
    expect(await R.recordWebhookDelivery(b, "shared-id", 1)).toBe(true);
    expect(await R.recordWebhookDelivery(b, "shared-id", 2)).toBe(false);
    expect(await R.forgetWebhookDelivery(b, "jamais-vue", 99)).toBe(false);
    vi.setSystemTime(Date.now() + 86_401_000);
    expect(await R.recordWebhookDelivery(b, "shared-id", 2)).toBe(true);
    vi.setSystemTime(Date.now() + 86_401_000);
    expect(await R.purgeWebhookDeliveries(b)).toBe(1);
    expect(await R.recordWebhookDelivery(b, "x".repeat(200), 1)).toBe(true);
    expect(await R.recordWebhookDelivery(b, "x".repeat(150), 1)).toBe(false);
  });

  it("purges : runs terminés anciens seulement ; rétention nulle sans effet", async () => {
    const rid = await R.createRoutine(b, 1, routine());
    await run(b, rid);
    const vivant = await R.admitAndInsertRun(b, rid, 1, { trigger: "manual", cap: 10, workerBootId: "t" });
    vi.setSystemTime(Date.now() + 200 * 86_400_000);
    await run(b, rid);
    expect(await R.purgeRoutineRuns(b, 0)).toBe(0);
    expect(await R.purgeRoutineRuns(b, 180)).toBe(1);
    expect((await R.listRuns(b, rid, 1)).map((r) => r["status"]).sort()).toEqual(["ok", "running"]);
    expect(vivant).not.toBeNull();
  });

  it("routines avales : actives seulement, pointant la routine amont", async () => {
    const a = await R.createRoutine(b, 1, routine("A"));
    const c = await R.createRoutine(b, 1, routine("B", { trigger_after_id: a, trigger_after_on: "error" }));
    await R.createRoutine(b, 1, routine("C", { trigger_after_id: a, enabled: false }));
    await R.createRoutine(b, 1, routine("D", { trigger_after_on: "bizarre" }));
    const aval = await R.listChainedRoutines(b, a);
    expect(aval.map((r) => [r["id"], r["trigger_after_on"]])).toEqual([[c, "error"]]);
    expect((await R.listRoutines(b, 1)).find((r) => r["name"] === "D")?.["trigger_after_on"]).toBe("ok");
  });

  it("liste : dernier run (départ puis id) et runs en cours par routine, sans N+1", async () => {
    const a = await R.createRoutine(b, 1, routine("A"));
    vi.setSystemTime(Date.now() + 1000);
    const c = await R.createRoutine(b, 1, routine("B"));
    const premier = await R.admitAndInsertRun(b, a, 1, { trigger: "manual", cap: 10, workerBootId: "t" });
    const second = await R.insertSkippedRun(b, a, 1, { trigger: "schedule", reason: "cap" });
    const items = await R.listRoutines(b, 1);
    expect(items.map((r) => r["id"])).toEqual([c, a]);
    const A = items[1] ?? {};
    expect([(A["last_run"] as Record<string, unknown>)["status"], A["running_count"]]).toEqual([
      "skipped",
      1,
    ]);
    expect(Object.keys(A["last_run"] as object)).toEqual([
      "routine_id",
      "status",
      "started_at",
      "ended_at",
      "duration_ms",
    ]);
    expect([items[0]?.["last_run"], items[0]?.["running_count"]]).toEqual([null, 0]);
    expect([premier, second].every((x) => typeof x === "number")).toBe(true);
    expect(await R.listRoutines(b, 2)).toEqual([]);
  });

  it("suppression du compte : ses routines partent avec lui (cascade)", async () => {
    await R.createRoutine(b, 2, routine("r"));
    expect((await R.listEnabledRoutines(b)).length).toBe(1);
    await b.run("DELETE FROM users WHERE id=2");
    expect(await R.listEnabledRoutines(b)).toEqual([]);
  });
});

describe("admission entre deux process (deux connexions SQLite sur le même fichier)", () => {
  it("le plafond tient entre connexions concurrentes", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    const autre = ouvrirBase({ backend: "sqlite", path: t.emplacement, lockTimeoutMs: 5000 });
    try {
      await initialiserBase(t.base);
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('alice', 's', 'h', 0)",
      );
      const rid = await R.createRoutine(t.base, 1, routine());
      const a = { trigger: "webhook", cap: 3, workerBootId: "w" };
      const ids = await Promise.all(
        Array.from({ length: 10 }, (_v, i) => R.admitAndInsertRun(i % 2 ? autre : t.base, rid, 1, a)),
      );
      expect(ids.filter((x) => x !== null).length).toBe(3);
    } finally {
      await autre.fermer();
      await t.fermer();
    }
  });
});
