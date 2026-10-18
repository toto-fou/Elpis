// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/revocation.ts — `apply_session_revocation` : les flux déjà ouverts d'un compte révoqué se ferment. */
import { intPy, reprPy } from "@elpis/commun";

import type { Journal } from "../journal";
import type { PipelineEvents } from "./pipeline";
import type { Message, SystemEvents } from "./systeme";

export interface CiblesRevocation {
  readonly systemEvents: SystemEvents;
  readonly pipelineEvents: PipelineEvents;
  /** Terminaux du compte (`null` : tous) ; rend leur nombre, -1 pour « tous ». */
  readonly fermerTerminaux?: (uid: number | null) => number | Promise<number>;
  readonly journal?: Journal;
}

export interface BilanRevocation {
  uid: number | null;
  systeme: number;
  pipeline: number;
  terminaux: number;
}

/** `{"type": "session_revoked", "uid": N|null}` : `session_expired` puis fermeture ; idempotent. */
export async function applySessionRevocation(
  payload: Message,
  cibles: CiblesRevocation,
): Promise<BilanRevocation | null> {
  const brut = payload["uid"] ?? null;
  let uid: number | null;
  try {
    uid = brut === null ? null : intPy(brut);
  } catch {
    cibles.journal?.warn(`[session_revoked] uid invalide dans le payload: ${reprPy(brut)}`);
    return null;
  }
  const expire: Message = { type: "session_expired" };
  const systeme = cibles.systemEvents.disconnectUser(uid, expire);
  const pipeline =
    uid === null
      ? cibles.pipelineEvents.disconnectAll(expire)
      : cibles.pipelineEvents.disconnectUser(uid, expire);
  let terminaux = 0;
  try {
    terminaux = (await cibles.fermerTerminaux?.(uid)) ?? 0;
  } catch (e) {
    cibles.journal?.error({ err: e }, "[session_revoked] fermeture des terminaux échouée");
  }
  if (systeme || pipeline || terminaux) {
    cibles.journal?.info(
      `[session_revoked] uid=${uid ?? "ALL"} : ${systeme} flux système, ${pipeline} flux pipeline, ` +
        `${terminaux === -1 ? "tous" : terminaux} PTY fermés (pid=${process.pid})`,
    );
  }
  return { uid, systeme, pipeline, terminaux };
}
