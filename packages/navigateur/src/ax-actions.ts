// SPDX-License-Identifier: MIT
/** packages/navigateur/src/ax-actions.ts — mémoire AX écrite par les outils pw_* (port de shared_infra/memory/ax/actions.py, selectors.py, credentials.py, tree.search_nodes, transitions.find_path). */
import { BLANC_PY, estDict, intPy, lowerPy, prefixePy, stripPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { ciLike } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";

import { log, normalizeUrl, texte, topSelecteurs, verrouAx } from "./ax";
import type { Selecteur } from "./ax";
import { echapperDsl } from "./client";

const BLANCS = new RegExp(`${BLANC_PY}+`, "gu");
const REGIONS = new Set([
  "header",
  "nav",
  "main",
  "aside",
  "footer",
  "form",
  "dialog",
  "menu",
  "toolbar",
  "banner",
  "complementary",
  "contentinfo",
  "search",
  "navigation",
]);
const STRATEGIES: readonly (readonly [string, string])[] = [
  ["test_id", "test_id"],
  ["label", "label"],
  ["placeholder", "placeholder"],
  ["css", "css"],
  ["xpath", "xpath"],
  ["text", "text"],
];

/** `(x or "")` puis `.strip()` de Python : une valeur non textuelle lève comme l'AttributeError. */
function chaine(v: unknown): string {
  if (!veritePy(v)) return "";
  if (typeof v !== "string") throw new TypeError(`'${typeof v}' object has no attribute 'strip'`);
  return v;
}

/** `node_key` : `rôle:nom` en minuscules, blancs réduits, nom borné à 80 caractères. */
export function nodeKey(role: unknown, name: unknown): string {
  const r = lowerPy(stripPy(veritePy(role) ? chaine(role) : "generic"));
  const n = prefixePy(lowerPy(stripPy(chaine(name)).replace(BLANCS, " ")), 80);
  return `${r}:${n}`;
}

/** `extract_selectors_from_kwargs` : `[stratégie, valeur]` des sélecteurs non vides (rôle et nom d'abord). */
export function extractSelectorsFromKwargs(kw: Dict): [string, string][] {
  const out: [string, string][] = [];
  const role = stripPy(chaine(kw["role"]));
  const name = stripPy(chaine(kw["name"]));
  if (role) out.push(["role_name", `${role}|${name}`]);
  for (const [strategie, cle] of STRATEGIES) {
    const v = stripPy(chaine(kw[cle]));
    if (v) out.push([strategie, v]);
  }
  return out;
}

/** `infer_region` : région sémantique du résultat de pw_act (ou du rôle de repli), `body` sinon. */
export function inferRegion(result: unknown, fallbackRole = ""): string {
  if (!estDict(result)) return "body";
  for (const cle of ["region", "region_tag", "ancestor", "closest_landmark"]) {
    const v = result[cle];
    if (typeof v === "string" && REGIONS.has(lowerPy(v))) return lowerPy(v);
  }
  if (fallbackRole && REGIONS.has(lowerPy(fallbackRole))) return lowerPy(fallbackRole);
  return "body";
}

/** `is_action_success` : un dictionnaire sans `error` vrai. */
export function isActionSuccess(result: unknown): boolean {
  return estDict(result) && !("error" in result && veritePy(result["error"]));
}

async function regionPlate(x: Executeur, site: string, chemin: string, region: string): Promise<number> {
  const ligne = await x.get(
    "SELECT id FROM ax_nodes WHERE site=? AND path=? AND parent_id IS NULL AND node_type='region' AND region_tag=?",
    [site, chemin, region],
  );
  if (ligne) return Number(ligne["id"]);
  return x.insertId(
    "INSERT INTO ax_nodes (site, path, parent_id, node_type, region_tag, role, name, node_key, verified_count, last_ok, stale) VALUES (?, ?, NULL, 'region', ?, 'region', ?, ?, 0, ?, 0)",
    [site, chemin, region, region, `region:${region}`, Date.now() / 1000],
  );
}

/** `_resolve_ancestor_chain` : chaîne d'ancêtres DOM (du plus lointain au plus proche) retrouvée ou créée ; id du plus proche. */
async function chaineAncetres(
  x: Executeur,
  site: string,
  chemin: string,
  ancetres: unknown[],
): Promise<number | null> {
  let parent: number | null = null;
  const maintenant = Date.now() / 1000;
  for (const anc of [...ancetres].reverse()) {
    if (!estDict(anc)) continue;
    const role = lowerPy(
      stripPy(chaine(veritePy(anc["role"]) ? anc["role"] : veritePy(anc["tag"]) ? anc["tag"] : "region")),
    );
    const name = prefixePy(stripPy(chaine(anc["name"])), 80);
    const cle = name ? nodeKey(role, name) : `region:${role}`;
    const ligne: Dict | undefined =
      parent === null
        ? await x.get(
            "SELECT id FROM ax_nodes WHERE site=? AND path=? AND parent_id IS NULL AND node_type='region' AND node_key=?",
            [site, chemin, cle],
          )
        : await x.get(
            "SELECT id FROM ax_nodes WHERE site=? AND path=? AND parent_id=? AND node_type='region' AND node_key=?",
            [site, chemin, parent, cle],
          );
    if (ligne) {
      parent = Number(ligne["id"]);
      await x.run("UPDATE ax_nodes SET verified_count = verified_count + 1, last_ok = ? WHERE id = ?", [
        maintenant,
        parent,
      ]);
    } else {
      parent = await x.insertId(
        "INSERT INTO ax_nodes (site, path, parent_id, node_type, region_tag, role, name, node_key, verified_count, last_ok, stale) VALUES (?, ?, ?, 'region', ?, ?, ?, ?, 1, ?, 0)",
        [site, chemin, parent, role, role, name, cle, maintenant],
      );
    }
  }
  return parent;
}

export interface Action {
  readonly url: string;
  readonly role: string;
  readonly name: string;
  readonly result: unknown;
  readonly locatorKw?: Dict | null;
  readonly urlBefore?: string | null;
  readonly ancestors?: unknown;
}

/** `record_action` : succès → nœud (sous ses ancêtres DOM ou sa région ; parent nul jamais retrouvé, comme en Python), sélecteurs et transition ; échec → nœud connu marqué périmé ; `saved`, `stale` ou `null` (jamais d'exception). */
export async function recordAction(b: Base, a: Action): Promise<"saved" | "stale" | null> {
  try {
    const [site, path] = normalizeUrl(a.url || (estDict(a.result) ? String(a.result["url"] ?? "") : ""));
    if (!site || !a.role || !a.name) return null;
    const selecteurs = extractSelectorsFromKwargs({ ...(a.locatorKw ?? {}), role: a.role, name: a.name });
    if (!selecteurs.length) return null;
    const cle = nodeKey(a.role, a.name);
    const ok = isActionSuccess(a.result);
    const region = inferRegion(a.result);
    const maintenant = Date.now() / 1000;
    let depuis: string | null = null;
    let chemin = path;
    if (ok && a.urlBefore) {
      const [siteAvant, cheminAvant] = normalizeUrl(a.urlBefore);
      if (siteAvant === site && cheminAvant !== path) {
        depuis = cheminAvant;
        chemin = cheminAvant;
      }
    }
    const nom = prefixePy(a.name, 200);
    return await verrouAx.avec(() =>
      b.transaction(async (x) => {
        if (!ok) {
          const existant = await x.get(
            "SELECT id FROM ax_nodes WHERE site=? AND path=? AND node_type='element' AND node_key=?",
            [site, chemin, cle],
          );
          if (!existant) return null;
          const id = Number(existant["id"]);
          await x.run("UPDATE ax_nodes SET stale = 1, stale_at = ? WHERE id = ? AND stale = 0", [
            maintenant,
            id,
          ]);
          for (const [strategie, valeur] of selecteurs)
            await x.run(
              "UPDATE ax_selectors SET failure_count = failure_count + 1, last_fail = ? WHERE node_id=? AND strategy=? AND value=?",
              [maintenant, id, strategie, prefixePy(valeur, 300)],
            );
          return "stale" as const;
        }
        const regionId =
          Array.isArray(a.ancestors) && a.ancestors.length
            ? await chaineAncetres(x, site, chemin, a.ancestors)
            : await regionPlate(x, site, chemin, region);
        const existant = await x.get(
          "SELECT id FROM ax_nodes WHERE site=? AND path=? AND parent_id=? AND node_key=?",
          [site, chemin, regionId, cle],
        );
        let id: number;
        if (existant) {
          id = Number(existant["id"]);
          await x.run(
            "UPDATE ax_nodes SET verified_count = verified_count + 1, last_ok = ?, stale = 0, stale_at = NULL, role = ?, name = ? WHERE id = ?",
            [maintenant, a.role, nom, id],
          );
        } else {
          id = await x.insertId(
            "INSERT INTO ax_nodes (site, path, parent_id, node_type, region_tag, role, name, node_key, verified_count, last_ok, stale) VALUES (?, ?, ?, 'element', ?, ?, ?, ?, 1, ?, 0)",
            [site, chemin, regionId, region, a.role, nom, cle, maintenant],
          );
        }
        for (const [strategie, valeur] of selecteurs)
          await x.run(
            "INSERT INTO ax_selectors (node_id, strategy, value, success_count, failure_count, last_ok) VALUES (?, ?, ?, 1, 0, ?) ON CONFLICT(node_id, strategy, value) DO UPDATE SET success_count = ax_selectors.success_count + 1, last_ok = excluded.last_ok",
            [id, strategie, prefixePy(valeur, 300), maintenant],
          );
        if (depuis !== null)
          await x.run(
            "INSERT INTO ax_transitions (site, from_path, action_node_id, to_path, verified_count, last_ok) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(site, from_path, action_node_id, to_path) DO UPDATE SET verified_count = ax_transitions.verified_count + 1, last_ok = excluded.last_ok",
            [site, depuis, id, path, maintenant],
          );
        return "saved" as const;
      }),
    );
  } catch (e) {
    log().warn(`[ax] record_action failed: ${texte(e)}`);
    return null;
  }
}

/** `record_inspection` : nœuds périmés du chemin revus (présents) ou supprimés (absents), régions vides nettoyées. */
export async function recordInspection(
  b: Base,
  url: string,
  presents: unknown,
): Promise<{ revived: number; deleted: number }> {
  const [site, path] = normalizeUrl(url);
  const rien = { revived: 0, deleted: 0 };
  if (!site) return rien;
  const cles = new Set<string>();
  for (const n of Array.isArray(presents) ? presents : []) {
    if (!estDict(n)) continue;
    const r = veritePy(n["role"]) ? n["role"] : "";
    const nm = veritePy(n["name"])
      ? n["name"]
      : veritePy(n["accessible_name"])
        ? n["accessible_name"]
        : veritePy(n["text"])
          ? n["text"]
          : "";
    if (veritePy(r)) cles.add(nodeKey(r, nm));
  }
  try {
    return await verrouAx.avec(() =>
      b.transaction(async (x) => {
        const perimes = await x.all<{ id: number; node_key: string }>(
          "SELECT id, node_key FROM ax_nodes WHERE site=? AND path=? AND stale=1 AND node_type='element'",
          [site, path],
        );
        if (!perimes.length) return rien;
        const maintenant = Date.now() / 1000;
        const revus = perimes.filter((r) => cles.has(r.node_key)).map((r) => r.id);
        const supprimes = perimes.filter((r) => !cles.has(r.node_key)).map((r) => r.id);
        for (const id of revus)
          await x.run("UPDATE ax_nodes SET stale=0, stale_at=NULL, last_ok=? WHERE id=?", [maintenant, id]);
        for (const id of supprimes) await x.run("DELETE FROM ax_nodes WHERE id=?", [id]);
        await x.run(
          "DELETE FROM ax_nodes WHERE site=? AND path=? AND node_type='region' AND id NOT IN (SELECT parent_id FROM (SELECT DISTINCT parent_id FROM ax_nodes WHERE parent_id IS NOT NULL) AS parents)",
          [site, path],
        );
        if (revus.length || supprimes.length)
          log().info(
            `[ax] INSPECT site=${site} path=${path} revived=${revus.length} deleted=${supprimes.length}`,
          );
        return { revived: revus.length, deleted: supprimes.length };
      }),
    );
  } catch (e) {
    log().warn(`[ax] record_inspection failed: ${texte(e)}`);
    return rien;
  }
}

/** `save_credentials` : couple du compte pour le site normalisé (un seul, remplacé) ; propriétaire vide : refus. */
export async function saveCredentials(
  b: Base,
  url: string,
  username: string,
  password: string,
  owner: string,
): Promise<boolean> {
  if (!url || !username || !password || !owner) return false;
  const [site] = normalizeUrl(url);
  if (!site) return false;
  try {
    await verrouAx.avec(() =>
      b.run(
        "INSERT INTO ax_credentials (owner, site, username, password, last_ok, use_count) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(owner, site) DO UPDATE SET username = excluded.username, password = excluded.password, last_ok = excluded.last_ok, use_count = ax_credentials.use_count + 1",
        [owner, site, username, password, Date.now() / 1000],
      ),
    );
    log().info(`[ax] creds saved for owner=${owner} site=${site} user=${username}`);
    return true;
  } catch (e) {
    log().warn(`[ax] save_credentials failed: ${texte(e)}`);
    return false;
  }
}

/** `get_credentials` : couple de CE compte pour le site, `null` sinon (jamais celui d'un autre). */
export async function getCredentials(x: Executeur, url: string, owner: string): Promise<Dict | null> {
  if (!url || !owner) return null;
  const [site] = normalizeUrl(url);
  if (!site) return null;
  try {
    const r = await x.get(
      "SELECT username, password, use_count, last_ok FROM ax_credentials WHERE site = ? AND owner = ?",
      [site, owner],
    );
    return r
      ? { username: r["username"], password: r["password"], use_count: r["use_count"], last_ok: r["last_ok"] }
      : null;
  } catch (e) {
    log().warn(`[ax] get_credentials failed: ${texte(e)}`);
    return null;
  }
}

/** `search_nodes` : éléments du site dont le nom ou le rôle contient la requête, fiables d'abord, avec leur meilleur sélecteur. */
export async function searchNodes(
  x: Executeur,
  site: string,
  query: string,
  limit: unknown = 20,
): Promise<Dict[]> {
  if (!site || !query) return [];
  const q = `%${stripPy(query)}%`;
  const lim = Math.max(1, Math.min(intPy(limit), 100));
  const out: Dict[] = [];
  try {
    const lignes = await x.all(
      `SELECT n.id, n.path, n.role, n.name, n.region_tag, n.verified_count, n.stale FROM ax_nodes n WHERE n.site = ? AND n.node_type = 'element' AND ( ${ciLike("n.name", x.dialecte)} OR ${ciLike("n.role", x.dialecte)} ) ORDER BY n.stale ASC, n.verified_count DESC, n.name ASC LIMIT ?`,
      [site, q, q, lim],
    );
    for (const r of lignes) {
      const sels = await topSelecteurs(x, Number(r["id"]), 1);
      out.push({
        path: r["path"],
        role: r["role"],
        name: r["name"],
        region_tag: r["region_tag"],
        verified_count: r["verified_count"],
        stale: veritePy(r["stale"]),
        selector: sels[0] ?? null,
      });
    }
  } catch (e) {
    log().warn(`[ax] search_nodes failed: ${texte(e)}`);
  }
  return out;
}

interface Arete {
  from: string;
  to: string;
  action_node_id: number;
  action_role: unknown;
  action_name: unknown;
  verified_count: number;
}

/** Navigation directe (goto, back, forward) qu'enregistrait le Python comme un élément : pas un geste rejouable. */
function navigationDirecte(role: unknown, nom: unknown): boolean {
  return role === "navigation" && typeof nom === "string" && /^(goto|back|forward)(\s|$)/u.test(nom);
}

/** Cible DSL de pw_act tirée du meilleur sélecteur d'une étape (`role=…|name=…`, `label=…`, `css=…`…), `null` sinon. */
function cibleDsl(sel: Selecteur): string | null {
  if (sel.strategy === "role_name") {
    const i = sel.value.indexOf("|");
    const role = i < 0 ? sel.value : sel.value.slice(0, i);
    const nom = i < 0 ? "" : sel.value.slice(i + 1);
    return nom ? `role=${role}|name=${echapperDsl(nom)}` : `role=${role}`;
  }
  return ["text", "label", "placeholder", "test_id", "css", "xpath"].includes(sel.strategy)
    ? `${sel.strategy}=${echapperDsl(sel.value)}`
    : null;
}

/** `find_path` : plus court chemin de gestes connu vers `toPath` (BFS sur `ax_transitions`, nœuds périmés et navigations directes ignorés, transitions les plus vérifiées d'abord) ; sans départ, depuis toute AUTRE page connue (une étape au moins) ; meilleur sélecteur et cible DSL des seules étapes retenues. */
export async function findPath(
  x: Executeur,
  site: string,
  toPath: string,
  fromPath: string | null = null,
  maxDepth = 6,
): Promise<Dict> {
  const vide: Dict = { found: false, site, from_path: fromPath, to_path: toPath, depth: 0, steps: [] };
  if (!site || !toPath) return vide;
  if (fromPath !== null && fromPath === toPath)
    return { found: true, site, from_path: fromPath, to_path: toPath, depth: 0, steps: [] };
  try {
    const lignes = await x.all(
      "SELECT t.from_path, t.to_path, t.action_node_id, t.verified_count, n.role AS action_role, n.name AS action_name, n.stale AS action_stale FROM ax_transitions t JOIN ax_nodes n ON t.action_node_id = n.id WHERE t.site = ?",
      [site],
    );
    const suivants = new Map<string, Arete[]>();
    for (const r of lignes) {
      if (veritePy(r["action_stale"]) || navigationDirecte(r["action_role"], r["action_name"])) continue;
      const a: Arete = {
        from: String(r["from_path"]),
        to: String(r["to_path"]),
        action_node_id: Number(r["action_node_id"]),
        action_role: r["action_role"],
        action_name: r["action_name"],
        verified_count: Number(r["verified_count"]),
      };
      suivants.set(a.from, [...(suivants.get(a.from) ?? []), a]);
    }
    if (!suivants.size) return vide;
    const sources = fromPath !== null ? [fromPath] : [...suivants.keys()].filter((p) => p !== toPath);
    const parent = new Map<string, [string, Arete] | null>(sources.map((s) => [s, null]));
    const file: [string, number][] = sources.map((s) => [s, 0]);
    let atteint: string | null = null;
    for (let i = 0; i < file.length; i++) {
      const [noeud, profondeur] = file[i] as [string, number];
      if (noeud === toPath) {
        atteint = noeud;
        break;
      }
      if (profondeur >= maxDepth) continue;
      for (const a of [...(suivants.get(noeud) ?? [])].sort((p, q) => q.verified_count - p.verified_count)) {
        if (!parent.has(a.to)) {
          parent.set(a.to, [noeud, a]);
          file.push([a.to, profondeur + 1]);
        }
      }
    }
    if (atteint === null) return vide;
    const chaineAretes: Arete[] = [];
    for (let cur = atteint, p = parent.get(cur); p; cur = p[0], p = parent.get(cur)) chaineAretes.push(p[1]);
    chaineAretes.reverse();
    const steps: Dict[] = [];
    for (const a of chaineAretes) {
      const sels: Selecteur[] = await topSelecteurs(x, a.action_node_id, 1);
      steps.push({
        from: a.from,
        to: a.to,
        action_role: a.action_role,
        action_name: a.action_name,
        action_selector: sels[0] ?? null,
        action_target: sels[0] ? cibleDsl(sels[0]) : null,
        verified_count: a.verified_count,
      });
    }
    return {
      found: true,
      site,
      from_path: chaineAretes[0]?.from ?? fromPath ?? toPath,
      to_path: toPath,
      depth: steps.length,
      steps,
    };
  } catch (e) {
    log().warn(`[ax] find_path failed: ${texte(e)}`);
    return { ...vide, error: texte(e) };
  }
}
