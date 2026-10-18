// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/shell/pont.ts — pont des outils vers le conteneur du compte (llm_core/tools/_exec_bridge.py) : bac et profil réseau du compte, exécution, sortie live, sortie complète sauvée dans le bac, résultat formaté. */
import { closeSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bacDeLOutil, erreurAgent, estErreurAgent } from "@elpis/bac";
import type { PortProfilRappel } from "@elpis/bac";
import type { AgentBac, DonneesEnvoi, ExecResult, OptionsExec } from "@elpis/bac";
import { decoderRemplace } from "@elpis/bac";
import { fixePy, journalDe, longueurPy, prefixePy, reprPy, suffixePy } from "@elpis/commun";
import type { Dict, Journal } from "@elpis/commun";
import { LIVE_KIND_SHELL, LIVE_LOGGER_SHELL, Heartbeat, liveNotify, readMetaField } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { auditCodeExec, toContainer } from "@elpis/securite";

import { strErreurAnglais } from "../anglais";

/** Réglages du pont (modifiables par les tests). */
export const reglagesPont = {
  fluxSeuil: 2048,
  fluxDelaiMs: 150,
  fluxPlafond: 65_536,
  fluxFermetureMs: 2_000,
  /** `SpooledTemporaryFile(max_size=4 << 20)` : au-delà, copie sur le disque de l'hôte. */
  tamponMemoire: 4 << 20,
  /** Au-delà (par flux), la copie complète est abandonnée : rien n'est sauvé (écart : le Python remplit le disque de l'hôte). */
  tamponMax: 256 << 20,
  /** Purge de `.tool-output/` et `.bg/` (écart voulu au Python, qui n'en faisait pas) : âge, volume, fraîcheur protégée, intervalle par compte. */
  purgeAgeJours: 7,
  purgeMaxOctets: 200 * 1024 * 1024,
  purgeRecentS: 3600,
  purgeIntervalleMs: 3_600_000,
};

/** Script de purge (sh du conteneur, dans /work) : journaux de l'outil seulement, jamais un fichier ouvert par un processus ; `$1` jours, `$2` octets, `$3` secondes. */
export const SCRIPT_PURGE =
  'age=$(($1 * 86400)); max="$2"; recent="$3"; now=$(date +%s); base=$(pwd -P); ' +
  'ouverts=$(for f in /proc/[0-9]*/fd/*; do readlink "$f"; done 2>/dev/null | sort -u); ' +
  "liste=$(find .tool-output .bg -maxdepth 1 -type f -regextype posix-extended " +
  "-regex '[.](tool-output/shell|bg/bg)-[0-9]+-[0-9a-f]{6}[.]log' -printf '%T@ %s %p\\n' 2>/dev/null | sort -n); " +
  "total=$(printf '%s\\n' \"$liste\" | awk 'NF == 3 { t += $2 } END { print t + 0 }'); " +
  'printf \'%s\\n\' "$liste" | while read -r t taille p; do [ -n "$p" ] || continue; t=${t%.*}; ' +
  'if [ $((now - t)) -gt "$age" ] || { [ "$total" -gt "$max" ] && [ $((now - t)) -gt "$recent" ]; }; then ' +
  'printf \'%s\\n\' "$ouverts" | grep -Fqx -- "$base/$p" && continue; ' +
  'rm -f -- "$p" && total=$((total - taille)); fi; done';

export const PATH_CONTENEUR =
  "/work/.python-user/bin:/work/.local/bin:/work/.npm-global/bin" +
  ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MARQUE_STDERR = Buffer.from("\n--- STDERR ---\n");
/** Environnement de base des commandes de l'outil (`execute_shell`, jobs de fond). */
export const ENV_BASE: Readonly<Record<string, string>> = {
  PATH: PATH_CONTENEUR,
  HOME: "/work",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
  PYTHONUSERBASE: "/work/.python-user",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PIP_BREAK_SYSTEM_PACKAGES: "1",
};

