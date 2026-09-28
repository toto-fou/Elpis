// SPDX-License-Identifier: MIT
// Régression : classification du résultat de navigation (page.goto).
//
// Bug d'origine : naviguer vers http://IP:port (ex. http://192.1.1.1:8080) via
// l'action goto produisait un HTTP 500 opaque — l'exception de page.goto
// remontait au catch externe (seul /start la protégeait). Le fix capture
// l'erreur et la classe via classifyNavOutcome : succès, succès partiel
// (page atteinte malgré un timeout de load-state), ou 502 nav_error propre.
//
// Tests purs (aucun navigateur requis) : node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNavOutcome, authHint } from '../nav_util.js';

test('goto réussi → 200 success, pas de warning', () => {
    const o = classifyNavOutcome('http://192.1.1.1:8080', 'about:blank',
                                 'http://192.1.1.1:8080/', null);
    assert.equal(o.httpStatus, 200);
    assert.equal(o.body.status, 'success');
    assert.equal(o.body.url, 'http://192.1.1.1:8080/');
    assert.equal(o.body.nav_warning, undefined);
});

test('IP:port joignable mais lente (goto lève mais la page a chargé) → 200 succès partiel', () => {
    // Cas réel du bug : domcontentloaded ne se déclenche pas → goto timeout,
    // mais on a bien atterri sur la cible. Doit RÉUSSIR, pas 500.
    const o = classifyNavOutcome('http://192.1.1.1:8080', 'about:blank',
                                 'http://192.1.1.1:8080/', 'Timeout 60000ms exceeded');
    assert.equal(o.httpStatus, 200);
    assert.equal(o.body.status, 'success');
    assert.equal(o.body.url, 'http://192.1.1.1:8080/');
    assert.equal(o.body.nav_warning, 'Timeout 60000ms exceeded');
});

test('IP:port injoignable sur page neuve (reste about:blank) → 502 nav_error', () => {
    const o = classifyNavOutcome('http://192.1.1.1:8080', 'about:blank',
                                 'about:blank', 'net::ERR_CONNECTION_REFUSED');
    assert.equal(o.httpStatus, 502);
    assert.equal(o.body.status, 'nav_error');
    assert.match(o.body.error, /192\.1\.1\.1:8080/);
    assert.match(o.body.error, /ERR_CONNECTION_REFUSED/);
});

test('goto refusé qui ne quitte pas la page courante → 502 (pas un faux succès)', () => {
    // Chromium ne commit pas la nav échouée → page.url() reste sur la page
    // précédente. Rester sur place == échec, surtout PAS un succès.
    const o = classifyNavOutcome('http://192.1.1.1:8080', 'https://exemple.fr/page',
                                 'https://exemple.fr/page', 'net::ERR_ADDRESS_UNREACHABLE');
    assert.equal(o.httpStatus, 502);
    assert.equal(o.body.status, 'nav_error');
    assert.equal(o.body.url, 'https://exemple.fr/page');
});

test('redirection : goto lève mais on a bougé vers une autre URL → 200 succès partiel', () => {
    const o = classifyNavOutcome('http://192.1.1.1:8080', 'about:blank',
                                 'http://192.1.1.1:8080/login', 'Timeout 60000ms exceeded');
    assert.equal(o.httpStatus, 200);
    assert.equal(o.body.status, 'success');
    assert.equal(o.body.url, 'http://192.1.1.1:8080/login');
});

test('landed vide/undefined avec erreur → 502 nav_error (url null)', () => {
    const o = classifyNavOutcome('http://192.1.1.1:8080', 'about:blank',
                                 '', 'net::ERR_NAME_NOT_RESOLVED');
    assert.equal(o.httpStatus, 502);
    assert.equal(o.body.status, 'nav_error');
    assert.equal(o.body.url, null);
});

test('le message nav_error inclut TOUJOURS l\'URL cible et la cause', () => {
    const o = classifyNavOutcome('http://10.0.0.5:9000/api', 'about:blank',
                                 'about:blank', 'net::ERR_CONNECTION_TIMED_OUT');
    assert.match(o.body.error, /http:\/\/10\.0\.0\.5:9000\/api/);
    assert.match(o.body.error, /ERR_CONNECTION_TIMED_OUT/);
});


// ── authHint : guidage du modèle sur les pages protégées par auth HTTP ──
// (le modèle ne devinait pas que username/password vont au pw_session start)
test('401 → hint pointant vers pw_session(start) avec username/password', () => {
    const h = authHint(401);
    assert.ok(h, 'un hint doit être renvoyé pour 401');
    assert.match(h, /401/);
    assert.match(h, /pw_session/);
    assert.match(h, /username/);
    assert.match(h, /password/);
});

test('407 → hint proxy', () => {
    const h = authHint(407);
    assert.ok(h);
    assert.match(h, /407|[Pp]roxy/);
});

test('200/404/null → pas de hint d\'auth', () => {
    assert.equal(authHint(200), null);
    assert.equal(authHint(404), null);
    assert.equal(authHint(null), null);
    assert.equal(authHint(undefined), null);
});
