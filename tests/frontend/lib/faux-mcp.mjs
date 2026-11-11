// SPDX-License-Identifier: MIT
/** tests/frontend/lib/faux-mcp.mjs — faux serveur MCP « Streamable HTTP » (JSON-RPC, réponses JSON) : outils déclarés par le test, appels et en-têtes journalisés */
import http from 'node:http';

function lireCorps(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => resolve(b));
    });
}

// Démarre le serveur ; `outils` : [{ name, description, inputSchema, _meta, reponse(args) → texte, delaiMs }].
export async function demarrerFauxMcp({ nom = 'faux-mcp', outils = [] } = {}) {
    const etat = { appels: [], entetes: [], methodes: [] };
    const serveur = http.createServer(async (req, res) => {
        etat.entetes.push(req.headers);
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
        let msg = null;
        try { msg = JSON.parse(await lireCorps(req)); } catch { msg = null; }
        const lot = Array.isArray(msg) ? msg : [msg];
        const sorties = [];
        for (const m of lot) {
            if (!m || typeof m.method !== 'string') continue;
            etat.methodes.push(m.method);
            if (m.id === undefined) continue;
            const ok = (result) => sorties.push({ jsonrpc: '2.0', id: m.id, result });
            if (m.method === 'initialize') ok({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: nom, version: '1.0.0' } });
            else if (m.method === 'tools/list') ok({ tools: outils.map(({ name, description, inputSchema, _meta }) => ({ name, description, inputSchema: inputSchema || { type: 'object', properties: {} }, ...(_meta ? { _meta } : {}) })) });
            else if (m.method === 'tools/call') {
                const o = outils.find((t) => t.name === (m.params && m.params.name));
                const args = (m.params && m.params.arguments) || {};
                etat.appels.push({ nom: m.params && m.params.name, args });
                if (o && o.delaiMs) await new Promise((r) => setTimeout(r, o.delaiMs));
                ok(o ? { content: [{ type: 'text', text: String(o.reponse ? o.reponse(args) : 'ok') }], isError: false } : { content: [{ type: 'text', text: 'outil inconnu' }], isError: true });
            } else if (m.method === 'ping') ok({});
            else sorties.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `méthode inconnue : ${m.method}` } });
        }
        if (!sorties.length) { res.writeHead(202); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-faux-mcp' });
        res.end(JSON.stringify(Array.isArray(msg) ? sorties : sorties[0]));
    });
    await new Promise((resolve) => serveur.listen(0, '127.0.0.1', resolve));
    const { port } = serveur.address();
    return {
        port,
        url: `http://127.0.0.1:${port}/mcp`,
        etat,
        arreter() { return new Promise((resolve) => { serveur.closeAllConnections(); serveur.close(() => resolve()); }); },
    };
}
