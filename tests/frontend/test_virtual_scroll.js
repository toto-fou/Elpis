// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_virtual_scroll.js
//  Lancer : node tests/frontend/test_virtual_scroll.js
//
//  Cible : frontend/js/chat/_virtual_scroll.js — le rendu fenêtré des
//  longues conversations.
//
//  POURQUOI CE TEST
//  ================
//  Ce module décide QUELS messages existent dans le DOM. Quand son
//  arithmétique dérape, le symptôme n'est pas une erreur : c'est un
//  ÉCRAN BLANC, ou un historique devenu inatteignable au scroll. Rien
//  dans la console, rien dans les journaux.
//
//  Le bug historique est documenté dans le source (``:107-112``) :
//  quand ``scrollTop`` dépasse la hauteur totale — suppression de
//  messages, redimensionnement, changement de conversation — la boucle
//  de recherche sort avec ``first === total`` et la fenêtre devient
//  vide. Le source présente le clamp qui suit comme « la » protection.
//
//  CONSTAT FAIT EN ÉCRIVANT CE TEST — ce clamp est aujourd'hui du CODE
//  MORT, et il vaut mieux le savoir que de croire qu'on le teste. Le
//  retirer ne change AUCUN résultat (vérifié par mutation le
//  2026-09-17). La raison : même avec ``first === total``, la fenêtre
//  est bornée par ``start = Math.max(0, first - VS_BUFFER)``, donc
//  ``total - 10`` — jamais vide, puisque le fenêtrage ne s'active qu'à
//  partir de VS_THRESHOLD = 30 messages, très au-dessus de
//  VS_BUFFER = 10. C'est le RAPPORT ENTRE LES DEUX CONSTANTES qui
//  protège, pas le clamp.
//
//  Conséquence pratique : le clamp redeviendrait porteur si quelqu'un
//  abaissait le seuil sous le tampon. Les cas ci-dessous testent donc
//  le COMPORTEMENT (« il reste toujours un message rendu ») sur
//  plusieurs tailles de conversation plutôt que la ligne de clamp —
//  un test qui affirmerait couvrir cette ligne mentirait.
//
//  ⚠ LE PIÈGE DU rAF — à lire avant de toucher à ce fichier.
//  ``onChatScroll`` fait :
//
//      if (_vsRafId) return;
//      _vsRafId = requestAnimationFrame(() => { _vsRafId = null; ... });
//
//  Une doublure SYNCHRONE de ``requestAnimationFrame`` (``f => { f();
//  return 1; }``) exécute le callback AVANT de rendre sa valeur : le
//  callback met ``_vsRafId`` à ``null``, puis l'affectation le repose à
//  ``1``. Le garde reste armé pour toujours et TOUS les scrolls
//  suivants sont ignorés EN SILENCE — la fenêtre reste figée sur son
//  premier calcul et le test passe au vert en ne testant rien. D'où
//  ``rafManuel()`` dans tests/frontend/lib/stubs.js : une FILE, vidée
//  explicitement par ``videRaf()``.
//
//  On pilote donc le module par sa porte d'entrée (``onChatScroll`` +
//  ``videRaf``) plutôt que d'extraire ``_vsRecalc`` : ça couvre en
//  prime le garde anti-réentrance, qui est précisément ce qui casse.
// ============================================================

'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { charger } = require('./lib/charger.js');
const { vueMini, refsDeclares, ctxMuet, elementFactice } = require('./lib/stubs.js');

// Constantes du module, recopiées ici pour que les attentes soient
// lisibles. Le premier cas vérifie qu'elles n'ont pas bougé.
const SEUIL = 30;         // VS_THRESHOLD
const TAMPON = 10;        // VS_BUFFER
const HAUTEUR = 180;      // VS_DEFAULT_HEIGHT
const ESPACE = 32;        // VS_GAP
const PAS = HAUTEUR + ESPACE;   // hauteur estimée d'un message, espace compris