/** Ce que le pont demande au bac d'un compte (`UserSandbox`). */
export interface BacShell {
  readonly containerName: string;
  /** `P/work` monté sur `/work` (noms seulement, jamais ouvert par l'hôte). */
  readonly sandboxPath: string;
  readonly networkProfileId: string | null;
  readonly agent: AgentBac;
  exec(cmd: readonly string[], options?: OptionsExec): Promise<ExecResult>;
}

/** Appels de l'agent du conteneur dont se servent les outils (`AgentClient` de @elpis/fichiers). */
export interface AgentOutils {
  stat(paths: Iterable<string>, o?: { hash?: boolean; hashMax?: number }): Promise<Dict[]>;
  write(p: string, data: DonneesEnvoi, o?: { parents?: boolean }): Promise<Dict>;
  changesBegin(
    skip: Iterable<string>,
    o?: { maxEntries?: number; deadlineS?: number; allKinds?: boolean },
  ): Promise<Dict>;
  changesEnd(
    ident: string,
    o?: { maxFiles?: number; maxBytes?: number; maxFile?: number },
  ): Promise<[Dict[], Dict]>;
}

/** Agent du bac vu par les outils ; `agent_unavailable` si la fabrique posée n'en est pas un. */
export function agentOutils(bac: BacShell): AgentOutils {
  const a = bac.agent as unknown as Partial<AgentOutils>;
  if (typeof a.stat !== "function" || typeof a.write !== "function" || typeof a.changesBegin !== "function")
    throw erreurAgent("agent_unavailable", "sandbox agent client without the tool calls");
  return a as AgentOutils;
}

/** Bac d'un appel : `bacDeLOutil` de @elpis/bac (profil effectif commun aux familles de l'hôte) ; doublé par les tests. */
export type FabriqueBacShell = (
  uid: number,
  username: string,
  rappel: PortProfilRappel | null,
) => Promise<BacShell>;

export interface DependancesPont {
  readonly rappel?: PortProfilRappel | null;
  readonly journal?: Pick<Journal, "info" | "warn"> | null;
  readonly bac?: FabriqueBacShell;
  readonly audit?: typeof auditCodeExec;
}

/** Sortie d'une exécution (`ExecResult`), telle que le formatage la lit. */
export type ResultatExec = Pick<
  ExecResult,
  "returncode" | "stdout" | "stderr" | "duration_s" | "timed_out" | "executor_tag"
>;

export interface OptionsShell {
  readonly tokens: readonly string[];
  /** `P/work` vu par l'outil (le bac le recalcule : `racineTravail`). */
  readonly sandboxRoot: string;
  readonly workdirRel?: string;
  readonly envExtra: Readonly<Record<string, string>>;
  readonly timeoutS: number;
  readonly maxOutput: number;
  readonly stdin: Buffer | null;
  readonly userId: number;
  readonly username: string;
  readonly auditKind?: string;
  readonly ctx?: ContexteAppel | null;
  readonly saveStdoutRel?: string | null;
  readonly autoSpillRel?: string | null;
  readonly spillOverChars?: number | null;
  readonly streamLive?: boolean;
  /** Flux non textuel remplacé par un résumé et toujours sauvé (`execute_shell`, harnais N-18). */
  readonly resumerBinaire?: boolean;
}

/** Message d'une exception comme `str(e)` de Python (`AgentError` : `code: message`). */
export function strErreur(e: unknown): string {
  if (estErreurAgent(e)) return e.message ? `${e.code}: ${e.message}` : e.code;
  return e instanceof Error ? e.message : String(e);
}

function sansAttente(p: Promise<unknown> | null | undefined): void {
  p?.catch(() => undefined);
}

/** `_ShellStreamBatcher` : sortie d'un exec en notifications `shell_output` (2 Kio ou 150 ms, 64 Kio en tout), `done` toujours émis. */
export class FluxShell {
  private readonly ctx: ContexteAppel;
  private readonly callId: string | null;
  private readonly logToken: string | null;
  private enAttente: [string, string][] = [];
  private enAttenteChars = 0;
  private envoyes = 0;
  private seq = 0;
  private tronque = false;
  private minuterie: NodeJS.Timeout | null = null;
  private readonly envois: Promise<void>[] = [];
  private readonly decodeurs = {
    stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
  };

