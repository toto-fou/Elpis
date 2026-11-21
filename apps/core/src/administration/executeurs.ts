// SPDX-License-Identifier: MIT
/** apps/core/src/administration/executeurs.ts — réglages des bacs à sable vus et validés par la console, conteneurs des comptes relevés par l'hôte d'outils (shared_infra/routes/admin/executors.py, executors/_user_sandbox.py, _image_loader.py). */
import {
  ErreurPython,
  estDict,
  estErreurPython,
  getPy,
  HttpError,
  intPy,
  iterExige,
  lire,
  longueurPy,
  lowerPy,
  nomTypePy,
  ouPy,
  poserCle,
  prefixePy,
  reprPy,
  reseauPy,
  rstripPy,
  stripPy,
  strPy,
  texteNet,
  veritePy,
} from "@elpis/commun";
import type { Dict, Reseau } from "@elpis/commun";
import {
  ACCES_GIT,
  adressesEpinglables,
  argsRunPermis,
  assainirSeuilsDisque,
  configuredImage,
  DEFAULT_IMAGE,
  DOMAIN_RE,
  domainesEpingles,
  domainesPerimes,
  ipv4Canonique,
  netcfgHash,
  PROFILE_ID_RE,
  profilFiltre,
  profilReseauDepuis,
  protectionsDe,
  regleGitDepuis,
  resolveurValide,
  resoudreIpv4,
  RUN_SPEC,
  serveurGitCanonique,
  seuilsDisqueDepuis,
} from "@elpis/bac";
import type { ProfilReseau } from "@elpis/bac";
import { hostAddressesRecent } from "@elpis/securite";
import type { HoteMachine } from "@elpis/securite";

import { assainirReglagesJobs, reglagesJobsDepuis } from "../jobs/reglages";
import { appelerConsole } from "./hote-console";
import type { Acteur } from "./hote-console";

const MODES = ["none", "bridge", "allowlist_ip"];
const EXEC_USER_RE = /^[0-9]{1,7}:[0-9]{1,7}$/u;
const RUNTIME_RE = /^[A-Za-z0-9._-]+$/u;
const LIEN_LOCAL = reseauPy("169.254.0.0/16") as Reseau;
const LIMITES_PAR_DEFAUT = { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 };
/** `get_image_load_state().to_dict()` du process admin, qui ne charge jamais d'image. */
export const ETAT_CHARGEMENT_IMAGE = {
  status: "not_checked",
  image: null,
  archive_path: null,
  progress_msg: "",
};
const INDICE_HOTE = "Demandez à votre administrateur de vérifier l'hôte d'outils.";

