// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-codes.test.ts — les codes d'erreur que les routes RAG et celles de la console peuvent rendre sont tous dans les listes des contrats, que l'interface lit. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CODES_ERREUR_ADMIN_RAG, CODES_ERREUR_ROUTES_RAG } from "@elpis/contracts";
import { describe, expect, it } from "vitest";

import { MESSAGES_REFUS_RAG } from "../../src/rag/acces";
import { MESSAGES_REFUS_INDEXATION_RAG } from "../../src/rag/erreurs-indexation";

const SRC = new URL("../../src/", import.meta.url).pathname;

function fichiers(): string[] {
  const rag = readdirSync(join(SRC, "rag")).map((f) => join(SRC, "rag", f));
  const familles = readdirSync(join(SRC, "familles"))
    .filter((f) => /^(?:admin-)?rag.*\.ts$/u.test(f))
    .map((f) => join(SRC, "familles", f));
  return [...rag, ...familles].filter((f) => f.endsWith(".ts"));
}

describe("codes d'erreur des routes RAG", () => {
  it("chaque code écrit dans les routes et les modules RAG est dans CODES_ERREUR_ROUTES_RAG ou CODES_ERREUR_ADMIN_RAG", () => {
    const connus = new Set<string>([...CODES_ERREUR_ROUTES_RAG, ...CODES_ERREUR_ADMIN_RAG]);
    const inconnus: string[] = [];
    let vus = 0;
    for (const f of fichiers()) {
      const texte = readFileSync(f, "utf8");
      for (const motif of [
        /ErreurRouteRag\(\s*\d+,\s*"([a-z_]+)"/gu,
        /corpsErreur\(\s*"([a-z_]+)"/gu,
        /new RefusIndexationRag\(\s*"([a-z_]+)"/gu,
        /new RefusRag\(\s*"([a-z_]+)"/gu,
      ])
        for (const m of texte.matchAll(motif)) {
          vus++;
          if (!connus.has(m[1] as string)) inconnus.push(`${f.slice(SRC.length)} : ${m[1]}`);
        }
    }
    expect(vus).toBeGreaterThan(60);
    expect(inconnus).toEqual([]);
  });

  it("les refus des droits et de l'indexation y sont aussi", () => {
    for (const code of [...Object.keys(MESSAGES_REFUS_RAG), ...Object.keys(MESSAGES_REFUS_INDEXATION_RAG)])
      expect(CODES_ERREUR_ROUTES_RAG, code).toContain(code);
  });
});
