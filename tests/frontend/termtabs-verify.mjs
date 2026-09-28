// SPDX-License-Identifier: MIT
// Vérification des onglets du panneau terminal (style navigateur, 2026-08-08).
//   PERF_PORT=8931 node tests/frontend/termtabs-server.mjs &
//   PERF_PORT=8931 node tests/frontend/termtabs-verify.mjs
//
// Ce qu'on prouve, sur le CSS RÉEL de l'app :
//   1. l'onglet ACTIF fusionne avec la surface du terminal (même couleur, pas
//      de bord bas) — c'est ce qui fait l'effet « onglet navigateur » ;
//   2. il porte bien les DEUX raccords à rayon inversé (::before / ::after),
//      posés hors de sa boîte, à gauche et à droite de son pied ;
//   3. les coins HAUTS sont arrondis et les coins BAS carrés (trapèze) ;
//   4. un onglet INACTIF est visuellement enfoncé (fond distinct de la surface) ;
//   5. la pastille d'état a une couleur DIFFÉRENTE par état (connecté /
//      reconnexion / jamais ouvert / coupé) — le point que l'utilisateur
//      signalait comme « pas clair » ;
//   6. le balisage de editor.html utilise bien ces classes (garde anti-dérive).
import fs from 'fs';
import { launch, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/termtabs-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond, extra) => {
    checks.push([cond ? 'PASS' : 'FAIL', name]);
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  → ' + extra : ''));
};

