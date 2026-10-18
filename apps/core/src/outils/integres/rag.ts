// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/rag.ts — outils RAG intégrés (rag_search, rag_get_document, rag_list_sources, rag_cite) sur le module de requête RAG injecté. */
import {
  arrondiPy,
  cleHashPy,
  clesOrdonnees,
  comparePointsDeCode,
  copieDict,
  entierOuNulPy,
  ErreurPython,
  estDict,
  estErreurPython,
  floatPy,
  FlottantPy,
  fnmatchPy,
  getPy,
  intPy,
  iterExige,
  longueurPy,
  lowerPy,
  nomTypePy,
  ouPy,
  poserCle,
  prefixePy,
  pyJsonDumps,
  reprPy,
  rstripPy,
  stripPy,
  strPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { CHARS_PER_TOKEN } from "@elpis/config";

import { journal } from "../../journal";
import type { OutilIntegre } from "../catalogue";

export { fnmatchPy };

const log = journal("rag_tools");

export const DEFAULT_SEARCH_TOP_K = 8;
export const DEFAULT_SEARCH_MAX_CHARS = 1_500;
export const CTX_FILL_RATIO = 0.8;
export const RAM_CAP_CHARS = 600_000;
export const RAM_CAP_CHUNKS = 600;
export const DEFAULT_DOC_MAX_CHUNKS = 15;
export const DEFAULT_DOC_MAX_CHARS = 20_000;
export const CITE_MAX_RESULTS = 10;
export const CITE_SNIPPET_CHARS = 600;

/** Arguments nommés de `rag_search_only` ; sans `collection` pour un service RAG antérieur au paramètre. */
export interface ParametresRecherche {
  question: string;
  top_k: number;
  use_hybrid: boolean;
  use_mmr: boolean;
  collection?: unknown;
}

/** `rag_app.rag_query` tel que les outils l'appellent (valeur ou promesse) ; `listIndexedFiles` est facultatif comme le `hasattr` Python. */
export interface ModuleRequeteRag {
  loadConfig(signal?: AbortSignal): unknown;
  ragSearchOnly(p: ParametresRecherche, signal?: AbortSignal): unknown;
  getAllChunksForFiles(cfg: Dict, fichiers: unknown[], maxChunks: number, signal?: AbortSignal): unknown;
  listIndexedFiles?: (cfg: Dict, signal?: AbortSignal) => unknown;
}

/** Enveloppe d'erreur `ok: false` explicite (le classifieur partagé la compte en échec) ; les extras nuls sont omis. */
export function ragErr(message: string, extra: Dict = {}): string {
  const payload: Dict = { ok: false, error: message };
  for (const k of clesOrdonnees(extra))
    if (extra[k] !== null && extra[k] !== undefined) poserCle(payload, k, extra[k]);
  return pyJsonDumps(payload, { ensureAscii: false });
}

/** Extrait borné avec marqueur : une coupe silencieuse ferait passer un chunk amputé pour le texte intégral. */
export function clipExcerpt(text: string, cap = DEFAULT_SEARCH_MAX_CHARS): string {
  const n = longueurPy(text);
  if (n <= cap) return text;
  return (
    prefixePy(text, cap) +
    `… [excerpt truncated, ${n - cap} chars omitted — use rag_get_document for the full text]`
  );
}

/** `[max_chars, max_chunks]` d'une lecture de document : 80 % de la fenêtre, plafonnés pour la RAM ; défauts sans fenêtre connue. */
export function ctxDocLimits(ctxSize = 0): [number, number] {
  if (ctxSize && ctxSize > 0) {
    const rawChars = Math.trunc(ctxSize * CTX_FILL_RATIO * CHARS_PER_TOKEN);
    const maxChars = Math.min(rawChars, RAM_CAP_CHARS);
    const maxChunks = Math.min(Math.floor(maxChars / 300), RAM_CAP_CHUNKS);
    return [maxChars, Math.max(1, maxChunks)];
  }
  return [DEFAULT_DOC_MAX_CHARS, DEFAULT_DOC_MAX_CHUNKS];
}

function methodeTexte(v: unknown, methode: string): string {
  if (typeof v === "string") return v;
  throw new ErreurPython("AttributeError", `'${nomTypePy(v)}' object has no attribute '${methode}'`);
}

function stripTexte(v: unknown): string {
  return stripPy(methodeTexte(v, "strip"));
}

function lowerTexte(v: unknown): string {
  return lowerPy(methodeTexte(v, "lower"));
}

function lstripCaracteres(s: string, caracteres: string): string {
  let debut = 0;
  while (debut < s.length && caracteres.includes(s.charAt(debut))) debut++;
  return s.slice(debut);
}

/** `PurePosixPath(s).name` : dernier composant ni vide ni `.`. */
function nomPosix(s: string): string {
  return (
    s
      .split("/")
      .filter((x) => x !== "" && x !== ".")
      .at(-1) ?? ""
  );
}

/** Nom de fichier nu : préfixe de collection retiré (coupé sur la longueur du texte en minuscules, comme Python), puis base du chemin. */
export function normalizeFilename(raw: string, collection = ""): string {
  if (!raw) return "";
  let s = stripPy(raw).replaceAll("\\", "/");
  if (collection) {
    const colLower = rstripPy(lowerPy(collection), "/");
    const sLower = lstripCaracteres(lowerPy(s), "/");
    for (const prefixe of [`${colLower}/`, `collections/${colLower}/`, `collection/${colLower}/`]) {
      if (sLower.startsWith(prefixe)) {
        s = Array.from(s).slice(longueurPy(prefixe)).join("");
        break;
      }
    }
  }
  return stripPy(lstripCaracteres(stripPy(nomPosix(s) || s), "./"));
}

/** Nom indexé le plus proche : égalité sans casse, puis suffixe, puis inclusion dans un sens ou l'autre. */
export function fuzzyMatch(target: string, available: unknown): string | null {
  if (!target || !veritePy(available)) return null;
  const noms = iterExige(available);
  const t = lowerPy(target);
  for (const name of noms) if (lowerTexte(name) === t) return name as string;
  for (const name of noms) {
    const nl = lowerTexte(name);
    if (nl.endsWith(t) || nl.endsWith(`.${t}`)) return name as string;
  }
  for (const name of noms) {
    const nl = lowerTexte(name);
    if (nl.includes(t) || t.includes(nl)) return name as string;
  }
  return null;
}

/** Filtre léger d'un résultat : `file_glob` (fnmatch sur le nom), `folder_contains`, `folder_equals`, sans casse. */
export function matchesFilter(name: unknown, folder: unknown, filters: unknown): boolean {
  if (!veritePy(filters)) return true;
  const fg = getPy(filters, "file_glob");
  if (veritePy(fg) && !fnmatchPy(lowerTexte(ouPy(name, "")), lowerTexte(fg))) return false;
  const fc = getPy(filters, "folder_contains");
  if (veritePy(fc) && !lowerTexte(ouPy(folder, "")).includes(lowerTexte(fc))) return false;
  const fe = getPy(filters, "folder_equals");
  if (veritePy(fe) && rstripPy(lowerTexte(ouPy(folder, "")), "/") !== rstripPy(lowerTexte(fe), "/"))
    return false;
  return true;
}

/** Refus du paramètre `collection` par un service ancien : `ErreurPython("TypeError")` du module, jamais une `TypeError` JS (panne réseau, bogue). */
function estTypeError(e: unknown): boolean {
  return estErreurPython(e, "TypeError");
}

/** Arrêt réel : le signal du run est abandonné (une `AbortError` interne au module reste une panne ordinaire). */
function estAnnulation(_e: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function messagePy(e: unknown): string {
  return e instanceof Error ? e.message : strPy(e);
}

/** Une recherche ; `overFetch` triple `top_k` pour survivre au post-filtrage ; un service sans `collection` est rappelé sans. */
export async function runSearch(
  mod: ModuleRequeteRag,
  cfg: unknown,
  query: string,
  topK: number,
  useHybrid: boolean,
  useMmr: boolean,
  overFetch = false,
  signal?: AbortSignal,
): Promise<unknown> {
  const k = Math.max(1, Math.min(topK * (overFetch ? 3 : 1), 64));
  const coll = ouPy(getPy(ouPy(cfg, {}), "collection"), null);
  const base = { question: query, top_k: k, use_hybrid: useHybrid, use_mmr: useMmr };
  let result: unknown;
  try {
    result = await mod.ragSearchOnly({ ...base, collection: coll }, signal);
  } catch (e) {
    if (estAnnulation(e, signal) || !estTypeError(e)) throw e;
    result = await mod.ragSearchOnly(base, signal);
  }
  if (!veritePy(getPy(result, "ok"))) return [];
  return ouPy(getPy(result, "results", []), []);
}

function avecCollection(cfg: unknown, coll: unknown): Dict {
  if (!estDict(cfg)) throw new ErreurPython("TypeError", `'${nomTypePy(cfg)}' object is not a mapping`);
  const copie = copieDict(cfg);
  poserCle(copie, "collection", coll);
  return copie;
}

function marquer(r: unknown, coll: unknown): Dict {
  if (!estDict(r))
    throw new ErreurPython("TypeError", `'${nomTypePy(r)}' object does not support item assignment`);
  poserCle(r, "_collection", coll);
  return r;
}

function cleTuple(valeurs: readonly unknown[]): string {
  return JSON.stringify(
    valeurs.map((v) => {
      const h = cleHashPy(v);
      if (typeof h === "string") return ["s", h];
      if (typeof h === "number" || typeof h === "bigint") return ["n", String(h)];
      return h === null || h === undefined ? ["N"] : ["o", strPy(h)];
    }),
  );
}

function nombrePy(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean" || typeof v === "bigint") return Number(v);
  return v instanceof FlottantPy ? v.valeur : null;
}

/** `a > b` de Python sur des scores : nombres entre eux, textes entre eux, TypeError sinon. */
function superieurPy(a: unknown, b: unknown): boolean {
  const x = nombrePy(a);
  const y = nombrePy(b);
  if (x !== null && y !== null) return x > y;
  if (typeof a === "string" && typeof b === "string") return comparePointsDeCode(a, b) > 0;
  throw new ErreurPython(
    "TypeError",
    `'>' not supported between instances of '${nomTypePy(a)}' and '${nomTypePy(b)}'`,
  );
}

/** Dédoublonnage par (collection, nom, chunk) : un meilleur score remplace l'entrée, qui garde sa place. */
function meilleurs(pooled: readonly Dict[]): Dict[] {
  const best = new Map<string, Dict>();
  for (const r of pooled) {
    const cle = cleTuple([getPy(r, "_collection", ""), getPy(r, "name", ""), getPy(r, "chunk_index", 0)]);
    const actuel = best.get(cle);
    if (actuel === undefined || superieurPy(getPy(r, "score", 0), getPy(actuel, "score", 0)))
      best.set(cle, r);
  }
  return [...best.values()];
}

/** Tri stable par score décroissant (`key=-float(score)`, clés toutes calculées avant le tri). */
function parScore(liste: readonly Dict[]): Dict[] {
  const cles = liste.map((r) => -floatPy(getPy(r, "score", 0)));
  return liste
    .map((r, i) => ({ r, k: cles[i] ?? 0 }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.r);
}

function source(folder: unknown, name: unknown): unknown {
  return veritePy(folder) ? `${strPy(folder)}/${strPy(name)}` : name;
}

function score4(r: Dict): unknown {
  return versFlottantPy(arrondiPy(floatPy(getPy(r, "score", 0)), 4));
}

function lenPy(v: unknown): number {
  if (typeof v === "string") return longueurPy(v);
  if (Array.isArray(v)) return v.length;
  if (estDict(v)) return Object.keys(v).length;
  throw new ErreurPython("TypeError", `object of type '${nomTypePy(v)}' has no len()`);
}

function textePourLen(v: unknown): string {
  if (typeof v === "string") return v;
  throw new ErreurPython("TypeError", `object of type '${nomTypePy(v)}' has no len()`);
}

function tranchePy(v: unknown, n: number): unknown {
  if (typeof v === "string") return prefixePy(v, n);
  if (Array.isArray(v)) return v.slice(0, n);
  throw new ErreurPython("TypeError", `'${nomTypePy(v)}' object is not subscriptable`);
}

function plusUnPy(v: unknown): unknown {
  if (v instanceof FlottantPy) return new FlottantPy(v.valeur + 1);
  if (typeof v === "bigint") return v + 1n;
  if (typeof v === "number" || typeof v === "boolean") return Number(v) + 1;
  if (typeof v === "string" || Array.isArray(v))
    throw new ErreurPython(
      "TypeError",
      `can only concatenate ${nomTypePy(v)} (not "int") to ${nomTypePy(v)}`,
    );
  throw new ErreurPython("TypeError", `unsupported operand type(s) for +: '${nomTypePy(v)}' and 'int'`);
}

function joindrePy(valeurs: readonly unknown[], sep: string): string {
  return valeurs
    .map((v, i) => {
      if (typeof v === "string") return v;
      throw new ErreurPython("TypeError", `sequence item ${i}: expected str instance, ${nomTypePy(v)} found`);
    })
    .join(sep);
}

/** `sorted()` de noms : textes par points de code, nombres entre eux, TypeError pour un mélange. */
function triePy(valeurs: unknown[]): unknown[] {
  return [...valeurs].sort((a, b) => {
    if (typeof a === "string" && typeof b === "string") return comparePointsDeCode(a, b);
    const x = nombrePy(a);
    const y = nombrePy(b);
    if (x !== null && y !== null) return x - y;
    throw new ErreurPython(
      "TypeError",
      `'<' not supported between instances of '${nomTypePy(a)}' and '${nomTypePy(b)}'`,
    );
  });
}

function collectionsDemandees(args: Dict, defaut: string): unknown[] {
  const c = getPy(args, "collections");
  if (Array.isArray(c) && c.length > 0) return c;
  return defaut ? [defaut] : [""];
}

/** Le `try` du Python (dès `load_config`) : toute erreur devient `ok: false` journalisée, l'annulation remonte ; le prélude, lui, lève vers le dispatcher. */
async function sansLever(
  outil: string,
  signal: AbortSignal | undefined,
  f: () => Promise<string>,
): Promise<string> {
  try {
    return await f();
  } catch (e) {
    if (estAnnulation(e, signal)) throw e;
    log.error({ err: e }, `${outil} error`);
    return ragErr(messagePy(e));
  }
}

const json = (v: unknown): string => pyJsonDumps(v, { ensureAscii: false });

export async function handleRagSearch(
  mod: ModuleRequeteRag | null,
  args: Dict,
  defaultCollection: string,
  searchMode: string,
  topK: number,
  useMmr: boolean,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!mod) return ragErr("RAG module unavailable.", { hint: "Check RAG module installation." });
  const query = stripTexte(ouPy(getPy(args, "query"), ""));
  if (!query) return ragErr("Parameter 'query' required.", { hint: "Pass query='keywords or question'" });
  const filters = ouPy(getPy(args, "filters"), {});
  const brut = getPy(args, "score_threshold");
  let seuil: number | null = null;
  if (brut !== null && brut !== undefined) {
    try {
      seuil = floatPy(brut);
    } catch (e) {
      if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    }
  }
  const collections = collectionsDemandees(args, defaultCollection);
  return sansLever("rag_search", signal, async () => {
    const cfgBase = await mod.loadConfig(signal);
    if (!veritePy(cfgBase)) return ragErr("RAG config not found.");
    const cappedK = Math.min(topK, DEFAULT_SEARCH_TOP_K);
    const useHybrid = searchMode === "hybrid";
    const tous: Dict[] = [];
    for (const coll of collections) {
      const cfg = veritePy(coll) ? avecCollection(cfgBase, coll) : cfgBase;
      let items: unknown;
      try {
        items = await runSearch(mod, cfg, query, cappedK, useHybrid, useMmr, veritePy(filters), signal);
      } catch (e) {
        if (estAnnulation(e, signal)) throw e;
        log.warn(`search failed on collection ${reprPy(coll)}: ${messagePy(e)}`);
        items = [];
      }
      for (const r of iterExige(items)) tous.push(marquer(r, coll));
    }
    if (tous.length === 0)
      return json({ results: [], count: 0, message: "No results found.", collections_searched: collections });
    const pooled = meilleurs(tous);
    const filtered: Dict[] = [];
    for (const r of pooled) {
      if (seuil !== null && floatPy(getPy(r, "score", 0)) < seuil) continue;
      if (!matchesFilter(getPy(r, "name", ""), getPy(r, "folder", ""), filters)) continue;
      filtered.push(r);
    }
    const compact = parScore(filtered)
      .slice(0, cappedK)
      .map((r) => {
        const name = getPy(r, "name", "");
        return {
          source: source(getPy(r, "folder", ""), name),
          get_document_name: name,
          chunk: getPy(r, "chunk_index", 0),
          score: score4(r),
          text: clipExcerpt(textePourLen(ouPy(getPy(r, "text", ""), ""))),
          collection: ouPy(getPy(r, "_collection", ""), null),
        };
      });
    const payload: Dict = {
      results: compact,
      count: compact.length,
      pooled_before_filter: pooled.length,
      collections_searched: collections,
      note: "Use 'get_document_name' (not 'source') in rag_get_document.",
    };
    if (veritePy(filters)) payload["filters_applied"] = filters;
    if (seuil !== null) payload["score_threshold"] = versFlottantPy(seuil);
    return json(payload);
  });
}

export async function handleRagGetDocument(
  mod: ModuleRequeteRag | null,
  args: Dict,
  collection: string,
  ctxSize = 0,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!mod) return ragErr("RAG module unavailable.");
  const rawFilename = stripTexte(ouPy(getPy(args, "filename"), ""));
  if (!rawFilename)
    return ragErr("Parameter 'filename' required.", {
      hint: "Call rag_list_sources to get the exact names.",
    });
  const chunkStart = entierOuNulPy(getPy(args, "chunk_start"));
  const chunkEnd = entierOuNulPy(getPy(args, "chunk_end"));
  return sansLever("rag_get_document", signal, async () => {
    let cfg = await mod.loadConfig(signal);
    if (!veritePy(cfg)) return ragErr("RAG config not found.");
    if (collection) cfg = avecCollection(cfg, collection);
    let filename = normalizeFilename(rawFilename, collection);
    const [maxChars, maxChunks] = ctxDocLimits(ctxSize);
    const lire = async (nom: string): Promise<unknown> =>
      mod.getAllChunksForFiles(cfg as Dict, [nom], maxChunks + 5, signal);
    let chunks = await lire(filename);
    const lister = mod.listIndexedFiles?.bind(mod);
    if (!veritePy(chunks) && lister) {
      const matched = fuzzyMatch(filename, ouPy(await lister(cfg as Dict, signal), []));
      if (matched && matched !== filename) {
        log.info(`fuzzy-match: '${rawFilename}' → '${matched}'`);
        chunks = await lire(matched);
        filename = matched;
      }
    }
    if (!veritePy(chunks) && rawFilename !== filename) {
      chunks = await lire(rawFilename);
      if (veritePy(chunks)) filename = rawFilename;
    }
    if (!veritePy(chunks)) {
      let hint = "";
      if (lister) {
        const avail = iterExige(ouPy(await lister(cfg as Dict, signal), [])).slice(0, 20);
        if (avail.length) hint = ` Fichiers disponibles : ${joindrePy(avail, ", ")}`;
      }
      return json({ results: [], count: 0, message: `Aucun contenu pour '${rawFilename}'.${hint}` });
    }
    const liste = iterExige(chunks);
    const totalAvailable = liste.length;
    const aEnvoyer =
      chunkStart !== null || chunkEnd !== null
        ? liste.slice(Math.max(0, chunkStart || 0), chunkEnd ?? totalAvailable)
        : liste.slice(0, maxChunks);
    const results: Dict[] = [];
    let total = 0;
    let truncated = false;
    for (const c of aEnvoyer) {
      const text = getPy(c, "text", "");
      const n = lenPy(text);
      if (total + n > maxChars) {
        truncated = true;
        break;
      }
      results.push({ chunk: getPy(c, "chunk_index", 0), text });
      total += n;
    }
    const payload: Dict = {
      filename,
      requested: rawFilename,
      results,
      count: results.length,
      total_chars: total,
      ctx_size: ctxSize,
      limit_chars: maxChars,
      total_chunks_available: totalAvailable,
    };
    if (truncated) {
      const suivant = plusUnPy(results.length ? results.at(-1)?.["chunk"] : -1);
      payload["warning"] =
        `Document truncated to ${results.length}/${totalAvailable} chunks ` +
        `(budget ${maxChars} chars ≈ 80% ctx_size=${ctxSize}). ` +
        `Pour lire la suite : rag_get_document(filename, chunk_start=${strPy(suivant)}).`;
      payload["next_chunk_start"] = suivant;
    }
    return json(payload);
  });
}

export async function handleRagListSources(
  mod: ModuleRequeteRag | null,
  args: Dict,
  collection: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!mod) return ragErr("RAG module unavailable.");
  return sansLever("rag_list_sources", signal, async () => {
    let cfg = await mod.loadConfig(signal);
    if (!veritePy(cfg)) return ragErr("RAG config not found.");
    if (collection) cfg = avecCollection(cfg, collection);
    const nameFilter = lowerPy(stripTexte(ouPy(getPy(args, "name_filter"), "")));
    let files: unknown;
    if (mod.listIndexedFiles) files = ouPy(await mod.listIndexedFiles(cfg as Dict, signal), []);
    else {
      const result = await mod.ragSearchOnly(
        { question: "document fichier", top_k: 50, use_hybrid: false, use_mmr: false },
        signal,
      );
      const seen = new Map<string, unknown>();
      for (const r of iterExige(getPy(result, "results", []))) {
        const name = getPy(r, "name", "");
        if (veritePy(name) && !seen.has(cleTuple([name]))) seen.set(cleTuple([name]), name);
      }
      files = triePy([...seen.values()]);
    }
    if (nameFilter) files = iterExige(files).filter((f) => lowerTexte(f).includes(nameFilter));
    return json({
      files,
      count: lenPy(files),
      collection: collection || "default",
      note: "Utilisez ces noms exacts dans rag_get_document.",
    });
  });
}

