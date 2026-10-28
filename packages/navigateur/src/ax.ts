// SPDX-License-Identifier: MIT
/** packages/navigateur/src/ax.ts — mémoire AX des sites vue par les routes : URL normalisées, arbre DOM, rendu ASCII, statistiques et purges (port de shared_infra/memory/ax/). */
import {
  BLANC_PY,
  comparePointsDeCode,
  estDict,
  FlottantPy,
  intPy,
  journalDe,
  pyJsonLoads,
  longueurPy,
  lowerPy,
  prefixePy,
  rstripPy,
  strPy,
  stripPy,
  urlsplit,
  veritePy,
} from "@elpis/commun";
import { readConfigJson } from "@elpis/config";
import { castFloat, greatest, nullsFirst } from "@elpis/db";
import type { Executeur } from "@elpis/db";
import { Verrou } from "@elpis/mcp";

import { pwOwner } from "./session";

export const log = (): ReturnType<typeof journalDe> => journalDe("ax");
export const texte = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `_DB_LOCK` : les écritures AX de ce processus passent une à une. */
export const verrouAx = new Verrou();

const ID_DANS_CHEMIN: readonly (readonly [RegExp, string])[] = [
  [/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/gu, "/*"],
  [/\/[A-Z][A-Z0-9]{1,9}-\p{Nd}+(?=\/|$)/gu, "/*"],
  [/\/[a-f0-9]{8,}(?=\/|$)/gu, "/*"],
  [/\/\p{Nd}{3,}(?=\/|$)/gu, "/*"],
];
const IP_PRIVEE =
  /^(10\.\p{Nd}{1,3}\.\p{Nd}{1,3}\.\p{Nd}{1,3}|172\.(1[6-9]|2\p{Nd}|3[0-1])\.\p{Nd}{1,3}\.\p{Nd}{1,3}|192\.168\.\p{Nd}{1,3}\.\p{Nd}{1,3}|127\.\p{Nd}{1,3}\.\p{Nd}{1,3}\.\p{Nd}{1,3}|169\.254\.\p{Nd}{1,3}\.\p{Nd}{1,3})$/u;
const IP_QUELCONQUE = /^(\p{Nd}{1,3}\.){3}\p{Nd}{1,3}$/u;
const USES_PARAMS: ReadonlySet<string> = new Set([
  "",
  "ftp",
  "hdl",
  "prospero",
  "http",
  "imap",
  "https",
  "shttp",
  "rtsp",
  "rtsps",
  "rtspu",
  "sip",
  "sips",
  "mms",
  "sftp",
  "tel",
]);

/** Bloc `app` de config.json, `{}` s'il manque ; lève comme Python s'il n'est pas un dict. */
function blocApp(): Record<string, unknown> {
  const cfg = readConfigJson();
  const app = veritePy(cfg["app"]) ? cfg["app"] : {};
  if (!estDict(app)) throw new TypeError("'app' n'est pas un dict");
  return app;
}

/** `_load_site_aliases` : `{port: alias}` en textes ; `{}` sur toute erreur. */
function aliasesDeSites(): Map<string, string> {
  try {
    const brut = blocApp()["ax_site_aliases"];
    const aliases = veritePy(brut) ? brut : {};
    if (!estDict(aliases)) return new Map();
    return new Map(Object.entries(aliases).map(([k, v]) => [k, strPy(v)]));
  } catch {
    return new Map();
  }
}

function dedupToutesIp(): boolean {
  try {
    return veritePy(blocApp()["ax_dedup_any_ip"] ?? false);
  } catch {
    return false;
  }
}

/** `_normalize_site` : alias du port, IP privée (ou toute IPv4 si configuré) réduite à `:port`, sinon le netloc en minuscules. */
function normaliserSite(netloc: string): string {
  if (!netloc) return "";
  let hote = netloc;
  let port = "";
  const i = netloc.lastIndexOf(":");
  if (i >= 0) [hote, port] = [netloc.slice(0, i), netloc.slice(i + 1)];
  hote = stripPy(lowerPy(hote));
  port = stripPy(port);
  if (port) {
    const alias = aliasesDeSites().get(port);
    if (alias !== undefined) return alias;
  }
  if (IP_PRIVEE.test(hote) || (IP_QUELCONQUE.test(hote) && dedupToutesIp())) return port ? `:${port}` : ":_";
  return lowerPy(netloc);
}

