// SPDX-License-Identifier: MIT
// Occupation de contexte PERSISTÉE (2026-09-07) — vérification front sans
// backend : au chargement d'un chat dont ``GET /api/saved/chats/{id}`` porte
// ``ctx_usage``, la puce « ctx » sous le composeur affiche l'occupation
// restaurée ; un chat SANS ctx_usage n'en affiche pas ; aucune erreur JS.
// Couvre AUSSI les seuils de couleur de la jauge (kvColor, _models.js) : le
// palier « accent » — recoloré en or/terracotta par le skin Elpis, donc lu
// comme un avertissement — ne s'allume qu'à partir de 65 %.
//
//   node tests/frontend/ctxusage-verify.mjs      (lance perf-server lui-même)
import { spawn } from 'child_process';
import { launch, gotoApp, configureServer, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (n, c, detail = '') => {
    checks.push([c ? 'PASS' : 'FAIL', n]);
    if (!c) console.log('  ✗ ' + n + (detail ? '  — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// perf-server (mock API + statique) lancé ici, tué à la fin.
const srv = spawn(process.execPath, ['tests/perf/perf-server.mjs'], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
    try { await fetch(BASE_URL + '/api/public-config'); break; } catch (_) { await sleep(200); }
}

// Muté entre les cas : la route relit cette variable à chaque GET du chat.
let CTX = { used: 18400, total: 65536, pct: 28, model: 'qwen3', ts: 1 };
const h = await launch();
try {
    await configureServer({ reply: 'short', toks: 50, chats: ['long40', 'long100'] });
    // Injecte ctx_usage sur long40 SEULEMENT (long100 = chat jamais mesuré).
    await h.page.route('**/api/saved/chats/long40', async (route) => {
        const r = await route.fetch();
        const j = await r.json();
        j.ctx_usage = CTX;
        await route.fulfill({ json: j });
    });
    await gotoApp(h.page);

    const chip = () => h.page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('div'))
            .filter((d) => /\bctx$/.test((d.textContent || '').trim())
                          && d.querySelector('i.ph-database'));
        const el = els[els.length - 1];   // le plus PROFOND (les ancêtres finissent aussi par « ctx »)
        return el ? { text: (el.textContent || '').trim(), title: el.getAttribute('title') || '',
                      cls: el.className || '' } : null;
    });

    // Recharge long40 avec un ctx_usage donné (aller-retour = re-fetch).
    const rechargeAvec = async (pct) => {
        CTX = { used: Math.round(65536 * pct / 100), total: 65536, pct, model: 'qwen3', ts: 1 };
        await h.page.locator('text=Chat long 100 messages').first().click();
        await sleep(500);
        await h.page.locator('text=Chat long 40 messages').first().click();
        await sleep(800);
        return chip();
    };

    await h.page.locator('text=Chat long 40 messages').first().click();
    await sleep(900);
    const c1 = await chip();
    ok('puce « ctx » affichée après chargement d\'un chat avec ctx_usage', !!c1,
       JSON.stringify(c1));
    ok('la puce porte l\'occupation restaurée (18k / 66k)',
       !!c1 && /18[.,]?4?k/.test(c1.text) && /6[56][.,]?\d?k/.test(c1.text), c1 && c1.text);
    ok('le tooltip signale une valeur restaurée (28 %)',
       !!c1 && c1.title.includes('28 %') && c1.title.includes('restaurée'), c1 && c1.title);

    // Switch vers un chat SANS ctx_usage → la puce disparaît (pas d'héritage).
    await h.page.locator('text=Chat long 100 messages').first().click();
    await sleep(900);
    const c2 = await chip();
    ok('aucune puce sur un chat jamais mesuré (pas d\'héritage du chat précédent)',
       !c2, JSON.stringify(c2));

    // Retour sur long40 → la puce revient (re-seed à chaque chargement).
    await h.page.locator('text=Chat long 40 messages').first().click();
    await sleep(900);
    const c3 = await chip();
    ok('la puce revient au retour sur le chat mesuré', !!c3 && /ctx$/.test(c3.text),
       JSON.stringify(c3));

    // ── Seuils de couleur (demande user 2026-09-07) ────────────────────
    // Le palier « accent » (text-blue-600) est recoloré par chaque skin —
    // or/terracotta dans Elpis : il se LIT comme un avertissement. Il ne doit
    // pas s'allumer avant 65 % (il partait à 50 %).
    for (const [pct, attendu, libelle] of [
        [50, 'text-emerald-600', 'contexte à moitié plein → VERT (plus d\'accent à 50 %)'],
        [64, 'text-emerald-600', 'juste sous le seuil (64 %) → encore vert'],
        [65, 'text-blue-600',    'seuil atteint (65 %) → accent'],
        [80, 'text-amber-600',   '80 % → ambre'],
        [95, 'text-red-600',     '95 % → rouge'],
    ]) {
        const c = await rechargeAvec(pct);
        ok(`teinte de la jauge à ${pct} % : ${libelle}`,
           !!c && c.cls.includes(attendu),
           c ? `classes="${c.cls}"` : 'puce absente');
    }

    ok('aucune erreur JS de page', h.errors.length === 0, h.errors.slice(0, 2).join(' | '));
} finally {
    await h.browser.close();
    srv.kill();
}

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(fails.length ? 1 : 0);
