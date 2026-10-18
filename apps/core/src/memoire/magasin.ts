// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/magasin.ts — magasin Markdown auto-curé (entrées « § », limite de caractères, ids courts, cibles guidées), port de llm_core/memory/_markdown_store.py. */
import { createHash, randomInt } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  arrondiPy,
  blocsCorrespondants,
  casefoldPy,
  ErreurPython,
  fixePy,
  FlottantPy,
  formatValeursPy,
  nfcPy,
  reprFlottant,
  stripPy,
  strPy,
} from "@elpis/commun";
import { realpathPy } from "@elpis/config";
import { DelaiDepasse, Verrou } from "@elpis/mcp";
import { VerrouFichier, VerrouOccupe } from "@elpis/verrous";

import { CTX } from "../contexte/config-contexte";
import { journal } from "../journal";
import { BLANC_PY, longueurPy, lstripPy, rstripPy } from "../python";

export const DELIM = "§";
export const DEFAULT_LOCK_TIMEOUT_S = 5.0;
/** `(?m)^[ \t]*§[ \t]*$` : début et fin de ligne au sens de `\n` seul, comme `re` (le drapeau `m` de JS coupe aussi sur `\r`, U+2028…). */
const SEPARATEUR = /(?<![^\n])[ \t]*§[ \t]*(?![^\n])/u;
const SEPARATEUR_REECRITURE = /(?<![^\n])[ \t]*(?:-{3,}|§)[ \t]*(?![^\n])/u;
const LIGNE_DELIM = /(?<![^\n])([ \t]*)§([ \t]*)(?![^\n])/gu;
const ID_CROCHETS = new RegExp(`^${BLANC_PY}*\\[([0-9a-fA-F]{4,40})\\]${BLANC_PY}*([\\s\\S]*)$`, "u");
const ID_NU = /^[0-9a-fA-F]{4,12}$/u;
const BLANCS = new RegExp(`${BLANC_PY}+`, "gu");
const ELLIPSES = ["…", "..."] as const;
const DECODEUR = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ALPHABET_TEMPORAIRE = "abcdefghijklmnopqrstuvwxyz0123456789_";
const log = (): ReturnType<typeof journal> => journal("memory");

/** Verrou du magasin non acquis dans le délai (contention ou blocage). */
export class StoreBusyError extends Error {
  override name = "StoreBusyError";
}

/** Fichier présent mais illisible (E/S, UTF-8 invalide) : levé sur le seul chemin de mutation, jamais confondu avec « vide ». */
export class StoreReadError extends Error {
  override name = "StoreReadError";
}

/** Résultat d'une opération de curation ; champs au nom Python (sérialisés par les routes et le journal). */
export interface StoreOpResult {
  ok: boolean;
  action: string;
  error: string | null;
  error_code: string | null;
  chars: number;
  limit: number;
  /** `float` de Python : `strPy` et `pyJsonDumps` le rendent `3.0`. */
  usage_pct: FlottantPy;
  n_entries: number;
  entries: string[];
  entry_ids: string[];
  closest_index: number | null;
  candidate_indexes: number[];
  before: string[];
  unchanged: boolean;
}

/** Issue de la résolution d'une cible : index, ou candidats (ambiguë), ou plus proche. */
export interface ResolutionCible {
  index: number | null;
  matched_by: string;
  candidates: number[];
  closest_index: number | null;
  closest_score: number;
}

/** UTF-8 strict à l'écriture : une demi-paire isolée lève comme `UnicodeEncodeError` de Python. */
export function exigerUtf8(texte: string): void {
  if (texte.isWellFormed()) return;
  let position = 0;
  for (const c of texte) {
    const code = c.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff)
      throw new ErreurPython(
        "ValueError",
        `'utf-8' codec can't encode character '\\u${code.toString(16)}' in position ${position}: surrogates not allowed`,
      );
    position++;
  }
}

export function serialize(entries: readonly string[]): string {
  return entries
    .map(stripPy)
    .filter((e) => e !== "")
    .join(`\n${DELIM}\n`);
}

/** Découpe un document en entrées non vides. */
export function parseEntries(raw: string): string[] {
  if (!raw || !stripPy(raw)) return [];
  return raw
    .split(SEPARATEUR)
    .map(stripPy)
    .filter((p) => p !== "");
}

/** Morceaux d'un `rewrite` : lignes `---` (3 tirets ou plus) ou `§`. */
export function decouperReecriture(content: string): string[] {
  return (content || "")
    .split(SEPARATEUR_REECRITURE)
    .map(stripPy)
    .filter((p) => p !== "");
}