/** Chemin de `urlparse` : les `;params` du dernier segment retirés pour les schémas qui en ont. */
function cheminUrlparse(scheme: string, chemin: string): string {
  if (!USES_PARAMS.has(scheme) || !chemin.includes(";")) return chemin;
  const i = chemin.includes("/") ? chemin.indexOf(";", chemin.lastIndexOf("/")) : chemin.indexOf(";");
  return i < 0 ? chemin : chemin.slice(0, i);
}

/** `(site, chemin)` stables : identifiants opaques du chemin en `/*`, `/` en double ou final retirés. */
export function normalizeUrl(url: string): [string, string] {
  if (!url) return ["", "/"];
  try {
    const u = urlsplit(url);
    const site = normaliserSite(u.netloc || "");
    let chemin = cheminUrlparse(u.scheme, u.path) || "/";
    for (const [motif, remplacement] of ID_DANS_CHEMIN) chemin = chemin.replace(motif, remplacement);
    chemin = chemin.replace(/\/+/g, "/");
    if (longueurPy(chemin) > 1 && chemin.endsWith("/")) chemin = chemin.slice(0, -1);
    return [site, chemin || "/"];
  } catch {
    return ["", "/"];
  }
}

// ── Lecture ──────────────────────────────────────────────────────────────

export interface Selecteur {
  strategy: string;
  value: string;
  success_count: number;
  failure_count: number;
}

export interface NoeudDom {
  id: number;
  parent_id: number | null;
  role: string;
  name: string;
  node_type: string;
  region_tag: string | null;
  node_key: string;
  verified_count: number;
  last_ok: number | null;
  stale: boolean;
  selectors: Selecteur[];
  children: NoeudDom[];
}

export interface PageDom {
  roots: NoeudDom[];
  byId: Map<number, NoeudDom>;
}

/** `_top_selectors` : les meilleurs sélecteurs d'un nœud (taux de succès, succès, stratégie). */
export async function topSelecteurs(x: Executeur, idNoeud: number, limite: number): Promise<Selecteur[]> {
  const d = x.dialecte;
  return x.all<Selecteur & Record<string, unknown>>(
    `SELECT strategy, value, success_count, failure_count FROM ax_selectors WHERE node_id = ? ORDER BY (${castFloat("success_count", d)} / ${greatest(["success_count + failure_count", "1"], d)}) DESC, success_count DESC, strategy ASC LIMIT ?`,
    [idNoeud, limite],
  );
}

/** `load_dom_tree` : par chemin, racines et index des nœuds, enfants rattachés dans l'ordre des lignes. */
export async function loadDomTree(
  x: Executeur,
  site: string,
  options: { path?: string | null; includeStale?: boolean } = {},
): Promise<Map<string, PageDom>> {
  const out = new Map<string, PageDom>();
  if (!site) return out;
  try {
    const filtre = options.includeStale ? "" : " AND stale = 0";
    const colonnes =
      "SELECT id, path, parent_id, node_type, region_tag, role, name, node_key, verified_count, last_ok, stale FROM ax_nodes";
    const ordre = nullsFirst("parent_id", x.dialecte);
    const lignes =
      options.path !== undefined && options.path !== null
        ? await x.all(`${colonnes} WHERE site = ? AND path = ?${filtre} ORDER BY ${ordre}, role, name`, [
            site,
            options.path,
          ])
        : await x.all(`${colonnes} WHERE site = ?${filtre} ORDER BY path, ${ordre}, role, name`, [site]);
    for (const r of lignes) {
      const chemin = r["path"] as string;
      let page = out.get(chemin);
      if (page === undefined) {
        page = { roots: [], byId: new Map() };
        out.set(chemin, page);
      }
      const id = r["id"] as number;
      page.byId.set(id, {
        id,
        parent_id: (r["parent_id"] as number | null) ?? null,
        role: r["role"] as string,
        name: r["name"] as string,
        node_type: r["node_type"] as string,
        region_tag: (r["region_tag"] as string | null) ?? null,
        node_key: r["node_key"] as string,
        verified_count: r["verified_count"] as number,
        last_ok: (r["last_ok"] as number | null) ?? null,
        stale: veritePy(r["stale"]),
        selectors: r["node_type"] === "element" ? await topSelecteurs(x, id, 3) : [],
        children: [],
      });
    }
    for (const page of out.values()) {
      for (const noeud of page.byId.values()) {
        const parent = noeud.parent_id === null ? undefined : page.byId.get(noeud.parent_id);
        if (parent === undefined) page.roots.push(noeud);
        else parent.children.push(noeud);
      }
    }
  } catch (e) {
    log().warn(`[ax] load_dom_tree failed: ${texte(e)}`);
  }
  return out;
}

