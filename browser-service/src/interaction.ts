// SPDX-License-Identifier: MIT
/** browser-service/src/interaction.ts — gestes sur un élément résolu : ancêtre interactif, surcouches retirées, champ de formulaire d'un libellé, ancêtres pour la mémoire AX, clic intelligent, souris humaine. */
import type { Frame, Locator, Page } from 'playwright';

import { decrireNoeud, erreurInterception, erreurIntrouvable, etatClic, resoudreRepli } from './localisateur.ts';
import { erreurCodee } from './requete.ts';
import { codeErreur } from './result_util.ts';
import type { ParamsCible } from './result_util.ts';

/** Champ de formulaire visé par resolveFormInput. */
type ChampFormulaire = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Champ trouvé dans la page pour un libellé ou un texte voisin : méthode, et sélecteur pour le relocaliser. */
interface ChampResolu {
    method: string;
    id?: string;
    selector?: string | null;
    index?: boolean;
}

/** Champ de formulaire réel d'un libellé, et la méthode qui l'a trouvé. */
export interface ChampFormulaireResolu {
    locator: Locator;
    method: string;
}

/** Ancêtre sémantique d'un élément pour la mémoire AX (le plus proche d'abord). */
export interface AncetreAx {
    tag: string;
    role: string;
    name: string;
    expandable: boolean;
}

type OptionsClicPw = NonNullable<Parameters<Locator['click']>[0]>;

/** Options de smartClick. */
export interface OptionsSmartClick {
    timeout?: number;
    button?: OptionsClicPw['button'];
    modifiers?: OptionsClicPw['modifiers'];
    human?: boolean;
    /** Point de clic dans l'élément, en pixels depuis son coin haut gauche. */
    position?: { x: number; y: number } | null;
    params?: ParamsCible | null;
}

/** Élément cliqué : point de clic vérifié (`pointDeClic`) ou nœud décrit (`decrireNoeud`). */
export interface ElementClique {
    css: string;
    role?: string;
    name?: string;
    text?: string;
    disabled?: true;
}

/** Clic réussi de smartClick ; `locator` et `cadre` absents d'un clic par coordonnées. */
export interface ClicReussi {
    success: true;
    strategy: string;
    resolved: string;
    element?: ElementClique;
    locator?: Locator | null;
    cadre?: Page | Frame | null;
}

/** Point d'une trajectoire de souris. */
interface Point {
    x: number;
    y: number;
}

// Premier élément visible d'une liste (les `max` premiers examinés), null sinon.
export async function premierVisible(loc: Locator, max = 10): Promise<Locator | null> {
    const n = Math.min(await loc.count().catch(() => 0), max);
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible({ timeout: 150 }).catch(() => false)) return loc.nth(i);
    return null;
}

// Élément visible le plus intérieur d'une liste (aucun autre élément de la liste en dessous) : le bouton, pas la page qui le contient.
export async function plusInterieurVisible(loc: Locator): Promise<Locator | null> {
    const k = await loc.evaluateAll((els) => {
        const liste = els.slice(0, 400);
        for (let i = 0; i < liste.length; i++) {
            const e = liste[i]!;
            if (liste.some((o) => o !== e && e.contains(o))) continue;
            const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
            if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') return i;
        }
        return -1;
    }).catch(() => -1);
    return k >= 0 ? loc.nth(k) : null;
}

