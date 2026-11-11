// SPDX-License-Identifier: MIT
// Vérif : BARRE DE PROGRESSION DU CHARGEMENT, dans la barre de prompt.
//   PERF_PORT=8933 node tests/frontend/model-load-percent-server.mjs &
//   PERF_PORT=8933 node tests/frontend/model-load-percent-verify.mjs
//   PERF_PORT=8934 LOAD_LEGACY=1 node ...-server.mjs &
//   PERF_PORT=8934 LOAD_LEGACY=1 node ...-verify.mjs
//
// Le chargement d'un modèle ne se voyait que dans le MENU du sélecteur, sous
// forme de roue — or le menu se referme et un chargement dure des dizaines de
// secondes. La progression vit maintenant dans la barre de prompt, à côté du
// nom du modèle : elle occupe sa place le temps du chargement, puis disparaît.
// Un moteur qui ne donne pas la progression n'affiche AUCUNE barre (rien
// d'inventé) — c'est la seconde exécution.
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const LEGACY = process.env.LOAD_LEGACY === '1';
const SHOTS = process.env.SHOTS_DIR || '/tmp/model-load-percent-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

// État de la barre : présence, pourcentage annoncé, largeur réelle, et
// voisinage immédiat du sélecteur de modèle (c'est LE point de l'exercice).
const barre = () => {
    const b = document.querySelector('#app [role="progressbar"]');
    if (!b) return null;
    // ⚠ Pas ``div > div`` : la PISTE aussi est un div enfant de ``b``, et
    // c'est elle qui sortirait la première. On vise le remplissage par sa
    // largeur en ligne, qui est justement ce qu'on veut mesurer.
    const rempli = b.querySelector('div[style*="width"]');
    const chip = document.querySelector('#app button[aria-haspopup="listbox"]');
    return {
        pct: Number(b.getAttribute('aria-valuenow')),
        txt: (b.textContent || '').trim(),
        largeur: rempli ? rempli.style.width : '',
        voisine: !!(chip && b.parentElement === chip.parentElement.parentElement),
        label: b.getAttribute('aria-label') || '',
    };
};

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(25000);
    await gotoApp(page, '/');

    const chip = page.locator('#app button[aria-haspopup="listbox"]').first();
    await chip.waitFor({ state: 'visible' });
    ok('la barre de prompt affiche le sélecteur de modèle', true);
    ok('au repos : aucune barre de progression', (await page.evaluate(barre)) === null);

    // ════ Déclencher le chargement depuis le menu ═══════════════════════
    await chip.click();
    await page.locator('#app button[title="Charger"]').first().waitFor({ state: 'visible' });
    await page.locator('#app button[title="Charger"]').first().click();

    if (!LEGACY) {
        // ════ Moteur récent : la barre apparaît à côté du modèle ════════
        await page.waitForFunction(
            () => !!document.querySelector('#app [role="progressbar"]'), { timeout: 20000 });
        const b1 = await page.evaluate(barre);
        ok(`une barre apparaît, à ${b1.pct} %`, b1.pct > 0);
        ok('elle est bien VOISINE du sélecteur de modèle dans la barre de prompt',
           b1.voisine);
        ok(`sa largeur suit le pourcentage (${b1.largeur})`,
           b1.largeur === b1.pct + '%');
        ok('elle nomme le modèle chargé (lecteurs d’écran)',
           /Qwen3\.8-27B-long/.test(b1.label));
        await page.screenshot({ path: `${SHOTS}/prompt-bar-running.png` }).catch(() => {});

        // ════ Elle progresse ════════════════════════════════════════════
        await page.waitForFunction((seuil) => {
            const b = document.querySelector('#app [role="progressbar"]');
            return !!b && Number(b.getAttribute('aria-valuenow')) > seuil;
        }, b1.pct, { timeout: 20000 });
        const b2 = await page.evaluate(barre);
        ok(`elle PROGRESSE réellement (${b1.pct} % → ${b2.pct} %)`, b2.pct > b1.pct);
        ok('le pourcentage est affiché en clair', /\d+%/.test(b2.txt));
    } else {
        // ════ Moteur ancien : rien d'inventé ════════════════════════════
        await page.waitForTimeout(3000);
        ok('moteur ancien : AUCUNE barre (rien n’est inventé)',
           (await page.evaluate(barre)) === null);
        const roue = await page.evaluate(() => {
            const b = [...document.querySelectorAll('#app button')]
                .find(e => (e.getAttribute('title') || '') === 'Décharger'
                        || (e.getAttribute('title') || '') === 'Charger');
            return !!(b && b.querySelector('.animate-spin'));
        });
        ok('moteur ancien : la roue du menu dit « en cours »', roue);
        await page.screenshot({ path: `${SHOTS}/prompt-bar-legacy.png` }).catch(() => {});
    }

    // ════ Fin : la barre rend sa place ══════════════════════════════════
    await page.waitForFunction(
        () => !document.querySelector('#app [role="progressbar"]'), { timeout: 30000 });
    ok('la barre disparaît une fois le modèle chargé et rend sa place', true);

    if (!LEGACY) {
        // ════ Déchargement : la barre pleine ne doit PAS ressusciter ════
        // Signalé en usage : décharger un modèle rallumait la barre à 100 %,
        // vestige du chargement précédent. Un déchargement n'a aucune
        // progression à montrer.
        // ⚠ Le menu est resté OUVERT pendant tout le chargement : re-cliquer
        // la puce le refermerait. On ne l'ouvre que s'il est fermé.
        const dejaOuvert = await page.evaluate(
            () => !!document.querySelector('#app button[title="Décharger"]'));
        if (!dejaOuvert) await chip.click();
        const btnDecharger = page.locator('#app button[title="Décharger"]').first();
        await btnDecharger.waitFor({ state: 'visible' });
        await btnDecharger.click();
        // Fenêtre de confirmation : le bouton porte le libellé « Décharger ».
        await page.getByRole('button', { name: 'Décharger', exact: true })
            .last().click();
        await page.waitForTimeout(2500);
        ok('déchargement : AUCUNE barre fantôme à 100 %',
           (await page.evaluate(barre)) === null);

        // La roue du sélecteur doit S'ARRÊTER. Le finally du déchargement
        // appelait une variable d'une AUTRE portée : la ReferenceError
        // l'interrompait avant ``isLoadingModel = false``, et la roue
        // tournait indéfiniment sur un modèle pourtant déchargé.
        // ⚠ Confirmer la modale referme le menu du sélecteur (clic hors
        // zone) : on le rouvre pour aller regarder la ligne du modèle.
        await page.waitForTimeout(3000);
        await chip.click();
        await page.waitForFunction(() => {
            const b = [...document.querySelectorAll('#app button')]
                .find(e => /^(Charger|Décharger)$/.test(e.getAttribute('title') || ''));
            return !!b && !b.querySelector('.animate-spin') && !b.disabled;
        }, { timeout: 25000 });
        ok('déchargement : la roue du sélecteur s’arrête bien', true);
        await page.screenshot({ path: `${SHOTS}/prompt-bar-unload.png` }).catch(() => {});
    }

    await page.evaluate(() => {
        const c = document.querySelector('#app button[aria-haspopup="listbox"]');
        return c && c.offsetWidth > 0;
    }).then(v => ok('le sélecteur de modèle est toujours là, intact', !!v));
    await page.screenshot({ path: `${SHOTS}/prompt-bar-done.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/prompt-bar-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nmodel-load-percent-verify${LEGACY ? ' (moteur ANCIEN)' : ''} : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
