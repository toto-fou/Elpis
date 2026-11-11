// SPDX-License-Identifier: MIT
// test/aides/service.js — vrai service navigateur des essais d'intégration : dossier temporaire, port libre, garde ouverte à 127.0.0.1 seulement pour l'essai.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GARDE_BOUCLE = pathToFileURL(path.join(SERVICE, 'test', 'aides', 'garde_boucle.mjs')).href;
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

// Service démarré et prêt (/health) : base, appels JSON, journal et arrêt (dossier temporaire supprimé).
export async function demarrerService({ env = {}, jeton = env.BROWSER_SERVICE_TOKEN || '' } = {}) {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-pw-essai-'));
    const port = await portLibre();
    const base = `http://127.0.0.1:${port}`;
    let journal = '';
    const auth = jeton ? { Authorization: `Bearer ${jeton}` } : {};
    const enfant = spawn(process.execPath, ['--import', NEUTRE_PS, '--import', GARDE_BOUCLE, path.join(SERVICE, 'server.js')], {
        cwd: dossier,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env, FIREFOX_SERVICE_PORT: String(port), FIREFOX_SERVICE_HOST: '127.0.0.1',
            APP_CONFIG_PATH: path.join(dossier, 'config-absente.json'),
            BROWSER_URL_ALLOWLIST: '', ...env,
        },
    });
    enfant.stdout.on('data', (d) => { journal += d; });
    enfant.stderr.on('data', (d) => { journal += d; });
    const appel = async (methode, route, corps) => {
        const r = await fetch(`${base}${route}`, methode === 'GET' ? { headers: auth } : {
            method: methode, headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(corps ?? {}),
        });
        const texte = await r.text();
        let json = null;
        try { json = JSON.parse(texte); } catch (_) { /* corps non JSON */ }
        return { statut: r.status, corps: json, texte };
    };
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
        try { if ((await (await fetch(`${base}/health`, { headers: auth })).json()).ok) break; } catch (_) { /* pas encore prêt */ }
        if (Date.now() > limite) { await arreter(); throw new Error(`service muet après 20 s : ${journal}`); }
        await new Promise(r => setTimeout(r, 200));
    }
    return {
        base,
        journal: () => journal,
        post: (route, corps) => appel('POST', route, corps),
        get: (route) => appel('GET', route),
        arreter,
    };
}
