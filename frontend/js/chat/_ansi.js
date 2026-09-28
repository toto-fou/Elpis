// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/chat/_ansi.js — rendu ANSI minimal pour le terminal en direct du chat.
 *
 * Convertit la sortie brute d'``execute_shell`` (chunks ``shell_output``) en
 * HTML sûr : échappement systématique, résolution des retours chariot ``\r``
 * (barres de progression pip/npm : le dernier segment écrase la ligne), puis
 * parsing des SEULES séquences SGR (``ESC[...m``) — couleurs 16 + gras/dim.
 * Toute autre séquence d'échappement (curseur, effacement, OSC titre…) est
 * silencieusement retirée. Palette : classes ``sh-fg-N`` (style.css, thème
 * VS-Code Dark identique au terminal de l'éditeur et aux blocs de code).
 *
 * Module PUR (sans Vue), testable en Node (tests/frontend/test_ansi.js).
 * Exporté en CommonJS ET en global navigateur (window.elpisAnsi).
 * ==========================================================================*/
(function (root) {
    "use strict";

    var ESC_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, function (c) { return ESC_HTML[c]; });
    }

    // Retire les séquences non-SGR : CSI autres que ``m``, OSC (titre de
    // fenêtre, terminées par BEL ou ST), et les échappements simples.
    // Garde les CSI ``m`` pour le parsing SGR en aval.
    var RE_OSC   = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
    var RE_CSI   = /\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g;   // tout sauf ``m`` (et M rare)
    var RE_MISC  = /\x1b[@-Z\\-_]/g;                    // ESC + un caractère (RIS, charset…)
    var RE_CTRL  = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g; // contrôles résiduels (garde \t \n \r et ESC)

    function stripNonSgr(s) {
        return String(s)
            .replace(RE_OSC, '')
            .replace(RE_CSI, '')
            .replace(RE_MISC, '')
            .replace(RE_CTRL, '');
    }

    // Résout les ``\r`` d'une ligne physique : chaque segment écrase le début
    // de la ligne accumulée (comportement terminal). ``abc\r12`` → ``12c``.
    // Cas dominant en pratique (progress bars) : le dernier segment est plus
    // long que les précédents → il gagne entièrement.
    function resolveCarriage(line) {
        var segs = line.split('\r');
        if (segs.length === 1) return line;
        var acc = '';
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i];
            if (!s) continue;
            acc = s.length >= acc.length ? s : s + acc.slice(s.length);
        }
        return acc;
    }

    // Parse SGR sur une ligne SANS ESC hors ``ESC[...m``. État : {fg, bold, dim}.
    // NB : l'état SGR se propage d'une ligne à l'autre via le paramètre
    // ``state`` (objet muté) — une commande qui colore un bloc multi-lignes
    // garde sa couleur.
    var RE_SGR = /\x1b\[([0-9;]*)m/g;

    function applySgrCodes(state, paramStr) {
        var parts = (paramStr === '' ? ['0'] : paramStr.split(';'));
        for (var i = 0; i < parts.length; i++) {
            var n = parseInt(parts[i] || '0', 10);
            if (isNaN(n)) continue;
            if (n === 0) { state.fg = null; state.bold = false; state.dim = false; }
            else if (n === 1) state.bold = true;
            else if (n === 2) state.dim = true;
            else if (n === 22) { state.bold = false; state.dim = false; }
            else if (n === 39) state.fg = null;
            else if (n >= 30 && n <= 37) state.fg = n - 30;
            else if (n >= 90 && n <= 97) state.fg = n - 90 + 8;
            /* 38;5;… / 38;2;… (256/truecolor) : ignorés — le reset 39/0 suffit */
        }
    }

    function spanOpen(state) {
        var cls = [];
        if (state.fg !== null) cls.push('sh-fg-' + state.fg);
        if (state.bold) cls.push('sh-b');
        if (state.dim) cls.push('sh-d');
        if (!cls.length) return '';
        return '<span class="' + cls.join(' ') + '">';
    }

    /**
     * Convertit un texte brut de shell en HTML sûr avec spans de couleur.
     * @param {string} text  sortie brute (peut contenir ANSI, \r, \n)
     * @returns {string} HTML (à injecter dans un <pre> via v-html)
     */
    function ansiToHtml(text) {
        if (text == null || text === '') return '';
        var clean = stripNonSgr(String(text));
        var lines = clean.split('\n');
        var state = { fg: null, bold: false, dim: false };
        var out = [];
        for (var li = 0; li < lines.length; li++) {
            var line = resolveCarriage(lines[li]);
            var html = '';
            var last = 0;
            var open = spanOpen(state);
            if (open) html += open;
            RE_SGR.lastIndex = 0;
            var m;
            while ((m = RE_SGR.exec(line)) !== null) {
                html += escapeHtml(line.slice(last, m.index));
                if (open) { html += '</span>'; open = ''; }
                applySgrCodes(state, m[1]);
                open = spanOpen(state);
                if (open) html += open;
                last = m.index + m[0].length;
            }
            html += escapeHtml(line.slice(last));
            if (open) html += '</span>';
            out.push(html);
        }
        return out.join('\n');
    }

    var api = { ansiToHtml: ansiToHtml, escapeHtml: escapeHtml };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.elpisAnsi = api;
})(typeof window !== 'undefined' ? window : globalThis);
