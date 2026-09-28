// SPDX-License-Identifier: MIT
// Vérif du skin « kiki », route-mock, sans backend (même serveur que la mascotte) :
//   PERF_PORT=8931 node tests/frontend/mascotte-server.mjs &
//   PERF_PORT=8931 node tests/frontend/kiki-verify.mjs
//
// K1 : skin kiki → classe posée, le trio à l'accueil, le mot KIKI (aria-label).
// K2 : le rail dit « Kiki » et montre le trio animé ; un nom choisi l'emporte.
// K3 : chaque scénario se monte avec le trio et KIKI, sans erreur — captures
//      figées à un instant parlant (le vol de la dernière lettre, etc.).
// K4 : perchoir = le trio ; quitter le skin rend la mascotte choisie + ELPIS.
// K5 : sombre : fond et encre du mot suivent.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/kiki-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond, extra) => {
    checks.push([cond ? 'PASS' : 'FAIL', name]);
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : `   [${extra}]`));
};
const { browser, page, errors } = await launch({ reducedMotion: 'no-preference' });
const PROXY = 'document.getElementById("app").__vue_app__._container._vnode.component';
const setup = (k) => page.evaluate(`${PROXY}.setupState.${k}`);

try {
    page.setDefaultTimeout(10000);
    await fetch(BASE_URL + '/__cfg?skin=kiki');
    await gotoApp(page, '/');

    // ════ K1 ════════════════════════════════════════════════════════════
    ok('K1 classe elpis-skin-kiki posée',
       await page.evaluate(() => document.body.classList.contains('elpis-skin-kiki')));
    const scene = page.locator('#app .accueil').first();
    await scene.waitFor({ state: 'visible' });
    ok('K1 le skin impose le trio', (await setup('mascotteId')) === 'kiki');
    await page.waitForFunction(() => {
        const c = document.querySelector('#app .accueil canvas');
        return c && /^KIKI teams/.test(c.getAttribute('aria-label') || '');
    }, null, { timeout: 5000 }).then(() => ok('K1 le titre est « KIKI teams »', true),
                                      () => ok('K1 le titre est « KIKI teams »', false));
    ok('K1 fond crème (tokens du skin)',
       (await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--cl-bg').trim())) === '#f4efe6');
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${SHOTS}/k1-accueil.png` });

    // ════ K2 ════════════════════════════════════════════════════════════
    ok('K2 le rail dit « Kiki »',
       (await page.locator('#app aside .elpis-kiki-hote span.truncate').first().textContent()).trim() === 'Kiki');
    ok('K2 le trio anime le logo du rail',
       (await page.locator('#app aside .elpis-kiki-logo .socle-mascotte[data-perso="kiki"]').count()) >= 2);
    const bg = await page.evaluate(() => getComputedStyle(
        document.querySelector('#app aside .elpis-kiki-logo .elpis-kiki-repos')).backgroundImage);
    ok('K2 planche du trio chargée', /kiki\/idle\.png/.test(bg), bg);
    await page.locator('#app aside div.elpis-kiki-hote').first().hover();
    const vis = await page.evaluate(() => getComputedStyle(
        document.querySelector('#app aside div.elpis-kiki-hote .elpis-kiki-marche')).visibility);
    ok('K2 survol → le trio marche', vis === 'visible', vis);
    await page.locator('#app aside').first().screenshot({ path: `${SHOTS}/k2-rail.png` });

    // ════ K3 : les scènes du GANG, figées aux instants qui racontent ════
    // passage : entrée (3), pistolet dégainé (4.9), éclair du 1er tir (5.52),
    // trou + éclats (5.7), 3e tir (6.62), fumée et 4 trous (7.9), sortie
    // avec le mot troué (10), trous qui se referment (13.9) ; patrouille (4).
    const INSTANTS = { arrivee: [1.5, 4.0], attente: [2.0, 2.55, 3.0, 3.4, 4.0, 5.5],
                       fusillade: [2.7, 3.32, 4.0, 5.6, 7.0, 9.0],
                       coupe: [2.0, 4.72, 4.85, 5.3, 6.2, 9.0, 11.6],
                       patrouille: [4], dodo: [2.5, 5.2, 8] };
    for (const [nom, ts] of Object.entries(INSTANTS)) {
        for (const t of ts) {
            const r = await page.evaluate(async ({ nom, t }) => {
                const mod = await import('/static/assets/mascotte/accueil.js');
                let h = document.getElementById('kiki-banc');
                if (!h) {
                    h = document.createElement('div');
                    h.id = 'kiki-banc';
                    h.className = 'accueil';
                    h.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:260px;z-index:99999;background:var(--cl-bg)';
                    document.body.appendChild(h);
                }
                h.innerHTML = '';
                const s = mod.montrerAccueil(h, { base: '/static/assets/mascotte/',
                    perso: 'kiki', mot: 'kiki', suffixe: 'teams', scenario: nom, mouvement: 'toujours' });
                await s.pret;
                // le dodo appelle un AUTRE personnage (kiki_dodo), préchargé
                await new Promise(r => setTimeout(r, 400));
                s.aller(t, false);
                const lbl = h.querySelector('canvas').getAttribute('aria-label');
                return { scene: h.dataset.scene, lbl, choix: s.choix.perso };
            }, { nom, t });
            ok(`K3 ${nom} @${t}s : gang + KIKI`,
               r.scene === nom && r.choix === 'kiki' && /^KIKI/.test(r.lbl), JSON.stringify(r));
            await page.locator('#kiki-banc').screenshot({ path: `${SHOTS}/k3-${nom}-${t}.png` });
        }
    }
    // LE PIVOT : profil → face sans coupure. On avance l'horloge sur la MÊME
    // scène (aller() successifs) : l'ancien dessin se referme, le nouveau
    // s'ouvre. Largeur peinte mesurée : elle doit passer par un minimum.
    const piv = await page.evaluate(async () => {
        const mod = await import('/static/assets/mascotte/accueil.js');
        const h = document.getElementById('kiki-banc');
        h.innerHTML = '';
        const s = mod.montrerAccueil(h, { base: '/static/assets/mascotte/',
            perso: 'kiki', mot: 'kiki', suffixe: 'teams', scenario: 'attente', mouvement: 'toujours' });
        await s.pret;
        await new Promise(r => setTimeout(r, 500));
        const c = h.querySelector('canvas'), g = c.getContext('2d');
        const larg = () => {
            // largeur des pixels peints dans la moitié basse (sous le titre)
            const d = g.getImageData(0, c.height * 0.55, c.width, c.height * 0.45).data;
            let x0 = 1e9, x1 = -1;
            for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) {
                const x = (i / 4) % c.width; x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            }
            return x1 - x0;
        };
        const out = [];
        for (const t of [2.3, 2.42, 2.5, 2.6, 2.75, 3.0, 3.3, 3.7, 4.2]) { s.aller(t, false); out.push([t, larg()]); }
        return out;
    });
    // le retournement dessiné, en fondu depuis la marche : jamais d'image
    // vide, et pas de saut de largeur brutal d'une image à la suivante
    const sauts = piv.slice(1).map((p, i) => Math.abs(p[1] - piv[i][1]) / Math.max(1, piv[i][1]));
    ok('K3 le retournement s\'enchaîne sans image vide ni saut',
       piv.every(p => p[1] > 40) && Math.max(...sauts) < 0.45, JSON.stringify(piv));
    await page.locator('#kiki-banc').screenshot({ path: `${SHOTS}/k3-pivot-fin.png` });

    // UNE SORTIE PROPRE : quitter l'attente pour le dodo fait d'abord SORTIR
    // le gang (scène « attente:sortie »), puis entrer la grenouille.
    const sortie = await page.evaluate(async () => {
        const mod = await import('/static/assets/mascotte/accueil.js');
        const h = document.getElementById('kiki-banc');
        h.innerHTML = '';
        const s = mod.montrerAccueil(h, { base: '/static/assets/mascotte/',
            perso: 'kiki', mot: 'kiki', scenario: 'attente', mouvement: 'toujours' });
        await s.pret;
        await new Promise(r => setTimeout(r, 400));
        s.jouer('dodo');
        const pendant = h.dataset.scene, annonce = s.scenario;
        await new Promise(r => setTimeout(r, 5400));
        return { pendant, annonce, apres: h.dataset.scene };
    });
    ok('K3 attente → dodo : le gang sort d\'abord, puis la grenouille entre',
       sortie.pendant === 'attente:sortie' && sortie.annonce === 'dodo' && sortie.apres === 'dodo',
       JSON.stringify(sortie));
    // Dans l'app : le gang ARRIVE (salut), puis passe à l'ATTENTE
    ok('K3 dans l\'app, l\'accueil kiki commence par l\'attente (marche puis retournement)',
       (await page.evaluate(() => document.querySelector('#app .accueil')?.dataset.scene)) === 'attente');
    // La marche vers le titre dure le temps de la DISTANCE (vitesse 32) : pas
    // de pause fixe avant le retournement
    const dur = await page.evaluate(async () => {
        const mod = await import('/static/assets/mascotte/accueil.js');
        const h = document.getElementById('kiki-banc') || document.body.appendChild(Object.assign(
            document.createElement('div'), { id: 'kiki-banc', className: 'accueil',
            style: 'position:fixed;left:0;top:0;width:900px;height:260px;z-index:99999' }));
        h.innerHTML = '';
        const s = mod.montrerAccueil(h, { base: '/static/assets/mascotte/', perso: 'kiki',
            mot: 'kiki', suffixe: 'teams', scenario: 'attente', mouvement: 'toujours' });
        await s.pret;
        return s.duree;
    });
    ok('K3 la marche se cale sur la distance (fin de retournement < 6 s)', dur > 1.2 && dur < 6, String(dur));
    await page.evaluate(() => document.getElementById('kiki-banc')?.remove());

    // ════ K4 : sortie du skin ══════════════════════════════════════════
    await fetch(BASE_URL + '/__cfg');
    await gotoApp(page, '/');
    await page.locator('#app .accueil').first().waitFor({ state: 'visible' });
    ok('K4 hors skin : la mascotte choisie revient', (await setup('mascotteId')) === 'boite_or');
    await page.waitForFunction(() => /^ELPIS/.test(
        document.querySelector('#app .accueil canvas')?.getAttribute('aria-label') || ''),
        null, { timeout: 5000 }).then(() => ok('K4 hors skin : le mot redevient ELPIS', true),
                                      () => ok('K4 hors skin : le mot redevient ELPIS', false));
    ok('K4 hors skin : le rail redit « Elpis »',
       (await page.locator('#app aside span.truncate').first().textContent()).trim() === 'Elpis');

    // ════ K5 : sombre ════════════════════════════════════════════════════
    await fetch(BASE_URL + '/__cfg?skin=kiki&dark=1');
    await gotoApp(page, '/');
    await page.locator('#app .accueil').first().waitFor({ state: 'visible' });
    ok('K5 sombre : encre claire pour le mot',
       (await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--cl-ink').trim())) === '#f1e9dd');
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${SHOTS}/k5-sombre.png` });

    // ════ K6 : perchoir — EN DERNIER, l'horloge figée survit au rechargement
    await fetch(BASE_URL + '/__cfg?skin=kiki');
    await gotoApp(page, '/');
    await page.locator('#app aside').getByText('Conversation existante').first().click();
    await page.waitForTimeout(700);
    await page.clock.install();
    await page.mouse.click(700, 300);
    await page.waitForTimeout(100);
    await page.clock.fastForward('03:01');
    await page.waitForTimeout(300);
    ok('K6 le perchoir est le trio',
       (await page.locator('#app .perchoir .socle-mascotte[data-perso="kiki"]').count()) === 1);
    ok('K6 les messages sont signés « Kiki »',
       (await page.locator('#app .elpis-msg-assistant').first().textContent()).includes('Kiki'));
    await page.clock.fastForward(3000);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/k6-perchoir.png` });

    ok('aucune erreur JS', errors.length === 0, errors.join(' | '));
} catch (e) {
    ok('exception : ' + e.message, false);
} finally {
    await browser.close();
}
const n = checks.filter(c => c[0] === 'PASS').length;
console.log(`\n${n}/${checks.length} ${n === checks.length ? 'OK' : 'ÉCHECS'} · captures dans ${SHOTS}`);
process.exit(n === checks.length ? 0 : 1);
