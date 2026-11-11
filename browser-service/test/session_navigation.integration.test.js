// SPDX-License-Identifier: MIT
// test/session_navigation.integration.test.js — vrai service et vrai navigateur (headless shell de Chromium) contre des pages d'essai locales : navigation en échec, popups, onglets, statut HTTP, certificat expiré, /health.
//
//     node --test test/session_navigation.integration.test.js
//
// Sans les dépendances du service (npm ci) ou sans navigateur installé, tout est ignoré. Aucun accès réseau :
// les pages sont servies sur 127.0.0.1, que la garde d'adresse laisse passer pour ces essais seulement (test/aides).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { demarrerService, portLibre, raisonDeSauter } from './aides/service.js';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'outils-mcp', 'goldens', 'browser.json');
const SAUTER = await raisonDeSauter();

const PAGES = {
    '/': '<title>Accueil</title><a id="nouvel" target="_blank" href="/fenetre">Click Here</a>'
       + '<button id="ouvrir" onclick="window.open(\'/fenetre-script\')">Open</button>'
       + '<button id="ephemere" onclick="window.open(\'/se-ferme\')">Ephemeral</button>',
    '/fenetre': '<title>New Window</title><h3>New Window</h3>',
    '/se-ferme': '<title>Bref</title><script>setTimeout(() => window.close(), 100)</script>',
    '/cible': '<title>Cible</title><p>cible</p>',
};
const STATUTS = { '/introuvable': 404, '/indisponible': 503 };

let service = null;
let pages = null;
let tls = null;
let dossierTls = null;

// Pages d'essai : liens et scripts qui ouvrent des onglets, statuts 404/503, redirection.
function gestionnaire(req, res) {
    const chemin = req.url.split('?')[0];
    if (chemin === '/redirige') { res.writeHead(302, { location: '/cible' }); res.end(); return; }
    res.writeHead(STATUTS[chemin] || 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGES[chemin] || `<title>${chemin}</title><p>page ${chemin}</p>`);
}

// Serveur local écoutant sur un port libre de 127.0.0.1.
async function ecouter(serveur) {
    await new Promise(r => serveur.listen(0, '127.0.0.1', r));
    return { serveur, base: `${serveur instanceof https.Server ? 'https' : 'http'}://127.0.0.1:${serveur.address().port}` };
}

// Serveur HTTPS au certificat auto-signé expiré (openssl 3 requis), sinon null.
async function serveurTlsExpire() {
    dossierTls = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-tls-'));
    const cle = path.join(dossierTls, 'cle.pem');
    const cert = path.join(dossierTls, 'cert.pem');
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                                 '-keyout', cle, '-out', cert, '-subj', '/CN=127.0.0.1',
                                 '-not_before', '20200101000000Z', '-not_after', '20210101000000Z'], { stdio: 'ignore' });
    } catch (_) { return null; }
    return ecouter(https.createServer({ key: fs.readFileSync(cle), cert: fs.readFileSync(cert) }, gestionnaire));
}

// Écarts d'une valeur au schéma JSON (anyOf, const, type, items, properties, required) : [] si conforme.
function ecartsSchema(schema, v, chemin = '$') {
    if (schema.anyOf) return schema.anyOf.some(s => !ecartsSchema(s, v, chemin).length) ? [] : [`${chemin} : ${JSON.stringify(v)} hors de anyOf`];
    if ('const' in schema && v !== schema.const) return [`${chemin} ≠ ${JSON.stringify(schema.const)}`];
    const types = {
        null: v === null, boolean: typeof v === 'boolean', string: typeof v === 'string', integer: Number.isInteger(v),
        number: typeof v === 'number', array: Array.isArray(v), object: v !== null && typeof v === 'object' && !Array.isArray(v),
    };
    if (schema.type && !types[schema.type]) return [`${chemin} : ${JSON.stringify(v)} n'est pas ${schema.type}`];
    const ecarts = [];
    if (schema.type === 'array' && schema.items) v.forEach((x, i) => ecarts.push(...ecartsSchema(schema.items, x, `${chemin}[${i}]`)));
    if (schema.type === 'object') {
        for (const k of schema.required || []) if (!(k in v)) ecarts.push(`${chemin}.${k} manquant`);
        for (const [k, s] of Object.entries(schema.properties || {})) if (k in v) ecarts.push(...ecartsSchema(s, v[k], `${chemin}.${k}`));
    }
    return ecarts;
}