/** Chemins triés comme `sorted(…, key=lambda p: (p != "/", p))`. */
function cheminsTries(chemins: Iterable<string>): string[] {
  return [...chemins].sort((a, b) => Number(a !== "/") - Number(b !== "/") || comparePointsDeCode(a, b));
}

function serialiserNoeud(n: NoeudDom): Record<string, unknown> {
  return {
    id: n.id,
    role: n.role,
    name: n.name,
    node_type: n.node_type,
    region_tag: n.region_tag,
    verified_count: n.verified_count,
    stale: n.stale,
    selectors: n.selectors.map((s) => ({
      strategy: s.strategy,
      value: s.value,
      success_count: s.success_count || 0,
      failure_count: s.failure_count || 0,
    })),
    children: n.children.map(serialiserNoeud),
  };
}

/** `get_tree_json` : arbre complet (périmés compris) pour l'accordéon de l'interface. */
export async function getTreeJson(x: Executeur, site: string): Promise<{ site: string; paths: unknown[] }> {
  if (!site) return { site, paths: [] };
  const dom = await loadDomTree(x, site, { includeStale: true });
  return {
    site,
    paths: cheminsTries(dom.keys()).map((p) => ({
      path: p,
      roots: (dom.get(p)?.roots ?? []).map(serialiserNoeud),
    })),
  };
}

/** `_render_selector` : sélecteur compact pour le modèle, avec son taux de succès dès deux essais. */
export function renderSelector(sel: Selecteur): string {
  const sc = sel.success_count;
  const total = sc + sel.failure_count;
  const tag = total >= 2 ? `(${sc}/${total}, ${Math.trunc((100 * sc) / Math.max(total, 1))}%)` : "";
  const val = sel.value;
  let base: string;
  if (sel.strategy === "role_name") {
    const i = val.indexOf("|");
    base = i < 0 ? `role=${val} name=""` : `role=${val.slice(0, i)} name="${val.slice(i + 1)}"`;
  } else if (sel.strategy === "text" || sel.strategy === "label" || sel.strategy === "placeholder") {
    base = `${sel.strategy}="${val}"`;
  } else {
    base = `${sel.strategy}=${val}`;
  }
  return stripPy(`${base} ${tag}`);
}

/** `_render_dom_subtree` : branches `|-` / `` `- ``, sélecteurs sous les éléments, usage au-delà d'une vérification. */
function rendreSousArbre(noeud: NoeudDom, lignes: string[], dernier: boolean, prefixes: string[]): void {
  const retrait = prefixes.join("");
  const branche = dernier ? "`- " : "|- ";
  const vc = noeud.verified_count || 0;
  const usage = vc > 1 ? ` [used ${vc}x]` : "";
  if (noeud.node_type === "region") {
    const libelle = noeud.name ? `${noeud.role} "${noeud.name}"` : noeud.role;
    lignes.push(`${retrait}${branche}${libelle}${usage}`);
  } else {
    lignes.push(`${retrait}${branche}${noeud.role} "${noeud.name}"${usage}`);
    const prefixeSel = retrait + (dernier ? "   " : "|  ");
    for (const sel of noeud.selectors) lignes.push(`${prefixeSel}- ${renderSelector(sel)}`);
  }
  const suivants = [...prefixes, dernier ? "   " : "|  "];
  noeud.children.forEach((enfant, i) => {
    rendreSousArbre(enfant, lignes, i === noeud.children.length - 1, suivants);
  });
}

/** Indice du coffre : une ligne, sans identifiant ni mot de passe, seulement si une entrée confirmée du propriétaire porte cette origine exacte. */
async function indiceIdentifiants(
  x: Executeur,
  origine: string | null,
  proprietaire: string,
): Promise<string | null> {
  if (!origine || !proprietaire) return null;
  try {
    const r = await x.get(
      "SELECT 1 AS un FROM coffre_identifiants c JOIN users u ON u.id = c.user_id WHERE u.username = ? AND c.origin = ? AND c.origin_confirmed = 1",
      [proprietaire, origine],
    );
    return r === undefined
      ? null
      : "CREDENTIALS: a saved login exists for this origin; ask the user for /creds, then open pw_session(action='start', url=…, secure=true)";
  } catch {
    return null;
  }
}

