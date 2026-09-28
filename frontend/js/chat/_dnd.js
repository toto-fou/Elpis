// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/chat/_dnd.js -- Extracted from app-chat.js
//
//  Drag & drop + file picker upload pipeline for the chat area.
//
//  Responsibilities
//  ----------------
//  • Accept drag & drop of OS files onto the chat area, ignoring
//    internal file-tree drags (data-type check on `Files` only).
//  • Coordinate with the editor file-tree via window.__dropHandled
//    (200ms cooperative lock) so a drop into the tree doesn't
//    double-upload to chat.
//  • File picker: click the paperclip → <input type="file">.
//  • Push files to attachedFiles.value as chips:
//      - Images  → base64 data URL (FileReader.readAsDataURL)
//      - Binary  → backend parse (POST /api/tools/parse-file)
//                  for .pcap, .pcapng, .cap
//      - Text    → FileReader.readAsText
//  • Hard cap at 10 attached files per message.
//
//  Contract
//  --------
//  Loaded BEFORE app-chat.js. Exposes on window:
//      window.setupChatDnd(vue, sharedRefs, ctx)
//
//  Dependencies
//  ------------
//  From sharedRefs : attachedFiles
//  From ctx        : showToast, fetchAuth, fileInput (ref to <input>)
//  From vue        : ref
// ============================================================

