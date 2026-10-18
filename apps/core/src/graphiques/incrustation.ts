// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/incrustation.ts — configs de graphiques recopiées dans la conversation sauvée (embed_chart_configs, shared_infra/charts/routes.py). */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getUsernameById } from "@elpis/auth";
import {
  BLANC_PY,
  clesOrdonnees,
  estAlnumPy,
  estDict,
  getOu,
  lowerPy,
  poserCle,
  pyJsonLoads,
  strPy,
  texteUtf8,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { pyPath } from "@elpis/config";
import type { Base } from "@elpis/db";

import { getChat } from "../chats/stockage";
import { journal } from "../journal";

const log = journal("charts");

/** `_CHART_REF_RE` : bloc chart-ref (6 à 32 hex) ou poignée `!<12 hex>`, avec le `\s` et le `\b` de Python. */
const REF_GRAPHIQUE = new RegExp(
  "```chart-ref" +
    `${BLANC_PY}*[\\r\\n]+${BLANC_PY}*([0-9a-fA-F]{6,32})${BLANC_PY}*[\\r\\n]*` +
    "```" +
    "|!([0-9a-fA-F]{12})",
  "gu",
);

/** `_scan_chart_ref_ids` : identifiants référencés par un texte, en minuscules. */
export function refsGraphiques(texte: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof texte !== "string" || !texte) return out;
  for (const m of texte.matchAll(REF_GRAPHIQUE)) {
    if (m[2] !== undefined) {
      const suivant = String.fromCodePoint(texte.codePointAt(m.index + m[0].length) ?? 0x20);
      if (suivant === "_" || estAlnumPy(suivant)) continue;
    }
    const cid = m[1] || m[2];
    if (cid) out.add(cid.toLowerCase());
  }
  return out;
}

/** `_harvest_embedded` : configs déjà incrustées dans une liste de messages. */
function configsIncrustees(messages: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    const charts = estDict(m) ? getOu(m, "charts", null) : null;
    if (!estDict(charts)) continue;
    for (const cid of clesOrdonnees(charts)) {
      const cfg = charts[cid];
      if (cfg !== null && cfg !== undefined) out.set(lowerPy(strPy(cid)), cfg);
    }
  }
  return out;
}

function filtrer(texte: string, garder: (c: string) => boolean): string {
  return Array.from(texte).filter(garder).join("");
}

/** `_safe_username` : lettres, chiffres, `-` et `_`, sinon « guest ». */
export function nomSur(nom: string): string {
  return filtrer(nom || "", (c) => estAlnumPy(c) || c === "-" || c === "_") || "guest";
}

/** `_safe_chart_id` : lettres et chiffres seulement, aucun moyen de sortir du dossier (le cache n'est lu que pour un identifiant hexadécimal). */
export function idGraphiqueSur(id: string): string {
  return filtrer(id || "", estAlnumPy);
}

/** Base du cache : `CHART_CACHE_DIR`, sinon `<tmp>/elpis_charts` (cache écrit par la famille chart, servie par main). */
export function baseGraphiques(): string {
  return process.env["CHART_CACHE_DIR"] || `${dossierTemporairePy()}/elpis_charts`;
}

/** `tempfile.gettempdir()` : TMPDIR, TEMP puis TMP, absolu et normalisé (`abspath`). */
function dossierTemporairePy(): string {
  return path.resolve(process.env["TMPDIR"] || process.env["TEMP"] || process.env["TMP"] || tmpdir());
}

const ABSENTS = new Set(["ENOENT", "ENOTDIR"]);
const HEXA = /^[0-9A-Fa-f]+$/u;
const O_DOSSIER = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const O_FICHIER = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function codeErreur(e: unknown): string {
  return String((e as { code?: unknown } | null)?.code ?? "");
}

/** Propriétaire attendu du cache : l'uid effectif du process (compte de service du core). */
function uidAttendu(): number {
  return process.geteuid?.() ?? -1;
}

/** Vrai dossier de l'uid du process, non modifiable par le groupe ni les autres (shared_infra/charts/cache.py). */
function dossierValide(st: Stats): boolean {
  return st.isDirectory() && st.uid === uidAttendu() && (st.mode & 0o022) === 0;
}

/** Fichier ordinaire de l'uid du process, à lien unique. */
function fichierValide(st: Stats): boolean {
  return st.isFile() && st.uid === uidAttendu() && st.nlink === 1;
}

/** Chemin d'une entrée du dossier ouvert `fd`, résolu par le noyau à partir du descripteur. */
function sous(fd: number, nom: string): string {
  return `/proc/self/fd/${fd}/${nom}`;
}

function ecarte(fichier: string, raison: string): null {
  log.warn(`[charts] cache écarté ${path.basename(fichier)} : ${raison}`);
  return null;
}

class Ecarte extends Error {}