export async function handleRagCite(
  mod: ModuleRequeteRag | null,
  args: Dict,
  defaultCollection: string,
  searchMode: string,
  useMmr: boolean,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!mod) return ragErr("RAG module unavailable.");
  const query = stripTexte(ouPy(getPy(args, "query"), ""));
  if (!query) return ragErr("Parameter 'query' required.");
  const k = Math.max(1, Math.min(intPy(ouPy(getPy(args, "max_sources"), 5)), CITE_MAX_RESULTS));
  const collections = collectionsDemandees(args, defaultCollection);
  return sansLever("rag_cite", signal, async () => {
    const cfgBase = await mod.loadConfig(signal);
    if (!veritePy(cfgBase)) return ragErr("RAG config not found.");
    const useHybrid = searchMode === "hybrid";
    const tous: Dict[] = [];
    for (const coll of collections) {
      const cfg = veritePy(coll) ? avecCollection(cfgBase, coll) : cfgBase;
      let items: unknown;
      try {
        items = await runSearch(mod, cfg, query, k * 2, useHybrid, useMmr, false, signal);
      } catch (e) {
        if (estAnnulation(e, signal)) throw e;
        items = [];
      }
      for (const r of iterExige(items)) tous.push(marquer(r, coll));
    }
    const pooled = parScore(meilleurs(tous)).slice(0, k);
    if (pooled.length === 0)
      return json({ sources: [], count: 0, message: "No source found for this query." });
    const sources = pooled.map((r, i) => {
      const name = getPy(r, "name", "");
      const folder = getPy(r, "folder", "");
      const text = tranchePy(ouPy(getPy(r, "text", ""), ""), CITE_SNIPPET_CHARS);
      return {
        cite_id: `S${i + 1}`,
        source: source(folder, name),
        document: name,
        chunk: getPy(r, "chunk_index", 0),
        collection: ouPy(getPy(r, "_collection", ""), null),
        score: score4(r),
        excerpt: text,
      };
    });
    return json({
      sources,
      count: sources.length,
      collections_searched: collections,
      instruction_for_llm:
        "Cite each factual claim with [S1], [S2]... matching the sources above. " +
        "If a claim is not supported by any excerpt, say so explicitly.",
    });
  });
}

