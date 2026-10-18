// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/journal.ts — journal JSONL borné des écritures mémoire (avant/après, annulation, origine des notes), port de llm_core/memory/_journal.py. */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";

import { ErreurPython, FlottantPy, pyJsonDumps, pyJsonLoads, strPy, stripPy, veritePy } from "@elpis/commun";
import { avecVerrou } from "@elpis/verrous";

import { estDict, iterPy, lire, lowerPy, splitlinesPy } from "../python";
import type { Dict } from "../python";
import { exigerUtf8, lireTextePy } from "./magasin";
import { cheminPy } from "./portee";

export const JOURNAL_NAME = ".journal.jsonl";
export const MAX_RECORDS = 200;
/** Rognage amorti : le fichier n'est réécrit qu'au-delà de cette taille. */
const TRIM_AT = MAX_RECORDS + 50;

const sources = {
  horloge: (): number => Date.now() / 1000,
  jeton: (): string => randomBytes(4).toString("hex"),
};

/** Aide de test : horloge et jetons d'op déterministes ; rend la fonction qui remet les vrais. */
export function reglerJournalPourTests(remplacement: Partial<typeof sources>): () => void {
  const avant = { ...sources };
  Object.assign(sources, remplacement);
  return () => {
    Object.assign(sources, avant);
  };
}

export function journalPath(memDir: string): string {
  return cheminPy(memDir, JOURNAL_NAME);
}

async function lireLignes(chemin: string): Promise<string[]> {
  try {
    return splitlinesPy(await lireTextePy(chemin)).filter((l) => stripPy(l) !== "");
  } catch {
    return [];
  }
}