  constructor(ctx: ContexteAppel) {
    this.ctx = ctx;
    this.callId = readMetaField(ctx, "call_id");
    this.logToken = readMetaField(ctx, "log_token");
  }

  ajouter(flux: "stdout" | "stderr", data: Uint8Array): void {
    if (this.envoyes >= reglagesPont.fluxPlafond) {
      this.tronque = true;
      return;
    }
    let texte = this.decodeurs[flux].decode(data, { stream: true });
    if (!texte) return;
    const place = reglagesPont.fluxPlafond - this.envoyes - this.enAttenteChars;
    if (place <= 0) {
      this.tronque = true;
      return;
    }
    let n = longueurPy(texte);
    if (n > place) {
      texte = prefixePy(texte, place);
      n = place;
      this.tronque = true;
    }
    const der = this.enAttente.at(-1);
    if (der !== undefined && der[0] === flux) der[1] += texte;
    else this.enAttente.push([flux, texte]);
    this.enAttenteChars += n;
    if (this.enAttenteChars >= reglagesPont.fluxSeuil) this.vider();
    else if (this.minuterie === null)
      this.minuterie = setTimeout(() => this.vider(), reglagesPont.fluxDelaiMs);
  }

  private vider(): void {
    if (this.minuterie !== null) clearTimeout(this.minuterie);
    this.minuterie = null;
    if (this.enAttente.length === 0) return;
    const lot = this.enAttente;
    this.enAttente = [];
    this.enAttenteChars = 0;
    for (const [flux, texte] of lot) {
      this.seq++;
      this.envoyes += longueurPy(texte);
      this.notifier({ stream: flux, chunk: texte, seq: this.seq, done: false });
    }
  }

  private notifier(charge: Dict): void {
    const p: Dict = { ...charge };
    if (this.callId && !Object.hasOwn(p, "call_id")) p["call_id"] = this.callId;
    if (this.logToken && !Object.hasOwn(p, "log_token")) p["log_token"] = this.logToken;
    const envoi = liveNotify(this.ctx, LIVE_KIND_SHELL, p, { loggerName: LIVE_LOGGER_SHELL });
    if (envoi !== null) this.envois.push(envoi.catch(() => undefined));
  }

  /** Dernier lot puis `done` ; attend (2 s au plus) que tout soit écrit avant le résultat de l'outil. */
  async fermer(o: { returncode: number; durationMs: number; timedOut: boolean }): Promise<void> {
    this.vider();
    this.seq++;
    this.notifier({
      done: true,
      seq: this.seq,
      returncode: o.returncode,
      duration_ms: o.durationMs,
      timed_out: o.timedOut,
      bytes_total: this.envoyes,
      live_truncated: this.tronque,
    });
    let minuterie: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(this.envois),
      new Promise<void>((fin) => {
        minuterie = setTimeout(fin, reglagesPont.fluxFermetureMs);
      }),
    ]);
    clearTimeout(minuterie);
    this.envois.length = 0;
  }
}

