// SPDX-License-Identifier: MIT
/** apps/core/test/routines/goldens-runs.test.ts — goldens `runs_routine_*` (harnais « runs », table editor_routine_runs) rejoués sur le magasin, SQLite et PostgreSQL, horloge logique T0 + a. */
import { readdirSync, readFileSync } from "node:fs";

import { createUser } from "@elpis/auth";
import { pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as R from "../../src/routines/magasin";

const RACINE = new URL("../../../../tests/goldens/", import.meta.url);
const T0 = 1_700_000_000;
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const NOMS = readdirSync(RACINE)
  .filter((f) => /^runs_routine_.+\.json$/u.test(f))
  .map((f) => f.slice(0, -5))
  .sort();

type Operation = { a: number } & Record<string, Dict>;

/** Instant relatif à T0 au millième, comme `_relatif` du harnais Python. */
function relatif(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  return Math.round((Number(v) - T0) * 1000) / 1000;
}

async function table(base: Base, noms: Map<number, string>): Promise<Dict[]> {
  const lignes = await base.all("SELECT * FROM editor_routine_runs ORDER BY id");
  return lignes.map((r) => {
    const d: Dict = { ...r };
    d["routine_id"] = noms.get(Number(r["routine_id"])) ?? r["routine_id"];
    for (const k of ["started_at", "ended_at", "heartbeat_at"]) d[k] = relatif(r[k]);
    d["files"] = JSON.parse(typeof r["files"] === "string" && r["files"] ? r["files"] : "[]") as unknown;
    return d;
  });
}

async function terminer(base: Base, c: Dict): Promise<boolean> {
  const run = Number(c["run"]);
  const duree = Number(c["duree_ms"] ?? 0);
  const bilan = {
    durationMs: duree,
    inputTokens: Number(c["jetons_entree"] ?? 0),
    outputTokens: Number(c["jetons_sortie"] ?? 0),
    summary: String(c["resume"] ?? ""),
    files: (c["fichiers"] as unknown[] | undefined) ?? null,
  };
  if (c["statut"] === "ok")
    return R.markRunOk(base, run, { ...bilan, toolLimitReached: c["plafond_outils"] === true });
  if (c["statut"] === "error")
    return R.markRunError(base, run, { ...bilan, error: String(c["erreur"] ?? "") });
  if (c["statut"] === "skipped")
    return R.markRunSkipped(base, run, { reason: String(c["raison"] ?? ""), durationMs: duree });
  return R.markRunCancelled(base, run, duree);
}

async function rejouer(base: Base, entrees: Dict): Promise<Dict[]> {
  vi.setSystemTime(T0 * 1000);
  const ids = new Map<string, number>();
  const comptes = new Map<string, number>();
  for (const r of entrees["routines"] as Dict[]) {
    const cle = String(r["cle"]);
    ids.set(
      cle,
      await R.createRoutine(base, Number(r["compte"]), {
        name: cle,
        cron_expr: "* * * * *",
        model: null,
        system_prompt: "",
        task_prompt: "tâche",
        mcp_servers: [],
        runs_keep: r["runs_keep"] ?? 0,
      }),
    );
    comptes.set(cle, Number(r["compte"]));
  }
  const noms = new Map([...ids].map(([cle, id]) => [id, cle]));
  const etapes: Dict[] = [];
  for (const o of entrees["operations"] as Operation[]) {
    vi.setSystemTime((T0 + o.a) * 1000);
    const [nom, c] = Object.entries(o).find(([k]) => k !== "a") as [string, Dict];
    const routine = (): number => ids.get(String(c["routine"])) ?? 0;
    const compte = (): number => comptes.get(String(c["routine"])) ?? 0;
    let rendu: unknown;
    if (nom === "admettre")
      rendu = await R.admitAndInsertRun(base, routine(), compte(), {
        trigger: String(c["declencheur"]),
        cap: Number(c["plafond"]),
        workerBootId: String(c["boot"]),
        overlapFreshAfterS: c["chevauchement_s"] === undefined ? null : Number(c["chevauchement_s"]),
      });
    else if (nom === "ignorer")
      rendu = await R.insertSkippedRun(base, routine(), compte(), {
        trigger: String(c["declencheur"]),
        reason: String(c["raison"]),
      });
    else if (nom === "battement") rendu = await R.heartbeatRun(base, Number(c["run"]));
    else if (nom === "terminer") rendu = await terminer(base, c);
    else if (nom === "reconcilier") rendu = await R.reconcileOrphans(base, Number(c["perime_s"]));
    else if (nom === "purger") rendu = await R.purgeRoutineRuns(base, Number(c["jours"]));
    else if (nom === "compter")
      rendu = await R.countRunningForRoutine(
        base,
        routine(),
        c["frais_s"] === undefined ? null : Number(c["frais_s"]),
      );
    else throw new Error(`opération inconnue : ${nom}`);
    etapes.push({ a: o.a, op: nom, rendu, table: await table(base, noms) });
  }
  return etapes;
}

afterEach(() => {
  vi.useRealTimers();
});

describe.each(MOTEURS)("goldens runs_routine_* (%s)", (moteur) => {
  it("au moins deux goldens du harnais", () => expect(NOMS.length).toBeGreaterThanOrEqual(2));

  it.each(NOMS)("%s : chaque étape, valeur rendue et table identiques", async (nom) => {
    const golden = JSON.parse(readFileSync(new URL(`${nom}.json`, RACINE), "utf-8")) as Dict;
    const entrees = golden["entrees"] as Dict;
    expect(entrees["harnais"]).toBe("runs");
    expect(entrees["table"]).toBe("routine");
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = ouvrirBaseDeTest(moteur);
    try {
      await initialiserBase(t.base);
      expect([
        await createUser(t.base, "alice", "pw-alice-12"),
        await createUser(t.base, "bob", "pw-bob-123"),
      ]).toEqual([1, 2]);
      const etapes = await rejouer(t.base, entrees);
      expect(JSON.parse(pyJsonDumps(etapes))).toStrictEqual(golden["etapes"]);
    } finally {
      vi.useRealTimers();
      await t.fermer();
    }
  });
});
