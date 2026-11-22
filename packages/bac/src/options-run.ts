// SPDX-License-Identifier: MIT
/** packages/bac/src/options-run.ts — options `docker run` qu'un administrateur peut ajouter aux bacs (`executors.extra_run_args`) : liste permise, lue sans toucher au disque ; montages en lecture seule sur `/mnt/<nom>`, dont la source est vérifiée sur le disque à la création du conteneur et à l'enregistrement (`verifierMontages`). */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { rstripPy, stripPy } from "@elpis/commun";
import { config, pyPath } from "@elpis/config";

/** Options à valeur admises telles quelles. */
const SIMPLES = new Set([
  "--shm-size",
  "--add-host",
  "--gpus",
  "--cpuset-cpus",
  "--cpu-shares",
  "--hostname",
  "--dns",
  "--dns-search",
  "--dns-option",
  "--storage-opt",
]);
/** Formes courtes et leur option longue. */
const COURTES: Readonly<Record<string, string>> = {
  "-e": "--env",
  "-v": "--volume",
  "-h": "--hostname",
  "-l": "--label",
  "-c": "--cpu-shares",
};
/** Limites `--ulimit` permises : ni fichiers core (fixés par Elpis), ni priorité temps réel (limite de processeur), ni nombre de processus (compté pour tous les bacs ensemble, même UID). */
const ULIMITS = new Set(["nofile", "stack", "memlock"]);
/** Variables que le bac pose lui-même, ou que lisent ses étapes root et leurs bibliothèques (chargeur, iptables, glibc). */
const ENV_RESERVE =
  /^(?:PATH|HOME|ENV|BASH_ENV|LD_\w*|ELPIS_\w*|XTABLES_\w*|IPTABLES_\w*|IP6TABLES_\w*|GCONV_PATH|LOCPATH|NLSPATH|GLIBC_TUNABLES|MALLOC_\w*)$/iu;
/** Étiquettes posées par Elpis : tout l'espace `elpis.`. */
const ETIQUETTE_RESERVEE = /^elpis\./u;
/** Dossiers de l'hôte jamais montés, ni leur contenu ni un dossier qui les contient. */
const SOURCES_INTERDITES = [
  "/etc",
  "/root",
  "/home",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt",
  "/tmp",
  "/snap",
];
/** Seule destination d'un montage : un dossier direct de `/mnt`. */
const DESTINATION = /^\/mnt\/(?!\.\.?$)[A-Za-z0-9._-]+$/u;
/** Source d'un montage : chemin absolu de caractères sûrs (Docker lit `--mount` en CSV : ni virgule, ni guillemet, ni `=`). */
const SOURCE_SURE = /^\/[A-Za-z0-9._@+/-]*$/u;
/** Montage tel que le rend `argsRunPermis`, relu par `verifierMontages`. */
const MONTAGE_RENDU =
  /^--mount=type=bind,source=(\/[A-Za-z0-9._@+/-]*),target=(\/mnt\/[A-Za-z0-9._-]+),readonly$/u;
/** Un argument : une ligne, 200 caractères au plus ; 32 options au plus. */
const LONGUEUR_MAX = 200;
const OPTIONS_MAX = 32;
/** Délai de chaque lecture du disque pendant la vérification d'une source (un partage réseau muet ne retient pas la création). */
export const reglagesSources = { delaiMs: 5000 };

function sous(chemin: string, racine: string): boolean {
  return chemin === racine || chemin.startsWith(racine.endsWith("/") ? racine : `${racine}/`);
}

/** Motif de refus d'un chemin de source par sa seule forme (sans toucher au disque), `null` s'il est admissible. */
function motifChemin(chemin: string): string | null {
  if (!SOURCE_SURE.test(chemin) || chemin.split("/").some((x) => x === "." || x === ".."))
    return "source : chemin absolu fait de lettres, chiffres et . _ @ + - seulement";
  const net = rstripPy(path.posix.normalize(chemin), "/") || "/";
  if (net === "/") return "racine de l'hôte";
  if (SOURCES_INTERDITES.some((r) => sous(net, r) || sous(r, net))) return "dossier système de l'hôte";
  return null;
}

/** Montage permis rendu sous la forme lue par `verifierMontages` (`--mount=type=bind,…,readonly`) ; sinon le motif. */
function montage(
  source: string,
  destination: string,
  lectureSeule: boolean,
): { arg: string } | { motif: string } {
  if (!lectureSeule) return { motif: "montage en lecture seule seulement" };
  if (!DESTINATION.test(destination)) return { motif: "destination : /mnt/<nom> seulement" };
  const m = motifChemin(source);
  if (m !== null) return { motif: m };
  const net = rstripPy(path.posix.normalize(source), "/");
  return { arg: `--mount=type=bind,source=${net},target=${destination},readonly` };
}

