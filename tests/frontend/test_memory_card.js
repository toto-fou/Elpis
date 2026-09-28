// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_memory_card.js
//  Lancer : node tests/frontend/test_memory_card.js
//
//  Cibles : frontend/js/chat/_memory_card.js — les lignes « effets »
//  affichées sous un message : écritures en mémoire, liste de tâches.
//
//  POURQUOI CE TEST
//  ================
//  Deux choses valent d'être verrouillées ici.
//
//  1. LA RÈGLE DE VISIBILITÉ (2026-09-19) — une écriture mémoire
//     RÉUSSIE reste affichée, au passé (« Mémorisé »…), et survit au
//     rechargement. L'ancienne règle la faisait disparaître à la fin de
//     l'appel : l'utilisateur ne voyait QUE les échecs (demande user,
//     et pratique de LibreChat / hermes / letta). « Mémoire pleine »
//     est une ligne ambre distincte d'un échec rouge.
//
//  2. LE MIROIR ENTRE DEUX MODULES — la même règle « qu'est-ce qu'une
//     sauvegarde mémoire » existe en DEUX copies :
//        * ``_memory_card.js:50`` ``_isMemorySave``
//        * ``_tool_segments.js:98`` ``_kindFor``
//     Elles doivent reconnaître exactement le même ensemble d'actions
//     (``add|replace|remove|rewrite``). Si elles divergent, un step
//     reconstruit au rechargement d'une conversation est taggé
//     ``_kind: 'memory'`` par l'un mais rejeté par l'autre — la ligne
//     mémoire apparaît en live et disparaît après un F5, ou l'inverse.
//     Le cas MIROIR ci-dessous fait passer une vraie ``tool_history``
//     par ``parseToolHistorySegments`` puis par ``memorySavesFor`` :
//     c'est le chemin réel, pas une comparaison de deux copies.
//
//  Note sur ``_firstLineTruncated`` : la troncature se fait sur une
//  FRONTIÈRE DE MOT (``t.slice(0, n).replace(/\s+\S*$/, '')``). On lit
//  souvent cette expression comme « un mot unique plus long que la
//  limite serait entièrement mangé, ne laissant que ‹ … › ». C'EST
//  FAUX, et deux cas ci-dessous le prouvent : le ``\s+`` exige une
//  espace pour mordre, donc un monobloc de 300 caractères — un chemin,
//  un jeton, une URL — est coupé net à 140 et reste lisible. Le
//  comportement est correct ; c'est la lecture rapide qui ne l'est
//  pas, d'où ces deux cas plutôt qu'un « correctif ».
// ============================================================

'use strict';

