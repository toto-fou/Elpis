// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_webshot.js -- Carousel des screenshots Playwright (live)
//  associés aux messages assistant qui ont déclenché des actions
//  web (browser_*, web_screenshot, etc.).
//
//  Extrait de app-chat.js. Comportement identique :
//
//    * 4 fonctions de navigation dans le carousel (prev/next/goto/toggle)
//    * 1 helper de cleanup qui révoque les blob URLs des screenshots
//      pour éviter les fuites mémoire (1-2 MB par screenshot, persistant
//      jusqu'à fermeture du navigateur sinon)
//
//  IMPORTANT — pourquoi le revoke est nécessaire :
//    Avant ce helper, ``startNewChat`` faisait simplement
//    ``messages.value = []`` sans cleanup, et chaque "Nouveau chat"
//    accumulait les blobs des screenshots des sessions précédentes.
//    Sur un user qui enchaîne des chats avec automation web, ça
//    montait vite à 100+ MB de fuite mémoire.
//
//  Le carousel mute directement les champs sur l'objet ``msg`` (pas
//  de remplacement d'objet) parce que Vue 3 track les propriétés
//  d'un objet réactif dans un array — la mutation est détectée et
//  la référence ``entry.msg`` du template v-for reste valide.
//
//  Dépendances injectées :
//    * sharedRefs.messages -- ref(array) du chat courant
//
//  Exporte :
//    * _revokeAllWebShotBlobs()
//    * webShotPrev(msg)
//    * webShotNext(msg)
//    * webShotToggleExpand(msg)
//    * webShotGoto(msg, i)
// ============================================================

function setupChatWebshot(vue, sharedRefs, ctx) {
    const { messages } = sharedRefs;

    /** Helper : libère tous les blob URLs des screenshots du chat courant. */
    function _revokeAllWebShotBlobs() {
        try {
            for (const m of messages.value) {
                if (m.webScreenshots && m.webScreenshots.length) {
                    for (const s of m.webScreenshots) {
                        if (s.blobUrl) {
                            try { URL.revokeObjectURL(s.blobUrl); } catch (_) {}
                            s.blobUrl = null;
                        }
                    }
                }
            }
        } catch (_) {}
    }

    function webShotPrev(msg) {
        if (!msg || !msg.webScreenshots) return;
        const n = msg.webScreenshots.length;
        // array vide (truthy) → n=0 → (cur-1+0)%0 = NaN, idx devient NaN.
        if (!n) return;
        const cur = msg.webScreenshotIdx ?? n - 1;
        msg.webScreenshotIdx = (cur - 1 + n) % n;
    }

    function webShotNext(msg) {
        if (!msg || !msg.webScreenshots) return;
        const n = msg.webScreenshots.length;
        if (!n) return;
        const cur = msg.webScreenshotIdx ?? n - 1;
        msg.webScreenshotIdx = (cur + 1) % n;
    }

    function webShotToggleExpand(msg) {
        if (!msg) return;
        msg.webScreenshotExpanded = !msg.webScreenshotExpanded;
    }

    function webShotGoto(msg, i) {
        if (!msg || !msg.webScreenshots) return;
        if (i >= 0 && i < msg.webScreenshots.length) {
            msg.webScreenshotIdx = i;
        }
    }

    return {
        _revokeAllWebShotBlobs,
        webShotPrev,
        webShotNext,
        webShotToggleExpand,
        webShotGoto,
    };
}

window.setupChatWebshot = setupChatWebshot;
