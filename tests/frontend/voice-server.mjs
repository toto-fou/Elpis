// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le MOTEUR VOCAL (dictée + lecture) :
// gating par les drapeaux d'instance ET par les réglages utilisateur,
// insertion des énoncés À LA SUITE dans la zone de saisie sans envoi
// automatique, bouton « lire » par message, lecture automatique phrase par
// phrase pendant la génération, et silence sur une génération interrompue.
// Lancement : PERF_PORT=8930 node tests/frontend/voice-server.mjs
//
// - POST /__test/voice {...} : bascule drapeaux, réglages, mode d'échec.
// - GET  /__test/calls       : ce qui a été appelé (transcriptions, lectures).
// - POST /api/voice/transcribe : rend une phrase DIFFÉRENTE à chaque appel,
//   pour prouver la concaténation.
// - POST /api/voice/speak      : rend un WAV minuscule et journalise le texte.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8930);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

const etat = {
    voice_stt: true,
    voice_tts: true,
    voice_input_enabled: true,
    voice_reply_enabled: false,
    voice_reply_tools_enabled: false,
    transcribeStatus: 200,     // 502 pour simuler un service mort
    cancelled: false,          // le tour se termine en « interrompu »
    max_utterance_sec: 30,     // plafond annoncé par /api/voice/status
    scenario: 'simple',        // 'simple' | 'tools'
};
const appels = { transcribe: [], speak: [], status: 0, chatsNew: 0 };
let dernierChat = 0;
const PHRASES = ['Bonjour, ceci est un test.', 'Deuxième phrase.', 'Troisième phrase.'];

// WAV 16 kHz mono d'un échantillon : le verify bouchonne la lecture, seule
// la forme de la réponse compte.
function wavMinimal() {
    const donnees = Buffer.alloc(2);
    const entete = Buffer.alloc(44);
    entete.write('RIFF', 0); entete.writeUInt32LE(36 + donnees.length, 4);
    entete.write('WAVE', 8); entete.write('fmt ', 12);
    entete.writeUInt32LE(16, 16); entete.writeUInt16LE(1, 20); entete.writeUInt16LE(1, 22);
    entete.writeUInt32LE(16000, 24); entete.writeUInt32LE(32000, 28);
    entete.writeUInt16LE(2, 32); entete.writeUInt16LE(16, 34);
    entete.write('data', 36); entete.writeUInt32LE(donnees.length, 40);
    return Buffer.concat([entete, donnees]);
}
const WAV = wavMinimal();

function applyIncludes(html) {
    for (let i = 0; i < 8; i++) {
        let changed = false;
        html = html.replace(/<!--\s*@include\s+(\S+)\s*-->/g, (m, rel) => {
            changed = true;
            try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
            catch (e) { return `<!-- include manquant: ${rel} -->`; }
        });
        if (!changed) break;
    }
    return html;
}
function json(res, obj, status = 200) {
    res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj));
}
function corps(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
    });
}

// Un tour court, deux phrases : de quoi vérifier que la lecture démarre
// AVANT la fin de la génération.
const STREAM = [
    { type: 'content_token', text: 'Première phrase de la réponse. ' },
    { type: 'content_token', text: 'Seconde phrase de la réponse.' },
];

// Tour AGENTIQUE. Le point qui compte : dès qu'un tool_call est passé, le front
// route TOUS les content_token vers le tampon de pré-contenu — la narration
// comme la réponse finale. C'est ce canal-là que « Lire entre les outils »
// ouvre à la voix ; sans lui, un tour outillé reste muet jusqu'au 'final'.
const RESULTAT_OUTIL = JSON.stringify({
    ok: true, cmd: ['bash', '-c', 'pytest -q'], cwd: '/work',
    returncode: 0, truncated: false, duration_ms: 120,
    executor: 'docker.user.alice', stdout: '3 passed\n', stderr: '',
});
const STREAM_OUTILS = [
    { type: 'iteration', n: 1 },
    { type: 'tool_call', name: 'execute_shell', args: { command: 'pytest -q' }, call_id: 't1' },
    { type: 'content_token', text: 'Je lance les tests. ' },
    { type: 'tool_result', name: 'execute_shell', call_id: 't1', result: RESULTAT_OUTIL },
    { type: 'content_token', text: 'Première phrase de la réponse. ' },
    { type: 'content_token', text: 'Seconde phrase de la réponse.' },
];

