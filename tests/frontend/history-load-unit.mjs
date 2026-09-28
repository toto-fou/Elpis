// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/history-load-unit.mjs
//  Lancer : node tests/frontend/history-load-unit.mjs
//
//  Cible : frontend/js/chat/_history.js:237 ``loadChat`` — la
//  reconstruction d'une conversation persistée.
//
//  POURQUOI CE TEST, ET POURQUOI PAR LA PORTE D'ENTRÉE
//  ==================================================
//  La reconstruction de message est écrite EN LIGNE dans ``loadChat``
//  (``:315-430``), pas dans une fonction nommée. La tentation était de
//  l'extraire en ``buildMessagesFromPayload`` pour la tester seule.
//  On ne l'a pas fait : piloter ``loadChat`` de bout en bout donne
//  exactement les mêmes assertions ET couvre le CÂBLAGE — la garde de
//  concurrence ``_seq``, l'ordre ``_vsInitTail`` avant l'assignation —
//  qu'une fonction extraite ne verrait pas. Une extraction aurait
//  réduit la couverture en donnant l'impression de l'augmenter.
//
//  Les invariants verrouillés ici, et ce qu'ils coûtent s'ils cassent :
//
//   * AUCUN message ``system`` n'atteint le front (``:289``). L'état
//     de compression est persisté comme un ``system`` en tête de
//     ``messages_json`` : usage serveur uniquement. S'il passe, une
//     bulle de résumé interne s'affiche dans la conversation.
//
//   * UN SEUL message porte un ``thinking`` : le dernier assistant
//     (``:336``). Sinon on ré-affiche le raisonnement de toute la
//     conversation à chaque rechargement.
//
//   * Un message vide + ``thinking`` + ``thinkingTruncated`` SURVIT
//     (``:401-405``). C'est le cas « tour coupé en plein
//     raisonnement » : sans lui, « Continuer » repart de zéro et
//     reboucle indéfiniment.
//
//   * ``tool_history`` est CUMULATIVE entre tours : le préfixe déjà
//     affiché doit être sauté, d'où le chaînage ``_prevTH``
//     (``:314, :381-393``). Sans lui, chaque message ré-affiche les
//     rounds de tous les tours précédents.
//
//   * Les messages sont GELÉS (``:429``) — c'est ce qui évite 500
//     proxies réactifs sur une conversation de 500 messages (~40 % de
//     CPU au chargement, empreinte ÷3). Un dégel silencieux ne casse
//     rien de visible : il coûte, et personne ne le remarque.
//
//   * Seul le DERNIER ``loadChat`` demandé a le droit d'écrire
//     (``:252``). Deux clics rapides et la réponse lente de la
//     première conversation écraserait la seconde.
// ============================================================

import { t, ta, fin, assert } from './lib/harnais.js';
import { charger, depuisBac } from './lib/charger.js';
import { vueMini, refsDeclares, ctxMuet, depsMuets, reponseJson } from './lib/stubs.js';

// _tool_segments.js est chargé AVANT _history.js : la reconstruction
// entrelacée lit ``window.elpisToolSegments``. C'est l'ordre d'index.html.
const C = charger(['chat/_tool_segments.js', 'chat/_history.js']);

/**
 * Monte le module avec un payload de conversation donné, et rend les
 * poignées d'inspection.
 */
function monter(payload, options) {
    const o = options || {};
    const vue = vueMini();
    const refs = refsDeclares({
        messages: [],
        currentChatId: o.chatCourant !== undefined ? o.chatCourant : null,
        currentChatTitle: '',
        currentView: 'accueil',
        isStreaming: false,
        isThinking: false,
        statusText: '',
        isUserScrolling: false,
        chats: [],
        inputRef: null,
        attachedFiles: [],
        user: { id: 1 },
    });

    const journalFetch = [];
    const ctx = ctxMuet({
        showSidebar: { value: true },
        fetchAuth: async (url) => {
            journalFetch.push(url);
            if (o.fetchAuth) return o.fetchAuth(url);
            return reponseJson(payload);
        },
    });

    const deps = depsMuets({
        // Sans ça, `parsed.files` jetterait sur un message user.
        _parseFileBlocks: (contenu) => ({ files: undefined, displayContent: contenu }),
        ...(o.deps || {}),
    });

    const api = C.fabrique('setupChatHistory', [vue, refs, ctx, deps]);
    return { api, refs, ctx, deps, vue, journalFetch };
}

/** Les messages reconstruits, recopiés dans le royaume de l'hôte. */
const lus = (refs) => depuisBac(refs.messages.value);

