// SPDX-License-Identifier: MIT
// browser-service/test/outils_web_correctifs.integration.test.js — vrai service et Chromium contre des pages locales (127.0.0.1, garde ouverte pour l'essai seulement) : clic qui navigue dans le délai du client, goto en échec, recorder sans secret, même cible même élément dans tous les outils, délai explicite d'une étape, sélecteurs uniques en shadow DOM, contenu de la page jamais masqué.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';

import { demarrerService, portLibre, raisonDeSauter } from './aides/service.js';

const SAUTER = await raisonDeSauter('chromium');
const OWNER = 'correctifs';
// Script de tête servi après le délai du client (10 s) : DOMContentLoaded de /dcl n'arrive pas à temps.
const SCRIPT_LENT_MS = 12000;
const PAGES = {
    '/': '<title>Accueil</title><a id="lent" href="/dcl">lent</a> <a id="vite" href="/cible">vite</a>',
    '/cible': '<title>Cible</title><p>cible</p>',
    '/form': '<title>Formulaire</title><input id="champ"><button id="envoyer" onclick="document.title=\'envoyé\'">Envoyer</button>',
    '/mdp': '<title>Mot de passe</title><label>Current password <input type="password" id="actuel"></label>'
        + '<label>New password <input type="password" id="nouveau"></label><label>Confirm <input type="password" id="confirme"></label>',
    '/boutons': '<title>Boutons</title><p id="out"></p><button id="r" onclick="out.textContent=\'r\'">Restart</button>'
        + '<button id="s1" onclick="out.textContent=\'s1\'" disabled>Start</button><button id="s2" onclick="out.textContent=\'s2\'">Start</button>',
    '/ombre': '<title>Ombre</title><button onclick="window.last=\'clair:Go\'">Go</button><my-c data-n="1"></my-c><my-c data-n="2"></my-c>'
        + '<script>customElements.define(\'my-c\', class extends HTMLElement { constructor() { super();'
        + ' const r = this.attachShadow({ mode: \'open\' }); r.innerHTML = \'<div><button>Go</button><button>Stop</button></div>\';'
        + ' for (const b of r.querySelectorAll(\'button\')) b.onclick = () => { window.last = this.dataset.n + \':\' + b.textContent; }; } });</script>',
    '/chemins': `<title>Chemins</title><p id="t">Voir ${os.homedir()}/notes.txt ; dépôt http://git.lan${os.homedir()} ; fin</p>`,
    '/tardif': '<title>Tardif</title><p id="out"></p><script>setTimeout(() => { const b = document.createElement(\'button\');'
        + ' b.textContent = \'Valider\'; b.onclick = () => { out.textContent = \'v\'; }; document.body.append(b); }, 3000)</script>',
};

let service = null;
let pages = null;
let base = '';
let sid = '';

// Pages d'essai ; /dcl attend son script de tête, servi après SCRIPT_LENT_MS.
function gestionnaire(req, res) {
    const chemin = req.url.split('?')[0];
    if (chemin === '/dcl') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Lente</title><script src="/script-lent"></script></head><body>lente</body></html>');
        return;
    }
    if (chemin === '/script-lent') {
        const t = setTimeout(() => { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('//'); }, SCRIPT_LENT_MS);
        res.on('close', () => clearTimeout(t));
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGES[chemin] || `<title>${chemin}</title>`);
}

const api = (route, corps = {}) => service.post(route, { owner: OWNER, session_id: sid, ...corps });
const ouvrir = (chemin) => api('/action', { type: 'goto', url: `${base}${chemin}` });