// Session isolée (ou partagée) d'un compte ouverte sur une page d'essai.
async function ouvrir(owner, url, isolated = true) {
    const r = await service.post('/start', { owner, url, isolated });
    assert.equal(r.statut, 200, r.texte);
    return r.corps;
}

before(async () => {
    if (SAUTER) return;
    pages = await ecouter(http.createServer(gestionnaire));
    tls = await serveurTlsExpire();
    service = await demarrerService();
});

after(async () => {
    if (service) await service.arreter();
    for (const s of [pages, tls]) if (s) await new Promise(r => s.serveur.close(r));
    if (dossierTls) fs.rmSync(dossierTls, { recursive: true, force: true });
});

test('goto injoignable : navigation_failed sans séquences ANSI, session et onglet intacts, goto suivant réussi (session partagée puis isolée, 3 fois)',
     { skip: SAUTER, timeout: 240000 }, async () => {
    const ferme = `https://127.0.0.1:${await portLibre()}/`;
    for (const isolated of [false, true]) {
        const owner = isolated ? 'nav-isolee' : 'nav-partagee';
        const { session_id: sid } = await ouvrir(owner, `${pages.base}/`, isolated);
        for (const cible of [ferme, 'https://domaine-inexistant.invalid/', ferme]) {
            const r = await service.post('/action', { owner, session_id: sid, type: 'goto', url: cible });
            assert.equal(r.statut, 502, r.texte);
            assert.equal(r.corps.code, 'navigation_failed');
            assert.ok(r.corps.error.startsWith(`Navigation to ${cible} failed: `), r.corps.error);
            assert.ok(!/\u001b|Call log/.test(r.texte), r.texte);
            const onglets = await service.get(`/list_tabs?owner=${owner}&session_id=${sid}`);
            assert.equal(onglets.statut, 200, `session perdue après l'échec : ${onglets.texte}`);
            assert.equal(onglets.corps.count, 1);
            const liste = await service.get(`/sessions?owner=${owner}`);
            assert.deepEqual(liste.corps.sessions.map(x => x.session_id), [sid]);
            const suite = await service.post('/action', { owner, session_id: sid, type: 'goto', url: `${pages.base}/cible` });
            assert.equal(suite.statut, 200, suite.texte);
            assert.equal(suite.corps.http_status, 200);
        }
        assert.ok(!/page_crash_on_request|owner_session_dead/.test(service.journal()), service.journal());
        await service.post('/stop', { owner, session_id: sid });
    }
});

