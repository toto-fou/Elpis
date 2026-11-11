// SPDX-License-Identifier: MIT
/** tests/frontend/reel/mascotte-reel-verify.mjs — mascotte du perchoir contre le core TS réel : un tour l'amène sur la barre ; réflexion, outil lent, texte, fin, erreur et question se jouent avec les planches du personnage ; sous chaque skin, clair et sombre, sur ordinateur et sur mobile, elle reste entière, visible, hors des commandes et du texte. */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [SKINS=veilleuse,terminal] [CAPTURES=dossier] node tests/frontend/reel/mascotte-reel-verify.mjs
import fs from 'node:fs';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, messagesFixture } from '../lib/core-reel.mjs';
import { demarrerFauxMcp } from '../lib/faux-mcp.mjs';

const v = verifications('mascotte-reel');
const SKINS = (process.env.SKINS ?? ',elpis,monochrome,emeraude,pingouins,alize,veilleuse,terminal').split(',');
const CAPTURES = process.env.CAPTURES || '';
const ECRANS = [{ nom: 'ordinateur', width: 1440, height: 900 }, { nom: 'mobile', width: 390, height: 844 }];
const EN_STREAM = 'button[title="Arrêter la génération"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Journal du perchoir, relevé toutes les 40 ms : état, nombre de tours de l'animation, planche affichée.
const ENREGISTRER = () => {
    window.__perchoir = [];
    let dernier = '';
    setInterval(() => {
        const s = document.querySelector('.perchoir .socle-mascotte');
        const cs = s && getComputedStyle(s);
        const e = s ? `${s.dataset.etat || ''}|${cs.animationIterationCount}|${(cs.backgroundImage.match(/\/([\w-]+)\.png/) || [])[1] || ''}` : '-';
        if (e !== dernier) { dernier = e; window.__perchoir.push({ t: Math.round(performance.now()), e }); }
    }, 40);
};

