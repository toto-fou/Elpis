// SPDX-License-Identifier: MIT
/** browser-service/src/routes/demarrage.ts — /start : session d'un propriétaire (réutilisation, état sauvegardé, options de contexte, quotas, éviction), première navigation. */
import fs from "fs";
import path from "path";
import { devices } from "playwright";
import type { BrowserContextOptions } from "playwright";
import { v4 as uuidv4 } from "uuid";
import type { Application, Request, Response } from "express";
import type { LigneConsole, JournalReseau, ServiceContext, Session } from "../contexte.ts";
import { USER_AGENT, installerGarde, refusUrl, repondreRefus } from "../destinations.ts";
import {
  attachDialogHandler,
  attachPageLoggers,
  detailsNavigation,
  makeDialogState,
  suivreOnglets,
} from "../evenements.ts";
import { safeRemoveOverlays } from "../interaction.ts";
import { authHint, cleanNavError } from "../nav_util.ts";
import {
  COOKIES_DIR,
  DOWNLOAD_DIR,
  HAR_DIR,
  LOCK_MAX_W,
  LOCK_WAIT_MS,
  PW_MUTEX,
  VIDEO_DIR,
} from "../reglages.ts";
import { sansAnsi } from "../result_util.ts";
import { origineDe } from "../secret_util.ts";
import { acquireLock, makeLock } from "../session_lock.ts";
import type { ErreurVerrou, Liberer } from "../session_lock.ts";
import { planSessionSlot, resolveStateFile, safeDownloadName, safeOwner } from "../session_util.ts";
import type { EtatIntrouvable, PlanPlace } from "../session_util.ts";
import {
  MAX_SESSIONS_PER_GROUP,
  MAX_SESSIONS_PER_OWNER,
  STATE_MAX_AGE_D,
  _ownerStartLock,
  closeSession,
  ensureBrowser,
  findLiveSessionByOwner,
} from "../sessions.ts";

/** Corps de /start. */
interface CorpsDemarrage {
  url: string;
  load_state_id?: string;
  record_har?: boolean;
  device?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  timezone?: string;
  color_scheme?: "light" | "dark" | "no-preference";
  touch?: boolean;
  isolated?: boolean;
  trace?: boolean;
  record_video?: boolean;
  owner?: string;
  group?: string;
  tls?: string | null;
  relay_binding?: { key: string; origins: string[] } | null;
}

/** Première navigation d'une session démarrée : détails de la réponse, ou avertissement de navigation. */
type NavDemarrage = Awaited<ReturnType<typeof detailsNavigation>> & { nav_warning?: string };

/** Liaison au relais d'une session : clé envoyée dans ENTETE_LIAISON, origines qui la reçoivent. */
interface LiaisonRelais {
  cle: string;
  origines: ReadonlySet<string | null>;
}

/** Limite qui a fait céder une session. */
type Limite = "owner" | "group";

/** Fenêtre de Chrome, dont le script d'initialisation masque `chrome.runtime`. */
type FenetreChrome = Window & { chrome?: { runtime?: unknown } };

// Indice joint à un démarrage arrivé sur un 401/407.
const indiceAuthDemarrage = (nav: { http_status?: number | null }) => {
  const h = authHint(nav.http_status ?? null);
  return h ? { auth_hint: h } : {};
};

// Liaison d'authentification HTTP du relais de l'hôte (clé et origines) ; la clé part dans l'en-tête ENTETE_LIAISON des seules requêtes de la session vers ces origines, le relais y ajoute Authorization.
const ENTETE_LIAISON = "x-elpis-binding";
function liaisonRelais(b: CorpsDemarrage): LiaisonRelais | null | undefined {
  const l = b.relay_binding;
  if (l === undefined || l === null) return null;
  if (
    typeof l !== "object" ||
    typeof l.key !== "string" ||
    !/^[0-9a-f]{32,128}$/.test(l.key) ||
    !Array.isArray(l.origins) ||
    !l.origins.length ||
    l.origins.some((o) => origineDe(o) !== o)
  )
    return undefined;
  return { cle: l.key, origines: new Set(l.origins) };
}

