// SPDX-License-Identifier: MIT
/** apps/core/test/securite-acces-comptes-locaux-reserves.test.ts — en mode local « administrateurs seulement », les accès non interactifs d'un compte local ordinaire (jeton d'API, OAuth, routine, webhook) s'arrêtent sans rien supprimer et reprennent au retour du mode « tous » ; un administrateur local n'est jamais gêné (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createHash, randomBytes } from "node:crypto";

import {
  accesPerimeDe,
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
import { configurerCoffre } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerFamilleWebhooks } from "../src/familles/webhooks";
import { createRoutine, setRoutineWebhook } from "../src/routines/magasin";
import { Planificateur } from "../src/routines/planificateur";
import { appTest } from "./aides";
import { AnnuaireFactice } from "./identite/annuaire/annuaire-factice";
import { ouvrirBancAnnuaire } from "./identite/annuaire/banc-annuaire";
import type { BancAnnuaire } from "./identite/annuaire/banc-annuaire";
import { MOTEURS } from "./identite/banc";

configurerCoffre({
  cleEnv: randomBytes(32).toString("base64"),
  systeme: "/nonexistent/vault.key",
  repli: "/nonexistent/.vault.key",
});

describe("accesPerimeDe : mode local réservé aux administrateurs", () => {
  const T = 1_800_000_000;
  const local = (
    admin: number,
  ): { ident_provider_id: null; ident_checked_at: null; ident_is_admin: number } => ({
    ident_provider_id: null,
    ident_checked_at: null,
    ident_is_admin: admin,
  });

  it("compte local non administrateur périmé seulement quand le mode est réservé ; administrateur jamais", async () => {
    const reserve = { localReserveAuxAdmins: () => true };
    expect(await accesPerimeDe(reserve, local(0), T)).toBe(true);
    expect(await accesPerimeDe(reserve, local(2), T)).toBe(true);
    expect(await accesPerimeDe(reserve, local(1), T)).toBe(false);
    expect(await accesPerimeDe({ localReserveAuxAdmins: () => false }, local(0), T)).toBe(false);
    expect(await accesPerimeDe({}, local(0), T)).toBe(false);
    expect(
      await accesPerimeDe(
        {
          localReserveAuxAdmins: () => {
            throw new Error("panne");
          },
        },
        local(0),
        T,
      ),
    ).toBe(false);
  });
});

describe.each(MOTEURS)("accès non interactifs d'un compte local en mode réservé (%s)", (moteur) => {
  let b: BancAnnuaire;
  let reserve: boolean;
  let maintenant: number;
  let ordinaire: number;
  let admin: number;

  const dep = () => ({
    ...dependancesParDefaut(b.t.base),
    maintenant: () => b.horloge,
    localReserveAuxAdmins: () => reserve,
  });
  const champs = {
    name: "r",
    cron_expr: "* * * * *",
    model: null,
    system_prompt: "",
    task_prompt: "t",
    mcp_servers: [],
  };

  beforeEach(async () => {
    b = await ouvrirBancAnnuaire(moteur, [{}], new AnnuaireFactice());
    maintenant = Math.floor(Date.now() / 1000);
    b.horloge = maintenant;
    reserve = false;
    ordinaire = await createUser(b.t.base, "ordinaire", "mdp-ordinaire-1", {
      maintenant: maintenant - 400 * 86_400,
    });
    admin = await createUser(b.t.base, "respo", "mdp-respo-1", {
      isAdmin: 1,
      maintenant: maintenant - 400 * 86_400,
    });
  });
  afterEach(async () => {
    await b.fermer();
  });

  it("jeton d'API : refusé en mode réservé, accepté de nouveau au retour du mode « tous » ; administrateur jamais gêné", async () => {
    const [jo] = await creerJeton(dep(), ordinaire, "tools", "t", ["fs"], 5);
    const [ja] = await creerJeton(dep(), admin, "tools", "t", ["fs"], 5);
    const ok = async (j: unknown): Promise<boolean> =>
      (await resoudreJeton(dep(), j as string, ["tools"], false)) !== null;
    expect([await ok(jo), await ok(ja)]).toEqual([true, true]);
    reserve = true;
    expect([await ok(jo), await ok(ja)]).toEqual([false, true]);
    reserve = false;
    expect(await ok(jo)).toBe(true);
  });

  it("OAuth : jeton d'accès, échange du code refusés en mode réservé, repris au retour", async () => {
    let n = 0;
    const od: DependancesOAuth = {
      base: b.t.base,
      config: () => ({}),
      localReserveAuxAdmins: () => reserve,
      maintenant: () => b.horloge,
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
    const client = (await getClient(b.t.base, cree["client_id"] as string)) as ClientOAuth;
    const verifierPkce = "v".repeat(50);
    const defi = createHash("sha256").update(verifierPkce).digest("base64url");
    const echange = async (uid: number): Promise<Record<string, unknown>> =>
      exchangeCode(od, {
        code: await issueCode(od, {
          client_id: client.client_id,
          user_id: uid,
          redirect_uri: "https://c.example/cb",
          code_challenge: defi,
          resource: "",
          families: ["fs"],
        }),
        client,
        redirectUri: "https://c.example/cb",
        codeVerifier: verifierPkce,
        resource: "",
        appUrl: "https://app.lan",
      });
    const po = await echange(ordinaire);
    const pa = await echange(admin);
    reserve = true;
    expect(await verifyAccessToken(od, po["access_token"])).toBeNull();
    expect(await verifyAccessToken(od, pa["access_token"])).not.toBeNull();
    await expect(echange(ordinaire)).rejects.toMatchObject({ error: "invalid_grant" });
    reserve = false;
    expect(await verifyAccessToken(od, po["access_token"])).not.toBeNull();
  });

  describe("routines et webhooks", () => {
    let lancees: number[];
    let p: Planificateur;
    beforeEach(() => {
      lancees = [];
      p = new Planificateur({
        base: b.t.base,
        meneur: { tenu: true, essayer: async () => true, rendre: async () => undefined },
        llmJoignable: async () => true,
        localReserve: () => reserve,
        runner: async (o) => {
          lancees.push(Number(o.userId ?? 0));
          return ["ok", [], {}];
        },
      });
    });
    const routine = async (id: number): Promise<Record<string, unknown>> =>
      (await b.t.base.get<Record<string, unknown>>("SELECT * FROM editor_routines WHERE id=?", [
        id,
      ])) as Record<string, unknown>;

    it("routine planifiée : sautée en mode réservé pour un compte ordinaire, lancée pour un administrateur et au retour", async () => {
      const ro = await routine(await createRoutine(b.t.base, ordinaire, champs));
      const ra = await routine(await createRoutine(b.t.base, admin, champs));
      reserve = true;
      expect(await p.lancerRun(ro, { trigger: "schedule" })).toBeNull();
      expect(await p.lancerRun(ra, { trigger: "schedule" })).not.toBeNull();
      await vi.waitFor(() => expect(lancees).toEqual([admin]));
      await p.drainer();
      reserve = false;
      expect(await p.lancerRun(ro, { trigger: "schedule" })).not.toBeNull();
      await vi.waitFor(() => expect(lancees).toEqual([admin, ordinaire]));
      await p.drainer();
    });

    it("webhook : livraison sautée en mode réservé pour un compte ordinaire, run lancé au retour", async () => {
      const id = await createRoutine(b.t.base, ordinaire, { ...champs, cron_expr: "" });
      const secret = "s".repeat(32);
      await setRoutineWebhook(b.t.base, id, ordinaire, { enabled: true, secret });
      const app = await appTest({ familles: [creerFamilleWebhooks({ base: b.t.base, planificateur: p })] });
      try {
        const livrer = async (): Promise<Record<string, unknown>> =>
          (
            await app.inject({
              method: "POST",
              url: `/api/webhooks/routines/${id}?token=${secret}`,
              headers: { "content-type": "application/json", "x-webhook-event": "push" },
              payload: { ref: "refs/heads/main" },
            })
          ).json();
        reserve = true;
        expect(await livrer()).toMatchObject({ skipped: true });
        reserve = false;
        expect(await livrer()).toHaveProperty("run_id");
        await p.drainer();
      } finally {
        await app.close();
      }
    });
  });
});