/** Fichier anonyme 0600 de l'hôte (`TemporaryFile`) : son nom est retiré aussitôt ouvert, rien ne reste si le process meurt. */
function fichierAnonyme(): number {
  const dossier = mkdtempSync(path.join(tmpdir(), "elpis-shell-"));
  try {
    const chemin = path.join(dossier, "sortie");
    const fd = openSync(chemin, "w+", 0o600);
    unlinkSync(chemin);
    return fd;
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
}

function ecrireTout(fd: number, b: Buffer): void {
  for (let fait = 0; fait < b.length;) fait += writeSync(fd, b, fait, b.length - fait);
}

async function* lireFd(fd: number, taille: number): AsyncGenerator<Uint8Array> {
  const bloc = Buffer.alloc(1 << 20);
  for (let pos = 0; pos < taille;) {
    const n = readSync(fd, bloc, 0, Math.min(bloc.length, taille - pos), pos);
    if (n <= 0) return;
    pos += n;
    yield Buffer.from(bloc.subarray(0, n));
  }
}

/** `SpooledTemporaryFile` : octets en mémoire, puis dans un fichier anonyme de l'hôte ; `echec` dit pourquoi la copie a été abandonnée. */
export class Tampon {
  private morceaux: Buffer[] = [];
  private fd: number | null = null;
  octets = 0;
  echec: string | null = null;

  /** Descripteur du fichier de l'hôte (`null` tant que tout tient en mémoire). */
  get descripteur(): number | null {
    return this.fd;
  }

  ecrire(data: Uint8Array): void {
    if (this.echec !== null) return;
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (this.octets + b.length > reglagesPont.tamponMax) {
      this.abandonner(`output larger than ${reglagesPont.tamponMax} bytes: not saved`);
      return;
    }
    try {
      if (this.fd === null && this.octets + b.length > reglagesPont.tamponMemoire) {
        this.fd = fichierAnonyme();
        for (const m of this.morceaux) ecrireTout(this.fd, m);
        this.morceaux = [];
      }
      if (this.fd !== null) ecrireTout(this.fd, b);
      else this.morceaux.push(Buffer.from(b));
      this.octets += b.length;
    } catch (e) {
      this.abandonner(`host spool: ${strErreur(e)}`);
    }
  }

  private abandonner(raison: string): void {
    this.fermer();
    this.echec = raison;
  }

  /** Recopie le contenu d'un autre tampon à la suite. */
  recopier(autre: Tampon): void {
    if (autre.echec !== null) {
      this.abandonner(autre.echec);
      return;
    }
    if (autre.fd === null) {
      for (const m of autre.morceaux) this.ecrire(m);
      return;
    }
    const bloc = Buffer.alloc(1 << 20);
    for (let pos = 0; pos < autre.octets;) {
      const n = readSync(autre.fd, bloc, 0, bloc.length, pos);
      if (n <= 0) break;
      this.ecrire(bloc.subarray(0, n));
      pos += n;
    }
  }

  /** Corps à envoyer à l'agent : les octets, ou le fichier anonyme lu par blocs (taille connue). */
  envoi(): DonneesEnvoi {
    if (this.fd !== null) return { flux: lireFd(this.fd, this.octets), taille: this.octets };
    return Buffer.concat(this.morceaux);
  }

  fermer(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.morceaux = [];
  }
}

/** `_format_result` : sorties décodées, QUEUE gardée au-delà de `maxOutput` (points de code), petits champs d'abord. */
export function formatResult(r: ResultatExec, cmd: unknown, maxOutput: number, cwd: string): Dict {
  let stdout = decoderRemplace(r.stdout);
  let stderr = decoderRemplace(r.stderr);
  let truncated = false;
  const couper = (s: string): string => {
    const n = longueurPy(s);
    if (n <= maxOutput) return s;
    truncated = true;
    return `...[TRUNCATED — ${n - maxOutput} chars omitted, showing the tail]\n` + suffixePy(s, maxOutput);
  };
  stdout = couper(stdout);
  stderr = couper(stderr);
  if (r.timed_out)
    return {
      ok: false,
      error: "timeout",
      hint: `Exceeded ${fixePy(r.duration_s, 1)}s.`,
      cmd,
      cwd,
      returncode: 124,
      duration_ms: Math.trunc(r.duration_s * 1000),
      executor: r.executor_tag,
      stdout,
      stderr,
    };
  return {
    ok: r.returncode === 0,
    cmd,
    cwd,
    returncode: r.returncode,
    truncated,
    duration_ms: Math.trunc(r.duration_s * 1000),
    executor: r.executor_tag,
    stdout,
    stderr,
  };
}

/** Sortie sauvée : tête et queue injectées, environ 4 Ko en tout (écart voulu au Python, qui en injectait jusqu'à 20 000 caractères par flux). */
export const APERCU_SAUVE = { tete: 1500, queue: 2500 };

/** Tête et queue de `s` reliées par la ligne « … N chars omitted … » ; `null` si `s` tient dans le budget. */
export function apercu(s: string, tete: number, queue: number): string | null {
  const n = longueurPy(s);
  if (n <= tete + queue) return null;
  return `${prefixePy(s, tete)}\n… ${n - tete - queue} chars omitted …\n${suffixePy(s, queue)}`;
}

/** Flux sauvés remplacés par leur aperçu quand il est plus court (stderr, s'il est sauvé, a au moins le quart du budget et ce que stdout n'use pas) ; vrai si l'un l'a été. */
function apercuSauve(formatted: Dict, r: ResultatExec, stdoutSeul: boolean): boolean {
  const total = APERCU_SAUVE.tete + APERCU_SAUVE.queue;
  const out = decoderRemplace(r.stdout);
  const err = stdoutSeul ? "" : decoderRemplace(r.stderr);
  const partOut = Math.min(longueurPy(out), total - Math.min(longueurPy(err), Math.floor(total / 4)));
  const partErr = stdoutSeul ? 0 : total - partOut;
  const budgets: [string, string, number][] = [["stdout", out, stdoutSeul ? total : partOut]];
  if (!stdoutSeul) budgets.push(["stderr", err, partErr]);
  let fait = false;
  for (const [flux, texte, budget] of budgets) {
    const tete = Math.floor((budget * APERCU_SAUVE.tete) / total);
    const court = apercu(texte, tete, budget - tete);
    if (court === null || longueurPy(court) >= longueurPy(String(formatted[flux] ?? ""))) continue;
    formatted[flux] = court;
    fait = true;
  }
  if (fait) formatted["truncated"] = true;
  return fait;
}

/** Octets d'une sortie binaire montrés en hexadécimal (comme `read_file`). */
export const APERCU_BINAIRE = 512;
const ECHANTILLON_BINAIRE = 8192;
/** Contrôles admis dans un texte : bip, retour arrière, tabulations, fins de ligne, saut de page, ESC (couleurs ANSI). */
const CONTROLES_TEXTE = new Set([7, 8, 9, 10, 11, 12, 13, 27]);
const DECODEUR_ECHANTILLON = new TextDecoder("utf-8", { ignoreBOM: true });

/** Part des caractères suspects (NUL et autres contrôles hors texte, DEL, octets UTF-8 invalides) dans `octets`. */
export function partNonTexte(octets: Uint8Array): number {
  let n = 0;
  let suspects = 0;
  for (const c of DECODEUR_ECHANTILLON.decode(octets)) {
    const u = c.codePointAt(0) ?? 0;
    n++;
    if (u === 0xfffd || u === 127 || (u < 32 && !CONTROLES_TEXTE.has(u))) suspects++;
  }
  return n ? suspects / n : 0;
}

/** Sortie non textuelle : au moins 30 % de caractères suspects dans ses 8 premiers ou ses 8 derniers Kio. */
export function sortieBinaire(octets: Uint8Array): boolean {
  if (!octets.length) return false;
  const parts =
    octets.length <= 2 * ECHANTILLON_BINAIRE
      ? [octets]
      : [octets.subarray(0, ECHANTILLON_BINAIRE), octets.subarray(octets.length - ECHANTILLON_BINAIRE)];
  return parts.some((p) => partNonTexte(p) >= 0.3);
}

interface FluxBinaire {
  readonly flux: "stdout" | "stderr";
  readonly octets: number;
  readonly tete: Uint8Array;
}

/** Taille complète d'un flux : sa copie par l'outil si elle est entière, sinon sa capture. */
function tailleFlux(t: Tampon | null, capture: Buffer): number {
  const c = copieUtile(t, capture);
  return c !== null && c.echec === null ? c.octets : capture.length;
}

/** Flux non textuels d'une exécution, avec leur taille complète. */
function fluxBinaires(r: ResultatExec, copies: { out: Tampon | null; err: Tampon | null }): FluxBinaire[] {
  const vus: FluxBinaire[] = [];
  for (const [flux, capture, copie] of [
    ["stdout", r.stdout, copies.out],
    ["stderr", r.stderr, copies.err],
  ] as const)
    if (sortieBinaire(capture))
      vus.push({ flux, octets: tailleFlux(copie, capture), tete: capture.subarray(0, APERCU_BINAIRE) });
  return vus;
}

/** Flux binaires remplacés par un résumé (taille, hexdump de la tête) et un `hint` vers le fichier sauvé ou `save_stdout`. */
function resumerBinaires(
  formatted: Dict,
  binaires: readonly FluxBinaire[],
  sauve: { stdout: string | null; stderr: string | null; offsetStderr: number },
): void {
  const phrases: string[] = [];
  for (const b of binaires) {
    formatted[b.flux] = `[binary output: ${b.octets} bytes, not shown]`;
    formatted[`${b.flux}_binary`] = true;
    formatted[`${b.flux}_bytes`] = b.octets;
    formatted[`${b.flux}_preview_hex`] = Buffer.from(b.tete).toString("hex");
    const ou = sauve[b.flux];
    const offset = b.flux === "stderr" ? sauve.offsetStderr : 0;
    phrases.push(
      `${b.flux} is binary (${b.octets} bytes): not shown, ${b.flux}_preview_hex is a hexdump of its first ` +
        `${b.tete.length} bytes.` +
        (ou !== null
          ? ` It was saved to ${ou}${offset ? ` from byte ${offset}` : ""}: read a byte range with ` +
            `read_file(path="${ou}", offset=${offset}, length=4096) (base64).`
          : ` To get the bytes, re-run with ${b.flux === "stdout" ? 'save_stdout="out.bin" (or > out.bin)' : "2> err.bin"} ` +
            "and read them with read_file(offset/length), or pipe them through xxd, od or base64."),
    );
  }
  const avant = typeof formatted["hint"] === "string" ? `${formatted["hint"]} ` : "";
  formatted["hint"] = avant + phrases.join(" ");
  formatted["truncated"] = true;
}

/** `_got` : la copie complète, sauf si l'exécuteur n'a rien recopié alors que sa capture n'est pas vide. */
function copieUtile(t: Tampon | null, capture: Buffer): Tampon | null {
  return t !== null && (t.octets > 0 || capture.length === 0) ? t : null;
}

/** `_save_outputs` : `save_stdout` ou débord automatique (stdout, puis stderr après une marque) depuis les copies complètes ; vrai si un fichier était demandé. */
export async function saveOutputs(
  formatted: Dict,
  r: ResultatExec,
  agent: () => AgentOutils,
  o: { saveStdoutRel: string | null; autoSpillRel: string | null; spillOverChars: number | null },
  copies: { out: Tampon | null; err: Tampon | null },
): Promise<boolean> {
  const out = copieUtile(copies.out, r.stdout);
  const err = out !== null ? copieUtile(copies.err, r.stderr) : null;
  const ecrire = (rel: string, data: DonneesEnvoi): Promise<Dict> =>
    agent().write(rel, data, { parents: true });
  if (o.saveStdoutRel !== null) {
    if (out?.echec) {
      formatted["save_error"] = prefixePy(out.echec, 200);
      return true;
    }
    try {
      const n = out !== null ? out.octets : r.stdout.length;
      await ecrire(o.saveStdoutRel, out !== null ? out.envoi() : r.stdout);
      formatted["saved_bytes"] = n;
    } catch (e) {
      formatted["save_error"] = prefixePy(strErreurAnglais(e), 200);
    }
    return true;
  }
  const nOut = out !== null ? out.octets : r.stdout.length;
  const nErr = err !== null ? err.octets : r.stderr.length;
  if (
    o.autoSpillRel !== null &&
    (formatted["truncated"] === true || (o.spillOverChars !== null && nOut + nErr > o.spillOverChars))
  ) {
    const abandon = out?.echec ?? err?.echec ?? null;
    if (abandon !== null) {
      formatted["save_error"] = prefixePy(abandon, 200);
      return true;
    }
    try {
      let n: number;
      if (out !== null) {
        if (nErr) {
          out.ecrire(MARQUE_STDERR);
          if (err !== null) out.recopier(err);
          else out.ecrire(r.stderr);
        }
        n = out.octets;
        await ecrire(o.autoSpillRel, out.envoi());
      } else {
        const complet = r.stderr.length ? Buffer.concat([r.stdout, MARQUE_STDERR, r.stderr]) : r.stdout;
        n = complet.length;
        await ecrire(o.autoSpillRel, complet);
      }
      formatted["saved_bytes"] = n;
      formatted["auto_saved"] = true;
    } catch (e) {
      formatted["save_error"] = prefixePy(strErreurAnglais(e), 200);
    }
    return true;
  }
  return false;
}

/** Pont des familles du bac (shell, skill_run) : un par hôte, ports posés par la composition. */
export class PontExec {
  private readonly rappel: PortProfilRappel | null;
  private readonly journal: Pick<Journal, "info" | "warn">;
  private readonly fabrique: FabriqueBacShell;
  private readonly audit: typeof auditCodeExec;

  constructor(dep: DependancesPont = {}) {
    this.rappel = dep.rappel ?? null;
    this.journal = dep.journal ?? journalDe("uvicorn.error");
    this.fabrique = dep.bac ?? bacDeLOutil;
    this.audit = dep.audit ?? auditCodeExec;
  }

  /** Purge best-effort des journaux de l'outil dans le conteneur du compte (`SCRIPT_PURGE`) ; une panne lève. */
  async purger(uid: number, username: string): Promise<void> {
    const sb = await this.bac(uid, username);
    await sb.exec(
      [
        "sh",
        "-c",
        SCRIPT_PURGE,
        "purge",
        String(reglagesPont.purgeAgeJours),
        String(reglagesPont.purgeMaxOctets),
        String(reglagesPont.purgeRecentS),
      ],
      { workdirInContainer: "/work", timeoutS: 30 },
    );
  }

  /** `get_user_sandbox` sous le profil effectif (`profilDuBac`) : le même bac que l'espace des autres familles. */
  bac(uid: number, username: string): Promise<BacShell> {
    return this.fabrique(uid, username, this.rappel);
  }

  /** Exécution consignée (`auditCodeExec`) : genre `kind`, commande, conteneur. */
  auditer(o: {
    userId: number;
    username: string;
    kind: string;
    code: string;
    executor: string;
    extra?: Record<string, unknown>;
  }): void {
    this.audit({
      userId: o.userId,
      username: o.username,
      kind: o.kind,
      code: o.code,
      pipelineId: null,
      runId: `tool-${o.username}`,
      nodeId: o.kind,
      executor: o.executor,
      extra: o.extra ?? null,
    });
  }

  /** `run_shell_via_executor` : exécution dans le conteneur (toujours par Docker), sortie live si demandée, sortie complète sauvée, résultat formaté ; une panne d'infrastructure lève. */
  async runShell(o: OptionsShell): Promise<Dict> {
    const ctx = o.ctx ?? null;
    const sb = await this.bac(o.userId, o.username);
    const apercu = o.tokens.slice(0, 4).join(" ");
    this.journal.info(
      `[bridge] execute_shell user=${reprPy(o.username)} user_id=${o.userId} tokens=${reprPy(o.tokens.slice(0, 3))} ` +
        `→ docker exec ${sb.containerName} (profile=${sb.networkProfileId || "isolated"})`,
    );
    sansAttente(ctx?.info(`shell → ${sb.containerName}: ${apercu}`));
    sansAttente(ctx?.reportProgress(0.0, 1.0, `running: ${apercu}`));
    const env = Object.assign(Object.create(null) as Record<string, string>, ENV_BASE);
    for (const [k, v] of Object.entries(o.envExtra)) if (v !== null && v !== undefined) env[k] = String(v);
    this.auditer({
      userId: o.userId,
      username: o.username,
      kind: o.auditKind ?? "tools.shell",
      code: o.tokens.join(" "),
      executor: sb.containerName,
      extra: { cmd_argv: [...o.tokens] },
    });
    const flux = o.streamLive && ctx !== null ? new FluxShell(ctx) : null;
    const saveRel = o.saveStdoutRel ?? null;
    const spillRel = o.autoSpillRel ?? null;
    const copieOut = saveRel !== null || spillRel !== null ? new Tampon() : null;
    const copieErr = copieOut !== null && saveRel === null ? new Tampon() : null;
    const surMorceau = (nom: "stdout" | "stderr", data: Buffer): void => {
      flux?.ajouter(nom, data);
      if (nom === "stdout") copieOut?.ecrire(data);
      else copieErr?.ecrire(data);
    };
    try {
      return await this.executer(sb, o, env, flux, surMorceau, { out: copieOut, err: copieErr });
    } finally {
      copieOut?.fermer();
      copieErr?.fermer();
    }
  }

  /** Exécution, fin du flux live et des notifications, formatage puis sauvegarde des sorties. */
  private async executer(
    sb: BacShell,
    o: OptionsShell,
    env: Readonly<Record<string, string>>,
    flux: FluxShell | null,
    surMorceau: (nom: "stdout" | "stderr", data: Buffer) => void,
    copies: { out: Tampon | null; err: Tampon | null },
  ): Promise<Dict> {
    const ctx = o.ctx ?? null;
    const t0 = performance.now();
    const battement = ctx !== null ? new Heartbeat(ctx).start() : null;
    let r: ExecResult;
    try {
      r = await sb.exec(o.tokens, {
        workdirInContainer: toContainer(o.workdirRel ?? ""),
        env,
        ...(o.stdin !== null ? { stdin: o.stdin } : {}),
        timeoutS: o.timeoutS,
        ...(flux !== null || copies.out !== null ? { onChunk: surMorceau } : {}),
      });
    } catch (e) {
      battement?.stop();
      if (flux !== null)
        await flux.fermer({
          returncode: -1,
          durationMs: Math.trunc(performance.now() - t0),
          timedOut: false,
        });
      throw e;
    }
    battement?.stop();
    const ecoule = Math.trunc(performance.now() - t0);
    if (flux !== null)
      await flux.fermer({ returncode: r.returncode, durationMs: ecoule, timedOut: r.timed_out });
    sansAttente(ctx?.reportProgress(1.0, 1.0, `done in ${ecoule} ms (rc=${r.returncode})`));
    if (r.returncode !== 0) sansAttente(ctx?.warning(`shell exited rc=${r.returncode} after ${ecoule} ms`));
    const formatted = formatResult(r, [...o.tokens], o.maxOutput, toContainer(o.workdirRel ?? ""));
    const binaires = o.resumerBinaire ? fluxBinaires(r, copies) : [];
    const nOut = tailleFlux(copies.out, r.stdout);
    const saveRel = o.saveStdoutRel ?? null;
    const spillRel = o.autoSpillRel ?? null;
    await saveOutputs(
      formatted,
      r,
      () => agentOutils(sb),
      {
        saveStdoutRel: saveRel,
        autoSpillRel: spillRel,
        spillOverChars: binaires.length ? 0 : (o.spillOverChars ?? null),
      },
      copies,
    );
    const sauve = formatted["saved_bytes"] !== undefined && formatted["save_error"] === undefined;
    if (binaires.length) {
      const spill = sauve && saveRel === null && spillRel !== null ? toContainer(spillRel) : null;
      resumerBinaires(formatted, binaires, {
        stdout: sauve && saveRel !== null ? toContainer(saveRel) : spill,
        stderr: spill,
        offsetStderr: nOut + MARQUE_STDERR.length,
      });
    }
    if (sauve && apercuSauve(formatted, r, saveRel !== null)) formatted["apercu"] = true;
    return formatted;
  }
}
