// SPDX-License-Identifier: MIT
/** packages/fichiers/src/git.ts — git d'un bac à sable exécuté par son agent (sandbox/git_ops.py) : commande locale, réseau par le relais authentifiant, `pull`, dépôts du bac ; jeton du connecteur envoyé seulement à l'hôte EXACT de son connecteur. */
import { lookup } from "node:dns/promises";

import {
  adresseIpOuNul,
  comparePointsDeCode,
  getPy,
  hostname,
  journalDe,
  lowerPy,
  port,
  rstripPy,
  stripPy,
  strPy,
  texteIp,
  urlsplit,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { adresseCritique, blockRemoteUrlReason } from "@elpis/securite";
import type { Resolveur } from "@elpis/securite";

import { AgentError } from "./agent";
import type { AgentClient, ResultatGitAgent } from "./agent";
import { amont, avecTicket, basicAuth, RECEIVE, RelayRefused, UPLOAD } from "./relais-git";
import type { VerdictDepot } from "./relais-git";

/** Schémas relayés (smart HTTP) ; `git://` n'a ni authentification ni relais. */
export const REMOTE_SCHEMES: readonly string[] = ["http", "https"];

/** `pull` : fusion de ce que `git pull` fusionnerait, en tentatives successives. */
const PULL_MODES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  "--ff-only": [["merge", "--ff-only"]],
  "--no-rebase": [["merge", "--no-edit"]],
  "--rebase": [["merge", "--ff-only"], ["rebase"]],
};

export class GitResult {
  returncode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timed_out: boolean;
  duration_ms: number;
  /** Requêtes refusées par le relais pendant l'opération (motifs) : un refus de politique, pas un échec d'authentification. */
  refus: string[];

  constructor(
    r: Partial<ResultatGitAgent> & { returncode: number; stdout: string; stderr: string },
    refus: string[] = [],
  ) {
    this.returncode = r.returncode;
    this.stdout = r.stdout;
    this.stderr = r.stderr;
    this.truncated = r.truncated ?? false;
    this.timed_out = r.timed_out ?? false;
    this.duration_ms = r.duration_ms ?? 0;
    this.refus = refus;
  }

  get ok(): boolean {
    return this.returncode === 0;
  }
}

/** Ce que l'hôte demande au core (`ClientRappel` : /api/internal/git/*) : il n'ouvre jamais la base. */
export interface SourceGit {
  gitCredential(uid: number, remoteUrl: string): Promise<Dict | null>;
  connectorHosts(uid: number): Promise<string[]>;
}

/** Garde d'un dépôt distant : motif de refus, ou adresses validées à joindre. */
export type GardeDepot = (url: string, uid: number) => Promise<VerdictDepot>;

/** `run` : `git <args>` dans `cwd` (relatif à /work) ; `passive` : sondage (conteneur arrêté laissé tel quel, `container_down`). */
export async function run(
  agent: AgentClient,
  cwd: string,
  args: Iterable<string>,
  o: { timeoutS?: number; maxOut?: number; env?: Record<string, string>; passive?: boolean } = {},
): Promise<GitResult> {
  return new GitResult(
    await agent.git(cwd, [...args], {
      timeoutS: o.timeoutS ?? 60,
      maxOut: o.maxOut ?? 1 << 20,
      ...(o.env ? { env: o.env } : {}),
      passive: o.passive ?? false,
    }),
  );
}

/** `connector_hosts` : hôtes des connecteurs du compte (permis malgré une adresse privée) ; vide en cas de panne. */
export async function connectorHosts(source: SourceGit, uid: number): Promise<Set<string>> {
  try {
    return new Set(await source.connectorHosts(Math.trunc(uid)));
  } catch {
    return new Set();
  }
}

async function resoudreSysteme(hote: string): Promise<string[]> {
  return (await lookup(hote, { all: true, order: "verbatim" })).map((r) => r.address);
}

