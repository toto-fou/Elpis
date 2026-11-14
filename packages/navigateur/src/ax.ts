// SPDX-License-Identifier: MIT
/** packages/navigateur/src/ax.ts — mémoire AX des sites vue par les routes : URL normalisées, arbre DOM, rendu ASCII, statistiques (identifiants fournis par l'appelant, depuis le coffre) et purges, anciens identifiants `ax_credentials` compris (port de shared_infra/memory/ax/). */
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
import { neutraliserJetonsRole, neutraliserMarqueursTour } from "@elpis/securite";

import { requeteService, serviceNavigateur } from "./mode";
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

/** Origine exacte (schéma, hôte, port) d'une URL http(s), vide sinon : clé des identifiants de sites, sans alias ni réduction d'IP. */
export function origineExacte(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

/** Une clé d'`ax_credentials` sans schéma est une ancienne clé de site : son origine est inconnue, elle n'est jamais remplie. */
const cleAvecOrigine = (cle: unknown): boolean => String(cle).includes("://");

/** Site AX d'une clé d'`ax_credentials`, pour l'affichage et les purges seulement. */
const siteDeCle = (cle: unknown): string =>
  cleAvecOrigine(cle) ? normalizeUrl(String(cle))[0] : String(cle);

/** Identifiant d'un site montré par la console : nom de connexion, origine exacte, usages ; jamais de valeur. */
export interface IdentifiantSite {
  readonly username: string | null;
  readonly origin: string;
  readonly use_count: number;
  readonly last_ok: number | null;
}

/** Identifiant connu d'un site AX (secret du coffre du compte qui consulte), `undefined` sinon. */
export type IdentifiantsDesSites = (site: string) => IdentifiantSite | undefined;

/** Identifiants rattachés à un site AX retirés (d'un compte, ou de tous) ; nombre de lignes retirées. */
async function retirerIdentifiantsDuSite(
  x: Executeur,
  site: string,
  proprietaire: string | null,
): Promise<number> {
  const lignes = await (proprietaire === null
    ? x.all<{ owner: string; site: string }>("SELECT owner, site FROM ax_credentials")
    : x.all<{ owner: string; site: string }>("SELECT owner, site FROM ax_credentials WHERE owner = ?", [
        proprietaire,
      ]));
  let retirees = 0;
  for (const r of lignes)
    if (siteDeCle(r.site) === site)
      retirees += (await x.run("DELETE FROM ax_credentials WHERE owner = ? AND site = ?", [r.owner, r.site]))
        .changes;
  return retirees;
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

// ── Rendu pour le modèle : la mémoire est partagée entre comptes et nourrie par les pages ──

const ROLES_ARIA: ReadonlySet<string> = new Set(
  (
    "alert alertdialog application article banner blockquote button caption cell checkbox code columnheader " +
    "combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form " +
    "generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu " +
    "menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation " +
    "progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider " +
    "spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer " +
    "toolbar tooltip tree treegrid treeitem"
  ).split(" "),
);
const NOM_MAX = 80;
const CHEMIN_MAX = 120;
/** Plafond d'écriture de `recordAction` : aucun sélecteur enregistré n'est écarté au rendu. */
const SELECTEUR_MAX = 300;
const INVISIBLES = /\p{Cf}+/gu;
const NON_IMPRIMABLES = /[\p{Cc}\u2028\u2029]+/gu;
const CHEVRON_DE_BALISE = /<(?!\s*(?:=|[0-9](?![xX])))/gu;

function borner(texte: string, max: number): string {
  return longueurPy(texte) <= max ? texte : `${prefixePy(texte, max - 1)}…`;
}

/** Rôle ARIA connu, `generic` sinon : la colonne vient d'un attribut de page ou d'un argument d'outil. */
export function roleInerte(role: unknown): string {
  const r = lowerPy(stripPy(String(role ?? "")));
  return ROLES_ARIA.has(r) ? r : "generic";
}

/** Valeur recopiable telle quelle par le modèle : `>`, `"` et comparaisons XPath gardés, rien qui ouvre une balise ni une ligne. */
function valeurInerte(valeur: string): string {
  return valeur.replace(INVISIBLES, "").replace(NON_IMPRIMABLES, " ").replace(CHEVRON_DE_BALISE, "&lt;");
}

/** Nom ou libellé inerte et borné, `&` et `"` gardés : une seule ligne, aucune balise ni marqueur. */
export function nomInerte(nom: unknown): string {
  const inerte = neutraliserMarqueursTour(neutraliserJetonsRole(valeurInerte(String(nom ?? ""))));
  return borner(stripPy(inerte), NOM_MAX);
}

/** Chemin ou site inerte et borné. */
export function cheminInerte(chemin: unknown): string {
  return borner(valeurInerte(String(chemin ?? "")), CHEMIN_MAX);
}

/** Sélecteur rendu tel quel par `pw_memory` : valeur inerte, écarté (`null`) au-delà du plafond d'écriture. */
export function selecteurInerte<T extends { value?: unknown }>(sel: T | null | undefined): T | null {
  if (!sel) return null;
  const v = valeurInerte(String(sel.value ?? ""));
  return longueurPy(v) > SELECTEUR_MAX ? null : { ...sel, value: v };
}

/** Cible DSL rendue par `pw_memory` : inerte, écartée (`null`) au-delà du plafond. */
export function cibleInerte(cible: unknown): string | null {
  if (cible === null || cible === undefined) return null;
  const v = valeurInerte(String(cible));
  return longueurPy(v) > SELECTEUR_MAX + NOM_MAX ? null : v;
}

function libelleElement(n: NoeudDom): string {
  return `${roleInerte(n.role)} "${nomInerte(n.name)}"`;
}

function libelleNoeud(n: NoeudDom): string {
  return n.name ? libelleElement(n) : roleInerte(n.role);
}

/** `_render_selector` : sélecteur compact pour le modèle, avec son taux de succès dès deux essais ; texte coupé (le service cherche une sous-chaîne), `""` pour ce qu'une coupe casserait ou un rôle inconnu. */
export function renderSelector(sel: Selecteur): string {
  const sc = sel.success_count;
  const total = sc + sel.failure_count;
  const tag = total >= 2 ? `(${sc}/${total}, ${Math.trunc((100 * sc) / Math.max(total, 1))}%)` : "";
  const val = valeurInerte(sel.value);
  let base: string;
  if (sel.strategy === "role_name") {
    const i = val.indexOf("|");
    const role = lowerPy(i < 0 ? val : val.slice(0, i));
    if (role && !ROLES_ARIA.has(role)) return "";
    base = i < 0 ? `role=${role} name=""` : `role=${role} name="${prefixePy(val.slice(i + 1), NOM_MAX)}"`;
  } else if (sel.strategy === "text" || sel.strategy === "label" || sel.strategy === "placeholder") {
    base = `${sel.strategy}="${prefixePy(val, NOM_MAX)}"`;
  } else {
    if (longueurPy(val) > SELECTEUR_MAX) return "";
    base = `${sel.strategy}=${val}`;
  }
  return stripPy(`${base} ${tag}`);
}

/** Meilleur sélecteur rendable d'un nœud, `""` sans aucun. */
function premierSelecteur(n: NoeudDom): string {
  return n.selectors.map((s) => renderSelector(s)).find((r) => r) ?? "";
}

/** `_render_dom_subtree` : branches `|-` / `` `- ``, sélecteurs sous les éléments, usage au-delà d'une vérification. */
function rendreSousArbre(noeud: NoeudDom, lignes: string[], dernier: boolean, prefixes: string[]): void {
  const retrait = prefixes.join("");
  const branche = dernier ? "`- " : "|- ";
  const vc = noeud.verified_count || 0;
  const usage = vc > 1 ? ` [used ${vc}x]` : "";
  if (noeud.node_type === "region") {
    lignes.push(`${retrait}${branche}${libelleNoeud(noeud)}${usage}`);
  } else {
    lignes.push(`${retrait}${branche}${libelleElement(noeud)}${usage}`);
    const prefixeSel = retrait + (dernier ? "   " : "|  ");
    for (const sel of noeud.selectors) {
      const rendu = renderSelector(sel);
      if (rendu) lignes.push(`${prefixeSel}- ${rendu}`);
    }
  }
  const suivants = [...prefixes, dernier ? "   " : "|  "];
  noeud.children.forEach((enfant, i) => {
    rendreSousArbre(enfant, lignes, i === noeud.children.length - 1, suivants);
  });
}

/** `render_full_dom_for_prompt` : arbre DOM de toutes les pages connues (non périmées), tronqué à `maxChars` ; plus d'indice d'identifiants (le coffre les annonce par le bloc `<secrets>`). */
export async function renderFullDomForPrompt(
  x: Executeur,
  site: string,
  maxChars = 6000,
  _proprietaire = "",
): Promise<string> {
  if (!site) return "";
  const dom = await loadDomTree(x, site);
  if (dom.size === 0) return "";
  let elements = 0;
  for (const page of dom.values())
    for (const n of page.byId.values()) if (n.node_type === "element") elements++;
  const lignes = [
    `KNOWN UI: ${cheminInerte(site)}`,
    `(${elements} elements across ${dom.size} paths, full DOM hierarchy)`,
    "",
  ];
  for (const chemin of cheminsTries(dom.keys())) {
    const racines = dom.get(chemin)?.roots ?? [];
    if (racines.length === 0) continue;
    lignes.push(`[${cheminInerte(chemin)}]`);
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

/** `detect_session_url` : dernière session Playwright citée par un résultat d'outil, puis son URL courante au service navigateur du bac du compte (2 s) ; `null` au moindre échec. */
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
    const qs = new URLSearchParams({
      session_id: sessionId,
      owner: pwOwner(owner),
      skip_screenshot: "true",
      level: "lite",
    });
    const r = await requeteService(serviceNavigateur(owner), `/smart_inspect?${qs.toString()}`, {
      delaiMs: 2000,
      ...(signal ? { signal } : {}),
    });
    if (r.statut !== 200) return null;
    const d = pyJsonLoads(new TextDecoder("utf-8", { fatal: true }).decode(r.corps));
    const u = estDict(d) ? (veritePy(d["url"]) ? d["url"] : d["current_url"]) : null;
    return typeof u === "string" && u ? u : null;
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

/** `render_focused_dom_for_prompt` : ancêtres, frères et descendants (deux niveaux) du dernier élément utilisé de la page. */
export async function renderFocusedDomForPrompt(
  x: Executeur,
  site: string,
  currentPath: string,
  options: { currentNodeId?: number | null; maxChars?: number; owner?: string } = {},
): Promise<string> {
  const maxChars = options.maxChars ?? 3000;
  if (!site || !currentPath) return "";
  const page = (await loadDomTree(x, site, { path: currentPath })).get(currentPath);
  if (page === undefined || page.byId.size === 0)
    return `KNOWN UI: ${cheminInerte(site)}\nFOCUSED ON: [${cheminInerte(currentPath)}] (no DOM recorded yet, use pw_page(op='inspect') to discover)`;
  const byId = page.byId;
  let courant: NoeudDom | undefined;
  if (veritePy(options.currentNodeId) && byId.has(options.currentNodeId as number))
    courant = byId.get(options.currentNodeId as number);
  else
    courant = [...byId.values()]
      .filter((n) => n.node_type === "element")
      .sort((a, b) => (b.last_ok || 0) - (a.last_ok || 0))[0];
  if (courant === undefined) return renderFullDomForPrompt(x, site, maxChars);
  const lignes = [
    `KNOWN UI: ${cheminInerte(site)}`,
    `FOCUSED ON: [${cheminInerte(currentPath)}] ${libelleElement(courant)}`,
    "",
  ];
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
        const sel = premierSelecteur(f);
        lignes.push(`  - ${libelleElement(f)}${sel ? `  [${sel}]` : ""}`);
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
      lignes.push(`${retrait}- ${libelleElement(d)}`);
      const sel = premierSelecteur(d);
      if (sel) lignes.push(`${retrait}     ${sel}`);
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
  options: { currentPath?: string | null; maxChars?: number; iteration?: number; owner?: string } = {},
): Promise<string> {
  const maxChars = options.maxChars ?? 4000;
  const owner = options.owner ?? "";
  if (!site) return "";
  if (AX_INJECT_MIN_SIGNAL > 0 && (await siteSignal(x, site)) < AX_INJECT_MIN_SIGNAL) return "";
  if ((options.iteration ?? 0) === 0) return renderFullDomForPrompt(x, site, maxChars, owner);
  if (options.currentPath)
    return renderFocusedDomForPrompt(x, site, options.currentPath, { maxChars, owner });
  return renderFullDomForPrompt(x, site, maxChars, owner);
}

/** Valeur REAL de la base : un flottant de Python (`1.0`), `null` gardé. */
function reel(v: unknown): FlottantPy | null {
  return v === null || v === undefined ? null : new FlottantPy(Number(v));
}

/** `list_sites_with_stats` : sites connus et leurs compteurs ; identifiants donnés par l'appelant (coffre du compte qui consulte), aucun sans lui. */
export async function listSitesWithStats(
  x: Executeur,
  identifiants: IdentifiantsDesSites | null = null,
): Promise<Record<string, unknown>[]> {
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
      const cred = identifiants?.(site);
      out.push({
        site,
        elements: r["elements"] || 0,
        regions: r["regions"] || 0,
        paths: r["paths"] || 0,
        transitions: trans ? trans["n"] : 0,
        has_credentials: cred !== undefined,
        cred_username: cred ? cred.username : null,
        cred_origin: cred ? cred.origin : null,
        cred_use_count: cred ? cred.use_count : 0,
        last_activity: reel(r["last_activity"]),
      });
    }
    return out;
  } catch (e) {
    log().warn(`[ax] list_sites_with_stats failed: ${texte(e)}`);
    return [];
  }
}

/** `get_site_stats` : compteurs détaillés d'un site, `null` s'il n'a aucun nœud ; identifiants donnés par l'appelant (coffre du compte qui consulte). */
export async function getSiteStats(
  x: Executeur,
  site: string,
  identifiants: IdentifiantsDesSites | null = null,
): Promise<Record<string, unknown> | null> {
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
    const cred = identifiants?.(site);
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
      has_credentials: cred !== undefined,
      cred_username: cred ? cred.username : null,
      cred_origin: cred ? cred.origin : null,
      cred_use_count: cred ? cred.use_count : 0,
      cred_last_ok: cred ? reel(cred.last_ok) : null,
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
  credentials: number;
}

/** `delete_site` : nœuds, sélecteurs et transitions du site (identifiants de tous les comptes si demandé) ; `{error}` en échec. */
export async function deleteSite(
  x: Executeur,
  site: string,
  includeCredentials = false,
): Promise<{ deleted: Suppressions } | { error: string }> {
  if (!site) return { deleted: { nodes: 0, selectors: 0, transitions: 0, credentials: 0 } };
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
      const cr = includeCredentials ? await retirerIdentifiantsDuSite(x, site, null) : 0;
      return { nodes: nd, selectors: Number(sel?.["n"] ?? 0), transitions: tr, credentials: cr };
    });
    log().info(
      `[ax] delete_site ${site} : nodes=${d.nodes} selectors=${d.selectors} trans=${d.transitions} creds=${d.credentials}`,
    );
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
  includeCredentials = false,
): Promise<{ deleted: Suppressions & { sites_processed: number } }> {
  const bilan = { nodes: 0, selectors: 0, transitions: 0, credentials: 0, sites_processed: 0 };
  for (const s of sites) {
    const r = await deleteSite(x, s, includeCredentials);
    if ("deleted" in r) {
      bilan.nodes += r.deleted.nodes;
      bilan.selectors += r.deleted.selectors;
      bilan.transitions += r.deleted.transitions;
      bilan.credentials += r.deleted.credentials;
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

/** `delete_credentials` : URL normalisée ou site tel quel, avec toutes les origines de ce site ; `proprietaire` absent = tous les comptes (administration). */
export async function deleteCredentials(
  x: Executeur,
  urlOuSite: string,
  proprietaire: string | null = null,
): Promise<boolean> {
  if (!urlOuSite) return false;
  const site = urlOuSite.startsWith("http") ? normalizeUrl(urlOuSite)[0] : urlOuSite;
  if (!site) return false;
  try {
    return (await verrouAx.avec(() => retirerIdentifiantsDuSite(x, site, proprietaire))) > 0;
  } catch {
    return false;
  }
}

/** Identifiants de sites d'un compte supprimé, tous sites confondus ; nombre de lignes retirées. */
export async function deleteOwnerCredentials(x: Executeur, proprietaire: string): Promise<number> {
  if (!proprietaire) return 0;
  return (await verrouAx.avec(() => x.run("DELETE FROM ax_credentials WHERE owner = ?", [proprietaire])))
    .changes;
}

/** `wipe_all` : toutes les tables AX vidées (administration). */
export async function wipeAll(x: Executeur): Promise<{ deleted: Suppressions } | { error: string }> {
  try {
    const d = await verrouAx.avec(async () => {
      const selectors = (await x.run("DELETE FROM ax_selectors")).changes;
      const transitions = (await x.run("DELETE FROM ax_transitions")).changes;
      const nodes = (await x.run("DELETE FROM ax_nodes")).changes;
      const credentials = (await x.run("DELETE FROM ax_credentials")).changes;
      return { nodes, selectors, transitions, credentials };
    });
    log().warn(
      `[ax] WIPE ALL : nodes=${d.nodes} selectors=${d.selectors} trans=${d.transitions} creds=${d.credentials}`,
    );
    return { deleted: d };
  } catch (e) {
    log().warn(`[ax] wipe_all failed: ${texte(e)}`);
    return { error: texte(e) };
  }
}
