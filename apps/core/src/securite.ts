// SPDX-License-Identifier: MIT
/** apps/core/src/securite.ts — chiffrement des secrets du core : même clé et même précédence que le Python (env, config, fichier). */
import { bootRaw, config, deepGet } from "@elpis/config";
import { brancherJournal, configurerChiffrement, encryptionKeyPath } from "@elpis/securite";
import { brancherJournal as brancherJournalVerrous } from "@elpis/verrous";

import { journal } from "./journal";

/** À appeler au démarrage de main et d'admin, avant toute lecture de secret en base. */
export function configurerSecuriteDuCore(env: NodeJS.ProcessEnv = process.env): void {
  brancherJournal(journal);
  brancherJournalVerrous(journal);
  configurerChiffrement({
    cleEnv: env["APP_ENCRYPTION_KEY"],
    cleConfig: deepGet(bootRaw(), "app.encryption_key", ""),
    fichierCle: encryptionKeyPath(config.DB_PATH),
  });
}
