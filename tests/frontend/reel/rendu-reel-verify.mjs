// SPDX-License-Identifier: MIT
/** tests/frontend/reel/rendu-reel-verify.mjs — rendu des messages contre le core TS réel : coloration et Mermaid chargés à la demande, purification d'un message piégé (sans coloration), blocs de code (Copier, Aperçu HTML exécuté sous CSP), export PDF (impression), flux d'un gros bloc (ni texte brut, ni coloration, caret injecté), recherche */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/rendu-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';
import { wrapLibs } from '../../perf/lib/harness.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const EN_STREAM = 'button[title="Arrêter la génération"]';
const HTML = '<!doctype html>\n<html><head><title>Démo</title></head>\n<body><h1>Bonjour</h1><p id="etat">avant</p>'
    + '<script>document.getElementById("etat").textContent = "SCRIPT_OK"; parent.postMessage("apercu-script-ok", "*");</script></body></html>';
const DIAGRAMME = 'graph TD\n  A[Départ] --> B{Choix}\n  B -->|oui| C[Fin heureuse]\n  B -->|non| D[Autre fin]';
const FIXTURES = [
    ['Sans diagramme', 'Bonjour ! Voici du code :\n\n```js\nconst x = 1;\n```\n'],
    ['Demo HTML', 'Voici une page :\n\n```html\n' + HTML + '\n```\n'],
    ['Avec diagramme', 'Voici :\n\n```mermaid\n' + DIAGRAMME + '\n```\n'],
    ['Message piégé', 'Texte normal.\n\n<img src=x onerror="window.__xss=1">\n\n<script>window.__xss=2<\/script>\n\n<a href="javascript:window.__xss=3">lien</a>'],
];