/** `render_full_dom_for_prompt` : arbre DOM de toutes les pages connues (non périmées), tronqué à `maxChars`. */
export async function renderFullDomForPrompt(
  x: Executeur,
  site: string,
  maxChars = 6000,
  proprietaire = "",
  origine: string | null = null,
): Promise<string> {
  if (!site) return "";
  const dom = await loadDomTree(x, site);
  if (dom.size === 0) return "";
  let elements = 0;
  for (const page of dom.values())
    for (const n of page.byId.values()) if (n.node_type === "element") elements++;
  const lignes = [`KNOWN UI: ${site}`, `(${elements} elements across ${dom.size} paths, full DOM hierarchy)`];
  const indice = await indiceIdentifiants(x, origine, proprietaire);
  if (indice) lignes.push(indice);
  lignes.push("");
  for (const chemin of cheminsTries(dom.keys())) {
    const racines = dom.get(chemin)?.roots ?? [];
    if (racines.length === 0) continue;
    lignes.push(`[${chemin}]`);
    racines.forEach((r, i) => {
      rendreSousArbre(r, lignes, i === racines.length - 1, ["  "]);
    });
    lignes.push("");
  }
  const sortie = rstripPy(lignes.join("\n"));
  return longueurPy(sortie) > maxChars ? `${prefixePy(sortie, maxChars)}\n... (truncated)` : sortie;
}

// ── Injection dans le prompt (assemblage du contexte) ───────────────────

const URL_DANS_TEXTE = new RegExp(`https?://[^${BLANC_PY.slice(1, -1)}"'<>\`]+`, "gu");
const SESSION_DANS_RESULTAT = new RegExp(`"session_id"${BLANC_PY}*:${BLANC_PY}*"([a-zA-Z0-9_-]{6,})"`, "u");

/** `detect_sites_from_text` : sites normalisés des URL `http(s)://` du texte, sans doublon, dans l'ordre. */
export function detectSitesFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(URL_DANS_TEXTE)) {
    const [site] = normalizeUrl(m[0]);
    if (site && !out.includes(site)) out.push(site);
  }
  return out;
}

/** `detect_session_url` : dernière session Playwright citée par un résultat d'outil, puis son URL courante au service navigateur (2 s) ; `null` au moindre échec. */
export async function detectSessionUrl(
  messages: readonly unknown[] | null | undefined,
  owner = "",
  signal?: AbortSignal,
): Promise<string | null> {
  if (!messages || messages.length === 0) return null;
  let sessionId: string | null = null;
  for (const m of messages.slice(-40).reverse()) {
    if (!estDict(m)) return null;
    const c = veritePy(m["content"]) ? m["content"] : "";
    if (typeof c !== "string") continue;
    const trouve = SESSION_DANS_RESULTAT.exec(c);
    if (trouve) {
      sessionId = trouve[1] ?? null;
      break;
    }
  }
  if (!sessionId || !owner) return null;
  try {
    const base = process.env["PLAYWRIGHT_API_URL"] ?? "http://localhost:3000";
    const qs = new URLSearchParams({
      session_id: sessionId,
      owner: pwOwner(owner),
      skip_screenshot: "true",
      level: "lite",
    });
    const delai = AbortSignal.timeout(2000);
    const r = await fetch(`${base}/smart_inspect?${qs.toString()}`, {
      method: "GET",
      signal: signal ? AbortSignal.any([signal, delai]) : delai,
    });
    if (!r.ok) return null;
    const data = pyJsonLoads(new TextDecoder("utf-8", { fatal: true }).decode(await r.arrayBuffer()));
    if (!estDict(data)) return null;
    const url = veritePy(data["url"]) ? data["url"] : data["current_url"];
    return typeof url === "string" && url ? url : null;
  } catch {
    if (signal?.aborted) throw signal.reason;
    return null;
  }
}

