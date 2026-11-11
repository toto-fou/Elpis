// SPDX-License-Identifier: MIT
/** tests/frontend/lib/faux-images.mjs — faux moteur d'images « OpenAI-compatible » (/v1/models, /v1/images/generations) : génération tenue par une barrière, images PNG en b64_json. */
import http from 'node:http';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function lireCorps(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => resolve(b));
    });
}

// `retenir()` pose une barrière : la prochaine génération attend `ouvrir()` ; `appels` garde les requêtes reçues.
export async function demarrerFauxImages() {
    const etat = { appels: [] };
    let barriere = null;
    const serveur = http.createServer(async (req, res) => {
        const chemin = req.url.split('?')[0];
        if (req.method === 'GET' && chemin.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'm', object: 'model' }] }));
            return;
        }
        if (req.method === 'POST' && chemin.endsWith('/images/generations')) {
            let corps = {};
            try { corps = JSON.parse(await lireCorps(req)); } catch { corps = {}; }
            etat.appels.push(corps);
            if (barriere) await barriere.promesse;
            const n = Math.max(1, Number(corps.n) || 1);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ created: 1, data: Array.from({ length: n }, () => ({ b64_json: PNG })) }));
            return;
        }
        res.writeHead(404); res.end();
    });
    await new Promise((resolve) => serveur.listen(0, '127.0.0.1', resolve));
    const { port } = serveur.address();
    return {
        url: `http://127.0.0.1:${port}/v1`,
        etat,
        retenir() { let ouvrir; const promesse = new Promise((r) => { ouvrir = r; }); barriere = { promesse }; return () => { barriere = null; ouvrir(); }; },
        arreter() { return new Promise((resolve) => { serveur.closeAllConnections(); serveur.close(() => resolve()); }); },
    };
}
