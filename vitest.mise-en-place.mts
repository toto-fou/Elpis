// SPDX-License-Identifier: MIT
/** vitest.mise-en-place.mts — `MCP_SERVERS_DIR` et le dossier des temporaires d'environnement (`VITEST_ELPIS_TMP`) dans le run, supprimés à la fin même si un fichier de test s'arrête avant son nettoyage ; pas de pré-chauffage MCP (`MCP_PREWARM=0`) hors des tests qui le demandent, ni de nettoyage des navigateurs des sous-agents au démarrage (`BROWSER_CHILD_CLEANUP=0`) : un service navigateur réel n'est jamais touché ; journal de sécurité dans le temporaire (`ELPIS_AUDIT_DIR`) ; main injoignable par défaut (`MAIN_INTERNAL_URL`, `MAIN_PUBLIC_URL`) : une instance locale réelle n'est jamais appelée. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export default function miseEnPlace(): () => void {
  const dossier = mkdtempSync(path.join(tmpdir(), "elpis-vitest-mcp-"));
  const temporaires = mkdtempSync(path.join(tmpdir(), "elpis-vitest-tmp-"));
  process.env["MCP_SERVERS_DIR"] = dossier;
  process.env["VITEST_ELPIS_TMP"] = temporaires;
  process.env["MCP_PREWARM"] = "0";
  process.env["BROWSER_CHILD_CLEANUP"] = "0";
  // Journal de sécurité des tests dans le dossier temporaire : jamais celui de l'hôte, ni sa clé de signature.
  process.env["ELPIS_AUDIT_DIR"] = path.join(temporaires, "audit");
  process.env["ELPIS_AUDIT_KEY_PATH"] = path.join(temporaires, "audit.key.absente");
  process.env["MAIN_INTERNAL_URL"] = "http://127.0.0.1:9";
  process.env["MAIN_PUBLIC_URL"] = "http://127.0.0.1:9";
  return () => {
    rmSync(dossier, { recursive: true, force: true });
    rmSync(temporaires, { recursive: true, force: true });
  };
}
