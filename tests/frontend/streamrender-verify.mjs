// SPDX-License-Identifier: MIT
// Garde-fou du RENDU DE STREAM (AUDIT 2026-08-31) — trois régressions que
// rien ne vérifiait, chacune vécue en prod :
//
//   1. hljs pendant le stream : un fence qui n'OUVRE pas le bloc actif
//      (« Voici : » + ``` sans ligne vide) partait dans marked →
//      renderer.code → hljs.highlight/highlightAuto ~9×/s sur un bloc qui
//      grossit. Fix : window.elpisHljsOff pendant le rendu actif.
//   2. Garde-fou 12 Ko : un bloc de code long basculait en texte brut
//      (div pre-wrap, ``` visibles, police de prose) jusqu'à la fin du
//      stream. Fix : chemin fence testé AVANT la limite + découpe
//      prose/fence pour les gros blocs mixtes.
//   3. Caret : le span frère des wrappers display:contents tombait dans une
//      boîte anonyme UNE LIGNE SOUS le texte. Fix : injection DANS le
//      dernier élément (_injectCaret) — le span du gabarit n'est qu'un repli.
//
// Vérifie aussi la survie du DOM ENRICHI (boutons Copier, data-cb-done) à
// l'ouverture/fermeture de la RECHERCHE in-chat : la bascule réécrit
// l'innerHTML des lignes (v-memo) et détruisait graphiques et boutons sans
// restauration (fix : watch messageSearchActive/messageSearchQ →
// addCodeCopyButtons).
//
//   node tests/perf/perf-server.mjs &          (port 8901, ou PERF_PORT)
//   node tests/frontend/streamrender-verify.mjs
import { launch, gotoApp, wrapLibs, configureServer, sendAndWaitStream } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (n, c, detail = '') => {
    checks.push([c ? 'PASS' : 'FAIL', n]);
    if (!c) console.log('  ✗ ' + n + (detail ? '  — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IN_STREAM = 'button[title="Arrêter la génération"], textarea[disabled]';

const h = await launch();
try {
    await gotoApp(h.page);

    // ── Étape 1 : amorce — un bloc code CLASSIQUE charge hljs (lazy) ──────
    // toks modéré : un stream trop court se termine avant que
    // sendAndWaitStream ait pu observer l'état « en cours ».
    await configureServer({
        reply: 'custom', toks: 120, chat: null,
        custom: 'Amorce :\n\n```js\nconst a = 1;\n```\n\nfin.',
    });
    await sendAndWaitStream(h.page, 'amorce');
    await h.page.waitForFunction(() => !!window.hljs, null, { timeout: 20000, polling: 200 });
    await wrapLibs(h.page);
    await h.page.evaluate(() => {
        window.__perf = window.__perf || {};
        __perf.hl = { n: 0, ms: 0, max: 0 };
        __perf.hlAuto = { n: 0, ms: 0, max: 0 };
        __perf.parse = __perf.parse || { n: 0, ms: 0, max: 0 };
    });

    // ── Étape 2 : prose + fence SANS ligne vide, bloc > 12 Ko ─────────────
    const gros = 'Voici le script :\n```python\n'
        + Array.from({ length: 700 },
            (_, i) => `def f_${i}(x):\n    return x * ${i}  # commentaire`).join('\n')
        + '\n```\nEt voilà le résultat final.';
    await configureServer({ custom: gros, toks: 1500 });

    const ta = h.page.locator('textarea[placeholder]').last();
    await ta.fill('go');
    await h.page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await h.page.waitForFunction((sel) => !!document.querySelector(sel),
        IN_STREAM, { timeout: 10000, polling: 100 });

    const acc = { ticks: 0, caret: 0, caretInjecte: 0, prewrap: 0, spans: 0 };
    for (let i = 0; i < 400; i++) {
        const s = await h.page.evaluate((sel) => {
            const out = { streaming: !!document.querySelector(sel) };
            const bulle = document.querySelector('.markdown-body[aria-busy]');
            if (!bulle) return out;
            out.sampled = true;
            const caret = bulle.querySelector('.elpis-stream-caret');
            out.caret = !!caret;
            // injecté = à l'INTÉRIEUR d'un élément (p/pre/code…), pas frère
            // direct des wrappers dans .markdown-body.
            out.caretInjecte = !!(caret && caret.parentElement !== bulle);
            out.prewrap = !!bulle.querySelector('div[style*="pre-wrap"]');
            out.spans = bulle.querySelectorAll('[class*="hljs-"]').length;
            return out;
        }, IN_STREAM);
        if (!s.streaming) break;
        if (s.sampled) {
            acc.ticks++;
            if (s.caret) acc.caret++;
            if (s.caretInjecte) acc.caretInjecte++;
            if (s.prewrap) acc.prewrap++;
            acc.spans = Math.max(acc.spans, s.spans);
        }
        await sleep(150);
    }
    await h.page.waitForFunction((sel) => !document.querySelector(sel),
        IN_STREAM, { timeout: 120000, polling: 250 });

    console.log(`échantillons pendant le stream : ${acc.ticks} `
        + `(caret ${acc.caret}, injecté ${acc.caretInjecte}, `
        + `prewrap ${acc.prewrap}, max spans hljs ${acc.spans})`);

    ok('assez d\'échantillons en cours de stream (≥ 8)', acc.ticks >= 8,
       `ticks=${acc.ticks} — augmenter la taille du contenu ou baisser toks`);
    ok('le bloc actif ne bascule JAMAIS en texte brut (garde 12 Ko)',
       acc.prewrap === 0, `${acc.prewrap} échantillons en pre-wrap`);
    ok('aucune coloration hljs dans la bulle PENDANT le stream',
       acc.spans === 0, `${acc.spans} spans`);
    ok('le caret est présent pendant le stream', acc.caret >= acc.ticks * 0.5,
       `${acc.caret}/${acc.ticks}`);
    ok('le caret est INJECTÉ dans le flux du texte (pas frère de bloc)',
       acc.caret > 0 && acc.caretInjecte >= acc.caret * 0.8,
       `${acc.caretInjecte}/${acc.caret}`);

    const hl = await h.page.evaluate(() => ({
        n: (__perf.hl ? __perf.hl.n : 0) + (__perf.hlAuto ? __perf.hlAuto.n : 0),
    }));
    // Le rendu FINAL colore (1-2 appels attendus) ; le bug en produisait un
    // par tick de rendu actif (~9/s × durée du stream).
    ok(`hljs quasi silencieux sur tout le tour (${hl.n} appels ≤ 6)`, hl.n <= 6,
       `n=${hl.n}`);

    const fin = await h.page.evaluate(() => ({
        colore: document.querySelectorAll('.markdown-body [class*="hljs-"]').length,
        cbDone: document.querySelectorAll('pre[data-cb-done]').length,
        copyBtn: document.querySelectorAll('.copy-btn').length,
    }));
    ok('au repos, le code est bien coloré (les jetons hljs reviennent)',
       fin.colore > 0);
    ok('les blocs sont enrichis (data-cb-done + bouton Copier)',
       fin.cbDone > 0 && fin.copyBtn > 0,
       `cbDone=${fin.cbDone} copyBtn=${fin.copyBtn}`);

    // ── Étape 3 : la recherche ne détruit plus l'enrichissement ──────────
    // Pilotée par l'UI réELLE : menu de conversation → « Rechercher » →
    // saisie (le debounce du miroir messageSearchQ est de 250 ms).
    await h.page.locator('button[title="Menu de la conversation"]').click();
    await h.page.locator('button:has-text("Rechercher")').click();
    const searchInput = h.page.locator(
        'input[placeholder="Rechercher dans la conversation..."]');
    await searchInput.waitFor({ state: 'visible', timeout: 5000 });
    await searchInput.fill('script');
    await sleep(700);                       // debounce 250 ms + re-render + watch
    const pendant = await h.page.evaluate(() => ({
        copyBtn: document.querySelectorAll('.copy-btn').length,
        cbDone: document.querySelectorAll('pre[data-cb-done]').length,
    }));
    ok('boutons Copier SURVIVENT à la recherche active',
       pendant.copyBtn > 0 && pendant.cbDone > 0,
       `copyBtn=${pendant.copyBtn} cbDone=${pendant.cbDone}`);
    await searchInput.press('Escape');      // ferme la recherche (vide aussi)
    await sleep(300);
    const apres = await h.page.evaluate(() => ({
        copyBtn: document.querySelectorAll('.copy-btn').length,
        cbDone: document.querySelectorAll('pre[data-cb-done]').length,
        colore: document.querySelectorAll('.markdown-body [class*="hljs-"]').length,
    }));
    ok('enrichissement + coloration de retour à la FERMETURE de la recherche',
       apres.copyBtn > 0 && apres.cbDone > 0 && apres.colore > 0,
       JSON.stringify(apres));

    ok('aucune erreur JS de page', h.errors.length === 0,
       h.errors.slice(0, 2).join(' | '));
} finally {
    await h.browser.close();
}

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(fails.length ? 1 : 0);
