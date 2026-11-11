// SPDX-License-Identifier: MIT
/** packages/mcp/test/invalidation.test.ts — registre de rappels d'invalidation : réglages d'un compte (ciblée, sur les configs résolues, secret compris) et manifeste (recyclage). */
import "./environnement";

import { describe, expect, it, vi } from "vitest";

import {
  brancherInvalidationPool,
  invaliderMcp,
  invaliderServeursPerso,
  makeKey,
  marquerConfiance,
  personalToConfig,
  surInvalidationMcp,
} from "../src";
import type { ConfigMcp, PoolMcp } from "../src";
import { capturerJournal } from "./aides";

const journal = capturerJournal();

function fauxPool(): { pool: PoolMcp; invalides: string[]; resets: unknown[] } {
  const invalides: string[] = [];
  const resets: unknown[] = [];
  const pool = {
    invalidate: vi.fn(async (cfg: ConfigMcp) => {
      invalides.push(makeKey(cfg));
    }),
    reset: vi.fn(async (o?: unknown) => {
      resets.push(o ?? null);
    }),
  } as unknown as PoolMcp;
  return { pool, invalides, resets };
}

const cfgAdmin = (srv: unknown, auth = ""): Promise<ConfigMcp> =>
  personalToConfig(srv, { allowStdio: true, secrets: { auth, headers: [], env: [] } });
const cfgs = (liste: unknown[]): Promise<ConfigMcp[]> => Promise.all(liste.map((s) => cfgAdmin(s)));

/** Clés d'un serveur perso : de confiance (admin) et gardée (non-admin). */
async function cles(srv: unknown): Promise<string[]> {
  const cfg = await cfgAdmin(srv);
  return [makeKey(cfg), makeKey({ ...cfg })];
}

const A = {
  id: "a",
  name: "A",
  type: "http",
  url: "https://a/mcp",
  auth_mode: "bearer",
  secret_id: 4,
};
const B = { id: "b", name: "B", type: "sse", url: "https://b/sse" };

describe("rappels d'invalidation", () => {
  it("diffusés à chaque abonné ; la panne d'un rappel est journalisée, jamais levée ; désabonnement", async () => {
    const recus: string[] = [];
    const off1 = surInvalidationMcp((e) => {
      recus.push(`1:${e.type}`);
    });
    const off2 = surInvalidationMcp(() => {
      throw new Error("rappel en panne");
    });
    const off3 = surInvalidationMcp(async (e) => {
      recus.push(`3:${e.type}`);
    });
    await invaliderMcp({ type: "manifeste" });
    expect(recus).toEqual(["1:manifeste", "3:manifeste"]);
    expect(journal.some((l) => l.message === "Erreur invalidation pool: rappel en panne")).toBe(true);
    off1();
    off2();
    off3();
    await invaliderMcp({ type: "manifeste" });
    expect(recus).toHaveLength(2);
  });
});

describe("serveurs perso modifiés", () => {
  it("liste inchangée (à l'ordre des clés près) : rien n'est touché", async () => {
    const { pool, invalides, resets } = fauxPool();
    await invaliderServeursPerso(pool, [A, B], [{ ...B }, { ...A }].reverse());
    await invaliderServeursPerso(pool, [A], [Object.fromEntries(Object.entries(A).reverse())]);
    expect(invalides).toEqual([]);
    expect(resets).toEqual([]);
  });

  it("serveur modifié : ancienne et nouvelle clé invalidées, les autres connexions gardées", async () => {
    const { pool, invalides, resets } = fauxPool();
    const A2 = { ...A, url: "https://a2/mcp" };
    await invaliderServeursPerso(pool, await cfgs([A, B]), await cfgs([A2, B]));
    const attendues = [...(await cles(A)), ...(await cles(A2))];
    expect(new Set(attendues).size).toBe(4);
    expect(invalides).toEqual(attendues);
    expect(resets).toEqual([]);
    expect(
      journal.some((l) => l.message.startsWith("1 serveur(s) MCP modifié(s) → 2 clé(s) invalidée(s)")),
    ).toBe(true);
  });

  it("serveur retiré ou ajouté : sa seule clé ; entrée sans id → recyclage large (intégrés gardés)", async () => {
    const { pool, invalides, resets } = fauxPool();
    await invaliderServeursPerso(pool, await cfgs([A, B]), await cfgs([A]));
    expect(invalides).toEqual(await cles(B));
    await invaliderServeursPerso(
      pool,
      await cfgs([A]),
      await cfgs([A, { name: "sans id", type: "http", url: "https://x/mcp" }]),
    );
    expect(resets).toEqual([null]);
  });

  it("secret seul changé (entrée identique) : ancienne et nouvelle clé invalidées", async () => {
    const { pool, invalides } = fauxPool();
    const avant = await cfgAdmin(A, "v1");
    const apres = await cfgAdmin(A, "v2");
    await invaliderServeursPerso(pool, [avant], [apres]);
    expect(new Set(invalides).size).toBe(4);
    expect(invalides).toEqual([makeKey(avant), makeKey({ ...avant }), makeKey(apres), makeKey({ ...apres })]);
  });
});

describe("pool abonné", () => {
  it("réglages → invalidation ciblée ; manifeste → recyclage complet, pool toujours utilisable", async () => {
    const { pool, invalides, resets } = fauxPool();
    const off = brancherInvalidationPool(pool);
    await invaliderMcp({ type: "reglages", avant: await cfgs([B]), apres: [] });
    expect(invalides).toEqual(await cles(B));
    await invaliderMcp({ type: "manifeste" });
    expect(resets).toEqual([{ keepPersistent: false }]);
    off();
  });

  it("serveur partagé écrit : sa connexion d'avant fermée, rien à la création", async () => {
    const { pool, invalides, resets } = fauxPool();
    const off = brancherInvalidationPool(pool);
    const avant = {
      id: "shared:3",
      name: "S",
      type: "http",
      url: "https://s/mcp",
      authorization: "Bearer j",
    };
    await invaliderMcp({ type: "partage", avant: null });
    expect(invalides).toEqual([]);
    await invaliderMcp({ type: "partage", avant });
    expect(invalides).toEqual([makeKey(avant), makeKey(marquerConfiance({ ...avant }))]);
    expect(resets).toEqual([]);
    off();
  });
});
