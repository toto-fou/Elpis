// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/reprise-taches.ts — store disque du travail partiel d'un sous-agent (reprise par `task_id`) : dossier 0700 du compte système du core, JSON 0600 atomique par compte, TTL et cap sur la mtime. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { estDict, pyJsonDumps, pyJsonLoads, stripPy } from "@elpis/commun";

import { journal } from "../../journal";
import type { Dict } from "../../python";

const log = journal("outils.reprise-taches");

export const MAX_BYTES = 8 * 1024 * 1024;

/** `runtime_path("task_resume", "ELPIS_TASK_RESUME_DIR", "/tmp/elpis_task_resume")`, relu à chaque appel. */
export function storeDir(): string {
  const dedie = stripPy(process.env["ELPIS_TASK_RESUME_DIR"] ?? "");
  if (dedie) return dedie;
  const racine = stripPy(process.env["ELPIS_RUNTIME_DIR"] ?? "");
  return racine ? path.join(racine, "task_resume") : "/tmp/elpis_task_resume";
}

/** Fichier d'un enregistrement : compte haché, `child_id` assaini (il peut venir du modèle). */
export function cheminEnregistrement(username: string, childId: string): string {
  const h = createHash("sha256").update(String(username), "utf8").digest("hex").slice(0, 16);
  const sur =
    Array.from(String(childId).replace(/[^A-Za-z0-9_-]/gu, "_"))
      .slice(0, 64)
      .join("") || "_";
  return path.join(storeDir(), `${h}-${sur}.json`);
}

function supprimer(chemin: string): void {
  try {
    unlinkSync(chemin);
  } catch {
    return;
  }
}

/** Dossier réel du compte système du core, sans droit d'écriture pour le groupe ni les autres (le défaut est sous `/tmp`, partagé : un dossier voisin laisserait remplacer un enregistrement) ; `creer` le crée en 0700 et resserre ses droits. */
function dossierSur(creer: boolean): boolean {
  const dossier = storeDir();
  try {
    if (creer) mkdirSync(dossier, { recursive: true, mode: 0o700 });
    let st = lstatSync(dossier);
    if (!st.isDirectory()) throw new Error("pas un dossier");
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      throw new Error("dossier d'un autre compte système");
    if (creer && (st.mode & 0o077) !== 0) {
      chmodSync(dossier, 0o700);
      st = lstatSync(dossier);
    }
    if ((st.mode & 0o022) !== 0) throw new Error("dossier ouvert en écriture");
  } catch (e) {
    if (creer) log.warn(`[task_resume] ${dossier} inutilisable (${String(e)}) — reprise locale seule`);
    return false;
  }
  return true;
}

/** Persiste un enregistrement de reprise ; `true` s'il est écrit (mtime calée sur `ts`). */
export function put(username: string, childId: string, record: Dict): boolean {
  if (!dossierSur(true)) return false;
  let blob: Buffer;
  try {
    blob = Buffer.from(pyJsonDumps(record, { ensureAscii: false }), "utf8");
  } catch (e) {
    log.warn(`[task_resume] enregistrement non sérialisable (${String(e)})`);
    return false;
  }
  if (blob.length > MAX_BYTES) {
    log.info(
      `[task_resume] ${username}/${childId} : ${blob.length} octets > plafond — reprise limitée à la mémoire`,
    );
    return false;
  }
  const p = cheminEnregistrement(username, childId);
  const tmp = p.replace(/\.json$/u, ".tmp");
  try {
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, blob);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
    const ts = record["ts"];
    if (typeof ts === "number" && ts > 0)
      try {
        utimesSync(p, ts, ts);
      } catch {
        // mtime non calée : la relecture compare quand même les ts
      }
    return true;
  } catch (e) {
    log.warn(`[task_resume] écriture ${p} échouée (${String(e)})`);
    supprimer(tmp);
    return false;
  }
}

/** Relit un enregistrement non périmé ; un fichier expiré ou illisible est retiré. */
export function get(username: string, childId: string, ttlS: number): Dict | null {
  if (!dossierSur(false)) return null;
  const p = cheminEnregistrement(username, childId);
  let octets: Buffer;
  try {
    octets = readFileSync(p);
  } catch {
    return null;
  }
  let rec: unknown;
  try {
    rec = pyJsonLoads(new TextDecoder("utf-8", { fatal: true }).decode(octets), { mode: "natif" });
  } catch {
    supprimer(p);
    return null;
  }
  if (!estDict(rec)) return null;
  if (Date.now() / 1000 - Number(rec["ts"] || 0) > ttlS) {
    supprimer(p);
    return null;
  }
  return rec;
}

/** Horodatage de l'enregistrement sur disque sans le relire (la mtime) ; `null` s'il est absent. */
export function peekTs(username: string, childId: string): number | null {
  if (!dossierSur(false)) return null;
  try {
    return Number(statSync(cheminEnregistrement(username, childId), { bigint: true }).mtimeNs) / 1e9;
  } catch {
    return null;
  }
}

/** TTL puis cap d'entrées (les plus anciennes par mtime d'abord) ; best-effort. */
export function prune(ttlS: number, maxEntries: number, maintenant = Date.now() / 1000): void {
  let noms: string[];
  try {
    noms = readdirSync(storeDir());
  } catch {
    return;
  }
  if (!dossierSur(false)) return;
  const survivants: [number, string][] = [];
  for (const n of noms) {
    if (!n.endsWith(".json") && !n.endsWith(".tmp")) continue;
    const p = path.join(storeDir(), n);
    let mtime: number;
    try {
      mtime = statSync(p).mtimeMs / 1000;
    } catch {
      continue;
    }
    if (maintenant - mtime > ttlS) {
      supprimer(p);
      continue;
    }
    if (n.endsWith(".json")) survivants.push([mtime, p]);
  }
  if (maxEntries > 0 && survivants.length > maxEntries) {
    survivants.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    for (const [, p] of survivants.slice(0, survivants.length - maxEntries)) supprimer(p);
  }
}
