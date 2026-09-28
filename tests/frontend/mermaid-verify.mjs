// SPDX-License-Identifier: MIT
// Vérifie le rendu Mermaid ET son chargement paresseux, route-mock :
//   PERF_PORT=8918 node tests/frontend/mermaid-server.mjs &
//   PERF_PORT=8918 node tests/frontend/mermaid-verify.mjs
//
// mermaid.min.js pèse 2 894 Ko — 72 % des 4,0 Mo de vendor que la page
// chargeait à chaque ouverture, pour une fonctionnalité qui ne sert que si un
// message contient un diagramme. Ce fichier verrouille les deux moitiés du
// contrat : la lib N'ARRIVE PAS quand elle est inutile, et elle arrive bien —
// avec un diagramme réellement peint — quand elle sert.
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// Trace les requêtes réseau vers le bundle mermaid : la preuve directe qu'il
// n'est pas téléchargé tant qu'il ne sert à rien.
const mermaidHits = [];
page.on('request', (r) => { if (/mermaid\.min\.js/.test(r.url())) mermaidHits.push(r.url()); });

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée', true);

    // ── 1. Sans diagramme : mermaid ne doit pas être chargé ───────────────
    await page.locator('text=Sans diagramme').first().click();
    await page.waitForTimeout(1200);
    // Le bloc ```js``` est transformé en carte de code (pas un <pre> nu) :
    // on vérifie le CONTENU, seule chose qui compte ici — la page a bien
    // rendu un message, donc le pipeline de rendu est passé.
    ok('chat sans diagramme rendu',
       await page.evaluate(() => /const x = 1/.test(document.body.innerText)));
    ok('mermaid PAS téléchargé sur un chat sans diagramme', mermaidHits.length === 0);
    ok('window.mermaid absent à ce stade',
       await page.evaluate(() => typeof window.mermaid === 'undefined'));

    // ── 2. Avec diagramme : mermaid arrive et le SVG est peint ────────────
    await page.locator('text=Avec diagramme').first().click();
    await page.waitForFunction(() => !!document.querySelector('.mermaid-render svg'),
                               null, { timeout: 20000 }).catch(() => {});

    ok('mermaid téléchargé une fois le diagramme à l’écran', mermaidHits.length >= 1);
    ok('téléchargé UNE seule fois (mémoïsation)', mermaidHits.length === 1);
    ok('carte de diagramme rendue',
       await page.locator('.mermaid-render').first().isVisible().catch(() => false));

    const svg = await page.evaluate(() => {
        const el = document.querySelector('.mermaid-render svg');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height),
                 nodes: el.querySelectorAll('g').length };
    });
    ok('SVG présent dans la carte', !!svg);
    ok('SVG a des dimensions réelles', !!svg && svg.w > 40 && svg.h > 20);
    ok('SVG contient les nœuds du graphe', !!svg && svg.nodes >= 3);

    // Le repli en bloc de code ne doit PAS avoir été posé.
    ok('pas de repli « MERMAID » affiché',
       !(await page.locator('text=MERMAID').first().isVisible().catch(() => false)));

    // ── 3. Un second passage ne relance pas de téléchargement ─────────────
    await page.locator('text=Sans diagramme').first().click();
    await page.waitForTimeout(400);
    await page.locator('text=Avec diagramme').first().click();
    await page.waitForTimeout(1500);
    ok('aller-retour entre chats : toujours un seul téléchargement', mermaidHits.length === 1);
    ok('diagramme toujours peint après retour',
       await page.evaluate(() => !!document.querySelector('.mermaid-render svg')));

    ok('aucune erreur JS de page', errors.length === 0);
    ok('aucune erreur console liée à mermaid',
       !consoleErrors.some((t) => /mermaid/i.test(t)));
    if (errors.length) console.log('   page errors:', errors.slice(0, 3));
    if (consoleErrors.length) console.log('   console:', consoleErrors.slice(0, 3));
} finally {
    await browser.close();
}

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(fails.length ? 1 : 0);
