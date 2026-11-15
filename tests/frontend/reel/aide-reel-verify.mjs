// SPDX-License-Identifier: MIT
/** tests/frontend/reel/aide-reel-verify.mjs — fenêtre d'aide contre le core TS réel : sommaire du guide livré, section de l'écran en cours, recherche, clips en animations complètes (lecture seule à l'écran) et réduites (au clic). */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules node tests/frontend/reel/aide-reel-verify.mjs
import { attendreMontage, contexteConnecte, demarrerCoreReel, lancerNavigateur, verifications } from '../lib/core-reel.mjs';

const v = verifications('aide-reel');
const ok = (nom, cond, detail = '') => v.ok(nom, cond, String(detail).slice(0, 300));
const core = await demarrerCoreReel({ tokParS: 80 });
const nav = await lancerNavigateur();
const etatClip = (page) => page.evaluate(() => { const f = document.querySelector('figure.aide-clip'); if (!f) return null; const v = f.querySelector('video'); return { etat: f.dataset.etat, src: v.getAttribute('src'), paused: v.paused, temps: v.currentTime, l: v.videoWidth, presse: f.querySelector('button').getAttribute('aria-pressed') }; });
try {
    for (const [nom, mouvement] of [['complet', 'no-preference'], ['reduit', 'reduce']]) {
        console.log(`— animations : ${nom}`);
        const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1280, height: 800 }, reducedMotion: mouvement });
        const page = await ctx.newPage();
        const erreurs = [];
        page.on('pageerror', (e) => erreurs.push(String(e.message)));
        const medias = [];
        page.on('response', (r) => { if (r.url().includes('/api/help/')) medias.push(`${r.status()} ${new URL(r.url()).pathname}`); });
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        await page.locator('button[title="Nouveau chat"], button:has-text("Nouveau chat")').first().click().catch(() => {});
        await page.locator('text=alice').first().click();
        await page.locator('[role=menuitem]:has-text("Aide")').click();
        await page.waitForSelector('[role=dialog][aria-label="Aide"] .markdown-body h2', { timeout: 15000 });
        const entrees = await page.locator('[data-aide-entree]').allTextContents().then((t) => t.map((x) => x.trim()));
        ok('sommaire : 26 sections', entrees.length === 26, String(entrees.length));
        ok('ouverture sur la première section depuis l\'accueil', (await page.locator('[role=dialog] .markdown-body h2').first().textContent()) === 'Bienvenue', await page.locator('[role=dialog] .markdown-body h2').first().textContent());
        ok('plus d\'onglet Développeur', (await page.locator('[role=dialog][aria-label="Aide"] [role=tab]').count()) === 0);
        await page.locator('[data-aide-entree]:has-text("Le chat")').first().click();
        await page.waitForSelector('figure.aide-clip video');
        await page.waitForTimeout(1800);
        const e1 = await etatClip(page);
        if (nom === 'complet') ok('le premier clip joue seul', e1 && !e1.paused && e1.temps > 0.3 && e1.presse === 'true', JSON.stringify(e1));
        else {
            ok('le premier clip attend, première image chargée', e1 && e1.paused && e1.l > 0, JSON.stringify(e1));
            await page.locator('figure.aide-clip button').first().click();
            await page.waitForTimeout(1000);
            const e2 = await etatClip(page);
            ok('un clic le lance', e2 && !e2.paused && e2.temps > 0.2, JSON.stringify(e2));
        }
        const nb = await page.locator('figure.aide-clip').count();
        ok('les clips de la section sont posés', nb >= 5, String(nb));
        await page.locator('[data-aide-recherche]').fill('questionnaire');
        await page.waitForTimeout(300);
        const trouvees = await page.locator('[data-aide-entree]').count();
        ok('la recherche filtre le sommaire', trouvees > 0 && trouvees < 26, String(trouvees));
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.locator('aside >> text=Routines').first().click();
        await page.waitForTimeout(600);
        await page.locator('text=alice').first().click();
        await page.locator('[role=menuitem]:has-text("Aide")').click();
        await page.waitForFunction(() => document.querySelector('[role=dialog][aria-label="Aide"] .markdown-body h2')?.textContent === 'Les routines', null, { timeout: 8000 }).catch(() => {});
        ok('depuis la page Routines, l\'aide s\'ouvre sur « Les routines »', (await page.locator('[role=dialog] .markdown-body h2').first().textContent()) === 'Les routines', await page.locator('[role=dialog] .markdown-body h2').first().textContent());
        ok('clips servis (200 ou 206), guide servi', medias.some((m) => m.startsWith('200 /api/help/readme')) && medias.filter((m) => m.includes('/media/')).every((m) => /^(200|206|304) /.test(m)), medias.slice(0, 6).join(' | '));
        ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
        await ctx.close();
    }
} finally { await nav.close(); await core.arreter(); }
process.exit(v.bilan());
