// SPDX-License-Identifier: MIT
/** apps/toolhost/src/git/routes.ts — routes Git de l'éditeur (sandbox/routes_git.py) : git par l'agent du conteneur, réseau par le relais authentifiant (jeton à l'hôte exact), dépôts du bac. */
import { estErreurAgent } from "@elpis/bac";
import {
  ErreurPython,
  estErreurPython,
  getPy,
  HttpError,
  intPy,
  lowerPy,
  nomTypePy,
  ouPy,
  prefixePy,
  pyJsonLoadsOctets,
  splitlinesPy,
  splitPy,
  stripPy,
  strPy,
  urlsplit,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  agentHttp,
  findRepos,
  pull,
  RelayRefused,
  REMOTE_SCHEMES,
  remoteBlockReason,
  remoteUrl,
  remoteUrls,
  run,
  runNetwork,
} from "@elpis/fichiers";
import type { AgentClient, GitResult } from "@elpis/fichiers";
import { parametreRequete } from "@elpis/http";
import { ErreurCheminBac, lexicalRel, resolveUsername } from "@elpis/securite";
import type { FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { arbre, reponseJson, TREE_MAX_ENTRIES, uidDe, une } from "../fichiers/commun";
import type { ContexteFichiers } from "../fichiers/commun";

/** `_SORTIE` : sortie gardée d'une commande git (diff, show…) ; modifiable par les tests. */
export const reglagesGit = { sortie: 8 << 20 };
/** Opérations réseau et horloge, remplaçables par les tests (comme `monkeypatch` sur `git_ops`). */
export const reseauGit = { runNetwork, pull, remoteBlockReason, maintenant: (): number => Date.now() / 1000 };

const REF_RE = /^[A-Za-z0-9._/@~^+-]{1,255}$/u;
const HASH_RE = /^[0-9a-fA-F]{4,64}$/u;
const NOM_CLONE = /\/([^/]+?)(?:\.git)?\/?$/u;
const TREE_MAX_DEPTH = 40;
const PUSH_GENRES: Readonly<Record<string, string>> = {
  " ": "maj",
  "*": "maj",
  "+": "force",
  "-": "suppr",
  "!": "refus",
  "=": "a_jour",
};

/** Dépôt d'une requête : l'agent du bac du compte et son chemin relatif à /work (`""` : la racine). */
interface Depot {
  readonly uid: number;
  readonly agent: AgentClient;
  readonly rel: string;
}

/** `_ref_arg` : nom de branche, remote ou commit venu du client ; jamais une option (« - » en tête). */
export function refArg(valeur: unknown, quoi = "Référence"): string {
  const v = typeof valeur === "string" ? stripPy(valeur) : "";
  if (!v || v.startsWith("-") || !REF_RE.test(v)) throw new HttpError(400, `${quoi} invalide`);
  return v;
}

export function hashArg(valeur: unknown): string {
  const v = typeof valeur === "string" ? stripPy(valeur) : "";
  if (!HASH_RE.test(v)) throw new HttpError(400, "Hash invalide");
  return v;
}

export function pathsArg(paths: unknown): string[] {
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p !== ""))
    throw new HttpError(400, "paths : liste de chemins");
  return paths as string[];
}

/** `_dans_depot` : `p` (relatif au dépôt) en chemin relatif à /work s'il reste dans le dépôt (`..` résolu sur le texte). */
export function dansDepot(rel: string, p: string): string | null {
  if (!p || p.startsWith("/") || p.includes("\0")) return null;
  const parties: string[] = [];
  for (const c of p.split("/")) {
    if (c === "" || c === ".") continue;
    if (c === "..") {
      if (!parties.length) return null;
      parties.pop();
    } else parties.push(c);
  }
  if (!parties.length) return null;
  return (rel ? [rel, ...parties] : parties).join("/");
}

/** `_refs_porcelaine` : refs d'un `push --dry-run --porcelain` rangées par drapeau. */
export function refsPorcelaine(sortie: string): Record<string, string[]> {
  const rendu: Record<string, string[]> = { a_jour: [], force: [], maj: [], refus: [], suppr: [] };
  for (const ligne of splitlinesPy(sortie)) {
    const genre = Object.hasOwn(PUSH_GENRES, ligne.charAt(0)) ? PUSH_GENRES[ligne.charAt(0)] : undefined;
    if (Array.from(ligne).length <= 2 || ligne.charAt(1) !== "\t" || genre === undefined) continue;
    const champ = ligne.slice(2).split("\t", 1)[0] ?? "";
    const dst = champ.slice(champ.lastIndexOf(":") + 1);
    if (dst.startsWith("refs/")) rendu[genre]?.push(dst);
  }
  return rendu;
}

/** Nom du dossier d'un clone d'après son URL (`…/depot.git` → `depot`), « repo » à défaut. */
export function nomDuClone(url: string): string {
  return NOM_CLONE.exec(url)?.[1] ?? "repo";
}

/** `(v or "").strip()` : une valeur non texte lève comme Python (AttributeError, 500). */
function texteNu(v: unknown): string {
  if (!veritePy(v)) return "";
  if (typeof v !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(v)}' object has no attribute 'strip'`);
  return stripPy(v);
}

/** `await request.json()` du Python : JSON invalide levé (500), objet attendu ensuite par `data.get`. */
function corps(requete: FastifyRequest): unknown {
  return pyJsonLoadsOctets(requete.corpsBrut);
}

/** `request.query_params.get(nom, defaut)`. */
function param(q: FastifyRequest, nom: string, defaut = ""): string {
  return parametreRequete(q, nom) ?? defaut;
}

