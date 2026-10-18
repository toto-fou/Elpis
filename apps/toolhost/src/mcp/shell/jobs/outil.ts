// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/shell/jobs/outil.ts — outil `shell_job` : jobs de fond dans le conteneur du compte (agent du bac), enregistrés d'abord auprès du core, veillés par l'hôte ; textes au modèle en anglais (B-13). */
import { setTimeout as attendre } from "node:timers/promises";

import { decoderRemplace, erreurAgent, estErreurAgent } from "@elpis/bac";
import type { AgentBac } from "@elpis/bac";
import {
  clesOrdonnees,
  compilerPy,
  ErreurRe,
  estDict,
  longueurPy,
  prefixePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { err, getUsername, readMetaField } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { ErreurCheminBac, lexicalRel, toContainer } from "@elpis/securite";

import type { CompteSigne } from "../../../rappel";
import { strErreurAnglais } from "../../anglais";
import { verifierRegexSure } from "../../fs/edition";
import { ENV_BASE } from "../pont";
import type { VeilleurJobs } from "./veilleur";

export const MAX_DECLENCHEURS = 6;
/** Une entrée de `wake_on` (borne du core : 300 caractères). */
export const MAX_ENTREE = 300;
export const MAX_NOTE = 600;
export const MAX_LABEL = 60;
export const MAX_COMMANDE = 100_000;
/** Variables passées à l'agent, base de l'outil comprise (borne de l'agent). */
export const MAX_ENV = 128;
/** Lignes ou correspondances rendues par `logs` (B-04). */
export const LOGS_OCTETS = 4096;
export const TAIL_MAX = 200;
export const LIGNE_VUE = 200;
const LECTURE_QUEUE = 64 * 1024;
const LISTE_MAX = 50;
const QUANTIFICATEURS_LIBRES = 2;
const BORNES: Readonly<Record<string, readonly [number, number]>> = {
  port: [1, 65535],
  idle: [10, 3600],
  timeout: [1, 86400],
};
const CLE_ENV = /^[A-Z_][A-Z0-9_]*$/u;
export const ID_JOB = /^j-[0-9a-f]{8}$/u;
const GRAMMAIRE =
  "Triggers: exit | match:<text> | regex:<pattern> | port:<1-65535> | file:<path under /work> | " +
  "idle:<10-3600> | timeout:<1-86400>.";
const REDEMARRER =
  "Container may be down. Try restarting it via the sandbox panel (POST /api/sandbox/me/restart).";

/** Réglages de l'outil (modifiables par les tests). */
export const reglagesShellJob = {
  /** Reprises de `POST /api/internal/jobs/state` après un premier échec (8 : environ 8 min 30, sous les 10 min où le core tient le lancement pour perdu). */
  reprisesEtat: 8,
  repriseEtatMs: 2_000,
  graceKillS: 5,
};

/** Arguments validés de `shell_job` (signature du golden). */
export interface ArgsJob {
  readonly action: "start" | "status" | "logs" | "kill" | "list";
  readonly command: string;
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly label: string;
  readonly wake_on: readonly string[];
  readonly resume_note: string;
  readonly wake: boolean;
  readonly job_id: string;
  readonly tail: number;
  readonly grep: string;
  readonly signal: "TERM" | "KILL" | "INT";
}

/** Rappels au core dont se sert l'outil (`ClientRappel`). */
export interface PortRappelJobs {
  enregistrerJob(compte: CompteSigne, corps: Dict, statut?: { code: number }): Promise<Dict | null>;
  etatJob(
    compte: CompteSigne,
    corps: { job_id: string; state: "running" | "failed"; pid?: number | null; error?: string },
  ): Promise<Dict | null>;
  jobsDuCompte(compte: CompteSigne, chatId: string | null): Promise<Dict | null>;
  /** Marque livrés les événements du job (le résultat de l'outil les a portés) ; absente : le réveil ordinaire a lieu. */
  jobLivre?(compte: CompteSigne, jobId: string): Promise<Dict | null>;
}

/** Appels de l'agent du bac dont se sert l'outil (`AgentClient`). */
export interface AgentJobs {
  jobsStart(o: {
    id: string;
    command: string;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    label?: string;
    wakeOn?: readonly string[];
    chainDepth?: number;
  }): Promise<Dict>;
  jobsKill(o: {
    id: string;
    signal?: "TERM" | "KILL" | "INT";
    graceS?: number;
    by?: "agent" | "user" | "core";
    purge?: boolean;
    passive?: boolean;
  }): Promise<Dict>;
  jobsStatus(id?: string, o?: { passive?: boolean }): Promise<Dict[]>;
  jobsList(o?: { passive?: boolean }): Promise<Dict[]>;
  stat(paths: Iterable<string>): Promise<Dict[]>;
  read(p: string, o?: { offset?: number; length?: number; maxBytes?: number }): Promise<{ data: Buffer }>;
  grep(
    paths: Iterable<string>,
    needle: string,
    o?: { ignoreCase?: boolean; maxFileBytes?: number; maxHits?: number; width?: number; deadlineS?: number },
  ): Promise<[Dict[], Dict]>;
}

/** Agent du bac vu par l'outil ; `agent_unavailable` si la fabrique posée n'en est pas un. */
export function agentJobs(agent: AgentBac): AgentJobs {
  const a = agent as unknown as Partial<AgentJobs>;
  if (typeof a.jobsStart !== "function" || typeof a.jobsKill !== "function" || typeof a.read !== "function")
    throw erreurAgent("agent_unavailable", "sandbox agent client without the job calls");
  return a as AgentJobs;
}

/** Points d'appui de `shell_job` (doublés par les tests). */
export interface AppuisJobs {
  racine(username: string): Promise<string>;
  userIdFor(username: string): Promise<number>;
  /** `Espace.stat` du compte (dossier de travail vérifié par l'agent). */
  stats(username: string, racine: string, rels: readonly string[]): Promise<Dict[]>;
  bac(uid: number, username: string): Promise<{ readonly containerName: string; readonly agent: AgentBac }>;
  readonly rappel: PortRappelJobs;
  veilleur(): VeilleurJobs | null;
  auditer(o: { userId: number; username: string; command: string; executor: string; jobId: string }): void;
}

export class Refus extends Error {
  readonly code: string;
  readonly fix: string | null;

  constructor(code: string, message: string, fix: string | null = null) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

const invalide = (message: string, fix: string | null = null): Refus =>
  new Refus("invalid_argument", message, fix);

/** `_quantificateurs_libres` de l'agent : `*`, `+` et `{n,}` hors classes et échappements (`*?`, `*+` comptent pour un). */
export function quantificateursLibres(motif: string): number {
  let n = 0;
  let i = 0;
  while (i < motif.length) {
    const c = motif[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      i += motif.slice(i + 1, i + 2) === "^" ? 2 : 1;
      i += motif.slice(i, i + 1) === "]" ? 1 : 0;
      while (i < motif.length && motif[i] !== "]") i += motif[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    const m = c === "{" ? /^\{[0-9]*,\}/u.exec(motif.slice(i)) : null;
    if (c === "*" || c === "+" || m !== null) {
      n++;
      i += m !== null ? m[0].length : 1;
      i += motif.slice(i, i + 1) === "?" || motif.slice(i, i + 1) === "+" ? 1 : 0;
      continue;
    }
    i += 1;
  }
  return n;
}

/** Motif d'un `regex:` vérifié comme l'agent : longueur, quantificateur imbriqué, quantificateurs libres, syntaxe de `re`. */
function verifierMotif(motif: string): void {
  try {
    verifierRegexSure(motif);
  } catch (e) {
    if (e instanceof ErreurRe) throw invalide(`wake_on regex: ${e.message}`);
    throw e;
  }
  if (quantificateursLibres(motif) > QUANTIFICATEURS_LIBRES)
    throw invalide(`wake_on regex: at most ${QUANTIFICATEURS_LIBRES} unbounded quantifiers (*, +, {n,})`);
  try {
    compilerPy(motif);
  } catch (e) {
    if (e instanceof ErreurRe) throw invalide(`wake_on regex: invalid pattern (${e.message})`);
    // syntaxe que le portage ne lit pas : l'agent (re de Python) tranche
  }
}

/** Une entrée de `wake_on` vérifiée (grammaire de la SPEC §1) ; `file:` rendu relatif à /work. */
function declencheur(s: string, racine: string): string {
  if (s === "exit") return s;
  if (longueurPy(s) > MAX_ENTREE) throw invalide(`wake_on: entry longer than ${MAX_ENTREE} characters`);
  const i = s.indexOf(":");
  const genre = i < 0 ? s : s.slice(0, i);
  const val = i < 0 ? "" : s.slice(i + 1);
  if (!s.includes("\0") && val) {
    if (genre === "match") return s;
    if (genre === "regex") {
      verifierMotif(val);
      return s;
    }
    const bornes = BORNES[genre];
    if (bornes !== undefined && /^[0-9]{1,6}$/u.test(val)) {
      const v = Number(val);
      if (v >= bornes[0] && v <= bornes[1]) return s;
      throw invalide(`wake_on: ${genre} must be between ${bornes[0]} and ${bornes[1]}`, GRAMMAIRE);
    }
    if (genre === "file") {
      let rel: string;
      try {
        rel = lexicalRel(racine, val);
      } catch (e) {
        if (e instanceof ErreurCheminBac)
          throw new Refus(
            "path_outside_sandbox",
            `wake_on file: path outside the sandbox: ${prefixePy(val, 200)}`,
            "Use a path relative to /work.",
          );
        throw e;
      }
      if (rel) return `file:${rel}`;
    }
  }
  throw invalide(`wake_on: invalid entry '${prefixePy(s, 80)}'`, GRAMMAIRE);
}

/** `wake_on` vérifié : `exit` en tête, sans doublon, 6 déclencheurs au plus en plus d'`exit`. */
export function verifierDeclencheurs(brut: readonly string[], racine: string): string[] {
  if (new Set(["exit", ...brut]).size - 1 > MAX_DECLENCHEURS)
    throw invalide(`wake_on: at most ${MAX_DECLENCHEURS} triggers besides exit`);
  return [...new Set(["exit", ...brut].map((s) => declencheur(s, racine)))];
}

/** `env` aux règles d'`execute_shell`, ajouté à la base de l'outil (PATH…) : l'agent ne pose que HOME et le marqueur. */
export function environnementJob(env: Readonly<Record<string, string>>): Record<string, string> {
  const rendu: Record<string, string> = { ...ENV_BASE, GIT_TERMINAL_PROMPT: "0" };
  for (const k of clesOrdonnees(env)) {
    const v = strPy(env[k]);
    if (longueurPy(k) > 64 || longueurPy(v) > 4000 || v.includes("\0"))
      throw invalide("env: key 64 characters max, value 4000 characters max, no NUL");
    if (!CLE_ENV.test(k)) throw invalide(`env: key '${prefixePy(k, 64)}' must match [A-Z_][A-Z0-9_]*`);
    rendu[k] = v;
  }
  if (Object.keys(rendu).length > MAX_ENV)
    throw invalide(`env: at most ${MAX_ENV - Object.keys(ENV_BASE).length - 1} variables`);
  return rendu;
}

/** Libellé : celui donné, sinon les 40 premiers caractères de la commande ; 60 au plus. */
export function libelle(label: string, commande: string): string {
  const l = stripPy(label) || Array.from(stripPy(commande)).slice(0, 40).join("");
  return Array.from(l).slice(0, MAX_LABEL).join("");
}

export function journalDuJob(jobId: string): string {
  return `/work/.bg/job-${jobId}.log`;
}

function refusEnveloppe(r: Refus): Dict {
  return err(r.code, r.message, { fix: r.fix });
}

export const PAS_ICI = (): Dict =>
  err(
    "not_available_here",
    "Background jobs need a saved conversation: not available in a sub-agent, routine, webhook or ephemeral chat.",
    { fix: "Use execute_shell instead (background=true starts a detached process without wake-up)." },
  );

const REGISTRE_MUET = (): Dict =>
  err("sandbox_unavailable", "The job registry (Elpis core) is unreachable.", {
    fix: "Retry in a moment.",
    retryable: true,
  });

const BAC_MUET = (e: unknown): Dict =>
  err("sandbox_unavailable", `executor unavailable: ${strErreurAnglais(e)}`, {
    fix: REDEMARRER,
    retryable: true,
  });

/** Dossier de travail : relatif à /work, confiné (JB-19), dossier vérifié par l'agent. */
async function dossierDeTravail(
  a: AppuisJobs,
  cwd: string | null,
  racine: string,
  username: string,
): Promise<string> {
  if (!cwd) return "";
  let rel: string;
  try {
    rel = lexicalRel(racine, cwd);
  } catch (e) {
    if (e instanceof ErreurCheminBac)
      throw new Refus(
        "path_outside_sandbox",
        "cwd outside sandbox",
        "cwd must be inside your sandbox (relative to /work).",
      );
    throw e;
  }
  if (!rel) return "";
  const e = (await a.stats(username, racine, [rel]))[0] ?? {};
  if (veritePy(e["outside"]) || (e["kind"] === "error" && e["error"] === "outside_root"))
    throw new Refus(
      "path_outside_sandbox",
      "cwd outside sandbox",
      "cwd must be inside your sandbox (relative to /work).",
    );
  if (e["kind"] !== "dir") throw invalide(`cwd not a directory: ${toContainer(rel)}`);
  return rel;
}

/** État posé auprès du core ; un échec est repris en arrière-plan (sinon le job resterait `starting`). */
async function poserEtat(
  a: AppuisJobs,
  compte: CompteSigne,
  corps: { job_id: string; state: "running" | "failed"; pid?: number | null; error?: string },
): Promise<void> {
  if ((await a.rappel.etatJob(compte, corps)) !== null) return;
  void (async () => {
    for (let i = 0; i < reglagesShellJob.reprisesEtat; i++) {
      await attendre(reglagesShellJob.repriseEtatMs * 2 ** i, undefined, { ref: false });
      if ((await a.rappel.etatJob(compte, corps).catch(() => null)) !== null) return;
    }
  })();
}

/** Lancement que l'agent n'a ni confirmé ni refusé : la commande tourne peut-être, ne pas la relancer. */
export const LANCEMENT_INCERTAIN = (jobId: string): Dict =>
  err("launch_unconfirmed", "the sandbox did not confirm the launch: the command may be running", {
    job_id: jobId,
    fix: `Do not start it again: check shell_job(action="status", job_id="${jobId}") first.`,
  });

/** Après un échec de `jobsStart` sans réponse de l'agent (délai, transport) : sa fiche s'il connaît le job, `null` s'il ne le connaît pas, `undefined` si on ne peut pas le savoir. */
async function ficheApresEchec(
  agent: AgentJobs,
  jobId: string,
  e: unknown,
): Promise<Dict | null | undefined> {
  if (estErreurAgent(e) && (e.status > 0 || ["agent_unavailable", "container_down"].includes(e.code)))
    return null;
  try {
    return (await agent.jobsStatus(jobId))[0] ?? null;
  } catch (x) {
    return estErreurAgent(x) && x.code === "job_not_found" ? null : undefined;
  }
}

/** Refus de lancement de l'agent rendu en code stable de la SPEC. */
function refusLancement(e: unknown): Dict {
  if (!estErreurAgent(e)) return BAC_MUET(e);
  if (e.code === "outside_root")
    return err("path_outside_sandbox", "cwd or file: path outside the sandbox", {
      fix: "Use paths relative to /work.",
    });
  if (e.code === "not_found") return err("invalid_argument", "cwd not a directory");
  if (e.code === "too_many_jobs")
    return err("limit_exceeded", "Too many background jobs running in the sandbox container.", {
      fix: 'Wait for a job to end or kill one (shell_job action="kill").',
    });
  if (e.code === "bad_request") {
    const m = (e as { message?: unknown }).message;
    const detail = typeof m === "string" ? m.replace(/^bad_request: /u, "") : "";
    return err(
      "invalid_argument",
      /^(wake_on|regex|invalid regex)/u.test(detail) ? detail : "the sandbox agent refused the job",
      { fix: GRAMMAIRE },
    );
  }
  return BAC_MUET(e);
}

/** Job lancé : identifiant du core, pid de l'agent, déclencheurs armés et réponse d'enregistrement. */
export interface Lance {
  readonly jobId: string;
  readonly pid: number | null;
  readonly armes: string[];
  readonly reg: Dict;
}

/** Démarrage partagé par `shell_job` et `execute_shell(on_timeout)` : validation, enregistrement au core, lancement par l'agent (réponse perdue : fiche relue, jamais de second lancement), état confirmé, veille du compte ; un refus est rendu en enveloppe. */
export async function lancer(
  args: Pick<ArgsJob, "command" | "cwd" | "env" | "label" | "wake_on" | "resume_note" | "wake">,
  a: AppuisJobs,
  compte: CompteSigne,
  chatId: string,
  ctx: ContexteAppel,
): Promise<Lance | { readonly refus: Dict }> {
  if (typeof args.command !== "string" || !stripPy(args.command))
    throw invalide("command required", "Provide the command to run.");
  if (longueurPy(args.command) > MAX_COMMANDE || args.command.includes("\0"))
    throw invalide(`command: ${MAX_COMMANDE} characters max, no NUL`);
  if (longueurPy(args.resume_note) > MAX_NOTE) throw invalide(`resume_note: ${MAX_NOTE} characters max`);
  const racine = await a.racine(compte.username);
  const env = environnementJob(args.env);
  const wakeOn = verifierDeclencheurs(args.wake_on, racine);
  const cwd = await dossierDeTravail(a, args.cwd, racine, compte.username);
  const label = libelle(args.label, args.command);
  const statut = { code: 0 };
  const reg = await a.rappel.enregistrerJob(
    compte,
    {
      chat_id: chatId,
      call_id: readMetaField(ctx, "call_id") ?? "",
      label,
      command: args.command,
      cwd,
      wake_on: wakeOn,
      resume_note: args.resume_note,
      wake: args.wake,
    },
    statut,
  );
  if (reg === null)
    return {
      refus:
        statut.code >= 400 && statut.code < 500 && statut.code !== 401 && statut.code !== 403
          ? err("invalid_argument", `the job registry refused the request (HTTP ${statut.code})`)
          : REGISTRE_MUET(),
    };
  if (reg["ok"] !== true) {
    const refus: Dict = { ...reg, ok: false };
    if (typeof refus["error"] !== "string") refus["error"] = "not_available_here";
    if (refus["error"] === "limit_exceeded" && !refus["fix"])
      refus["fix"] = 'Wait for a job to end or kill one (shell_job action="kill"), then start again.';
    return { refus };
  }
  const jobId = reg["job_id"];
  if (typeof jobId !== "string" || !ID_JOB.test(jobId)) return { refus: REGISTRE_MUET() };
  const veilleur = a.veilleur();
  const liberer = veilleur?.lancement(jobId) ?? ((): void => undefined);
  try {
    let lance: Dict;
    let agent: AgentJobs | null = null;
    try {
      const sb = await a.bac(compte.user_id, compte.username);
      a.auditer({
        userId: compte.user_id,
        username: compte.username,
        command: args.command,
        executor: sb.containerName,
        jobId,
      });
      agent = agentJobs(sb.agent);
      lance = await agent.jobsStart({
        id: jobId,
        command: args.command,
        cwd,
        env,
        label,
        wakeOn,
        chainDepth: profondeurDuTour(reg),
      });
    } catch (e) {
      const fiche = agent === null ? null : await ficheApresEchec(agent, jobId, e);
      if (fiche === undefined) {
        veilleur?.veiller(compte, [jobId]);
        return { refus: LANCEMENT_INCERTAIN(jobId) };
      }
      if (fiche === null) {
        await poserEtat(a, compte, {
          job_id: jobId,
          state: "failed",
          error: estErreurAgent(e) ? e.code : "launch_failed",
        });
        return { refus: refusLancement(e) };
      }
      lance = fiche;
    }
    const pid = typeof lance["pid"] === "number" ? lance["pid"] : null;
    await poserEtat(a, compte, { job_id: jobId, state: "running", pid });
    veilleur?.veiller(compte, [jobId]);
    const armes = Array.isArray(lance["wake_on"]) ? (lance["wake_on"] as unknown[]).map(strPy) : wakeOn;
    return { jobId, pid, armes, reg };
  } finally {
    liberer();
  }
}

/** Profondeur du tour qui lance le job (`depth` de l'enregistrement), écrite par l'agent dans `.bg/jobs-events.ndjson` (JB-11) ; hors bornes : rien. */
export function profondeurDuTour(reg: Dict): number | undefined {
  const d = reg["depth"];
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 1000 ? d : undefined;
}

/** Chaîne de réveils vue par le core (JB-11) : `chain_depth` et `max_chain_depth` dans un tour de réveil, `warning` si le job ne réveillera pas. */
export function chaineDeReveils(reg: Dict): Dict {
  const d = reg["depth"];
  const max = reg["max_depth"];
  const limite = reg["chain_limit"] === true;
  if (typeof d !== "number" || typeof max !== "number" || (d <= 0 && !limite)) return {};
  const rendu: Dict = { chain_depth: d, max_chain_depth: max };
  if (limite)
    rendu["warning"] =
      `wake chain limit reached (${d}/${max}): this job will not wake you; hand back to the user`;
  return rendu;
}

/** `start` : lancement partagé, puis réponse de l'outil. */
async function demarrer(
  args: ArgsJob,
  a: AppuisJobs,
  compte: CompteSigne,
  chatId: string,
  ctx: ContexteAppel,
): Promise<Dict> {
  const l = await lancer(args, a, compte, chatId, ctx);
  if ("refus" in l) return l.refus;
  const chaine = chaineDeReveils(l.reg);
  const pourquoi = "warning" in chaine ? "wake chain limit" : "wake=false";
  return {
    ok: true,
    job_id: l.jobId,
    pid: l.pid,
    state: "running",
    log: journalDuJob(l.jobId),
    wake_on: l.armes,
    active_jobs: l.reg["active_jobs"] ?? null,
    max_jobs: l.reg["max_jobs"] ?? null,
    ...chaine,
    hint:
      args.wake && !("warning" in chaine)
        ? `End your turn now: you will be woken automatically on ${l.armes.join("/")}. Do not poll or sleep.`
        : `This job will not start a new turn (${pourquoi}): its events will be attached to your next tool result ` +
          `or to the user's next message; shell_job(action="status") shows it at any time.`,
  };
}

/** Jobs de la conversation selon le core ; `null` : core injoignable. */
async function jobsDuChat(a: AppuisJobs, compte: CompteSigne, chatId: string): Promise<Dict | null> {
  return a.rappel.jobsDuCompte(compte, chatId);
}

/** Job de CETTE conversation (contrôle de propriété avant `kill`, `logs`, `status`). */
async function jobDuChat(
  a: AppuisJobs,
  compte: CompteSigne,
  chatId: string,
  jobId: string,
  connue: Dict | null = null,
): Promise<Dict> {
  if (!ID_JOB.test(jobId))
    throw invalide(
      'job_id required: "j-" followed by 8 hex digits',
      'shell_job(action="list") shows the jobs of this conversation.',
    );
  const liste = connue ?? (await jobsDuChat(a, compte, chatId));
  if (liste === null)
    throw new Refus(
      "sandbox_unavailable",
      "The job registry (Elpis core) is unreachable.",
      "Retry in a moment.",
    );
  const job = (liste["jobs"] as unknown[]).find((j) => estDict(j) && j["job_id"] === jobId);
  if (!estDict(job))
    throw new Refus(
      "job_not_found",
      `No job ${jobId} in this conversation.`,
      'shell_job(action="list") shows the jobs of this conversation.',
    );
  return job;
}

/** `kill` : groupe du job et processus marqués arrêtés par l'agent (`by: "agent"`, JB-12). */
async function tuer(args: ArgsJob, a: AppuisJobs, compte: CompteSigne, chatId: string): Promise<Dict> {
  await jobDuChat(a, compte, chatId, args.job_id);
  let r: Dict;
  try {
    const sb = await a.bac(compte.user_id, compte.username);
    r = await agentJobs(sb.agent).jobsKill({
      id: args.job_id,
      signal: args.signal,
      graceS: reglagesShellJob.graceKillS,
      by: "agent",
      passive: true,
    });
  } catch (e) {
    if (estErreurAgent(e) && e.code === "job_not_running")
      return err("job_not_running", `Job ${args.job_id} is not running.`, { state: e.data["state"] ?? null });
    if (estErreurAgent(e) && e.code === "busy")
      return err("job_not_running", `Job ${args.job_id} is already being stopped.`, { retryable: true });
    if (estErreurAgent(e) && e.code === "job_not_found") {
      await a.veilleur()?.declarerPerdus(compte, [args.job_id]);
      return err("job_not_running", `Job ${args.job_id} is unknown to the sandbox: it is lost.`, {
        state: "lost",
      });
    }
    if (estErreurAgent(e) && e.code === "container_down") {
      a.veilleur()?.veiller(compte, [args.job_id]);
      return err("job_not_running", "The sandbox container is stopped: the job is no longer running.", {
        state: "lost",
      });
    }
    return BAC_MUET(e);
  }
  return {
    ok: true,
    job_id: args.job_id,
    killed_pids: Array.isArray(r["killed_pids"]) ? r["killed_pids"] : [],
    state: r["state"] ?? null,
    exit_code: r["exit_code"] ?? null,
    signal: r["signal"] ?? null,
  };
}

/** Fiches de l'agent par id ; `{}` si le conteneur est arrêté ou l'agent muet (seul le core répond alors). */
async function fichesAgent(a: AppuisJobs, compte: CompteSigne, jobId: string): Promise<Map<string, Dict>> {
  try {
    const sb = await a.bac(compte.user_id, compte.username);
    const agent = agentJobs(sb.agent);
    const fiches = jobId
      ? await agent.jobsStatus(jobId, { passive: true })
      : await agent.jobsList({ passive: true });
    return new Map(fiches.map((f) => [String(f["id"]), f]));
  } catch {
    return new Map();
  }
}

/** Entrée de `status` : registre du core, complété par la fiche vivante de l'agent. */
function entree(j: Dict, f: Dict | undefined): Dict {
  const id = String(j["job_id"]);
  return {
    job_id: id,
    label: j["label"] ?? "",
    state: f?.["state"] ?? j["state"] ?? null,
    pid: f?.["pid"] ?? j["pid"] ?? null,
    runtime_s: f?.["runtime_s"] ?? null,
    exit_code: f?.["exit_code"] ?? j["exit_code"] ?? null,
    signal: f?.["signal"] ?? j["signal"] ?? null,
    wake_on: Array.isArray(j["wake_on"]) ? j["wake_on"] : (f?.["wake_on"] ?? []),
    fired: Array.isArray(f?.["fired"]) ? f["fired"] : [],
    last_line: typeof f?.["last_line"] === "string" ? prefixePy(f["last_line"], LIGNE_VUE) : null,
    log: journalDuJob(id),
  };
}

/** `status` (un job, ou ceux de la conversation) et `list` : registre du core et fiches de l'agent. */
async function etat(args: ArgsJob, a: AppuisJobs, compte: CompteSigne, chatId: string): Promise<Dict> {
  const un = args.action === "status" && args.job_id !== "";
  const liste = await jobsDuChat(a, compte, chatId);
  if (liste === null) return REGISTRE_MUET();
  if (un) await jobDuChat(a, compte, chatId, args.job_id, liste);
  const jobs = (liste["jobs"] as unknown[]).filter(estDict).filter((j) => !un || j["job_id"] === args.job_id);
  const fiches = await fichesAgent(a, compte, un ? args.job_id : "");
  const rendu: Dict = {
    ok: true,
    jobs: jobs.slice(0, LISTE_MAX).map((j) => entree(j, fiches.get(String(j["job_id"])))),
    active_jobs: liste["active_jobs"] ?? null,
    max_jobs: liste["max_jobs"] ?? null,
  };
  if (jobs.length > LISTE_MAX) rendu["truncated"] = true;
  return rendu;
}

/** Ligne affichée : dernier segment après un retour chariot, 200 caractères au plus. */
function vue(ligne: string): [string, boolean] {
  const s = ligne.slice(ligne.lastIndexOf("\r") + 1);
  return longueurPy(s) <= LIGNE_VUE ? [s, false] : [`${prefixePy(s, LIGNE_VUE - 1)}…`, true];
}

/** `logs` : fin du journal (`tail`) ou lignes qui contiennent `grep`, 4 Ko au plus (B-04), chemin du journal complet. */
async function lire(args: ArgsJob, a: AppuisJobs, compte: CompteSigne, chatId: string): Promise<Dict> {
  await jobDuChat(a, compte, chatId, args.job_id);
  const rel = `.bg/job-${args.job_id}.log`;
  let agent: AgentJobs;
  try {
    agent = agentJobs((await a.bac(compte.user_id, compte.username)).agent);
  } catch (e) {
    return BAC_MUET(e);
  }
  const fiche = (await agent.jobsStatus(args.job_id, { passive: true }).catch(() => []))[0];
  const base: Dict = {
    ok: true,
    job_id: args.job_id,
    log: journalDuJob(args.job_id),
    total_lines: typeof fiche?.["log_lines"] === "number" ? fiche["log_lines"] : null,
    bytes: typeof fiche?.["log_bytes"] === "number" ? fiche["log_bytes"] : null,
  };
  try {
    if (args.grep) return { ...base, ...(await chercher(agent, rel, args.grep)) };
    return { ...base, ...(await queue(agent, rel, Math.max(1, Math.min(args.tail || 40, TAIL_MAX)))) };
  } catch (e) {
    if (estErreurAgent(e) && (e.code === "not_found" || e.code === "missing"))
      return err("job_not_found", `No log for job ${args.job_id} (never started or purged).`);
    return BAC_MUET(e);
  }
}

async function chercher(agent: AgentJobs, rel: string, aiguille: string): Promise<Dict> {
  const [trouves, bilan] = await agent.grep([rel], aiguille, {
    ignoreCase: false,
    maxHits: TAIL_MAX,
    width: LIGNE_VUE,
    maxFileBytes: 1 << 30,
    deadlineS: 15,
  });
  const matches: Dict[] = [];
  let octets = 0;
  let tronque = trouves.length >= TAIL_MAX || bilan["hits_truncated"] === true || bilan["timed_out"] === true;
  for (const t of trouves) {
    const [texte, coupe] = vue(strPy(t["text"] ?? ""));
    const m = { line: t["line"] ?? null, text: texte };
    const n = Buffer.byteLength(JSON.stringify(m), "utf8");
    if (octets + n > LOGS_OCTETS) {
      tronque = true;
      break;
    }
    tronque ||= coupe;
    matches.push(m);
    octets += n;
  }
  return { matches, truncated: tronque };
}

async function queue(agent: AgentJobs, rel: string, n: number): Promise<Dict> {
  const st = (await agent.stat([rel]))[0] ?? {};
  if (st["kind"] !== "file")
    throw erreurAgent(st["kind"] === "missing" ? "not_found" : String(st["error"] ?? "not_found"));
  const taille = Number(st["size"] ?? 0);
  const debut = Math.max(0, taille - LECTURE_QUEUE);
  const { data } =
    taille > debut
      ? await agent.read(rel, { offset: debut, length: taille - debut, maxBytes: LECTURE_QUEUE })
      : { data: Buffer.alloc(0) };
  const toutes = decoderRemplace(data).split("\n");
  if (debut > 0) toutes.shift();
  if (toutes.at(-1) === "") toutes.pop();
  const choisies = toutes.slice(-n);
  let tronque = debut > 0 && choisies.length < n;
  const lignes: string[] = [];
  let octets = 0;
  for (let i = choisies.length - 1; i >= 0; i--) {
    const [texte, coupe] = vue((choisies[i] ?? "").replace(/\r$/u, ""));
    const poids = Buffer.byteLength(texte, "utf8") + 1;
    if (octets + poids > LOGS_OCTETS) {
      tronque = true;
      break;
    }
    tronque ||= coupe;
    lignes.unshift(texte);
    octets += poids;
  }
  return { lines: lignes, truncated: tronque };
}

/** Compte et conversation de l'appel ; `null` hors conversation enregistrée (sous-agent, routine, éphémère : le core tranche). */
export async function compteDuChat(
  ctx: ContexteAppel,
  a: AppuisJobs,
): Promise<{ compte: CompteSigne; chatId: string } | null> {
  const username = getUsername(ctx);
  const chatId = readMetaField(ctx, "chat_id");
  if (!chatId) return null;
  const uid = await a.userIdFor(username);
  return uid <= 0 ? null : { compte: { user_id: uid, username }, chatId };
}

/** `shell_job` : actions start, status, logs, kill, list ; erreurs rendues en enveloppe, jamais levées. */
export async function shellJob(args: ArgsJob, ctx: ContexteAppel, a: AppuisJobs): Promise<Dict> {
  try {
    const c = await compteDuChat(ctx, a);
    if (c === null) return PAS_ICI();
    const { compte, chatId } = c;
    if (args.action === "start") return await demarrer(args, a, compte, chatId, ctx);
    if (args.action === "kill") return await tuer(args, a, compte, chatId);
    if (args.action === "logs") return await lire(args, a, compte, chatId);
    return await etat(args, a, compte, chatId);
  } catch (e) {
    if (e instanceof Refus) return refusEnveloppe(e);
    return BAC_MUET(e);
  }
}