before(async () => {
    if (SAUTER) return;
    pages = http.createServer(gestionnaire);
    await new Promise(r => pages.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${pages.address().port}`;
    service = await demarrerService();
    const r = await service.post('/start', { owner: OWNER, url: `${base}/`, isolated: true });
    assert.equal(r.statut, 200, r.texte);
    sid = r.corps.session_id;
});

after(async () => {
    if (service) await service.arreter();
    if (pages) { pages.closeAllConnections(); await new Promise(r => pages.close(r)); }
});

test('clic vers une page au DOMContentLoaded lent : succès avant le délai du client, URL d\'arrivée et nav_warning', { skip: SAUTER, timeout: 60000 }, async () => {
    // Délais du client : 10 s pour /action, 60 s pour /chain (10 s d'attente d'arrivée au plus par étape).
    for (const [route, corps, maxMs] of [['/action', { type: 'click', by_css: '#lent' }, 9800],
                                         ['/chain', { actions: [{ type: 'click', by_css: '#lent' }] }, 11500]]) {
        await ouvrir('/');
        const t0 = Date.now();
        const r = await api(route, corps);
        const ms = Date.now() - t0;
        assert.equal(r.statut, 200, r.texte);
        const res = route === '/chain' ? r.corps.results[0] : r.corps;
        assert.notEqual(res.success, false, r.texte);
        assert.ok(ms < maxMs, `${route} : ${ms} ms`);
        assert.equal(res.url, `${base}/dcl`, r.texte);
        assert.equal(res.navigated, true, r.texte);
        assert.match(res.nav_warning || '', /^navigation still loading/, r.texte);
    }
    await ouvrir('/');
    const vite = await api('/action', { type: 'click', by_css: '#vite' });
    assert.equal(vite.corps.url, `${base}/cible`, vite.texte);
    assert.equal(vite.corps.nav_warning, undefined, vite.texte);
});

// URL que montre vraiment l'onglet actif.
async function urlActive() {
    const r = await service.get(`/list_tabs?owner=${OWNER}&session_id=${sid}`);
    return r.corps.tabs.find(o => o.active).url;
}

test('goto en échec : URL réelle de l\'onglet, retour à la page précédente annoncé, jamais « intact » à tort', { skip: SAUTER, timeout: 90000 }, async () => {
    for (const cible of [`https://127.0.0.1:${await portLibre()}/`, 'https://domaine-inexistant.invalid/']) {
        await ouvrir('/form');
        const r = await api('/action', { type: 'goto', url: cible });
        assert.equal(r.statut, 502, r.texte);
        assert.equal(r.corps.code, 'navigation_failed', r.texte);
        assert.equal(r.corps.url, await urlActive(), r.texte);
        assert.equal(r.corps.url, `${base}/form`, r.texte);
        assert.doesNotMatch(r.corps.fix, /intact/, r.texte);
        assert.match(r.corps.fix, /went back to the page it showed before/, r.texte);
        const clic = await api('/action', { type: 'click', by_css: '#envoyer' });
        assert.equal(clic.statut, 200, clic.texte);
    }
});