const { t, ta, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');

const C = charger(['chat/_tool_segments.js', 'chat/_memory_card.js']);
const M = C.fabrique('setupChatMemoryCard', [null, null, null]);
const segments = C.bac.elpisToolSegments;

/** Lignes mémoire d'un message, recopiées dans le royaume de l'hôte. */
const lignes = (steps) => depuisBac(M.memorySavesFor({ toolSteps: steps }));

/** Un step d'outil mémoire. */
const pas = (args, extra) => Object.assign(
    { name: 'memory', args, status: 'running' }, extra || {});

// ── La règle du transitoire ──────────────────────────────────

t('une écriture mémoire EN COURS est affichée', () => {
    const r = lignes([pas({ action: 'add', content: 'une note' })]);
    assert.equal(r.length, 1);
    assert.equal(r[0].running, true);
    assert.equal(r[0].error, false);
});

t('une écriture mémoire EN ÉCHEC est affichée (en rouge)', () => {
    const r = lignes([pas({ action: 'add', content: 'x' }, { status: 'done', _is_error: true })]);
    assert.equal(r.length, 1);
    assert.equal(r[0].error, true);
    assert.equal(r[0].running, false);
});

t('une écriture mémoire RÉUSSIE ET TERMINÉE RESTE affichée, au passé', () => {
    const r = lignes([pas({ action: 'add', content: 'x' },
        { status: 'done', result: JSON.stringify({ ok: true, action: 'add', op: 'ab12cd34', id: 'a1f4' }) })]);
    assert.equal(r.length, 1);
    assert.equal(r[0].label, 'Mémorisé');
    assert.equal(r[0].op, 'ab12cd34');
    assert.equal(r[0].running, false);
    assert.equal(r[0].error, false);
});

t('succès et échec terminés restent tous deux affichés', () => {
    const steps = [
        pas({ action: 'add', content: 'réussi' }, { status: 'done' }),
        pas({ action: 'add', content: 'raté' }, { status: 'done', _is_error: true }),
    ];
    const r = lignes(steps);
    assert.deepStrictEqual(r.map((l) => [l.title, l.error]), [['réussi', false], ['raté', true]]);
});

t('libellés au passé une fois l\'écriture terminée', () => {
    const attendus = { add: 'Mémorisé', replace: 'Mémoire mise à jour',
                       remove: 'Retiré de la mémoire', rewrite: 'Mémoire réorganisée' };
    for (const [action, libelle] of Object.entries(attendus)) {
        assert.equal(lignes([pas({ action, content: 'x' }, { status: 'done' })])[0].label, libelle);
    }
});

t('MÉMOIRE PLEINE : ligne ambre, pas un échec rouge', () => {
    const res = { ok: false, action: 'add', error: 'over_limit', message: 'exceeds the limit' };
    const r = lignes([pas({ action: 'add', content: 'x' },
        { status: 'done', _is_error: true, result: JSON.stringify(res) })])[0];
    assert.equal(r.full, true);
    assert.equal(r.error, false);
    assert.equal(r.label, 'Mémoire pleine');
});

t('un échec garde son message pour le détail', () => {
    const res = { ok: false, error: 'no_match', message: 'no entry matches', fix: 'Reuse the id' };
    const r = lignes([pas({ action: 'remove', target: 'x' },
        { status: 'done', _is_error: true, result: JSON.stringify(res) })])[0];
    assert.equal(r.error, true);
    assert.equal(r.label, 'Échec — Retrait de la mémoire');
    assert.equal(r.message, 'no entry matches');
});

t('ajout d\'un texte déjà présent : « Déjà en mémoire » (op vide)', () => {
    const res = { ok: true, action: 'add', op: '', id: 'a1f4', note: 'Already stored' };
    const r = lignes([pas({ action: 'add', content: 'x' },
        { status: 'done', result: JSON.stringify(res) })])[0];
    assert.equal(r.unchanged, true);
    assert.equal(r.label, 'Déjà en mémoire');
});

t('un ancien résultat (sans op) reste un succès ordinaire', () => {
    const r = lignes([pas({ action: 'add', content: 'x' },
        { status: 'done', result: JSON.stringify({ ok: true, entries: [] }) })])[0];
    assert.equal(r.unchanged, false);
    assert.equal(r.label, 'Mémorisé');
    assert.equal(r.op, '');
});

// ── Reconnaissance d'une sauvegarde mémoire ──────────────────

t('les quatre actions mutantes sont reconnues', () => {
    for (const action of ['add', 'replace', 'remove', 'rewrite']) {
        assert.equal(lignes([pas({ action, content: 'x' })]).length, 1, 'action ' + action);
    }
});

t('la casse de l\'action est ignorée', () => {
    assert.equal(lignes([pas({ action: 'ADD', content: 'x' })]).length, 1);
    assert.equal(lignes([pas({ action: 'Replace', content: 'x' })]).length, 1);
});

t('une action de LECTURE n\'est pas une sauvegarde', () => {
    for (const action of ['read', 'search', 'list', 'get', '']) {
        assert.deepStrictEqual(lignes([pas({ action, content: 'x' })]), [], 'action ' + action);
    }
});

t('un autre outil n\'est jamais une sauvegarde mémoire', () => {
    assert.deepStrictEqual(lignes([{ name: 'shell', args: { action: 'add' }, status: 'running' }]), []);
});

t('le marqueur _kind prime sur le nom de l\'outil', () => {
    // Un step reconstruit porte _kind ; on lui fait confiance d'abord.
    const r = lignes([{ _kind: 'memory', name: 'autre', args: { action: 'add', content: 'x' }, status: 'running' }]);
    assert.equal(r.length, 1);
});

t('un message sans toolSteps rend une liste vide', () => {
    assert.deepStrictEqual(depuisBac(M.memorySavesFor(null)), []);
    assert.deepStrictEqual(depuisBac(M.memorySavesFor({})), []);
    assert.deepStrictEqual(depuisBac(M.memorySavesFor({ toolSteps: 'pas un tableau' })), []);
});

t('les steps nuls dans la liste ne font pas tomber la dérivation', () => {
    assert.deepStrictEqual(lignes([null, undefined]), []);
});

// ── Libellés ─────────────────────────────────────────────────

t('chaque action a son libellé', () => {
    const attendus = {
        add: 'Écriture en mémoire',
        replace: 'Mise à jour de la mémoire',
        remove: 'Retrait de la mémoire',
        rewrite: 'Réorganisation de la mémoire',
    };
    for (const [action, libelle] of Object.entries(attendus)) {
        assert.equal(lignes([pas({ action, content: 'x' })])[0].label, libelle);
    }
});

t('les deux espaces mémoire ont leur nuance', () => {
    assert.equal(lignes([pas({ action: 'add', content: 'x', store: 'user' })])[0].storeLabel,
        'profil utilisateur');
    assert.equal(lignes([pas({ action: 'add', content: 'x', store: 'memory' })])[0].storeLabel,
        'notes projet');
});

t('l\'espace par défaut est « memory »', () => {
    const r = lignes([pas({ action: 'add', content: 'x' })])[0];
    assert.equal(r.store, 'memory');
    assert.equal(r.storeLabel, 'notes projet');
});

t('un espace inconnu ne produit pas de nuance, mais ne casse rien', () => {
    const r = lignes([pas({ action: 'add', content: 'x', store: 'inconnu' })])[0];
    assert.equal(r.storeLabel, '');
    assert.equal(r.store, 'inconnu');
});

t('AUCUN EMOJI dans les libellés (règle produit)', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const action of ['add', 'replace', 'remove', 'rewrite']) {
        const r = lignes([pas({ action, content: 'x', store: 'user' })])[0];
        assert.ok(!emoji.test(r.label), 'emoji dans ' + r.label);
        assert.ok(!emoji.test(r.storeLabel), 'emoji dans ' + r.storeLabel);
    }
});