/** `NetworkProfile.to_dict()` du profil par défaut (« isolated »). */
function profilIsoleDict(): Dict {
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

/** `GET /api/admin/executors` : réglages tels qu'écrits dans config.json (profils non revalidés), image effective. */
export function vueExecuteurs(cfg: Dict): Dict {
  const bloc = ouPy(getPy(cfg, "executors"), {});
  let profils = ouPy(getPy(bloc, "network_profiles"), []);
  if (!veritePy(profils)) profils = [profilIsoleDict()];
  profils = profilsPourConsole(profils);
  const limites = ouPy(getPy(bloc, "limits"), { ...LIMITES_PAR_DEFAUT });
  return {
    config: {
      limits: limites,
      force_user_docker: veritePy(getPy(bloc, "force_user_docker", false)),
      idle_kill_hours: intPy(getPy(bloc, "idle_kill_hours", 24)),
      network_profiles: profils,
      exec_user: strPy(ouPy(getPy(bloc, "exec_user"), "10001:10001")),
      runtime: strPy(ouPy(getPy(bloc, "runtime"), "")),
      extra_run_args: iterExige(ouPy(getPy(bloc, "extra_run_args"), []))
        .map(strPy)
        .filter((x) => stripPy(x) !== ""),
      allow_sudo: getPy(bloc, "allow_sudo", true) === true,
      jobs: reglagesJobsDepuis(getPy(bloc, "jobs")),
      disk: seuilsDisqueDepuis(getPy(bloc, "disk")),
    },
    image: configuredImage(getPy(bloc, "image")),
  };
}

/** Profils montrés à la console : protections et règle Git rendues telles que lues (une valeur éditée à la main ne casse pas l'écran). */
function profilsPourConsole(profils: unknown): unknown {
  if (!Array.isArray(profils)) return profils;
  return profils.map((p: unknown) => {
    if (p === null || typeof p !== "object" || Array.isArray(p)) return p;
    const d: Dict = { ...(p as Dict) };
    for (const k of ["block_metadata", "block_lan", "block_host"])
      if (k in d && typeof d[k] !== "boolean") d[k] = veritePy(d[k]);
    if ("git_access" in d || "git_servers" in d)
      Object.assign(
        d,
        regleGitDepuis(d, "", () => undefined),
      );
    return d;
  });
}

/** `(v or "").strip()` : un texte, AttributeError (500) pour une autre valeur vraie. */
function texteNettoye(v: unknown): string {
  const s = veritePy(v) ? v : "";
  if (typeof s !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(s)}' object has no attribute 'strip'`);
  return stripPy(s);
}

/** `[str(x).strip() for x in (v or []) if str(x).strip()]`. */
function textesNets(v: unknown): string[] {
  return iterExige(ouPy(v, []))
    .map((x) => stripPy(strPy(x)))
    .filter((x) => x !== "");
}

function longueurPrefixe(r: Reseau): number {
  let n = 0;
  for (let m = r.masque; m > 0n; m >>= 1n) n += Number(m & 1n);
  return n;
}

/** `IPv4Network.overlaps` : deux réseaux CIDR se recouvrent si l'un contient l'adresse de l'autre. */
function recouvre(a: Reseau, b: Reseau): boolean {
  return (
    a.version === b.version && ((a.adresse & b.masque) === b.adresse || (b.adresse & a.masque) === a.adresse)
  );
}

/** Validation d'un profil `allowlist_ip` : IP/CIDR, domaines, ports et résolveurs, avec leurs plafonds. */
function validerListeBlanche(
  pid: string,
  ips: readonly string[],
  domaines: readonly string[],
  portsBruts: readonly unknown[],
  dns: readonly string[],
  avertissements: string[],
): number[] {
  const p = reprPy(pid);
  if (ips.length === 0 && domaines.length === 0)
    throw new HttpError(400, `Profil ${p} : allowlist_ip sans IP ni domaine`);
  for (const ip of ips) {
    const net = reseauPy(ip);
    if (net === null)
      throw new HttpError(400, `Profil ${p} : IP invalide ${reprPy(ip)} (utilise IP ou CIDR)`);
    if (net.version !== 4)
      throw new HttpError(400, `Profil ${p} : ${reprPy(ip)} est une IPv6 (IPv4 ou CIDR IPv4 seulement)`);
    if (longueurPrefixe(net) === 0)
      avertissements.push(
        `Profil ${p} : ${ip} autorise TOUT internet — autant utiliser le mode Ouvert (bridge).`,
      );
    else if (net.version === 4 && recouvre(net, LIEN_LOCAL))
      avertissements.push(
        `Profil ${p} : ${ip} recouvre 169.254.0.0/16 (métadonnées cloud, ex. 169.254.169.254).`,
      );
  }
  if (ips.length > 64) throw new HttpError(400, `Profil ${p} : trop d'IPs (max 64)`);
  for (const dom of domaines)
    if (!DOMAIN_RE.test(dom)) throw new HttpError(400, `Profil ${p} : domaine invalide ${reprPy(dom)}`);
  if (domaines.length > 32) throw new HttpError(400, `Profil ${p} : trop de domaines (max 32)`);
  const ports: number[] = [];
  for (const x of portsBruts) {
    let port: number;
    try {
      port = intPy(x);
    } catch (e) {
      if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
      throw new HttpError(400, `Profil ${p} : port invalide ${reprPy(x)}`);
    }
    if (!(port >= 1 && port <= 65535))
      throw new HttpError(400, `Profil ${p} : port hors plage ${strPy(port)}`);
    ports.push(port);
  }
  if (ports.length > 32) throw new HttpError(400, `Profil ${p} : trop de ports (max 32)`);
  for (const ip of dns)
    if (resolveurValide(ip) === null)
      throw new HttpError(400, `Profil ${p} : résolveur DNS invalide ${reprPy(ip)} (IPv4 attendue)`);
  if (dns.length > 4) throw new HttpError(400, `Profil ${p} : trop de résolveurs (max 4)`);
  return ports;
}

/** Règle Git d'un profil saisie en console : `git_access` parmi les trois (absent ou `null` : tous, comme à la lecture), serveurs en liste et en forme, 32 au plus. */
function regleGitSaisie(pid: string, p: Dict): Dict {
  const acces = getPy(p, "git_access", "all") ?? "all";
  if (typeof acces !== "string" || !(ACCES_GIT as readonly string[]).includes(acces))
    throw new HttpError(400, `Profil ${reprPy(pid)} : git_access invalide (all, servers ou accounts)`);
  const listeServeurs = getPy(p, "git_servers", []) ?? [];
  if (!Array.isArray(listeServeurs))
    throw new HttpError(400, `Profil ${reprPy(pid)} : git_servers doit être une liste`);
  const serveurs: string[] = [];
  for (const brut of textesNets(listeServeurs)) {
    const v = serveurGitCanonique(brut);
    if (v === null)
      throw new HttpError(
        400,
        `Profil ${reprPy(pid)} : serveur Git invalide ${reprPy(brut)} (hôte[:port] ou hôte/organisation)`,
      );
    if (!serveurs.includes(v)) serveurs.push(v);
  }
  if (serveurs.length > 32) throw new HttpError(400, `Profil ${reprPy(pid)} : trop de serveurs Git (max 32)`);
  return { git_access: acces, git_servers: acces === "servers" ? serveurs : [] };
}

/** Profils réseau d'un `POST /api/admin/executors` : validés, « isolated » ré-ancré sur « none », avertissements non bloquants. */
export function profilsAssainis(nouveau: Dict, avertissements: string[]): Dict[] {
  const sortie: Dict[] = [];
  const vus = new Set<string>();
  for (const p of iterExige(ouPy(getPy(nouveau, "network_profiles"), []))) {
    if (!estDict(p)) continue;
    const pid = prefixePy(texteNettoye(getPy(p, "id")), 32);
    const nom = prefixePy(texteNettoye(getPy(p, "name")), 60);
    if (!pid || !nom) continue;
    if (!PROFILE_ID_RE.test(pid))
      throw new HttpError(
        400,
        `id de profil invalide : ${reprPy(pid)} (lettres minuscules, chiffres, _ ou -)`,
      );
    if (vus.has(pid)) throw new HttpError(400, `id de profil dupliqué : ${reprPy(pid)}`);
    vus.add(pid);
    let mode = getPy(p, "mode", "none");
    if (typeof mode !== "string" || !MODES.includes(mode))
      throw new HttpError(400, `mode invalide pour profil ${reprPy(pid)}`);
    if (pid === "isolated" && mode !== "none") {
      avertissements.push(
        "Le profil 'isolated' est le repli de sécurité : son mode est forcé à « Tout bloquer ».",
      );
      mode = "none";
    }
    let ips = textesNets(getPy(p, "ips"));
    let domaines = iterExige(ouPy(getPy(p, "domains"), []))
      .filter((x) => stripPy(strPy(x)) !== "")
      .map((x) => rstripPy(lowerPy(stripPy(strPy(x))), "."));
    let dns = textesNets(getPy(p, "dns"));
    const portsBruts = iterExige(ouPy(getPy(p, "ports"), [])).filter((x) => stripPy(strPy(x)) !== "");
    let ports: number[] = [];
    if (mode === "allowlist_ip") {
      ports = validerListeBlanche(pid, ips, domaines, portsBruts, dns, avertissements);
      ips = ips.map((x) => ipv4Canonique(x) ?? x);
      dns = dns.map((x) => resolveurValide(x) ?? x);
    } else [ips, domaines, dns] = [[], [], []];
    // Protections d'un profil ouvert : cochées, elles font tourner ses bacs sans sudo.
    const protections =
      mode === "bridge"
        ? {
            block_metadata: veritePy(getPy(p, "block_metadata")),
            block_lan: veritePy(getPy(p, "block_lan")),
            block_host: veritePy(getPy(p, "block_host")),
          }
        : {};
    sortie.push({
      id: pid,
      name: nom,
      mode,
      ips,
      domains: domaines,
      ports,
      dns,
      description: prefixePy(texteNettoye(getPy(p, "description")), 200),
      ...protections,
      ...regleGitSaisie(pid, p),
    });
  }
  if (sortie.length > 20) throw new HttpError(400, "Trop de profils (max 20)");
  return sortie;
}

/** Bornes des limites cgroups, dans l'ordre des contrôles du Python. */
const BORNES: readonly [string, number, number][] = [
  ["memory_mb", 256, 65536],
  ["cpu_quota_pct", 10, 1600],
  ["pids_max", 16, 8192],
  ["timeout_s", 5, 7200],
];

/** Suite de la validation, sur la section `executors` en place (`cur`) : un champ avancé absent du POST est conservé, l'image tierce aussi. */
export function configAssainie(nouveau: Dict, cur: unknown, profils: Dict[]): Dict {
  const execUser = stripPy(
    strPy(ouPy(getPy(nouveau, "exec_user", getPy(cur, "exec_user", "10001:10001")), "10001:10001")),
  );
  if (!EXEC_USER_RE.test(execUser))
    throw new HttpError(400, "exec_user doit être au format UID:GID (ex. 10001:10001)");
  const brutSudo = getPy(nouveau, "allow_sudo", getPy(cur, "allow_sudo", true));
  if (typeof brutSudo !== "boolean") throw new HttpError(400, "allow_sudo doit valoir true ou false");
  const sudo = brutSudo;
  if (!sudo && /^0+:/u.test(execUser))
    throw new HttpError(400, "exec_user root refusé : sudo n'est pas permis dans les sandboxes");
  const runtime = prefixePy(
    stripPy(strPy(ouPy(getPy(nouveau, "runtime", getPy(cur, "runtime", "")), ""))),
    64,
  );
  if (runtime && !RUNTIME_RE.test(runtime))
    throw new HttpError(400, "runtime invalide (lettres, chiffres, . _ - uniquement)");
  const brutsExtra = getPy(nouveau, "extra_run_args", ouPy(getPy(cur, "extra_run_args"), []));
  if (!Array.isArray(brutsExtra)) throw new HttpError(400, "extra_run_args doit être une liste de chaînes");
  const extra: string[] = [];
  for (const x of brutsExtra) {
    const s = stripPy(strPy(x));
    if (!s) continue;
    if (longueurPy(s) > 200 || s.includes("\n") || s.includes("\r"))
      throw new HttpError(
        400,
        "extra_run_args : un argument dépasse 200 caractères ou tient sur plusieurs lignes",
      );
    extra.push(s);
  }
  if (extra.length > 32) throw new HttpError(400, "extra_run_args : trop d'arguments (max 32)");
  const refuses = argsRunPermis(extra).refus;
  if (refuses.length > 0) throw new HttpError(400, `extra_run_args refusé : ${refuses.join(", ")}`);
  const limite = (cle: string, defaut: number): number =>
    intPy(getPy(ouPy(getPy(nouveau, "limits"), {}), cle, defaut));
  const limites: Record<string, number> = {
    memory_mb: limite("memory_mb", 2048),
    cpu_quota_pct: limite("cpu_quota_pct", 100),
    pids_max: limite("pids_max", 512),
    timeout_s: limite("timeout_s", 600),
  };
  const assainie: Dict = {
    limits: limites,
    force_user_docker: veritePy(getPy(nouveau, "force_user_docker", false)),
    idle_kill_hours: intPy(getPy(nouveau, "idle_kill_hours", 24)),
    exec_user: execUser,
    runtime,
    extra_run_args: extra,
    allow_sudo: sudo,
    network_profiles: profils,
  };
  const jobs = getPy(nouveau, "jobs", null);
  if (jobs !== null) poserCle(assainie, "jobs", assainirReglagesJobs(jobs));
  else if (estDict(cur) && estDict(getPy(cur, "jobs")))
    poserCle(assainie, "jobs", reglagesJobsDepuis(getPy(cur, "jobs")));
  const disque = getPy(nouveau, "disk", null);
  if (disque !== null) poserCle(assainie, "disk", assainirSeuilsDisque(disque));
  else if (estDict(cur) && estDict(getPy(cur, "disk")))
    poserCle(assainie, "disk", seuilsDisqueDepuis(getPy(cur, "disk")));
  const image = configuredImage(getPy(cur, "image"));
  if (image !== DEFAULT_IMAGE) poserCle(assainie, "image", image);
  for (const [cle, bas, haut] of BORNES) {
    const v = limites[cle] ?? 0;
    if (v < bas || v > haut) throw new HttpError(400, `${cle} doit être entre ${bas} et ${haut}`);
  }
  return assainie;
}

// ── Conteneurs des comptes (relevés par l'hôte d'outils) ─────────────────────────────

/** `_find_stale_network_containers` : conteneurs en marche (relevés par l'hôte d'outils) dont le réseau (`elpis.netcfg`), la version des options (`elpis.spec`), le durcissement (`elpis.durci`) ou, quand `domaines` donne la résolution du moment d'un profil, les adresses épinglées de ses domaines (`elpis.resolved`) ne suivent plus les réglages ; toute erreur → `[]`. */
export async function conteneursPerimes(
  acteur: Acteur | undefined,
  profils: readonly Dict[],
  reglagesDe: (uid: number) => Promise<Dict>,
  profilDe: (reglages: Dict) => string,
  sudo: boolean,
  domaines: Readonly<Record<string, Readonly<Record<string, string[] | null>>>> = {},
): Promise<Dict[]> {
  try {
    const parId = new Map<string, ProfilReseau>(profils.map((p) => [strPy(p["id"]), profilReseauDepuis(p)]));
    const releve = await appelerConsole(acteur, "GET", "/api/internal/sandboxes/running", { delaiS: 30 });
    const lignes = getPy(releve, "containers");
    if (!Array.isArray(lignes)) return [];
    const perimes: Dict[] = [];
    for (const parts of lignes as string[][]) {
      const [
        nomConteneur = "",
        uidTexte = "",
        nomCompte = "",
        brut = "",
        spec = "",
        durci = "",
        resolu = "",
      ] = parts;
      const etiquette = stripPy(brut);
      let uid: number;
      try {
        uid = intPy(uidTexte);
      } catch (e) {
        if (estErreurPython(e, "ValueError")) continue;
        throw e;
      }
      const profil = parId.get(profilDe(await reglagesDe(uid))) ?? parId.get("isolated");
      if (profil === undefined) continue;
      const options = spec === RUN_SPEC && durci === (!sudo || profilFiltre(profil) ? "1" : "0");
      const actuels = domaines[profil.id];
      const adresses =
        profil.mode !== "allowlist_ip" ||
        actuels === undefined ||
        domainesPerimes(domainesEpingles(stripPy(resolu)) ?? {}, actuels).length === 0;
      // Profil protégé : réglages du profil seulement ; les plages de la machine sont relues par la sandbox avant chaque usage.
      const reseau =
        protectionsDe(profil).length === 0
          ? etiquette === netcfgHash(profil)
          : etiquette.startsWith(`${netcfgHash(profil)}-`);
      if (options && adresses && reseau) continue;
      if (options && !etiquette && !profilFiltre(profil)) continue;
      perimes.push({
        user_id: uid,
        username: nomCompte || null,
        container: nomConteneur,
        profile_id: profil.id,
      });
    }
    return perimes;
  } catch {
    return [];
  }
}

/** Comptes et profil réseau de leur sandbox (`profilDe`, celui des conteneurs) avec son origine : imposé, choisi, sinon le profil isolé, qui sert aussi de repli à un profil disparu. */
export function comptesDesProfils(
  comptes: readonly { id: number; username: string; reglages: Dict }[],
  profils: readonly { id: string }[],
  profilDe: (reglages: Dict) => string,
): Dict[] {
  return comptes.map((c) => {
    const voulu = profilDe(c.reglages);
    const connu = profils.some((p) => p.id === voulu);
    let origine = "default";
    if (connu && texteNet(lire(c.reglages, "forced_network_profile_id"))) origine = "forced";
    else if (connu && texteNet(lire(c.reglages, "network_profile_id"))) origine = "chosen";
    return { user_id: c.id, username: c.username, profile_id: connu ? voulu : "isolated", origin: origine };
  });
}

/** Résolutions des domaines pour l'état de la console : gardées `ttlMs`, `simultanees` à la fois au plus, une seule par nom en cours. */
export const reglagesEtatDomaines = { ttlMs: 60_000, simultanees: 2 };
const resolutions = new Map<string, { t: number; v: Promise<string[] | null> }>();
let resolutionsEnCours = 0;
const resolutionsEnAttente: (() => void)[] = [];

/** Pour les tests : résolutions gardées oubliées. */
export function oublierEtatDomaines(): void {
  resolutions.clear();
}

/** Appel sous le plafond de résolutions simultanées ; un créneau libéré passe directement à la suivante en attente. */
async function sousPlafond<T>(f: () => Promise<T>): Promise<T> {
  if (resolutionsEnCours < reglagesEtatDomaines.simultanees) resolutionsEnCours++;
  else await new Promise<void>((r) => resolutionsEnAttente.push(r));
  try {
    return await f();
  } finally {
    const suivante = resolutionsEnAttente.shift();
    if (suivante) suivante();
    else resolutionsEnCours--;
  }
}

/** Adresses du moment d'un domaine : `[]` s'il n'existe pas (ENOTFOUND, ENODATA), `null` sur un échec passager (non gardé). */
function resolution(dom: string, resoudre: (dom: string) => Promise<string[]>): Promise<string[] | null> {
  const t = Date.now();
  for (const [k, e] of resolutions) if (t - e.t >= reglagesEtatDomaines.ttlMs) resolutions.delete(k);
  const connue = resolutions.get(dom);
  if (connue !== undefined) return connue.v;
  const v = sousPlafond(() => resoudre(dom)).catch((e: unknown) => {
    const code = (e as { code?: unknown } | null)?.code;
    return code === "ENOTFOUND" || code === "ENODATA" ? [] : null;
  });
  resolutions.set(dom, { t, v });
  void v.then((ips) => {
    if (ips === null && resolutions.get(dom)?.v === v) resolutions.delete(dom);
  });
  return v;
}

/** Adresses IPv4 du moment des domaines des profils en liste blanche, attendues `delaiMs` au plus, réduites à celles qu'une sandbox créée maintenant épinglerait (`adressesEpinglables`) : par profil puis par domaine, `[]` pour un nom irrésoluble ou sans adresse épinglable, `null` sans réponse à temps. */
export async function etatDomaines(
  profils: readonly ProfilReseau[],
  delaiMs = 3000,
  resoudre: (dom: string) => Promise<string[]> = resoudreIpv4,
  machine: () => Promise<HoteMachine> = () => hostAddressesRecent(),
): Promise<Record<string, Record<string, string[] | null>>> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const echeance = new Promise<null>((r) => (minuteur = setTimeout(() => r(null), delaiMs)));
  const etat: Record<string, Record<string, string[] | null>> = {};
  const attentes: Promise<void>[] = [];
  const avecDomaines = profils.filter((p) => p.mode === "allowlist_ip" && p.domains.length > 0);
  const h = avecDomaines.length > 0 ? await machine().catch(() => null) : null;
  for (const p of avecDomaines) {
    const parDomaine: Record<string, string[] | null> = {};
    etat[p.id] = parDomaine;
    for (const dom of p.domains) {
      parDomaine[dom] = null;
      attentes.push(
        Promise.race([resolution(dom, resoudre), echeance]).then((ips) => {
          parDomaine[dom] = ips === null ? null : adressesEpinglables(ips, p.ips, h).gardees;
        }),
      );
    }
  }
  await Promise.all(attentes);
  clearTimeout(minuteur);
  return etat;
}

