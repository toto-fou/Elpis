// SPDX-License-Identifier: MIT
/** tests/frontend/reel/transitions-reel-verify.mjs — transitions des menus contre le core TS réel, sous le skin par défaut, Veilleuse et Terminal : menu « + » du composeur et menu de la conversation entrent et sortent en animation ; la préférence « mouvement réduit » les réduit à un fondu d'opacité de 150 ms au plus, sans déplacement ni changement de taille (toutes les transitions nommées sondées), sans avertissement Vue */
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
// Enregistre, image par image, les transitions et animations finies (propriété@durée) jusqu'au relevé.
const ENREGISTRER_ANIMATIONS = () => {
    const id = (window.__idBoucle = (window.__idBoucle || 0) + 1);
    window.__anim = new Set();
    const boucle = () => {
        for (const a of document.getAnimations()) {
            const t = a.effect?.getTiming?.() ?? {};
            if (t.iterations === Infinity) continue;
            const props = a.transitionProperty ? [a.transitionProperty] : (a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k)).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)).map((p) => p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
            for (const p of props) window.__anim.add(`${p}@${Math.round(Number(t.duration) || 0)}`);
        }
        if (window.__idBoucle === id) requestAnimationFrame(boucle);
    };
    requestAnimationFrame(boucle);
};
const RELEVER_ANIMATIONS = () => { window.__idBoucle += 1; return [...window.__anim]; };
// Mouvement réduit : opacité et couleurs seulement (l'ombre d'un anneau de focus aussi), 150 ms au plus.
const PERMIS_REDUIT = /^(opacity|color|background-color|border-(top|right|bottom|left)-color|outline-color|fill|stroke|text-decoration-color|box-shadow)@(\d+)$/;
const hors_reduit = (vues) => vues.filter((x) => { const m = PERMIS_REDUIT.exec(x); return !m || Number(m[3]) > 150; });

// Transitions nommées : leurs classes posées sur un élément témoin, propriété et décalage d'entrée lus sur le style calculé.
const SONDER = () => {
    const out = {};
    for (const nom of ['modal', 'popover', 'popover-up', 'toast', 'fade', 'tool-detail', 'model-load', 'adm-bar']) {
        const hote = document.createElement('div');
        hote.style.cssText = 'position:fixed;left:-9999px;top:0';
        hote.className = `${nom}-enter-active ${nom}-enter-from`;
        const enfant = document.createElement('div');
        hote.appendChild(enfant);
        document.body.appendChild(hote);
        const lire = (el) => { const c = getComputedStyle(el); return { propriete: c.transitionProperty, duree: c.transitionDuration, transform: c.transform, maxWidth: c.maxWidth, maxHeight: c.maxHeight }; };
        out[nom] = { hote: lire(hote), enfant: lire(enfant) };
        hote.remove();
    }
    return out;
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
            await page.evaluate(ENREGISTRER_ANIMATIONS);
            await page.locator(m.ouvrir).locator('visible=true').first().click();
            await page.waitForTimeout(400);
            const visible = await page.locator(m.menu).count() > 0;
            await page.mouse.click(900, 150);
            await page.waitForTimeout(60);
            const pendantSortie = await page.locator(`${m.menu}.${m.attendu}-leave-active`).count();
            await page.waitForTimeout(500);
            const parti = await page.locator(m.menu).count() === 0;
            const vues = await page.evaluate(() => window.__tr);
            const animees = await page.evaluate(RELEVER_ANIMATIONS);
            v.ok(`[${skin ?? 'défaut'}, ${mouvement}] ${m.libelle} : s'ouvre puis disparaît`, visible && parti);
            if (mouvement === 'no-preference') v.ok(`[${skin ?? 'défaut'}, ${mouvement}] ${m.libelle} : entrée animée, sortie encore présente 60 ms après`, vues.includes(`${m.attendu}-enter-active`) && pendantSortie === 1, `${vues.join(', ')} / ${pendantSortie}`);
            else {
                v.ok(`[${skin ?? 'défaut'}, ${mouvement}] ${m.libelle} : sortie en fondu, encore présente 60 ms après`, pendantSortie === 1, String(pendantSortie));
                v.ok(`[${skin ?? 'défaut'}, ${mouvement}] ${m.libelle} : opacité et couleurs seulement, 150 ms au plus`, animees.some((x) => x.startsWith('opacity@')) && hors_reduit(animees).length === 0, animees.join(', '));
            }
        }
        if (mouvement === 'reduce') {
            const sonde = await page.evaluate(SONDER);
            for (const [nom, { hote, enfant }] of Object.entries(sonde)) {
                const porteurs = nom === 'modal' ? [hote, enfant] : [hote];
                const ms = (d) => Math.max(...d.split(',').map((x) => parseFloat(x) * (x.trim().endsWith('ms') ? 1 : 1000)));
                v.ok(`[${skin ?? 'défaut'}, reduce] transition « ${nom} » : fondu d'opacité seul, 150 ms au plus, élément à sa place`, porteurs.every((p) => p.propriete === 'opacity' && ms(p.duree) <= 150 && p.transform === 'none' && p.maxWidth !== '0px' && p.maxHeight !== '0px'), JSON.stringify(porteurs));
            }
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
