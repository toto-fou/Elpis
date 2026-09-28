// SPDX-License-Identifier: MIT
// Garde-fou du MODE SOMBRE (audit 2026-09-07) — 6 skins × mode sombre, sur
// une conversation RICHE (blocs de code, tableau, citation, cartes d'outils,
// bandeaux, message en erreur) puis panneau Outils et modale Paramètres.
//
//   PERF_PORT=8912 node tests/frontend/darkmode-server.mjs &
//   PERF_PORT=8912 node tests/frontend/darkmode-verify.mjs
//
// Trois familles d'assertions, celles des défauts corrigés :
//
//   1. COUTURE DES BLOCS DE CODE — le cadre, l'en-tête et la zone de code
//      doivent former UNE surface. Avant : cadre #1e1e1e, en-tête #252526,
//      code #0d1117 → une bordure parasite visible entre le texte et le bloc.
//      Vérifié dans les DEUX modes : le bloc est sombre en clair aussi.
//   2. ÎLOTS CLAIRS — aucun élément à fond clair sur une page sombre, SAUF
//      un remplissage d'accent (un skin a le droit d'avoir un accent clair :
//      llamacpp inverse son primary en sombre, et l'encre suit --accent-fg).
//   3. CONTRASTE — aucun texte sous son seuil WCAG AA.
//
// La sonde DOM est partagée : tests/frontend/darkmode-sweep.js.
import fs from 'fs';
import { launch, BASE_URL } from '../perf/lib/harness.mjs';

const SWEEP = fs.readFileSync(new URL('./darkmode-sweep.js', import.meta.url), 'utf8');
const SKINS = ['', 'elpis', 'llamacpp', 'emeraude', 'parchemin', 'pingouins', 'kiki'];

const checks = [];
const ok = (name, cond, extra) => {
    checks.push([cond ? 'PASS' : 'FAIL', name]);
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : `   [${extra}]`));
};

// Un fond clair n'est légitime que sur un REMPLISSAGE D'ACCENT : c'est la
// couleur du skin (llamacpp inverse son primary en sombre) et l'encre posée
// dessus suit --accent-fg, dont la lisibilité est vérifiée par les assertions
// de contraste. La sonde compare la couleur RÉSOLUE aux tokens d'accent — pas
// les noms de classes, tronqués dans la signature.

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const config = (skin, dark) => fetch(BASE_URL + '/__config',
    { method: 'POST', body: JSON.stringify({ skin, dark_mode: dark }) });

async function ouvrirChat() {
    await page.goto(BASE_URL + '/');
    await page.waitForFunction(() => {
        const a = document.getElementById('app');
        return a && !a.hasAttribute('v-cloak');
    }, null, { timeout: 30000, polling: 100 });
    await page.waitForTimeout(900);
    await page.locator('text=Conversation témoin').first().click();
    await page.waitForTimeout(2500);   // markdown + hljs + cartes d'outils
}

// ⚠ `.first()` tombe souvent sur la variante REPLIÉE du rail (dans le DOM mais
// masquée) : on clique le premier candidat RÉELLEMENT visible.
async function clic(sel, ms = 700) {
    try {
        for (const c of await page.locator(sel).all()) {
            if (await c.isVisible().catch(() => false)) {
                await c.click({ timeout: 2500 });
                await page.waitForTimeout(ms);
                return true;
            }
        }
    } catch (_) {}
    return false;
}

try {
    for (const skin of SKINS) {
        const nom = skin || 'ardoise';
        await config(skin, true);
        await ouvrirChat();

        const zones = { chat: await page.evaluate(SWEEP) };
        if (await clic('[title="Outils"]')) zones.outils = await page.evaluate(SWEEP);
        await page.keyboard.press('Escape').catch(() => {});
        if (await clic('[title="Paramètres"]', 1100)) zones.parametres = await page.evaluate(SWEEP);
        await page.keyboard.press('Escape').catch(() => {});

        for (const [zn, z] of Object.entries(zones)) {
            const etiq = `${nom}/sombre/${zn}`;

            ok(`${etiq} — la page est bien sombre`, z.pageL < 0.30, `L=${z.pageL} ${z.pageBg}`);

            const ilots = Object.entries(z.light).filter(([, i]) => !i.accent);
            ok(`${etiq} — aucun îlot clair hors remplissage d'accent`, ilots.length === 0,
               ilots.map(([s, i]) => `${s} ${i.bg}`).join(' | ').slice(0, 220));

            const ko = Object.entries(z.contrast);
            ok(`${etiq} — tout le texte au-dessus du seuil AA`, ko.length === 0,
               ko.map(([s, i]) => `${s} ${i.ratio}/${i.need} ${i.fg}·${i.bg}`).join(' | ').slice(0, 220));

            if (zn === 'chat') {
                ok(`${etiq} — des blocs de code sont bien rendus`, z.seams.length > 0,
                   `n=${z.seams.length}`);
                const couture = z.seams.filter((s) => s.ecart_code !== 0);
                ok(`${etiq} — bloc de code SANS couture (cadre == fond du code)`,
                   couture.length === 0,
                   couture.map((s) => `cadre ${s.wrapper} ≠ code ${s.code}`).join(' | '));
                const enTete = z.seams.filter((s) => s.ecart_header !== null && s.ecart_header > 0.02);
                ok(`${etiq} — en-tête du bloc dans la MÊME famille que le fond`,
                   enTete.length === 0,
                   enTete.map((s) => `${s.wrapper} vs ${s.header} (Δ${s.ecart_header})`).join(' | '));
            }
        }
    }

    // Le bloc de code est sombre dans les DEUX modes (thème hljs github-dark
    // seul vendorisé) : la continuité de surface doit donc tenir en clair.
    for (const skin of ['', 'parchemin']) {
        const nom = skin || 'ardoise';
        await config(skin, false);
        await ouvrirChat();
        const z = await page.evaluate(SWEEP);
        const couture = z.seams.filter((s) => s.ecart_code !== 0);
        ok(`${nom}/clair — bloc de code SANS couture`, couture.length === 0,
           couture.map((s) => `cadre ${s.wrapper} ≠ code ${s.code}`).join(' | '));
    }

    ok('aucune erreur JS de page', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
    await browser.close();
}

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
if (fails.length) for (const [, n] of fails) console.log(`  ✗ ${n}`);
process.exit(fails.length ? 1 : 0);
