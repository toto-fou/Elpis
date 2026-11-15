// SPDX-License-Identifier: MIT
/** browser-service/src/routes/divers.ts — /evaluate, /save_state, /stop, /trace_export, /health, /wait_for_dynamic, /dialog. */
import path from "path";
import type { Application, Request, Response } from "express";
import type { Frame, Page, Video } from "playwright";
import type { ServiceContext } from "../contexte.ts";
import { recordEvent } from "../enregistrement.ts";
import { DIALOG_DEFAULT_WHEN_UNARMED, makeDialogState } from "../evenements.ts";
import { INDICE_PLAFOND, PLAFOND_SORTIE, locatorFromParams, smartResolveLocator } from "../localisateur.ts";
import { COOKIES_DIR, TRACE_DIR } from "../reglages.ts";
import { detailsErreur, erreurCodee, intercepteurs } from "../requete.ts";
import type { ErreurCodee } from "../requete.ts";
import { bornerValeur, describeLocator } from "../result_util.ts";
import type { ParamsCible } from "../result_util.ts";
import { occupationGroupe, ownerFromRequest, placesEnfants, stateFileName } from "../session_util.ts";
import { MAX_SESSIONS_PER_GROUP, SESSION_TTL_MS, closeSession } from "../sessions.ts";

// ======================== EVALUATE JS ========================
// Résultat d'un script tenu sous `max` caractères : chaîne coupée, liste ou objet réduit à ses premiers éléments, avec ce qui manque et un conseil.
function resultatBorne(valeur: unknown, max: number) {
  const b = bornerValeur(valeur, max);
  return {
    result: b.value,
    ...(b.truncated
      ? {
          truncated: true,
          omitted: b.omitted,
          hint: `${INDICE_PLAFOND} Return only what you need: .slice(0, N), the fields you need, a count.`,
        }
      : {}),
  };
}

// Délai d'un script de pw_page eval, sous celui du client (10 s) : à l'échéance la réponse part et la session est rendue, la promesse abandonnée ne retient rien.
const EVAL_TIMEOUT_MS = parseInt(process.env.PW_EVAL_TIMEOUT_MS || "8000", 10);

// Script exécuté comme une expression s'il en est une (`document.title`), sinon comme le corps d'une fonction asynchrone (instructions, `return`, `throw`) : l'erreur rendue est la sienne.
async function evaluerAvecDelai(cadre: Page | Frame, script: string, delaiMs: number): Promise<unknown> {
  const enCours = cadre.evaluate(async (corps) => {
    let fn: () => Promise<unknown>;
    try {
      fn = new Function(`return (async () => { return (${corps}\n); })();`) as () => Promise<unknown>;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      fn = new Function(`return (async () => { ${corps}\n })();`) as () => Promise<unknown>;
    }
    return await fn();
  }, script);
  enCours.catch(() => {});
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise((_, rejeter) => {
    minuterie = setTimeout(
      () =>
        rejeter(
          erreurCodee(
            "eval_timeout",
            `The script did not finish within ${Math.round(Math.max(0, delaiMs) / 1000)} s (a promise that never settles?); it was abandoned and may still run in the page.`,
            {
              fix: "Make the script settle on its own (add a timeout to what it awaits, e.g. Promise.race with a timer), or wait in the page with pw_wait.",
            },
          ),
        ),
      Math.max(0, delaiMs),
    );
  });
  try {
    return await Promise.race([enCours, delai]);
  } finally {
    clearTimeout(minuterie);
  }
}

// ======================== HEALTH ========================
// Seul /health du service : état global (sans URL ni identifiant de
// session), plus la liste des sessions du propriétaire s'il est indiqué.
const _DEMARRAGE = Date.now();

/** Corps de /evaluate. */
interface CorpsEvaluation {
  script?: string;
  in_all_frames?: boolean;
}

/** Corps de /save_state et /trace_export. */
interface CorpsSession {
  session_id: string;
}