(function() {
    'use strict';

    function setupChatDnd(vue, sharedRefs, ctx) {
        const { ref } = vue;
        const { attachedFiles } = sharedRefs;
        const { showToast, fetchAuth } = ctx;

        // -- Drag state ----------------------------------------------
        const chatDragOver   = ref(false);
        let   _chatDragCounter = 0;

        function _chatDropAllowed(event) {
            // Uniquement si le drag contient des fichiers (pas un item interne de l'arbre)
            try {
                const types = event.dataTransfer && event.dataTransfer.types;
                if (!types) return false;
                for (let i = 0; i < types.length; i++) {
                    if (types[i] === 'Files') return true;
                }
            } catch(_) {}
            return false;
        }

        function handleChatDragEnter(event) {
            if (!_chatDropAllowed(event)) return;
            event.preventDefault();
            _chatDragCounter++;
            chatDragOver.value = true;
        }
        // Cible de saisie éditable (textarea du composer, input, contenteditable) :
        // on y préserve le drop NATIF de texte/URL. Ailleurs (zone non éditable),
        // un drop non géré déclencherait la navigation par défaut → SPA détruite.
        function _isEditableDropTarget(event) {
            const t = event.target;
            if (!t || !t.tagName) return false;
            return t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable === true;
        }
        function handleChatDragOver(event) {
            // preventDefault pour toute cible NON éditable (sinon lâcher un lien/texte/
            // image y déclenche la navigation du navigateur → SPA détruite, brouillon
            // perdu) et pour tout drag de fichiers (qu'on veut capturer). On laisse en
            // revanche le drop natif de texte/URL fonctionner DANS le champ de saisie.
            const isFileDrag = _chatDropAllowed(event);
            if (isFileDrag || !_isEditableDropTarget(event)) event.preventDefault();
            if (!isFileDrag) return;
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            chatDragOver.value = true;
        }
        function handleChatDragLeave(event) {
            if (!_chatDropAllowed(event)) return;
            _chatDragCounter = Math.max(0, _chatDragCounter - 1);
            if (_chatDragCounter === 0) chatDragOver.value = false;
        }
        function handleChatDrop(event) {
            // preventDefault pour empêcher la navigation par défaut du navigateur
            // (qui rechargerait la SPA et perdrait le brouillon + les pièces jointes)
            // sur toute cible NON éditable, ET pour tout drop de fichiers (qu'on
            // capture pour l'upload). On laisse le drop natif de texte/URL s'insérer
            // dans le champ de saisie du composer (cible éditable, sans fichier).
            const files = event.dataTransfer && event.dataTransfer.files;
            const hasFiles = !!(files && files.length);
            if (hasFiles || !_isEditableDropTarget(event)) event.preventDefault();
            _chatDragCounter = 0;
            chatDragOver.value = false;
            // Si l'éditeur / l'arbre a déjà géré ce drop, ne rien faire
            if (window.__dropHandled && Date.now() - window.__dropHandled < 200) return;
            if (!hasFiles) return;
            // Réutiliser le pipeline d'upload existant via un event synthétique
            handleFileUpload({ target: { files } });
        }

        // -- File picker trigger -------------------------------------
        function triggerFileUpload() {
            if (ctx.fileInput && ctx.fileInput.value) ctx.fileInput.value.click();
        }

        // Binary file extensions that need backend parsing
        const _PARSEABLE_EXTS = ['.pcap', '.pcapng', '.cap'];
        function _isParseable(name) {
            var dot = name.lastIndexOf('.');
            return dot >= 0 && _PARSEABLE_EXTS.indexOf(name.substring(dot).toLowerCase()) !== -1;
        }

        // -- File reading + dispatch --------------------------------
        // limite stricte en taille avant readAs* : un drop de 500 Mo
        // chargeait tout en mémoire RAM (data URL ou string) → freeze de
        // l'onglet + OOM. Limites différenciées : images en data URL ont une
        // empreinte ~33 % plus haute que le fichier brut (base64), le texte
        // attaché à un message LLM dépasse rarement 1 Mo utilement.
        const MAX_TEXT_BYTES   = 5  * 1024 * 1024;   // 5 Mo texte
        const MAX_IMAGE_BYTES  = 15 * 1024 * 1024;   // 15 Mo image
        const MAX_PARSE_BYTES  = 50 * 1024 * 1024;   // 50 Mo pcap (backend parse)

        function _rejectTooBig(file, limit) {
            const mb = Math.round((file.size || 0) / (1024 * 1024));
            const cap = Math.round(limit / (1024 * 1024));
            showToast(
                `${file.name} (${mb} Mo) dépasse la limite (${cap} Mo)`,
                'warning'
            );
        }

        const MAX_FILES = 10;
        // AUDIT 2026-08-31 (passe 4, F15) — point de PUSH unique : la
        // capacité restante était calculée AVANT les callbacks asynchrones
        // (FileReader, POST de parsing) — deux sélections/drops rapprochés
        // la calculaient depuis le même état et dépassaient le cap à
        // l'atterrissage. On re-vérifie au push. ``_uid`` : clé STABLE pour
        // le v-for (``:key="index"`` faisait réutiliser le mauvais DOM de
        // vignette à la suppression d'un fichier au milieu de la liste).
        let _attachSeq = 0;
        function _pushAttachment(_ownerList, item) {
            if (attachedFiles.value !== _ownerList) return;   // chat changé
            if (_ownerList.length >= MAX_FILES) {
                showToast('Maximum ' + MAX_FILES + ' fichiers atteint', 'warning');
                return;
            }
            item._uid = ++_attachSeq;
            _ownerList.push(item);
        }

        function handleFileUpload(event) {
            const files = event.target.files;
            if (!files || files.length === 0) return;
            const remaining = MAX_FILES - attachedFiles.value.length;
            if (remaining <= 0) {
                showToast('Maximum 10 fichiers atteint', 'warning');
                if (ctx.fileInput && ctx.fileInput.value) ctx.fileInput.value.value = '';
                return;
            }
            const toRead = Array.from(files).slice(0, remaining);
            if (files.length > remaining) {
                showToast(`${files.length - remaining} fichier(s) ignoré(s) (max ${MAX_FILES})`, 'warning');
            }
            // AUDIT 2026-08-31 (passe 2) — jeton d'APPARTENANCE. Les pushes
            // ci-dessous arrivent depuis des callbacks ASYNCHRONES (FileReader,
            // POST de parsing) ; or le switch de conversation remplace
            // ``attachedFiles.value`` par une NOUVELLE array
            // (_resetTransientCompose) : le push tardif atterrissait dans le
            // composeur du chat SUIVANT, et le contenu partait au LLM dans un
            // contexte auquel il n'appartenait pas. Même patron que les
            // @mentions (_compose.js, _ownerList — audit 2026-08-01 M5).
            const _ownerList = attachedFiles.value;
            toRead.forEach(file => {
                const isImage = file.type.startsWith('image/');
                const size = file.size || 0;
                if (_isParseable(file.name)) {
                    if (size > MAX_PARSE_BYTES) { _rejectTooBig(file, MAX_PARSE_BYTES); return; }
                    // Binary file → send to backend for parsing
                    _parseAndAttach(file, _ownerList);
                } else if (isImage) {
                    if (size > MAX_IMAGE_BYTES) { _rejectTooBig(file, MAX_IMAGE_BYTES); return; }
                    const reader = new FileReader();
                    reader.onload = e => {
                        _pushAttachment(_ownerList, {
                            name:     file.name,
                            content:  e.target.result,
                            isImage:  true,
                            mimeType: file.type,
                        });
                    };
                    reader.readAsDataURL(file);
                } else {
                    if (size > MAX_TEXT_BYTES) { _rejectTooBig(file, MAX_TEXT_BYTES); return; }
                    const reader = new FileReader();
                    reader.onload = e => {
                        _pushAttachment(_ownerList, { name: file.name, content: e.target.result });
                    };
                    reader.readAsText(file);
                }
            });
            if (ctx.fileInput && ctx.fileInput.value) ctx.fileInput.value.value = '';
        }

        async function _parseAndAttach(file, _ownerList) {
            showToast('Analyse de ' + file.name + '...');
            // Repli : appel direct sans jeton (ancien cache) → liste courante.
            if (_ownerList === undefined) _ownerList = attachedFiles.value;
            try {
                var formData = new FormData();
                formData.append('file', file);
                var res = await fetchAuth('/api/tools/parse-file', {
                    method: 'POST',
                    body: formData,
                });
                if (attachedFiles.value !== _ownerList) return;   // chat changé
                if (res && res.ok) {
                    var data = await res.json();
                    _pushAttachment(_ownerList, {
                        name: file.name,
                        content: data.content,
                    });
                    showToast(file.name + ' analysé (' + data.length + ' caractères)');
                } else {
                    var err = await res.json().catch(function() { return {}; });
                    showToast(err.detail || 'Erreur parsing ' + file.name, 'error');
                }
            } catch(e) {
                showToast('Erreur réseau parsing ' + file.name, 'error');
            }
        }

        function removeAttachedFile(index) {
            attachedFiles.value.splice(index, 1);
        }

        // -- Public surface -----------------------------------------
        return {
            chatDragOver,
            handleChatDragEnter,
            handleChatDragOver,
            handleChatDragLeave,
            handleChatDrop,
            triggerFileUpload,
            handleFileUpload,
            removeAttachedFile,
        };
    }

    window.setupChatDnd = setupChatDnd;
})();
