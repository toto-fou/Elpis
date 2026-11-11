// SPDX-License-Identifier: MIT
/** apps/core/test/moteur-environnement.ts — à importer en premier : variables lues au chargement du moteur remises à défaut, cache des catégories hors du dépôt, temporaire supprimé en fin de fichier (et de run : il vit sous VITEST_ELPIS_TMP). */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

export const DOSSIER_MOTEUR = realpathSync(
  mkdtempSync(path.join(process.env["VITEST_ELPIS_TMP"] || tmpdir(), "elpis-moteur-test-")),
);
afterAll(() => rmSync(DOSSIER_MOTEUR, { recursive: true, force: true }));

export const ENV_MOTEUR = [
  "LLAMA_FORCE_IDLE_SLOT",
  "LLAMA_PIN_SLOT_BY_CHAT",
  "LLAMA_CACHE_PROMPT",
  "LLAMA_CACHE_REUSE_TOKENS",
  "LLAMA_GEN_CAP_CTX_RATIO",
  "LLAMA_TOOL_PARALLELISM",
  "LLAMA_TOOL_SERIAL_PREFIXES",
  "APP_CONTEXT_CONFIG",
] as const;

for (const nom of ENV_MOTEUR) delete process.env[nom];
process.env["APP_LOG_LEVEL"] = "WARNING";
process.env["TOOL_CATEGORIES_CACHE_PATH"] = path.join(
  DOSSIER_MOTEUR,
  "user_db",
  ".tool_categories_cache.json",
);