/** État de l'élément attendu tel que /wait_for_dynamic le sonde (aussi la `baseline` que le client renvoie). */
interface Sonde {
  count: number;
  text: string | null;
  attr: string | null;
  visible: boolean;
}

/** Corps de /wait_for_dynamic : la condition, et la cible (sélecteur, ref ou by_*). */
interface CorpsAttenteDynamique extends ParamsCible {
  condition?: string;
  expected_text?: string;
  attribute?: string;
  expected_value?: string;
  timeout?: number;
  poll_interval?: number;
  baseline?: Sonde | null;
}

/** Corps de /dialog. */
interface CorpsDialogue {
  action?: string;
  input_text?: string;
  times?: number | string;
  sticky?: boolean | string;
}

export function registerMiscRoutes(app: Application, ctx: ServiceContext) {
  const { getSession, autoSnapshot } = intercepteurs(ctx);
  const { sessions } = ctx;
  app.post(
    "/evaluate",
    getSession,
    autoSnapshot,
    async (req: Request<CorpsEvaluation>, res: Response): Promise<Response | void> => {
      try {
        const { script, in_all_frames = false } = req.body;
        const { page } = req.session!;
        if (!script || typeof script !== "string") {
          return res.status(400).json({ error: "script (string) required" });
        }
        const echeance = Date.now() + EVAL_TIMEOUT_MS;
        if (in_all_frames) {
          const results = [];
          for (const frame of page.frames()) {
            if (frame.isDetached()) continue;
            try {
              const r = await evaluerAvecDelai(frame, script, echeance - Date.now());
              results.push({ frame: frame.url(), result: r });
            } catch (e) {
              results.push({ frame: frame.url(), error: (e as Error).message, ...detailsErreur(e) });
            }
          }
          void recordEvent(req.session, { action: "eval", script, url: page.url(), in_all_frames: true });
          const part = Math.floor(PLAFOND_SORTIE / Math.max(1, results.length));
          return res.json({
            results: results.map((x) => ("result" in x ? { ...x, ...resultatBorne(x.result, part) } : x)),
          });
        }
        const result = await evaluerAvecDelai(page, script, EVAL_TIMEOUT_MS);
        void recordEvent(req.session, { action: "eval", script, url: page.url() });
        res.json(resultatBorne(result, PLAFOND_SORTIE));
      } catch (e) {
        res
          .status((e as ErreurCodee).code === "eval_timeout" ? 408 : 500)
          .json({ error: (e as Error).message, ...detailsErreur(e) });
      }
    },
  );

  // ======================== SAVE STATE ========================
  app.post(
    "/save_state",
    getSession,
    autoSnapshot,
    async (req: Request<CorpsSession>, res: Response): Promise<Response | void> => {
      try {
        const nom = stateFileName(req.session!.owner, req.body.session_id);
        if (!nom) return res.status(400).json({ error: "Identifiant de session invalide." });
        await req.session!.context.storageState({ path: path.join(COOKIES_DIR, nom) });
        res.json({ status: "saved", state_id: req.body.session_id });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );

  // ======================== STOP ========================
  app.post("/stop", getSession, async (req: Request, res: Response) => {
    // Capture les objets vidéo AVANT close (le chemin n'est résolu qu'après).
    const vids: Video[] = [];
    try {
      for (const pg of req.session!.tabs || [req.session!.page]) {
        const v = pg.video && pg.video();
        if (v) vids.push(v);
      }
    } catch {
      /* tab already closed: no video */
    }
    try {
      if (req.session!.traceActive) await req.session!.context.tracing.stop().catch(() => {});
    } catch {
      /* context already closed */
    }
    // Même fermeture que le reaper (captures nettoyées, session retirée) ; le
    // verrou de la session est déjà tenu par cette requête.
    await closeSession(ctx, req.sessionId!, "stop", { lockHeld: true });
    const video_urls: string[] = [];
    for (const v of vids) {
      try {
        const p = await v.path();
        if (p) video_urls.push(`/videos/${path.basename(p)}`);
      } catch {
        /* video not saved */
      }
    }
    res.json({ status: "closed", ...(video_urls.length ? { video_urls } : {}) });
  });

  // ======================== TRACE EXPORT (Phase 5) ========================
  // Arrête le tracing et écrit un .zip ouvrable avec `npx playwright show-trace`.
  app.post(
    "/trace_export",
    getSession,
    async (req: Request<CorpsSession>, res: Response): Promise<Response | void> => {
      try {
        if (!req.session!.traceActive)
          return res.json({ ok: false, error: "tracing non actif (démarre la session avec trace=true)" });
        const file = `trace_${req.body.session_id}_${Date.now()}.zip`;
        await req.session!.context.tracing.stop({ path: path.join(TRACE_DIR, file) });
        req.session!.traceActive = false;
        res.json({
          ok: true,
          trace_url: `/traces/${file}`,
          file: path.join(TRACE_DIR, file),
          hint: "Ouvre avec: npx playwright show-trace <fichier>",
        });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );
  app.get("/health", (req: Request, res: Response) => {
    const now = Date.now();
    const owner = ownerFromRequest(req);
    const sessionList = [];
    for (const [sid, s] of sessions) {
      if (!owner || s.owner !== owner) continue;
      sessionList.push({
        id: sid.substring(0, 8) + "…",
        idle_sec: Math.round((now - (s.lastActivity || now)) / 1000),
        age_sec: Math.round((now - (s.createdAt || now)) / 1000),
        url: s.page?.url?.()?.substring(0, 80) || "?",
        tabs: s.tabs?.length || 1,
        active_tab: s.tabs ? s.tabs.indexOf(s.page) : 0,
      });
    }
    // Propriétaire indiqué : places des sous-agents dans son groupe (le compte et ses enfants à session isolée).
    const groupe = owner ? occupationGroupe(sessions, owner) : null;
    res.json({
      ok: true,
      service: "browser",
      status: "running",
      engine: "chromium",
      uptime_sec: Math.round((now - _DEMARRAGE) / 1000),
      // ``sessions`` : celles du propriétaire (liste d'objets, comme /sessions) ; ``session_count`` : toutes celles du compte.
      sessions: sessionList,
      session_count: sessions.size,
      ...(groupe
        ? {
            group_sessions: groupe.compte + groupe.enfants,
            max_sessions_per_group: MAX_SESSIONS_PER_GROUP,
            child_slots_left: Math.max(0, placesEnfants(groupe, MAX_SESSIONS_PER_GROUP) - groupe.enfants),
          }
        : {}),
      session_ttl_min: SESSION_TTL_MS / 60000,
      browser_connected: ctx.navigateur?.isConnected() || false,
    });
  });

  // ======================== WAIT FOR DYNAMIC ELEMENT ========================
  // Attend qu'un élément apparaisse / disparaisse / change, par polling.
  //
  // Audit tools web 2026-09-05 (P0) — les conditions texte/compte/attribut
  // passaient par `document.querySelector(sel)` : toute syntaxe Playwright
  // (`text=`, `label=`, `xpath=`, `css=#x`, ref) LEVAIT dans le evaluate, et
  // l'exception était avalée par la boucle → attente expirée alors que
  // `pw_expect text-contains` sur la MÊME cible passait en 8 ms. On résout
  // maintenant EXACTEMENT comme /expect : locatorFromParams (by_*/ref) puis
  // smartResolveLocator sur la chaîne. Chaque réponse — 200 comme 408 — porte
  // `polled_value` (ce que l'élément montrait en dernier) et `via`.
  // `baseline` : état initial repassé par le client entre deux tranches de
  // polling, pour que text_changes/count_* ne repartent pas de zéro.
  app.post(
    "/wait_for_dynamic",
    getSession,
    autoSnapshot,
    async (req: Request<CorpsAttenteDynamique>, res: Response): Promise<Response | void> => {
      try {
        const { page } = req.session!;
        const {
          selector,
          condition = "visible", // visible | hidden | attached | detached | text_contains | text_changes | attribute_changes | count_increases | count_decreases
          expected_text = "",
          attribute = "",
          expected_value = "",
          timeout = 15000,
          poll_interval = 200,
          baseline = null,
          ref,
          by_role,
          by_name,
          by_text,
          by_label,
          by_placeholder,
          by_test_id,
          by_alt,
          by_title,
          by_css,
          by_xpath,
          nth,
        } = req.body;

        const start = Date.now();
        const params = {
          ref,
          by_role,
          by_name,
          by_text,
          by_label,
          by_placeholder,
          by_test_id,
          by_alt,
          by_title,
          by_css,
          by_xpath,
          nth,
        };
        let loc = await locatorFromParams(ctx, page, params, req.sessionId, { first: false });
        let via = loc ? "official" : null;
        if (!loc && selector) {
          const r = await smartResolveLocator(page, selector).catch(() => null);
          if (r && r.locator) {
            loc = r.locator;
            via = `smart:${r.strategy || "selector"}`;
          }
        }
        if (!loc && selector) {
          loc = page.locator(selector);
          via = "raw";
        }
        if (!loc) return res.status(400).json({ error: "selector or by_* params required", condition });
        const first = loc.first();
        const label = selector || describeLocator(params, { first: false }) || "?";

        let polled: Sonde | null = null;
        let attrReel: string | null = null;
        const probe = async (): Promise<Sonde> => {
          const count = await loc.count().catch(() => 0);
          if (!count) {
            attrReel = null;
            return { count: 0, text: null, attr: null, visible: false };
          }
          const text = ((await first.textContent({ timeout: 800 }).catch(() => null)) || "")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 500);
          let attr = attribute
            ? await first.getAttribute(attribute, { timeout: 800 }).catch(() => null)
            : null;
          attrReel = attr;
          // Attribut value d'un champ mot de passe : jamais rendu (masqué aussi si le contrôle échoue).
          if (
            attr !== null &&
            String(attribute).toLowerCase() === "value" &&
            (await first
              .evaluate((el: HTMLInputElement) => el.type === "password", undefined, { timeout: 800 })
              .catch(() => true))
          )
            attr = "[password value hidden]";
          const visible = await first.isVisible().catch(() => false);
          return { count, text, attr, visible };
        };
        const done = (status: string, extra: object = {}) =>
          res.json({
            status,
            condition,
            selector: label,
            via,
            elapsed_ms: Date.now() - start,
            polled_value: polled,
            ...extra,
          });
        const notYet = (msg: string, extra: object = {}) =>
          res.status(408).json({
            error: msg,
            condition,
            selector: label,
            via,
            elapsed_ms: Date.now() - start,
            polled_value: polled,
            ...extra,
          });

        // Cas Playwright natif : états du locator
        if (["visible", "hidden", "attached", "detached"].includes(condition)) {
          try {
            await first.waitFor({
              state: condition as "visible" | "hidden" | "attached" | "detached",
              timeout,
            });
            polled = await probe();
            const box = condition === "visible" ? await first.boundingBox().catch(() => null) : null;
            return done(condition === "visible" ? "found" : condition, box ? { box } : {});
          } catch {
            polled = await probe();
            return notYet(`Timeout: '${label}' not ${condition} within ${timeout}ms`);
          }
        }
        const KNOWN = [
          "text_contains",
          "text_changes",
          "count_increases",
          "count_decreases",
          "attribute_changes",
        ];
        if (!KNOWN.includes(condition))
          return res.status(400).json({
            error: `unknown condition '${condition}'`,
            hint: "visible|hidden|attached|detached|" + KNOWN.join("|"),
          });

        // Ligne de base : celle du client (tranche précédente) sinon l'état courant
        const initial = baseline && typeof baseline === "object" ? baseline : await probe();
        polled = initial;
        while (Date.now() - start < timeout) {
          const cur = await probe();
          polled = cur;
          // Un texte présent dans un élément caché n'est pas affiché : la condition attend qu'il se voie.
          if (condition === "text_contains" && cur.count && cur.text!.includes(expected_text)) {
            // Conteneur sans hauteur (enfants flottants) : le texte peut se voir alors que le conteneur passe pour caché.
            if (!cur.visible && expected_text)
              cur.visible = await first
                .getByText(expected_text)
                .first()
                .isVisible()
                .catch(() => false);
            if (cur.visible) return done("matched", { text: cur.text });
          }
          if (condition === "text_changes" && cur.count && initial.text !== null && cur.text !== initial.text)
            return done("changed", { from: initial.text, to: cur.text });
          if (condition === "count_increases" && cur.count > (initial.count || 0))
            return done("changed", { from: initial.count || 0, to: cur.count });
          if (condition === "count_decreases" && cur.count < (initial.count || 0))
            return done("changed", { from: initial.count || 0, to: cur.count });
          if (condition === "attribute_changes" && attribute && cur.count) {
            if (expected_value && attrReel === expected_value)
              return done("matched", { attribute, value: cur.attr });
            if (!expected_value && initial.attr !== null && cur.attr !== initial.attr)
              return done("changed", { attribute, from: initial.attr, to: cur.attr });
          }
          await page.waitForTimeout(poll_interval);
        }
        const cache =
          condition === "text_contains" &&
          polled.count &&
          !polled.visible &&
          polled.text!.includes(expected_text);
        return notYet(
          `Timeout after ${timeout}ms — condition '${condition}' on '${label}' not met${cache ? " (the text is there, but the element is hidden)" : ""}`,
          { baseline: initial },
        );
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );

  // ======================== DIALOGUE : POLITIQUE ARMABLE ====================
  // Contrairement à une attente bloquante (qui retiendrait la réponse HTTP jusqu'à ce
  // qu'un dialogue apparaisse — inutilisable pour un agent, qui doit rendre la
  // main pour déclencher l'action qui l'ouvre), on arme et on rend la main tout
  // de suite. Le handler global consulte la politique au moment voulu.
  app.post(
    "/dialog",
    getSession,
    async (req: Request<CorpsDialogue>, res: Response): Promise<Response | void> => {
      try {
        const s = req.session!;
        s.dialogState = s.dialogState || makeDialogState();
        const st = s.dialogState;
        st.history = st.history || [];
        const { action = "status", input_text = "", times = 1, sticky = false } = req.body;
        // Audit tools web 2026-09-05 — status disait {armed, last, seen} : ni ce
        // qui s'applique quand rien n'est armé, ni l'historique, ni si le
        // dernier dialogue a suivi la politique armée ou le défaut.
        const view = () => ({
          armed: st.pending,
          last: st.last,
          seen: st.count,
          history: st.history.slice(-10),
          last_policy: st.last ? st.last.policy : null,
          default_when_unarmed: DIALOG_DEFAULT_WHEN_UNARMED,
          sticky: !!(st.pending && st.pending.sticky),
        });

        if (action === "status") return res.json({ status: "success", ...view() });
        if (action === "reset") {
          st.pending = null;
          return res.json({ status: "success", ...view() });
        }
        if (action !== "accept" && action !== "dismiss") {
          return res
            .status(400)
            .json({ error: `unknown dialog action "${action}"`, hint: "accept|dismiss|status|reset" });
        }
        st.pending = {
          action,
          input_text: String(input_text || ""),
          remaining: Math.max(1, Math.min(parseInt(String(times), 10) || 1, 20)),
          sticky: sticky === true || sticky === "true",
        };
        res.json({ status: "armed", ...view() });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );
}
