// SPDX-License-Identifier: MIT
/** apps/toolhost/src/base-hote.ts — base de l'hôte (`init_db` de toolhost/app.py) : `db_path` de toolhost.json, sinon la base de l'app ; schéma sous le verrou partagé avec main, garde de génération, WAL compacté. */
import type { FabriqueJournal } from "@elpis/commun";
import { creerGardeGeneration, demarrerBase, walCheckpoint } from "@elpis/db";
import type { Base } from "@elpis/db";

let courante: Base | null = null;

/** Base de l'hôte ouverte au démarrage (mémoire AX, sessions…), `null` si son ouverture a échoué. */
export function baseHote(): Base | null {
  return courante;
}

/** `init_db` : schéma et migrations sous `.init_db.lock` (même verrou que main), emprunts refusés après une bascule de base, WAL compacté hors de `.startup_cleanup.lock` (laissé à la purge de main) ; échec : avertissement et hôte sans base, comme le Python qui démarre quand même. */
export async function ouvrirBaseHote(journal: FabriqueJournal): Promise<Base | null> {
  await fermerBaseHote();
  try {
    const { base } = await demarrerBase({
      garde: creerGardeGeneration({ journal }),
      apres: walCheckpoint,
      journal,
    });
    courante = base;
  } catch (e) {
    journal("toolhost").warn(`init_db : ${e instanceof Error ? e.message : String(e)}`);
  }
  return courante;
}

export async function fermerBaseHote(): Promise<void> {
  const b = courante;
  courante = null;
  await b?.fermer();
}