const DEF_RAG_SEARCH: Dict = {
  type: "function",
  function: {
    name: "rag_search",
    description:
      "Semantic search over the document base. " +
      "Returns relevant chunks with 'get_document_name' " +
      "(exact value to pass to rag_get_document). " +
      "Supports: filters={file_glob, folder_contains, folder_equals}, " +
      "collections=[...] to search several collections, " +
      "score_threshold to filter noisy results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or question to search for." },
        filters: {
          type: "object",
          description:
            "Optional filters: " + "{file_glob:'*.pdf', folder_contains:'api', folder_equals:'docs/'}",
        },
        collections: {
          type: "array",
          items: { type: "string" },
          description: "Union of several collections. Empty = default collection.",
        },
        score_threshold: { type: "number", description: "Minimum score (0..1). Useful to cut noise." },
      },
      required: ["query"],
    },
  },
};

const DEF_RAG_GET_DOCUMENT: Dict = {
  type: "function",
  function: {
    name: "rag_get_document",
    description:
      "Fetch the content of one file. " +
      "IMPORTANT: 'filename' = the 'get_document_name' returned by rag_search. " +
      "Do not prefix it with the collection. " +
      "For large documents: use chunk_start / chunk_end for iterative reading.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Exact file name, without path." },
        chunk_start: { type: "integer", description: "Index of the first chunk to return (0-based)." },
        chunk_end: { type: "integer", description: "Exclusive end index (e.g. 30 for chunks 0..29)." },
      },
      required: ["filename"],
    },
  },
};

