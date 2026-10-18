// SPDX-License-Identifier: MIT
/** apps/toolhost/src/terminal/ws.ts — WebSocket ↔ PTY (`_terminal_ws_loop`) : trame d'accueil, sortie en binaire avec contre-pression, frappe limitée, redimensionnement, ping, quota, inactivité, 4001 du relais. */
import { estDict, getPy, intPy, nomTypePy, pyJsonDumps, pyJsonLoads, veritePy } from "@elpis/commun";
import type { Base } from "@elpis/db";
import WebSocket from "ws";
import type { RawData } from "ws";

import type { Journal } from "../journal";
import type { Consommateur, Terminal, Terminaux } from "./pty";
import { quotaOctets, usageBac } from "./quota";

export const WS_INPUT_RATE_CAPACITY = 200;
export const WS_INPUT_RATE_REFILL = 100.0;
export const WS_MAX_CTRL_BYTES = 1024;
export const WS_QUOTA_INTERVAL_S = 20.0;
export const WS_QUOTA_WARN_PCT = 0.9;
export const WS_INACTIVITE_S = 300;
/** Réglages de la boucle, modifiables en test : tic d'inactivité (5 s), période de la sonde de quota. */
export const reglagesWs = {
  ticMs: 5_000,
  intervalleQuotaS: WS_QUOTA_INTERVAL_S,
  inactiviteS: WS_INACTIVITE_S,
};
/** Messages gardés pendant l'ouverture (`ws_max_queue` d'uvicorn) : au-delà, la socket cesse d'être lue jusqu'à la boucle. */
const FILE_OUVERTURE = 32;
/** Au-delà de ce qui attend l'envoi, le PTY cesse d'être lu (la file de 128 morceaux du Python), reprise sous le seuil bas. */
const SEUIL_HAUT = 2 * 1024 * 1024;
const SEUIL_BAS = 512 * 1024;

export interface ContexteWs {
  readonly terminaux: Terminaux;
  readonly base: () => Promise<Base>;
  readonly journal: Journal;
  readonly arret?: AbortSignal | undefined;
}

/** Messages arrivés avant la boucle (contrôles d'ouverture), rejoués dans l'ordre ; fermeture notée. */
export interface Tampon {
  readonly messages: { donnees: RawData; binaire: boolean }[];
  ferme: { code: number } | null;
  liberer(): void;
}

export function tamponner(socket: WebSocket): Tampon {
  const t: Tampon = {
    messages: [],
    ferme: null,
    liberer: () => {
      socket.off("message", surMessage);
      socket.off("close", surFermeture);
    },
  };
  const surMessage = (donnees: RawData, binaire: boolean): void => {
    t.messages.push({ donnees, binaire });
    if (t.messages.length >= FILE_OUVERTURE) socket.pause();
  };
  const surFermeture = (code: number): void => {
    t.ferme = { code };
  };
  socket.on("message", surMessage);
  socket.on("close", surFermeture);
  socket.on("error", () => undefined);
  return t;
}

/** Fin d'une ouverture sans boucle : tampon rendu ; un 4001 du relais (reçu ou en cours de fermeture) tue les PTY du compte. */
export function abandonner(socket: WebSocket, tampon: Tampon, uid: number, ctx: ContexteWs): void {
  tampon.liberer();
  const expire = (): void => {
    ctx.journal.info(`[PTY-WS] session expirée signalée par le relais uid=${uid}`);
    ctx.terminaux.tuerDuCompte(uid);
  };
  if (tampon.ferme !== null) {
    if (tampon.ferme.code === 4001) expire();
  } else if (socket.readyState === WebSocket.CLOSING) {
    socket.once("close", (code: number) => {
      if (code === 4001) expire();
    });
  }
}

/** `ws.send_json` de Starlette : JSON compact, UTF-8 brut. */
export function jsonCompact(valeur: unknown): string {
  return pyJsonDumps(valeur, { separators: [",", ":"], ensureAscii: false });
}

function octets(donnees: RawData): Buffer {
  if (Buffer.isBuffer(donnees)) return donnees;
  if (Array.isArray(donnees)) return Buffer.concat(donnees);
  return Buffer.from(donnees);
}

/** `len(texte) > n` en points de code, sans tout parcourir. */
function plusDePointsDeCode(texte: string, n: number): boolean {
  if (texte.length <= n) return false;
  let i = 0;
  for (const c of texte) if (c && ++i > n) return true;
  return false;
}

/** Fermeture si la socket est encore ouverte (une fermeture déjà engagée reste telle quelle). */
export function fermer(socket: WebSocket, code: number, raison = ""): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, raison);
}