/** Signal minimal avant d'injecter un site (`AX_INJECT_MIN_SIGNAL`, lu au chargement comme en Python). */
export const AX_INJECT_MIN_SIGNAL = intPy(process.env["AX_INJECT_MIN_SIGNAL"] || "3") || 3;

/** `_site_signal` : vérifications des transitions + éléments non périmés ; le seuil lui-même si la lecture échoue. */
export async function siteSignal(x: Executeur, site: string): Promise<number> {
  try {
    const t = await x.get("SELECT COALESCE(SUM(verified_count), 0) AS v FROM ax_transitions WHERE site = ?", [
      site,
    ]);
    const n = await x.get(
      "SELECT COUNT(*) AS n FROM ax_nodes WHERE site = ? AND node_type = 'element' AND stale = 0",
      [site],
    );
    return intPy(Number(t?.["v"] || 0)) + intPy(Number(n?.["n"] || 0));
  } catch {
    return AX_INJECT_MIN_SIGNAL;
  }
}

function libelleNoeud(n: NoeudDom): string {
  return n.name ? `${n.role} "${n.name}"` : n.role;
}

/** `render_focused_dom_for_prompt` : ancêtres, frères et descendants (deux niveaux) du dernier élément utilisé de la page. */
export async function renderFocusedDomForPrompt(
  x: Executeur,
  site: string,
  currentPath: string,
  options: { currentNodeId?: number | null; maxChars?: number; owner?: string; origin?: string | null } = {},
): Promise<string> {
  const maxChars = options.maxChars ?? 3000;
  if (!site || !currentPath) return "";
  const page = (await loadDomTree(x, site, { path: currentPath })).get(currentPath);
  if (page === undefined || page.byId.size === 0)
    return `KNOWN UI: ${site}\nFOCUSED ON: [${currentPath}] (no DOM recorded yet, use pw_page(op='inspect') to discover)`;
  const byId = page.byId;
  let courant: NoeudDom | undefined;
  if (veritePy(options.currentNodeId) && byId.has(options.currentNodeId as number))
    courant = byId.get(options.currentNodeId as number);
  else
    courant = [...byId.values()]
      .filter((n) => n.node_type === "element")
      .sort((a, b) => (b.last_ok || 0) - (a.last_ok || 0))[0];
  if (courant === undefined)
    return renderFullDomForPrompt(x, site, maxChars, options.owner ?? "", options.origin ?? null);
  const lignes = [`KNOWN UI: ${site}`, `FOCUSED ON: [${currentPath}] ${courant.role} "${courant.name}"`];
  const indice = await indiceIdentifiants(x, options.origin ?? null, options.owner ?? "");
  if (indice) lignes.push(indice);
  lignes.push("");
  const ancetres: NoeudDom[] = [];
  for (let n = courant; ancetres.length < 2;) {
    const parent = n.parent_id === null ? undefined : byId.get(n.parent_id);
    if (parent === undefined) break;
    ancetres.push(parent);
    n = parent;
  }
  if (ancetres.length) {
    lignes.push("Path to here (ancestors):");
    [...ancetres.reverse(), courant].forEach((n, i) => {
      lignes.push(
        `${"  ".repeat(i + 1)}\`- ${libelleNoeud(n)}${n === courant ? "  *** YOU ARE HERE ***" : ""}`,
      );
    });
    lignes.push("");
  }
  const parent = veritePy(courant.parent_id) ? byId.get(courant.parent_id as number) : undefined;
  if (parent !== undefined) {
    const freres = parent.children.filter((c) => c.id !== courant.id);
    if (freres.length) {
      lignes.push("Siblings (same parent):");
      for (const f of freres) {
        const sel = f.selectors[0];
        lignes.push(`  - ${f.role} "${f.name}"${sel ? `  [${renderSelector(sel)}]` : ""}`);
      }
      lignes.push("");
    }
  }
  const descendants: [NoeudDom, number][] = [];
  const descendre = (n: NoeudDom, profondeur: number): void => {
    if (profondeur >= 2) return;
    for (const c of n.children) {
      descendants.push([c, profondeur + 1]);
      descendre(c, profondeur + 1);
    }
  };
  descendre(courant, 0);
  if (descendants.length) {
    lignes.push("Below (1-2 hops):");
    for (const [d, profondeur] of descendants) {
      const retrait = "  ".repeat(profondeur);
      lignes.push(`${retrait}- ${d.role} "${d.name}"`);
      const sel = d.selectors[0];
      if (sel) lignes.push(`${retrait}     ${renderSelector(sel)}`);
    }
    lignes.push("");
  }
  const sortie = rstripPy(lignes.join("\n"));
  return longueurPy(sortie) > maxChars ? `${prefixePy(sortie, maxChars)}\n... (truncated)` : sortie;
}

