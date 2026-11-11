// SPDX-License-Identifier: MIT
/** tests/frontend/reel/arret-reel-verify.mjs — Stop et réponse tronquée contre le core TS réel : tour en file d'attente (un seul créneau) arrêté sans témoin résiduel, coupure par le plafond de jetons gardée au rechargement, encart « Continuer » (thème, mode sombre, skin) et reprise */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/arret-reel-verify.mjs
import fs from 'node:fs';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const ENVOYER = 'button:has(i.ph-paper-plane-right)';
const rgb = (s) => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number);
const proche = (a, b, tol = 24) => a.length === 3 && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const COPIER = '#app button[title="Copier la réponse"]';
const v = verifications('arret-reel');
// Gabarit de la page de chat : les sources .vue des composants de page, concaténées.
const sourcePage = () => { const d = new URL('../../../frontend/src/components/chat/page/', import.meta.url); return fs.readdirSync(d).filter((n) => n.endsWith('.vue')).map((n) => fs.readFileSync(new URL(n, d), 'utf8')).join('\n').replace(/\b(?:comp|mod|conv|ent|img|p)\./g, ''); };
// LLAMA_CONTENT_RESUME_MAX=1 : une seule suite automatique d'une réponse coupée, pour atteindre l'encart en deux appels.
const core = await demarrerCoreReel({ tokParS: 30, slots: 1, envSup: { LLAMA_CONTENT_RESUME_MAX: '1' } });
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const autre = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const annulations = [];
    page.on('request', (r) => { if (r.url().includes('/api/chat/cancel')) annulations.push(r.url()); });
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const ouvrir = async (p, chat) => {
        await p.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
        await p.waitForFunction((t) => document.body.innerText.includes(t), `${chat.titre} : question ${chat.echanges}`, { timeout: 15000 }).catch(() => {});
    };
    const envoyer = async (p, texte) => {
        await p.locator('textarea[placeholder]').last().fill(texte);
        await p.locator(ENVOYER).last().click();
    };
    const [a, b, c] = core.chats;
    for (const p of [page, autre]) { await p.goto(core.urlMain + '/'); await attendreMontage(p); }

    // ── Un seul créneau : le second tour attend, Stop le retire sans témoin résiduel ──
    await ouvrir(autre, a);
    core.llm.scripter(`Longue réponse OCCUPE-LE-CRENEAU ${Array.from({ length: 150 }, (_, i) => `m${i}`).join(' ')} FIN`);
    await envoyer(autre, 'Occupe le créneau.');
    await autre.waitForFunction(() => document.body.innerText.includes('OCCUPE-LE-CRENEAU'), null, { timeout: 15000 }).catch(() => {});
    await ouvrir(page, b);
    await envoyer(page, 'Je passe après.');
    const bandeau = page.locator('#app [role="status"]:has-text("requête(s) en cours")');
    await bandeau.first().waitFor({ timeout: 15000 }).catch(() => {});
    v.ok('tour en attente : bandeau de file affiché', await bandeau.count() >= 1);
    v.ok('tour en attente : bouton Arrêter présent', await page.locator(EN_STREAM).count() === 1);
    const copiesAvant = await page.locator(COPIER).count();
    await page.locator(EN_STREAM).first().click();
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 10000 }).catch(() => {});
    await pause(900);
    v.ok('après Stop : bandeau de file retiré', await bandeau.count() === 0);
    v.ok('après Stop : composeur rendu, plus de bouton Arrêter', await page.locator(ENVOYER).count() >= 1 && await page.locator(EN_STREAM).count() === 0);
    v.ok('après Stop : aucune ligne « en cours » résiduelle', !(await page.evaluate(() => document.body.innerText)).includes('Génération en cours'));
    v.ok('après Stop : annulation envoyée au core', annulations.length >= 1);
    v.ok('après Stop : le message a quitté l\'état « en cours » (barre d\'actions rendue)', await page.locator(COPIER).count() > copiesAvant);
    const gabarit = sourcePage();
    v.ok('le bandeau « Chargement de <modèle> » n\'existe plus dans le gabarit', !gabarit.includes("queueStatus.kind === 'loading'") && !gabarit.includes('Chargement de {{ queueStatus.model }}'));
    v.ok('la barre de progression du modèle est conservée dans le gabarit', gabarit.includes("modelLoadingId && typeof modelLoadPct === 'number'"));
    v.ok('le tour arrêté en file n\'a jamais atteint le moteur', !core.llm.completions().some((r) => JSON.stringify(r.corps.messages || []).includes('Je passe après')));
    await autre.waitForFunction(() => document.body.innerText.includes(' FIN'), null, { timeout: 30000 }).catch(() => {});
    await autre.waitForSelector(EN_STREAM, { state: 'detached', timeout: 15000 }).catch(() => {});
    v.ok('l\'autre tour va au bout, sans être touché par le Stop', (await autre.evaluate(() => document.body.innerText)).includes(' FIN'));
    await autre.close();

    // ── Réponse coupée une fois : le core la poursuit seul ──
    await ouvrir(page, c);
    const n0 = core.llm.completions().length;
    core.llm.scripter({ contenu: 'Début coupé une première fois et', fin: 'length' }, { contenu: ' complété par la SUITE-AUTOMATIQUE.' });
    await envoyer(page, 'Écris un texte moyen.');
    await page.waitForFunction(() => document.body.innerText.includes('SUITE-AUTOMATIQUE'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    const auto = await page.evaluate(() => ([...document.querySelectorAll('.markdown-body')].pop() || {}).textContent || '');
    v.ok('coupure unique : suite automatique dans la même bulle, sans encart', auto.includes('première fois') && auto.includes('SUITE-AUTOMATIQUE')
        && core.llm.completions().length === n0 + 2 && await page.locator('[role="status"]:has-text("Continuer")').count() === 0, auto.slice(-80));

    // ── Coupée deux fois : encart « Continuer », gardé au rechargement ──
    core.llm.scripter({ contenu: 'Voici le début de la réponse, coupée net par le plafond de jetons et', fin: 'length' }, { contenu: ' encore coupée', fin: 'length' });
    await envoyer(page, 'Écris-moi un très long texte.');
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    const encarts = page.locator('[role="status"]:has-text("Continuer"), [role="status"]:has-text("Reprendre")');
    await encarts.first().waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('coupure : un seul encart de reprise, sur la dernière bulle', await encarts.count() === 1);
    let enBase = [];
    for (let i = 0; i < 20; i++) {
        enBase = (await api.req('GET', `/api/saved/chats/${c.id}`)).messages || [];
        if (enBase.some((m) => String(m.content).includes('plafond de jetons'))) break;
        await pause(250);
    }
    const tronque = enBase.find((m) => String(m.content).includes('plafond de jetons')) || {};
    v.ok('coupure : la réponse est enregistrée comme tronquée', tronque.isTruncated === true, JSON.stringify(Object.keys(tronque)));
    await page.reload();
    await attendreMontage(page);
    await ouvrir(page, c);
    await encarts.first().waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('après rechargement : l\'encart « Continuer » est toujours là', await encarts.count() === 1);
    const continuer = page.locator('[role="status"] button:has-text("Continuer")').first();
    const jetons = await page.evaluate(() => {
        const cv = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
        const rgb = (css) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = css; cv.fillRect(0, 0, 1, 1); return `rgb(${[...cv.getImageData(0, 0, 1, 1).data].slice(0, 3).join(', ')})`; };
        const sonde = (cls, prop) => { const d = document.createElement('div'); d.className = cls; document.body.appendChild(d); const c = getComputedStyle(d)[prop]; d.remove(); return c; };
        const p = document.createElement('div'); p.style.color = 'var(--accent)'; document.body.appendChild(p); const accent = getComputedStyle(p).color; p.remove();
        return { surface: rgb(sonde('bg-slate-50', 'backgroundColor')), accent: rgb(accent), skin: [...document.body.classList].filter((c) => c.startsWith('elpis-skin-')).join(' ') };
    });
    const fondEncart = rgb(await encarts.first().evaluate((el) => getComputedStyle(el).backgroundColor));
    v.ok('encart sur la surface neutre du skin actif (pas d\'ambre)', proche(fondEncart, rgb(jetons.surface), 8) && !(fondEncart[0] > fondEncart[2] + 60), JSON.stringify({ fondEncart, ...jetons }));
    v.ok('bouton « Continuer » à l\'accent du skin actif', proche(rgb(await continuer.evaluate((el) => getComputedStyle(el).backgroundColor)), rgb(jetons.accent), 8), JSON.stringify(jetons));
    await page.evaluate(() => document.body.classList.add('elpis-app-dark'));
    await pause(250);
    v.ok('encart en mode sombre : fond sombre', rgb(await encarts.first().evaluate((el) => getComputedStyle(el).backgroundColor))[0] < 120);
    await page.evaluate(() => { document.body.classList.remove('elpis-app-dark'); document.body.classList.add('elpis-skin-emeraude'); });
    await pause(300);
    const vert = rgb(await continuer.evaluate((el) => getComputedStyle(el).backgroundColor));
    v.ok('bouton recoloré par le skin émeraude', !proche(vert, [37, 99, 235]) && vert[1] > vert[2], JSON.stringify(vert));
    await page.evaluate(() => document.body.classList.remove('elpis-skin-emeraude'));

    core.llm.scripter(' la suite.');
    await continuer.click();
    await pause(150);
    v.ok('« Continuer » : encart retiré dès le clic', await encarts.count() === 0);
    await page.waitForFunction(() => /la suite\./.test(([...document.querySelectorAll('.markdown-body')].pop() || {}).textContent || ''), null, { timeout: 20000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    const derniere = await page.evaluate(() => ([...document.querySelectorAll('.markdown-body')].pop() || {}).textContent || '');
    v.ok('« Continuer » : la même bulle est complétée', derniere.includes('plafond de jetons') && derniere.includes('la suite.'), derniere.slice(-60));
    await page.reload();
    await attendreMontage(page);
    await ouvrir(page, c);
    await pause(800);
    v.ok('après reprise et rechargement : plus d\'encart', await encarts.count() === 0);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
