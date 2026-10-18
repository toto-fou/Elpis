// SPDX-License-Identifier: MIT
/** packages/verrous/src/battement.ts — battement des prises longues : un fil dédié rafraîchit le mtime toutes les P/3, même quand la boucle principale est occupée. */
import { Worker } from "node:worker_threads";

import { journalDe } from "./ports";

/** Code du fil (CommonJS, évalué) : n'écrit le mtime que d'un fichier ouvert sans suivre de lien et portant nos octets. */
const CODE_FIL = `
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const DRAPEAUX = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const FIN = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);
const entrees = new Map();
function arreter(id) {
  const e = entrees.get(id);
  if (e === undefined) return;
  clearInterval(e.minuteur);
  entrees.delete(id);
}
function signaler(e, id, err) {
  if (e.signale) return;
  e.signale = true;
  parentPort.postMessage({ id, erreur: (err && err.code) || String(err) });
}
function battre(id) {
  const e = entrees.get(id);
  if (e === undefined) return;
  let fd;
  try {
    fd = fs.openSync(e.chemin, DRAPEAUX);
  } catch (err) {
    if (FIN.has(err && err.code)) arreter(id);
    else signaler(e, id, err);
    return;
  }
  try {
    const tampon = Buffer.alloc(4096);
    const n = fs.readSync(fd, tampon, 0, 4096, 0);
    if (!tampon.subarray(0, n).equals(e.octets)) {
      arreter(id);
      return;
    }
    const t = Date.now() / 1000;
    fs.futimesSync(fd, t, t);
  } catch (err) {
    signaler(e, id, err);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}
parentPort.on("message", (m) => {
  if (m.type === "arreter") return arreter(m.id);
  arreter(m.id);
  const e = { chemin: m.chemin, octets: Buffer.from(m.octets), signale: false, minuteur: null };
  e.minuteur = setInterval(battre, m.periodeMs, m.id);
  entrees.set(m.id, e);
});
`;

interface Battement {
  chemin: string;
  periodeMs: number;
  octets: Uint8Array;
}

const actifs = new Map<number, Battement>();
let fil: Worker | null = null;
let dernierId = 0;

function poster(w: Worker, id: number, b: Battement): void {
  w.postMessage({ type: "battre", id, chemin: b.chemin, periodeMs: b.periodeMs, octets: b.octets });
}

/** Fil créé à la demande, détaché du cycle de vie du processus (`unref` APRÈS les écouteurs, qui le re-référencent) ; recréé s'il s'arrête. */
function filActif(): Worker {
  if (fil !== null) return fil;
  const w = new Worker(CODE_FIL, { eval: true, name: "elpis-verrous-battement" });
  w.on("message", (m: { id: number; erreur: string }) => {
    const chemin = actifs.get(m.id)?.chemin ?? "?";
    journalDe("verrou").warn(
      `${chemin} : battement en échec (${m.erreur}), nouvel essai à la prochaine période`,
    );
  });
  const perdu = (raison: string): void => {
    if (fil !== w) return;
    fil = null;
    if (actifs.size === 0) return;
    journalDe("verrou").error(`fil de battement arrêté (${raison}) : relancé pour ${actifs.size} verrou(s)`);
    try {
      const neuf = filActif();
      for (const [id, b] of actifs) poster(neuf, id, b);
    } catch (e) {
      journalDe("verrou").error(
        `fil de battement non relancé : ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  w.on("error", (e) => perdu(e.message));
  w.on("exit", (code) => perdu(`code ${code}`));
  w.unref();
  fil = w;
  return w;
}

/** Rafraîchit le mtime de `chemin` tant qu'il porte `octets` ; rend la fonction d'arrêt (idempotente). */
export function demarrerBattement(chemin: string, periodeMs: number, octets: Uint8Array): () => void {
  const id = ++dernierId;
  const b: Battement = { chemin, periodeMs, octets: Uint8Array.from(octets) };
  actifs.set(id, b);
  try {
    poster(filActif(), id, b);
  } catch (e) {
    actifs.delete(id);
    throw e;
  }
  return () => {
    if (!actifs.delete(id)) return;
    fil?.postMessage({ type: "arreter", id });
  };
}
