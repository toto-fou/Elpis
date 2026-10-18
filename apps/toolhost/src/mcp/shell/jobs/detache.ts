// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/shell/jobs/detache.ts — `execute_shell(on_timeout="detach_and_wake")` : la commande part comme un job, on l'attend jusqu'à l'échéance ; texte au modèle en anglais (B-13). */
import { setTimeout as attendre } from "node:timers/promises";

import type { Dict } from "@elpis/commun";
import { err } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { toContainer } from "@elpis/securite";

import {
  agentJobs,
  chaineDeReveils,
  compteDuChat,
  journalDuJob,
  lancer,
  libelle,
  PAS_ICI,
  Refus,
} from "./outil";
import type { AgentJobs, AppuisJobs } from "./outil";
import { formatResult } from "../pont";
import type { ResultatExec } from "../pont";

/** Réglages de l'attente (modifiables par les tests). */
export const reglagesDetache = { sondeMs: 200, relanceMs: 1_000 };

const TERMINAUX: ReadonlySet<string> = new Set(["exited", "killed", "lost", "failed"]);
const NOTE_REPRISE = "The command you started with execute_shell finished: read its result and carry on.";

export interface DemandeDetache {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly strict: boolean;
  readonly timeoutS: number;
  readonly maxOutput: number;
}

/** Issue : `repli` (raison du retour au comportement `kill`) ou résultat d'`execute_shell` (`termine` : la commande a fini avant l'échéance). */
export type IssueDetache =
  { readonly repli: string } | { readonly resultat: Dict; readonly termine: boolean };

function raison(refus: Dict): string {
  const code = typeof refus["error"] === "string" ? refus["error"] : "refused";
  const message = typeof refus["message"] === "string" ? refus["message"] : "";
  return message ? `${code}: ${message}` : code;
}

/** Fin du journal (fusion stdout et stderr), lue par l'agent. */
async function lireJournal(agent: AgentJobs, jobId: string, maxOutput: number): Promise<Buffer> {
  const rel = `.bg/job-${jobId}.log`;
  const st = (await agent.stat([rel]))[0] ?? {};
  if (st["kind"] !== "file") return Buffer.alloc(0);
  const taille = Number(st["size"] ?? 0);
  const longueur = Math.min(taille, maxOutput * 4);
  if (longueur <= 0) return Buffer.alloc(0);
  return (await agent.read(rel, { offset: taille - longueur, length: longueur, maxBytes: longueur })).data;
}

/** Le core marque le job : ses événements, déjà là ou à venir, naissent livrés (l'agent a le résultat, aucun réveil) ; trois essais. */
async function marquerLivre(
  a: AppuisJobs,
  compte: { user_id: number; username: string },
  jobId: string,
): Promise<void> {
  const livrer = a.rappel.jobLivre;
  if (livrer === undefined) return;
  for (let essai = 0; essai < 3; essai++) {
    if ((await livrer.call(a.rappel, compte, jobId).catch(() => null)) !== null) return;
    await attendre(reglagesDetache.relanceMs);
  }
}

/** Lance la commande comme job et l'attend jusqu'à l'échéance ou l'abandon de l'appel (Stop) : fini avant, résultat normal fusionné ; sinon la commande continue et réveillera comme un job ordinaire. */
export async function executerDetache(
  d: DemandeDetache,
  ctx: ContexteAppel,
  a: AppuisJobs,
): Promise<IssueDetache> {
  const c = await compteDuChat(ctx, a);
  if (c === null) return { repli: raison(PAS_ICI()) };
  const { compte, chatId } = c;
  const commande = d.strict ? `set -euo pipefail\n${d.command}` : d.command;
  let jobId: string;
  let pid: number | null;
  let chaine: Dict;
  try {
    const l = await lancer(
      {
        command: commande,
        cwd: d.cwd,
        env: d.env,
        label: libelle("", d.command),
        wake_on: ["exit"],
        resume_note: NOTE_REPRISE,
        wake: true,
      },
      a,
      compte,
      chatId,
      ctx,
    );
    if ("refus" in l)
      return l.refus["error"] === "launch_unconfirmed"
        ? { resultat: l.refus, termine: false }
        : { repli: raison(l.refus) };
    ({ jobId, pid } = l);
    chaine = chaineDeReveils(l.reg);
  } catch (e) {
    if (e instanceof Refus) return { repli: `${e.code}: ${e.message}` };
    throw e;
  }
  const sb = await a.bac(compte.user_id, compte.username);
  const agent = agentJobs(sb.agent);
  const debut = Date.now();
  const echeance = debut + d.timeoutS * 1000;
  while (!ctx.signal.aborted) {
    const fiche = (await agent.jobsStatus(jobId, { passive: true }).catch(() => []))[0];
    const etat = String(fiche?.["state"] ?? "");
    if (TERMINAUX.has(etat) && !ctx.signal.aborted) {
      if (etat !== "exited" && etat !== "killed") {
        await marquerLivre(a, compte, jobId);
        return {
          resultat: err(`job_${etat}`, `The command's job ended in state '${etat}' without an exit code.`, {
            job_id: jobId,
            log: journalDuJob(jobId),
          }),
          termine: true,
        };
      }
      const code = typeof fiche?.["exit_code"] === "number" ? fiche["exit_code"] : -1;
      const sortie = await lireJournal(agent, jobId, d.maxOutput).catch(() => Buffer.alloc(0));
      const brut: ResultatExec = {
        returncode: code,
        stdout: sortie,
        stderr: Buffer.alloc(0),
        duration_s: (Date.now() - debut) / 1000,
        timed_out: false,
        executor_tag: sb.containerName,
      } as ResultatExec;
      const r = formatResult(brut, d.command, d.maxOutput, toContainer(d.cwd));
      r["merged_output"] = true;
      if (r["truncated"] === true) {
        r["saved_to"] = journalDuJob(jobId);
        r["hint"] =
          `Output truncated — the FULL merged output is in ${journalDuJob(jobId)}. Use read_file with grep/tail on it; ` +
          "do not re-run the command just to see more.";
      }
      await marquerLivre(a, compte, jobId);
      return { resultat: r, termine: true };
    }
    if (Date.now() >= echeance) break;
    await attendre(Math.min(reglagesDetache.sondeMs, Math.max(1, echeance - Date.now())));
  }
  return {
    resultat: {
      ok: true,
      detached: true,
      cmd: d.command,
      job_id: jobId,
      pid,
      log: journalDuJob(jobId),
      wake_on: ["exit"],
      ...chaine,
      hint:
        "warning" in chaine
          ? `The command is still running as background job ${jobId}; it will not wake you (wake chain limit): ` +
            "its exit will be attached to your next tool result or to the user's next message."
          : `The command is still running as background job ${jobId}; end your turn, you will be woken when it exits. Do not poll.`,
    },
    termine: false,
  };
}
