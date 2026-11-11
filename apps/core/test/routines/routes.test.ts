// SPDX-License-Identifier: MIT
/** apps/core/test/routines/routes.test.ts — routes /api/routines rejouées contre le routeur Python (vecteurs) : validations, cloisonnement, run immédiat, arrêt, déclencheur webhook ; secret jamais relu. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpError } from "@elpis/commun";
import { reinitialiserCaches, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { configurerCoffre } from "@elpis/securite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installerPortsSkills } from "../../src/composition";
import { creerFamilleRoutines, filtreWebhook } from "../../src/familles/routines";
import { validerHistorique } from "../../src/routines/validation";
import { brancherLlm } from "../../src/llm/branchement";
import { Planificateur, REGLAGES } from "../../src/routines/planificateur";
import { invalidateSkillsScanCache } from "../../src/skills/bibliotheque";
import { appTest } from "../aides";
import { sansAgentsDeRoutine } from "../ecart-routines-sans-agents";
import { ecrireArbre, poserEnv } from "../skills/arbre";

/** Clé du coffre de l'essai (secrets de webhook chiffrés), jamais celle du système. */
configurerCoffre({
  cleEnv: randomBytes(32).toString("base64"),
  systeme: "/nonexistent/vault.key",
  repli: "/nonexistent/.vault.key",
});

type Etape = [string | null, string, string | number, string | null, number?];

const V = JSON.parse(readFileSync(new URL("../vecteurs/routes-routines.json", import.meta.url), "utf-8")) as {
  comptes: [string, number][];
  global: Record<string, string>;
  perso_bob: Record<string, string>;
  sql: [string, unknown[]][];
  t0: number;
  pas: number;
  cap: number;
  boot_id: string;
  etapes: Etape[];
  ids: Record<string, number>;
  reponses: { statut: number; corps: string }[];
  annules: [number, string][];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const JETON = "5ec2e7".repeat(10) + "abcd";

const gardes = {
  session: (req: { headers: Record<string, unknown>; utilisateur?: unknown }) => {
    const uid = req.headers["x-uid"];
    if (!uid) throw new HttpError(401, "not logged in");
    req.utilisateur = { id: Number(uid), username: null };
  },
};

const leaderFactice = { tenu: false, essayer: async () => false, rendre: async () => undefined };

interface Banc {
  app: FastifyInstance;
  base: BaseDeTest["base"];
  planificateur: Planificateur;
  fermer: () => Promise<void>;
}

/** Comptes, connecteurs, politique et skills des vecteurs ; ports du démarrage posés comme dans `composer`. */
async function monterBanc(moteur: "sqlite" | "postgres"): Promise<Banc> {
  const t: BaseDeTest = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  for (const [nom, admin] of V.comptes)
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
      [nom, "s", "h", 0, admin],
    );
  for (const [sql, params] of V.sql) await t.base.run(sql, params as never[]);
  const racine = mkdtempSync(join(tmpdir(), "elpis-routines-routes-"));
  await ecrireArbre(join(racine, "global"), V.global);
  await ecrireArbre(join(racine, "user_skills", "bob"), V.perso_bob);
  const remettreEnv = poserEnv({
    APP_SKILLS_DIR: join(racine, "global"),
    SKILLS_LOCK_PATH: join(racine, ".skills_write.lock"),
    ELPIS_ENGINE_ACCESS_DIR: join(racine, "acces"),
  });
  const remettreConfig = surchargerConfig({
    USER_SKILLS_DIR: join(racine, "user_skills"),
    SANDBOX_DIR: join(racine, "sb"),
  });
  reinitialiserCaches();
  invalidateSkillsScanCache();
  installerPortsSkills(t.base);
  brancherLlm(t.base);
  const planificateur = new Planificateur({ base: t.base, meneur: leaderFactice, bootId: V.boot_id });
  const app = await appTest({
    familles: [creerFamilleRoutines({ base: t.base, planificateur, jetonSecret: () => JETON })],
    gardes,
  });
  return {
    app,
    base: t.base,
    planificateur,
    fermer: async () => {
      await app.close();
      remettreConfig();
      remettreEnv();
      invalidateSkillsScanCache();
      await t.fermer();
      rmSync(racine, { recursive: true, force: true });
    },
  };
}

const capAvant = REGLAGES.perUserCap;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  REGLAGES.perUserCap = capAvant;
});

