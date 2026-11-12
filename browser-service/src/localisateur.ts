// SPDX-License-Identifier: MIT
/** browser-service/src/localisateur.ts — résolution de cible : localisateurs officiels Playwright, refs distribuées par pw_find, replis (shadow DOM, cadres, texte), candidats et erreurs d'introuvable. */
import type { Frame, Locator, Page } from 'playwright';

import type { RefLocator, ServiceContext } from './contexte.ts';
import { climbToInteractive, plusInterieurVisible, premierVisible } from './interaction.ts';
import type { Boite, ElementDecrit, PointDeClic } from './page_util.ts';
import { pointDeClic, sourceDe } from './page_util.ts';
import { erreurCodee } from './requete.ts';
import type { ParamsCible, SuggestionCible } from './result_util.ts';
import { classerSuggestions, describeLocator, echapperCss, litteralXPath, noeudsAria } from './result_util.ts';

/** Portée d'un localisateur : la page ou l'un de ses cadres (même API Locator). */
export type Portee = Page | Frame;

/** Paramètres lus par resolveOfficialLocator : la cible, plus le nom accessible entier (`whole_name`) et un filtre CSS de descendant (`filter_has`). */
export interface ParamsLocalisateur extends ParamsCible {
    whole_name?: boolean;
    filter_has?: string;
}

/** Paramètres de cible d'un outil (ref ou by_*) tels que reçus : `nth` peut arriver vide (''). */
export type ParamsOutil = Omit<ParamsLocalisateur, 'nth'> & { nth?: number | string | null };

/** Liste retenue pour une cible by_* : `n` éléments, par nom entier (`exact`, `partial` = correspondances par sous-chaîne) ou par sous-chaîne. */
export interface ListeCible {
    liste: Locator;
    n: number;
    nameMatch: 'exact' | 'substring' | null;
    partial?: number;
    params: ParamsLocalisateur;
}

/** Cible d'un outil : l'élément `nth` ou toute la liste (`loc`) ; `refBase` quand elle est donnée par une ref. */
export interface CibleResolue extends ListeCible {
    nth: number | null;
    loc: Locator;
    refBase?: string;
}

/** Élément trouvé dans la page avec son point de clic vérifié. */
export type PointTrouve = PointDeClic & { found: true };

/** Élément trouvé par l'échelle de repli : son localisateur et la page ou le cadre qui le contient. */
export interface RepliLocator {
    locator: Locator;
    frame: Portee;
    strategy: string;
    coords?: undefined;
}

/** Élément atteignable seulement par sa position (shadow DOM, parcours du texte) : point de clic vérifié. */
export interface RepliPoint {
    locator: null;
    frame: Page;
    strategy: 'shadow-dom' | 'shadow-dom-text' | 'js-text-walk';
    coords: { x: number; y: number };
    hit: boolean;
    cover?: ElementDecrit | null;
    element: ElementDecrit;
}

/** Texte pris pour un sélecteur qui ne correspond à rien. */
export interface RepliAbsent {
    locator: null;
    frame: Page;
    strategy: 'not_found';
    coords?: undefined;
}

/** Résultat de smartResolveLocator. */
export type Repli = RepliLocator | RepliPoint | RepliAbsent;

/** Élément tel que decrireNoeud le décrit : rôle ARIA, nom accessible approché, états ; `in_viewport` et `xpath` sur demande. */
export interface NoeudDecrit {
    tag: string;
    role: string | null;
    name: string;
    text: string;
    checked?: boolean | 'mixed';
    value?: string;
    disabled?: true;
    expanded?: boolean;
    in_viewport?: boolean;
    xpath?: string;
}

/** Élément lu par decrireNoeud : les propriétés de contrôle de formulaire, absentes des autres éléments. */
type ElementLu = Element & Partial<Pick<HTMLInputElement, 'checked' | 'disabled' | 'indeterminate' | 'labels' | 'multiple' | 'size' | 'value'>>;

/** Rôle accepté par getByRole. */
type RoleAria = Parameters<Page['getByRole']>[0];

/** Candidat d'une cible ambiguë, avec une ref que pw_act peut réutiliser. */
export interface CandidatCible {
    index: number;
    ref: string;
    role: string | null;
    name: string;
    text?: string;
}

/** État de clic d'un localisateur : son point de clic vérifié quand il est visible. */
export type EtatClic = (PointDeClic & { visible: true }) | { visible: false };

/** Élément interactif visible proche d'un sélecteur en échec. */
export interface Alternative {
    selector: string;
    tag: string;
    text: string;
    aria_label: string;
    rect: Boite;
    center: { x: number; y: number };
}

/** Options de resoudreRepli : paramètres de cible pour l'erreur d'introuvable, position de clic acceptée, attente de grâce. */
interface OptionsRepli {
    params?: ParamsCible | null;
    coords?: boolean;
    graceMs?: number;
}

