// SPDX-License-Identifier: MIT
/** apps/core/src/administration/executeurs.ts — réglages des bacs à sable vus et validés par la console, conteneurs des comptes par la CLI Docker locale (shared_infra/routes/admin/executors.py, executors/_user_sandbox.py, _image_loader.py). */
import { lstatSync, readdirSync, statSync } from "node:fs";

import {
  adresseIpOuNul,
  decoderUtf8Py,
  ErreurJsonPy,
  ErreurPython,
  estDict,
  estErreurPython,
  getPy,
  HttpError,
  intPy,
  itemPy,
  iterExige,
  longueurPy,
  lowerPy,
  nomTypePy,
  ouPy,
  poserCle,
  prefixePy,
  pyJsonLoads,
  reprPy,
  reseauPy,
  rstripPy,
  splitlinesPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict, Reseau } from "@elpis/commun";
import {
  appelDocker,
  assainirSeuilsDisque,
  configuredImage,
  decoderRemplace,
  DEFAULT_IMAGE,
  DOMAIN_RE,
  findImageArchive,
  labelFilter,
  labelTpl,
  netcfgHash,
  PROFILE_ID_RE,
  profilReseauDepuis,
  seuilsDisqueDepuis,
  sousVerrouDeCycle,
  which,
} from "@elpis/bac";
import type { ProfilReseau } from "@elpis/bac";
import { config, pyJoin } from "@elpis/config";

import { assainirReglagesJobs, reglagesJobsDepuis } from "../jobs/reglages";
import { journal } from "../journal";

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
const INDICE_DEMON =
  "Le daemon Docker n'est pas joignable. Vérifie :\n" +
  "  • sudo systemctl status docker\n" +
  "  • L'utilisateur de l'app a-t-il le droit (groupe docker) ?\n" +
  "  • Le socket /var/run/docker.sock existe-t-il ?";
