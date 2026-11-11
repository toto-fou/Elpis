// SPDX-License-Identifier: MIT
/** packages/config/test/environnement.ts — à importer en premier : config.json, base et dossiers du singleton dans un temporaire. */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const DOSSIER_TEST = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-config-test-")));

for (const nom of Object.keys(process.env)) {
  if (/^(APP_|LLAMA_|MCP_|LOCAL_MCP_|ELPIS_)/.test(nom)) delete process.env[nom];
}
process.env["APP_CONFIG_PATH"] = path.join(DOSSIER_TEST, "config.json");
process.env["APP_DB_PATH"] = path.join(DOSSIER_TEST, "db", "app.db");
process.env["MCP_SERVERS_DIR"] = path.join(DOSSIER_TEST, "mcp");
process.env["APP_SANDBOX_DIR"] = path.join(DOSSIER_TEST, "sandboxes");
process.env["APP_SKILLS_DIR"] = path.join(DOSSIER_TEST, "skills");
process.env["APP_USER_SKILLS_DIR"] = path.join(DOSSIER_TEST, "user_skills");