// Remonte d'un nœud de texte vers l'ancêtre RÉELLEMENT interactif.
//
// Motif canonique des applis à base de <div> (GWT, GXT, SmartGWT, ExtJS) :
//     <div class="x-btn"><table><tr><td class="x-btn-text"><span>Valider</span>
// getByText() rend le <span>. Cliquer dessus marche par bouillonnement, mais
// fill/check/hover/état visent le mauvais nœud, et l'ancêtre porte souvent le
// vrai `cursor:pointer`, le `disabled`, le rôle.
//
// Historique : cette fonction a longtemps été un stub `return null`, alors que
// ses deux appelants testaient son résultat et annonçaient une stratégie
// `text+climb` qui ne pouvait jamais se produire (audit 2026-08-08).
//
// Règle : on ne remonte QUE si l'ancêtre reste « serré » autour du texte
// (aire ≤ 6× celle du nœud de départ) — sinon on finit sur <body> et on clique
// n'importe où. Retourne null quand rien de mieux n'est trouvé.
export async function climbToInteractive(_locator: Locator): Promise<Locator | null> {
    try {
        const handle = await _locator.elementHandle({ timeout: 500 }).catch(() => null);
        if (!handle) return null;
        // On renvoie un CHEMIN, pas un handle : marquer le nœud (setAttribute)
        // déclencherait les MutationObserver de la page — précisément ce que
        // font les frameworks qu'on essaie d'aider.
        const xpath = await handle.evaluate((el) => {
            const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'summary']);
            const INTERACTIVE_ROLES = new Set([
                'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option',
                'combobox', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell',
            ]);
            function looksInteractive(node: HTMLElement | SVGElement | null): boolean {
                if (!node || node.nodeType !== 1) return false;
                const tag = node.tagName.toLowerCase();
                if (INTERACTIVE_TAGS.has(tag)) return true;
                const role = (node.getAttribute('role') || '').toLowerCase();
                if (INTERACTIVE_ROLES.has(role)) return true;
                if (node.hasAttribute('onclick')) return true;
                if (typeof node.onclick === 'function') return true;
                const ti = node.getAttribute('tabindex');
                if (ti !== null && ti !== '-1') return true;
                try {
                    if (window.getComputedStyle(node).cursor === 'pointer') return true;
                } catch { /* style unreadable: not interactive by its cursor */ }
                return false;
            }
            function absXPath(node: Element | null): string {
                const parts: string[] = [];
                while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
                    let i = 1, sib = node.previousElementSibling;
                    while (sib) { if (sib.tagName === node.tagName) i++; sib = sib.previousElementSibling; }
                    parts.unshift(node.tagName.toLowerCase() + '[' + i + ']');
                    node = node.parentElement;
                }
                return '/html/' + parts.join('/');
            }
            const startRect = el.getBoundingClientRect();
            const startArea = Math.max(1, startRect.width * startRect.height);
            // Le nœud de départ est déjà le bon : ne rien faire.
            if (looksInteractive(el)) return null;
            let node = el.parentElement;
            let hops = 0;
            while (node && hops < 6 && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
                const r = node.getBoundingClientRect();
                if (r.width * r.height > startArea * 6) break;   // trop large : on s'arrête
                if (looksInteractive(node)) return absXPath(node);
                node = node.parentElement;
                hops++;
            }
            return null;
        }).catch(() => null);
        try { await handle.dispose(); } catch { /* handle already gone */ }
        if (!xpath) return null;
        // Les deux appelants construisent leur locator sur la page principale
        // (getByText / xpath) — on relocalise donc dans le même contexte.
        const loc = _locator.page().locator(`xpath=${xpath}`).first();
        if (await loc.count().catch(() => 0) === 0) return null;
        return loc;
    } catch {
        return null;
    }
}

export async function scrollIntoViewIfNeeded(locator: Locator): Promise<void> {
    try { await locator.scrollIntoViewIfNeeded({ timeout: 3000 }); }
    catch {
        try { await locator.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })); } catch { /* detached: left as is */ }
    }
}