/** Forme de comparaison d'une cible : NFC, casefold, blancs repliés, ellipses de bord retirées. */
export function normalizeForMatch(s: string | null | undefined): string {
  let t = stripPy(casefoldPy(nfcPy(s || "")).replace(BLANCS, " "));
  let change = true;
  while (change && t) {
    change = false;
    for (const e of ELLIPSES) {
      if (t.startsWith(e)) {
        t = lstripPy(t.slice(e.length));
        change = true;
      }
      if (t.endsWith(e)) {
        t = rstripPy(t.slice(0, t.length - e.length));
        change = true;
      }
    }
  }
  return t;
}

/** Id court stable : sha1 du contenu strippé en NFC. */
export function computeEntryId(text: string | null | undefined, length = 4): string {
  const norme = nfcPy(stripPy(text || ""));
  exigerUtf8(norme);
  return createHash("sha1")
    .update(norme, "utf8")
    .digest("hex")
    .slice(0, Math.max(1, Math.trunc(length)));
}

/** Ids de longueur 4 ; seuls ceux en collision sont allongés (5 … 12) jusqu'à unicité. */
export function entryIds(entries: readonly string[]): string[] {
  let ids = entries.map((e) => computeEntryId(e));
  for (let longueur = 4; longueur < 12;) {
    const comptes = new Map<string, number>();
    for (const i of ids) comptes.set(i, (comptes.get(i) ?? 0) + 1);
    const doublons = new Set([...comptes].filter(([, n]) => n > 1).map(([i]) => i));
    if (doublons.size === 0) break;
    longueur++;
    ids = ids.map((id, j) => (doublons.has(id) ? computeEntryId(entries[j] ?? "", longueur) : id));
  }
  return ids;
}