/** Payload minimal d'une conversation. */
const conv = (messages, extra) => Object.assign(
    { id: 'chat-1', title: 'Essai', messages }, extra || {});

// ── Le filtre system ─────────────────────────────────────────

await ta('AUCUN message system n\'atteint le front', async () => {
    const { api, refs } = monter(conv([
        { role: 'system', content: 'résumé de compression interne' },
        { role: 'user', content: 'bonjour' },
        { role: 'system', content: 'autre état serveur' },
        { role: 'assistant', content: 'salut' },
        { role: 'system', content: 'encore' },
    ]));
    await api.loadChat('chat-1');
    const m = lus(refs);
    assert.equal(m.length, 2, 'trois system devaient disparaître');
    assert.deepStrictEqual(m.map((x) => x.role), ['user', 'assistant']);
});

await ta('une conversation entièrement system donne une liste vide, pas une erreur', async () => {
    const { api, refs } = monter(conv([{ role: 'system', content: 'x' }]));
    await api.loadChat('chat-1');
    assert.deepStrictEqual(lus(refs), []);
});

await ta('un payload sans tableau messages ne fait pas tomber le chargement', async () => {
    const { api, refs } = monter({ id: 'chat-1', title: 'Neuf' });
    await api.loadChat('chat-1');
    assert.deepStrictEqual(lus(refs), []);
    assert.equal(refs.currentChatId.value, 'chat-1');
});

await ta('les entrées nulles du tableau sont écartées', async () => {
    const { api, refs } = monter(conv([null, { role: 'user', content: 'a' }, undefined]));
    await api.loadChat('chat-1');
    assert.equal(lus(refs).length, 1);
});

// ── Le thinking du seul dernier assistant ────────────────────

await ta('UN SEUL message porte un thinking : le dernier assistant', async () => {
    const { api, refs } = monter(conv([
        { role: 'assistant', content: 'a1', thinking: 'vieille réflexion' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a2', thinking: 'réflexion récente' },
    ]));
    await api.loadChat('chat-1');
    const m = lus(refs);
    assert.equal(m[0].thinking, '', 'le thinking d\'un assistant ancien doit être vidé');
    assert.equal(m[2].thinking, 'réflexion récente');
});

await ta('« dernier assistant » ne veut pas dire « dernier message »', async () => {
    const { api, refs } = monter(conv([
        { role: 'assistant', content: 'a1', thinking: 'gardée' },
        { role: 'user', content: 'question posée après' },
    ]));
    await api.loadChat('chat-1');
    assert.equal(lus(refs)[0].thinking, 'gardée');
});

await ta('un assistant sans thinking rend une chaîne vide, pas undefined', async () => {
    const { api, refs } = monter(conv([{ role: 'assistant', content: 'a' }]));
    await api.loadChat('chat-1');
    assert.strictEqual(lus(refs)[0].thinking, '');
});

// ── Tour coupé en plein raisonnement ─────────────────────────

await ta('un message VIDE avec thinking tronqué SURVIT (sinon « Continuer » reboucle)', async () => {
    const { api, refs } = monter(conv([
        { role: 'user', content: 'fais le travail' },
        { role: 'assistant', content: '', thinkingTruncated: true, resume_thinking: 'j\'en étais là' },
    ]));
    await api.loadChat('chat-1');
    const m = lus(refs);
    assert.equal(m.length, 2, 'le message vide ne doit pas disparaître');
    assert.equal(m[1].thinking, 'j\'en étais là', 'le raisonnement doit être réhydraté');
    assert.equal(m[1].resume_thinking, 'j\'en étais là');
    assert.equal(m[1].thinkingTruncated, true);
});

await ta('resume_thinking ne remplace PAS un thinking déjà présent', async () => {
    const { api, refs } = monter(conv([
        { role: 'assistant', content: 'x', thinking: 'le vrai', thinkingTruncated: true, resume_thinking: 'le repli' },
    ]));
    await api.loadChat('chat-1');
    assert.equal(lus(refs)[0].thinking, 'le vrai');
});

await ta('thinkingTruncated sans resume_thinking ne pose pas le marqueur', async () => {
    const { api, refs } = monter(conv([
        { role: 'assistant', content: 'x', thinkingTruncated: true },
    ]));
    await api.loadChat('chat-1');
    assert.equal(lus(refs)[0].thinkingTruncated, undefined);
});

// ── Contenu multimodal ───────────────────────────────────────

await ta('un content multimodal redevient content (texte) + images', async () => {
    const { api, refs } = monter(conv([{
        role: 'user',
        content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'text', text: 'regarde ça' },
        ],
    }]));
    await api.loadChat('chat-1');
    const m = lus(refs)[0];
    assert.equal(m.content, 'regarde ça', 'sans ça, le rendu affiche « [object Object] »');
    assert.deepStrictEqual(m.images, [{ dataUrl: 'data:image/png;base64,AAA' }]);
});

