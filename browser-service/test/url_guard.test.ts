// SPDX-License-Identifier: MIT
// Forme des adresses du navigateur dans le bac (url_guard.ts) : schémas, page vide, boucle locale du bac directe, le reste au relais de l'hôte. Tests purs : node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserUrl, estBoucleLocale, messageRefus, normaliserIp, verifierBac } from '../src/url_guard.ts';
import type { AnalyseUrl } from '../src/url_guard.ts';

type Refus = Extract<AnalyseUrl, { ok: false }>;
type Adresse = Extract<AnalyseUrl, { hote: string }>;

test('schémas : http/https/ws(s) et about:blank seulement', () => {
    for (const u of ['file:///etc/passwd', 'ftp://exemple.org/', 'chrome://settings',
                     'view-source:https://exemple.org', 'javascript:alert(1)', 'data:text/html,x']) {
        const a = analyserUrl(u);
        assert.ok(!a.ok && /scheme|malformed/.test(a.motif), `${u} → ${(a as Refus).motif}`);
    }
    assert.deepEqual(analyserUrl('about:blank'), { ok: true, vide: true, url: 'about:blank' });
    for (const u of ['https://93.184.216.34/', 'wss://exemple.org/ws', 'http://localhost:8080/', 'http://[::1]:3000/'])
        assert.equal(analyserUrl(u).ok, true, u);
    assert.equal((analyserUrl('') as Refus).motif, 'empty address');
    assert.equal((analyserUrl('pas une url') as Refus).motif, 'malformed address');
    assert.equal((analyserUrl('HTTPS://Exemple.ORG/a') as Adresse).hote, 'exemple.org');
});

test('IPv4 mappée en IPv6, forme hexadécimale comprise', () => {
    assert.equal(normaliserIp('[::ffff:10.0.0.1]'), '10.0.0.1');
    assert.equal(normaliserIp('::ffff:c0a8:320a'), '192.168.50.10');
    assert.equal(normaliserIp('[::FFFF:192.168.50.10]'), '192.168.50.10');
    assert.equal(normaliserIp('0:0:0:0:0:ffff:7f00:1'), '127.0.0.1');
    assert.equal(normaliserIp('2001:db8::1'), '2001:db8::1');
    assert.equal((analyserUrl('http://[::ffff:7f00:1]:8080/') as Adresse).hote, '127.0.0.1');
});

test('boucle locale du bac : 127/8, ::1, localhost ; le reste part au relais', async () => {
    for (const h of ['127.0.0.1', '127.8.9.10', '::1', '[::1]', 'localhost', 'app.localhost', '::ffff:127.0.0.1']) assert.ok(estBoucleLocale(h), h);
    for (const h of ['10.0.0.1', '172.17.0.1', 'example.org', 'localhost.example.org', '']) assert.ok(!estBoucleLocale(h), h);
    const v = verifierBac();
    assert.deepEqual(await v('localhost', 8080), { ok: true, adresse: '127.0.0.1' });
    assert.deepEqual(await v('127.0.0.2', 80), { ok: true, adresse: '127.0.0.2' });
    assert.deepEqual(await v('intranet.lan', 443), { ok: true, amont: true });
});

test('message de refus', () => {
    assert.match(messageRefus('http://x/', 'motif'), /browser policy: motif\. URL: http:\/\/x\//);
});