// La mascotte posée : entière à l'écran, non rognée, au premier plan, opaque, hors des commandes et du texte du fil ; pieds mesurés dans le repère de la barre, rotation comprise.
const MESURER = () => {
    const s = document.querySelector('.perchoir .socle-mascotte');
    if (!s) return { absente: true };
    const p = s.closest('.perchoir');
    const r = s.getBoundingClientRect();
    const nom = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${[...e.classList].slice(0, 3).join('.')}`;
    const coupe = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const rogneePar = [];
    for (let e = s.parentElement; e && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        const rogne = /hidden|clip|auto|scroll/.test(cs.overflowX + cs.overflowY) || cs.clipPath !== 'none' || (cs.maskImage || 'none') !== 'none' || /paint|strict|content/.test(cs.contain);
        const a = e.getBoundingClientRect();
        if (rogne && (r.left < a.left - 0.5 || r.right > a.right + 0.5 || r.top < a.top - 0.5 || r.bottom > a.bottom + 0.5)) rogneePar.push(nom(e));
    }
    const avant = [p.style.pointerEvents, s.style.pointerEvents];
    p.style.pointerEvents = 'auto';
    s.style.pointerEvents = 'auto';
    const couvertPar = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
        .map(([x, y]) => document.elementFromPoint(r.left + r.width * x, r.top + r.height * y))
        .filter((el) => !el || !p.contains(el)).map((el) => (el ? nom(el) : 'hors page'));
    [p.style.pointerEvents, s.style.pointerEvents] = avant;
    let opacite = 1;
    for (let e = s; e; e = e.parentElement) opacite *= Number(getComputedStyle(e).opacity);
    const carte = s.closest('.elpis-compose-card');
    const commandes = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="option"], [role="menuitem"]')]
        .filter((el) => !p.contains(el) && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
        .filter((el) => { const q = el.getBoundingClientRect(); const h = Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top); return coupe(q, r) > 1 && !(carte && carte.contains(el) && h <= 10); })
        .map(nom);
    const textes = [];
    for (const bloc of document.querySelectorAll('.elpis-msg-user, .elpis-msg-assistant')) {
        const marche = document.createTreeWalker(bloc, NodeFilter.SHOW_TEXT);
        for (let n = marche.nextNode(); n; n = marche.nextNode()) {
            if (!n.textContent.trim()) continue;
            const g = document.createRange();
            g.selectNodeContents(n);
            if ([...g.getClientRects()].some((q) => coupe(q, r) > 2)) textes.push(n.textContent.trim().slice(0, 24));
        }
    }
    return {
        rect: [r.left, r.top, r.width, r.height].map(Math.round),
        ecran: [innerWidth, innerHeight],
        dansEcran: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width >= 40,
        rogneePar, couvertPar, opacite, commandes, textes,
        image: getComputedStyle(s).backgroundImage !== 'none',
        pieds: carte && p.offsetParent === carte ? p.offsetTop + p.offsetHeight + carte.clientTop : null,
    };
};

const lent = await demarrerFauxMcp({ nom: 'lent', outils: [{ name: 'lire_lent', description: 'Lit un document, lentement.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, reponse: () => 'bonjour du document', delaiMs: 2500 }] });
const core = await demarrerCoreReel({ tokParS: 400, outilsEnProcessus: true, llm: { gabarit: '{% if enable_thinking %}<think>{% endif %}' } });
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.admin);
    await api.req('PUT', '/api/settings', {
        welcome_mascot_on: true, welcome_mascot: 'elpis', welcome_mascot_anime: true, skin: '', dark_mode: false, dark_mode_auto: false,
        mcp_servers: [{ name: 'Lent', type: 'http', url: lent.url, visible: true, id: 'server_lent' }],
    });
    const chats = {};
    for (const [titre, n] of [['Mascotte', 1], ['Positions', 6]]) {
        const { id } = await api.req('POST', '/api/saved/chats/new', {});
        await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: titre, messages: messagesFixture(n, titre) });
        await api.req('PUT', `/api/saved/chats/${id}/tools`, { tools: titre === 'Mascotte' ? ['ext:server_lent'] : [] });
        chats[titre] = id;
    }

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.admin, { viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const ouvrir = async (titre) => {
        await page.locator('[data-chat-row]', { hasText: titre }).first().click();
        await page.waitForFunction((t) => document.body.innerText.includes(t), `${titre} : question 1`, { timeout: 15000 }).catch(() => {});
        await pause(300);
    };
    const envoyer = async (msg) => {
        await page.locator('textarea[placeholder]').last().fill(msg);
        await page.locator('button:has(i.ph-paper-plane-right)').last().click();
        await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
    };
    const finDuTour = () => page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
    const auRepos = () => page.waitForFunction(() => {
        const p = document.querySelector('.perchoir');
        return !!p && p.style.left === '31%' && p.querySelector('.socle-mascotte')?.dataset.etat === 'repos';
    }, null, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
    // Lu après un relevé au moins (40 ms) : l'état qu'on vient d'attendre y figure.
    const journal = async () => { await pause(120); return page.evaluate(() => window.__perchoir.splice(0)); };
    const lire = (j) => j.map((x) => x.e).join(' > ');
    // Les états attendus apparaissent dans cet ordre (d'autres peuvent s'intercaler).
    const dansLOrdre = (j, attendus) => { let i = 0; for (const { e } of j) if (i < attendus.length && e === attendus[i]) i++; return i === attendus.length; };
    // Durées d'affichage, le dernier état excepté (relevé toutes les 40 ms : 60 ms de marge sur les 800 ms).
    const brefs = (j) => j.slice(0, -1).map((x, i) => [x.e, j[i + 1].t - x.t]).filter(([, d]) => d < 740);

    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await ouvrir('Mascotte');
    await page.evaluate(ENREGISTRER);
    v.ok('conversation ouverte sans événement : pas de mascotte sur la barre', (await page.locator('.perchoir').count()) === 0);

    // ── Un tour amène la mascotte en courant ──
    core.llm.scripter('Bonjour, je suis prêt.');
    await envoyer('Bonjour');
    await finDuTour();
    const arrivee = await auRepos();
    const j0 = await journal();
    v.ok('un tour amène la mascotte : elle court jusqu\'à la barre puis se pose au repos', arrivee && dansLOrdre(j0, ['run-right|infinite|run-right', 'repos|infinite|idle']), lire(j0));

    // ── Réflexion, outil lent, texte, fin ──
    core.llm.scripter(
        { raisonnement: 'Je dois lire le document demo.txt avant de répondre, puis résumer ce qu\'il contient pour la personne.', appels: [{ nom: 'lire_lent', args: { path: 'demo.txt' } }], tokParS: 14 },
        { contenu: 'Le document dit bonjour. En résumé, il contient une salutation simple et rien d\'autre, FIN-MASCOTTE.', tokParS: 14 },
    );
    await envoyer('Lis demo.txt');
    await page.waitForFunction(() => document.querySelector('.perchoir .socle-mascotte')?.dataset.etat === 'chantier', null, { timeout: 15000, polling: 50 }).catch(() => {});
    await page.locator('textarea[placeholder]').last().pressSequentially('ok', { delay: 30 });
    await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await pause(900);
    const pendantOutil = await page.evaluate(() => document.querySelector('.perchoir')?.style.left || '');
    await finDuTour();
    await auRepos();
    const j1 = await journal();
    v.ok('réflexion, puis outil (chantier), puis texte (parole), chacun avec sa planche', dansLOrdre(j1, ['reflexion|infinite|waiting', 'chantier|infinite|chantier', 'parole|infinite|bounce']), lire(j1));
    v.ok('fin du tour : « fin » joué une fois (planche espoir), puis repos', dansLOrdre(j1, ['parole|infinite|bounce', 'fin|1|espoir', 'repos|infinite|idle']), lire(j1));
    v.ok('un geste pendant le tour ne la chasse pas (clavier et pointeur)', pendantOutil === '31%', pendantOutil);
    v.ok('pas de clignotement : chaque état reste affiché au moins 0,8 s', brefs(j1).length === 0, JSON.stringify(brefs(j1)));
    await page.locator('textarea[placeholder]').last().fill('');

    // ── Erreur du moteur ──
    core.llm.scripter({ erreur: { statut: 401, message: 'invalid api key', type: 'authentication_error' } });
    await envoyer('Encore une question.');
    await finDuTour();
    await auRepos();
    const j2 = await journal();
    v.ok('réponse en erreur : « erreur » joué une fois (planche failed), puis repos, sans « fin »', dansLOrdre(j2, ['erreur|1|failed', 'repos|infinite|idle']) && !j2.some((x) => x.e.startsWith('fin|')), lire(j2));

    // ── Question posée par l'assistant ──
    core.llm.scripter({ appels: [{ nom: 'ask_user', args: { questions: [{ q: 'Quel format voulez-vous ?', options: ['Court', 'Détaillé'] }] } }] }, 'Répondez ci-dessous.');
    await envoyer('Pose-moi une question.');
    await finDuTour();
    const question = await page.waitForFunction(() => document.querySelector('.perchoir .socle-mascotte')?.dataset.etat === 'question', null, { timeout: 8000, polling: 50 }).then(() => true).catch(() => false);
    await pause(1500);
    const j3 = await journal();
    v.ok('une question attend : « question » en boucle (planche look), sans « fin »', question && j3.at(-1)?.e === 'question|infinite|look' && !j3.some((x) => x.e.startsWith('fin|')), lire(j3));
    if (CAPTURES) { fs.mkdirSync(CAPTURES, { recursive: true }); await page.screenshot({ path: `${CAPTURES}/mascotte-question.png` }); }
    await ctx.close();

    // ── Positions : sous chaque skin, clair et sombre, ordinateur et mobile (page chargée à sa taille, comme sur l'appareil) ──
    for (const skin of SKINS) for (const sombre of [false, true]) {
        await api.req('PUT', '/api/settings', { skin, dark_mode: sombre, dark_mode_auto: false });
        for (const ecran of ECRANS) {
            const nom = `${skin || 'ardoise'} ${sombre ? 'sombre' : 'clair'}, ${ecran.nom}`;
            const c = await contexteConnecte(nav, core.urlMain, core.comptes.admin, { viewport: { width: ecran.width, height: ecran.height } });
            const pg = await c.newPage();
            pg.on('pageerror', (e) => erreurs.push(`${nom} : ${String(e.message || e)}`));
            await pg.goto(core.urlMain + '/');
            await attendreMontage(pg);
            const volet = pg.locator('button[aria-label="Ouvrir le volet"]:visible');
            if (await volet.count()) { await volet.first().click(); await pause(300); }
            await pg.locator('[data-chat-row]', { hasText: 'Positions' }).first().click();
            await pg.waitForFunction(() => document.body.innerText.includes('Positions : question 1'), null, { timeout: 15000 }).catch(() => {});
            const fermer = pg.locator('button[aria-label="Fermer le volet"]:visible');
            if (ecran.width < 1024 && await fermer.count()) { await fermer.first().click(); await pause(300); }
            core.llm.scripter('Réponse brève pour poser la mascotte.');
            await pg.locator('textarea[placeholder]').last().fill('Encore');
            await pg.locator('button:has(i.ph-paper-plane-right)').last().click();
            const posee = await pg.waitForFunction(() => {
                const p = document.querySelector('.perchoir');
                return !!p && p.style.left === '31%' && p.querySelector('.socle-mascotte')?.dataset.etat === 'repos';
            }, null, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
            await pg.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === 'Aller en bas'); if (b && b.getClientRects().length) b.click(); });
            await pause(500);
            const m = await pg.evaluate(MESURER);
            const detail = JSON.stringify(m);
            v.ok(`${nom} : posée, entière à l'écran et non rognée`, posee && !m.absente && m.dansEcran && m.rogneePar.length === 0, detail);
            v.ok(`${nom} : au premier plan, opaque, sa planche chargée`, !m.absente && m.couvertPar.length === 0 && m.opacite > 0.99 && m.image, detail);
            v.ok(`${nom} : pieds sur le bord de la barre, sans couvrir une commande ni le texte du fil`, !m.absente && m.pieds !== null && m.pieds >= 0 && m.pieds <= 12 && m.commandes.length === 0 && m.textes.length === 0, detail);
            if (CAPTURES) await pg.screenshot({ path: `${CAPTURES}/mascotte-${skin || 'ardoise'}-${sombre ? 'sombre' : 'clair'}-${ecran.nom}.png` });
            await c.close();
        }
    }
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
    await lent.arreter?.();
}
process.exit(v.bilan());