const v = verifications('rendu-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    for (const [titre, reponse] of FIXTURES) {
        const { id } = await api.req('POST', '/api/saved/chats/new', {});
        await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: titre, messages: [{ role: 'user', content: `Question de ${titre}` }, { role: 'assistant', content: reponse }] });
    }
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    const consoleErreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErreurs.push(m.text()); });
    const hljs = [];
    const mermaid = [];
    page.on('request', (r) => {
        if (/highlight\.min[-.][\w-]*\.?js/.test(r.url())) hljs.push(r.url());
        if (/mermaid\.min[-.][\w-]*\.?js/.test(r.url())) mermaid.push(r.url());
    });
    const ouvrir = async (titre) => {
        await page.locator('[data-chat-row]', { hasText: titre }).first().click();
        await page.waitForFunction((t) => document.body.innerText.includes(t), `Question de ${titre}`, { timeout: 15000 }).catch(() => {});
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: 'Demo HTML' }).first().waitFor({ timeout: 15000 });
    await pause(800);

    // ── Rien de lourd tant qu'aucun bloc n'est à l'écran ; purification indépendante de la coloration ──
    v.ok('coloration absente au premier rendu (ni hljs, ni téléchargement)', await page.evaluate(() => typeof window.hljs === 'undefined') && hljs.length === 0, hljs.join(' | '));
    v.ok('Mermaid absent au premier rendu', mermaid.length === 0 && await page.evaluate(() => typeof window.mermaid === 'undefined'));
    await ouvrir('Message piégé');
    await page.waitForFunction(() => document.body.innerText.includes('Texte normal.'), null, { timeout: 10000 }).catch(() => {});
    await pause(500);
    const piege = await page.evaluate(() => {
        const bulle = [...document.querySelectorAll('.markdown-body')].find((n) => n.textContent.includes('Texte normal.'));
        return { bulle: !!bulle, onerror: !!(bulle && bulle.querySelector('[onerror]')), script: !!(bulle && bulle.querySelector('script')), js: !!(bulle && bulle.querySelector('a[href^="javascript"]')), xss: window.__xss || 0 };
    });
    v.ok('purification sans hljs : onerror, <script> et lien javascript: retirés, rien d\'exécuté', piege.bulle && !piege.onerror && !piege.script && !piege.js && piege.xss === 0 && hljs.length === 0, JSON.stringify(piege));

    // ── Coloration à la demande ──
    await ouvrir('Sans diagramme');
    await page.waitForFunction(() => !!document.querySelector('pre code.hljs span[class^="hljs-"]'), null, { timeout: 20000 }).catch(() => {});
    v.ok('hljs téléchargé une fois à l\'ouverture d\'un chat avec du code', hljs.length === 1, String(hljs.length));
    v.ok('le bloc est coloré, texte intact', await page.evaluate(() => {
        const c = document.querySelector('pre code.hljs');
        return !!c && c.querySelectorAll('span[class^="hljs-"]').length > 0 && c.textContent.includes('const x = 1');
    }));
    v.ok('Mermaid toujours absent sur un chat sans diagramme', mermaid.length === 0);

    // ── Bloc HTML : Copier et Aperçu ──
    await ouvrir('Demo HTML');
    await page.locator('.code-wrapper .code-header').first().waitFor({ timeout: 10000 }).catch(() => {});
    const sticky = page.locator('.code-wrapper .copy-sticky').first();
    v.ok('groupe d\'actions du bloc en position sticky', (await sticky.evaluate((el) => getComputedStyle(el).position).catch(() => '')) === 'sticky');
    const copier = page.locator('.code-wrapper .copy-sticky .code-actions .copy-btn').first();
    const apercu = page.locator('.code-wrapper .copy-sticky .code-actions button:not(.copy-btn)').first();
    const [cb, ab] = [await copier.boundingBox().catch(() => null), await apercu.boundingBox().catch(() => null)];
    v.ok('Copier et Aperçu visibles et disjoints', !!(cb && ab) && (cb.x >= ab.x + ab.width - 1 || ab.x >= cb.x + cb.width - 1));
    const pre = page.locator('.code-wrapper pre').first();
    // Côté page : messages reçus de l'aperçu et violations de la CSP (appliquée par le core).
    await page.evaluate(() => {
        window.__apercuMsgs = [];
        window.__violations = [];
        addEventListener('message', (e) => window.__apercuMsgs.push(e.data));
        document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.effectiveDirective + ' ' + e.blockedURI));
    });
    await apercu.click();
    await page.locator('.code-preview-frame').first().waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('Aperçu : iframe affichée à la place du code, bouton « Code »', await page.locator('.code-preview-frame').first().isVisible().catch(() => false)
        && !(await pre.isVisible().catch(() => true)) && /Code/.test(await apercu.innerText().catch(() => '')));
    await apercu.click();
    await pause(300);
    v.ok('« Code » : retour au code, iframe retirée', await pre.isVisible().catch(() => false) && await page.locator('.code-preview-frame').count() === 0);
    await apercu.click();
    await page.locator('.code-preview-frame').first().waitFor({ timeout: 5000 }).catch(() => {});
    const cadre = page.locator('.code-preview-frame').first();
    const attrs = await cadre.evaluate((el) => [new URL(el.src).pathname, el.getAttribute('sandbox'), el.hasAttribute('srcdoc')]).catch(() => []);
    v.ok('second aperçu : document d\'aperçu du core, sandbox allow-scripts seul, pas de srcdoc', JSON.stringify(attrs) === JSON.stringify(['/apercu-code', 'allow-scripts', false]), JSON.stringify(attrs));
    const etat = await (await cadre.elementHandle()).contentFrame().then((f) => f.locator('#etat').textContent({ timeout: 5000 })).catch(() => '');
    await page.waitForFunction(() => window.__apercuMsgs.includes('apercu-script-ok'), null, { timeout: 5000 }).catch(() => {});
    const cote = await page.evaluate(() => ({ msgs: window.__apercuMsgs, violations: window.__violations }));
    v.ok('aperçu : le script en ligne du HTML s\'exécute sous la CSP de la page (DOM du cadre, postMessage reçu)', etat === 'SCRIPT_OK' && cote.msgs.includes('apercu-script-ok'), JSON.stringify({ etat, ...cote }));
    v.ok('aperçu : aucune violation de CSP côté page', cote.violations.length === 0, cote.violations.join(' | '));

    // ── Export PDF : la fenêtre about:blank hérite de la CSP ; l'impression part de la page ──
    await page.evaluate(() => {
        window.__impression = 0;
        const ouvrir = window.open;
        window.open = (...a) => {
            const w = ouvrir.apply(window, a);
            if (w) w.print = () => { window.__impression++; };
            return w;
        };
    });
    await page.evaluate(() => window.__racine().exportChatAs('pdf'));
    await page.waitForFunction(() => window.__impression > 0, null, { timeout: 5000 }).catch(() => {});
    const impression = await page.evaluate(() => ({ n: window.__impression, violations: window.__violations }));
    v.ok('export PDF : impression appelée une fois, sans violation de CSP', impression.n === 1 && impression.violations.length === 0, JSON.stringify(impression));
    for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});

    // ── Mermaid : téléchargé une fois, diagramme peint ──
    await ouvrir('Avec diagramme');
    await page.waitForFunction(() => !!document.querySelector('.mermaid-render svg'), null, { timeout: 20000 }).catch(() => {});
    const svg = await page.evaluate(() => {
        const el = document.querySelector('.mermaid-render svg');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), noeuds: el.querySelectorAll('g').length };
    });
    v.ok('Mermaid téléchargé une fois, diagramme peint avec ses nœuds', mermaid.length === 1 && !!svg && svg.w > 40 && svg.h > 20 && svg.noeuds >= 3, JSON.stringify({ n: mermaid.length, svg }));
    await ouvrir('Sans diagramme');
    await ouvrir('Avec diagramme');
    await page.waitForFunction(() => !!document.querySelector('.mermaid-render svg'), null, { timeout: 10000 }).catch(() => {});
    v.ok('aller-retour : diagramme repeint sans second téléchargement', mermaid.length === 1 && await page.evaluate(() => !!document.querySelector('.mermaid-render svg')));

    // ── Flux d'un gros bloc de code ──
    await ouvrir('Sans diagramme');
    await wrapLibs(page);
    await page.evaluate(() => {
        window.__perf = window.__perf || {};
        Object.assign(window.__perf, { hl: { n: 0, ms: 0, max: 0 }, hlAuto: { n: 0, ms: 0, max: 0 }, parse: window.__perf.parse || { n: 0, ms: 0, max: 0 } });
    });
    const gros = 'Voici le script :\n```python\n' + Array.from({ length: 700 }, (_, i) => `def f_${i}(x):\n    return x * ${i}  # commentaire`).join('\n') + '\n```\nEt voilà le résultat final.';
    core.llm.scripter({ contenu: gros, tokParS: 1500 });
    await page.locator('textarea[placeholder]').last().fill('Écris un long script.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForSelector(EN_STREAM, { timeout: 15000 }).catch(() => {});
    const acc = { ticks: 0, caret: 0, injecte: 0, prewrap: 0, spans: 0 };
    for (let i = 0; i < 400; i++) {
        const s = await page.evaluate((sel) => {
            const out = { flux: !!document.querySelector(sel) };
            const bulle = document.querySelector('.markdown-body[aria-busy]');
            if (!bulle) return out;
            const caret = bulle.querySelector('.elpis-stream-caret');
            return { ...out, vu: true, caret: !!caret, injecte: !!(caret && caret.parentElement !== bulle), prewrap: !!bulle.querySelector('div[style*="pre-wrap"]'), spans: bulle.querySelectorAll('[class*="hljs-"]').length };
        }, EN_STREAM);
        if (!s.flux) break;
        if (s.vu) {
            acc.ticks++;
            if (s.caret) acc.caret++;
            if (s.injecte) acc.injecte++;
            if (s.prewrap) acc.prewrap++;
            acc.spans = Math.max(acc.spans, s.spans);
        }
        await pause(150);
    }
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 120000 }).catch(() => {});
    v.ok('assez d\'échantillons pendant le flux (≥ 8)', acc.ticks >= 8, JSON.stringify(acc));
    v.ok('pendant le flux : le bloc ne bascule jamais en texte brut', acc.prewrap === 0, JSON.stringify(acc));
    v.ok('pendant le flux : aucune coloration dans la bulle', acc.spans === 0, JSON.stringify(acc));
    v.ok('pendant le flux : caret présent et injecté dans le texte', acc.caret >= acc.ticks * 0.5 && acc.injecte >= acc.caret * 0.8, JSON.stringify(acc));
    const appelsHl = await page.evaluate(() => (window.__perf.hl ? window.__perf.hl.n : 0) + (window.__perf.hlAuto ? window.__perf.hlAuto.n : 0));
    v.ok(`hljs quasi silencieux sur le tour (${appelsHl} appels ≤ 6)`, appelsHl <= 6);
    const fin = await page.evaluate(() => ({ colore: document.querySelectorAll('.markdown-body [class*="hljs-"]').length, faits: document.querySelectorAll('pre[data-cb-done]').length, copier: document.querySelectorAll('.copy-btn').length, texte: ([...document.querySelectorAll('.markdown-body')].pop() || {}).textContent || '' }));
    v.ok('au repos : réponse complète, code coloré, blocs enrichis (Copier)', fin.texte.includes('résultat final') && fin.colore > 0 && fin.faits > 0 && fin.copier > 0, JSON.stringify({ ...fin, texte: fin.texte.slice(-40) }));

    // ── Recherche dans la conversation : les blocs gardent leurs boutons ──
    await page.locator('button[aria-label="Conversation"]').click();
    await page.locator('header [role="menuitem"]', { hasText: 'Rechercher' }).click();
    const champ = page.locator('input[placeholder="Rechercher dans la conversation..."]');
    await champ.waitFor({ state: 'visible', timeout: 5000 });
    await champ.fill('script');
    await pause(700);
    const pendant = await page.evaluate(() => ({ copier: document.querySelectorAll('.copy-btn').length, faits: document.querySelectorAll('pre[data-cb-done]').length }));
    v.ok('recherche active : boutons Copier conservés', pendant.copier > 0 && pendant.faits > 0, JSON.stringify(pendant));
    await champ.press('Escape');
    await pause(300);
    const apres = await page.evaluate(() => ({ copier: document.querySelectorAll('.copy-btn').length, colore: document.querySelectorAll('.markdown-body [class*="hljs-"]').length }));
    v.ok('recherche fermée : coloration et boutons de retour', apres.copier > 0 && apres.colore > 0, JSON.stringify(apres));

    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
    v.ok('aucune erreur console liée à Mermaid ou à la coloration', !consoleErreurs.some((t) => /mermaid|hljs|highlight/i.test(t)), consoleErreurs.slice(0, 3).join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
