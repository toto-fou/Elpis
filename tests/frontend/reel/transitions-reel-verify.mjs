// SPDX-License-Identifier: MIT
/** tests/frontend/reel/transitions-reel-verify.mjs — transitions des menus contre le core TS réel, sous le skin par défaut, Veilleuse et Terminal : menu « + » du composeur et menu de la conversation entrent et sortent en animation, coupées par la préférence « mouvement réduit », sans avertissement Vue */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/transitions-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

// Enregistre les classes *-enter-active / *-leave-active posées par les <Transition>.
const ENREGISTREUR = () => {
    window.__tr = [];
    new MutationObserver((muts) => {
        for (const m of muts) {
            const cl = m.target.className;
            if (typeof cl !== 'string') continue;
            for (const c of cl.split(/\s+/)) if (/-(enter|leave)-active$/.test(c) && !window.__tr.includes(c)) window.__tr.push(c);
        }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
};
const MENUS = [
    { libelle: 'menu « + » du composeur', ouvrir: 'button[aria-label="Plus d\'actions"]', menu: 'main [role="menu"][aria-label="Plus d\'actions"]', attendu: 'popover-up' },
    { libelle: 'menu de la conversation', ouvrir: 'button[aria-label="Conversation"]', menu: 'header [role="menu"]', attendu: 'popover' },
];

const v = verifications('transitions-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
const api = new Client(core.urlMain);
await api.req('POST', '/api/login-lite', core.comptes.user);
try {
  for (const skin of [null, 'veilleuse', 'terminal']) {
    if (skin) await api.req('PUT', '/api/settings', { skin });
    for (const mouvement of ['no-preference', 'reduce']) {
        const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { reducedMotion: mouvement });
        const page = await ctx.newPage();
        const erreurs = [];
        const bavardages = [];
        page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
        page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') bavardages.push(m.text()); });
        await page.addInitScript(ENREGISTREUR);
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        await page.locator('[data-chat-row]', { hasText: core.chats[1].titre }).first().click();
        await page.waitForTimeout(1200);
        for (const m of MENUS) {
            await page.evaluate(() => { window.__tr = []; });
            await page.locator(m.ouvrir).locator('visible=true').first().click();
            await page.waitForTimeout(400);
            const visible = await page.locator(m.menu).count() > 0;
            await page.mouse.click(900, 150);
            await page.waitForTimeout(60);
            const pendantSortie = await page.locator(`${m.menu}.${m.attendu}-leave-active`).count();
            await page.waitForTimeout(500);
            const parti = await page.locator(m.menu).count() === 0;
            const vues = await page.evaluate(() => window.__tr);
            v.ok(`[${skin ?? 'défaut'}, ${mouvement}] ${m.libelle} : s'ouvre puis disparaît`, visible && parti);
            if (mouvement === 'no-preference') v.ok(`[${skin ?? 'défaut'}, ${mouvement}] ${m.libelle} : entrée animée, sortie encore présente 60 ms après`, vues.includes(`${m.attendu}-enter-active`) && pendantSortie === 1, `${vues.join(', ')} / ${pendantSortie}`);
            else v.ok(`[${skin ?? 'défaut'}, ${mouvement}] ${m.libelle} : sortie immédiate`, pendantSortie === 0, String(pendantSortie));
        }
        const avertissements = bavardages.filter((t) => /Transition|expects exactly one/i.test(t));
        v.ok(`[${skin ?? 'défaut'}, ${mouvement}] aucun avertissement Vue sur les transitions, aucune erreur JS`, avertissements.length === 0 && erreurs.length === 0, [...avertissements, ...erreurs].slice(0, 2).join(' | '));
        await ctx.close();
    }
  }
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
