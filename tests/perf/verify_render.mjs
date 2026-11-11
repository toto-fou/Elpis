// SPDX-License-Identifier: MIT
// Vérification de NON-RÉGRESSION du rendu (Phase C) — complète les mesures
// de perf. Cible les changements les plus risqués des vagues 1-2 :
//   1. split frozen/tail : le texte affiché pendant le stream reste un
//      préfixe EXACT du texte attendu (aucune perte/duplication/réordre) ;
//   2. rendu final : markdown rendu, code surligné (hljs) ;
//   3. sanitize : les vecteurs XSS n'atteignent jamais le DOM ni le JS ;
//   4. scroll : l'autoscroll respecte isUserScrolling (remonter pendant le
//      stream ne ramène pas en bas ; redescendre reprend le suivi) ;
//   5. virtualisation : chat long → tous les messages accessibles au scroll.
//
// Sortie : lignes "OK/FAIL: …" + code retour ≠ 0 si un check échoue.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, gotoApp, configureServer, sendAndWaitStream, BASE_URL } from './lib/harness.mjs';
import { buildXlReply } from './fixtures/big_code_reply.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const results = [];
function check(name, cond, detail = '') {
    results.push({ name, ok: !!cond });
    console.log(`${cond ? 'OK  ' : 'FAIL'}: ${name}${detail ? '  — ' + detail : ''}`);
}

let server = null;
try { await fetch(`${BASE_URL}/__perf/config`); }
catch (_) {
    server = spawn('node', [path.join(__dirname, 'perf-server.mjs')], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 900));
}

const send = (page, txt) =>
    page.locator('textarea[placeholder]').last().fill(txt)
        .then(() => page.locator('button:has(i.ph-paper-plane-right)').last().click());
const waitStreamEnd = (page) =>
    page.waitForFunction(() => !document.querySelector('textarea[disabled]'),
        null, { timeout: 40000, polling: 300 });

// Résout le conteneur scrollable des MESSAGES (ref=chatContainer, pas la
// sidebar .chat-history-scroll) : on remonte depuis un [data-vs-idx] jusqu'au
// 1er ancêtre réellement scrollable. Évalué dans la page.
function installScrollerHelper(page) {
    return page.evaluate(() => {
        window.__scroller = () => {
            let el = document.querySelector('[data-vs-idx]');
            while (el && el !== document.body) {
                const s = getComputedStyle(el);
                if ((s.overflowY === 'auto' || s.overflowY === 'scroll')
                    && el.scrollHeight > el.clientHeight + 5) return el;
                el = el.parentElement;
            }
            return document.querySelector('div.overflow-y-auto.scroll-smooth') || document.scrollingElement;
        };
    });
}

// ── 1+2. Rendu markdown LIVE incrémental + complétude au final (XL) ─────────
async function testXlLiveRender() {
    await configureServer({ reply: 'xl', toks: 200, chat: null });
    const h = await launch({ cpuRate: 1 });
    try {
        await gotoApp(h.page);
        await send(h.page, 'Texte long pour le rendu live.');
        await h.page.waitForFunction(() => !!document.querySelector('textarea[disabled]'),
            null, { timeout: 10000, polling: 100 });

        // Pendant le stream : le markdown est rendu EN DIRECT (éléments
        // formatés présents, pas du texte brut) et les blocs TERMINÉS se
        // figent (le nombre d'éléments de bloc CROÎT au fil du stream).
        let sawFormatted = false, maxBlocks = 0, sawStrong = false, samples = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < 40000) {
            const snap = await h.page.evaluate(() => {
                const el = document.querySelector('[aria-busy="true"]');
                if (!el) return { streaming: false };
                return {
                    streaming: true,
                    blocks: el.querySelectorAll('p,h1,h2,h3,ul,ol,pre,blockquote,table').length,
                    strong: el.querySelectorAll('strong,em').length,
                    rawHashHeading: /(^|\n)#{1,3}\s/.test(el.innerText || ''),
                };
            });
            if (!snap.streaming) break;
            samples++;
            if (snap.blocks > 0) sawFormatted = true;
            if (snap.strong > 0) sawStrong = true;
            maxBlocks = Math.max(maxBlocks, snap.blocks);
            await h.page.waitForTimeout(120);
        }
        check('XL: markdown rendu EN DIRECT pendant le stream (éléments formatés)',
              sawFormatted, `${samples} échantillons, max ${maxBlocks} blocs`);
        check('XL: blocs terminés figés et accumulés (incrémental)', maxBlocks >= 3);
        check('XL: gras/emphase formatés en direct (pas de ** brut)', sawStrong);

        await waitStreamEnd(h.page);
        const finalText = await h.page.evaluate(() => {
            const b = document.querySelectorAll('.markdown-body');
            return b.length ? (b[b.length - 1].innerText || '').trim() : '';
        });
        check('XL: rendu final non vide', finalText.length > 1000, `${finalText.length} chars`);
        check('XL: rendu final — début présent', finalText.includes('analyse détaillée du pipeline'));
        check('XL: rendu final — fin présente', finalText.includes('sans dépendre du GPU'));
        check('XL: rendu final — markdown appliqué (pas de ** littéral)', !finalText.includes('**'));
    } finally { await h.browser.close(); }
}

