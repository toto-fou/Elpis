// SPDX-License-Identifier: MIT
// Test d'intégration OPT-IN du browser-service (Playwright réel + réseau).
//
// POURQUOI OPT-IN : ce test démarre le VRAI serveur (server.js), lance un
// navigateur Chromium headless et atteint un site public
// (the-internet.herokuapp.com). Il est donc LENT (10-40s pour le cas digest),
// dépend du réseau et d'un navigateur installé. Il n'a rien à faire dans la
// CI par défaut ni dans un `npm test` rapide/hors-ligne.
//
// → Il est SKIPPÉ par défaut. On ne l'exécute (et on ne spawn le serveur) que
//   lorsque la variable d'environnement BROWSER_SERVICE_LIVE vaut '1' :
//
//       BROWSER_SERVICE_LIVE=1 node --test test/digest_auth.integration.test.js
//
// Ce qu'il valide (cas métier) :
//   1. Auth HTTP Digest : /start avec username/password (httpCredentials au
//      niveau du contexte Playwright) sur la page digest_auth, puis
//      /extract_text doit contenir le message de succès « Congratulations ».
//   2. Erreur de navigation propre : un goto vers un port refusé doit renvoyer
//      un 502 nav_error explicite (et NON un 500 opaque). Garde-fou du bugfix.
//
// Aucune dépendance externe : uniquement node:test, node:assert, node:child_process,
// node:url, node:path et le `fetch` global (Node 20).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LIVE = process.env.BROWSER_SERVICE_LIVE === '1';

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.BROWSER_SERVICE_TEST_PORT || '3997', 10);
const BASE = `http://${HOST}:${PORT}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'server.js');

let child = null;

// ── Helpers réseau ───────────────────────────────────────────────────────
function api(pathname, body) {
    return fetch(`${BASE}${pathname}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
}

async function waitForHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`${BASE}/health`);
            if (r.ok) {
                const j = await r.json();
                if (j && j.ok === true) return;
            }
        } catch (e) {
            lastErr = e;
        }
        await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(
        `Serveur pas prêt après ${timeoutMs}ms (dernier essai: ${lastErr ? lastErr.message : '?'})`,
    );
}

// ── Cycle de vie : NO-OP hors mode live (on ne spawn JAMAIS le serveur) ────
before(async () => {
    if (!LIVE) return;
    child = spawn(process.execPath, [SERVER_PATH], {
        stdio: 'ignore',
        env: {
            ...process.env,
            FIREFOX_SERVICE_PORT: String(PORT),
            FIREFOX_SERVICE_HOST: HOST,
            PLAYWRIGHT_HEADLESS: 'true',
        },
    });
    child.on('error', (e) => {
        console.error('[itest] échec spawn server.js:', e.message);
    });
    // Boot Chromium : laisser de la marge (~20s).
    await waitForHealth(20000);
});

after(async () => {
    if (child && !child.killed) {
        child.kill('SIGTERM');
        // Laisser le process se fermer proprement.
        await new Promise((res) => {
            const t = setTimeout(res, 3000);
            child.on('exit', () => {
                clearTimeout(t);
                res();
            });
        });
        if (!child.killed) {
            try { child.kill('SIGKILL'); } catch {}
        }
    }
    child = null;
});

// ── Cas 1 : auth HTTP Digest (cas métier) ──────────────────────────────────
test(
    'Digest auth: /start + /extract_text affiche le message de succès',
    { skip: LIVE ? false : 'set BROWSER_SERVICE_LIVE=1 to run', timeout: 120000 },
    async () => {
        const startRes = await api('/start', {
            url: 'https://the-internet.herokuapp.com/digest_auth',
            username: 'admin',
            password: 'admin',
            headless: true,
            isolated: true,
        });
        assert.equal(startRes.status, 200, `POST /start a renvoyé ${startRes.status}`);
        const started = await startRes.json();
        assert.equal(started.status, 'started');
        assert.ok(started.session_id, 'session_id manquant');

        const textRes = await api('/extract_text', { session_id: started.session_id });
        assert.equal(textRes.status, 200, `POST /extract_text a renvoyé ${textRes.status}`);
        const payload = await textRes.json();
        const text = payload.text ?? payload.content ?? '';
        assert.match(
            text,
            /Congratulations/i,
            `Le texte de la page ne confirme pas l'auth digest. Reçu: ${JSON.stringify(text).slice(0, 300)}`,
        );
    },
);

// ── Cas 2 : erreur de navigation → 502 nav_error propre (garde-fou bugfix) ──
test(
    'Navigation vers un port refusé → 502 nav_error (pas de 500 opaque)',
    { skip: LIVE ? false : 'set BROWSER_SERVICE_LIVE=1 to run', timeout: 120000 },
    async () => {
        // Session neuve et isolée sur about:blank.
        const startRes = await api('/start', {
            url: 'about:blank',
            headless: true,
            isolated: true,
        });
        assert.equal(startRes.status, 200, `POST /start a renvoyé ${startRes.status}`);
        const started = await startRes.json();
        assert.equal(started.status, 'started');
        assert.ok(started.session_id, 'session_id manquant');

        // goto vers un port refusé → doit échouer proprement.
        const actRes = await api('/action', {
            session_id: started.session_id,
            type: 'goto',
            url: 'http://127.0.0.1:1',
        });
        assert.equal(actRes.status, 502, `attendu 502, reçu ${actRes.status}`);
        const body = await actRes.json();
        assert.equal(body.status, 'nav_error');
        assert.match(
            body.error,
            /127\.0\.0\.1:1/,
            `error devrait mentionner la cible. Reçu: ${JSON.stringify(body.error)}`,
        );
    },
);
