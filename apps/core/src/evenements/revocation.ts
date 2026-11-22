// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/revocation.ts — `apply_session_revocation` : les flux déjà ouverts d'un compte révoqué se ferment. */
import { intPy, reprPy } from "@elpis/commun";

import type { Journal } from "../journal";
import type { Message, SystemEvents } from "./systeme";

export interface CiblesRevocation {
  readonly systemEvents: SystemEvents;
  /** Terminaux du compte (`null` : tous ; avec `sid`, ceux de cette session) ; rend leur nombre, -1 pour « tous ». */
  readonly fermerTerminaux?: (uid: number | null, sid?: string) => number | Promise<number>;
  /** Exécutions en cours du compte (tours de chat, runs de routine) ; rend leur nombre coupé. */
  readonly arreterExecutions?: (uid: number) => number | Promise<number>;
  readonly journal?: Journal;
}

export interface BilanRevocation {
  uid: number | null;
  systeme: number;
  terminaux: number;
}

/** `{"type": "session_revoked", "uid": N|null}` : `session_expired` puis fermeture ; avec `sid`, les seuls flux de cette session (les autres se ferment à leur revalidation) ; idempotent. */
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
  const sid = payload["sid"];
  if (uid !== null && typeof sid === "string" && sid !== "") {
    const fermes = cibles.systemEvents.disconnectSession(uid, sid, expire);
    let terminaux = 0;
    try {
      terminaux = (await cibles.fermerTerminaux?.(uid, sid)) ?? 0;
    } catch (e) {
      cibles.journal?.error({ err: e }, "[session_revoked] fermeture des terminaux de la session échouée");
    }
    return { uid, systeme: fermes, terminaux };
  }
  const systeme = cibles.systemEvents.disconnectUser(uid, expire);
  let terminaux = 0;
  try {
    terminaux = (await cibles.fermerTerminaux?.(uid)) ?? 0;
  } catch (e) {
    cibles.journal?.error({ err: e }, "[session_revoked] fermeture des terminaux échouée");
  }
  if (systeme || terminaux) {
    cibles.journal?.info(
      `[session_revoked] uid=${uid ?? "ALL"} : ${systeme} flux système, ` +
        `${terminaux === -1 ? "tous" : terminaux} PTY fermés (pid=${process.pid})`,
    );
  }
  return { uid, systeme, terminaux };
}

/** `{"type": "account_suspended", "uid": N}` : flux et terminaux fermés comme une révocation, puis exécutions du compte coupées ; idempotent. */
export async function applyAccountSuspension(
  payload: Message,
  cibles: CiblesRevocation,
): Promise<BilanRevocation | null> {
  const bilan = await applySessionRevocation(payload, cibles);
  if (bilan === null || bilan.uid === null) return bilan;
  try {
    const n = (await cibles.arreterExecutions?.(bilan.uid)) ?? 0;
    if (n) cibles.journal?.info(`[account_suspended] uid=${bilan.uid} : ${n} exécution(s) coupée(s)`);
  } catch (e) {
    cibles.journal?.error({ err: e }, "[account_suspended] arrêt des exécutions échoué");
  }
  return bilan;
}
