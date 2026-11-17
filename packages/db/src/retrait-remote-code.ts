// SPDX-License-Identifier: MIT
/** packages/db/src/retrait-remote-code.ts — migration 0031_remove_remote_code : tables de Remote code supprimées, jetons `opencode` retirés de `tool_tokens` (la table et les autres genres restent). */
import type { Executeur } from "./base";
import type { Migration } from "./migration";
import { hasTable } from "./schema";

/** Tables propres à Remote code : sessions et leur transcript, postes, appairages, commandes, et l'ancienne table des jetons en clair. */
export const TABLES_REMOTE_CODE: readonly string[] = [
  "code_clients",
  "code_commands",
  "code_messages",
  "code_meta",
  "code_notes",
  "code_pairings",
  "code_parts",
  "code_permissions",
  "code_questions",
  "code_remote_tokens",
  "code_sessions",
];

/** 0031 : chaque table supprimée si elle existe (ses index avec elle), puis les jetons `opencode` ; une base neuve la reçoit tamponnée, sans rien à supprimer. */
export const MIGRATION_RETRAIT_REMOTE_CODE: Migration = {
  name: "0031_remove_remote_code",
  tables: [],
  async migrer(x: Executeur) {
    let tables = 0;
    for (const t of TABLES_REMOTE_CODE) {
      if (!(await hasTable(x, t))) continue;
      await x.run(`DROP TABLE IF EXISTS ${t}`);
      tables++;
    }
    const jetons = (await x.run("DELETE FROM tool_tokens WHERE kind = 'opencode'")).changes;
    return {
      infos: tables || jetons ? [`${tables} table(s) supprimée(s), ${jetons} jeton(s) retiré(s)`] : [],
    };
  },
};
