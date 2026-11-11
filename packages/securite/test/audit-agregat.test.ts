// SPDX-License-Identifier: MIT
/** packages/securite/test/audit-agregat.test.ts — rafales du journal de sécurité : première occurrence tout de suite, résumé par fenêtre, clés bornées par source (groupe d'adresses et compte), débordement échantillonné, lectures dédupliquées à part, résumés avant la ligne de fin. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { arreterAudit, configureAudit, oublierConfigurationAudit } from "../src/audit";
import type { EvenementAudit } from "../src/audit";
import { auditLecture, auditRafale, creerAgregatAudit, creerLecturesAudit } from "../src/audit-agregat";

const refus = (ip: string): EvenementAudit => ({
  userId: null,
  username: null,
  action: "auth.csrf.denied",
  outcome: "failure",
  ip,
  details: { route: "/api/x" },
});

/** Refus d'un compte (ou anonyme) sur une route, clé construite comme `auditerRefus`. */
const refusDe = (ip: string, uid: number | null, action: string, route: string): [string, EvenementAudit] => [
  `${action}|${ip}|${uid ?? "-"}|POST|${route}`,
  {
    userId: uid,
    username: uid === null ? null : `u${uid}`,
    action,
    outcome: "failure",
    ip,
    details: { method: "POST", route },
  },
];

