// SPDX-License-Identifier: MIT
// test/securite-jeton-service.test.ts — jeton d'appel du service : Bearer exact exigé sur chaque appel ; sans socket ni jeton, le service ne démarre pas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refusAppel } from '../src/service_auth.ts';
import { demarrerService, NEUTRE_PS, raisonDeSauter, SERVEUR } from './aides/service.ts';

const req = (headers = {}) => ({ socket: {}, headers });

test('Bearer exact exigé ; jamais d’appel admis sans jeton attendu', () => {
    assert.equal(refusAppel(req(), 's3cret')?.code, 'unauthorized');
    assert.equal(refusAppel(req({ authorization: 'Bearer faux' }), 's3cret')?.code, 'unauthorized');
    assert.equal(refusAppel(req({ authorization: 's3cret' }), 's3cret')?.code, 'unauthorized');
    assert.equal(refusAppel(req({ authorization: 'Bearer s3cret' }), 's3cret'), null);
    assert.equal(refusAppel(req({ authorization: 'bearer s3cret' }), 's3cret'), null);
    assert.equal(refusAppel(req({ authorization: 'Bearer ' }), '')?.statut, 401);
});

test('sans socket ou sans jeton : arrêt au démarrage, message clair', async () => {
    assert.ok(fs.existsSync(SERVEUR), `${SERVEUR} absent : construire le service d'abord (npm run build:browser)`);
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-pw-sans-'));
    try {
        for (const [env, attendu] of [[{ BROWSER_SERVICE_TOKEN: 'x' }, /FIREFOX_SERVICE_SOCKET \(its Unix socket\) is required/],
                                      [{ FIREFOX_SERVICE_SOCKET: path.join(dossier, 's.sock') }, /BROWSER_SERVICE_TOKEN \(its call token\) is required/]] as const) {
            const base = { ...process.env };
            delete base.FIREFOX_SERVICE_SOCKET;
            delete base.BROWSER_SERVICE_TOKEN;
            const enfant = spawn(process.execPath, ['--import', NEUTRE_PS, SERVEUR], { cwd: dossier, env: { ...base, ...env } });
            let sortie = '';
            enfant.stderr.on('data', (d) => { sortie += d; });
            const code = await new Promise((r) => enfant.on('exit', r));
            assert.equal(code, 1);
            assert.match(sortie, attendu);
            assert.ok(!fs.existsSync(path.join(dossier, 's.sock')));
        }
    } finally {
        fs.rmSync(dossier, { recursive: true, force: true });
    }
});

test('service réel : routes, santé et captures refusées sans le jeton', async (t) => {
    const raison = await raisonDeSauter();
    if (raison) return t.skip(raison);
    const svc = await demarrerService();
    try {
        for (const [methode, route] of [['GET', '/health'], ['GET', '/sessions?owner=alice'], ['POST', '/start'], ['GET', '/screenshots/live_x.png'], ['GET', '/traces/t.zip']] as const) {
            for (const entetes of [{}, { Authorization: 'Bearer faux' }]) {
                const r = await svc.brute(methode, route, { entetes });
                assert.equal(r.statut, 401, `${methode} ${route}`);
                assert.equal(r.corps.code, 'unauthorized');
            }
        }
        const bon = await svc.get('/health');
        assert.equal(bon.statut, 200);
        assert.equal(bon.corps.ok, true);
        assert.equal(bon.corps.mode, undefined);
        assert.equal((fs.statSync(svc.socket).mode & 0o777), 0o666);
    } finally {
        await svc.arreter();
    }
});