/** `render_site_contextual` : rien sous le seuil de signal ; carte complète au premier appel, vue ciblée sur la page courante ensuite. */
export async function renderSiteContextual(
  x: Executeur,
  site: string,
  options: {
    currentPath?: string | null;
    maxChars?: number;
    iteration?: number;
    owner?: string;
    origin?: string | null;
  } = {},
): Promise<string> {
  const maxChars = options.maxChars ?? 4000;
  const owner = options.owner ?? "";
  const origin = options.origin ?? null;
  if (!site) return "";
  if (AX_INJECT_MIN_SIGNAL > 0 && (await siteSignal(x, site)) < AX_INJECT_MIN_SIGNAL) return "";
  if ((options.iteration ?? 0) === 0) return renderFullDomForPrompt(x, site, maxChars, owner, origin);
  if (options.currentPath)
    return renderFocusedDomForPrompt(x, site, options.currentPath, { maxChars, owner, origin });
  return renderFullDomForPrompt(x, site, maxChars, owner, origin);
}

/** Valeur REAL de la base : un flottant de Python (`1.0`), `null` gardé. */
function reel(v: unknown): FlottantPy | null {
  return v === null || v === undefined ? null : new FlottantPy(Number(v));
}

/** `list_sites_with_stats` : sites connus et leurs compteurs (les identifiants sont dans le coffre du compte, plus ici). */
export async function listSitesWithStats(x: Executeur): Promise<Record<string, unknown>[]> {
  try {
    const lignes = await x.all(
      `SELECT n.site,
              SUM(CASE WHEN n.node_type='element' AND n.stale=0 THEN 1 ELSE 0 END) AS elements,
              SUM(CASE WHEN n.node_type='region' THEN 1 ELSE 0 END) AS regions,
              COUNT(DISTINCT n.path) AS paths,
              MAX(n.last_ok) AS last_activity
         FROM ax_nodes n
        GROUP BY n.site
        ORDER BY last_activity DESC`,
    );
    const out: Record<string, unknown>[] = [];
    for (const r of lignes) {
      const site = r["site"] as string;
      const trans = await x.get("SELECT COUNT(*) AS n FROM ax_transitions WHERE site = ?", [site]);
      out.push({
        site,
        elements: r["elements"] || 0,
        regions: r["regions"] || 0,
        paths: r["paths"] || 0,
        transitions: trans ? trans["n"] : 0,
        last_activity: reel(r["last_activity"]),
      });
    }
    return out;
  } catch (e) {
    log().warn(`[ax] list_sites_with_stats failed: ${texte(e)}`);
    return [];
  }
}

/** `get_site_stats` : compteurs détaillés d'un site, `null` s'il n'a aucun nœud. */
export async function getSiteStats(x: Executeur, site: string): Promise<Record<string, unknown> | null> {
  if (!site) return null;
  try {
    const agg = await x.get(
      `SELECT
          SUM(CASE WHEN node_type='element' AND stale=0 THEN 1 ELSE 0 END) AS elements_ok,
          SUM(CASE WHEN node_type='element' AND stale=1 THEN 1 ELSE 0 END) AS elements_stale,
          SUM(CASE WHEN node_type='region' THEN 1 ELSE 0 END) AS regions,
          COUNT(DISTINCT path) AS paths,
          MAX(last_ok) AS last_activity,
          MIN(last_ok) AS first_activity
        FROM ax_nodes WHERE site = ?`,
      [site],
    );
    if (agg === undefined || agg["elements_ok"] === null || agg["elements_ok"] === undefined) return null;
    const trans = await x.get(
      "SELECT COUNT(*) AS n, SUM(verified_count) AS total_verifs FROM ax_transitions WHERE site = ?",
      [site],
    );
    const sel = await x.get(
      "SELECT COUNT(*) AS n FROM ax_selectors s JOIN ax_nodes n ON s.node_id = n.id WHERE n.site = ?",
      [site],
    );
    return {
      site,
      elements_ok: agg["elements_ok"] || 0,
      elements_stale: agg["elements_stale"] || 0,
      regions: agg["regions"] || 0,
      paths: agg["paths"] || 0,
      transitions: trans ? trans["n"] : 0,
      selectors: sel ? sel["n"] : 0,
      first_activity: reel(agg["first_activity"]),
      last_activity: reel(agg["last_activity"]),
    };
  } catch (e) {
    log().warn(`[ax] get_site_stats failed: ${texte(e)}`);
    return null;
  }
}

