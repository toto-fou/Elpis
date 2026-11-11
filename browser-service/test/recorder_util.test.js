// SPDX-License-Identifier: MIT
// browser-service/test/recorder_util.test.js — recorder : champs secrets remplacés par une variable d'environnement (une par champ), secrets retirés des évaluations et des URL, évaluations notées.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variableSecrete, masquerSecret, masquerScript, masquerUrl, variablePourChamp, commentaireEval, notesDuScript, celluleRobot } from '../recorder_util.js';

test('variableSecrete : type password, noms et libellés qui évoquent un secret ; champs ordinaires laissés', () => {
    assert.equal(variableSecrete({ type: 'password' }), 'PASSWORD');
    assert.equal(variableSecrete({ type: 'PASSWORD', name: 'pin' }), 'PIN');
    assert.equal(variableSecrete({ name: 'otp_code' }), 'OTP');
    assert.equal(variableSecrete({ autocomplete: 'one-time-code' }), 'OTP');
    assert.equal(variableSecrete({ labels: 'Mot de passe' }), 'PASSWORD');
    assert.equal(variableSecrete({ id: 'api-key' }), 'API_KEY');
    assert.equal(variableSecrete({ name: 'access_token' }), 'TOKEN');
    assert.equal(variableSecrete({}, ['#password']), 'PASSWORD');
    assert.equal(variableSecrete({ name: 'username', type: 'text' }), null);
    assert.equal(variableSecrete({ name: 'passport_number' }), null);
    assert.equal(variableSecrete({ name: 'spinner' }), null);
});

test('masquerSecret : valeur retirée et variable nommée ; saisie ordinaire intacte', () => {
    const evt = { action: 'fill', locator: { label: 'Password' }, value: 'SuperSecretPassword!', url: 'u' };
    assert.deepEqual(masquerSecret(evt), { action: 'fill', locator: { label: 'Password' }, url: 'u', secret: 'PASSWORD' });
    assert.deepEqual(masquerSecret({ action: 'type', selector: '#pw1', text: 'x', value: 'x' }, { type: 'password' }),
        { action: 'type', selector: '#pw1', secret: 'PASSWORD' });
    const ordinaire = { action: 'fill', locator: { label: 'Username' }, value: 'tomsmith' };
    assert.equal(masquerSecret(ordinaire, { type: 'text', name: 'username' }), ordinaire);
});

test('commentaireEval et notesDuScript : une ligne bornée, variables et évaluations annoncées', () => {
    assert.equal(commentaireEval('a\n// b\r\nc\u2028d'), 'a // b c d');
    assert.equal(commentaireEval('1\x1c\x1f\x1fEvaluate\x85x'), '1 Evaluate x');
    assert.equal(commentaireEval('x'.repeat(200)).length, 120);
    const n = notesDuScript([{ action: 'fill', secret: 'PASSWORD' }, { action: 'fill', secret: 'OTP' },
        { action: 'fill', secret: 'PASSWORD' }, { action: 'eval', script: '1' }]);
    assert.deepEqual(n.secret_variables, ['OTP', 'PASSWORD']);
    assert.equal(n.notes.length, 2);
    assert.match(n.notes[0], /set OTP, PASSWORD in the environment/);
    assert.match(n.notes[1], /^1 eval call\(s\) kept as comments, not replayed/);
    assert.deepEqual(notesDuScript([{ action: 'click' }]), { secret_variables: [], notes: [] });
});

test('celluleRobot : ni variable évaluée, ni ligne, ni cellule ajoutée ; blancs codés, valeur exacte au rejeu', () => {
    assert.equal(celluleRobot('France ${{1+1}}'), 'France \\${{1+1}}');
    assert.equal(celluleRobot('a\n    Log    x'), String.raw`a\u000a\u0020\u0020\u0020 Log\u0020\u0020\u0020 x`);
    assert.equal(celluleRobot('x\x1c\x1f\x1fEvaluate\x1f\x1f1\x85y\u2028z'), String.raw`x\u001c\u001f\u001fEvaluate\u001f\u001f1\u0085y\u2028z`);
    assert.equal(celluleRobot('C:\\d @{l} &{d} %{E} #c a=b | *{x}'), 'C:\\\\d \\@{l} \\&{d} \\%{E} \\#c a\\=b \\| \\*{x}');
    assert.equal(celluleRobot('10\u202f000,00\u00a0€'), String.raw`10\u202f000,00\u00a0€`);
    assert.equal(celluleRobot(' a  b '), String.raw`\u0020a\u0020 b\u0020`);
    assert.equal(celluleRobot(undefined), '${EMPTY}');
});

