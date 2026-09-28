// SPDX-License-Identifier: MIT
// La console d'administration doit survivre à une réponse d'API incomplète.
//
//   node tests/perf/perf-server.mjs &          (port 8901, ou PERF_PORT)
//   node tests/frontend/admin-degrade-verify.mjs
//
// Pourquoi ce test utilise le serveur du harnais PERF et pas `admin-server.mjs`
// ===========================================================================
// `perf-server.mjs` répond `{}` à toute route `/api/` qu'il ne connaît pas.
// C'est exactement le cas dégradé qu'on veut éprouver : un backend plus
// ancien, une réponse d'erreur, un payload partiel. Le serveur d'admin, lui,
// répond toujours des données parfaites — il ne peut pas révéler ce défaut.
//
// Ce qu'on vérifie
// ================
// `dashboardData` est initialisé à `{ layout: [], data: {} }` et tout
// `app-admin.js` compte sur cette forme : les lecteurs se gardent
// (`|| []`, `if (!layout) return []`). Mais `loadAdminStats` écrivait la
// réponse TELLE QUELLE, et `renderDynamicDashboard` était le seul à ne pas se
// garder → `layout.forEach` sur `undefined`, à chaque tour de rafraîchissement.
// Relevé par le scénario `e_idle` en variante admin : 8 erreurs sur 30 s de
// repos, c'est-à-dire une boucle.
import { launch, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (n, c, detail = '') => {
    checks.push([c ? 'PASS' : 'FAIL', n]);
    if (!c) console.log('  ✗ ' + n + (detail ? '  — ' + detail : ''));
};

const h = await launch({ reducedMotion: 'reduce', cpuRate: 1 });
const erreurs = [];
h.page.on('pageerror', (e) => erreurs.push(String((e && e.message) || e)));
try {
    await h.page.goto(BASE_URL + '/admin.html');
    // Laisser passer plusieurs tours du rafraîchissement périodique : le
    // symptôme d'origine se répétait à chaque tour, pas une seule fois.
    await h.page.waitForTimeout(9000);

    ok('admin : aucune erreur JS malgré des réponses d\'API vides',
       erreurs.length === 0, erreurs.slice(0, 3).join(' | '));
    ok('admin : rien qui ressemble à une lecture sur undefined',
       !erreurs.some((e) => /of undefined|of null/.test(e)),
       erreurs.filter((e) => /undefined|null/.test(e)).slice(0, 2).join(' | '));

    const monte = await h.page.evaluate(() => {
        const a = document.getElementById('app');
        return !!a && !a.hasAttribute('v-cloak');
    });
    ok('admin : l\'application est tout de même montée', monte);
} finally {
    await h.browser.close();
}

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(fails.length ? 1 : 0);
