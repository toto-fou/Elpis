// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_helpers_json.js -- Helpers JSON purs pour le streaming
//  des tool_call deltas.
//
//  Extrait de app-chat.js (lignes 491-598). Zéro state, zéro side
//  effect, aucune dépendance Vue / DOM / réseau. Si l'un de ces
//  helpers casse, le bug est purement algorithmique et reproductible
//  hors browser.
//
//  Contexte d'usage : les events `tool_call_delta` arrivent en
//  fragments JSON incomplets au fur et à mesure que le LLM stream
//  les arguments. ``_handleToolCallDeltaImpl`` (qui reste dans
//  ``app-chat.js`` car couplé au state global du streaming) accumule
//  ces fragments dans ``argsBuf`` et appelle ces helpers pour pull
//  les champs progressivement :
//
//    * ``_extractJsonScalar`` : pour les scalars (string complète,
//      number, bool, null) qui doivent être présents en entier avant
//      d'être utilisés (par ex. ``mode``, ``path``, ``action``,
//      ``start_line``).
//
//    * ``_pullJsonStringField`` : pour les strings longues qui
//      doivent être streamées caractère par caractère vers Monaco
//      (par ex. ``content`` d'un write_file ou d'un edit_file
//      replace) — chaque appel consomme les nouveaux caractères
//      depuis le dernier cursor et retourne ``{chunk, complete}``.
//
//    * ``_makeToolStreamKey`` : composite key (chat × iter × index)
//      pour gérer les streams concurrents (background + foreground
//      sur deux chats simultanés).
//
//    * ``_reEsc`` : regex-escape un nom de champ.
//
//  Aucune dépendance injectée. Le sous-module est un singleton
//  fonctionnel — le ``setup*`` ne sert qu'à harmoniser le pattern.
//
//  Exporte : { _makeToolStreamKey, _reEsc, _extractJsonScalar,
//              _pullJsonStringField }
// ============================================================

function setupChatHelpersJson() {

    function _makeToolStreamKey(chatId, iter, index) {
        return (chatId || 'local') + ':' + (iter || 0) + ':' + (index || 0);
    }

    /** Regex-escape un nom de champ pour l'injecter dans une RegExp. */
    function _reEsc(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Extrait un scalaire JSON (string / number / bool / null) de ``buf`` une
     * fois qu'il est COMPLÈTEMENT arrivé. Retourne undefined sinon (pas
     * trouvé ou incomplet → il faut attendre plus de deltas).
     */
    function _extractJsonScalar(buf, fieldName) {
        const keyRe = new RegExp('"' + _reEsc(fieldName) + '"\\s*:\\s*');
        const m = buf.match(keyRe);
        if (!m) return undefined;
        const start = m.index + m[0].length;
        if (start >= buf.length) return undefined;
        const first = buf[start];
        // ── string ───────────────────────────────────────────────────
        if (first === '"') {
            let i = start + 1;
            let out = '';
            while (i < buf.length) {
                const c = buf[i];
                if (c === '\\') {
                    if (i + 1 >= buf.length) return undefined;  // incomplet
                    const nx = buf[i + 1];
                    if (nx === 'u') {
                        if (i + 6 > buf.length) return undefined;
                        const code = parseInt(buf.substring(i + 2, i + 6), 16);
                        out += isNaN(code) ? '' : String.fromCharCode(code);
                        i += 6;
                    } else {
                        const map = { n:'\n', t:'\t', r:'\r', '"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f' };
                        out += map[nx] !== undefined ? map[nx] : nx;
                        i += 2;
                    }
                } else if (c === '"') {
                    return { type: 'string', value: out, endIdx: i + 1 };
                } else {
                    out += c; i++;
                }
            }
            return undefined;  // guillemet fermant pas encore reçu
        }
        // ── number ──────────────────────────────────────────────────
        if (first === '-' || (first >= '0' && first <= '9')) {
            let i = start;
            if (buf[i] === '-') i++;
            while (i < buf.length && ((buf[i] >= '0' && buf[i] <= '9') || buf[i] === '.' || buf[i] === 'e' || buf[i] === 'E' || buf[i] === '+' || buf[i] === '-')) i++;
            if (i >= buf.length) return undefined;
            // Le séparateur suivant doit être non-numérique
            const nx = buf[i];
            if (/[\s,}\]]/.test(nx)) {
                const n = parseFloat(buf.substring(start, i));
                return { type: 'number', value: n, endIdx: i };
            }
            return undefined;
        }
        // ── bool / null ─────────────────────────────────────────────
        if (buf.startsWith('true',  start)) return { type: 'bool', value: true,  endIdx: start + 4 };
        if (buf.startsWith('false', start)) return { type: 'bool', value: false, endIdx: start + 5 };
        if (buf.startsWith('null',  start)) return { type: 'null', value: null,  endIdx: start + 4 };
        return undefined;
    }

    /**
     * Décodeur progressif d'un champ string : à chaque appel, consomme les
     * caractères disponibles depuis le dernier cursor et retourne le chunk
     * décodé + un flag ``complete`` quand le guillemet fermant est atteint.
     * ``state`` est un objet mutable qui garde l'avancement entre appels.
     */
    function _pullJsonStringField(buf, fieldName, state) {
        if (state.complete) return { chunk: '', complete: true, found: true };
        if (state.valueStart === undefined) {
            const keyRe = new RegExp('"' + _reEsc(fieldName) + '"\\s*:\\s*"');
            const m = buf.match(keyRe);
            if (!m) return { chunk: '', complete: false, found: false };
            state.valueStart = m.index + m[0].length;
            state.cursor    = state.valueStart;
        }
        let out = '';
        let i = state.cursor;
        while (i < buf.length) {
            const c = buf[i];
            if (c === '\\') {
                if (i + 1 >= buf.length) break;  // besoin de plus de données
                const nx = buf[i + 1];
                if (nx === 'u') {
                    if (i + 6 > buf.length) break;
                    const code = parseInt(buf.substring(i + 2, i + 6), 16);
                    out += isNaN(code) ? '' : String.fromCharCode(code);
                    i += 6;
                } else {
                    const map = { n:'\n', t:'\t', r:'\r', '"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f' };
                    out += map[nx] !== undefined ? map[nx] : nx;
                    i += 2;
                }
            } else if (c === '"') {
                state.complete = true;
                state.cursor   = i + 1;
                return { chunk: out, complete: true, found: true };
            } else {
                out += c; i++;
            }
        }
        state.cursor = i;
        return { chunk: out, complete: false, found: true };
    }

    return {
        _makeToolStreamKey,
        _reEsc,
        _extractJsonScalar,
        _pullJsonStringField,
    };
}

window.setupChatHelpersJson = setupChatHelpersJson;
