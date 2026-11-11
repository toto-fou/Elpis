// SPDX-License-Identifier: MIT
/** packages/bac/src/registre.ts — bacs du process par compte (`get_user_sandbox`), bac du compte courant d'après l'enveloppe (exec_bridge, routes_lifecycle), statistiques et IP d'aperçu. */
import { floatPy, HttpError, rstripPy, splitPy, stripPy } from "@elpis/commun";
import { config, pyJoin, realpathPy, safeSandboxName } from "@elpis/config";
import {
  current,
  resolveForcedNetworkProfileId,
  resolveNetworkProfileId,
  usernameFor,
  userNetworkProfileId,
} from "@elpis/securite";

import type { AgentBac } from "./agent";
import { DockerCli } from "./cli";
import type { CliDocker } from "./cli";
import { loadAdminConfig, UserSandbox } from "./conteneur";
import { getReadinessCache } from "./disponibilite";
import { decoderRemplace, labelFilter, which } from "./docker";
import { ensureWorkSubdir } from "./travail";

const bacs = new Map<string, UserSandbox>();

/** Clé (id, nom brut) : deux comptes non résolus (id 0) ne partagent jamais un bac. */
function cle(uid: number, username: string): string {
  return `${uid}\0${username}`;
}

/** `get_user_sandbox` : une instance par compte et par process ; configuration relue, profil mis à jour s'il est fourni. */
export function getUserSandbox(
  uid: number,
  username: string,
  sandboxPath: string,
  networkProfileId: string | null = null,
): UserSandbox {
  const deja = bacs.get(cle(uid, username));
  if (deja !== undefined) {
    deja.cfg = loadAdminConfig();
    if (networkProfileId !== null && networkProfileId !== deja.networkProfileId) {
      deja.networkProfileId = networkProfileId;
      deja.configVerified = false;
      deja.configRetryAt = 0;
    }
    return deja;
  }
  const sb = new UserSandbox(uid, username, sandboxPath, null, networkProfileId);
  bacs.set(cle(uid, username), sb);
  return sb;
}

/** Instances oubliées : ce compte seul, ou toutes (changement de configuration). */
export function resetUserSandboxCache(uid: number | null = null): void {
  if (uid === null) bacs.clear();
  else for (const k of [...bacs.keys()]) if (k.startsWith(`${uid}\0`)) bacs.delete(k);
}

const CHOIX_TTL_S = 30;
const choixRecents = new Map<number, { profil: string; jusqua: number }>();

/** Choix du profil validé par POST /me, retenu 30 s : main ne l'enregistre (et l'enveloppe ne le porte) qu'après la réponse. */
export function retenirChoixProfil(uid: number, profil: string): void {
  const maintenant = performance.now() / 1000;
  if (choixRecents.size >= 1024)
    for (const [k, v] of [...choixRecents]) if (v.jusqua < maintenant) choixRecents.delete(k);
  choixRecents.set(uid, { profil, jusqua: maintenant + CHOIX_TTL_S });
}

/** Profil de l'enveloppe, sauf choix retenu encore absent de l'enveloppe (une imposition de l'admin l'emporte). */
export function profilRetenu(uid: number, enveloppe: string): string {
  const c = choixRecents.get(uid);
  if (c === undefined) return enveloppe;
  if (enveloppe === c.profil || performance.now() / 1000 > c.jusqua || resolveForcedNetworkProfileId(uid)) {
    choixRecents.delete(uid);
    return enveloppe;
  }
  return c.profil;
}

/** `_user_sandbox_dir` : `P/work` du compte (`P = <SANDBOX_DIR>/<nom sûr>` résolu), migré une fois. */
export function racineTravail(username: string): Promise<string> {
  return ensureWorkSubdir(realpathPy(pyJoin(config.SANDBOX_DIR, safeSandboxName(username))));
}

/** `_user_sandbox_for` / `_get_sandbox_for_user` : bac du compte avec son profil EFFECTIF (imposition > choix). */
export async function bacDuCompte(uid: number, username?: string): Promise<UserSandbox> {
  const nom = username ?? (await usernameFor(uid));
  return getUserSandbox(
    uid,
    nom,
    await racineTravail(nom),
    profilRetenu(uid, await userNetworkProfileId(uid)),
  );
}

/** Profil réseau effectif vu par main, par rappel `/api/internal/identity` (ClientRappel de l'hôte d'outils). */
export interface PortProfilRappel {
  readonly actif: boolean;
  identityForUsername(username: string): Promise<{ readonly network_profile_id: string } | null>;
}

/** Profil effectif d'un appel d'outil : imposition de l'enveloppe, profil de l'identité, celui de main par rappel, puis la base ; « isolated » sinon. */
export async function profilReseauEffectif(
  uid: number,
  username: string,
  rappel: PortProfilRappel | null = null,
): Promise<string> {
  const impose = resolveForcedNetworkProfileId(uid);
  if (impose) return impose;
  const enveloppe = resolveNetworkProfileId(uid);
  if (enveloppe) return enveloppe;
  if (rappel?.actif) {
    const d = await rappel.identityForUsername(current()?.username || username).catch(() => null);
    if (d?.network_profile_id) return d.network_profile_id;
  }
  return userNetworkProfileId(uid);
}

/** Profil du bac d'un appel d'outil : l'effectif ; le choix retenu 30 s après POST /me ne vaut que si l'enveloppe dit qu'il n'y a pas d'imposition. */
export async function profilDuBac(
  uid: number,
  username: string,
  rappel: PortProfilRappel | null = null,
): Promise<string> {
  const effectif = await profilReseauEffectif(uid, username, rappel);
  return resolveForcedNetworkProfileId(uid) === "" ? profilRetenu(uid, effectif) : effectif;
}

