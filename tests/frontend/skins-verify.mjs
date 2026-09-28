// SPDX-License-Identifier: MIT
// Vérif du CORRECTIF SKINS (route-mock, sans backend) :
//   PERF_PORT=8911 node tests/frontend/skins-server.mjs &
//   PERF_PORT=8911 node tests/frontend/skins-verify.mjs
//
// Matrice 6 skins × 2 modes sur index.html, puis smoke admin.html (3 combos).
// Par combo :
//   • classes body : elpis-skin-<id>, elpis-app-dark (toggle) et le MARQUEUR
//     elpis-dark-surface (posé ssi sombre OU skin darkBase — Émeraude) ;
//   • contrastes WCAG (luminance relative, composition alpha via canvas —
//     robuste aux couleurs oklch/color-mix des skins) : texte de rail,
//     icônes de rail, textarea du composeur + placeholder, sonde
//     text-gray-800/text-black sur surface (RC1 : illisible en
//     Émeraude-clair avant le marqueur), chip bg-blue-50/text-blue-700 ;
//   • câblage tokens : bouton Admin == --rail-ok (vert sémantique restauré),
//     fond bg-blue-600 == --accent (+ --accent-fg), ring-blue-500 ==
//     --accent-ring, .elpis-toast == --toast-bg, .elpis-search-hl == --hl-bg,
//     .elpis-role-admin-badge == --role-admin-text, accent-color du body ;
//   • popover notifications : .elpis-notif-pop N'hérite PAS des remaps rail ;
//   • zéro pageerror sur les 15 chargements.
import fs from 'fs';
import { launch, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/skins-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond, extra) => {
    checks.push([cond ? 'PASS' : 'FAIL', name]);
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : `   [${extra}]`));
};

// Registre des skins intégrés : le manifeste lu par le serveur (plus de liste
// recopiée ici — un skin ajouté au manifeste entre dans la matrice).
const SKINS = JSON.parse(fs.readFileSync(new URL('../../frontend/css/skins/skins.json', import.meta.url), 'utf8'))
    .skins.map((s) => ({ id: s.id, slug: s.id || 'ardoise', darkBase: !!s.darkBase }));

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

async function setConfig(skin, dark) {
    await fetch(BASE_URL + '/__config', { method: 'POST', body: JSON.stringify({ skin, dark_mode: dark }) });
}
// gotoApp du harnais attend 5 s (timer diagnostic sous throttle) — inutile ici,
// 15 chargements : version rapide, on attend juste le montage + watchers.
async function fastGoto(pathName) {
    await page.goto(BASE_URL + pathName);
    await page.waitForFunction(() => {
        const app = document.getElementById('app');
        return app && !app.hasAttribute('v-cloak');
    }, null, { timeout: 30000, polling: 100 });
    await page.waitForTimeout(700);
}

