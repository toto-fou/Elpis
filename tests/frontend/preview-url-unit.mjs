// SPDX-License-Identifier: MIT
// Test unitaire hors-navigateur (node tests/frontend/preview-url-unit.mjs) du
// parseur d'adresse de l'aperçu « Serveur » de l'éditeur.
//
// Contexte : le mode serveur n'acceptait qu'un numéro de port dans un champ
// `type=number`, précédé d'un « localhost: » figé — impossible d'y coller une
// URL complète telle que l'affiche un serveur de dev. Le champ est désormais
// libre et `parsePreviewServerUrl` en dérive { port, path, host }.
//
// La fonction vit dans le setup Vue de app-editor.js : on l'EXTRAIT du source
// réel (pas une copie) pour que le test casse si l'implémentation dérive.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const APP_EDITOR = new URL('../../frontend/js/app-editor.js', import.meta.url);
const SRC = readFileSync(APP_EDITOR, 'utf8');

/** Découpe une déclaration `function <name>(…) { … }` en équilibrant les accolades. */
function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `fonction ${name} introuvable dans app-editor.js`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`accolades non équilibrées pour ${name}`);
}

const sandbox = { Number, String, RegExp };
vm.createContext(sandbox);
vm.runInContext(extractFunction(SRC, 'parsePreviewServerUrl'), sandbox);
const parse = sandbox.parsePreviewServerUrl;

let ok = 0;
// Le résultat naît dans le contexte vm : son prototype diffère de celui d'ici,
// ce qui suffirait à faire échouer deepEqual. On recompose donc l'objet, en
// vérifiant au passage qu'il n'expose ni clé manquante ni clé en trop.
const t = (raw, expected, why) => {
    const got = parse(raw);
    const ctx = `${why} — saisie: ${JSON.stringify(raw)}`;
    assert.deepEqual(Object.keys(got).sort(), ['host', 'path', 'port'],
                     `${ctx} — forme du retour`);
    assert.deepEqual({ port: got.port, path: got.path, host: got.host },
                     expected, ctx);
    ok++;
};

// ── Port nu : la saisie historique doit continuer de marcher ─────────────────
t('8080', { port: 8080, path: '/', host: '' }, 'port nu');
t('  3000  ', { port: 3000, path: '/', host: '' }, 'port nu entouré d’espaces');

// ── hôte:port, avec et sans chemin ──────────────────────────────────────────
t('localhost:8080', { port: 8080, path: '/', host: 'localhost' }, 'hôte:port');
t('localhost:8080/', { port: 8080, path: '/', host: 'localhost' }, 'hôte:port + /');
t('127.0.0.1:5000/api', { port: 5000, path: '/api', host: '127.0.0.1' }, 'IP:port/chemin');
t('0.0.0.0:8000/docs', { port: 8000, path: '/docs', host: '0.0.0.0' }, 'bind 0.0.0.0');

// ── URL complète collée depuis le terminal : le cas qui motivait le change ──
t('http://localhost:5173/app', { port: 5173, path: '/app', host: 'localhost' },
  'URL http complète');
t('https://localhost:8443/x', { port: 8443, path: '/x', host: 'localhost' },
  'schéma https retiré');
t('http://localhost:8000/docs?debug=1&v=2',
  { port: 8000, path: '/docs?debug=1&v=2', host: 'localhost' },
  'query string préservée (le proxy la retransmet)');

// ── Chemin seul : port courant conservé (port === null) ─────────────────────
t('/docs', { port: null, path: '/docs', host: '' }, 'chemin seul');
t('', { port: null, path: '/', host: '' }, 'saisie vide');
t('   ', { port: null, path: '/', host: '' }, 'espaces seuls');

// ── Hôte sans port : ne doit pas être pris pour un port ─────────────────────
t('localhost', { port: null, path: '/', host: 'localhost' }, 'hôte sans port');
t('http://localhost/x', { port: null, path: '/x', host: 'localhost' },
  'URL sans port explicite');

// ── IPv6 littéral ───────────────────────────────────────────────────────────
t('[::1]:8080/x', { port: 8080, path: '/x', host: '[::1]' }, 'IPv6 littéral');
t('http://[::1]:9000', { port: 9000, path: '/', host: '[::1]' }, 'IPv6 avec schéma');

// ── Ports hors bornes → null (l'appelant garde le port courant) ─────────────
t('0', { port: null, path: '/', host: '' }, 'port 0 rejeté');
t('70000', { port: null, path: '/', host: '' }, 'port > 65535 rejeté');
t('localhost:99999/x', { port: null, path: '/x', host: 'localhost' },
  'port hors bornes mais chemin conservé');

// ── Hôte distant : parsé et RENVOYÉ pour que l'UI puisse avertir que le
//    proxy vise toujours la sandbox, jamais cet hôte ────────────────────────
t('http://example.com:8080/x', { port: 8080, path: '/x', host: 'example.com' },
  'hôte distant remonté à l’appelant');

console.log(`preview-url-unit: ${ok} cas OK`);