test('popup (target=_blank, window.open) : onglet ajouté sans bascule, annoncé par opened_tab ; onglet qui se ferme seul retiré',
     { skip: SAUTER, timeout: 120000 }, async () => {
    const owner = 'popups';
    const { session_id: sid } = await ouvrir(owner, `${pages.base}/`);
    const clic = (css) => service.post('/action', { owner, session_id: sid, type: 'click', by_css: css });
    let r = await clic('#nouvel');
    assert.equal(r.statut, 200, r.texte);
    assert.deepEqual({ ...r.corps.opened_tab, note: undefined },
                     { index: 1, url: `${pages.base}/fenetre`, active: false, note: undefined,
                       switch_with: 'pw_page(action="tab_switch", index=1)' });
    let onglets = await service.get(`/list_tabs?owner=${owner}&session_id=${sid}`);
    assert.equal(onglets.corps.count, 2);
    assert.equal(onglets.corps.active, 0);
    r = await clic('#ouvrir');
    assert.equal(r.corps.opened_tab.index, 2);
    assert.equal(r.corps.opened_tab.url, `${pages.base}/fenetre-script`);
    r = await service.post('/switch_tab', { owner, session_id: sid, tab_index: 1 });
    assert.equal(r.corps.active, 1);
    r = await service.post('/extract_text', { owner, session_id: sid });
    assert.match(r.corps.text ?? r.corps.content ?? '', /New Window/);
    await service.post('/switch_tab', { owner, session_id: sid, tab_index: 0 });
    const annonces = [(await clic('#ephemere')).corps];
    const limite = Date.now() + 10000;
    do {
        onglets = await service.get(`/list_tabs?owner=${owner}&session_id=${sid}`);
        annonces.push(onglets.corps);
        if (annonces.some(a => a.closed_tab)) break;
        await new Promise(res => setTimeout(res, 200));
    } while (Date.now() < limite);
    assert.deepEqual(annonces.find(a => a.closed_tab).closed_tab, { index: 3, url: `${pages.base}/se-ferme`, active: 0 });
    assert.equal(onglets.statut, 200);
    assert.equal(onglets.corps.count, 3, onglets.texte);
    assert.equal(onglets.corps.active, 0);
    await service.post('/stop', { owner, session_id: sid });
});

test('tab_new : onglet actif indiqué (active), switch=true pour basculer ; une erreur sur l\'onglet actif rappelle lequel',
     { skip: SAUTER, timeout: 120000 }, async () => {
    const owner = 'onglets';
    const { session_id: sid } = await ouvrir(owner, `${pages.base}/`);
    let r = await service.post('/new_tab', { owner, session_id: sid, url: `${pages.base}/cible` });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.corps.tab_index, 1);
    assert.equal(r.corps.active, 0);
    assert.equal(r.corps.switched, false);
    assert.match(r.corps.note, /switch=true/);
    r = await service.post('/action', { owner, session_id: sid, type: 'click', by_css: '#absent', timeout: 300 });
    assert.ok(r.statut >= 400, r.texte);
    assert.match(r.corps.tab_hint, /^Actions run on tab index 0 of 2 tabs /);
    assert.equal(r.corps.active_tab, 0);
    r = await service.post('/new_tab', { owner, session_id: sid, url: `${pages.base}/fenetre`, switch: true });
    assert.equal(r.corps.active, 2);
    assert.equal(r.corps.switched, true);
    r = await service.get(`/sessions?owner=${owner}`);
    assert.equal(r.corps.sessions[0].active_tab, 2);
    r = await service.post('/close_tab', { owner, session_id: sid, tab_index: 1 });
    assert.equal(r.corps.remaining_tabs, 2);
    assert.equal(r.corps.active, 1);
    r = await service.get(`/list_tabs?owner=${owner}&session_id=${sid}`);
    assert.equal(r.corps.tabs[r.corps.active].url, `${pages.base}/fenetre`);
    await service.post('/stop', { owner, session_id: sid });
});

test('goto : http_status (un 404 ou un 503 reste une navigation réussie), final_url après une redirection',
     { skip: SAUTER, timeout: 120000 }, async () => {
    const owner = 'statuts';
    const debut = await ouvrir(owner, `${pages.base}/`);
    assert.equal(debut.http_status, 200);
    const aller = (chemin) => service.post('/action', { owner, session_id: debut.session_id, type: 'goto', url: `${pages.base}${chemin}` });
    for (const [chemin, statut] of [['/introuvable', 404], ['/indisponible', 503], ['/cible', 200]]) {
        const r = await aller(chemin);
        assert.equal(r.statut, 200, r.texte);
        assert.equal(r.corps.status, 'success');
        assert.equal(r.corps.http_status, statut);
        assert.equal(r.corps.final_url, undefined);
    }
    const r = await aller('/redirige');
    assert.equal(r.corps.http_status, 200);
    assert.equal(r.corps.final_url, `${pages.base}/cible`);
    await service.post('/stop', { owner, session_id: debut.session_id });
});

