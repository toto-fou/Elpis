// SPDX-License-Identifier: MIT
/** packages/bac/src/durcissement.ts — durcissement des conteneurs des comptes : PATH des étapes root et du compte, entrée root de l'hôte, profil filtré. */
import type { ProfilReseau } from "./profils";

/** Version des options de `docker run` qui touchent à la sécurité (étiquette `elpis.spec`) ; la changer recrée les conteneurs. */
export const RUN_SPEC = "11";

/** PATH des étapes root (démarrage, entretien de l'hôte) : dossiers du système seuls, jamais ceux de `/work`. */
export const PATH_SYSTEME = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** PATH des entrées du compte (commandes, agent, navigateur, terminal) : ses dossiers de `/work` d'abord. */
export const PATH_COMPTE = `/work/.python-user/bin:/work/.local/bin:/work/.npm-global/bin:${PATH_SYSTEME}`;
/** Préfixe des paquets npm globaux du compte : `npm install -g` y écrit sans root. */
export const PREFIXE_NPM = "/work/.npm-global";
/** Options `docker exec` d'une étape root de l'hôte : PATH du système, dossier courant hors de `/work`. */
export const ENTREE_ROOT: readonly string[] = ["-u", "0:0", "-e", `PATH=${PATH_SYSTEME}`, "-w", "/"];

/** Capacités d'un conteneur où le compte peut devenir root (`--cap-drop ALL` puis celles-ci). */
export const CAPABILITIES_SUDO: readonly string[] = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "SETUID",
  "SETGID",
  "SETPCAP",
  "KILL",
  "AUDIT_WRITE",
  "NET_BIND_SERVICE",
];
/** Capacités d'un conteneur durci : celles des étapes root seules (droits de /work, abandon des privilèges, arrêt des processus). */
export const CAPABILITIES_DURCIES: readonly string[] = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "SETUID",
  "SETGID",
  "SETPCAP",
  "KILL",
];

/** Options d'un conteneur durci : racine en lecture seule, `/tmp` (exécutable, moitié de la mémoire du bac), `/var/tmp` et le dossier personnel de l'image en mémoire. */
export function optionsRacineDurcie(memoryMb: number): string[] {
  const tmp = Math.max(64, Math.floor(memoryMb / 2));
  return [
    "--read-only",
    "--tmpfs",
    `/tmp:rw,exec,nosuid,nodev,size=${tmp}m,mode=1777`,
    "--tmpfs",
    "/var/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--tmpfs",
    "/home/elpis:rw,nosuid,nodev,size=64m,mode=0700,uid=10001,gid=10001",
  ];
}

/** Profil dont le réseau est filtré dans le conteneur : le compte n'y devient jamais root. */
export function profilFiltre(profil: Pick<ProfilReseau, "mode">): boolean {
  return profil.mode === "allowlist_ip";
}

/** Gabarit `docker inspect` lu par `lireEntree` : privilégié, capacités ajoutées, options de sécurité, une valeur JSON par ligne. */
export const FORMAT_ENTREE =
  "{{json .HostConfig.Privileged}}\n{{json .HostConfig.CapAdd}}\n{{json .HostConfig.SecurityOpt}}";

/** `uid:gid` numérique d'un compte ordinaire (UID non nul). */
const UID_COMPTE = /^0*[1-9][0-9]*:[0-9]+$/u;
/** Utilisateur de l'image, celui des comptes par défaut. */
export const UTILISATEUR_IMAGE = "10001:10001";

/** Utilisateur des entrées du compte dans un conteneur durci : `exec_user` s'il est un UID ordinaire, sinon celui de l'image (jamais root). */
export function utilisateurDurci(execUser: string): string {
  return UID_COMPTE.test(execUser) ? execUser : UTILISATEUR_IMAGE;
}

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

/** Entrée permise dans le conteneur inspecté : s'il peut toucher à son réseau ou s'il doit être durci (`durciAttendu`), `no-new-privileges` exigé ; dans un conteneur durci, jamais d'entrée du compte en root (`null` : étape root de l'hôte). */
export function entreePermise(inspection: string, execUser: string | null, durciAttendu = false): boolean {
  const e = lireEntree(inspection);
  if (e === null) return false;
  if (durciAttendu && execUser !== null && !e.sansGain) return false;
  if (e.sansGain && execUser !== null && !UID_COMPTE.test(execUser)) return false;
  if (!e.reseau) return true;
  return e.sansGain && (execUser === null || UID_COMPTE.test(execUser));
}