// ── Écriture ─────────────────────────────────────────────────────────────

export interface Suppressions {
  nodes: number;
  selectors: number;
  transitions: number;
}

/** `delete_site` : nœuds, sélecteurs et transitions du site ; `{error}` en échec. */
export async function deleteSite(
  x: Executeur,
  site: string,
): Promise<{ deleted: Suppressions } | { error: string }> {
  if (!site) return { deleted: { nodes: 0, selectors: 0, transitions: 0 } };
  try {
    const d = await verrouAx.avec(async () => {
      const sel = await x.get(
        "SELECT COUNT(*) AS n FROM ax_selectors s JOIN ax_nodes n ON s.node_id = n.id WHERE n.site = ?",
        [site],
      );
      await x.run("DELETE FROM ax_selectors WHERE node_id IN (SELECT id FROM ax_nodes WHERE site = ?)", [
        site,
      ]);
      const tr = (await x.run("DELETE FROM ax_transitions WHERE site = ?", [site])).changes;
      const nd = (await x.run("DELETE FROM ax_nodes WHERE site = ?", [site])).changes;
      return { nodes: nd, selectors: Number(sel?.["n"] ?? 0), transitions: tr };
    });
    log().info(`[ax] delete_site ${site} : nodes=${d.nodes} selectors=${d.selectors} trans=${d.transitions}`);
    return { deleted: d };
  } catch (e) {
    log().warn(`[ax] delete_site failed: ${texte(e)}`);
    return { error: texte(e) };
  }
}

/** `delete_sites_bulk` : site par site ; un site en échec n'est pas compté. */
export async function deleteSitesBulk(
  x: Executeur,
  sites: readonly string[],
): Promise<{ deleted: Suppressions & { sites_processed: number } }> {
  const bilan = { nodes: 0, selectors: 0, transitions: 0, sites_processed: 0 };
  for (const s of sites) {
    const r = await deleteSite(x, s);
    if ("deleted" in r) {
      bilan.nodes += r.deleted.nodes;
      bilan.selectors += r.deleted.selectors;
      bilan.transitions += r.deleted.transitions;
      bilan.sites_processed += 1;
    }
  }
  return { deleted: bilan };
}

/** `mark_site_stale` : éléments non périmés du site marqués périmés (rafraîchis au prochain usage). */
export async function markSiteStale(
  x: Executeur,
  site: string,
): Promise<{ marked: number } | { error: string }> {
  if (!site) return { marked: 0 };
  try {
    const n = await verrouAx.avec(
      async () =>
        (
          await x.run(
            "UPDATE ax_nodes SET stale = 1, stale_at = ? WHERE site = ? AND node_type = 'element' AND stale = 0",
            [Date.now() / 1000, site],
          )
        ).changes,
    );
    log().info(`[ax] mark_site_stale ${site} : ${n} elements marked`);
    return { marked: n };
  } catch (e) {
    log().warn(`[ax] mark_site_stale failed: ${texte(e)}`);
    return { error: texte(e) };
  }
}

/** `wipe_all` : toutes les tables AX vidées (administration). */
export async function wipeAll(x: Executeur): Promise<{ deleted: Suppressions } | { error: string }> {
  try {
    const d = await verrouAx.avec(async () => {
      const selectors = (await x.run("DELETE FROM ax_selectors")).changes;
      const transitions = (await x.run("DELETE FROM ax_transitions")).changes;
      const nodes = (await x.run("DELETE FROM ax_nodes")).changes;
      return { nodes, selectors, transitions };
    });
    log().warn(`[ax] WIPE ALL : nodes=${d.nodes} selectors=${d.selectors} trans=${d.transitions}`);
    return { deleted: d };
  } catch (e) {
    log().warn(`[ax] wipe_all failed: ${texte(e)}`);
    return { error: texte(e) };
  }
}