test('masquerSecret avec variables : une variable par champ (PASSWORD, PASSWORD_2…), la même pour le même champ', () => {
    const variables = new Map();
    const saisie = (id, label) => masquerSecret({ action: 'fill', locator: { css: `#${id}` }, value: 's' }, { type: 'password', id, labels: label }, variables).secret;
    assert.equal(saisie('actuel', 'Current password'), 'PASSWORD');
    assert.equal(saisie('nouveau', 'New password'), 'PASSWORD_2');
    assert.equal(saisie('confirme', 'Confirm'), 'PASSWORD_3');
    assert.equal(saisie('actuel', 'Current password'), 'PASSWORD');
    assert.equal(masquerSecret({ action: 'fill', locator: { label: 'PIN' }, value: '1' }, {}, variables).secret, 'PIN');
    assert.equal(masquerSecret({ action: 'fill', locator: { label: 'PIN code' }, value: '1' }, {}, variables).secret, 'PIN_2');
    assert.equal(variablePourChamp('TOKEN', 'x'), 'TOKEN');
});

test('masquerScript : littéraux et valeur affectée masqués dès que le script saisit ou cite un secret ; script ordinaire intact', () => {
    assert.equal(masquerScript("document.querySelector('#pw').value='hunter2'; return 1"), "document.querySelector('***').value='***'; return 1");
    assert.equal(masquerScript('el.value = 1234; ok.value == 2'), 'el.value = ***; ok.value == 2');
    assert.equal(masquerScript('el.value += "a;b" + "c"'), "el.value += '***' + '***'");
    assert.equal(masquerScript("document.execCommand('insertText', false, 'x1')"), "document.execCommand('***', false, '***')");
    assert.equal(masquerScript('localStorage.setItem(`token`, `abc`)'), "localStorage.setItem('***', '***')");
    assert.equal(masquerScript("return { password: 'p' }"), "return { password: '***' }");
    assert.equal(masquerScript("document.querySelector('h1').textContent"), "document.querySelector('h1').textContent");
    assert.equal(masquerScript(undefined), '');
});

test('masquerScript : un long script sensible est masqué en entier, sans analyse quadratique', () => {
    assert.equal(masquerScript("token = '" + 'x'.repeat(9000) + "'"), "'***'");
    const t0 = Date.now();
    assert.equal(masquerScript("// token '" + "\\'".repeat(20000)), "'***'");
    assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
    assert.equal(masquerScript('x'.repeat(9000)), 'x'.repeat(9000));
});

test('masquerUrl : identifiants et paramètres sensibles (requête et fragment) masqués, le reste gardé', () => {
    assert.equal(masquerUrl('http://u:p@h.lan/x?token=S&page=2&api_key=K&keyword=k&code=C#access_token=F&state=ok'),
        'http://h.lan/x?token=***&page=2&api_key=***&keyword=k&code=***#access_token=***&state=ok');
    assert.equal(masquerUrl('https://h.lan/cb?SAMLResponse=x&PHPSESSID=y&X-Amz-Signature=z&sig=w&password=p&session_id=s&authToken=a'),
        'https://h.lan/cb?SAMLResponse=***&PHPSESSID=***&X-Amz-Signature=***&sig=***&password=***&session_id=***&authToken=***');
    for (const u of ['http://h.lan/x?q=1&page=2', 'http://h.lan/a#section', 'about:blank', 'pas une url', ''])
        assert.equal(masquerUrl(u), u);
    assert.equal(masquerUrl(undefined), undefined);
    const n = notesDuScript([{ action: 'goto', url: 'u', url_masked: true }, { action: 'click', url: 'u', url_masked: true }]);
    assert.match(n.notes[0], /^1 goto URL\(s\) had credentials or sensitive parameters replaced by \*\*\*/);
});
