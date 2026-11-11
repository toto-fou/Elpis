// SPDX-License-Identifier: MIT
/** apps/toolhost/src/captures.ts — captures servies par l'hôte (shared_infra/routes/tools.py) : PNG du service navigateur du bac du compte, à son seul propriétaire. */
import { HttpError, lowerPy } from "@elpis/commun";
import { entrees, py } from "@elpis/http";
import { getPwSessionOwner, requeteService } from "@elpis/navigateur";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Famille } from "./app";
import type { Journal } from "./journal";
import { serviceLu } from "./mcp/browser/bac";

export const CHEMIN_CAPTURE = "/api/playwright/screenshot/:filename";
const MOTIF_ETAPE = /^(?:step|shot)_([A-Za-z0-9-]{8,64})_[0-9]+\.png$/u;
const MOTIF_AUTRE = /^(?:live|smart|view)_([A-Za-z0-9-]{8,64})\.png$/u;
const SANS_CACHE = { "cache-control": "no-store, no-cache, must-revalidate", pragma: "no-cache" } as const;
const ESSAIS = 4;
// Codes d'une connexion impossible (`httpx.ConnectError` : « All connection attempts failed »).
const CONNEXION = /^(E(?!RR_)[A-Z_]+|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/u;

export interface ContexteCaptures {
  readonly journal: Journal;
  /** Attente entre deux essais (tests). */
  readonly attendre?: (ms: number) => Promise<void>;
}

function messageTransport(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNEXION.test(code)) return "All connection attempts failed";
  return e instanceof Error ? e.message : String(e);
}

/** Nom de capture accepté et identifiant de session qu'il porte ; 400 sinon (même contrôle que le Python). */
export function sessionDeLaCapture(filename: string): string {
  const sur = filename.slice(filename.lastIndexOf("/") + 1);
  if (sur !== filename || sur.includes("..") || !lowerPy(sur).endsWith(".png"))
    throw new HttpError(400, "Invalid filename");
  const m = MOTIF_ETAPE.exec(sur) ?? MOTIF_AUTRE.exec(sur);
  if (!m?.[1]) throw new HttpError(400, "Invalid screenshot filename pattern");
  return m[1];
}

async function servirCapture(
  ctx: ContexteCaptures,
  req: FastifyRequest,
  rep: FastifyReply,
): Promise<FastifyReply> {
  const { filename } = entrees(req, { path: { filename: py.str() } }).path;
  const sid = sessionDeLaCapture(filename);
  const attendu = req.identite?.username ?? `user_${Math.trunc(req.identite?.user_id ?? 0)}`;
  const proprietaire = await getPwSessionOwner(sid);
  if (proprietaire === null) {
    ctx.journal.warn(
      `[pw_screenshot] DENIED: sid=${sid.slice(0, 8)} sans propriétaire connu (user=${attendu})`,
    );
    throw new HttpError(403, "Access denied: unknown session");
  }
  if (proprietaire !== attendu) {
    ctx.journal.warn(
      `[pw_screenshot] DENIED: user=${attendu} tried to access session of user=${proprietaire}`,
    );
    throw new HttpError(403, "Access denied: not your session");
  }
  const attendre = ctx.attendre ?? ((ms: number) => new Promise<void>((fin) => setTimeout(fin, ms)));
  // La capture est lue au service du bac du compte, par son socket.
  const service = serviceLu(proprietaire);
  try {
    for (let essai = 0; essai < ESSAIS; essai++) {
      const r = await requeteService(service, `/screenshots/${filename}`, { delaiMs: 5000 });
      if (r.statut === 200) return rep.code(200).headers(SANS_CACHE).type("image/png").send(r.corps);
      if (r.statut !== 404) {
        ctx.journal.warn(`[pw_screenshot] PLAYWRIGHT_ERROR: ${filename} → ${r.statut}`);
        throw new HttpError(502, `Playwright returned ${r.statut}`);
      }
      await attendre(300 * (essai + 1));
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    ctx.journal.error(`[pw_screenshot] PLAYWRIGHT_DOWN: ${proprietaire} (${messageTransport(e)})`);
    throw new HttpError(503, `Playwright unreachable: ${messageTransport(e)}`);
  }
  ctx.journal.warn(
    `[pw_screenshot] NOT_READY: ${filename} 404 after ${ESSAIS} retries (file never appeared)`,
  );
  throw new HttpError(404, "Screenshot not ready");
}

export function creerFamilleCaptures(ctx: ContexteCaptures): Famille {
  return {
    nom: "captures",
    routes: [
      {
        methode: "GET",
        chemin: CHEMIN_CAPTURE,
        processus: ["toolhost"],
        acces: "enveloppe",
        traiter: (req, rep) => servirCapture(ctx, req, rep),
      },
    ],
  };
}
