// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/ecriture-sous-agent.ts — `writable_paths` d'un sous-agent vérifiés aussi sur le chemin RÉSOLU par l'agent du bac (liens internes suivis, ancien rangement `git_repos/` de `git_write`), après la garde lexicale. */
import type { Dict } from "@elpis/commun";
import { AgentError } from "@elpis/fichiers";
import { err } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { current, lireSousAgent, refusHorsChemins, relatifBac, toContainer } from "@elpis/securite";
import type { SousAgent } from "@elpis/securite";

import type { Espace } from "./espace";
import { cheminReel } from "./fs/acces";

/** Périmètre du sous-agent de l'appel (identité, sinon `_meta`) quand ses écritures sont bornées ; `null` sinon. */
export function sousAgentBorne(
  ctx: ContexteAppel,
): (SousAgent & { writable_paths: readonly string[] }) | null {
  const sa = current()?.subagent ?? lireSousAgent(ctx.meta?.["subagent"]);
  return sa && !sa.read_only && sa.writable_paths !== null
    ? { ...sa, writable_paths: sa.writable_paths }
    : null;
}

/** Refus `path_not_writable` si l'un des chemins (relatifs à /work), une fois résolu, sort des préfixes permis ; `null` sinon. */
export async function refusEcritureResolue(
  esp: Espace,
  prefixes: readonly string[],
  rels: readonly string[],
): Promise<Dict | null> {
  for (const rel of rels) {
    let reel: string | null;
    try {
      reel = await cheminReel(esp, rel);
    } catch (e) {
      if (!(e instanceof AgentError)) throw e;
      reel = null;
    }
    const affiche =
      reel === rel
        ? toContainer(rel)
        : `${toContainer(rel)} (resolved: ${reel === null ? "unresolved" : toContainer(reel)})`;
    const refus = refusHorsChemins(prefixes, affiche, reel);
    if (refus !== null) return err(refus.code, refus.message, { fix: refus.fix });
  }
  return null;
}

/** Garde des outils de fichiers : chemins écrits relus depuis les arguments, puis résolus. */
export async function refusFichiersResolus(
  ctx: ContexteAppel,
  chemins: readonly string[] | null,
  espace: () => Promise<Espace>,
): Promise<Dict | null> {
  const sa = sousAgentBorne(ctx);
  if (sa === null || chemins === null) return null;
  const rels = chemins.map(relatifBac).filter((r): r is string => r !== null);
  return rels.length ? refusEcritureResolue(await espace(), sa.writable_paths, rels) : null;
}