// ── Le texte affiché ─────────────────────────────────────────

t('le titre fourni par l\'outil PRIME sur le contenu', () => {
    const r = lignes([pas({ action: 'add', title: 'Titre pensé pour l\'affichage', content: 'contenu brut' })]);
    assert.equal(r[0].title, 'Titre pensé pour l\'affichage');
});

t('un titre vide ou blanc ne prime pas : on retombe sur le contenu', () => {
    assert.equal(lignes([pas({ action: 'add', title: '', content: 'contenu' })])[0].title, 'contenu');
    assert.equal(lignes([pas({ action: 'add', title: '   ', content: 'contenu' })])[0].title, 'contenu');
    assert.equal(lignes([pas({ action: 'add', title: 42, content: 'contenu' })])[0].title, 'contenu');
});

t('pour un remove, c\'est la CIBLE qui est affichée, pas le contenu', () => {
    assert.equal(lignes([pas({ action: 'remove', target: 'la cible', content: 'ignoré' })])[0].title,
        'la cible');
});

t('old_text reste lu comme alias déprécié de target', () => {
    // Les anciens messages persistés portent old_text.
    assert.equal(lignes([pas({ action: 'remove', old_text: 'ancienne clé' })])[0].title, 'ancienne clé');
    assert.equal(lignes([pas({ action: 'replace', old_text: 'ancienne clé' })])[0].title, 'ancienne clé');
});

t('target prime sur old_text quand les deux sont présents', () => {
    assert.equal(lignes([pas({ action: 'remove', target: 'neuf', old_text: 'vieux' })])[0].title, 'neuf');
});

t('pour un replace, le contenu prime sur la cible', () => {
    assert.equal(lignes([pas({ action: 'replace', target: 'avant', content: 'après' })])[0].title, 'après');
});

t('seule la PREMIÈRE ligne du texte est affichée', () => {
    assert.equal(lignes([pas({ action: 'add', content: 'première ligne\nseconde ligne' })])[0].title,
        'première ligne');
});

t('les fins de ligne CRLF sont normalisées avant découpe', () => {
    assert.equal(lignes([pas({ action: 'add', content: 'première\r\nseconde' })])[0].title, 'première');
    assert.equal(lignes([pas({ action: 'add', content: 'première\rseconde' })])[0].title, 'première');
});

t('le texte est détouré des espaces', () => {
    assert.equal(lignes([pas({ action: 'add', content: '   entouré   ' })])[0].title, 'entouré');
});

t('un texte absent donne un titre vide, pas « undefined »', () => {
    assert.equal(lignes([pas({ action: 'add' })])[0].title, '');
    assert.equal(lignes([pas({ action: 'add', content: null })])[0].title, '');
});