export async function safeRemoveOverlays(page: Page, aggressive = false): Promise<void> {
    try {
        await page.evaluate((agg) => {
            // ── Phase 1: Known cookie/GDPR banners (always safe) ──
            const cookieSelectors = [
                '#onetrust-banner-sdk', '#onetrust-consent-sdk', '.cookie-banner', '.cookie-consent',
                '#cookie-law-info-bar', '.fc-consent-root', '#CybotCookiebotDialog', '.cc-window',
                '#gdpr-consent-tool-wrapper', '.cc-banner', '#cookie-notice', '.cookie-notice',
                '#cookiebanner', '.cookie-wall', '#cookies-eu-banner', '.js-cookie-consent',
                '#tarteaucitron', '.tarteaucitronAlertBig', '#axeptio_overlay', '.didomi-popup',
                '#usercentrics-root', '.cky-consent-container', '.qc-cmp-ui-container',
            ];
            cookieSelectors.forEach(sel => document.querySelectorAll(sel).forEach(el => {
                try { el.remove(); } catch { /* already detached */ }
            }));

            // ── Phase 2: Chat widgets & newsletter popups ──
            const widgetSelectors = [
                '#hubspot-messages-iframe-container', '#intercom-container', '#drift-widget',
                '.crisp-client', '#tidio-chat', '#zsiq_float', '.zopim', '#launcher',
                '[class*="newsletter-popup"]', '[class*="popup-modal"]', '[class*="exit-intent"]',
                '[class*="subscribe-popup"]', '[id*="newsletter"]',
                // Toast notifications
                '.toast', '.Toastify', '[class*="snackbar"]', '[class*="notification-bar"]',
                '.notistack-SnackbarContainer', '.notyf',
            ];
            widgetSelectors.forEach(sel => document.querySelectorAll(sel).forEach(el => {
                try { el.remove(); } catch { /* already detached */ }
            }));

            // ── Phase 3: Generic modal backdrops (only the backdrop, not the modal itself) ──
            document.querySelectorAll('.modal-backdrop, .overlay-backdrop, [class*="backdrop"]').forEach(el => {
                try { el.remove(); } catch { /* already detached */ }
            });

            // ── Phase 4: Unlock body scroll ──
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.width = '';
            document.body.classList.remove('modal-open', 'no-scroll', 'overflow-hidden');
            document.documentElement.style.overflow = '';

            // ── Phase 5: High z-index fixed overlays (only if aggressive or clearly blocking) ──
            document.querySelectorAll('*').forEach(el => {
                const style = window.getComputedStyle(el);
                const z = parseInt(style.zIndex) || 0;
                const pos = style.position;
                if (z > 9000 && (pos === 'fixed' || pos === 'absolute')) {
                    const rect = el.getBoundingClientRect();
                    const tag = el.tagName.toLowerCase();
                    // Never remove navigation, headers, or sidebars
                    if (['nav', 'header', 'aside', 'footer'].includes(tag)) return;
                    const role = el.getAttribute('role');
                    // In non-aggressive mode, don't remove dialogs (they might be intentional)
                    if (!agg && (role === 'dialog' || role === 'alertdialog')) return;
                    // Only remove if it covers a significant portion of the viewport
                    if (rect.width > window.innerWidth * 0.3 && rect.height > window.innerHeight * 0.15) {
                        try { el.remove(); } catch { /* already detached */ }
                    }
                }
            });

            // ── Phase 6: position:sticky elements that may cover content ──
            document.querySelectorAll('*').forEach(el => {
                const style = window.getComputedStyle(el);
                if (style.position === 'sticky' || style.position === 'fixed') {
                    const z = parseInt(style.zIndex) || 0;
                    if (z > 100 && el.tagName.toLowerCase() !== 'nav' && el.tagName.toLowerCase() !== 'header') {
                        const rect = el.getBoundingClientRect();
                        // Small sticky bars (cookie bars, notification bars)
                        if (rect.height < 100 && rect.width > window.innerWidth * 0.5) {
                            try { el.remove(); } catch { /* already detached */ }
                        }
                    }
                }
            });
        }, aggressive);
    } catch { /* page closed or navigating: nothing removed */ }
}

