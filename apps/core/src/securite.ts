// SPDX-License-Identifier: MIT
/** apps/core/src/securite.ts — chiffrement des secrets du core : même clé et même précédence que le Python (env, config, fichier) ; clé du coffre « Secrets » (env, /etc/elpis/vault.key, repli à côté de la base). */
import { dirname } from "node:path";

import { bootRaw, config, deepGet } from "@elpis/config";
import {
  brancherJournal,
  configurerChiffrement,
  configurerCoffre,
  encryptionKeyPath,
  reglagesCoffreDeLEnvironnement,
} from "@elpis/securite";
import { brancherJournal as brancherJournalVerrous } from "@elpis/verrous";

import { journal } from "./journal";

/** Source de la clé du coffre : `ELPIS_VAULT_KEY`, `ELPIS_VAULT_KEY_PATH` ou /etc/elpis/vault.key, sinon `.vault.key` du dossier de la base. */
export function configurerCoffreDuCore(env: NodeJS.ProcessEnv = process.env): void {
  configurerCoffre(reglagesCoffreDeLEnvironnement(env, dirname(config.DB_PATH)));
}

/** À appeler au démarrage de main et d'admin, avant toute lecture de secret en base. */
export function configurerSecuriteDuCore(env: NodeJS.ProcessEnv = process.env): void {
  brancherJournal(journal);
  brancherJournalVerrous(journal);
  configurerChiffrement({
    cleEnv: env["APP_ENCRYPTION_KEY"],
    cleConfig: deepGet(bootRaw(), "app.encryption_key", ""),
    fichierCle: encryptionKeyPath(config.DB_PATH),
  });
  configurerCoffreDuCore(env);
}
