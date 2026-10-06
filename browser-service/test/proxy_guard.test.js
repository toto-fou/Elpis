// SPDX-License-Identifier: MIT
// Relais filtrant du navigateur (proxy_guard.js) : requêtes http, tunnels
// CONNECT, refus avec page explicite, connexion à l'adresse JUGÉE (et non à
// une nouvelle résolution), vérificateur de service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import { demarrerRelais, verifierDepuisPolitique, entetesReponse } from '../proxy_guard.js';

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

test('un client qui coupe (RST) pendant le jugement ne fait pas tomber le service', async () => {
    let libere;
    const attente = new Promise(r => { libere = r; });
    const lent = async (hote) => { await attente; return verifier(hote); };
    const relais = await demarrerRelais({ verifier: lent });
    const erreurs = [];
    const capter = (e) => erreurs.push(e);
    process.on('uncaughtException', capter);
    try {
        for (const premiere of [
            (c) => `CONNECT permis.test:443 HTTP/1.1\r\nHost: permis.test:443\r\n\r\n`,
            (c) => 'GET http://permis.test/ws HTTP/1.1\r\nHost: permis.test\r\nConnection: Upgrade\r\n'
                 + 'Upgrade: websocket\r\n\r\n',
        ]) {
            await new Promise((resolve) => {
                const s = net.connect(relais.port, '127.0.0.1', () => {
                    s.write(premiere(s));
                    setTimeout(() => { s.resetAndDestroy(); resolve(); }, 50);
                });
                s.on('error', () => {});
            });
        }
        libere();
        await new Promise(r => setTimeout(r, 100));
        assert.deepEqual(erreurs, []);
        // Le relais répond toujours.
        const r = await viaRelais(relais.port, 'http://interdit.test/');
        assert.equal(r.status, 403);
    } finally {
        process.removeListener('uncaughtException', capter);
        await relais.close();
    }
});

test('vérificateur de service : verdicts gardés brièvement, négatifs compris', async () => {
    let t = 0, appels = 0;
    const v = verifierDepuisPolitique({
        resoudre: async (nom) => { appels++; if (nom === 'absent.test') throw new Error('ENOTFOUND'); return ['93.184.216.34']; },
        motifIp: () => null, cacheMs: 1000, cacheNegatifMs: 500, maintenant: () => t,
    });
    assert.equal((await v('ok.test', 443)).ok, true);
    assert.equal((await v('ok.test', 443)).ok, true);
    assert.equal((await v('absent.test', 443)).ok, false);
    assert.equal((await v('absent.test', 443)).ok, false);
    assert.equal(appels, 2);
    t = 600;                                   // négatif expiré, positif encore valable
    await v('absent.test', 443); await v('ok.test', 443);
    assert.equal(appels, 3);
    t = 1200;
    await v('ok.test', 443);
    assert.equal(appels, 4);
});

// ── Authentification HTTP à travers le relais ───────────────────────────────

// Requête brute par le relais sur UNE connexion donnée → lignes de la réponse.
function brut(socket, hote, port, chemin) {
    return new Promise((resolve, reject) => {
        let recu = '';
        const lire = (d) => {
            recu += d;
            const fin = recu.indexOf('\r\n\r\n');
            if (fin < 0) return;
            const tete = recu.slice(0, fin);
            const m = /content-length: (\d+)/i.exec(tete);
            if (recu.length < fin + 4 + (m ? parseInt(m[1], 10) : 0)) return;
            socket.off('data', lire);
            resolve(tete.split('\r\n'));
        };
        socket.on('data', lire);
        socket.once('error', reject);
        socket.write(`GET http://${hote}:${port}${chemin} HTTP/1.1\r\nHost: ${hote}:${port}\r\n\r\n`);
    });
}

function ouvrir(port) {
    return new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
    });
}

test('entetesReponse : un en-tête répété le reste, saut par saut retiré', () => {
    const e = entetesReponse(['WWW-Authenticate', 'Negotiate', 'Connection', 'keep-alive',
                              'WWW-Authenticate', 'NTLM', 'Content-Type', 'text/html']);
    assert.deepEqual(e['www-authenticate'], ['Negotiate', 'NTLM']);
    assert.equal(e['content-type'], 'text/html');
    assert.equal('connection' in e, false);
});

test('http : plusieurs WWW-Authenticate arrivent en lignes séparées (IIS : Negotiate + NTLM)', async () => {
    const cible = http.createServer((req, res) => {
        res.writeHead(401, { 'WWW-Authenticate': ['Negotiate', 'NTLM', 'Basic realm="z"'], 'content-length': 0 });
        res.end();
    });
    await new Promise(r => cible.listen(0, '127.0.0.1', r));
    const relais = await demarrerRelais({ verifier });
    const s = await ouvrir(relais.port);
    try {
        const lignes = await brut(s, 'permis.test', cible.address().port, '/');
        const defis = lignes.filter(l => /^www-authenticate:/i.test(l)).map(l => l.split(': ')[1]);
        assert.deepEqual(defis, ['Negotiate', 'NTLM', 'Basic realm="z"']);
    } finally {
        s.destroy(); await relais.close(); cible.close();
    }
});

test('http : une connexion amont par connexion cliente, jamais partagée entre clients', async () => {
    // La cible répond le port source de la connexion qu'elle voit : même
    // client → même connexion amont (NTLM tient) ; autre client → autre connexion.
    const cible = http.createServer((req, res) => {
        const corps = String(req.socket.remotePort);
        res.writeHead(200, { 'content-length': corps.length, 'x-amont': corps });
        res.end(corps);
    });
    await new Promise(r => cible.listen(0, '127.0.0.1', r));
    const relais = await demarrerRelais({ verifier });
    const port = cible.address().port;
    const amont = (lignes) => lignes.find(l => /^x-amont:/i.test(l)).split(': ')[1];
    const a = await ouvrir(relais.port);
    const b = await ouvrir(relais.port);
    try {
        const a1 = amont(await brut(a, 'permis.test', port, '/1'));
        const a2 = amont(await brut(a, 'permis.test', port, '/2'));
        const b1 = amont(await brut(b, 'permis.test', port, '/1'));
        const a3 = amont(await brut(a, 'permis.test', port, '/3'));
        assert.equal(a1, a2);
        assert.equal(a1, a3);
        assert.notEqual(a1, b1);
    } finally {
        a.destroy(); b.destroy(); await relais.close(); cible.close();
    }
});
