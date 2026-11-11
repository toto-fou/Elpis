// SPDX-License-Identifier: MIT
// browser-service/test/geste_util.test.js — suivi de la navigation déclenchée par un geste, sur une page factice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { suivreNavigation, champsNavigation } from '../geste_util.js';

// Page factice : événements Playwright émis à la main, URL et chargement pilotés.
class FaussePage extends EventEmitter {
    constructor(url) { super(); this.adresse = url; this.cadre = {}; this.chargements = 0; }
    mainFrame() { return this.cadre; }
    url() { return this.adresse; }
    async waitForLoadState() { this.chargements++; }
}
const requete = (page) => ({ isNavigationRequest: () => true, frame: () => page.cadre });

test('suivreNavigation : sans navigation, null après la grâce ; écouteurs retirés', async () => {
    const page = new FaussePage('http://s/login');
    const t0 = Date.now();
    assert.equal(await suivreNavigation(page, { graceMs: 60 })(), null);
    assert.ok(Date.now() - t0 >= 50);
    assert.equal(page.eventNames().length, 0);
});

test('suivreNavigation : navigation partie après le geste, attendue jusqu\'à la page d\'arrivée', async () => {
    const page = new FaussePage('http://s/login');
    const fin = suivreNavigation(page, { graceMs: 60, maxMs: 2000 });
    page.emit('request', requete(page));
    setTimeout(() => { page.adresse = 'http://s/secure'; page.emit('framenavigated', page.cadre); }, 200);
    assert.deepEqual(await fin(), { url_before: 'http://s/login', url: 'http://s/secure' });
    assert.equal(page.chargements, 1);
    assert.equal(page.eventNames().length, 0);
});

test('suivreNavigation : navigation échouée ou téléchargement, arrêt sans attendre la borne', async () => {
    const page = new FaussePage('http://s/a');
    const fin = suivreNavigation(page, { graceMs: 10, maxMs: 5000 });
    page.emit('request', requete(page));
    setTimeout(() => page.emit('requestfailed', requete(page)), 50);
    const t0 = Date.now();
    assert.equal(await fin(), null);
    assert.ok(Date.now() - t0 < 1000);
    const autre = new FaussePage('http://s/a');
    const fin2 = suivreNavigation(autre, { graceMs: 10, maxMs: 5000 });
    autre.emit('request', requete(autre));
    autre.emit('download', {});
    assert.equal(await fin2(), null);
    const annulee = new FaussePage('http://s/a');
    suivreNavigation(annulee).annuler();
    assert.equal(annulee.eventNames().length, 0);
});

test('suivreNavigation : échéance de la requête atteinte, page arrivée en chargement ou pas encore arrivée → loading, sans attendre la borne', async () => {
    const page = new FaussePage('http://s/a');
    page.waitForLoadState = (_etat, { timeout }) => new Promise((_ok, ko) => setTimeout(() => ko(new Error('Timeout')), timeout));
    const fin = suivreNavigation(page, { graceMs: 10, maxMs: 10000 });
    page.emit('request', requete(page));
    page.adresse = 'http://s/b';
    page.emit('framenavigated', page.cadre);
    const t0 = Date.now();
    const nav = await fin({ limite: Date.now() + 300 });
    assert.deepEqual(nav, { url_before: 'http://s/a', url: 'http://s/b', loading: true });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(champsNavigation(nav).navigated, true);
    assert.match(champsNavigation(nav).nav_warning, /^navigation still loading: http:\/\/s\/b is not fully loaded yet/);
    const lente = new FaussePage('http://s/a');
    const fin2 = suivreNavigation(lente, { graceMs: 10, maxMs: 10000 });
    lente.emit('request', requete(lente));
    const nav2 = await fin2({ limite: Date.now() + 200 });
    assert.deepEqual(nav2, { url_before: 'http://s/a', url: 'http://s/a', loading: true });
    assert.equal(champsNavigation(nav2).navigated, undefined);
    assert.match(champsNavigation(nav2).nav_warning, /tab still shows the page before/);
    assert.deepEqual(champsNavigation({ url_before: 'http://s/a', url: 'http://s/b' }), { url: 'http://s/b', url_before: 'http://s/a', navigated: true });
    assert.deepEqual(champsNavigation(null), {});
});
