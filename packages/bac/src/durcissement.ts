// SPDX-License-Identifier: MIT
/** packages/bac/src/durcissement.ts — durcissement des conteneurs des comptes : PATH des étapes root et du compte, entrée root de l'hôte, profil filtré. */
import type { ProfilReseau } from "./profils";

/** Version des options de `docker run` qui touchent à la sécurité (étiquette `elpis.spec`) ; la changer recrée les conteneurs. */
export const RUN_SPEC = "9";

/** PATH des étapes root (démarrage, entretien de l'hôte) : dossiers du système seuls, jamais ceux de `/work`. */
export const PATH_SYSTEME = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** PATH des entrées du compte (commandes, agent, navigateur, terminal) : ses dossiers de `/work` d'abord. */
export const PATH_COMPTE = `/work/.python-user/bin:/work/.local/bin:/work/.npm-global/bin:${PATH_SYSTEME}`;
/** Options `docker exec` d'une étape root de l'hôte : PATH du système, dossier courant hors de `/work`. */
export const ENTREE_ROOT: readonly string[] = ["-u", "0:0", "-e", `PATH=${PATH_SYSTEME}`, "-w", "/"];

/** Profil dont le réseau est filtré dans le conteneur : le compte n'y devient jamais root. */
export function profilFiltre(profil: Pick<ProfilReseau, "mode">): boolean {
  return profil.mode === "allowlist_ip";
}

/** Gabarit `docker inspect` lu par `lireEntree` : privilégié, capacités ajoutées, options de sécurité, une valeur JSON par ligne. */
export const FORMAT_ENTREE =
  "{{json .HostConfig.Privileged}}\n{{json .HostConfig.CapAdd}}\n{{json .HostConfig.SecurityOpt}}";

/** `uid:gid` numérique d'un compte ordinaire (UID non nul). */
const UID_COMPTE = /^0*[1-9][0-9]*:[0-9]+$/u;

/** Ce que l'inspection dit du conteneur : il peut toucher à son réseau (`reseau`), ses processus ne gagnent aucun privilège (`sansGain`) ; `null` si elle est illisible. */
export function lireEntree(inspection: string): { reseau: boolean; sansGain: boolean } | null {
  const lignes = inspection.trim().split("\n");
  if (lignes.length !== 3) return null;
  let valeurs: unknown[];
  try {
    valeurs = lignes.map((l) => JSON.parse(l) as unknown);
  } catch {
    return null;
  }
  const [privilegie, capacites, options] = valeurs;
  if (typeof privilegie !== "boolean") return null;
  const liste = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const reseau = privilegie || liste(capacites).some((c) => /^(?:CAP_)?(?:NET_ADMIN|ALL)$/iu.test(c));
  const dernier = liste(options)
    .filter((o) => /^no-new-privileges/iu.test(o))
    .at(-1);
  return { reseau, sansGain: dernier !== undefined && /^no-new-privileges(?:[:=]true)?$/iu.test(dernier) };
}

/** Entrée permise dans le conteneur inspecté : s'il peut toucher à son réseau, `no-new-privileges` et, pour une entrée du compte, un `exec_user` numérique non root (`null` : étape root de l'hôte). */
export function entreePermise(inspection: string, execUser: string | null): boolean {
  const e = lireEntree(inspection);
  if (e === null) return false;
  if (!e.reseau) return true;
  return e.sansGain && (execUser === null || UID_COMPTE.test(execUser));
}
