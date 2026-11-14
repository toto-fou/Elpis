// SPDX-License-Identifier: MIT
// ============================================================================
//  proxy_guard.js — relais HTTP local par lequel passe TOUT le trafic du
//  navigateur (2026-09-30).
// ============================================================================
//  Le navigateur est lancé avec ce relais comme proxy (boucle locale comprise :
//  ``--proxy-bypass-list=<-loopback>``) : chaque connexion — requête http,
//  tunnel CONNECT (https, wss), mise à niveau WebSocket — est jugée par
//  ``verifier(hote, port)`` → ``{ ok, adresse, amont, motif }`` (en service :
//  url_guard.verifierBac) ; la boucle locale du bac est jointe à l'adresse
//  jugée, tout le reste part au relais de l'hôte (``amont``), qui résout, juge
//  la destination et injecte les secrets.
// ============================================================================
import http from 'http';
import net from 'net';

const _SAUT_PAR_SAUT = new Set(['proxy-connection', 'proxy-authorization', 'connection',
    'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * En-têtes d'une réponse amont à rendre au navigateur, d'après ``rawHeaders``
 * (``[nom, valeur, nom, valeur…]``) : un en-tête répété le reste. ``r.headers``
 * de Node réunit les répétitions en une ligne (« Negotiate, NTLM ») ; pour
 * ``WWW-Authenticate``, le navigateur n'y reconnaît plus aucun schéma et
 * n'envoie jamais les identifiants (401 sans fin sur un site IIS/AD).
 */
export function entetesReponse(brut) {
    const sortie = Object.create(null);
    for (let i = 0; i + 1 < (brut || []).length; i += 2) {
        const k = String(brut[i]).toLowerCase();
        if (_SAUT_PAR_SAUT.has(k)) continue;
        if (k in sortie) sortie[k] = [].concat(sortie[k], brut[i + 1]);
        else sortie[k] = brut[i + 1];
    }
    return sortie;
}

// Une connexion amont PAR connexion du navigateur. L'agent global de Node
// partage ses connexions entre toutes les requêtes : une connexion
// authentifiée (NTLM, Negotiate : l'identité tient à la connexion) servait
// alors la requête suivante, d'où qu'elle vienne — y compris d'une autre
// session, sans identifiants. Et sans keep-alive (Node < 19), la poignée de
// main NTLM changeait de connexion à chaque étape et échouait.
const _agents = new WeakMap();
function _agentPour(socket) {
    let agent = _agents.get(socket);
    if (!agent) {
        agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        _agents.set(socket, agent);
        socket.once('close', () => agent.destroy());
    }
    return agent;
}

function _hotePort(brut, portDefaut) {
    const s = String(brut || '');
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) || /^([^:]+)(?::(\d+))?$/.exec(s);
    if (!m) return null;
    const port = m[2] ? parseInt(m[2], 10) : portDefaut;
    if (!(port > 0 && port < 65536)) return null;
    return { hote: m[1].toLowerCase(), port };
}

function _pageRefus(motif) {
    const texte = `Address refused by the browser policy: ${motif}. `
        + 'The browser reaches only http(s) sites allowed by the sandbox network profile and sites served inside the sandbox (localhost).';
    return `<!doctype html><meta charset="utf-8"><title>Address refused</title><p>${texte
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;
}

// En-tête d'authentification auprès du relais de l'hôte, ligne CRLF comprise ; vide sans jeton.
function _authAmont(amont) {
    return amont && amont.jeton ? `Proxy-Authorization: Bearer ${amont.jeton}\r\n` : '';
}

/**
 * Tunnel CONNECT ouvert par le relais de l'hôte (socket unix ``amont.socket``) : le socket établi,
 * ou un rejet portant la réponse brute du relais (``e.reponse``) s'il refuse.
 */
export function tunnelAmont(amont, cible) {
    return new Promise((resolve, reject) => {
        const s = net.connect(amont.socket);
        let tampon = Buffer.alloc(0);
        const echec = (e) => { s.destroy(); reject(e); };
        const lire = (d) => {
            tampon = Buffer.concat([tampon, d]);
            const fin = tampon.indexOf('\r\n\r\n');
            if (fin < 0) { if (tampon.length > 16384) echec(new Error('réponse du relais trop longue')); return; }
            s.off('data', lire);
            s.off('error', echec);
            const reste = tampon.subarray(fin + 4);
            if (/^HTTP\/1\.[01] 200/.test(tampon.subarray(0, fin).toString('latin1'))) {
                if (reste.length) s.unshift(reste);
                return resolve(s);
            }
            s.destroy();
            reject(Object.assign(new Error('tunnel refusé par le relais'), { reponse: tampon }));
        };
        s.on('data', lire);
        s.once('error', echec);
        s.write(`CONNECT ${cible} HTTP/1.1\r\nHost: ${cible}\r\n${_authAmont(amont)}\r\n`);
    });
}

/**
 * Démarre le relais sur 127.0.0.1 (port libre si ``port`` = 0).
 * ``amont`` : ``{ socket, jeton }`` du relais de l'hôte, où partent les connexions que
 * ``verifier`` marque ``amont: true``.
 * → Promise<{ port, close() }>.
 */
export function demarrerRelais({ verifier, port = 0, journal = () => {}, amont = null } = {}) {
    if (typeof verifier !== 'function') throw new Error('verifier requis');
    const serveur = http.createServer();

    async function juger(hote, port) {
        try {
            const v = await verifier(hote, port);
            if (v && v.ok && v.amont && amont) return v;
            return v && v.ok && v.adresse ? v : { ok: false, motif: (v && v.motif) || 'destination refusée' };
        } catch (e) {
            return { ok: false, motif: 'vérification impossible' };
        }
    }

    // Requêtes http en clair (forme absolue : GET http://hote:port/chemin).
    serveur.on('request', async (req, res) => {
        req.on('error', () => {});      // client parti pendant le jugement : rien à faire
        let cible;
        try { cible = new URL(req.url); } catch (_) { cible = null; }
        if (!cible || cible.protocol !== 'http:') {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end('Requête de proxy invalide.');
        }
        const hp = _hotePort(cible.host, 80);
        const v = hp ? await juger(hp.hote, hp.port) : { ok: false, motif: 'malformed address' };
        if (!v.ok) {
            journal(`refus http ${cible.host} : ${v.motif}`);
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(_pageRefus(v.motif));
        }
        const entetes = {};
        for (const [k, val] of Object.entries(req.headers)) {
            if (!_SAUT_PAR_SAUT.has(k.toLowerCase())) entetes[k] = val;
        }
        entetes.host = cible.host;
        if (v.amont && amont.jeton) entetes['proxy-authorization'] = `Bearer ${amont.jeton}`;
        const destination = v.amont
            ? { socketPath: amont.socket, path: cible.href }
            : { host: v.adresse, port: hp.port, path: cible.pathname + cible.search };
        const sortant = http.request({
            ...destination, method: req.method, headers: entetes, setHost: false,
            agent: _agentPour(req.socket),
        }, (r) => {
            res.writeHead(r.statusCode || 502, r.statusMessage, entetesReponse(r.rawHeaders));
            r.pipe(res);
        });
        sortant.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        // Le navigateur abandonne (onglet fermé, flux long coupé) : la
        // connexion amont ne doit pas lui survivre.
        res.on('close', () => { if (!sortant.destroyed) sortant.destroy(); });
        req.pipe(sortant);
    });

    // Tunnels (https, wss) : CONNECT hote:port.
    serveur.on('connect', async (req, client, tete) => {
        // AVANT tout await : pendant l'événement, Node retire son propre
        // écouteur d'erreur du socket ; une coupure du client pendant le
        // jugement ferait sinon tomber tout le service.
        client.on('error', () => client.destroy());
        const hp = _hotePort(req.url, 443);
        const v = hp ? await juger(hp.hote, hp.port) : { ok: false, motif: 'malformed address' };
        if (client.destroyed) return;
        if (!v.ok) {
            journal(`refus tunnel ${req.url} : ${v.motif}`);
            client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
            return;
        }
        if (v.amont) {
            let s;
            try { s = await tunnelAmont(amont, `${hp.hote.includes(':') ? `[${hp.hote}]` : hp.hote}:${hp.port}`); }
            catch (e) {
                if (!client.destroyed) client.end(e.reponse || 'HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
                return;
            }
            if (client.destroyed) return s.destroy();
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (tete && tete.length) s.write(tete);
            s.pipe(client);
            client.pipe(s);
            const coupe = () => { s.destroy(); client.destroy(); };
            s.on('error', coupe);
            client.on('error', coupe);
            client.on('close', coupe);
            s.on('close', coupe);
            return;
        }
        const direct = net.connect(hp.port, v.adresse, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (tete && tete.length) direct.write(tete);
            direct.pipe(client);
            client.pipe(direct);
        });
        const fin = () => { direct.destroy(); client.destroy(); };
        direct.on('error', () => { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) {} fin(); });
        client.on('error', fin);
    });

    // ws:// sans tunnel : mise à niveau en forme absolue.
    serveur.on('upgrade', async (req, client, tete) => {
        client.on('error', () => client.destroy());      // avant tout await (cf. CONNECT)
        let cible;
        try { cible = new URL(req.url); } catch (_) { cible = null; }
        const hp = cible ? _hotePort(cible.host, 80) : null;
        const v = hp ? await juger(hp.hote, hp.port) : { ok: false, motif: 'malformed address' };
        if (client.destroyed) return;
        if (!v.ok) { client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'); return; }
        const relaye = Boolean(v.amont);
        const ouvrir = (fn) => relaye ? net.connect(amont.socket, fn) : net.connect(hp.port, v.adresse, fn);
        const amontWs = ouvrir(() => {
            const lignes = [`${req.method} ${relaye ? cible.href : cible.pathname + cible.search} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const k = req.rawHeaders[i];
                if (/^proxy-/i.test(k)) continue;
                lignes.push(`${k}: ${req.rawHeaders[i + 1]}`);
            }
            if (relaye && amont.jeton) lignes.push(`Proxy-Authorization: Bearer ${amont.jeton}`);
            amontWs.write(lignes.join('\r\n') + '\r\n\r\n');
            if (tete && tete.length) amontWs.write(tete);
            amontWs.pipe(client);
            client.pipe(amontWs);
        });
        const fin = () => { amontWs.destroy(); client.destroy(); };
        amontWs.on('error', fin);
        client.on('error', fin);
    });

    serveur.on('clientError', (_e, s) => { try { s.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });
    // Connexions ouvertes (tunnels compris), coupées à la fermeture du relais.
    const ouvertes = new Set();
    serveur.on('connection', (c) => { ouvertes.add(c); c.once('close', () => ouvertes.delete(c)); });

    return new Promise((resolve, reject) => {
        serveur.once('error', reject);
        serveur.listen(port, '127.0.0.1', () => {
            resolve({ port: serveur.address().port, close: () => new Promise(r => { serveur.close(() => r()); for (const c of ouvertes) c.destroy(); }) });
        });
    });
}