/** Monte le module avec N messages et un conteneur de scroll contrôlé. */
function monter(nbMessages, options) {
    const o = options || {};
    const c = charger('chat/_virtual_scroll.js');
    const conteneur = elementFactice({
        scrollTop: o.scrollTop || 0,
        clientHeight: o.hauteurVue !== undefined ? o.hauteurVue : 900,
        querySelectorAll: () => [],     // aucune mesure réelle : on reste sur l'estimation
    });
    const refs = refsDeclares({
        messages: Array.from({ length: nbMessages }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i })),
        chatContainer: o.sansConteneur ? null : conteneur,
        isUserScrolling: false,
    });
    const api = c.fabrique('setupChatVirtualScroll', [vueMini(), refs, ctxMuet({})]);
    return {
        api, refs, conteneur,
        /** Simule un scroll à `px` puis laisse tourner le rAF. */
        scroller(px) { conteneur.scrollTop = px; api.onChatScroll(); c.videRaf(); },
        videRaf: () => c.videRaf(),
        /** Indices actuellement rendus. */
        indices() { return api.visibleMessages.value.map((v) => v.idx); },
    };
}

// ── Les constantes ───────────────────────────────────────────

t('sous le seuil, TOUS les messages sont rendus et les cales sont nulles', () => {
    const v = monter(SEUIL);
    assert.equal(v.api.visibleMessages.value.length, SEUIL);
    assert.equal(v.api.vsTopPad.value, 0);
    assert.equal(v.api.vsBotPad.value, 0);
});

t('à seuil + 1, le fenêtrage s\'active', () => {
    const v = monter(SEUIL + 1);
    v.api._vsInitTail(SEUIL + 1);
    assert.ok(v.api.visibleMessages.value.length < SEUIL + 1,
        'le fenêtrage devrait avoir réduit la liste rendue');
});

t('une conversation vide ne casse pas', () => {
    const v = monter(0);
    assert.deepStrictEqual(v.indices(), []);
    v.scroller(0);
    assert.deepStrictEqual(v.indices(), []);
});

// ── visibleMessages : forme du rendu ─────────────────────────

t('chaque entrée porte le message ET son index absolu', () => {
    const v = monter(5);
    const e = v.api.visibleMessages.value[2];
    assert.equal(e.idx, 2);
    assert.equal(e.msg.content, 'm2');
});

t('les index restent ABSOLUS dans une fenêtre décalée', () => {
    // C'est ce qui permet à _patch de remplacer le bon message.
    const v = monter(100);
    v.api._vsInitTail(100);
    const idx = v.indices();
    assert.equal(idx[idx.length - 1], 99);
    assert.ok(idx[0] > 0, 'la fenêtre devrait être décalée vers la fin');
    for (let i = 1; i < idx.length; i++) assert.equal(idx[i], idx[i - 1] + 1, 'index non contigus');
});

// ── _vsInitTail : la fenêtre initiale ────────────────────────

t('_vsInitTail sous le seuil rend tout, sans cale', () => {
    const v = monter(10);
    v.api._vsInitTail(10);
    assert.deepStrictEqual(v.indices(), [...Array(10).keys()]);
    assert.equal(v.api.vsTopPad.value, 0);
    assert.equal(v.api.vsBotPad.value, 0);
});

t('_vsInitTail ouvre sur la FIN de la conversation', () => {
    const v = monter(100);
    v.api._vsInitTail(100);
    const idx = v.indices();
    assert.equal(idx[idx.length - 1], 99, 'le dernier message doit être rendu');
    assert.equal(idx.length, TAMPON * 2 + 5, 'fenêtre initiale de 2×tampon + 5');
    assert.equal(idx[0], 100 - (TAMPON * 2 + 5));
});

