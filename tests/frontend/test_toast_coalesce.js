// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_toast_coalesce.js
//  Lancer : node tests/frontend/test_toast_coalesce.js
//
//  Cible : app.js ``showToast`` (extraite : elle vit dans la fermeture de
//  setup). 2026-09-20 : deux toasts identiques (même texte, même type, sans
//  action ni rappel) ne s'empilent plus — le premier est prolongé. Vu avec
//  deux Ctrl+S rapprochés : deux « Sauvegardé ! » superposés.
// ============================================================
'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { extraire } = require('./lib/charger.js');

function monte() {
    const toasts = { value: [] };
    const timers = [];
    const { showToast } = extraire('app.js', ['function showToast'], {
        toasts,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    });
    return { toasts, timers, showToast };
}

t('deux toasts identiques → un seul, prolongé', () => {
    const m = monte();
    const a = m.showToast('Sauvegardé !');
    const b = m.showToast('Sauvegardé !');
    assert.equal(a, b);
    assert.equal(m.toasts.value.length, 1);
    assert.equal(m.timers.filter((x) => x.fn).length, 1, 'un seul minuteur vivant');
});

t('texte ou type différent → deux toasts', () => {
    const m = monte();
    m.showToast('Sauvegardé !'); m.showToast('Sauvegardé !', 'error'); m.showToast('Autre');
    assert.equal(m.toasts.value.length, 3);
});

t('un toast avec action ou rappel n\'est jamais fusionné', () => {
    const m = monte();
    m.showToast('Conversation supprimée', 'success', { actionLabel: 'Annuler', onAction() {} });
    m.showToast('Conversation supprimée', 'success', { actionLabel: 'Annuler', onAction() {} });
    m.showToast('X', 'success', { onExpire() {} });
    m.showToast('X', 'success', { onExpire() {} });
    assert.equal(m.toasts.value.length, 4);
});

t('après expiration, un nouveau toast identique réapparaît', () => {
    const m = monte();
    m.showToast('Sauvegardé !');
    m.timers[0].fn();                       // le minuteur expire
    assert.equal(m.toasts.value.length, 0);
    m.showToast('Sauvegardé !');
    assert.equal(m.toasts.value.length, 1);
});

fin();
