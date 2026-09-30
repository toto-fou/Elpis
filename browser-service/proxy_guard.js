// SPDX-License-Identifier: MIT
// ============================================================================
//  proxy_guard.js — relais HTTP local par lequel passe TOUT le trafic du
//  navigateur (2026-09-30).
// ============================================================================
//  Pourquoi : le routage Playwright (context.route) ne voit que la PREMIÈRE
//  requête d'une chaîne de redirections, et le navigateur résout lui-même les
//  noms. Une page pouvait donc atteindre la boucle locale ou le réseau interne
//  de l'hôte par une simple redirection, ou par un nom qui change d'adresse
//  entre la vérification et la connexion.
//
//  Ici, le navigateur est lancé avec ce relais comme proxy (boucle locale
//  comprise : ``--proxy-bypass-list=<-loopback>``). Pour chaque connexion —
//  requête http, tunnel CONNECT (https, wss), mise à niveau WebSocket — le
//  relais résout le nom LUI-MÊME, juge chaque adresse (``verifier``) et se
//  connecte à l'adresse jugée : redirections, sous-ressources, WebSocket et
//  changement d'adresse DNS passent tous par le même contrôle.
//
//  ``verifier(hote, port)`` → ``{ ok, adresse, motif }`` est injecté (tests
//  sans réseau ; en service : résolution DNS + url_guard.motifIp).
// ============================================================================
import http from 'http';
import net from 'net';

const _SAUT_PAR_SAUT = new Set(['proxy-connection', 'proxy-authorization', 'connection',
    'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function _hotePort(brut, portDefaut) {
    const s = String(brut || '');
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) || /^([^:]+)(?::(\d+))?$/.exec(s);
    if (!m) return null;
    const port = m[2] ? parseInt(m[2], 10) : portDefaut;
    if (!(port > 0 && port < 65536)) return null;
    return { hote: m[1].toLowerCase(), port };
}