t('_vsInitTail ne laisse AUCUNE cale sous la fenêtre', () => {
    // On ouvre en bas : il n'y a rien après.
    const v = monter(100);
    v.api._vsInitTail(100);
    assert.equal(v.api.vsBotPad.value, 0);
});

t('_vsInitTail pose une cale au-dessus égale aux messages sautés', () => {
    const v = monter(100);
    v.api._vsInitTail(100);
    const sautes = 100 - (TAMPON * 2 + 5);
    assert.equal(v.api.vsTopPad.value, sautes * PAS);
});

// ── Fenêtrage au scroll ──────────────────────────────────────

t('en haut de la conversation, la fenêtre part du début', () => {
    const v = monter(100);
    v.scroller(0);
    assert.equal(v.indices()[0], 0);
    assert.equal(v.api.vsTopPad.value, 0);
});

t('scroller au milieu déplace la fenêtre sur le viewport', () => {
    const v = monter(100);
    v.scroller(50 * PAS);            // ~message 50
    const idx = v.indices();
    assert.ok(idx.includes(50), 'le message visé doit être rendu — reçu ' + idx[0] + '..' + idx[idx.length - 1]);
    assert.equal(idx[0], 50 - TAMPON, 'le tampon amont doit être de ' + TAMPON);
});

t('la fenêtre englobe le viewport plus un tampon de chaque côté', () => {
    const v = monter(200);
    v.scroller(100 * PAS);
    const idx = v.indices();
    const vus = Math.ceil(900 / PAS);      // messages tenant dans la vue
    assert.equal(idx[0], 100 - TAMPON);
    assert.ok(idx.length >= vus + TAMPON, 'fenêtre trop étroite : ' + idx.length);
});

t('une vue plus haute rend plus de messages', () => {
    const petite = monter(200, { hauteurVue: 400 });
    petite.scroller(100 * PAS);
    const grande = monter(200, { hauteurVue: 2000 });
    grande.scroller(100 * PAS);
    assert.ok(grande.indices().length > petite.indices().length);
});

t('les cales encadrent exactement les messages non rendus', () => {
    const v = monter(100);
    v.scroller(50 * PAS);
    const idx = v.indices();
    assert.equal(v.api.vsTopPad.value, idx[0] * PAS);
    assert.equal(v.api.vsBotPad.value, (100 - (idx[idx.length - 1] + 1)) * PAS);
});

t('INVARIANT : cale haute + messages rendus + cale basse = hauteur totale', () => {
    // Si cette somme dérive, la barre de défilement ment et le scroll saute.
    for (const px of [0, 10 * PAS, 50 * PAS, 99 * PAS]) {
        const v = monter(100);
        v.scroller(px);
        const rendus = v.indices().length;
        const total = v.api.vsTopPad.value + rendus * PAS + v.api.vsBotPad.value;
        assert.equal(total, 100 * PAS, 'à scrollTop=' + px);
    }
});

t('INVARIANT : le dernier message reste rendu quand on est en bas', () => {
    const v = monter(100);
    v.scroller(100 * PAS);
    assert.ok(v.indices().includes(99));
});

// ── LE BUG HISTORIQUE : scrollTop au-delà du total ───────────

t('ÉCRAN BLANC : un scrollTop très au-delà du total garde des messages rendus', () => {
    // Sans le clamp `first >= total`, la fenêtre devient vide : l'écran
    // se vide sans la moindre erreur en console.
    const v = monter(100);
    v.scroller(999999);
    const idx = v.indices();
    assert.ok(idx.length > 0, 'la fenêtre est vide : écran blanc');
    assert.ok(idx.includes(99), 'le dernier message doit rester rendu');
});

t('ÉCRAN BLANC : le cas survient aussi juste après une suppression de messages', () => {
    // On scrolle en bas d'une longue conversation, puis elle raccourcit.
    const v = monter(100);
    v.scroller(99 * PAS);
    v.refs.messages.value = v.refs.messages.value.slice(0, 40);
    v.scroller(99 * PAS);        // scrollTop périmé, bien au-delà du nouveau total
    const idx = v.indices();
    assert.ok(idx.length > 0, 'la fenêtre est vide après raccourcissement');
    assert.ok(idx.includes(39), 'le nouveau dernier message doit être rendu');
});

