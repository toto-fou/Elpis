// SPDX-License-Identifier: MIT
/** browser-service/src/requete.ts — intergiciels par appel (session de l'appel, compteur d'étapes et capture, téléchargements et navigation lancés par un geste) et erreurs codées. */
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { capturesDemandees, ecrireCapture } from "./captures.ts";
import type { ServiceContext } from "./contexte.ts";
import { annoncerOnglets } from "./evenements.ts";
import { GESTES_NAVIGANTS, champsNavigation, suivreNavigation } from "./geste_util.ts";
import { LOCK_MAX_W, LOCK_WAIT_MS, PW_MUTEX } from "./reglages.ts";
import { codeErreur } from "./result_util.ts";
import { acquireLock, makeLock } from "./session_lock.ts";
import type { ErreurVerrou, Liberer } from "./session_lock.ts";
import { ownerFromRequest, ownerMatches, pingPage } from "./session_util.ts";
import { closeSession, touchSession } from "./sessions.ts";

// ==========================================
// MIDDLEWARE
// ==========================================
/** Appel tel que les intergiciels le voient, quels que soient le corps et la requête de sa route. */
export type Appel = Request<unknown, object>;

async function getSession(
  ctx: ServiceContext,
  req: Appel,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  const { sessions } = ctx;
  const sid =
    (req.body as { session_id?: string } | undefined)?.session_id ||
    (req.query as { session_id?: string } | undefined)?.session_id;
  // Propriétaire obligatoire (2026-09-30) : une session d'un autre compte
  // répond exactement comme une session inconnue.
  if (!sid || !sessions.has(sid) || !ownerMatches(sessions.get(sid), ownerFromRequest(req))) {
    return res.status(404).json({ error: "Session introuvable." });
  }
  const session = sessions.get(sid)!;
  // Connexion en cours : refus avant le ping et le verrou, revu sous le verrou (un client parti le rend avant la fin de /login).
  if (session._connexionEnCours) return res.status(409).json(CONNEXION_EN_COURS);
  // AUDIT 2026-06 — ping borné (3 s) : une page gelée ne bloque plus la
  // requête entrante ('frozen' = fail-open, les handlers ont leurs propres
  // timeouts). Crash → closeSession (et plus un simple delete de la Map,
  // qui laissait le context Playwright ouvert → fuite RAM).
  const verdict = await pingPage(session.page, 3000);
  if (verdict === "crashed") {
    await closeSession(ctx, sid, "page_crash_on_request");
    return res.status(410).json({ error: "Session expirée (page crash)." });
  }
  touchSession(ctx, sid);
  // AUDIT 2026-06 — mutex par session : UN SEUL point d'intégration pour
  // les ~80 routes. Le verrou est relâché au finish/close de la réponse
  // (close couvre la déconnexion client). Voir session_lock.js.
  if (PW_MUTEX) {
    if (!session._lock) session._lock = makeLock();
    let release: Liberer;
    try {
      release = await acquireLock(session._lock, { waitMs: LOCK_WAIT_MS, maxWaiters: LOCK_MAX_W });
    } catch (e) {
      const code = (e as ErreurVerrou).code === 429 ? 429 : 423;
      return res.status(code).json({
        error:
          code === 429
            ? "File d'attente de la session pleine — réessaie dans un instant."
            : "Session occupée (opération longue en cours) — réessaie.",
        retryable: true,
      });
    }
    // Re-check post-attente : le reaper a pu fermer la session pendant
    // qu'on attendait notre tour.
    if (!sessions.has(sid)) {
      release();
      return res.status(410).json({ error: "Session expirée." });
    }
    res.once("finish", release);
    res.once("close", release);
  }
  if (session._connexionEnCours) return res.status(409).json(CONNEXION_EN_COURS);
  req.session = session;
  req.sessionId = sid;
  annoncerOnglets(req, res);
  next();
}

const CONNEXION_EN_COURS = Object.freeze({
  error: "A login is in progress on this session: retry once it has finished.",
  code: "secret_login_busy",
  retryable: true,
});

// Chaque réponse réussie compte un pas (repère de since_step) ; captures demandées : `screenshot_step` et step_<sid>_<n>.jpg écrit après la réponse, hors verrou.
function autoSnapshot(ctx: ServiceContext, req: Appel, res: Response, next: NextFunction): void {
  const { sessions } = ctx;
  const origJson = res.json.bind(res);
  res.json = function (this: Response, payload?: unknown): Response {
    try {
      const ok = this.statusCode >= 200 && this.statusCode < 300;
      const s = sessions.get(req.sessionId!);
      const page = req.session && req.session.page;
      if (ok && s && page && payload && typeof payload === "object" && !Array.isArray(payload)) {
        s.screenshotCounter = (s.screenshotCounter || 0) + 1;
        const n = s.screenshotCounter;
        if (capturesDemandees(req)) {
          (payload as { screenshot_step?: number }).screenshot_step = n;
          const nom = `step_${req.sessionId}_${n}.jpg`;
          setImmediate(() => {
            void ecrireCapture(ctx, page, req.sessionId, nom);
          });
        }
      }
    } catch (e) {
      console.error(`[autoSnapshot] EXCEPTION:`, (e as Error).message);
    }
    return origJson(payload);
  };
  next();
}

