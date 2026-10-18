// SPDX-License-Identifier: MIT
/** apps/core/src/tour/suivi-run.ts — rejeu puis suite en direct du journal d'un run, pour se rattacher à un tour en cours (`/api/chat/{id}/run/events` de routes/chat_control.py). */
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { dormirMs, HttpError, intPy, stripPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { verrousChat } from "./etat";
import { currentRun, isEnded, journalPath, readLines } from "./journal-run";

const PAUSE_S = 0.15;
const GRACE_S = 3.0;
const PING_S = 20.0;
const REVALIDATION_S = 60.0;

/** Horloge monotone et attente : remplaçables par les tests (horloge logique). */
export interface ReglagesSuivi {
  maintenant: () => number;
  dormir: (s: number, signal: AbortSignal) => Promise<void>;
}

const DEFAUTS: ReglagesSuivi = {
  maintenant: () => performance.now() / 1000,
  dormir: (s, signal) => dormirMs(s * 1000, signal).catch(() => undefined),
};
let reglages: ReglagesSuivi = { ...DEFAUTS };

export function reglerSuiviPourTests(r: Partial<ReglagesSuivi> | null): void {
  reglages = r === null ? { ...DEFAUTS } : { ...reglages, ...r };
}

export interface SuiviRun {
  readonly uid: number;
  readonly chatId: string;
  readonly runId: string;
  readonly chemin: string;
  readonly fromSeq: number;
}

/** Run demandé (paramètre `run_id`, sinon le courant) et premier numéro à rendre ; 404 `run_not_found` s'il n'est pas le run courant du chat. */
export function preparerSuivi(
  uid: number,
  chatId: string,
  runIdDemande: string | null,
  from: string | null,
): SuiviRun {
  const cur = currentRun(uid, chatId);
  const runId = stripPy(runIdDemande ?? "") || (cur?.["run_id"] as string | undefined);
  if (cur === null || !runId || cur["run_id"] !== runId) throw new HttpError(404, "run_not_found");
  let fromSeq: number;
  try {
    fromSeq = Math.max(0, intPy(veritePy(from) ? from : 0));
  } catch {
    fromSeq = 0;
  }
  return { uid, chatId, runId, chemin: journalPath(uid, chatId, runId) as string, fromSeq };
}

function absent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export interface OptionsSuivi {
  readonly signal: AbortSignal;
  /** `stream_session_still_valid` ; une panne vaut « encore valide ». */
  readonly revalider: () => Promise<boolean>;
}

/** Événements du run (`_s` = numéro de ligne), `replay_done` à la fin du rejeu, puis `run_end`, `run_lost` ou `session_expired`. */
export async function* evenementsDuRun(s: SuiviRun, options: OptionsSuivi): AsyncGenerator<Dict> {
  const { signal } = options;
  let offset = 0;
  let replayDone = false;
  let lostSince: number | null = null;
  let lastPing = reglages.maintenant();
  let lastCheck = lastPing;
  let lastHeldProbe = 0.0;
  const rendre = function* (items: Dict[]): Generator<Dict, boolean> {
    for (const it of items) {
      const seq = intPy(veritePy(it["s"]) ? it["s"] : 0);
      if (seq < s.fromSeq) continue;
      const ev: Dict = { ...(it["e"] as Dict), _s: seq };
      yield ev;
      if (ev["type"] === "run_end") return true;
    }
    return false;
  };
  for (;;) {
    let grew: boolean;
    try {
      grew = statSync(s.chemin).size > offset;
    } catch (e) {
      if (absent(e)) {
        yield { type: "run_lost", reason: "journal" };
        return;
      }
      grew = true;
    }
    let items: Dict[] = [];
    if (grew) {
      try {
        [items, offset] = readLines(s.chemin, offset);
      } catch (e) {
        if (!absent(e)) throw e;
        yield { type: "run_lost", reason: "journal" };
        return;
      }
    }
    if (yield* rendre(items)) return;
    const now = reglages.maintenant();
    if (now - lastCheck > REVALIDATION_S) {
      lastCheck = now;
      let valide: boolean;
      try {
        valide = await options.revalider();
      } catch {
        valide = true;
      }
      if (!valide) {
        yield { type: "session_expired" };
        return;
      }
    }
    if (now - lastPing > PING_S) {
      lastPing = now;
      yield { type: "ping" };
    }
    if (signal.aborted) return;
    if (items.length) {
      lostSince = null;
      continue;
    }
    if (!replayDone) {
      replayDone = true;
      yield { type: "replay_done" };
    }
    if (isEnded(s.uid, s.chatId, s.runId)) {
      if (yield* rendre(readLines(s.chemin, offset)[0])) return;
      yield { type: "run_end", status: "unknown" };
      return;
    }
    if (now - lastHeldProbe >= 1.0) {
      lastHeldProbe = now;
      if (!verrousChat.isHeld("gen", s.uid, s.chatId)) {
        lostSince = lostSince || now;
        if (now - lostSince > GRACE_S) {
          yield { type: "run_lost", reason: "worker" };
          return;
        }
      } else lostSince = null;
    }
    await reglages.dormir(PAUSE_S, signal);
  }
}
