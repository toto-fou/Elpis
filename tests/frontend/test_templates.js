// SPDX-License-Identifier: MIT
/* Tests Node des templates de prompt (2026-09-21).
 * Lancer : node tests/frontend/test_templates.js
 * Cf. docs/templates-prompt-design-2026-09-21.md.
 */
const path = require('path');
const assert = require('assert');
const { t, fin } = require('./lib/harnais.js');

const T = require(path.join(__dirname, '../../frontend/js/chat/_templates.js'));
const noms = (c) => T.parse(c).vars.map(v => v.name);

t('variables simples, ordre de première apparition, sans doublon', () => {
    assert.deepStrictEqual(noms('Traduis {{texte}} en {{langue}}. Relis {{texte}}.'), ['texte', 'langue']);
    assert.deepStrictEqual(noms('Rien à remplir.'), []);
});

t('accents et tirets dans un nom', () => {
    assert.deepStrictEqual(noms('{{sujet_précis}} et {{mot-clé}}'), ['sujet_précis', 'mot-clé']);
});

t('champ multiligne et liste (syntaxe Open WebUI)', () => {
    const v = T.parse('{{texte | textarea}} {{ton | select:options=["neutre","formel"]}}').vars;
    assert.strictEqual(v[0].type, 'textarea');
    assert.strictEqual(v[1].type, 'select');
    assert.deepStrictEqual(v[1].options, ['neutre', 'formel']);
});

t('propriétés : placeholder, default, required', () => {
    const [v] = T.parse('{{nom | text:placeholder="Ex. : Paul":default="Anne":required}}').vars;
    assert.strictEqual(v.type, 'text');
    assert.strictEqual(v.placeholder, 'Ex. : Paul');     // « : » entre guillemets conservé
    assert.strictEqual(v.default, 'Anne');
    assert.strictEqual(v.required, true);
});

t('propriété sans type devant', () => {
    const [v] = T.parse('{{nom | placeholder="x"}}').vars;
    assert.strictEqual(v.type, 'text');
    assert.strictEqual(v.placeholder, 'x');
});

t('liste sans options = champ texte', () => {
    assert.strictEqual(T.parse('{{a | select}}').vars[0].type, 'text');
});

t('définition typée APRÈS une mention nue : la définition l’emporte', () => {
    const v = T.parse('Voir {{texte}} puis {{texte | textarea}}').vars;
    assert.strictEqual(v.length, 1);
    assert.strictEqual(v[0].type, 'textarea');
    assert.strictEqual(v[0].name, 'texte');
});

t('variables système reconnues (FR, Open WebUI, LibreChat), casse indifférente', () => {
    const r = T.parse('{{date}} {{CURRENT_DATE}} {{Heure}} {{USER_NAME}} {{current_user}} {{CLIPBOARD}} {{a}}');
    assert.deepStrictEqual(r.vars.map(v => v.name), ['a']);
    assert.deepStrictEqual(r.system, ['date', 'heure', 'utilisateur', 'presse_papier']);
});

t('rendu : valeurs, système, variables manquantes vides', () => {
    const sys = T.systemValues({ now: new Date(2026, 8, 21, 9, 5), userName: 'Paul' });
    const out = T.render('Le {{date}} à {{heure}}, {{USER_NAME}} : {{Texte}} [{{absent}}]',
                         { texte: 'bonjour' }, sys);
    assert.strictEqual(out, 'Le 2026-09-21 à 09:05, Paul : bonjour []');
});

t('rendu : une définition typée est remplacée comme une mention nue', () => {
    assert.strictEqual(T.render('A {{t | textarea:required}} B', { t: 'x' }, {}), 'A x B');
});

t('les accolades seules ne sont pas des variables', () => {
    assert.deepStrictEqual(noms('code {x} {{ }} {{a b}}'), []);
    assert.strictEqual(T.render('{x} {{ }}', {}, {}), '{x} {{ }}');
});

t('jour de la semaine et date_heure', () => {
    const s = T.systemValues({ now: new Date(2026, 8, 21, 14, 30) });
    assert.strictEqual(s.date_heure, '2026-09-21 14:30');
    assert.strictEqual(s.jour, 'lundi');
});

t('raccourci valide', () => {
    assert.ok(T.validName('resume') && T.validName('trad-en') && T.validName('a1_b'));
    assert.ok(!T.validName('') && !T.validName('Resume') && !T.validName('-x') && !T.validName('a b'));
});

fin('test_templates.js');