/** `get_username_by_id(uid) or "user"` : nom de l'enveloppe d'identité (l'hôte n'a pas la base des comptes). */
function auteur(uid: number): string {
  const nom = resolveUsername(uid) || "user";
  return `${nom} <${nom}@elpis>`;
}

/** `_relaye` : refus du relais (403 garde, 400 sinon) ou de l'agent en erreur HTTP. */
async function relaye<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (e instanceof RelayRefused) throw new HttpError(e.code === "blocked_remote" ? 403 : 400, e.message);
    if (estErreurAgent(e)) throw agentHttp(e, "Git");
    throw e;
  }
}

/** `_rel` : chemin reçu relatif à /work, sans lire le disque (`~` est un nom) ; hors du bac : 403. */
async function relDe(ctx: ContexteFichiers, uid: number, chemin: unknown): Promise<string> {
  try {
    return lexicalRel(
      await ctx.bac.racine(uid),
      chemin === null || chemin === undefined ? "" : strPy(chemin),
      {
        tilde: false,
      },
    );
  } catch (e) {
    if (e instanceof ErreurCheminBac) throw new HttpError(403, "Chemin hors sandbox");
    throw e;
  }
}

function deux(entrees: readonly Dict[]): [Dict, Dict] {
  const [a, b] = entrees;
  if (entrees.length !== 2 || a === undefined || b === undefined)
    throw new ErreurPython("ValueError", `not enough values to unpack (expected 2, got ${entrees.length})`);
  return [a, b];
}

/** `_depot` : dépôt `repo` du compte, ou la racine si elle en est un ; 400 (pas un dépôt), 403 (hors du bac), 404. */
async function depot(ctx: ContexteFichiers, uid: number, repo: unknown, passive = false): Promise<Depot> {
  const agent = await ctx.bac.agent(uid);
  const rel = veritePy(repo) ? await relDe(ctx, uid, repo) : "";
  const [dossier, marque] = deux(
    await relaye(() => agent.stat([rel, rel ? `${rel}/.git` : ".git"], { passive })),
  );
  if (veritePy(getPy(dossier, "outside")) || getPy(dossier, "error") === "outside_root")
    throw new HttpError(403, "Chemin hors sandbox");
  if (getPy(dossier, "kind") !== "dir") throw new HttpError(404, `Dossier introuvable : ${strPy(repo)}`);
  const genre = getPy(marque, "kind");
  if (genre === "missing" || genre === "error")
    throw new HttpError(
      400,
      veritePy(repo)
        ? `'${strPy(repo)}' n'est pas un dépôt Git`
        : "Paramètre 'repo' requis (chemin du dépôt)",
    );
  return { uid, agent, rel };
}

/** `_git` : `git <args>` dans le dépôt ; échéance → 504. */
async function git(d: Depot, args: readonly string[], o: { timeoutS?: number; passive?: boolean } = {}) {
  const r = await relaye(() =>
    run(d.agent, d.rel, args, {
      timeoutS: o.timeoutS ?? 30,
      maxOut: reglagesGit.sortie,
      passive: o.passive ?? false,
    }),
  );
  if (r.timed_out) throw new HttpError(504, `git ${args[0] ?? ""} : délai dépassé`);
  return r;
}

/** `_auth` : identifiants saisis dans la requête, prioritaires sur le connecteur. */
function auth(data: unknown): [string, string] | null {
  const jeton = texteNu(getPy(data, "cred_token"));
  return jeton ? [texteNu(getPy(data, "cred_user")), jeton] : null;
}

/** `_refus_relais` : requête refusée par le relais (politique, pas authentification) → 409 avec ses motifs. */
function refusRelais(r: GitResult): void {
  if (r.refus.length && !r.ok) throw new HttpError(409, prefixePy(r.refus.join("\n"), 500));
}

function sortieOu(r: GitResult): string {
  return stripPy(r.stderr || r.stdout || "");
}

/** `_reseau` : commande réseau vers `url` par le relais ; échéance → 504, refus du relais → 409. */
async function reseau(
  ctx: ContexteFichiers,
  d: Depot,
  args: readonly string[],
  o: { url: string; data: unknown; pushRefs?: Iterable<string>; timeoutS?: number },
): Promise<GitResult> {
  const a = auth(o.data);
  const r = await relaye(() =>
    reseauGit.runNetwork(d.agent, d.rel, args, {
      uid: d.uid,
      username: resolveUsername(d.uid) ?? "",
      url: o.url,
      source: ctx.rappel,
      ...(o.pushRefs !== undefined ? { pushRefs: o.pushRefs } : {}),
      ...(a ? { auth: a } : {}),
      timeoutS: o.timeoutS ?? 60,
      maxOut: reglagesGit.sortie,
    }),
  );
  if (r.timed_out) throw new HttpError(504, `git ${args[0] ?? ""} : délai dépassé`);
  refusRelais(r);
  return r;
}

/** `_validate_git_url` : 403 si `url` n'est pas un dépôt distant permis. */
async function validerUrl(ctx: ContexteFichiers, url: string, uid: number): Promise<void> {
  if (!url) throw new HttpError(400, "URL manquante");
  const motif = await reseauGit.remoteBlockReason(url, uid, ctx.rappel);
  if (motif) throw new HttpError(403, `URL refusée (anti-SSRF) : ${motif}`);
}

