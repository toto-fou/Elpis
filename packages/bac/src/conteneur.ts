// SPDX-License-Identifier: MIT
/** packages/bac/src/conteneur.ts — conteneur Docker persistant d'un compte (executors/_user_sandbox.py) : options de lancement, création, réconciliations, arrêt, purge, agent et exec. */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";

import {
  comparePointsDeCode,
  decoderUtf8,
  estChiffresPy,
  fixePy,
  intPy,
  getPy,
  journalDe,
  lowerPy,
  messageErreurOs,
  ouPy,
  prefixePy,
  pyJsonLoads,
  splitPy,
  stripPy,
  suffixePy,
} from "@elpis/commun";
import { config, configView, pyJoin, pyParent, pyPath, realpathPy, safeSandboxName } from "@elpis/config";

import { erreurAgent, fabriqueAgent } from "./agent";
import type { AgentBac, BacPourAgent, EtatBac } from "./agent";
import { CaptureBornee, execCaptureMaxBytes } from "./capture";
import { ensureImageLoaded } from "./chargeur-image";
import type { ImageLoadState } from "./chargeur-image";
import { DockerCli } from "./cli";
import type { CliDocker, ReponseDocker } from "./cli";
import { sousVerrouDeCycle } from "./cycle";
import { getReadinessCache } from "./disponibilite";
import { containerName, decoderRemplace, label, labelTpl } from "./docker";
import { configuredImage } from "./image";
import {
  AGENT_MOUNT,
  AGENT_RUN_DIR,
  AGENT_SOCKET,
  agentDir,
  agentEmpreinte,
  RELAY_DIR,
  RELAY_MOUNT,
} from "./montages";
import * as privdrop from "./privdrop";
import { configBacDepuis, netcfgHash, profilParId } from "./profils";
import type { Avertir, ConfigBac, ProfilReseau } from "./profils";
import { MODES_MARKER, PERMS_MARKER_LEGACY } from "./travail";

