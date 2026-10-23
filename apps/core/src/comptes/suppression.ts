// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/suppression.ts — suppression complète d'un compte et de ce qui lui appartient en base (users.delete_user_full). */
import { lstat, unlink } from "node:fs/promises";

import { nomCanonique, supprimerJetonsCompte, supprimerOauthCompte } from "@elpis/auth";
import { pyJoin } from "@elpis/commun";
import { config, safeSandboxName } from "@elpis/config";
import { estTableAbsente } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";
import { supprimerArbreSous } from "@elpis/securite";

import { deleteUserDir } from "../images/magasin";
import { journal } from "../journal";
import { deletePrincipalRows } from "../llm/acces-moteurs";
import { invaliderAccesRag, purgerCompteRag } from "../rag/acces";
import { nettoyerRagCompte } from "../rag/nettoyage";
import type { CollectionPartieRag } from "../rag/nettoyage";
import { LEGACY_MEMORY_SUBDIR, MEMORY_SUBDIR } from "../memoire/portee";

const log = journal("users");

/** Point de sauvegarde dont l'échec « table absente » (base antérieure à la migration) est avalé. */
async function toleree(base: Base, f: (x: Executeur) => Promise<unknown>): Promise<void> {
  try {
    await base.transaction(f);
  } catch (e) {
    if (!estTableAbsente(e)) throw e;
  }
}

/** Dossier supprimé sans suivre de lien ; un lien ou un fichier à sa place est retiré lui-même. */
async function supprimerEntree(chemin: string): Promise<void> {
  try {
    await supprimerArbreSous(chemin);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if ((code === "ELOOP" || code === "ENOTDIR") && !(await lstat(chemin)).isDirectory())
      return unlink(chemin);
    throw e;
  }
}

/** Magasins rangés par nom de compte (skills perso et leur miroir hors /work, mémoire) : purgés, sinon un compte recréé sous ce nom en hériterait. */
async function purgerDossiersDuNom(nom: string): Promise<void> {
  const sur = safeSandboxName(nom);
  const bac = pyJoin(config.SANDBOX_DIR, sur);
  const memoire = pyJoin(config.MEMORY_DIR, sur);
  const entrees = [
    pyJoin(config.USER_SKILLS_DIR, sur),
    pyJoin(bac, "skills"),
    pyJoin(bac, ".skills-mirror.tmp"),
    pyJoin(memoire, MEMORY_SUBDIR),
    pyJoin(memoire, LEGACY_MEMORY_SUBDIR),
  ];
  for (const entree of entrees) {
    try {
      await supprimerEntree(entree);
    } catch (e) {
      log.error({ err: e }, `[users] purge de ${entree} échouée`);
    }
  }
}

/** `delete_user_full` : conversations, prompts, groupes, accès aux moteurs, jetons, OAuth, images, RAG et identifiants de sites dans une transaction, puis les fichiers. */
export async function deleteUserFull(base: Base, uid: number): Promise<boolean> {
  let rag: CollectionPartieRag[] = [];
  let nom = "";
  let partage = false;
  const supprime = await base.ecriture(async (x) => {
    const ligne = await x.get("SELECT username FROM users WHERE id=?", [uid]);
    nom = typeof ligne?.["username"] === "string" ? ligne["username"] : "";
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
    if (nom) await toleree(base, (tx) => tx.run("DELETE FROM ax_credentials WHERE owner=?", [nom]));
    const efface = (await x.run("DELETE FROM users WHERE id=?", [uid])).changes > 0;
    const restants = await x.all<{ username: string | null }>("SELECT username FROM users");
    partage = restants.some((u) => nomCanonique(u.username) === nomCanonique(nom));
    return efface;
  });
  if (!supprime) return false;
  invaliderAccesRag(base);
  await deleteUserDir(uid);
  await nettoyerRagCompte(uid, rag);
  if (nom && !partage) await purgerDossiersDuNom(nom);
  return true;
}