function streamTurn(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const suite = etat.scenario === 'tools' ? STREAM_OUTILS : STREAM;
    // Comme le vrai backend : ``assistant`` est le texte COMPLET du tour,
    // narration d'étapes comprise.
    const complet = suite.filter((e) => e.type === 'content_token')
                         .map((e) => e.text).join('');
    let i = 0;
    const tick = () => {
        if (i >= suite.length) {
            try {
                res.write(JSON.stringify({
                    type: 'final', cancelled: etat.cancelled, persisted: true,
                    // Le serveur attribue son id au chat neuf EN FIN DE TOUR :
                    // c'est ce changement qui coupait le micro juste après
                    // l'envoi du premier message.
                    chat_id: 'c1',
                    assistant: complet,
                }) + '\n');
                res.end();
            } catch (_) {}
            return;
        }
        try { res.write(JSON.stringify(suite[i++]) + '\n'); } catch (_) { return; }
        setTimeout(tick, 160);
    };
    tick();
}

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    if (process.env.VOICE_LOG && url.startsWith('/api/')) console.log(req.method + ' ' + url);
    try {
        if (url === '/__test/voice' && req.method === 'POST') {
            Object.assign(etat, await corps(req));
            appels.transcribe = []; appels.speak = []; appels.status = 0; appels.chatsNew = 0;
            return json(res, { ok: true, etat });
        }
        if (url === '/__test/calls') return json(res, appels);

        if (url === '/api/voice/transcribe' && req.method === 'POST') {
            req.on('data', () => {});
            req.on('end', () => {
                if (etat.transcribeStatus !== 200) {
                    return json(res, { detail: 'Moteur vocal injoignable.' }, etat.transcribeStatus);
                }
                const texte = PHRASES[appels.transcribe.length % PHRASES.length];
                appels.transcribe.push(texte);
                json(res, { text: texte, duration_ms: 900 });
            });
            return;
        }
        if (url === '/api/voice/speak' && req.method === 'POST') {
            const b = await corps(req);
            appels.speak.push({ text: b.text || '', auto: !!b.auto });
            res.statusCode = 200;
            res.setHeader('content-type', 'audio/wav');
            res.end(WAV);
            return;
        }
        if (url === '/api/voice/status') {
            appels.status++;
            return json(res, {
                stt: etat.voice_stt, tts: etat.voice_tts,
                dictation: etat.voice_stt && etat.voice_input_enabled,
                reply: etat.voice_tts && etat.voice_reply_enabled,
                language: 'fr', sample_rate: 16000, max_utterance_sec: etat.max_utterance_sec,
                max_upload_mb: 10, max_chars: 4000, voice: 'fr_FR-siwis-medium',
            });
        }

        if (url === '/api/settings') {
            return json(res, {
                hide_thinking: false, live_shell_enabled: true,
                voice_input_enabled: etat.voice_input_enabled,
                voice_reply_enabled: etat.voice_reply_enabled,
                voice_reply_tools_enabled: etat.voice_reply_tools_enabled,
            });
        }
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {}); req.on('end', () => streamTurn(res));
            return;
        }
        if (url === '/api/public-config') {
            return json(res, {
                app_info: { name: 'Elpis' },
                features: { voice_stt: etat.voice_stt, voice_tts: etat.voice_tts },
            });
        }
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/saved/chats') return json(res, { items: [] });
        // Le VRAI serveur attribue l'identifiant du chat neuf PENDANT le tour,
        // entre le début de la génération et le premier token. Sans cette
        // route, le bouchon laissait ``currentChatId`` vide et la recette ne
        // pouvait pas voir qu'un watcher coupait la voix à cet instant.
        if (url === '/api/saved/chats/new' && req.method === 'POST') {
            req.on('data', () => {});
            appels.chatsNew++;
            return json(res, { id: 'c' + (++dernierChat), title: 'Essai' });
        }
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.write(': ping\n\n'); const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t)); return;
        }
        if (url.startsWith('/api/')) return json(res, {});

        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))); return;
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(fs.readFileSync(p));
    } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, '127.0.0.1', () => console.log(`voice-server sur http://127.0.0.1:${PORT}`));
