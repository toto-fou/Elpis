// SPDX-License-Identifier: MIT
// Prouve que les menus du composeur et de la conversation ENTRENT et SORTENT
// en animation — et que la préférence système coupe bien le mouvement.
//
//   node tests/perf/perf-server.mjs &          (port 8901, ou PERF_PORT)
//   node tests/frontend/transitions-verify.mjs
//
// Ce que ce test apporte face aux tests statiques
// ===============================================
// `tests/shared_infra/test_transitions_declarees.py` garantit que les classes
// CSS existent, et `test_tailwind_arbitrary_utilities.py` qu'elles compilent.
// Aucun des deux ne dit si le `<Transition>` enveloppe le BON élément : Vue
// n'accepte qu'un enfant unique, et un wrapper mal posé se solde par un
// avertissement en console et un menu qui n'anime pas — ou pire, qui ne
// s'ouvre plus. C'est ce câblage-là qu'on vérifie ici, dans le navigateur.
import { launch, gotoApp, configureServer } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (n, c, detail = '') => {
    checks.push([c ? 'PASS' : 'FAIL', n]);
    if (!c) console.log('  ✗ ' + n + (detail ? '  — ' + detail : ''));
};

// Enregistre les classes `*-enter-active` / `*-leave-active` que Vue pose au
// fil des transitions. Un simple `querySelector` raterait la fenêtre : la
// classe d'entrée ne vit qu'une frame avant d'être remplacée.
const RECORDER = () => {
    window.__tr = [];
    new MutationObserver((muts) => {
        for (const m of muts) {
            const cl = m.target.className;
            if (typeof cl !== 'string') continue;
            for (const c of cl.split(/\s+/)) {
                if (/-(enter|leave)-active$/.test(c) && !window.__tr.includes(c)) {
                    window.__tr.push(c);
                }
            }
        }
        // `document` et non `document.documentElement` : le script d'init
        // s'exécute avant que l'élément racine existe.
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
};

async function joue(page, { ouvrir, menu, attendu, libelle }) {
    await page.evaluate(() => { window.__tr = []; });
    await page.locator(ouvrir).locator('visible=true').first().click();
    await page.waitForTimeout(400);
    const visible = await page.locator(menu).count() > 0;
    // Refermer par un clic AILLEURS, pas par la bascule : le menu de
    // conversation pose un voile plein écran qui intercepte tout, et c'est
    // ainsi que l'utilisateur le referme.
    await page.mouse.click(900, 150);
    await page.waitForTimeout(60);
    const pendantSortie = await page.locator(`${menu}.${attendu}-leave-active`).count();
    await page.waitForTimeout(500);
    const partiApres = await page.locator(menu).count() === 0;
    const vues = await page.evaluate(() => window.__tr);
    return { libelle, visible, pendantSortie, partiApres, vues };
}

const MENUS = [
    { libelle: 'menu « + » du composeur',
      ouvrir: 'button[title="Plus d\'actions"]',
      menu: 'div.absolute.bottom-full.w-60',
      attendu: 'popover-up' },
    { libelle: 'menu de la conversation',
      ouvrir: 'button[title="Menu de la conversation"]',
      menu: 'div.absolute.right-0.top-full.w-48',
      attendu: 'popover' },
];

for (const mouvement of ['no-preference', 'reduce']) {
    const h = await launch({ reducedMotion: mouvement, cpuRate: 1 });
    const bavardages = [];
    h.page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') bavardages.push(m.text());
    });
    try {
        await configureServer({ reply: 'short', toks: 60, chat: 'long40' });
        await h.page.addInitScript(RECORDER);
        await gotoApp(h.page);
        // La deuxième page a besoin d'un chat ouvert pour que le menu de
        // conversation existe.
        await h.page.locator('text=Chat long 40 messages').first().click().catch(() => {});
        await h.page.waitForTimeout(1200);

        for (const m of MENUS) {
            const r = await joue(h.page, m);
            ok(`[${mouvement}] ${r.libelle} : s'ouvre`, r.visible);
            ok(`[${mouvement}] ${r.libelle} : refermé, l'élément a bien disparu`, r.partiApres);
            if (mouvement === 'no-preference') {
                ok(`[${mouvement}] ${r.libelle} : entrée animée (${m.attendu})`,
                   r.vues.includes(`${m.attendu}-enter-active`), r.vues.join(', '));
                ok(`[${mouvement}] ${r.libelle} : sortie animée, encore présent 60 ms après`,
                   r.pendantSortie === 1, `présents: ${r.pendantSortie}`);
            } else {
                // Sous `reduce`, la durée tombe à 0,01 ms : l'élément ne doit
                // PAS s'attarder. C'est la contrepartie du mouvement.
                ok(`[${mouvement}] ${r.libelle} : sortie immédiate (pas d'attente)`,
                   r.pendantSortie === 0, `présents: ${r.pendantSortie}`);
            }
        }
        const vueWarn = bavardages.filter((t) => /Transition|expects exactly one/i.test(t));
        ok(`[${mouvement}] aucun avertissement Vue sur les transitions`,
           vueWarn.length === 0, vueWarn.slice(0, 2).join(' | '));
        ok(`[${mouvement}] aucune erreur de page`, h.errors.length === 0,
           h.errors.slice(0, 2).join(' | '));
    } finally {
        await h.browser.close();
    }
}

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(fails.length ? 1 : 0);
