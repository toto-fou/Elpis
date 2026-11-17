// SPDX-License-Identifier: MIT
/** packages/bac/src/durcissement.ts — durcissement des conteneurs des comptes : capacités, réseau Docker dédié sans trafic entre bacs, refus des options `docker run` qui défont l'isolation. */
import { config, pyPath } from "@elpis/config";

/** Capacités du conteneur quand `sudo` est permis : celles qu'attend un root « complet » dans son bac. */
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
/** Capacités du conteneur durci : les seules dont le root de l'entrypoint et des `docker exec -u 0:0` de l'hôte se servent (chown de /work, setpriv, pkill). */
export const CAPABILITIES_DURCIES: readonly string[] = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "SETUID",
  "SETGID",
  "SETPCAP",
  "KILL",
];

/** Réseau Docker des bacs en mode ouvert ou liste blanche : pont dédié, trafic entre conteneurs coupé (ICC). */
export const RESEAU_BACS = "elpis-sandbox";
/** Nom de l'interface du pont sur l'hôte, stable pour les règles `DOCKER-USER` de l'administrateur. */
export const PONT_BACS = "elpis-sbx0";

/** argv de `docker network create` du réseau des bacs. */
export function argvCreationReseau(): string[] {
  return [
    "network",
    "create",
    "--driver",
    "bridge",
    "--label",
    "elpis.role=sandbox",
    "-o",
    "com.docker.network.bridge.enable_icc=false",
    "-o",
    `com.docker.network.bridge.name=${PONT_BACS}`,
    RESEAU_BACS,
  ];
}

/** Options qui donnent au conteneur des droits sur l'hôte ou sur les autres bacs. */
const OPTIONS_INTERDITES = new Set([
  "--privileged",
  "--cap-add",
  "--security-opt",
  "--pid",
  "--ipc",
  "--uts",
  "--userns",
  "--cgroupns",
  "--cgroup-parent",
  "--network",
  "--net",
  "--device",
  "--device-cgroup-rule",
  "--gpus",
  "--group-add",
  "--user",
  "-u",
  "--volumes-from",
  "--runtime",
  "--oom-kill-disable",
]);
const OPTIONS_BOOLEENNES = new Set(["--privileged", "--oom-kill-disable"]);
const OPTIONS_MONTAGE = new Set(["-v", "--volume", "--mount"]);
/** Sources de montage qui exposent l'hôte (démon Docker, noyau, comptes, secrets). */
const SOURCES_INTERDITES = [
  "/etc",
  "/root",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var/run",
  "/var/lib/docker",
  "/var/lib/containerd",
  "/var/lib/elpis",
  "/usr",
  "/home",
];

function sous(chemin: string, racine: string): boolean {
  return chemin === racine || chemin.startsWith(racine.endsWith("/") ? racine : `${racine}/`);
}

/** Source d'un `-v src:dst[:opts]` ou d'un `--mount type=…,source=…`. */
function sourceMontage(option: string, valeur: string): string {
  if (option !== "--mount") return valeur.split(":", 1)[0] ?? "";
  for (const champ of valeur.split(",")) {
    const [cle = "", v = ""] = champ.split("=", 2);
    if (cle === "source" || cle === "src") return v;
  }
  return "";
}

/** Motif de refus d'une source de montage, `null` si elle est admise (volume nommé, dossier hors zones sensibles). */
function montageRefuse(source: string): string | null {
  if (!source.startsWith("/")) return null;
  const p = pyPath(source);
  if (p === "/" || /docker\.sock|containerd\.sock|podman\.sock/u.test(p)) return "socket ou racine de l'hôte";
  if (SOURCES_INTERDITES.some((r) => sous(p, r))) return "dossier système de l'hôte";
  for (const racine of [config.PROJECT_ROOT, config.SANDBOX_DIR]) {
    if (racine && (sous(p, pyPath(racine)) || sous(pyPath(racine), p))) return "données d'Elpis";
  }
  return null;
}

/** Options `extra_run_args` refusées, avec leur motif : chaque option interdite (et sa valeur détachée) ou montage sensible. */
export function argsRunRefuses(args: readonly string[]): { gardes: string[]; refus: string[] } {
  const gardes: string[] = [];
  const refus: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = (args[i] ?? "").trim();
    let nom = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    let valeur: string | null = a.includes("=") ? a.slice(a.indexOf("=") + 1) : null;
    if (/^-[vu][^-=]/u.test(a)) {
      nom = a.slice(0, 2);
      valeur = a.slice(2);
    }
    const prendValeur = OPTIONS_INTERDITES.has(nom) || OPTIONS_MONTAGE.has(nom);
    let detachee: string | null = null;
    if (prendValeur && valeur === null && !OPTIONS_BOOLEENNES.has(nom)) {
      const suivant = args[i + 1];
      if (suivant !== undefined && !suivant.trim().startsWith("-")) {
        detachee = suivant.trim();
        valeur = detachee;
        i++;
      }
    }
    const brut = detachee === null ? a : `${a} ${detachee}`;
    if (OPTIONS_INTERDITES.has(nom)) {
      refus.push(`${brut} (isolation du bac)`);
      continue;
    }
    if (OPTIONS_MONTAGE.has(nom)) {
      const motif = montageRefuse(sourceMontage(nom, valeur ?? ""));
      if (motif !== null) {
        refus.push(`${brut} (${motif})`);
        continue;
      }
    }
    gardes.push(a);
    if (detachee !== null) gardes.push(detachee);
  }
  return { gardes, refus };
}
