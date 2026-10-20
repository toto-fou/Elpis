// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/suppression.ts — suppression complète d'un compte et de ce qui lui appartient en base (users.delete_user_full). */
import { supprimerJetonsCompte, supprimerOauthCompte } from "@elpis/auth";
import { estTableAbsente } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";

import { deleteUserDir } from "../images/magasin";
import { deletePrincipalRows } from "../llm/acces-moteurs";
import { invaliderAccesRag, purgerCompteRag } from "../rag/acces";
import { nettoyerRagCompte } from "../rag/nettoyage";
import type { CollectionPartieRag } from "../rag/nettoyage";

/** Point de sauvegarde dont l'échec « table absente » (base antérieure à la migration) est avalé. */
async function toleree(base: Base, f: (x: Executeur) => Promise<unknown>): Promise<void> {
  try {
    await base.transaction(f);
  } catch (e) {
    if (!estTableAbsente(e)) throw e;
  }
}

/** `delete_user_full` : conversations, prompts, groupes, accès aux moteurs, jetons, OAuth, images et RAG dans une transaction, puis les fichiers. */
export async function deleteUserFull(base: Base, uid: number): Promise<boolean> {
  let rag: CollectionPartieRag[] = [];
  const supprime = await base.ecriture(async (x) => {
    await x.run("DELETE FROM chats WHERE user_id=?", [uid]);
    await x.run("DELETE FROM saved_prompts WHERE user_id=?", [uid]);
    await x.run("DELETE FROM shared_prompts WHERE to_user_id=? OR from_user_id=?", [uid, uid]);
    await x.run("DELETE FROM user_groups WHERE user_id=?", [uid]);
    await deletePrincipalRows(x, "user", uid, base);
    await toleree(base, (tx) => supprimerJetonsCompte(tx, uid));
    await toleree(base, (tx) => supprimerOauthCompte(tx, uid));
    await toleree(base, (tx) => tx.run("DELETE FROM generated_images WHERE user_id=?", [uid]));
    await toleree(base, async (tx) => {
      rag = await purgerCompteRag(tx, uid);
    });
    return (await x.run("DELETE FROM users WHERE id=?", [uid])).changes > 0;
  });
  if (!supprime) return false;
  invaliderAccesRag(base);
  await deleteUserDir(uid);
  await nettoyerRagCompte(uid, rag);
  return true;
}
