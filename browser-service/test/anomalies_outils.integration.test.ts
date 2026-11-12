// SPDX-License-Identifier: MIT
// browser-service/test/anomalies_outils.integration.test.ts — vrai service et Chromium contre des pages locales : recorder par ref, compteur des mocks, seuil visuel, contraste a11y, options de session réutilisée, erreurs par document.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { demarrerService, portDe, raisonDeSauter } from './aides/service.ts';
import type { Service } from './aides/service.ts';

const SAUTER = await raisonDeSauter();
const OWNER = 'anomalies';
const PAGES: Record<string, string> = {
    '/avec-onload': '<title>Onload</title><body onload="throw new Error(\'boom du chargement\')">page',
    '/': '<title>Accueil</title><button id="b" onclick="document.title=\'clic\'">Envoyer</button><input placeholder="Votre nom"><div><span>a</span><span class="x" onclick="1">b</span></div>',
};

// Violation relevée par /a11y_audit.
interface Violation { rule: string; selector: string; message: string }
// Événement noté par le recorder (format json).
interface Evenement { action: string; locator: unknown }

// Champs des réponses lus par ces essais.
interface Corps {
    session_id: string;
    matches?: { ref: string }[];
    ref: string;
    script: string;
    id: string;
    mocks: { id: string; used: number; exhausted: boolean }[];
    baseline_created: boolean;
    passed: boolean;
    pixel_diff_failed: boolean;
    diff_pixels: number;
    max_diff_pixels: number;
    diff_ratio: number;
    threshold: number;
    violations: Violation[];
    contrast_skipped: number;
    contrast_note: string;
    tabs: unknown[];
    code: string;
    ignored_options: string[];
    fix: string;
    reused: boolean;
    console_errors: string[];
}

let service!: Service<Corps>;
let pages!: http.Server;
let base = '';
let sid = '';

const api = (route: string, corps: Record<string, unknown> = {}) => service.post(route, { owner: OWNER, session_id: sid, ...corps });
const ouvrir = (chemin: string) => api('/action', { type: 'goto', url: `${base}${chemin}` });