test('recorder : aucun secret par eval ni par l\'URL, dans aucun format ; une variable par champ mot de passe', { skip: SAUTER, timeout: 90000 }, async () => {
    await ouvrir('/mdp');
    await api('/recorder/start');
    for (const [champ, valeur] of [['#actuel', 'ancien-SECRET-1'], ['#nouveau', 'neuf-SECRET-2'], ['#confirme', 'neuf-SECRET-2']])
        assert.equal((await api('/action', { type: 'fill', by_css: champ, text: valeur })).statut, 200);
    const chaine = await api('/chain', { actions: [{ type: 'fill', by_css: '#actuel', text: 'ancien-SECRET-1' }] });
    assert.equal(chaine.corps.ok, true, chaine.texte);
    assert.equal((await api('/evaluate', { script: "document.querySelector('#actuel').value='hunter2-SECRET'; return 1" })).statut, 200);
    assert.equal((await api('/evaluate', { script: 'document.querySelector("#nouveau").value = "hunter3-SECRET"', in_all_frames: true })).statut, 200);
    const r = await ouvrir('/cible?token=SECRET-URL-123&page=2#access_token=SECRET-FRAG&state=ok');
    assert.equal(r.statut, 200, r.texte);
    await api('/recorder/stop');
    for (const format of ['playwright', 'cypress', 'robot', 'json']) {
        const d = await service.get(`/recorder/dump?owner=${OWNER}&session_id=${sid}&format=${format}`);
        assert.equal(d.statut, 200, d.texte);
        assert.doesNotMatch(d.texte, /SECRET/, `${format} : ${d.corps.script}`);
        assert.deepEqual(d.corps.secret_variables, ['PASSWORD', 'PASSWORD_2', 'PASSWORD_3'], format);
        if (format === 'playwright') {
            for (const [champ, variable] of [['#actuel', 'PASSWORD'], ['#nouveau', 'PASSWORD_2'], ['#confirme', 'PASSWORD_3']])
                assert.match(d.corps.script, new RegExp(`locator\\('${champ}'\\)\\.fill\\(process\\.env\\.${variable} \\?\\? ''\\)`), d.corps.script);
            assert.equal(d.corps.script.match(/process\.env\.PASSWORD \?\?/g).length, 2, d.corps.script);
            assert.match(d.corps.script, /token=\*\*\*&page=2#access_token=\*\*\*&state=ok/, d.corps.script);
        }
    }
});

// Bouton cliqué en dernier sur /boutons (vidé ensuite).
async function clique() {
    const r = await api('/evaluate', { script: "const t = out.textContent; out.textContent = ''; return t" });
    return r.corps.result;
}

test('même cible, même élément : nom entier préféré et nth compté de même dans pw_find, pw_expect, pw_act et pw_chain', { skip: SAUTER, timeout: 60000 }, async () => {
    await ouvrir('/boutons');
    const cible = { by_role: 'button', by_name: 'Start' };
    const trouve = await api('/locator', { ...cible, nth: 1, visible_only: false });
    assert.deepEqual(trouve.corps.matches.map(m => m.xpath), ['//*[@id="s2"]'], trouve.texte);
    const actif = await api('/expect', { ...cible, nth: 1, assertion: 'enabled', timeout_ms: 500 });
    assert.equal(actif.corps.pass, true, actif.texte);
    assert.equal((await api('/action', { type: 'click', ...cible, nth: 1 })).statut, 200);
    assert.equal(await clique(), 's2');
    const chaine = await api('/chain', { actions: [{ type: 'click', ...cible, nth: 1 }] });
    assert.equal(chaine.corps.ok, true, chaine.texte);
    assert.equal(await clique(), 's2');
    const tous = await api('/locator', { ...cible, visible_only: false });
    assert.deepEqual(tous.corps.matches.map(m => m.xpath), ['//*[@id="s1"]', '//*[@id="s2"]'], tous.texte);
    const premier = await api('/expect', { ...cible, assertion: 'text-equals', value: 'Start', timeout_ms: 500 });
    assert.equal(premier.corps.pass, true, premier.texte);
    const inactif = await api('/expect', { ...cible, assertion: 'disabled', timeout_ms: 500 });
    assert.equal(inactif.corps.pass, true, inactif.texte);
    const parRef = await api('/action', { type: 'click', ref: tous.corps.matches[1].ref });
    assert.equal(parRef.statut, 200, parRef.texte);
    assert.equal(await clique(), 's2');
});

test('délai explicite d\'une étape : il allonge aussi l\'attente de présence (écran construit en 3 s)', { skip: SAUTER, timeout: 60000 }, async () => {
    const cible = { by_role: 'button', by_name: 'Valider', timeout: 8000 };
    await ouvrir('/tardif');
    const chaine = await api('/chain', { actions: [{ type: 'click', ...cible }] });
    assert.equal(chaine.corps.ok, true, chaine.texte);
    assert.equal(await clique(), 'v');
    await ouvrir('/tardif');
    const action = await api('/action', { type: 'click', ...cible });
    assert.equal(action.statut, 200, action.texte);
    assert.equal(await clique(), 'v');
    await ouvrir('/tardif');
    const court = await api('/action', { type: 'click', by_role: 'button', by_name: 'Valider' });
    assert.equal(court.corps.code, 'element_not_found', court.texte);
});

test('pw_observe en shadow DOM : chaque sélecteur désigne un seul élément pour Playwright, le bon', { skip: SAUTER, timeout: 60000 }, async () => {
    await ouvrir('/ombre');
    const vue = await service.get(`/observe?owner=${OWNER}&session_id=${sid}&mode=indexed&viewport_only=false`);
    const items = vue.corps.items.filter(it => /^(Go|Stop)$/.test(it.text));
    assert.equal(items.length, 5, vue.texte);
    const cliques = [];
    for (const it of items) {
        assert.equal(it.target_dsl, `css=${it.selector}`);
        const n = await api('/locator', { by_css: it.selector, visible_only: false, max: 5 });
        assert.equal(n.corps.total, 1, `${it.selector} : ${n.texte}`);
        await api('/evaluate', { script: 'window.last = null; return 1' });
        assert.equal((await api('/action', { type: 'click', by_css: it.selector, strict: true })).statut, 200, it.selector);
        cliques.push((await api('/evaluate', { script: 'return window.last' })).corps.result);
    }
    assert.deepEqual(cliques.sort(), ['1:Go', '1:Stop', '2:Go', '2:Stop', 'clair:Go']);
});

test('contenu de la page jamais réécrit : texte et URL citant le dossier du service, Date et URL d\'un eval', { skip: SAUTER, timeout: 60000 }, async () => {
    await ouvrir('/chemins');
    const attendu = `Voir ${os.homedir()}/notes.txt ; dépôt http://git.lan${os.homedir()} ; fin`;
    const texte = await api('/extract_text', {});
    assert.ok(texte.texte.includes(attendu), texte.texte);
    const lu = await api('/evaluate', { script: "return document.querySelector('#t').textContent" });
    assert.equal(lu.corps.result, attendu);
    const objets = await api('/evaluate', { script: "return { quand: new Date(0), ou: new URL('http://a.lan/x'), liste: [new Date(86400000)] }" });
    assert.deepEqual(objets.corps.result, { quand: '1970-01-01T00:00:00.000Z', ou: 'http://a.lan/x', liste: ['1970-01-02T00:00:00.000Z'] });
});