/** Garde anti-SSRF d'un dépôt (`critical_only` : LAN permis, boucle et métadonnées non, connecteurs permis), puis boucle et lien local refusés pour TOUT hôte ; adresses retenues pour la connexion. */
export async function gardeDepot(
  url: string,
  uid: number,
  source: SourceGit,
  resoudre: Resolveur = (h) => resoudreSysteme(h),
): Promise<VerdictDepot> {
  let vues: string[] | null = null;
  const motif = await blockRemoteUrlReason(url, {
    allowSchemes: REMOTE_SCHEMES,
    allowHosts: await connectorHosts(source, uid),
    criticalOnly: true,
    resoudre: async (h, p) => (vues = await resoudre(h, p)),
  });
  if (motif) return { motif, adresses: null };
  const p = urlsplit(stripPy(url));
  const hote = lowerPy(hostname(p) ?? "");
  const litterale = adresseIpOuNul(hote);
  if (litterale !== null)
    return adresseCritique(litterale)
      ? { motif: `blocked_ip (${texteIp(litterale)})`, adresses: null }
      : { motif: null, adresses: null };
  if (vues === null) {
    try {
      vues = await resoudre(hote, port(p) || null);
    } catch {
      return { motif: "unresolvable_host", adresses: null };
    }
  }
  for (const brute of vues) {
    const ip = adresseIpOuNul(brute);
    if (ip !== null && adresseCritique(ip))
      return { motif: `resolves_to_blocked (${texteIp(ip)})`, adresses: null };
  }
  return { motif: null, adresses: vues };
}

/** `remote_block_reason` : motif de refus d'un dépôt distant, `null` s'il est permis. */
export async function remoteBlockReason(url: string, uid: number, source: SourceGit): Promise<string | null> {
  return (await gardeDepot(url, uid, source)).motif;
}