test('certificat expiré : la page se charge (pas de blocage) avec tls_warning ; rien sur une page en clair',
     { skip: SAUTER, timeout: 120000 }, async (t) => {
    if (!tls) { t.skip('openssl 3 absent : pas de certificat expiré à servir'); return; }
    const owner = 'tls';
    const debut = await ouvrir(owner, `${pages.base}/`);
    assert.equal(debut.tls_warning, undefined);
    const r = await service.post('/action', { owner, session_id: debut.session_id, type: 'goto', url: `${tls.base}/cible` });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.corps.http_status, 200);
    assert.deepEqual(r.corps.tls_warning.problems, ['expired', 'self_signed']);
    assert.equal(r.corps.tls_warning.issuer, '127.0.0.1');
    assert.equal(r.corps.tls_warning.valid_to, '2021-01-01T00:00:00.000Z');
    assert.match(r.corps.tls_warning.message, /certificate expired on 2021-01-01/);
    await service.post('/stop', { owner, session_id: debut.session_id });
});

test('/health : conforme au schéma de sortie publié de pw_session (sessions = liste du compte), moteur annoncé par la description',
     { skip: SAUTER }, async () => {
    const outil = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).outils.find(o => o.name === 'pw_session');
    const owner = 'sante';
    const { session_id: sid } = await ouvrir(owner, 'about:blank');
    const r = await service.get(`/health?owner=${owner}`);
    assert.equal(r.statut, 200);
    assert.deepEqual(ecartsSchema(outil.outputSchema, { result: r.corps }), []);
    assert.deepEqual(r.corps.sessions.map(s => s.id), [`${sid.slice(0, 8)}…`]);
    assert.equal(typeof r.corps.session_count, 'number');
    assert.equal(r.corps.engine, 'chromium');
    assert.match(outil.description, /^Manage the Playwright browser session lifecycle \(headless Chromium\)/);
    await service.post('/stop', { owner, session_id: sid });
});

test('/cleanup du compte ferme aussi les sessions de ses sous-agents, jamais un autre compte ; /cleanup_children, sans propriétaire, ne ferme que les enfants de tous les comptes',
     { skip: SAUTER, timeout: 120000 }, async () => {
    const enfant = async (owner, group) => {
        const r = await service.post('/start', { owner, group, url: 'about:blank' });
        assert.equal(r.statut, 200, r.texte);
    };
    const nombre = async (owner) => (await service.get(`/sessions?owner=${owner}`)).corps.count;
    await ouvrir('nettoie-a', 'about:blank', false);
    await enfant('s_nettoie_a1', 'nettoie-a');
    await ouvrir('nettoie-b', 'about:blank', false);
    await enfant('s_nettoie_b1', 'nettoie-b');
    assert.equal((await service.post('/cleanup_children', {})).statut, 400);
    assert.deepEqual((await service.post('/cleanup_children', { older_than_ms: 3600000 })).corps, { cleaned: 0 });
    assert.deepEqual((await service.post('/cleanup_children', { older_than_ms: 0 })).corps, { cleaned: 2 });
    assert.deepEqual([await nombre('nettoie-a'), await nombre('s_nettoie_a1'), await nombre('nettoie-b'), await nombre('s_nettoie_b1')], [1, 0, 1, 0]);
    await enfant('s_nettoie_a1', 'nettoie-a');
    await enfant('s_nettoie_b1', 'nettoie-b');
    assert.deepEqual((await service.post('/cleanup', { owner: 'nettoie-a' })).corps, { cleaned: 2 });
    assert.deepEqual([await nombre('nettoie-a'), await nombre('s_nettoie_a1')], [0, 0]);
    assert.deepEqual([await nombre('nettoie-b'), await nombre('s_nettoie_b1')], [1, 1]);
    assert.deepEqual((await service.post('/cleanup', { owner: 'nettoie-b' })).corps, { cleaned: 2 });
});
