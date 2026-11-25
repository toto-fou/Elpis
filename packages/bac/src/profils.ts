// SPDX-License-Identifier: MIT
/** packages/bac/src/profils.ts — profils réseau du bac à sable lus dans config.json et revérifiés à la lecture (`_user_sandbox.py`). */
import { createHash } from "node:crypto";

import {
  adresseIpOuNul,
  comparePointsDeCode,
  ErreurPython,
  estDict,
  estErreurPython,
  getPy,
  intPy,
  iterExige,
  journalDe,
  lire,
  lowerPy,
  ouPy,
  prefixePy,
  pyJsonDumps,
  reprPy,
  reseauPy,
  rstripPy,
  stripPy,
  strPy,
  texteIp,
  texteNet,
  texteOu,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { configView } from "@elpis/config";

import { argsRunPermis } from "./options-run";

/** Règles de la console (POST /api/admin/executors) ; `[a-zA-Z]` : l'IGNORECASE ASCII de Python. */
export const PROFILE_ID_RE = /^[a-z0-9_-]+$/u;
export const DOMAIN_RE =
  /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/u;

const MODES: readonly unknown[] = ["none", "bridge", "allowlist_ip"];

/** Règle Git d'un profil : tous les dépôts (`all`), ceux des serveurs choisis par l'administrateur (`servers`), ceux que couvrent les comptes Git du compte (`accounts`). */
export const ACCES_GIT = ["all", "servers", "accounts"] as const;
export type AccesGit = (typeof ACCES_GIT)[number];
const SEGMENT_GIT = /^[A-Za-z0-9._~-]+$/u;
const HOTE_GIT =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[1-9][0-9]{0,4})?$/u;