t('ÉCRAN BLANC : la garde tient pour TOUTE taille au-dessus du seuil', () => {
    // Le clamp du source est inopérant tant que VS_THRESHOLD (30) reste
    // très au-dessus de VS_BUFFER (10) — cf. l'en-tête. Ce cas vérifie la
    // propriété qui compte vraiment, sur les tailles où le rapport entre
    // les deux constantes est le plus serré.
    for (const total of [SEUIL + 1, SEUIL + 2, SEUIL + 5, 50, 100, 500]) {
        const v = monter(total);
        v.scroller(total * PAS * 10);
        const idx = v.indices();
        assert.ok(idx.length > 0, 'fenêtre vide à ' + total + ' messages : écran blanc');
        assert.ok(idx.includes(total - 1),
            'le dernier message doit rester rendu à ' + total + ' messages');
    }
});

t('un scrollTop négatif n\'explose pas', () => {
    const v = monter(100);
    v.scroller(-500);
    assert.ok(v.indices().length > 0);
    assert.equal(v.indices()[0], 0);
});

t('sans conteneur monté, la fenêtre reste complète plutôt que vide', () => {
    const v = monter(100, { sansConteneur: true });
    v.api.onChatScroll();
    v.videRaf();
    assert.equal(v.indices().length, 100);
});

// ── Le garde anti-réentrance du rAF ──────────────────────────

t('plusieurs scrolls dans la même frame ne planifient qu\'UN recalcul', () => {
    const v = monter(100);
    v.conteneur.scrollTop = 10 * PAS;
    v.api.onChatScroll();
    v.api.onChatScroll();
    v.api.onChatScroll();
    const passes = v.videRaf();
    assert.equal(passes, 1, 'le garde _vsRafId doit dédupliquer les scrolls d\'une même frame');
});

t('le garde se RÉARME après exécution — les scrolls suivants comptent', () => {
    // C'est le cœur du piège du rAF synchrone : si le garde ne se
    // réarmait pas, tout scroll ultérieur serait ignoré en silence et la
    // fenêtre resterait figée sur son premier calcul.
    const v = monter(100);
    v.scroller(10 * PAS);
    const premier = v.indices()[0];
    v.scroller(60 * PAS);
    const second = v.indices()[0];
    assert.notEqual(second, premier,
        'la fenêtre n\'a pas bougé au second scroll : le garde rAF est resté armé');
    assert.equal(second, 60 - TAMPON);
});

t('_vsReset annule un recalcul en vol', () => {
    // Sinon un scroll planifié juste avant un changement de conversation
    // s'exécute APRÈS l'initialisation et mesure l'ancien DOM.
    const v = monter(100);
    v.conteneur.scrollTop = 50 * PAS;
    v.api.onChatScroll();
    v.api._vsReset();
    const passes = v.videRaf();
    assert.equal(passes, 0, 'le rAF en vol devait être annulé');
});

// ── lastAssistantIdx ─────────────────────────────────────────

t('lastAssistantIdx pointe le dernier assistant, pas le dernier message', () => {
    const v = monter(0);
    v.refs.messages.value = [
        { role: 'user' }, { role: 'assistant' }, { role: 'user' },
    ];
    assert.equal(v.api.lastAssistantIdx.value, 1);
});

t('lastAssistantIdx vaut -1 sans aucun assistant', () => {
    const v = monter(0);
    v.refs.messages.value = [{ role: 'user' }];
    assert.equal(v.api.lastAssistantIdx.value, -1);
    v.refs.messages.value = [];
    assert.equal(v.api.lastAssistantIdx.value, -1);
});

fin();