t('TRONCATURE à 140, sur une frontière de MOT', () => {
    const mots = ('mot '.repeat(60)).trim();     // bien au-delà de 140
    const titre = lignes([pas({ action: 'add', content: mots })])[0].title;
    assert.ok(titre.length <= 141, 'longueur ' + titre.length);
    assert.ok(titre.endsWith('…'));
    assert.ok(!titre.includes('mo…'), 'la coupe ne doit pas tomber au milieu d\'un mot');
    assert.ok(titre.startsWith('mot mot'));
});

t('un texte de 140 caractères exactement n\'est PAS tronqué', () => {
    const exact = 'a'.repeat(140);
    assert.equal(lignes([pas({ action: 'add', content: exact })])[0].title, exact);
});

t('un mot unique trop long est coupé NET, il ne disparaît pas', () => {
    // `.replace(/\s+\S*$/, '')` exige une espace pour mordre. Sur un
    // monobloc sans espace, il ne retire RIEN et la coupe se fait
    // simplement à 140. Une chaîne de 300 caractères sans espace — un
    // chemin, un jeton, une URL — reste donc lisible sur 140 caractères
    // au lieu d'être réduite à « … ».
    const monobloc = 'a'.repeat(300);
    const titre = lignes([pas({ action: 'add', content: monobloc })])[0].title;
    assert.equal(titre, 'a'.repeat(140) + '…');
});

t('la coupe sur frontière de mot ne s\'applique qu\'au DERNIER mot partiel', () => {
    // 138 caractères, une espace, puis un mot long : le mot coupé part,
    // le reste est conservé.
    const texte = 'x'.repeat(138) + ' motquidepasse';
    const titre = lignes([pas({ action: 'add', content: texte })])[0].title;
    assert.equal(titre, 'x'.repeat(138) + '…');
});

// ── toolStepsForDisplay ──────────────────────────────────────

t('toolStepsForDisplay retire les sauvegardes mémoire (rendues à part)', () => {
    const steps = [
        { name: 'shell', args: {}, status: 'done' },
        pas({ action: 'add', content: 'x' }),
    ];
    const r = depuisBac(M.toolStepsForDisplay(steps));
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'shell');
});

t('toolStepsForDisplay retire aussi les sous-agents task (carte dédiée)', () => {
    const steps = [
        { name: 'task', args: {}, status: 'done' },
        { _kind: 'task', name: 'autre', args: {}, status: 'done' },
        { name: 'shell', args: {}, status: 'done' },
    ];
    const r = depuisBac(M.toolStepsForDisplay(steps));
    assert.deepStrictEqual(r.map((s) => s.name), ['shell']);
});

t('toolStepsForDisplay CONSERVE les steps de compression', () => {
    const steps = [{ name: 'compress', args: {}, status: 'done' }];
    assert.equal(depuisBac(M.toolStepsForDisplay(steps)).length, 1);
});

t('toolStepsForDisplay retire une sauvegarde mémoire même RÉUSSIE', () => {
    // Elle est rendue en ligne d'effet : elle ne doit pas réapparaître
    // aussi dans le panneau générique d'outils.
    const steps = [pas({ action: 'add', content: 'x' }, { status: 'done' })];
    assert.deepStrictEqual(depuisBac(M.toolStepsForDisplay(steps)), []);
});

t('toolStepsForDisplay rend [] pour une entrée non tableau', () => {
    assert.deepStrictEqual(depuisBac(M.toolStepsForDisplay(null)), []);
    assert.deepStrictEqual(depuisBac(M.toolStepsForDisplay('x')), []);
});

// ── MIROIR entre _kindFor et _isMemorySave ───────────────────

