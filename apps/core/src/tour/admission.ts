// SPDX-License-Identifier: MIT
/** apps/core/src/tour/admission.ts — gardes d'entrée d'un tour : verrou de présence « une génération à la fois par conversation », passation après un Stop, réservation jusqu'à la réclamation par le tour, compressions manuelles en vol (chatbot_app/turn/admission.py). */
import { egalPy, estDict, HttpError, intPy, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";
import { performance } from "node:perf_hooks";

import { journal } from "../journal";
import { isChatCancelled, verrousChat } from "./etat";
import type { JetonVerrou } from "./etat";

const log = journal("uvicorn.error");

export const PENDING_GEN_LOCK_TTL_S = 120.0;
export const PENDING_GEN_LOCK_WATCHDOG_S = 30.0;
const HANDOVER_WAIT_S = 12.0;
const HANDOVER_PAS_S = 0.2;

export interface Reservation {
  readonly jeton: JetonVerrou;
  readonly ts: number;
}

/** Verrous pris par la route et pas encore réclamés par le tour, par `uid\0chat`. */
export const pendingGenLocks = new Map<string, Reservation>();

export const cleReservation = (uid: number, chatId: string): string => `${uid}\x00${chatId}`;

const monotone = (): number => performance.now() / 1000;

/** Relâche CETTE réservation si elle n'a toujours pas été réclamée (une plus récente du même chat n'est pas touchée). */
export function releaseUnclaimedGenLock(cle: string, entree: Reservation): void {
  if (pendingGenLocks.get(cle) !== entree) return;
  pendingGenLocks.delete(cle);
  verrousChat.release(entree.jeton);
  log.warn(
    `[chat_stream] verrou de présence réservé jamais réclamé (client parti avant le flux) — relâché par le filet : ${JSON.stringify(cle.split("\x00"))}`,
  );
}

/** Relâche les réservations que le tour n'a jamais réclamées au-delà de 120 s. */
export function sweepPendingGenLocks(): void {
  const t = monotone();
  for (const [cle, e] of [...pendingGenLocks]) {
    if (t - e.ts <= PENDING_GEN_LOCK_TTL_S) continue;
    pendingGenLocks.delete(cle);
    verrousChat.release(e.jeton);
    log.warn(
      `[chat_stream] verrou de présence réservé jamais réclamé (client déconnecté avant le flux) — relâché : ${JSON.stringify(cle.split("\x00"))}`,
    );
  }
}

/** Réserve le verrou jusqu'à la réclamation par le tour, avec un filet à 30 s. */
export function reserverVerrou(uid: number, chatId: string, jeton: JetonVerrou): void {
  const cle = cleReservation(uid, chatId);
  const entree = { jeton, ts: monotone() };
  pendingGenLocks.set(cle, entree);
  setTimeout(() => releaseUnclaimedGenLock(cle, entree), PENDING_GEN_LOCK_WATCHDOG_S * 1000).unref();
}

/** Réclamation par le tour ; `null` si rien n'était réservé. */
export function reclamerVerrou(uid: number, chatId: string): Reservation | null {
  const cle = cleReservation(uid, chatId);
  const e = pendingGenLocks.get(cle) ?? null;
  pendingGenLocks.delete(cle);
  return e;
}

function tronque(m: unknown): boolean {
  if (!estDict(m) || m["role"] !== "assistant") return false;
  const err = m["image_error"];
  return veritePy(m["isTruncated"]) || (estDict(err) && err["code"] === "cancelled");
}

/** Le chat relu après une passation ne diffère-t-il de la base que par le partiel du run stoppé (ajouté, ou remplaçant le dernier assistant) ? */
export function handoverRebaselineOk(old: unknown, fresh: unknown): boolean {
  const a = Array.isArray(old) ? old : [];
  const f = Array.isArray(fresh) ? fresh : [];
  if (egalPy(f, a)) return true;
  if (!f.length || !tronque(f.at(-1))) return false;
  if (f.length === a.length + 1) return egalPy(f.slice(0, -1), a);
  if (
    f.length === a.length &&
    a.length &&
    estDict(a.at(-1)) &&
    (a.at(-1) as Record<string, unknown>)["role"] === "assistant"
  )
    return egalPy(f.slice(0, -1), a.slice(0, -1));
  return false;
}

/** 429 si le compte tient déjà `MAX_RUNS_PER_USER` générations (verrou du chat en cours d'annulation non compté ; `apresPrise` : le verrou du chat est déjà pris) ; sans attente avant la prise du verrou, pour que deux requêtes simultanées ne dépassent pas le plafond. */
export function verifierPlafondRuns(uid: number, chatId: string | null = null, apresPrise = false): void {
  let maxRuns: number;
  try {
    maxRuns = intPy(veritePy(config.MAX_RUNS_PER_USER) ? config.MAX_RUNS_PER_USER : 0);
  } catch {
    maxRuns = 0;
  }
  if (maxRuns <= 0) return;
  let n = verrousChat.countHeld("gen", uid);
  if (
    !apresPrise &&
    chatId !== null &&
    isChatCancelled(uid, chatId) &&
    verrousChat.isHeld("gen", uid, chatId)
  )
    n -= 1;
  if (apresPrise ? n <= maxRuns : n < maxRuns) return;
  log.info(`[chat_stream] user=${uid} a déjà ${n} génération(s) en cours (plafond ${maxRuns}) — refus`);
  throw new HttpError(429, "too_many_runs");
}

/** Verrou « gen » du chat, ou 409 ; après un Stop, attend jusqu'à 12 s l'unwind du run précédent (`attendu` reçoit alors `true`). */
export async function acquireGenPresence(
  uid: number,
  chatId: string,
  attendu?: boolean[],
  dormir: (s: number) => Promise<void> = (s) => new Promise((ok) => setTimeout(ok, s * 1000)),
): Promise<JetonVerrou> {
  let jeton = verrousChat.acquire("gen", uid, chatId);
  if (jeton !== null) return jeton;
  if (isChatCancelled(uid, chatId)) {
    const limite = monotone() + HANDOVER_WAIT_S;
    while (monotone() < limite) {
      await dormir(HANDOVER_PAS_S);
      jeton = verrousChat.acquire("gen", uid, chatId);
      if (jeton !== null) {
        try {
          verifierPlafondRuns(uid, chatId, true);
        } catch (e) {
          verrousChat.release(jeton);
          throw e;
        }
        attendu?.push(true);
        return jeton;
      }
    }
  }
  throw new HttpError(409, "generation_running");
}

// ── Compressions manuelles ───────────────────────────────────────────────────

const compressions = new Map<string, JetonVerrou | null>();

export function manualCompressionActive(uid: number, chatId: string): boolean {
  return compressions.has(cleReservation(uid, chatId)) || verrousChat.isHeld("compact", uid, chatId);
}

/** Compaction en vol ; une seconde compaction concurrente ne remplace pas le jeton de la première (sinon il ne serait jamais rendu). */
export function manualCompressionBegin(uid: number, chatId: string): void {
  const cle = cleReservation(uid, chatId);
  const jeton = verrousChat.acquire("compact", uid, chatId);
  if (jeton !== null || !compressions.has(cle)) compressions.set(cle, jeton);
}

export function manualCompressionEnd(uid: number, chatId: string): void {
  const cle = cleReservation(uid, chatId);
  verrousChat.release(compressions.get(cle) ?? null);
  compressions.delete(cle);
}

/** Remet l'admission à zéro (tests). */
export function viderAdmissionPourTests(): void {
  pendingGenLocks.clear();
  compressions.clear();
}
