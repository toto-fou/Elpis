// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/portee.ts — portée d'une requête : familles cachées selon le client (opencode, jeton d'outils, délégation) et l'URL `/mcp/<famille>`. */
import { strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { FAMILY_NAMES } from "@elpis/mcp";

/** `hidden_families_for_current_client` : la portée par l'URL ne fait que restreindre, jamais élargir. */
export function famillesCachees(
  claims: Dict | null,
  famille: string | null,
  famillesOpencode: ReadonlySet<string>,
): Set<string> {
  const cachees = new Set<string>();
  const c = claims ?? {};
  if (c["client_kind"] === "opencode")
    for (const f of FAMILY_NAMES) if (!famillesOpencode.has(f)) cachees.add(f);
  const permises = c["families"];
  if (
    (Array.isArray(permises) || permises instanceof Set) &&
    (veritePy(permises) || veritePy(c["delegated"]))
  ) {
    const liste = new Set([...(permises as Iterable<unknown>)].map((f) => strPy(f)));
    for (const f of FAMILY_NAMES) if (!liste.has(f)) cachees.add(f);
  } else if (c["client_kind"] === "tools") for (const f of FAMILY_NAMES) cachees.add(f);
  if (famille) for (const f of FAMILY_NAMES) if (f !== famille) cachees.add(f);
  return cachees;
}

/** Segment `<famille>` d'un chemin monté : `null` = toutes, `undefined` = famille inconnue (404). */
export function familleDuChemin(segment: string | null | undefined): string | null | undefined {
  const fam = (segment ?? "").replace(/^\/+|\/+$/gu, "").toLowerCase();
  if (!fam) return null;
  return FAMILY_NAMES.includes(fam) ? fam : undefined;
}
