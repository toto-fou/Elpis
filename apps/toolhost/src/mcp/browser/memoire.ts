// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/memoire.ts — `pw_memory` : requêtes compactes sur la mémoire AX de la base de l'hôte (sites du compte, chemin connu, recherche, éléments d'une page). */
import { reprPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { messageErreur } from "@elpis/mcp";
import { errPw, findPath, first, listSitesWithStats, loadDomTree, searchNodes } from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { borne } from "./appel";
import type { ServicesBrowser } from "./appel";

/** `page` : éléments connus d'une page, fiables d'abord, plafonnés à `limit` (200 au plus). */
async function elementsDePage(ax: Base, site: string, chemin: string, limit: unknown): Promise<Dict> {
  const page = (await loadDomTree(ax, site, { path: chemin })).get(chemin);
  const elements: Dict[] = [];
  for (const n of page?.byId.values() ?? [])
    if (n.node_type === "element")
      elements.push({
        role: n.role,
        name: n.name,
        region_tag: n.region_tag,
        verified_count: n.verified_count,
        stale: n.stale,
        selector: n.selectors[0] ?? null,
      });
  elements.sort(
    (p, q) =>
      Number(p["stale"]) - Number(q["stale"]) ||
      (Number(q["verified_count"]) || 0) - (Number(p["verified_count"]) || 0),
  );
  const cap = borne(limit, 1, 200);
  return {
    op: "page",
    site,
    path: chemin,
    count: Math.min(elements.length, cap),
    truncated: elements.length > cap,
    elements: elements.slice(0, cap),
  };
}

/** Requête `op` sur la mémoire AX ; arguments manquants refusés avec leur message Python. */
async function interroger(ax: Base, op: string, a: Dict): Promise<unknown> {
  const site = a["site"] as string;
  if (op === "sites") {
    const sites = await listSitesWithStats(ax);
    return { op: "sites", count: sites.length, sites };
  }
  if (op === "path") {
    if (!site || !a["to_path"]) return errPw("path requires site= and to_path=");
    const r = await findPath(
      ax,
      site,
      a["to_path"] as string,
      (a["from_path"] as string) || null,
      borne(a["max_depth"], 1, 12),
    );
    return { op: "path", ...r };
  }
  if (op === "find") {
    if (!site || !a["query"]) return errPw("find requires site= and query=");
    const matches = await searchNodes(ax, site, a["query"] as string, borne(a["limit"], 1, 100));
    return { op: "find", site, query: a["query"], count: matches.length, matches };
  }
  if (op === "page") {
    if (!site || !a["path"]) return errPw("page requires site= and path=");
    return elementsDePage(ax, site, a["path"] as string, a["limit"]);
  }
  return errPw(`unknown action ${reprPy(op)}`, "use: sites|path|find|page");
}

/** `pw_memory` : sans session ni service navigateur ; mémoire AX éteinte (base de l'hôte absente) = refus. */
export function pwMemory(s: ServicesBrowser) {
  return async (a: Dict, _ctx: ContexteAppel): Promise<unknown> => {
    const op = first(a["action"], a["op"]);
    if (!op)
      return errPw("action_required", "", {
        message: "pw_memory needs to know WHICH query to run.",
        fix: "pw_memory(action='sites'|'path'|'find'|'page'). action= (legacy synonym: op=) is required.",
      });
    const ax = s.ax();
    if (ax === null)
      return errPw(
        "ax memory unavailable",
        "backend.ax_memory failed to import in this process — check server logs for [ax] lines",
      );
    try {
      return await interroger(ax, op, a);
    } catch (e) {
      return errPw(`ax memory query failed: ${messageErreur(e)}`);
    }
  };
}
