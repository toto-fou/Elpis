// SPDX-License-Identifier: MIT
// test/securite-jeton-service.test.js — jeton d'appel du service : Bearer exigé s'il est configuré, boucle locale directe seule sinon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refusAppel, jetonAttendu, oublierJeton, fichierJeton } from '../service_auth.js';
import { demarrerService, raisonDeSauter } from './aides/service.js';

const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });

test('sans jeton : boucle locale directe admise, relais et réseau refusés', () => {
    assert.equal(refusAppel(req('127.0.0.1'), ''), null);
    assert.equal(refusAppel(req('::ffff:127.0.0.1'), ''), null);
    assert.equal(refusAppel(req('127.0.0.1', { 'x-forwarded-for': '10.0.0.5' }), '')?.code, 'unauthorized');
    assert.equal(refusAppel(req('192.0.2.20'), '')?.code, 'unauthorized');
});

test('avec jeton : Bearer exact exigé, même en boucle locale', () => {
    assert.equal(refusAppel(req('127.0.0.1'), 's3cret')?.code, 'unauthorized');
    assert.equal(refusAppel(req('127.0.0.1', { authorization: 'Bearer faux' }), 's3cret')?.code, 'unauthorized');
    assert.equal(refusAppel(req('127.0.0.1', { authorization: 's3cret' }), 's3cret')?.code, 'unauthorized');
    assert.equal(refusAppel(req('192.0.2.20', { authorization: 'Bearer s3cret' }), 's3cret'), null);
    assert.equal(refusAppel(req('127.0.0.1', { authorization: 'bearer s3cret' }), 's3cret'), null);
});

test('fichier du jeton illisible : null, et chaque appel refusé en 503 (jamais d\'ouverture)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jeton-'));
    const f = path.join(d, 'jeton');
    fs.writeFileSync(f, 'abc\n');
    fs.chmodSync(f, 0o000);
    oublierJeton();
    const lu = jetonAttendu({ BROWSER_SERVICE_TOKEN_FILE: f }, 50_000);
    fs.chmodSync(f, 0o600);
    fs.rmSync(d, { recursive: true, force: true });
    oublierJeton();
    if (process.getuid?.() === 0) return;  // root lit tout
    assert.equal(lu, null);
    const refus = refusAppel(req('127.0.0.1', { authorization: 'Bearer abc' }), null);
    assert.deepEqual([refus.statut, refus.code], [503, 'token_unreadable']);
});

test('jeton lu : variable, sinon première ligne du fichier, relu après 5 s', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jeton-'));
    const f = path.join(d, 'jeton');
    fs.writeFileSync(f, 'abc\nreste\n');
    oublierJeton();
    assert.equal(jetonAttendu({ BROWSER_SERVICE_TOKEN: ' direct ' }, 0), 'direct');
    assert.equal(jetonAttendu({ BROWSER_SERVICE_TOKEN_FILE: f }, 10_000), 'abc');
    fs.writeFileSync(f, 'neuf\n');
    assert.equal(jetonAttendu({ BROWSER_SERVICE_TOKEN_FILE: f }, 12_000), 'abc');
    assert.equal(jetonAttendu({ BROWSER_SERVICE_TOKEN_FILE: f }, 16_000), 'neuf');
    oublierJeton();
    assert.equal(jetonAttendu({ BROWSER_SERVICE_TOKEN_FILE: path.join(d, 'absent') }, 30_000), '');
    assert.equal(fichierJeton({}, '/srv/elpis/browser-service'), '/srv/elpis/user_db/.browser_service_token');
    fs.rmSync(d, { recursive: true, force: true });
    oublierJeton();
});

test('service réel avec jeton : routes, santé et captures refusées sans lui', async (t) => {
    const raison = await raisonDeSauter();
    if (raison) return t.skip(raison);
    const svc = await demarrerService({ env: { BROWSER_SERVICE_TOKEN: 'jeton-essai' } });
    try {
        for (const [methode, route] of [['GET', '/health'], ['GET', '/sessions?owner=alice'], ['POST', '/start'], ['GET', '/screenshots/live_x.png'], ['GET', '/traces/t.zip']]) {
            const r = await fetch(`${svc.base}${route}`, { method: methode, headers: { 'Content-Type': 'application/json' }, body: methode === 'POST' ? '{}' : undefined });
            assert.equal(r.status, 401, `${methode} ${route}`);
            assert.equal((await r.json()).code, 'unauthorized');
        }
        const bon = await svc.get('/health');
        assert.equal(bon.statut, 200);
        assert.equal(bon.corps.ok, true);
    } finally {
        await svc.arreter();
    }
});