const TERM_SURFACE = 'rgb(30, 30, 30)';    // #1e1e1e, fond du panneau terminal
const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(10000);
    await page.goto(BASE_URL + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.term-tab.is-active');

    const css = (sel, prop, pseudo) => page.evaluate(
        ([s, p, ps]) => getComputedStyle(document.querySelector(s), ps || null).getPropertyValue(p),
        [sel, prop, pseudo || null]);

    // 1. Fusion actif ↔ surface
    const activeBg  = await css('.term-tab.is-active', 'background-color');
    const surfaceBg = await css('#surface', 'background-color');
    ok('onglet actif : même couleur que la surface du terminal (fusion)',
       activeBg === surfaceBg && activeBg === TERM_SURFACE, activeBg);
    ok('onglet actif : aucun bord bas',
       (await css('.term-tab.is-active', 'border-bottom-width')) === '0px');

    // 2. Raccords à rayon inversé
    const before = await css('.term-tab.is-active', 'content', '::before');
    const after  = await css('.term-tab.is-active', 'content', '::after');
    ok('onglet actif : raccord gauche (::before) présent', before === '""', before);
    ok('onglet actif : raccord droit (::after) présent',  after === '""', after);
    const beforeBg = await css('.term-tab.is-active', 'background-color', '::before');
    ok('raccords : couleur de la surface (ils prolongent le plan du terminal)',
       beforeBg === TERM_SURFACE, beforeBg);
    const maskB = await css('.term-tab.is-active', '-webkit-mask-image', '::before');
    ok('raccords : découpe en quart de disque (radial-gradient)',
       /radial-gradient/.test(maskB), maskB.slice(0, 44) + '…');
    // Les raccords débordent HORS de la boîte de l'onglet (gauche ET droite).
    const geo = await page.evaluate(() => {
        const t = document.querySelector('.term-tab.is-active');
        const r = t.getBoundingClientRect();
        const b = getComputedStyle(t, '::before'), a = getComputedStyle(t, '::after');
        return { w: r.width, left: b.left, right: a.right,
                 bw: parseFloat(b.width), aw: parseFloat(a.width) };
    });
    ok('raccords : posés hors de la boîte, de part et d\'autre du pied',
       parseFloat(geo.left) < 0 && parseFloat(geo.right) < 0 && geo.bw > 0 && geo.aw > 0,
       `left=${geo.left} right=${geo.right}`);

    // 3. Trapèze : coins hauts arrondis, coins bas carrés
    const rTL = await css('.term-tab.is-active', 'border-top-left-radius');
    const rBL = await css('.term-tab.is-active', 'border-bottom-left-radius');
    ok('coins HAUTS arrondis, coins BAS carrés', parseFloat(rTL) > 0 && parseFloat(rBL) === 0,
       `haut=${rTL} bas=${rBL}`);

    // 4. Contraste barre ↔ surface : SANS lui, l'onglet actif (couleur de la
    //    surface) se fond dans le fond et la forme d'onglet est invisible.
    const stripBg = await css('.term-tabstrip', 'background-color');
    ok('barre d\'onglets : en retrait du plan du terminal (contraste)',
       stripBg !== surfaceBg && stripBg !== 'rgba(0, 0, 0, 0)', stripBg);
    const lum = (c) => { const m = c.match(/\d+/g) || [0,0,0];
                         return (+m[0]) * .299 + (+m[1]) * .587 + (+m[2]) * .114; };
    ok('barre d\'onglets : plus sombre que la surface (onglet actif « en relief »)',
       lum(stripBg) < lum(surfaceBg), `strip=${lum(stripBg).toFixed(1)} surface=${lum(surfaceBg).toFixed(1)}`);

    // Onglet inactif visuellement distinct de l'actif
    const idleBg = await css('.term-tab:not(.is-active)', 'background-color');
    ok('onglet inactif : fond distinct de la surface (enfoncé)',
       idleBg !== surfaceBg, idleBg);

    // 5. Pastilles d'état : une couleur par état
    const dots = await page.evaluate(() => {
        const out = {};
        for (const el of document.querySelectorAll('.term-tab-dot')) {
            const st = [...el.classList].find(c => c.startsWith('is-'));
            out[st] = getComputedStyle(el).backgroundColor;
        }
        return out;
    });
    const states = ['is-open', 'is-reconnecting', 'is-idle', 'is-closed'];
    ok('pastille : les 4 états sont rendus', states.every(s => s in dots),
       Object.keys(dots).join(', '));
    const colored = states.map(s => dots[s]).filter(Boolean);
    ok('pastille : une couleur DIFFÉRENTE par état',
       new Set(colored).size === colored.length, JSON.stringify(dots));

    // Bascule d'onglet : l'actif suit le clic (et un seul est actif).
    await page.click('[data-sid="t_b"]');
    await page.waitForTimeout(120);
    const activeCount = await page.locator('.term-tab.is-active').count();
    const activeSid = await page.getAttribute('.term-tab.is-active', 'data-sid');
    ok('un seul onglet actif à la fois, et il suit le clic',
       activeCount === 1 && activeSid === 't_b', `${activeCount} actif(s), sid=${activeSid}`);

    // 6. Garde anti-dérive : editor.html utilise bien ces classes.
    const html = fs.readFileSync(new URL('../../frontend/includes/main/editor.html', import.meta.url), 'utf8');
    ok('editor.html utilise .term-tab / .term-tabstrip',
       html.includes('class="term-tab"') && html.includes('term-tabstrip'));
    ok('editor.html rend la pastille d\'état par onglet',
       html.includes('term-tab-dot') && html.includes("'is-' + termSessionState(s.id)"));
    ok('editor.html affiche le compteur N/max',
       html.includes('termSessions.length }}/{{ termMaxSessions'));

    await page.screenshot({ path: SHOTS + '/termtabs.png' });
    await page.locator('#panel').screenshot({ path: SHOTS + '/termtabs-panel.png' });

    ok('aucune erreur JS', errors.length === 0, errors.join(' | '));
} finally {
    await browser.close();
}

const failed = checks.filter(c => c[0] === 'FAIL');
console.log(`\n${checks.length - failed.length}/${checks.length} vérifications OK`);
console.log('captures : ' + SHOTS);
process.exit(failed.length ? 1 : 0);
