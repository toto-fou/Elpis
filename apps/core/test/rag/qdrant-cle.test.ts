// SPDX-License-Identifier: MIT
/** apps/core/test/rag/qdrant-cle.test.ts — la clé d'API de Qdrant passe par la seule fabrique `clientQdrant` : en-tête présent ou absent, jamais vers une adresse saisie, aucun autre `new ClientQdrant`. */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { clientQdrant } from "../../src/rag/qdrant";

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Fetch factice : rend 200 et note les en-têtes de chaque requête. */
function faux(): { fetch: typeof fetch; entetes: Record<string, string>[] } {
  const entetes: Record<string, string>[] = [];
  const f = (async (_url: unknown, init?: RequestInit) => {
    entetes.push({ ...(init?.headers as Record<string, string>) });
    return new Response(JSON.stringify({ version: "1.16.3" }), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, entetes };
}

describe("fabrique clientQdrant", () => {
  it("sans clé : pas d'en-tête api-key", async () => {
    const { fetch: f, entetes } = faux();
    await clientQdrant(undefined, { fetch: f }).sante();
    expect(entetes.length).toBeGreaterThan(0);
    expect(entetes.every((h) => !("api-key" in h))).toBe(true);
  });

  it("QDRANT_API_KEY : en-tête envoyé à l'adresse configurée", async () => {
    vi.stubEnv("QDRANT_API_KEY", "cle-de-test");
    const { fetch: f, entetes } = faux();
    await clientQdrant(undefined, { fetch: f }).sante();
    expect(entetes.every((h) => h["api-key"] === "cle-de-test")).toBe(true);
  });

  it("QDRANT_API_KEY_FILE : clé lue du fichier", async () => {
    const fichier = path.join(mkdtempSync(path.join(tmpdir(), "elpis-qdrant-")), "qdrant.key");
    writeFileSync(fichier, "cle-fichier\n");
    vi.stubEnv("QDRANT_API_KEY_FILE", fichier);
    const { fetch: f, entetes } = faux();
    await clientQdrant(undefined, { fetch: f }).sante();
    expect(entetes.every((h) => h["api-key"] === "cle-fichier")).toBe(true);
  });

  it("une adresse saisie (essai de la console) ne reçoit jamais la clé", async () => {
    vi.stubEnv("QDRANT_API_KEY", "cle-de-test");
    const { fetch: f, entetes } = faux();
    await clientQdrant("http://autre.exemple:6333", { fetch: f }).sante();
    expect(entetes.every((h) => !("api-key" in h))).toBe(true);
  });
});

describe("architecture : un seul constructeur", () => {
  it("aucun `new ClientQdrant` dans apps/ hors de la fabrique", () => {
    const base = path.join(RACINE, "apps");
    const fautifs = readdirSync(base, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.includes("node_modules") && !/(^|\/)test\//u.test(f))
      .filter((f) => /new ClientQdrant\(/u.test(readFileSync(path.join(base, f), "utf8")));
    expect(fautifs).toEqual(["core/src/rag/qdrant.ts"]);
  });
});
