// SPDX-License-Identifier: MIT
/** apps/core/src/ops/sauvegarde-distante.ts — envoi des sauvegardes (sftp par clé, dossier monté, rsync par mot de passe), planification et boucle de main (ops/backup_remote.py, ops/backup_scheduler.py). */
import { spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { constants as constantesOs, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as attendre } from "node:timers/promises";

import {
  ErreurPython,
  estDict,
  FlottantPy,
  floatPy,
  getPy,
  intPy,
  ouPy,
  prefixePy,
  rstripPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, lireConfigDisque, pyJoin, sousVerrouConfigJson, writeConfigJson } from "@elpis/config";
import type { Base } from "@elpis/db";
import { VerrouFichier } from "@elpis/verrous";

import type { CycleDeVie } from "../cycle";
import type { Journal } from "../journal";
import { lireConfigPy } from "./config-py";
import { estErreurOs } from "./erreurs-os";
import { mkdirParentsPy } from "./restauration";
import { backupIncomplete, creerTemporaire, estPortee, makeBackupZip, SCOPES } from "./sauvegarde";

export const CONNECTORS = ["sftp", "mounted", "rsync"] as const;
export const SCHEDULE_UNITS: Readonly<Record<string, number>> = { hours: 3600, days: 86400 };
export const RETRY_AFTER_FAIL_S = 3600;
export const TICK_SECONDS = 60;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;
const PATH_RE = /^[A-Za-z0-9._/-]+$/u;
const SSH_ASKPASS_BODY = "#!/bin/sh\nprintf '%s\\n' \"$ELPIS_BACKUP_SSH_PASS\"\n";

let horloge: () => number = () => Date.now() / 1000;

/** Horloge en secondes (tests) ; `null` la rend au système. */
export function reglerSauvegardeDistantePourTests(o: { horloge?: (() => number) | null }): void {
  if (o.horloge !== undefined) horloge = o.horloge ?? (() => Date.now() / 1000);
}

function userDb(): string {
  return pyJoin(config.PROJECT_ROOT, "user_db");
}

export function defaultKeyPath(): string {
  return pyJoin(userDb(), ".backup_ssh_key");
}

export function defaultKnownHosts(): string {
  return pyJoin(userDb(), ".backup_known_hosts");
}

export function rsyncPasswordPath(): string {
  return pyJoin(userDb(), ".backup_rsync_password");
}

export function sendLockPath(): string {
  return pyJoin(userDb(), ".backup_send.lock");
}

/** `os.path.exists` : toute erreur vaut faux. */
function existeOs(p: string): boolean {
  if (!p.isWellFormed() || p.includes("\0")) return false;
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function get(d: Dict, cle: string, defaut: unknown): unknown {
  return Object.hasOwn(d, cle) ? d[cle] : defaut;
}

/** `normalize_remote_config` : défauts et coercions de `backup.remote`, sans secret. */
export function normalizeRemoteConfig(brut: unknown): Dict {
  const r: Dict = estDict(brut) ? brut : {};
  const s = (k: string, d = ""): string => {
    const v = get(r, k, d);
    return v !== null && v !== undefined ? stripPy(strPy(v)) : d;
  };
  const entier = (k: string, d: number): number => {
    try {
      return intPy(ouPy(get(r, k, d), d));
    } catch {
      return d;
    }
  };
  const port = entier("port", 22);
  const every = entier("schedule_every", 1);
  const unit = s("schedule_unit", "days") || "days";
  const last: Dict = estDict(get(r, "last_send", null)) ? (r["last_send"] as Dict) : {};
  return {
    enabled: veritePy(get(r, "enabled", false)),
    connector: s("connector", "sftp") || "sftp",
    scope: s("scope", "full") || "full",
    host: s("host"),
    port: Math.max(1, Math.min(65535, port)),
    user: s("user"),
    remote_path: s("remote_path"),
    dest_path: s("dest_path"),
    strict_host_key_checking: veritePy(get(r, "strict_host_key_checking", true)),
    schedule_enabled: veritePy(get(r, "schedule_enabled", false)),
    schedule_every: Math.max(1, Math.min(999, every)),
    schedule_unit: Object.hasOwn(SCHEDULE_UNITS, unit) ? unit : "days",
    key_path: s("key_path") || defaultKeyPath(),
    known_hosts: s("known_hosts") || defaultKnownHosts(),
    timeout_sec: Math.max(10, Math.min(3600, intPy(ouPy(get(r, "timeout_sec", 300), 300)))),
    last_send: {
      at: get(last, "at", 0),
      ok: get(last, "ok", null),
      ok_at: get(last, "ok_at", 0),
      trigger: get(last, "trigger", ""),
      filename: get(last, "filename", ""),
      error: get(last, "error", ""),
    },
  };
}

/** `next_run_at` : prochain envoi automatique (secondes), `null` hors planification. */
export function nextRunAt(cfg: Dict, now: number | null = null): number | null {
  if (!(veritePy(getPy(cfg, "enabled")) && veritePy(getPy(cfg, "schedule_enabled")))) return null;
  const t = now ?? horloge();
  const unite = strPy(ouPy(getPy(cfg, "schedule_unit"), "days"));
  const intervalle =
    intPy(ouPy(getPy(cfg, "schedule_every"), 1)) *
    (Object.hasOwn(SCHEDULE_UNITS, unite) ? (SCHEDULE_UNITS[unite] as number) : 86400);
  const last = ouPy(getPy(cfg, "last_send"), {});
  const at = floatPy(ouPy(getPy(last, "at"), 0));
  if (!at) return t;
  if (getPy(last, "ok") === false && !veritePy(getPy(last, "incomplete")))
    return at + Math.min(intervalle, RETRY_AFTER_FAIL_S);
  return at + intervalle;
}

/** `get_remote_config` : `backup.remote` relu et normalisé, présence de la clé et du mot de passe, prochaine échéance. */
export function getRemoteConfig(): Dict {
  const lu = lireConfigDisque() ?? {};
  const backup = get(lu, "backup", {});
  const brut = estDict(backup) ? get(backup, "remote", {}) : {};
  const cfg = normalizeRemoteConfig(brut);
  const cle = cfg["key_path"] as string;
  cfg["key_present"] = Boolean(cle) && existeOs(cle);
  cfg["password_present"] = existeOs(rsyncPasswordPath());
  const prochain = nextRunAt(cfg);
  cfg["next_run_at"] = prochain === null ? null : new FlottantPy(prochain);
  return cfg;
}

/** `validate_remote_config` : (ok, message) selon le connecteur. */
export function validateRemoteConfig(cfg: Dict): [boolean, string] {
  const v = (k: string): string => {
    const x = getPy(cfg, k);
    return typeof x === "string" ? x : "";
  };
  const connecteur = getPy(cfg, "connector");
  if (!(CONNECTORS as readonly unknown[]).includes(connecteur)) return [false, "Connecteur invalide"];
  if (!(SCOPES as readonly unknown[]).includes(getPy(cfg, "scope"))) return [false, "Scope invalide"];
  if (connecteur === "rsync") {
    if (!v("host") || !HOST_RE.test(v("host")))
      return [false, "Adresse invalide (caractères autorisés : lettres, chiffres, . _ -)"];
    if (!v("user") || !USER_RE.test(v("user"))) return [false, "Utilisateur invalide"];
    if (!v("remote_path") || !PATH_RE.test(v("remote_path")))
      return [false, "Chemin cible invalide (pas d'espace ni de métacaractère)"];
    if (!PATH_RE.test(v("known_hosts"))) return [false, "Chemin known_hosts invalide"];
  } else if (connecteur === "sftp") {
    if (!v("host") || !HOST_RE.test(v("host")))
      return [false, "Hôte invalide (caractères autorisés : lettres, chiffres, . _ -)"];
    if (!v("user") || !USER_RE.test(v("user"))) return [false, "Utilisateur invalide"];
    if (!v("remote_path") || !PATH_RE.test(v("remote_path")))
      return [false, "Chemin distant invalide (pas d'espace ni de métacaractère)"];
  } else if (!v("dest_path") || !PATH_RE.test(v("dest_path"))) {
    return [false, "Dossier de destination invalide"];
  }
  return [true, ""];
}

/** `save_remote_config` : champs entrants fusionnés sous `backup.remote`, `last_send` existant préservé. */
export async function saveRemoteConfig(entrant: unknown): Promise<Dict> {
  const cfg = normalizeRemoteConfig(entrant);
  await sousVerrouConfigJson(() => {
    const complet = lireConfigPy();
    const backup: Dict = estDict(complet["backup"]) ? complet["backup"] : {};
    const prec: Dict = estDict(backup["remote"]) ? backup["remote"] : {};
    if (estDict(prec["last_send"])) cfg["last_send"] = prec["last_send"];
    backup["remote"] = cfg;
    complet["backup"] = backup;
    writeConfigJson(complet);
  });
  const cle = cfg["key_path"] as string;
  return {
    ...cfg,
    key_present: Boolean(cle) && existeOs(cle),
    password_present: existeOs(rsyncPasswordPath()),
  };
}

/** `str.encode("utf-8")` d'un texte écrit : une demi-paire isolée lève l'`UnicodeEncodeError` (ValueError) de Python. */
export function encoderTexte(s: string): Buffer {
  const points = Array.from(s);
  const i = points.findIndex((c) => /^\p{Cs}$/u.test(c));
  if (i < 0) return Buffer.from(s, "utf8");
  let j = i;
  while (j < points.length && /^\p{Cs}$/u.test(points[j] as string)) j++;
  const hex = (c: string): string => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
  const raison =
    j - i === 1
      ? `'utf-8' codec can't encode character '${hex(points[i] as string)}' in position ${i}: surrogates not allowed`
      : `'utf-8' codec can't encode characters in position ${i}-${j - 1}: surrogates not allowed`;
  throw new ErreurPython("ValueError", raison);
}

/** `store_ssh_key` : clé privée en fichier 0600 (temporaire puis renommage) ; rend son chemin. */
export function storeSshKey(contenu: string, keyPath?: string): string {
  const chemin = keyPath || (getRemoteConfig()["key_path"] as string);
  mkdirParentsPy(path.dirname(chemin));
  const corps = encoderTexte(contenu.endsWith("\n") ? contenu : `${contenu}\n`);
  const tmp = `${chemin}.tmp`;
  writeFileSync(tmp, corps, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, chemin);
  chmodSync(chemin, 0o600);
  return chemin;
}

/** `store_rsync_password` : mot de passe en fichier 0600, vide = retrait ; vrai s'il est désormais enregistré. */
export function storeRsyncPassword(motDePasse: string): boolean {
  const chemin = rsyncPasswordPath();
  if (!motDePasse) {
    try {
      unlinkSync(chemin);
    } catch (e) {
      if ((e as { code?: unknown }).code !== "ENOENT") throw e;
    }
    return false;
  }
  if (motDePasse.includes("\n") || motDePasse.includes("\r"))
    throw new ErreurPython("ValueError", "Le mot de passe ne peut pas contenir de saut de ligne");
  mkdirParentsPy(path.dirname(chemin));
  const tmp = pyJoin(path.dirname(chemin), `${path.basename(chemin)}.tmp`);
  const corps = encoderTexte(`${motDePasse}\n`);
  writeFileSync(tmp, corps, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, chemin);
  return true;
}

interface Sortie {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** Processus sans shell, entrée fermée ; `null` au-delà du délai (tué). Une commande introuvable lève ENOENT. */
function lancer(argv: readonly string[], delaiS: number, env?: NodeJS.ProcessEnv): Promise<Sortie | null> {
  return new Promise((resolu, rejete) => {
    const enfant = spawn(argv[0] as string, argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    enfant.stdout.on("data", (b: Buffer) => out.push(b));
    enfant.stderr.on("data", (b: Buffer) => err.push(b));
    let expire = false;
    const minuteur = setTimeout(() => {
      expire = true;
      enfant.kill("SIGKILL");
    }, delaiS * 1000);
    enfant.once("error", (e) => {
      clearTimeout(minuteur);
      rejete(e);
    });
    enfant.once("close", (code, signal) => {
      clearTimeout(minuteur);
      if (expire) return resolu(null);
      resolu({
        code: code ?? -(signal ? constantesOs.signals[signal] : 0),
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      });
    });
  });
}

/** `_run` : (ok, première ligne de stderr) ; commande introuvable et délai dépassé rendus en message. */
export async function executerCommande(
  argv: readonly string[],
  delaiS: number,
  env?: NodeJS.ProcessEnv,
): Promise<[boolean, string]> {
  let sortie: Sortie | null;
  try {
    sortie = await lancer(argv, delaiS, env);
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT")
      return [false, `Commande introuvable : [Errno 2] No such file or directory: '${argv[0] ?? ""}'`];
    throw e;
  }
  if (sortie === null) return [false, "Délai dépassé"];
  if (sortie.code === 0) return [true, ""];
  const premiere = stripPy(sortie.stderr.toString("utf8")).split("\n")[0] ?? "";
  const msg = prefixePy(premiere, 300);
  return [false, msg || `Échec (code ${sortie.code})`];
}

/** `key_fingerprint` : `ssh-keygen -lf` (best-effort, `null` si absente ou en échec). */
export async function keyFingerprint(keyPath?: string): Promise<string | null> {
  try {
    const chemin = keyPath || (getRemoteConfig()["key_path"] as string);
    if (!chemin || !existeOs(chemin)) return null;
    const sortie = await lancer(["ssh-keygen", "-lf", chemin], 10);
    if (sortie === null) return null;
    return stripPy(sortie.stdout.toString("utf8")) || null;
  } catch {
    return null;
  }
}

function sshOpts(cfg: Dict): string[] {
  const strict = veritePy(
    Object.hasOwn(cfg, "strict_host_key_checking") ? cfg["strict_host_key_checking"] : true,
  )
    ? "accept-new"
    : "no";
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `StrictHostKeyChecking=${strict}`,
    "-o",
    `UserKnownHostsFile=${strPy(cfg["known_hosts"])}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "IdentitiesOnly=yes",
    "-i",
    strPy(cfg["key_path"]),
  ];
}

function rstripBarres(s: string): string {
  return rstripPy(s, "/");
}

export function buildTestArgv(cfg: Dict): string[] {
  const rp = strPy(cfg["remote_path"]);
  return [
    "ssh",
    ...sshOpts(cfg),
    "-p",
    strPy(cfg["port"]),
    `${strPy(cfg["user"])}@${strPy(cfg["host"])}`,
    `test -d ${rp} && test -w ${rp}`,
  ];
}

export function buildSendArgv(cfg: Dict, local: string, nom: string): string[] {
  const dest = `${strPy(cfg["user"])}@${strPy(cfg["host"])}:${rstripBarres(strPy(cfg["remote_path"]))}/${nom}`;
  return ["scp", "-q", ...sshOpts(cfg), "-P", strPy(cfg["port"]), local, dest];
}

function rsyncSshCmd(cfg: Dict): string {
  const strict = veritePy(
    Object.hasOwn(cfg, "strict_host_key_checking") ? cfg["strict_host_key_checking"] : true,
  )
    ? "accept-new"
    : "no";
  return [
    "ssh",
    "-p",
    strPy(cfg["port"]),
    "-o",
    `StrictHostKeyChecking=${strict}`,
    "-o",
    `UserKnownHostsFile=${strPy(cfg["known_hosts"])}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "PreferredAuthentications=password,keyboard-interactive",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "NumberOfPasswordPrompts=1",
    "-o",
    "LogLevel=ERROR",
  ].join(" ");
}

export function buildRsyncTestArgv(cfg: Dict): string[] {
  const dest = `${strPy(cfg["user"])}@${strPy(cfg["host"])}:${rstripBarres(strPy(cfg["remote_path"]))}/`;
  return ["rsync", "--timeout=20", "-e", rsyncSshCmd(cfg), "--list-only", "--", dest];
}

export function buildRsyncSendArgv(cfg: Dict, local: string, nom: string): string[] {
  const dest = `${strPy(cfg["user"])}@${strPy(cfg["host"])}:${rstripBarres(strPy(cfg["remote_path"]))}/${nom}`;
  const delai = Math.max(10, intPy(ouPy(cfg["timeout_sec"], 300)));
  return ["rsync", `--timeout=${delai}`, "-e", rsyncSshCmd(cfg), "-t", "--", local, dest];
}

/** `Path.read_text(encoding="utf-8")` : UTF-8 strict (ValueError), fins de ligne universelles. */
function lireTexte(chemin: string): string {
  let texte: string;
  try {
    texte = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(chemin));
  } catch (e) {
    if (estErreurOs(e)) throw e;
    throw new ErreurPython("ValueError", `'utf-8' codec can't decode ${chemin}`);
  }
  return texte.replace(/\r\n?/gu, "\n");
}

/** `_SshPassword` : script askpass temporaire (0700) et environnement portant le mot de passe ; `null` sans mot de passe enregistré. */
async function avecMotDePasse<T>(f: (env: NodeJS.ProcessEnv | null) => Promise<T>): Promise<T> {
  let mdp: string;
  try {
    mdp = lireTexte(rsyncPasswordPath()).replace(/\n+$/u, "");
  } catch (e) {
    if (!estErreurOs(e)) throw e;
    return f(null);
  }
  const script = creerTemporaire(tmpdir(), ".sh", "elpis_askpass_");
  try {
    writeFileSync(script, SSH_ASKPASS_BODY);
    chmodSync(script, 0o700);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SSH_ASKPASS: script,
      SSH_ASKPASS_REQUIRE: "force",
      ELPIS_BACKUP_SSH_PASS: mdp,
    };
    delete env["DISPLAY"];
    return await f(env);
  } finally {
    rmSync(script, { force: true });
  }
}

/** `_ssh_error` : première ligne d'erreur ssh/rsync en message lisible (brute sinon). */
export function sshError(msg: string): string {
  const m = (msg || "").toLowerCase();
  if (m.includes("permission denied") || m.includes("authentication failed"))
    return "Identifiants refusés (utilisateur ou mot de passe).";
  if (m.includes("connection refused")) return "Connexion refusée : aucun serveur SSH sur ce port.";
  if (
    m.includes("timed out") ||
    m.includes("no route to host") ||
    m.includes("could not resolve") ||
    m.includes("name or service not known")
  )
    return "Serveur injoignable (adresse ou réseau).";
  if (m.includes("host key verification failed") || m.includes("remote host identification has changed"))
    return "L'empreinte du serveur a changé (known_hosts) : connexion refusée.";
  if (m.includes("no such file or directory") || m.includes("change_dir"))
    return "Dossier cible introuvable sur le serveur.";
  if (
    m.includes("command not found") ||
    m.includes("rsync: not found") ||
    m.includes("protocol version mismatch")
  )
    return "rsync absent sur le serveur distant.";
  return msg;
}

function dossierInscriptible(d: string): boolean {
  try {
    if (!statSync(d).isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    accessSync(d, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** `run_test` : connexion ou destination testée selon le connecteur. */
export async function runTest(): Promise<Dict> {
  const cfg = getRemoteConfig();
  const [ok, err] = validateRemoteConfig(cfg);
  if (!ok) return { ok: false, error: err };
  if (cfg["connector"] === "mounted") {
    const d = cfg["dest_path"] as string;
    let estDossier: boolean;
    try {
      estDossier = statSync(d).isDirectory();
    } catch {
      estDossier = false;
    }
    if (!estDossier) return { ok: false, error: "Dossier introuvable (monté ?)" };
    if (!dossierInscriptible(d)) return { ok: false, error: "Dossier non inscriptible" };
    return { ok: true, error: "" };
  }
  if (cfg["connector"] === "rsync") {
    return avecMotDePasse(async (env) => {
      if (env === null) return { ok: false, error: "Mot de passe absent — enregistrez-le d'abord." };
      const [ok2, msg] = await executerCommande(buildRsyncTestArgv(cfg), 40, env);
      return { ok: ok2, error: sshError(msg) };
    });
  }
  if (!existeOs(cfg["key_path"] as string))
    return { ok: false, error: "Clé SSH absente — téléverse-la d'abord." };
  const [ok2, msg] = await executerCommande(buildTestArgv(cfg), 20);
  return { ok: ok2, error: msg };
}

/** `_record_last_send` : `backup.remote.last_send` persisté (best-effort), `ok_at` gardant le dernier succès. */
export async function recordLastSend(
  ok: boolean,
  nom: string,
  erreur: string,
  trigger = "manual",
  incomplete = false,
  journal?: Journal,
): Promise<void> {
  try {
    await sousVerrouConfigJson(() => {
      const complet = lireConfigPy();
      const backup: Dict = estDict(complet["backup"]) ? complet["backup"] : {};
      const remote: Dict = estDict(backup["remote"]) ? backup["remote"] : {};
      const prec: Dict = estDict(remote["last_send"]) ? remote["last_send"] : {};
      const now = horloge();
      remote["last_send"] = {
        at: new FlottantPy(now),
        ok,
        filename: nom,
        error: erreur,
        trigger,
        incomplete,
        ok_at: new FlottantPy(ok ? now : floatPy(ouPy(get(prec, "ok_at", null), 0))),
      };
      backup["remote"] = remote;
      complet["backup"] = backup;
      writeConfigJson(complet);
    });
  } catch (e) {
    journal?.debug({ err: e }, "[backup_remote] last_send non persisté");
  }
}

export interface OptionsEnvoi {
  readonly trigger?: string;
  readonly journal?: Journal;
}

/** `run_send` : un envoi à la fois entre les process (verrou de fichier pris sans attente), archive toujours supprimée. */
export async function runSend(base: Base, scope: unknown, options: OptionsEnvoi = {}): Promise<Dict> {
  const verrou = new VerrouFichier(sendLockPath(), { battement: true });
  let pris: boolean;
  try {
    mkdirParentsPy(path.dirname(sendLockPath()));
    pris = await verrou.essayer();
  } catch (e) {
    if (!estErreurOs(e)) throw e;
    pris = false;
  }
  if (!pris) return { ok: false, error: "Un envoi est déjà en cours." };
  try {
    return await envoyer(base, scope, options.trigger ?? "manual", options.journal);
  } catch (e) {
    const erreur = e instanceof Error ? e.message : String(e);
    await recordLastSend(false, "", erreur, options.trigger ?? "manual", false, options.journal);
    return { ok: false, error: erreur };
  } finally {
    await verrou.rendre();
  }
}

async function envoyer(base: Base, scope: unknown, trigger: string, journal?: Journal): Promise<Dict> {
  const cfg = getRemoteConfig();
  const [ok, err] = validateRemoteConfig(cfg);
  if (!ok) return { ok: false, error: err };
  const portee = veritePy(scope) ? scope : cfg["scope"];
  if (!estPortee(portee)) return { ok: false, error: "Scope invalide" };
  const { chemin, nom } = await makeBackupZip(base, portee, journal ? { journal } : {});
  let res: Dict;
  try {
    if (cfg["connector"] === "mounted") {
      const dest = cfg["dest_path"] as string;
      if (!dossierInscriptible(dest)) res = { ok: false, error: "Dossier de destination indisponible" };
      else {
        const final = path.join(dest, nom);
        const part = `${final}.part`;
        try {
          copyFileSync(chemin, part);
          const st = statSync(chemin);
          chmodSync(part, st.mode & 0o7777);
          utimesSync(part, st.atime, st.mtime);
          renameSync(part, final);
        } catch (e) {
          rmSync(part, { force: true });
          throw e;
        }
        res = { ok: true, error: "", filename: nom };
      }
    } else if (cfg["connector"] === "rsync") {
      res = await avecMotDePasse(async (env) => {
        if (env === null) return { ok: false, error: "Mot de passe absent" };
        const [ok2, msg] = await executerCommande(
          buildRsyncSendArgv(cfg, chemin, nom),
          (cfg["timeout_sec"] as number) + 30,
          env,
        );
        return { ok: ok2, error: sshError(msg), filename: ok2 ? nom : "" };
      });
    } else if (!existeOs(cfg["key_path"] as string)) {
      res = { ok: false, error: "Clé SSH absente" };
    } else {
      const [ok2, msg] = await executerCommande(
        buildSendArgv(cfg, chemin, nom),
        cfg["timeout_sec"] as number,
      );
      res = { ok: ok2, error: msg, filename: ok2 ? nom : "" };
    }
  } finally {
    rmSync(chemin, { force: true });
  }
  if (veritePy(res["ok"]) && backupIncomplete(nom))
    res = {
      ...res,
      ok: false,
      incomplete: true,
      error:
        "Sauvegarde incomplète : /work d'au moins un compte non sauvegardé " +
        "(sandboxes indisponibles ?) — voir backup-warnings.txt",
    };
  await recordLastSend(
    veritePy(res["ok"]),
    strPy(get(res, "filename", "")),
    strPy(get(res, "error", "")),
    trigger,
    veritePy(get(res, "incomplete", false)),
    journal,
  );
  return res;
}

/** `due_now` : un envoi planifié est dû (configuration relue et valide). */
export function dueNow(now: number | null = null): boolean {
  const cfg = getRemoteConfig();
  const [ok] = validateRemoteConfig(cfg);
  if (!ok) return false;
  const prochain = nextRunAt(cfg, now);
  return prochain !== null && (now ?? horloge()) >= prochain;
}

/** `run_if_due` : un tour de boucle ; vrai si un envoi a été tenté. */
export async function runIfDue(base: Base, journal: Journal): Promise<boolean> {
  if (!dueNow()) return false;
  const res = await runSend(base, null, { trigger: "schedule", journal });
  if (veritePy(res["ok"]))
    journal.info(`[backup] envoi planifié réussi : ${strPy(get(res, "filename", ""))}`);
  else journal.warn(`[backup] envoi planifié en échec : ${strPy(get(res, "error", ""))}`);
  return true;
}

export interface DependancesBoucleSauvegarde {
  readonly base: Base;
  readonly journal: Journal;
  readonly arret: AbortSignal;
  /** Élection du process qui envoie (`try_acquire_cron_lock`) ; défaut : ce process. */
  readonly leader?: () => boolean | Promise<boolean>;
  readonly tickMs?: number;
}

/** `_backup_loop` : un tour par minute, envoi si dû, toute erreur journalisée sans arrêter la boucle. */
export async function boucleSauvegarde(dep: DependancesBoucleSauvegarde): Promise<void> {
  for (;;) {
    try {
      await attendre(dep.tickMs ?? TICK_SECONDS * 1000, undefined, { signal: dep.arret });
    } catch {
      return;
    }
    try {
      if (dep.leader && !(await dep.leader())) continue;
      await runIfDue(dep.base, dep.journal);
    } catch (e) {
      dep.journal.warn(`[backup] erreur de boucle : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** `start_backup_scheduler` : boucle de fond de main, arrêtée avec le process. */
export function demarrerSauvegardes(
  cycle: CycleDeVie,
  base: Base,
  journal: Journal,
  leader?: () => boolean | Promise<boolean>,
): void {
  cycle.auDemarrage(
    "sauvegarde distante",
    () => {
      journal.info("[backup] planificateur de sauvegarde distante démarré.");
      return boucleSauvegarde({ base, journal, arret: cycle.signalArret, ...(leader ? { leader } : {}) });
    },
    { modes: ["main"], arrierePlan: true },
  );
}
