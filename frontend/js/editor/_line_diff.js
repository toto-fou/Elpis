// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/editor/_line_diff.js — différences de LIGNES, logique pure (sans Vue ni
 * Monaco), testée sous node (tests/frontend/test_line_diff.js).
 *
 *   hunks(avant, après) → [{ type: 'add' | 'mod' | 'del', start, end }]
 *       Lignes 1-indexées dans « après » : ce que la marge de l'éditeur
 *       marque par rapport à la dernière version commitée (HEAD).
 *       'del' : des lignes ont disparu JUSTE AVANT ``start`` (start = end ;
 *       start = n + 1 si la suppression est en fin de fichier).
 *
 * Préfixe et suffixe communs sont retirés d'abord (une modification courante
 * touche une zone locale) ; le milieu passe par une LCS classique tant que la
 * matrice reste raisonnable, sinon il est marqué d'un bloc « modifié ».
 * ==========================================================================*/
(function (root) {
    "use strict";

    var MAX_CELLS = 4000000;       // ≈ 2000 × 2000 lignes : ~16 Mo d'Int32

    function hunks(a, b) {
        a = a || [];
        b = b || [];
        var n = a.length, m = b.length;
        var top = 0;
        while (top < n && top < m && a[top] === b[top]) top++;
        var ea = n - 1, eb = m - 1;
        while (ea >= top && eb >= top && a[ea] === b[eb]) { ea--; eb--; }
        var A = a.slice(top, ea + 1), B = b.slice(top, eb + 1);
        var out = [];
        if (!A.length && !B.length) return out;
        if (!A.length) return [{ type: 'add', start: top + 1, end: top + B.length }];
        if (!B.length) return [{ type: 'del', start: top + 1, end: top + 1 }];
        if (A.length * B.length > MAX_CELLS) {
            return [{ type: 'mod', start: top + 1, end: top + B.length }];
        }
        // LCS bottom-up puis parcours : suite d'opérations =, -, +.
        var N = A.length, M = B.length, W = M + 1;
        var dp = new Int32Array((N + 1) * W);
        for (var i = N - 1; i >= 0; i--) {
            for (var j = M - 1; j >= 0; j--) {
                dp[i * W + j] = A[i] === B[j]
                    ? dp[(i + 1) * W + j + 1] + 1
                    : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
            }
        }
        // Regroupe les opérations en blocs entre deux lignes identiques :
        // (suppr > 0, ajout > 0) → modifié ; ajout seul → ajouté ; suppr
        // seule → marque de suppression.
        var ii = 0, jj = 0, del = 0, add = 0, blockStart = 0;
        function flush() {
            if (!del && !add) return;
            if (add && del) out.push({ type: 'mod', start: top + blockStart + 1, end: top + blockStart + add });
            else if (add)   out.push({ type: 'add', start: top + blockStart + 1, end: top + blockStart + add });
            else            out.push({ type: 'del', start: top + blockStart + 1, end: top + blockStart + 1 });
            del = 0; add = 0;
        }
        while (ii < N || jj < M) {
            if (ii < N && jj < M && A[ii] === B[jj]) {
                flush();
                ii++; jj++;
                blockStart = jj;
            } else if (jj >= M || (ii < N && dp[(ii + 1) * W + jj] >= dp[ii * W + jj + 1])) {
                if (!del && !add) blockStart = jj;
                del++; ii++;
            } else {
                if (!del && !add) blockStart = jj;
                add++; jj++;
            }
        }
        flush();
        return out;
    }

    // Découpe un texte en lignes (fins de ligne \n, \r\n ou \r).
    function lines(text) {
        return String(text == null ? '' : text).split(/\r\n|\r|\n/);
    }

    var api = { hunks: hunks, lines: lines, MAX_CELLS: MAX_CELLS };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.elpisLineDiff = api;
})(typeof window !== "undefined" ? window : this);