/** Une tool_history réaliste appelant `memory` avec l'action donnée. */
function historiqueMemoire(action) {
    return [
        { role: 'assistant', tool_calls: [{
            id: 'c1',
            function: { name: 'memory', arguments: JSON.stringify({ action, content: 'une note' }) },
        }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ];
}

t('MIROIR : les actions reconnues par _kindFor le sont par _isMemorySave', () => {
    for (const action of ['add', 'replace', 'remove', 'rewrite']) {
        const segs = depuisBac(segments.parseToolHistorySegments(historiqueMemoire(action), {}));
        const step = segs.toolSteps[0];
        assert.equal(step._kind, 'memory',
            '_kindFor ne reconnaît pas « ' + action +' »');
        // Le step reconstruit est done+succès → memorySavesFor l'AFFICHE
        // (règle 2026-09-19) et toolStepsForDisplay l'a retiré : preuve
        // que _isMemorySave l'a bien reconnu lui aussi.
        assert.deepStrictEqual(depuisBac(M.toolStepsForDisplay([step])), [],
            '_isMemorySave ne reconnaît pas le step taggé « ' + action + ' »');
        assert.equal(lignes([step]).length, 1, 'succès rechargé invisible pour « ' + action + ' »');
    }
});

t('MIROIR : une action NON mutante n\'est taggée par aucun des deux', () => {
    for (const action of ['read', 'search', 'list']) {
        const segs = depuisBac(segments.parseToolHistorySegments(historiqueMemoire(action), {}));
        const step = segs.toolSteps[0];
        assert.equal(step._kind, undefined, '_kindFor tagge à tort « ' + action + ' »');
        assert.equal(depuisBac(M.toolStepsForDisplay([step])).length, 1,
            '_isMemorySave retire à tort « ' + action + ' »');
    }
});

t('MIROIR : un step mémoire EN ÉCHEC reconstruit s\'affiche bien', () => {
    const histo = [
        { role: 'assistant', tool_calls: [{
            id: 'c1',
            function: { name: 'memory', arguments: JSON.stringify({ action: 'add', content: 'note ratée' }) },
        }] },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ error: 'disque plein' }) },
    ];
    const segs = depuisBac(segments.parseToolHistorySegments(histo, {}));
    const r = lignes(segs.toolSteps);
    assert.equal(r.length, 1, 'un échec mémoire rechargé doit rester visible');
    assert.equal(r[0].error, true);
    assert.equal(r[0].action, 'add');
});

// ── Liste de tâches : RIEN dans le fil (chip de la barre de prompt) ──

const tache = (res, extra) => Object.assign({ name: 'todowrite', args: { todos: [] },
    status: 'done', result: res == null ? null : JSON.stringify(res) }, extra || {});
const effets = (steps) => depuisBac(M.effectLinesFor({ toolSteps: steps }));

t('todowrite : aucune ligne dans le fil (terminé, en cours, refusé)', () => {
    assert.deepStrictEqual(effets([
        tache({ done: 1, total: 3, in_progress: 'B', completed_now: ['A'] }),
        tache(null, { status: 'running', args: {} }),
        tache({ ok: false, error: 'validation' }, { _is_error: true }),
    ]), []);
});

t('effets : seules les écritures mémoire restent, dans l\'ordre des appels', () => {
    const r = effets([
        pas({ action: 'add', content: 'note' }, { status: 'done' }),
        tache({ done: 1, total: 1, in_progress: '', completed_now: ['A'] }),
        pas({ action: 'remove', target: 'x' }, { status: 'done' }),
    ]);
    assert.deepStrictEqual(r.map((l) => [l.kind, l.action]), [['memory', 'add'], ['memory', 'remove']]);
});

t('toolStepsForDisplay retire todowrite (chip de la barre de prompt)', () => {
    const steps = [tache({ done: 0, total: 1 }), { _kind: 'todo', name: 'x' }, { name: 'shell' }];
    assert.deepStrictEqual(depuisBac(M.toolStepsForDisplay(steps)).map((s) => s.name), ['shell']);
});

t('MIROIR : todowrite reconstruit est taggé « todo », absent du fil', () => {
    const histo = [
        { role: 'assistant', tool_calls: [{ id: 'c1',
            function: { name: 'todowrite', arguments: JSON.stringify({ todos: [{ content: 'A', status: 'pending' }] }) } }] },
        { role: 'tool', tool_call_id: 'c1',
          content: JSON.stringify({ ok: true, done: 0, total: 1, in_progress: '', completed_now: [] }) },
    ];
    const step = depuisBac(segments.parseToolHistorySegments(histo, {})).toolSteps[0];
    assert.equal(step._kind, 'todo');
    assert.deepStrictEqual(effets([step]), []);
    assert.deepStrictEqual(depuisBac(M.toolStepsForDisplay([step])), []);
});

// ── Constats de la relecture du 2026-09-19 ───────────────────

t('CLÉS : deux messages au même call_id ne partagent pas leur état', () => {
    // call_{itération}_{rang} se répète d'un tour à l'autre.
    const step = () => pas({ action: 'add', content: 'x' }, { status: 'done', callId: 'call_0_0', _is_error: true });
    const a = depuisBac(M.effectLinesFor({ toolSteps: [step()] }, 1))[0];
    const b = depuisBac(M.effectLinesFor({ toolSteps: [step()] }, 3))[0];
    assert.notEqual(a.key, b.key);
});