await ta('plusieurs images sont toutes réhydratées, dans l\'ordre', async () => {
    const { api, refs } = monter(conv([{
        role: 'user',
        content: [
            { type: 'image_url', image_url: { url: 'u1' } },
            { type: 'image_url', image_url: { url: 'u2' } },
            { type: 'text', text: 'deux' },
        ],
    }]));
    await api.loadChat('chat-1');
    assert.deepStrictEqual(lus(refs)[0].images, [{ dataUrl: 'u1' }, { dataUrl: 'u2' }]);
});

await ta('un multimodal SANS partie texte donne un content vide, pas undefined', async () => {
    const { api, refs } = monter(conv([{
        role: 'user', content: [{ type: 'image_url', image_url: { url: 'u1' } }],
    }]));
    await api.loadChat('chat-1');
    assert.strictEqual(lus(refs)[0].content, '');
});

await ta('un m.images déjà présent n\'est pas écrasé par la reconstruction', async () => {
    const { api, refs } = monter(conv([{
        role: 'user',
        images: [{ dataUrl: 'deja-la' }],
        content: [{ type: 'image_url', image_url: { url: 'ignore' } }, { type: 'text', text: 't' }],
    }]));
    await api.loadChat('chat-1');
    assert.deepStrictEqual(lus(refs)[0].images, [{ dataUrl: 'deja-la' }]);
});

await ta('les parties image malformées sont ignorées sans casser', async () => {
    const { api, refs } = monter(conv([{
        role: 'user',
        content: [
            { type: 'image_url' },
            { type: 'image_url', image_url: {} },
            { type: 'image_url', image_url: { url: 'bonne' } },
            { type: 'text', text: 't' },
        ],
    }]));
    await api.loadChat('chat-1');
    assert.deepStrictEqual(lus(refs)[0].images, [{ dataUrl: 'bonne' }]);
});

// ── tool_history : delta, chaînage, marqueurs ────────────────

await ta('tool_history et son marqueur delta sont réhydratés (survie au round-trip)', async () => {
    const th = [{ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'c1', content: 'ok' }];
    const { api, refs } = monter(conv([
        { role: 'assistant', content: 'fini', tool_history: th, tool_history_delta: true },
    ]));
    await api.loadChat('chat-1');
    const m = lus(refs)[0];
    assert.equal(m.tool_history_delta, true);
    assert.equal(m.tool_history.length, 2);
});

await ta('CHAÎNAGE : le second tour n\'affiche pas les outils du premier', async () => {
    // tool_history est CUMULATIVE : sans le threading de _prevTH, le
    // second message ré-afficherait les étapes du premier.
    const tour1 = [
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
    ];
    const tour2 = tour1.concat([
        { role: 'assistant', tool_calls: [{ id: 'c2', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }] },
        { role: 'tool', tool_call_id: 'c2', content: '/work' },
    ]);
    const { api, refs } = monter(conv([
        { role: 'assistant', content: 'un', tool_history: tour1 },
        { role: 'user', content: 'encore' },
        { role: 'assistant', content: 'deux', tour: 2, tool_history: tour2 },
    ]));
    await api.loadChat('chat-1');
    const m = lus(refs);
    assert.equal(m[0].toolSteps.length, 1, 'le premier tour a une étape');
    assert.equal(m[2].toolSteps.length, 1,
        'le second tour ne doit afficher QUE sa propre étape, pas celle du premier');
});

await ta('une tool_history vide ne pose pas de toolSteps', async () => {
    const { api, refs } = monter(conv([
        { role: 'assistant', content: 'x', tool_history: [] },
    ]));
    await api.loadChat('chat-1');
    assert.equal(lus(refs)[0].toolSteps, undefined);
});

await ta('les marqueurs de troncature d\'outils sont réhydratés', async () => {
    const { api, refs } = monter(conv([{
        role: 'assistant', content: 'x',
        isTruncated: true, toolLoopTruncated: true, toolLoopStats: { rounds: 12 },
        errorMessage: 'plafond atteint',
    }]));
    await api.loadChat('chat-1');
    const m = lus(refs)[0];
    assert.equal(m.isTruncated, true);
    assert.equal(m.toolLoopTruncated, true);
    assert.deepStrictEqual(m.toolLoopStats, { rounds: 12 });
    assert.equal(m.errorMessage, 'plafond atteint',
        'sans errorMessage, l\'encart affiche « Erreur inconnue »');
});

