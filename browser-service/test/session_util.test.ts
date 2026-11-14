// SPDX-License-Identifier: MIT
// test/session_util.test.ts — pingPage borné + quota screenshots par session
// (AUDIT 2026-06). Sans Playwright : pages factices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pingPage, planScreenshotQuota } from "../src/session_util.ts";

// ── pingPage ─────────────────────────────────────────────────────────

test("pingPage: page qui répond → ok", async () => {
  const page = { evaluate: async () => true };
  assert.equal(await pingPage(page, 1000), "ok");
});

test("pingPage: evaluate qui rejette → crashed", async () => {
  const page = {
    evaluate: async () => {
      throw new Error("Target closed");
    },
  };
  assert.equal(await pingPage(page, 1000), "crashed");
});

test("pingPage: contexte détruit par une navigation (goto échoué) → resondé, ok (pas un crash)", async () => {
  let n = 0;
  const page = {
    isClosed: () => false,
    evaluate: async () => {
      if (n++ === 0)
        throw new Error(
          "page.evaluate: Execution context was destroyed, most likely because of a navigation",
        );
      return true;
    },
  };
  assert.equal(await pingPage(page, 2000), "ok");
  assert.equal(n, 2);
});

test("pingPage: page fermée, même avec un message de navigation → crashed", async () => {
  const page = {
    isClosed: () => true,
    evaluate: async () => {
      throw new Error("Execution context was destroyed");
    },
  };
  assert.equal(await pingPage(page, 1000), "crashed");
});

test("pingPage: navigation qui ne finit pas dans le délai → frozen", async () => {
  const page = {
    isClosed: () => false,
    evaluate: async () => {
      throw new Error("Execution context was destroyed");
    },
  };
  assert.equal(await pingPage(page, 300), "frozen");
});

test("pingPage: evaluate qui ne résout jamais → frozen sous le timeout", async () => {
  const page = { evaluate: () => new Promise(() => {}) };
  const t0 = Date.now();
  const verdict = await pingPage(page, 50);
  assert.equal(verdict, "frozen");
  assert.ok(Date.now() - t0 < 1000, "doit rendre la main vite");
});

// ── planScreenshotQuota ──────────────────────────────────────────────

function mkEntries(sid: string, kind: string, n: number, { size = 1000, t0 = 1_000_000 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    name: `${kind}_${sid}_${i}.png`,
    sid,
    mtimeMs: t0 + i,
    size,
  }));
}

test("quota: sous les caps → rien à supprimer", () => {
  const entries = mkEntries("aaaabbbb-1111", "step", 10);
  assert.deepEqual(planScreenshotQuota(entries, { maxPerSession: 300 }), []);
});

test("quota count: garde les N plus récents, supprime les plus anciens", () => {
  const entries = mkEntries("aaaabbbb-1111", "step", 10);
  const del = planScreenshotQuota(entries, { maxPerSession: 7, maxBytesPerSession: 1e9 });
  // 3 à supprimer : les mtime les plus anciens (i = 0,1,2)
  assert.deepEqual(del, ["step_aaaabbbb-1111_0.png", "step_aaaabbbb-1111_1.png", "step_aaaabbbb-1111_2.png"]);
});

test("quota bytes: coupe au-delà du volume", () => {
  const entries = mkEntries("aaaabbbb-1111", "shot", 5, { size: 100 });
  // cap 250 octets → garde les 2 plus récents (200), le 3e dépasse
  const del = planScreenshotQuota(entries, { maxPerSession: 999, maxBytesPerSession: 250 });
  assert.equal(del.length, 3);
  assert.ok(del.includes("shot_aaaabbbb-1111_0.png"));
});

test("quota: par session, pas global", () => {
  const entries = [...mkEntries("aaaabbbb-1111", "step", 5), ...mkEntries("ccccdddd-2222", "step", 5)];
  const del = planScreenshotQuota(entries, { maxPerSession: 5, maxBytesPerSession: 1e9 });
  assert.deepEqual(del, []); // 5+5 mais 5 max PAR session → ok
});

test("quota: live_/smart_/view_ jamais éligibles", () => {
  const entries = [
    { name: "live_aaaabbbb-1111.png", sid: "aaaabbbb-1111", mtimeMs: 1, size: 1e12 },
    { name: "smart_aaaabbbb-1111.png", sid: "aaaabbbb-1111", mtimeMs: 2, size: 1e12 },
    { name: "view_aaaabbbb-1111.png", sid: "aaaabbbb-1111", mtimeMs: 3, size: 1e12 },
  ];
  assert.deepEqual(planScreenshotQuota(entries, { maxPerSession: 1, maxBytesPerSession: 10 }), []);
});

