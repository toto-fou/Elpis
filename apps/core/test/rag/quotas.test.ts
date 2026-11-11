// SPDX-License-Identifier: MIT
/** apps/core/test/rag/quotas.test.ts — quotas RAG d'un compte : défauts de l'instance, surcharge clé par clé posée par l'admin, retrait, valeurs refusées. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getUserSettings } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { definirQuotaRagCompte, quotasRag, surchargeQuotaRag } from "../../src/rag/quotas";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

let dossier: string;
let restaurer: () => void;

beforeAll(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-rag-quotas-"));
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
});

afterAll(() => {
  restaurer();
  rmSync(dossier, { recursive: true, force: true });
});

describe.each(MOTEURS)("quotas RAG (%s)", (moteur) => {
  let t: BaseDeTest;
  let uid: number;

  beforeEach(async () => {
    writeFileSync(join(dossier, "config.json"), "{}");
    invalidateConfigCache();
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    uid = await t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, settings_json) VALUES('alice', '', '', 1, ?)",
      [JSON.stringify({ theme: "sombre", sandbox_quota_mb: 100 })],
    );
  });

  afterEach(async () => t.fermer());

  it("défauts du plan, puis ceux de l'instance, puis la surcharge du compte clé par clé", async () => {
    expect(await quotasRag(t.base, uid)).toEqual({
      storage_mb: 2048,
      collections: 10,
      file_mb: 200,
      docs_per_collection: 2000,
    });
    writeFileSync(
      join(dossier, "config.json"),
      JSON.stringify({ rag: { quotas: { storage_mb: 4096, file_mb: 50 } } }),
    );
    invalidateConfigCache();
    expect(await quotasRag(t.base, uid)).toMatchObject({ storage_mb: 4096, file_mb: 50, collections: 10 });
    expect(await definirQuotaRagCompte(t.base, uid, { collections: 3, file_mb: 0 })).toEqual({
      collections: 3,
      file_mb: 0,
    });
    expect(await quotasRag(t.base, uid)).toEqual({
      storage_mb: 4096,
      collections: 3,
      file_mb: 0,
      docs_per_collection: 2000,
    });
    const reglages = await getUserSettings(t.base, uid);
    expect(reglages).toMatchObject({
      theme: "sombre",
      sandbox_quota_mb: 100,
      rag_quota: { collections: 3, file_mb: 0 },
    });
    expect(surchargeQuotaRag(reglages)).toEqual({ collections: 3, file_mb: 0 });
  });

  it("retrait de la surcharge (`null` ou objet vide) ; valeur hors bornes refusée sans rien écrire", async () => {
    await definirQuotaRagCompte(t.base, uid, { storage_mb: 10 });
    for (const mauvais of [{ storage_mb: -1 }, { collections: 1.5 }, { file_mb: 100_001 }])
      await expect(definirQuotaRagCompte(t.base, uid, mauvais)).rejects.toThrow(RangeError);
    expect((await quotasRag(t.base, uid)).storage_mb).toBe(10);
    expect(await definirQuotaRagCompte(t.base, uid, {})).toBeNull();
    expect((await getUserSettings(t.base, uid))["rag_quota"]).toBeUndefined();
    await definirQuotaRagCompte(t.base, uid, { storage_mb: 10 });
    expect(await definirQuotaRagCompte(t.base, uid, null)).toBeNull();
    expect((await quotasRag(t.base, uid)).storage_mb).toBe(2048);
  });

  it("surcharge abîmée en base : clés invalides ignorées", async () => {
    await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
      JSON.stringify({ rag_quota: { storage_mb: "9", collections: 2, file_mb: -4 } }),
      uid,
    ]);
    expect(await quotasRag(t.base, uid)).toMatchObject({ storage_mb: 2048, collections: 2, file_mb: 200 });
    expect(surchargeQuotaRag({ rag_quota: [1] })).toBeNull();
    expect(surchargeQuotaRag({})).toBeNull();
  });
});
