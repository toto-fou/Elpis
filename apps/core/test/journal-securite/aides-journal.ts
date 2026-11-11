// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/aides-journal.ts — journal de sécurité dans un dossier temporaire : lignes relues, texte brut pour chercher les secrets. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureAudit, oublierConfigurationAudit, viderRafalesAudit } from "@elpis/securite";

export interface LigneJournal {
  action: string;
  outcome: string;
  user_id: number | null;
  username: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

export interface JournalDeTest {
  /** Lignes écrites depuis le début, hors marqueurs de l'écrivain. */
  lignes(): LigneJournal[];
  /** Lignes d'une action. */
  de(action: string): LigneJournal[];
  /** Dernière ligne d'une action (échoue si absente). */
  derniere(action: string): LigneJournal;
  /** Texte brut de tous les fichiers du journal. */
  brut(): string;
  fermer(): void;
}

/** Configure l'audit sur un dossier neuf (sans clé HMAC) ; `fermer` oublie la configuration et efface le dossier. */
export function journalDeTest(service = "test"): JournalDeTest {
  const dossier = mkdtempSync(join(tmpdir(), "elpis-catalogue-"));
  oublierConfigurationAudit();
  configureAudit({ service, auditDir: dossier, hmacKeyPath: join(dossier, "sans-cle") });
  const brut = (): string =>
    readdirSync(dossier)
      .sort()
      .map((f) => readFileSync(join(dossier, f), "utf8"))
      .join("");
  const lignes = (): LigneJournal[] => {
    viderRafalesAudit();
    return brut()
      .split("\n")
      .filter((l) => l.startsWith('{"v":'))
      .map((l) => JSON.parse(l) as LigneJournal)
      .filter((l) => !l.action.startsWith("audit.writer."));
  };
  return {
    lignes,
    de: (action) => lignes().filter((l) => l.action === action),
    derniere(action) {
      const l = lignes().filter((x) => x.action === action);
      const derniere = l[l.length - 1];
      if (!derniere)
        throw new Error(
          `aucune ligne ${action} (vues : ${lignes()
            .map((x) => x.action)
            .join(", ")})`,
        );
      return derniere;
    },
    brut,
    fermer() {
      oublierConfigurationAudit();
      rmSync(dossier, { recursive: true, force: true });
    },
  };
}
