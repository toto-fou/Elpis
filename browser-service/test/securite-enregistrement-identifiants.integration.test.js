// SPDX-License-Identifier: MIT
// test/securite-enregistrement-identifiants.integration.test.js — HAR et trace refusés avec des identifiants HTTP (ils les écrivent en clair) ; vidéo admise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { demarrerService, raisonDeSauter } from './aides/service.js';

let svc = null;
let saut = false;
before(async () => { saut = await raisonDeSauter(); if (!saut) svc = await demarrerService(); });
after(async () => { if (svc) await svc.arreter(); });

test('record_har ou trace avec username/password : 400 recording_with_credentials, rien démarré', async (t) => {
    if (saut) return t.skip(saut);
    for (const option of ['record_har', 'trace']) {
        const r = await svc.post('/start', { owner: 'essai', url: 'about:blank', isolated: true, username: 'u', password: 'p', [option]: true });
        assert.equal(r.statut, 400, `${option} : ${r.texte}`);
        assert.equal(r.corps.code, 'recording_with_credentials');
        assert.match(r.corps.error, /^[\x20-\x7e]+$/, 'message en anglais, ASCII');
    }
    assert.equal((await svc.get('/sessions?owner=essai')).corps.sessions?.length ?? 0, 0);
});

test('record_video avec identifiants, ou HAR sans identifiants : démarrés', async (t) => {
    if (saut) return t.skip(saut);
    for (const corps of [{ record_video: true, username: 'u', password: 'p' }, { record_har: true }]) {
        const r = await svc.post('/start', { owner: 'essai', url: 'about:blank', isolated: true, ...corps });
        assert.equal(r.statut, 200, r.texte);
        await svc.post('/stop', { owner: 'essai', session_id: r.corps.session_id });
    }
});
