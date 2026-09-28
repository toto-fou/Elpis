// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_helpers_misc.js -- Petits utilitaires bas niveau utilisés
//  par le streaming de tool_calls.
//
//  Extrait de app-chat.js. Comportement identique :
//
//    * _relPath(p) : ramène un path sandbox absolu vers sa forme
//      relative affichable (strip du préfixe sandbox_path_display).
//
//    * _prefetchSandboxFile(path) : télécharge le contenu d'un
//      fichier sandbox pour pouvoir démarrer un stream d'édition
//      quand l'user n'a pas encore ouvert le fichier (utile pour
//      edit_file str_replace : besoin de matcher old_str dans le
//      modèle).
//
//    * _recordDiffForMessage(msgIdx, path, beforeContent) :
//      enregistre le snapshot pré-édition d'un fichier sur le
//      message assistant courant pour afficher le bouton "Voir
//      les modifications". Préserve la subtilité originale : si
//      plusieurs tool_calls touchent le même fichier au cours
//      d'un même prompt, on garde le snapshot du TOUT PREMIER
//      tool_call (sinon le diff montrerait des modifs partielles
//      au lieu de la session complète).
//
//  Dépendances injectées :
//    * sharedRefs.settings        -- ref(object) pour _relPath
//    * ctx.fetchAuth              -- helper HTTP authentifié
//    * ctx._getStreamMsgs         -- fonction (hoistée dans app-chat.js)
//    * ctx._patch                 -- fonction (hoistée dans app-chat.js)
//
//  Exporte : { _relPath, _prefetchSandboxFile, _recordDiffForMessage }
// ============================================================

function setupChatHelpersMisc(vue, sharedRefs, ctx) {
    const { settings } = sharedRefs;
    const { fetchAuth, _getStreamMsgs, _patch } = ctx;

    /** Ramène un path sandbox absolu vers sa forme relative affichable. */
    function _relPath(p) {
        if (!p) return p;
        // Même canonisation que l'éditeur (E13) : ``/work/x`` et ``x``
        // désignent le même onglet.
        return window.elpisCanonPath ? window.elpisCanonPath(p, settings.value.sandbox_path_display) : p;
    }

    /**
     * Télécharge le contenu d'un fichier sandbox pour pouvoir démarrer un
     * stream d'édition quand l'user n'a pas encore ouvert le fichier. Utile
     * pour edit_file str_replace (besoin de matcher old_str dans le modèle).
     * Retourne la string du contenu ou null si fetch échoue.
     */
    async function _prefetchSandboxFile(path) {
        try {
            const res = await fetchAuth(
                '/api/sandbox/download?path=' + encodeURIComponent(path),
                {}, true,
            );
            if (res && res.ok) return await res.text();
        } catch (_) { /* non-fatal */ }
        return null;
    }

    /**
     * Enregistre le snapshot pré-édition d'un fichier sur le message
     * assistant courant pour afficher le bouton "Voir les modifications".
     *
     * Un PROMPT utilisateur = UN message assistant = potentiellement plusieurs
     * tool_calls sur le(s) même(s) fichier(s). Pour que le diff affiche
     * TOUTES les modifs de la session (et pas seulement la dernière), on
     * garde pour chaque path le snapshot du TOUT PREMIER tool_call de ce
     * prompt. Appels ultérieurs sur le même path : snapshot ignoré.
     *
     * Structure sur le message :
     *   _diffFiles  : { [path]: beforeContent }   ← source de vérité (map)
     *   _diffPath   : dernier path modifié        ← rétrocompat (UI actuelle)
     *   _diffBefore : snapshot ORIGINAL pour _diffPath
     *
     * La rétrocompat garantit que le template existant (bouton unique via
     * v-if="entry.msg._diffPath") continue de fonctionner sans changement.
     * Le nouveau template (liste sur _diffFiles) affiche un bouton par
     * fichier modifié dans le prompt.
     */
    function _recordDiffForMessage(msgIdx, path, beforeContent) {
        if (msgIdx < 0) return;
        const msgs = _getStreamMsgs();
        const cur  = msgs[msgIdx];
        if (!cur) return;
        const prev = cur._diffFiles || {};
        // On ne remplace PAS si le path est déjà enregistré : le premier
        // snapshot est celui d'avant toute modif de la session.
        if (prev[path] !== undefined) {
            // Juste mettre à jour _diffPath pour que l'UI rétrocompat
            // pointe vers le dernier fichier modifié (sensation d'activité).
            _patch(msgIdx, {
                _diffPath:   path,
                _diffBefore: prev[path],
            });
            return;
        }
        const next = Object.assign({}, prev, { [path]: beforeContent });
        _patch(msgIdx, {
            _diffFiles:  next,
            _diffPath:   path,
            _diffBefore: beforeContent,
        });
    }

    return {
        _relPath,
        _prefetchSandboxFile,
        _recordDiffForMessage,
    };
}

window.setupChatHelpersMisc = setupChatHelpersMisc;
