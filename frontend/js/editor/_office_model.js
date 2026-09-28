// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/editor/_office_model.js — logique PURE (sans Vue ni DOM) des visualiseurs
 * de l'éditeur : choix du mode de vue d'un fichier, détection binaire, calculs
 * de fenêtres de la grille xlsx, cache LRU, libellés d'erreur.
 *
 * Exposé sous UN seul espace de noms ``window.elpisOffice`` (pas de globales
 * éparses) et en CommonJS pour les tests node (tests/frontend/test_office_model.js).
 * La règle ``looksBinary`` doit rester alignée avec
 * ``shared_infra/sandbox/filetypes.py::looks_binary`` : le serveur refuse de
 * sauvegarder du texte par-dessus ce que cette fonction juge binaire.
 * Cf. docs/editor-office-preview-design-2026-09-15.md
 * ==========================================================================*/
(function (root) {
    "use strict";

    // ``.svg`` n'y figure PAS (2026-09-19) : c'est du texte, il s'ouvre en code
    // (éditable) avec son aperçu à côté — en visionneuse d'image, on ne
    // pouvait plus modifier le source.
    var IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'];

    // Aperçus Office / PDF (vue « office »).
    var OFFICE_EXTS = { '.docx': 'docx', '.pptx': 'pptx', '.xlsx': 'xlsx', '.pdf': 'pdf' };

    // Binaires connus : jamais dans Monaco (le texte décodé serait illisible
    // et une sauvegarde corromprait le fichier). Tout autre binaire est de
    // toute façon rattrapé à l'ouverture par ``looksBinary``.
    var HEX_EXTS = [
        '.bin', '.exe', '.so', '.dll', '.o', '.a', '.dylib', '.class', '.jar', '.dat', '.pyc', '.pyo', '.wasm',
        '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.zst', '.lz4', '.whl', '.iso', '.img',
        '.deb', '.rpm', '.apk',
        '.sqlite', '.sqlite3', '.db',
        '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.docm', '.xlsm', '.pptm', '.dotx', '.xltx', '.potx',
        '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.m4a', '.avi', '.mov', '.mkv', '.webm',
        '.ttf', '.otf', '.woff', '.woff2', '.eot',
        '.tif', '.tiff', '.heic', '.psd',
        '.gguf', '.safetensors', '.onnx', '.pt', '.pth', '.ckpt', '.pkl', '.npy', '.npz', '.parquet', '.h5',
    ];

    var SNIFF_BYTES = 8192;
    // Signatures binaires (même liste que filetypes.py::BINARY_MAGICS).
    var BINARY_MAGICS = [
        [0x25, 0x50, 0x44, 0x46, 0x2d],                     // %PDF-
        [0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], // zip
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],   // PNG
        [0xff, 0xd8, 0xff],                                 // JPEG
        [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
        [0x7f, 0x45, 0x4c, 0x46],                           // ELF
        [0x1f, 0x8b],                                       // gzip
        [0x42, 0x5a, 0x68],                                 // bz2
        [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],               // xz
        [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],               // 7z
        [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],               // Rar!
        [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],   // CFB
        [0xff, 0xfe], [0xfe, 0xff],                         // BOM UTF-16
    ];

    function extOf(path) {
        if (!path) return '';
        var m = String(path).toLowerCase().match(/\.[^./\\]+$/);
        return m ? m[0] : '';
    }

    function officeKind(path) {
        return OFFICE_EXTS[extOf(path)] || null;
    }

    function _has(set, key) {
        return !!(set && typeof set.has === 'function' && set.has(key));
    }

    /**
     * Mode de vue d'un chemin : 'image' | 'office' | 'docx' | 'hex' | 'monaco'.
     * opts.officeEnabled : drapeau global (défaut vrai) — coupé, docx retombe sur
     *   l'extraction texte historique et pptx/xlsx sur le visualiseur hex ;
     *   le PDF reste en 'office' (aucune conversion serveur).
     * opts.textFallback : Set des docx basculés à la demande sur le texte brut.
     * opts.binaryPaths  : Set des chemins reconnus binaires à l'ouverture.
     */
    function viewModeForPath(path, opts) {
        opts = opts || {};
        var ext = extOf(path);
        if (IMAGE_EXTS.indexOf(ext) >= 0) return 'image';
        var kind = OFFICE_EXTS[ext];
        if (kind === 'pdf') return 'office';
        if (kind) {
            if (opts.officeEnabled !== false && !_has(opts.textFallback, path)) return 'office';
            return kind === 'docx' ? 'docx' : 'hex';
        }
        if (HEX_EXTS.indexOf(ext) >= 0) return 'hex';
        if (_has(opts.binaryPaths, path)) return 'hex';
        return 'monaco';
    }

    // Modes sans modèle Monaco (rien à sauvegarder, rien à éditer).
    function isViewerMode(mode) {
        return mode === 'image' || mode === 'hex' || mode === 'office';
    }

    function _startsWith(u8, magic) {
        if (u8.length < magic.length) return false;
        for (var i = 0; i < magic.length; i++) if (u8[i] !== magic[i]) return false;
        return true;
    }

    /** Vrai si les premiers octets (Uint8Array) ne sont pas du texte éditable. */
    function looksBinary(u8) {
        if (!u8 || !u8.length) return false;
        var n = Math.min(u8.length, SNIFF_BYTES);
        for (var i = 0; i < n; i++) if (u8[i] === 0) return true;
        for (var j = 0; j < BINARY_MAGICS.length; j++) {
            if (_startsWith(u8, BINARY_MAGICS[j])) return true;
        }
        return false;
    }

    /** ``bytes 0-4095/123456`` → {start, end, total} ; total null si « * ». */
    function parseContentRange(header) {
        var m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(header || '').trim());
        if (!m) return null;
        return { start: +m[1], end: +m[2], total: m[3] === '*' ? null : +m[3] };
    }

    /** Index de colonne 0-based → lettres Excel (0 → A, 26 → AA). */
    function colName(i) {
        var n = Math.floor(i) + 1, s = '';
        while (n > 0) {
            var r = (n - 1) % 26;
            s = String.fromCharCode(65 + r) + s;
            n = Math.floor((n - 1) / 26);
        }
        return s;
    }

    /** Sommes de préfixes : out[i] = position gauche de la colonne i (out[n] = largeur totale). */
    function prefixSums(widths) {
        var out = [0];
        for (var i = 0; i < widths.length; i++) out.push(out[i] + widths[i]);
        return out;
    }

    function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /** Lignes visibles [start, end[ avec marge ``overscan``. */
    function rowWindow(scrollTop, viewportH, rowH, total, overscan) {
        overscan = overscan == null ? 8 : overscan;
        if (!total || rowH <= 0) return { start: 0, end: 0 };
        var first = Math.floor(Math.max(0, scrollTop) / rowH);
        var count = Math.ceil(Math.max(0, viewportH) / rowH) + 1;
        return {
            start: _clamp(first - overscan, 0, total),
            end: _clamp(first + count + overscan, 0, total),
        };
    }

    // Plus grand i tel que prefix[i] <= x (recherche dichotomique).
    function _floorIndex(prefix, x) {
        var lo = 0, hi = prefix.length - 1;
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (prefix[mid] <= x) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    /** Colonnes visibles [start, end[ d'après les sommes de préfixes. */
    function colWindow(scrollLeft, viewportW, prefix, overscan) {
        overscan = overscan == null ? 2 : overscan;
        var total = prefix.length - 1;
        if (total <= 0) return { start: 0, end: 0 };
        var left = Math.max(0, scrollLeft);
        var first = Math.min(_floorIndex(prefix, left), total - 1);
        var last = Math.min(_floorIndex(prefix, left + Math.max(0, viewportW)), total - 1);
        return {
            start: _clamp(first - overscan, 0, total),
            end: _clamp(last + 1 + overscan, 0, total),
        };
    }

    /** Morceaux (taille ``chunkSize``) couvrant les lignes [start, end[. */
    function chunksFor(start, end, chunkSize) {
        var out = [];
        if (end <= start || chunkSize <= 0) return out;
        for (var c = Math.floor(start / chunkSize); c * chunkSize < end; c++) out.push(c);
        return out;
    }

    /** LRU borné (Map : l'ordre d'insertion = ordre d'usage). */
    function createLru(max, onEvict) {
        var map = new Map();
        return {
            get: function (k) {
                if (!map.has(k)) return undefined;
                var v = map.get(k);
                map.delete(k); map.set(k, v);
                return v;
            },
            set: function (k, v) {
                if (map.has(k)) map.delete(k);
                map.set(k, v);
                while (map.size > max) {
                    var oldest = map.keys().next().value;
                    var ov = map.get(oldest);
                    map.delete(oldest);
                    if (onEvict) { try { onEvict(oldest, ov); } catch (_) {} }
                }
            },
            has: function (k) { return map.has(k); },
            delete: function (k) { return map.delete(k); },
            clear: function () { map.clear(); },
            keys: function () { return Array.from(map.keys()); },
            get size() { return map.size; },
        };
    }

    var ERROR_LABELS = {
        disabled: 'Aperçu désactivé',
        not_found: 'Fichier introuvable',
        too_large: 'Fichier trop lourd',
        unsupported: 'Format non pris en charge',
        invalid: 'Fichier illisible',
        encrypted: 'Fichier protégé',
        soffice_missing: 'LibreOffice absent',
        isolation_unavailable: 'Isolation indisponible',
        busy: 'Conversions occupées',
        timeout: 'Délai dépassé',
        expired: 'Aperçu expiré',
        failed: 'Conversion échouée',
        network: 'Erreur réseau',
    };

    function errorLabel(code) {
        return ERROR_LABELS[code] || ERROR_LABELS.failed;
    }

    var api = {
        IMAGE_EXTS: IMAGE_EXTS,
        OFFICE_EXTS: OFFICE_EXTS,
        HEX_EXTS: HEX_EXTS,
        SNIFF_BYTES: SNIFF_BYTES,
        extOf: extOf,
        officeKind: officeKind,
        viewModeForPath: viewModeForPath,
        isViewerMode: isViewerMode,
        looksBinary: looksBinary,
        parseContentRange: parseContentRange,
        colName: colName,
        prefixSums: prefixSums,
        rowWindow: rowWindow,
        colWindow: colWindow,
        chunksFor: chunksFor,
        createLru: createLru,
        errorLabel: errorLabel,
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.elpisOffice = api;
})(typeof window !== "undefined" ? window : this);