test("quota: vision_ et step_ JPEG éligibles (une par inspect, une par pas)", () => {
  const entries = [
    ...mkEntries("aaaabbbb-1111", "vision", 3),
    ...mkEntries("aaaabbbb-1111", "step", 3, { t0: 2_000_000 }),
  ].map((e) => ({ ...e, name: e.name.replace(/\.png$/, ".jpg") }));
  const del = planScreenshotQuota(entries, { maxPerSession: 4, maxBytesPerSession: 1e9 });
  assert.deepEqual(del, ["vision_aaaabbbb-1111_0.jpg", "vision_aaaabbbb-1111_1.jpg"]);
});

test("quota: fail_ éligibles (timestampés, ils s'accumulent)", () => {
  const entries = mkEntries("aaaabbbb", "fail", 4);
  const del = planScreenshotQuota(entries, { maxPerSession: 2, maxBytesPerSession: 1e9 });
  assert.equal(del.length, 2);
});

// ── Place d'une nouvelle session : jamais au détriment d'un autre propriétaire ────
import {
  occupationGroupe,
  placesEnfants,
  planSessionSlot,
  quotasSessions,
  sessionCessible,
} from "../src/session_util.ts";
import type { SessionPlace } from "../src/session_util.ts";
import { makeLock } from "../src/session_lock.ts";

const _sess = (entries: [string, string, number][]) =>
  new Map(entries.map(([sid, owner, t]): [string, SessionPlace] => [sid, { owner, lastActivity: t }]));

test("planSessionSlot : sous les plafonds → rien à évincer", () => {
  assert.deepEqual(
    planSessionSlot(_sess([["a1", "alice", 1]]), "alice", { maxPerOwner: 3, maxPerGroup: 4 }),
    { evict: null, refuse: false },
  );
});

test("planSessionSlot : quota du propriétaire atteint → SA plus ancienne cède", () => {
  const s = _sess([
    ["a1", "alice", 5],
    ["a2", "alice", 2],
    ["a3", "alice", 9],
  ]);
  assert.deepEqual(planSessionSlot(s, "alice", { maxPerOwner: 3, maxPerGroup: 4 }), {
    evict: "a2",
    refuse: false,
    limit: "owner",
  });
});

// Sessions d'un compte (`alice`) et de ses sous-agents (`alice~t1`… groupe `alice`).
const _grp = (entries: [string, string, string, number][]) =>
  new Map(
    entries.map(([sid, owner, group, t]): [string, SessionPlace] => [sid, { owner, group, lastActivity: t }]),
  );
const _quota = { maxPerOwner: 3, maxPerGroup: 4 };

test("quotasSessions : défauts 3/4, groupe jamais sous le quota par propriétaire", () => {
  assert.deepEqual(quotasSessions({}), { maxPerOwner: 3, maxPerGroup: 4 });
  assert.deepEqual(
    quotasSessions({ BROWSER_MAX_SESSIONS_PER_OWNER: "5", BROWSER_MAX_SESSIONS_PER_GROUP: "2" }).maxPerGroup,
    5,
  );
  assert.deepEqual(quotasSessions({ BROWSER_MAX_SESSIONS_PER_GROUP: "x" }).maxPerGroup, 4);
});

test("planSessionSlot : session du chat et trois enfants web parallèles → le troisième passe, un quatrième est refusé", () => {
  const s = _grp([
    ["c", "alice", "alice", 1],
    ["e1", "alice~t1", "alice", 2],
    ["e2", "alice~t2", "alice", 3],
  ]);
  assert.deepEqual(planSessionSlot(s, "alice~t3", { ..._quota, group: "alice" }), {
    evict: null,
    refuse: false,
  });
  s.set("e3", { owner: "alice~t3", group: "alice", lastActivity: 4 });
  assert.deepEqual(planSessionSlot(s, "alice~t4", { ..._quota, group: "alice" }), {
    evict: null,
    refuse: true,
    cause: "groupe",
  });
  assert.deepEqual(planSessionSlot(s, "alice~t1", { ..._quota, group: "alice" }), {
    evict: "e1",
    refuse: false,
    limit: "group",
  });
});

test("planSessionSlot : enfants sur toutes leurs places → la place réservée laisse démarrer le compte", () => {
  const s = _grp([
    ["e1", "alice~t1", "alice", 1],
    ["e2", "alice~t2", "alice", 2],
    ["e3", "alice~t3", "alice", 3],
  ]);
  assert.deepEqual(placesEnfants(occupationGroupe(s, "alice"), 4), 3);
  assert.deepEqual(planSessionSlot(s, "alice", { ..._quota, group: "alice" }), {
    evict: null,
    refuse: false,
  });
  assert.deepEqual(planSessionSlot(s, "alice~t4", { ..._quota, group: "alice" }), {
    evict: null,
    refuse: true,
    cause: "groupe",
  });
});