// ==========================================
// SMART LABEL → INPUT RESOLUTION
// ==========================================
// When a selector matches a <label> or text near a form field,
// find the actual input element to fill.
export async function resolveFormInput(page: Page, locator: Locator, originalSelector: string): Promise<ChampFormulaireResolu | null> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- le sélecteur est passé à la page, inutilisé ici
        const resolved = await locator.evaluate((el, sel): ChampResolu | null => {
            const tag = el.tagName.toLowerCase();

            // Already an input? Return as-is
            if (['input', 'textarea', 'select'].includes(tag)) return null;

            // It's a <label> — find associated input
            if (tag === 'label') {
                // Method 1: <label for="xxx">
                const forAttr = el.getAttribute('for');
                if (forAttr) {
                    const target = document.getElementById(forAttr);
                    if (target) return { method: 'label-for', id: forAttr };
                }
                // Method 2: <label><input> nested inside
                const nested = el.querySelector<ChampFormulaire>('input, textarea, select');
                if (nested) {
                    const nid = nested.id || nested.name || nested.getAttribute('data-testid');
                    return { method: 'label-nested', selector: nid ? `#${nid}` : null, index: true };
                }
            }

            // It's text near a form field — find the closest input
            // Strategy: look for inputs in the same form-row, parent container, or nearby
            const searchContainers: HTMLElement[] = [];
            let parent = el.parentElement;
            for (let i = 0; i < 5 && parent; i++) {
                searchContainers.push(parent);
                parent = parent.parentElement;
            }

            for (const container of searchContainers) {
                const inputs = container.querySelectorAll<ChampFormulaire>('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
                if (inputs.length === 1) {
                    // Only one input in the container — it's probably the target
                    const inp = inputs[0]!;
                    const id = inp.id || inp.name || inp.getAttribute('data-testid');
                    return { method: 'nearby-single', selector: id ? (inp.id ? `#${id}` : `[name="${id}"]`) : null, index: true };
                }
                if (inputs.length > 1) {
                    // Multiple inputs — find the one closest to our text
                    const elRect = el.getBoundingClientRect();
                    let closest: ChampFormulaire | null = null, minDist = Infinity;
                    for (const inp of inputs) {
                        const inpRect = inp.getBoundingClientRect();
                        const dx = inpRect.left - elRect.right;
                        const dy = Math.abs(inpRect.top - elRect.top);
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist < minDist) { minDist = dist; closest = inp; }
                    }
                    if (closest && minDist < 500) {
                        const id = closest.id || closest.name || closest.getAttribute('data-testid');
                        return { method: 'nearby-closest', selector: id ? (closest.id ? `#${id}` : `[name="${id}"]`) : null, index: true };
                    }
                }
            }

            // Also try: aria-labelledby reverse lookup
            const elText = el.textContent.trim().toLowerCase();
            const allInputs = document.querySelectorAll<ChampFormulaire>('input, textarea, select');
            for (const inp of allInputs) {
                const ariaLabel = (inp.getAttribute('aria-label') || '').toLowerCase();
                const placeholder = (inp.getAttribute('placeholder') || '').toLowerCase();
                const name = (inp.getAttribute('name') || '').toLowerCase();
                if (ariaLabel.includes(elText) || placeholder.includes(elText) || name.includes(elText)) {
                    const id = inp.id || inp.name;
                    return { method: 'aria-match', selector: id ? (inp.id ? `#${id}` : `[name="${id}"]`) : null, index: true };
                }
            }

            return null;
        }, originalSelector);

        if (resolved) {
            // Re-resolve to get the actual input locator
            if (resolved.selector) {
                const inputLoc = page.locator(resolved.selector).first();
                if (await inputLoc.count().catch(() => 0) > 0) {
                    return { locator: inputLoc, method: resolved.method };
                }
            }
            if (resolved.index) {
                // Fallback: find nearest input via label's container
                const containerInput = locator.locator('..').locator('input, textarea, select').first();
                if (await containerInput.count().catch(() => 0) > 0) {
                    return { locator: containerInput, method: 'container-child' };
                }
            }
        }
    } catch { /* element gone: keep the original locator */ }
    return null; // Return null = use original locator
}

