// SPDX-License-Identifier: MIT
// test/secret_util.test.js — connexion avec un secret du coffre : origine, formes encodées du mot de passe, purge des sorties de /login, charge d'une requête et garde réseau ; quota sans session protégée.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { origineDe, formesSecret, purgerTexte, chargeRequete, requetePorteSecret } from '../secret_util.js';
import { planSessionSlot } from '../session_util.js';

const SECRET = 'Mdp tres&secret/42é';

test('origineDe : http(s) seulement, jamais about:, data:, srcdoc ni javascript:', () => {
    assert.equal(origineDe('https://a.example:8443/x?y#z'), 'https://a.example:8443');
    assert.equal(origineDe('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
    for (const u of ['about:blank', 'about:srcdoc', 'data:text/html,x', 'javascript:alert(1)', 'blob:https://a/1', '', null, 'pas une url'])
        assert.equal(origineDe(u), null, String(u));
});

test('formesSecret : brute, URL, formulaire, HTML, JSON, base64 (trois variantes), hexadécimal', () => {
    const f = formesSecret(SECRET);
    for (const attendu of [SECRET, encodeURIComponent(SECRET), new URLSearchParams({ x: SECRET }).toString().slice(2),
        Buffer.from(SECRET).toString('base64'), Buffer.from(SECRET).toString('base64url'), Buffer.from(SECRET).toString('hex'),
        JSON.stringify(SECRET).slice(1, -1), SECRET.replaceAll('&', '&amp;')])
        assert.ok(f.includes(attendu), attendu);
    assert.deepEqual(formesSecret('ab'), []);
});

test('purgerTexte : toutes les formes données, tel quel sans formes', () => {
    const formes = formesSecret(SECRET);
    assert.equal(purgerTexte(`x ${SECRET}`, null), `x ${SECRET}`);
    assert.equal(purgerTexte(`x ${SECRET}`, []), `x ${SECRET}`);
    const t = purgerTexte(`a ${SECRET} /p?x=${encodeURIComponent(SECRET)} ${Buffer.from(SECRET).toString('base64')}`, formes);
    assert.equal(t, 'a [secret] /p?x=[secret] [secret]');
    assert.equal(purgerTexte(undefined, formes), '');
});

test('purge sans oracle : seule une forme ENTIÈRE est masquée, aucun morceau (préfixe, suffixe, milieu, caractère) au bord ou au milieu d\'un texte', () => {
    const formes = formesSecret('Correct-Horse-Battery!');
    for (const f of formes)
        for (let i = 0; i < f.length; i++)
            for (let j = i + 1; j <= f.length; j++) {
                const morceau = f.slice(i, j);
                if (formes.some((g) => morceau.includes(g))) continue;
                for (const t of [morceau, `a ${morceau}`, `${morceau} z`, `a ${morceau} z`, `${morceau}…`])
                    assert.equal(purgerTexte(t, formes), t, JSON.stringify(t));
            }
    assert.equal(purgerTexte('x Correct-Horse-Battery! y', formes), 'x [secret] y');
    assert.equal(purgerTexte('Correct-Horse-Battery', formes), 'Correct-Horse-Battery');
});

test('formes du HTML sérialisé (texte et attribut)', () => {
    const f = formesSecret('a&b<c>"d e\'f');
    assert.ok(f.includes('a&amp;b&lt;c&gt;"d&nbsp;e\'f'), 'texte');
    assert.ok(f.includes('a&amp;b<c>&quot;d&nbsp;e\'f'), 'attribut');
});

test('chargeRequete : corps puis en-têtes ; vide si la requête ne se lit plus', () => {
    assert.equal(chargeRequete({ postData: () => 'u=a', headers: () => ({ 'x-a': '1', accept: '*/*' }) }), 'u=a\n1\n*/*');
    assert.equal(chargeRequete({ postData: () => null, headers: () => ({}) }), '');
    assert.equal(chargeRequete({ postData: () => { throw new Error('fermée'); }, headers: () => ({}) }), '');
});

test('garde réseau : adresse, corps ou en-têtes qui portent une forme du mot de passe', () => {
    const formes = formesSecret(SECRET);
    assert.ok(requetePorteSecret(`https://x/?p=${encodeURIComponent(SECRET)}`, '', formes));
    assert.ok(requetePorteSecret('https://x/', `u=a&p=${new URLSearchParams({ x: SECRET }).toString().slice(2)}`, formes));
    assert.ok(requetePorteSecret('https://x/', `{"p":${JSON.stringify(SECRET)}}`, formes));
    assert.ok(requetePorteSecret('https://x/', `x-p: ${Buffer.from(SECRET).toString('base64')}`, formes));
    assert.ok(!requetePorteSecret('https://x/', 'u=alice', formes));
});

test('quota : la plus ancienne session du propriétaire cède la place, quelle que soit la session (plus de session protégée)', () => {
    const sess = new Map([['s1', { owner: 'o', lastActivity: 1, tls: 'strict' }], ['n1', { owner: 'o', lastActivity: 2 }]]);
    assert.deepEqual(planSessionSlot(sess, 'o', { maxTotal: 10, maxPerOwner: 2 }), { evict: 's1', refuse: false });
    assert.deepEqual(planSessionSlot(sess, 'o', { maxTotal: 10, maxPerOwner: 3 }), { evict: null, refuse: false });
});