// Refus (400) d'un démarrage au `tls` inconnu ou à la liaison du relais invalide, ou qui enregistrerait cette liaison (HAR, trace) ; null sinon.
function refusDemarrage(b: CorpsDemarrage) {
  if (b.tls !== undefined && b.tls !== null && b.tls !== "strict" && b.tls !== "insecure")
    return { error: "tls must be 'strict' or 'insecure'.", code: "invalid_option" };
  const liaison = liaisonRelais(b);
  if (liaison === undefined)
    return { error: "relay_binding must be { key, origins }.", code: "invalid_option" };
  // La clé de la liaison part dans les requêtes : un HAR ou une trace la garderaient.
  if (liaison && (b.record_har || b.trace))
    return {
      error: "HAR and trace recordings would keep the relay binding of HTTP authentication.",
      code: "recording_with_credentials",
    };
  return null;
}

// Options fixées à la création d'un contexte : sans effet sur une session reprise.
const OPTIONS_DE_CREATION: (keyof CorpsDemarrage)[] = [
  "record_har",
  "trace",
  "record_video",
  "device",
  "viewport",
  "locale",
  "timezone",
  "color_scheme",
  "touch",
];
const optionsDeCreation = (b: CorpsDemarrage) =>
  OPTIONS_DE_CREATION.filter((k) => (k === "touch" ? typeof b[k] === "boolean" : Boolean(b[k])));

// Plafond qui a fait céder une session, en clair pour le modèle.
const LIMITES_SESSIONS: Record<Limite, () => string> = {
  owner: () => `at most ${MAX_SESSIONS_PER_OWNER} sessions per owner`,
  group: () => `at most ${MAX_SESSIONS_PER_GROUP} sessions for an account and its sub-agents`,
};

// Session qui va céder sa place : identifiant, adresse, inactivité et raison.
function descriptionEviction(ctx: ServiceContext, sid: string, limite: Limite, now: number) {
  const { sessions } = ctx;
  const s: Partial<Session> = sessions.get(sid) || {};
  let url = "";
  try {
    url = s.page?.url?.() || "";
  } catch {
    /* page fermée */
  }
  return {
    session_id: sid,
    url: url.substring(0, 120),
    idle_sec: Math.round((now - (s.lastActivity || now)) / 1000),
    isolated: Boolean(s.isolated),
    reason: `closed to stay within ${(LIMITES_SESSIONS[limite] || LIMITES_SESSIONS.owner)()}`,
  };
}

function avisEviction(evincees: ReturnType<typeof descriptionEviction>[]) {
  return (
    `To open this session, ${evincees.length} older idle session(s) of yours were closed (${evincees.map((e) => e.session_id).join(", ")}): ` +
    `${evincees[0]!.reason.replace(/^closed /, "")}. Their session_id no longer works; a session that is busy or opened for a secret is never closed.`
  );
}

// Refus quand toutes les sessions du demandeur sont protégées (occupées ou liées à un secret) : lesquelles, et quoi faire.
function refusSessionsProtegees(ctx: ServiceContext, slot: Extract<PlanPlace, { cause: "protegees" }>) {
  const { sessions } = ctx;
  const protegees = (slot.protected || []).map((sid) => {
    const s: Partial<Session> = sessions.get(sid) || {};
    return { session_id: sid, why: s.tls ? "opened for a secret" : "busy" };
  });
  return {
    error: `Browser session limit reached (${(LIMITES_SESSIONS[slot.limit] || LIMITES_SESSIONS.owner)()}) and none of your sessions can be closed for this one: each is busy or opened for a secret.`,
    code: "browser_quota",
    protected_sessions: protegees,
    fix: "Stop a session you no longer need with pw_session(action='stop', session_id=…), or reuse one: start without isolated=true reuses your main session (a new tab), and starting again for the same secret reuses its session.",
  };
}

