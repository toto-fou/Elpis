// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-avatar-assistant.ts — écart voulu au Python : l'avatar de l'assistant est le logo de l'application ; `assistant_icon` et `assistant_avatar` ni écrits ni relus, `POST /api/settings/assistant-avatar` refusée (403) sans rien déposer. */
import { estDict, pyJsonDumps, pyJsonLoads } from "@elpis/commun";

export const ROUTE_AVATAR_ASSISTANT = "/api/settings/assistant-avatar";
export const REFUS_AVATAR_ASSISTANT =
  "L'avatar de l'assistant est le logo de l'application, réglé par l'administrateur dans la console.";
const CLES = ["assistant_icon", "assistant_avatar"];
const COMPACT = { ensureAscii: false, separators: [",", ":"] as [string, string], allowNan: false };

interface ReponseVecteur {
  statut?: number;
  corps?: unknown;
  type?: string | null;
  cache?: string | null;
}

/** Document JSON sans les clés de l'avatar de l'assistant (inchangé s'il n'en a pas), réécrit avec les options données. */
export function sansAvatarAssistant(
  texte: string,
  options: Parameters<typeof pyJsonDumps>[1] = COMPACT,
): string {
  const d = pyJsonLoads(texte);
  if (!estDict(d) || !CLES.some((k) => Object.hasOwn(d, k))) return texte;
  for (const k of CLES) delete d[k];
  return pyJsonDumps(d, options);
}

/** Réponse Python d'une étape ramenée au TS : réglages lus sans ces clés, envoi refusé, fichier `bot_…` jamais déposé. */
export function reponseSansAvatarAssistant<R extends ReponseVecteur>(
  methode: string,
  chemin: string,
  r: R,
): R {
  if (methode === "GET" && chemin === "/api/settings" && r.statut === 200 && typeof r.corps === "string")
    return { ...r, corps: sansAvatarAssistant(r.corps) };
  if (methode === "POST" && chemin === ROUTE_AVATAR_ASSISTANT)
    return {
      ...r,
      statut: 403,
      corps: pyJsonDumps({ detail: REFUS_AVATAR_ASSISTANT }, COMPACT),
      type: "application/json",
    };
  if (methode === "GET" && chemin.startsWith("/avatars/bot_"))
    return {
      ...r,
      statut: 404,
      corps: pyJsonDumps({ detail: "Avatar not found" }, COMPACT),
      type: "application/json",
      cache: null,
    };
  return r;
}