test("planSessionSlot : groupe plein → le compte cède sa plus ancienne, jamais celle d’un enfant", () => {
  const s = _grp([
    ["c1", "alice", "alice", 5],
    ["c2", "alice", "alice", 1],
    ["e1", "alice~t1", "alice", 0],
    ["e2", "alice~t2", "alice", 0],
  ]);
  assert.deepEqual(planSessionSlot(s, "alice", { ..._quota, group: "alice" }), {
    evict: "c2",
    refuse: false,
    limit: "group",
  });
});

// ── Nettoyage : le compte et ses sous-agents, jamais un autre compte ────────
import { sessionsANettoyer, sessionsEnfantsAnciennes } from "../src/session_util.ts";

test("sessionsANettoyer : le compte ferme ses sessions et celles de ses enfants, jamais celles d’un autre compte", () => {
  const s = new Map([
    ["a", { owner: "alice", group: "alice", createdAt: 1 }],
    ["e1", { owner: "s_a1", group: "alice", createdAt: 2 }],
    ["e2", { owner: "s_a2", group: "alice", createdAt: 900 }],
    ["b", { owner: "bob", group: "bob", createdAt: 1 }],
    ["f1", { owner: "s_b1", group: "bob", createdAt: 2 }],
    ["ancien", { owner: "alice", createdAt: 1 }],
  ]);
  assert.deepEqual(sessionsANettoyer(s, "alice"), ["a", "e1", "e2", "ancien"]);
  assert.deepEqual(sessionsANettoyer(s, "s_a1"), ["e1"]);
  assert.deepEqual(sessionsANettoyer(s, ""), []);
  assert.deepEqual(sessionsANettoyer(s, "carol"), []);
});

test("sessionsEnfantsAnciennes : enfants plus vieux que le seuil, jamais une session de compte", () => {
  const s = new Map([
    ["a", { owner: "alice", group: "alice", createdAt: 1 }],
    ["e1", { owner: "s_a1", group: "alice", createdAt: 2 }],
    ["e2", { owner: "s_a2", group: "alice", createdAt: 900 }],
    ["f1", { owner: "s_b1", group: "bob", createdAt: 3 }],
    ["ancien", { owner: "alice", createdAt: 1 }],
    ["compte_s", { owner: "s_carol", group: "s_carol", createdAt: 1 }],
    ["sans_groupe", { owner: "s_dave", createdAt: 1 }],
    ["autre_groupe", { owner: "erin", group: "frank", createdAt: 1 }],
    ["vide", null],
  ]);
  assert.deepEqual(sessionsEnfantsAnciennes(s, { ageMinMs: 0, now: 1000 }), ["e1", "e2", "f1"]);
  assert.deepEqual(sessionsEnfantsAnciennes(s, { ageMinMs: 500, now: 1000 }), ["e1", "f1"]);
  assert.deepEqual(sessionsEnfantsAnciennes(s, { ageMinMs: 5000, now: 1000 }), []);
});

test("planSessionSlot : une session occupée ou liée à un secret ne cède jamais ; une isolée cède avant la principale ; rien à céder → refus", () => {
  const occupee = makeLock();
  occupee.held = 1;
  const s = new Map<string, SessionPlace>([
    ["main", { owner: "o", lastActivity: 1 }],
    ["iso", { owner: "o", lastActivity: 5, isolated: true }],
    ["occ", { owner: "o", lastActivity: 0, isolated: true, _lock: occupee }],
    ["sec", { owner: "o", lastActivity: 0, tls: "strict" }],
  ]);
  const q = { maxPerOwner: 3, maxPerGroup: 10 };
  assert.deepEqual(planSessionSlot(s, "o", q), { evict: "iso", refuse: false, limit: "owner" });
  s.delete("iso");
  s.set("login", { owner: "o", lastActivity: 0, _connexionEnCours: true });
  assert.deepEqual(planSessionSlot(s, "o", q), { evict: "main", refuse: false, limit: "owner" });
  s.delete("main");
  s.set("sec2", { owner: "o", lastActivity: 0, tls: "insecure" });
  assert.deepEqual(planSessionSlot(s, "o", q), {
    evict: null,
    refuse: true,
    cause: "protegees",
    limit: "owner",
    protected: ["occ", "sec", "login", "sec2"],
  });
  assert.equal(sessionCessible({ owner: "o", _lock: makeLock() }), true);
});
