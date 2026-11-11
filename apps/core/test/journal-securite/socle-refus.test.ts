// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/socle-refus.test.ts — refus au journal de sécurité : IP lue de droite à gauche, motif de route (jamais le chemin brut dans la clé), compte dans la clé, 403 non signalés, jeton de service, CSRF avec le compte visé, texte borné. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyserMandataires, creerGardes, installerAuth, ipDuClient, signerSession } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { MANDATAIRES_DE_CONFIANCE } from "@elpis/http";
import { configureAudit, oublierConfigurationAudit, texteBorne, viderRafalesAudit } from "@elpis/securite";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { installerRefusGeneriques, ipDeRequete, signalerRefusAuth } from "../../src/journal-securite/auditer";

let dossier: string;
let audit: string;
let app: FastifyInstance;
const attributs = {
  cookie_name: "mcpwebui_session",
  same_site: "lax",
  https_only: false,
  max_age: 86400,
} as const;
const T = 1_800_000_000;

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-socle-refus-"));
  audit = join(dossier, "audit");
  oublierConfigurationAudit();
  configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(dossier, "absente") });
  const dep = {
    base: { get: async () => undefined } as unknown as DependancesAuth["base"],
    config: () => ({}),
    attributsCookie: () => ({ ...attributs }),
    secret: () => "secret-de-test",
    jetonService: () => "jeton-svc",
    maintenant: () => T,
    signalerRefus: signalerRefusAuth,
  } satisfies DependancesAuth;
  app = Fastify({ trustProxy: false });
  app.setErrorHandler((e, _req, rep) =>
    rep
      .code(e instanceof HttpError ? e.statusCode : 500)
      .send({ detail: e instanceof HttpError ? e.detail : String(e) }),
  );
  installerAuth(app, dep);
  installerRefusGeneriques(app);
  const g = creerGardes(dep);
  app.get("/ip", async (req) => ({ ip: ipDeRequete(req) }));
  app.get("/interdit", async () => {
    throw new HttpError(403, "Admin required");
  });
  app.get("/service", { onRequest: g.service }, async () => ({ ok: true }));
  app.post("/ecrire", async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

beforeEach(() => {
  viderRafalesAudit();
  rmSync(audit, { recursive: true, force: true });
});

const lignes = (): Record<string, unknown>[] => {
  try {
    return readdirSync(audit).flatMap((f) =>
      readFileSync(join(audit, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
  } catch {
    return [];
  }
};

describe("IP du client pour le journal", () => {
  it("pair non mandataire : le pair ; mandataire de confiance : dernière adresse valide hors mandataires ; valeur invalide ignorée", async () => {
    const ip = async (remoteAddress: string, xff?: string): Promise<string> =>
      (
        (
          await app.inject({
            method: "GET",
            url: "/ip",
            remoteAddress,
            headers: xff ? { "x-forwarded-for": xff } : {},
          })
        ).json() as { ip: string }
      ).ip;
    expect(await ip("10.0.0.5", "1.2.3.4")).toBe("10.0.0.5");
    expect(await ip("127.0.0.1", "6.6.6.6, 10.0.0.9")).toBe("10.0.0.9");
    expect(await ip("127.0.0.1", "10.0.0.9, 127.0.0.1")).toBe("10.0.0.9");
    expect(await ip("127.0.0.1", "pas-une-ip")).toBe("127.0.0.1");
    expect(await ip("127.0.0.1", `${"9".repeat(200)}, 10.0.0.8`)).toBe("10.0.0.8");
  });

  it("trustProxy de production : l'adresse déjà résolue par Fastify est validée, sinon la socket", async () => {
    const prod = Fastify({ trustProxy: [...MANDATAIRES_DE_CONFIANCE] });
    prod.get("/ip", async (req) => ({ ip: ipDeRequete(req), brute: req.ip }));
    await prod.ready();
    try {
      const ip = async (remoteAddress: string, xff: string): Promise<{ ip: string; brute: string }> =>
        (
          await prod.inject({ method: "GET", url: "/ip", remoteAddress, headers: { "x-forwarded-for": xff } })
        ).json();
      expect(await ip("127.0.0.1", "pas-une-ip")).toEqual({ ip: "127.0.0.1", brute: "pas-une-ip" });
      expect((await ip("127.0.0.1", `<script>${"A".repeat(300)}`)).ip).toBe("127.0.0.1");
      expect((await ip("::1", "10.0.0.66")).ip).toBe("10.0.0.66");
      expect((await ip("127.0.0.1", "10.0.0.9, 127.0.0.5")).ip).toBe("10.0.0.9");
      expect((await ip("10.0.0.5", "1.2.3.4")).ip).toBe("10.0.0.5");
    } finally {
      await prod.close();
    }
  });

  it("frontal de confiance qui ajoute à X-Forwarded-For : l'entrée posée par le frontal, pas celle du client", () => {
    const reseaux = analyserMandataires("127.0.0.0/8,::1,10.0.0.2");
    const req = (ip: string, xff: string) => ({
      ip,
      socket: { remoteAddress: ip },
      headers: { "x-forwarded-for": xff },
    });
    expect(ipDuClient(req("10.0.0.2", "6.6.6.6, 10.0.0.50"), reseaux)).toBe("10.0.0.50");
    expect(ipDuClient(req("::ffff:10.0.0.2", "6.6.6.6, 10.0.0.50"), reseaux)).toBe("10.0.0.50");
    expect(
      ipDuClient({ ip: "pas-une-ip", socket: { remoteAddress: "10.0.0.2" }, headers: {} }, reseaux),
    ).toBe("10.0.0.2");
    expect(ipDuClient({ ip: "", socket: null, headers: {} }, reseaux)).toBe("?");
  });
});

describe("refus", () => {
  it("403 rendu par un traitement : auth.forbidden ; chemin inconnu : motif « (no route) », chemin borné dans les détails", async () => {
    await app.inject({ method: "GET", url: "/interdit", remoteAddress: "10.0.0.5" });
    await app.inject({
      method: "POST",
      url: `/inconnu/${"a".repeat(5000)}?q=secret`,
      remoteAddress: "10.0.0.5",
      headers: { cookie: "mcpwebui_session=x.y", origin: "http://autre", host: "localhost" },
    });
    const [interdit, csrf] = lignes();
    expect(interdit).toMatchObject({
      action: "auth.forbidden",
      ip: "10.0.0.5",
      details: { route: "/interdit", status: 403 },
    });
    expect(csrf).toMatchObject({ action: "auth.csrf.denied", details: { route: "(no route)" } });
    const chemin = (csrf?.["details"] as { path: string }).path;
    expect(Array.from(chemin)).toHaveLength(200);
    expect(JSON.stringify(csrf)).not.toContain("secret");
    expect(lignes().filter((l) => l["action"] === "auth.forbidden")).toHaveLength(1);
  });

  it("CSRF : le compte visé est lu dans le cookie signé ; deux comptes de la même IP restent distincts", async () => {
    for (const uid of [5, 9]) {
      const cookie = `mcpwebui_session=${signerSession({ user_id: uid }, "secret-de-test", T)}`;
      await app.inject({
        method: "POST",
        url: "/ecrire",
        remoteAddress: "10.0.0.5",
        headers: { cookie, origin: "http://autre", host: "localhost" },
      });
    }
    expect(lignes().map((l) => [l["action"], l["user_id"]])).toEqual([
      ["auth.csrf.denied", 5],
      ["auth.csrf.denied", 9],
    ]);
  });

  it("jeton de service refusé : auth.service.denied, jamais le jeton reçu", async () => {
    await app.inject({ method: "GET", url: "/service", headers: { authorization: "Bearer jeton-faux-XYZ" } });
    expect(lignes()).toEqual([
      expect.objectContaining({
        action: "auth.service.denied",
        details: expect.objectContaining({ reason: "bad_token" }),
      }),
    ]);
    expect(
      readdirSync(audit)
        .map((f) => readFileSync(join(audit, f), "utf8"))
        .join(""),
    ).not.toContain("XYZ");
  });
});

describe("texteBorne", () => {
  it("points de code entiers, demi-paire remplacée", () => {
    expect(texteBorne("a😀b", 2)).toBe("a😀");
    expect(texteBorne("x\ud800y", 10)).toBe("x�y");
    expect(texteBorne("😀".repeat(300), 200)).toHaveLength(400);
  });
});
