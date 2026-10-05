// SPDX-License-Identifier: MIT
// Test d'intégration du service (vrai server.js) : états sauvegardés avant
// la 0.0.1, ``state_<id>.json``, sans propriétaire.
//
//     node --test test/etats_sans_compte.integration.test.js
//     BROWSER_SERVICE_LIVE=1 node --test test/etats_sans_compte.integration.test.js
//
// Il faut les dépendances du service (``npm ci``) : sans elles (CI), tout est
// ignoré. Le serveur tourne dans un dossier temporaire (ses ``cookies/``,
// ``screenshots/``… y sont créés) : rien n'est écrit dans browser-service/.
// Sans navigateur (aucun Chromium lancé) :
//   1. la purge au démarrage garde les états sans compte, pas les autres, et
//      le service les signale ;
//   2. ``/start`` rend 404 ``legacy_state`` (avec la marche à suivre) pour un
//      état sans compte, ``state_not_found`` pour un état inconnu ou d'un
//      autre compte.
// Avec ``BROWSER_SERVICE_LIVE=1`` (Chromium) :
//   3. renommé comme le fait ``./elpis browser migrate-states``, l'état se
//      recharge avec le même ``load_state_id`` (cookies présents) ;
//   4. demandé sur la session déjà ouverte du compte, il est signalé comme
//      non chargé.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = ['express', 'playwright'].every(m => fs.existsSync(path.join(SERVICE, 'node_modules', m)));
const SANS_NAVIGATEUR = MODULES ? false : 'dépendances du service absentes (npm ci)';
const AVEC_NAVIGATEUR = !MODULES ? SANS_NAVIGATEUR
                      : process.env.BROWSER_SERVICE_LIVE === '1' ? false : 'BROWSER_SERVICE_LIVE=1 pour le lancer';

const ID = '0a1b2c3d-1111-2222-3333-444455556666';
const ID_VIEUX = '9f8e7d6c-5555-6666-7777-888899990000';
const ID_ALICE = '5a5a5a5a-0000-1111-2222-333344445555';
const IL_Y_A_UN_AN = (Date.now() - 365 * 86400 * 1000) / 1000;

let child = null;
let dossier = null;
let base = '';
let journal = '';
const cookies = (nom) => path.join(dossier, 'cookies', nom);

function etat(nom, valeur, mtime) {
    fs.writeFileSync(cookies(nom), JSON.stringify({
        cookies: [{ name: 'jeton', value: valeur, domain: 'exemple.org', path: '/',
                    expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
        origins: [],
    }));
    if (mtime) fs.utimesSync(cookies(nom), mtime, mtime);
}

async function portLibre() {
    const srv = net.createServer();
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    await new Promise(r => srv.close(r));
    return port;
}

const api = (route, corps) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps),
});

before(async () => {
    if (!MODULES) return;
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-etats-'));
    fs.mkdirSync(path.join(dossier, 'cookies'));
    etat(`state_${ID}.json`, 'valeur-ancienne');
    etat(`state_${ID_VIEUX}.json`, 'vieux', IL_Y_A_UN_AN);
    etat(`state_alice__${ID_VIEUX}.json`, 'perime', IL_Y_A_UN_AN);
    etat(`state_alice__${ID_ALICE}.json`, 'a-alice');
    const port = await portLibre();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(SERVICE, 'server.js')], {
        cwd: dossier,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, FIREFOX_SERVICE_PORT: String(port), FIREFOX_SERVICE_HOST: '127.0.0.1',
               PLAYWRIGHT_HEADLESS: 'true', PW_STATE_MAX_AGE_D: '30' },
    });
    child.stderr.on('data', (d) => { journal += d; });
    const limite = Date.now() + 20000;
    while (Date.now() < limite) {
        if (child.exitCode !== null) throw new Error(`service arrêté (${child.exitCode}) : ${journal}`);
        try { if ((await (await fetch(`${base}/health`)).json()).ok) return; } catch (_) {}
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`service muet après 20 s : ${journal}`);
});

after(async () => {
    if (child) {
        child.kill('SIGTERM');
        await new Promise(r => { const t = setTimeout(r, 5000); child.on('exit', () => { clearTimeout(t); r(); }); });
        try { child.kill('SIGKILL'); } catch (_) {}
    }
    if (dossier) fs.rmSync(dossier, { recursive: true, force: true });
});

test('démarrage : la purge épargne les états sans compte, que le service signale',
     { skip: SANS_NAVIGATEUR }, () => {
    assert.ok(fs.existsSync(cookies(`state_${ID_VIEUX}.json`)));
    assert.ok(!fs.existsSync(cookies(`state_alice__${ID_VIEUX}.json`)));
    assert.match(journal, /\[STATES\] 2 état\(s\) sauvegardé\(s\) avant la 0\.0\.1/);
});

test('/start : 404 explicite, avant tout lancement du navigateur', { skip: SANS_NAVIGATEUR }, async () => {
    const debut = { owner: 'alice', url: 'about:blank', load_state_id: ID };
    let r = await api('/start', debut);
    assert.equal(r.status, 404);
    const refus = await r.json();
    assert.equal(refus.code, 'legacy_state');
    assert.ok(refus.fix.includes(`./elpis browser migrate-states <compte> ${ID}`), refus.fix);
    assert.ok(refus.fix.includes(`state_alice__${ID}.json`), refus.fix);

    r = await api('/start', { ...debut, load_state_id: 'inconnu-0000-1111' });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, 'state_not_found');

    r = await api('/start', { ...debut, owner: 'bob', load_state_id: ID_ALICE });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, 'state_not_found');

    assert.equal((await (await fetch(`${base}/health`)).json()).browser_connected, false);
});

test('rattaché : même load_state_id ; sur une session réutilisée, signalé non chargé',
     { skip: AVEC_NAVIGATEUR, timeout: 120000 }, async () => {
    fs.renameSync(cookies(`state_${ID}.json`), cookies(`state_alice__${ID}.json`));
    const ouvertes = [];
    try {
        let r = await api('/start', { owner: 'alice', url: 'about:blank', load_state_id: ID, isolated: true });
        assert.equal(r.status, 200);
        const { session_id: sid } = await r.json();
        ouvertes.push(sid);
        r = await api('/save_state', { owner: 'alice', session_id: sid });
        assert.equal(r.status, 200);
        const sauve = JSON.parse(fs.readFileSync(cookies(`state_alice__${sid}.json`), 'utf8'));
        assert.ok(sauve.cookies.some(c => c.name === 'jeton' && c.value === 'valeur-ancienne'),
                  JSON.stringify(sauve.cookies));

        // Le compte a maintenant une session : start la réutilise sans l'état.
        r = await api('/start', { owner: 'alice', url: 'about:blank', load_state_id: ID });
        assert.equal(r.status, 200);
        const reprise = await r.json();
        assert.equal(reprise.reused, true);
        assert.equal(reprise.state_loaded, false);
        assert.match(reprise.warning, /isolated=true/);
    } finally {
        for (const sid of ouvertes) await api('/stop', { owner: 'alice', session_id: sid });
    }
});