/** Serveur Git saisi par l'administrateur, en forme : `hôte[:port]` (tout le serveur) ou `hôte[:port]/organisation[/…]`, hôte sans la casse et chemin tel quel, `.git` et barres des bords retirés ; `null` s'il ne se lit pas. */
export function serveurGitCanonique(texte: string): string | null {
  let t = stripPy(texte).replace(/^https?:\/\//iu, "");
  t = rstripPy(t, "/");
  if (t.toLowerCase().endsWith(".git")) t = t.slice(0, -4);
  const [brutHote = "", ...segments] = t.split("/");
  const hote = brutHote.toLowerCase();
  const port = /:([0-9]+)$/u.exec(hote)?.[1];
  if (!HOTE_GIT.test(hote) || (port !== undefined && Number(port) > 65535)) return null;
  if (segments.some((x) => !SEGMENT_GIT.test(x) || x === "." || x === "..")) return null;
  return [hote, ...segments].join("/");
}

/** `NetworkProfile.to_dict()` ; un profil migré (legacy) garde `mode` et `ips` tels quels. */
export interface ProfilReseau {
  id: string;
  name: string;
  mode: unknown;
  ips: unknown[];
  description: string;
  domains: string[];
  ports: number[];
  dns: string[];
  /** Protections d'un profil ouvert (`bridge`) : métadonnées du cloud, réseau local, machine hôte refusés ; sans effet dans les autres modes. */
  block_metadata: boolean;
  block_lan: boolean;
  block_host: boolean;
  /** Dépôts que joint le relais Git pour les bacs du profil, quel que soit son mode ; `git_servers` : serveurs en forme (`serveurGitCanonique`). */
  git_access: AccesGit;
  git_servers: string[];
}

/** `SandboxAdminConfig`, sans l'image (inutile à main). */
export interface ConfigBac {
  memory_mb: number;
  cpu_quota_pct: number;
  pids_max: number;
  timeout_s: number;
  exec_user: string;
  force_user_docker: boolean;
  idle_kill_hours: number;
  network_profiles: ProfilReseau[];
  runtime: string;
  extra_run_args: string[];
  /** `sudo` permis dans les bacs dont le réseau n'est pas filtré (root dans le conteneur) ; vrai par défaut, faux : tous les bacs durcis. */
  allow_sudo: boolean;
}

export type Avertir = (message: string) => void;

const signales = new Set<string>();

/** `_signaler_une_fois` : un même avertissement n'est journalisé qu'une fois par processus. */
export function signalerUneFois(message: string): void {
  if (signales.has(message)) return;
  signales.add(message);
  journalDe("sandbox").warn(message);
}

/** Pour les tests : avertissements de nouveau journalisables. */
export function oublierSignalements(): void {
  signales.clear();
}

/** `_default_profiles()[0]`. */
function profilIsole(): ProfilReseau {
  return {
    id: "isolated",
    name: "Isolé total",
    mode: "none",
    ips: [],
    description: "Aucun accès réseau. Sécurité maximale.",
    domains: [],
    ports: [],
    dns: [],
    block_metadata: false,
    block_lan: false,
    block_host: false,
    git_access: "all",
    git_servers: [],
  };
}

/** Adresse ou réseau IPv4 en forme canonique (`a.b.c.d` ou `a.b.c.d/n`, bits d'hôte effacés) ; `null` pour toute autre saisie, IPv6 comprise : le filtre du conteneur est IPv4. */
export function ipv4Canonique(texte: string): string | null {
  const r = reseauPy(stripPy(texte));
  if (r === null || r.version !== 4) return null;
  let prefixe = 0;
  for (let m = r.masque; m > 0n; m >>= 1n) prefixe += Number(m & 1n);
  const adresse = texteIp({ version: 4, valeur: r.adresse, zone: null });
  return prefixe === 32 ? adresse : `${adresse}/${prefixe}`;
}

/** Résolveur DNS d'un profil : une adresse IPv4 seule, rendue en forme canonique ; `null` sinon. */
export function resolveurValide(texte: string): string | null {
  const a = adresseIpOuNul(stripPy(texte));
  return a !== null && a.version === 4 && a.zone === null ? texteIp(a) : null;
}

/** `[str(x).strip() for x in (v or []) if str(x).strip()]`. */
function textes(v: unknown): string[] {
  return iterExige(ouPy(v, []))
    .map((x) => stripPy(strPy(x)))
    .filter((x) => x !== "");
}

/** `_ints` : `int(x)` de chaque élément, ceux qui lèvent TypeError ou ValueError ignorés. */
function entiers(v: unknown): number[] {
  const sortie: number[] = [];
  for (const x of iterExige(ouPy(v, []))) {
    try {
      sortie.push(intPy(x));
    } catch (e) {
      if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    }
  }
  return sortie;
}

/** Entrées d'une liste d'adresses du profil passées par leur validateur, les autres signalées et ignorées (config.json édité à la main). */
function valides(
  d: Dict,
  cle: "ips" | "dns",
  valider: (s: string) => string | null,
  avertir: Avertir,
): string[] {
  const sortie: string[] = [];
  for (const brut of textes(lire(d, cle))) {
    const v = valider(brut);
    if (v !== null) sortie.push(v);
    else
      avertir(
        `profil réseau ${reprPy(strPy(lire(d, "id") ?? null))} : ${cle} ${reprPy(brut)} ignoré (IPv4 attendue)`,
      );
  }
  return sortie;
}

/** `_domaines_valides` : domaines conformes à la règle de la console, les autres signalés. */
function domainesValides(d: Dict, avertir: Avertir): string[] {
  const sortie: string[] = [];
  for (const x of iterExige(ouPy(lire(d, "domains"), []))) {
    const dom = rstripPy(lowerPy(stripPy(strPy(x))), ".");
    if (dom && DOMAIN_RE.test(dom)) sortie.push(dom);
    else if (dom) {
      avertir(
        `profil réseau ${reprPy(strPy(lire(d, "id") ?? null))} : domaine ${reprPy(dom)} ignoré (invalide)`,
      );
    }
  }
  return sortie;
}

/** Règle Git lue : absente (ou `null`), tous les dépôts ; illisible, les serveurs listés seuls (signalé) ; serveurs illisibles, ou autre chose qu'une liste, ignorés et signalés. */
export function regleGitDepuis(
  d: Dict,
  pid: string,
  avertir: Avertir,
): Pick<ProfilReseau, "git_access" | "git_servers"> {
  const brut = lire(d, "git_access");
  let acces: AccesGit = "all";
  if ((ACCES_GIT as readonly unknown[]).includes(brut)) acces = brut as AccesGit;
  else if (brut !== undefined && brut !== null) {
    avertir(
      `profil réseau ${reprPy(pid)} : git_access ${reprPy(strPy(brut))} illisible, serveurs listés seuls`,
    );
    acces = "servers";
  }
  const serveurs: string[] = [];
  const brutServeurs = lire(d, "git_servers");
  if (brutServeurs !== undefined && brutServeurs !== null && !Array.isArray(brutServeurs))
    avertir(`profil réseau ${reprPy(pid)} : git_servers ignoré (une liste est attendue)`);
  for (const x of Array.isArray(brutServeurs) ? textes(brutServeurs) : []) {
    const v = serveurGitCanonique(x);
    if (v !== null) serveurs.push(v);
    else
      avertir(
        `profil réseau ${reprPy(pid)} : serveur Git ${reprPy(x)} ignoré (hôte[:port][/organisation] attendu)`,
      );
  }
  return { git_access: acces, git_servers: serveurs };
}

/** `NetworkProfile.from_dict` : identifiant revérifié (ValueError sinon), domaines filtrés. */
export function profilReseauDepuis(d: Dict, avertir: Avertir = signalerUneFois): ProfilReseau {
  const pid = prefixePy(texteNet(lire(d, "id")), 32);
  if (!PROFILE_ID_RE.test(pid)) {
    throw new ErreurPython("ValueError", `identifiant de profil invalide : ${reprPy(pid)}`);
  }
  const mode = lire(d, "mode");
  const demandes = entiers(lire(d, "ports"));
  const ports = demandes.filter((p) => p >= 1 && p <= 65535);
  // Des ports demandés dont aucun n'est valide : profil fermé, plutôt qu'ouvert sur tous les ports.
  const ferme = iterExige(ouPy(lire(d, "ports"), [])).length > 0 && ports.length === 0;
  if (ferme) avertir(`profil réseau ${reprPy(pid)} : aucun port valide, aucune destination gardée`);
  return {
    id: pid,
    name: prefixePy(texteNet(lire(d, "name")), 60),
    mode: MODES.includes(mode) ? mode : "none",
    ips: ferme ? [] : valides(d, "ips", ipv4Canonique, avertir),
    description: prefixePy(texteOu(lire(d, "description"), ""), 200),
    domains: ferme ? [] : domainesValides(d, avertir),
    ports,
    dns: valides(d, "dns", resolveurValide, avertir),
    block_metadata: veritePy(lire(d, "block_metadata")),
    block_lan: veritePy(lire(d, "block_lan")),
    block_host: veritePy(lire(d, "block_host")),
    ...regleGitDepuis(d, pid, avertir),
  };
}

/** Options `docker run` de l'administrateur : celles hors de la liste permise sont retirées et signalées (config.json édité à la main). */
function optionsPermises(brut: unknown, avertir: Avertir): string[] {
  const args = iterExige(ouPy(brut, []))
    .map(strPy)
    .filter((x) => stripPy(x) !== "");
  const { gardes, refus } = argsRunPermis(args);
  for (const r of refus) avertir(`executors.extra_run_args : ${r} ignoré`);
  return gardes;
}

/** `uid:gid` numérique des commandes du compte ; toute autre forme, ou root quand sudo est refusé, revient à l'utilisateur de l'image avec un avertissement. */
export const EXEC_USER_RE = /^[0-9]{1,7}:[0-9]{1,7}$/u;
const EXEC_USER_DEFAUT = "10001:10001";
function execUserValide(brut: unknown, sudo: boolean, avertir: Avertir): string {
  const texte = stripPy(texteOu(brut, EXEC_USER_DEFAUT));
  if (!EXEC_USER_RE.test(texte)) {
    avertir(`executors.exec_user ${reprPy(texte)} ignoré (uid:gid numérique attendu)`);
    return EXEC_USER_DEFAUT;
  }
  if (!sudo && /^0+:/u.test(texte)) {
    avertir("executors.exec_user root ignoré : sudo est refusé (executors.allow_sudo)");
    return EXEC_USER_DEFAUT;
  }
  return texte;
}

/** `SandboxAdminConfig.from_dict` : profils invalides ignorés et signalés, migration legacy, « isolated » toujours présent. */
export function configBacDepuis(brut: unknown, avertir: Avertir = signalerUneFois): ConfigBac {
  const d = ouPy(brut, {});
  const limites = ouPy(getPy(d, "limits"), {});
  const profils: ProfilReseau[] = [];
  for (const p of iterExige(ouPy(getPy(d, "network_profiles"), []))) {
    if (!estDict(p) || !veritePy(lire(p, "id")) || !veritePy(lire(p, "name"))) continue;
    try {
      profils.push(profilReseauDepuis(p, avertir));
    } catch (e) {
      if (!estErreurPython(e, "ValueError")) throw e;
      avertir(`profil réseau ignoré : ${e.message}`);
    }
  }
  if (
    profils.length === 0 &&
    (veritePy(getPy(d, "network_mode")) || veritePy(getPy(d, "network_allowlist")))
  ) {
    profils.push({
      id: "legacy",
      name: "Profil migré (legacy)",
      mode: MODES.includes(getPy(d, "network_mode", "none")) ? getPy(d, "network_mode", "none") : "none",
      ips: valides({ id: "legacy", ips: getPy(d, "network_allowlist") }, "ips", ipv4Canonique, avertir),
      description: "Migré automatiquement depuis l'ancienne config.",
      domains: [],
      ports: [],
      dns: [],
      block_metadata: false,
      block_lan: false,
      block_host: false,
      git_access: "all",
      git_servers: [],
    });
  }
  const brutSudo = getPy(d, "allow_sudo", true);
  const sudo = brutSudo === true;
  if (typeof brutSudo !== "boolean")
    avertir(`executors.allow_sudo ${reprPy(strPy(brutSudo))} illisible : sudo refusé`);
  if (profils.length === 0) profils.push(profilIsole());
  else if (!profils.some((p) => p.id === "isolated")) profils.unshift(profilIsole());
  return {
    memory_mb: intPy(getPy(limites, "memory_mb", 2048)),
    cpu_quota_pct: intPy(getPy(limites, "cpu_quota_pct", 100)),
    pids_max: intPy(getPy(limites, "pids_max", 512)),
    timeout_s: intPy(getPy(limites, "timeout_s", 600)),
    exec_user: execUserValide(getPy(d, "exec_user"), sudo, avertir),
    force_user_docker: veritePy(getPy(d, "force_user_docker", false)),
    idle_kill_hours: intPy(getPy(d, "idle_kill_hours", 24)),
    network_profiles: profils,
    runtime: texteNet(getPy(d, "runtime")),
    extra_run_args: optionsPermises(getPy(d, "extra_run_args"), avertir),
    allow_sudo: sudo,
  };
}

/** `get_profile` : le profil demandé, sinon « isolated » lui-même. */
export function profilParId(config: ConfigBac, id: string): ProfilReseau {
  return (
    config.network_profiles.find((p) => p.id === id) ??
    config.network_profiles.find((p) => p.id === "isolated") ??
    profilIsole()
  );
}

/** `load_admin_config` : section `executors` de config.json, relue à chaud. */
export function chargerConfigBac(avertir: Avertir = signalerUneFois): ConfigBac {
  return configBacDepuis(ouPy(getPy(configView(), "executors"), {}), avertir);
}

/** `elpis.resolved` : adresses épinglées à la création pour chaque domaine résolu d'un profil en liste blanche (JSON compact, trié). */
export function etiquetteDomaines(resolus: Readonly<Record<string, readonly string[]>>): string {
  const tries: Record<string, string[]> = {};
  for (const dom of Object.keys(resolus).sort(comparePointsDeCode)) {
    const ips = [...(resolus[dom] ?? [])].sort(comparePointsDeCode);
    if (ips.length > 0) tries[dom] = ips;
  }
  return pyJsonDumps(tries, { sortKeys: true, separators: [",", ":"] });
}

/** Adresses épinglées lues sur l'étiquette `elpis.resolved` ; absente ou illisible : `null`. */
export function domainesEpingles(etiquette: string): Record<string, string[]> | null {
  let v: unknown;
  try {
    v = JSON.parse(etiquette);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const sortie: Record<string, string[]> = {};
  for (const [dom, ips] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(ips) || !ips.every((x) => typeof x === "string")) return null;
    sortie[dom] = ips as string[];
  }
  return sortie;
}

/** Domaines à présent rendus dont aucune adresse n'est épinglée dans le conteneur (recréation utile) ; un domaine sans réponse (`null`) ou irrésoluble (`[]`) n'y entre pas. */
export function domainesPerimes(
  epingles: Readonly<Record<string, readonly string[]>>,
  actuels: Readonly<Record<string, readonly string[] | null>>,
): string[] {
  return Object.entries(actuels)
    .filter(
      ([dom, ips]) => ips !== null && ips.length > 0 && !ips.some((ip) => (epingles[dom] ?? []).includes(ip)),
    )
    .map(([dom]) => dom);
}

/** Protections appliquées d'un profil : celles cochées d'un profil ouvert, aucune dans les autres modes. */
export function protectionsDe(
  p: Pick<ProfilReseau, "mode" | "block_metadata" | "block_lan" | "block_host">,
): ("metadata" | "lan" | "host")[] {
  if (p.mode !== "bridge") return [];
  return (
    [
      ["metadata", p.block_metadata],
      ["lan", p.block_lan],
      ["host", p.block_host],
    ] as const
  )
    .filter(([, coche]) => coche)
    .map(([nom]) => nom);
}

/** `netcfg_hash` : empreinte stable (12 hex) de la config réseau d'un profil (étiquette `elpis.netcfg`) ; les protections n'y entrent que cochées (profils d'avant inchangés). */
export function netcfgHash(p: ProfilReseau): string {
  const tries = (l: readonly unknown[]): string[] => l.map((x) => x as string).sort(comparePointsDeCode);
  const protections = protectionsDe(p);
  const charge = pyJsonDumps(
    {
      mode: p.mode,
      ips: tries(p.ips),
      domains: tries(p.domains),
      ports: p.ports.map((x) => intPy(x)).sort((a, b) => a - b),
      dns: tries(p.dns),
      ...(protections.length > 0 ? { blocks: protections } : {}),
    },
    { sortKeys: true, separators: [",", ":"] },
  );
  return createHash("sha256").update(charge, "utf8").digest("hex").slice(0, 12);
}

/** Étiquette `elpis.netcfg` d'un conteneur : empreinte du profil, suivie pour un profil protégé de celle des plages refusées posées dans le conteneur (adresses de la machine comprises). */
export function etiquetteNetcfg(p: ProfilReseau, refusees: readonly string[]): string {
  if (protectionsDe(p).length === 0) return netcfgHash(p);
  const plages = createHash("sha256").update(refusees.join(" "), "utf8").digest("hex").slice(0, 12);
  return `${netcfgHash(p)}-${plages}`;
}
