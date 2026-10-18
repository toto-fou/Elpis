// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/lecture.ts — routes de lecture de l'éditeur (routes_files.py) : arbre, quota, service et téléchargement des fichiers, recherche par nom ou contenu, archives, état des onglets, historique de session, texte d'un .docx. */
import { estErreurAgent, PANNES_AGENT, sandboxUsageBytes } from "@elpis/bac";
import {
  arrondiPy,
  estDict,
  FlottantPy,
  getPy,
  guessTypePy,
  HttpError,
  lowerPy,
  poserCle,
  pyJsonLoadsOctets,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { agentHttp, fileEntry, getBlob, sessionInfo, sha256Bytes } from "@elpis/fichiers";
import type { AgentClient } from "@elpis/fichiers";
import { entrees, py } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { fichierAgent, reponseAgent, typeAvecCharset } from "../reponse-agent";
import { DOWNLOAD_SHA_MAX, entetesTelechargement, etatAgent, nsDe, ouvrirArchive, relayer } from "./aides";
import { avecFilCalcul, DelaiCalcul } from "./calcul-execution";
import {
  arbre,
  entierDe,
  mtimeS,
  parAgent,
  reponseJson,
  relEditeur,
  sansCache,
  statUn,
  TREE_MAX_ENTRIES,
  uidDe,
} from "./commun";
import type { ContexteFichiers } from "./commun";
import { quotaMb } from "./quota";

const MIO = 1024 * 1024;
const CHECK_SHA_MAX = 2 * MIO;
const CHECK_MAX_FILES = 500;
const SAVE_MTIME_EPS = 0.0005;
const SHA_RE = /^[0-9a-f]{64}\n?$/u;
const ZIP_DIR_MAX_BYTES = 1024 * MIO;
const ZIP_DIR_MAX_FILES = 20_000;
const DOCX_MAX_BYTES = 10 * MIO;
const SKIP_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".bin",
  ".exe",
  ".so",
  ".pyc",
  ".db",
  ".sqlite",
]);

/** Nom final d'un chemin POSIX (`PurePosixPath(p).name`). */
export function nomDe(p: string): string {
  const parties = p.split("/").filter((x) => x !== "" && x !== ".");
  return parties[parties.length - 1] ?? "";
}

/** `PurePosixPath(p).suffix` (Python 3.13). */
export function suffixeDe(p: string): string {
  const nom = nomDe(p);
  const i = nom.lastIndexOf(".");
  return i > 0 && i < nom.length - 1 ? nom.slice(i) : "";
}

/** `isinstance(v, int) and not isinstance(v, bool)`. */
export function estEntierStrict(v: unknown): v is number | bigint {
  return typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v));
}

/** `isinstance(v, (int, float)) and not isinstance(v, bool)` (un `float` lu du JSON est un `number` ou un `FlottantPy`). */
export function estNombre(v: unknown): v is number | bigint | FlottantPy {
  return typeof v === "number" || typeof v === "bigint" || v instanceof FlottantPy;
}

export function valeurNombre(v: number | bigint | FlottantPy): number {
  return v instanceof FlottantPy ? v.valeur : Number(v);
}

/** `s[a:b]` de Python sur les points de code (bornes négatives comptées depuis la fin). */
export function tranchePy(s: string, a: number, b: number): string {
  const c = Array.from(s);
  const n = c.length;
  const borne = (x: number): number => (x < 0 ? Math.max(0, n + x) : Math.min(n, x));
  return c.slice(borne(a), borne(b)).join("");
}

/** `round(min(x, 100), 1)` : l'entier 100 au-delà du quota, sinon un flottant. */
function pourcentage(x: number): number | FlottantPy {
  return x > 100 ? 100 : new FlottantPy(arrondiPy(x, 1));
}

function routeLecture(
  methode: "GET" | "POST",
  chemin: string,
  traiter: (q: FastifyRequest, r: FastifyReply) => Promise<unknown>,
): DefinitionRoute {
  return { methode, chemin, processus: ["toolhost"], acces: "enveloppe", traiter };
}

async function agentDe(ctx: ContexteFichiers, uid: number, libelle: string): Promise<AgentClient> {
  return parAgent(libelle, () => ctx.bac.agent(uid));
}

