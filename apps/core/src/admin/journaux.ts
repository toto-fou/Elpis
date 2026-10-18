// SPDX-License-Identifier: MIT
/** apps/core/src/admin/journaux.ts — fin du journal JSONL commun, filtrée (access_logging.read_recent_events). */
import { readFile } from "node:fs/promises";

import { ErreurPython, FlottantPy, getPy, lowerPy, nomTypePy, pyJsonLoads } from "@elpis/commun";

export interface FiltresJournal {
  readonly limit: number;
  readonly services: readonly string[] | null;
  readonly levels: readonly string[] | null;
  readonly categories: readonly string[] | null;
  readonly sinceTs: number | null;
}

const DECODEUR = new TextDecoder("utf-8", { ignoreBOM: true });

/** `bytes.splitlines()` : coupe sur `\n`, `\r\n` et `\r`. */
function lignes(octets: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let debut = 0;
  for (let i = 0; i < octets.length; i++) {
    const c = octets[i];
    if (c !== 0x0a && c !== 0x0d) continue;
    out.push(octets.subarray(debut, i));
    if (c === 0x0d && octets[i + 1] === 0x0a) i++;
    debut = i + 1;
  }
  if (debut < octets.length) out.push(octets.subarray(debut));
  return out;
}

/** `rec.get(cle, "").lower()` : AttributeError hors dict ou hors texte, comme en Python. */
function champ(rec: unknown, cle: string): string {
  const v = getPy(rec, cle, "");
  if (typeof v !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(v)}' object has no attribute 'lower'`);
  return v;
}

/** `rec.get("ts", 0) < since_ts` : TypeError si l'horodatage n'est pas un nombre. */
function avant(rec: unknown, depuis: number): boolean {
  const ts = getPy(rec, "ts", 0);
  if (typeof ts === "number" || typeof ts === "boolean") return Number(ts) < depuis;
  if (ts instanceof FlottantPy) return ts.valeur < depuis;
  if (typeof ts === "bigint") return Number(ts) < depuis;
  throw new ErreurPython(
    "TypeError",
    `'<' not supported between instances of '${nomTypePy(ts)}' and 'float'`,
  );
}

/** `read_recent_events` : journal courant puis `.1`, du plus récent au plus ancien, rendu dans l'ordre chronologique. */
export async function lireEvenementsRecents(chemin: string, f: FiltresJournal): Promise<unknown[]> {
  const services = f.services?.length ? new Set(f.services.map((s) => lowerPy(s))) : null;
  const niveaux = f.levels?.length ? new Set(f.levels.map((l) => l.toUpperCase())) : null;
  const categories = f.categories?.length ? new Set(f.categories.map((c) => lowerPy(c))) : null;
  const out: unknown[] = [];
  for (const fichier of [chemin, `${chemin}.1`]) {
    let octets: Buffer;
    try {
      octets = await readFile(fichier);
    } catch {
      continue;
    }
    for (const ligne of lignes(octets).reverse()) {
      if (!ligne.length) continue;
      let rec: unknown;
      try {
        rec = pyJsonLoads(DECODEUR.decode(ligne));
      } catch {
        continue;
      }
      if (services && !services.has(lowerPy(champ(rec, "service")))) continue;
      if (niveaux && !niveaux.has(champ(rec, "level").toUpperCase())) continue;
      if (categories && !categories.has(lowerPy(champ(rec, "category")))) continue;
      if (f.sinceTs !== null && avant(rec, f.sinceTs)) continue;
      out.push(rec);
      if (out.length >= f.limit) break;
    }
    if (out.length >= f.limit) break;
  }
  return out.reverse();
}
