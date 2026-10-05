// SPDX-License-Identifier: MIT
// États sauvegardés avant la 0.0.1 (``state_<id>.json``, sans propriétaire) :
// jamais chargés, signalés avec la marche à suivre, jamais purgés.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyStateFileName, isLegacyStateName, resolveStateFile, stateFileName,
         planArtifactPurge } from '../session_util.js';

const ID = '0a1b2c3d-1111-2222-3333-444455556666';
const existe = (...noms) => (nom) => noms.includes(nom);

test('nom ancien : celui d’avant la 0.0.1, jamais un nom par compte', () => {
    assert.equal(legacyStateFileName(ID), `state_${ID}.json`);
    assert.equal(legacyStateFileName('../../etc/passwd'), null);
    assert.equal(legacyStateFileName(''), null);
    assert.equal(isLegacyStateName(`state_${ID}.json`), true);
    assert.equal(isLegacyStateName(stateFileName('alice', ID)), false);
    assert.equal(isLegacyStateName(stateFileName('u_0123abcd', ID)), false);
    assert.equal(isLegacyStateName('state_court.json'), false);
    assert.equal(isLegacyStateName(`har_${ID}.har`), false);
});

test('l’état du compte se charge', () => {
    const nom = stateFileName('alice', ID);
    assert.deepEqual(resolveStateFile('alice', ID, existe(nom, `state_${ID}.json`)), { file: nom });
});

test('état sans compte : jamais chargé, la réponse dit comment le rattacher', () => {
    const r = resolveStateFile('alice', ID, existe(`state_${ID}.json`));
    assert.equal(r.file, undefined);
    assert.equal(r.code, 'legacy_state');
    assert.match(r.error, /avant la version 0\.0\.1/);
    assert.ok(r.fix.includes(`./elpis browser migrate-states <compte> ${ID}`), r.fix);
    assert.ok(r.fix.includes(`cookies/state_${ID}.json en state_alice__${ID}.json`), r.fix);
    // Une session déjà ouverte serait réutilisée sans charger l'état.
    assert.match(r.fix, /même load_state_id \(isolated=true si une session est déjà ouverte\)/);
});

test('l’état d’un autre compte répond comme un état inconnu', () => {
    const r = resolveStateFile('bob', ID, existe(stateFileName('alice', ID)));
    assert.equal(r.file, undefined);
    assert.equal(r.code, 'state_not_found');
    assert.equal(r.error, 'État sauvegardé introuvable (load_state_id).');
    assert.ok(!r.fix.includes('alice'), r.fix);
});

test('identifiant ou propriétaire invalide : rien n’est cherché sous l’ancien nom', () => {
    const vus = [];
    const espion = (nom) => { vus.push(nom); return true; };
    assert.equal(resolveStateFile('alice', '../../etc/passwd', espion).code, 'state_not_found');
    assert.equal(resolveStateFile('', ID, espion).code, 'state_not_found');
    assert.deepEqual(vus, []);
});

test('état introuvable : la durée de conservation est dite quand la purge est active', () => {
    const fix = resolveStateFile('alice', ID, () => false, { maxAgeDays: 30 }).fix;
    assert.match(fix, /30 jours/);
    assert.match(fix, /save_state en crée un nouveau/);
    assert.doesNotMatch(resolveStateFile('alice', ID, () => false, { maxAgeDays: 0 }).fix, /supprimé/);
});

test('purge : les états sans compte attendent leur rattachement', () => {
    const e = [
        { name: `state_${ID}.json`, mtimeMs: 0 },
        { name: stateFileName('alice', ID), mtimeMs: 0 },
        { name: 'state_alice__neuf-0000-1111.json', mtimeMs: 900 },
    ];
    assert.deepEqual(planArtifactPurge(e, { now: 1000, maxAgeMs: 500, keep: isLegacyStateName }),
                     [stateFileName('alice', ID)]);
});