/** Champs d'un `--mount` : sans guillemets (lecture CSV de Docker), chacun une seule fois sous tous ses alias. */
function champsMount(valeur: string): Map<string, string> | null {
  if (/["']/u.test(valeur)) return null;
  const alias: Readonly<Record<string, string>> = {
    type: "type",
    source: "source",
    src: "source",
    destination: "target",
    dst: "target",
    target: "target",
    readonly: "readonly",
    ro: "readonly",
  };
  const champs = new Map<string, string>();
  for (const brut of valeur.split(",")) {
    const egal = brut.indexOf("=");
    const cle = alias[(egal < 0 ? brut : brut.slice(0, egal)).trim().toLowerCase()];
    if (cle === undefined || champs.has(cle)) return null;
    champs.set(cle, egal < 0 ? "" : brut.slice(egal + 1));
  }
  return champs;
}

/** Option admise (forme rendue à Docker) ou motif de refus. */
function examiner(option: string, valeur: string): { args: string[] } | { motif: string } {
  if (option === "--ulimit")
    return ULIMITS.has(stripPy(valeur.split("=", 1)[0] ?? "").toLowerCase())
      ? { args: [`--ulimit=${valeur}`] }
      : { motif: "limite non permise (nofile, stack ou memlock)" };
  if (SIMPLES.has(option)) return valeur ? { args: [`${option}=${valeur}`] } : { motif: "valeur manquante" };
  if (option === "--env") {
    const nom = valeur.split("=", 1)[0] ?? "";
    return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(nom) && valeur.includes("=") && !ENV_RESERVE.test(nom)
      ? { args: [`--env=${valeur}`] }
      : { motif: "variable réservée ou mal formée" };
  }
  if (option === "--label")
    return valeur && !ETIQUETTE_RESERVEE.test(valeur)
      ? { args: [`--label=${valeur}`] }
      : { motif: "étiquette réservée" };
  if (option === "--volume") {
    const parts = valeur.split(":");
    if (parts.length !== 3) return { motif: "montage : source:/mnt/<nom>:ro attendu" };
    const [source = "", destination = "", mode = ""] = parts;
    const m = montage(source, destination, mode === "ro");
    return "arg" in m ? { args: [m.arg] } : m;
  }
  if (option === "--mount") {
    const champs = champsMount(valeur);
    if (champs === null || champs.get("type") !== "bind")
      return { motif: "montage : type=bind sans champ répété" };
    const ro = champs.get("readonly");
    const m = montage(
      champs.get("source") ?? "",
      champs.get("target") ?? "",
      ro !== undefined && ["", "true", "1"].includes(ro.toLowerCase()),
    );
    return "arg" in m ? { args: [m.arg] } : m;
  }
  return { motif: "option non permise" };
}

/** Texte d'un refus : jamais la valeur d'une variable (secret possible). */
function texteRefus(option: string, valeur: string, motif: string): string {
  const montre = option === "--env" ? `--env ${valeur.split("=", 1)[0] ?? ""}` : `${option} ${valeur}`.trim();
  return `${montre.slice(0, 80)} (${motif})`;
}

/** Nom d'option d'un argument invalide, sans sa valeur. */
function nomOption(brut: string): string {
  return /^-{1,2}[A-Za-z][A-Za-z0-9-]*/u.exec(brut)?.[0] ?? "argument";
}

/** `extra_run_args` triés sans toucher au disque : options admises, rendues sous la forme vérifiée (`--option=valeur`), et refus avec leur motif. */
export function argsRunPermis(args: readonly string[]): { gardes: string[]; refus: string[] } {
  const gardes: string[] = [];
  const refuses: string[] = [];
  let admises = 0;
  for (let i = 0; i < args.length; i++) {
    const brut = (args[i] ?? "").trim();
    if (!brut) continue;
    if (brut.length > LONGUEUR_MAX || /[\r\n\0]/u.test(brut)) {
      refuses.push(`${nomOption(brut)} (argument invalide : une ligne, 200 caractères au plus)`);
      continue;
    }
    let option = brut;
    let valeur: string | null = null;
    if (brut.startsWith("--")) {
      const egal = brut.indexOf("=");
      if (egal > 0) [option, valeur] = [brut.slice(0, egal), brut.slice(egal + 1)];
    } else if (/^-[A-Za-z]/u.test(brut)) {
      option = brut.slice(0, 2);
      if (brut.length > 2) valeur = brut.slice(2).replace(/^=/u, "");
    }
    option = COURTES[option] ?? option;
    if (valeur === null) {
      const suivant = (args[i + 1] ?? "").trim();
      if (
        suivant &&
        !suivant.startsWith("-") &&
        suivant.length <= LONGUEUR_MAX &&
        !/[\r\n\0]/u.test(suivant)
      ) {
        valeur = suivant;
        i++;
      }
    }
    const r = examiner(option, valeur ?? "");
    if ("motif" in r) refuses.push(texteRefus(option, valeur ?? "", r.motif));
    else if (admises >= OPTIONS_MAX)
      refuses.push(texteRefus(option, valeur ?? "", "trop d'options (32 au plus)"));
    else {
      admises++;
      gardes.push(...r.args);
    }
  }
  return { gardes, refus: refuses };
}

/** Promesse bornée à `ms` : l'appel système peut rester en cours, la vérification n'attend plus. */
function avecDelai<T>(p: Promise<T>, ms: number): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const echeance = new Promise<never>((_, refuser) => {
    minuteur = setTimeout(() => refuser(new Error("délai dépassé")), ms);
  });
  return Promise.race([p, echeance]).finally(() => clearTimeout(minuteur));
}

/** Dossiers des données d'Elpis (installation, config, bacs, mémoire, skills, apparences, serveurs MCP, base), liens résolus. */
async function donneesElpis(): Promise<string[]> {
  const c = config as unknown as Record<string, unknown>;
  const texte = (k: string): string => (typeof c[k] === "string" ? (c[k] as string) : "");
  const dossiers = [
    "PROJECT_ROOT",
    "SANDBOX_DIR",
    "MEMORY_DIR",
    "SKILLS_DIR",
    "USER_SKILLS_DIR",
    "SKINS_DIR",
    "MCP_SERVERS_DIR",
  ]
    .map(texte)
    .filter((d) => d !== "");
  for (const k of ["DB_PATH", "CONFIG_JSON_PATH"]) if (texte(k)) dossiers.push(path.posix.dirname(texte(k)));
  return Promise.all(
    dossiers.map(async (d) => {
      const brut = pyPath(d);
      try {
        return await avecDelai(realpath(brut), reglagesSources.delaiMs);
      } catch {
        return path.posix.normalize(brut);
      }
    }),
  );
}

/** Source d'un montage vérifiée sur le disque : dossier existant, liens résolus, hors système et données d'Elpis, dont chaque dossier parent appartient à root et n'est modifiable par aucun autre compte (la source ne peut être remplacée avant le montage) ; sinon le motif. */
async function sourceVerifiee(
  source: string,
  donnees: readonly string[],
): Promise<{ chemin: string } | { motif: string }> {
  const d = reglagesSources.delaiMs;
  let reel: string;
  try {
    reel = await avecDelai(realpath(source), d);
  } catch {
    return { motif: "source absente, illisible ou sans réponse" };
  }
  const forme = motifChemin(reel);
  if (forme !== null) return { motif: forme };
  if (donnees.some((r) => sous(reel, r) || sous(r, reel))) return { motif: "données d'Elpis" };
  try {
    if (!(await avecDelai(stat(reel), d)).isDirectory()) return { motif: "source : un dossier attendu" };
    for (let parent = path.posix.dirname(reel); ; parent = path.posix.dirname(parent)) {
      const s = await avecDelai(lstat(parent), d);
      if (!s.isDirectory() || s.uid !== 0 || (s.mode & 0o022) !== 0)
        return { motif: "un dossier parent de la source est modifiable par un autre compte que root" };
      if (parent === "/") break;
    }
  } catch {
    return { motif: "source illisible ou sans réponse" };
  }
  return { chemin: reel };
}

/** Montages d'`extra_run_args` (forme d'`argsRunPermis`) vérifiés sur le disque, à la création du conteneur et à l'enregistrement : rendus avec le chemin résolu, ou écartés avec leur motif ; les autres options passent telles quelles. */
export async function verifierMontages(
  args: readonly string[],
): Promise<{ args: string[]; refus: string[] }> {
  const sortie: string[] = [];
  const refus: string[] = [];
  let donnees: string[] | null = null;
  for (const a of args) {
    const m = MONTAGE_RENDU.exec(a);
    if (m === null) {
      sortie.push(a);
      continue;
    }
    const [, source = "", cible = ""] = m;
    donnees ??= await donneesElpis();
    const v = await sourceVerifiee(source, donnees);
    if ("motif" in v) refus.push(`${source} → ${cible} (${v.motif})`);
    else sortie.push(`--mount=type=bind,source=${v.chemin},target=${cible},readonly`);
  }
  return { args: sortie, refus };
}
