// SPDX-License-Identifier: MIT
/** browser-service/src/routes/chaine.ts — /chain : plusieurs gestes en un appel, arrêtés au premier échec (capture et alternatives). */
import type { Application, Request, Response } from "express";
import type { Locator } from "playwright";

import { screenshotOnFailure } from "../captures.ts";
import type { ServiceContext } from "../contexte.ts";
import { refusUrl } from "../destinations.ts";
import { recordEvent } from "../enregistrement.ts";
import { GESTES_NAVIGANTS, champsNavigation, suivreNavigation } from "../geste_util.ts";
import { postActionWait, selectOptionSmart } from "../gestes.ts";
import type { AttenteApresAction, OptionChoisie } from "../gestes.ts";
import { smartClick } from "../interaction.ts";
import {
  ACTION_TIMEOUT_MS,
  NOT_FOUND_GRACE_MS,
  cibleDepuisParams,
  erreurInterception,
  erreurIntrouvable,
  etatClic,
  findAlternatives,
  resoudreRepli,
  suggestionsCible,
  trouveParRepli,
} from "../localisateur.ts";
import {
  BUDGET_CHAINE_MS,
  detailsErreur,
  erreurCodee,
  intercepteurs,
  NAV_GRACE_MS,
  suiviTelechargements,
} from "../requete.ts";
import type { ErreurCodee } from "../requete.ts";
import { codeErreur, describeLocator, sansAnsi } from "../result_util.ts";
import type { ParamsCible } from "../result_util.ts";
import { messageRefus } from "../url_guard.ts";

/** Étape de /chain : geste (`type`, ou `action`), cible (`ref`, `by_*`, `selector` de repli) et options du geste. */
interface EtapeChaine {
  type?: string;
  action?: string;
  ref?: string;
  by_role?: string;
  by_name?: string;
  by_text?: string;
  by_label?: string;
  by_placeholder?: string;
  by_test_id?: string;
  by_alt?: string;
  by_title?: string;
  by_css?: string;
  by_xpath?: string;
  nth?: number;
  selector?: string;
  timeout?: number;
  button?: "left" | "right" | "middle";
  human?: boolean;
  text?: string;
  value?: string;
  delay?: number;
  key?: string;
  option_value?: string;
  option_label?: string;
  label?: string;
  checked?: boolean;
  wait_for?: string;
  ms?: number;
  amount?: number;
  url?: string;
  wait_after?: AttenteApresAction;
}

/** Corps de /chain. */
interface CorpsChaine {
  actions?: EtapeChaine[];
  stop_on_error?: boolean;
  screenshot_on_fail?: boolean;
}

/** Issue d'une étape : les champs du geste (stratégie, touche, option choisie…), la navigation, ou l'échec et ses alternatives. */
interface ResultatEtape {
  success: boolean;
  code?: string;
  selected?: OptionChoisie;
  alternatives?: unknown[];
  [champ: string]: unknown;
}

/** Gestes d'une étape, nommés dans le refus d'un geste inconnu. */
const GESTES_CHAINE = [
  "click",
  "rclick",
  "dblclick",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "focus",
  "scroll",
  "wait",
  "goto",
];

/** L'étape désigne-t-elle un élément par `ref` ou `by_*` (la cible officielle, celle que l'hôte d'outils envoie) ? */
const aUneCible = (act: EtapeChaine): boolean =>
  [
    act.ref,
    act.by_role,
    act.by_text,
    act.by_label,
    act.by_placeholder,
    act.by_test_id,
    act.by_alt,
    act.by_title,
    act.by_css,
    act.by_xpath,
  ].some((v) => v !== undefined && v !== null && v !== "");

/** Critères de cible d'une étape (`ref`, `by_*`, `nth`). */
const paramsDe = (act: EtapeChaine): ParamsCible => ({
  ref: act.ref,
  by_role: act.by_role,
  by_name: act.by_name,
  by_text: act.by_text,
  by_label: act.by_label,
  by_placeholder: act.by_placeholder,
  by_test_id: act.by_test_id,
  by_alt: act.by_alt,
  by_title: act.by_title,
  by_css: act.by_css,
  by_xpath: act.by_xpath,
  nth: act.nth,
});

/** Geste de clic sur la cible résolue, dans le délai de l'étape (une couverture passagère a le temps de partir) ; encore couverte à l'échéance : click_intercepted (rien n'a été cliqué) au lieu d'un délai dépassé. */
async function cliquerSurCible(
  locator: Locator,
  clic: (timeout: number) => Promise<void>,
  delai: number,
): Promise<void> {
  try {
    await clic(delai);
  } catch (e) {
    const etat = await etatClic(locator);
    if (etat && etat.visible && !etat.hit) throw erreurInterception(etat.element, etat.cover);
    throw e;
  }
}

