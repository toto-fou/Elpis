// SPDX-License-Identifier: MIT
// Destinations autorisées du navigateur (url_guard.js) : schémas, adresses
// réservées, adresses et réseaux de conteneurs de l'hôte, réseau local et
// liste blanche, jugement sur les adresses RÉSOLUES. Tests purs : node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserUrl, motifUrl, motifIp, hoteDepuisInterfaces, analyserListeBlanche,
         normaliserIp, messageRefus, makeCache } from '../url_guard.js';

const HOTE = hoteDepuisInterfaces({
    lo: [{ address: '127.0.0.1', cidr: '127.0.0.1/8' }, { address: '::1', cidr: '::1/128' }],
    enp0s3: [{ address: '192.168.50.10', cidr: '192.168.50.10/24' }],
    docker0: [{ address: '172.17.0.1', cidr: '172.17.0.1/16' }],
    'br-test': [{ address: '172.21.0.1', cidr: '172.21.0.1/16' }],
});
const resoudre = (table) => async (nom) => {
    if (!(nom in table)) throw new Error('ENOTFOUND');
    return table[nom];
};

test('schémas : http/https (et about:blank) seulement', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://exemple.org/', 'chrome://settings',
                     'view-source:https://exemple.org', 'javascript:alert(1)', 'data:text/html,x']) {
        const m = await motifUrl(u, { hote: HOTE });
        assert.ok(m && /schéma|mal formée/.test(m), `${u} → ${m}`);
    }
    assert.equal(await motifUrl('about:blank', { hote: HOTE }), null);
    assert.equal(await motifUrl('https://93.184.216.34/', { hote: HOTE }), null);
});

test('adresses réservées, sous toutes leurs formes', async () => {
    for (const u of ['http://127.0.0.1:8001/', 'http://2130706433/', 'http://0x7f000001/',
                     'http://127.1/', 'http://0.0.0.0:3000/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
                     'http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/',
                     'http://localhost:8765/', 'http://app.localhost/', 'http://255.255.255.255/']) {
        const m = await motifUrl(u, { hote: HOTE });
        assert.ok(m, `${u} devrait être refusée`);
    }
});

test("adresses de l'hôte et réseaux de conteneurs", () => {
    assert.match(motifIp('192.168.50.10', { hote: HOTE }), /machine qui héberge/);
    assert.match(motifIp('172.17.0.5', { hote: HOTE }), /réseau interne/);
    assert.match(motifIp('172.21.3.4', { hote: HOTE }), /réseau interne/);
    // Le reste du réseau local reste joignable par défaut (D-A1).
    assert.equal(motifIp('192.168.50.54', { hote: HOTE }), null);
    assert.equal(motifIp('10.0.0.8', { hote: HOTE }), null);
});

test('un nom est jugé sur les adresses résolues (toutes)', async () => {
    const r = resoudre({ 'public.example': ['93.184.216.34'],
                         'piege.example': ['93.184.216.34', '127.0.0.1'],
                         'nas.lan': ['192.168.50.20'] });
    assert.equal(await motifUrl('https://public.example/x', { resoudre: r, hote: HOTE }), null);
    assert.ok(await motifUrl('https://piege.example/', { resoudre: r, hote: HOTE }));
    assert.equal(await motifUrl('http://nas.lan/', { resoudre: r, hote: HOTE }), null);
    // Nom introuvable : pas refusé ici, le navigateur échouera seul.
    assert.equal(await motifUrl('http://inconnu.example/', { resoudre: r, hote: HOTE }), null);
});

test('liste blanche : restreint le réseau local, pas internet', async () => {
    const lb = analyserListeBlanche('nas.lan, *.corp, 10.1.0.0/16, 192.168.50.54');
    const r = resoudre({ 'nas.lan': ['192.168.50.20'], 'wiki.corp': ['10.9.9.9'],
                         'autre.lan': ['192.168.1.21'], 'public.example': ['93.184.216.34'] });
    const o = { resoudre: r, hote: HOTE, listeBlanche: lb };
    assert.equal(await motifUrl('http://nas.lan/', o), null);
    assert.equal(await motifUrl('http://wiki.corp/', o), null);
    assert.equal(await motifUrl('http://10.1.2.3/', o), null);
    assert.equal(await motifUrl('http://192.168.50.54:8080/', o), null);
    assert.match(await motifUrl('http://autre.lan/', o), /liste autorisée/);
    assert.match(await motifUrl('http://10.2.0.1/', o), /liste autorisée/);
    assert.equal(await motifUrl('https://public.example/', o), null);
    // La liste blanche n'ouvre jamais la boucle locale ni l'hôte.
    const lb2 = analyserListeBlanche(['127.0.0.0/8', '192.168.1.0/24']);
    assert.ok(await motifUrl('http://127.0.0.1/', { hote: HOTE, listeBlanche: lb2 }));
    assert.ok(await motifUrl('http://192.168.50.10/', { hote: HOTE, listeBlanche: lb2 }));
});

test('utilitaires', () => {
    assert.equal(normaliserIp('[::ffff:10.0.0.1]'), '10.0.0.1');
    assert.equal(analyserUrl('HTTPS://Exemple.ORG/a').hote, 'exemple.org');
    assert.equal(analyserListeBlanche('').vide, true);
    assert.match(messageRefus('http://x/', 'motif'), /politique du navigateur : motif/);
    const c = makeCache({ ttlMs: 10, max: 2 });
    c.set('a', 1, 0); c.set('b', 2, 0); c.set('c', 3, 0);
    assert.equal(c.get('a', 1), undefined);          // évincé (taille max)
    assert.equal(c.get('c', 5), 3);
    assert.equal(c.get('c', 50), undefined);         // expiré
});

test("IPv4 mappée en IPv6, forme hexadécimale comprise (adresses de l'hôte)", async () => {
    assert.equal(normaliserIp('::ffff:c0a8:184'), '192.168.50.10');
    assert.equal(normaliserIp('[::FFFF:192.168.50.10]'), '192.168.50.10');
    assert.equal(normaliserIp('0:0:0:0:0:ffff:7f00:1'), '127.0.0.1');
    assert.equal(normaliserIp('2001:db8::1'), '2001:db8::1');          // non mappée : intacte
    for (const u of ['http://[::ffff:c0a8:184]:47003/', 'http://[::ffff:192.168.50.10]/',
                     'http://[0:0:0:0:0:ffff:c0a8:184]/', 'http://[::ffff:ac11:1]/']) {
        assert.ok(await motifUrl(u, { hote: HOTE }), `${u} devrait être refusée`);
    }
    // Adresse de l'hôte en IPv6 écrite autrement que dans l'interface.
    const h6 = hoteDepuisInterfaces({ eth0: [{ address: '2001:db8:0:0::7', cidr: '2001:db8::7/64' }] });
    assert.ok(motifIp('2001:db8::7', { hote: h6 }));
});