/** Bac d'un appel d'outil (familles fs, shell, git… de l'hôte) : `P/work` du compte sous `profilDuBac`, le même pour toutes les familles. */
export async function bacDeLOutil(
  uid: number,
  username: string,
  rappel: PortProfilRappel | null = null,
): Promise<UserSandbox> {
  return getUserSandbox(
    uid,
    username,
    await racineTravail(username),
    await profilDuBac(uid, username, rappel),
  );
}

/** `agent_for` : client de l'agent du bac du compte. */
export async function agentFor(uid: number): Promise<AgentBac> {
  return (await bacDuCompte(uid)).agent;
}

/** `ensure_container_running` : 503 si le conteneur ne tourne pas (sans le démarrer). */
export async function ensureContainerRunning(uid: number): Promise<void> {
  const sb = await bacDuCompte(uid);
  let enMarche: boolean;
  try {
    enMarche = (await sb.status(AbortSignal.timeout(5_000))).running;
  } catch {
    enMarche = false;
  }
  if (!enMarche)
    throw new HttpError(
      503,
      "Sandbox container non démarré. Ouvrez le terminal pour le lancer (POST /api/sandbox/me).",
    );
}

const UNITES_MIB: Readonly<Record<string, number>> = {
  b: 1 / 1048576,
  kib: 1 / 1024,
  kb: 1000 / 1048576,
  mib: 1.0,
  mb: 1e6 / 1048576,
  gib: 1024.0,
  gb: 1e9 / 1048576,
  tib: 1048576.0,
  tb: 1e12 / 1048576,
};
const BLANCS = "[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*";
const MIB_RE = new RegExp(`^${BLANCS}([0-9.]+)${BLANCS}([A-Za-z]+)${BLANCS}$`, "u");

/** `_mib` : « 123.4MiB » (moitié gauche de `MemUsage`) en Mio ; `float()` lève ValueError comme le Python. */
export function mib(texte: string): number | null {
  const m = MIB_RE.exec(texte);
  const unite = m?.[2]?.toLowerCase();
  if (!m || unite === undefined || !Object.hasOwn(UNITES_MIB, unite)) return null;
  return floatPy(m[1]) * (UNITES_MIB[unite] ?? 0);
}

/** `running_container_stats` : `{cpu_pct, mem_mb}` du conteneur EN MARCHE du compte, `null` sinon (rien n'est démarré). */
export async function runningContainerStats(
  uid: number,
  cli: CliDocker = new DockerCli(),
): Promise<{ cpu_pct: number; mem_mb: number } | null> {
  if (which("docker") === null && cli instanceof DockerCli) return null;
  const [rc, out] = await cli.call(
    ["ps", ...labelFilter("user_id", String(uid)), "--filter", "status=running", "--format", "{{.Names}}"],
    { timeoutS: 5 },
  );
  const noms = rc === 0 ? splitPy(decoderRemplace(out)) : [];
  const nom = noms[0];
  if (nom === undefined) return null;
  const [rc2, out2] = await cli.call(
    ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", nom],
    {
      timeoutS: 10,
    },
  );
  if (rc2 !== 0) return null;
  const texte = stripPy(decoderRemplace(out2));
  const i = texte.indexOf("|");
  const [cpu, mem] = i < 0 ? [texte, ""] : [texte.slice(0, i), texte.slice(i + 1)];
  let cpuPct: number;
  try {
    cpuPct = floatPy(rstripPy(stripPy(cpu), "%"));
  } catch (e) {
    if ((e as Error).name !== "ValueError") throw e;
    return null;
  }
  const memMb = mib(mem.split("/", 1)[0] ?? "");
  return { cpu_pct: cpuPct, mem_mb: memMb ?? 0.0 };
}

const IP_TTL_S = 5;
const IP_MAX = 1024;
const ips = new Map<number, { ip: string; expire: number; conteneur: string; signal: [boolean, number] }>();

/** `_forget_preview_ip` : IP mémorisée oubliée (changement de profil, redémarrage, destruction). */
export function forgetPreviewIp(uid: number): void {
  ips.delete(uid);
}

/** `_preview_container_ip` : IP du conteneur pour l'aperçu, gardée 5 s tant que `docker events` ne signale rien. */
export async function previewContainerIp(uid: number, username: string): Promise<string | null> {
  const cache = getReadinessCache();
  const maintenant = performance.now() / 1000;
  const deja = ips.get(uid);
  if (deja && deja.expire > maintenant) {
    const s = cache.stateStamp(deja.conteneur);
    if (s !== null && s[0] === deja.signal[0] && s[1] === deja.signal[1] && s[0]) return deja.ip;
  }
  ips.delete(uid);
  const sb = await bacDuCompte(uid, username);
  const ip = await sb.containerIp();
  const s = cache.stateStamp(sb.containerName);
  if (ip && s !== null && s[0]) {
    if (ips.size >= IP_MAX) {
      for (const [k, v] of [...ips]) if (v.expire <= maintenant) ips.delete(k);
      if (ips.size >= IP_MAX) ips.clear();
    }
    ips.set(uid, { ip, expire: maintenant + IP_TTL_S, conteneur: sb.containerName, signal: [s[0], s[1]] });
  }
  return ip;
}

/** Port de l'aperçu (B2-05) : IP du conteneur du compte, oubliée au changement de profil ou au redémarrage. */
export interface IpConteneurApercu {
  ip(uid: number, username: string): Promise<string | null>;
  oublier(uid: number): void;
}

export const ipConteneurApercu: IpConteneurApercu = { ip: previewContainerIp, oublier: forgetPreviewIp };