/** Seules capacités du conteneur (`--cap-drop ALL` puis celles-ci), mesurées sur l'image. */
export const CAPABILITIES: readonly string[] = [
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
/** Version des options de `docker run` qui touchent à la sécurité (étiquette `elpis.spec`) ; la changer recrée les conteneurs. */
export const RUN_SPEC = "6";
const FORMAT_STATUT = "{{.Id}}|{{.Name}}|{{.State.Running}}|{{.Config.Image}}|{{.State.StartedAt}}";
const FORMAT_STATS =
  '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","mem_pct":"{{.MemPerc}}",' + '"pids":"{{.PIDs}}"}';
const SCRIPT_DROITS =
  'chown "$1" /work && chmod 0755 /work || exit 1; ' +
  '[ "$2" = 1 ] || exit 0; chown -R "$1" /work && chmod -R go-w /work';
/** `timeout -k 5` dans son groupe (stdin gardé, INT/QUIT non ignorés) ; à l'échéance, le groupe et les processus marqués `ELPIS_EXEC_ID` (sortis par setsid ou setpgid) ont 5 s puis sont tués ; `$0` (autre que `--`) impose l'identifiant, que l'hôte retrouve pour tuer cet exec à l'abandon. */
export const ENVELOPPE_EXEC =
  'umask 0022; t="$1"; shift; exec 3<&0; u=$$; read -r u </proc/sys/kernel/random/uuid 2>/dev/null; [ "$0" = -- ] || u="$0"; ' +
  'env --default-signal=INT,QUIT ELPIS_EXEC_ID="$u" timeout -k 5 "$t" "$@" <&3 3<&- & p=$!; exec 3<&-; ' +
  'wait "$p" 2>/dev/null; rc=$?; if [ "$rc" -eq 124 ]; then ' +
  'm() { grep -lsxzF "ELPIS_EXEC_ID=$u" /proc/[0-9]*/environ | sed "s,^/proc/,,;s,/.*,,"; }; ' +
  'k=$(m); [ -z "$k" ] || kill -TERM $k 2>/dev/null; n=0; ' +
  'while [ "$n" -lt 5 ] && { kill -0 "-$p" 2>/dev/null || [ -n "$(m)" ]; }; do sleep 1; n=$((n + 1)); done; ' +
  'kill -KILL "-$p" $(m) 2>/dev/null; fi; exit "$rc"';

/** Tue les processus marqués `ELPIS_EXEC_ID=$1` (une retentative après 1 s si l'exec n'a pas encore démarré) : TERM, 5 s de grâce, puis KILL ; `timeout` relaie TERM à son groupe. */
export const SCRIPT_TUER_EXEC =
  'u="$1"; m() { grep -lsxzF "ELPIS_EXEC_ID=$u" /proc/[0-9]*/environ | sed "s,^/proc/,,;s,/.*,,"; }; ' +
  'k=$(m); [ -n "$k" ] || { sleep 1; k=$(m); }; [ -n "$k" ] || exit 0; kill -TERM $k 2>/dev/null; n=0; ' +
  'while [ "$n" -lt 5 ] && [ -n "$(m)" ]; do sleep 1; n=$((n + 1)); done; kill -KILL $(m) 2>/dev/null; exit 0';

/** Délais et attentes du Python, réglables par les tests. */
export const reglagesBac = {
  /** Recréation reportée faute d'image : délai avant de réessayer (s). */
  configRetryS: 60,
  /** Attente après `docker run` avant de vérifier que l'entrypoint tient (ms). */
  attenteCreationMs: 800,
  /** Attente de la fin d'un `docker exec` tué (ms). */
  attenteTueMs: 2_000,
  /** Délai de l'appel qui tue dans le conteneur les processus d'un exec abandonné (s) : 1 s de retentative, 5 s de grâce, marge. */
  tuerExecS: 15,
};

/** `SandboxAdminConfig` : `ConfigBac` et l'image effective. */
export type ConfigSandbox = ConfigBac & { image: string };

/** `SandboxAdminConfig.from_dict` (image comprise). */
export function sandboxAdminConfigDepuis(brut: unknown, avertir?: Avertir): ConfigSandbox {
  const d = ouPy(brut, {});
  const image = configuredImage(getPy(d, "image"));
  return { image, ...(avertir ? configBacDepuis(brut, avertir) : configBacDepuis(brut)) };
}

/** `load_admin_config` : section `executors` de config.json, relue à chaque appel. */
export function loadAdminConfig(): ConfigSandbox {
  return sandboxAdminConfigDepuis(ouPy(getPy(configView(), "executors"), {}));
}

/** `resolve_network_profile_id` : imposition de l'admin, sinon choix du compte, sinon « isolated ». */
export function resolveNetworkProfileIdReglages(reglages: unknown): string {
  const s = ouPy(reglages, {});
  const force = stripPy(String(ouPy(getPy(s, "forced_network_profile_id"), "")));
  return force || stripPy(String(ouPy(getPy(s, "network_profile_id"), ""))) || "isolated";
}

/** `ExecError` : panne d'infrastructure (démon, image, démarrage), avec les journaux du conteneur s'il a planté. */
export class ExecError extends Error {
  readonly containerLogs: string | null;

  constructor(message: string, containerLogs: string | null = null) {
    super(message);
    this.name = "ExecError";
    this.containerLogs = containerLogs;
  }
}

export interface ExecResult {
  returncode: number;
  stdout: Buffer;
  stderr: Buffer;
  duration_s: number;
  timed_out: boolean;
  executor_tag: string;
  container_id: string | null;
}

export interface OptionsExec {
  readonly workdirInContainer?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: Buffer;
  readonly timeoutS?: number | null;
  /** `on_chunk(flux, octets)` à chaque paquet lu ; une exception y est ignorée. */
  readonly onChunk?: (flux: "stdout" | "stderr", data: Buffer) => void;
  readonly signal?: AbortSignal;
}

export type ChargeurImage = (
  image: string,
  options: { blocking?: boolean; signal?: AbortSignal },
) => Promise<ImageLoadState>;
export type ResolveurDomaines = (profil: ProfilReseau) => Promise<Record<string, string[]>>;

export interface OptionsUserSandbox {
  readonly cli?: CliDocker;
  readonly chargerImage?: ChargeurImage;
  readonly resoudreDomaines?: ResolveurDomaines;
}

function etat(champs: Partial<EtatBac> & { exists: boolean; running: boolean }): EtatBac {
  return {
    container_id: null,
    container_name: null,
    image: null,
    started_at: null,
    error: null,
    ...champs,
  };
}

function estAnnulation(e: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && e === signal.reason;
}

function erreurOs(e: unknown): boolean {
  return typeof (e as { syscall?: unknown } | null)?.syscall === "string";
}

/** `resolve_profile_domains` : domaines du profil en IPv4 triées (au mieux : un domaine irrésoluble est ignoré). */
export async function resolveProfileDomains(profil: ProfilReseau): Promise<Record<string, string[]>> {
  const resolus: Record<string, string[]> = {};
  for (const dom of profil.domains) {
    try {
      const adresses = await lookup(dom, { family: 4, all: true });
      const ips = [...new Set(adresses.map((a) => a.address))].sort(comparePointsDeCode);
      if (ips.length > 0) resolus[dom] = ips;
    } catch (e) {
      journalDe("sandbox").warn(
        `[sandbox] profil ${profil.id} : domaine '${dom}' irrésoluble (${(e as Error).message}) — ignoré`,
      );
    }
  }
  return resolus;
}

/** `_racine_privee` : racine des bacs réservée au compte de service (0700). */
export function racinePrivee(racine: string): void {
  try {
    mkdirSync(racine, { recursive: true, mode: 0o700 });
    const st = statSync(racine);
    if (st.uid === process.getuid?.() && st.mode & 0o077) chmodSync(racine, 0o700);
  } catch (e) {
    journalDe("sandbox").warn(`[sandbox] ${racine} : droits non restreints (${(e as Error).message})`);
  }
}

/** `Path(SANDBOX_DIR) in sandbox_path.parents`, lexical. */
function sousRacine(chemin: string, racine: string): boolean {
  const r = pyPath(racine);
  for (let p = pyParent(pyPath(chemin)), avant = ""; p !== avant; avant = p, p = pyParent(p)) {
    if (p === r) return true;
  }
  return false;
}

export class UserSandbox implements BacPourAgent {
  readonly userId: number;
  readonly username: string;
  readonly sandboxPath: string;
  cfg: ConfigSandbox;
  networkProfileId: string | null;
  mountVerified = false;
  modesVerified = false;
  configVerified = false;
  configRetryAt = 0;
  recreationReportee = "";
  private agentClient: AgentBac | null = null;
  readonly cli: CliDocker;
  private readonly chargerImage: ChargeurImage;
  private readonly resoudreDomaines: ResolveurDomaines;

  constructor(
    userId: number,
    username: string | null,
    sandboxPath: string,
    cfg?: ConfigSandbox | null,
    networkProfileId?: string | null,
    options: OptionsUserSandbox = {},
  ) {
    this.userId = userId;
    this.username = safeSandboxName(username);
    this.sandboxPath = sandboxPath;
    this.cfg = cfg ?? loadAdminConfig();
    this.networkProfileId = networkProfileId ?? null;
    this.cli = options.cli ?? new DockerCli();
    this.chargerImage = options.chargerImage ?? ensureImageLoaded;
    this.resoudreDomaines = options.resoudreDomaines ?? resolveProfileDomains;
  }

  get containerName(): string {
    return containerName(this.username);
  }

  /** Profil réseau actif (résolu à chaque accès). */
  get networkProfile(): ProfilReseau {
    return profilParId(this.cfg, this.networkProfileId || "isolated");
  }

  private appel(args: readonly string[], timeoutS: number, signal?: AbortSignal): Promise<ReponseDocker> {
    return this.cli.call(args, { timeoutS, ...(signal ? { signal } : {}) });
  }

  async status(signal?: AbortSignal): Promise<EtatBac> {
    const [rc, out] = await this.appel(
      ["container", "inspect", this.containerName, "--format", FORMAT_STATUT],
      10,
      signal,
    );
    const absent = etat({ exists: false, running: false, container_name: this.containerName });
    if (rc !== 0) return absent;
    const ligne = stripPy(decoderRemplace(out));
    if (!ligne) return absent;
    const [cid = "", nom = "", enMarche = "", image = "", debut = ""] = [
      ...ligne.split("|"),
      "",
      "",
      "",
      "",
      "",
    ];
    return etat({
      exists: true,
      running: lowerPy(enMarche) === "true",
      container_id: cid,
      container_name: nom.replace(/^\/+/u, ""),
      image,
      started_at: debut || null,
    });
  }

  /** IP du conteneur sur son réseau Docker ; `null` sans conteneur, arrêté ou isolé. */
  async containerIp(): Promise<string | null> {
    const [rc, out] = await this.appel(
      [
        "container",
        "inspect",
        this.containerName,
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
      ],
      10,
    );
    if (rc !== 0) return null;
    return splitPy(decoderRemplace(out))[0] ?? null;
  }

  private async workMountMatches(signal?: AbortSignal): Promise<boolean> {
    const [rc, out] = await this.appel(
      [
        "inspect",
        "--format",
        '{{range .Mounts}}{{if eq .Destination "/work"}}{{.Source}}{{end}}{{end}}',
        this.containerName,
      ],
      5,
      signal,
    );
    if (rc !== 0) return true;
    const source = stripPy(decoderRemplace(out));
    if (!source) return true;
    try {
      return realpathPy(source) === realpathPy(this.sandboxPath);
    } catch {
      return true;
    }
  }

  private async reconcileWorkMount(st: EtatBac, signal?: AbortSignal): Promise<EtatBac> {
    this.mountVerified = true;
    if (await this.workMountMatches(signal)) return st;
    journalDe("sandbox").info(
      `[sandbox] ${this.containerName} : /work montait l'ancienne arbo plate → recréation sur ${this.sandboxPath}`,
    );
    return sousVerrouDeCycle(
      this.userId,
      async () => {
        const cur = await this.status(signal);
        if (cur.running && !(await this.workMountMatches(signal))) {
          await this.appel(["rm", "-fv", this.containerName], 10, signal);
          await this.create(signal);
        }
        return this.status(signal);
      },
      signal,
    );
  }

  /** `_config_matches` : options de lancement, image, agent et config réseau du conteneur à jour ; vrai sur incertitude. */
  async configMatches(signal?: AbortSignal): Promise<boolean> {
    const profil = this.networkProfile;
    const format = [labelTpl("netcfg"), labelTpl("spec"), "{{.Config.Image}}", labelTpl("agent")].join("|");
    const [rc, out] = await this.appel(["inspect", "--format", format, this.containerName], 5, signal);
    if (rc !== 0) return true;
    const [cur = "", spec = "", image = "", agent = ""] = [
      ...stripPy(decoderRemplace(out)).split("|"),
      "",
      "",
      "",
    ];
    if (spec !== RUN_SPEC || (image && image !== this.cfg.image) || !["", agentEmpreinte()].includes(agent))
      return false;
    if (!cur || cur === "<no value>") return profil.mode !== "allowlist_ip";
    return cur === netcfgHash(profil);
  }

  /** `_stale` : à recréer, et l'image configurée disponible ; sinon recréation reportée (message gardé). */
  private async stale(signal?: AbortSignal): Promise<boolean> {
    if (await this.configMatches(signal)) {
      this.recreationReportee = "";
      return false;
    }
    try {
      await this.ensureImage(signal);
    } catch (e) {
      if (!(e instanceof ExecError)) throw e;
      journalDe("sandbox").warn(
        `[sandbox] ${this.containerName} : options périmées, recréation reportée (${e.message})`,
      );
      this.configVerified = false;
      this.configRetryAt = performance.now() / 1000 + reglagesBac.configRetryS;
      this.recreationReportee =
        `image ${this.cfg.image} absente : le conteneur de la sandbox date d'une ` +
        "version précédente et ne peut pas encore être recréé (fichiers, éditeur et " +
        "git indisponibles). Construisez l'image (./install.sh --sandbox build) ou " +
        "chargez son archive (deploy/docker/sandbox/load_image.sh), puis relancez.";
      return false;
    }
    this.recreationReportee = "";
    return true;
  }

  private async reconcileConfig(st: EtatBac, signal?: AbortSignal): Promise<EtatBac> {
    this.configVerified = true;
    try {
      if (!(await this.stale(signal))) return st;
    } catch (e) {
      if (estAnnulation(e, signal)) this.configVerified = false;
      throw e;
    }
    journalDe("sandbox").info(
      `[sandbox] ${this.containerName} : options de lancement ou config réseau (profil '${this.networkProfileId || "isolated"}') périmées → recréation`,
    );
    return sousVerrouDeCycle(
      this.userId,
      async () => {
        const cur = await this.status(signal);
        if (cur.running && (await this.stale(signal))) {
          await this.appel(["rm", "-fv", this.containerName], 10, signal);
          await this.create(signal);
        }
        return this.status(signal);
      },
      signal,
    );
  }

  /** `_reconcile_work_modes` : /work à l'UID du conteneur (0755) une fois par processus, tout l'arbre une fois par compte et par propriétaire. */
  private async reconcileWorkModes(signal?: AbortSignal): Promise<void> {
    if (this.modesVerified) return;
    this.modesVerified = true;
    const marqueur = pyJoin(pyParent(this.sandboxPath), MODES_MARKER);
    const proprietaire = this.cfg.exec_user || "10001:10001";
    let faitPour = "";
    try {
      faitPour = stripPy(decoderUtf8(readFileSync(marqueur)));
    } catch (e) {
      if (!erreurOs(e)) throw e;
    }
    const tout = faitPour !== proprietaire;
    try {
      const [rc, , err] = await this.appel(
        [
          "exec",
          "-u",
          "0:0",
          this.containerName,
          "sh",
          "-c",
          SCRIPT_DROITS,
          "--",
          proprietaire,
          tout ? "1" : "0",
        ],
        tout ? 600 : 30,
        signal,
      );
      if (rc !== 0) {
        journalDe("sandbox").warn(
          `[sandbox] droits de /work non repris (${this.containerName}, rc=${rc}) : ${err.length ? prefixePy(decoderRemplace(err), 200) : ""}`,
        );
      } else if (tout) {
        try {
          writeFileSync(marqueur, proprietaire, "utf-8");
        } catch {
          // marqueur non écrit : le processus suivant refait l'arbre
        }
        for (const ancien of PERMS_MARKER_LEGACY) {
          try {
            unlinkSync(pyJoin(pyParent(marqueur), ancien));
          } catch {
            // absent
          }
        }
      }
    } catch (e) {
      if (estAnnulation(e, signal)) {
        this.modesVerified = false;
        throw e;
      }
      journalDe("sandbox").warn(
        `[sandbox] droits de /work non repris (${this.containerName}) : ${(e as Error).message}`,
      );
    }
  }

  /** `daemon_reachable` : (vrai, version du serveur) ou (faux, première ligne de l'erreur). */
  async daemonReachable(): Promise<[boolean, string]> {
    const [rc, out, err] = await this.appel(["version", "--format", "{{.Server.Version}}"], 5);
    if (rc === 0) return [true, stripPy(decoderUtf8(out))];
    return [false, stripPy(decoderRemplace(err)).split("\n")[0] ?? ""];
  }

  /** `ensure_running` : en marche, créé ou redémarré ; création sérialisée par compte (verrou de cycle de vie). */
  async ensureRunning(signal?: AbortSignal): Promise<EtatBac> {
    const cache = getReadinessCache();
    if (this.mountVerified && this.configVerified && cache.confirmedRunning(this.containerName))
      return etat({ exists: true, running: true, container_name: this.containerName });
    let st = await this.status(signal);
    if (st.running) {
      if (!this.mountVerified) st = await this.reconcileWorkMount(st, signal);
      if (st.running && !this.configVerified && performance.now() / 1000 >= this.configRetryAt)
        st = await this.reconcileConfig(st, signal);
      if (st.running) {
        await this.reconcileWorkModes(signal);
        cache.recordRunning(this.containerName);
      }
      return st;
    }
    return sousVerrouDeCycle(
      this.userId,
      async () => {
        const cur = await this.status(signal);
        if (cur.running) {
          await this.reconcileWorkModes(signal);
          cache.recordRunning(this.containerName);
          return cur;
        }
        const res = await this.ensureRunningLocked(cur, signal);
        if (res.running) {
          await this.reconcileWorkModes(signal);
          cache.recordRunning(this.containerName);
        }
        return res;
      },
      signal,
    );
  }

  /** `_ensure_running_locked` : conteneur arrêté redémarré (137/143 sans OOM = arrêt, pas un crash), sinon recréé ; absent : créé. */
  async ensureRunningLocked(st: EtatBac, signal?: AbortSignal): Promise<EtatBac> {
    if (st.exists) {
      const [rcInspect, outInspect] = await this.appel(
        ["inspect", "--format", "{{.State.ExitCode}}|{{.State.OOMKilled}}", this.containerName],
        5,
        signal,
      );
      let oom = false;
      let exitCode: number;
      try {
        const texte = stripPy(decoderUtf8(outInspect));
        const i = texte.indexOf("|");
        const code = i < 0 ? texte : texte.slice(0, i);
        const reste = i < 0 ? "" : texte.slice(i + 1);
        exitCode = rcInspect === 0 ? intPy(code) : -1;
        oom = lowerPy(stripPy(reste)) === "true";
      } catch (e) {
        if (!(e instanceof Error) || e.name !== "ValueError") throw e;
        exitCode = -1;
      }
      if ((exitCode === 137 || exitCode === 143) && !oom) exitCode = 0;
      const perime = exitCode === 0 && (await this.stale(signal));
      if (exitCode !== 0 || perime) {
        journalDe("sandbox").info(
          `[sandbox] container ${this.containerName} en état exited (code=${exitCode}${perime ? ", options périmées" : ""}) → destroy + recreate`,
        );
        await this.appel(["rm", "-fv", this.containerName], 10, signal);
        await this.create(signal);
      } else {
        const [rc, , err] = await this.appel(["start", this.containerName], 15, signal);
        if (rc !== 0) {
          journalDe("sandbox").warn(
            `[sandbox ${this.containerName}] start KO, recreate: ${decoderRemplace(err)}`,
          );
          await this.appel(["rm", "-f", this.containerName], 10, signal);
          await this.create(signal);
        }
      }
    } else {
      await this.create(signal);
    }
    return this.status(signal);
  }

  /** `_build_run_args` : argv de `docker run`, pur (les domaines sont résolus par l'appelant). */
  buildRunArgs(
    profil: ProfilReseau,
    resolus: Readonly<Record<string, readonly string[]>> | null = null,
  ): string[] {
    const args = [
      "run",
      "-d",
      "--init",
      "--name",
      this.containerName,
      "--label",
      label("user_id", String(this.userId)),
      "--label",
      label("username", this.username),
      "--security-opt",
      "no-new-privileges:false",
      "--cap-drop",
      "ALL",
      ...CAPABILITIES.flatMap((cap) => ["--cap-add", cap]),
      "--tmpfs",
      "/run:rw,size=10m,mode=755",
      "--shm-size",
      "1g",
      "--memory",
      `${this.cfg.memory_mb}m`,
      "--cpus",
      fixePy(this.cfg.cpu_quota_pct / 100, 2),
      "--pids-limit",
      String(this.cfg.pids_max),
      "-e",
      "HOME=/work",
      "-e",
      "LANG=C.UTF-8",
      "-e",
      "LC_ALL=C.UTF-8",
      "-e",
      "TZ=UTC",
      "-e",
      "MOZ_HEADLESS=1",
      "-v",
      `${this.sandboxPath}:/work:rw`,
      "-v",
      `${pyJoin(pyParent(this.sandboxPath), AGENT_RUN_DIR)}:/run/elpis:rw`,
      "-v",
      `${agentDir()}:${AGENT_MOUNT}:ro`,
      "-v",
      `${pyJoin(pyParent(pyParent(this.sandboxPath)), RELAY_DIR)}:${RELAY_MOUNT}:ro`,
      "--workdir",
      "/work",
    ];
    if (this.cfg.runtime) args.splice(2, 0, "--runtime", this.cfg.runtime);
    args.push(
      "--label",
      label("netcfg", netcfgHash(profil)),
      "--label",
      label("spec", RUN_SPEC),
      "--label",
      label("agent", agentEmpreinte()),
    );
    if (profil.mode === "none") args.push("--network", "none");
    else if (profil.mode === "allowlist_ip") {
      args.push("--cap-add", "NET_ADMIN");
      const r = resolus ?? {};
      const permis: string[] = profil.ips.map((x) => x as string);
      for (const dom of profil.domains) {
        const ips = Object.hasOwn(r, dom) ? [...(r[dom] ?? [])] : [];
        permis.push(...ips);
        if (ips.length > 0) args.push("--add-host", `${dom}:${ips[0]}`);
      }
      permis.push(...profil.dns);
      const vus = new Set<string>();
      const uniques = permis.filter((x) => !vus.has(x) && vus.add(x) !== undefined);
      args.push("-e", `ELPIS_ALLOWLIST=${uniques.join(" ")}`);
      if (profil.ports.length > 0) args.push("-e", `ELPIS_ALLOWLIST_PORTS=${profil.ports.join(",")}`);
      if (profil.dns.length > 0) {
        args.push("-e", `ELPIS_DNS=${profil.dns.join(" ")}`);
        for (const ip of profil.dns) args.push("--dns", ip);
      }
    }
    for (const a of this.cfg.extra_run_args) args.push(a);
    args.push(this.cfg.image, "sleep", "infinity");
    return args;
  }

  /** `_ensure_image` : image présente, sinon chargée depuis son archive ; `ExecError` si elle reste indisponible. */
  private async ensureImage(signal?: AbortSignal): Promise<void> {
    const [rc] = await this.appel(["image", "inspect", this.cfg.image], 10, signal);
    if (rc === 0) return;
    const st = await this.chargerImage(this.cfg.image, { blocking: true, ...(signal ? { signal } : {}) });
    if (st.status === "loading")
      throw new ExecError(
        `Le chargement de l'image '${this.cfg.image}' est toujours en cours (${st.progress_msg}). Réessayez dans quelques instants.`,
      );
    if (st.status !== "loaded")
      throw new ExecError(`Image '${this.cfg.image}' indisponible. ${st.error || st.progress_msg}`);
  }

  /** `_create` : idempotent face à une création concurrente ; journaux du conteneur rendus si l'entrypoint plante. */
  private async create(signal?: AbortSignal): Promise<void> {
    const pre = await this.status(signal);
    if (pre.running) return;
    if (pre.exists) await this.appel(["rm", "-fv", this.containerName], 10, signal);
    await this.ensureImage(signal);
    if (sousRacine(this.sandboxPath, config.SANDBOX_DIR)) racinePrivee(config.SANDBOX_DIR);
    mkdirSync(this.sandboxPath, { recursive: true });
    const dossierAgent = pyJoin(pyParent(this.sandboxPath), AGENT_RUN_DIR);
    try {
      if (!existsSync(dossierAgent) || !statSync(dossierAgent).isDirectory()) mkdirSync(dossierAgent);
      chmodSync(dossierAgent, 0o777);
    } catch (e) {
      throw new ExecError(`Dossier de l'agent ${dossierAgent} : ${messageErreurOs(e, dossierAgent)}`);
    }
    const dossierRelais = pyJoin(pyParent(pyParent(this.sandboxPath)), RELAY_DIR);
    try {
      if (!existsSync(dossierRelais) || !statSync(dossierRelais).isDirectory())
        mkdirSync(dossierRelais, { mode: 0o755 });
    } catch (e) {
      throw new ExecError(`Dossier du relais Git ${dossierRelais} : ${messageErreurOs(e, dossierRelais)}`);
    }
    const profil = this.networkProfile;
    let resolus: Record<string, string[]> = {};
    if (profil.mode === "allowlist_ip" && profil.domains.length > 0) {
      try {
        resolus = await this.resoudreDomaines(profil);
      } catch (e) {
        journalDe("sandbox").warn(
          `[sandbox] résolution domaines profil ${profil.id} KO : ${(e as Error).message}`,
        );
      }
    }
    const [rc, , err] = await this.appel(this.buildRunArgs(profil, resolus), 60, signal);
    if (rc !== 0) {
      const texte = stripPy(decoderRemplace(err));
      if (lowerPy(texte).includes("already in use")) {
        const st = await this.status(signal);
        if (st.running) {
          journalDe("sandbox").info(
            `[sandbox] ${this.containerName} déjà créé par un appel concurrent — réutilisé`,
          );
          return;
        }
      }
      throw new ExecError(`docker run a échoué : ${prefixePy(texte, 400)}`);
    }
    if (reglagesBac.attenteCreationMs > 0) await attendre(reglagesBac.attenteCreationMs, signal);
    const [rcEtat, outEtat] = await this.appel(
      ["inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}", this.containerName],
      5,
      signal,
    );
    if (rcEtat === 0) {
      const etatTexte = stripPy(decoderUtf8(outEtat));
      if (etatTexte.startsWith("exited") || etatTexte.startsWith("dead")) {
        const [rcLogs, outLogs] = await this.appel(["logs", "--tail", "30", this.containerName], 5, signal);
        const texteLogs = rcLogs === 0 ? stripPy(decoderRemplace(outLogs)) : "(logs indisponibles)";
        journalDe("sandbox").warn(
          `[sandbox] container ${this.containerName} a crashé (état=${etatTexte}). Logs:\n${suffixePy(texteLogs, 500)}`,
        );
        throw new ExecError(
          `Container a crashé au démarrage (état=${etatTexte}).`,
          suffixePy(texteLogs, 1500),
        );
      }
    }
    journalDe("sandbox").info(
      `[sandbox] container créé : ${this.containerName} pour user_id=${this.userId} (profil=${profil.id}, mode=${String(profil.mode)})`,
    );
  }

  /** Arrêt sous le verrou de cycle de vie ; verdict privdrop et cache de disponibilité oubliés. */
  async stop(): Promise<void> {
    await sousVerrouDeCycle(this.userId, () => this.appel(["stop", "-t", "5", this.containerName], 15));
    privdrop.forget(this.containerName);
    getReadinessCache().recordStopped(this.containerName);
  }

  async destroy(): Promise<void> {
    await sousVerrouDeCycle(this.userId, () => this.appel(["rm", "-fv", this.containerName], 20));
    privdrop.forget(this.containerName);
    getReadinessCache().recordStopped(this.containerName);
  }

  /** `purge` (suppression d'un compte) : processus du compte tués, /work vidé par le root du conteneur (redémarré si l'arrêt l'a stoppé), puis conteneur retiré. */
  async purge(): Promise<void> {
    const st = await this.ensureRunning();
    if (!st.running) throw new ExecError(`${this.containerName} : conteneur arrêté, /work non vidé`);
    const uidExec = (this.cfg.exec_user || "10001:10001").split(":", 1)[0] ?? "";
    if (estChiffresPy(uidExec) && uidExec !== "0")
      await this.appel(["exec", "-u", "0:0", this.containerName, "pkill", "-KILL", "-U", uidExec], 15);
    const vider = (): Promise<ReponseDocker> =>
      this.appel(
        ["exec", "-u", "0:0", this.containerName, "find", "/work", "-xdev", "-mindepth", "1", "-delete"],
        600,
      );
    let [rc, , err] = await vider();
    if (rc !== 0 && lowerPy(decoderRemplace(err)).includes("is not running")) {
      if ((await this.ensureRunning()).running) [rc, , err] = await vider();
    }
    if (rc !== 0)
      throw new ExecError(
        `${this.containerName} : /work non vidé : ${prefixePy(stripPy(decoderRemplace(err)), 300)}`,
      );
    await this.destroy();
  }

  async restart(): Promise<EtatBac> {
    await this.destroy();
    return this.ensureRunning();
  }

  /** Sonde une fois par (conteneur, exec_user) la chaîne `docker exec -u 0:0 → setpriv → exec_user` ; une sonde en échec transitoire ne mémorise rien, un refus mémorisé est resondé une fois quand le profil l'exige. */
  private async ensurePrivdropProbed(execUser: string, signal?: AbortSignal): Promise<void> {
    const verdict = privdrop.cached(this.containerName, execUser);
    if (verdict === true) return;
    if (verdict === false) {
      if (this.networkProfile.mode !== "allowlist_ip") return;
      privdrop.oublierVerdict(this.containerName, execUser);
    }
    const argv = privdrop.probeArgv(this.containerName, execUser);
    if (argv === null) return;
    let rc: number;
    try {
      [rc] = await this.appel(argv, 10, signal);
    } catch (e) {
      if (estAnnulation(e, signal)) throw e;
      return;
    }
    privdrop.remember(this.containerName, execUser, rc === 0);
  }

  /** Utilisateur et préfixe d'exec ; en liste blanche IP, échoue fermé si `net_admin` pourrait rester. */
  private resoudreUtilisateur(execUser: string): [string, string[]] {
    try {
      return privdrop.resolve(this.containerName, execUser, this.networkProfile.mode === "allowlist_ip");
    } catch (e) {
      if (e instanceof privdrop.RetraitNetAdminAbsent) throw new ExecError(e.message);
      throw e;
    }
  }

  /** Client de l'agent de ce bac (fabrique posée par la composition) ; sans fabrique : `agent_unavailable`. */
  get agent(): AgentBac {
    if (this.agentClient === null) {
      const f = fabriqueAgent();
      if (f === null) throw erreurAgent("agent_unavailable", "client de l'agent non installé");
      this.agentClient = f(this);
    }
    return this.agentClient;
  }

  /** `start_agent` : agent lancé détaché sous `exec_user`, sans net_admin ; `replace` : agent figé tué d'abord. */
  async startAgent(replace = false): Promise<void> {
    if (this.recreationReportee) throw new ExecError(this.recreationReportee);
    if (replace)
      await this.appel(
        ["exec", "--user", "0:0", this.containerName, "pkill", "-KILL", "-f", `${AGENT_MOUNT}/server.py`],
        10,
      );
    const execUser = this.cfg.exec_user || "10001:10001";
    await this.ensurePrivdropProbed(execUser);
    const [utilisateur, prefixe] = this.resoudreUtilisateur(execUser);
    const [rc, , err] = await this.appel(
      [
        "exec",
        "-d",
        "--user",
        utilisateur,
        this.containerName,
        ...prefixe,
        "python3",
        "-I",
        "-S",
        `${AGENT_MOUNT}/server.py`,
        "--root",
        "/work",
        "--socket",
        AGENT_SOCKET,
      ],
      15,
    );
    if (rc !== 0)
      throw new ExecError(
        `Agent non démarré dans ${this.containerName} : ${prefixePy(stripPy(decoderRemplace(err)), 300)}`,
      );
  }

  /** Activité poussée à l'agent, sans l'attendre (le GC d'inactivité lit le mtime de /work). */
  private activite(): void {
    try {
      this.agent.hello().catch(() => undefined);
    } catch {
      // agent indisponible : rien à pousser
    }
  }

  /** `exec` : commande dans le conteneur (umask 0022, `timeout` côté conteneur, sans net_admin), sortie bornée ; avec `signal`, l'abandon tue aussi la commande dans le conteneur (le client `docker exec` tué ne l'arrête pas). */
  async exec(cmd: readonly string[], options: OptionsExec = {}): Promise<ExecResult> {
    const signal = options.signal;
    const st = await this.ensureRunning(signal);
    if (!st.running) throw new ExecError(`Container ${this.containerName} n'a pas pu démarrer`);
    const delai = options.timeoutS || this.cfg.timeout_s;
    this.activite();
    const execUser = this.cfg.exec_user || "10001:10001";
    await this.ensurePrivdropProbed(execUser, signal);
    const [utilisateur, prefixe] = this.resoudreUtilisateur(execUser);
    const args = ["exec", "--user", utilisateur, "--workdir", options.workdirInContainer ?? "/work"];
    if (options.stdin !== undefined) args.push("-i");
    const env = new Map(Object.entries(options.env ?? {}));
    if (!env.has("GIT_CONFIG_COUNT")) {
      env.set("GIT_CONFIG_COUNT", "1");
      env.set("GIT_CONFIG_KEY_0", "safe.directory");
      env.set("GIT_CONFIG_VALUE_0", "*");
    }
    for (const [k, v] of env) args.push("-e", `${k}=${v}`);
    const idExec = signal === undefined ? null : randomUUID();
    args.push(
      this.containerName,
      ...prefixe,
      "sh",
      "-c",
      ENVELOPPE_EXEC,
      idExec ?? "--",
      String(Math.trunc(delai)),
      ...cmd,
    );
    signal?.throwIfAborted();
    const t0 = performance.now();
    const proc = this.cli.lancer(args, { entree: options.stdin !== undefined });
    const max = execCaptureMaxBytes();
    const sortie = new CaptureBornee(max);
    const erreur = new CaptureBornee(max);
    const pomper = async (flux: AsyncIterable<Buffer>, nom: "stdout" | "stderr", tampon: CaptureBornee) => {
      for await (const data of flux) {
        tampon.add(data);
        if (options.onChunk === undefined) continue;
        try {
          options.onChunk(nom, data);
        } catch {
          // un rappel cassé ne tue jamais l'exec
        }
      }
    };
    const nourrir = async (): Promise<void> => {
      if (options.stdin === undefined || proc.stdin === null) return;
      const entree = proc.stdin;
      await new Promise<void>((fin) => {
        entree.once("error", () => fin());
        entree.end(options.stdin, () => fin());
      });
    };
    let codeFin: number | null = null;
    const travaux = Promise.all([
      nourrir(),
      pomper(proc.stdout, "stdout", sortie),
      pomper(proc.stderr, "stderr", erreur),
      proc.fin.then((c) => {
        codeFin = c;
      }),
    ]);
    let timedOut = false;
    let minuterie: NodeJS.Timeout | undefined;
    let surAbandon: (() => void) | undefined;
    const issue = await new Promise<"fini" | "delai" | "annule" | { erreur: unknown }>((fin) => {
      travaux.then(
        () => fin("fini"),
        (e: unknown) => fin({ erreur: e }),
      );
      const filet = (delai + 10) * 1000;
      if (filet <= 2_147_483_647) minuterie = setTimeout(() => fin("delai"), filet);
      surAbandon = () => fin("annule");
      signal?.addEventListener("abort", surAbandon, { once: true });
    });
    clearTimeout(minuterie);
    if (surAbandon) signal?.removeEventListener("abort", surAbandon);
    if (issue !== "fini") {
      proc.tuer();
      proc.stdout.destroy();
      proc.stderr.destroy();
      await Promise.race([proc.fin.catch(() => undefined), attendre(reglagesBac.attenteTueMs)]);
      if (issue === "annule") {
        if (idExec !== null) await this.tuerExec(idExec, utilisateur, prefixe);
        throw signal?.reason as Error;
      }
      if (issue !== "delai") throw issue.erreur;
      timedOut = true;
    } else if (codeFin === 124) timedOut = true;
    const out = sortie.value();
    const err = erreur.value();
    const rc = codeFin;
    if (rc !== null && rc !== 0 && rc !== 124) {
      const bas = lowerPy(decoderRemplace(err));
      if (bas.includes("no such container") || bas.includes("is not running"))
        getReadinessCache().recordStopped(this.containerName);
    }
    return {
      returncode: rc ?? -1,
      stdout: out,
      stderr: err,
      duration_s: (performance.now() - t0) / 1000,
      timed_out: timedOut,
      executor_tag: `docker.user.${this.username}`,
      container_id: st.container_id,
    };
  }

  /** Tue dans le conteneur les processus de l'exec `id` (même mécanisme que le délai) ; au mieux : une panne du démon laisse la commande finir d'elle-même à son délai. */
  private async tuerExec(id: string, utilisateur: string, prefixe: readonly string[]): Promise<void> {
    try {
      await this.appel(
        [
          "exec",
          "--user",
          utilisateur,
          this.containerName,
          ...prefixe,
          "sh",
          "-c",
          SCRIPT_TUER_EXEC,
          "tuer-exec",
          id,
        ],
        reglagesBac.tuerExecS,
      );
    } catch (e) {
      journalDe("sandbox").warn(`[sandbox] exec ${id} non tué dans ${this.containerName} : ${String(e)}`);
    }
  }

  /** `stats` : `docker stats --no-stream` du conteneur, `{}` en cas d'échec. */
  async stats(): Promise<unknown> {
    const [rc, out] = await this.appel(
      ["stats", "--no-stream", "--format", FORMAT_STATS, this.containerName],
      10,
    );
    if (rc !== 0) return {};
    try {
      return pyJsonLoads(stripPy(decoderUtf8(out)));
    } catch {
      return {};
    }
  }
}

function attendre(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((ok, ko) => {
    if (signal?.aborted) return ko(signal.reason as Error);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", annuler);
      ok();
    }, ms);
    const annuler = (): void => {
      clearTimeout(t);
      ko(signal?.reason as Error);
    };
    signal?.addEventListener("abort", annuler, { once: true });
  });
}
