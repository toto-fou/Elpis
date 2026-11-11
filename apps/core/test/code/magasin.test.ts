// SPDX-License-Identifier: MIT
/** apps/core/test/code/magasin.test.ts — magasin de la page Code : fonctions rejouées contre le Python, réclamation atomique, routage, tombstone, balayage, élagage ; SQLite et PostgreSQL. */
import { readFileSync } from "node:fs";

import { ErreurPython, FlottantPy, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLIENT_TTL,
  CMD_TTL,
  MagasinCode,
  normalizePermission,
  normalizeQuestion,
  partTs,
  SESSION_TTL,
} from "../../src/code/magasin";

type Dict = Record<string, unknown>;
type Issue = { valeur: unknown } | { erreur: string };

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/code-page.json", import.meta.url), "utf-8")) as {
  fonctions: Dict;
};
const F = V.fonctions as {
  permissions: ({ entree: unknown } & Issue)[];
  questions: ({ entree: unknown } & Issue)[];
  parts: ({ entree: unknown } & Issue)[];
  parts_erreurs: ({ indice: number } & Issue)[];
};

function issue(f: () => unknown): Issue {
  try {
    const v = f();
    if (typeof v === "number" && !Number.isFinite(v))
      return { valeur: { $flottant: Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf" } };
    return { valeur: v };
  } catch (e) {
    if (e instanceof ErreurPython) return { erreur: e.type };
    throw e;
  }
}

/** Comparaison au texte JSON de Python : flottants entiers (`1.0`), ordre des clés, grands entiers. */
function memeJson(a: unknown, b: unknown): void {
  expect(pyJsonDumps(a, { ensureAscii: false })).toBe(pyJsonDumps(b, { ensureAscii: false }));
}

describe("fonctions rejouées contre le Python", () => {
  it.each(F.permissions.map((c, i) => [i, c] as const))("normalize_permission %i", (_i, c) => {
    memeJson(
      issue(() => normalizePermission(c.entree)),
      "valeur" in c ? { valeur: c.valeur } : c,
    );
  });

  it.each(F.questions.map((c, i) => [i, c] as const))("normalize_question %i", (_i, c) => {
    memeJson(
      issue(() => normalizeQuestion(c.entree)),
      "valeur" in c ? { valeur: c.valeur } : c,
    );
  });

  it.each(F.parts.map((c, i) => [i, c] as const))("_part_ts %i", (_i, c) => {
    const attendu: Issue = "valeur" in c ? { valeur: c.valeur } : { erreur: c.erreur };
    const obtenu = issue(() => partTs(c.entree));
    if ("valeur" in obtenu && typeof obtenu.valeur === "number" && "valeur" in attendu)
      expect(obtenu.valeur).toBe(Number(attendu.valeur as number | FlottantPy));
    else memeJson(obtenu, attendu);
  });

  it("_part_ts : infini gardé, entier hors des doubles → OverflowError", () => {
    const [inf, enorme] = F.parts_erreurs;
    expect(issue(() => partTs({ time: { start: new FlottantPy(Infinity) } }))).toEqual({
      valeur: (inf as { valeur: unknown }).valeur,
    });
    expect(issue(() => partTs({ time: 10n ** 400n }))).toEqual({
      erreur: (enorme as { erreur: string }).erreur,
    });
  });
});

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T0 = 1_800_000_000;

describe.each(MOTEURS)("magasin (%s)", (moteur) => {
  let t: BaseDeTest;
  let horloge: number;
  let m: MagasinCode;

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    horloge = T0;
    m = new MagasinCode(t.base, () => horloge);
  });

  afterEach(async () => {
    await t.fermer();
  });

  async function session(uid: number, cid: string, sid: string): Promise<void> {
    await m.seenClient(uid, cid, 14, "/w", true);
    await m.applyEvents(uid, [{ type: "session.created", properties: { info: { id: sid } } }], cid);
  }

  it("epoch posé une fois, stable entre deux magasins sur la même base (« redémarrage »)", async () => {
    expect(await m.getEpoch()).toBe(T0);
    horloge += 500;
    const autre = new MagasinCode(t.base, () => horloge);
    expect(await autre.getEpoch()).toBe(T0);
  });

  it("réclamation atomique : deux tirages concurrents ne prennent jamais deux fois la même commande", async () => {
    await session(1, "c1", "s1");
    for (let i = 0; i < 20; i++)
      await m.queueCommand(1, { id: `k${i}`, sid: "s1", kind: "prompt", text: `t${i}` });
    const autre = new MagasinCode(t.base, () => horloge);
    const tirages = await Promise.all([
      m.claimCommands(1, "c1"),
      autre.claimCommands(1, "c1"),
      m.claimCommands(1, "c1"),
    ]);
    const ids = tirages.flat().map((c) => c["id"]);
    expect(ids.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `k${i}`).sort());
  });

  it("routage : propriétaire vivant prioritaire, cible stricte, propriétaire mort → prenable par un autre", async () => {
    await session(1, "c1", "s1");
    await session(1, "c2", "s2");
    await m.queueCommand(1, { id: "a", sid: "s1", kind: "prompt", text: "pour c1" });
    await m.queueCommand(1, { id: "b", sid: "", kind: "action", action: "new", target: "c1" });
    expect(await m.claimCommands(1, "c2")).toEqual([]);
    expect((await m.claimCommands(1, "c1")).map((c) => c["id"])).toEqual(["a", "b"]);
    await m.queueCommand(1, { id: "c", sid: "s1", kind: "abort" });
    horloge += CLIENT_TTL + 1;
    await m.seenClient(1, "c2");
    expect((await m.claimCommands(1, "c2")).map((c) => c["id"])).toEqual(["c"]);
  });

  it("commande périmée (90 s) purgée au tirage ; isolation par compte", async () => {
    await session(1, "c1", "s1");
    await session(2, "c1", "s1");
    await m.queueCommand(1, { id: "x", sid: "s1", kind: "prompt" });
    expect(await m.claimCommands(2, "c1")).toEqual([]);
    horloge += CMD_TTL + 1;
    await m.seenClient(1, "c1");
    expect(await m.claimCommands(1, "c1")).toEqual([]);
  });

  it("bye : client mort tout de suite, un tirage tardif ne le ressuscite pas, l'ingest oui", async () => {
    await session(1, "c1", "s1");
    await m.clientBye(1, "c1");
    expect(await m.activeClients(1)).toEqual([]);
    expect(await m.lastIngest(1)).toBe(0);
    await m.seenClient(1, "c1");
    expect(await m.activeClients(1)).toEqual([]);
    await m.seenClient(1, "c1", 5, "", true);
    expect(await m.activeClients(1)).toEqual(["c1"]);
    expect(await m.clientPluginVersion(1, "c1")).toBe(5);
  });

  it("balayage : seule une commande que plus aucune CLI ne prendra est rendue (et purgée)", async () => {
    await session(1, "c1", "s1");
    await m.queueCommand(1, { id: "p", sid: "s1", kind: "prompt" });
    horloge += 60;
    await m.seenClient(1, "c1");
    expect(await m.sweepUndeliverable(1)).toEqual([]);
    horloge += CLIENT_TTL + 1;
    expect(await m.sweepUndeliverable(1)).toEqual([{ id: "p", sid: "s1", kind: "prompt" }]);
    expect(await m.claimCommands(1, "c1")).toEqual([]);
  });

  it("élagage : sessions de plus de 14 jours, notes et orphelins supprimés ; au plus toutes les 60 s", async () => {
    await session(1, "c1", "s1");
    await m.addNote(1, "s1", "n1", "command", "/x");
    await m.applyEvents(1, [
      { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "user" } } },
    ]);
    await m.prune();
    horloge += SESSION_TTL + 1;
    await m.prune();
    expect(await m.sessionsList(1)).toEqual([]);
    for (const table of ["code_messages", "code_notes", "code_sessions"])
      expect(await t.base.get(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual({ n: 0 });
    await session(1, "c1", "s2");
    horloge += 30;
    await t.base.run("UPDATE code_sessions SET updated_at=0");
    await m.prune();
    expect((await m.sessionsList(1)).map((s) => s["id"])).toEqual(["s2"]);
  });

  it("instantané vide : une seule session vide par CLI ; une session avec contenu n'est jamais balayée", async () => {
    await m.seenClient(1, "c1", 14, "", true);
    const instantane = (id: string, messages: unknown[]): Dict => ({
      type: "session.snapshot",
      properties: { session: { id }, messages },
    });
    await m.applyEvents(
      1,
      [instantane("avec", [{ info: { id: "m1", sessionID: "avec" }, parts: [] }])],
      "c1",
    );
    await m.applyEvents(1, [instantane("v1", [])], "c1");
    await m.applyEvents(1, [instantane("v2", [])], "c1");
    expect((await m.sessionsList(1)).map((s) => s["id"]).sort()).toEqual(["avec", "v2"]);
  });
});
