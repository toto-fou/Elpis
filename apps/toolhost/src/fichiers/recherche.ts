// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/recherche.ts — recherche et remplacement multi-fichiers de l'éditeur (routes_files.py `/grep`, `/replace`) : parcours et présélection par l'agent du conteneur, expressions de Python, remplacements dans un thread. */
import { bumpSandboxUsage, estErreurAgent, PANNES_AGENT, sandboxUsageBytes } from "@elpis/bac";
import {
  comparePointsDeCode,
  compilerRe,
  ErreurRe,
  getPy,
  HttpError,
  pyJsonLoadsOctets,
  RegexNonGeree,
  reprPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { agentHttp, sha256Bytes } from "@elpis/fichiers";
import type { AgentClient } from "@elpis/fichiers";
import { stripWorkPrefix } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { cheminHote, histEcrire, mtimeF, sousVerrouFichier } from "./aides";
import { entierDe, parAgent, reponseJson, uidDe, une } from "./commun";
import type { ContexteFichiers } from "./commun";
import { quotaMb, sousVerrouQuota } from "./quota";
import {
  dansLeChamp,
  GREP_IGNORED_DIRS,
  GREP_MAX_FILE_BYTES,
  longueurPy,
  posix,
  preparerRemplaceur,
} from "./remplacement";
import type { SpecRemplacement } from "./remplacement";
import { avecFilCalcul, DelaiCalcul } from "./calcul-execution";
import type { SessionCalcul } from "./calcul-execution";

const MIO = 1024 * 1024;
const GREP_MAX_RESULTS = 500;
const GREP_MAX_FILES_SCANNED = 5_000;
const GREP_TIMEOUT_S = 5.0;
const GREP_SNIPPET_RADIUS = 80;
const GREP_MAX_LINE_CHARS = 20_000;
const REPLACE_MAX_FILES = 500;
const REPLACE_MAX_REPLACEMENT = 10_000;
const REPLACE_SCAN_TIMEOUT_S = 10.0;
const ELAGUES = [...GREP_IGNORED_DIRS].sort(comparePointsDeCode);

function route(
  chemin: string,
  traiter: (q: FastifyRequest, r: FastifyReply) => Promise<unknown>,
): DefinitionRoute {
  return { methode: "POST", chemin, processus: ["toolhost"], acces: "enveloppe", traiter };
}

/** Corps JSON (illisible : 400 « Body JSON requis »). */
function corps(q: FastifyRequest): unknown {
  try {
    return pyJsonLoadsOctets(q.corpsBrut);
  } catch {
    throw new HttpError(400, "Body JSON requis");
  }
}

/** `body.get(cle) or ""` d'un corps qui doit être un dict. */
function ou(d: unknown, cle: string, defaut: unknown): unknown {
  const v = getPy(d, cle);
  return veritePy(v) ? v : defaut;
}

/** `glob` : texte de 200 caractères au plus, sinon 400. */
function motifNom(d: unknown): string {
  const g = ou(d, "glob", "");
  if (veritePy(g) && (typeof g !== "string" || longueurPy(g) > 200))
    throw new HttpError(400, "glob invalide");
  return g as string;
}

/** `re.compile(query)` pour un 400 lisible (les refus de Python ne dépendent pas d'IGNORECASE) ; un motif valide mais intraduisible est laissé à l'agent. */
function validerRegex(query: string): void {
  try {
    compilerRe(query);
  } catch (e) {
    if (e instanceof RegexNonGeree) return;
    if (e instanceof ErreurRe) throw new HttpError(400, `Regex invalide : ${e.message}`);
    throw e;
  }
}

async function rechercher(ctx: ContexteFichiers, q: FastifyRequest): Promise<Dict> {
  const uid = uidDe(q);
  const d = corps(q);
  const query = ou(d, "query", "");
  if (typeof query !== "string" || !stripPy(query)) throw new HttpError(400, "Query vide");
  if (longueurPy(query) > 1000) throw new HttpError(400, "Query trop longue (max 1000 caractères)");
  const regex = veritePy(getPy(d, "regex", false));
  const sensible = veritePy(getPy(d, "case_sensitive", false));
  const motif = motifNom(d);
  const caches = veritePy(getPy(d, "include_hidden", false));
  if (regex) validerRegex(query);
  const debut = performance.now();
  const [fichiers, tronque, trouves, bilan] = await parAgent("Recherche", async () => {
    const agent = await ctx.bac.agent(uid);
    const liste = await agent.list("", {
      depth: 4096,
      maxEntries: GREP_MAX_FILES_SCANNED + 1,
      hidden: caches,
      prune: ELAGUES,
      deadlineS: GREP_TIMEOUT_S,
      kinds: ["file"],
      nameGlob: motif,
    });
    const tous = liste.entries.map((e) => String(e["path"]));
    const t = liste.truncated || tous.length > GREP_MAX_FILES_SCANNED;
    const f = tous.slice(0, GREP_MAX_FILES_SCANNED);
    const reste = GREP_TIMEOUT_S - (performance.now() - debut) / 1000;
    const [tr, bi] = f.length
      ? await agent.grep(f, query, {
          ignoreCase: !sensible,
          regex,
          maxFileBytes: GREP_MAX_FILE_BYTES,
          maxHits: GREP_MAX_RESULTS,
          context: GREP_SNIPPET_RADIUS,
          maxLine: GREP_MAX_LINE_CHARS,
          deadlineS: Math.max(0.5, reste),
        })
      : [[], {}];
    return [f, t, tr, bi] as const;
  });
  const exiger = (h: Dict, k: string): unknown => {
    if (!Object.hasOwn(h, k)) throw new Error(`KeyError: '${k}'`);
    return h[k];
  };
  const matches = trouves.map((h) => ({
    path: exiger(h, "file"),
    line: exiger(h, "line"),
    col: exiger(h, "col"),
    snippet: exiger(h, "text"),
    match_start: exiger(h, "match_start"),
    match_end: exiger(h, "match_end"),
  }));
  return {
    matches,
    total_files_scanned: fichiers.length,
    truncated: tronque || veritePy(getPy(bilan, "hits_truncated")) || veritePy(getPy(bilan, "timed_out")),
    elapsed_ms: Math.trunc(performance.now() - debut),
  };
}

/** Aperçu du remplacement : liste et présélection par l'agent, candidats lus par lots et remplacés dans le thread, bornes de fichiers et de temps. */
async function apercu(
  fil: SessionCalcul,
  agent: AgentClient,
  spec: SpecRemplacement,
  caches: boolean,
  motif: string,
): Promise<Dict> {
  const files: Dict[] = [];
  const skipped: Dict[] = [];
  const debut = Date.now();
  const echeance = debut + REPLACE_SCAN_TIMEOUT_S * 1000;
  let truncated: boolean;
  try {
    const liste = await agent.list("", {
      depth: 4096,
      maxEntries: GREP_MAX_FILES_SCANNED + 1,
      hidden: caches,
      prune: ELAGUES,
      deadlineS: REPLACE_SCAN_TIMEOUT_S,
      kinds: ["file", "link", "other"],
      nameGlob: motif,
    });
    truncated = liste.truncated || liste.entries.length > GREP_MAX_FILES_SCANNED;
    const entrees = liste.entries.slice(0, GREP_MAX_FILES_SCANNED);
    for (const e of entrees)
      if (e["kind"] !== "file")
        skipped.push({
          path: e["path"],
          reason: e["kind"] === "link" || veritePy(e["link"]) ? "lien symbolique" : "fichier spécial",
        });
    const fichiers = entrees
      .filter((e) => e["kind"] === "file" && entierDe(e, "size") <= GREP_MAX_FILE_BYTES)
      .map((e) => String(e["path"]));
    const [trouves, bilan] = fichiers.length
      ? await agent.grep(fichiers, spec.query, {
          ignoreCase: !spec.caseSensitive,
          regex: spec.regex,
          filesOnly: true,
          maxHits: fichiers.length,
          maxFileBytes: GREP_MAX_FILE_BYTES,
          maxLine: GREP_MAX_FILE_BYTES,
          deadlineS: Math.max(0.5, REPLACE_SCAN_TIMEOUT_S - (Date.now() - debut) / 1000),
        })
      : [[], {}];
    truncated = truncated || veritePy(getPy(bilan, "timed_out"));
    const candidats = trouves.map((h) => String(h["file"]));
    let nLus = 0;
    while (nLus < candidats.length) {
      if (files.length >= REPLACE_MAX_FILES || Date.now() - debut > REPLACE_SCAN_TIMEOUT_S * 1000) {
        truncated = true;
        break;
      }
      let lot = candidats.slice(nLus, nLus + 200);
      const lus = await agent.readMany(lot, { maxFile: GREP_MAX_FILE_BYTES, maxTotal: 32 * MIO });
      const premierAbsent = lot.findIndex((rel) => !lus.has(rel));
      lot = lot.slice(0, premierAbsent < 0 ? lot.length : premierAbsent);
      if (!lot.length) {
        truncated = true;
        break;
      }
      nLus += lot.length;
      const resultats = await fil.lot(
        spec,
        lot,
        lot.map((rel) => lus.get(rel) ?? null),
        REPLACE_MAX_FILES - files.length,
        echeance,
      );
      if (resultats === null || resultats.length < lot.length) truncated = true;
      if (resultats === null) break;
      for (const [rel, brut] of resultats) {
        let res = brut;
        if (res === null) continue;
        if (stripWorkPrefix(rel) !== rel) res = "chemin ambigu (work/)";
        if (typeof res === "string") {
          skipped.push({ path: rel, reason: res });
          continue;
        }
        files.push({
          path: rel,
          count: res.n,
          samples: res.echantillons.map(([ligne, avant, apres]) => ({
            line: ligne,
            before: Array.from(avant).slice(0, 300).join(""),
            after: Array.from(apres).slice(0, 300).join(""),
          })),
        });
        if (files.length >= REPLACE_MAX_FILES) break;
      }
    }
  } catch (e) {
    if (estErreurAgent(e)) throw agentHttp(e, "Remplacement");
    throw e;
  }
  return { files, total: files.reduce((n, f) => n + (f["count"] as number), 0), truncated, skipped };
}

/** Application : fichier par fichier sous le verrou du compte, chacun relu sous son verrou puis écrit si son contenu n'a pas bougé. */
async function appliquer(
  fil: SessionCalcul,
  ctx: ContexteFichiers,
  uid: number,
  agent: AgentClient,
  spec: SpecRemplacement,
  seuls: string[],
  caches: boolean,
  motif: string,
): Promise<Dict> {
  const racine = await ctx.bac.racine(uid);
  const done: Dict[] = [];
  const skipped: Dict[] = [];
  const etat: { failed: Dict | null } = { failed: null };
  const vus = new Set<string>();
  await sousVerrouQuota(uid, async () => {
    const qMb = await quotaMb(ctx.rappel, uid);
    const quotaOctets = qMb * MIO;
    let utilise = qMb > 0 ? await sandboxUsageBytes(uid, racine, { quotaBytes: quotaOctets }) : 0;
    for (const brut of seuls) {
      if (stripWorkPrefix(brut) !== brut) {
        skipped.push({ path: brut, reason: "hors champ" });
        continue;
      }
      const rel = posix(brut);
      if (vus.has(rel)) continue;
      vus.add(rel);
      if (!dansLeChamp(rel, caches, motif)) {
        skipped.push({ path: brut, reason: "hors champ" });
        continue;
      }
      const issue = await sousVerrouFichier(cheminHote(racine, rel), async () => {
        let e: Dict;
        let lu: Buffer | null = null;
        try {
          e = une(await agent.stat([rel]));
          if (
            getPy(e, "kind") === "file" &&
            !veritePy(getPy(e, "link")) &&
            entierDe(e, "size") <= GREP_MAX_FILE_BYTES
          )
            lu = (await agent.read(rel, { maxBytes: GREP_MAX_FILE_BYTES + 1 })).data;
        } catch (ex) {
          if (!estErreurAgent(ex)) throw ex;
          if (!PANNES_AGENT.includes(ex.code)) return "suivant" as const;
          etat.failed = { path: rel, error: detailTexte(agentHttp(ex, "Remplacement")) };
          return "arret" as const;
        }
        const kind = getPy(e, "kind");
        if (kind === "missing" || kind === "error") return "suivant" as const;
        let res;
        try {
          res = await fil.un(spec, { kind, link: getPy(e, "link") }, lu);
        } catch (ex) {
          const message =
            ex instanceof DelaiCalcul ? "délai dépassé" : ex instanceof Error ? ex.message : String(ex);
          etat.failed = { path: rel, error: `Remplacement : ${message}` };
          return "arret" as const;
        }
        if (res === null) return "suivant" as const;
        if (typeof res === "string") {
          skipped.push({ path: rel, reason: res });
          return "suivant" as const;
        }
        const ancien = lu as Buffer;
        const nouveau = Buffer.from(res.nouveau ?? "", "utf-8");
        const delta = nouveau.length - ancien.length;
        if (qMb > 0 && delta > 0 && utilise + delta > quotaOctets) {
          etat.failed = { path: rel, error: `Quota sandbox dépassé (${qMb} Mo)` };
          return "arret" as const;
        }
        let r: Dict;
        try {
          r = await agent.write(rel, nouveau, { ifSha256: sha256Bytes(ancien) });
        } catch (ex) {
          if (!estErreurAgent(ex)) throw ex;
          if (ex.code === "changed") {
            skipped.push({ path: rel, reason: "modifié pendant l'opération" });
            return "suivant" as const;
          }
          etat.failed = { path: rel, error: detailTexte(agentHttp(ex, "Remplacement")) };
          return "arret" as const;
        }
        return { r, ancien, nouveau, delta, n: res.n };
      });
      if (issue === "arret") break;
      if (issue === "suivant") continue;
      bumpSandboxUsage(uid, issue.delta);
      utilise += issue.delta;
      await histEcrire(uid, rel, issue.ancien, issue.nouveau, "replace");
      done.push({
        path: rel,
        count: issue.n,
        mtime: veritePy(getPy(issue.r, "mtime_ns")) ? mtimeF(getPy(issue.r, "mtime_ns")) : null,
        sha256: sha256Bytes(issue.nouveau),
      });
    }
  });
  const sortie: Dict = {
    files: done,
    total: done.reduce((n, f) => n + (f["count"] as number), 0),
    truncated: false,
    skipped,
  };
  if (etat.failed) sortie["failed"] = etat.failed;
  return sortie;
}

/** `str(agent_http(ex, …).detail)`. */
function detailTexte(e: HttpError): string {
  return typeof e.detail === "string" ? e.detail : reprPy(e.detail);
}

async function remplacer(ctx: ContexteFichiers, q: FastifyRequest): Promise<Dict> {
  const uid = uidDe(q);
  const d = corps(q);
  const query = ou(d, "query", "");
  if (typeof query !== "string" || !query) throw new HttpError(400, "Query vide");
  if (longueurPy(query) > 1000) throw new HttpError(400, "Query trop longue (max 1000 caractères)");
  const remplacement = getPy(d, "replacement");
  if (typeof remplacement !== "string") throw new HttpError(400, "replacement (texte) requis");
  if (longueurPy(remplacement) > REPLACE_MAX_REPLACEMENT)
    throw new HttpError(400, "Texte de remplacement trop long (10 000 caractères max)");
  const regex = veritePy(getPy(d, "regex", false));
  const sensible = veritePy(getPy(d, "case_sensitive", false));
  const caches = veritePy(getPy(d, "include_hidden", false));
  const motifBrut = ou(d, "glob", "");
  const aperçuSeul = veritePy(getPy(d, "dry_run", false));
  const seuls = getPy(d, "paths");
  if (veritePy(motifBrut) && (typeof motifBrut !== "string" || longueurPy(motifBrut) > 200))
    throw new HttpError(400, "glob invalide");
  if (!aperçuSeul) {
    if (!(Array.isArray(seuls) && seuls.length && seuls.every((p) => typeof p === "string")))
      throw new HttpError(400, "paths requis pour appliquer");
    if (seuls.length > REPLACE_MAX_FILES)
      throw new HttpError(400, `Trop de fichiers (${REPLACE_MAX_FILES} max par application)`);
  }
  const spec: SpecRemplacement = { query, replacement: remplacement, regex, caseSensitive: sensible };
  const prepare = preparerRemplaceur(spec);
  if ("erreur" in prepare) throw new HttpError(400, prepare.erreur);
  const agent = await parAgent("Remplacement", () => ctx.bac.agent(uid));
  const motif = motifBrut as string;
  return avecFilCalcul((fil) =>
    aperçuSeul
      ? apercu(fil, agent, spec, caches, motif)
      : appliquer(fil, ctx, uid, agent, spec, seuls as string[], caches, motif),
  );
}

export function routesRecherche(ctx: ContexteFichiers): DefinitionRoute[] {
  return [
    route("/api/sandbox/grep", async (q, r) => reponseJson(r, await rechercher(ctx, q))),
    route("/api/sandbox/replace", async (q, r) => reponseJson(r, await remplacer(ctx, q))),
  ];
}