/** Toutes les lignes lisibles (dict à `op` vrai), de la plus ancienne à la plus récente. */
export async function records(memDir: string): Promise<Dict[]> {
  const out: Dict[] = [];
  for (const ligne of await lireLignes(journalPath(memDir))) {
    let rec: unknown;
    try {
      rec = pyJsonLoads(ligne);
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
    if (estDict(rec) && veritePy(lire(rec, "op"))) out.push(rec);
  }
  return out;
}

export async function get(memDir: string, op: unknown): Promise<Dict | null> {
  const cle = lowerPy(stripPy(veritePy(op) ? strPy(op) : ""));
  if (!cle) return null;
  return (await records(memDir)).findLast((r) => lire(r, "op") === cle) ?? null;
}

/** La ligne d'annulation de `op`, s'il y en a une. */
export async function undoneBy(memDir: string, op: unknown): Promise<Dict | null> {
  return (await records(memDir)).findLast((r) => egalPy(lire(r, "undo_of"), op)) ?? null;
}

export interface Ecriture {
  action: string;
  store: string;
  before: Iterable<unknown>;
  after: Iterable<unknown>;
  source?: string;
  chat_id?: string | null;
  title?: string | null;
  undo_of?: string | null;
}

/** Ajoute une écriture et rend son `op` ; `null` si rien n'a changé (un ajout idempotent n'est pas une écriture). */
export async function append(memDir: string, e: Ecriture): Promise<string | null> {
  const avant = [...e.before].map((x) => strPy(x));
  const apres = [...e.after].map((x) => strPy(x));
  if (avant.length === apres.length && avant.every((x, i) => x === apres[i])) return null;
  const op = sources.jeton();
  const rec: Dict = {
    op,
    ts: new FlottantPy(sources.horloge()),
    source: e.source ?? "tool",
    action: e.action,
    store: e.store,
    chat_id: e.chat_id || null,
    title: e.title || null,
    before: avant,
    after: apres,
  };
  if (e.undo_of) rec["undo_of"] = e.undo_of;
  const ligne = pyJsonDumps(rec, { ensureAscii: false }) + "\n";
  exigerUtf8(ligne);
  const chemin = journalPath(memDir);
  await avecVerrou(`${chemin}.lock`, {}, async () => {
    await mkdir(memDir, { recursive: true });
    await appendFile(chemin, ligne, "utf8");
    const lignes = await lireLignes(chemin);
    if (lignes.length > TRIM_AT) {
      await writeFile(`${chemin}.tmp`, lignes.slice(-MAX_RECORDS).join("\n") + "\n", "utf8");
      await rename(`${chemin}.tmp`, chemin);
    }
  });
  return op;
}

/** `x == y` de Python sur des valeurs JSON (flottants et entiers égaux par valeur, booléens comme 0 et 1). */
function egalPy(a: unknown, b: unknown): boolean {
  const nombre = (x: unknown): number | bigint | null =>
    x instanceof FlottantPy
      ? x.valeur
      : typeof x === "number" || typeof x === "bigint"
        ? x
        : typeof x === "boolean"
          ? Number(x)
          : null;
  const [na, nb] = [nombre(a), nombre(b)];
  if (na !== null && nb !== null) {
    if (typeof na === "number" && typeof nb === "number") return na === nb;
    try {
      return BigInt(na) === BigInt(nb);
    } catch {
      return false;
    }
  }
  if (na !== null || nb !== null) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => egalPy(x, b[i]));
  if (estDict(a) && estDict(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && egalPy(a[k], b[k]));
  }
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

/** `list(x)` de Python sur une valeur JSON : liste copiée, texte en caractères, dict en clés ; TypeError sinon. */
function listePy(x: unknown): unknown[] {
  const elements = iterPy(x);
  if (elements === null) throw new ErreurPython("TypeError", "object is not iterable");
  return [...elements];
}

function ou(x: unknown): unknown {
  return veritePy(x) ? x : [];
}

/** Entrées ajoutées et retirées (différence de multisets, ordre gardé) : un `replace` = 1 retirée + 1 ajoutée. */
export function diff(rec: Dict): { added: unknown[]; removed: unknown[] } {
  const avant = listePy(ou(lire(rec, "before")));
  const apres = listePy(ou(lire(rec, "after")));
  const moins = (de: unknown[], retirer: unknown[]): unknown[] => {
    const reste = [...retirer];
    const out: unknown[] = [];
    for (const x of de) {
      const i = reste.findIndex((y) => egalPy(x, y));
      if (i >= 0) reste.splice(i, 1);
      else out.push(x);
    }
    return out;
  };
  return { added: moins(apres, avant), removed: moins(avant, apres) };
}

/** `x in conteneur` : élément d'une liste, sous-chaîne d'un texte, clé d'un dict ; TypeError comme Python sur un nombre. */
function contient(conteneur: unknown, x: string): boolean {
  if (Array.isArray(conteneur)) return conteneur.some((y) => egalPy(y, x));
  if (typeof conteneur === "string") return conteneur.includes(x);
  if (estDict(conteneur)) return Object.hasOwn(conteneur, x);
  const type =
    typeof conteneur === "boolean"
      ? "bool"
      : conteneur instanceof FlottantPy || (typeof conteneur === "number" && !Number.isInteger(conteneur))
        ? "float"
        : typeof conteneur === "number" || typeof conteneur === "bigint"
          ? "int"
          : "object";
  throw new ErreurPython("TypeError", `argument of type '${type}' is not iterable`);
}

/** Pour chaque entrée actuelle : l'écriture qui l'a fait apparaître (`ts`, `source`, `chat_id`, `op`), `null` si antérieure. */
export async function origins(
  memDir: string,
  store: string,
  entries: readonly string[],
): Promise<(Dict | null)[]> {
  const recs = (await records(memDir)).filter((r) => egalPy(lire(r, "store"), store));
  return entries.map((texte) => {
    let trouve: Dict | null = null;
    for (const rec of recs.toReversed()) {
      if (!contient(ou(lire(rec, "after")), texte) || contient(ou(lire(rec, "before")), texte)) continue;
      const candidat: Dict = {
        ts: lire(rec, "ts") ?? null,
        source: lire(rec, "source") ?? null,
        chat_id: lire(rec, "chat_id") ?? null,
        op: lire(rec, "op") ?? null,
      };
      if (!egalPy(lire(rec, "source"), "undo")) return candidat;
      trouve ??= candidat;
    }
    return trouve;
  });
}

/** Supprime le journal sous son verrou (effacement complet de la mémoire) ; faux s'il n'y avait rien. */
export async function purge(memDir: string): Promise<boolean> {
  try {
    if (!(await stat(memDir)).isDirectory()) return false;
  } catch {
    return false;
  }
  const chemin = journalPath(memDir);
  return avecVerrou(`${chemin}.lock`, {}, async () => {
    try {
      await unlink(chemin);
      return true;
    } catch (e) {
      if ((e as { code?: unknown }).code === "ENOENT") return false;
      throw e;
    }
  });
}
