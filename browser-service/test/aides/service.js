// SPDX-License-Identifier: MIT
// test/aides/service.js — vrai service navigateur des essais d'intégration : dossier temporaire, socket unix et jeton comme dans le bac.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVEUR = path.join(SERVICE, 'server.js');
export const NEUTRE_PS = pathToFileURL(path.join(SERVICE, 'test', 'aides', 'neutre_ps.mjs')).href;

export async function portLibre() {
    const srv = net.createServer();
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    await new Promise(r => srv.close(r));
    return port;
}

// Raison de sauter un essai : dépendances du service ou headless shell de Chromium absents ; false s'il peut tourner, toute autre erreur de lancement remonte.
export async function raisonDeSauter() {
    if (!['express', 'playwright'].every(m => fs.existsSync(path.join(SERVICE, 'node_modules', m)))) {
        return 'dépendances du service absentes (npm ci)';
    }
    const { chromium } = await import(pathToFileURL(path.join(SERVICE, 'node_modules', 'playwright', 'index.mjs')).href);
    try { await (await chromium.launch({ headless: true })).close(); return false; }
    catch (e) {
        if (/Executable doesn't exist/.test(String(e?.message))) return 'headless shell de Chromium absent (PLAYWRIGHT_BROWSERS_PATH)';
        throw e;
    }
}

// Requête HTTP au service par son socket : statut, corps JSON (null sinon), texte et en-têtes.
export function requeteSocket(socket, methode, route, { corps, entetes = {} } = {}) {
    return new Promise((resolve, reject) => {
        const charge = methode === 'GET' ? null : JSON.stringify(corps ?? {});
        const rq = http.request({ socketPath: socket, path: route, method: methode,
            headers: { host: 'browser', ...(charge === null ? {} : { 'Content-Type': 'application/json' }), ...entetes } }, (r) => {
            const morceaux = [];
            r.on('data', (m) => morceaux.push(m));
            r.on('end', () => {
                const texte = Buffer.concat(morceaux).toString('utf8');
                let json = null;
                try { json = JSON.parse(texte); } catch (_) { /* corps non JSON */ }
                resolve({ statut: r.statusCode, corps: json, texte, entetes: r.headers });
            });
            r.on('error', reject);
        });
        rq.on('error', reject);
        rq.end(charge ?? undefined);
    });
}

// Service démarré et prêt (/health) dans un dossier temporaire (son dossier courant, comme /work/.elpis-browser) : appels JSON, journal et arrêt (dossier supprimé).
export async function demarrerService({ env = {}, jeton = env.BROWSER_SERVICE_TOKEN || crypto.randomBytes(16).toString('hex') } = {}) {
    const dossier = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-pw-essai-')));
    const socket = path.join(dossier, 'browser.sock');
    let journal = '';
    const auth = { Authorization: `Bearer ${jeton}` };
    const enfant = spawn(process.execPath, ['--import', NEUTRE_PS, SERVEUR], {
        cwd: dossier,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FIREFOX_SERVICE_SOCKET: socket, BROWSER_RELAY_SOCKET: path.join(dossier, 'relais-absent.sock'),
               ...env, BROWSER_SERVICE_TOKEN: jeton },
    });
    enfant.stdout.on('data', (d) => { journal += d; });
    enfant.stderr.on('data', (d) => { journal += d; });
    const appel = (methode, route, corps) => requeteSocket(socket, methode, route, { corps, entetes: auth });
    const arreter = async () => {
        if (enfant.exitCode === null) {
            enfant.kill('SIGTERM');
            await new Promise(r => { const t = setTimeout(r, 8000); enfant.on('exit', () => { clearTimeout(t); r(); }); });
            try { enfant.kill('SIGKILL'); } catch (_) { /* déjà arrêté */ }
        }
        fs.rmSync(dossier, { recursive: true, force: true });
    };
    const limite = Date.now() + 20000;
    for (;;) {
        if (enfant.exitCode !== null) { await arreter(); throw new Error(`service arrêté (${enfant.exitCode}) : ${journal}`); }
        try { if ((await appel('GET', '/health')).corps?.ok) break; } catch (_) { /* pas encore prêt */ }
        if (Date.now() > limite) { await arreter(); throw new Error(`service muet après 20 s : ${journal}`); }
        await new Promise(r => setTimeout(r, 200));
    }
    return {
        dossier,
        socket,
        jeton,
        journal: () => journal,
        post: (route, corps) => appel('POST', route, corps),
        get: (route) => appel('GET', route),
        brute: (methode, route, options) => requeteSocket(socket, methode, route, options),
        arreter,
    };
}
