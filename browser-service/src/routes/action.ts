// SPDX-License-Identifier: MIT
/** browser-service/src/routes/action.ts — /action : un geste sur une cible, avec la navigation et les téléchargements qu'il déclenche. */
import type { Application, Request, Response } from 'express';
import type { Locator, Response as ReponsePw } from 'playwright';

import { screenshotOnFailure } from '../captures.ts';
import type { ServiceContext } from '../contexte.ts';
import { refusUrl, repondreRefus } from '../destinations.ts';
import { cheminCadres, recordEvent } from '../enregistrement.ts';
import { detailsNavigation } from '../evenements.ts';
import { expandTreeItem, fichiersUpload, performDrag, postActionWait, revenirApresEchec, selectOptionSmart, urlApresEchec } from '../gestes.ts';
import { captureAncestors, humanClick, humanMouseMove, resolveFormInput, safeRemoveOverlays, scrollIntoViewIfNeeded, smartClick } from '../interaction.ts';
import type { ElementClique } from '../interaction.ts';
import { ACTION_TIMEOUT_MS, NOT_FOUND_GRACE_MS, attendrePresence, candidatsCible, cocherParScript, decrireNoeud, erreurIntrouvable, findAlternatives, resolveRef, resoudreCible, resoudreRepli, trouveParRepli } from '../localisateur.ts';
import type { CibleResolue } from '../localisateur.ts';
import { authHint, classifyNavOutcome, estPageErreur } from '../nav_util.ts';
import { detailsErreur, intercepteurs, repondreErreur, suiviNavigationGeste, suiviTelechargements } from '../requete.ts';
import { codeErreur, describeLocator } from '../result_util.ts';
import type { ParamsCible } from '../result_util.ts';
import { OFFICIAL_TRY_MS } from '../sessions.ts';

/** Touche modificatrice tenue pendant un clic ou un survol (Playwright). */
type Modificateur = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';

/** Corps de /action : le geste, sa cible (ref, by_*, sélecteur de repli) et ses options (champs de glisser lus par performDrag). */
interface CorpsAction {
    type: string;
    selector?: string;
    text?: string;
    key?: string;
    url?: string;
    relative_to?: string;
    /** Point de clic {x, y} dans la cible, ou la pseudo-classe de disposition de click_relative. */
    position?: { x: number; y: number } | string;
    timeout?: number;
    force?: boolean;
    modifiers?: Modificateur[];
    button?: 'left' | 'right' | 'middle';
    option_value?: string;
    option_label?: string;
    dx?: number;
    dy?: number;
    delay?: number;
    target_selector?: string;
    human?: boolean;
    wait_after?: number | string | null;
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
    value?: string;
    files?: unknown;
    direction?: string;
    amount?: number;
    strict?: boolean;
    nth?: number;
    x?: number;
    y?: number;
    wait_for?: string;
    wait_timeout?: number;
    to?: ParamsCible;
}

/** Cible comptée avant le geste : par ref, ou résolue depuis by_* (resoudreCible). */
type CibleComptee = Pick<CibleResolue, 'loc' | 'n' | 'nameMatch' | 'partial' | 'params' | 'refBase'>;

/** Champ texte rempli par script : React garde sa dernière valeur dans `_valueTracker`. */
type ChampReact = (HTMLInputElement | HTMLTextAreaElement) & { _valueTracker?: { setValue(v: string): void } };

/** Une voie tentée pour atteindre la cible, listée dans la réponse. */
interface Tentative {
    via: string;
    ok: boolean;
    ms?: number;
    error?: string;
}