// ==========================================
// SHADOW DOM — SCAN RÉCURSIF PROFOND
// ==========================================
// Élément trouvé dans les racines shadow ouvertes par un sélecteur CSS (toute profondeur) : point de clic vérifié (`pointDeClic`), null sinon.
async function shadowDOMQuery(page: Page, selector: string): Promise<PointTrouve | null> {
    try {
        return await page.evaluate(({ sel, srcPoint }) => {
            const auPoint = new Function(`return (${srcPoint})`)() as typeof pointDeClic;
            function deepQuery(root: ParentNode): PointTrouve | null {
                try {
                    const el = root.querySelector(sel);
                    const p = el ? auPoint(el) : null;
                    if (p) return { found: true, ...p };
                } catch { /* invalid selector here: the shadow roots are still scanned */ }
                for (const child of root.querySelectorAll('*')) {
                    if (!child.shadowRoot) continue;
                    const result = deepQuery(child.shadowRoot);
                    if (result) return result;
                }
                return null;
            }
            return deepQuery(document);
        }, { sel: selector, srcPoint: sourceDe(pointDeClic) });
    } catch { return null; }
}

// Élément dont le texte RENDU (sans <script> ni <style>) contient `text`, page et racines shadow ouvertes : point de clic vérifié, null sinon.
export async function shadowDOMQueryByText(page: Page, text: string): Promise<PointTrouve | null> {
    try {
        return await page.evaluate(({ txt, srcPoint }) => {
            const auPoint = new Function(`return (${srcPoint})`)() as typeof pointDeClic;
            const voulu = txt.toLowerCase();
            const texteRendu = (el: Element) => {
                let t = '';
                const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
                    acceptNode: (n) => (n.parentElement && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentElement.tagName)
                        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
                });
                while (w.nextNode()) t += w.currentNode.textContent;
                return t.replace(/\s+/g, ' ').trim();
            };
            function deepTextQuery(root: ParentNode): PointTrouve | null {
                for (const el of root.querySelectorAll('button, a, [role="button"], [role="link"], span, div, li, td, th, label')) {
                    const elText = texteRendu(el);
                    if (elText.length < 200 && elText.toLowerCase().includes(voulu)) {
                        const p = auPoint(el);
                        if (p) return { found: true, ...p };
                    }
                }
                for (const el of root.querySelectorAll('*')) {
                    if (!el.shadowRoot) continue;
                    const result = deepTextQuery(el.shadowRoot);
                    if (result) return result;
                }
                return null;
            }
            return deepTextQuery(document);
        }, { txt: text, srcPoint: sourceDe(pointDeClic) });
    } catch { return null; }
}

// ==========================================
// LOCATOR RÉSILIENT v3 — 10 STRATÉGIES
// ==========================================
// Frames attachées de la page, une fois chacune (page.frames() les donne déjà toutes, enfants compris).
export function getAllFrames(page: Page, maxDepth = 5): Frame[] {
    const frames: Frame[] = [];
    const vues = new Set<Frame>();
    function collect(frameList: Frame[], depth: number) {
        if (depth > maxDepth) return;
        for (const f of frameList) {
            if (vues.has(f) || f.isDetached()) continue;
            vues.add(f);
            frames.push(f);
            try { collect(f.childFrames(), depth + 1); } catch { /* frame detached meanwhile */ }
        }
    }
    collect([page.mainFrame()], 0);
    return frames;
}

export function isLikelyText(selector: string): boolean {
    // More permissive: accept anything that looks like human-readable text.
    // Only exclude clear CSS/XPath patterns.
    if (!selector || selector.length < 2) return false;
    if (selector.startsWith('#') || selector.startsWith('.') || selector.startsWith('[')) return false;
    if (selector.startsWith('//') || selector.startsWith('(//')) return false;
    if (selector.startsWith('css=') || selector.startsWith('xpath=') || selector.startsWith('id=')) return false;
    if (selector.includes('>>') || selector.includes('::')) return false;
    // If it has alphabetic characters (any script) and no CSS combinators, it's likely text
    if (/[{}>+~]/.test(selector)) return false;
    return /[a-zA-ZÀ-ÿа-яА-Я\u4e00-\u9fff]/.test(selector);
}

async function tryLocatorInContext(scope: Portee, selector: string, visTimeout = 150): Promise<Locator | null> {
    try {
        const isXPath = selector.startsWith('//') || selector.startsWith('(//');
        const loc = isXPath ? scope.locator(`xpath=${selector}`) : scope.locator(selector);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
            const first = loc.first();
            const visible = await first.isVisible({ timeout: visTimeout }).catch(() => false);
            if (visible) return first;
        }
    } catch { /* invalid selector for this scope */ }
    return null;
}

