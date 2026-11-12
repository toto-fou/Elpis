// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/routes/localiser.ts — /locator and /handle_dropdown: targets found by pw_find (refs, candidates) and dropdown handling. */
import { recordEvent } from '../enregistrement.ts';
import { selectOptionSmart } from '../gestes.ts';
import { smartClick } from '../interaction.ts';
import { ACTION_TIMEOUT_MS, REF_TTL_MS, decrireNoeud, resolveOfficialLocator, resoudreCible, resoudreRepli, shadowDOMQueryByText, storeLocatorRef } from '../localisateur.ts';
import { decrireElement } from '../recorder_util.ts';
import { intercepteurs, repondreErreur } from '../requete.ts';


export function registerLocatorRoutes(app, ctx) {
const { getSession, autoSnapshot } = intercepteurs(ctx);
// ======================== LOCATOR (officiel Playwright API) ========================
// Utilise getByRole/getByText/getByLabel/etc. — l'API officielle Playwright.
// Renvoie un `ref` opaque que pw_act peut utiliser pour cliquer/taper sans
// reconstruire de sélecteur.
app.post('/locator', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const params = req.body;
        const max = Math.min(params.max || 5, 20);
        const visible_only = params.visible_only !== false;

        const includeFrames = params.include_frames === true;

        // Validation des critères (indépendant du scope).
        if (!resolveOfficialLocator(page, params)) {
            return res.status(400).json({
                error: "Au moins un critère requis: by_role, by_text, by_label, by_placeholder, by_test_id, by_alt, by_title, by_css, by_xpath"
            });
        }

        // Mécanisme Playwright natif : page.frames() renvoie le frame principal
        // + chaque iframe (imbriquée incluse). Frame expose la MÊME API Locator
        // que Page → on résout la même stratégie sur chaque scope et on agrège.
        // Sans include_frames on scope sur mainFrame() (PAS `page`) : un objet
        // Page échoue le test `scope === page.mainFrame()` ci-dessous et le
        // code tentait alors `scope.name()` — inexistant sur Page → TypeError
        // « scope.name is not a function » sur 100 % des pw_find.
        const scopes = includeFrames ? page.frames() : [page.mainFrame()];
        const matches = [];
        let total = 0;
        let nameMatch = null;

        for (const scope of scopes) {
            if (matches.length >= max) break;
            // Même résolution que pw_act, pw_expect et pw_chain (nom entier d'abord, nth sur la liste retenue).
            const c = await resoudreCible(scope, params);
            if (!c) continue;
            const loc = c.loc;
            const count = c.nth === null ? c.n : await loc.count().catch(() => 0);
            if (count === 0) continue;
            total += count;
            if (!nameMatch && (c.nameMatch === 'substring' || c.partial > c.n)) nameMatch = c.nameMatch;
            const isMain = scope === page.mainFrame();
            const frameInfo = isMain ? null : { name: scope.name() || '', url: scope.url() || '' };
            // Le ref mémorise le frame d'origine → resolveRef re-résout sur CE frame
            // (pw_act peut donc agir sur un élément d'iframe).
            const baseRef = storeLocatorRef(ctx, req.sessionId, loc, c.params, frameInfo);

            for (let i = 0; i < Math.min(count, max); i++) {
                if (matches.length >= max) break;
                const item = loc.nth(i);
                try {
                    const visible = await item.isVisible({ timeout: 200 }).catch(() => false);
                    if (visible_only && !visible) continue;

                    const info = await item.evaluate(decrireNoeud, { xpath: true }).catch(() => null);

                    if (!info) continue;
                    // getByRole a trouvé l'élément par CE rôle : c'est son rôle effectif.
                    if (params.by_role) info.role = params.by_role;
                    matches.push({
                        ...info,
                        visible,
                        enabled: await item.isEnabled().catch(() => true),
                        ref: count > 1 ? `${baseRef}#${i}` : baseRef,
                        ...(frameInfo ? { frame: frameInfo } : {}),
                    });
                } catch (e) { /* ignore individual failures */ }
            }
        }

        const ttlS = Math.round(REF_TTL_MS / 1000);
        res.json({
            count: matches.length,
            total,
            matches,
            ...(nameMatch ? { name_match: nameMatch } : {}),
            ...(includeFrames ? { frames_searched: scopes.length } : {}),
            // Durée de vie du ref, DITE : un ref rejoué sur un contenu qui a
            // disparu entre-temps est le piège classique des pages instables.
            ref_ttl_s: ttlS,
            ref_reusable: true,
            // Hint pour le LLM
            usage_hint: matches.length === 1
                ? `Pass ref="${matches[0].ref}" to pw_act for this element (reusable for ${ttlS}s — re-run pw_find on content that shifts/disappears)`
                : matches.length > 1
                ? `Multiple matches. Use refs above, or refine with filter_has_text/nth (refs reusable for ${ttlS}s).`
                : 'No visible matches found.',
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== HANDLE DROPDOWN (custom + natif) ========================
app.post('/handle_dropdown', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector, option_text, option_value, search_text } = req.body;

        const { locator } = await resoudreRepli(page, selector);
        const tag = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

        // Cas 1 : select natif (même choix que select, l'option retenue est rendue)
        if (tag === 'select') {
            const selected = await selectOptionSmart(locator, {
                option_value, option_label: option_value ? undefined : option_text, timeout: ACTION_TIMEOUT_MS });
            await recordEvent(req.session, { action: 'select', selector, value: selected.value, option_label: selected.label, selected, url: page.url() }, locator);
            return res.json({ status: 'success', type: 'native-select', selected });
        }


        // Cas 2 : combobox/input avec datalist
        const inputType = await locator.evaluate(el => el.getAttribute('type') || '').catch(() => '');
        if (tag === 'input' && inputType !== 'hidden') {
            await locator.fill(search_text || option_text || option_value || '');
            await page.waitForTimeout(400);
            // Chercher dans les suggestions (datalist, autocomplete)
            const suggestions = [
                `[role="option"]:has-text("${option_text || option_value}")`,
                `datalist option[value="${option_value || option_text}"]`,
                `li:has-text("${option_text || option_value}")`,
                `.autocomplete-suggestion:has-text("${option_text || option_value}")`,
            ];
            for (const s of suggestions) {
                const sl = page.locator(s).first();
                if (await sl.count().catch(() => 0) > 0) {
                    const label = (await sl.innerText({ timeout: 1000 }).catch(() => '')).trim();
                    const optionDecrite = await sl.evaluate(decrireElement, null, { timeout: 1000 }).catch(() => null);
                    await sl.click();
                    await recordEvent(req.session, { action: 'pick', kind: 'autocomplete', selector, url: page.url(),
                        value: search_text || option_text || option_value || '', option: label,
                        ...(optionDecrite ? { option_locator: optionDecrite } : {}) }, locator);
                    const valeur = await locator.inputValue({ timeout: 1000 }).catch(() => null);
                    return res.json({ status: 'success', type: 'input-autocomplete', selected: { label, value: valeur } });
                }
            }
            await page.keyboard.press('Enter');
            const valeur = await locator.inputValue({ timeout: 1000 }).catch(() => null);
            await recordEvent(req.session, { action: 'pick', kind: 'enter', selector, url: page.url(), value: search_text || option_text || option_value || '' }, locator);
            return res.json({ status: 'success', type: 'input-enter', selected: { value: valeur } });
        }

        // Cas 3 : dropdown custom (div/button) ; le déclencheur est décrit avant que la liste ne s'ouvre
        const declencheur = req.session._recorder?.recording ? await locator.evaluate(decrireElement, null, { timeout: 1000 }).catch(() => null) : null;
        await smartClick(page, selector);
        await page.waitForTimeout(350);

        // Chercher l'option dans la liste déroulante ouverte
        const optionText = option_text || option_value || '';
        const optionSelectors = [
            `[role="option"]:has-text("${optionText}")`,
            `[role="listbox"] *:has-text("${optionText}")`,
            `[role="menu"] *:has-text("${optionText}")`,
            `[class*="option"]:has-text("${optionText}")`,
            `[class*="item"]:has-text("${optionText}")`,
            `[class*="choice"]:has-text("${optionText}")`,
            `li:has-text("${optionText}")`,
            `td:has-text("${optionText}")`,
        ];

        for (const s of optionSelectors) {
            const optLoc = page.locator(s).first();
            if (await optLoc.count().catch(() => 0) > 0 && await optLoc.isVisible({ timeout: 500 }).catch(() => false)) {
                const label = (await optLoc.innerText({ timeout: 1000 }).catch(() => optionText)).trim();
                const optionDecrite = req.session._recorder?.recording ? await optLoc.evaluate(decrireElement, null, { timeout: 1000 }).catch(() => null) : null;
                await optLoc.click();
                await recordEvent(req.session, { action: 'pick', kind: 'custom', selector, url: page.url(), option: label,
                    ...(declencheur ? { locator: declencheur } : {}), ...(optionDecrite ? { option_locator: optionDecrite } : {}) }, locator);
                return res.json({ status: 'success', type: 'custom-dropdown', matched_by: s, selected: { label } });
            }
        }

        // Fallback : chercher par text dans shadow DOM
        const shadowOpt = await shadowDOMQueryByText(page, optionText);
        if (shadowOpt?.found) {
            await page.mouse.click(shadowOpt.x, shadowOpt.y);
            await recordEvent(req.session, { action: 'pick', kind: 'custom', selector, url: page.url(), option: optionText,
                ...(declencheur ? { locator: declencheur } : {}) }, locator);
            return res.json({ status: 'success', type: 'shadow-dom-dropdown', selected: { label: optionText } });
        }

        return res.status(404).json({ error: `Option "${optionText}" not found in the dropdown.`, code: 'option_not_found',
            fix: 'Open the dropdown and read its options with pw_page(action="inspect"), then pass the visible text as option_label=.' });
    } catch (e) { repondreErreur(res, e); }
});
}
