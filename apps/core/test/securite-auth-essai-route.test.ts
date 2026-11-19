// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-essai-route.test.ts — POST /api/admin/auth/providers/test : réservée à l'administrateur, toujours 200 avec le résultat, deux tests au plus à la fois, une ligne d'audit, aucun test réussi enregistré. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as serveurTcp } from "node:net";
import type { AddressInfo, Server as ServeurTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { JugeHote } from "@elpis/http";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleAdminIdentite } from "../src/familles/admin-identite";
import { appTest, journalMuet, lignesAuditRecentes } from "./aides";
import { cleCoffreDeTest, configDeTest, ldapValide } from "./identite/aides";
import type { ConfigDeTest } from "./identite/aides";

const URL_TEST = "/api/admin/auth/providers/test";

describe("test d'un fournisseur : route (SQLite)", () => {
  let t: BaseDeTest;
  let cfg: ConfigDeTest;
  let dossier: string;
  let admin: FastifyInstance;
  let chef = 0;
  let modo = 0;
  let muet: ServeurTcp;
  let portMuet = 0;
  let cookieSecure = true;
  let jugeCourant: JugeHote = async () => ({ motif: null, adresses: ["127.0.0.1"] });
  const essai: { sortant: { juger: JugeHote; delaiConnexionMs: number }; delaiGlobalMs?: number } = {
    sortant: { juger: (h, p) => jugeCourant(h, p), delaiConnexionMs: 700 },
  };
  const sockets: { destroy: () => void }[] = [];

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    cleCoffreDeTest();
    cfg = configDeTest({ https: true });
    cfg.ecrire({ auth: { public_url: "https://elpis.exemple.lan", providers: [] } });
    dossier = mkdtempSync(join(tmpdir(), "elpis-essai-route-"));
    configureAudit({
      service: "admin",
      auditDir: join(dossier, "audit"),
      hmacKeyPath: join(dossier, "sans-cle"),
    });
    chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    modo = await createUser(t.base, "modo", "mdp-modo-1", { isAdmin: 2 });
    muet = serveurTcp((x) => void sockets.push(x));
    await new Promise<void>((r) => muet.listen(0, "127.0.0.1", () => r()));
    portMuet = (muet.address() as AddressInfo).port;
    const role = async (req: FastifyRequest, roles: number[]): Promise<void> => {
      const uid = req.headers["x-uid"];
      if (!uid) throw new HttpError(401, "not logged in");
      const ligne = await ligneUtilisateur(t.base, Number(uid));
      req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
      if (!ligne || !roles.includes(Number(ligne.is_admin))) throw new HttpError(403, "Admin required");
    };
    const auth = {
      ...dependancesParDefaut(t.base),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax" as const,
        https_only: cookieSecure,
        max_age: 86_400,
      }),
    };
    admin = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminIdentite({
          base: t.base,
          auth,
          journal: journalMuet,
          revoquer: async () => undefined,
          essai,
        }),
      ],
      gardes: {
        admin: (req: FastifyRequest) => role(req, [1]),
        staff: (req: FastifyRequest) => role(req, [1, 2]),
        session: (req: FastifyRequest) => role(req, [0, 1, 2]),
        service: async () => {
          throw new HttpError(403, "service");
        },
      },
    });
  });
  afterAll(async () => {
    await admin.close();
    for (const x of sockets) x.destroy();
    await new Promise<void>((r) => muet.close(() => r()));
    oublierConfigurationAudit();
    cfg.fermer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const tester = (uid: number | null, corps: unknown): Promise<LightMyRequestResponse> =>
    admin.inject({
      method: "POST",
      url: URL_TEST,
      headers: uid === null ? {} : { "x-uid": String(uid) },
      payload: corps as object,
    });
  const lent = (): Record<string, unknown> =>
    ldapValide({ urls: [`ldaps://serveur-muet.invalid:${portMuet}`] });

  it("modérateur 403, sans session 401", async () => {
    expect((await tester(modo, lent())).statusCode).toBe(403);
    expect((await tester(null, lent())).statusCode).toBe(401);
  });

  it("un test raté est un 200 avec ses étapes, une ligne d'audit, et aucun test réussi n'est enregistré", async () => {
    const r = await tester(chef, lent());
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json<{
      ok: boolean;
      complete: boolean;
      steps: { id: string; level: string; target: string | null }[];
    }>();
    expect(j.ok).toBe(false);
    expect(j.complete).toBe(false);
    expect(j.steps.map((s) => s.id)).toEqual(["settings", "prerequisites", "resolve", "address", "tls"]);
    expect(j.steps.at(-1)).toMatchObject({ level: "fail", target: `serveur-muet.invalid:${portMuet}` });
    const ev = lignesAuditRecentes({ actionPrefix: "admin.auth.provider.test" })[0];
    expect(ev?.["details"]).toEqual({
      provider_id: "annuaire",
      type: "ldap",
      ok: false,
      complete: false,
      failed_step: "tls",
      targets: [`serveur-muet.invalid:${portMuet}`],
      test_user: null,
    });
    expect(await t.base.valeurs("SELECT * FROM auth_provider_state")).toEqual([]);
  });

  it("corps invalide : 200, échec sur les réglages, rien d'enregistré", async () => {
    const r = await tester(chef, { type: "ldap", id: "x", verify_tls: false });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ ok: boolean; steps: { id: string }[] }>()).toMatchObject({
      ok: false,
      steps: [{ id: "settings" }, { id: "prerequisites" }],
    });
    const ev = lignesAuditRecentes({ actionPrefix: "admin.auth.provider.test" })[0];
    expect(ev?.["details"]).toMatchObject({ ok: false, failed_step: "settings", provider_id: "x" });
  });

  it("prérequis lus dans ce processus : cookie non sécurisé signalé", async () => {
    cookieSecure = false;
    try {
      const r = await tester(chef, lent());
      const p = r
        .json<{ steps: { id: string; level: string; detail: string }[] }>()
        .steps.find((s) => s.id === "prerequisites");
      expect(p).toMatchObject({ level: "fail" });
      expect(p?.detail).toContain("connexion sécurisée");
    } finally {
      cookieSecure = true;
    }
  });

  it("deux tests à la fois au plus pour l'instance : le troisième reçoit 429, puis le créneau est rendu", async () => {
    const a = tester(chef, lent());
    const b = tester(chef, lent());
    await new Promise((r) => setTimeout(r, 150));
    const c = await tester(chef, lent());
    expect(c.statusCode).toBe(429);
    expect(c.headers["retry-after"]).toBe("5");
    expect((await a).statusCode).toBe(200);
    expect((await b).statusCode).toBe(200);
    expect((await tester(chef, lent())).statusCode).toBe(200);
  });

  it("le plafond tient tant que le travail continue : réponse rendue à l'échéance, créneau rendu à la fin réelle", async () => {
    jugeCourant = async () => {
      await new Promise((r) => setTimeout(r, 700));
      return { motif: null, adresses: ["127.0.0.1"] };
    };
    essai.delaiGlobalMs = 100;
    try {
      const [a, b] = await Promise.all([tester(chef, lent()), tester(chef, lent())]);
      for (const r of [a, b]) {
        expect(r.statusCode).toBe(200);
        expect(r.json<{ steps: { id: string }[] }>().steps.at(-1)?.id).toBe("timeout");
      }
      expect((await tester(chef, lent())).statusCode, "réponses parties, travail en cours").toBe(429);
      await new Promise((r) => setTimeout(r, 800));
      jugeCourant = async () => ({ motif: null, adresses: ["127.0.0.1"] });
      essai.delaiGlobalMs = undefined;
      expect((await tester(chef, lent())).statusCode, "travail fini").toBe(200);
    } finally {
      essai.delaiGlobalMs = undefined;
    }
  });

  it("les cibles visées sont dans l'audit : un balayage se reconstitue", async () => {
    await tester(chef, ldapValide({ urls: ["ldaps://a.invalid:1", "ldaps://b.invalid:2"] }));
    const ev = lignesAuditRecentes({ actionPrefix: "admin.auth.provider.test" })[0];
    expect((ev?.["details"] as { targets: string[] }).targets).toEqual(["a.invalid:1", "b.invalid:2"]);
  });
});
