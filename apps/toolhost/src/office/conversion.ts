// SPDX-License-Identifier: MIT
/** apps/toolhost/src/office/conversion.ts — conversion LibreOffice isolée des aperçus (sandbox/office_convert.py) : prison bwrap, environnement minimal, groupe tué à l'échéance, verrous `flock` partagés avec les conversions Python. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bwrap, which } from "@elpis/bac";
import { ErreurPython, intPy, journalDe, realpathPy, splitlinesPy, stripPy, strPy } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";

const log = journalDe("office");

/** `OfficeError` : `code` stable pour le front, statut HTTP, message court. */
export class ErreurOffice extends Error {
  override name = "OfficeError";
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const INFILTERS: Readonly<Record<string, string>> = {
  docx: "MS Word 2007 XML",
  pptx: "Impress MS PowerPoint 2007 XML",
  xlsx: "Calc MS Excel 2007 XML",
  odt: "writer8",
  odp: "impress8",
  ods: "calc8",
  svg: "SVG - Scalable Vector Graphics Draw",
};
export const PDF_EXPORT_FILTERS: Readonly<Record<string, string>> = {
  docx: "writer_pdf_Export",
  pptx: "impress_pdf_Export",
  xlsx: "calc_pdf_Export",
  odt: "writer_pdf_Export",
  odp: "impress_pdf_Export",
  ods: "calc_pdf_Export",
};
const DEFAUTS: Readonly<Record<string, unknown>> = {
  isolation: "auto",
  timeout_s: 60,
  slots: 2,
  slots_per_user: 1,
  wait_s: 20,
  max_pdf_mb: 300,
};

/** `cfg` : `office_preview.<cle>` relu à l'appel ; absent ou nul : la valeur par défaut. */
export function cfg(cle: string, defaut?: unknown): unknown {
  const d = defaut === undefined || defaut === null ? (DEFAUTS[cle] ?? null) : defaut;
  const v = liveConfigValue(`office_preview.${cle}`, d);
  return v === null || v === undefined ? d : v;
}

function estErreurConversion(e: unknown): boolean {
  return e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError");
}

/** `_int_cfg` : entier borné, la valeur par défaut s'il est illisible. */
export function intCfg(cle: string, lo: number, hi: number): number {
  let v: number;
  try {
    v = intPy(cfg(cle));
  } catch (e) {
    if (!estErreurConversion(e)) throw e;
    v = intPy(DEFAUTS[cle]);
  }
  return Math.max(lo, Math.min(hi, v));
}

/** `soffice_bin` : chemin réel du lanceur `program/soffice`, `""` s'il manque. */
export function sofficeBin(): string {
  const brut = cfg("soffice_bin", "");
  const cand =
    stripPy(process.env["APP_SOFFICE_BIN"] ?? "") ||
    stripPy(brut === null || brut === undefined || brut === false || brut === "" ? "" : strPy(brut)) ||
    which("soffice") ||
    "";
  if (!cand) return "";
  try {
    const reel = realpathPy(cand);
    if (!statSync(reel).isFile()) return "";
    accessSync(reel, constants.X_OK);
    return reel;
  } catch {
    return "";
  }
}

/** `lo_version_token` : empreinte de l'installation (une mise à jour invalide le cache). */
export function loVersionToken(soffice: string): string {
  if (!soffice) return "none";
  const prog = path.dirname(soffice);
  const parties = [soffice];
  for (const nom of ["soffice.bin", "versionrc"]) {
    try {
      parties.push(statSync(path.join(prog, nom), { bigint: true }).mtimeNs.toString());
    } catch {
      parties.push("-");
    }
  }
  return createHash("sha256").update(parties.join("|"), "utf8").digest("hex").slice(0, 16);
}

function bwrapBase(dossiers: readonly string[]): string[] {
  const argv = [
    ...bwrap.baseArgv(),
    ...["--ro-bind-try", "/etc/fonts", "/etc/fonts"],
    ...["--ro-bind-try", "/etc/libreoffice", "/etc/libreoffice"],
    ...["--ro-bind-try", "/var/cache/fontconfig", "/var/cache/fontconfig"],
  ];
  for (const d of dossiers) if (d && !d.startsWith("/usr/")) argv.push("--ro-bind", d, d);
  return argv;
}

let averti = false;

/** `isolation_mode` : `"bwrap"`, ou `"none"` seulement si la configuration le dit ; sinon 503. */
export async function isolationMode(): Promise<string> {
  const brut = cfg("isolation");
  const mode = stripPy(veriteTexte(brut, "auto")).toLowerCase();
  if (mode === "none") {
    if (!averti) {
      averti = true;
      log.warn('[office] aperçus Office SANS isolation (office_preview.isolation = "none")');
    }
    return "none";
  }
  if (await bwrap.probe()) return "bwrap";
  throw new ErreurOffice("isolation_unavailable", 503, "Isolation indisponible sur le serveur (bubblewrap)");
}

/** `str(x or defaut)`. */
function veriteTexte(x: unknown, defaut: string): string {
  return x === null || x === undefined || x === false || x === "" || x === 0 ? defaut : strPy(x);
}

const PROFILE_VERSION = "1";
const REGISTRY_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`;

/** `ensure_profile` : profil LibreOffice du créneau semé (appelé sous le verrou du créneau). */
export function ensureProfile(profil: string): void {
  try {
    if (readFileSync(path.join(profil, ".elpis-profile"), "utf8") === PROFILE_VERSION) {
      try {
        unlinkSync(path.join(profil, ".lock"));
      } catch {
        // pas de verrou résiduel
      }
      return;
    }
  } catch {
    // profil absent ou illisible : semé de nouveau
  }
  rmSync(profil, { recursive: true, force: true });
  try {
    mkdirSync(path.dirname(profil), { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  mkdirSync(path.join(profil, "user"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(profil, "user", "registrymodifications.xcu"), REGISTRY_XCU);
  writeFileSync(path.join(profil, ".elpis-profile"), PROFILE_VERSION);
}

const NOM_VERROU = /^[a-z0-9][a-z0-9_.-]{0,80}$/u;
let dossierImpose: string | null = null;
let flockAbsent = false;
const tenusSansFlock = new Map<number, string>();

/** Tests : dossier des verrous imposé (`null` : celui de l'exécution). */
export function surchargerDossierVerrous(d: string | null): void {
  dossierImpose = d;
}

/** `LOCK_DIR` : `runtime_path("office_locks", "ELPIS_OFFICE_LOCK_DIR", "/tmp/elpis_office_locks")`. */
export function dossierVerrous(): string {
  if (dossierImpose !== null) return dossierImpose;
  const propre = stripPy(process.env["ELPIS_OFFICE_LOCK_DIR"] ?? "");
  if (propre) return propre;
  const racine = stripPy(process.env["ELPIS_RUNTIME_DIR"] ?? "");
  return racine ? path.join(racine, "office_locks") : "/tmp/elpis_office_locks";
}

function dossierPret(d: string): boolean {
  try {
    mkdirSync(d, { recursive: true });
    chmodSync(d, 0o700);
    return true;
  } catch (e) {
    log.warn(`[office] dossier de verrous ${d} inutilisable (${(e as Error).message})`);
    return false;
  }
}

/** `flock -x -n` sur le descripteur hérité : le verrou reste sur la description ouverte que garde ce processus. */
function flockNonBloquant(fd: number): Promise<boolean | null> {
  return new Promise((fin) => {
    let enfant;
    try {
      enfant = spawn("flock", ["-x", "-n", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    } catch {
      fin(null);
      return;
    }
    enfant.once("error", (e: NodeJS.ErrnoException) => fin(e.code === "ENOENT" ? null : false));
    enfant.once("exit", (code) => fin(code === 0));
  });
}

/** `try_lock` : verrou exclusif non bloquant `<dossier>/<nom>.lock` → descripteur, ou `null`. */
export async function tryLock(nom: string): Promise<number | null> {
  const d = dossierVerrous();
  if (!NOM_VERROU.test(nom) || !dossierPret(d)) return null;
  const chemin = path.join(d, `${nom}.lock`);
  for (let essai = 0; essai < 4; essai++) {
    let fd: number;
    try {
      fd = openSync(chemin, constants.O_RDWR | constants.O_CREAT, 0o600);
    } catch {
      return null;
    }
    let obtenu = await flockNonBloquant(fd);
    if (obtenu === null) {
      if (!flockAbsent) {
        flockAbsent = true;
        log.warn(
          "[office] commande flock (util-linux) absente : verrous de conversion propres à ce processus",
        );
      }
      obtenu = ![...tenusSansFlock.values()].includes(chemin);
      if (obtenu) tenusSansFlock.set(fd, chemin);
    }
    if (!obtenu) {
      closeSync(fd);
      return null;
    }
    let meme: boolean;
    try {
      meme = fstatSync(fd).ino === statSync(chemin).ino;
    } catch {
      meme = false;
    }
    if (meme) {
      try {
        const t = Date.now() / 1000;
        utimesSync(chemin, t, t);
      } catch {
        // date d'usage non mise à jour
      }
      return fd;
    }
    releaseLock(fd);
  }
  return null;
}

export function releaseLock(fd: number | null): void {
  if (fd === null) return;
  tenusSansFlock.delete(fd);
  try {
    closeSync(fd);
  } catch {
    // déjà fermé
  }
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Horloge monotone en secondes (`time.monotonic`). */
export function monotone(): number {
  return performance.now() / 1000;
}

/** `acquire_first` : le premier verrou libre de `noms` avant `echeance` (monotone) → `[fd, nom]` ; sinon 503 « busy ». */
export async function acquireFirst(noms: readonly string[], echeance: number): Promise<[number, string]> {
  for (;;) {
    for (const n of noms) {
      const fd = await tryLock(n);
      if (fd !== null) return [fd, n];
    }
    if (monotone() >= echeance) throw new ErreurOffice("busy", 503, "Conversions occupées, réessayez");
    await dormir(250);
  }
}

export interface OptionsArgv {
  readonly isolation: string;
  readonly soffice: string;
  readonly profil: string;
  readonly job: string;
  readonly kind: string;
  readonly inName: string;
  readonly convertTo: string;
  readonly timeoutS: number;
  readonly autres?: readonly string[];
}

/** `build_argv` : prlimit → bwrap → soffice. */
export function buildArgv(o: OptionsArgv): string[] {
  const prison = o.isolation === "bwrap";
  const profilDedans = prison ? "/profile" : o.profil;
  const jobDedans = prison ? "/job" : o.job;
  const lo = [
    o.soffice,
    ...["--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck"],
    `-env:UserInstallation=file://${profilDedans}`,
    `--infilter=${INFILTERS[o.kind] ?? ""}`,
    "--convert-to",
    o.convertTo,
    "--outdir",
    `${jobDedans}/out`,
    `${jobDedans}/${o.inName}`,
    ...(o.autres ?? []).map((n) => `${jobDedans}/${n}`),
  ];
  const argv: string[] = [];
  const prlimit = which("prlimit");
  if (prlimit)
    argv.push(
      prlimit,
      `--cpu=${Math.trunc(o.timeoutS) * 2 + 30}`,
      `--fsize=${1024 * 1024 * 1024}`,
      "--nofile=1024",
      "--",
    );
  if (prison)
    argv.push(
      bwrap.binary() || "bwrap",
      ...bwrapBase([path.dirname(path.dirname(o.soffice))]),
      ...["--bind", o.profil, "/profile"],
      ...["--bind", o.job, "/job"],
      ...["--setenv", "HOME", "/profile"],
      ...["--setenv", "TMPDIR", "/tmp"],
      ...["--chdir", "/job", "--"],
    );
  return [...argv, ...lo];
}