// ==========================================
// SMART CLICK — 7 STRATÉGIES CASCADÉES
// ==========================================
// ── AX Memory : capture DOM ancestors for hierarchy tracking ─────────
// Called after a successful action to extract the semantic ancestor chain
// (max 3 levels) of the acted-on element. Used by backend/ax_memory.py
// to build a deep DOM hierarchy per page across runs.
//
// Returned format: [
//   { tag: 'menu', role: 'menu', name: 'Admin', expandable: true },
//   { tag: 'nav',  role: 'navigation', name: 'Main', expandable: false },
//   { tag: 'header', role: 'banner', name: '', expandable: false },
// ]
// Order: closest ancestor first. Empty array if nothing semantic found.
// Safe : catches all errors, returns [] on failure. Never throws.
export async function captureAncestors(locator: Locator | null | undefined): Promise<AncetreAx[]> {
    if (!locator) return [];
    try {
        const handle = await locator.elementHandle({ timeout: 500 }).catch(() => null);
        if (!handle) return [];
        const ancestors = await handle.evaluate((el) => {
            const SEMANTIC_TAGS = new Set([
                'header', 'nav', 'main', 'aside', 'footer', 'form',
                'section', 'article', 'dialog',
            ]);
            const SEMANTIC_ROLES = new Set([
                'banner', 'navigation', 'main', 'complementary', 'contentinfo',
                'form', 'search', 'dialog', 'menu', 'menubar', 'menuitem',
                'toolbar', 'tablist', 'tab', 'tabpanel', 'region',
            ]);
            const out: AncetreAx[] = [];
            let cur = el.parentElement;
            let depth = 0;
            const MAX_DEPTH = 3;
            while (cur && depth < MAX_DEPTH) {
                const tag = (cur.tagName || '').toLowerCase();
                const role = (cur.getAttribute('role') || '').toLowerCase();
                const ariaLabel = cur.getAttribute('aria-label') || '';
                const ariaHaspopup = cur.getAttribute('aria-haspopup');
                const ariaExpanded = cur.getAttribute('aria-expanded');
                // An ancestor qualifies as "semantic" if:
                //   - it's a landmark tag (header/nav/main...)
                //   - OR it has an explicit role
                //   - OR it's expandable (menu/dropdown)
                //   - OR it has a meaningful aria-label
                const isSemanticTag = SEMANTIC_TAGS.has(tag);
                const isSemanticRole = role && SEMANTIC_ROLES.has(role);
                const isExpandable = ariaHaspopup !== null
                    || ariaExpanded !== null;
                const hasAriaLabel = ariaLabel && ariaLabel.length > 0;
                if (isSemanticTag || isSemanticRole || isExpandable || hasAriaLabel) {
                    // Extract accessible name : aria-label > heading > text
                    let name = ariaLabel;
                    if (!name) {
                        const heading = cur.querySelector('h1,h2,h3,h4,h5,h6,legend');
                        if (heading) name = (heading.textContent || '').trim().slice(0, 80);
                    }
                    if (!name) {
                        // Fallback : first meaningful text child
                        const txt = (cur.textContent || '').trim();
                        if (txt.length > 0 && txt.length < 80) name = txt;
                    }
                    // Determine effective role (landmark tags map to aria roles)
                    let effRole = role;
                    if (!effRole) {
                        const TAG_TO_ROLE: Record<string, string> = {
                            'header': 'banner', 'nav': 'navigation',
                            'main': 'main', 'aside': 'complementary',
                            'footer': 'contentinfo', 'form': 'form',
                            'section': 'region', 'article': 'article',
                            'dialog': 'dialog',
                        };
                        effRole = TAG_TO_ROLE[tag] || tag;
                    }
                    out.push({
                        tag: tag,
                        role: effRole,
                        name: (name || '').slice(0, 80),
                        expandable: isExpandable,
                    });
                    depth += 1;
                }
                cur = cur.parentElement;
            }
            return out;
        });
        return Array.isArray(ancestors) ? ancestors : [];
    } catch {
        return [];
    }
}