// ── taskRuns : normalisation des tokens ──────────────────────

await ta('taskRuns : context_tokens gagne quand il est positif', async () => {
    const { api, refs } = monter(conv([{
        role: 'assistant', content: 'x',
        task_runs: [{ agent: 'explore', context_tokens: 5000, input_tokens: 100, output_tokens: 50 }],
    }]));
    await api.loadChat('chat-1');
    assert.equal(lus(refs)[0].taskRuns[0].tokens, 5000);
});

await ta('taskRuns : repli sur in+out pour les anciens enregistrements', async () => {
    const { api, refs } = monter(conv([{
        role: 'assistant', content: 'x',
        task_runs: [
            { agent: 'a', input_tokens: 100, output_tokens: 50 },
            { agent: 'b', context_tokens: 0, input_tokens: 7, output_tokens: 3 },
            { agent: 'c' },
        ],
    }]));
    await api.loadChat('chat-1');
    const runs = lus(refs)[0].taskRuns;
    assert.equal(runs[0].tokens, 150);
    assert.equal(runs[1].tokens, 10, 'context_tokens à 0 doit basculer sur le repli');
    assert.equal(runs[2].tokens, 0);
});

await ta('taskRuns conserve les champs d\'origine en plus de tokens', async () => {
    const { api, refs } = monter(conv([{
        role: 'assistant', content: 'x',
        task_runs: [{ agent: 'explore', result: 'ok', context_tokens: 42 }],
    }]));
    await api.loadChat('chat-1');
    const r = lus(refs)[0].taskRuns[0];
    assert.equal(r.agent, 'explore');
    assert.equal(r.result, 'ok');
    assert.equal(r.tokens, 42);
});

// ── Notices de compaction ────────────────────────────────────

await ta('une notice réhydrate kind, ts, tokens_after et summary', async () => {
    const { api, refs } = monter(conv([{
        role: 'notice', content: '', kind: 'compaction',
        ts: 1700000000, tokens_after: 4096, summary: 'résumé du compact',
    }]));
    await api.loadChat('chat-1');
    const m = lus(refs)[0];
    assert.equal(m.kind, 'compaction');
    assert.equal(m.ts, 1700000000);
    assert.equal(m.tokens_after, 4096);
    assert.equal(m.summary, 'résumé du compact');
});

await ta('une notice sans kind retombe sur « compaction »', async () => {
    const { api, refs } = monter(conv([{ role: 'notice', content: '' }]));
    await api.loadChat('chat-1');
    assert.equal(lus(refs)[0].kind, 'compaction');
});

// ── Gel ──────────────────────────────────────────────────────

await ta('TOUS les messages chargés sont gelés, y compris le dernier', async () => {
    const { api, refs } = monter(conv([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
    ]));
    await api.loadChat('chat-1');
    for (const m of refs.messages.value) {
        assert.ok(Object.isFrozen(m), 'un message chargé doit être gelé');
    }
});

// ── Concurrence : seul le dernier clic écrit ─────────────────

await ta('GARDE _seq : une réponse LENTE arrivée après un autre clic est JETÉE', async () => {
    let libere;
    const attente = new Promise((r) => { libere = r; });
    let nb = 0;
    const { api, refs } = monter(null, {
        fetchAuth: async (url) => {
            nb += 1;
            if (nb === 1) { await attente; return reponseJson(conv([{ role: 'user', content: 'LENT' }], { id: 'lent' })); }
            return reponseJson(conv([{ role: 'user', content: 'RAPIDE' }], { id: 'rapide' }));
        },
    });

    const premier = api.loadChat('lent');     // part, reste suspendu
    await api.loadChat('rapide');             // passe devant et écrit
    libere();
    await premier;                            // se réveille : doit renoncer

    assert.equal(refs.currentChatId.value, 'rapide');
    assert.equal(lus(refs)[0].content, 'RAPIDE',
        'la réponse lente de la première conversation a écrasé la seconde');
});

await ta('recharger la conversation COURANTE est un no-op sans force', async () => {
    const { api, journalFetch } = monter(conv([{ role: 'user', content: 'a' }]), { chatCourant: 'chat-1' });
    await api.loadChat('chat-1');
    assert.equal(journalFetch.length, 0, 'aucun aller-retour ne doit partir');
});

