// SPDX-License-Identifier: MIT
/** packages/rag/test/uuid.test.ts — UUID v5 (vecteur de référence de la RFC) et identifiants de points stables. */
import { describe, expect, it } from "vitest";

import { ESPACE_POINTS_RAG, idPoint, uuidV5 } from "../src/uuid";

const ESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuidV5", () => {
  it("donne le vecteur de référence de Python (uuid5(NAMESPACE_DNS, 'python.org'))", () => {
    expect(uuidV5("python.org", ESPACE_DNS)).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("refuse un espace de noms qui n'est pas un UUID", () => {
    expect(() => uuidV5("x", "pas-un-uuid")).toThrow(TypeError);
  });
});

describe("idPoint", () => {
  it("est déterministe, versionné 5 et distinct selon le document et l'indice", () => {
    const a = idPoint("doc-1", 0);
    expect(a).toBe(idPoint("doc-1", 0));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).toBe(uuidV5("doc-1:0", ESPACE_POINTS_RAG));
    expect(
      new Set([a, idPoint("doc-1", 1), idPoint("doc-2", 0), idPoint("doc-10", 0), idPoint("doc-1", 10)]).size,
    ).toBe(5);
  });
});