// Clic par l'échelle de repli : succès seulement sur un élément réel, visible, et que le clic atteint (point vérifié avant tout clic forcé ou par coordonnées) ; sinon element_not_found, click_intercepted ou l'erreur du premier essai.
export async function smartClick(page: Page, selector: string, opts: OptionsSmartClick = {}): Promise<ClicReussi> {
    const { timeout = 8000, button = 'left', modifiers = [], human = false, position = null, params = null } = opts;
    const FAST = 2000;
    const resolved = await resoudreRepli(page, selector, { params, coords: true });
    const fin = (strategy: string): ClicReussi => ({ success: true, strategy, resolved: resolved.strategy, locator: resolved.locator || null,
                                 cadre: resolved.frame || null, ...(decrit ? { element: decrit } : {}) });

    // Shadow DOM / parcours du texte : clic par coordonnées, point vérifié dans la page
    if (resolved.coords) {
        if (!resolved.hit) throw erreurInterception(resolved.element, resolved.cover);
        if (resolved.element && resolved.element.disabled)
            throw erreurCodee('element_disabled', `<${resolved.element.css}> is disabled: nothing was clicked.`);
        if (human) await humanClick(page, resolved.coords.x, resolved.coords.y);
        else await page.mouse.click(resolved.coords.x, resolved.coords.y, { button });
        return { success: true, strategy: resolved.strategy, resolved: resolved.strategy, element: resolved.element };
    }

    const loc: Locator = resolved.locator!;
    const errors: string[] = [];
    let premiere: Error;
    const vu = await loc.evaluate(decrireNoeud, {}, { timeout: 1000 }).catch(() => null);
    const decrit = vu ? { css: vu.tag, ...(vu.role ? { role: vu.role } : {}), ...(vu.name ? { name: vu.name } : {}) } : null;

    // Stratégie 1 : clic Playwright (attend que l'élément soit actionnable et non couvert)
    try {
        await scrollIntoViewIfNeeded(loc);
        if (human) {
            const etat = await etatClic(loc, position);
            if (etat && etat.visible && etat.hit) {
                await humanClick(page, etat.x, etat.y);
                return fin('1-human');
            }
        }
        await loc.click({ timeout, button, modifiers, ...(position ? { position } : {}) });
        return fin('1-playwright');
    } catch (e) { premiere = e as Error; errors.push(`S1: ${(e as Error).message.substring(0, 80)}`); }

    // Stratégie 2 : bandeaux connus retirés, pointer-events rétablis, puis point vérifié
    await safeRemoveOverlays(page);
    await loc.evaluate(el => {
        let node: HTMLElement | SVGElement | null = el;
        for (let i = 0; i < 10 && node; i++) {
            if (window.getComputedStyle(node).pointerEvents === 'none') node.style.pointerEvents = 'auto';
            node = node.parentElement;
        }
    }).catch(() => {});
    await page.waitForTimeout(100);
    const etat = await etatClic(loc, position);
    if (!etat) throw await erreurIntrouvable(page, params, selector, ' (it left the page)');
    if (!etat.visible) throw Object.assign(premiere, { code: codeErreur(premiere.message) === 'timeout' ? 'timeout' : 'element_not_visible' });
    if (!etat.hit) throw erreurInterception(etat.element, etat.cover);
    if (etat.disabled) throw Object.assign(premiere, { code: 'element_disabled' });
    try {
        await loc.click({ timeout: FAST, button, modifiers, ...(position ? { position } : {}) });
        return fin('2-overlay+pointer-fix');
    } catch (e) { errors.push(`S2: ${(e as Error).message.substring(0, 80)}`); }

    // Stratégie 3 : clic forcé au point vérifié (l'élément y est le premier touché)
    try {
        await loc.click({ timeout: FAST, force: true, button, modifiers, ...(position ? { position } : {}) });
        return fin('3-force');
    } catch (e) { errors.push(`S3: ${(e as Error).message.substring(0, 80)}`); }

    // Stratégie 5 : clic JS sur l'élément visible lui-même
    try {
        await loc.evaluate((el: HTMLElement) => el.click());
        return fin('5-js-click');
    } catch (e) { errors.push(`S5: ${(e as Error).message.substring(0, 80)}`); }

    throw Object.assign(new Error(`smartClick failed on "${selector}" (resolved via ${resolved.strategy}):\n${errors.join('\n')}`), { code: 'click_failed' });
}

// ==========================================
// MOUVEMENT DE SOURIS HUMAIN (Courbes de Bézier)
// ==========================================
function bezierCurve(start: Point, end: Point, steps = 25): Point[] {
    const cp1x = start.x + (end.x - start.x) * 0.3 + (Math.random() - 0.5) * 80;
    const cp1y = start.y + (end.y - start.y) * 0.1 + (Math.random() - 0.5) * 80;
    const cp2x = start.x + (end.x - start.x) * 0.7 + (Math.random() - 0.5) * 40;
    const cp2y = start.y + (end.y - start.y) * 0.9 + (Math.random() - 0.5) * 40;
    const points: Point[] = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const it = 1 - t;
        points.push({
            x: it * it * it * start.x + 3 * it * it * t * cp1x + 3 * it * t * t * cp2x + t * t * t * end.x,
            y: it * it * it * start.y + 3 * it * it * t * cp1y + 3 * it * t * t * cp2y + t * t * t * end.y,
        });
    }
    return points;
}

export async function humanMouseMove(page: Page, fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    const points = bezierCurve({ x: fromX, y: fromY }, { x: toX, y: toY }, 20 + Math.floor(Math.random() * 15));
    for (const p of points) {
        await page.mouse.move(p.x, p.y);
        await page.waitForTimeout(3 + Math.floor(Math.random() * 8));
    }
}

export async function humanClick(page: Page, x: number, y: number): Promise<void> {
    const fromX = 960 + (Math.random() - 0.5) * 200;
    const fromY = 540 + (Math.random() - 0.5) * 200;
    await humanMouseMove(page, fromX, fromY, x, y);
    await page.waitForTimeout(50 + Math.floor(Math.random() * 120));
    await page.mouse.click(x, y);
}
