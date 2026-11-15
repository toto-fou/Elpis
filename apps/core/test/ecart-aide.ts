// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-aide.ts — écart voulu au Python : l'aide ne sert plus que le guide utilisateur (`doc` ignoré, plus de champ `doc`, documentation développeur jamais lue). */
import { estDict, pyJsonDumps, pyJsonLoads } from "@elpis/commun";

const COMPACT = { ensureAscii: false, separators: [",", ":"] as [string, string], allowNan: false };

interface ReponseVecteur {
  statut?: number;
  corps?: unknown;
}

/** Réponses Python de `/api/help/readme` ramenées au TS : toujours le dernier guide utilisateur servi, sans `doc`. */
export function ecartAide(): <R extends ReponseVecteur>(methode: string, chemin: string, r: R) => R {
  let guide: unknown = null;
  return (methode, chemin, r) => {
    if (methode !== "GET" || !chemin.startsWith("/api/help/readme") || r.statut !== 200) return r;
    const d = typeof r.corps === "string" ? pyJsonLoads(r.corps) : null;
    if (!estDict(d)) return r;
    if (d["doc"] === "user") guide = d["content"];
    return { ...r, corps: pyJsonDumps({ content: guide }, COMPACT) };
  };
}
