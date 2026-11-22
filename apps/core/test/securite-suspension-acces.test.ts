// SPDX-License-Identifier: MIT
/** apps/core/test/securite-suspension-acces.test.ts — suspendre un compte révoque ses jetons d'API et ses accès OAuth (absents après réactivation), la route en rend les nombres ; deux suspensions simultanées des deux derniers administrateurs locaux : une seule réussit. */
import { createHash, randomBytes } from "node:crypto";

import {
  creerJeton,
  createUser,
  dependancesParDefaut,
  exchangeCode,
  getClient,
  issueCode,
  registerClient,
  resoudreJeton,
  verifyAccessToken,
} from "@elpis/auth";
import type { ClientOAuth, DependancesOAuth } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reactiver, suspendre } from "../src/comptes/etat";
import { creerFamilleAdminComptes } from "../src/familles/admin-comptes";
import { appTest, journalMuet } from "./aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T0 = 1_800_000_000;
configurerCoffre({
  cleEnv: randomBytes(32).toString("base64"),
  systeme: "/nonexistent/vault.key",
  repli: "/nonexistent/.vault.key",
});

describe.each(MOTEURS)("suspension : accès non interactifs révoqués (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice = 0;
  let bob = 0;
  let chef = 0;
  let app: FastifyInstance;
  let od: DependancesOAuth;
  let client: ClientOAuth;
  const verifier = "v".repeat(50);

  const auth = (): ReturnType<typeof dependancesParDefaut> => ({
    ...dependancesParDefaut(t.base),
    maintenant: () => T0,
    config: () => ({}),
  });
  const depEtat = (): Parameters<typeof suspendre>[0] => ({
    base: t.base,
    acces: auth(),
    maintenant: () => T0,
    publierSuspension: async () => true,
    journal: journalMuet,
  });
  const paireOauth = async (uid: number): Promise<Record<string, unknown>> => {
    const code = await issueCode(od, {
      client_id: client.client_id,
      user_id: uid,
      redirect_uri: "https://c.example/cb",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      resource: "",
      families: ["fs"],
    });
    return exchangeCode(od, {
      code,
      client,
      redirectUri: "https://c.example/cb",
      codeVerifier: verifier,
      resource: "",
      appUrl: "https://app.lan",
    });
  };

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    alice = await createUser(t.base, "alice", "mdp-alice", { maintenant: T0 });
    bob = await createUser(t.base, "bob", "mdp-bob", { maintenant: T0 });
    chef = await createUser(t.base, "chef", "mdp-chef", { isAdmin: 1, maintenant: T0 });
    let n = 0;
    od = {
      base: t.base,
      config: () => ({}),
      maintenant: () => T0,
      jetonUrl: (k) => `U${String(++n).padStart(4, "0")}`.padEnd(Math.ceil((4 * k) / 3), "u"),
      jetonHex: (k) => `H${String(++n).padStart(4, "0")}`.padEnd(2 * k, "0"),
      resoudre: async () => [],
      telecharger: async () => Buffer.from(""),
    };
    const cree = (await registerClient(
      od,
      { redirect_uris: ["https://c.example/cb"], client_name: "C" },
      "dcr",
      1000,
    )) as Record<string, string>;
    client = (await getClient(t.base, cree["client_id"])) as ClientOAuth;
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminComptes({
          base: t.base,
          auth: auth(),
          journal: journalMuet,
          revoquer: async () => undefined,
          publierSuspension: async () => true,
        }),
      ],
      gardes: {
        admin: (req) => {
          req.utilisateur = { id: chef, username: "chef" };
        },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await t?.fermer();
  });

  it("jetons d'API et accès OAuth révoqués par la suspension, absents après réactivation, l'autre compte intact", async () => {
    const [jetonAlice] = await creerJeton(auth(), alice, "tools", "t", ["fs"], 5);
    const [jetonBob] = await creerJeton(auth(), bob, "tools", "t", ["fs"], 5);
    const paireAlice = await paireOauth(alice);
    const paireBob = await paireOauth(bob);
    const ok = async (jeton: string): Promise<boolean> =>
      (await resoudreJeton(auth(), jeton, ["tools"], false)) !== null;
    expect(await ok(jetonAlice)).toBe(true);
    const bilan = await suspendre(depEtat(), alice, "admin");
    expect(bilan.change).toBe(true);
    expect(bilan.tokens).toBe(1);
    expect(bilan.oauth).toBeGreaterThan(0);
    await reactiver({ base: t.base, maintenant: () => T0 + 1 }, alice);
    expect(await ok(jetonAlice)).toBe(false);
    expect(await verifyAccessToken(od, paireAlice["access_token"])).toBeNull();
    expect(await ok(jetonBob)).toBe(true);
    expect(await verifyAccessToken(od, paireBob["access_token"])).not.toBeNull();
  });

  it("la route rend le nombre de jetons et d'accès OAuth révoqués", async () => {
    await creerJeton(auth(), bob, "tools", "t2", ["fs"], 5);
    await paireOauth(bob);
    const r = await app.inject({ method: "POST", url: `/api/admin/users/${bob}/suspend` });
    expect(r.statusCode).toBe(200);
    const corps = r.json<{ tokens_revoked: number; oauth_revoked: number }>();
    expect(corps.tokens_revoked).toBeGreaterThanOrEqual(1);
    expect(corps.oauth_revoked).toBeGreaterThan(0);
    const r2 = await app.inject({ method: "POST", url: `/api/admin/users/${bob}/suspend` });
    expect(r2.json()).toMatchObject({ ok: true, tokens_revoked: 0, oauth_revoked: 0 });
  });
});

describe.each(MOTEURS)(
  "deux suspensions simultanées des deux derniers administrateurs locaux (%s)",
  (moteur) => {
    it("une seule réussit, l'autre est refusée en 409 et un administrateur reste actif", async () => {
      const t = ouvrirBaseDeTest(moteur);
      try {
        await initialiserBase(t.base);
        const a = await createUser(t.base, "adm-a", "mdp-a", { isAdmin: 1, maintenant: T0 });
        const b = await createUser(t.base, "adm-b", "mdp-b", { isAdmin: 1, maintenant: T0 });
        const dep = (): Parameters<typeof suspendre>[0] => ({
          base: t.base,
          acces: dependancesParDefaut(t.base),
          maintenant: () => T0,
          publierSuspension: async () => true,
          journal: journalMuet,
        });
        const issues = await Promise.allSettled([suspendre(dep(), a, "admin"), suspendre(dep(), b, "admin")]);
        expect(issues.filter((i) => i.status === "fulfilled")).toHaveLength(1);
        const refus = issues.find((i) => i.status === "rejected") as PromiseRejectedResult;
        expect(refus.reason).toBeInstanceOf(HttpError);
        expect((refus.reason as HttpError).statusCode).toBe(409);
        const actifs = await t.base.valeurs<[number]>(
          "SELECT id FROM users WHERE is_admin=1 AND (suspended_at IS NULL OR suspended_at=0)",
        );
        expect(actifs).toHaveLength(1);
      } finally {
        await t.fermer();
      }
    });
  },
);
