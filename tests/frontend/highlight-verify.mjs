// SPDX-License-Identifier: MIT
// Coloration syntaxique : chargée à la demande, et la sanitisation ne dépend
// plus d'elle.
//
//   PERF_PORT=8905 node tests/frontend/codeblock-server.mjs &
//   PERF_PORT=8905 node tests/frontend/highlight-verify.mjs
//
// highlight.min.js pèse 118 Ko et ne sert qu'aux messages contenant du code.
// Deux contrats sont verrouillés ici :
//   • il n'est PAS téléchargé tant qu'aucun bloc de code n'est à l'écran, et le
//     code reste lisible entre-temps (rendu échappé) ;
//   • ``setupMarked`` enregistre le hook de sanitisation MÊME sans lui. La
//     garde portait auparavant sur les deux : une 404 sur highlight.min.js
//     suffisait à faire passer toute sortie de ``marked.parse()`` non assainie.
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (n, c) => { checks.push([c ? 'PASS' : 'FAIL', n]); if (!c) console.log('  ✗ ' + n); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const hits = [];
page.on('request', (r) => { if (/highlight\.min\.js/.test(r.url())) hits.push(r.url()); });

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    await page.waitForTimeout(1200);

    ok('hljs absent au premier rendu',
       await page.evaluate(() => typeof window.hljs === 'undefined'));
    ok('highlight.min.js pas téléchargé sans bloc de code', hits.length === 0);

    // ── La sanitisation ne dépend PAS de la coloration ────────────────────
    ok('le hook de sanitisation est enregistré sans hljs', await page.evaluate(() => {
        if (!window.marked) return false;
        const html = window.marked.parse('<img src=x onerror="alert(1)">\n\n<script>alert(2)<\/script>');
        return !/onerror/i.test(html) && !/<script/i.test(html);
    }));
    ok('un bloc de code sans hljs reste ÉCHAPPÉ, pas injecté', await page.evaluate(() => {
        const html = window.marked.parse('```html\n<script>alert(1)<\/script>\n```');
        return html.includes('&lt;script') && !/<script>alert/i.test(html);
    }));

    // ── Chargement à la demande ───────────────────────────────────────────
    await page.locator('text=Demo HTML').first().click();
    await page.waitForFunction(() => typeof window.hljs !== 'undefined',
                               null, { timeout: 20000 }).catch(() => {});
    ok('hljs chargé à l’ouverture d’un chat contenant du code', hits.length >= 1);
    ok('téléchargé une seule fois (mémoïsation)', hits.length === 1);

    await page.waitForTimeout(1500);
    const etat = await page.evaluate(() => {
        const code = document.querySelector('pre code.hljs');
        if (!code) return null;
        return {
            classes: code.className,
            jetons: code.querySelectorAll('span.hljs-tag, span.hljs-name, span[class^="hljs-"]').length,
            texte: (code.textContent || '').slice(0, 40),
        };
    });
    ok('un bloc de code est rendu', !!etat);
    ok('le bloc est effectivement coloré (jetons hljs)', !!etat && etat.jetons > 0);
    ok('le texte du code est intact', !!etat && etat.texte.includes('<'));

    ok('aucune erreur JS de page', errors.length === 0);
    if (errors.length) console.log('   ', errors.slice(0, 3));
} finally {
    await browser.close();
}

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(fails.length ? 1 : 0);