function _pageRefus(motif) {
    const texte = `Adresse refusée par la politique du navigateur : ${motif}. `
        + 'Le navigateur ne peut joindre que des sites http/https hors de la machine qui héberge Elpis.';
    return `<!doctype html><meta charset="utf-8"><title>Adresse refusée</title><p>${texte
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;
}

/**
 * Démarre le relais sur 127.0.0.1 (port libre si ``port`` = 0).
 * → Promise<{ port, close() }>.
 */
export function demarrerRelais({ verifier, port = 0, journal = () => {} } = {}) {
    if (typeof verifier !== 'function') throw new Error('verifier requis');
    const serveur = http.createServer();

    async function juger(hote, port) {
        try {
            const v = await verifier(hote, port);
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
        const v = hp ? await juger(hp.hote, hp.port) : { ok: false, motif: 'adresse mal formée' };
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
        const amont = http.request({
            host: v.adresse, port: hp.port, method: req.method,
            path: cible.pathname + cible.search, headers: entetes, setHost: false,
        }, (r) => {
            const sortie = {};
            for (const [k, val] of Object.entries(r.headers)) {
                if (!_SAUT_PAR_SAUT.has(k.toLowerCase())) sortie[k] = val;
            }
            res.writeHead(r.statusCode || 502, r.statusMessage, sortie);
            r.pipe(res);
        });
        amont.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        // Le navigateur abandonne (onglet fermé, flux long coupé) : la
        // connexion amont ne doit pas lui survivre.
        res.on('close', () => { if (!amont.destroyed) amont.destroy(); });
        req.pipe(amont);
    });

    // Tunnels (https, wss) : CONNECT hote:port.
    serveur.on('connect', async (req, client, tete) => {
        // AVANT tout await : pendant l'événement, Node retire son propre
        // écouteur d'erreur du socket ; une coupure du client pendant le
        // jugement ferait sinon tomber tout le service.
        client.on('error', () => client.destroy());
        const hp = _hotePort(req.url, 443);
        const v = hp ? await juger(hp.hote, hp.port) : { ok: false, motif: 'adresse mal formée' };
        if (client.destroyed) return;
        if (!v.ok) {
            journal(`refus tunnel ${req.url} : ${v.motif}`);
            client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
            return;
        }
        const amont = net.connect(hp.port, v.adresse, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (tete && tete.length) amont.write(tete);
            amont.pipe(client);
            client.pipe(amont);
        });
        const fin = () => { amont.destroy(); client.destroy(); };
        amont.on('error', () => { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) {} fin(); });
        client.on('error', fin);
    });

    // ws:// sans tunnel : mise à niveau en forme absolue.
    serveur.on('upgrade', async (req, client, tete) => {
        client.on('error', () => client.destroy());      // avant tout await (cf. CONNECT)
        let cible;
        try { cible = new URL(req.url); } catch (_) { cible = null; }
        const hp = cible ? _hotePort(cible.host, 80) : null;
        const v = hp ? await juger(hp.hote, hp.port) : { ok: false, motif: 'adresse mal formée' };
        if (client.destroyed) return;
        if (!v.ok) { client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'); return; }
        const amont = net.connect(hp.port, v.adresse, () => {
            const lignes = [`${req.method} ${cible.pathname + cible.search} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const k = req.rawHeaders[i];
                if (/^proxy-/i.test(k)) continue;
                lignes.push(`${k}: ${req.rawHeaders[i + 1]}`);
            }
            amont.write(lignes.join('\r\n') + '\r\n\r\n');
            if (tete && tete.length) amont.write(tete);
            amont.pipe(client);
            client.pipe(amont);
        });
        const fin = () => { amont.destroy(); client.destroy(); };
        amont.on('error', fin);
        client.on('error', fin);
    });

    serveur.on('clientError', (_e, s) => { try { s.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });

    return new Promise((resolve, reject) => {
        serveur.once('error', reject);
        serveur.listen(port, '127.0.0.1', () => {
            resolve({ port: serveur.address().port, close: () => new Promise(r => serveur.close(() => r())) });
        });
    });
}

/**
 * Vérificateur de service : résout ``hote`` (sauf adresse littérale), juge
 * CHAQUE adresse avec ``motifIp`` et renvoie la première si toutes passent.
 * ``resoudre`` : ``async (nom) => [adresses]`` ; ``motifIp`` : ``(ip, nom) =>
 * motif|null``.
 */
export function verifierDepuisPolitique({ resoudre, motifIp, cacheMs = 10000, cacheNegatifMs = 5000,
                                         max = 2000, maintenant = () => Date.now() }) {
    // Verdicts par nom, courts (négatifs compris) : une page ouvre des dizaines
    // de connexions vers les mêmes hôtes, et un résolveur injoignable (site
    // hors ligne) occuperait sinon le pool de threads à chaque connexion. La
    // connexion se fait toujours à l'adresse JUGÉE, cache ou non.
    const cache = new Map();
    async function _juger(hote) {
        const litteral = net.isIP(hote) ? [hote] : null;
        let adresses;
        try { adresses = litteral || await resoudre(hote); } catch (_) {
            return { ok: false, motif: `nom introuvable (${hote})` };
        }
        if (!adresses || !adresses.length) return { ok: false, motif: `nom introuvable (${hote})` };
        for (const a of adresses) {
            const m = motifIp(a, hote);
            if (m) return { ok: false, motif: m };
        }
        return { ok: true, adresse: adresses[0] };
    }
    return async (hote, _port) => {
        const t = maintenant();
        const e = cache.get(hote);
        if (e && t < e.expire) return e.v;
        const v = await _juger(hote);
        if (cache.size >= max) cache.delete(cache.keys().next().value);
        cache.set(hote, { v, expire: t + (v.ok ? cacheMs : cacheNegatifMs) });
        return v;
    };
}
