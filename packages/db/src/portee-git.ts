// SPDX-License-Identifier: MIT
/** packages/db/src/portee-git.ts — migration 0030_git_account_scope : portée par chemin des comptes git (`path` : tout l'hôte, une organisation ou un dépôt), l'unicité par libellé remplacée par l'unicité par portée. */
import type { Executeur } from "./base";
import type { Migration } from "./migration";

type LigneGit = { id: number; owner_user_id: number; host: string } & Record<string, unknown>;

const cle = (l: Pick<LigneGit, "owner_user_id" | "host">): string => `${Number(l.owner_user_id)}\n${l.host}`;

/** 0030 : par compte Elpis et par hôte, le compte git le plus récemment utilisé garde tout l'hôte (`path = ''`), les autres restent sans portée (`NULL` : inactifs jusqu'à ce qu'on leur en donne une, ils ne servaient déjà pas) ; l'index unique par libellé est retiré. */
export const MIGRATION_PORTEE_GIT: Migration = {
  name: "0030_git_account_scope",
  tables: [],
  async migrer(x: Executeur) {
    const pris = await x.all<LigneGit>("SELECT id, owner_user_id, host FROM git_connectors WHERE path = ''");
    const vus = new Set(pris.map(cle));
    const lignes = await x.all<LigneGit>(
      "SELECT id, owner_user_id, host FROM git_connectors WHERE path IS NULL " +
        "ORDER BY owner_user_id, host, COALESCE(last_used, 0) DESC, created_at DESC, id DESC",
    );
    let sansPortee = 0;
    for (const l of lignes) {
      if (vus.has(cle(l))) {
        sansPortee++;
        continue;
      }
      vus.add(cle(l));
      await x.run("UPDATE git_connectors SET path = '' WHERE id = ?", [l.id]);
    }
    await x.run("DROP INDEX IF EXISTS idx_gitconn_owner_host_label");
    return {
      infos: [`${lignes.length - sansPortee} compte(s) git gardent tout leur hôte`],
      avertissements: sansPortee
        ? [
            `${sansPortee} compte(s) git en double sur leur hôte : sans portée, à préciser dans Paramètres › Secrets › Comptes Git`,
          ]
        : [],
    };
  },
};
