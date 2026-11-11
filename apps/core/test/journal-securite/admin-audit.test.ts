// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/admin-audit.test.ts — console › journal de sécurité : recherche (chaque page tracée, hors des quotas des refus), export et vérification audités, réglages lus et écrits (admins seulement), chemin réservé au PATCH de la config. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import {
  auditEvent,
  auditRafale,
  configureAudit,
  oublierConfigurationAudit,
  viderRafalesAudit,
} from "@elpis/securite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { creerFamilleAdminAudit } from "../../src/familles/admin-audit";
import { creerFamilleAdminConfig } from "../../src/familles/admin-config";
import { appTest, journalMuet } from "../aides";

let app: FastifyInstance;
let dossier: string;
let audit: string;
let configJson: string;
let restaurer: () => void;

const ROLES: Record<string, number> = { "1": 1, "2": 2 };
const role = async (req: FastifyRequest, roles: number[], message: string): Promise<void> => {
  const uid = String(req.headers["x-uid"] ?? "");
  if (!uid) throw new HttpError(401, "not logged in");
  req.utilisateur = { id: Number(uid), username: uid === "1" ? "alice" : "mo" };
  if (!roles.includes(ROLES[uid] ?? 0)) throw new HttpError(403, message);
};

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-admin-audit-"));
  audit = join(dossier, "audit");
  configJson = join(dossier, "config.json");
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: configJson });
  oublierConfigurationAudit();
  configureAudit({ service: "admin", auditDir: audit, hmacKeyPath: join(dossier, "absente") });
  app = await appTest({
    mode: "admin",
    familles: [
      creerFamilleAdminAudit({ journal: journalMuet }),
      creerFamilleAdminConfig({ journal: journalMuet }),
    ],
    gardes: {
      admin: (req) => role(req, [1], "Admin required"),
      staff: (req) => role(req, [1, 2], "Staff required"),
    },
  });
});