// Audit in-page : toutes les mesures d'un combo en un evaluate. Couleurs
// normalisées via canvas 2D (fillStyle accepte rgb/oklch/color-mix → pixels
// sRGB), contraste = WCAG relative luminance, fond effectif = composition
// alpha en remontant au premier ancêtre opaque.
const AUDIT = `(() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const toRGBA = (css) => {
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = '#000'; cx.fillStyle = String(css || '');
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
    };
    const lum = (rgb) => {
        const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const over = (fg, bg) => fg[3] >= 1 ? fg.slice(0, 3)
        : [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])];
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const effBg = (el) => {
        const layers = [];
        let n = el;
        while (n && n !== document.documentElement) {
            const c = toRGBA(getComputedStyle(n).backgroundColor);
            if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
            n = n.parentElement;
        }
        let out = [255, 255, 255];
        const bodyBg = toRGBA(getComputedStyle(document.body).backgroundColor);
        if (!layers.length || layers[layers.length - 1][3] < 1) out = bodyBg.slice(0, 3);
        else out = layers.pop().slice(0, 3);
        for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
        return out;
    };
    const vr = (name, host) => {
        const probe = document.createElement('div');
        probe.style.color = 'var(' + name + ')';
        probe.style.display = 'none';
        (host || document.body).appendChild(probe);
        const c = toRGBA(getComputedStyle(probe).color);
        probe.remove();
        return c;
    };
    const same = (a, b, tol) => a && b && Math.abs(a[0]-b[0]) <= (tol||2) && Math.abs(a[1]-b[1]) <= (tol||2) && Math.abs(a[2]-b[2]) <= (tol||2);
    const cRatio = (el, bg) => {
        const fg = toRGBA(getComputedStyle(el).color);
        const base = bg || effBg(el.parentElement || el);
        return ratio(over(fg, base), base);
    };

    const out = { classes: Array.from(document.body.classList) };
    const aside = document.querySelector('aside.elpis-slide-panel');
    const railBg = aside ? vr('--rail-bg', aside) : null;

    // ── Rail : texte courant, icônes discrètes, marque, bouton Admin ──
    if (aside && railBg) {
        const item = aside.querySelector('.text-slate-300');
        const gear = aside.querySelector('button[title="Paramètres"]');
        // Marque = le span truncate de l'en-tête — PAS le premier .text-white
        // du DOM (ce serait le bouton « Nouveau chat », posé sur un fond
        // ACCENT : son texte suit --accent-fg, pas le fond du rail).
        const brand = aside.querySelector('span.text-white.truncate');
        const admin = aside.querySelector('button[title="Admin"]');
        out.rail = {
            textC:  item  ? cRatio(item,  railBg.slice(0, 3)) : null,
            mutedC: gear  ? cRatio(gear,  railBg.slice(0, 3)) : null,
            brandC: brand ? cRatio(brand, railBg.slice(0, 3)) : null,
            adminMatch: admin ? same(toRGBA(getComputedStyle(admin).color), vr('--rail-ok', aside)) : null,
        };
        // Popover notifications : surface CLAIRE de l'app, PAS les remaps rail.
        const pop = document.createElement('div');
        pop.className = 'elpis-notif-pop bg-white';
        pop.innerHTML = '<span class="text-slate-500">notif</span>';
        aside.appendChild(pop);
        const span = pop.querySelector('span');
        out.pop = {
            tokenMatch: same(toRGBA(getComputedStyle(span).color), vr('--text-500')),
            contrast: cRatio(span),
        };
        pop.remove();
    }

    // ── Sondes de surface (RC1) : gray/black + chip accent ────────────
    const host = document.createElement('div');
    host.className = 'bg-white';
    host.innerHTML = '<span class="text-gray-800">g</span><span class="text-black">b</span>'
        + '<div class="bg-blue-50"><span class="text-blue-700">chip</span></div>'
        + '<div class="elpis-toast"><span>toast</span></div>'
        + '<mark class="elpis-search-hl">hl</mark>'
        + '<span class="elpis-role-admin-badge">Admin</span>'
        + '<button class="bg-blue-600">CTA</button>'
        + '<div class="ring-blue-500">ring</div>';
    document.body.appendChild(host);
    const q = (s) => host.querySelector(s);
    out.grayC  = cRatio(q('.text-gray-800'));
    out.blackC = cRatio(q('.text-black'));
    out.chipC  = cRatio(q('.text-blue-700'));
    const toastEl = q('.elpis-toast');
    out.toast = {
        bgMatch: same(toRGBA(getComputedStyle(toastEl).backgroundColor), vr('--toast-bg')),
        contrast: ratio(toRGBA(getComputedStyle(toastEl).color).slice(0, 3), toRGBA(getComputedStyle(toastEl).backgroundColor).slice(0, 3)),
    };
    out.hlMatch = same(toRGBA(getComputedStyle(q('.elpis-search-hl')).backgroundColor), vr('--hl-bg'), 3);
    out.roleMatch = same(toRGBA(getComputedStyle(q('.elpis-role-admin-badge')).color), vr('--role-admin-text'));
    const cta = q('.bg-blue-600');
    out.accentFill = {
        bgMatch: same(toRGBA(getComputedStyle(cta).backgroundColor), vr('--accent')),
        fgMatch: same(toRGBA(getComputedStyle(cta).color), vr('--accent-fg')),
    };
    out.ringMatch = same(toRGBA(getComputedStyle(q('.ring-blue-500')).getPropertyValue('--tw-ring-color')), vr('--accent-ring'));
    host.remove();

    // ── Composeur : texte saisi + placeholder ──────────────────────────
    const ta = document.querySelector('.elpis-compose-card textarea') || document.querySelector('textarea[placeholder]');
    if (ta) {
        const bg = effBg(ta);
        out.input = {
            contrast: cRatio(ta, bg),
            phContrast: ratio(over(toRGBA(getComputedStyle(ta, '::placeholder').color), bg), bg),
        };
    }

    out.bodyAccentMatch = same(toRGBA(getComputedStyle(document.body).accentColor), vr('--accent'));
    out.fontSmoothing = getComputedStyle(document.body).webkitFontSmoothing || '';
    return out;
})()`;

const r1 = (x) => (x == null ? 'n/a' : Math.round(x * 100) / 100);

