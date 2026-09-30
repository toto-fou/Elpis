// SPDX-License-Identifier: MIT
// Relais filtrant du navigateur (proxy_guard.js) : requêtes http, tunnels
// CONNECT, refus avec page explicite, connexion à l'adresse JUGÉE (et non à
// une nouvelle résolution), vérificateur de service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import { demarrerRelais, verifierDepuisPolitique } from '../proxy_guard.js';

function serveurCible() {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain', 'x-hote-recu': req.headers.host || '' });
            res.end('cible ' + req.url);
        });
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
}

// Vérificateur de test : « permis.test » → la cible locale, tout le reste refusé.
const verifier = async (hote) => (hote === 'permis.test'
    ? { ok: true, adresse: '127.0.0.1' }
    : { ok: false, motif: `interdit (${hote})` });

function viaRelais(relaisPort, urlAbsolue) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: relaisPort, method: 'GET', path: urlAbsolue,
                                   headers: { host: new URL(urlAbsolue).host } }, (res) => {
            let corps = '';
            res.on('data', d => { corps += d; });
            res.on('end', () => resolve({ status: res.statusCode, corps, entetes: res.headers }));
        });
        req.on('error', reject);
        req.end();
    });
}

function connect(relaisPort, cible) {
    return new Promise((resolve, reject) => {
        const s = net.connect(relaisPort, '127.0.0.1', () => s.write(`CONNECT ${cible} HTTP/1.1\r\nHost: ${cible}\r\n\r\n`));
        let tampon = '';
        s.on('data', (d) => {
            tampon += d.toString();
            if (tampon.includes('\r\n\r\n')) resolve({ socket: s, entete: tampon.split('\r\n')[0] });
        });
        s.on('error', reject);
    });
}

test('http : destination permise relayée, avec le nom d’origine', async () => {
    const cible = await serveurCible();
    const relais = await demarrerRelais({ verifier });
    try {
        const r = await viaRelais(relais.port, `http://permis.test:${cible.address().port}/a?b=1`);
        assert.equal(r.status, 200);
        assert.equal(r.corps, 'cible /a?b=1');
        assert.equal(r.entetes['x-hote-recu'], `permis.test:${cible.address().port}`);
    } finally { await relais.close(); cible.close(); }
});

test('http : destination refusée → 403 avec message clair', async () => {
    const relais = await demarrerRelais({ verifier });
    try {
        const r = await viaRelais(relais.port, 'http://127.0.0.1:9/secret');
        assert.equal(r.status, 403);
        assert.match(r.corps, /politique du navigateur : interdit \(127\.0\.0\.1\)/);
    } finally { await relais.close(); }
});

test('tunnel CONNECT : permis → établi et fonctionnel ; refusé → 403', async () => {
    const cible = await serveurCible();
    const relais = await demarrerRelais({ verifier });
    try {
        const ok = await connect(relais.port, `permis.test:${cible.address().port}`);
        assert.match(ok.entete, /200/);
        const reponse = await new Promise((resolve) => {
            let t = '';
            ok.socket.on('data', d => { t += d; if (t.includes('cible /tunnel')) resolve(t); });
            ok.socket.write('GET /tunnel HTTP/1.1\r\nHost: permis.test\r\nConnection: close\r\n\r\n');
        });
        assert.match(reponse, /cible \/tunnel/);
        ok.socket.destroy();
        const non = await connect(relais.port, 'metadata.test:80');
        assert.match(non.entete, /403/);
        non.socket.destroy();
    } finally { await relais.close(); cible.close(); }
});

test('vérificateur de service : toutes les adresses résolues sont jugées', async () => {
    const table = { 'public.example': ['93.184.216.34'], 'piege.example': ['93.184.216.34', '127.0.0.1'] };
    const v = verifierDepuisPolitique({
        resoudre: async (n) => { if (!(n in table)) throw new Error('ENOTFOUND'); return table[n]; },
        motifIp: (ip) => (ip.startsWith('127.') ? 'boucle locale' : null),
    });
    assert.deepEqual(await v('public.example', 443), { ok: true, adresse: '93.184.216.34' });
    assert.deepEqual(await v('piege.example', 443), { ok: false, motif: 'boucle locale' });
    assert.equal((await v('127.0.0.1', 80)).ok, false);                 // adresse littérale
    assert.equal((await v('introuvable.example', 80)).ok, false);
});