const log = journal("sandbox");
/** Délais des appels Docker du Python (ms), réglables par les tests. */
export const delaisDocker = {
  version: 10_000,
  image: 10_000,
  ps: 15_000,
  stop: 15_000,
  rm: 20_000,
  inspect: 5_000,
};

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
      jobs: reglagesJobsDepuis(getPy(bloc, "jobs")),
      disk: seuilsDisqueDepuis(getPy(bloc, "disk")),
    },
    image: configuredImage(getPy(bloc, "image")),
  };
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
    if (adresseIpOuNul(ip) === null)
      throw new HttpError(400, `Profil ${p} : résolveur DNS invalide ${reprPy(ip)} (IP attendue)`);
  if (dns.length > 4) throw new HttpError(400, `Profil ${p} : trop de résolveurs (max 4)`);
  return ports;
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
    if (mode === "allowlist_ip")
      ports = validerListeBlanche(pid, ips, domaines, portsBruts, dns, avertissements);
    else [ips, domaines, dns] = [[], [], []];
    sortie.push({
      id: pid,
      name: nom,
      mode,
      ips,
      domains: domaines,
      ports,
      dns,
      description: prefixePy(texteNettoye(getPy(p, "description")), 200),
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
    throw new HttpError(400, "exec_user doit être au format UID:GID (ex. 10001:10001 ; 0:0 = root)");
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
      throw new HttpError(400, `extra_run_args : argument invalide ${reprPy(prefixePy(s, 40))}`);
    extra.push(s);
  }
  if (extra.length > 32) throw new HttpError(400, "extra_run_args : trop d'arguments (max 32)");
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

// ── Conteneurs des comptes (CLI Docker locale) ─────────────────────────────

/** `_find_stale_network_containers` : conteneurs en marche dont l'étiquette `elpis.netcfg` ne suit plus le profil du compte ; toute erreur → `[]`. */
export async function conteneursPerimes(
  profils: readonly Dict[],
  reglagesDe: (uid: number) => Promise<Dict>,
  profilDe: (reglages: Dict) => string,
): Promise<Dict[]> {
  try {
    const parId = new Map<string, ProfilReseau>(profils.map((p) => [strPy(p["id"]), profilReseauDepuis(p)]));
    const format =
      `{{.Names}}\t${labelTpl("user_id", true)}\t${labelTpl("username", true)}\t` + labelTpl("netcfg", true);
    const r = await appelDocker(["ps", ...labelFilter("user_id"), "--format", format], delaisDocker.ps);
    if (r.delaiDepasse || r.code !== 0) return [];
    const perimes: Dict[] = [];
    for (const ligne of splitlinesPy(decoderRemplace(r.sortie))) {
      const parts = ligne.split("\t");
      if (parts.length < 4) continue;
      const [nomConteneur = "", uidTexte = "", nomCompte = "", brut = ""] = parts;
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
      if (etiquette === netcfgHash(profil)) continue;
      if (!etiquette && profil.mode !== "allowlist_ip") continue;
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

/** `GET /api/admin/executors/healthcheck` : démon (10 s), image chargée (10 s), archive sur disque, état de chargement du process. */
export async function controleSante(image: string): Promise<Dict> {
  const r = await appelDocker(["version", "--format", "{{.Server.Version}}"], delaisDocker.version);
  if (r.delaiDepasse)
    return {
      daemon_ok: false,
      error: "Timeout — le daemon Docker ne répond pas",
      hint: "Vérifie : sudo systemctl status docker",
    };
  if (r.code !== 0)
    return {
      daemon_ok: false,
      error: prefixePy(stripPy(decoderRemplace(r.erreur)).split("\n")[0] ?? "", 300),
      hint: INDICE_DEMON,
    };
  const version = stripPy(decoderUtf8Py(r.sortie));
  const r2 = await appelDocker(["image", "inspect", image], delaisDocker.image);
  const chargee = !r2.delaiDepasse && r2.code === 0;
  const archive = chargee ? null : findImageArchive(image);
  return {
    daemon_ok: true,
    server_version: version,
    image,
    image_loaded: chargee,
    archive_available: archive !== null,
    archive_path: archive,
    image_load_state: { ...ETAT_CHARGEMENT_IMAGE },
  };
}

const FORMAT_PS =
  '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}",' +
  '"state":"{{.State}}","status":"{{.Status}}","created":"{{.CreatedAt}}"}';

/** `GET /api/admin/sandbox/containers` : conteneurs étiquetés `elpis.user_id`, compte relu par `docker inspect` ; 502 si `docker ps` échoue. */
export async function listerConteneurs(): Promise<Dict> {
  const r = await appelDocker(
    ["ps", "-a", ...labelFilter("user_id"), "--format", FORMAT_PS],
    delaisDocker.ps,
  );
  if (r.delaiDepasse) throw new HttpError(502, "docker ps timeout");
  if (r.code !== 0) throw new HttpError(502, prefixePy(stripPy(decoderRemplace(r.erreur)), 300));
  const conteneurs: unknown[] = [];
  for (const brute of splitlinesPy(decoderUtf8Py(r.sortie))) {
    const ligne = stripPy(brute);
    if (!ligne) continue;
    let c: unknown;
    try {
      c = pyJsonLoads(ligne);
    } catch (e) {
      if (e instanceof ErreurJsonPy) continue;
      throw e;
    }
    const nom = itemPy(c, "name");
    if (typeof nom !== "string")
      throw new ErreurPython("TypeError", `expected str, bytes or os.PathLike object, not ${nomTypePy(nom)}`);
    const ri = await appelDocker(
      ["inspect", "--format", `${labelTpl("user_id")}|${labelTpl("username")}`, nom],
      null,
    );
    const etiquette = stripPy(decoderUtf8Py(ri.sortie));
    const i = etiquette.indexOf("|");
    const [uidTexte, nomCompte] = i < 0 ? [etiquette, ""] : [etiquette.slice(0, i), etiquette.slice(i + 1)];
    let uid: number | null;
    try {
      uid = intPy(uidTexte);
    } catch (e) {
      if (!estErreurPython(e, "ValueError")) throw e;
      uid = null;
    }
    poserCle(c as Dict, "user_id", uid);
    poserCle(c as Dict, "username", nomCompte || null);
    conteneurs.push(c);
  }
  return { containers: conteneurs, count: conteneurs.length };
}

// ── Cycle de vie : arrêt, destruction, GC ──────────────────────────────────

/** `UserSandbox.stop()` / `destroy()` : la commande Docker sous le verrou de cycle de vie, son résultat ignoré (124 au délai). */
export async function actionConteneur(
  uid: number,
  conteneur: string,
  action: "stop" | "destroy",
): Promise<void> {
  const args = action === "stop" ? ["stop", "-t", "5", conteneur] : ["rm", "-fv", conteneur];
  await sousVerrouDeCycle(uid, () =>
    appelDocker(args, action === "stop" ? delaisDocker.stop : delaisDocker.rm),
  );
}

/** Dernière activité du `/work` d'un compte : mtime du dossier et des journaux de `.bg/` (liens non suivis) ; 0 si illisible. */
function derniereActivite(travail: string): number {
  let dernier: number;
  try {
    dernier = statSync(travail).mtimeMs / 1000;
  } catch {
    dernier = 0;
  }
  try {
    const bg = pyJoin(travail, ".bg");
    if (statSync(bg).isDirectory() && !lstatSync(bg).isSymbolicLink()) {
      for (const nom of readdirSync(bg)) {
        try {
          dernier = Math.max(dernier, lstatSync(pyJoin(bg, nom)).mtimeMs / 1000);
        } catch {
          continue;
        }
      }
    }
  } catch {
    // dossier .bg absent ou illisible
  }
  return dernier;
}

/** `gc_idle_containers` : arrête les conteneurs dont le `/work` est inactif depuis `idle_kill_hours` ; rend leurs noms. */
export async function gcIdleContainers(
  idleKillHours: number,
  maintenant = Date.now() / 1000,
): Promise<string[]> {
  if (which("docker") === null) return [];
  const seuil = idleKillHours * 3600;
  if (seuil <= 0) return [];
  const r = await appelDocker(["ps", ...labelFilter("user_id"), "--format", "{{.Names}}"], delaisDocker.ps);
  if (r.delaiDepasse || r.code !== 0) return [];
  const arretes: string[] = [];
  for (const brut of splitlinesPy(decoderUtf8Py(r.sortie))) {
    const nom = stripPy(brut);
    if (!nom) continue;
    const r2 = await appelDocker(["inspect", "--format", labelTpl("username"), nom], delaisDocker.inspect);
    if (r2.delaiDepasse || r2.code !== 0) continue;
    const compte = stripPy(decoderUtf8Py(r2.sortie));
    const dernier = derniereActivite(pyJoin(pyJoin(config.SANDBOX_DIR, compte), "work"));
    if (maintenant - dernier > seuil) {
      await appelDocker(["stop", "-t", "5", nom], delaisDocker.stop);
      arretes.push(nom);
      log.info(`[sandbox-gc] container stoppé (idle ${Math.trunc(maintenant - dernier)}s) : ${nom}`);
    }
  }
  return arretes;
}