/** `_refs_du_push` : refs que `git push <args>` mettrait à jour d'après git lui-même ; suppression, force non demandée, étiquette réécrite : 409. */
async function refsDuPush(
  ctx: ContexteFichiers,
  d: Depot,
  args: readonly string[],
  o: { url: string; data: unknown; force: boolean },
): Promise<Set<string>> {
  const essai = await reseau(ctx, d, ["push", "--dry-run", "--porcelain", ...args], {
    url: o.url,
    data: o.data,
    pushRefs: [],
  });
  if (essai.returncode !== 0 && essai.returncode !== 1)
    throw new HttpError(400, prefixePy(sortieOu(essai), 500));
  const p = refsPorcelaine(essai.stdout);
  const n = (k: string): string[] => p[k] ?? [];
  if (n("refus").length || (essai.returncode === 1 && !n("maj").length && !n("force").length))
    throw new HttpError(400, prefixePy(sortieOu(essai), 500) || "Push refusé par le dépôt distant");
  if (n("suppr").length)
    throw new HttpError(409, `Relais Git : suppression de ${n("suppr").slice(0, 5).join(", ")} refusée`);
  if (n("force").length && !o.force)
    throw new HttpError(
      409,
      `Relais Git : mise à jour forcée de ${n("force").slice(0, 5).join(", ")} non demandée`,
    );
  const etiquettes = n("force").filter((r) => r.startsWith("refs/tags/"));
  if (etiquettes.length)
    throw new HttpError(
      409,
      `Relais Git : étiquette existante réécrite (${etiquettes.slice(0, 5).join(", ")})`,
    );
  return new Set([...n("maj"), ...n("force")]);
}

/** `_remote_suivi` : remote de la branche courante, sinon origin ; « . » : branche qui suit une branche locale. */
async function remoteSuivi(d: Depot): Promise<string> {
  const b = stripPy((await git(d, ["branch", "--show-current"])).stdout);
  if (b) {
    const r = await git(d, ["config", "--get", `branch.${b}.remote`]);
    const nom = stripPy(r.stdout);
    if (r.ok && nom === ".") return ".";
    if (r.ok && nom) return refArg(nom, "Remote de la branche");
  }
  return "origin";
}

/** `_mode_pull` : « Pull (rebase) » rebase ; « Pull » suit `pull.rebase`/`pull.ff` du dépôt, avance rapide seule par défaut. */
async function modePull(d: Depot, rebase: boolean): Promise<string> {
  if (rebase) return "--rebase";
  const b = stripPy((await git(d, ["branch", "--show-current"])).stdout);
  let valeur = "";
  for (const cle of [...(b ? [`branch.${b}.rebase`] : []), "pull.rebase"]) {
    const r = await git(d, ["config", "--get", cle]);
    if (r.ok && stripPy(r.stdout)) {
      valeur = lowerPy(stripPy(r.stdout));
      break;
    }
  }
  if (["true", "merges", "interactive", "i", "m", "1", "yes", "on"].includes(valeur)) return "--rebase";
  const ff = await git(d, ["config", "--get", "pull.ff"]);
  const ffv = ff.ok ? lowerPy(stripPy(ff.stdout)) : "";
  if (ffv === "only") return "--ff-only";
  if (
    ["false", "0", "no", "off"].includes(valeur) ||
    ["false", "0", "no", "off", "true", "1", "yes", "on"].includes(ffv)
  )
    return "--no-rebase";
  return "--ff-only";
}

const DECODEUR = new TextDecoder("utf-8", { ignoreBOM: true });

/** `_branches_courantes` : `.git/HEAD` lus en une requête, `git branch --show-current` quand HEAD n'est pas un fichier du dépôt. */
async function branchesCourantes(
  agent: AgentClient,
  depots: readonly string[],
): Promise<Map<string, string>> {
  const tetes = new Map(depots.map((p) => [p, p ? `${p}/.git/HEAD` : ".git/HEAD"] as const));
  const lus = await agent.readMany([...tetes.values()], { maxFile: 4096, maxTotal: 1 << 20, passive: true });
  const rendu = new Map<string, string>();
  for (const [p, f] of tetes) {
    const brut = lus.get(f) ?? null;
    if (brut !== null) {
      const t = stripPy(DECODEUR.decode(brut));
      rendu.set(p, t.startsWith("ref: refs/heads/") ? t.slice("ref: refs/heads/".length) : "");
    } else {
      const r = await run(agent, p, ["branch", "--show-current"], {
        timeoutS: 10,
        maxOut: 4096,
        passive: true,
      });
      rendu.set(p, r.ok ? stripPy(r.stdout) : "");
    }
  }
  return rendu;
}

/** Ligne de status porcelaine conflictuelle (UU, AA, DD, AU, UA, DU, UD). */
function enConflit(cars: readonly string[]): boolean {
  return cars[0] === "U" || cars[1] === "U" || ["AA", "DD"].includes(cars.slice(0, 2).join(""));
}

/** `int(x) if x != "-" else 0` d'une colonne de `--numstat`. */
function compte(x: string): number {
  return x !== "-" ? intPy(x) : 0;
}

/** Lignes `ajouts\tsuppressions\tchemin` de `--numstat` par chemin. */
function numstat(sortie: string): Map<string, { add: number; del: number }> {
  const m = new Map<string, { add: number; del: number }>();
  for (const ligne of splitlinesPy(sortie)) {
    const parts = ligne.split("\t");
    if (parts.length >= 3)
      m.set(parts[2] as string, {
        add: intPy(parts[0] !== "-" ? (parts[0] as string) : "0"),
        del: intPy(parts[1] !== "-" ? (parts[1] as string) : "0"),
      });
  }
  return m;
}