t('CLÉS : une écriture journalisée est indexée par son op (unique)', () => {
    const l = lignes([pas({ action: 'add', content: 'x' },
        { status: 'done', callId: 'call_0_0', result: JSON.stringify({ ok: true, op: 'ab12cd34' }) })])[0];
    assert.equal(l.key, 'mem:ab12cd34');
});

// ── Détail et annulation (fetch simulé) ──────────────────────

(async () => {

await ta('déplier une ligne charge le détail par op, une seule fois', async () => {
    const appels = [];
    const fauxCtx = { fetchAuth: async (u, o) => { appels.push([u, (o && o.method) || 'GET']);
        return { ok: true, json: async () => ({ op: 'ab12cd34', added: ['note'], removed: [], can_undo: true }) }; } };
    const MM = C.fabrique('setupChatMemoryCard', [null, null, fauxCtx]);
    const ligne = MM.effectLinesFor({ toolSteps: [pas({ action: 'add', content: 'note' },
        { status: 'done', result: JSON.stringify({ ok: true, op: 'ab12cd34' }) })] })[0];
    MM.toggleEffect(ligne);
    assert.equal(MM.effectIsOpen(ligne), true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(MM.effectDetail(ligne).state, 'ok');
    assert.deepStrictEqual(depuisBac(MM.effectDetail(ligne).data.added), ['note']);
    MM.toggleEffect(ligne); MM.toggleEffect(ligne);
    assert.equal(appels.length, 1, 'détail rechargé inutilement');
    assert.ok(MM.effectUiRev.value > 0, 'v-memo non invalidé');
});

await ta('annuler : succès → détail marqué annulé ; refus → message', async () => {
    let refuser = false;
    const fauxCtx = { fetchAuth: async (u, o) => {
        if (o && o.method === 'POST') {
            return refuser
                ? { ok: false, json: async () => ({ detail: 'la mémoire a changé depuis cette écriture' }) }
                : { ok: true, json: async () => ({ ok: true, op: { op: 'ab12cd34', undone: true, can_undo: false, added: [], removed: [] } }) };
        }
        return { ok: true, json: async () => ({ op: 'ab12cd34', added: ['n'], removed: [], can_undo: true }) };
    } };
    const MM = C.fabrique('setupChatMemoryCard', [null, null, fauxCtx]);
    const ligne = MM.effectLinesFor({ toolSteps: [pas({ action: 'add', content: 'n' },
        { status: 'done', result: JSON.stringify({ ok: true, op: 'ab12cd34' }) })] })[0];
    await MM.undoMemoryEffect(ligne);
    assert.equal(MM.effectDetail(ligne).data.undone, true);
    refuser = true;
    await MM.undoMemoryEffect(ligne);
    assert.equal(MM.effectDetail(ligne).error, 'La mémoire a changé depuis cette écriture');
});

await ta('détail en ÉCHEC : retenté à la réouverture', async () => {
    let n = 0;
    const fauxCtx = { fetchAuth: async () => { n++;
        return n === 1 ? null : { ok: true, json: async () => ({ op: 'ab12cd34', added: ['n'], removed: [], can_undo: true }) }; } };
    const MM = C.fabrique('setupChatMemoryCard', [null, null, fauxCtx]);
    const ligne = MM.effectLinesFor({ toolSteps: [pas({ action: 'add', content: 'n' },
        { status: 'done', result: JSON.stringify({ ok: true, op: 'ab12cd34' }) })] })[0];
    MM.toggleEffect(ligne);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(MM.effectDetail(ligne).state, 'error');
    MM.toggleEffect(ligne); MM.toggleEffect(ligne);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(MM.effectDetail(ligne).state, 'ok');
});

await ta('annulation refusée PASSAGÈREMENT : le bouton reste', async () => {
    const fauxCtx = { fetchAuth: async (u, o) => (o && o.method === 'POST')
        ? { ok: false, json: async () => ({ detail: 'écriture mémoire en cours, réessayez' }) }
        : { ok: true, json: async () => ({ op: 'ab12cd34', added: ['n'], removed: [], can_undo: true }) } };
    const MM = C.fabrique('setupChatMemoryCard', [null, null, fauxCtx]);
    const ligne = MM.effectLinesFor({ toolSteps: [pas({ action: 'add', content: 'n' },
        { status: 'done', result: JSON.stringify({ ok: true, op: 'ab12cd34' }) })] })[0];
    await MM.undoMemoryEffect(ligne);
    const d = MM.effectDetail(ligne);
    assert.equal(d.data.can_undo, true, 'le serveur dit encore annulable');
    assert.ok(/réessayez/.test(d.error));
});

fin();

})();