describe.each(MOTEURS)("routes des routines rejouées contre le Python (%s)", (moteur) => {
  it("réponses identiques étape par étape, arrêt signalé au run, secret jamais relu", async () => {
    const banc = await monterBanc(moteur);
    try {
      REGLAGES.perUserCap = V.cap;
      const lances = vi.spyOn(banc.planificateur, "executerRun").mockResolvedValue(undefined);
      vi.useFakeTimers({ toFake: ["Date"] });
      let saut = 0;
      for (const [i, [nom, methode, chemin, corps, statutTs]] of V.etapes.entries()) {
        if (methode === "AVANCER") {
          saut += chemin as number;
          continue;
        }
        vi.setSystemTime((V.t0 + V.pas * i + saut) * 1000);
        const entetes: Record<string, string> = nom ? { "x-uid": String(V.ids[nom]) } : {};
        if (corps !== null) entetes["content-type"] = "application/json";
        const r = await banc.app.inject({
          method: methode as "GET",
          url: chemin as string,
          headers: entetes,
          ...(corps === null ? {} : { payload: Buffer.from(corps, "utf8") }),
        });
        const etiquette = `étape ${i} : ${methode} ${String(chemin)}`;
        if (!String(chemin).endsWith("/webhook/rotate")) expect(r.body, etiquette).not.toContain(JETON);
        if (statutTs !== undefined) {
          expect(r.statusCode, `${etiquette} (écart déclaré)`).toBe(statutTs);
          continue;
        }
        const attendu = V.reponses[i]!;
        expect({ statut: r.statusCode, corps: r.body.replaceAll(JETON, "<secret>") }, etiquette).toEqual({
          ...attendu,
          corps: sansAgentsDeRoutine(attendu.corps),
        });
      }
      expect(lances.mock.calls.map((c) => c[1])).toEqual([1, 3, 5]);
      const annules = (banc.planificateur as unknown as { annulations: Map<string, number> }).annulations;
      expect([...annules.keys()]).toEqual(V.annules.map(([u, c]) => `${u}|${c}`));
    } finally {
      await banc.fermer();
    }
  }, 60_000);
});

describe("validations sans équivalent dans les vecteurs", () => {
  it("prompts bornés à 200 000 points de code (une émoji = un caractère)", async () => {
    const banc = await monterBanc("sqlite");
    try {
      const poster = (corps: unknown) =>
        banc.app.inject({
          method: "POST",
          url: "/api/routines",
          headers: { "x-uid": "1", "content-type": "application/json" },
          payload: JSON.stringify(corps),
        });
      const limite = await poster({ name: "A", task_prompt: "\u{1f600}".repeat(200_000) });
      expect([limite.statusCode, limite.json()]).toEqual([200, { id: 1, ok: true }]);
      const trop = await poster({ name: "A", system_prompt: "é".repeat(200_001) });
      expect([trop.statusCode, trop.json()]).toEqual([
        400,
        { detail: "system_prompt trop long (max 200000 caractères)" },
      ]);
    } finally {
      await banc.fermer();
    }
  });

  it("politiques d'accès illisibles : 503 access_check_failed, pas un refus 403", async () => {
    const banc = await monterBanc("sqlite");
    try {
      await banc.base.exec("DROP TABLE user_groups");
      const r = await banc.app.inject({
        method: "POST",
        url: "/api/routines",
        headers: { "x-uid": "1", "content-type": "application/json" },
        payload: JSON.stringify({ name: "A", connector_id: 1 }),
      });
      expect([r.statusCode, r.json()]).toEqual([
        503,
        {
          detail: {
            code: "engine_unavailable",
            reason: "access_check_failed",
            message: "Contrôle d'accès au serveur indisponible, réessayez.",
          },
        },
      ]);
    } finally {
      await banc.fermer();
    }
  });

  it("historique et filtre : seules les clés présentes, events dédupliqués", () => {
    expect(validerHistorique({})).toEqual({});
    expect(validerHistorique({ runs_keep: 3n as unknown as number, notify_on: null })).toEqual({
      runs_keep: 3,
      notify_on: "all",
    });
    expect(filtreWebhook({ events: ["Push", "push", " PUSH "] })).toEqual({
      events: ["push"],
      branch: "",
      repo: "",
    });
  });
});