/** Neutralise toute ligne `§` nue d'une entrée (`\§`) ; fins de ligne ramenées à `\n`. */
export function sanitizeEntryText(text: string | null | undefined): string {
  const t = (text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return t.replace(LIGNE_DELIM, (_m, avant: string, apres: string) => `${avant}\\${DELIM}${apres}`);
}

/** Résout une cible : id crocheté, id nu, extrait normalisé ; sinon le plus proche par recouvrement (blocs ≥ 3). */
export function resolveTarget(
  entries: readonly string[],
  target: string | null | undefined,
): ResolutionCible {
  const rien = (): ResolutionCible => ({
    index: null,
    matched_by: "",
    candidates: [],
    closest_index: null,
    closest_score: 0,
  });
  let cible = stripPy(target || "");
  if (!cible || entries.length === 0) return rien();
  const ids = entryIds(entries);
  const parId = (jeton: string): ResolutionCible | null => {
    const bas = jeton.toLowerCase();
    const touches = ids.flatMap((id, i) => (id === bas ? [i] : []));
    if (touches.length === 1) return { ...rien(), index: touches[0] ?? null, matched_by: "id" };
    return touches.length > 1 ? { ...rien(), candidates: touches } : null;
  };
  const crochets = ID_CROCHETS.exec(cible);
  if (crochets) {
    const r = parId(crochets[1] ?? "");
    if (r !== null) return r;
    const reste = stripPy(crochets[2] ?? "");
    if (!reste) return rien();
    cible = reste;
  } else if (ID_NU.test(cible)) {
    const r = parId(cible);
    if (r !== null) return r;
  }
  const aiguille = normalizeForMatch(cible);
  if (!aiguille) return rien();
  const normes = entries.map((e) => normalizeForMatch(e));
  const touches = normes.flatMap((n, i) => (n.includes(aiguille) ? [i] : []));
  if (touches.length === 1) return { ...rien(), index: touches[0] ?? null, matched_by: "substring" };
  if (touches.length > 1) return { ...rien(), candidates: touches };
  const a = Array.from(aiguille);
  let meilleur: number | null = null;
  let score = 0;
  normes.forEach((n, i) => {
    if (!n) return;
    const couvert = blocsCorrespondants(a, Array.from(n))
      .filter(([, , taille]) => taille >= 3)
      .reduce((s, [, , taille]) => s + taille, 0);
    const s = couvert / Math.max(1, a.length);
    if (s > score) [meilleur, score] = [i, s];
  });
  if (meilleur !== null && score >= 0.6)
    return { ...rien(), closest_index: meilleur, closest_score: arrondiPy(Math.min(score, 1), 2) };
  return rien();
}

const verrousInternes = new Map<string, Verrou>();

/** Verrou du chemin dans ce processus ; au-delà de 256 chemins, les verrous libres sont évincés. */
function verrouInterne(cle: string): Verrou {
  let v = verrousInternes.get(cle);
  if (v !== undefined) return v;
  if (verrousInternes.size >= 256)
    for (const [k, x] of verrousInternes) if (!x.locked && x.enAttente === 0) verrousInternes.delete(k);
  v = new Verrou();
  verrousInternes.set(cle, v);
  return v;
}

/** Transaction lire-modifier-écrire : verrou du processus puis `<chemin>.lock` (v1.1), chacun borné → `StoreBusyError`. */
export async function storeTransaction<T>(chemin: string, delaiS: number, f: () => Promise<T>): Promise<T> {
  const nom = path.basename(chemin);
  const delaiMs = Math.max(0, delaiS) * 1000;
  const interne = verrouInterne(path.isAbsolute(chemin) ? realpathPy(chemin) : chemin);
  try {
    await interne.acquerir({ delaiMs });
  } catch (e) {
    if (e instanceof DelaiDepasse)
      throw new StoreBusyError(`internal lock of ${nom} not acquired after ${fixePy(delaiS, 1)}s`);
    throw e;
  }
  try {
    const verrou = new VerrouFichier(`${chemin}.lock`, { delaiMs });
    try {
      await verrou.acquerir();
    } catch (e) {
      if (e instanceof VerrouOccupe)
        throw new StoreBusyError(`lock ${nom}.lock not acquired after ${fixePy(delaiS, 1)}s`);
      throw e;
    }
    try {
      return await f();
    } finally {
      await verrou.rendre();
    }
  } finally {
    interne.liberer();
  }
}

/** `read_text(encoding="utf-8")` : UTF-8 strict, BOM gardé, fins de ligne universelles. */
export async function lireTextePy(chemin: string): Promise<string> {
  return DECODEUR.decode(await readFile(chemin)).replace(/\r\n?/g, "\n");
}

function temporaire(dossier: string): string {
  let nom = "tmp";
  for (let i = 0; i < 8; i++) nom += ALPHABET_TEMPORAIRE.charAt(randomInt(ALPHABET_TEMPORAIRE.length));
  return path.join(dossier, `${nom}.tmp`);
}

/** En-tête du gabarit `memory.header_template` (`{label}`, `{chars}`, `{limit}`, `{pct}`) ; `null` s'il est vide ou invalide. */
function enTeteGabarit(label: string, chars: number, limit: number, pct: number): string | null {
  try {
    const gabarit = CTX.override("memory.header_template", "");
    return gabarit ? formatValeursPy(gabarit, { label, chars, limit, pct: new FlottantPy(pct) }) : null;
  } catch {
    return null;
  }
}

export interface OptionsMagasin {
  label?: string;
  lockTimeoutS?: number;
}

/** Fichier d'entrées `§` sous limite de caractères ; écritures atomiques (temporaire 0600 puis remplacement). */
export class MarkdownStore {
  readonly path: string;
  readonly charLimit: number;
  readonly label: string;
  readonly lockTimeoutS: number;

  constructor(chemin: string, charLimit: number, options: OptionsMagasin = {}) {
    this.path = chemin;
    this.charLimit = Math.trunc(charLimit);
    this.label = options.label || path.basename(chemin);
    this.lockTimeoutS = options.lockTimeoutS ?? DEFAULT_LOCK_TIMEOUT_S;
  }

  /** Lecture indulgente (affichage, rendu) : absent ou illisible → vide. */
  async entries(): Promise<string[]> {
    try {
      return parseEntries(await lireTextePy(this.path));
    } catch {
      return [];
    }
  }

  async charCount(): Promise<number> {
    return longueurPy(serialize(await this.entries()));
  }

  async usagePct(): Promise<FlottantPy> {
    return new FlottantPy(
      this.charLimit <= 0 ? 0 : arrondiPy((100 * (await this.charCount())) / this.charLimit, 1),
    );
  }

  async add(content: string | null | undefined): Promise<StoreOpResult> {
    const c = sanitizeEntryText(stripPy(content || ""));
    if (!c)
      return this.resultat(false, "add", await this.entries(), "content is empty", {
        error_code: "empty_content",
      });
    return this.transaction(async () => {
      const entrees = await this.entriesStrict();
      if (entrees instanceof StoreReadError) return this.lectureEchouee("add", entrees);
      if (entrees.includes(c))
        return this.resultat(true, "add", entrees, null, { before: entrees, unchanged: true });
      const candidat = [...entrees, c];
      const taille = longueurPy(serialize(candidat));
      if (taille > this.charLimit)
        return this.resultat(
          false,
          "add",
          entrees,
          `exceeds the limit (${taille}/${this.charLimit} chars); consolidate or remove an entry first`,
          { error_code: "over_limit" },
        );
      await this.ecrireEntrees(candidat);
      return this.resultat(true, "add", candidat, null, { before: entrees });
    });
  }

  /** Remplace l'entrée UNIQUE ciblée (id `[a1f4]` ou extrait) par `content`. */
  async replace(
    target: string | null | undefined,
    content: string | null | undefined,
  ): Promise<StoreOpResult> {
    const c = sanitizeEntryText(stripPy(content || ""));
    if (!c)
      return this.resultat(false, "replace", await this.entries(), "content is empty", {
        error_code: "empty_content",
      });
    return this.transaction(async () => {
      const entrees = await this.entriesStrict();
      if (entrees instanceof StoreReadError) return this.lectureEchouee("replace", entrees);
      const res = resolveTarget(entrees, target);
      if (res.index === null) return this.cibleIntrouvable("replace", entrees, res);
      const candidat = [...entrees];
      candidat[res.index] = c;
      const taille = longueurPy(serialize(candidat));
      if (taille > this.charLimit)
        return this.resultat(
          false,
          "replace",
          entrees,
          `exceeds the limit (${taille}/${this.charLimit} chars)`,
          {
            error_code: "over_limit",
          },
        );
      await this.ecrireEntrees(candidat);
      return this.resultat(true, "replace", candidat, null, { before: entrees });
    });
  }

  /** Supprime l'entrée UNIQUE ciblée (id `[a1f4]` ou extrait). */
  async remove(target: string | null | undefined): Promise<StoreOpResult> {
    return this.transaction(async () => {
      const entrees = await this.entriesStrict();
      if (entrees instanceof StoreReadError) return this.lectureEchouee("remove", entrees);
      const res = resolveTarget(entrees, target);
      if (res.index === null) return this.cibleIntrouvable("remove", entrees, res);
      const candidat = entrees.filter((_e, i) => i !== res.index);
      await this.ecrireEntrees(candidat);
      return this.resultat(true, "remove", candidat, null, { before: entrees });
    });
  }

  /** Réécrit tout le magasin depuis un document (entrées séparées par `---` ou `§`). */
  async rewrite(content: string | null | undefined): Promise<StoreOpResult> {
    return this.setEntries(decouperReecriture(content || ""));
  }

  /** Remplace tout le magasin par `entries` (déjà découpées) ; vide et dépassement refusés ; répare un fichier illisible. */
  async setEntries(entries: readonly unknown[] | null | undefined): Promise<StoreOpResult> {
    const parts = (entries ?? [])
      .map((e) => stripPy(strPy(e)))
      .filter((e) => e !== "")
      .map((e) => sanitizeEntryText(e));
    return this.transaction(async () => {
      const courant = await this.entries();
      if (parts.length === 0)
        return this.resultat(
          false,
          "rewrite",
          courant,
          "empty content: rewrite replaces the WHOLE store and requires at least one entry (separate them with a --- line)",
          { error_code: "empty_content" },
        );
      const taille = longueurPy(serialize(parts));
      if (taille > this.charLimit)
        return this.resultat(
          false,
          "rewrite",
          courant,
          `exceeds the limit (${taille}/${this.charLimit} chars); rewrite shorter`,
          { error_code: "over_limit" },
        );
      await this.ecrireEntrees(parts);
      return this.resultat(true, "rewrite", parts, null, { before: courant });
    });
  }

  /** Compare-and-set d'une annulation : remet `entries` si le magasin vaut encore `expected`, sinon `changed`. */
  async restore(
    expected: readonly unknown[] | null | undefined,
    entries: readonly unknown[] | null | undefined,
  ): Promise<StoreOpResult> {
    const voulu = (expected ?? []).map((e) => stripPy(strPy(e))).filter((e) => e !== "");
    const parts = (entries ?? [])
      .map((e) => stripPy(strPy(e)))
      .filter((e) => e !== "")
      .map((e) => sanitizeEntryText(e));
    return this.transaction(async () => {
      const courant = await this.entriesStrict();
      if (courant instanceof StoreReadError) return this.lectureEchouee("restore", courant);
      if (courant.length !== voulu.length || courant.some((e, i) => e !== voulu[i]))
        return this.resultat(
          false,
          "restore",
          courant,
          "the store changed since this write; nothing was restored",
          {
            error_code: "changed",
          },
        );
      const taille = longueurPy(serialize(parts));
      if (taille > this.charLimit)
        return this.resultat(
          false,
          "restore",
          courant,
          `exceeds the limit (${taille}/${this.charLimit} chars)`,
          {
            error_code: "over_limit",
          },
        );
      await this.ecrireEntrees(parts);
      return this.resultat(true, "restore", parts, null, { before: courant });
    });
  }

  /** Bloc Markdown du prompt système : en-tête (gabarit `memory.header_template` éventuel) puis entrées préfixées de leur id. */
  async renderBlock(): Promise<string> {
    const entrees = await this.entries();
    if (entrees.length === 0) return "";
    const chars = longueurPy(serialize(entrees));
    const pct = this.charLimit ? arrondiPy((100 * chars) / this.charLimit, 1) : 0;
    const tete =
      enTeteGabarit(this.label, chars, this.charLimit, pct) ??
      `## ${this.label}  (${chars}/${this.charLimit} chars · ${reprFlottant(pct)}%)`;
    const ids = entryIds(entrees);
    return `${tete}\n${entrees.map((e, i) => `[${ids[i] ?? ""}] ${e}`).join(`\n${DELIM}\n`)}`;
  }

  private transaction<T>(f: () => Promise<T>): Promise<T> {
    return storeTransaction(this.path, this.lockTimeoutS, f);
  }

  /** Lecture stricte (mutation) : vide si absent ; toute autre erreur rendue en `StoreReadError` (jamais d'écrasement). */
  private async entriesStrict(): Promise<string[] | StoreReadError> {
    try {
      return parseEntries(await lireTextePy(this.path));
    } catch (e) {
      if ((e as { code?: unknown }).code === "ENOENT") return [];
      return new StoreReadError(e instanceof Error ? e.message : String(e));
    }
  }

  private lectureEchouee(action: string, e: StoreReadError): StoreOpResult {
    log().warn(
      `${action} avorté : fichier illisible (${e.message.slice(0, 120)}) — aucune écriture, données préservées`,
    );
    return this.resultat(
      false,
      action,
      [],
      "memory file unreadable (I/O or non-UTF-8 encoding); nothing was written, to avoid clobbering the existing entries",
      { error_code: "read_failed" },
    );
  }

  private cibleIntrouvable(action: string, entrees: string[], res: ResolutionCible): StoreOpResult {
    if (res.candidates.length > 0)
      return this.resultat(
        false,
        action,
        entrees,
        `ambiguous target (${res.candidates.length} entries match); use the id of ONE entry`,
        { error_code: "ambiguous", candidate_indexes: res.candidates },
      );
    return this.resultat(
      false,
      action,
      entrees,
      "no entry matches the target; reuse the bracketed id as displayed",
      {
        error_code: "no_match",
        closest_index: res.closest_index,
      },
    );
  }

  private async ecrireEntrees(entrees: readonly string[]): Promise<void> {
    const dossier = path.dirname(this.path);
    await mkdir(dossier, { recursive: true });
    const donnees = serialize(entrees);
    exigerUtf8(donnees);
    const tmp = temporaire(dossier);
    const fh = await open(tmp, "wx", 0o600);
    try {
      try {
        await fh.writeFile(donnees, "utf8");
      } finally {
        await fh.close();
      }
      await rename(tmp, this.path);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  private resultat(
    ok: boolean,
    action: string,
    entrees: readonly string[],
    error: string | null = null,
    o: {
      error_code?: string;
      closest_index?: number | null;
      candidate_indexes?: readonly number[];
      before?: readonly string[];
      unchanged?: boolean;
    } = {},
  ): StoreOpResult {
    const propres = entrees.filter((e) => stripPy(e) !== "");
    const chars = longueurPy(serialize(entrees));
    return {
      ok,
      action,
      error,
      error_code: o.error_code ?? null,
      chars,
      limit: this.charLimit,
      usage_pct: new FlottantPy(this.charLimit ? arrondiPy((100 * chars) / this.charLimit, 1) : 0),
      n_entries: propres.length,
      entries: propres,
      entry_ids: entryIds(propres),
      closest_index: o.closest_index ?? null,
      candidate_indexes: [...(o.candidate_indexes ?? [])],
      before: (o.before ?? []).filter((e) => stripPy(e) !== ""),
      unchanged: Boolean(o.unchanged),
    };
  }
}
