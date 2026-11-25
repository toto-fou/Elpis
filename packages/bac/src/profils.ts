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

/** Règles de la console (POST /api/admin/executors) ; `[a-zA-Z]` : l'IGNORECASE ASCII de Python. */
export const PROFILE_ID_RE = /^[a-z0-9_-]+$/u;
export const DOMAIN_RE =
  /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/u;

const MODES: readonly unknown[] = ["none", "bridge", "allowlist_ip"];

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
  };
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
    });
  }
  if (profils.length === 0) profils.push(profilIsole());
  else if (!profils.some((p) => p.id === "isolated")) profils.unshift(profilIsole());
  return {
    memory_mb: intPy(getPy(limites, "memory_mb", 2048)),
    cpu_quota_pct: intPy(getPy(limites, "cpu_quota_pct", 100)),
    pids_max: intPy(getPy(limites, "pids_max", 512)),
    timeout_s: intPy(getPy(limites, "timeout_s", 600)),
    exec_user: stripPy(texteOu(getPy(d, "exec_user"), "10001:10001")),
    force_user_docker: veritePy(getPy(d, "force_user_docker", false)),
    idle_kill_hours: intPy(getPy(d, "idle_kill_hours", 24)),
    network_profiles: profils,
    runtime: texteNet(getPy(d, "runtime")),
    extra_run_args: iterExige(ouPy(getPy(d, "extra_run_args"), []))
      .map(strPy)
      .filter((x) => stripPy(x) !== ""),
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

/** `netcfg_hash` : empreinte stable (12 hex) de la config réseau d'un profil (étiquette `elpis.netcfg`). */
export function netcfgHash(p: ProfilReseau): string {
  const tries = (l: readonly unknown[]): string[] => l.map((x) => x as string).sort(comparePointsDeCode);
  const charge = pyJsonDumps(
    {
      mode: p.mode,
      ips: tries(p.ips),
      domains: tries(p.domains),
      ports: p.ports.map((x) => intPy(x)).sort((a, b) => a - b),
      dns: tries(p.dns),
    },
    { sortKeys: true, separators: [",", ":"] },
  );
  return createHash("sha256").update(charge, "utf8").digest("hex").slice(0, 12);
}