export function registerActionRoutes(app: Application, ctx: ServiceContext) {
const { getSession, autoSnapshot } = intercepteurs(ctx);
// ======================== ACTIONS ========================
app.post('/action', getSession, autoSnapshot, suiviTelechargements, suiviNavigationGeste, async (req: Request<CorpsAction>, res: Response): Promise<Response | void> => {
    try {
        const { page } = req.session!;
        const {
            type: rawType, selector: rawSelector, text, key, url: targetUrl,
            relative_to, position, timeout = ACTION_TIMEOUT_MS,
            force = false, modifiers = [], button = 'left',
            option_value, option_label, delay,
            human = false, wait_after = null,
            // Nouveau : API Playwright officielle
            ref, by_role, by_name, by_text, by_label, by_placeholder,
            by_test_id, by_alt, by_title, by_css, by_xpath,
            value, files,
            direction, amount,
        } = req.body;
        const strict = req.body.strict === true;
        const nth = Number.isInteger(req.body.nth) && req.body.nth! >= 0 && !String(ref || '').includes('#') ? req.body.nth! : null;
        // Le chemin « locator officiel » et le chemin « selector » n'ont jamais
        // parlé le même dialecte : le premier accepte double_click/rclick/
        // scroll_into_view, le second ne connaît que dblclick/right_click/
        // scroll. Tant que le repli n'existait pas, ça ne se voyait pas. Une
        // seule table d'alias, appliquée en entrée.
        const _TYPE_ALIASES: Record<string, string> = {
            double_click: 'dblclick', rclick: 'right_click',
            select_option: 'select', scroll_to: 'scroll_into_view',
        };
        const type = _TYPE_ALIASES[rawType] || rawType;
        // Point de clic dans la cible ({x, y} depuis son coin haut gauche : canvas, carte), pour click, dblclick, rclick et hover.
        const point = position && typeof position === 'object' ? position : null;
        if (point && !(Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0))
            return res.status(400).json({ error: 'position must be {x, y}: pixels from the top-left corner of the target, 0 or more.', code: 'invalid_position' });
        const auPoint = point ? { position: { x: point.x, y: point.y } } : {};
        let selectedOption: Awaited<ReturnType<typeof selectOptionSmart>> | null = null;
        let officialError: string | null = null;   // renseigné quand on retombe sur smartResolve
        let extra: Record<string, unknown> = {};             // champs additionnels du résultat (expanded, drag…)
        const _t0 = Date.now();

        // NAVIGATION
        if (type === 'goto') {
            // BUG FIX (Playwright 500 sur http://IP:port) : on ne laisse plus
            // l'exception de goto remonter au catch externe (500 opaque). On la
            // capture et on classe le résultat (cf. nav_util.classifyNavOutcome) :
            // succès, succès partiel (page atteinte malgré un timeout de
            // load-state), ou erreur de navigation propre (502).
            const _motif = await refusUrl(targetUrl);
            if (_motif) return repondreRefus(res, targetUrl, _motif);
            const prevUrl = page.url();
            let navError: string | null = null, gotoResp: ReponsePw | null = null;
            try {
                gotoResp = await page.goto(targetUrl!, { waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch (e) { navError = (e as Error).message; }
            // ROBUSTESSE : après un goto en ERREUR (ex. timeout sur IP black-hole
            // non-routable), la frame reste « loading » et les opérations qui
            // font page.evaluate (safeRemoveOverlays) ou attendent le réseau
            // BLOQUENT jusqu'à l'abandon TCP de l'OS (~minutes). On saute donc
            // ces étapes quand navError, et on lit page.url() de façon défensive.
            if (!navError) {
                await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(3000)]);
                await safeRemoveOverlays(page, false);
            }
            void recordEvent(req.session, { action: 'goto', url: targetUrl });
            let landed: string; try { landed = page.url(); } catch { landed = prevUrl; }
            // Échec : Chromium engage sa page d'erreur à la place de la page courante ; on revient à celle-ci.
            let restored = false;
            if (navError) {
                landed = await urlApresEchec(page, prevUrl);
                if (estPageErreur(landed) && prevUrl && prevUrl !== 'about:blank' && !estPageErreur(prevUrl)) {
                    landed = await revenirApresEchec(page, landed, req.recuA! + 70000);
                    restored = !estPageErreur(landed);
                }
            }
            const outcome = classifyNavOutcome(targetUrl!, prevUrl, landed, navError, { restored });
            // GUIDAGE MODÈLE : une page en 401/407 est protégée par une auth HTTP ; l'indice renvoie au secret attaché (pw_session start), jamais à un mot de passe.
            // Toute réponse rend aussi son statut (un 404 reste un succès), l'adresse finale et un certificat douteux.
            if (outcome.httpStatus === 200) Object.assign(outcome.body, await detailsNavigation(gotoResp, targetUrl, landed));
            const hint = authHint(outcome.body.http_status ?? null);
            if (hint) outcome.body.auth_hint = hint;
            return res.status(outcome.httpStatus).json(outcome.body);
        }
        if (type === 'back') { await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); return res.json({ status: 'success', url: page.url() }); }
        if (type === 'forward') { await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {}); return res.json({ status: 'success', url: page.url() }); }
        if (type === 'reload') { await page.reload({ waitUntil: 'domcontentloaded' }); return res.json({ status: 'success' }); }

        // Upload : contenus validés AVANT toute résolution (un refus ne doit pas passer par le repli).
        let uploadFiles: ReturnType<typeof fichiersUpload> | null = null;
        if (type === 'upload') {
            try { uploadFiles = fichiersUpload(files); }
            catch (e) { return res.status(400).json({ error: (e as Error).message, ...detailsErreur(e) }); }
        }

        // ── Résolution prioritaire : ref ou by_* (API officielle) ──
        // Si on a un ref ou des params by_*, on utilise un Locator officiel
        // au lieu de passer par smartClick (qui parse une chaîne CSS ambiguë).
        // → Fiabilité maximale, mappe direct sur l'API Playwright.
        let officialLocator: Locator | null = null;
        // Cible COMPTÉE avant le geste : absente → element_not_found rapide ; plusieurs → matched + warning, ou refus strict.
        let cible: CibleComptee | null = null;
        let cibleParams: ParamsCible | null = null;
        // Attente de présence : le délai explicite de l'appelant (qui peut l'allonger), sinon 2 s.
        const graceMs = Number(req.body.timeout) > 0 ? Number(req.body.timeout) : NOT_FOUND_GRACE_MS;
        if (ref) {
            // Format ref : "loc_xxx" ou "loc_xxx#N" (index)
            const [baseRef, idxStr] = String(ref).split('#');
            let loc = resolveRef(ctx, baseRef!, page, req.sessionId);
            if (loc && idxStr !== undefined) loc = loc.nth(parseInt(idxStr, 10));
            if (!loc) {
                return res.status(404).json({ error: `Ref expired or invalid: ${ref}. Re-call pw_find.`, code: 'ref_expired' });
            }
            cible = { loc, n: await attendrePresence(loc, graceMs), nameMatch: null, params: {}, refBase: baseRef! };
            if (cible.n === 0)
                return res.status(404).json({ error: `The element of ref ${ref} is no longer on the page. Re-call pw_find.`, code: 'ref_expired' });
        } else if (by_role || by_text || by_label || by_placeholder || by_test_id || by_alt || by_title || by_css || by_xpath) {
            cibleParams = { by_role, by_name, by_text, by_label, by_placeholder, by_test_id, by_alt, by_title, by_css, by_xpath };
            cible = await resoudreCible(page, cibleParams, graceMs);
        }
        if (cible && cible.n === 0) {
            if (!(rawSelector && await trouveParRepli(page, rawSelector))) {
                const e = await erreurIntrouvable(page, cibleParams, rawSelector);
                return res.status(404).json({ error: e.message, ...detailsErreur(e), url: page.url() });
            }
            officialError = 'no element matches the official locator';
        } else if (cible) {
            const expr = ref ? `ref ${ref}` : describeLocator(cible.params, { first: false });
            if (nth !== null && nth >= cible.n) {
                return res.status(404).json({ error: `nth=${nth} but only ${cible.n} element(s) match ${expr}.`,
                    code: 'element_not_found', matched: cible.n, fix: `Use nth between 0 and ${cible.n - 1}.` });
            }
            if (cible.n > 1 && nth === null && strict) {
                const candidates = await candidatsCible(ctx, cible.loc, req.sessionId!, cible.params, cible.n, { refBase: cible.refBase });
                return res.status(409).json({
                    error: `${cible.n} elements match ${expr}; strict=true refuses to pick one.`,
                    code: 'ambiguous_target', matched: cible.n, candidates,
                    fix: 'Pass ref= of the right candidate, add |nth=K (0-based) to the target, or use a more precise target.',
                });
            }
            officialLocator = nth !== null ? cible.loc.nth(nth) : cible.loc.first();
            const avis: string[] = [];
            if (cible.n > 1 && nth === null)
                avis.push(`${cible.n} elements match ${expr}; acted on the first. Pass strict=true to refuse ambiguous targets, or add |nth=K / use a ref from pw_find.`);
            else if (cible.n > 1)
                avis.push(`${cible.n} elements match ${expr}; acted on nth=${nth} (0-based). A position breaks when the list changes: prefer a ref from pw_find or a more precise target.`);
            if (cible.nameMatch === 'substring') {
                const vu = await officialLocator.evaluate(decrireNoeud).catch(() => null);
                avis.push(`No ${by_role} is named exactly "${by_name}"; matched by substring${vu && vu.name ? ` ("${vu.name}")` : ''}.`);
            }
            extra = { ...extra, matched: cible.n,
                      ...(cible.nameMatch === 'substring' || cible.partial! > cible.n ? { name_match: cible.nameMatch } : {}),
                      ...(avis.length ? { warning: avis.join(' ') } : {}) };
        }

        // ── Actions page-level (sans cible) ──
        // press, type sans cible → utilise page.keyboard (focus actuel)
        if (!officialLocator && !rawSelector) {
            // DÉFILEMENT DE PAGE. `scroll_into_view` sans cible n'était traité
            // NULLE PART : la requête traversait tout le handler pour finir en
            // 400 « Type d'action inconnu ». Il n'existait donc aucun moyen de
            // faire défiler la page — bloquant sur toute liste virtualisée ou
            // à défilement infini (audit 2026-08-08).
            if (type === 'scroll' || type === 'scroll_into_view') {
                const dir = direction || 'down';
                const amt = amount === undefined ? 500 : amount;
                const map: Record<string, [number, number]> = { down: [0, amt], up: [0, -amt], right: [amt, 0], left: [-amt, 0] };
                const [dxs, dys] = map[dir] || [0, amt];
                // window.scrollBy, PAS mouse.wheel : la molette fait défiler ce
                // qui se trouve SOUS LE CURSEUR. Si la souris est restée sur un
                // panneau à ascenseur après un clic, un « défile la page »
                // faisait défiler ce panneau — non déterministe, et invisible
                // dans le résultat (constaté en repassant les outils en direct).
                // Le mode `human` garde la molette : c'est son intérêt.
                if (human) await page.mouse.wheel(dxs, dys);
                else await page.evaluate(([x, y]: [number, number]) => window.scrollBy(x, y), [dxs, dys] as [number, number]);
                await postActionWait(page, wait_after);
                const pos = await page.evaluate(() => ({
                    y: Math.round(window.scrollY), x: Math.round(window.scrollX),
                    max_y: Math.round(Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight)),
                })).catch(() => null);
                // Audit tools web 2026-09-05 — sur une appli GWT/desktop-like la
                // PAGE ne défile pas (max_y:0) : tout se passe dans un
                // ScrollPanel. Mesuré `scroll page down 800 → y:0 max_y:0` avec
                // deux panneaux internes défilables. On défile alors le plus
                // grand conteneur défilable visible, et on le NOMME.
                let container = null;
                if (!human && pos && pos.max_y === 0) {
                    container = await page.evaluate(([x, y]: [number, number]) => {
                        const GEN_ID = /^(gwt-uid-|ext-gen|ext-comp-|x-auto-|yui_|:r|ember\d)/i;
                        const stableId = (el: Element) => el.id && !/^\d/.test(el.id) && !GEN_ID.test(el.id) && el.id.length < 60;
                        const sel = (el: Element) => {
                            if (stableId(el)) return `#${el.id}`;
                            // Chemin positionnel ancré (premier id stable ou body) —
                            // la MÊME chaîne que `scrollables` dans inspect, pour que
                            // le modèle retrouve son panneau d'un appel à l'autre.
                            const parts: string[] = []; let cur: Element | null = el, d = 0;
                            while (cur && cur.nodeType === 1 && cur.tagName !== 'HTML' && d < 40) {
                                const tag = cur.tagName.toLowerCase();
                                if (stableId(cur)) { parts.unshift(`#${cur.id}`); break; }
                                if (tag === 'body') { parts.unshift('body'); break; }
                                const par: Element | null = cur.parentElement;
                                if (!par) { parts.unshift(tag); break; }
                                parts.unshift(`${tag}:nth-child(${Array.from(par.children).indexOf(cur) + 1})`);
                                cur = par; d++;
                            }
                            return parts.join(' > ');
                        };
                        const cands: { el: Element; area: number }[] = [];
                        for (const el of document.querySelectorAll('div, section, main, article, ul, ol, table, tbody, aside, form')) {
                            let cs; try { cs = getComputedStyle(el); } catch { continue; }
                            if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 2) continue;
                            if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
                            const r = el.getBoundingClientRect();
                            if (r.width < 40 || r.height < 40 || r.bottom < 0 || r.top > innerHeight) continue;
                            cands.push({ el, area: r.width * r.height });
                        }
                        if (!cands.length) return null;
                        cands.sort((a, b) => b.area - a.area);
                        const el = cands[0]!.el, before = Math.round(el.scrollTop);
                        el.scrollBy(x, y);
                        return { selector: sel(el), before, top: Math.round(el.scrollTop),
                                 max: Math.round(el.scrollHeight - el.clientHeight), candidates: cands.length };
                    }, [dxs, dys] as [number, number]).catch(() => null);
                }
                return res.json({
                    status: 'success', strategy: container ? 'container-scroll' : 'page-scroll',
                    direction: dir, amount: amt, scroll: pos,
                    ...(container ? { container, note: `page not scrollable — scrolled the largest scrollable panel (${container.selector}); target it explicitly next time: target="css=${container.selector}"` } : {}),
                });
            }
            if (type === 'press' && key) {
                await page.keyboard.press(key);
                await postActionWait(page, wait_after);
                return res.json({ status: 'success', strategy: 'keyboard' });
            }
            if (type === 'type' && (text || value)) {
                await page.keyboard.type(text || value!, { delay: delay || 30 });
                await postActionWait(page, wait_after);
                return res.json({ status: 'success', strategy: 'keyboard' });
            }
        }

        // Si on a un Locator officiel, on l'utilise directement sur l'action
        if (officialLocator) {
            // Quand un `selector` de repli est joint, l'essai officiel doit
            // ÉCHOUER VITE : sinon il consomme les 10 s de budget, le client
            // Python coupe, et le repli — qui aurait trouvé — ne s'exécute
            // jamais. Mesuré sur un champ dans une <iframe> : timeout côté
            // outil alors que smartResolveLocator le résout (audit 2026-08-08).
            const officialTimeout = rawSelector
                ? Math.min(timeout, OFFICIAL_TRY_MS)
                : timeout;
            const _t = officialTimeout;
            const cadresAvant = req.session!._recorder?.recording ? await cheminCadres(officialLocator) : [];
            try {
                if (type === 'click') {
                    await officialLocator.click({ timeout: _t, button, modifiers, force, ...auPoint });
                    // Un treeitem / disclosure dit s'il s'est ouvert : sans ça un
                    // clic « réussi » qui n'a fait que SÉLECTIONNER passait pour
                    // un dépliage (audit tools web 2026-09-05).
                    const _ae = await officialLocator.getAttribute('aria-expanded', { timeout: 500 }).catch(() => null);
                    if (_ae !== null && _ae !== undefined) extra.expanded = _ae === 'true';
                } else if (type === 'double_click' || type === 'dblclick') {
                    await officialLocator.dblclick({ timeout: _t, button, modifiers, ...auPoint });
                } else if (type === 'right_click' || type === 'rclick') {
                    await officialLocator.click({ timeout: _t, button: 'right', modifiers, ...auPoint });
                } else if (type === 'hover') {
                    await officialLocator.hover({ timeout: _t, modifiers, ...auPoint });
                } else if (type === 'check') {
                    await officialLocator.check({ timeout: _t, force });
                } else if (type === 'uncheck') {
                    await officialLocator.uncheck({ timeout: _t, force });
                } else if (type === 'focus') {
                    await officialLocator.focus({ timeout: _t });
                } else if ((type === 'scroll_into_view' || type === 'scroll') && (direction || amount !== undefined)) {
                    // Cible + direction = défiler DANS ce conteneur (liste
                    // virtualisée, panneau à ascenseur), pas l'amener à l'écran.
                    await officialLocator.evaluate((el, { direction, amount }) => {
                        const map: Record<string, [number, number]> = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
                        const [x, y] = map[direction || 'down'] || [0, amount];
                        el.scrollBy(x, y);
                    }, { direction, amount: amount === undefined ? 500 : amount });
                } else if (type === 'scroll_into_view' || type === 'scroll') {
                    await officialLocator.scrollIntoViewIfNeeded({ timeout: _t });
                } else if (type === 'fill') {
                    await officialLocator.fill(text || value || '', { timeout: _t, force });
                } else if (type === 'type') {
                    await officialLocator.click({ timeout: _t }).catch(() => {});
                    await officialLocator.fill(''); // clear first
                    await officialLocator.type(text || value || '', { delay: delay || 30, timeout: _t });
                } else if (type === 'clear') {
                    await officialLocator.fill('', { timeout: _t, force });
                } else if (type === 'press') {
                    await officialLocator.press(key!, { timeout: _t });
                } else if (type === 'select_option' || type === 'select') {
                    if (!option_value && !option_label && !value && !text)
                        throw new Error('select requires option_value=, option_label=, value= or text=');
                    selectedOption = await selectOptionSmart(officialLocator, {
                        option_value, option_label, value, text, timeout: _t });
                } else if (type === 'upload') {
                    await officialLocator.setInputFiles(uploadFiles!, { timeout: _t });
                    extra = { ...extra, uploaded: uploadFiles!.map(f => ({ name: f.name, size: f.buffer.length })) };
                } else if (type === 'expand' || type === 'collapse') {
                    extra = { ...extra, ...(await expandTreeItem(page, officialLocator, type === 'expand', _t)) };
                } else if (type === 'drag') {
                    extra = { ...extra, ...(await performDrag(ctx, page, officialLocator, req.body, _t)) };
                } else {
                    return res.status(400).json({ error: `Action '${type}' incompatible avec API Playwright officielle. Utilise selector= au lieu de by_*/ref.` });
                }
                await postActionWait(page, wait_after);
                // AX Memory : capture la chaine d'ancetres du locator
                // pour construire la hierarchie DOM multi-niveaux cote Python
                const ancestors = await captureAncestors(officialLocator).catch(() => []);
                // Recorder hook (no-op when not recording)
                await recordEvent(req.session, {
                    action: type === 'select_option' ? 'select' : (type === 'double_click' ? 'dblclick' : type === 'right_click' ? 'rclick' : type),
                    locator: { role: by_role, name: by_name, text: by_text, label: by_label, placeholder: by_placeholder, test_id: by_test_id, css: by_css, xpath: by_xpath, alt: by_alt, title: by_title },
                    value: text || value, key,
                    // L'option RÉELLEMENT choisie — le rejeu n'écrit plus
                    // selectOption('') (audit tools web 2026-09-05).
                    ...(selectedOption ? { value: selectedOption.value, option_label: selectedOption.label, selected: selectedOption } : {}),
                    ...(uploadFiles ? { files: uploadFiles.map(f => f.name) } : {}),
                    ...(cadresAvant.length ? { frames: cadresAvant } : {}),
                    url: page.url(), ref,
                }, officialLocator);
                return res.json({
                    status: 'success',
                    strategy: ref ? 'ref' : 'by_official',
                    // Ce que le service a RÉELLEMENT résolu, et par quel chemin :
                    // un succès par repli n'est plus indiscernable d'un succès
                    // direct (audit tools web 2026-09-05).
                    resolved_selector: describeLocator(ref ? { ref } : { ...cible!.params, ...(nth !== null ? { nth } : {}) }, { first: true }),
                    attempts: [{ via: ref ? 'ref' : 'official', ok: true, ms: Date.now() - _t0 }],
                    url: page.url(),
                    ...(selectedOption ? { selected: selectedOption } : {}),
                    ...extra,
                    ancestors: ancestors,
                });
            } catch (e) {
                // ── REPLI sur l'échelle « smart » ──────────────────────────
                // Un locator officiel qui échoue renvoyait un 500 sec. Or
                // l'échelle smartResolveLocator sait faire ce que l'API
                // officielle ne fait pas : remonter du texte vers l'ancêtre
                // porteur du handler (applis GWT/GXT en <div>), chercher DANS
                // les iframes, retomber sur aria-label/placeholder/title. Elle
                // était morte depuis la couche outil, qui n'envoie que des
                // by_* (audit 2026-08-08). On l'utilise maintenant comme
                // second souffle quand — et seulement quand — l'appelant a
                // joint un `selector` de repli.
                //
                // `notASelect` est une erreur de DIAGNOSTIC (« ce n'est pas un
                // <select>, utilise pick ») : la répéter via l'autre chemin ne
                // ferait que la rendre plus confuse.
                if (rawSelector && !(e as { notASelect?: boolean }).notASelect) {
                    console.log(`[action] official KO (${(e as Error).message.slice(0, 80)}) → repli smartResolve sur ${rawSelector}`);
                    officialLocator = null;
                    officialError = (e as Error).message;
                } else {
                    const ss = await screenshotOnFailure(page, req.sessionId, type).catch(() => null);
                    return res.status(500).json({ error: (e as Error).message, screenshot: ss, ...detailsErreur(e) });
                }
            }
        }

        // ── Sinon, fallback sur le code existant (selector= chaîne) ──
        const selector = rawSelector;
        // Quand on arrive ici APRÈS l'échec d'un locator officiel, on le dit :
        // sans ça, un succès par repli est indiscernable d'un succès direct et
        // personne ne voit que la cible demandée était mauvaise.
        const _fb: { fallback_after?: string; attempts?: Tentative[] } = officialError
            ? { fallback_after: officialError.slice(0, 200),
                attempts: [{ via: 'official', ok: false, error: officialError.slice(0, 120) }] }
            : {};
        // Chaque réponse de repli complète la liste des tentatives : la dernière
        // est celle qui a atterri (via = stratégie smartResolve).
        const _landed = (via: string, element: ElementClique | null = null) => ({
            ..._fb,
            attempts: [...(_fb.attempts || []), { via: `smart:${via || 'selector'}`, ok: true, ms: Date.now() - _t0 }],
            resolved_selector: describeLocator({ selector }, { first: true }),
            ...(element ? { resolved_element: element } : {}),
        });
        // Budget du repli : l'essai officiel a déjà consommé jusqu'à
        // OFFICIAL_TRY_MS. Sans plafond ici, une cible RÉELLEMENT absente
        // dépassait le budget du client, qui rendait « Timeout (10s) » à la
        // place de l'erreur serveur — laquelle liste les éléments proches.
        const _lt = officialError ? Math.min(timeout, 5000) : timeout;

        // AMENER À L'ÉCRAN (cible + pas de direction)
        if (type === 'scroll_into_view') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            await scrollIntoViewIfNeeded(locator);
            await postActionWait(page, wait_after);
            return res.json({ status: 'success', strategy: 'scroll_into_view', ..._landed('scroll_into_view') });
        }

        // CLIC SMART (via smartClick)
        if (type === 'click') {
            const { locator: cliqueSur, cadre, element, ...result } = await smartClick(page, selector!, { timeout: _lt, button, modifiers, human, params: cibleParams, position: point });
            const ancestors = cliqueSur ? await captureAncestors(cliqueSur).catch(() => []) : [];
            await postActionWait(page, wait_after);
            const cadres = req.session!._recorder?.recording && cadre ? await cheminCadres(cadre) : [];
            await recordEvent(req.session, { action: 'click', selector, url: page.url(), ...(cadres.length ? { frames: cadres } : {}) }, cliqueSur);
            return res.json({
                status: 'success', ...result,
                url: page.url(), ancestors, ..._landed(result.strategy, element),
            });
        }

        // CLIC RELATIF
        if (type === 'click_relative') {
            const layoutSelector = `${selector}:${position}(${relative_to})`;
            const { locator: _l, cadre: _c, ...result } = await smartClick(page, layoutSelector, { timeout: _lt, button, modifiers, human });
            await postActionWait(page, wait_after);
            return res.json({ status: 'success', ...result });
        }

        // CLIC COORDONNÉES
        if (type === 'click_coords') {
            const { x, y } = req.body;
            if (human) await humanClick(page, x!, y!);
            else await page.mouse.click(x!, y!, { button });
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // DOUBLE-CLIC
        if (type === 'dblclick') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            await scrollIntoViewIfNeeded(locator);
            await locator.dblclick({ timeout: _lt, force, ...auPoint });
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // CLIC DROIT
        if (type === 'right_click') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            await scrollIntoViewIfNeeded(locator);
            await locator.click({ timeout: _lt, button: 'right', force, ...auPoint });
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // HOVER
        if (type === 'hover') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            if (human) {
                const box = await locator.boundingBox().catch(() => null);
                if (box) { await humanMouseMove(page, 960, 540, box.x + box.width / 2, box.y + box.height / 2); }
                else await locator.hover({ timeout: _lt, force });
            } else {
                await scrollIntoViewIfNeeded(locator);
                await locator.hover({ timeout: _lt, force, ...auPoint });
            }
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // FILL — gère input natif, contentEditable, React/Vue/Angular
        if (type === 'fill') {
            const resolved = await resoudreRepli(page, selector!, { params: cibleParams });
            let loc = resolved.locator;
            let fillMethod = '';

            // ── Smart label→input resolution ──
            // If the resolved element is a label/span/div (not an input),
            // try to find the associated form input
            const inputResolved = await resolveFormInput(page, loc, selector!);
            if (inputResolved) {
                loc = inputResolved.locator;
                fillMethod = `via-${inputResolved.method}→`;
            }

            const errors: string[] = [];

            // Tentative 1 : vérifier si contentEditable
            let isCE = false;
            try {
                const info = await loc.evaluate((el: HTMLElement) => ({
                    tag: el.tagName.toLowerCase(),
                    isCE: el.contentEditable === 'true' || el.isContentEditable,
                    isInput: ['input', 'textarea'].includes(el.tagName.toLowerCase()),
                }));
                isCE = info.isCE;

                if (isCE) {
                    await loc.click({ timeout: 3000 }).catch(() => {});
                    await loc.evaluate((el, val: string) => {
                        el.focus();
                        el.innerHTML = '';
                        el.textContent = val;
                        ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
                    }, text!);
                } else {
                    // Tentative fill Playwright
                    await scrollIntoViewIfNeeded(loc);
                    await loc.fill('', { timeout: 3000 }).catch(() => {});
                    await loc.fill(text!, { timeout: _lt, force: true });
                    await loc.evaluate(el => {
                        ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
                    }).catch(() => {});
                }
                await postActionWait(page, wait_after);
                await recordEvent(req.session, { action: 'fill', selector, value: text, url: page.url() }, loc);
                return res.json({ status: 'success', method: `${fillMethod}${isCE ? 'contenteditable' : 'fill'}` });
            } catch (e) { errors.push(`fill: ${(e as Error).message.substring(0, 80)}`); }

            // Tentative 2 : Sélectionner tout + type
            try {
                await loc.click({ clickCount: 3, timeout: 3000 }).catch(() => {});
                await page.keyboard.press('Control+a');
                await page.keyboard.press('Backspace');
                await loc.type(text!, { delay: delay || 30 });
                await postActionWait(page, wait_after);
                await recordEvent(req.session, { action: 'fill', selector, value: text, url: page.url() }, loc);
                return res.json({ status: 'success', method: `${fillMethod}ctrl-a-type` });
            } catch (e) { errors.push(`ctrl+a: ${(e as Error).message.substring(0, 80)}`); }

            // Tentative 3 : JS value + React/Vue native setter, sur un vrai champ seulement
            try {
                await loc.evaluate((el: ChampReact, val: string) => {
                    if (!['INPUT', 'TEXTAREA'].includes(el.tagName)) throw new Error(`<${el.tagName.toLowerCase()}> is not a text field`);
                    // React native setter (works with React 16+, 17, 18)
                    const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
                    if (nativeInput?.set) nativeInput.set.call(el, val);
                    else el.value = val;
                    // Dispatch comprehensive events for React/Vue/Angular
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                    // React synthetic events
                    const tracker = el._valueTracker;
                    if (tracker) tracker.setValue('');
                }, text!);
                await postActionWait(page, wait_after);
                await recordEvent(req.session, { action: 'fill', selector, value: text, url: page.url() }, loc);
                return res.json({ status: 'success', method: `${fillMethod}js-value` });
            } catch (e) { errors.push(`js-value: ${(e as Error).message.substring(0, 80)}`); }

            // Feature 3+4: Smart retry + screenshot on failure
            const alternatives = await findAlternatives(page, selector!, 3).catch(() => []);
            const ss = await screenshotOnFailure(page, req.sessionId, 'fill');
            res.status(500).json({ error: `fill failed: ${errors.join(' | ')}`, alternatives, ...ss });
            return;
        }

        // TYPE (frappe humaine)
        if (type === 'type') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            await locator.click({ timeout: 3000 }).catch(() => {});
            if (human) {
                for (const char of text!) {
                    await page.keyboard.type(char);
                    const d = char === ' ' ? (80 + Math.random() * 120) : (30 + Math.random() * 80);
                    await page.waitForTimeout(d);
                }
            } else {
                await locator.type(text!, { delay: delay || 50 });
            }
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // CLAVIER
        if (type === 'press') {
            if (selector) {
                const { locator } = await resoudreRepli(page, selector, { params: cibleParams });
                await locator.press(key!, { timeout: _lt });
            } else {
                await page.keyboard.press(key!);
            }
            await postActionWait(page, wait_after);
            void recordEvent(req.session, { action: 'press', selector, key, url: page.url() });
            return res.json({ status: 'success' });
        }

        // SELECT (natif)
        if (type === 'select') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            // Même résolution sans essai-erreur que la branche officielle : on
            // lit les <option> puis on choisit. L'ancien code enchaînait deux
            // selectOption avec le timeout PLEIN chacun (10 s + 10 s).
            const picked = await selectOptionSmart(locator, {
                option_value, option_label, value, text, timeout: _lt });
            await postActionWait(page, wait_after);
            void recordEvent(req.session, { action: 'select', selector, value: picked.value, option_label: picked.label, selected: picked, url: page.url() });
            return res.json({ status: 'success', selected: picked, ..._landed('select') });
        }

        // CHECK/UNCHECK
        if (type === 'check') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            try { await locator.check({ timeout: _lt, force }); }
            catch (e) { await cocherParScript(locator, true, e); }
            void recordEvent(req.session, { action: 'check', selector, url: page.url() });
            return res.json({ status: 'success' });
        }
        if (type === 'uncheck') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            try { await locator.uncheck({ timeout: _lt, force }); }
            catch (e) { await cocherParScript(locator, false, e); }
            void recordEvent(req.session, { action: 'uncheck', selector, url: page.url() });
            return res.json({ status: 'success' });
        }

        // DÉPLIER / REPLIER (arbre, accordéon)
        if (type === 'expand' || type === 'collapse') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            const r = await expandTreeItem(page, locator, type === 'expand', _lt);
            await postActionWait(page, wait_after);
            return res.json({ status: 'success', ...r, ..._landed(type) });
        }

        // DRAG & DROP (même moteur que le chemin officiel : dragTo → HTML5 → décalage)
        if (type === 'drag') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            const r = await performDrag(ctx, page, locator, req.body, _lt);
            await postActionWait(page, wait_after);
            return res.json({ status: 'success', ...r, ..._landed('drag') });
        }

        // UPLOAD
        if (type === 'upload') {
            const { locator } = await resoudreRepli(page, selector!, { params: cibleParams });
            await locator.setInputFiles(uploadFiles!, { timeout: _lt });
            await recordEvent(req.session, { action: 'upload', selector, files: uploadFiles!.map(f => f.name), url: page.url() }, locator);
            return res.json({ status: 'success', uploaded: uploadFiles!.map(f => ({ name: f.name, size: f.buffer.length })),
                              ..._landed('upload') });
        }

        // SCROLL
        if (type === 'scroll') {
            const { direction = 'down', amount = 500 } = req.body;
            if (selector) {
                const { locator } = await resoudreRepli(page, selector, { params: cibleParams });
                await locator.evaluate((el, { direction, amount }) => {
                    const map: Record<string, [number, number]> = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
                    const [x, y] = map[direction] || [0, amount];
                    el.scrollBy(x, y);
                }, { direction, amount });
            } else {
                if (human) {
                    const steps = 5 + Math.floor(Math.random() * 5);
                    const perStep = amount / steps;
                    const dir = direction === 'up' ? -1 : 1;
                    for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, perStep * dir); await page.waitForTimeout(30 + Math.random() * 50); }
                } else {
                    const map: Record<string, [number, number]> = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
                    const [x, y] = map[direction] || [0, amount];
                    await page.mouse.wheel(x, y);
                }
            }
            return res.json({ status: 'success' });
        }

        // WAIT
        if (type === 'wait') {
            const { wait_for, wait_timeout = 15000 } = req.body;
            if (wait_for === 'network') await page.waitForLoadState('networkidle', { timeout: wait_timeout });
            else if (wait_for === 'navigation') await page.waitForNavigation({ timeout: wait_timeout, waitUntil: 'domcontentloaded' });
            else if (selector) await page.waitForSelector(selector, { state: 'visible', timeout: wait_timeout });
            else await page.waitForTimeout(wait_timeout);
            return res.json({ status: 'success' });
        }

        // REMOVE OVERLAYS
        if (type === 'remove_overlays') { await safeRemoveOverlays(page); return res.json({ status: 'success' }); }

        return res.status(400).json({ error: `Type d'action inconnu: "${type}"` });
    } catch (e) {
        const code = detailsErreur(e).code || codeErreur((e as Error).message);
        const proches = ['timeout', 'element_not_visible', 'element_disabled', 'click_failed'].includes(code) && req.body.selector
            ? await findAlternatives(req.session!.page, req.body.selector, 3).catch(() => []) : [];
        repondreErreur(res, e, proches.length ? { alternatives: proches } : {});
    }
});
}