export function registerChainRoutes(app: Application, ctx: ServiceContext) {
  const { getSession, autoSnapshot } = intercepteurs(ctx);
  // ==========================================
  // ACTION CHAINING (Feature 2) — v2: prefers by_* params over selector strings
  // ==========================================
  app.post(
    "/chain",
    getSession,
    autoSnapshot,
    suiviTelechargements,
    async (req: Request<CorpsChaine>, res: Response): Promise<Response | void> => {
      try {
        const { page } = req.session!;
        const { actions = [], stop_on_error = true, screenshot_on_fail = true } = req.body;

        if (!Array.isArray(actions) || actions.length === 0)
          return res.status(400).json({ error: "actions[] required (array of action objects)" });
        if (actions.length > 30) return res.status(400).json({ error: "Max 30 actions per chain" });

        // Resolve a chain step's target. Prefers `ref` and explicit `by_*`
        // params (Playwright official API — robust). Falls back to a
        // `selector` string parsed by smartResolveLocator (text/CSS/XPath).
        async function resolveChainTarget(act: EtapeChaine) {
          const params = paramsDe(act);
          const hasOfficial = Object.values(params).some((v) => v !== undefined && v !== null && v !== "");
          if (hasOfficial) {
            // Comptée d'abord, comme /action : une cible absente échoue vite (element_not_found).
            const c = await cibleDepuisParams(
              ctx,
              page,
              params,
              req.sessionId,
              Number(act.timeout) > 0 ? Number(act.timeout) : NOT_FOUND_GRACE_MS,
            );
            if (c) {
              if (c.n > 0 && !(c.nth !== null && c.nth >= c.n))
                return { locator: c.loc.first(), source: "official", matched: c.n };
              if (!act.selector || !(await trouveParRepli(page, act.selector)))
                throw erreurCodee(
                  "element_not_found",
                  `No element matches ${act.ref ? `ref ${act.ref}` : describeLocator(params, { first: false })} on this page.`,
                );
            }
          }
          if (act.selector) {
            const r = await resoudreRepli(page, act.selector, { params });
            return { locator: r.locator, source: r.strategy || "selector" };
          }
          throw new Error("No target: provide by_*/ref or selector");
        }

        // Cible d'une étape wait : attendue jusqu'à l'échéance (pour `nth`, jusqu'à ce que cet élément existe), puis visible ; le sélecteur de repli ne sert qu'à une cible sans `nth` ni `ref`.
        async function attendreCible(act: EtapeChaine, delai: number): Promise<void> {
          const params = paramsDe(act);
          const fin = Date.now() + delai;
          const sansRang = act.nth === undefined || act.nth === null;
          const repli = act.selector && !act.ref && sansRang ? act.selector : null;
          let locator: Locator;
          for (let tour = 0; ; tour++) {
            const c = await cibleDepuisParams(ctx, page, params, req.sessionId, 0);
            if (c && c.n > 0 && !(c.nth !== null && c.nth >= c.n)) {
              locator = c.loc.first();
              break;
            }
            // Le repli parcourt la page entière (cadres, shadow DOM, attributs) : un tour sur trois.
            if (repli && tour % 3 === 0 && (await trouveParRepli(page, repli))) {
              locator = (await resoudreRepli(page, repli, { params, graceMs: 0 })).locator;
              break;
            }
            if ((c === null && !repli) || Date.now() >= fin)
              throw await erreurIntrouvable(page, params, act.selector, ` after ${delai} ms`);
            await new Promise((r) => setTimeout(r, 200));
          }
          await locator.waitFor({ state: "visible", timeout: Math.max(500, fin - Date.now()) });
        }

        const results: ResultatEtape[] = [];
        let failed = false;

        for (let i = 0; i < actions.length; i++) {
          const act = actions[i]!;
          const actType = act.type || act.action || "";
          const startMs = Date.now();
          let locEtape: Locator | null | undefined = null;
          const suivi = GESTES_NAVIGANTS.has(actType)
            ? suivreNavigation(page, { graceMs: NAV_GRACE_MS })
            : null;

          try {
            let result: ResultatEtape;

            switch (actType) {
              case "click":
              case "smart_click":
              case "rclick":
              case "right_click": {
                // Cible officielle (by_*, ref) : le locator garde son identité (nth, ref), jamais rejouée par un sélecteur plus large.
                // Sélecteur seul : smartClick et son échelle de repli (pages difficiles).
                const droit = actType === "rclick" || actType === "right_click";
                const button = droit ? "right" : act.button || "left";
                const delai = act.timeout || ACTION_TIMEOUT_MS;
                if (aUneCible(act)) {
                  const { locator } = await resolveChainTarget(act);
                  await cliquerSurCible(locator, (timeout) => locator.click({ timeout, button }), delai);
                  result = { success: true, action: droit ? "rclick" : "click", strategy: "official" };
                } else {
                  if (!act.selector) throw new Error("No target: provide by_*/ref or selector");
                  const {
                    locator: cliqueSur,
                    cadre: _c,
                    ...clic
                  } = await smartClick(page, act.selector, { human: act.human, button, timeout: delai });
                  locEtape = cliqueSur;
                  result = clic;
                }
                break;
              }

              case "dblclick":
              case "double_click": {
                const { locator } = await resolveChainTarget(act);
                const button = act.button || "left";
                await cliquerSurCible(
                  locator,
                  (timeout) => locator.dblclick({ timeout, button }),
                  act.timeout || ACTION_TIMEOUT_MS,
                );
                result = { success: true, action: "dblclick" };
                break;
              }

              case "fill": {
                const { locator } = await resolveChainTarget(act);
                try {
                  await locator.fill(act.text || act.value || "", {
                    timeout: act.timeout || ACTION_TIMEOUT_MS,
                  });
                } catch {
                  await locator.evaluate(
                    (el: HTMLInputElement, val: string) => {
                      el.focus();
                      el.value = val;
                      el.dispatchEvent(new Event("input", { bubbles: true }));
                      el.dispatchEvent(new Event("change", { bubbles: true }));
                    },
                    act.text || act.value || "",
                  );
                }
                result = { success: true, action: "fill" };
                break;
              }

              case "type": {
                const { locator } = await resolveChainTarget(act);
                await locator.click({ timeout: 3000 }).catch(() => {});
                await locator.pressSequentially(act.text || act.value || "", { delay: act.delay || 50 });
                result = { success: true, action: "type" };
                break;
              }

              case "press": {
                const hasTarget =
                  act.ref ||
                  act.by_role ||
                  act.by_text ||
                  act.by_label ||
                  act.by_placeholder ||
                  act.by_test_id ||
                  act.by_css ||
                  act.by_xpath ||
                  act.selector;
                if (hasTarget) {
                  const { locator } = await resolveChainTarget(act);
                  await locator.press(act.key!, { timeout: act.timeout || ACTION_TIMEOUT_MS });
                } else {
                  await page.keyboard.press(act.key!);
                }
                result = { success: true, action: "press", key: act.key };
                break;
              }

              case "select":
              case "select_option": {
                const { locator } = await resolveChainTarget(act);
                // Même résolution sans essai-erreur que /action : on lit les
                // <option> puis on choisit UNE fois. L'échelle value→label
                // consommait deux timeouts pleins, et le recorder ne savait
                // pas ce qui avait été choisi (audit tools web 2026-09-05).
                const picked = await selectOptionSmart(locator, {
                  option_value: act.option_value,
                  option_label: act.option_label || act.label,
                  value: act.value,
                  text: act.text,
                  timeout: act.timeout || ACTION_TIMEOUT_MS,
                });
                result = { success: true, action: "select", selected: picked };
                break;
              }

              case "check": {
                const { locator } = await resolveChainTarget(act);
                const _to = { timeout: act.timeout || ACTION_TIMEOUT_MS };
                if (act.checked !== false) await locator.check(_to);
                else await locator.uncheck(_to);
                result = { success: true, action: "check" };
                break;
              }
              case "uncheck": {
                const { locator } = await resolveChainTarget(act);
                await locator.uncheck({ timeout: act.timeout || ACTION_TIMEOUT_MS });
                result = { success: true, action: "uncheck" };
                break;
              }

              case "wait":
                if (aUneCible(act))
                  await attendreCible(act, Number(act.timeout) > 0 ? Number(act.timeout) : 10000);
                else if (act.selector) {
                  // Sélecteur CSS ou Playwright, sinon texte : les deux lectures courent ensemble, la première qui voit l'élément l'emporte (un CSS invalide échoue aussitôt).
                  const timeout = act.timeout || 10000;
                  await Promise.any([
                    page.waitForSelector(act.selector, { state: "visible", timeout }),
                    page.getByText(act.selector).first().waitFor({ state: "visible", timeout }),
                  ]).catch((e: unknown) => {
                    const erreurs = (e as { errors?: Error[] }).errors || [];
                    throw erreurs.find((x) => /timeout/i.test(x.message)) ?? erreurs[0] ?? e;
                  });
                } else if (act.wait_for === "network")
                  await Promise.race([page.waitForLoadState("networkidle"), page.waitForTimeout(6000)]);
                else if (act.ms) await page.waitForTimeout(act.ms);
                else await page.waitForTimeout(1000);
                result = { success: true, action: "wait" };
                break;

              case "scroll":
                await page.mouse.wheel(0, act.amount || 500);
                result = { success: true, action: "scroll" };
                break;

              case "goto": {
                const _motif = await refusUrl(act.url);
                if (_motif) throw new Error(messageRefus(act.url, _motif));
                await page.goto(act.url!, { waitUntil: "domcontentloaded", timeout: 30000 });
                await Promise.race([
                  page.waitForLoadState("networkidle").catch(() => {}),
                  page.waitForTimeout(2000),
                ]);
                result = { success: true, action: "goto", url: page.url() };
                break;
              }

              case "hover": {
                const { locator } = await resolveChainTarget(act);
                await locator.hover({ timeout: act.timeout || ACTION_TIMEOUT_MS });
                result = { success: true, action: "hover" };
                break;
              }

              case "focus": {
                const { locator } = await resolveChainTarget(act);
                await locator.focus({ timeout: act.timeout || ACTION_TIMEOUT_MS });
                result = { success: true, action: "focus" };
                break;
              }

              default:
                throw erreurCodee("unknown_action", `Unknown chain action: ${actType || "(none)"}.`, {
                  fix: `Use one of: ${GESTES_CHAINE.join(", ")}.`,
                });
            }

            // Post-action wait
            if (act.wait_after) await postActionWait(page, act.wait_after);
            const nav = suivi ? await suivi({ limite: (req.recuA || startMs) + BUDGET_CHAINE_MS }) : null;
            if (nav && result && result.success !== false) Object.assign(result, champsNavigation(nav));

            // Recorder hook (no-op when not recording)
            if (result && result.success !== false) {
              const saisie = (actType === "fill" || actType === "type") && req.session!._recorder?.recording;
              await recordEvent(
                req.session!,
                {
                  action:
                    actType === "select_option"
                      ? "select"
                      : actType === "double_click"
                        ? "dblclick"
                        : actType === "right_click"
                          ? "rclick"
                          : actType,
                  locator: {
                    role: act.by_role,
                    name: act.by_name,
                    text: act.by_text,
                    label: act.by_label,
                    placeholder: act.by_placeholder,
                    test_id: act.by_test_id,
                    css: act.by_css,
                    xpath: act.by_xpath,
                  },
                  selector: act.selector,
                  ref: act.ref,
                  value: act.text || act.value,
                  ...(result && result.selected
                    ? {
                        value: result.selected.value,
                        option_label: result.selected.label,
                        selected: result.selected,
                      }
                    : {}),
                  key: act.key,
                  url: page.url(),
                },
                locEtape ||
                  ((saisie || act.ref) && req.session!._recorder?.recording
                    ? await resolveChainTarget(act).then(
                        (r) => r.locator,
                        () => null,
                      )
                    : null),
              );
            }

            results.push({ step: i, action: actType, duration_ms: Date.now() - startMs, ...result });
          } catch (e) {
            if (suivi) suivi.annuler();
            const msg = sansAnsi((e as Error).message || String(e));
            const failResult: ResultatEtape = {
              step: i,
              action: actType,
              success: false,
              error: msg.substring(0, 200),
              code: detailsErreur(e).code || codeErreur(msg),
              ...((e as ErreurCodee).details || {}),
              duration_ms: Date.now() - startMs,
            };

            // Feature 3: Smart retry context — try selector or any text-bearing param
            const inconnue = failResult.code === "unknown_action";
            const probe = inconnue ? "" : act.selector || act.by_name || act.by_text || act.by_label || "";
            if (probe) {
              failResult.alternatives = await findAlternatives(page, probe).catch(() => []);
            }
            // Rien sous ce texte : les cibles aux noms proches (ou du même rôle) de l'instantané ARIA.
            if (failResult.code === "element_not_found" && !(failResult.alternatives || []).length) {
              const byParams = {
                by_role: act.by_role,
                by_name: act.by_name,
                by_text: act.by_text,
                by_label: act.by_label,
                by_placeholder: act.by_placeholder,
                by_test_id: act.by_test_id,
                by_alt: act.by_alt,
                by_title: act.by_title,
              };
              failResult.alternatives = await suggestionsCible(page, byParams, act.selector).catch(() => []);
            }

            // Feature 4: Screenshot on failure
            if (screenshot_on_fail && !inconnue) {
              const ss = await screenshotOnFailure(page, req.sessionId, actType);
              Object.assign(failResult, ss);
            }

            results.push(failResult);
            failed = true;

            if (stop_on_error) break;
          }
        }

        res.json({
          ok: !failed,
          total: actions.length,
          executed: results.length,
          failed: failed ? results.filter((r) => !r.success).length : 0,
          results,
        });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );
}