// Fenêtre où un geste peut lancer une navigation (soumission, lien) avant qu'on la tienne pour absente.
export const NAV_GRACE_MS = Math.max(0, parseInt(process.env.PW_NAV_GRACE_MS || "250", 10) || 0);
// Durée d'une requête /action ou /chain, depuis son arrivée, sous le délai du client (10 s, 60 s) : l'attente de la page d'arrivée prend ce qui reste.
const BUDGET_GESTE_MS = parseInt(process.env.PW_GESTURE_BUDGET_MS || "9000", 10);
export const BUDGET_CHAINE_MS = parseInt(process.env.PW_CHAIN_BUDGET_MS || "55000", 10);

// Geste de /action qui peut naviguer : la réponse attend la page d'arrivée et en donne l'URL (`navigated`, `url_before`).
// Téléchargements lancés pendant un geste (depuis l'arrivée de la requête) joints à sa réponse : fichier, chemin, taille (attente bornée de leur enregistrement).
export function suiviTelechargements(req: Appel, res: Response, next: NextFunction): void {
  const s = req.session;
  if (!s || !Array.isArray(s.downloads)) return next();
  const depuis = req.recuA || Date.now();
  const envoyer = res.json.bind(res);
  res.json = (corps?: unknown): Response => {
    const lances = s.downloads.filter((d) => d.debut >= depuis);
    if (
      !lances.length ||
      res.statusCode >= 400 ||
      !corps ||
      typeof corps !== "object" ||
      Array.isArray(corps)
    )
      return envoyer(corps);
    const delai = new Promise<null>((r) => setTimeout(r, TELECHARGEMENT_ATTENTE_MS, null));
    Promise.all(
      lances.map((d) =>
        Promise.race([d.fini, delai]).then((f) => f || { file: d.nom, status: "in_progress" }),
      ),
    )
      .then(
        (fichiers) => {
          (corps as { downloads?: unknown[] }).downloads = fichiers;
        },
        () => {},
      )
      .finally(() => {
        try {
          envoyer(corps);
        } catch (e) {
          console.error("[téléchargement] réponse non envoyée :", (e as Error).message);
        }
      });
    return res;
  };
  next();
}
const TELECHARGEMENT_ATTENTE_MS = parseInt(process.env.PW_DOWNLOAD_WAIT_MS || "5000", 10);

export function suiviNavigationGeste(req: Appel, res: Response, next: NextFunction): void {
  const page = req.session && req.session.page;
  if (!page || !GESTES_NAVIGANTS.has(req.body && (req.body as { type?: string }).type)) return next();
  const fin = suivreNavigation(page, { graceMs: NAV_GRACE_MS });
  res.once("close", fin.annuler);
  const envoyer = res.json.bind(res);
  res.json = (corps?: unknown): Response => {
    fin({ limite: (req.recuA || Date.now()) + BUDGET_GESTE_MS })
      .then(
        (nav) => {
          if (nav && res.statusCode < 400 && corps && typeof corps === "object" && !Array.isArray(corps))
            Object.assign(corps, champsNavigation(nav));
        },
        () => {},
      )
      .finally(() => {
        try {
          envoyer(corps);
        } catch (e) {
          console.error("[nav] réponse non envoyée :", (e as Error).message);
        }
      });
    return res;
  };
  next();
}

/** Erreur avec un code stable et un contexte pour la réponse. */
export interface ErreurCodee extends Error {
  code?: string;
  details?: Record<string, unknown>;
}

// Erreur levée avec un code stable et un contexte pour la réponse (`detailsErreur`).
export function erreurCodee(
  code: string,
  message: string,
  details: Record<string, unknown> | null = null,
): ErreurCodee {
  const e: ErreurCodee = new Error(message);
  e.code = code;
  if (details) e.details = details;
  return e;
}

// Réponse d'erreur d'une route : statut selon le code (introuvable 404, clic intercepté 409, sinon 500), code et contexte de l'erreur.
export function repondreErreur(res: Response, e: unknown, extra: Record<string, unknown> = {}): Response {
  const code = detailsErreur(e).code || codeErreur((e as Error).message);
  const statut = code === "element_not_found" ? 404 : code === "click_intercepted" ? 409 : 500;
  return res.status(statut).json({ error: (e as Error).message, ...detailsErreur(e), ...extra });
}

// Code propre et contexte d'une erreur levée par le service, pour le corps de la réponse.
export function detailsErreur(e: unknown): { code?: string; [champ: string]: unknown } {
  const out: { code?: string; [champ: string]: unknown } = {};
  const err = e as { code?: unknown; details?: unknown } | null | undefined;
  if (err && typeof err.code === "string" && /^[a-z][a-z0-9_]*$/.test(err.code)) out.code = err.code;
  if (err && err.details && typeof err.details === "object") Object.assign(out, err.details);
  return out;
}

/** Middlewares of a route family, bound to the service context: session of the call (getSession), step count and step screenshot (autoSnapshot). */
export function intercepteurs(ctx: ServiceContext): {
  getSession: RequestHandler<unknown, object>;
  autoSnapshot: RequestHandler<unknown, object>;
} {
  return {
    getSession: (req, res, next) => getSession(ctx, req, res, next),
    autoSnapshot: (req, res, next) => autoSnapshot(ctx, req, res, next),
  };
}