afterAll(async () => {
  await app?.close();
  restaurer?.();
  invalidateConfigCache();
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

beforeEach(() => {
  viderRafalesAudit();
  writeFileSync(configJson, JSON.stringify({ security: { session: { max_age_sec: 3600 } } }, null, 2));
  invalidateConfigCache();
  rmSync(audit, { recursive: true, force: true });
});

const appel = (
  methode: "GET" | "PUT" | "PATCH" | "POST",
  url: string,
  uid: string,
  corps?: unknown,
  entetes: Record<string, string> = {},
) =>
  app.inject({
    method: methode,
    url,
    headers: {
      "x-uid": uid,
      "x-elpis-console": "1",
      ...entetes,
      ...(corps === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
    remoteAddress: "10.1.2.3",
  });

const lignes = (): Record<string, unknown>[] =>
  readdirSync(audit)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(audit, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );

describe("/api/admin/audit/settings", () => {
  it("lecture : défauts et bornes ; modérateur refusé", async () => {
    const r = await appel("GET", "/api/admin/audit/settings", "1");
    expect(r.json()).toEqual({
      retention_days: 365,
      hold: false,
      hold_reason: "",
      forwarding_expected: false,
      out_of_bounds: false,
      invalid: false,
      from_witness: false,
      bounds: { min: 180, max: 1095, default: 365 },
    });
    expect((await appel("GET", "/api/admin/audit/settings", "2")).statusCode).toBe(403);
    expect((await appel("PUT", "/api/admin/audit/settings", "2", { hold: false })).statusCode).toBe(403);
  });

  it("écriture : config.json mis à jour sans toucher le reste, changement audité avec l'IP", async () => {
    const r = await appel("PUT", "/api/admin/audit/settings", "1", {
      retention_days: 730,
      hold: true,
      hold_reason: "Incident 17",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ retention_days: 730, hold: true, hold_reason: "Incident 17" });
    const cfg = JSON.parse(readFileSync(configJson, "utf8")) as { security: Record<string, unknown> };
    expect(cfg.security).toEqual({
      session: { max_age_sec: 3600 },
      audit: { retention_days: 730, hold: true, hold_reason: "Incident 17", forwarding_expected: false },
    });
    expect(lignes()).toEqual([
      expect.objectContaining({
        action: "admin.audit.settings",
        outcome: "success",
        user_id: 1,
        username: "alice",
        ip: "10.1.2.3",
        details: {
          changes: [
            { field: "retention_days", before: 365, after: 730 },
            { field: "hold", before: false, after: true },
            { field: "hold_reason", before: "", after: "Incident 17" },
          ],
        },
      }),
    ]);
  });

  it("refus : hors bornes, gel sans motif ; rien écrit ni audité", async () => {
    for (const corps of [{ retention_days: 90 }, { retention_days: 4000 }, { hold: true }]) {
      const r = await appel("PUT", "/api/admin/audit/settings", "1", corps);
      expect(r.statusCode).toBe(400);
    }
    expect(
      (JSON.parse(readFileSync(configJson, "utf8")) as { security: object }).security,
    ).not.toHaveProperty("audit");
    expect(() => lignes()).toThrow();
  });

  it("chemin réservé : l'éditeur de config.json ne crée pas la section absente du disque, ni ne la change", async () => {
    const contenu = (audit: unknown) =>
      JSON.stringify({ security: { session: { max_age_sec: 3600 }, audit } }, null, 2);
    const r = await appel("POST", "/api/admin/config-file", "1", {
      type: "main",
      content: contenu({ retention_days: 30 }),
    });
    expect(r.statusCode).toBe(200);
    expect(
      (JSON.parse(readFileSync(configJson, "utf8")) as { security: object }).security,
    ).not.toHaveProperty("audit");
    await appel("PUT", "/api/admin/audit/settings", "1", { retention_days: 400 });
    await appel("POST", "/api/admin/config-file", "1", {
      type: "main",
      content: contenu({ retention_days: 30 }),
    });
    const cfg = JSON.parse(readFileSync(configJson, "utf8")) as {
      security: { audit: { retention_days: number } };
    };
    expect(cfg.security.audit.retention_days).toBe(400);
  });

  it("témoin .settings écrit par la console : section retirée de config.json, réglages repris et signalés", async () => {
    mkdirSync(audit, { recursive: true });
    await appel("PUT", "/api/admin/audit/settings", "1", { retention_days: 800, forwarding_expected: true });
    expect(JSON.parse(readFileSync(join(audit, ".settings"), "utf8"))).toEqual({
      retention_days: 800,
      forwarding_expected: true,
    });
    writeFileSync(configJson, JSON.stringify({ security: { session: { max_age_sec: 3600 } } }));
    invalidateConfigCache();
    expect((await appel("GET", "/api/admin/audit/settings", "1")).json()).toMatchObject({
      retention_days: 800,
      forwarding_expected: true,
      from_witness: true,
    });
  });

  it("durée illisible sur disque : un PUT qui ne la fixe pas est refusé, un PUT qui la fixe passe", async () => {
    writeFileSync(configJson, JSON.stringify({ security: { audit: { retention_days: "beaucoup" } } }));
    invalidateConfigCache();
    expect((await appel("PUT", "/api/admin/audit/settings", "1", { hold: false })).statusCode).toBe(400);
    const r = await appel("PUT", "/api/admin/audit/settings", "1", { retention_days: 400 });
    expect([r.statusCode, (r.json() as { retention_days: number }).retention_days]).toEqual([200, 400]);
  });

  it("éditeur de config.json sur un disque illisible : la section du journal envoyée est gardée", async () => {
    writeFileSync(configJson, '{ "security": { "audit": { "retention_days": 1095 }, } }');
    invalidateConfigCache();
    const r = await appel("POST", "/api/admin/config-file", "1", {
      type: "main",
      content: JSON.stringify({ security: { audit: { retention_days: 1095 } } }, null, 2),
    });
    expect(r.statusCode).toBe(200);
    expect(
      (JSON.parse(readFileSync(configJson, "utf8")) as { security: { audit: unknown } }).security.audit,
    ).toEqual({ retention_days: 1095 });
  });

  it("chemin réservé : le PATCH générique de la config ne peut pas l'écrire", async () => {
    const r = await appel("PATCH", "/api/admin/config", "1", {
      changes: [{ path: "security.audit.retention_days", to: 30 }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ paths: ["security.audit.retention_days"] });
  });
});

describe("/api/admin/audit/events, export, verify", () => {
  const jour = new Date().toISOString().slice(0, 10);
  const remplir = async (): Promise<void> => {
    for (const hold of [true, false])
      await appel("PUT", "/api/admin/audit/settings", "1", { hold, ...(hold ? { hold_reason: "x" } : {}) });
  };

  it("recherche : les plus récentes d'abord, filtres ; modérateur refusé ; dates invalides refusées", async () => {
    await remplir();
    const r = await appel("GET", `/api/admin/audit/events?from=${jour}&to=${jour}&action=admin.audit`, "1");
    expect(r.statusCode).toBe(200);
    const page = r.json() as {
      events: { action: string; details: { changes: { field: string }[] } }[];
      cursor: null;
    };
    expect(page.events.map((e) => e.details.changes[0]?.field)).toEqual(["hold", "hold"]);
    expect(page.cursor).toBeNull();
    expect(r.headers["cache-control"]).toBe("no-store");
    expect((await appel("GET", "/api/admin/audit/events", "2")).statusCode).toBe(403);
    for (const q of [
      "from=2026-13-01",
      "from=2026-11-07&to=2026-11-01",
      "from=2020-01-01&to=2026-11-07",
      "outcome=autre",
    ])
      expect((await appel("GET", `/api/admin/audit/events?${q}`, "1")).statusCode).toBe(400);
  });

  it("recherche : exclude_markers=1 écarte les marqueurs d'écriture et la trace du filtre le dit", async () => {
    await remplir();
    auditEvent({ userId: 0, username: "root", action: "audit.writer.heartbeat", details: {} });
    const actions = async (q: string): Promise<string[]> =>
      (
        (await appel("GET", `/api/admin/audit/events?from=${jour}&to=${jour}${q}`, "1")).json() as {
          events: { action: string }[];
        }
      ).events.map((e) => e.action);
    expect((await actions("")).some((a) => a.startsWith("audit.writer."))).toBe(true);
    const sans = await actions("&exclude_markers=1");
    expect(sans.length).toBeGreaterThan(0);
    expect(sans.some((a) => a.startsWith("audit.writer."))).toBe(false);
    expect(lignes().at(-1)).toMatchObject({
      action: "admin.audit.search",
      details: { filters: { exclude_markers: "1" } },
    });
  });

  it("recherche : sans l'en-tête de la console, 403 et aucune trace écrite", async () => {
    await remplir();
    viderRafalesAudit();
    const avant = lignes().length;
    const url = `/api/admin/audit/events?from=${jour}&to=${jour}`;
    for (const entetes of [{ "x-elpis-console": "0" }, { "x-elpis-console": "" }])
      expect((await appel("GET", url, "1", undefined, entetes)).statusCode).toBe(403);
    // Absence réelle de l'en-tête (l'aide `appel` le pose par défaut).
    const sans = await app.inject({
      method: "GET",
      url,
      headers: { "x-uid": "1" },
      remoteAddress: "10.1.2.3",
    });
    expect(sans.statusCode).toBe(403);
    expect(lignes().length).toBe(avant);
    expect((await appel("GET", url, "1")).statusCode).toBe(200);
  });

  it("export : fichier joint, sans cache, et l'export lui-même est audité ; plus de 366 jours refusés", async () => {
    await remplir();
    const r = await appel(
      "POST",
      `/api/admin/audit/export?from=${jour}&to=${jour}&format=jsonl&action=admin.audit`,
      "1",
    );
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toBe(`attachment; filename="elpis-audit_${jour}_${jour}.jsonl"`);
    // La trace de l'export est écrite avant l'envoi : elle fait partie du fichier exporté.
    const exportees = r.body
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { action: string });
    expect(exportees.map((l) => l.action)).toEqual([
      "admin.audit.settings",
      "admin.audit.settings",
      "admin.audit.export",
    ]);
    expect(lignes().at(-1)).toMatchObject({
      action: "admin.audit.export",
      details: { from: jour, to: jour, format: "jsonl", filters: { action: "admin.audit" } },
    });
    const csv = await appel("POST", `/api/admin/audit/export?from=${jour}&to=${jour}`, "1");
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(
      (await appel("POST", "/api/admin/audit/export?from=2025-01-01&to=2026-11-07", "1")).statusCode,
    ).toBe(400);
    expect((await appel("POST", `/api/admin/audit/export?format=xml`, "1")).statusCode).toBe(400);
    expect((await appel("POST", `/api/admin/audit/export`, "2")).statusCode).toBe(403);
  });

  it("chaque page tracée après coup ; pages et répétitions d'une même recherche comptées ; curseur forgé tracé", async () => {
    await remplir();
    const url = `/api/admin/audit/events?from=${jour}&to=${jour}&action=admin.audit&service=admin&limit=1`;
    const r = await appel("GET", url, "1");
    expect((r.json() as { events: { action: string }[] }).events.map((e) => e.action)).toEqual([
      "admin.audit.settings",
    ]);
    const cursor = (r.json() as { cursor: string }).cursor;
    await appel("GET", `${url}&cursor=${cursor}`, "1");
    await appel("GET", url, "1");
    const forge = Buffer.from(JSON.stringify({ j: jour, o: -1 })).toString("base64url");
    const cible = await appel(
      "GET",
      `/api/admin/audit/events?from=${jour}&to=${jour}&q=hold&cursor=${forge}`,
      "1",
    );
    expect(cible.statusCode).toBe(200);
    viderRafalesAudit();
    const filtres = { action: "admin.audit", service: "admin" };
    expect(lignes().filter((l) => l["action"] === "admin.audit.search")).toEqual([
      expect.objectContaining({
        user_id: 1,
        ip: "10.1.2.3",
        details: { from: jour, to: jour, filters: filtres },
      }),
      expect.objectContaining({ user_id: 1, details: { from: jour, to: jour, filters: { q: "hold" } } }),
      expect.objectContaining({
        user_id: 1,
        details: expect.objectContaining({ filters: filtres, repeated: 2, window_s: 60 }),
      }),
    ]);
  });

  it("recherche hors des quotas des refus : des refus du même compte et de la même IP ne la cachent pas", async () => {
    for (let k = 0; k < 20; k++)
      auditRafale(`10.1.2.3|1|POST|/r${k}`, {
        userId: 1,
        username: "alice",
        action: "auth.forbidden",
        outcome: "failure",
        ip: "10.1.2.3",
        details: { method: "POST", route: `/r${k}` },
      });
    await appel("GET", `/api/admin/audit/events?from=${jour}&to=${jour}&q=quotas`, "1");
    expect(lignes().filter((l) => l["action"] === "admin.audit.search")).toEqual([
      expect.objectContaining({ user_id: 1, details: { from: jour, to: jour, filters: { q: "quotas" } } }),
    ]);
  });

  it("export : POST seulement, requête venue d'un autre site refusée ; exports successifs libérés ; 503 sans trace écrite", async () => {
    const url = `/api/admin/audit/export?from=${jour}&to=${jour}`;
    const statut = async (methode: "GET" | "POST", u: string, entetes: Record<string, string> = {}) =>
      (await appel(methode, u, "1", undefined, entetes)).statusCode;
    expect(await statut("POST", url, { "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await statut("POST", url, { "sec-fetch-site": "same-site" })).toBe(403);
    expect(await statut("POST", url, { origin: "https://ailleurs.lan" })).toBe(403);
    expect(await statut("GET", url)).toBeGreaterThanOrEqual(404);
    expect(
      await statut("GET", `/api/admin/audit/events?from=${jour}&to=${jour}`, {
        "sec-fetch-site": "cross-site",
      }),
    ).toBe(403);
    for (let i = 0; i < 4; i++)
      expect(await statut("POST", url, { "sec-fetch-site": "same-origin" })).toBe(200);
    rmSync(audit, { recursive: true, force: true });
    writeFileSync(audit, "");
    try {
      expect(await statut("POST", url)).toBe(503);
    } finally {
      rmSync(audit, { force: true });
    }
  });

  it("vérification : sans clé, lignes non signées comptées ; intègre ; auditée", async () => {
    await remplir();
    const r = await appel("POST", "/api/admin/audit/verify", "1", { from: jour, to: jour });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      from: jour,
      to: jour,
      status: "non_verifie",
      intact: false,
      key_available: false,
      files: 1,
      lines: 2,
      unsigned: 2,
      gaps: [],
      totals: { invalid_signatures: 0, gaps: 0 },
    });
    expect(lignes().at(-1)).toMatchObject({
      action: "admin.audit.verify",
      details: { status: "non_verifie", intact: false, lines: 2 },
    });
    expect((await appel("POST", "/api/admin/audit/verify", "1", { from: "hier" })).statusCode).toBe(400);
  });

  it("vérification sans date de fin : fin du journal ancienne donnée en motif (reasons)", async () => {
    mkdirSync(audit, { recursive: true });
    writeFileSync(
      join(audit, "audit-2020-01-01.jsonl"),
      '{"v":1,"time":"2020-01-01T10:00:00.000Z","ts":1577872800.0,"host":"vieil-hote","service":"main","boot":"b","seq":1,"action":"x","outcome":"success","user_id":null,"username":null,"ip":null,"details":{}}\n',
    );
    const r = await appel("POST", "/api/admin/audit/verify", "1", {});
    expect(r.json()).toMatchObject({
      to: null,
      status: "non_verifie",
      duplicates: [],
      totals: { duplicates: 0 },
      reasons: [
        {
          kind: "fin_ancienne",
          host: "vieil-hote",
          service: null,
          last_ts: 1577872800,
          text: expect.stringMatching(/^dernière ligne de vieil-hote il y a \d+ j$/u) as unknown,
        },
      ],
    });
  });
});

describe("export coupé par le client pendant les gardes (vrai serveur)", () => {
  it("le créneau est rendu : après trois coupures, un export passe encore", async () => {
    const lent = await appTest({
      mode: "admin",
      familles: [creerFamilleAdminAudit({ journal: journalMuet })],
      gardes: {
        admin: async (req) => {
          await new Promise((r) => setTimeout(r, 60));
          return role(req, [1], "Admin required");
        },
        staff: (req) => role(req, [1, 2], "Staff required"),
      },
    });
    try {
      await lent.listen({ port: 0, host: "127.0.0.1" });
      const port = (lent.server.address() as AddressInfo).port;
      for (let i = 0; i < 3; i++)
        await new Promise<void>((fini) => {
          const q = request({
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/admin/audit/export",
            headers: { "x-uid": "1" },
          });
          q.on("error", () => fini());
          q.end();
          setTimeout(() => {
            q.destroy();
            fini();
          }, 10);
        });
      await new Promise((r) => setTimeout(r, 200));
      const r = await fetch(`http://127.0.0.1:${port}/api/admin/audit/export`, {
        method: "POST",
        headers: { "x-uid": "1" },
      });
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    } finally {
      await lent.close();
    }
  });
});

describe("/api/admin/audit/status et /api/admin/audit/test", () => {
  it("état réservé aux admins, sans cache ; événement de test avec nonce, un toutes les 10 s", async () => {
    const etat = await appel("GET", "/api/admin/audit/status", "1");
    expect(etat.statusCode).toBe(200);
    expect(etat.headers["cache-control"]).toBe("no-store");
    expect(etat.json()).toMatchObject({ directory: audit, signed: false });
    expect((await appel("GET", "/api/admin/audit/status", "2")).statusCode).toBe(403);
    expect((await appel("POST", "/api/admin/audit/test", "2", {})).statusCode).toBe(403);
    const r = await appel("POST", "/api/admin/audit/test", "1", {});
    expect(r.statusCode).toBe(200);
    const { nonce } = r.json() as { nonce: string };
    expect(nonce).toMatch(/^[0-9a-f]{16}$/u);
    expect(lignes().at(-1)).toMatchObject({
      action: "audit.test",
      user_id: 1,
      ip: "10.1.2.3",
      details: { nonce },
    });
    expect((await appel("POST", "/api/admin/audit/test", "1", {})).statusCode).toBe(429);
  });

  it("PUT puis GET /status : l'état (gel, durée) suit tout de suite, malgré le cache de 60 s", async () => {
    const avant = (await appel("GET", "/api/admin/audit/status", "1")).json() as {
      retention: { hold: boolean };
    };
    expect(avant.retention.hold).toBe(false);
    await appel("PUT", "/api/admin/audit/settings", "1", { hold: true, hold_reason: "enquête" });
    const gele = (await appel("GET", "/api/admin/audit/status", "1")).json() as {
      retention: { hold: boolean; hold_reason: string };
    };
    expect(gele.retention).toMatchObject({ hold: true, hold_reason: "enquête" });
    await appel("PUT", "/api/admin/audit/settings", "1", { hold: false });
    const leve = (await appel("GET", "/api/admin/audit/status", "1")).json() as {
      retention: { hold: boolean };
    };
    expect(leve.retention.hold).toBe(false);
  });

  it("édition manuelle de config.json : le GET /status suivant rend les réglages tout de suite, le reste vient du cache", async () => {
    const avant = (await appel("GET", "/api/admin/audit/status", "1")).json() as {
      retention: { retention_days: number };
      generated_at: number;
    };
    const dur = avant.retention.retention_days;
    const memeEtat = (await appel("GET", "/api/admin/audit/status", "1")).json() as { generated_at: number };
    expect(memeEtat.generated_at).toBe(avant.generated_at);
    writeFileSync(configJson, JSON.stringify({ security: { audit: { retention_days: dur + 100 } } }));
    invalidateConfigCache();
    const apres = (await appel("GET", "/api/admin/audit/status", "1")).json() as {
      retention: { retention_days: number };
    };
    expect(apres.retention.retention_days).toBe(dur + 100);
  });
});