/** `_parents_sans_lien` : aucun dossier entre le dépôt et `cible` n'est un lien (l'agent suit ceux des parents). */
async function parentsSansLien(d: Depot, cible: string): Promise<boolean> {
  const base = d.rel ? `${d.rel}/` : "";
  const parties = cible.slice(base.length).split("/").slice(0, -1);
  const parents = parties.map((_, i) => base + parties.slice(0, i + 1).join("/"));
  if (!parents.length) return true;
  const entrees = await relaye(() => d.agent.stat(parents));
  return entrees.every((e) => getPy(e, "kind") === "dir" && !veritePy(getPy(e, "link")));
}

const STATUS_ARGS: readonly (readonly string[])[] = [
  ["branch", "--show-current"],
  ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
  ["status", "--porcelain=v1", "-uall"],
  ["remote", "get-url", "origin"],
  ["diff", "--cached", "--numstat"],
  ["diff", "--numstat"],
];

async function statut(ctx: ContexteFichiers, uid: number, repo: string): Promise<Dict> {
  let d: Depot;
  try {
    d = await depot(ctx, uid, repo, true);
  } catch (e) {
    if (e instanceof HttpError && [400, 403, 404].includes(e.statusCode)) return { is_repo: false };
    throw e;
  }
  const [branche, ab, st, remote, ns, ns2] = (await Promise.all(
    STATUS_ARGS.map((a) => git(d, a, { passive: true })),
  )) as [GitResult, GitResult, GitResult, GitResult, GitResult, GitResult];
  let [ahead, behind] = [0, 0];
  if (ab.returncode === 0) {
    const parts = splitPy(stripPy(ab.stdout));
    if (parts.length === 2) [ahead, behind] = [intPy(parts[0]), intPy(parts[1])];
  }
  const staged: Dict[] = [];
  const modified: Dict[] = [];
  const untracked: Dict[] = [];
  const conflicted: Dict[] = [];
  for (const ligne of splitlinesPy(st.stdout)) {
    const cars = Array.from(ligne);
    if (cars.length < 4) continue;
    const [x, y] = [cars[0] as string, cars[1] as string];
    let fpath = cars.slice(3).join("");
    if (fpath.includes(" -> ")) fpath = fpath.split(" -> ").at(-1) as string;
    if (enConflit(cars)) {
      conflicted.push({ path: fpath, status: cars.slice(0, 2).join("") });
      continue;
    }
    if (["A", "M", "D", "R", "C"].includes(x)) staged.push({ path: fpath, status: x });
    if (y === "M" || y === "D") modified.push({ path: fpath, status: y });
    else if (y === "?" && x === "?") untracked.push({ path: fpath });
  }
  const remoteUrlTexte = remote.returncode === 0 ? stripPy(remote.stdout) : "";
  const index = numstat(ns.stdout);
  const arbreDeTravail = numstat(ns2.stdout);
  for (const [liste, stats] of [
    [staged, index],
    [modified, arbreDeTravail],
  ] as const)
    for (const f of liste) {
      const s = stats.get(f["path"] as string);
      f["add"] = s?.add ?? 0;
      f["del"] = s?.del ?? 0;
    }
  return {
    is_repo: true,
    repo: repo || ".",
    branch: stripPy(branche.stdout) || "(HEAD détaché)",
    ahead,
    behind,
    remote_url: remoteUrlTexte,
    staged,
    modified,
    untracked,
    conflicted,
    truncated: st.truncated,
  };
}

/** Fichiers en conflit d'un status porcelaine (règle de `api_git_merge`, précédence du Python comprise). */
function conflitsDeFusion(sortie: string): string[] {
  const rendu: string[] = [];
  for (const ligne of splitlinesPy(sortie)) {
    const cars = Array.from(ligne);
    if (
      (cars.length >= 4 && cars[0] === "U") ||
      (cars.length >= 4 && cars[1] === "U") ||
      ["AA", "DD"].includes(cars.slice(0, 2).join(""))
    )
      rendu.push(cars.slice(3).join(""));
  }
  return rendu;
}

function conflitsDuStatus(sortie: string): string[] {
  return splitlinesPy(sortie)
    .map((l) => Array.from(l))
    .filter((cars) => cars.length >= 4 && enConflit(cars))
    .map((cars) => cars.slice(3).join(""));
}

function message(r: GitResult, n = 200): string {
  return prefixePy(stripPy(r.stdout || r.stderr), n);
}

