// SPDX-License-Identifier: MIT
// test/securite-identifiants-origine.test.js — identifiants d'un contexte liés à l'origine exacte de l'adresse de départ, avis rendus au modèle. Sans Playwright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisIdentifiants, identifiantsPourOrigine } from '../session_util.js';

const A = 'http://192.168.0.10:8080';

test('origine exacte : schéma, hôte, port ; chemin, casse et port par défaut ramenés', () => {
    assert.deepEqual(identifiantsPourOrigine(`${A}/login?x=1`, 'u', 'p'),
        { username: 'u', password: 'p', origin: A, send: 'unauthorized' });
    assert.equal(identifiantsPourOrigine('https://Intranet.LAN:443/x', 'u', 'p').origin, 'https://intranet.lan');
    assert.equal(identifiantsPourOrigine('http://[fd00::1]:8080/', 'u', 'p').origin, 'http://[fd00::1]:8080');
    assert.equal(identifiantsPourOrigine('http://nom:secret@hote.lan/', 'u', 'p').origin, 'http://hote.lan');
});

test('sans adresse http(s) ou sans couple complet : aucun identifiant, jamais sans origine', () => {
    for (const url of [undefined, null, '', 'pas une url', 'about:blank', 'data:text/plain,x', 'file:///etc/passwd', 'ftp://h/'])
        assert.equal(identifiantsPourOrigine(url, 'u', 'p'), undefined, String(url));
    assert.equal(identifiantsPourOrigine(A, 'u', ''), undefined);
    assert.equal(identifiantsPourOrigine(A, '', 'p'), undefined);
    assert.equal(identifiantsPourOrigine(A, undefined, undefined), undefined);
});

test('aucun identifiant demandé : aucun avis', () => {
    assert.deepEqual(avisIdentifiants(false, undefined, null, 401, A), {});
});

test('contexte réutilisé sans ces identifiants : non appliqués, le dire', () => {
    const demandes = identifiantsPourOrigine(`${A}/`, 'u', 'p');
    for (const lies of [null, { origin: 'http://autre.lan', username: 'u' }, { origin: A, username: 'autre' }]) {
        const avis = avisIdentifiants(true, demandes, lies, 401, `${A}/`);
        assert.equal(avis.credentials_applied, false);
        assert.match(avis.credentials_warning, /isolated=true/);
        assert.ok(!avis.credentials_warning.includes('"p"'));
    }
});

test('contexte qui porte déjà ces identifiants : aucun avis', () => {
    const demandes = identifiantsPourOrigine(`${A}/`, 'u', 'p');
    assert.deepEqual(avisIdentifiants(true, demandes, { origin: A, username: 'u' }, 200, `${A}/`), {});
    assert.deepEqual(avisIdentifiants(true, demandes, demandes, 401, `${A}/x`), {});
});

test('redirection vers une autre origine qui répond 401 : le dire ; sans 401 : rien', () => {
    const demandes = identifiantsPourOrigine(`${A}/`, 'u', 'p');
    const avis = avisIdentifiants(true, demandes, demandes, 401, 'https://192.168.0.10:8443/login');
    assert.equal(avis.credentials_applied, undefined);
    assert.match(avis.credentials_warning, /https:\/\/192\.168\.0\.10:8443/);
    assert.deepEqual(avisIdentifiants(true, demandes, demandes, 200, 'https://192.168.0.10:8443/login'), {});
    assert.deepEqual(avisIdentifiants(true, demandes, demandes, undefined, 'pas une url'), {});
});

test('adresse sans origine : les identifiants fournis ne sont pas posés, le dire', () => {
    const avis = avisIdentifiants(true, undefined, null, undefined, 'about:blank');
    assert.equal(avis.credentials_applied, false);
    assert.match(avis.credentials_warning, /http\(s\)/);
});
