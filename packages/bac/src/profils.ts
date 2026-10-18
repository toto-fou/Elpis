// SPDX-License-Identifier: MIT
/** packages/bac/src/profils.ts — profils réseau du bac à sable lus dans config.json et revérifiés à la lecture (`_user_sandbox.py`). */
import { createHash } from "node:crypto";

import {
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
  rstripPy,
  stripPy,
  strPy,
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
  return {
    id: pid,
    name: prefixePy(texteNet(lire(d, "name")), 60),
    mode: MODES.includes(mode) ? mode : "none",
    ips: textes(lire(d, "ips")),
    description: prefixePy(texteOu(lire(d, "description"), ""), 200),
    domains: domainesValides(d, avertir),
    ports: entiers(lire(d, "ports")),
    dns: textes(lire(d, "dns")),
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
      mode: getPy(d, "network_mode", "none"),
      ips: [...iterExige(ouPy(getPy(d, "network_allowlist"), []))],
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