/** `child_env` : environnement minimal, jamais celui du processus (secrets). */
export function childEnv(isolation: string, profil: string, job: string): Record<string, string> {
  const prison = isolation === "bwrap";
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: prison ? "/profile" : profil,
    TMPDIR: prison ? "/tmp" : path.join(job, "tmp"),
  };
}

function tuerGroupe(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // groupe déjà parti
  }
}

export type LanceurSoffice = (
  argv: readonly string[],
  env: Record<string, string>,
  o: { cwd: string; logPath: string; timeoutS: number; signal?: AbortSignal },
) => Promise<number>;

/** `run_soffice` : conversion dans une nouvelle session ; échéance ou annulation → tout le groupe tué. */
export const runSofficeReel: LanceurSoffice = async (argv, env, o) => {
  mkdirSync(path.join(o.cwd, "tmp"), { recursive: true });
  const journal = await open(o.logPath, "w");
  try {
    const enfant = spawn(argv[0] as string, argv.slice(1), {
      env,
      cwd: o.cwd,
      detached: true,
      stdio: ["ignore", journal.fd, journal.fd],
    });
    let fini = false;
    const fin = new Promise<number>((ok, ko) => {
      enfant.once("error", ko);
      enfant.once("exit", (code, signal) => {
        fini = true;
        ok(code ?? -((signal ? os.constants.signals[signal] : undefined) ?? 1));
      });
    });
    let minuterie: NodeJS.Timeout | undefined;
    const delai = new Promise<"delai">((ok) => {
      minuterie = setTimeout(() => ok("delai"), o.timeoutS * 1000);
    });
    const annule = new Promise<"annule">((ok) => {
      if (o.signal?.aborted) ok("annule");
      o.signal?.addEventListener("abort", () => ok("annule"), { once: true });
    });
    try {
      const r = await Promise.race([fin, delai, annule]);
      if (r === "delai") {
        tuerGroupe(enfant.pid);
        await fin.catch(() => -1);
        throw new ErreurOffice("timeout", 504, "Conversion trop longue (délai dépassé)");
      }
      if (r === "annule") {
        tuerGroupe(enfant.pid);
        await fin.catch(() => -1);
        throw o.signal?.reason ?? new Error("annulé");
      }
      return r;
    } finally {
      clearTimeout(minuterie);
      if (!fini) tuerGroupe(enfant.pid);
    }
  } finally {
    await journal.close();
  }
};

