// SPDX-License-Identifier: MIT
// ============================================================
//  editor/_minimal_edit.js -- Édition MINIMALE d'un modèle Monaco
//
//  Passer d'un texte à un autre par UNE opération d'édition qui ne touche
//  que la fenêtre de lignes modifiée (préfixe et suffixe communs sautés) :
//  curseur, défilement et pile d'annulation sont conservés, contrairement à
//  ``setValue``.
//
//  Module PUR (aucune dépendance à Monaco) pour être testé à part : la
//  version précédente, enfouie dans app-editor.js, CORROMPAIT le texte quand
//  le changement était une pure insertion ou une pure suppression de lignes
//  (fenêtre ancienne ou nouvelle VIDE) — elle remplaçait alors le début de la
//  ligne suivante au lieu d'insérer / de retirer des lignes entières :
//      "x\ny\nz\n" → "x\ny\nNEW\nz\n"  donnait  "x\ny\nNEW\n"   (« z » perdu)
//      "a\nb\nc"   → "a\nc"            donnait  "a\n\nc"
//      "a"         → "a\nb"            donnait  "ab"
//  Or les rechargements depuis le disque passent par elle (git pull, commande
//  du terminal, formateur) : tampon corrompu, puis enregistré.
//
//  Exporte (window.elpisMinimalEdit / module.exports)
//  -------
//    compute(oldText, newText) -> null si identiques, sinon
//      { range: {startLineNumber, startColumn, endLineNumber, endColumn},
//        text,                      // texte à poser sur ``range``
//        startLine, endLine,        // zone modifiée dans le NOUVEAU texte
//        changed }                  // nb de lignes nouvelles (0 = suppression)
//    apply(oldText, edit) -> texte résultant (référence pour les tests ;
//      mêmes conventions de colonnes que Monaco, fins de ligne LF)
// ============================================================

(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.elpisMinimalEdit = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
    'use strict';

    // Colonne de fin d'une ligne au sens Monaco (le « \r » d'un CRLF n'est pas
    // un caractère de la ligne).
    function _maxCol(line) {
        var s = line || '';
        if (s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
        return s.length + 1;
    }

    function compute(oldText, newText) {
        oldText = String(oldText == null ? '' : oldText);
        newText = String(newText == null ? '' : newText);
        if (oldText === newText) return null;

        var oldLines = oldText.split('\n');
        var newLines = newText.split('\n');

        // Préfixe commun (en lignes)
        var top = 0;
        while (top < oldLines.length && top < newLines.length
               && oldLines[top] === newLines[top]) top++;

        // Suffixe commun, sans jamais mordre sur le préfixe
        var oldBot = oldLines.length - 1;
        var newBot = newLines.length - 1;
        while (oldBot >= top && newBot >= top
               && oldLines[oldBot] === newLines[newBot]) { oldBot--; newBot--; }

        var oldEmpty = oldBot < top;          // rien à retirer : pure INSERTION
        var newEmpty = newBot < top;          // rien à poser  : pure SUPPRESSION
        var mid = newLines.slice(top, newBot + 1).join('\n');
        var range, text;

        if (!oldEmpty && !newEmpty) {
            // Remplacement de lignes [top..oldBot] par newLines[top..newBot].
            range = { startLineNumber: top + 1, startColumn: 1,
                      endLineNumber: oldBot + 1, endColumn: _maxCol(oldLines[oldBot]) };
            text = mid;
        } else if (oldEmpty) {
            if (top < oldLines.length) {
                // Insertion AVANT la ligne top+1 : lignes entières + leur saut.
                range = { startLineNumber: top + 1, startColumn: 1,
                          endLineNumber: top + 1, endColumn: 1 };
                text = mid + '\n';
            } else {
                // Insertion APRÈS la dernière ligne : le saut passe devant.
                range = { startLineNumber: top, startColumn: _maxCol(oldLines[top - 1]),
                          endLineNumber: top, endColumn: _maxCol(oldLines[top - 1]) };
                text = '\n' + mid;
            }
        } else {
            // Suppression des lignes [top..oldBot], saut de ligne compris.
            if (oldBot + 1 < oldLines.length) {
                range = { startLineNumber: top + 1, startColumn: 1,
                          endLineNumber: oldBot + 2, endColumn: 1 };
            } else if (top > 0) {
                range = { startLineNumber: top, startColumn: _maxCol(oldLines[top - 1]),
                          endLineNumber: oldBot + 1, endColumn: _maxCol(oldLines[oldBot]) };
            } else {
                range = { startLineNumber: 1, startColumn: 1,
                          endLineNumber: oldBot + 1, endColumn: _maxCol(oldLines[oldBot]) };
            }
            text = '';
        }

        var changed = newEmpty ? 0 : (newBot - top + 1);
        return {
            range: range,
            text: text,
            startLine: top + 1,
            endLine: top + 1 + Math.max(0, changed - 1),
            changed: changed,
        };
    }

    // Application de référence sur une chaîne (fins de ligne LF).
    function apply(oldText, edit) {
        if (!edit) return String(oldText);
        var lines = String(oldText).split('\n');
        var r = edit.range;
        var offset = function (line, col) {
            var o = 0;
            for (var i = 0; i < line - 1; i++) o += lines[i].length + 1;
            return o + (col - 1);
        };
        var a = offset(r.startLineNumber, r.startColumn);
        var b = offset(r.endLineNumber, r.endColumn);
        return oldText.slice(0, a) + edit.text + oldText.slice(b);
    }

    return { compute: compute, apply: apply };
});
