// SPDX-License-Identifier: MIT
// test/securite-identifiants-origine.integration.test.js — vrai service et vrai navigateur : les identifiants d'un contexte ne partent que vers l'origine de l'adresse de départ (autre origine, sous-ressource, redirection, onglet suivant, contexte réutilisé).
//
//     node --test test/securite-identifiants-origine.integration.test.js
//
// Sans les dépendances du service (npm ci) ou sans navigateur installé, tout est ignoré. Aucun accès réseau : serveurs d'essai sur 127.0.0.1.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { demarrerService, raisonDeSauter } from './aides/service.js';

const SAUTER = await raisonDeSauter();
const ATTENDU = `Basic ${Buffer.from('alice:mdp-a').toString('base64')}`;

let service = null;
let a = null;
let b = null;
let n = 0;

// Serveur d'essai : relève l'en-tête Authorization de chaque requête ; `exige` donne 200 aux bons identifiants, sinon 401.
async function serveur(traiter) {
    const vus = [];
    const srv = http.createServer((req, res) => { vus.push({ chemin: req.url, auth: req.headers.authorization || null }); traiter(req, res); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    return { srv, vus, base: `http://127.0.0.1:${srv.address().port}` };
}

const defi = (res) => { res.writeHead(401, { 'www-authenticate': 'Basic realm="essai"', 'content-type': 'text/html' }); res.end('<title>401</title>'); };

before(async () => {
    if (SAUTER) return;
    service = await demarrerService();
    b = await serveur((req, res) => defi(res));
    a = await serveur((req, res) => {
        if (req.headers.authorization !== ATTENDU) return defi(res);
        if (req.url.startsWith('/vers-b')) { res.writeHead(302, { location: `${b.base}/connexion` }); return res.end(); }
        res.writeHead(200, { 'content-type': 'text/html' });
        if (req.url.startsWith('/image')) return res.end(`<title>A</title><img src="${b.base}/image.png">`);
        res.end('<title>A</title><p>ok</p>');
    });
});

after(async () => {
    if (service) await service.arreter();
    for (const s of [a, b]) if (s) { s.srv.closeAllConnections(); await new Promise(r => s.srv.close(r)); }
});

beforeEach(() => { if (a) a.vus.length = 0; if (b) b.vus.length = 0; n += 1; });

const owner = () => `essai${n}`;
const demarrer = async (corps) => {
    const r = await service.post('/start', { headless: true, owner: owner(), ...corps });
    assert.equal(r.statut, 200, r.texte);
    return r.corps;
};
const arreter = (sid) => service.post('/stop', { session_id: sid, owner: owner() });
const fuites = () => b.vus.filter(v => v.auth);

test('identifiants reçus par leur origine, jamais par une sous-ressource d\'une autre', { skip: SAUTER }, async () => {
    const r = await demarrer({ url: `${a.base}/image`, username: 'alice', password: 'mdp-a' });
    assert.equal(r.http_status, 200);
    assert.ok(a.vus.some(v => v.auth === ATTENDU));
    assert.equal(r.credentials_warning, undefined);
    for (let i = 0; i < 40 && !b.vus.length; i++) await new Promise(res => setTimeout(res, 50));
    assert.ok(b.vus.length > 0, 'l\'image a bien été demandée à B');
    assert.deepEqual(fuites(), []);
    await arreter(r.session_id);
});

test('session réutilisée : start, goto et onglet vers une autre origine n\'en reçoivent rien', { skip: SAUTER }, async () => {
    const r = await demarrer({ url: `${a.base}/`, username: 'alice', password: 'mdp-a' });
    assert.equal(r.http_status, 200);

    const reprise = await demarrer({ url: `${b.base}/page` });
    assert.equal(reprise.reused, true);
    assert.equal(reprise.session_id, r.session_id);
    assert.equal(reprise.http_status, 401);
    assert.deepEqual(fuites(), []);
    assert.ok(b.vus.length > 0);

    const go = await service.post('/action', { session_id: r.session_id, owner: owner(), type: 'goto', url: `${b.base}/autre` });
    assert.equal(go.corps.http_status, 401);
    assert.deepEqual(fuites(), []);

    // Le contexte garde ses identifiants pour leur origine.
    a.vus.length = 0;
    const retour = await demarrer({ url: `${a.base}/encore` });
    assert.equal(retour.http_status, 200);
    assert.ok(a.vus.some(v => v.auth === ATTENDU));
    await arreter(r.session_id);
});

test('redirection de l\'origine de départ vers une autre : la cible n\'en reçoit rien, et le modèle est prévenu', { skip: SAUTER }, async () => {
    // Le 302 n'est servi qu'une fois authentifié sur A : le navigateur a bien répondu au défi avant de partir vers B.
    const r = await demarrer({ url: `${a.base}/vers-b`, username: 'alice', password: 'mdp-a' });
    assert.ok(a.vus.some(v => v.auth === ATTENDU));
    assert.equal(r.http_status, 401);
    assert.ok(b.vus.length > 0);
    assert.deepEqual(fuites(), []);
    assert.match(r.credentials_warning, new RegExp(b.base.replace(/[.:/]/g, '\\$&')));
    await arreter(r.session_id);
});

test('saisie après coup sur un contexte sans identifiants : non appliqués et dit ; contexte neuf : appliqués', { skip: SAUTER }, async () => {
    const sans = await demarrer({ url: `${a.base}/` });
    assert.equal(sans.http_status, 401);
    assert.equal(sans.credentials_warning, undefined);

    const reprise = await demarrer({ url: `${a.base}/`, username: 'alice', password: 'mdp-a' });
    assert.equal(reprise.reused, true);
    assert.equal(reprise.http_status, 401);
    assert.equal(reprise.credentials_applied, false);
    assert.match(reprise.credentials_warning, /isolated=true/);
    assert.ok(!JSON.stringify(reprise).includes('mdp-a'));

    const neuf = await demarrer({ url: `${a.base}/`, username: 'alice', password: 'mdp-a', isolated: true });
    assert.equal(neuf.http_status, 200);
    assert.notEqual(neuf.session_id, sans.session_id);
    assert.equal(neuf.credentials_warning, undefined);
    await arreter(neuf.session_id);
    await arreter(sans.session_id);
});

test('reprise sur la même origine avec les mêmes identifiants : aucun avis', { skip: SAUTER }, async () => {
    const r = await demarrer({ url: `${a.base}/`, username: 'alice', password: 'mdp-a' });
    const reprise = await demarrer({ url: `${a.base}/x`, username: 'alice', password: 'mdp-a' });
    assert.equal(reprise.reused, true);
    assert.equal(reprise.http_status, 200);
    assert.equal(reprise.credentials_warning, undefined);
    assert.equal(reprise.credentials_applied, undefined);
    await arreter(r.session_id);
});

test('identifiants passés avec une autre origine dans le même contexte : la première origine ne les reçoit pas', { skip: SAUTER }, async () => {
    const r = await demarrer({ url: `${b.base}/`, username: 'alice', password: 'mdp-a' });
    assert.equal(r.http_status, 401);
    assert.ok(b.vus.some(v => v.auth === ATTENDU), 'B a reçu les identifiants qui lui sont destinés');
    b.vus.length = 0;
    const versA = await demarrer({ url: `${a.base}/` });
    assert.equal(versA.http_status, 401);
    assert.deepEqual(a.vus.filter(v => v.auth), []);
    await arreter(r.session_id);
});