/** Boucle d'un client sur un PTY ; rendue à la fermeture de la socket. */
export async function boucleWs(
  socket: WebSocket,
  term: Terminal,
  ctx: ContexteWs,
  tampon: Tampon,
): Promise<void> {
  const quota = await quotaOctets(ctx.base, term.uid);
  if (tampon.ferme !== null || socket.readyState !== WebSocket.OPEN)
    return abandonner(socket, tampon, term.uid, ctx);
  let fini = false;
  let derniereSonde = Date.now() / 1000;
  let averti = false;
  let sondeEnCours = false;
  let jetons = WS_INPUT_RATE_CAPACITY;
  let dernierRemplissage = performance.now() / 1000;
  let dernierRecu = performance.now() / 1000;

  const envoyer = (morceau: Buffer | string, binaire: boolean): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(morceau, { binary: binaire }, () => {
      if (socket.bufferedAmount < SEUIL_BAS) term.pause(consommateur, false);
    });
    if (socket.bufferedAmount > SEUIL_HAUT) term.pause(consommateur, true);
  };

  const terminer = (code: number): void => {
    fini = true;
    term.detacher(consommateur);
    fermer(socket, code);
  };

  const consommateur: Consommateur = {
    donnees: (morceau) => {
      if (!fini) envoyer(morceau, true);
    },
    fin: () => {
      if (fini) return;
      envoyer(jsonCompact({ type: "exit" }), false);
      terminer(1000);
    },
    remplace: () => {
      if (!fini) terminer(1000);
    },
  };

  const avis = (texte: string): void => envoyer(Buffer.from(texte, "utf-8"), true);

  /** `_quota_check` : au plus toutes les 20 s, mesure en dehors du flux ; échec de mesure = shell laissé ouvert. */
  const sonderQuota = async (): Promise<void> => {
    if (quota <= 0 || sondeEnCours || fini) return;
    if (Date.now() / 1000 - derniereSonde < reglagesWs.intervalleQuotaS) return;
    derniereSonde = Date.now() / 1000;
    sondeEnCours = true;
    let utilise: number;
    try {
      utilise = await usageBac(term.uid, term.racine, quota);
    } catch {
      return;
    } finally {
      sondeEnCours = false;
    }
    if (fini) return;
    if (utilise > quota) {
      avis("\r\n\x1b[41;97m ⚠  QUOTA SANDBOX DÉPASSÉ — session fermée \x1b[0m\r\n");
      ctx.journal.info(
        `[PTY-WS] quota dépassé uid=${term.uid} (${(utilise / 1048576).toFixed(1)} Mo > ${(quota / 1048576).toFixed(1)} Mo) — PTY tué`,
      );
      fini = true;
      term.tuer();
      fermer(socket, 1000);
      return;
    }
    if (!averti && utilise > quota * WS_QUOTA_WARN_PCT) {
      averti = true;
      avis(
        `\r\n\x1b[43;30m ⚠  Quota sandbox à ${Math.floor((utilise * 100) / quota)} % — libérez de l'espace, ` +
          "la session sera fermée au dépassement \x1b[0m\r\n",
      );
    }
  };

  /** Seau à jetons des trames de frappe : 200 en rafale, 100 par seconde ; au-delà, la trame est jetée. */
  const autoriser = (): boolean => {
    const t = performance.now() / 1000;
    jetons = Math.min(WS_INPUT_RATE_CAPACITY, jetons + (t - dernierRemplissage) * WS_INPUT_RATE_REFILL);
    dernierRemplissage = t;
    if (jetons >= 1) {
      jetons -= 1;
      return true;
    }
    return false;
  };

  const controle = (texte: string): void => {
    if (plusDePointsDeCode(texte, WS_MAX_CTRL_BYTES)) return;
    let obj: unknown;
    try {
      obj = pyJsonLoads(texte);
    } catch {
      return;
    }
    if (!estDict(obj)) {
      ctx.journal.warn(`[PTY-WS] loop error: '${nomTypePy(obj)}' object has no attribute 'get'`);
      terminer(1000);
      return;
    }
    const premier = getPy(obj, "op", null);
    const op = veritePy(premier) ? premier : getPy(obj, "type", null);
    if (op === "resize") {
      try {
        const lignes = Math.max(1, intPy(getPy(obj, "rows", 24)));
        const colonnes = Math.max(1, intPy(getPy(obj, "cols", 80)));
        term.redimensionner(lignes, colonnes);
      } catch {
        return;
      }
    } else if (op === "ping") {
      envoyer(jsonCompact({ type: "pong" }), false);
    }
  };

  const recevoir = (donnees: RawData, binaire: boolean): void => {
    if (fini) return;
    dernierRecu = performance.now() / 1000;
    void sonderQuota();
    if (binaire) {
      if (!autoriser()) return;
      try {
        term.ecrire(octets(donnees));
      } catch {
        terminer(1000);
      }
      return;
    }
    controle(octets(donnees).toString("utf-8"));
  };

  const tic = setInterval(() => {
    if (fini) return;
    if (performance.now() / 1000 - dernierRecu > reglagesWs.inactiviteS) {
      ctx.journal.info(`[PTY-WS] idle timeout uid=${term.uid} sid=${term.sid}`);
      terminer(1000);
      return;
    }
    void sonderQuota();
  }, reglagesWs.ticMs);
  tic.unref();
  const surArret = (): void => {
    if (!fini) terminer(1012);
  };
  ctx.arret?.addEventListener("abort", surArret, { once: true });

  await new Promise<void>((fin) => {
    socket.on("close", (code: number) => {
      fini = true;
      clearInterval(tic);
      ctx.arret?.removeEventListener("abort", surArret);
      term.detacher(consommateur);
      if (code === 4001) relaisExpire(term, ctx);
      fin();
    });
    tampon.liberer();
    envoyer(jsonCompact({ type: "hello", fresh_shell: term.streamEpoch === 0 }), false);
    if (term.attacher(consommateur) < 0) return;
    for (const m of tampon.messages.splice(0)) recevoir(m.donnees, m.binaire);
    socket.on("message", recevoir);
    if (socket.isPaused) socket.resume();
    if (ctx.arret?.aborted) surArret();
  });
}

/** Session expirée signalée par le relais (4001) : main a revalidé et refusé, tous les PTY du compte sont tués. */
function relaisExpire(term: Terminal, ctx: ContexteWs): void {
  ctx.journal.info(`[PTY-WS] session expirée signalée par le relais uid=${term.uid}`);
  ctx.terminaux.tuerDuCompte(term.uid);
}