function estLien(chemin: string): boolean {
  try {
    return lstatSync(chemin).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Dossier ouvert sans suivre de lien puis validé sur son descripteur ; `null` s'il n'existe pas, `Ecarte` s'il est refusé. */
function ouvrirDossier(chemin: string): number | null {
  let fd: number;
  try {
    fd = openSync(chemin, O_DOSSIER);
  } catch (e) {
    if (!ABSENTS.has(codeErreur(e)) && codeErreur(e) !== "ELOOP") throw e;
    if (estLien(chemin)) throw new Ecarte("dossier lien symbolique");
    return null;
  }
  let valide = false;
  try {
    valide = dossierValide(fstatSync(fd));
  } finally {
    if (!valide) closeSync(fd);
  }
  if (valide) return fd;
  throw new Ecarte("dossier d'un autre propriétaire ou modifiable par le groupe ou les autres");
}

let procPresent: boolean | null = null;

/** `/proc/self/fd` disponible (parcours par descripteurs) ; son absence est journalisée une fois. */
function parcoursPossible(): boolean {
  if (procPresent === null) {
    procPresent = existsSync("/proc/self/fd");
    if (!procPresent)
      log.warn("[charts] /proc/self/fd absent : cache des graphiques jamais lu (copie durable seule)");
  }
  return procPresent;
}

/** Fichier du cache du compte, lu par descripteurs (base, dossier du compte, fichier) sans suivre de lien, seulement s'il appartient à l'uid du process ; `null` si absent ou écarté. */
export function lireCacheGraphique(nom: string, id: string): Buffer | null {
  const cid = idGraphiqueSur(id);
  const fichier = `${cid}.json`;
  if (!HEXA.test(cid) || !parcoursPossible()) return null;
  const ouverts: number[] = [];
  try {
    const base = ouvrirDossier(pyPath(baseGraphiques()));
    if (base === null) return null;
    ouverts.push(base);
    const dossier = ouvrirDossier(sous(base, nomSur(nom)));
    if (dossier === null) return null;
    ouverts.push(dossier);
    let vu: Stats;
    try {
      vu = lstatSync(sous(dossier, fichier));
    } catch (e) {
      if (ABSENTS.has(codeErreur(e))) return null;
      throw e;
    }
    if (vu.isSymbolicLink()) return ecarte(fichier, "lien symbolique");
    if (!vu.isFile()) return null;
    if (!fichierValide(vu))
      return ecarte(
        fichier,
        vu.uid !== uidAttendu()
          ? "propriétaire autre que le compte de service"
          : "plusieurs liens vers le fichier",
      );
    let fd: number;
    try {
      fd = openSync(sous(dossier, fichier), O_FICHIER);
    } catch (e) {
      if (ABSENTS.has(codeErreur(e))) return null;
      if (codeErreur(e) === "ELOOP") return ecarte(fichier, "lien symbolique");
      throw e;
    }
    ouverts.push(fd);
    const st = fstatSync(fd);
    if (!fichierValide(st) || st.dev !== vu.dev || st.ino !== vu.ino)
      return ecarte(fichier, "fichier remplacé pendant la lecture");
    return readFileSync(fd);
  } catch (e) {
    if (e instanceof Ecarte) return ecarte(fichier, e.message);
    throw e;
  } finally {
    for (const fd of ouverts.reverse()) closeSync(fd);
  }
}

/** `embed_chart_configs` : chaque config référencée est recopiée dans son message (`charts`) ; monotone et sans échec. */
export async function embedChartConfigs(
  base: Base,
  uid: number,
  chatId: string,
  messages: unknown,
  precedent?: Dict | null,
): Promise<unknown> {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const parMessage = messages.map((m) =>
    estDict(m) ? refsGraphiques(getOu(m, "content", "")) : new Set<string>(),
  );
  const tous = new Set(parMessage.flatMap((ids) => [...ids]));
  if (tous.size === 0) return messages;
  let resolues: Map<string, unknown>;
  try {
    const chat = precedent === undefined ? await getChat(base, uid, chatId) : precedent;
    resolues = chat ? configsIncrustees(chat["messages"]) : new Map();
  } catch {
    resolues = new Map();
  }
  const manquants = [...tous].filter((cid) => !resolues.has(cid));
  if (manquants.length > 0) {
    let nom: string;
    try {
      nom = (await getUsernameById(base, uid)) || "guest";
    } catch {
      nom = "guest";
    }
    for (const cid of manquants) {
      try {
        const octets = lireCacheGraphique(nom, cid);
        if (octets === null) continue;
        const texte = texteUtf8(octets);
        if (texte === undefined) throw new Error("'utf-8' codec can't decode bytes");
        resolues.set(cid, pyJsonLoads(texte));
      } catch (e) {
        log.warn(
          `[charts] cache illisible ${idGraphiqueSur(cid)}.json : ${e instanceof Error ? e.message : strPy(e)}`,
        );
      }
    }
  }
  messages.forEach((m, i) => {
    const ids = parMessage[i];
    if (!ids || ids.size === 0 || !estDict(m)) return;
    const incrustees: Dict = {};
    for (const cid of ids) if (resolues.has(cid)) poserCle(incrustees, cid, resolues.get(cid));
    if (clesOrdonnees(incrustees).length === 0) return;
    const existant = getOu(m, "charts", null);
    if (!estDict(existant)) {
      poserCle(m, "charts", incrustees);
      return;
    }
    const fusion: Dict = {};
    for (const k of clesOrdonnees(existant)) poserCle(fusion, k, existant[k]);
    for (const k of clesOrdonnees(incrustees)) poserCle(fusion, k, incrustees[k]);
    poserCle(m, "charts", fusion);
  });
  return messages;
}