export function registerStartRoutes(app: Application, ctx: ServiceContext) {
  const { sessions } = ctx;
  app.post("/start", async (req: Request<CorpsDemarrage>, res: Response): Promise<Response | void> => {
    let _startRelease: Liberer | null = null;
    try {
      const {
        url,
        load_state_id,
        record_har = false,
        device,
        viewport,
        locale,
        timezone,
        color_scheme,
        touch,
        isolated = false,
        trace = false,
        record_video = false,
      } = req.body;
      // Propriétaire obligatoire (2026-09-30) : c'est lui qui borne l'accès
      // à la session, à ses états sauvegardés et à ses téléchargements.
      const owner = safeOwner(req.body.owner);
      if (!owner) return res.status(400).json({ error: "owner requis." });
      // Groupe du quota : le compte d'un sous-agent à session isolée (absent : le propriétaire seul).
      const group = safeOwner(req.body.group) || owner;
      // Session ouverte pour un secret du coffre : politique TLS du secret (`tls`), contexte neuf, jamais reprise ensuite.
      const refus = refusDemarrage(req.body);
      if (refus) return res.status(400).json(refus);
      const tls = req.body.tls || null;
      if (url) {
        const motif = await refusUrl(url);
        if (motif) return repondreRefus(res, url, motif);
      }

      // État sauvegardé : seulement ceux du même propriétaire (cf.
      // resolveStateFile). Résolu avant la réutilisation d'une session : un
      // état absent ou sans compte répond 404 même si le compte en a une.
      let storageState: string | undefined = undefined;
      if (load_state_id) {
        const etat: { file?: string } & Partial<EtatIntrouvable> = resolveStateFile(
          owner,
          load_state_id,
          (nom) => fs.existsSync(path.join(COOKIES_DIR, nom)),
          { maxAgeDays: STATE_MAX_AGE_D },
        );
        if (!etat.file) {
          return res.status(404).json({ error: etat.error, code: etat.code, fix: etat.fix });
        }
        storageState = path.join(COOKIES_DIR, etat.file);
      }

      if (PW_MUTEX && owner && !isolated && !tls) {
        try {
          _startRelease = await acquireLock(_ownerStartLock(ctx, owner), { waitMs: LOCK_WAIT_MS });
        } catch (e) {
          return res.status((e as ErreurVerrou).code === 429 ? 429 : 423).json({
            error: "Un démarrage de session est déjà en cours pour cet utilisateur — réessaie.",
            retryable: true,
          });
        }
      }

      // ── Une instance par utilisateur ────────────────────────────
      // Si cet `owner` a déjà une session vivante, on la réutilise au
      // lieu d'ouvrir un second contexte. L'URL demandée (le cas
      // échéant) s'ouvre dans un NOUVEL ONGLET de l'instance existante :
      // rien en cours n'est perdu, et l'utilisateur accumule des
      // onglets entre lesquels il peut basculer (switch_tab).
      if (owner && !isolated && !tls) {
        // isolated=true ou politique TLS → contexte neuf, pas de réutilisation
        const existing = await findLiveSessionByOwner(ctx, owner);
        if (existing) {
          const [existingSid, s] = existing;
          const sansEffet = optionsDeCreation(req.body);
          if (sansEffet.length) {
            return res.status(409).json({
              error: `A session is already open for this account (one per account): ${sansEffet.join(", ")} can only be set when a session is created, so they were NOT applied and nothing was opened.`,
              code: "session_options_need_new_session",
              ignored_options: sansEffet,
              session_id: existingSid,
              fix: `Start again with isolated=true to get a new separate session with these options, or close this one first (pw_session action='stop'), or drop ${sansEffet.join(", ")} to open the url in a new tab of the existing session.`,
            });
          }
          // AUDIT 2026-06 — la mutation tabs/page se fait SOUS le mutex
          // de la session réutilisée (une op en vol sur cette page ne
          // doit pas voir s.page changer sous ses pieds).
          let _reuseRelease: Liberer | null = null;
          if (PW_MUTEX && s._lock) {
            try {
              _reuseRelease = await acquireLock(s._lock, { waitMs: LOCK_WAIT_MS, maxWaiters: LOCK_MAX_W });
            } catch {
              return res.status(423).json({ error: "Session occupée — réessaie.", retryable: true });
            }
          }
          try {
            s.lastActivity = Date.now();
            let tabIndex = s.tabs.indexOf(s.page);
            let nav: NavDemarrage = {};
            if (url) {
              const reusePage = await s.context.newPage();
              attachDialogHandler(reusePage, s.dialogState || (s.dialogState = makeDialogState()));
              attachPageLoggers(reusePage, s.consoleLogs, s.networkLog);
              suivreOnglets(s, reusePage);
              try {
                const resp = await reusePage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
                await Promise.race([
                  reusePage.waitForLoadState("networkidle").catch(() => {}),
                  reusePage.waitForTimeout(3000),
                ]);
                nav = await detailsNavigation(resp, url, reusePage.url());
              } catch (e) {
                nav = { nav_warning: cleanNavError((e as Error).message) };
                console.log("Nav warning (reuse):", nav.nav_warning);
              }
              s.tabs.push(reusePage);
              s.page = reusePage;
              tabIndex = s.tabs.length - 1;
              await reusePage.bringToFront().catch(() => {});
            }
            console.log(
              `[START] Réutilisation session ${existingSid.substring(0, 8)}… (owner=${owner}, tabs=${s.tabs.length})`,
            );
            return res.json({
              status: "reused",
              reused: true,
              session_id: existingSid,
              tab_index: tabIndex,
              total_tabs: s.tabs.length,
              url: s.page.url(),
              title: await s.page.title().catch(() => ""),
              ...nav,
              ...indiceAuthDemarrage(nav),
              note:
                "Instance unique par utilisateur : session existante réutilisée" +
                (url ? ", URL ouverte dans un nouvel onglet (utilisez switch_tab pour basculer)." : "."),
              // Un état ne se pose qu'à la création du contexte : le
              // dire plutôt que laisser croire la session chargée.
              ...(storageState
                ? {
                    state_loaded: false,
                    warning:
                      "load_state_id non appliqué : la session déjà ouverte de ce compte " +
                      "est réutilisée. Pour charger l'état : start avec isolated=true, " +
                      "ou fermez d'abord cette session (action='stop').",
                  }
                : {}),
            });
          } finally {
            if (_reuseRelease) _reuseRelease();
          }
        }
      }

      const browser = await ensureBrowser(ctx);
      const sessionId = uuidv4();

      // ── Émulation device/viewport (V13) ─────────────────────────────
      // device = preset Playwright ("iPhone 13", "Pixel 7", "iPad Mini"…) qui
      // fixe viewport + UA + deviceScaleFactor + touch + isMobile. Les options
      // explicites (viewport/locale/timezone/color_scheme/touch) surchargent.
      const preset: Partial<(typeof devices)[string]> = device && devices[device] ? devices[device] : {};
      const contextOpts: BrowserContextOptions & { defaultBrowserType?: string } = {
        ...preset,
        userAgent: preset.userAgent || USER_AGENT,
        viewport: viewport || preset.viewport || { width: 1920, height: 1080 },
        locale: locale || "fr-FR",
        timezoneId: timezone || "Europe/Paris",
        colorScheme: color_scheme || undefined, // 'light' | 'dark' | 'no-preference'
        ignoreHTTPSErrors: tls !== "strict",
        acceptDownloads: true,
        storageState,
        permissions: ["geolocation"],
        bypassCSP: true,
      };
      if (typeof touch === "boolean") contextOpts.hasTouch = touch;
      delete contextOpts.defaultBrowserType; // clé du preset non valide pour newContext

      if (record_har)
        contextOpts.recordHar = { path: path.join(HAR_DIR, `har_${sessionId}.har`), mode: "minimal" };

      if (record_video) contextOpts.recordVideo = { dir: VIDEO_DIR }; // vidéo finalisée à la fermeture du contexte (Phase 5)

      const context = await browser.newContext(contextOpts);
      await installerGarde(context);
      const liaison = liaisonRelais(req.body);
      if (liaison) {
        await context.route(
          (u) => liaison.origines.has(origineDe(u.href)),
          (route) =>
            route
              .fallback({ headers: { ...route.request().headers(), [ENTETE_LIAISON]: liaison.cle } })
              .catch(() => {}),
        );
      }

      // Trace Playwright (Phase 5) : screenshots + snapshots DOM + sources,
      // exportable en .zip ouvrable avec `npx playwright show-trace`.
      let _traceActive = false;
      if (trace) {
        try {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
          _traceActive = true;
        } catch (e) {
          console.warn("[trace] start KO:", (e as Error).message);
        }
      }

      await context.addInitScript(() => {
        Object.defineProperty(Object.getPrototypeOf(navigator), "webdriver", { get: () => undefined });
        if ((window as FenetreChrome).chrome) (window as FenetreChrome).chrome!.runtime = undefined;
        // Expose clipboard API si manquant
        if (!navigator.clipboard) {
          (navigator as { clipboard: unknown }).clipboard = {
            readText: () => Promise.resolve(""),
            writeText: () => Promise.resolve(),
          };
        }
      });

      // Téléchargements rangés par propriétaire, pour TOUS les onglets.
      // Chaque téléchargement est noté sur la session (début, fichier enregistré) : le geste qui l'a lancé le rapporte.
      const dossierTelechargements = path.join(DOWNLOAD_DIR, owner);
      context.on("page", (pg) =>
        pg.on("download", (download) => {
          const nom = safeDownloadName(download.suggestedFilename());
          const chemin = path.join(dossierTelechargements, nom);
          const fini = (async () => {
            fs.mkdirSync(dossierTelechargements, { recursive: true });
            await download.saveAs(chemin);
            return { file: nom, path: chemin, size: fs.statSync(chemin).size };
          })().catch((e: Error) => ({ file: nom, error: sansAnsi(e.message).split("\n")[0] }));
          const s = sessions.get(sessionId);
          if (s) {
            s.downloads.push({ debut: Date.now(), nom, fini });
            if (s.downloads.length > 20) s.downloads.shift();
          }
        }),
      );
      const page = await context.newPage();

      const dialogState = makeDialogState();
      const consoleLogs: LigneConsole[] = [];
      const networkLog: JournalReseau = [];
      attachDialogHandler(page, dialogState);
      attachPageLoggers(page, consoleLogs, networkLog);

      const now = Date.now();
      // Enforce max sessions — close oldest if at limit
      const slot = planSessionSlot(sessions, owner, {
        maxPerOwner: MAX_SESSIONS_PER_OWNER,
        group,
        maxPerGroup: MAX_SESSIONS_PER_GROUP,
        now,
      });
      if (slot.refuse) {
        await context.close().catch(() => {});
        if (slot.cause === "protegees") return res.status(503).json(refusSessionsProtegees(ctx, slot));
        return res.status(503).json({
          error: `Browser session quota reached for this account (${MAX_SESSIONS_PER_GROUP} sessions, sub-agents included).`,
          code: "browser_quota",
          fix:
            "Close a session you no longer need with pw_session(action='stop'), or wait for a running browser sub-agent to finish: " +
            "the account and its sub-agents share this quota. A sub-agent that hits it returns Status: blocked to its parent.",
        });
      }
      // Session cédée pour rester sous le plafond : dite dans la réponse, jamais en silence.
      const evincees = slot.evict ? [descriptionEviction(ctx, slot.evict, slot.limit, now)] : [];
      if (slot.evict) await closeSession(ctx, slot.evict, "max_sessions");

      sessions.set(sessionId, {
        context,
        page,
        owner,
        group,
        isolated: Boolean(isolated),
        consoleLogs,
        networkLog,
        downloads: [],
        tabs: [page],
        mousePos: { x: 960, y: 540 },
        createdAt: now,
        lastActivity: now,
        traceActive: _traceActive,
        _lock: makeLock(),
        dialogState,
        tls,
      });
      suivreOnglets(sessions.get(sessionId)!, page);

      let nav: NavDemarrage = {};
      try {
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await Promise.race([page.waitForLoadState("networkidle").catch(() => {}), page.waitForTimeout(3000)]);
        nav = await detailsNavigation(resp, url, page.url());
      } catch (e) {
        nav = { nav_warning: cleanNavError((e as Error).message) };
        console.log("Nav warning:", nav.nav_warning);
      }

      // Auto-dismiss popups after page load (cookies, newsletters, chat widgets)
      await page.waitForTimeout(800);
      await safeRemoveOverlays(page, false);

      res.json({
        status: "started",
        session_id: sessionId,
        url: page.url(),
        title: await page.title().catch(() => ""),
        ...nav,
        ...(evincees.length ? { evicted_sessions: evincees, warning: avisEviction(evincees) } : {}),
        ...indiceAuthDemarrage(nav),
        ...(tls ? { tls } : {}),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    } finally {
      if (_startRelease) _startRelease();
    }
  });
}