let lanceur: LanceurSoffice = runSofficeReel;

/** Tests : lanceur de LibreOffice imposé (`null` : le vrai). */
export function surchargerLanceur(f: LanceurSoffice | null): void {
  lanceur = f ?? runSofficeReel;
}

export function runSoffice(...a: Parameters<LanceurSoffice>): Promise<number> {
  return lanceur(...a);
}

/** `read_log_tail` : fin du journal de LibreOffice, sans les lignes `javaldx` ni les vides. */
export function readLogTail(chemin: string, limite = 400): string {
  let data: Buffer;
  try {
    data = readFileSync(chemin);
  } catch {
    return "";
  }
  const texte = data.subarray(Math.max(0, data.length - 4096)).toString("utf8");
  const lignes = splitlinesPy(texte).filter((l) => !l.includes("javaldx") && stripPy(l));
  const tout = Array.from(lignes.join("\n"));
  return tout.slice(Math.max(0, tout.length - limite)).join("");
}

const PAGE_RE = /\/Type[ \t\n\r\f\v]{0,8}\/Page(?![a-zA-Z])/gu;
const PAGE_CARRY = 32;

/** `count_pdf_pages` : objets `/Type /Page`, lus par blocs (une occurrence jugée seulement si l'octet suivant est là). */
export async function countPdfPages(pdf: string, bloc = 1 << 20): Promise<number> {
  let compte = 0;
  let reste = "";
  let fh;
  try {
    fh = await open(pdf, "r");
  } catch {
    return 0;
  }
  try {
    const tampon = Buffer.alloc(bloc);
    for (;;) {
      const { bytesRead } = await fh.read(tampon, 0, bloc, null);
      const final = bytesRead === 0;
      const buf = reste + tampon.subarray(0, bytesRead).toString("latin1");
      const limite = final ? buf.length : buf.length - PAGE_CARRY;
      let suivant = Math.max(0, limite);
      PAGE_RE.lastIndex = 0;
      for (let m = PAGE_RE.exec(buf); m !== null; m = PAGE_RE.exec(buf)) {
        if (m.index + m[0].length <= limite) compte++;
        else {
          suivant = Math.min(suivant, m.index);
          break;
        }
      }
      if (final) break;
      reste = buf.slice(suivant);
    }
  } catch {
    return 0;
  } finally {
    await fh.close();
  }
  return compte;
}
