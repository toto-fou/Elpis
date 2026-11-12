// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/routes/chaine.ts — /chain: several gestures in one call, stopped at the first failure (screenshot and alternatives). */
import { screenshotOnFailure } from '../captures.ts';
import { refusUrl } from '../destinations.ts';
import { recordEvent } from '../enregistrement.ts';
import { GESTES_NAVIGANTS, champsNavigation, suivreNavigation } from '../geste_util.ts';
import { postActionWait, selectOptionSmart } from '../gestes.ts';
import { smartClick } from '../interaction.ts';
import { ACTION_TIMEOUT_MS, NOT_FOUND_GRACE_MS, cibleDepuisParams, findAlternatives, resoudreRepli, suggestionsCible, trouveParRepli } from '../localisateur.ts';
import { BUDGET_CHAINE_MS, detailsErreur, erreurCodee, intercepteurs, NAV_GRACE_MS, suiviTelechargements } from '../requete.ts';
import { codeErreur, describeLocator, sansAnsi } from '../result_util.ts';
import { messageRefus } from '../url_guard.ts';


export function registerChainRoutes(app, ctx) {
const { getSession, autoSnapshot } = intercepteurs(ctx);
// ==========================================
// ACTION CHAINING (Feature 2) — v2: prefers by_* params over selector strings
// ==========================================
app.post('/chain', getSession, autoSnapshot, suiviTelechargements, async (req, res) => {
    try {
        const { page } = req.session;
        const { actions = [], stop_on_error = true, screenshot_on_fail = true } = req.body;

        if (!Array.isArray(actions) || actions.length === 0)
            return res.status(400).json({ error: 'actions[] required (array of action objects)' });
        if (actions.length > 30)
            return res.status(400).json({ error: 'Max 30 actions per chain' });

        // Resolve a chain step's target. Prefers `ref` and explicit `by_*`
        // params (Playwright official API — robust). Falls back to a
        // `selector` string parsed by smartResolveLocator (text/CSS/XPath).
        async function resolveChainTarget(act) {
            const params = {
                ref: act.ref,
                by_role: act.by_role, by_name: act.by_name, by_text: act.by_text,
                by_label: act.by_label, by_placeholder: act.by_placeholder,
                by_test_id: act.by_test_id, by_alt: act.by_alt, by_title: act.by_title,
                by_css: act.by_css, by_xpath: act.by_xpath, nth: act.nth,
            };
            const hasOfficial = Object.values(params).some(v => v !== undefined && v !== null && v !== '');
            if (hasOfficial) {
                // Comptée d'abord, comme /action : une cible absente échoue vite (element_not_found).
                const c = await cibleDepuisParams(ctx, page, params, req.sessionId, Number(act.timeout) > 0 ? Number(act.timeout) : NOT_FOUND_GRACE_MS);
                if (c) {
                    if (c.n > 0 && !(c.nth !== null && c.nth >= c.n)) return { locator: c.loc.first(), source: 'official', matched: c.n };
                    if (!act.selector || !(await trouveParRepli(page, act.selector)))
                        throw erreurCodee('element_not_found', `No element matches ${act.ref ? `ref ${act.ref}` : describeLocator(params, { first: false })} on this page.`);
                }
            }
            if (act.selector) {
                const r = await resoudreRepli(page, act.selector, { params });
                return { locator: r.locator, source: r.strategy || 'selector' };
            }
            throw new Error('No target: provide by_*/ref or selector');
        }

        const results = [];
        let failed = false;

        for (let i = 0; i < actions.length; i++) {
            const act = actions[i];
            const actType = act.type || act.action || '';
            const startMs = Date.now();
            let locEtape = null;
            const suivi = GESTES_NAVIGANTS.has(actType) ? suivreNavigation(page, { graceMs: NAV_GRACE_MS }) : null;

            try {
                let result;

                switch (actType) {
                    case 'click':
                    case 'smart_click': {
                        // For click we still prefer smartClick when only a selector is given
                        // (it has the 7-strategy cascade for tricky pages). But when by_* is
                        // present we use the official locator path for max robustness.
                        const hasOfficial = act.ref || act.by_role || act.by_text || act.by_label
                            || act.by_placeholder || act.by_test_id || act.by_css || act.by_xpath;
                        if (hasOfficial) {
                            const { locator } = await resolveChainTarget(act);
                            await locator.click({ timeout: act.timeout || ACTION_TIMEOUT_MS, button: act.button || 'left' });
                            result = { success: true, action: 'click', strategy: 'official' };
                        } else {
                            const { locator: cliqueSur, cadre: _c, ...clic } = await smartClick(page, act.selector, {
                                human: act.human, button: act.button || 'left', timeout: act.timeout || ACTION_TIMEOUT_MS
                            });
                            locEtape = cliqueSur;
                            result = clic;
                        }
                        break;
                    }

                    case 'fill': {
                        const { locator } = await resolveChainTarget(act);
                        try { await locator.fill(act.text || act.value || '', { timeout: act.timeout || ACTION_TIMEOUT_MS }); }
                        catch {
                            await locator.evaluate((el, val) => {
                                el.focus(); el.value = val;
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                            }, act.text || act.value || '');
                        }
                        result = { success: true, action: 'fill' };
                        break;
                    }

                    case 'type': {
                        const { locator } = await resolveChainTarget(act);
                        await locator.click({ timeout: 3000 }).catch(() => {});
                        await locator.pressSequentially(act.text || act.value || '', { delay: act.delay || 50 });
                        result = { success: true, action: 'type' };
                        break;
                    }

                    case 'press': {
                        const hasTarget = act.ref || act.by_role || act.by_text || act.by_label
                            || act.by_placeholder || act.by_test_id || act.by_css || act.by_xpath || act.selector;
                        if (hasTarget) {
                            const { locator } = await resolveChainTarget(act);
                            await locator.press(act.key, { timeout: act.timeout || ACTION_TIMEOUT_MS });
                        } else {
                            await page.keyboard.press(act.key);
                        }
                        result = { success: true, action: 'press', key: act.key };
                        break;
                    }

                    case 'select':
                    case 'select_option': {
                        const { locator } = await resolveChainTarget(act);
                        // Même résolution sans essai-erreur que /action : on lit les
                        // <option> puis on choisit UNE fois. L'échelle value→label
                        // consommait deux timeouts pleins, et le recorder ne savait
                        // pas ce qui avait été choisi (audit tools web 2026-09-05).
                        const picked = await selectOptionSmart(locator, {
                            option_value: act.option_value, option_label: act.option_label || act.label,
                            value: act.value, text: act.text, timeout: act.timeout || ACTION_TIMEOUT_MS });
                        result = { success: true, action: 'select', selected: picked };
                        break;
                    }

                    case 'check': {
                        const { locator } = await resolveChainTarget(act);
                        const _to = { timeout: act.timeout || ACTION_TIMEOUT_MS };
                        if (act.checked !== false) await locator.check(_to);
                        else await locator.uncheck(_to);
                        result = { success: true, action: 'check' };
                        break;
                    }
                    case 'uncheck': {
                        const { locator } = await resolveChainTarget(act);
                        await locator.uncheck({ timeout: act.timeout || ACTION_TIMEOUT_MS });
                        result = { success: true, action: 'uncheck' };
                        break;
                    }

                    case 'wait':
                        if (act.selector) await page.waitForSelector(act.selector, { state: 'visible', timeout: act.timeout || 10000 });
                        else if (act.wait_for === 'network') await Promise.race([page.waitForLoadState('networkidle'), page.waitForTimeout(6000)]);
                        else if (act.ms) await page.waitForTimeout(act.ms);
                        else await page.waitForTimeout(1000);
                        result = { success: true, action: 'wait' };
                        break;

                    case 'scroll':
                        await page.mouse.wheel(0, act.amount || 500);
                        result = { success: true, action: 'scroll' };
                        break;

                    case 'goto': {
                        const _motif = await refusUrl(act.url);
                        if (_motif) throw new Error(messageRefus(act.url, _motif));
                        await page.goto(act.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(2000)]);
                        result = { success: true, action: 'goto', url: page.url() };
                        break;
                    }

                    case 'hover': {
                        const { locator } = await resolveChainTarget(act);
                        await locator.hover({ timeout: act.timeout || ACTION_TIMEOUT_MS });
                        result = { success: true, action: 'hover' };
                        break;
                    }

                    case 'focus': {
                        const { locator } = await resolveChainTarget(act);
                        await locator.focus({ timeout: act.timeout || ACTION_TIMEOUT_MS });
                        result = { success: true, action: 'focus' };
                        break;
                    }

                    default:
                        result = { success: false, error: `Unknown chain action: ${actType}` };
                }

                // Post-action wait
                if (act.wait_after) await postActionWait(page, act.wait_after);
                const nav = suivi ? await suivi({ limite: (req.recuA || startMs) + BUDGET_CHAINE_MS }) : null;
                if (nav && result && result.success !== false) Object.assign(result, champsNavigation(nav));

                // Recorder hook (no-op when not recording)
                if (result && result.success !== false) {
                    const saisie = (actType === 'fill' || actType === 'type') && req.session._recorder?.recording;
                    await recordEvent(req.session, {
                        action: actType === 'select_option' ? 'select' : actType,
                        locator: {
                            role: act.by_role, name: act.by_name, text: act.by_text,
                            label: act.by_label, placeholder: act.by_placeholder,
                            test_id: act.by_test_id, css: act.by_css, xpath: act.by_xpath,
                        },
                        selector: act.selector,
                        ref: act.ref,
                        value: act.text || act.value,
                        ...(result && result.selected ? { value: result.selected.value, option_label: result.selected.label, selected: result.selected } : {}),
                        key: act.key,
                        url: page.url(),
                    }, locEtape || ((saisie || act.ref) && req.session._recorder?.recording ? await resolveChainTarget(act).then(r => r.locator, () => null) : null));
                }

                results.push({ step: i, action: actType, duration_ms: Date.now() - startMs, ...result });

            } catch (e) {
                if (suivi) suivi.annuler();
                const msg = sansAnsi(e.message || String(e));
                const failResult = {
                    step: i, action: actType, success: false, error: msg.substring(0, 200),
                    code: detailsErreur(e).code || codeErreur(msg), ...(e.details || {}),
                    duration_ms: Date.now() - startMs,
                };

                // Feature 3: Smart retry context — try selector or any text-bearing param
                const probe = act.selector || act.by_name || act.by_text || act.by_label || '';
                if (probe) {
                    failResult.alternatives = await findAlternatives(page, probe).catch(() => []);
                }
                // Rien sous ce texte : les cibles aux noms proches (ou du même rôle) de l'instantané ARIA.
                if (failResult.code === 'element_not_found' && !(failResult.alternatives || []).length) {
                    const byParams = { by_role: act.by_role, by_name: act.by_name, by_text: act.by_text,
                        by_label: act.by_label, by_placeholder: act.by_placeholder, by_test_id: act.by_test_id,
                        by_alt: act.by_alt, by_title: act.by_title };
                    failResult.alternatives = await suggestionsCible(page, byParams, act.selector).catch(() => []);
                }

                // Feature 4: Screenshot on failure
                if (screenshot_on_fail) {
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
            failed: failed ? results.filter(r => !r.success).length : 0,
            results,
        });

    } catch (e) { res.status(500).json({ error: e.message }); }
});
}
