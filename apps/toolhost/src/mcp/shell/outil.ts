// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/shell/outil.ts — famille `shell` servie par l'hôte (llm_core/tools/shell_tools.py) : `execute_shell` dans le conteneur du compte, définition figée par le golden Python. */
import { randomBytes } from "node:crypto";

import { estErreurAgent, racineTravail } from "@elpis/bac";
import type { PortProfilRappel } from "@elpis/bac";
import {
  clesOrdonnees,
  estChiffresPy,
  intPy,
  longueurPy,
  lowerPy,
  prefixePy,
  splitlinesPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict, Journal } from "@elpis/commun";
import { AgentError } from "@elpis/fichiers";
import { py } from "@elpis/http";
import { err, getUsername, outilDuGolden, readMetaField } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden } from "@elpis/outils-mcp";
import goldenShell from "@elpis/outils-mcp/goldens/shell.json" with { type: "json" };
import {
  bornerDelaiShell,
  envShellSousAgent,
  ErreurCheminBac,
  FIX_SOUS_AGENT,
  lexicalRel,
  lireSousAgent,
  REFUS_FOND_SOUS_AGENT,
  restaurerMarqueursArgs,
  SHELL_SOUS_AGENT_DELAI_MAX_S,
  toContainer,
  userIdFor,
} from "@elpis/securite";

import { alerteRemplissage, refusRemplissage } from "../../fichiers/quota";
import { plancherDebord } from "./budget";
import { strErreurAnglais } from "../anglais";
import { executerDetache } from "./jobs/detache";
import { shellJob } from "./jobs/outil";
import type { AppuisJobs, ArgsJob, PortRappelJobs } from "./jobs/outil";
import { veilleurJobs } from "./jobs/veilleur";
import { enveloppeAnnulee, PontExec, reglagesPont } from "./pont";
import type { OptionsShell } from "./pont";
import { ATTENTE_DISQUE_MS, auPlus, rappelQuota, refusDisque, sousGardeDisque } from "../disque";
import type { GardeDisque } from "../disque";
import { brancherRappelProfil, Espace } from "../espace";
import { WorkChanges } from "../changements";

export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 600;
export const DEFAULT_MAX_OUTPUT = 20_000;
/** Commande en argument positionnel (`$1`), jamais réinterpolée ; `;` et `setsid` : `$!` est le PID de la commande. */
export const WRAPPER_FOND =
  'mkdir -p "$(dirname "$2")"; nohup setsid bash -c "$1" >"$2" 2>&1 </dev/null & echo "$!"';
/** Options de bash de `strict=true` (écart voulu au Python, sans ce paramètre). */
export const BASH_STRICT: readonly string[] = ["-euo", "pipefail"];
const CLE_ENV = /^[A-Z_][A-Z0-9_]*$/u;
const PYTHON_NU = /(?:^|[^\p{L}\p{N}_.])python(?:$|[^\p{L}\p{N}_3])/u;
const REDEMARRER =
  "Container may be down. Try restarting it via the sandbox panel (POST /api/sandbox/me/restart).";

/** Relevé d'une commande (`WorkChanges`) : `debut()` avant, `fin()` après, puis `attacher(result)` ; ne lève jamais. */
export interface ReleveCommande {
  debut(): Promise<void>;
  fin(): Promise<void>;
  attacher(result: Dict): Dict;
}

const B64_STRICT = /^([A-Za-z0-9+/]*)(={0,2})$/u;

/** `base64.b64decode(s, validate=True)` (a2b_base64 strict) : `null` hors alphabet ou si le remplissage ne complète pas exactement le dernier quadruplet. */
export function b64Valide(s: string): Buffer | null {
  const m = B64_STRICT.exec(s);
  if (m === null) return null;
  const reste = (m[1] ?? "").length % 4;
  const remplissage = (m[2] ?? "").length;
  if (remplissage === 0 ? reste !== 0 : reste < 2 || reste + remplissage !== 4) return null;
  return Buffer.from(s, "base64");
}

