// SPDX-License-Identifier: MIT
/** apps/core/test/routines/webhook-coffre.test.ts — secret de webhook des routines chiffré sur place par le coffre (SQLite, PostgreSQL si ELPIS_TEST_PG) : jamais en clair en base ni listé dans Secrets, signature HMAC et jeton vérifiés après déchiffrement, illisible → livraison ignorée ; `vault status`/`rekey` le comptent et le rechiffrent, et tolèrent la colonne pas encore posée. */
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aadWebhookRoutine, initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { cleCoffre, configurerCoffre, dechiffrerSecret } from "@elpis/securite";
import type { CleCoffre } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { creerFamilleWebhooks } from "../../src/familles/webhooks";
import {
  createRoutine,
  getRoutine,
  getRoutineWebhookSecret,
  setRoutineWebhook,
} from "../../src/routines/magasin";
import type { Planificateur } from "../../src/routines/planificateur";
import { rechiffrerCoffre, secretsParCle } from "../../src/secrets/cle";
import { listerSecrets } from "../../src/secrets/stockage";
import { appTest } from "../aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

describe.each(MOTEURS)("secret de webhook des routines dans le coffre (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier = "";
  let uid = 0;
  let rid = 0;
  const lances: number[] = [];

  const coffre = (): CleCoffre => {
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    return cleCoffre() as CleCoffre;
  };

  beforeEach(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-webhook-coffre-"));
    coffre();
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    uid = await t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('alice', '', '', 0)",
    );
    rid = await createRoutine(t.base, uid, {
      name: "r",
      cron_expr: "",
      model: null,
      system_prompt: "",
      task_prompt: "t",
      mcp_servers: [],
      enabled: true,
    });
    lances.length = 0;
  });

  afterEach(async () => {
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const livrer = async (
    app: FastifyInstance,
    entetes: Record<string, string>,
    corps: string,
  ): Promise<unknown> =>
    (
      await app.inject({
        method: "POST",
        url: `/api/webhooks/routines/${rid}`,
        headers: { "content-type": "application/json", ...entetes },
        payload: corps,
      })
    ).json();

  it("chiffré sur place (AAD de la routine), jamais rendu ni listé ; HMAC et jeton vérifiés ; illisible : livraison ignorée", async () => {
    expect(await setRoutineWebhook(t.base, rid, uid, { enabled: true, secret: "s3cret-hook" })).toBe(true);
    const brut = await t.base.get<{ webhook_secret: string | null; webhook_secret_enc: string }>(
      "SELECT webhook_secret, webhook_secret_enc FROM editor_routines WHERE id = ?",
      [rid],
    );
    expect(brut?.webhook_secret).toBeNull();
    expect(brut?.webhook_secret_enc).toMatch(/^v1\.[0-9a-f]{8}\./u);
    expect(dechiffrerSecret(String(brut?.webhook_secret_enc), aadWebhookRoutine(rid))).toBe("s3cret-hook");
    expect(() => dechiffrerSecret(String(brut?.webhook_secret_enc), aadWebhookRoutine(rid + 1))).toThrow();
    const vue = (await getRoutine(t.base, rid, uid)) as Record<string, unknown>;
    expect(vue["webhook_has_secret"]).toBe(true);
    expect(Object.keys(vue)).not.toContain("webhook_secret_enc");
    expect(Object.keys(vue)).not.toContain("webhook_secret");
    expect(JSON.stringify(vue)).not.toContain(String(brut?.webhook_secret_enc));
    expect(await listerSecrets(t.base, uid)).toEqual([]);
    expect(await getRoutineWebhookSecret(t.base, rid)).toBe("s3cret-hook");

    const planificateur = {
      lancerRun: async (r: Record<string, unknown>): Promise<number> => {
        lances.push(Number(r["id"]));
        return 99;
      },
    } as unknown as Planificateur;
    const app = await appTest({ familles: [creerFamilleWebhooks({ base: t.base, planificateur })] });
    try {
      const corps = JSON.stringify({ ref: "refs/heads/main" });
      const sig = createHmac("sha256", "s3cret-hook").update(corps).digest("hex");
      expect(
        await livrer(app, { "x-hub-signature-256": `sha256=${sig}`, "x-github-event": "push" }, corps),
      ).toEqual({
        ok: true,
        run_id: 99,
      });
      expect(await livrer(app, { "x-webhook-token": "s3cret-hook" }, "{}")).toEqual({ ok: true, run_id: 99 });
      expect(await livrer(app, { "x-webhook-token": "mauvais" }, "{}")).toEqual({ ok: true });
      expect(lances).toEqual([rid, rid]);
      coffre();
      expect(await getRoutineWebhookSecret(t.base, rid)).toBeNull();
      expect(await livrer(app, { "x-webhook-token": "s3cret-hook" }, "{}")).toEqual({ ok: true });
      expect(lances).toEqual([rid, rid]);
    } finally {
      await app.close();
    }
  });

  it("`vault status` le compte avec sa clé ; `rekey` le rechiffre avec la clé courante", async () => {
    const ancienne = cleCoffre() as CleCoffre;
    await setRoutineWebhook(t.base, rid, uid, { secret: "hook-avant" });
    let c = await secretsParCle(t.base);
    expect(c).toMatchObject({ total: 0, webhooks: 1 });
    expect([...c.parKid]).toEqual([[ancienne.kid, 1]]);
    const courante = coffre();
    expect(await getRoutineWebhookSecret(t.base, rid)).toBeNull();
    const r = await rechiffrerCoffre(t.base, ancienne, courante);
    expect(r).toEqual({ rechiffres: 1, echecs: 0, restants: 0 });
    expect(await getRoutineWebhookSecret(t.base, rid)).toBe("hook-avant");
    c = await secretsParCle(t.base);
    expect([...c.parKid]).toEqual([[courante.kid, 1]]);
    await t.base.run("UPDATE editor_routines SET webhook_secret_enc = ? WHERE id = ?", [
      `v1.${ancienne.kid}.${"A".repeat(16)}.${"B".repeat(30)}`,
      rid,
    ]);
    expect(await rechiffrerCoffre(t.base, ancienne, courante)).toEqual({
      rechiffres: 0,
      echecs: 1,
      restants: 1,
    });
  });

  it("colonne pas encore posée (code mis à jour, services pas redémarrés) : `vault status` et `rekey` sans erreur, aucun secret de webhook compté", async () => {
    const ancienne = cleCoffre() as CleCoffre;
    await t.base.run("ALTER TABLE editor_routines DROP COLUMN webhook_secret_enc");
    expect(await secretsParCle(t.base)).toMatchObject({ total: 0, webhooks: 0 });
    expect(await rechiffrerCoffre(t.base, ancienne, coffre())).toEqual({
      rechiffres: 0,
      echecs: 0,
      restants: 0,
    });
  });
});