// ── 2b. Code : <pre><code> + coloration hljs au final ──────────────────────
async function testCodeRender() {
    await configureServer({ reply: 'code200', toks: 200, chat: null });
    const h = await launch({ cpuRate: 1 });
    try {
        await gotoApp(h.page);
        await send(h.page, 'Donne un exemple Python.');
        await waitStreamEnd(h.page);
        await h.page.waitForTimeout(900);   // addCodeCopyButtons différé
        const dom = await h.page.evaluate(() => {
            const b = document.querySelectorAll('.markdown-body');
            const last = b[b.length - 1];
            return {
                hasCode: !!last.querySelector('pre code'),
                hljs: !!last.querySelector('pre code.hljs, pre code [class^="hljs-"]'),
            };
        });
        check('code: bloc <pre><code> présent au final', dom.hasCode);
        check('code: coloration hljs appliquée', dom.hljs);
    } finally { await h.browser.close(); }
}

// ── 3. Sanitize XSS ─────────────────────────────────────────────────────────
async function testXss() {
    await configureServer({ reply: 'xss', toks: 200, chat: null });
    const h = await launch({ cpuRate: 1 });
    try {
        await gotoApp(h.page);
        await send(h.page, 'Récapitule.');
        await waitStreamEnd(h.page);
        await h.page.waitForTimeout(800);
        const r = await h.page.evaluate(() => {
            const b = document.querySelectorAll('.markdown-body');
            const last = b[b.length - 1];
            return {
                fired: !!window.__XSS_FIRED,
                hasScript: !!last.querySelector('script'),
                hasOnerror: /onerror=/i.test(last.innerHTML),
                hasJsHref: !!last.querySelector('a[href^="javascript:"]'),
                hasTable: !!last.querySelector('table'),
                hasCode: !!last.querySelector('pre code'),
            };
        });
        check('XSS: aucun handler exécuté (__XSS_FIRED non posé)', !r.fired);
        check('XSS: pas de <script> dans le DOM rendu', !r.hasScript);
        check('XSS: pas d\'attribut onerror', !r.hasOnerror);
        check('XSS: pas de href javascript:', !r.hasJsHref);
        check('XSS: markdown légitime préservé (table + code)', r.hasTable && r.hasCode);
    } finally { await h.browser.close(); }
}

