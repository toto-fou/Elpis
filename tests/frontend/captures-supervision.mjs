// SPDX-License-Identifier: MIT
// Captures du flux de supervision d'un tour (L5.3-L5.5), route-mock.
//   PERF_PORT=8916 node tests/frontend/supervision-server.mjs &
//   PERF_PORT=8916 CAPTURES=/chemin node tests/frontend/captures-supervision.mjs
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const DIR = process.env.CAPTURES || '.';
const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
await page.setViewportSize({ width: 1280, height: 900 });
const txt = (re) => page.waitForFunction((s) => new RegExp(s).test((document.getElementById('app') || {}).textContent || ''), re.source);
// Ouvre le conteneur « Travail de l'assistant » et ses groupes d'outils.
const ouvrir = () => page.evaluate(() => {
    document.querySelectorAll('details[data-pipeline], details[class*="toolwrap"]').forEach((d) => { d.open = true; });
});
const zone = () => page.locator('details[data-pipeline]').last();
try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    await page.locator('#app textarea').first().fill('Corrige parse_date pour les dates ISO.');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // 1. En cours : budget « tour 8/10 » (ambre), durée de read_file, 2e sous-agent en file.
    await txt(/En attente/);
    await page.waitForTimeout(400);
    await ouvrir();
    await page.waitForTimeout(300);
    await page.screenshot({ path: DIR + '/chat-1-en-cours.png' });

    // 2. Fin du tour : compression (déclenchement), durées, sorties retirées.
    await page.evaluate((b) => fetch(b + '/__resume'), BASE_URL);
    await txt(/les 3 tests passent/);
    await page.waitForTimeout(800);
    await ouvrir();
    await page.waitForTimeout(300);
    await page.screenshot({ path: DIR + '/chat-2-fin-du-tour.png' });
    // Détail du pas « compression du contexte ».
    await page.locator('text=compression du contexte').last().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: DIR + '/chat-3-compaction-detail.png' });

    // 3. « Détails » de la réponse.
    await page.locator('button[title*="Détails"], button[aria-label*="Détails"]').last().click();
    await txt(/Détails de l'exécution/);
    await page.waitForTimeout(500);
    await page.screenshot({ path: DIR + '/chat-4-details.png' });
    await page.locator('[aria-label="Détails de l\'exécution"] [aria-label="Fermer"]').first().click();
    await page.waitForTimeout(400);

    // 4. Rechargement : le pas de compaction est reconstruit à sa place.
    await page.locator('text=Supervision (rechargée)').first().click();
    await txt(/les 3 tests passent/);
    await page.waitForTimeout(800);
    await ouvrir();
    await page.waitForTimeout(300);
    await page.screenshot({ path: DIR + '/chat-5-apres-rechargement.png' });
    console.log('erreurs JS :', errors.length ? errors.slice(0, 5) : 'aucune');
} catch (e) {
    console.log('! ' + String(e && e.message || e).split('\n')[0]);
    await page.screenshot({ path: DIR + '/chat-echec.png' });
} finally {
    await browser.close();
}