const DEF_RAG_LIST_SOURCES: Dict = {
  type: "function",
  function: {
    name: "rag_list_sources",
    description: "List the available files. " + "Optional: name_filter='substring' to filter by name.",
    parameters: {
      type: "object",
      properties: {
        name_filter: { type: "string", description: "Case-insensitive substring filter on names." },
      },
      required: [],
    },
  },
};

const DEF_RAG_CITE: Dict = {
  type: "function",
  function: {
    name: "rag_cite",
    description:
      "Return short excerpts (≤600 chars) with a stable cite_id " +
      "(S1, S2…) to produce sourced answers. " +
      "Prefer it when the user asks for an answer with citations.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question or keywords to source." },
        max_sources: { type: "integer", description: "Max number of sources (1..10, default 5)." },
        collections: { type: "array", items: { type: "string" }, description: "Collections to query." },
      },
      required: ["query"],
    },
  },
};

/** Définitions `tools[]` des quatre outils, dans l'ordre de `_TOOL_DEFS`. */
export const TOOL_DEFS: readonly Dict[] = [
  DEF_RAG_SEARCH,
  DEF_RAG_GET_DOCUMENT,
  DEF_RAG_LIST_SOURCES,
  DEF_RAG_CITE,
];

export interface OptionsOutilsRag {
  /** Module de requête RAG ; absent, aucun outil (le tour retombe sur le RAG automatique). */
  module: ModuleRequeteRag | null;
  collection?: string;
  searchMode?: string;
  topK?: number;
  useMmr?: boolean;
  ctxSize?: number;
  /** Annulation du tour, transmise à chaque appel du module. */
  signal?: AbortSignal;
}

