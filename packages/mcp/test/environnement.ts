// SPDX-License-Identifier: MIT
/** packages/mcp/test/environnement.ts — à importer en premier : config.json, base, jeton et dossiers du singleton dans un temporaire supprimé en fin de fichier (et de run : il vit sous VITEST_ELPIS_TMP). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

export const DOSSIER_TEST = realpathSync(
  mkdtempSync(path.join(process.env["VITEST_ELPIS_TMP"] || tmpdir(), "elpis-mcp-test-")),
);
afterAll(() => rmSync(DOSSIER_TEST, { recursive: true, force: true }));

for (const nom of Object.keys(process.env)) {
  if (/^(APP_|LLAMA_|MCP_|LOCAL_MCP_|ELPIS_|RAG_)/.test(nom)) delete process.env[nom];
}
mkdirSync(path.join(DOSSIER_TEST, "db"), { recursive: true });
writeFileSync(path.join(DOSSIER_TEST, "config.json"), "{}");
process.env["APP_CONFIG_PATH"] = path.join(DOSSIER_TEST, "config.json");
process.env["APP_DB_PATH"] = path.join(DOSSIER_TEST, "db", "app.db");
process.env["MCP_SERVERS_DIR"] = path.join(DOSSIER_TEST, "mcp");
process.env["APP_SANDBOX_DIR"] = path.join(DOSSIER_TEST, "sandboxes");
process.env["APP_SKILLS_DIR"] = path.join(DOSSIER_TEST, "skills");
process.env["APP_USER_SKILLS_DIR"] = path.join(DOSSIER_TEST, "user_skills");
process.env["APP_MCP_MANIFEST"] = path.join(DOSSIER_TEST, "absent", "mcp.json");
