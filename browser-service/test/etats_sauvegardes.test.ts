// SPDX-License-Identifier: MIT
// États sauvegardés (cookies, stockage local) : liés au propriétaire, introuvables pour un autre compte, durée de conservation rappelée.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStateFile, stateFileName } from '../src/session_util.ts';
import type { EtatIntrouvable } from '../src/session_util.ts';

const ID = '0a1b2c3d-1111-2222-3333-444455556666';
const existe = (...noms: (string | null)[]) => (nom: string) => noms.includes(nom);

test('l’état du compte se charge', () => {
    const nom = stateFileName('alice', ID);
    assert.deepEqual(resolveStateFile('alice', ID, existe(nom)), { file: nom });
});

test('l’état d’un autre compte répond comme un état inconnu', () => {
    const r: Partial<EtatIntrouvable & { file: string }> = resolveStateFile('bob', ID, existe(stateFileName('alice', ID)));
    assert.equal(r.file, undefined);
    assert.equal(r.code, 'state_not_found');
    assert.equal(r.error, 'État sauvegardé introuvable (load_state_id).');
    assert.ok(!r.fix!.includes('alice'), r.fix);
});

test('identifiant ou propriétaire invalide : rien n’est cherché', () => {
    const vus: string[] = [];
    const espion = (nom: string) => { vus.push(nom); return true; };
    assert.equal((resolveStateFile('alice', '../../etc/passwd', espion) as EtatIntrouvable).code, 'state_not_found');
    assert.equal((resolveStateFile('', ID, espion) as EtatIntrouvable).code, 'state_not_found');
    assert.deepEqual(vus, []);
});

test('état introuvable : la durée de conservation est dite quand la purge est active', () => {
    const fix = (resolveStateFile('alice', ID, () => false, { maxAgeDays: 30 }) as EtatIntrouvable).fix;
    assert.match(fix, /30 jours/);
    assert.match(fix, /save_state en crée un nouveau/);
    assert.doesNotMatch((resolveStateFile('alice', ID, () => false, { maxAgeDays: 0 }) as EtatIntrouvable).fix, /supprimé/);
});
