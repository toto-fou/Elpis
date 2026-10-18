// SPDX-License-Identifier: MIT
/** apps/toolhost/src/trames.ts — trames du bureau servies par l'hôte (shared_infra/desktop/routes.py) : PNG ou JPEG d'une capture, à son seul propriétaire. */
import { readFile, stat } from "node:fs/promises";

import { desktopFramePath, getDesktopFrameOwner, sniffMime, TOKEN_RE } from "@elpis/bureau";
import { HttpError } from "@elpis/commun";
import { config } from "@elpis/config";
import { entrees, py } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Famille } from "./app";
import type { Journal } from "./journal";

export const CHEMIN_TRAME = "/api/desktop/frame/:token";
const SANS_CACHE = { "cache-control": "no-store, no-cache, must-revalidate", pragma: "no-cache" } as const;

export interface ContexteTrames {
  readonly journal: Journal;
  /** `DESKTOP_FRAME_STRICT_OWNER` (défaut : la config) ; strict, un propriétaire inconnu vaut 404. */
  readonly strict?: () => boolean;
}

async function estFichier(chemin: string): Promise<boolean> {
  try {
    return (await stat(chemin)).isFile();
  } catch {
    return false;
  }
}

async function servirTrame(
  ctx: ContexteTrames,
  req: FastifyRequest,
  rep: FastifyReply,
): Promise<FastifyReply> {
  const { token } = entrees(req, { path: { token: py.str() } }).path;
  if (!token || !TOKEN_RE.test(token)) throw new HttpError(400, "Invalid frame token");
  const proprietaire = await getDesktopFrameOwner(token);
  const attendu = req.identite?.username ?? `user_${Math.trunc(req.identite?.user_id ?? 0)}`;
  if (proprietaire !== null && proprietaire !== attendu) {
    ctx.journal.warn(`[desktop_frame] DENIED user=${attendu} token owned by=${proprietaire}`);
    throw new HttpError(403, "Access denied: not your frame");
  }
  const strict = ctx.strict ? ctx.strict() : config.DESKTOP_FRAME_STRICT_OWNER;
  if (proprietaire === null && strict) throw new HttpError(404, "Frame not available");
  const chemin = desktopFramePath(token);
  if (!(await estFichier(chemin))) throw new HttpError(404, "Frame not available");
  let octets: Buffer;
  try {
    octets = await readFile(chemin);
  } catch (e) {
    throw new HttpError(503, `Frame unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  return rep.code(200).headers(SANS_CACHE).type(sniffMime(octets)).send(octets);
}

export function creerFamilleTrames(ctx: ContexteTrames): Famille {
  return {
    nom: "trames",
    routes: [
      {
        methode: "GET",
        chemin: CHEMIN_TRAME,
        processus: ["toolhost"],
        acces: "enveloppe",
        traiter: (req, rep) => servirTrame(ctx, req, rep),
      },
    ],
  };
}