/** Outils intégrés pour la boucle (`builtin_tools`) ; `{}` sans module de requête RAG. */
export function buildRagBuiltinTools(o: OptionsOutilsRag): Record<string, OutilIntegre> {
  const mod = o.module;
  if (!mod) {
    log.warn("Module RAG introuvable — outils désactivés.");
    return {};
  }
  const collection = o.collection ?? "";
  const searchMode = o.searchMode ?? "classic";
  const topK = o.topK ?? DEFAULT_SEARCH_TOP_K;
  const useMmr = o.useMmr ?? true;
  const ctxSize = o.ctxSize ?? 0;
  const signal = o.signal;
  const [maxChars, maxChunks] = ctxDocLimits(ctxSize);
  log.info(
    `RAG activé v2 (col=${collection || "défaut"}, mode=${searchMode}, top_k=${topK}, ` +
      `use_mmr=${useMmr ? "True" : "False"}, ctx_size=${ctxSize}, doc_limit=${maxChunks}ch/${maxChars}c)`,
  );
  return {
    rag_search: {
      definition: DEF_RAG_SEARCH,
      handler: (args) => handleRagSearch(mod, args, collection, searchMode, topK, useMmr, signal),
    },
    rag_get_document: {
      definition: DEF_RAG_GET_DOCUMENT,
      handler: (args) => handleRagGetDocument(mod, args, collection, ctxSize, signal),
    },
    rag_list_sources: {
      definition: DEF_RAG_LIST_SOURCES,
      handler: (args) => handleRagListSources(mod, args, collection, signal),
    },
    rag_cite: {
      definition: DEF_RAG_CITE,
      handler: (args) => handleRagCite(mod, args, collection, searchMode, useMmr, signal),
    },
  };
}
