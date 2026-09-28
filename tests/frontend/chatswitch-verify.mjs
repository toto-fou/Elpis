// SPDX-License-Identifier: MIT
// Garde-fou de la COURSE DU SWITCH de conversation (AUDIT 2026-08-31, passe 2).
//
// ``loadChat`` assignait inconditionnellement après son await : sur deux clics
// rapides, la réponse la plus LENTE gagnait — l'utilisateur cliquait A puis B,
// voyait B s'afficher, puis A le REMPLAÇAIT quand sa (longue) réponse
// arrivait. Fix : jeton de séquence ``_loadChatSeq`` (_history.js) — seul le
// dernier demandé écrit. Ce verify rejoue exactement la course avec une
// latence artificielle par chat (perf-server, cfg.chatDelayMs).
//
//   node tests/perf/perf-server.mjs &          (port 8901, ou PERF_PORT)
//   node tests/frontend/chatswitch-verify.mjs
import { launch, gotoApp, configureServer } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (n, c, detail = '') => {
    checks.push([c ? 'PASS' : 'FAIL', n]);
    if (!c) console.log('  ✗ ' + n + (detail ? '  — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const h = await launch();
try {
    // A (long40) répond en 900 ms, B (long100) instantanément.
    await configureServer({
        reply: 'short', toks: 200,
        chats: ['long40', 'long100'],
        chatDelayMs: { long40: 900 },
    });
    await gotoApp(h.page);

    // Clic A (lent) puis IMMÉDIATEMENT clic B (rapide).
    await h.page.locator('text=Chat long 40 messages').first().click();
    await sleep(120);
    await h.page.locator('text=Chat long 100 messages').first().click();

    // B doit s'afficher tout de suite…
    await sleep(400);
    const avant = await h.page.evaluate(() =>
        document.querySelectorAll('[data-vs-idx]').length > 0
            ? (document.querySelector('.elpis-chat-title, header h1, [data-chat-title]')
               || {}).textContent || document.title : '');

    // …et Y RESTER après l'arrivée tardive de la réponse de A.
    await sleep(1200);
    const etat = await h.page.evaluate(() => {
        const t = (document.querySelector('.elpis-chat-title, header h1, [data-chat-title]') || {});
        const msgs = document.querySelectorAll('[data-vs-idx]').length;
        // Discriminant robuste : la virtualisation ne rend que la QUEUE de la
        // conversation — « Question 50 » (dernière de long100) est dans la
        // fenêtre si B est affiché ; « Question 20 » (dernière de long40) l'est
        // si la réponse lente de A a gagné.
        const corps = document.body.textContent || '';
        return {
            titre: t.textContent || '',
            msgs,
            aQ50: corps.includes('Question 50'),
            aQ20: corps.includes('Question 20 '),
        };
    });

    ok('une conversation est affichée après les deux clics', etat.msgs > 0,
       `msgs=${etat.msgs}`);
    ok('c\'est bien B (long100) qui reste affiché — la réponse LENTE de A ne '
       + 'l\'a pas remplacé', etat.aQ50 && !etat.aQ20,
       `titre="${(etat.titre || avant || '').trim()}" msgs=${etat.msgs} `
       + `aQ50=${etat.aQ50} aQ20=${etat.aQ20}`);
    ok('aucune erreur JS de page', h.errors.length === 0,
       h.errors.slice(0, 2).join(' | '));
} finally {
    await h.browser.close();
}

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(fails.length ? 1 : 0);
