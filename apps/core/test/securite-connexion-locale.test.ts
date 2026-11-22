// SPDX-License-Identifier: MIT
/** apps/core/test/securite-connexion-locale.test.ts — core réel (process console, vraie connexion) : `auth.local.mode = admins` refuse le mot de passe d'un compte non administrateur avec le même 401 qu'un mauvais mot de passe, un compte sans mot de passe local ne change pas de mot de passe, un modérateur est refusé sur chaque route de la connexion d'entreprise. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config, invalidateConfigCache } from "@elpis/config";
import type * as Securite from "@elpis/securite";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { creerCompte, demarrerCore } from "../../../packages/contracts/test/core/aides";
import type { CoreDeTest } from "../../../packages/contracts/test/core/aides";
import { lignesAuditRecentes } from "./aides";

const compteurs = vi.hoisted(() => ({ refus: 0, verifications: 0 }));

vi.mock("@elpis/securite", async (original) => {
  const reel = await original<typeof Securite>();
  return {
    ...reel,
    completerCoutRefus: (...a: Parameters<typeof reel.completerCoutRefus>) => {
      compteurs.refus += 1;
      return reel.completerCoutRefus(...a);
    },
    verifyPassword: (...a: Parameters<typeof reel.verifyPassword>) => {
      compteurs.verifications += 1;
      return reel.verifyPassword(...a);
    },
  };
});

describe("connexion locale et mot de passe (core réel, process console)", () => {
  let core: CoreDeTest;
  let audit: string;
  let bob = 0;
  let ext = 0;
  let cookieModo = "";
  let cookieExt = "";
  let cookieRacine = "";

  const ecrireAuth = (auth: unknown): void => {
    writeFileSync(config.CONFIG_JSON_PATH, JSON.stringify({ auth }));
    invalidateConfigCache();
  };
  const connexion = (username: string, password: string): Promise<LightMyRequestResponse> =>
    core.app.inject({ method: "POST", url: "/api/login-lite", payload: { username, password } });

  beforeAll(async () => {
    core = await demarrerCore("admin");
    audit = mkdtempSync(join(tmpdir(), "elpis-connexion-locale-"));
    configureAudit({ service: "admin", auditDir: audit, hmacKeyPath: join(audit, "sans-cle") });
    await creerCompte(core.base, "racine", "mdp-racine-1", 1);
    await creerCompte(core.base, "modo", "mdp-modo-1", 2);
    bob = await creerCompte(core.base, "bob", "mdp-bob-1");
    ext = await creerCompte(core.base, "externe", "mdp-externe-1");
    cookieRacine = await core.connecter("racine", "mdp-racine-1");
    cookieModo = await core.connecter("modo", "mdp-modo-1");
    cookieExt = await core.connecter("externe", "mdp-externe-1");
    await core.base.run("UPDATE users SET pass_hash='!' WHERE id=?", [ext]);
  });

  afterAll(async () => {
    oublierConfigurationAudit();
    rmSync(audit, { recursive: true, force: true });
    await core.fermer();
  });

  it("mode `all` (et sans section) : tout compte se connecte", async () => {
    expect((await connexion("bob", "mdp-bob-1")).statusCode).toBe(200);
    ecrireAuth({ local: { mode: "all" } });
    expect((await connexion("bob", "mdp-bob-1")).statusCode).toBe(200);
  });

  it("mode `admins` : un compte non administrateur reçoit le même 401 que pour un mauvais mot de passe, audit local_disabled, sans cookie", async () => {
    ecrireAuth({ local: { mode: "admins" } });
    const refuse = await connexion("bob", "mdp-bob-1");
    const faux = await connexion("bob", "mauvais-mot-de-passe");
    expect([refuse.statusCode, refuse.body, refuse.headers["set-cookie"]]).toEqual([
      401,
      faux.body,
      undefined,
    ]);
    expect(refuse.json()).toEqual({ detail: "invalid credentials" });
    expect((await connexion("modo", "mdp-modo-1")).statusCode).toBe(401);
    expect((await connexion("racine", "mdp-racine-1")).statusCode).toBe(200);
    const raisons = lignesAuditRecentes({ actionPrefix: "auth.login.denied" }).map(
      (l) => `${String(l["username"])}:${String((l["details"] as { reason?: unknown }).reason)}`,
    );
    expect(raisons).toEqual(expect.arrayContaining(["bob:local_disabled", "modo:local_disabled"]));
    expect(raisons).not.toContain("racine:local_disabled");
  });

  it("mode `admins` : un non-administrateur suit le chemin d'un compte inconnu : même réponse, même nombre de hachages, aucune vérification du mot de passe", async () => {
    ecrireAuth({ local: { mode: "admins" } });
    const compter = async (nom: string, mdp: string): Promise<[number, number, string]> => {
      compteurs.refus = 0;
      compteurs.verifications = 0;
      const r = await connexion(nom, mdp);
      return [compteurs.refus, compteurs.verifications, r.body];
    };
    const inconnu = await compter("personne", "mdp-bob-1");
    const nonAdmin = await compter("bob", "mdp-bob-1");
    expect(nonAdmin).toEqual(inconnu);
    expect(nonAdmin.slice(0, 2)).toEqual([1, 0]);
    expect((await compter("bob", "mauvais"))[0]).toBe(1);
    const r = await connexion("bob", "mdp-bob-1");
    expect(r.statusCode).toBe(401);
    ecrireAuth({ local: { mode: "all" } });
    expect((await connexion("bob", "mdp-bob-1")).statusCode).toBe(200);
  });

  it("compte sans mot de passe local : aucune saisie ne le connecte, et sa session ouverte par mot de passe ne vaut plus rien", async () => {
    for (const saisie of ["mdp-externe-1", "!", "x"])
      expect((await connexion("externe", saisie)).statusCode).toBe(401);
    const avant = await core.base.get<{ pass_hash: string }>("SELECT pass_hash FROM users WHERE id=?", [ext]);
    // La session avait été ouverte par mot de passe : elle n'est plus admise depuis que le compte n'en a plus.
    for (const payload of [
      { old_password: "!", new_password: "Nouveau-mdp-1234" },
      { new_password: "Nouveau-mdp-1234" },
    ]) {
      const r = await core.app.inject({
        method: "POST",
        url: "/api/users/change-password",
        headers: { cookie: cookieExt },
        payload,
      });
      expect(r.statusCode).toBe(401);
    }
    expect(
      (await core.base.get<{ pass_hash: string }>("SELECT pass_hash FROM users WHERE id=?", [ext]))
        ?.pass_hash,
    ).toBe(avant?.pass_hash);
  });

  it("réinitialisation par la console d'un compte sans mot de passe local : 409", async () => {
    const r = await core.app.inject({
      method: "POST",
      url: "/api/admin/reset-password",
      headers: { cookie: cookieRacine },
      payload: { target_id: ext, new_password: "Nouveau-mdp-1234" },
    });
    expect(r.statusCode).toBe(409);
    expect(bob).toBeGreaterThan(0);
  });

  it("un modérateur est refusé (403) sur chaque route de la connexion d'entreprise, un administrateur passe", async () => {
    const routes: [string, string, object?][] = [
      ["GET", "/api/admin/auth"],
      ["PUT", "/api/admin/auth/settings", {}],
      ["POST", "/api/admin/auth/providers", {}],
      ["PUT", "/api/admin/auth/providers/x", {}],
      ["DELETE", "/api/admin/auth/providers/x"],
      ["PUT", "/api/admin/auth/providers/x/secret", { secret: "s" }],
      ["POST", "/api/admin/auth/providers/x/enable"],
      ["POST", "/api/admin/auth/providers/x/disable"],
    ];
    for (const [m, u, corps] of routes) {
      const r = await core.app.inject({
        method: m as "GET",
        url: u,
        headers: { cookie: cookieModo },
        ...(corps ? { payload: corps } : {}),
      });
      expect(r.statusCode, `${m} ${u}`).toBe(403);
    }
    const ok = await core.app.inject({
      method: "GET",
      url: "/api/admin/auth",
      headers: { cookie: cookieRacine },
    });
    expect(ok.statusCode).toBe(200);
  });
});