/** Arguments validés de `execute_shell` (signature du golden). */
export interface ArgsShell {
  readonly command: string;
  readonly cwd: string | null;
  readonly timeout_sec: number | null;
  readonly stdin: string;
  readonly stdin_b64: string;
  readonly env: Readonly<Record<string, string>>;
  readonly save_stdout: string;
  readonly background: boolean;
  readonly strict?: boolean;
  readonly on_timeout?: "kill" | "detach_and_wake";
}

/** Points d'appui de l'outil : bac, agent, identité, relevé et pont (doublés par les tests comme les `monkeypatch` du Python). */
export interface AppuisShell {
  racine(username: string): Promise<string>;
  stats(username: string, racine: string, rels: readonly string[]): Promise<Dict[]>;
  userIdFor(username: string): Promise<number>;
  releve(uid: number | null, username: string, racine: string): ReleveCommande;
  executer(o: OptionsShell): Promise<Dict>;
  plancherDebord(): number;
  /** Purge des journaux de l'outil dans le bac (harnais SH-12) ; absente : aucune purge. */
  purger?(uid: number, username: string): Promise<void>;
  /** Appuis de `shell_job` (rappel au core compris) ; absents : refus `not_available_here`. */
  jobs?: AppuisJobs;
  /** Alerte de remplissage du bac (harnais N-08), `null` sous le seuil ; absente : aucune. */
  alerteDisque?(uid: number, racine: string): Promise<string | null>;
  /** Motif de refus d'un lancement de tâche, bac presque plein (harnais N-08), `null` sous le seuil ; absent : aucun refus. */
  refusDisque?(uid: number, racine: string): Promise<string | null>;
}

/** Attente bornée de l'alerte après la commande : au-delà, rien cette fois (la mesure finit et remplit le cache). */
export const ATTENTE_ALERTE_MS = ATTENTE_DISQUE_MS;

const dernieresPurges = new Map<string, number>();

/** Purge lancée sans être attendue, au plus une fois par intervalle et par compte ; une panne est ignorée. */
export function purgerAuBesoin(a: AppuisShell, uid: number, username: string): Promise<void> | null {
  const maintenant = Date.now();
  const avant = dernieresPurges.get(username);
  if (!a.purger || (avant !== undefined && maintenant - avant < reglagesPont.purgeIntervalleMs)) return null;
  dernieresPurges.set(username, maintenant);
  return a.purger(uid, username).catch(() => undefined);
}

/** Oublie les dates des dernières purges (tests). */
export function oublierPurges(): void {
  dernieresPurges.clear();
}

class ValeurRefusee extends Error {}

