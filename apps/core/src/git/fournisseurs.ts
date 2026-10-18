// SPDX-License-Identifier: MIT
/** apps/core/src/git/fournisseurs.ts — fournisseurs git (GitHub, GitLab, Bitbucket Cloud et Server, Gitea, générique) : adresse d'API, test de connexion, dépôts accessibles, ouverture de PR et URL de comparaison (shared_infra/git/providers/). */
import {
  adresseIpOuNul,
  encoderUtf8Py,
  ErreurCle,
  ErreurPython,
  estDict,
  estGlobaleIp,
  getPy,
  iterExige,
  lowerPy,
  nomTypePy,
  ouPy,
  quotePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";

/** Options d'un appel (`http_json(url, method=…, body=…, headers=…)`), dans l'ordre des mots-clés du Python. */
export interface OptionsAppel {
  readonly method?: "POST";
  readonly body?: Dict;
  readonly headers: Record<string, string>;
}

/** Client JSON injecté (`http_json`) : `{ok, status, body, error?}`, ne lève jamais. */
export type Http = (url: string, options: OptionsAppel) => Promise<Dict>;

/** Arguments de `create_pr` (owner = clé de projet pour Bitbucket Server). */
export interface DemandePr {
  readonly apiBase: string;
  readonly token: string;
  readonly username: string;
  readonly owner: string;
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

/** Arguments de `compare_url`. */
export interface Comparaison {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly head: string;
  readonly base: string;
}

export interface Fournisseur {
  readonly providerType: string;
  apiBase(host: string, override?: string): string;
  testConnection(http: Http, apiBase: string, token: string, username: string): Promise<Dict>;
  listRepos(http: Http, apiBase: string, token: string, username: string): Promise<Dict>;
  createPr(http: Http, d: DemandePr): Promise<Dict>;
  compareUrl(c: Comparaison): string;
}

const SUFFIXES_INTERNES = [".local", ".internal", ".lan", ".home", ".corp", ".intranet"];

/** `basic_auth_header` : `Basic base64("user:jeton")` en UTF-8 (une demi-paire lève). */
export function basicAuthHeader(user: string, token: string): string {
  return "Basic " + encoderUtf8Py(`${user}:${token}`).toString("base64");
}

function sansBarreFinale(s: string): string {
  return s.replace(/\/+$/u, "");
}

/** `_host_is_private` (Gitea) : IP non globale, `localhost` ou suffixe interne, port et crochets IPv6 retirés. */
export function hostIsPrivate(host: string): boolean {
  const hp = stripPy(host || "");
  let h: string;
  if (hp.startsWith("[")) h = hp.includes("]") ? hp.slice(1, hp.indexOf("]")) : hp.slice(1);
  else h = hp.split(":")[0] ?? "";
  h = lowerPy(stripPy(h));
  if (!h) return false;
  const ip = adresseIpOuNul(h);
  if (ip !== null) return !estGlobaleIp(ip);
  return h === "localhost" || SUFFIXES_INTERNES.some((s) => h.endsWith(s));
}

const corps = (r: Dict): unknown => (Object.hasOwn(r, "body") ? r["body"] : null);
const statut = (r: Dict): unknown => (Object.hasOwn(r, "status") ? r["status"] : null);
const erreur = (r: Dict): unknown => (Object.hasOwn(r, "error") ? r["error"] : "auth_failed");

function echec(r: Dict, avecDepots = false): Dict {
  return avecDepots
    ? { ok: false, error: erreur(r), status: statut(r), repos: [] }
    : { ok: false, error: erreur(r), status: statut(r) };
}

/** `_err` : échec d'appel d'API de PR, réponse brute recopiée (`error` à défaut `unknown`, `body` à défaut `""`). */
function erreurApi(codeErreur: string, r: Dict): Dict {
  return {
    ok: false,
    error_code: codeErreur,
    error: getPy(r, "error", "unknown"),
    status: getPy(r, "status"),
    body: getPy(r, "body", ""),
  };
}

/** `r.get("ok") and isinstance(r.get("body"), dict)` : corps de la PR créée, `null` sinon. */
function corpsCree(r: Dict): Dict | null {
  const b = corps(r);
  return veritePy(r["ok"]) && estDict(b) ? b : null;
}

/** Un dépôt `{full_name, clone_url, private, description, updated_at, web_url}` des fournisseurs GitHub et Gitea. */
function depotGithub(x: unknown): Dict {
  return {
    full_name: getPy(x, "full_name"),
    clone_url: getPy(x, "clone_url"),
    private: veritePy(getPy(x, "private")),
    description: ouPy(getPy(x, "description"), ""),
    updated_at: getPy(x, "updated_at"),
    web_url: getPy(x, "html_url"),
  };
}

async function listeGithub(http: Http, url: string, entetes: Record<string, string>): Promise<Dict> {
  const r = await http(url, { headers: entetes });
  const b = corps(r);
  if (!(veritePy(r["ok"]) && Array.isArray(b))) return echec(r, true);
  return { ok: true, repos: b.filter((x) => veritePy(getPy(x, "clone_url"))).map(depotGithub) };
}

/** `(c.get("name") or "").lower()` : un nom vrai qui n'est pas un texte lève comme `.lower()`. */
function minusculesOuVide(v: unknown): string {
  if (!veritePy(v)) return "";
  if (typeof v !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(v)}' object has no attribute 'lower'`);
  return lowerPy(v);
}

/** `_pick_clone` : URL de clone du schéma demandé dans `links.clone[]`, `""` sinon. */
function urlDeClone(links: unknown, schema: string): unknown {
  for (const c of iterExige(ouPy(getPy(ouPy(links, {}), "clone"), [])))
    if (minusculesOuVide(getPy(c, "name")) === schema) return ouPy(getPy(c, "href"), "");
  return "";
}

/** `seq[0]` : premier élément d'une liste ou d'un texte ; KeyError sur un dict, comme Python. */
function premier(v: unknown): unknown {
  if (Array.isArray(v)) return v[0];
  if (typeof v === "string") return Array.from(v)[0];
  if (estDict(v)) throw new ErreurCle("0");
  throw new ErreurPython("TypeError", `'${nomTypePy(v)}' object is not subscriptable`);
}

const github: Fournisseur = {
  providerType: "github",
  apiBase(host, override = "") {
    if (override) return sansBarreFinale(override);
    return lowerPy(host || "github.com") === "github.com"
      ? "https://api.github.com"
      : `https://${host}/api/v3`;
  },
  async testConnection(http, apiBase, token) {
    const r = await http(`${apiBase}/user`, { headers: entetesGithub(token) });
    const b = corps(r);
    if (veritePy(r["ok"]) && estDict(b)) return { ok: true, login: getPy(b, "login") };
    return echec(r);
  },
  listRepos(http, apiBase, token) {
    return listeGithub(
      http,
      `${apiBase}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`,
      entetesGithub(token),
    );
  },
  async createPr(http, d) {
    const hdr = entetesGithub(d.token);
    const r1 = await http(
      `${d.apiBase}/repos/${d.owner}/${d.repo}/pulls?head=${d.owner}:${d.head}&base=${d.base}&state=open`,
      { headers: hdr },
    );
    const b1 = corps(r1);
    if (veritePy(r1["ok"]) && Array.isArray(b1) && b1.length) {
      const pr = b1[0];
      return { ok: true, pr_url: getPy(pr, "html_url"), pr_number: getPy(pr, "number"), already_open: true };
    }
    const payload = { title: d.title, body: d.body, head: d.head, base: d.base, draft: d.draft };
    const r2 = await http(`${d.apiBase}/repos/${d.owner}/${d.repo}/pulls`, {
      method: "POST",
      body: payload,
      headers: hdr,
    });
    const pr = corpsCree(r2);
    if (pr) return { ok: true, pr_url: getPy(pr, "html_url"), pr_number: getPy(pr, "number") };
    return erreurApi("github_api_error", r2);
  },
  compareUrl: (c) => `https://${c.host}/${c.owner}/${c.repo}/compare/${c.base}...${c.head}?expand=1`,
};

function entetesGithub(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
}

const gitlab: Fournisseur = {
  providerType: "gitlab",
  apiBase(host, override = "") {
    return override ? sansBarreFinale(override) : `https://${host}/api/v4`;
  },
  async testConnection(http, apiBase, token) {
    const r = await http(`${apiBase}/user`, { headers: { "PRIVATE-TOKEN": token } });
    const b = corps(r);
    if (veritePy(r["ok"]) && estDict(b)) return { ok: true, login: getPy(b, "username") };
    return echec(r);
  },
  async listRepos(http, apiBase, token) {
    const r = await http(
      `${apiBase}/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at`,
      {
        headers: { "PRIVATE-TOKEN": token },
      },
    );
    const b = corps(r);
    if (!(veritePy(r["ok"]) && Array.isArray(b))) return echec(r, true);
    return {
      ok: true,
      repos: b
        .filter((x) => veritePy(getPy(x, "http_url_to_repo")))
        .map((x) => ({
          full_name: getPy(x, "path_with_namespace"),
          clone_url: getPy(x, "http_url_to_repo"),
          private: ouPy(getPy(x, "visibility"), "private") !== "public",
          description: ouPy(getPy(x, "description"), ""),
          updated_at: getPy(x, "last_activity_at"),
          web_url: getPy(x, "web_url"),
        })),
    };
  },
  async createPr(http, d) {
    const hdr = { "PRIVATE-TOKEN": d.token };
    const projet = quotePy(`${d.owner}/${d.repo}`, "");
    const r1 = await http(
      `${d.apiBase}/projects/${projet}/merge_requests?source_branch=${d.head}&target_branch=${d.base}&state=opened`,
      { headers: hdr },
    );
    const b1 = corps(r1);
    if (veritePy(r1["ok"]) && Array.isArray(b1) && b1.length) {
      const mr = b1[0];
      return { ok: true, pr_url: getPy(mr, "web_url"), pr_number: getPy(mr, "iid"), already_open: true };
    }
    const brouillon = /^(?:draft:|wip:)/u.test(lowerPy(d.title));
    const payload = {
      title: d.draft && !brouillon ? `Draft: ${d.title}` : d.title,
      description: d.body,
      source_branch: d.head,
      target_branch: d.base,
    };
    const r2 = await http(`${d.apiBase}/projects/${projet}/merge_requests`, {
      method: "POST",
      body: payload,
      headers: hdr,
    });
    const mr = corpsCree(r2);
    if (mr) return { ok: true, pr_url: getPy(mr, "web_url"), pr_number: getPy(mr, "iid") };
    return erreurApi("gitlab_api_error", r2);
  },
  compareUrl: (c) => `https://${c.host}/${c.owner}/${c.repo}/-/compare/${c.base}...${c.head}`,
};

/** `_PR_DISABLED` : Gitea répond 404 sur `/pulls` quand l'unité « Pull Requests » du dépôt est désactivée. */
function prDesactivees(): Dict {
  return {
    ok: false,
    error_code: "pull_requests_disabled",
    error:
      "Les Pull Requests sont DÉSACTIVÉES sur ce dépôt Gitea. Activez-les : dépôt → Paramètres → onglet « Unités » (ou Advanced) → cochez « Pull Requests », puis réessayez.",
    status: 404,
  };
}

function entetesGitea(username: string, token: string): Record<string, string> {
  return { Authorization: basicAuthHeader(username || token, username ? token : "") };
}

const gitea: Fournisseur = {
  providerType: "gitea",
  apiBase(host, override = "") {
    if (override) return sansBarreFinale(override);
    return `${hostIsPrivate(host) ? "http" : "https"}://${host}/api/v1`;
  },
  async testConnection(http, apiBase, token, username) {
    const r = await http(`${apiBase}/user`, { headers: entetesGitea(username, token) });
    const b = corps(r);
    if (veritePy(r["ok"]) && estDict(b)) return { ok: true, login: getPy(b, "login") };
    return echec(r);
  },
  listRepos(http, apiBase, token, username) {
    return listeGithub(http, `${apiBase}/user/repos?limit=50`, entetesGitea(username, token));
  },
  async createPr(http, d) {
    const hdr = entetesGitea(d.username, d.token);
    const r1 = await http(`${d.apiBase}/repos/${d.owner}/${d.repo}/pulls?state=open`, { headers: hdr });
    if (statut(r1) === 404) return prDesactivees();
    const b1 = corps(r1);
    if (veritePy(r1["ok"]) && Array.isArray(b1))
      for (const pr of b1)
        if (
          getPy(ouPy(getPy(pr, "head"), {}), "ref") === d.head &&
          getPy(ouPy(getPy(pr, "base"), {}), "ref") === d.base
        )
          return {
            ok: true,
            pr_url: getPy(pr, "html_url"),
            pr_number: getPy(pr, "number"),
            already_open: true,
          };
    const payload = { title: d.title, body: d.body, head: d.head, base: d.base };
    const r2 = await http(`${d.apiBase}/repos/${d.owner}/${d.repo}/pulls`, {
      method: "POST",
      body: payload,
      headers: hdr,
    });
    const pr = corpsCree(r2);
    if (pr) return { ok: true, pr_url: getPy(pr, "html_url"), pr_number: getPy(pr, "number") };
    if (statut(r2) === 404) return prDesactivees();
    return erreurApi("gitea_api_error", r2);
  },
  compareUrl: (c) => `https://${c.host}/${c.owner}/${c.repo}/compare/${c.base}...${c.head}`,
};

function entetesBitbucket(username: string, token: string): Record<string, string> {
  return { Authorization: basicAuthHeader(username || "x-token-auth", token) };
}

/** `(pr.get(cote) or {}).get("branch", {}).get("name")` d'une PR Bitbucket Cloud. */
function brancheBitbucket(pr: unknown, cote: string): unknown {
  return getPy(getPy(ouPy(getPy(pr, cote), {}), "branch", {}), "name");
}

/** `(pr.get("links") or {}).get("html", {}).get("href")`. */
function lienHtml(pr: unknown): unknown {
  return getPy(getPy(ouPy(getPy(pr, "links"), {}), "html", {}), "href");
}

/** `((pr.get("links") or {}).get("self") or [{}])[0].get("href")` d'une PR Bitbucket Server. */
function lienSelf(pr: unknown): unknown {
  return getPy(premier(ouPy(getPy(ouPy(getPy(pr, "links"), {}), "self"), [{}])), "href");
}

const bitbucketCloud: Fournisseur = {
  providerType: "bitbucket-cloud",
  apiBase(_host, override = "") {
    return override ? sansBarreFinale(override) : "https://api.bitbucket.org/2.0";
  },
  async testConnection(http, apiBase, token, username) {
    const r = await http(`${apiBase}/user`, { headers: entetesBitbucket(username, token) });
    const b = corps(r);
    if (veritePy(r["ok"]) && estDict(b))
      return { ok: true, login: ouPy(getPy(b, "username"), getPy(b, "nickname")) };
    return echec(r);
  },
  async listRepos(http, apiBase, token, username) {
    const r = await http(`${apiBase}/repositories?role=member&pagelen=100&sort=-updated_on`, {
      headers: entetesBitbucket(username, token),
    });
    const b = corps(r);
    if (!(veritePy(r["ok"]) && estDict(b))) return echec(r, true);
    const repos: Dict[] = [];
    for (const x of iterExige(ouPy(getPy(b, "values"), []))) {
      const cloneUrl = urlDeClone(ouPy(getPy(x, "links"), {}), "https");
      if (!veritePy(cloneUrl)) continue;
      repos.push({
        full_name: getPy(x, "full_name"),
        clone_url: cloneUrl,
        private: veritePy(getPy(x, "is_private")),
        description: ouPy(getPy(x, "description"), ""),
        updated_at: getPy(x, "updated_on"),
        web_url: getPy(ouPy(getPy(ouPy(getPy(x, "links"), {}), "html"), {}), "href"),
      });
    }
    return { ok: true, repos };
  },
  async createPr(http, d) {
    const hdr = entetesBitbucket(d.username, d.token);
    const r1 = await http(`${d.apiBase}/repositories/${d.owner}/${d.repo}/pullrequests?state=OPEN`, {
      headers: hdr,
    });
    const b1 = corps(r1);
    if (veritePy(r1["ok"]) && estDict(b1))
      for (const pr of iterExige(ouPy(getPy(b1, "values"), [])))
        if (brancheBitbucket(pr, "source") === d.head && brancheBitbucket(pr, "destination") === d.base)
          return { ok: true, pr_url: lienHtml(pr), pr_number: getPy(pr, "id"), already_open: true };
    const payload = {
      title: d.title,
      description: d.body,
      source: { branch: { name: d.head } },
      destination: { branch: { name: d.base } },
    };
    const r2 = await http(`${d.apiBase}/repositories/${d.owner}/${d.repo}/pullrequests`, {
      method: "POST",
      body: payload,
      headers: hdr,
    });
    const pr = corpsCree(r2);
    if (pr) return { ok: true, pr_url: lienHtml(pr), pr_number: getPy(pr, "id") };
    return erreurApi("bitbucket_api_error", r2);
  },
  compareUrl: (c) =>
    `https://${c.host}/${c.owner}/${c.repo}/pull-requests/new?source=${c.head}&dest=${c.base}`,
};

const bitbucketServer: Fournisseur = {
  providerType: "bitbucket-server",
  apiBase(host, override = "") {
    return override ? sansBarreFinale(override) : `https://${host}/rest/api/1.0`;
  },
  async testConnection(http, apiBase, token, username) {
    const r = await http(`${apiBase}/projects?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
    if (veritePy(r["ok"])) return { ok: true, login: username || null };
    return echec(r);
  },
  async listRepos(http, apiBase, token) {
    const r = await http(`${apiBase}/repos?limit=100`, { headers: { Authorization: `Bearer ${token}` } });
    const b = corps(r);
    if (!(veritePy(r["ok"]) && estDict(b))) return echec(r, true);
    const repos: Dict[] = [];
    for (const x of iterExige(ouPy(getPy(b, "values"), []))) {
      const links = ouPy(getPy(x, "links"), {});
      const cloneUrl = urlDeClone(links, "http");
      if (!veritePy(cloneUrl)) continue;
      const cle = ouPy(getPy(ouPy(getPy(x, "project"), {}), "key"), "");
      const slug = ouPy(ouPy(getPy(x, "slug"), getPy(x, "name")), "");
      repos.push({
        full_name: veritePy(cle) ? `${strPy(cle)}/${strPy(slug)}` : slug,
        clone_url: cloneUrl,
        private: !veritePy(getPy(x, "public")),
        description: ouPy(getPy(x, "description"), ""),
        updated_at: null,
        web_url: getPy(ouPy(premier(ouPy(getPy(links, "self"), [{}])), {}), "href"),
      });
    }
    return { ok: true, repos };
  },
  async createPr(http, d) {
    const hdr = { Authorization: `Bearer ${d.token}` };
    const liste = await http(
      `${d.apiBase}/projects/${d.owner}/repos/${d.repo}/pull-requests?state=OPEN&direction=OUTGOING`,
      { headers: hdr },
    );
    const b1 = corps(liste);
    if (veritePy(liste["ok"]) && estDict(b1))
      for (const pr of iterExige(ouPy(getPy(b1, "values"), [])))
        if (
          getPy(ouPy(getPy(pr, "fromRef"), {}), "displayId") === d.head &&
          getPy(ouPy(getPy(pr, "toRef"), {}), "displayId") === d.base
        )
          return { ok: true, pr_url: lienSelf(pr), pr_number: getPy(pr, "id"), already_open: true };
    const payload = {
      title: d.title,
      description: d.body,
      fromRef: { id: `refs/heads/${d.head}` },
      toRef: { id: `refs/heads/${d.base}` },
    };
    const r2 = await http(`${d.apiBase}/projects/${d.owner}/repos/${d.repo}/pull-requests`, {
      method: "POST",
      body: payload,
      headers: hdr,
    });
    const pr = corpsCree(r2);
    if (pr) return { ok: true, pr_url: lienSelf(pr), pr_number: getPy(pr, "id") };
    return erreurApi("bitbucket_server_api_error", r2);
  },
  compareUrl: (c) =>
    `https://${c.host}/projects/${c.owner}/repos/${c.repo}/compare/commits?sourceBranch=refs/heads/${c.head}&targetBranch=refs/heads/${c.base}`,
};

const generique: Fournisseur = {
  providerType: "generic",
  apiBase(_host, override = "") {
    return override ? sansBarreFinale(override) : "";
  },
  testConnection() {
    return Promise.resolve({ ok: false, error: "no_api" });
  },
  listRepos() {
    return Promise.resolve({
      ok: false,
      error_code: "no_api",
      error: "provider sans API de listing",
      repos: [],
    });
  },
  createPr() {
    return Promise.resolve({
      ok: false,
      error_code: "no_api",
      error: "provider sans API de PR (ouverture manuelle requise)",
    });
  },
  compareUrl: () => "",
};

const FOURNISSEURS: readonly Fournisseur[] = [
  github,
  gitlab,
  bitbucketCloud,
  bitbucketServer,
  gitea,
  generique,
];
const REGISTRE: ReadonlyMap<string, Fournisseur> = new Map(FOURNISSEURS.map((f) => [f.providerType, f]));
const DETECTE_VERS_COMPARAISON: ReadonlyMap<string, string> = new Map([
  ["github", "github"],
  ["gitlab", "gitlab"],
  ["bitbucket", "bitbucket-cloud"],
]);

/** `get_provider` : fournisseur du type (insensible à la casse), générique à défaut. */
export function getProvider(providerType: string | null | undefined): Fournisseur {
  return REGISTRE.get(lowerPy(providerType || "")) ?? generique;
}

export function providerTypes(): string[] {
  return FOURNISSEURS.map((f) => f.providerType);
}

/** `compare_url_for` : URL web de repli (sans jeton) ; le type du connecteur prime sur l'hébergeur détecté ; `""` si aucun ne s'applique. */
export function compareUrlFor(detecte: string, c: Comparaison, providerType = ""): string {
  const cle = lowerPy(providerType || "");
  let f = cle ? REGISTRE.get(cle) : undefined;
  if (f === undefined) {
    const type = DETECTE_VERS_COMPARAISON.get(lowerPy(detecte || ""));
    f = type ? REGISTRE.get(type) : undefined;
  }
  return f === undefined ? "" : f.compareUrl(c);
}