export function routesGit(ctx: ContexteFichiers): DefinitionRoute[] {
  const route = (
    methode: "GET" | "POST",
    nom: string,
    traiter: (q: FastifyRequest, uid: number) => Promise<unknown>,
  ): DefinitionRoute => ({
    methode,
    chemin: `/api/sandbox/git/${nom}`,
    processus: ["toolhost"],
    acces: "enveloppe",
    traiter: async (q, r) => reponseJson(r, await traiter(q, uidDe(q))),
  });
  const avecDepot = (nom: string, traiter: (d: Depot, data: unknown) => Promise<unknown>): DefinitionRoute =>
    route("POST", nom, async (q, uid) => {
      const data = corps(q);
      return traiter(await depot(ctx, uid, getPy(data, "repo", "")), data);
    });

  return [
    route("GET", "repos", async (_q, uid) => {
      const agent = await ctx.bac.agent(uid);
      let depots: string[];
      let branches: Map<string, string>;
      try {
        const racine = une(await agent.stat([".git"], { passive: true }));
        depots = (await findRepos(agent, { depth: 2, limit: 500, passive: true })).filter(
          (p) => !p.split("/").some((c) => c.startsWith(".")),
        );
        const genre = getPy(racine, "kind");
        if (genre === "dir" || genre === "file") depots.unshift("");
        branches = await branchesCourantes(agent, depots);
      } catch (e) {
        if (estErreurAgent(e)) throw agentHttp(e, "Dépôts Git");
        throw e;
      }
      const racine = await ctx.bac.racine(uid);
      const nomRacine = racine.slice(racine.lastIndexOf("/") + 1);
      return {
        repos: depots.map((p) => ({
          path: p || ".",
          name: p ? p.slice(p.lastIndexOf("/") + 1) : nomRacine,
          branch: branches.get(p) || "(HEAD)",
        })),
      };
    }),
    route("GET", "status", (q, uid) => statut(ctx, uid, param(q, "repo"))),
    route("GET", "branches", async (q, uid) => {
      const d = await depot(ctx, uid, param(q, "repo"));
      const r = await git(d, ["branch", "--format=%(refname:short)|%(HEAD)"]);
      const local: string[] = [];
      let current = "";
      for (const ligne of splitlinesPy(r.stdout)) {
        const parts = ligne.split("|");
        const nom = stripPy(parts[0] ?? "");
        if (parts.length > 1 && stripPy(parts[1] ?? "") === "*") current = nom;
        local.push(nom);
      }
      if (!current) current = stripPy((await git(d, ["branch", "--show-current"])).stdout);
      const rr = await git(d, ["branch", "-r", "--format=%(refname:short)"]);
      const remote = splitlinesPy(rr.stdout)
        .filter((b) => stripPy(b) && !b.includes("HEAD"))
        .map(stripPy);
      return { current, local, remote };
    }),
    route("GET", "log", async (q, uid) => {
      const d = await depot(ctx, uid, param(q, "repo"));
      let n: number;
      try {
        n = Math.max(1, Math.min(intPy(param(q, "n", "30")), 100));
      } catch (e) {
        if (estErreurPython(e, "ValueError")) throw new HttpError(400, "n invalide");
        throw e;
      }
      const r = await git(d, ["log", `-${n}`, "--format=%H|%h|%an|%ae|%at|%s"]);
      const commits: Dict[] = [];
      for (const ligne of splitlinesPy(r.stdout)) {
        const p = splitPy(ligne, "|", 5);
        if (p.length >= 6)
          commits.push({
            hash: p[0],
            short: p[1],
            author: p[2],
            email: p[3],
            timestamp: intPy(p[4]),
            message: p[5],
          });
      }
      return { commits };
    }),
    route("GET", "diff", async (q, uid) => {
      const d = await depot(ctx, uid, param(q, "repo"));
      const fichier = param(q, "path");
      const args = ["diff", "--no-color"];
      if (param(q, "staged") === "1") args.push("--cached");
      if (fichier) args.push("--", fichier);
      const r = await git(d, args);
      return { diff: r.stdout, truncated: r.truncated };
    }),
    route("POST", "init", async (q, uid) => {
      const data = corps(q);
      const dir = texteNu(getPy(data, "dir"));
      const agent = await ctx.bac.agent(uid);
      const d: Depot = { uid, agent, rel: dir ? await relDe(ctx, uid, dir) : "" };
      if (d.rel) await relaye(() => d.agent.fsop("mkdir", { path: d.rel, parents: true }));
      const r = await git(d, ["init"]);
      if (r.returncode !== 0) throw new HttpError(500, stripPy(r.stderr));
      const nom = texteNu(getPy(data, "user_name"));
      const email = texteNu(getPy(data, "user_email"));
      if (nom) await git(d, ["config", "user.name", nom]);
      if (email) await git(d, ["config", "user.email", email]);
      return { ok: true, repo: dir || ".", message: stripPy(r.stdout) };
    }),
    route("POST", "clone", async (q, uid) => {
      const data = corps(q);
      const url = texteNu(getPy(data, "url"));
      if (!url) throw new HttpError(400, "URL requise");
      await validerUrl(ctx, url, uid);
      let dir = texteNu(getPy(data, "dir"));
      if (!dir) dir = nomDuClone(url);
      if (dir.includes("/") || dir.includes("\\") || dir.split("/").includes(".."))
        throw new HttpError(400, "Nom de dossier invalide");
      const racine: Depot = { uid, agent: await ctx.bac.agent(uid), rel: "" };
      const rel = await relDe(ctx, uid, dir);
      if (!rel) throw new HttpError(400, "Nom de dossier invalide");
      const cible = une(await relaye(() => racine.agent.stat([rel])));
      const existait = getPy(cible, "kind") !== "missing";
      if (
        existait &&
        (getPy(cible, "kind") !== "dir" ||
          (await relaye(() => racine.agent.list(rel, { depth: 1, maxEntries: 1, hidden: true }))).entries
            .length)
      )
        throw new HttpError(409, `Le dossier '${dir}' existe déjà et n'est pas vide`);
      try {
        const r = await reseau(ctx, racine, ["clone", "--progress", "--", url, rel], {
          url,
          data,
          timeoutS: 120,
        });
        if (r.returncode !== 0) throw new HttpError(400, prefixePy(sortieOu(r), 500));
      } catch (e) {
        if (e instanceof HttpError) {
          try {
            await racine.agent.fsop("remove", { path: rel, recursive: true, missing_ok: true });
            if (existait) await racine.agent.fsop("mkdir", { path: rel, parents: true });
          } catch (ex) {
            if (!estErreurAgent(ex)) throw ex;
          }
        }
        throw e;
      }
      let enregistre = false;
      if (texteNu(getPy(data, "cred_token"))) {
        try {
          enregistre = await ctx.rappel.enregistrerIdentifiantGit(
            { user_id: uid, username: q.identite?.username ?? "" },
            url,
            texteNu(getPy(data, "cred_user")),
            texteNu(getPy(data, "cred_token")),
            texteNu(getPy(data, "provider_type")),
          );
        } catch {
          enregistre = false;
        }
      }
      return { ok: true, repo: dir, message: `Cloné dans ${dir}/`, credentials_saved: enregistre };
    }),
    avecDepot("stage", async (d, data) => {
      const paths = pathsArg(ouPy(getPy(data, "paths"), []));
      const r = await git(d, paths.length ? ["add", "--", ...paths] : ["add", "-A"]);
      if (r.returncode !== 0) throw new HttpError(400, stripPy(r.stderr));
      return { ok: true };
    }),
    avecDepot("unstage", async (d, data) => {
      const paths = pathsArg(ouPy(getPy(data, "paths"), []));
      const r = await git(d, paths.length ? ["reset", "HEAD", "--", ...paths] : ["reset", "HEAD"]);
      if (r.returncode !== 0) throw new HttpError(400, stripPy(r.stderr));
      return { ok: true };
    }),
    avecDepot("discard", async (d, data) => {
      const paths = getPy(data, "paths", []);
      if (!veritePy(paths)) {
        await git(d, ["checkout", "--", "."]);
        await git(d, ["clean", "-fd"]);
      } else
        for (const p of pathsArg(paths)) {
          const cible = dansDepot(d.rel, p);
          if (cible === null) continue;
          const r = await git(d, ["checkout", "--", p]);
          if (r.returncode !== 0 && (await parentsSansLien(d, cible)))
            await relaye(() => d.agent.fsop("remove", { path: cible, recursive: true, missing_ok: true }));
        }
      return { ok: true };
    }),
    avecDepot("commit", async (d, data) => {
      const msg = texteNu(getPy(data, "message"));
      if (!msg) throw new HttpError(400, "Message requis");
      const r = await git(d, ["commit", "-m", msg, "--author", auteur(d.uid)]);
      if (r.returncode !== 0)
        throw new HttpError(400, prefixePy(stripPy(r.stderr) || stripPy(r.stdout), 500));
      return { ok: true, message: prefixePy(stripPy(r.stdout), 200) };
    }),
    avecDepot("push", async (d, data) => {
      const remote = refArg(ouPy(getPy(data, "remote"), "origin"), "Remote");
      let branche = veritePy(getPy(data, "branch")) ? refArg(getPy(data, "branch"), "Branche") : "";
      const url = await relaye(() => remoteUrl(d.agent, d.rel, remote, { push: true }));
      const force = veritePy(getPy(data, "force", false));
      let args = force ? ["--force-with-lease"] : [];
      if (!branche) {
        const amont = await git(d, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
        const config = await git(d, ["config", "--get-all", `remote.${remote}.push`]);
        const courante = stripPy((await git(d, ["branch", "--show-current"])).stdout);
        if (!amont.ok && !stripPy(config.stdout) && courante) {
          branche = refArg(courante, "Branche");
          args = [...args, "--set-upstream"];
        }
      }
      args = [...args, "--end-of-options", remote, ...(branche ? [branche] : [])];
      const refs = await refsDuPush(ctx, d, args, { url, data, force });
      if (!refs.size) return { ok: true, message: "Déjà à jour" };
      const r = await reseau(ctx, d, ["push", ...args], { url, data, pushRefs: refs });
      if (r.returncode !== 0) throw new HttpError(400, prefixePy(sortieOu(r), 500));
      return { ok: true, message: prefixePy(stripPy(r.stderr || r.stdout), 200) };
    }),
    avecDepot("pull", async (d, data) => {
      const mode = await modePull(d, veritePy(getPy(data, "rebase", false)));
      const remote = await remoteSuivi(d);
      const a = auth(data);
      const r = await relaye(() =>
        reseauGit.pull(d.agent, d.rel, remote, "", mode, {
          uid: d.uid,
          username: resolveUsername(d.uid) ?? "",
          source: ctx.rappel,
          timeoutS: 60,
          maxOut: reglagesGit.sortie,
          ...(a ? { auth: a } : {}),
        }),
      );
      if (r.timed_out) throw new HttpError(504, "git pull : délai dépassé");
      refusRelais(r);
      if (r.returncode !== 0) throw new HttpError(400, prefixePy(sortieOu(r), 500));
      return { ok: true, message: message(r) };
    }),
    avecDepot("fetch", async (d) => {
      const ignores: string[] = [];
      for (const nom of splitPy((await git(d, ["remote"])).stdout)) {
        const urls =
          nom.startsWith("-") || !REF_RE.test(nom) ? [] : await relaye(() => remoteUrls(d.agent, d.rel, nom));
        if (urls.length !== 1 || !REMOTE_SCHEMES.includes(urlsplit(urls[0] as string).scheme)) {
          ignores.push(nom);
          continue;
        }
        const r = await reseau(
          ctx,
          d,
          ["fetch", "--prune", "--no-recurse-submodules", "--end-of-options", nom],
          { url: urls[0] as string, data: {} },
        );
        if (r.returncode !== 0) throw new HttpError(400, prefixePy(stripPy(r.stderr || ""), 300));
      }
      return { ok: true, ...(ignores.length ? { skipped: ignores } : {}) };
    }),
    avecDepot("checkout", async (d, data) => {
      const branche = refArg(getPy(data, "branch"), "Branche");
      const args = veritePy(getPy(data, "create", false))
        ? ["checkout", "-b", branche]
        : ["checkout", "--end-of-options", branche];
      const r = await git(d, args);
      if (r.returncode !== 0) throw new HttpError(400, prefixePy(sortieOu(r), 500));
      return { ok: true, message: prefixePy(stripPy(r.stderr || r.stdout), 200) };
    }),
    avecDepot("merge", async (d, data) => {
      const branche = refArg(getPy(data, "branch"), "Branche");
      const strategie = getPy(data, "strategy", "");
      const args = ["merge", "--no-edit"];
      if (strategie === "theirs" || strategie === "ours") args.push("-X", strategie);
      args.push("--end-of-options", branche);
      const r = await git(d, args);
      if (r.returncode === 0)
        return { ok: true, conflicts: false, message: prefixePy(stripPy(r.stdout), 200) };
      const conflits = conflitsDeFusion((await git(d, ["status", "--porcelain=v1"])).stdout);
      if (conflits.length)
        return {
          ok: false,
          conflicts: true,
          conflicted_files: conflits,
          message: `${conflits.length} fichier(s) en conflit`,
        };
      const err = sortieOu(r);
      await git(d, ["merge", "--abort"]);
      throw new HttpError(400, prefixePy(err, 500));
    }),
    avecDepot("merge-abort", async (d) => {
      if ((await git(d, ["merge", "--abort"])).returncode !== 0) await git(d, ["reset", "--hard", "HEAD"]);
      return { ok: true };
    }),
    avecDepot("merge-resolve", async (d, data) => {
      const strategie = getPy(data, "strategy", "theirs");
      if (strategie !== "ours" && strategie !== "theirs")
        throw new HttpError(400, "strategy : ours ou theirs");
      const brut = ouPy(getPy(data, "files"), []);
      if (!Array.isArray(brut) || !brut.every((f) => typeof f === "string" && f !== ""))
        throw new HttpError(400, "files : liste de chemins");
      const fichiers = brut as string[];
      if (!fichiers.length)
        fichiers.push(...conflitsDuStatus((await git(d, ["status", "--porcelain=v1"])).stdout));
      for (const f of fichiers) {
        await git(d, ["checkout", `--${strategie}`, "--", f]);
        await git(d, ["add", "--", f]);
      }
      const reste = conflitsDuStatus((await git(d, ["status", "--porcelain=v1"])).stdout).length > 0;
      if (!reste) await git(d, ["commit", "--no-edit", "--author", auteur(d.uid)]);
      return { ok: true, resolved: fichiers.length, all_resolved: !reste };
    }),
    route("GET", "merge-preview", async (q, uid) => {
      const d = await depot(ctx, uid, param(q, "repo"));
      const branche = refArg(parametreRequete(q, "branch"), "Branche");
      const rLog = await git(d, ["log", "--oneline", `HEAD..${branche}`, "--format=%h|%s|%an"]);
      const commits: Dict[] = [];
      for (const ligne of splitlinesPy(stripPy(rLog.stdout))) {
        const p = splitPy(ligne, "|", 2);
        if (p.length >= 3) commits.push({ short: p[0], message: p[1], author: p[2] });
      }
      const rStat = await git(d, ["diff", "--numstat", `HEAD...${branche}`]);
      const files: { path: string; add: number; del: number }[] = [];
      for (const ligne of splitlinesPy(stripPy(rStat.stdout))) {
        const p = ligne.split("\t");
        if (p.length >= 3)
          files.push({ path: p[2] as string, add: compte(p[0] as string), del: compte(p[1] as string) });
      }
      return {
        branch: branche,
        commits,
        files,
        total_add: files.reduce((n, f) => n + f.add, 0),
        total_del: files.reduce((n, f) => n + f.del, 0),
      };
    }),
    avecDepot("rebase", async (d, data) => {
      const branche = texteNu(getPy(data, "branch"));
      let r: GitResult;
      if (veritePy(getPy(data, "abort", false))) r = await git(d, ["rebase", "--abort"]);
      else if (veritePy(getPy(data, "continue", false))) r = await git(d, ["rebase", "--continue"]);
      else if (branche) r = await git(d, ["rebase", "--end-of-options", refArg(branche, "Branche")]);
      else throw new HttpError(400, "Branche requise");
      if (r.returncode !== 0) throw new HttpError(400, prefixePy(sortieOu(r), 500));
      return { ok: true, message: message(r) };
    }),
    avecDepot("stash", async (d, data) => {
      const action = getPy(data, "action", "push");
      let r: GitResult;
      if (action === "push") {
        const msg = getPy(data, "message", "");
        r = await git(d, ["stash", "push", ...(veritePy(msg) ? ["-m", msg as string] : [])]);
      } else if (action === "pop") r = await git(d, ["stash", "pop"]);
      else if (action === "list") {
        r = await git(d, ["stash", "list"]);
        return { ok: true, stashes: splitlinesPy(stripPy(r.stdout)) };
      } else if (action === "drop") r = await git(d, ["stash", "drop"]);
      else throw new HttpError(400, "Action invalide");
      if (r.returncode !== 0) throw new HttpError(400, prefixePy(sortieOu(r), 500));
      return { ok: true, message: message(r) };
    }),
    avecDepot("remote", async (d, data) => {
      const url = texteNu(getPy(data, "url"));
      const nom = refArg(ouPy(getPy(data, "name"), "origin"), "Nom de remote");
      if (!url) throw new HttpError(400, "URL requise");
      await validerUrl(ctx, url, d.uid);
      let r = await git(d, ["remote", "set-url", nom, url]);
      if (r.returncode !== 0) r = await git(d, ["remote", "add", nom, url]);
      if (r.returncode !== 0) throw new HttpError(400, prefixePy(stripPy(r.stderr || ""), 300));
      return { ok: true };
    }),
    avecDepot("config", async (d, data) => {
      for (const cle of ["user.name", "user.email"]) {
        const val = texteNu(getPy(data, cle));
        if (val) await git(d, ["config", cle, val]);
      }
      return { ok: true };
    }),
    route("GET", "tree", async (q, uid) => {
      const d = await depot(ctx, uid, param(q, "repo"), true);
      const liste = await relaye(() =>
        d.agent.list(d.rel, {
          depth: TREE_MAX_DEPTH + 1,
          hidden: false,
          maxEntries: TREE_MAX_ENTRIES,
          passive: true,
        }),
      );
      const n = d.rel ? d.rel.length + 1 : 0;
      return {
        items: arbre(liste.entries.map((e) => ({ ...e, path: strPy(e["path"]).slice(n) }))),
        truncated: liste.truncated,
      };
    }),
    route("GET", "commit-diff", async (q, uid) => {
      const d = await depot(ctx, uid, param(q, "repo"));
      const h = hashArg(param(q, "hash"));
      const rFichiers = await git(d, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "--name-status",
        "--end-of-options",
        h,
      ]);
      const files: Dict[] = [];
      for (const ligne of splitlinesPy(stripPy(rFichiers.stdout))) {
        const p = splitPy(ligne, "\t", 1);
        if (p.length === 2) files.push({ status: p[0], path: p[1] });
      }
      const r2 = await git(d, ["show", "--no-color", "--format=", "--end-of-options", h]);
      const diff = r2.returncode === 0 ? r2.stdout : "";
      const rInfo = await git(d, ["log", "-1", "--format=%s|%an|%at", "--end-of-options", h]);
      let [msg, author, ts] = ["", "", 0];
      if (rInfo.returncode === 0) {
        const p = splitPy(stripPy(rInfo.stdout), "|", 2);
        if (p.length >= 3) [msg, author, ts] = [p[0] as string, p[1] as string, intPy(p[2])];
      }
      return {
        files,
        diff,
        message: msg,
        author,
        timestamp: ts,
        truncated: r2.truncated || rFichiers.truncated,
      };
    }),
    route("GET", "show-file", async (q, uid) => {
      const d = await depot(ctx, uid, param(q, "repo"));
      const h = param(q, "hash");
      const fichier = param(q, "path");
      if (!h || !fichier) throw new HttpError(400, "hash et path requis");
      const r = await git(d, ["show", "--end-of-options", `${refArg(h, "Hash")}:${fichier}`]);
      if (r.returncode !== 0) throw new HttpError(404, prefixePy(stripPy(r.stderr), 200));
      if (r.truncated)
        throw new HttpError(413, `Fichier de plus de ${reglagesGit.sortie >> 20} Mio : non affiché`);
      return { content: r.stdout };
    }),
    avecDepot("restore-commit", async (d, data) => {
      const h = hashArg(getPy(data, "hash"));
      const force = veritePy(getPy(data, "force"));
      const cur = await git(d, ["rev-parse", "HEAD"]);
      const courant = cur.returncode === 0 ? stripPy(cur.stdout) : "";
      if (!courant) throw new HttpError(400, "Dépôt sans commit : rien à restaurer.");
      const st = await git(d, ["status", "--porcelain=v1", "-uall"]);
      if (st.returncode !== 0)
        throw new HttpError(
          500,
          "Impossible de vérifier l'état de l'arbre de travail ; restauration annulée : " +
            prefixePy(stripPy(st.stderr || ""), 200),
        );
      let sauvegarde = "";
      if (stripPy(st.stdout)) {
        if (!force)
          throw new HttpError(
            409,
            "L'arbre de travail contient des modifications non commitées qui " +
              "seraient écrasées par la restauration. Commitez-les, annulez-les, " +
              "ou confirmez la restauration (force) — une sauvegarde sera créée.",
          );
        sauvegarde = `restore-backup-${Math.trunc(reseauGit.maintenant())}`;
        await git(d, ["add", "-A"]);
        const bk = await git(d, [
          "commit",
          "-m",
          `Sauvegarde avant restauration vers ${h.slice(0, 8)}`,
          "--author",
          auteur(d.uid),
          "--allow-empty",
          "--no-verify",
        ]);
        if (bk.returncode !== 0)
          throw new HttpError(
            500,
            "Échec de la sauvegarde de l'arbre de travail ; restauration annulée : " +
              prefixePy(stripPy(bk.stderr || ""), 200),
          );
        await git(d, ["tag", sauvegarde]);
        await git(d, ["reset", courant]);
      }
      const r = await git(d, ["checkout", h, "--", "."]);
      if (r.returncode !== 0) throw new HttpError(400, prefixePy(stripPy(r.stderr || ""), 300));
      const r2 = await git(d, [
        "commit",
        "-m",
        `Restauration vers ${h.slice(0, 8)}`,
        "--author",
        auteur(d.uid),
        "--allow-empty",
      ]);
      return {
        ok: true,
        message:
          r2.returncode === 0 ? prefixePy(stripPy(r2.stdout), 200) : "Fichiers restaurés (non commité)",
        previous_head: courant,
        backup_ref: sauvegarde,
      };
    }),
    avecDepot("revert-last", async (d) => {
      const r = await git(d, ["revert", "HEAD", "--no-edit"]);
      if (r.returncode !== 0) {
        const err = stripPy(r.stderr || "");
        await git(d, ["revert", "--abort"]);
        throw new HttpError(400, prefixePy(err, 300));
      }
      return { ok: true, message: prefixePy(stripPy(r.stdout || ""), 200) };
    }),
  ];
}