describe("creerAgregatAudit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("10 000 refus identiques : 2 lignes (la première, puis un résumé à la fin de la fenêtre)", () => {
    vi.useFakeTimers();
    const ecrits: EvenementAudit[] = [];
    let t = 100;
    const a = creerAgregatAudit({ ecrire: (e) => ecrits.push(e), maintenant: () => t });
    for (let i = 0; i < 10_000; i++) {
      a.signaler("10.0.0.9", refus("10.0.0.9"));
      t += 0.001;
    }
    expect(ecrits).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(ecrits).toHaveLength(2);
    expect(ecrits[1]).toMatchObject({
      action: "auth.csrf.denied",
      outcome: "failure",
      ip: "10.0.0.9",
      details: { route: "/api/x", repeated: 9_999, first_ts: 100, window_s: 60 },
    });
    a.signaler("10.0.0.9", refus("10.0.0.9"));
    expect(ecrits).toHaveLength(3);
  });

  it("une occurrence isolée n'a pas de résumé ; plafond global atteint : le reste compté sous son IP", () => {
    const ecrits: EvenementAudit[] = [];
    const a = creerAgregatAudit({ ecrire: (e) => ecrits.push(e), maxCles: 2, maxClesAnonymes: 2 });
    for (const ip of ["a", "b", "c", "d", "d"]) a.signaler(ip, refus(ip));
    a.vider();
    expect(ecrits.map((e) => [e.action, e.ip])).toEqual([
      ["auth.csrf.denied", "a"],
      ["auth.csrf.denied", "b"],
      ["audit.aggregate.overflow", "c"],
      ["audit.aggregate.overflow", "d"],
    ]);
    expect(ecrits[3]).toMatchObject({
      outcome: "unknown",
      details: { dropped: 2, actions: { "auth.csrf.denied": 2 } },
    });
    a.vider();
    expect(ecrits).toHaveLength(4);
  });

  it("une IP qui multiplie les clés n'évince pas les refus des autres IP ni des autres actions", () => {
    const ecrits: EvenementAudit[] = [];
    const a = creerAgregatAudit({ ecrire: (e) => ecrits.push(e), maxClesParSource: 8, maxClesParAction: 16 });
    for (let i = 0; i < 300; i++) a.signaler(`bruit|/x${i}`, refus("10.0.0.66"));
    for (let i = 0; i < 20; i++) a.signaler(`autre${i}|/y`, refus(`10.0.1.${i}`));
    a.signaler("role|/admin", { ...refus("10.0.0.7"), action: "auth.role.denied" });
    const immediats = ecrits.filter((e) => e.action !== "audit.aggregate.overflow");
    expect(immediats.filter((e) => e.ip === "10.0.0.66")).toHaveLength(4);
    expect(immediats.filter((e) => e.action === "auth.csrf.denied")).toHaveLength(16);
    expect(immediats.at(-1)).toMatchObject({ action: "auth.role.denied", ip: "10.0.0.7" });
    a.vider();
    const debord = ecrits.filter((e) => e.action === "audit.aggregate.overflow");
    expect(debord.find((e) => e.ip === "10.0.0.66")?.details).toMatchObject({ dropped: 296 });
    expect(debord.reduce((n, e) => n + Number((e.details as { dropped: number }).dropped), 0)).toBe(296 + 8);
  });

  it("IPv6 : les adresses d'un même /64 forment une source ; le refus d'un compte sur une autre IP reste écrit", () => {
    const ecrits: EvenementAudit[] = [];
    const a = creerAgregatAudit({ ecrire: (e) => ecrits.push(e) });
    for (let i = 0; i < 16; i++)
      for (let k = 0; k < 8; k++) a.signaler(...refusDe(`fd00::a:${i}`, null, "auth.forbidden", `/r${k}`));
    for (let i = 0; i < 256; i++) a.signaler(...refusDe(`fd00::b:${i}`, null, "auth.forbidden", "/x"));
    a.signaler(...refusDe("10.0.0.7", 5, "auth.forbidden", "/api/admin/skills"));
    expect(ecrits.filter((e) => e.ip?.startsWith("fd00:"))).toHaveLength(4);
    expect(ecrits.at(-1)).toMatchObject({
      userId: 5,
      ip: "10.0.0.7",
      details: { route: "/api/admin/skills" },
    });
    a.vider();
    const debord = ecrits.filter((e) => e.action === "audit.aggregate.overflow");
    expect(debord).toHaveLength(1);
    expect(debord[0]).toMatchObject({
      ip: "fd00::a:0",
      details: { dropped: 16 * 8 + 256 - 4, network: "fd00:0:0:0::/64", user_ids: [] },
    });
  });

  it("de nombreuses IPv4 sans compte n'atteignent ni la place des comptes connectés ni leur débordement", () => {
    const ecrits: EvenementAudit[] = [];
    const a = creerAgregatAudit({ ecrire: (e) => ecrits.push(e) });
    const actions = ["auth.forbidden", "auth.csrf.denied", "oauth.token.denied", "toolhost.gate.denied"];
    for (let i = 0; i < 1200; i++)
      for (const [k, action] of actions.entries())
        a.signaler(...refusDe(`10.${i >> 8}.${i & 255}.1`, null, action, `/r${k}`));
    expect(ecrits.filter((e) => e.userId === null)).toHaveLength(512);
    for (let uid = 1; uid <= 16; uid++)
      a.signaler(...refusDe("10.200.0.1", uid, "auth.forbidden", "/api/admin/skills"));
    expect(ecrits.filter((e) => e.userId !== null).map((e) => e.userId)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
    a.vider();
    expect(ecrits.filter((e) => e.action === "audit.aggregate.overflow")).toHaveLength(257);
  });

  it("IP commune (NAT, mandataire) : chaque compte a son quota, une action bruyante laisse passer les autres", () => {
    const ecrits: EvenementAudit[] = [];
    const a = creerAgregatAudit({ ecrire: (e) => ecrits.push(e) });
    for (let k = 0; k < 8; k++) a.signaler(...refusDe("10.0.0.66", 9, "auth.forbidden", `/api/voice/x${k}`));
    for (let k = 0; k < 8; k++) a.signaler(...refusDe("10.0.0.66", 9, "auth.csrf.denied", `/api/y${k}`));
    a.signaler(...refusDe("10.0.0.66", 9, "auth.role.denied", "/api/admin/users"));
    a.signaler(...refusDe("10.0.0.66", 5, "auth.role.denied", "/api/admin/users"));
    const de9 = ecrits.filter((e) => e.userId === 9).map((e) => e.action);
    expect(de9).toEqual([
      ...Array<string>(4).fill("auth.forbidden"),
      ...Array<string>(4).fill("auth.csrf.denied"),
    ]);
    expect(ecrits.at(-1)).toMatchObject({ userId: 5, action: "auth.role.denied" });
    a.vider();
    const debord = ecrits.find((e) => e.action === "audit.aggregate.overflow");
    expect(debord).toMatchObject({
      ip: "10.0.0.66",
      details: {
        dropped: 9,
        actions: { "auth.forbidden": 4, "auth.csrf.denied": 4, "auth.role.denied": 1 },
        user_ids: [9],
      },
    });
    const echantillon = (debord?.details as { sample: { action: string; user_id: number; route: string }[] })
      .sample;
    expect(echantillon).toHaveLength(5);
    expect(echantillon).toContainEqual({
      action: "auth.role.denied",
      user_id: 9,
      ip: "10.0.0.66",
      method: "POST",
      route: "/api/admin/users",
    });
  });

  it("débordement : un compte connecté prend la place d'une occurrence anonyme dans l'échantillon ; ligne bornée", () => {
    const ecrits: EvenementAudit[] = [];
    const a = creerAgregatAudit({ ecrire: (e) => ecrits.push(e), maxCles: 0, maxClesAnonymes: 0 });
    const long = `/${"r".repeat(300)}`;
    for (let i = 0; i < 40; i++)
      a.signaler(
        ...refusDe("2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff", null, `action.tres.longue.${i}.denied`, long),
      );
    for (let uid = 1; uid <= 40; uid++)
      a.signaler(
        ...refusDe("2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff", 1_000_000 + uid, "auth.forbidden", long),
      );
    a.vider();
    const [ligne] = ecrits;
    const d = ligne?.details as { sample: { user_id: number | null; route: string }[]; user_ids: number[] };
    expect(d.user_ids).toHaveLength(16);
    expect(d.sample.filter((x) => x.user_id !== null).length).toBeGreaterThanOrEqual(2);
    expect(d.sample.every((x) => [...x.route].length <= 100)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(ligne), "utf8")).toBeLessThan(3200);
  });
});