before(async () => {
    if (SAUTER) return;
    pages = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGES[req.url!.split('?')[0]!] || `<title>${req.url}</title>`);
    });
    await new Promise<void>(r => pages.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${portDe(pages)}`;
    service = await demarrerService<Corps>();
    const r = await service.post('/start', { owner: OWNER, url: `${base}/`, isolated: true });
    assert.equal(r.statut, 200, r.texte);
    sid = r.corps.session_id;
});

after(async () => {
    if (service) await service.arreter();
    if (pages) { pages.closeAllConnections(); await new Promise(r => pages.close(r)); }
});

test('recorder : un geste par ref est noté avec un sélecteur stable dans tous les formats', { skip: SAUTER, timeout: 60000 }, async () => {
    await ouvrir('/');
    const trouve = await api('/locator', { by_css: '#b', visible_only: false, max: 1 });
    const ref = trouve.corps.matches?.[0]?.ref || trouve.corps.ref;
    assert.ok(ref, trouve.texte);
    const champ = (await api('/locator', { by_css: 'input', visible_only: false, max: 1 })).corps;
    const refChamp = champ.matches?.[0]?.ref || champ.ref;
    await api('/recorder/start');
    assert.equal((await api('/action', { type: 'click', ref })).statut, 200);
    assert.equal((await api('/chain', { actions: [{ type: 'fill', ref: refChamp, text: 'Zoé' }] })).statut, 200);
    for (const format of ['playwright', 'cypress', 'robot', 'json']) {
        const d = await service.get(`/recorder/dump?owner=${OWNER}&session_id=${sid}&format=${format}`);
        assert.doesNotMatch(d.corps.script, /locator\(''\)|get\(''\)|Click {4}\${EMPTY}|"ref"\s*:\s*"loc_[^"]*",\s*"url"[^}]*}\s*$/, `${format} : ${d.corps.script}`);
        if (format === 'playwright') {
            assert.match(d.corps.script, /getByRole\('button', \{ name: 'Envoyer' \}\)\.click\(\)/, d.corps.script);
            assert.match(d.corps.script, /getByPlaceholder\('Votre nom'\)\.fill\('Zoé'\)/, d.corps.script);
        }
        if (format === 'json') {
            const [clic] = (JSON.parse(d.corps.script) as Evenement[]).filter(e => e.action === 'click');
            assert.deepEqual(clic!.locator, { role: 'button', name: 'Envoyer' });
        }
    }
});

test('pw_mock list : chaque réponse servie par un mock est comptée, avec ou sans limite de fois', { skip: SAUTER, timeout: 60000 }, async () => {
    await ouvrir('/');
    const illimite = (await api('/mock/add', { url_pattern: '/api/libre', body: '{"a":1}' })).corps.id;
    const limite = (await api('/mock/add', { url_pattern: '/api/limite', body: '{"b":1}', times: 2 })).corps.id;
    const appels = (chemin: string, n: number) => api('/evaluate', { script: `for (let i = 0; i < ${n}; i++) await fetch('${chemin}'); return 1` });
    assert.equal((await appels('/api/libre', 3)).statut, 200);
    assert.equal((await appels('/api/limite', 2)).statut, 200);
    const liste = (await service.get(`/mock/list?owner=${OWNER}&session_id=${sid}`)).corps.mocks;
    assert.equal(liste.find(m => m.id === illimite)!.used, 3);
    assert.deepEqual(liste.find(m => m.id === limite), { ...liste.find(m => m.id === limite), used: 2, exhausted: true });
    await api('/mock/clear');
});

test('pw_visual : le seuil par défaut échoue sur un petit changement, le seuil explicite reste respecté, les pixels changés sont rapportés', { skip: SAUTER, timeout: 60000 }, async () => {
    await api('/action', { type: 'goto', url: `${base}/` });
    await api('/evaluate', { script: "document.body.innerHTML = '<div style=\"width:300px;height:300px\"></div>'; document.body.style.margin = '0'" });
    assert.equal((await api('/visual', { name: 'petit', update: true })).corps.baseline_created, true);
    await api('/evaluate', { script: "document.body.firstChild.innerHTML = '<div style=\"width:100px;height:100px;background:#000\"></div>'" });
    const defaut = (await api('/visual', { name: 'petit' })).corps;
    assert.equal(defaut.passed, false, JSON.stringify(defaut));
    assert.equal(defaut.pixel_diff_failed, true);
    assert.ok(defaut.diff_pixels >= 5000 && defaut.diff_pixels <= 20000, String(defaut.diff_pixels));
    assert.equal(defaut.max_diff_pixels, 200);
    assert.ok(defaut.diff_ratio < 0.01, 'passerait avec l\'ancien seuil de 1 %');
    const explicite = (await api('/visual', { name: 'petit', threshold: 0.05 })).corps;
    assert.equal(explicite.passed, true, JSON.stringify(explicite));
    assert.equal(explicite.threshold, 0.05);
    assert.equal(explicite.max_diff_pixels, undefined);
});

test('pw_a11y : texte gris clair sur blanc signalé, grand texte à 3:1, fond hérité des ancêtres, image écartée avec une note', { skip: SAUTER, timeout: 60000 }, async () => {
    await api('/evaluate', { script: `document.documentElement.lang = 'en'; document.body.innerHTML =
        '<div id="a" style="color:#ccc">Pale grey</div><strong id="b" style="color:#767676">Fine</strong><h2 id="f" style="color:#888;font-size:30px">Large ok</h2>'
        + '<div style="background:#000"><p><em id="c" style="color:#222">Dark on black</em></p></div>'
        + '<h1 id="d" style="color:#999;font-size:30px">Large pale</h1>'
        + '<div style="background-image:linear-gradient(red, blue)"><span id="e" style="color:#ccc">On gradient</span></div>'; return 1` });
    const r = (await api('/a11y_audit')).corps;
    const contrastes = r.violations.filter(v => v.rule === 'color-contrast');
    const par = (id: string) => contrastes.find(v => v.selector.includes(id));
    assert.ok(par('#a'), JSON.stringify(contrastes));
    assert.match(par('#a')!.message, /^contrast 1\.6\d:1 < 4\.5:1/);
    assert.equal(par('#b'), undefined, '#767676 sur blanc = 4.54:1');
    assert.equal(par('#f'), undefined, 'grand texte #888 = 3.54:1 passe à 3:1');
    assert.ok(par('#c'), 'fond noir hérité du parent');
    assert.match(par('#d')!.message, /< 3:1 \(WCAG AA, large text\)/);
    assert.equal(par('#e'), undefined);
    assert.equal(r.contrast_skipped, 1);
    assert.match(r.contrast_note, /image or gradient/);
});

test('pw_session start : record_har, trace ou émulation sur une session reprise sont refusés explicitement, sans ouvrir ni appliquer', { skip: SAUTER, timeout: 60000 }, async () => {
    const avant = (await service.get(`/list_tabs?owner=${OWNER}&session_id=${sid}`)).corps.tabs.length;
    for (const option of [{ record_har: true }, { trace: true }, { record_video: true }, { device: 'iPhone 13' }, { color_scheme: 'dark' }]) {
        const r = await service.post('/start', { owner: OWNER, url: `${base}/autre`, ...option });
        assert.equal(r.statut, 409, r.texte);
        assert.equal(r.corps.code, 'session_options_need_new_session');
        assert.deepEqual(r.corps.ignored_options, Object.keys(option));
        assert.match(r.corps.fix, /isolated=true/);
    }
    assert.equal((await service.get(`/list_tabs?owner=${OWNER}&session_id=${sid}`)).corps.tabs.length, avant);
    const simple = await service.post('/start', { owner: OWNER, url: `${base}/autre`, record_har: false, trace: false });
    assert.equal(simple.corps.reused, true, simple.texte);
});

test('pw_page inspect : console_errors du document courant seulement, erreur non rattrapée d\'un onload comprise', { skip: SAUTER, timeout: 60000 }, async () => {
    const erreurs = async () => (await service.get(`/smart_inspect?owner=${OWNER}&session_id=${sid}&level=lite&skip_screenshot=true`)).corps.console_errors;
    await ouvrir('/ancienne');
    await api('/evaluate', { script: "console.error('erreur de l\\'ancienne page'); return 1" });
    assert.deepEqual(await erreurs(), ["[error] erreur de l'ancienne page"]);
    await ouvrir('/chargement');
    assert.deepEqual(await erreurs(), [], 'rien de la page précédente');
    await ouvrir('/avec-onload');
    const apres = await erreurs();
    assert.equal(apres.length, 1, JSON.stringify(apres));
    assert.match(apres[0]!, /^\[pageerror\] .*boom du chargement/);
});
