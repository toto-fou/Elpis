// SPDX-License-Identifier: MIT
/** packages/bac/src/privdrop.ts — retrait de `net_admin` du bounding set de chaque `docker exec` (executors/_privdrop.py) : entrée en root, `setpriv`, puis l'UID cible ; verdict sondé par conteneur. */
import { journalDe } from "@elpis/commun";

/** `uid:gid` numérique ou nommé ; `$` de Python : un saut de ligne final est toléré. */
const EXEC_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*\n?$/u;

const sondes = new Map<string, boolean>();

function cle(conteneur: string, execUser: string): string {
  return `${conteneur}\0${execUser}`;
}

/** `privdrop_argv` : préfixe `setpriv` (mêmes options que l'entrypoint de l'image), ou `null` si `exec_user` est inattendu. */
export function privdropArgv(execUser: string): string[] | null {
  if (!execUser || !EXEC_USER_RE.test(execUser)) return null;
  const i = execUser.indexOf(":");
  return [
    "setpriv",
    `--reuid=${execUser.slice(0, i)}`,
    `--regid=${execUser.slice(i + 1)}`,
    "--init-groups",
    "--bounding-set=-net_admin",
    "--",
  ];
}

/** `probe_argv` : argv docker de la sonde de la chaîne complète dans ce conteneur. */
export function probeArgv(conteneur: string, execUser: string): string[] | null {
  const prefixe = privdropArgv(execUser);
  if (prefixe === null) return null;
  return ["exec", "--user", "0:0", conteneur, ...prefixe, "true"];
}

/** Verdict connu, ou `null` s'il faut sonder. */
export function cached(conteneur: string, execUser: string): boolean | null {
  return sondes.get(cle(conteneur, execUser)) ?? null;
}

export function remember(conteneur: string, execUser: string, ok: boolean): void {
  sondes.set(cle(conteneur, execUser), ok);
  if (!ok)
    journalDe("sandbox").warn(
      `[sandbox] privdrop indisponible sur ${conteneur} (exec_user=${execUser}) : ` +
        "`setpriv --bounding-set=-net_admin` a échoué — exec en mode historique, net_admin reste dans le bounding set des exec.",
    );
}

/** Verdicts d'un conteneur oubliés (arrêt, destruction) : le suivant portera peut-être une autre image. */
export function forget(conteneur: string): void {
  for (const k of [...sondes.keys()]) if (k.startsWith(`${conteneur}\0`)) sondes.delete(k);
}

/** Pour les tests : tous les verdicts oubliés. */
export function oublierSondes(): void {
  sondes.clear();
}

/** `resolve` : (`--user` de docker, préfixe) d'après le cache seul ; verdict inconnu ou négatif : forme historique. */
export function resolve(conteneur: string, execUser: string): [string, string[]] {
  const prefixe = privdropArgv(execUser);
  if (prefixe !== null && cached(conteneur, execUser)) return ["0:0", prefixe];
  return [execUser, []];
}