/** `GET /api/admin/executors/healthcheck` : démon, image chargée et archive sur disque relevés par l'hôte d'outils, plus l'état de chargement du process ; hôte injoignable : démon tenu pour absent. */
export async function controleSante(acteur: Acteur | undefined, image: string): Promise<Dict> {
  let r: unknown;
  try {
    r = await appelerConsole(
      acteur,
      "GET",
      `/api/internal/sandboxes/health?image=${encodeURIComponent(image)}`,
      {
        delaiS: 30,
      },
    );
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return { daemon_ok: false, error: e.message, hint: INDICE_HOTE };
  }
  if (!estDict(r)) throw new ErreurPython("TypeError", "réponse de l'hôte illisible");
  return r["daemon_ok"] === true ? { ...r, image_load_state: { ...ETAT_CHARGEMENT_IMAGE } } : r;
}

/** `GET /api/admin/sandbox/containers` : conteneurs étiquetés `elpis.user_id` relevés par l'hôte d'outils ; 502 si `docker ps` échoue. */
export async function listerConteneurs(acteur: Acteur | undefined): Promise<Dict> {
  const r = await appelerConsole(acteur, "GET", "/api/internal/sandboxes/containers", { delaiS: 120 });
  if (!estDict(r)) throw new ErreurPython("TypeError", "réponse de l'hôte illisible");
  return r;
}

