// SPDX-License-Identifier: MIT
/** apps/core/src/skills/miroir-distant.ts — magasin de skills d'un compte poussé vers son hôte d'outils distant (où skill_run_script lit le miroir) : un envoi à la fois par compte, les demandes faites pendant un envoi groupées en un seul envoi suivant du dernier état. */
import { safeSandboxName } from "@elpis/config";
import { current, userIdFor } from "@elpis/securite";

import { journal } from "../journal";
import { pushSkillsMirror } from "../relais/services";

interface FileCompte {
  dossier: string;
  /** Envoi demandé mais pas encore commencé : une nouvelle demande s'y joint. */
  enAttente: Promise<boolean> | null;
}

const files = new Map<number, FileCompte>();
const chaines = new Map<number, Promise<unknown>>();

/** Pousse `dossier` pour le compte `uid` après l'envoi en cours de ce compte ; vrai si l'hôte l'a accepté (faux en local ou en échec). */
export function pousserMiroir(uid: number, dossier: string): Promise<boolean> {
  let f = files.get(uid);
  if (f === undefined) {
    f = { dossier, enAttente: null };
    files.set(uid, f);
  }
  f.dossier = dossier;
  if (f.enAttente !== null) return f.enAttente;
  const file = f;
  const envoi = (chaines.get(uid) ?? Promise.resolve()).then(async () => {
    file.enAttente = null;
    try {
      return await pushSkillsMirror(uid, file.dossier);
    } catch (e) {
      journal("skills").debug(`miroir non poussé : ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  });
  file.enAttente = envoi;
  const fin: Promise<unknown> = envoi.finally(() => {
    if (chaines.get(uid) !== fin) return;
    chaines.delete(uid);
    files.delete(uid);
  });
  chaines.set(uid, fin);
  return envoi;
}

/** Compte du magasin `username` (nom sûr) : identité de l'appel, sinon login reçu, sinon le nom sûr lui-même ; 0 si aucun n'y mène. */
export async function uidDuMagasin(username: string, login: string | null): Promise<number> {
  const sur = safeSandboxName(username);
  const courant = current();
  if (courant !== null && courant.user_id > 0 && safeSandboxName(courant.username) === sur)
    return courant.user_id;
  for (const nom of [login, username]) {
    if (!nom || safeSandboxName(nom) !== sur) continue;
    const uid = await userIdFor(nom);
    if (uid) return uid;
  }
  return 0;
}

/** Après `skill_save` / `skill_add_file` : envoi lancé sans être attendu, pour le compte de l'appel qui possède ce magasin ; jamais d'erreur. */
export function pousserMiroirDuCompte(username: string, dossier: string, login: string | null = null): void {
  void (async () => {
    try {
      const uid = await uidDuMagasin(username, login);
      if (uid) await pousserMiroir(uid, dossier);
    } catch (e) {
      journal("skills").debug(`miroir non poussé : ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}