// ── 4. Scroll : autoscroll respecte isUserScrolling ─────────────────────────
async function testScroll() {
    await configureServer({ reply: 'xl', toks: 120, chat: null });
    const h = await launch({ cpuRate: 1 });
    try {
        await gotoApp(h.page);
        await send(h.page, 'Texte long pour tester le scroll.');
        await h.page.waitForFunction(() => !!document.querySelector('textarea[disabled]'),
            null, { timeout: 10000, polling: 100 });
        await installScrollerHelper(h.page);

        const dist = () => h.page.evaluate(() => {
            const el = window.__scroller();
            return el ? (el.scrollHeight - el.scrollTop - el.clientHeight) : -1;
        });
        // Le handler wheel n'arme isUserScrolling QUE si le conteneur déborde
        // (scrollHeight > clientHeight+10). On attend donc un overflow réel
        // avant de tester (sinon le test ne teste rien).
        await h.page.waitForFunction(() => {
            const el = window.__scroller();
            return el && el.scrollHeight - el.clientHeight > 300;
        }, null, { timeout: 20000, polling: 200 });
        const box = await h.page.evaluate(() => {
            const el = window.__scroller();
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        });

        // Remonter pendant le stream (mouse.wheel → déclenche isUserScrolling,
        // ce qu'un scrollTop programmatique ne ferait PAS). On vérifie que la
        // distance au bas CROÎT et reste élevée (l'autoscroll a lâché : le
        // contenu défile sous l'utilisateur au lieu de le ramener en bas).
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        await h.page.mouse.move(cx, cy);
        await h.page.mouse.wheel(0, -1500);
        await h.page.waitForTimeout(1800);   // plusieurs flushs : l'autoscroll NE doit PAS ramener
        const dUp = await dist();
        check('scroll: remonter pendant le stream n\'est pas annulé par l\'autoscroll',
              dUp > 120, `distance bas = ${Math.round(dUp)}px`);

        // Redescendre tout en bas → l'autoscroll doit reprendre.
        await h.page.mouse.wheel(0, 6000);
        await h.page.waitForTimeout(400);
        await h.page.mouse.wheel(0, 6000);
        await h.page.waitForTimeout(1800);
        const dDown = await dist();
        check('scroll: redescendre en bas réactive le suivi', dDown <= 60,
              `distance bas = ${Math.round(dDown)}px`);

        await waitStreamEnd(h.page);
    } finally { await h.browser.close(); }
}

// ── 5. Virtualisation : chat long, tous les messages accessibles ────────────
async function testVirtualization() {
    await configureServer({ reply: 'short', toks: 200, chat: 'long100' });
    const h = await launch({ cpuRate: 1 });
    try {
        await gotoApp(h.page);
        await h.page.locator('text=Chat long 100 messages').first().click();
        await h.page.waitForSelector('[data-vs-idx]', { timeout: 15000 });
        await h.page.waitForTimeout(1500);
        await installScrollerHelper(h.page);

        // Scroll en haut → le premier message (index 0) doit être atteignable.
        // Le recalc de fenêtre passe par un RAF + re-render → on POLLE l'index 0
        // plutôt qu'un délai fixe (le windowing peut réajuster scrollTop).
        await h.page.evaluate(() => { const c = window.__scroller(); if (c) c.scrollTop = 0; });
        let top = false;
        for (let i = 0; i < 12 && !top; i++) {
            await h.page.waitForTimeout(250);
            top = await h.page.evaluate(() => !!document.querySelector('[data-vs-idx="0"]'));
            if (!top) await h.page.evaluate(() => { const c = window.__scroller(); if (c && c.scrollTop > 4) c.scrollTop = 0; });
        }
        check('virtualisation: 1er message rendu après scroll en haut', top);

        // Re-scroll en bas → dernier message présent + boutons copier réattachés.
        await h.page.evaluate(() => { const c = window.__scroller(); if (c) c.scrollTop = c.scrollHeight; });
        await h.page.waitForTimeout(1000);
        const bottom = await h.page.evaluate(() => {
            const nodes = [...document.querySelectorAll('[data-vs-idx]')];
            const maxIdx = nodes.reduce((m, n) => Math.max(m, +n.dataset.vsIdx), -1);
            return { maxIdx, hasCopy: !!document.querySelector('.markdown-body .copy-btn, .markdown-body pre') };
        });
        check('virtualisation: dernier message rendu après scroll en bas',
              bottom.maxIdx >= 95, `maxIdx=${bottom.maxIdx}`);

        const errs = h.errors.length;
        check('virtualisation: aucune erreur de page pendant le scroll', errs === 0,
              errs ? h.errors[0] : '');
    } finally { await h.browser.close(); }
}

try {
    await testXlLiveRender();
    await testCodeRender();
    await testXss();
    await testScroll();
    await testVirtualization();
} finally {
    if (server) server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks OK`);
if (failed.length) { console.log('ÉCHECS : ' + failed.map((r) => r.name).join(' | ')); process.exit(1); }
