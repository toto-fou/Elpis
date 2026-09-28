// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_thinking_title.js -- Génère un "titre" humain depuis un
//  texte de raisonnement LLM, pour afficher quelque chose d'utile
//  dans la status bar pendant que le modèle réfléchit.
//
//  Extrait de app-chat.js (lignes 464-480). Pures fonctions, zéro
//  state, zéro side effect. Aucune dépendance Vue / DOM / réseau.
//
//  Heuristique : on regarde les 2000 derniers caractères du texte de
//  thinking, on cherche des marqueurs typiques (« je dois », « let me »,
//  « next »…) et on extrait le segment qui suit. À défaut, on prend la
//  dernière phrase complète. Fallback : "Réflexion en cours...".
//
//  Utilisé par ``_flushThinkBuf`` (qui reste dans app-chat.js — il
//  manipule trop de state pour être sorti tout seul) pour mettre à
//  jour ``statusText.value = _thinkingTitle(merged)`` (aucun emoji :
//  règle produit — l'app reste sobre).
//
//  Aucune dépendance injectée. Pure factory.
//
//  Exporte : { _thinkingTitle, _cap }
// ============================================================

function setupChatThinkingTitle() {

    /** Capitalize + strip leading punctuation/whitespace. */
    function _cap(s) {
        // `[,;:\----]` était ambigu selon le moteur regex (`\-` puis
        // une suite de `-` peut être lu comme range invalide sur Safari).
        // On garde un set explicite, sans range.
        s = (s || '').trim().replace(/^[,;:\-]+\s*/, '');
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function _thinkingTitle(text) {
        const last = (text || '').slice(-2000).trim();
        const stages = [
            [/(?:let me|let's|je dois|je vais|I need to|I should|I'll|il faut|nous devons)\s+([^.!?\n]{5,50})/i, m => _cap(m[1])],
            [/(?:first[,:]?|d'abord[,:]?|étape 1|step 1)\s*([^.!?\n]{5,50})/i, () => 'Analyse initiale'],
            [/(?:now[,:]?|next[,:]?|ensuite[,:]?|maintenant[,:]?)\s+([^.!?\n]{5,50})/i, m => _cap(m[1])],
            [/(?:wait|hmm|actually|en fait)\s*[,]?\s*([^.!?\n]{5,50})/i, () => 'Vérification...'],
            [/(?:calculat|calculons|comput|let me calc)\s*([^.!?\n]{0,40})/i, () => 'Calcul en cours...'],
            [/(?:the answer|la réponse|the result|le résultat)\s*(?:is|=|est)?\s*([^.!?\n]{2,40})/i, () => 'Formulation de la réponse'],
            [/(?:in conclusion|en conclusion|to summarize|pour résumer|finally|finalement)\s*([^.!?\n]{5,50})/i, () => 'Conclusion'],
        ];
        for (const [re, fn] of stages) {
            const m = last.match(re);
            if (m) {
                const t = fn(m);
                if (t && t.length >= 3) return t.slice(0, 55);
            }
        }
        const sentences = last.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 8);
        if (sentences.length > 0) return _cap(sentences[sentences.length - 1]).slice(0, 55);
        return 'Réflexion en cours...';
    }

    return { _thinkingTitle, _cap };
}

window.setupChatThinkingTitle = setupChatThinkingTitle;