// ── Cycle de vie : arrêt, destruction, GC ──────────────────────────────────

/** Arrêt ou destruction du conteneur du compte par l'hôte d'outils du relevé (celui qui l'a listé), sous son verrou de cycle de vie. */
export async function actionConteneur(compte: Acteur, action: "stop" | "destroy"): Promise<void> {
  await appelerConsole(undefined, "POST", `/api/internal/sandboxes/${action}`, { delaiS: 150, compte });
}

/** `gc_idle_containers` : l'hôte d'outils arrête les conteneurs dont le `/work` est inactif depuis `idle_kill_hours` ; rend leurs noms, `[]` si l'hôte ne répond pas. */
export async function gcIdleContainers(acteur: Acteur | undefined, idleKillHours: number): Promise<string[]> {
  if (idleKillHours * 3600 <= 0) return [];
  try {
    const r = await appelerConsole(
      acteur,
      "POST",
      `/api/internal/sandboxes/gc?idle_kill_hours=${encodeURIComponent(String(idleKillHours))}`,
      { delaiS: 330 },
    );
    const arretes = getPy(r, "stopped");
    return Array.isArray(arretes) ? arretes.map((n) => strPy(n)) : [];
  } catch (e) {
    if (e instanceof HttpError) return [];
    throw e;
  }
}