/** `hôte[:port]` que joint le relais pour `url` (forme de l'hôte d'un connecteur). */
function hoteJoint(url: string): string {
  return amont(url)[0].replace(/^https?:\/\//u, "");
}

/** `_credential` : (identifiant, jeton) du connecteur de l'hôte EXACT du dépôt (rendu par le core), sinon `["", ""]` ; un identifiant d'un autre hôte est écarté. */
export async function credential(source: SourceGit, uid: number, url: string): Promise<[string, string]> {
  let cred: Dict | null;
  try {
    cred = uid ? await source.gitCredential(Math.trunc(uid), url) : null;
  } catch {
    journalDe("git").warn(`[git] connecteur non résolu pour ${url}`);
    cred = null;
  }
  if (!cred) return ["", ""];
  const jeton = getPy(cred, "token");
  if (typeof jeton !== "string" || !jeton) return ["", ""];
  const attendu = hoteJoint(url);
  if (lowerPy(strPy(getPy(cred, "host") ?? "")) !== attendu) {
    journalDe("git").warn(`[git] identifiant écarté : connecteur d'un autre hôte que ${attendu}`);
    return ["", ""];
  }
  const user = getPy(cred, "username");
  return [typeof user === "string" ? user : strPy(user ?? ""), jeton];
}

const ANCIEN_FICHIER = ".git-credentials.json";
const anciensVus = new Set<number>();
const sansNomVus = new Set<number>();

/** Réponse d'`ImportAncien` : des hôtes sans connecteur enregistré ont été refusés, fichier gardé sans nouvel essai dans ce processus. */
export const IMPORT_GARDE = -2;

/** Import d'un ancien `.git-credentials.json` dans les connecteurs du compte (base du core, compte de l'enveloppe signée) : nombre créé, `-1` si l'import a échoué, `IMPORT_GARDE` si des hôtes ont été refusés. */
export type ImportAncien = (
  compte: { readonly user_id: number; readonly username: string },
  donnees: Buffer,
) => Promise<number>;
let importAncien: ImportAncien | null = null;

/** Port de `import_legacy_git_credentials` (route interne du core, POST /api/internal/git/legacy-credentials) ; absent : fichier gardé, comme une base indisponible. */
export function installerImportAncien(f: ImportAncien | null): void {
  importAncien = f;
}

/** `import_legacy_credentials` : une fois par processus et par compte, l'ancien `/work/.git-credentials.json` importé puis supprimé (avec sa trace `.imported`), gardé si des hôtes sont refusés ; sans nom de compte (enveloppe), rien n'est touché. */
export async function importLegacyCredentials(agent: AgentClient, uid: number, username = ""): Promise<void> {
  if (!uid || anciensVus.has(uid)) return;
  if (!username) {
    if (!sansNomVus.has(uid))
      journalDe("git").warn(`[git] anciens identifiants non importés : nom du compte ${uid} inconnu`);
    sansNomVus.add(uid);
    return;
  }
  try {
    await agent.fsop("remove", { path: ANCIEN_FICHIER + ".imported", missing_ok: true });
  } catch (e) {
    if (!(e instanceof AgentError)) throw e;
    journalDe("git").warn(`[git] trace .imported non supprimée (compte ${uid})`);
  }
  let donnees: Buffer;
  try {
    donnees = (await agent.read(ANCIEN_FICHIER, { maxBytes: 1 << 20 })).data;
  } catch (e) {
    if (!(e instanceof AgentError)) throw e;
    if (["not_found", "is_dir", "not_file", "too_large", "denied", "outside_root"].includes(e.code))
      anciensVus.add(uid);
    return;
  }
  let n: number;
  try {
    n = importAncien === null ? -1 : await importAncien({ user_id: uid, username }, donnees);
  } catch {
    n = -1;
  }
  if (n === IMPORT_GARDE) {
    anciensVus.add(uid);
    journalDe("git").warn(
      `[git] ${ANCIEN_FICHIER} gardé : hôte(s) sans connecteur enregistré (compte ${uid})`,
    );
    return;
  }
  if (n < 0) return;
  anciensVus.add(uid);
  try {
    await agent.fsop("remove", { path: ANCIEN_FICHIER, missing_ok: true });
  } catch (e) {
    if (!(e instanceof AgentError)) throw e;
    journalDe("git").warn(`[git] ${ANCIEN_FICHIER} non supprimé (compte ${uid})`);
  }
}

/** Tests : oublie les comptes déjà vus par `importLegacyCredentials`. */
export function oublierAnciensVus(): void {
  anciensVus.clear();
  sansNomVus.clear();
}

/** `remote_urls` : URL(s) du remote (`push` : celles du push). */
export async function remoteUrls(
  agent: AgentClient,
  cwd: string,
  remote: string,
  o: { push?: boolean } = {},
): Promise<string[]> {
  const r = await run(agent, cwd, ["remote", "get-url", "--all", ...(o.push ? ["--push"] : []), remote], {
    timeoutS: 10,
    maxOut: 1 << 16,
  });
  return r.ok ? lignesPy(r.stdout).map(stripPy).filter(Boolean) : [];
}

const FINS_DE_LIGNE = "\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029";

/** `str.splitlines()` de Python. */
function lignesPy(s: string): string[] {
  const l: string[] = [];
  let debut = 0;
  for (let i = 0; i < s.length; i++) {
    if (!FINS_DE_LIGNE.includes(s.charAt(i))) continue;
    l.push(s.slice(debut, i));
    if (s.charAt(i) === "\r" && s.charAt(i + 1) === "\n") i++;
    debut = i + 1;
  }
  if (debut < s.length) l.push(s.slice(debut));
  return l;
}

/** `remote_url` : URL unique du remote, sinon `RelayRefused` (absent, ou plusieurs URL : un dépôt par opération). */
export async function remoteUrl(
  agent: AgentClient,
  cwd: string,
  remote: string,
  o: { push?: boolean } = {},
): Promise<string> {
  const urls = await remoteUrls(agent, cwd, remote, o);
  if (!urls.length) throw new RelayRefused("no_remote", `Remote « ${remote} » introuvable`);
  if (urls.length > 1)
    throw new RelayRefused(
      "multiple_urls",
      `Remote « ${remote} » : plusieurs URL, non prises en charge par le relais`,
    );
  return urls[0] as string;
}

export interface OptionsReseau {
  readonly uid: number;
  /** Nom du compte (enveloppe signée de l'import des anciens identifiants) ; absent : fichier gardé. */
  readonly username?: string;
  readonly url: string;
  readonly source: SourceGit;
  /** Refs permises au push ; absent : fetch, clone, ls-remote. */
  readonly pushRefs?: Iterable<string>;
  /** Identifiants SAISIS (identifiant, jeton) : envoyés seulement en réponse à un 401 de l'amont. */
  readonly auth?: readonly [string, string];
  readonly timeoutS?: number;
  readonly maxOut?: number;
  readonly garde?: GardeDepot;
}

/** `run_network` : commande git réseau vers `url` seule, par le relais ; identifiants saisis, sinon ceux du connecteur de l'hôte exact. */
export async function runNetwork(
  agent: AgentClient,
  cwd: string,
  args: Iterable<string>,
  o: OptionsReseau,
): Promise<GitResult> {
  const timeoutS = o.timeoutS ?? 120;
  const garde: GardeDepot = o.garde ?? ((u, id) => gardeDepot(u, id, o.source));
  const verdict = await garde(o.url, o.uid);
  if (verdict.motif) throw new RelayRefused("blocked_remote", `Dépôt refusé (anti-SSRF) : ${verdict.motif}`);
  amont(o.url);
  await importLegacyCredentials(agent, o.uid, o.username ?? "");
  const saisis = Boolean(o.auth && o.auth[1]);
  const [user, token] = saisis
    ? (o.auth as readonly [string, string])
    : await credential(o.source, o.uid, o.url);
  const service = o.pushRefs === undefined ? UPLOAD : RECEIVE;
  let d: ResultatGitAgent | null = null;
  let refus: string[] = [];
  await avecTicket(
    agent.relayDir,
    {
      uid: o.uid,
      url: o.url,
      service,
      refs: o.pushRefs ?? [],
      dureeS: timeoutS + 60,
      auth: token ? basicAuth(user, token) : "",
      authOnChallenge: saisis,
      garde: () => garde(o.url, o.uid),
    },
    async (relay, refusRelais) => {
      d = await agent.git(cwd, [...args], {
        timeoutS,
        maxOut: o.maxOut ?? 1 << 20,
        relay: { socket: relay.socket, ticket: relay.ticket, origin: relay.origin },
      });
      refus = [...new Set(refusRelais)];
    },
  );
  const r = new GitResult(d as unknown as ResultatGitAgent, refus);
  if (refus.length && !r.ok)
    r.stderr = (rstripPy(r.stderr, "\n") + "\n" + refus.join("\n")).replace(/^\n+/u, "");
  return r;
}

/** `pull` : fetch par le relais puis fusion locale de la branche (`FETCH_HEAD`) ou de l'amont (`@{upstream}`) ; remote « . » : fusion seule. */
export async function pull(
  agent: AgentClient,
  cwd: string,
  remote: string,
  branch = "",
  mode = "--ff-only",
  o: Omit<OptionsReseau, "url" | "pushRefs">,
): Promise<GitResult> {
  const suites = PULL_MODES[mode];
  if (suites === undefined || !Object.hasOwn(PULL_MODES, mode))
    throw new Error(`ValueError: git pull : mode non pris en charge ${mode}`);
  const timeoutS = o.timeoutS ?? 120;
  const maxOut = o.maxOut ?? 1 << 20;
  let f: GitResult;
  if (remote === ".") f = new GitResult({ returncode: 0, stdout: "", stderr: "" });
  else {
    const url = await remoteUrl(agent, cwd, remote);
    f = await runNetwork(
      agent,
      cwd,
      ["fetch", "--no-recurse-submodules", remote, ...(branch ? [branch] : [])],
      {
        ...o,
        url,
        timeoutS,
        maxOut,
      },
    );
    if (!f.ok) return f;
  }
  const cible = branch ? "FETCH_HEAD" : "@{upstream}";
  let dernier: GitResult | null = null;
  for (const suite of suites) {
    dernier = await run(agent, cwd, [...suite, cible], { timeoutS, maxOut });
    if (dernier.ok) break;
  }
  const l = dernier as GitResult;
  return new GitResult({
    returncode: l.returncode,
    stdout: f.stdout + l.stdout,
    stderr: f.stderr + l.stderr,
    truncated: f.truncated || l.truncated,
    timed_out: l.timed_out,
    duration_ms: f.duration_ms + l.duration_ms,
  });
}

const NON_PARCOURUS = ["node_modules", "__pycache__", ".venv", "venv"];

/** `find_repos` : dépôts (dossier qui contient `.git`) jusqu'à `depth` niveaux sous /work, racine exclue, un dépôt dans un dépôt écarté ; triés, `limit` au plus. */
export async function findRepos(
  agent: AgentClient,
  o: { depth?: number; limit?: number; passive?: boolean } = {},
): Promise<string[]> {
  const liste = await agent.list("", {
    depth: (o.depth ?? 3) + 1,
    maxEntries: 20000,
    hidden: true,
    prune: [".git"],
    exclude: NON_PARCOURUS,
    nameContains: ".git",
    deadlineS: 10,
    passive: o.passive ?? false,
  });
  const depots = new Set<string>();
  for (const e of liste.entries) {
    const p = strPy(getPy(e, "path"));
    const i = p.lastIndexOf("/");
    if (i < 0 || p.slice(i + 1) !== ".git") continue;
    const genre = getPy(e, "kind");
    if (genre === "dir" || genre === "file") depots.add(p.slice(0, i));
  }
  const tries = [...depots].sort(comparePointsDeCode);
  const hauts = tries.filter((d) => !tries.some((x) => d.startsWith(x + "/")));
  return hauts.slice(0, o.limit ?? 50);
}
