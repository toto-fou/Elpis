// SPDX-License-Identifier: MIT
/** tests/frontend/lib/jobs-reel.mjs — tâches de fond contre le core TS réel : hôte d'outils simulé (arrêt, veille), routes internes `/api/internal/jobs*` (jeton de service, enveloppe signée), tour de premier niveau retenu pour enregistrer des jobs, événements de l'agent */
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { Client } from './core-reel.mjs';

export const JETON_SERVICE = 'jeton-de-service-du-harnais-jobs-0123456789';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Enveloppe d'identité `X-Elpis-Identity` : charge JSON en base64url, HMAC-SHA256 du jeton de service.
export function signerIdentite(uid, username, cle = JETON_SERVICE) {
    const charge = Buffer.from(JSON.stringify({ user_id: uid, username, roles: [], network_profile_id: '', chat_id: '', is_admin: false, ts: Date.now() / 1000 }), 'utf8');
    return `${charge.toString('base64url')}.${createHmac('sha256', cle).update(charge).digest().toString('base64url')}`;
}

// Hôte d'outils simulé : `kill` et `watch` du core ; `surKill(ids, par)` joue la réaction de l'agent (événement `killed`).
export async function demarrerFauxHote({ surKill = null } = {}) {
    const appels = [];
    const serveur = http.createServer((req, res) => {
        let corps = '';
        req.on('data', (c) => { corps += c; });
        req.on('end', async () => {
            let donnees = {};
            try { donnees = corps ? JSON.parse(corps) : {}; } catch { donnees = {}; }
            appels.push({ methode: req.method, url: req.url, corps: donnees });
            const rendre = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
            if (req.url === '/api/internal/jobs/kill') {
                const ids = donnees.job_ids || [];
                if (surKill) await surKill(ids, donnees.by, donnees.purge);
                return rendre({ ok: true, results: ids.map((id) => ({ job_id: id, killed_pids: [4242], state: 'killed' })) });
            }
            if (req.url === '/api/internal/jobs/watch') return rendre({ ok: true, watching: true });
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"detail":"route inconnue du faux hôte"}');
        });
    });
    await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${serveur.address().port}`,
        token: JETON_SERVICE,
        appels,
        arreter: () => new Promise((r) => { serveur.closeAllConnections(); serveur.close(() => r()); }),
    };
}

// Client des routes internes du core pour un compte (jeton de service + enveloppe signée), comme l'hôte d'outils.
export class Interne {
    constructor(urlMain, uid, username) { this.base = urlMain; this.uid = uid; this.username = username; this.seq = 0; }
    async req(methode, chemin, corps) {
        const r = await fetch(this.base + chemin, {
            method: methode,
            headers: { authorization: `Bearer ${JETON_SERVICE}`, 'x-elpis-identity': signerIdentite(this.uid, this.username), ...(corps === undefined ? {} : { 'content-type': 'application/json' }) },
            body: corps === undefined ? undefined : JSON.stringify(corps),
        });
        const texte = await r.text();
        if (!r.ok) throw new Error(`${methode} ${chemin} → ${r.status} ${texte.slice(0, 200)}`);
        return JSON.parse(texte);
    }
    // Enregistre un job (le tour de premier niveau doit être actif), attend le tour au besoin, puis le déclare lancé.
    async lancer(chatId, o = {}) {
        const corps = { chat_id: chatId, call_id: `call-${++this.seq}`, label: 'pytest', command: 'pytest -q', cwd: '', wake_on: ['exit'], resume_note: '', wake: true, ...o };
        let r = null;
        for (let i = 0; i < 100; i++) {
            r = await this.req('POST', '/api/internal/jobs', corps);
            if (r.ok || r.error !== 'not_available_here') break;
            await pause(100);
        }
        if (!r || !r.ok) throw new Error(`enregistrement refusé : ${JSON.stringify(r)}`);
        await this.req('POST', '/api/internal/jobs/state', { job_id: r.job_id, state: 'running', pid: 4242 });
        return r.job_id;
    }
    // Événement de l'agent du bac : `exit`, `match`… avec sa fin de journal.
    async evenement(jobId, o = {}) {
        const e = { seq: ++this.seq, job_id: jobId, ts: Date.now() / 1000, trigger: 'exit', spec: 'exit', state: 'exited', exit_code: 0, signal: null, duration_s: 3.2, line: null, context: null, tail: ['ok'], log_lines: 1, log_bytes: 3, by: null, still_running: false, ...o };
        return this.req('POST', '/api/internal/jobs/events', { events: [e], last_seq: e.seq });
    }
}

// Tour de premier niveau retenu sur la conversation `chat` ({ id, titre }) le temps de `fn` (faux moteur à barrière), puis relâché et attendu.
export async function pendantUnTour(core, api, chat, fn, { reponse = 'Tâche de fond lancée.' } = {}) {
    let liberer = () => {};
    const barriere = new Promise((r) => { liberer = r; });
    core.llm.scripter({ contenu: reponse, retenue: { apres: 2, promesse: barriere } });
    const flux = fetch(core.urlMain + '/api/chat-saved-stream3', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: [...api.cookies].map(([k, x]) => `${k}=${x}`).join('; ') },
        body: JSON.stringify({ messages: [{ role: 'user', content: `${chat.titre} : question 1` }], chat_id: chat.id, resumable: true }),
    }).then((r) => r.text()).catch(() => '');
    try {
        return await fn();
    } finally {
        liberer();
        await flux;
    }
}

// Nouvelle conversation d'alice, nommée, avec un échange enregistré.
export async function nouveauChat(api, titre) {
    const { id } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: titre, messages: [{ role: 'user', content: `${titre} : question 1` }, { role: 'assistant', content: `Réponse sur ${titre}.` }] });
    return { id, titre };
}

// Compte connecté et son identifiant interne (relu par les routes de profil).
export async function compteConnecte(urlMain, compte) {
    const c = new Client(urlMain);
    await c.req('POST', '/api/login-lite', compte);
    return c;
}
