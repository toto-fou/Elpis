// SPDX-License-Identifier: MIT
// Vérif du centre de notifications (route-mock, sans backend) :
//   PERF_PORT=8904 node tests/frontend/notif-server.mjs &
//   PERF_PORT=8904 node tests/frontend/notif-verify.mjs
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const bodyHas = async (re) => re.test(await page.locator('#app').innerText().catch(() => ''));
const htmlHas = async (re) => re.test(await page.locator('#app').innerHTML().catch(() => ''));

try {
    page.setDefaultTimeout(8000);
    // gotoApp ne rend la main que si #app perd v-cloak → preuve que TOUS les
    // templates Vue compilent (panneau notif réécrit + toggle réglages inclus).
    await gotoApp(page, '/');
    ok('app montée (sidebar + settings compilent)', true);

    // Badge non-lus initial (1 notif non-lue au boot).
    ok('badge non-lus initial visible', await htmlHas(/notification\(s\) non lue/));

    // ── Toast à l'arrivée d'une notif SSE ──────────────────────────────
    await fetch(BASE_URL + '/__inject');
    await page.waitForTimeout(700);
    ok('toast affiché à l\'arrivée', await bodyHas(/Nightly/));
    ok('toast porte l\'action « Voir »', await page.locator('button:has-text("Voir"):visible').first().isVisible().catch(() => false));

    // ── Ouverture du panneau ───────────────────────────────────────────
    // La cloche du pied de sidebar (title="Notifications" ou compteur).
    await page.locator('button[title*="otification"]:visible').first().click();
    await page.waitForTimeout(500);
    ok('panneau ouvert (titre Notifications)', await bodyHas(/Notifications/));
    // En-tête de groupe : classe .uppercase → innerText en MAJ (regex insensible).
    ok('groupement par date (Aujourd\'hui)', await bodyHas(/aujourd'hui/i));
    ok('item scénario présent', await bodyHas(/Scénario « Login »/));
    ok('item routine présent', await bodyHas(/Backup/));
    ok('icône erreur (rouge) rendue', await htmlHas(/ph-warning-circle/));
    ok('icône succès (vert) rendue', await htmlHas(/ph-check-circle/));

    // ── Deep-link au clic : item routine → page Routines ───────────────
    await page.locator('div[role="button"]:has-text("Backup")').first().click();
    await page.waitForTimeout(700);
    ok('deep-link routine → page Routines', await bodyHas(/Routines|Nouvelle routine|routine/i));

    // ── Réglage « Notifications système » (opt-in) ─────────────────────
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.waitForTimeout(400);
    ok('modal réglages ouvert', await bodyHas(/Préférences|Profil/));
    // Onglet « Chat » — scopé au modal (sinon « Nouveau chat » matcherait ailleurs).
    const dialog = page.locator('div[role="dialog"][aria-label="Paramètres"]');
    await dialog.locator('button:has-text("Chat")').first().click().catch(() => {});
    await page.waitForTimeout(300);
    ok('onglet Chat actif (Masquer le raisonnement)', await bodyHas(/Masquer le raisonnement/));
    ok('réglage « Notifications système » présent', await bodyHas(/Notifications système/));

    ok('aucune erreur JS de page', errors.length === 0);
    if (errors.length) console.log('  erreurs:', errors.slice(0, 5));
} catch (e) {
    ok('exécution sans exception', false);
    console.log('  ! ' + String(e && e.message || e).split('\n')[0]);
} finally {
    await browser.close();
}

const pass = checks.filter(c => c[0] === 'PASS').length;
console.log(`\n${pass}/${checks.length} checks PASS`);
checks.forEach(([s, n]) => console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}`));
process.exit(pass === checks.length ? 0 : 1);