await ta('opts.force RELIT la conversation courante', async () => {
    // À la fin d'un run détaché, c'est justement la conversation AFFICHÉE
    // qu'il faut rafraîchir : sans cette échappatoire, l'utilisateur reste
    // devant son tour interrompu alors que le résultat est en base.
    // On vise l'URL de la conversation, pas le nombre d'appels : le
    // chargement sonde aussi /generation-status pour se rattacher à un run
    // en cours, et compter les appels ferait rougir ce cas pour rien.
    const { api, journalFetch } = monter(conv([{ role: 'user', content: 'a' }]), { chatCourant: 'chat-1' });
    await api.loadChat('chat-1', { force: true });
    assert.ok(journalFetch.includes('/api/saved/chats/chat-1'),
        'URLs appelées : ' + journalFetch.join(', '));
});

await ta('un chargement se rattache au run en cours de la conversation', async () => {
    // Quitter une conversation qui génère arrête la LECTURE, pas le run ;
    // y revenir doit s'y rattacher, sinon le résultat n'arrive jamais à
    // l'écran bien qu'il soit produit côté serveur.
    const { api, journalFetch } = monter(conv([{ role: 'user', content: 'a' }]));
    await api.loadChat('chat-1');
    assert.ok(journalFetch.some((u) => u.includes('generation-status')),
        'URLs appelées : ' + journalFetch.join(', '));
});

// ── Ordre du câblage ─────────────────────────────────────────

await ta('_vsInitTail est appelé AVANT l\'assignation des messages', async () => {
    // Sinon le premier calcul de visibleMessages rend une liste vide,
    // remplie seulement au nextTick — l'écran clignote.
    let tailleAuMomentDeInit = null;
    const { api } = monter(conv([
        { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    ]), {
        deps: {
            _parseFileBlocks: (c) => ({ files: undefined, displayContent: c }),
            _vsInitTail: (n) => { tailleAuMomentDeInit = n; },
        },
    });
    await api.loadChat('chat-1');
    assert.equal(tailleAuMomentDeInit, 2, '_vsInitTail doit recevoir la taille reconstruite');
});

await ta('le flux en cours est détaché AVANT de charger une autre conversation', async () => {
    let detache = false;
    const { api } = monter(conv([{ role: 'user', content: 'a' }]), {
        deps: {
            _parseFileBlocks: (c) => ({ files: undefined, displayContent: c }),
            detachFromStream: () => { detache = true; },
        },
    });
    await api.loadChat('chat-1');
    assert.equal(detache, true);
});

await ta('les blobs de captures web sont révoqués avant de remplacer les messages', async () => {
    let revoque = false;
    const { api } = monter(conv([{ role: 'user', content: 'a' }]), {
        deps: {
            _parseFileBlocks: (c) => ({ files: undefined, displayContent: c }),
            _revokeAllWebShotBlobs: () => { revoque = true; },
        },
    });
    await api.loadChat('chat-1');
    assert.equal(revoque, true);
});

await ta('titre et vue sont posés depuis le payload', async () => {
    const { api, refs } = monter(conv([], { title: 'Ma conversation' }));
    await api.loadChat('chat-1');
    assert.equal(refs.currentChatTitle.value, 'Ma conversation');
    assert.equal(refs.currentView.value, 'chat');
});

await ta('une réponse en échec ne détruit pas les messages déjà affichés', async () => {
    const { api, refs } = monter(null, {
        fetchAuth: async () => reponseJson({}, { ok: false, status: 500 }),
    });
    refs.messages.value = [Object.freeze({ role: 'user', content: 'déjà là' })];
    await api.loadChat('autre');
    assert.equal(lus(refs)[0].content, 'déjà là');
});

// ── Panneau todo ─────────────────────────────────────────────

await ta('une liste de todos entièrement soldée ne réapparaît pas', async () => {
    let recu = 'jamais appelé';
    const deps = {
        _parseFileBlocks: (c) => ({ files: undefined, displayContent: c }),
        setTodoList: (l) => { recu = depuisBac(l); },
    };
    const { api } = monter(conv([], { todos: [{ status: 'completed' }, { status: 'cancelled' }] }), { deps });
    await api.loadChat('chat-1');
    assert.deepStrictEqual(recu, []);
});

await ta('une liste de todos avec du travail ouvert est re-semée', async () => {
    let recu = null;
    const deps = {
        _parseFileBlocks: (c) => ({ files: undefined, displayContent: c }),
        setTodoList: (l) => { recu = depuisBac(l); },
    };
    const todos = [{ status: 'completed' }, { status: 'pending' }];
    const { api } = monter(conv([], { todos }), { deps });
    await api.loadChat('chat-1');
    assert.deepStrictEqual(recu, todos);
});

fin();