try {
    page.setDefaultTimeout(15000);

    for (const sk of SKINS) {
        for (const dark of [false, true]) {
            const tag = `${sk.slug}${dark ? '/sombre' : '/clair'}`;
            await setConfig(sk.id, dark);
            await fastGoto('/');
            const a = await page.evaluate(AUDIT);
            await page.screenshot({ path: `${SHOTS}/${sk.slug}-${dark ? 'dark' : 'light'}.png` });

            const wantMarker = dark || sk.darkBase;
            ok(`${tag} — classes body (skin/${dark ? '+' : '−'}dark/${wantMarker ? '+' : '−'}marqueur)`,
               (sk.id ? a.classes.includes('elpis-skin-' + sk.id) : !a.classes.some(c => c.startsWith('elpis-skin-')))
               && a.classes.includes('elpis-app-dark') === dark
               && a.classes.includes('elpis-dark-surface') === wantMarker,
               a.classes.join(' '));
            ok(`${tag} — rail : texte ≥ 4.5`, a.rail && a.rail.textC >= 4.5, r1(a.rail && a.rail.textC));
            ok(`${tag} — rail : icônes ≥ 3`, a.rail && a.rail.mutedC >= 3, r1(a.rail && a.rail.mutedC));
            ok(`${tag} — rail : marque ≥ 4.5`, a.rail && a.rail.brandC >= 4.5, r1(a.rail && a.rail.brandC));
            ok(`${tag} — bouton Admin == --rail-ok (vert sémantique)`, a.rail && a.rail.adminMatch === true);
            ok(`${tag} — popover notif : tokens surface (pas les remaps rail)`, a.pop && a.pop.tokenMatch && a.pop.contrast >= 4.5, r1(a.pop && a.pop.contrast));
            ok(`${tag} — text-gray-800 sur surface ≥ 4.5 (RC1)`, a.grayC >= 4.5, r1(a.grayC));
            ok(`${tag} — text-black sur surface ≥ 4.5 (RC1)`, a.blackC >= 4.5, r1(a.blackC));
            ok(`${tag} — chip bg-blue-50/text-blue-700 ≥ 3`, a.chipC >= 3, r1(a.chipC));
            ok(`${tag} — composeur : texte ≥ 4.5`, a.input && a.input.contrast >= 4.5, r1(a.input && a.input.contrast));
            ok(`${tag} — composeur : placeholder ≥ 3`, a.input && a.input.phContrast >= 3, r1(a.input && a.input.phContrast));
            ok(`${tag} — toast : --toast-bg + contraste ≥ 4.5`, a.toast && a.toast.bgMatch && a.toast.contrast >= 4.5, r1(a.toast && a.toast.contrast));
            ok(`${tag} — surlignage recherche == --hl-bg`, a.hlMatch === true);
            ok(`${tag} — badge rôle admin == --role-admin-text`, a.roleMatch === true);
            ok(`${tag} — bg-blue-600 == --accent (+ fg)`, a.accentFill && a.accentFill.bgMatch && a.accentFill.fgMatch);
            ok(`${tag} — ring-blue-500 == --accent-ring`, a.ringMatch === true);
            ok(`${tag} — accent-color body == --accent`, a.bodyAccentMatch === true);
            if (wantMarker) ok(`${tag} — lissage antialiased (surface sombre)`, a.fontSmoothing === 'antialiased', a.fontSmoothing);
        }
    }

    // ════ Smoke console admin (page autonome, skinnée depuis le correctif) ═══
    for (const combo of [{ skin: 'elpis', dark: false }, { skin: 'emeraude', dark: false }, { skin: '', dark: true }]) {
        const tag = `admin ${combo.skin || 'ardoise'}${combo.dark ? '/sombre' : '/clair'}`;
        await setConfig(combo.skin, combo.dark);
        await fastGoto('/admin');
        const a = await page.evaluate(`(() => {
            const cv = document.createElement('canvas'); cv.width = cv.height = 1;
            const cx = cv.getContext('2d', { willReadFrequently: true });
            const toRGBA = (css) => { cx.clearRect(0,0,1,1); cx.fillStyle = '#000'; cx.fillStyle = String(css || ''); cx.fillRect(0,0,1,1); const d = cx.getImageData(0,0,1,1).data; return [d[0], d[1], d[2], d[3]/255]; };
            const vr = (name, host) => { const p = document.createElement('div'); p.style.color = 'var(' + name + ')'; p.style.display = 'none'; (host || document.body).appendChild(p); const c = toRGBA(getComputedStyle(p).color); p.remove(); return c; };
            const same = (a, b) => a && b && Math.abs(a[0]-b[0]) <= 2 && Math.abs(a[1]-b[1]) <= 2 && Math.abs(a[2]-b[2]) <= 2;
            const aside = document.querySelector('aside.elpis-slide-panel');
            return {
                classes: Array.from(document.body.classList),
                bodyBgMatch: same(toRGBA(getComputedStyle(document.body).backgroundColor), vr('--app-bg')),
                railBgMatch: aside ? same(toRGBA(getComputedStyle(aside).backgroundColor), vr('--rail-bg', aside)) : null,
            };
        })()`);
        await page.screenshot({ path: `${SHOTS}/admin-${combo.skin || 'ardoise'}${combo.dark ? '-dark' : ''}.png` });
        ok(`${tag} — classe skin posée`, combo.skin ? a.classes.includes('elpis-skin-' + combo.skin) : a.classes.includes('elpis-app-dark'), a.classes.join(' '));
        ok(`${tag} — fond body == --app-bg`, a.bodyBgMatch === true);
        ok(`${tag} — rail admin == --rail-bg`, a.railBgMatch === true);
    }

    // ════ Skin IMPORTÉ : feuille liée à la demande, retirée au changement ═══
    await setConfig('test-plugin', false);
    await fastGoto('/');
    const pl = await page.evaluate(() => {
        const link = document.getElementById('elpis-plugin-skin');
        const cs = getComputedStyle(document.body);
        const brand = document.querySelector('aside.elpis-slide-panel span.text-white.truncate');
        return { href: link ? link.getAttribute('href') : '', classes: Array.from(document.body.classList),
                 accent: cs.getPropertyValue('--accent').trim(), radiusXl: cs.getPropertyValue('--radius-xl').trim(),
                 brand: brand ? brand.textContent.trim() : '' };
    });
    ok('plugin — <link id=elpis-plugin-skin> vers css_url', pl.href === '/api/skins/test-plugin/skin.css?v=1', pl.href);
    ok('plugin — classe elpis-skin-test-plugin posée', pl.classes.includes('elpis-skin-test-plugin'), pl.classes.join(' '));
    ok('plugin — jeton --accent appliqué', pl.accent === '#a21caf', pl.accent);
    ok('plugin — échelle des rayons redéclarée', /0\.9rem/.test(pl.radiusXl), pl.radiusXl);
    ok('plugin — marque du skin dans le rail', pl.brand === 'Plugin', pl.brand);
    await setConfig('elpis', false);
    await fastGoto('/');
    const sans = await page.evaluate(() => !document.getElementById('elpis-plugin-skin'));
    ok('plugin — feuille retirée avec un skin intégré', sans === true);

    // ════ Console › Système › Apparence : liste + formulaire + aperçu ═══════
    await setConfig('elpis', false);
    await fastGoto('/admin#appearance');
    await page.waitForSelector('#skins tbody tr', { timeout: 15000 });
    const nLignes = await page.$$eval('#skins tbody tr', (l) => l.length);
    ok('apparence — une ligne par skin', nLignes === SKINS.length + 1, nLignes);
    await page.click('#skins .adm-card__actions .adm-btn--primary');
    await page.waitForSelector('#skin-editor .skn-prev', { timeout: 15000 });
    const ed = await page.evaluate(() => {
        const acc = document.getElementById('skt---accent');
        const prev = document.querySelector('#skin-editor .skn-prev');
        return { accent: acc ? acc.value : '', prevAccent: prev ? prev.style.getPropertyValue('--accent').trim() : '',
                 classes: Array.from(document.body.classList) };
    });
    ok('apparence — jetons lus sur la base (accent non vide)', !!ed.accent, ed.accent);
    ok('apparence — aperçu porte les jetons en ligne', ed.prevAccent === ed.accent, ed.prevAccent + ' / ' + ed.accent);
    ok('apparence — classes <body> restaurées après lecture', ed.classes.includes('elpis-skin-elpis') && !ed.classes.includes('elpis-app-dark'), ed.classes.join(' '));
    await page.fill('#skt---accent', '#ff0000');
    const apres = await page.evaluate(() => document.querySelector('#skin-editor .skn-prev').style.getPropertyValue('--accent').trim());
    ok('apparence — aperçu en direct', apres === '#ff0000', apres);
    await page.screenshot({ path: `${SHOTS}/admin-apparence.png`, fullPage: false });

    ok('zéro pageerror sur les chargements', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} PASS — captures dans ${SHOTS}`);
if (fails.length) { console.log('ÉCHECS :'); fails.forEach(([, n]) => console.log('  ✗ ' + n)); process.exit(1); }
