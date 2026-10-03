// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_message_edit.js -- Édition d'un message déjà envoyé.
//
//  Extrait de app-chat.js. Comportement identique :
//
//    * ``startEditMessage(index)`` : passe le message ``index`` en
//      mode édition. Bloque si un stream est en cours.
//    * ``cancelEditMessage()`` : ferme le mode édition sans rien
//      sauvegarder.
//    * ``submitEditMessage(index)`` : tronque le tableau messages
//      à ``index``, ré-injecte le contenu édité comme nouveau
//      message user, puis relance ``generateResponse()`` pour que
//      le LLM réponde au message corrigé.
//
//  Cas d'usage : l'utilisateur a tapé une question imprécise, le
//  LLM a répondu de façon hors-sujet → l'utilisateur édite sa
//  question d'origine plutôt que d'envoyer un follow-up. Tout
//  l'historique APRÈS le message édité disparaît (c'est voulu —
//  sinon le contexte deviendrait incohérent).
//
//  Dépendances injectées :
//    * sharedRefs.messages         -- ref(array) du chat courant
//    * sharedRefs.isStreaming      -- ref(bool) garde anti-conflit
//    * sharedRefs.isUserScrolling  -- ref(bool) reset au resubmit
//    * ctx.scrollToBottom          -- function declaration hoistée
//    * ctx.generateResponse        -- function declaration hoistée
//
//  Exporte :
//    * editingMessageIndex (ref)
//    * editMessageText     (ref)
//    * startEditMessage(index)
//    * cancelEditMessage()
//    * submitEditMessage(index)
// ============================================================

function setupChatMessageEdit(vue, sharedRefs, ctx) {
    const { ref, nextTick }                         = vue;
    const { messages, isStreaming, isUserScrolling } = sharedRefs;
    const { scrollToBottom, generateResponse, openConfirm, resetDiffCardState, sweepOrphanCharts } = ctx;

    const editingMessageIndex = ref(null);
    const editMessageText     = ref('');

    function startEditMessage(index) {
        if (isStreaming.value) return;
        editingMessageIndex.value = index;
        editMessageText.value = messages.value[index].content;
        // Focus le champ dès qu'il est rendu (un seul en édition à la fois) et
        // place le caret en fin de texte — sinon éditer demande un 2e clic.
        nextTick(() => {
            const el = document.querySelector('[data-edit-message-input]');
            if (!el) return;
            el.focus();
            try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {}
        });
    }

    function cancelEditMessage() {
        editingMessageIndex.value = null;
        editMessageText.value = '';
    }

    async function submitEditMessage(index) {
        if (isStreaming.value) return;
        const text = editMessageText.value.trim();
        if (!text) { cancelEditMessage(); return; }

        // ── Garde-fou édition du PREMIER message (UX option 5) ────────
        // Éditer le message à l'index 0 tronque tout l'historique : tous
        // les échanges suivants disparaissent. C'est une perte beaucoup
        // plus lourde qu'éditer un message en milieu de chat (où la
        // troncature est l'effet attendu : on rebrunche depuis ce point).
        // Demander confirmation UNIQUEMENT pour le 1er message ET s'il y
        // a effectivement quelque chose à perdre (>1 messages dans la
        // conversation). Sinon, édition silencieuse comme avant.
        const willLoseCount = messages.value.length - index - 1;
        if (index === 0 && willLoseCount > 0 && typeof openConfirm === 'function') {
            const msgWord = willLoseCount > 1 ? 'messages' : 'message';
            const ok = await openConfirm(
                'Modifier le premier message ?',
                `La conversation sera régénérée depuis ce point. Les ${willLoseCount} ${msgWord} qui suivent seront perdus.`,
                false,
                'Modifier et régénérer',
                'Annuler'
            );
            if (!ok) return;  // ← garde le formulaire d'édition ouvert
        }

        // AUDIT 2026-08-01 (E3) : capturer les pièces jointes AVANT la
        // troncature. Le message réinjecté ne reprenait que le texte : une
        // image jointe disparaissait de la bulle, n'était plus envoyée au
        // modèle (réponse hors-sol) et le tour suivant persistait la version
        // amputée — irréversible, le splice ayant déjà supprimé l'original.
        const _orig = messages.value[index] || {};
        const _keptImages = Array.isArray(_orig.images) ? _orig.images.slice() : null;
        const _keptFiles  = Array.isArray(_orig.files)  ? _orig.files.slice()  : null;

        // Tronque l'historique APRÈS le message édité — sinon le contexte
        // serait incohérent (réponse LLM antérieure à une question qui
        // vient de changer).
        // (2026-09-20) Les captures des messages retirés gardaient leurs blob
        // URLs (1 à 2 Mo chacune) : plus aucun message ne les référence et
        // ``_revokeAllWebShotBlobs`` ne parcourt que ``messages.value``.
        for (const m of messages.value.slice(index)) {
            for (const s of (m && m.webScreenshots) || []) {
                if (s && s.blobUrl) { try { URL.revokeObjectURL(s.blobUrl); } catch (_) {} s.blobUrl = null; }
            }
        }
        messages.value.splice(index);
        // Les index de messages sont RÉUTILISÉS après troncature →
        // purge l'état des diff cards (même contrat que loadChat /
        // startNewChat) sinon des stats +/- d'anciennes réponses
        // s'afficheraient sur les messages régénérés au même index.
        if (typeof resetDiffCardState === 'function') resetDiffCardState();
        // Les <canvas> des messages tronqués sont retirés du DOM par Vue au
        // prochain tick → détruire les instances Chart.js orphelines (+ leur
        // ResizeObserver) sinon elles fuiraient jusqu'au prochain rendu/switch.
        if (typeof sweepOrphanCharts === 'function') nextTick(() => sweepOrphanCharts());
        const _edited = { role: 'user', content: text };
        if (_keptImages && _keptImages.length) _edited.images = _keptImages;
        if (_keptFiles  && _keptFiles.length)  _edited.files  = _keptFiles;
        // Message « Images » : sa demande reste attachée, le tour renvoyé
        // repart au moteur d'images (cf. _imageGenFor).
        if (_orig.image_request && typeof _orig.image_request === 'object') {
            _edited.image_request = Object.assign({}, _orig.image_request);
        }
        messages.value.push(_edited);
        cancelEditMessage();
        isUserScrolling.value = false;
        nextTick(() => scrollToBottom(true));
        await generateResponse();
    }

    return {
        editingMessageIndex,
        editMessageText,
        startEditMessage,
        cancelEditMessage,
        submitEditMessage,
    };
}

window.setupChatMessageEdit = setupChatMessageEdit;