/** Tête d'un message (avant `:`, ` —`, ` (`, un guillemet ou une fin de phrase) : là où commencent ses données. */
const FIN_DE_TETE = /:|\s[—–]|\s\(|['"`«]|\.(?:\s|$)/u;

/** Code stable sans donnée (écart voulu au Python, qui prenait le slug du message entier) : tête du message en `[a-z0-9_]`, 40 au plus. */
export function codeErreur(message: string): string {
  if (/codec can't encode/u.test(message)) return "invalid_text";
  const code = lowerPy(message.split(FIN_DE_TETE, 1)[0] ?? "")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40)
    .replace(/_+$/u, "");
  return code || "shell_error";
}

/** `_err(msg, hint, **kw)` de shell_tools. */
export function errShell(message: string, hint = "", kw: Dict = {}): Dict {
  return err(codeErreur(message), message, { fix: hint || null, ...kw });
}

/** `_clip_marked` : champ de diagnostic borné AVEC marque. */
export function clipMarked(s: unknown, cap = 2000): string {
  const t = veritePy(s) ? strPy(s) : "";
  const n = longueurPy(t);
  return n <= cap ? t : `${prefixePy(t, cap)}… [+${n - cap} chars omitted]`;
}

function demiPaire(c: string): boolean {
  const u = c.charCodeAt(0);
  return c.length === 1 && u >= 0xd800 && u <= 0xdfff;
}

/** `str.encode("utf-8")` : une suite de demi-paires lève avec le message de Python (positions en points de code). */
export function encoderStdin(s: string): Buffer {
  if (!s.isWellFormed()) {
    const points = Array.from(s);
    const i = points.findIndex(demiPaire);
    let j = i + 1;
    while (j < points.length && demiPaire(points[j] ?? "")) j++;
    const quoi =
      j - i === 1
        ? `character '\\u${(points[i] ?? "").charCodeAt(0).toString(16)}' in position ${i}`
        : `characters in position ${i}-${j - 1}`;
    throw new Error(`'utf-8' codec can't encode ${quoi}: surrogates not allowed`);
  }
  return Buffer.from(s, "utf8");
}

/** `_rel_sandbox` : chemin relatif à `/work`, sans lire le disque. */
function relBac(chemin: string, racine: string, quoi = "path"): string {
  if (!chemin) throw new ValeurRefusee(`${quoi} required`);
  try {
    return lexicalRel(racine, chemin);
  } catch (e) {
    if (e instanceof ErreurCheminBac) throw new ValeurRefusee(`${quoi} outside sandbox`);
    throw e;
  }
}

/** `Espace.stat` : une entrée ; `kind: error` levé en `AgentError`. */
async function statUne(a: AppuisShell, username: string, racine: string, rel: string): Promise<Dict> {
  const e = (await a.stats(username, racine, [rel]))[0];
  if (e === undefined) throw new Error("list index out of range");
  if (e["kind"] === "error") throw new AgentError(strPy(e["error"] || "io_error"), strPy(e["message"] || ""));
  return e;
}

/** `_resolve_cwd` : dossier de travail relatif à `/work`, vérifié par l'agent. */
async function resoudreCwd(
  a: AppuisShell,
  cwd: string | null,
  racine: string,
  username: string,
): Promise<string> {
  if (!cwd) return "";
  const rel = relBac(cwd, racine, "cwd");
  let e: Dict;
  try {
    e = await statUne(a, username, racine, rel);
  } catch (ex) {
    if (estErreurAgent(ex) && ex.code === "outside_root") throw new ValeurRefusee("cwd outside sandbox");
    throw ex;
  }
  if (veritePy(e["outside"])) throw new ValeurRefusee("cwd outside sandbox");
  if (e["kind"] !== "dir") throw new ValeurRefusee(`cwd not a directory: ${toContainer(rel)}`);
  return rel;
}

function horodatage(): string {
  return `${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString("hex")}`;
}

/** `execute_shell` : commande passée telle quelle à `bash -c` dans le conteneur du compte ; erreurs rendues en enveloppe, jamais levées. */
export async function executeShell(args: ArgsShell, ctx: ContexteAppel, a: AppuisShell): Promise<Dict> {
  const username = getUsername(ctx);
  const sousAgent = lireSousAgent(ctx.meta?.["subagent"]);
  if (sousAgent !== null && args.background)
    return err(REFUS_FOND_SOUS_AGENT.code, REFUS_FOND_SOUS_AGENT.message, { fix: REFUS_FOND_SOUS_AGENT.fix });
  try {
    const sb = await a.racine(username);
    if (typeof args.command !== "string" || !stripPy(args.command))
      return errShell("empty_command", "Provide a command to run.");
    let workdir: string;
    try {
      workdir = await resoudreCwd(a, args.cwd, sb, username);
    } catch (e) {
      if (e instanceof ValeurRefusee) return errShell(e.message, "cwd must be inside your sandbox.");
      throw e;
    }
    let saveRel: string | null = null;
    if (args.save_stdout) {
      try {
        saveRel = relBac(args.save_stdout, sb);
      } catch (e) {
        if (e instanceof ValeurRefusee) return errShell(`bad save_stdout: ${e.message}`);
        throw e;
      }
    }
    const autoSpill = !args.save_stdout && !args.background ? `.tool-output/shell-${horodatage()}.log` : null;
    if (args.stdin && args.stdin_b64)
      return errShell("stdin_conflict", "Use either stdin (text) or stdin_b64 (bytes), not both.");
    let stdin: Buffer | null = null;
    if (args.stdin_b64) {
      stdin = b64Valide(args.stdin_b64);
      if (stdin === null) return errShell("stdin_b64_invalid", "stdin_b64 must be valid base64.");
    } else if (args.stdin) stdin = encoderStdin(args.stdin);
    const envExtra = Object.create(null) as Record<string, string>;
    envExtra["GIT_TERMINAL_PROMPT"] = "0";
    for (const k of clesOrdonnees(args.env)) {
      const v = strPy(args.env[k]);
      if (longueurPy(k) > 64 || longueurPy(v) > 4000)
        return errShell("env_invalid", "Key<64 chars, value<4000 chars.");
      if (!CLE_ENV.test(k)) return errShell("env_key_invalid", `Key '${k}' must match [A-Z_][A-Z0-9_]*`);
      envExtra[k] = v;
    }
    for (const [k, v] of Object.entries(envShellSousAgent(sousAgent))) if (!(k in envExtra)) envExtra[k] = v;
    const plafond = sousAgent ? SHELL_SOUS_AGENT_DELAI_MAX_S : MAX_TIMEOUT_S;
    const voulu = Math.max(1, Math.min(intPy(args.timeout_sec || DEFAULT_TIMEOUT_S), plafond));
    const timeout = bornerDelaiShell(sousAgent, voulu);
    let tokens: string[];
    let delai: number;
    let journalFond = "";
    if (args.background) {
      journalFond = `/work/.bg/bg-${horodatage()}.log`;
      const fond = args.strict
        ? WRAPPER_FOND.replace('bash -c "$1"', `bash ${BASH_STRICT.join(" ")} -c "$1"`)
        : WRAPPER_FOND;
      tokens = ["bash", "-c", fond, "bash", args.command, journalFond];
      delai = 15;
    } else {
      tokens = ["bash", ...(args.strict ? BASH_STRICT : []), "-c", args.command];
      delai = timeout;
    }
    const detache = args.on_timeout === "detach_and_wake" && !args.background && sousAgent === null;
    const live = readMetaField(ctx, "live_shell") === "1" && !args.background;
    const uid = await a.userIdFor(username);
    void purgerAuBesoin(a, uid, username);
    if (args.background && a.refusDisque) {
      const plein = await auPlus(a.refusDisque(uid, sb), ATTENTE_ALERTE_MS);
      if (plein) return refusDisque(plein);
    }
    const disque = !a.alerteDisque ? null : a.alerteDisque(uid, sb).catch(() => null);
    const wc = args.background ? null : a.releve(uid || null, username, sb);
    await wc?.debut();
    let repli: string | null =
      sousAgent !== null && args.on_timeout === "detach_and_wake" && !args.background
        ? "not_available_here: a sub-agent cannot be woken, the command ran with on_timeout=kill."
        : null;
    if (detache) {
      const refusLocal =
        args.stdin || args.stdin_b64
          ? "stdin is not supported by jobs"
          : saveRel !== null
            ? "save_stdout is not supported by jobs"
            : null;
      const plein =
        refusLocal === null && a.jobs && a.refusDisque
          ? await auPlus(a.refusDisque(uid, sb), ATTENTE_ALERTE_MS)
          : null;
      if (plein) {
        await wc?.fin();
        return refusDisque(plein);
      }
      const issue =
        refusLocal !== null
          ? { repli: `invalid_argument: ${refusLocal}` }
          : a.jobs
            ? await executerDetache(
                {
                  command: args.command,
                  cwd: workdir,
                  env: envExtra,
                  strict: args.strict === true,
                  timeoutS: timeout,
                  maxOutput: DEFAULT_MAX_OUTPUT,
                },
                ctx,
                a.jobs,
              ).catch((e: unknown) => ({ repli: `sandbox_unavailable: ${strErreurAnglais(e)}` }))
            : { repli: "not_available_here: shell_job is not available on this server (no job registry)." };
      if ("repli" in issue) repli = issue.repli;
      else {
        await wc?.fin();
        if (issue.termine) wc?.attacher(issue.resultat);
        const alerte = disque !== null ? await auPlus(disque, ATTENTE_ALERTE_MS) : null;
        if (alerte) issue.resultat["disk_warning"] = alerte;
        return issue.resultat;
      }
    }
    let result: Dict;
    try {
      result = await a.executer({
        tokens,
        workdirRel: workdir,
        sandboxRoot: sb,
        envExtra,
        timeoutS: delai,
        maxOutput: DEFAULT_MAX_OUTPUT,
        stdin,
        userId: uid,
        username,
        ctx,
        streamLive: live,
        saveStdoutRel: saveRel,
        autoSpillRel: autoSpill,
        spillOverChars: a.plancherDebord(),
        resumerBinaire: true,
        ...(args.background ? {} : { signal: ctx.signal }),
      });
    } catch (e) {
      await wc?.fin();
      if (ctx.signal?.aborted) return { ...enveloppeAnnulee("execute_shell"), cmd: args.command };
      return errShell(`executor unavailable: ${strErreurAnglais(e)}`, REDEMARRER, { cmd: args.command });
    }
    if (args.background) {
      const lignes = splitlinesPy(stripPy(veritePy(result["stdout"]) ? strPy(result["stdout"]) : ""));
      let pid: number | null = null;
      for (const l of lignes.reverse()) {
        if (estChiffresPy(stripPy(l))) {
          pid = intPy(stripPy(l));
          break;
        }
      }
      if (!veritePy(result["ok"]) || pid === null)
        return errShell("background_launch_failed", "Detached launch failed — read stderr.", {
          stderr: clipMarked(result["stderr"]),
          stdout: clipMarked(result["stdout"]),
        });
      const alerteFond = disque !== null ? await auPlus(disque, ATTENTE_ALERTE_MS) : null;
      const lance: Dict = {
        ok: true,
        background: true,
        pid,
        cmd: args.command,
        log: journalFond,
        hint:
          `Detached process (pid ${pid}). Its output goes to ${journalFond}: read it with read_file or ` +
          `\`tail -n 50 ${journalFond}\`; stop it with \`kill ${pid}\`. ` +
          'Nothing wakes you when it ends: to be woken (exit, log line, port), use shell_job(action="start") ' +
          'or execute_shell(on_timeout="detach_and_wake") (no background=true).',
      };
      if (alerteFond) lance["disk_warning"] = alerteFond;
      return lance;
    }
    if (wc !== null) {
      await wc.fin();
      wc.attacher(result);
    }
    result["cmd"] = args.command;
    const reduit = veritePy(result["apercu"]);
    delete result["apercu"];
    let autoSauve = false;
    if (!(saveRel !== null && Object.hasOwn(result, "saved_bytes"))) {
      autoSauve = veritePy(result["auto_saved"]);
      delete result["auto_saved"];
    }
    const lireLeReste = (ct: string, quoi: string): string =>
      ` Output shortened to its head and tail — the FULL ${quoi} was saved to ${ct}. Read the part you need ` +
      `with read_file(path="${ct}", grep="...") or tail; do not re-run the command just to see more.`;
    if (saveRel !== null && Object.hasOwn(result, "saved_bytes")) {
      result["saved_to"] = toContainer(saveRel);
      if (reduit)
        result["hint"] = stripPy(
          (veritePy(result["hint"]) ? strPy(result["hint"]) : "") +
            lireLeReste(toContainer(saveRel), "stdout"),
        );
    } else if (autoSauve && autoSpill !== null) {
      const ct = toContainer(autoSpill);
      result["saved_to"] = ct;
      const phrase = reduit
        ? lireLeReste(ct, "output")
        : veritePy(result["stdout_binary"]) || veritePy(result["stderr_binary"])
          ? ""
          : veritePy(result["truncated"])
            ? ` Output truncated — the FULL output was saved to ${ct}. Use read_file with grep/tail on it; do not ` +
              `re-run the command just to see more.`
            : ` Full output also saved to ${ct} (the stdout below is COMPLETE — no need to read the file).`;
      result["hint"] = stripPy((veritePy(result["hint"]) ? strPy(result["hint"]) : "") + phrase);
    }
    const rc = result["returncode"];
    if (rc === 127 && !Object.hasOwn(result, "fix")) {
      result["fix"] = PYTHON_NU.test(args.command)
        ? "`python` does not exist in the container: use `python3` (or `pip3`)."
        : "Command not found (127). Check the name, or install it (`pip install --user …` / `npm install -g …`).";
    } else if (result["error"] === "timeout" && sousAgent !== null) {
      result["fix"] = stripPy(
        `${veritePy(result["hint"]) ? strPy(result["hint"]) : ""} Killed after ${timeout}s` +
          `${timeout < voulu ? " (the time left in your budget)" : ""}. ${FIX_SOUS_AGENT}`,
      );
    } else if (result["error"] === "timeout") {
      result["fix"] = stripPy(
        (veritePy(result["hint"]) ? strPy(result["hint"]) : "") +
          ' For a server or a long-running process, use shell_job(action="start") instead (immediate return, ' +
          'woken when it ends, no polling), or retry with on_timeout="detach_and_wake": the command then ' +
          "keeps running past the timeout and wakes you when it exits.",
      );
    }
    if (repli !== null) result["on_timeout_fallback"] = repli;
    const alerte = disque !== null ? await auPlus(disque, ATTENTE_ALERTE_MS) : null;
    if (alerte) result["disk_warning"] = alerte;
    return result;
  } catch (e) {
    return errShell(strErreurAnglais(e));
  }
}

/** Rappel au core qui porte les routes des jobs (`ClientRappel`), sinon `null`. */
function rappelJobs(rappel: unknown): PortRappelJobs | null {
  const r = rappel as Partial<PortRappelJobs> | null | undefined;
  const actif = (rappel as { actif?: unknown } | null | undefined)?.actif !== false;
  return actif &&
    r &&
    typeof r.enregistrerJob === "function" &&
    typeof r.etatJob === "function" &&
    typeof r.jobsDuCompte === "function"
    ? (r as PortRappelJobs)
    : null;
}

/** Points d'appui réels : `/work` du compte, espace et relevé par l'agent (`Espace.pour`, `WorkChanges`), identité de l'enveloppe, pont d'exécution, alerte de remplissage ; `shell_job` si `rappel` joint le core. */
export function appuisParDefaut(
  pont: PontExec,
  racine: (username: string) => Promise<string> = racineTravail,
  rappel: unknown = null,
): AppuisShell {
  const stats = async (username: string, _racine: string, rels: readonly string[]): Promise<Dict[]> =>
    (await Espace.pour(username)).stats(rels);
  const core = rappelJobs(rappel);
  return {
    racine,
    stats,
    userIdFor,
    ...(core
      ? {
          jobs: {
            racine,
            stats,
            userIdFor,
            bac: (uid, username) => pont.bac(uid, username),
            rappel: core,
            veilleur: veilleurJobs,
            auditer: (o) =>
              pont.auditer({
                userId: o.userId,
                username: o.username,
                kind: "tools.shell_job",
                code: o.command,
                executor: o.executor,
                extra: { job_id: o.jobId },
              }),
          },
        }
      : {}),
    releve: (uid, username) => {
      const wc = new WorkChanges(uid, username, "shell");
      return {
        debut: async () => void (await wc.entrer()),
        fin: () => wc.sortir(),
        attacher: (r) => wc.attach(r),
      };
    },
    executer: (o) => pont.runShell(o),
    plancherDebord,
    purger: (uid, username) => pont.purger(uid, username),
    alerteDisque: (uid, rac) => alerteRemplissage(rappelQuota(rappel), uid, rac),
    refusDisque: (uid, rac) => refusRemplissage(rappelQuota(rappel), uid, rac),
  };
}

const SIGNATURE: DefinitionOutil["signature"] = {
  command: py.str(),
  cwd: py.optional(py.str()).defaut(null),
  timeout_sec: py.optional(py.int()).defaut(null),
  stdin: py.str().defaut(""),
  stdin_b64: py.str().defaut(""),
  env: py.dict(py.str(), py.str()).fabrique(() => ({})),
  save_stdout: py.str().defaut(""),
  background: py.bool().defaut(false),
  strict: py.bool().defaut(false),
  on_timeout: py.literal("kill", "detach_and_wake").defaut("kill"),
};

const SIGNATURE_JOB: DefinitionOutil["signature"] = {
  action: py.literal("start", "status", "logs", "kill", "list"),
  command: py.str().defaut(""),
  cwd: py.optional(py.str()).defaut(null),
  env: py.dict(py.str(), py.str()).fabrique(() => ({})),
  label: py.str().defaut(""),
  wake_on: py.list(py.str()).fabrique(() => ["exit"]),
  resume_note: py.str().defaut(""),
  wake: py.bool().defaut(true),
  job_id: py.str().defaut(""),
  tail: py.int().defaut(40),
  grep: py.str().defaut(""),
  signal: py.literal("TERM", "KILL", "INT").defaut("TERM"),
};

/** `shell_job` sans rappel au core (hôte sans `app_url` ni jeton) : refus stable, sans rien lancer. */
async function shellJobIndisponible(): Promise<Dict> {
  return err("not_available_here", "shell_job is not available on this server (no job registry).", {
    fix: "Use execute_shell instead.",
  });
}

/** Garde de remplissage de `shell_job(start)` sur le bac des tâches ; sans mesure : aucune. */
function gardeJobs(a: AppuisShell, j: AppuisJobs): GardeDisque | null {
  if (!a.alerteDisque && !a.refusDisque) return null;
  return {
    lieu: async (username) => [await j.userIdFor(username), await j.racine(username)],
    alerte: async (uid, rac) => (a.alerteDisque ? a.alerteDisque(uid, rac) : null),
    refus: async (uid, rac) => (a.refusDisque ? a.refusDisque(uid, rac) : null),
  };
}

/** Outils de la famille `shell` sur leurs points d'appui. */
export function outilsShell(a: AppuisShell): DefinitionOutil[] {
  const garde = a.jobs ? gardeJobs(a, a.jobs) : null;
  return [
    outilDuGolden(goldenShell as Golden, "execute_shell", {
      signature: SIGNATURE,
      traiter: (valeurs, ctx) =>
        executeShell(restaurerMarqueursArgs(valeurs) as unknown as ArgsShell, ctx, a),
    }),
    outilDuGolden(goldenShell as Golden, "shell_job", {
      signature: SIGNATURE_JOB,
      traiter: (valeurs, ctx) => {
        const v = valeurs as unknown as ArgsJob;
        const j = a.jobs;
        if (!j) return shellJobIndisponible();
        return sousGardeDisque(garde, ctx, v.action === "start" ? true : null, () => shellJob(v, ctx, j));
      },
    }),
  ];
}

/** Famille `shell` de l'hôte (forme `FabriqueNative`) : pont et espaces sur le bac du compte sous le profil effectif (rappel au core), journal de l'hôte. */
export function familleShell(o: {
  readonly rappel?: PortProfilRappel | null;
  readonly journal?: Pick<Journal, "info" | "warn"> | null;
}): { famille: string; outils: readonly DefinitionOutil[] } {
  if (o.rappel) brancherRappelProfil(o.rappel);
  const pont = new PontExec({ rappel: o.rappel ?? null, journal: o.journal ?? null });
  return { famille: "shell", outils: outilsShell(appuisParDefaut(pont, racineTravail, o.rappel ?? null)) };
}