/** `_lecture_stable` : `[octets, stat]` d'un fichier ≤ 64 Mio lu d'un seul tenant, sinon `null` (trop gros, illisible, réécrit à chaque essai). */
async function lectureStable(agent: AgentClient, rel: string, essais = 3): Promise<[Buffer, Dict] | null> {
  for (let i = 0; i < essais; i++) {
    let lu;
    let apres: Dict;
    try {
      lu = await agent.read(rel, { maxBytes: DOWNLOAD_SHA_MAX });
      const e = await agent.stat([rel]);
      if (e.length !== 1 || e[0] === undefined) throw new Error("not enough values to unpack");
      apres = e[0];
    } catch (e) {
      if (!estErreurAgent(e)) throw e;
      if (e.code === "transport" || e.code === "changed") continue;
      if (PANNES_AGENT.includes(e.code)) throw agentHttp(e, "Téléchargement");
      return null;
    }
    const st = lu.stat;
    if (
      getPy(apres, "kind") === "file" &&
      lu.data.length === Number(getPy(st, "size") ?? -1) &&
      ["ino", "size", "mtime_ns"].every((k) => egalJson(getPy(apres, k), getPy(st, k)))
    )
      return [lu.data, st];
  }
  return null;
}

/** Égalité de deux valeurs lues du JSON (entiers exacts compris). */
function egalJson(a: unknown, b: unknown): boolean {
  if ((typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint"))
    return BigInt(a) === BigInt(b);
  return a === b;
}

/** Aperçu de recherche par contenu centré sur la première occurrence (`api_search_sandbox`). */
export function apercuRecherche(h: Dict, apercu = 120): Dict {
  const fenetre = String(getPy(h, "text"));
  const col = Number(entierDe(h, "col") || 1);
  const decalage = col - 1 - entierDe(h, "match_start");
  const longueur = Array.from(fenetre).length;
  const entiere = decalage === 0 && longueur - entierDe(h, "match_end") < apercu;
  let preview = stripPy(fenetre);
  if (!entiere || Array.from(preview).length > apercu) {
    const debut = Math.max(0, col - 40);
    preview =
      (debut > 0 ? "…" : "") + stripPy(tranchePy(fenetre, debut - decalage, debut - decalage + apercu)) + "…";
  }
  const f = String(getPy(h, "file"));
  return { path: f, name: f.slice(f.lastIndexOf("/") + 1), line: getPy(h, "line"), col, preview };
}

/** `api_sandbox_check_mtimes` : états connus du front comparés au disque, empreintes demandées seulement si utiles (appels passifs). */
async function verifierEtats(ctx: ContexteFichiers, uid: number, corps: unknown): Promise<Dict> {
  const fichiersBruts = estDict(corps) ? getPy(corps, "files") : null;
  if (!Array.isArray(fichiersBruts)) throw new HttpError(400, "files doit être une liste");
  const truncated = fichiersBruts.length > CHECK_MAX_FILES;
  const fichiers = fichiersBruts.slice(0, CHECK_MAX_FILES);
  const racine = await ctx.bac.racine(uid);
  const demandes: {
    path: string;
    rel: string;
    mtime: number;
    taille: number | bigint | null;
    sha: string | null;
  }[] = [];
  for (const item of fichiers) {
    if (!estDict(item)) continue;
    const p = getPy(item, "path");
    const m = getPy(item, "mtime");
    if (typeof p !== "string" || Array.from(p).length > 1024) continue;
    if (!estNombre(m)) continue;
    const t = getPy(item, "size");
    const s = getPy(item, "sha256");
    const sha = typeof s === "string" && SHA_RE.test(lowerPy(s)) ? lowerPy(s) : null;
    let rel: string;
    try {
      rel = relEditeur(racine, p);
    } catch (e) {
      if (e instanceof HttpError) continue;
      throw e;
    }
    demandes.push({ path: p, rel, mtime: valeurNombre(m), taille: estEntierStrict(t) ? t : null, sha });
  }
  if (!demandes.length) return { stale: [], truncated };
  const agent = await agentDe(ctx, uid, "Vérification");
  const etats = await parAgent("Vérification", () =>
    agent.stat(
      demandes.map((d) => d.rel),
      { passive: true },
    ),
  );
  type Ligne = Dict & { _changed?: boolean; _sha?: string | null };
  const stale: Ligne[] = [];
  const aHacher: [number, string][] = [];
  demandes.forEach((d, n) => {
    const e = etats[n];
    if (e === undefined) return;
    const kind = getPy(e, "kind");
    if (kind === "missing" || (kind === "error" && getPy(e, "error") === "not_dir")) {
      stale.push({ path: d.path, missing: true });
      return;
    }
    if (kind === "error") {
      stale.push({ path: d.path, unreadable: true });
      return;
    }
    if (kind !== "file") {
      stale.push({ path: d.path, not_file: true });
      return;
    }
    const taille = entierDe(e, "size");
    const mtime = mtimeS(nsDe(e));
    const change =
      Math.abs(mtime - d.mtime) > SAVE_MTIME_EPS ||
      (d.taille !== null && BigInt(d.taille) !== BigInt(taille));
    if (taille <= CHECK_SHA_MAX && (change || d.sha !== null)) aHacher.push([stale.length, d.rel]);
    stale.push({
      path: d.path,
      new_mtime: new FlottantPy(mtime),
      size: taille,
      sha256: null,
      _changed: change,
      _sha: d.sha,
    });
  });
  if (aHacher.length) {
    const empreintes = await parAgent("Vérification", () =>
      agent.stat(
        aHacher.map(([, r]) => r),
        { hash: true, hashMax: CHECK_SHA_MAX, passive: true },
      ),
    );
    aHacher.forEach(([n], i) => {
      const e = empreintes[i];
      const d = stale[n];
      if (e === undefined || d === undefined) return;
      const brut = getPy(e, "kind") === "file" ? getPy(e, "sha256") : null;
      const sha = brut === null || brut === undefined ? null : brut;
      if (sha === null) {
        if (!d._changed) stale[n] = { path: d["path"], unreadable: true };
        return;
      }
      d["sha256"] = sha;
      if (!d._changed && d._sha !== null && d._sha !== undefined) d._changed = sha !== d._sha;
    });
  }
  const rendu: Dict[] = [];
  for (const d of stale) {
    if ("_changed" in d) {
      if (!d._changed) continue;
      const { _changed: _c, _sha: _s, ...reste } = d;
      rendu.push(reste);
      continue;
    }
    rendu.push(d);
  }
  return { stale: rendu, truncated };
}

export function routesLecture(ctx: ContexteFichiers): DefinitionRoute[] {
  return [
    routeLecture("GET", "/api/sandbox/tree", async (q, r) => {
      const { include_hidden } = entrees(q, { query: { include_hidden: py.bool().defaut(false) } }).query;
      const uid = uidDe(q);
      const racine = await ctx.bac.racine(uid);
      const agent = await agentDe(ctx, uid, "Arborescence");
      const liste = await parAgent("Arborescence", () =>
        agent.list("", {
          depth: 41,
          maxEntries: TREE_MAX_ENTRIES,
          hidden: include_hidden,
          deadlineS: 10,
          kinds: ["dir", "file", "other"],
        }),
      );
      return reponseJson(r.header("cache-control", "no-cache"), {
        root: nomDe(racine),
        items: arbre(liste.entries),
        truncated: liste.truncated,
        max_entries: TREE_MAX_ENTRIES,
      });
    }),
    routeLecture("GET", "/api/sandbox/quota", async (q, r) => {
      const uid = uidDe(q);
      const racine = await ctx.bac.racine(uid);
      const qMb = await quotaMb(ctx.rappel, uid);
      const utilise = await sandboxUsageBytes(uid, racine);
      const usedMb = arrondiPy(utilise / MIO, 2);
      const quotaOctets = qMb > 0 ? qMb * MIO : 0;
      return reponseJson(r, {
        used_mb: new FlottantPy(usedMb),
        quota_mb: qMb,
        pct: qMb > 0 ? pourcentage((usedMb / qMb) * 100) : 0,
        used_bytes: utilise,
        quota_bytes: quotaOctets,
        remaining_bytes: qMb > 0 ? Math.max(0, quotaOctets - utilise) : null,
      });
    }),
    routeLecture("GET", "/api/sandbox/serve/*", async (q, r) => {
      const { path } = entrees(q, { path: { path: py.str().alias("*") } }).path;
      const uid = uidDe(q);
      const trouve = await fichierAgent(await ctx.bac.racine(uid), () => agentDe(ctx, uid, "Lecture"), path);
      if (trouve === null) throw new HttpError(404, "Not found");
      const [agent, rel, e] = trouve;
      return reponseAgent(q, r, agent, rel, e, guessTypePy(nomDe(rel))[0] || "text/plain");
    }),
    routeLecture("GET", "/api/sandbox/search", async (q, r) => {
      const { q: texte, mode } = entrees(q, {
        query: { q: py.str(), mode: py.str().defaut("content") },
      }).query;
      const uid = uidDe(q);
      if (!texte) return reponseJson(r, { items: [] });
      const agent = await agentDe(ctx, uid, "Recherche");
      const echeance = performance.now() + 3000;
      const maxHits = 200;
      if (mode === "name") {
        const liste = await parAgent("Recherche", () =>
          agent.list("", {
            depth: 4096,
            maxEntries: maxHits,
            hidden: true,
            deadlineS: 3.0,
            nameContains: texte,
            kinds: ["file", "other"],
          }),
        );
        const items = liste.entries.map((e) => {
          const p = String(e["path"]);
          return { path: p, name: p.slice(p.lastIndexOf("/") + 1), type: "file" };
        });
        return reponseJson(r, { items, errors: liste.errors, truncated: liste.truncated });
      }
      const maxFile = 512 * 1024;
      const maxScanned = 5000;
      const apercu = 120;
      const [liste, trouves, bilan, tronque] = await parAgent("Recherche", async () => {
        const l = await agent.list("", {
          depth: 4096,
          maxEntries: 50_000,
          hidden: true,
          prune: [".*", "node_modules", "__pycache__"],
          deadlineS: 3.0,
          kinds: ["file"],
        });
        let fichiers = l.entries
          .filter(
            (e) => entierDe(e, "size") <= maxFile && !SKIP_EXTS.has(lowerPy(suffixeDe(String(e["path"])))),
          )
          .map((e) => String(e["path"]));
        const t = l.truncated || fichiers.length > maxScanned;
        fichiers = fichiers.slice(0, maxScanned);
        const [tr, bi] = fichiers.length
          ? await agent.grep(fichiers, texte, {
              ignoreCase: true,
              maxFileBytes: maxFile,
              maxHits,
              context: apercu,
              deadlineS: Math.max(0.5, (echeance - performance.now()) / 1000),
            })
          : [[], {}];
        return [l, tr, bi, t] as const;
      });
      const truncated =
        tronque || veritePy(getPy(bilan, "hits_truncated")) || veritePy(getPy(bilan, "timed_out"));
      const items = trouves.map((h) => apercuRecherche(h, apercu));
      return reponseJson(r, { items, errors: liste.errors, truncated });
    }),
    routeLecture("GET", "/api/sandbox/download", async (q, r) => {
      const { path } = entrees(q, { query: { path: py.str() } }).query;
      const uid = uidDe(q);
      const racine = await ctx.bac.racine(uid);
      const rel = relEditeur(racine, path);
      const agent = await agentDe(ctx, uid, "Téléchargement");
      let e = await statUn(agent, rel, "Téléchargement");
      if (getPy(e, "kind") === "dir") {
        const nom = nomDe(rel) || nomDe(racine);
        const flux = await ouvrirArchive(
          agent,
          [rel],
          "Archive",
          `Dossier trop volumineux pour une archive (> ${ZIP_DIR_MAX_BYTES / MIO} Mo ou ${ZIP_DIR_MAX_FILES} fichiers) — téléchargez-le par parties.`,
          { base: rel, prefix: nom, format: "zip", maxBytes: ZIP_DIR_MAX_BYTES, maxFiles: ZIP_DIR_MAX_FILES },
        );
        return relayer(r, flux, `${nom}.zip`, "application/zip", ctx.journal);
      }
      if (getPy(e, "kind") !== "file") {
        if (getPy(e, "outside")) throw new HttpError(403, "Access denied");
        throw new HttpError(404, "Not found");
      }
      const nom = nomDe(rel);
      const mt = guessTypePy(nom)[0] || "text/plain";
      if (q.headers["range"] === undefined && entierDe(e, "size") <= DOWNLOAD_SHA_MAX) {
        const lu = await lectureStable(agent, rel);
        if (lu !== null) {
          const [donnees, st] = lu;
          return r
            .headers({
              "content-type": typeAvecCharset(mt),
              "x-sha256": sha256Bytes(donnees),
              ...entetesTelechargement(nom, st, "X-Mtime, X-Sha256, X-Size"),
            })
            .send(donnees);
        }
        e = await statUn(agent, rel, "Téléchargement");
        if (getPy(e, "kind") !== "file") throw new HttpError(404, "Not found");
      }
      return reponseAgent(q, r, agent, rel, e, mt, (servie) =>
        entetesTelechargement(nom, servie, "X-Mtime, X-Size"),
      );
    }),
    routeLecture("POST", "/api/sandbox/download-multi", async (q, r) => {
      const uid = uidDe(q);
      const racine = await ctx.bac.racine(uid);
      let corps: unknown;
      try {
        corps = pyJsonLoadsOctets(q.corpsBrut);
      } catch {
        throw new HttpError(400, "Invalid JSON body");
      }
      const chemins = estDict(corps) ? getPy(corps, "paths") : null;
      if (!Array.isArray(chemins) || !chemins.length)
        throw new HttpError(400, "Missing 'paths' (non-empty list expected)");
      if (chemins.length > 500) throw new HttpError(413, "Too many paths (max 500)");
      const rels: string[] = [];
      for (const brut of chemins)
        if (typeof brut === "string" && brut)
          try {
            rels.push(relEditeur(racine, brut));
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
          }
      if (rels.length) {
        const agent = await agentDe(ctx, uid, "Archive");
        const flux = await ouvrirArchive(agent, rels, "Archive", "", {
          format: "zip",
          walk: false,
          strict: false,
          maxBytes: 200 * MIO,
          maxFiles: 500,
        });
        const n = getPy(flux.debut, "files");
        if (veritePy(n))
          return relayer(r, flux, "files.zip", "application/zip", ctx.journal, {
            "x-files-zipped": String(n),
          });
        await flux.fermer();
      }
      throw new HttpError(404, "No file could be added to the archive");
    }),
    routeLecture("GET", "/api/sandbox/read-docx", async (q, r) => {
      const { path } = entrees(q, { query: { path: py.str() } }).query;
      const uid = uidDe(q);
      if (!path || Array.from(path).length > 1024) throw new HttpError(400, "Path invalide");
      const rel = relEditeur(await ctx.bac.racine(uid), path);
      if (!lowerPy(rel).endsWith(".docx")) throw new HttpError(400, "Pas un fichier .docx");
      const agent = await agentDe(ctx, uid, "Lecture");
      const e = await statUn(agent, rel, "Lecture");
      if (getPy(e, "kind") !== "file") throw new HttpError(404, "Fichier introuvable");
      const taille = entierDe(e, "size");
      const trop = (): HttpError => new HttpError(413, `Fichier trop gros (max ${DOCX_MAX_BYTES / MIO} MB)`);
      if (taille > DOCX_MAX_BYTES) throw trop();
      let donnees: Buffer;
      try {
        donnees = (await agent.read(rel, { maxBytes: DOCX_MAX_BYTES })).data;
      } catch (ex) {
        if (!estErreurAgent(ex)) throw ex;
        if (ex.code === "too_large") throw trop();
        if (["not_found", "is_dir", "not_file"].includes(ex.code))
          throw new HttpError(404, "Fichier introuvable");
        throw agentHttp(ex, "Lecture");
      }
      let texte: string;
      try {
        texte = await avecFilCalcul((fil) => fil.docx(donnees));
      } catch (ex) {
        if (ex instanceof DelaiCalcul) throw new HttpError(504, "Lecture .docx trop longue (délai dépassé)");
        throw ex;
      }
      return reponseJson(r, {
        path,
        text: texte,
        size: taille,
        read_only: true,
        format: "docx",
      });
    }),
    routeLecture("POST", "/api/sandbox/check-mtimes", async (q, r) => {
      const uid = uidDe(q);
      let corps: unknown;
      try {
        corps = pyJsonLoadsOctets(q.corpsBrut);
      } catch {
        throw new HttpError(400, "JSON requis");
      }
      return reponseJson(r, await verifierEtats(ctx, uid, corps));
    }),
    routeLecture("GET", "/api/sandbox/history", async (q, r) => {
      return reponseJson(sansCache(r), await sessionInfo(uidDe(q)));
    }),
    routeLecture("GET", "/api/sandbox/history/file", async (q, r) => {
      const { path } = entrees(q, { query: { path: py.str().defaut("") } }).query;
      const uid = uidDe(q);
      if (!path || Array.from(path).length > 1024) throw new HttpError(400, "Chemin requis");
      const ent = await fileEntry(uid, path);
      if (!ent) throw new HttpError(404, "Aucun historique pour ce fichier");
      let courant: Dict = { exists: false, sha256: null, size: null, mtime: null };
      let rel: string | null;
      try {
        rel = relEditeur(await ctx.bac.racine(uid), path);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        rel = null;
      }
      if (rel !== null) {
        const agent = await agentDe(ctx, uid, "Lecture");
        const st = await etatAgent(agent, rel, DOWNLOAD_SHA_MAX);
        if (st.kind === "file")
          courant = { exists: true, sha256: st.sha256, size: st.size, mtime: new FlottantPy(st.mtime) };
      }
      poserCle(ent, "current", courant);
      return reponseJson(sansCache(r), ent);
    }),
    routeLecture("GET", "/api/sandbox/history/blob", async (q, r) => {
      const { sha } = entrees(q, { query: { sha: py.str().defaut("") } }).query;
      const donnees = await getBlob(uidDe(q), lowerPy(sha || ""));
      if (donnees === null) throw new HttpError(404, "Version introuvable");
      let mt = "text/plain; charset=utf-8";
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(donnees);
      } catch {
        mt = "application/octet-stream";
      }
      return r
        .headers({
          "content-type": mt,
          "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff",
        })
        .send(donnees);
    }),
  ];
}
