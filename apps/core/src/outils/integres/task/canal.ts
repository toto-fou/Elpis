// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/canal.ts — outils du parent sur un enfant en fond de sa conversation : `task_status` (lire), `task_wait` (attendre son rapport), `task_send` (lui parler, le faire conclure). */
import { CancelledError, estDict, longueurPy, pyJsonDumps, strPy, stripPy, texteOu } from "@elpis/commun";

import { ATTENTE_DEFAUT_S, ATTENTE_MAX_S } from "../../../llm/constantes";
import type { Dict } from "../../../python";
import type { AppelIntegre } from "../../catalogue";
import { err } from "../../erreur-outil";
import { tachesFond } from "../../ports";
import { TASK_SEND_MAX } from "./definition";
import { FOND } from "./fond";
import type { EnFond } from "./fond";
import { cle } from "./registre";
import { resumeLookup } from "./reprise";
import type { OptionsTache } from "./tour";

/** Messages en attente d'un enfant au plus : au-delà, il ne lit plus assez vite (la conclusion reste permise). */
const BOITE_MAX = 20;

/** Attend `fin` au plus `ms` : vrai si elle est venue, faux au délai ; l'arrêt du tour (signal) lève. */
async function attendreBorne(fin: Promise<void>, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new CancelledError("task_wait cancelled");
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  let surArret: (() => void) | undefined;
  try {
    return await Promise.race([
      fin.then(() => true),
      new Promise<boolean>((ok) => {
        minuterie = setTimeout(() => ok(false), ms);
      }),
      new Promise<boolean>((_, ko) => {
        surArret = () => ko(new CancelledError("task_wait cancelled"));
        signal?.addEventListener("abort", surArret, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(minuterie);
    if (surArret) signal?.removeEventListener("abort", surArret);
  }
}

/** Sous-agent en fond de CETTE conversation désigné par `task_id`, `null` sinon. */
function enFondDuChat(o: OptionsTache, taskId: string): EnFond | null {
  const e = taskId ? FOND.get(cle(o.username, taskId)) : undefined;
  return e && e.chatId === o.chatId ? e : null;
}

/** État d'un enfant en fond pour le modèle ; `elapsed_s` part de sa place au moteur comme `duration_s` (durée finale une fois fini), `queued_s` est l'attente avant. */
function etatFond(taskId: string, e: EnFond): Dict {
  const d = e.lire();
  const maintenant = Date.now() / 1000;
  const depart = typeof d["started_at"] === "number" ? d["started_at"] : null;
  const ecoule =
    !e.actif && typeof d["duration_s"] === "number"
      ? d["duration_s"]
      : depart === null
        ? 0
        : maintenant - depart;
  const garde = Object.fromEntries(
    [
      "step",
      "max_steps",
      "tool_calls",
      "last_text",
      "input_tokens",
      "output_tokens",
      "context_tokens",
      "status",
    ]
      .filter((c) => d[c] !== undefined)
      .map((c) => [c, d[c]]),
  );
  return {
    task_id: taskId,
    job_id: e.jobId,
    agent: e.agent,
    label: e.label,
    state: e.actif ? "running" : strPy(d["state"] ?? "finished"),
    elapsed_s: Math.round(ecoule),
    queued_s: Math.round(typeof d["queued_s"] === "number" ? d["queued_s"] : maintenant - e.debut),
    ...garde,
    ...(e.recent().length ? { recent: e.recent() } : {}),
  };
}

/** Refus `unknown_task_id` : la reprise est conseillée si l'agent est reprenable. */
function inconnu(o: OptionsTache, taskId: string): string {
  return pyJsonDumps(
    err("unknown_task_id", `no background sub-agent '${taskId}' in this conversation on this server`, {
      fix:
        taskId && resumeLookup(o.username, taskId) !== null
          ? "it is not running in the background: pass it to task(task_id=…) to resume it"
          : "use the task_id returned by task(background=true)",
    }),
  );
}

/** Arrêt du tour ou abandon de l'appel par la boucle, réunis. */
function signalDe(o: OptionsTache, appel?: AppelIntegre): AbortSignal | undefined {
  return o.signal && appel?.signal ? AbortSignal.any([o.signal, appel.signal]) : (appel?.signal ?? o.signal);
}

/** Enfant fini : son rapport s'il n'a pas encore été remis (pris pour ce résultat d'outil), sinon son état ; appel abandonné : rien de pris. */
async function rapportOuEtat(
  o: OptionsTache,
  taskId: string,
  e: EnFond,
  signal?: AbortSignal,
): Promise<string> {
  await e.fin;
  const port = tachesFond();
  const rapport =
    port !== null && o.userId && o.chatId
      ? await port.prendreRapport(o.userId, o.chatId, e.jobId, signal)
      : null;
  if (signal?.aborted) throw new CancelledError("task report call abandoned");
  if (rapport) return rapport;
  return pyJsonDumps({
    ok: true,
    ...etatFond(taskId, e),
    report: "already delivered in this conversation (job event)",
  });
}

/** `task_id` des arguments d'un outil du canal. */
function idDe(args: Dict): string {
  return stripPy(texteOu(estDict(args) ? args["task_id"] : "", ""));
}

/** `task_status` : progression d'un enfant en fond, ou son rapport s'il est fini et pas encore remis. */
export async function statutTache(o: OptionsTache, args: Dict, appel?: AppelIntegre): Promise<string> {
  const taskId = idDe(args);
  const e = enFondDuChat(o, taskId);
  if (e === null) return inconnu(o, taskId);
  if (!e.actif) return rapportOuEtat(o, taskId, e, signalDe(o, appel));
  return pyJsonDumps({
    ok: true,
    ...etatFond(taskId, e),
    note: "still running: its report will be delivered automatically, do not poll",
  });
}

/** `task_wait` : rapport d'un enfant en fond attendu au plus `timeout_s`, sinon sa progression. */
export async function attendreTache(o: OptionsTache, args: Dict, appel?: AppelIntegre): Promise<string> {
  const taskId = idDe(args);
  const e = enFondDuChat(o, taskId);
  if (e === null) return inconnu(o, taskId);
  const signal = signalDe(o, appel);
  const brutS = estDict(args) ? args["timeout_s"] : undefined;
  const voulu = typeof brutS === "number" && Number.isFinite(brutS) ? Math.trunc(brutS) : ATTENTE_DEFAUT_S;
  const attenteS = Math.min(ATTENTE_MAX_S, Math.max(1, voulu));
  if (e.actif && !(await attendreBorne(e.fin, attenteS * 1000, signal)))
    return pyJsonDumps({
      ok: true,
      ...etatFond(taskId, e),
      timed_out: true,
      note: `still running after ${attenteS} s: its report will be delivered automatically; wait again only if you cannot go on without it`,
    });
  return rapportOuEtat(o, taskId, e, signal);
}

/** `task_send` : message remis à l'enfant en fond avant sa prochaine requête au moteur ; `wrap_up` le fait conclure (génération et appel d'outil en cours coupés, comme à l'échéance souple). */
export async function envoyerTache(o: OptionsTache, args: Dict): Promise<string> {
  const taskId = idDe(args);
  const e = enFondDuChat(o, taskId);
  if (e === null) return inconnu(o, taskId);
  if (!e.actif)
    return pyJsonDumps(
      err("not_running", `sub-agent '${taskId}' has already finished`, {
        fix: `read its report; resume it with task(task_id="${taskId}", prompt=…) if more is needed`,
      }),
    );
  if (e.conclusion.signal.aborted)
    return pyJsonDumps(
      err("wrapping_up", `sub-agent '${taskId}' is already writing its final report`, {
        fix: "wait for its report, then resume it with task(task_id=…) if more is needed",
      }),
    );
  const message = stripPy(texteOu(estDict(args) ? args["message"] : "", ""));
  if (!message)
    return pyJsonDumps(err("empty_message", "message is empty", { fix: "write the instruction in message" }));
  if (longueurPy(message) > TASK_SEND_MAX)
    return pyJsonDumps(
      err("message_too_long", `message is longer than ${TASK_SEND_MAX} characters`, {
        fix: "shorten it, or write the details to a file under /work and name that file",
      }),
    );
  const conclure = estDict(args) && args["wrap_up"] === true;
  if (!conclure && e.boite.length >= BOITE_MAX)
    return pyJsonDumps(
      err("mailbox_full", `sub-agent '${taskId}' has ${BOITE_MAX} unread messages`, {
        fix: "wait for it to read them (task_status), or send wrap_up=true to make it conclude",
      }),
    );
  e.boite.push(message);
  if (conclure) e.conclusion.abort();
  return pyJsonDumps({
    ok: true,
    task_id: taskId,
    queued: true,
    wrap_up: conclure,
    note: conclure
      ? "it reads your message, stops working and writes its report (Status: partial), delivered automatically"
      : "it reads your message before its next step; if it finishes first, the message is not read",
  });
}
