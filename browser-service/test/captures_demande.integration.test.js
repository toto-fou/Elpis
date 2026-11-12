// SPDX-License-Identifier: MIT
// browser-service/test/captures_demande.integration.test.js — vrai server.js + Chromium, hors ligne : captures d'étape seulement sur demande de l'hôte (en-tête), en JPEG, une par requête ; vision réduite à 1024 px à l'inspection ; pas compté sans capture (since_step).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { demarrerService, raisonDeSauter } from './aides/service.js';

const SAUT = await raisonDeSauter();

const SITE = 'http://93.184.216.34';
const OWNER = 'essai';
// Haut du document blanc, blocs colorés plus bas : une capture cadrée sur le haut au lieu de la fenêtre défilée serait blanche.
const PAGE = `<html lang="en"><body style="margin:0;background:#fff">
    ${Array.from({ length: 5 }, (_, i) => `<button id="b${i}">Bloc ${i}</button>`).join('')}<div style="height:2000px"></div>
    ${Array.from({ length: 30 }, (_, i) => `<div style="height:200px;background:hsl(${i * 30},70%,50%)">Bloc coloré ${i}</div>`).join('')}
    </body></html>`;

let svc = null;
let sid = '';

// Appel au service avec les en-têtes de l'hôte d'outils (`captures`, `vision`) en plus du jeton.
async function appel(methode, route, { corps, captures = false, vision = false } = {}) {
    const entetes = { Authorization: `Bearer ${svc.jeton}` };
    if (captures) entetes['x-elpis-captures'] = '1';
    if (vision) entetes['x-elpis-vision'] = '1';
    const r = await svc.brute(methode, route, { corps: methode === 'GET' ? undefined : { owner: OWNER, session_id: sid, ...corps }, entetes });
    return { status: r.statut, corps: r.corps, entetes: r.entetes, texte: r.texte };
}

const inspecter = (params = {}, o = {}) =>
    appel('GET', `/smart_inspect?${new URLSearchParams({ owner: OWNER, session_id: sid, level: 'lite', skip_screenshot: 'true', ...params })}`, o);

const captures = () => fs.readdirSync(path.join(svc.dossier, 'screenshots')).filter(f => f.includes(sid)).sort();

// Largeur et hauteur d'un JPEG (premier marqueur SOF).
function tailleJpeg(octets) {
    assert.equal(octets.readUInt16BE(0), 0xffd8, 'pas un JPEG');
    for (let i = 2; i < octets.length - 9;) {
        const marqueur = octets.readUInt16BE(i);
        if (marqueur >= 0xffc0 && marqueur <= 0xffc2) return [octets.readUInt16BE(i + 7), octets.readUInt16BE(i + 5)];
        i += 2 + octets.readUInt16BE(i + 2);
    }
    throw new Error('SOF absent');
}

async function attendreFichier(nom, ms = 5000) {
    const chemin = path.join(svc.dossier, 'screenshots', nom);
    for (const fin = Date.now() + ms; Date.now() < fin;) {
        if (fs.existsSync(chemin) && fs.statSync(chemin).size > 0) return fs.readFileSync(chemin);
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`${nom} jamais écrit (${captures().join(', ')})`);
}

before(async () => {
    if (SAUT) return;
    svc = await demarrerService();
    const r = await svc.post('/start', { owner: OWNER, url: 'about:blank', isolated: true });
    assert.equal(r.statut, 200, r.texte);
    sid = r.corps.session_id;
    await svc.post('/mock/add', { owner: OWNER, session_id: sid, url_pattern: `${SITE}/`, status: 200, body: PAGE, content_type: 'text/html' });
});

after(async () => {
    if (svc) await svc.arreter();
});

test('sans demande de l\'hôte : ni capture ni screenshot_step, le pas est compté pour since_step', { skip: SAUT, timeout: 60000 }, async () => {
    const r = await appel('POST', '/action', { corps: { type: 'goto', url: `${SITE}/` } });
    assert.equal(r.status, 200, r.texte);
    assert.equal(r.corps.screenshot_step, undefined);
    const a = await inspecter();
    assert.equal(a.corps.screenshot_step, undefined);
    assert.equal(a.corps.vision_screenshot, undefined);
    assert.ok(Number.isInteger(a.corps.step) && a.corps.step >= 2, JSON.stringify(a.corps.step));
    await appel('POST', '/action', { corps: { type: 'click', selector: '#b1' } });
    const b = await inspecter({ since_step: String(a.corps.step) });
    assert.equal(b.corps.diff?.since_step, a.corps.step);
    assert.equal(b.corps.step, a.corps.step + 2);
    await new Promise(r => setTimeout(r, 400));
    assert.deepEqual(captures(), []);
});

test('captures demandées : une étape JPEG par requête (pw_chain compris), servie en image/jpeg, sans copie live_', { skip: SAUT, timeout: 60000 }, async () => {
    const r = await appel('POST', '/action', { corps: { type: 'click', selector: '#b2' }, captures: true });
    assert.equal(r.status, 200, r.texte);
    const n = r.corps.screenshot_step;
    assert.ok(Number.isInteger(n), JSON.stringify(r.corps));
    const jpeg = await attendreFichier(`step_${sid}_${n}.jpg`);
    assert.deepEqual(tailleJpeg(jpeg), [1920, 1080]);
    const servie = await appel('GET', `/screenshots/step_${sid}_${n}.jpg`);
    assert.equal(servie.status, 200);
    assert.match(String(servie.entetes['content-type']), /^image\/jpeg/);
    const chaine = await appel('POST', '/chain', {
        corps: { actions: [{ type: 'click', selector: '#b3' }, { type: 'wait', ms: 50 }, { type: 'click', selector: '#b4' }] },
        captures: true,
    });
    assert.equal(chaine.status, 200, chaine.texte);
    assert.equal(chaine.corps.screenshot_step, n + 1);
    await attendreFichier(`step_${sid}_${n + 1}.jpg`);
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(captures(), [`step_${sid}_${n}.jpg`, `step_${sid}_${n + 1}.jpg`]);
});

test('vision demandée à l\'inspection : une capture de la fenêtre défilée, réduite à 1024 px, écrite avant la réponse', { skip: SAUT, timeout: 60000 }, async () => {
    const defile = await appel('POST', '/evaluate', { corps: { script: 'window.scrollTo(0, 2400); window.scrollY' } });
    assert.equal(defile.status, 200, defile.texte);
    for (const f of captures()) fs.unlinkSync(path.join(svc.dossier, 'screenshots', f));
    const r = await inspecter({}, { vision: true });
    assert.equal(r.status, 200, r.texte);
    assert.equal(r.corps.vision_screenshot, `vision_${sid}_${r.corps.step}.jpg`);
    assert.equal(r.corps.screenshot_step, undefined);
    const octets = fs.readFileSync(path.join(svc.dossier, 'screenshots', r.corps.vision_screenshot));
    assert.deepEqual(tailleJpeg(octets), [1024, 576]);
    // Page défilée : la capture montre la fenêtre (blocs colorés), pas le haut blanc du document.
    assert.ok(octets.length > 8000, `capture blanche (${octets.length} octets)`);
    assert.deepEqual(captures(), [r.corps.vision_screenshot]);
});