// ═══════════════════════════════════════════════════════════════════
//  Official Playwright Locator API resolver
// ═══════════════════════════════════════════════════════════════════
// Convertit un set de paramètres EXPLICITES (by_role, by_text, etc.) en
// Locator Playwright officiel via getByRole/Text/Label/etc.
// → Aucune chaîne CSS à parser, aucune ambiguïté, fiabilité maximale.
function escapeRegex(s: unknown): string { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Élément décrit DANS la page : rôle ARIA (explicite, sinon implicite du HTML), nom accessible approché, états, sans la valeur d'une case.
export function decrireNoeud(el: ElementLu, { xpath = false }: { xpath?: boolean } = {}): NoeudDecrit {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const implicite = () => {
        if (tag === 'input') {
            if (type === 'hidden' || type === 'file' || type === 'color') return null;
            if (type === 'checkbox' || type === 'radio') return type;
            if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
            if (type === 'range') return 'slider';
            if (type === 'number') return 'spinbutton';
            if (type === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
            return el.hasAttribute('list') ? 'combobox' : 'textbox';
        }
        if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : null;
        if (tag === 'select') return el.multiple || el.size! > 1 ? 'listbox' : 'combobox';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'img';
        return ({
            button: 'button', summary: 'button', textarea: 'textbox', option: 'option', nav: 'navigation',
            main: 'main', ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row', td: 'cell',
            th: 'columnheader', dialog: 'dialog', progress: 'progressbar', form: 'form', fieldset: 'group',
            article: 'article', aside: 'complementary', header: 'banner', footer: 'contentinfo',
        } as Record<string, string>)[tag] || null;
    };
    const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0] || implicite();
    const net = (s: unknown) => String(s || '').replace(/\s+/g, ' ').trim();
    const champ = ['input', 'select', 'textarea'].includes(tag);
    const parId = (ids: string) => ids.split(/\s+/).map(id => (document.getElementById(id) || ({} as { textContent?: string })).textContent || '').join(' ');
    const nom = net(el.getAttribute('aria-label'))
        || net(parId(el.getAttribute('aria-labelledby') || ''))
        || net(el.labels ? Array.from(el.labels).map(l => l.textContent).join(' ') : '')
        || (champ ? '' : net(el.textContent))
        || (['button', 'submit', 'reset'].includes(type) ? net(el.value) : '')
        || net(el.getAttribute('alt')) || net(el.getAttribute('title')) || net(el.getAttribute('placeholder'));
    const out: NoeudDecrit = { tag, role, name: nom.substring(0, 80), text: champ ? '' : net(el.textContent).substring(0, 80) };
    const caseNative = tag === 'input' && (type === 'checkbox' || type === 'radio');
    if ((['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'] as (string | null)[]).includes(role)) {
        const aria = el.getAttribute('aria-checked');
        out.checked = caseNative ? (el.indeterminate ? 'mixed' : el.checked) : (aria === 'mixed' ? 'mixed' : aria === 'true');
    } else if (champ && !['button', 'submit', 'reset', 'image', 'hidden', 'file', 'password'].includes(type)) {
        out.value = String(el.value || '').substring(0, 80);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || (el.closest && el.closest('fieldset:disabled'))) out.disabled = true;
    const ouvert = el.getAttribute('aria-expanded');
    if (ouvert !== null) out.expanded = ouvert === 'true';
    if (xpath) {
        const chemin = (n: Element | null): string => {
            if (n!.id && /^[a-zA-Z][\w-]*$/.test(n!.id)) return `//*[@id="${n!.id}"]`;
            const parts: string[] = [];
            while (n && n.nodeType === 1 && n.tagName !== 'HTML') {
                let i = 1, sib = n.previousElementSibling;
                while (sib) { if (sib.tagName === n.tagName) i++; sib = sib.previousElementSibling; }
                parts.unshift(`${n.tagName.toLowerCase()}[${i}]`);
                n = n.parentElement;
            }
            return '/html/' + parts.join('/');
        };
        const r = el.getBoundingClientRect();
        out.in_viewport = r.top >= 0 && r.top <= window.innerHeight;
        out.xpath = chemin(el);
    }
    return out;
}

export function resolveOfficialLocator(page: Portee, params: ParamsLocalisateur): Locator | null {
    const {
        by_role, by_name, by_text, by_label, by_placeholder, by_test_id,
        by_alt, by_title, by_css, by_xpath,
        filter_has_text, filter_has,
        nth, exact = false,
    } = params;
    let loc: Locator;
    if (by_role) {
        const opts: { name?: string | RegExp; exact?: boolean } = {};
        // whole_name : nom entier (casse et espaces de bord ignorés) au lieu d'une sous-chaîne.
        const coupe = typeof by_name === 'string' && by_name.length > 1 && by_name.endsWith('…');
        const nom = coupe ? by_name.slice(0, -1) : by_name;
        if (by_name) opts.name = exact && !coupe ? by_name
            : new RegExp(params.whole_name && !coupe ? `^\\s*${escapeRegex(nom)}\\s*$` : coupe ? `^\\s*${escapeRegex(nom)}` : escapeRegex(nom), 'i');
        if (exact) opts.exact = true;
        loc = page.getByRole(by_role as RoleAria, opts);
    } else if (by_text) {
        loc = page.getByText(by_text, { exact });
    } else if (by_label) {
        loc = page.getByLabel(by_label, { exact });
    } else if (by_placeholder) {
        loc = page.getByPlaceholder(by_placeholder, { exact });
    } else if (by_alt) {
        loc = page.getByAltText(by_alt, { exact });
    } else if (by_title) {
        loc = page.getByTitle(by_title, { exact });
    } else if (by_test_id) {
        loc = page.getByTestId(by_test_id);
    } else if (by_css) {
        loc = page.locator(by_css);
    } else if (by_xpath) {
        loc = page.locator(`xpath=${by_xpath}`);
    } else {
        return null;
    }
    if (filter_has_text) loc = loc.filter({ hasText: filter_has_text });
    if (filter_has) loc = loc.filter({ has: page.locator(filter_has) });
    if (nth !== undefined && nth !== null && nth >= 0) loc = loc.nth(nth);
    return loc;
}

// Store des Locators par session : ref opaque → { sid, locator, expires_at }
// Permet à pw_find de renvoyer un ref que pw_act peut réutiliser sans
// reconstruire la stratégie.
export const REF_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function storeLocatorRef(ctx: ServiceContext, sid: string, locator: Locator, params: ParamsLocalisateur, frame: RefLocator['frame'] = null): string {
    const { locatorRefs } = ctx;
    const ref = `loc_${Math.random().toString(36).substring(2, 14)}`;
    locatorRefs.set(ref, {
        sid, locator, params, frame,
        expires_at: Date.now() + REF_TTL_MS,
    });
    // GC périodique opportuniste
    if (locatorRefs.size > 200) {
        const now = Date.now();
        for (const [k, v] of locatorRefs.entries()) {
            if (v.expires_at < now) locatorRefs.delete(k);
        }
    }
    return ref;
}

export function resolveRef(ctx: ServiceContext, ref: string, page: Page, sid: string | null = null): Locator | null {
    const { locatorRefs } = ctx;
    const entry = locatorRefs.get(ref);
    if (!entry) return null;
    if (entry.expires_at < Date.now()) {
        locatorRefs.delete(ref);
        return null;
    }
    // Cross-session safety: a ref minted for session A must not be usable in B.
    if (sid && entry.sid !== sid) return null;
    // Reconstruit le locator depuis params (le Locator stocké peut être
    // détaché si la page a navigué). Plus robuste de re-résoudre — mais sur le
    // BON scope : si le ref provient d'une iframe, on retrouve ce frame dans
    // page.frames() et on re-résout dessus (sinon l'élément serait introuvable
    // côté page principale). Mécanisme Playwright natif (Frame == API Locator).
    let scope: Portee = page;
    if (entry.frame && (entry.frame.name || entry.frame.url)) {
        const fr = page.frames().find(f =>
            (entry.frame!.name && f.name() === entry.frame!.name) ||
            (entry.frame!.url && f.url() === entry.frame!.url));
        if (fr) scope = fr;
    }
    return resolveOfficialLocator(scope, entry.params);
}

// Attente courte d'une cible absente avant « element_not_found » (la page peut finir de s'afficher).
export const NOT_FOUND_GRACE_MS = parseInt(process.env.PW_NOT_FOUND_GRACE_MS || '2000', 10);
// Plafond commun des grosses sorties (eval, extract, text), en caractères JSON comptés comme le client : sous son budget de 24 000, rien n'y est recoupé.
export const PLAFOND_SORTIE = parseInt(process.env.PW_OUTPUT_MAX_CHARS || '20000', 10);
export const INDICE_PLAFOND = `Output capped at ${PLAFOND_SORTIE} characters.`;

// Délai par défaut d'un geste, commun à /action et /chain, sous le délai du client (10 s) : l'erreur du service arrive d'abord.
export const ACTION_TIMEOUT_MS = parseInt(process.env.PW_ACTION_TIMEOUT_MS || '8000', 10);

// Nombre d'éléments d'un locator, après une courte attente (`graceMs`) s'il n'y en a encore aucun.
export async function attendrePresence(loc: Locator, graceMs: number): Promise<number> {
    let n = await loc.count().catch(() => 0);
    const fin = Date.now() + Math.max(0, graceMs);
    while (n === 0 && Date.now() < fin) {
        await new Promise(r => setTimeout(r, 200));
        n = await loc.count().catch(() => 0);
    }
    return n;
}

// Cible by_* résolue de même par tous les outils : nom entier préféré à une sous-chaîne, `nth` compté sur la liste retenue (`liste`, `n`) ; `loc` = l'élément `nth` ou la liste.
export async function resoudreCible(scope: Portee, params: ParamsOutil | null | undefined, graceMs = 0): Promise<CibleResolue | null> {
    const { nth, ...sansNth }: ParamsOutil = params || {};
    const base = resolveOfficialLocator(scope, sansNth);
    if (!base) return null;
    const n0 = await attendrePresence(base, graceMs);
    let r: ListeCible = { liste: base, n: n0, nameMatch: null, params: sansNth };
    if (n0 > 0 && sansNth.by_role && sansNth.by_name && !sansNth.exact && !sansNth.whole_name && !String(sansNth.by_name).endsWith('…')) {
        const entier = { ...sansNth, whole_name: true };
        const locEntier = resolveOfficialLocator(scope, entier)!;
        const ne = await locEntier.count().catch(() => 0);
        r = ne > 0 ? { liste: locEntier, n: ne, nameMatch: 'exact', partial: n0, params: entier } : { ...r, nameMatch: 'substring' };
    }
    const k = nth === undefined || nth === null || nth === '' ? null : Number(nth);
    if (k === null || !Number.isInteger(k) || k < 0) return { ...r, nth: null, loc: r.liste };
    return { ...r, nth: k, loc: r.liste.nth(k), params: { ...r.params, nth: k } };
}

// Le sélecteur de repli trouve-t-il un élément (échelle smartResolveLocator : texte, attributs, iframes, shadow DOM) ?
export async function trouveParRepli(page: Page, selector: string): Promise<boolean> {
    try {
        const r = await smartResolveLocator(page, selector);
        if (r.coords) return true;
        if (!r.locator) return false;
        return r.strategy !== 'fallback' || (await r.locator.count().catch(() => 0)) > 0;
    } catch { return false; }
}

// Repli par chaîne : un élément réel (un sélecteur CSS/XPath peut apparaître pendant `graceMs`), sinon element_not_found avec les cibles proches ; `coords` admis pour un clic seulement.
export function resoudreRepli(page: Page, selector: string, options?: OptionsRepli & { coords?: false }): Promise<RepliLocator>;
export function resoudreRepli(page: Page, selector: string, options: OptionsRepli & { coords: true }): Promise<RepliLocator | RepliPoint>;
export async function resoudreRepli(page: Page, selector: string, { params = null, coords = false, graceMs = NOT_FOUND_GRACE_MS }: OptionsRepli = {}): Promise<RepliLocator | RepliPoint> {
    const r = await smartResolveLocator(page, selector);
    if (r.coords && coords) return r;
    if (r.locator && (r.strategy !== 'fallback' || await attendrePresence(r.locator, graceMs) > 0)) return r;
    throw await erreurIntrouvable(page, params, selector, r.coords ? ' (only reachable by its position: use action=click)' : '');
}

// Case cochée par script en dernier recours : une vraie case ou un bouton radio seulement, sinon l'erreur du geste.
export async function cocherParScript(locator: Locator, etat: boolean, erreur: unknown): Promise<void> {
    const fait = await locator.evaluate((el: HTMLInputElement, v) => {
        if (el.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(el.type)) return false;
        el.checked = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }, etat, { timeout: 1000 }).catch(() => false);
    if (!fait) throw erreur;
}

// Clic qui atteindrait un autre élément que la cible (calque, bandeau, dialogue posé dessus) : rien n'a été cliqué.
export function erreurInterception(cible: ElementDecrit | null | undefined, couvert: ElementDecrit | null | undefined) {
    const quoi = cible && cible.css ? `<${cible.css}>` : 'the target';
    const par = couvert && couvert.css ? `<${couvert.css}>${couvert.text ? ` ("${couvert.text}")` : ''}` : 'another element';
    return erreurCodee('click_intercepted', `The click on ${quoi} would land on ${par}, which covers it: nothing was clicked.`, {
        covering_element: couvert || null, target_element: cible || null,
        fix: 'Close or remove what covers the element (its close button, pw_act action="press" value="Escape"), or wait until it is gone (pw_wait condition="hidden" on it), then retry.',
    });
}

// État de clic d'un locator (`pointDeClic` dans sa frame) ; null s'il n'est plus attaché.
export async function etatClic(loc: Locator, position: { x?: number; y?: number } | null = null): Promise<EtatClic | null> {
    return loc.evaluate(pointDeClic, position, { timeout: 1500 }).then((p): EtatClic => (p ? { visible: true, ...p } : { visible: false }), () => null);
}

// Cibles proposées pour une cible introuvable : rôles et noms de l'instantané ARIA de la page, les plus proches d'abord.
export async function suggestionsCible(page: Page, params: ParamsCible | null | undefined, selector: string | null | undefined, max = 5): Promise<SuggestionCible[]> {
    const p: ParamsCible = params || {};
    const voulu = p.by_name || p.by_text || p.by_label || p.by_placeholder || p.by_title || p.by_alt || p.by_test_id
        || (selector && isLikelyText(selector) ? selector : '');
    let instantane: string;
    try { instantane = await page.locator('body').ariaSnapshot({ timeout: 2000 }); } catch { return []; }
    return classerSuggestions(noeudsAria(instantane), { name: voulu || '', role: p.by_role || '' }, max);
}

// Erreur « element_not_found » d'une cible, avec les cibles proposées.
export async function erreurIntrouvable(page: Page, params: ParamsCible | null | undefined, selector: string | null | undefined, detail = '') {
    const expr = describeLocator(params || {}, { first: false }) || JSON.stringify(selector || '');
    const suggestions = await suggestionsCible(page, params, selector).catch(() => []);
    return erreurCodee('element_not_found', `No element matches ${expr} on this page${detail}.`, {
        suggestions,
        fix: suggestions.length
            ? 'Retry with one of the `suggestions` targets, or look at the page with pw_find / pw_page(action="inspect").'
            : 'Look at the page with pw_page(action="inspect"); if the element shows up later, wait for it first (pw_wait condition="visible").',
    });
}

// Premiers éléments d'une cible ambiguë, chacun avec un ref réutilisable par pw_act.
export async function candidatsCible(ctx: ServiceContext, loc: Locator, sid: string, params: ParamsLocalisateur, n: number, { refBase = null, frame = null, max = 5 }: { refBase?: string | null; frame?: RefLocator['frame']; max?: number } = {}): Promise<CandidatCible[]> {
    const base = refBase || storeLocatorRef(ctx, sid, loc, params, frame);
    const out: CandidatCible[] = [];
    for (let i = 0; i < Math.min(n, max); i++) {
        const d = await loc.nth(i).evaluate(decrireNoeud).catch(() => null);
        if (!d) continue;
        out.push({ index: i, ref: `${base}#${i}`, role: d.role, name: d.name,
                   ...(d.text && d.text !== d.name ? { text: d.text } : {}) });
    }
    return out;
}

export async function smartResolveLocator(page: Page, selector: string): Promise<Repli> {
    // ── Auto-correct: tag:text("X") and text="X" → tag:has-text("X") ──
    // Le LLM utilise souvent ces syntaxes inspirées de la doc Playwright,
    // mais elles ne sont PAS valides dans page.locator() / page.click().
    // :has-text() est l'extension CSS officielle Playwright qui marche partout.
    const origSelector = selector;
    // tag:text("X") → tag:has-text("X")  (et :text='X', :text=`X`)
    selector = selector.replace(/:text\((["'`])([^"'`]+)\1\)/g, ':has-text($1$2$1)');
    selector = selector.replace(/:text=(["'`])([^"'`]+)\1/g, ':has-text($1$2$1)');
    // text="X" en début / standalone → has-text. Note : on garde si combiné avec tag:.
    if (/^text=["']/.test(selector)) {
        const m = selector.match(/^text=(["'])(.+)\1$/);
        if (m) selector = `*:has-text("${echapperCss(m[2]!.replace(/\\(.)/gs, '$1'))}")`;
    }
    if (selector !== origSelector) {
        console.log(`[smartResolve] Auto-rewrite: ${origSelector} → ${selector}`);
    }

    const isXPath = selector.startsWith('//') || selector.startsWith('(//');
    const isPlaywrightSyntax = selector.includes('text=') || selector.includes('role=') ||
        selector.includes('>>') || selector.startsWith('css=') || selector.startsWith('xpath=');
    const textLike = isLikelyText(selector);
    const VIS_T = 150; // fast visibility probe timeout

    // ─── Strategy 1 : Direct selector (CSS, XPath, Playwright syntax) ───
    const mainLoc = await tryLocatorInContext(page, selector, VIS_T);
    if (mainLoc) return { locator: mainLoc, frame: page, strategy: 'direct' };

    // ─── Strategy 2 : Text-based matching (LLM's most common usage) ─────
    // This is the key improvement for div/span-based apps.
    if (!isXPath && !isPlaywrightSyntax && textLike) {
        // 2a. getByText — direct text content match (case-insensitive)
        try {
            const tl = page.getByText(selector, { exact: false }).first();
            if (await tl.count().catch(() => 0) > 0 && await tl.isVisible({ timeout: VIS_T }).catch(() => false)) {
                // Found text, but check if we should climb to interactive ancestor
                const climbed = await climbToInteractive(tl);
                return { locator: climbed || tl, frame: page, strategy: climbed ? 'text+climb' : 'text' };
            }
        } catch { /* next strategy */ }

        // 2b. :has-text() — finds CONTAINER that contains this text anywhere in descendants.
        // Critical for: <div class="btn"><span>Valider</span></div>
        try {
            for (const tag of ['button', 'a', '[role="button"]', '[onclick]', 'div', 'span', 'li', 'td', 'label']) {
                const ht = await plusInterieurVisible(page.locator(`${tag}:has-text("${echapperCss(selector)}")`));
                if (ht) return { locator: ht, frame: page, strategy: `has-text(${tag})` };
            }
        } catch { /* next strategy */ }

        // 2c. getByRole with name — covers buttons, links, etc. with accessible name
        try {
            for (const role of ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio'] as const) {
                const rl = page.getByRole(role, { name: selector, exact: false }).first();
                if (await rl.count().catch(() => 0) > 0 && await rl.isVisible({ timeout: VIS_T }).catch(() => false))
                    return { locator: rl, frame: page, strategy: `role(${role})` };
            }
        } catch { /* next strategy */ }

        // 2d. XPath sur le texte PROPRE d'un élément rendu (jamais html/body ni le source d'un <script>), casse ignorée en second.
        try {
            const rendu = 'not(ancestor-or-self::script or ancestor-or-self::style or ancestor-or-self::noscript or ancestor-or-self::template)';
            const xpaths = [
                `//body//*[${rendu}][text()[contains(normalize-space(.), ${litteralXPath(selector)})]]`,
                `//body//*[${rendu}][text()[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÂÄÉÈÊËÏÎÔÙÛÜÇ', 'abcdefghijklmnopqrstuvwxyzàâäéèêëïîôùûüç'), ${litteralXPath(selector.toLowerCase())})]]`,
            ];
            for (const xp of xpaths) {
                const xl = await premierVisible(page.locator(`xpath=${xp}`));
                if (xl) {
                    const climbed = await climbToInteractive(xl);
                    return { locator: climbed || xl, frame: page, strategy: climbed ? 'xpath-text+climb' : 'xpath-text' };
                }
            }
        } catch { /* next strategy */ }

        // 2e. Text search in iframes
        try {
            const allFrames = getAllFrames(page);
            for (const frame of allFrames) {
                if (frame === page.mainFrame() || frame.isDetached()) continue;
                try {
                    const fl = await premierVisible(frame.getByText(selector, { exact: false }));
                    if (fl) return { locator: fl, frame, strategy: 'iframe-text' };
                } catch { /* next frame */ }
            }
        } catch { /* next strategy */ }
    }

    // ─── Strategy 3 : Iframes with original selector ───
    try {
        const allFrames = getAllFrames(page);
        for (const frame of allFrames) {
            if (frame === page.mainFrame() || frame.isDetached()) continue;
            const frameLoc = await tryLocatorInContext(frame, selector, VIS_T);
            if (frameLoc) return { locator: frameLoc, frame, strategy: 'iframe' };
        }
    } catch { /* next strategy */ }

    // ─── Strategy 4 : Attribute matching (aria-label, placeholder, name, title) ───
    if (!isXPath && !isPlaywrightSyntax) {
        const escapedSel = echapperCss(selector);
        const attrChecks = [
            { sel: `[aria-label="${escapedSel}"]`, name: 'aria-label' },
            { sel: `[placeholder="${escapedSel}"]`, name: 'placeholder' },
            { sel: `[name="${escapedSel}"]`, name: 'name' },
            { sel: `[title="${escapedSel}"]`, name: 'title' },
            // Case-insensitive via CSS i flag (works in modern browsers)
            { sel: `[aria-label="${escapedSel}" i]`, name: 'aria-label-i' },
        ];
        for (const { sel, name } of attrChecks) {
            try {
                const al = page.locator(sel).first();
                if (await al.count().catch(() => 0) > 0 && await al.isVisible({ timeout: VIS_T }).catch(() => false))
                    return { locator: al, frame: page, strategy: name };
            } catch { /* next attribute */ }
        }

        // data-testid, data-cy, data-qa
        for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-automation', 'data-test']) {
            try {
                const al = page.locator(`[${attr}="${escapedSel}"]`).first();
                if (await al.count().catch(() => 0) > 0 && await al.isVisible({ timeout: VIS_T }).catch(() => false))
                    return { locator: al, frame: page, strategy: attr };
            } catch { /* next attribute */ }
        }
    }

    // ─── Strategy 5 : Shadow DOM ───
    if (!isXPath) {
        const shadowResult = await shadowDOMQuery(page, selector);
        if (shadowResult?.found)
            return { locator: null, frame: page, strategy: 'shadow-dom', coords: { x: shadowResult.x, y: shadowResult.y }, hit: shadowResult.hit, cover: shadowResult.cover, element: shadowResult.element };
        if (textLike) {
            const shadowTextResult = await shadowDOMQueryByText(page, selector);
            if (shadowTextResult?.found)
                return { locator: null, frame: page, strategy: 'shadow-dom-text', coords: { x: shadowTextResult.x, y: shadowTextResult.y }, hit: shadowTextResult.hit, cover: shadowTextResult.cover, element: shadowTextResult.element };
        }
    }

    // ─── Strategy 6 : JS deep text search with interactive ancestor climb ───
    // Last resort: find ANY element containing the text via JS, then climb to clickable ancestor
    if (textLike) {
        try {
            const jsResult = await page.evaluate(({ text, srcPoint }): PointTrouve | { found: false } => {
                const auPoint = new Function(`return (${srcPoint})`)() as typeof pointDeClic;
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                    acceptNode: (n) => (n.parentElement && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentElement.tagName)
                        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
                });
                const needle = text.toLowerCase().trim();
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    if (node.textContent!.toLowerCase().trim().includes(needle)) {
                        let el = node.parentElement;
                        // Climb to nearest interactive ancestor
                        const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);
                        let candidate = el;
                        for (let i = 0; i < 8 && candidate; i++) {
                            if (interactiveTags.has(candidate.tagName)) { el = candidate; break; }
                            if (candidate.getAttribute('role') === 'button' ||
                                candidate.getAttribute('role') === 'link' ||
                                candidate.getAttribute('role') === 'menuitem' ||
                                candidate.getAttribute('role') === 'tab' ||
                                candidate.hasAttribute('onclick') ||
                                candidate.hasAttribute('tabindex') ||
                                candidate.style.cursor === 'pointer' ||
                                window.getComputedStyle(candidate).cursor === 'pointer') {
                                el = candidate; break;
                            }
                            candidate = candidate.parentElement;
                        }
                        if (!el) continue;
                        const p = auPoint(el);
                        if (p) return { found: true, ...p };
                    }
                }
                return { found: false };
            }, { text: selector, srcPoint: sourceDe(pointDeClic) });
            if (jsResult?.found)
                return { locator: null, frame: page, strategy: 'js-text-walk', coords: { x: jsResult.x, y: jsResult.y }, hit: jsResult.hit, cover: jsResult.cover, element: jsResult.element };
        } catch { /* next strategy */ }
    }

    // ─── Strategy 7 : sélecteur CSS/XPath tel quel, jamais un texte pris pour un sélecteur ───
    if (textLike && !isPlaywrightSyntax) return { locator: null, frame: page, strategy: 'not_found' };
    const fallback = isXPath ? page.locator(`xpath=${selector}`) : page.locator(selector);
    return { locator: fallback.first(), frame: page, strategy: 'fallback' };
}

// ==========================================
// SMART RETRY CONTEXT (Feature 3)
// ==========================================
export async function findAlternatives(page: Page, failedSelector: string, maxSuggestions = 5): Promise<Alternative[]> {
    try {
        return await page.evaluate(({ selector, max }) => {
            const results: Alternative[] = [];
            // Gather all interactive elements
            const interactives = document.querySelectorAll<HTMLElement>(
                'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], [tabindex]'
            );
            const needle = (selector || '').toLowerCase().trim();

            for (const el of interactives) {
                if (results.length >= max) break;
                const text = (el.textContent || '').trim().substring(0, 80);
                const ariaLabel = el.getAttribute('aria-label') || '';
                const placeholder = el.getAttribute('placeholder') || '';
                const title = el.getAttribute('title') || '';
                const rect = el.getBoundingClientRect();

                if (rect.width === 0 || rect.height === 0) continue;
                if (!el.offsetParent && el.tagName !== 'BODY') continue; // hidden

                // Score similarity
                const haystack = `${text} ${ariaLabel} ${placeholder} ${title}`.toLowerCase();
                if (!needle || haystack.includes(needle) || needle.split(' ').some(w => w.length > 2 && haystack.includes(w))) {
                    const tag = el.tagName.toLowerCase();
                    const id = el.id ? `#${el.id}` : '';
                    const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : '';
                    results.push({
                        selector: id || `${tag}${cls}`,
                        tag,
                        text: text.substring(0, 60),
                        aria_label: ariaLabel.substring(0, 40),
                        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                        center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
                    });
                }
            }
            return results;
        }, { selector: failedSelector, max: maxSuggestions });
    } catch { return []; }
}

// ════════════════════════════════════════════════════════════════════
// MISSING ENDPOINTS — added v5.1 (matching firefox_tools.py contract)
// ════════════════════════════════════════════════════════════════════
// These endpoints back pw_expect, pw_observe, pw_mock, pw_recorder, and
// pw_page("screenshot", target=...). They were callable from the Python
// side but the server returned 404 on every call. Now implemented.

// Cible d'un outil par ref ou by_* (resoudreCible) : `{ loc, n, nth… }`, `null` sans critère ou pour un ref inconnu.
export async function cibleDepuisParams(ctx: ServiceContext, page: Page, params: ParamsOutil | null | undefined, sid: string | null = null, graceMs = 0): Promise<CibleResolue | null> {
    if (!params) return null;
    const { ref, ...byParams } = params;
    if (ref) {
        const [baseRef, idxStr] = String(ref).split('#') as [string, string?];
        let loc = resolveRef(ctx, baseRef, page, sid);
        if (loc && idxStr !== undefined) loc = loc.nth(parseInt(idxStr, 10));
        return loc ? { loc, liste: loc, n: await attendrePresence(loc, graceMs), nth: null, nameMatch: null, params: {}, refBase: baseRef } : null;
    }
    if (!Object.values(byParams).some(v => v !== undefined && v !== null && v !== '')) return null;
    return resoudreCible(page, byParams, graceMs);
}

// Locator d'un outil (/expect, /wait_for, captures, glisser) : premier élément si `first` (sauf ref), la liste entière pour les comptages.
export async function locatorFromParams(ctx: ServiceContext, page: Page, params: ParamsOutil | null | undefined, sid: string | null = null, { first = true }: { first?: boolean } = {}): Promise<Locator | null> {
    const c = await cibleDepuisParams(ctx, page, params, sid);
    if (!c) return null;
    return first && !c.refBase ? c.loc.first() : c.loc;
}