describe("creerLecturesAudit", () => {
  it("même clé dans la fenêtre comptée, clé nouvelle écrite ; table pleine : chaque lecture écrite", () => {
    const ecrits: EvenementAudit[] = [];
    const l = creerLecturesAudit({ ecrire: (e) => ecrits.push(e), maxCles: 2, maintenant: () => 5 });
    const lecture = (f: string): EvenementAudit => ({
      userId: 1,
      username: "alice",
      action: "admin.audit.search",
      ip: "10.0.0.1",
      details: { filters: { q: f } },
    });
    for (let i = 0; i < 3; i++) l.signaler("a", lecture("a"));
    l.signaler("b", lecture("b"));
    l.signaler("c", lecture("c"));
    l.signaler("c", lecture("c"));
    expect(ecrits.map((e) => (e.details as { filters: { q: string } }).filters.q)).toEqual([
      "a",
      "b",
      "c",
      "c",
    ]);
    l.vider();
    expect(ecrits.at(-1)).toMatchObject({ details: { filters: { q: "a" }, repeated: 2, window_s: 60 } });
    expect(ecrits).toHaveLength(5);
  });

  it("hors des quotas des refus : 1000 refus d'une IP ne retiennent pas la lecture d'un admin", () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-lecture-"));
    oublierConfigurationAudit();
    configureAudit({ service: "admin", auditDir: dossier, hmacKeyPath: join(dossier, "absente") });
    try {
      for (let i = 0; i < 1000; i++) auditRafale(`10.0.0.1|${i}`, { ...refus("10.0.0.1"), userId: 1 });
      auditLecture("10.0.0.1|1|f", {
        userId: 1,
        username: "alice",
        action: "admin.audit.search",
        ip: "10.0.0.1",
        details: { from: "2026-11-01" },
      });
      arreterAudit();
      const lignes = readdirSync(dossier).flatMap((f) =>
        readFileSync(join(dossier, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((x) => JSON.parse(x) as { action: string; user_id: number | null }),
      );
      expect(lignes.filter((x) => x.action === "admin.audit.search")).toEqual([
        expect.objectContaining({ user_id: 1 }),
      ]);
    } finally {
      oublierConfigurationAudit();
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});

describe("auditRafale", () => {
  let dossier: string;
  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-rafale-"));
    oublierConfigurationAudit();
    configureAudit({ service: "main", auditDir: dossier, hmacKeyPath: join(dossier, "absente") });
  });
  afterEach(() => {
    oublierConfigurationAudit();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("résumés en attente écrits avant audit.writer.stop", () => {
    for (let i = 0; i < 5; i++) auditRafale("10.0.0.1", refus("10.0.0.1"));
    arreterAudit();
    const lignes = readdirSync(dossier).flatMap((f) =>
      readFileSync(join(dossier, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { action: string; details: { repeated?: number } }),
    );
    expect(lignes.map((l) => [l.action, l.details.repeated])).toEqual([
      ["auth.csrf.denied", undefined],
      ["auth.csrf.denied", 4],
      ["audit.writer.stop", undefined],
    ]);
  });
});
