// SPDX-License-Identifier: MIT
// url_guard.js — forme des adresses du navigateur dans le bac (module PUR) : http(s)/ws(s) et page vide ; la boucle locale du bac est jointe directement, tout le reste est jugé par le relais de l'hôte.
import net from 'net';

const _BOUCLE = new net.BlockList();
_BOUCLE.addSubnet('127.0.0.0', 8, 'ipv4');
_BOUCLE.addSubnet('::1', 128, 'ipv6');

/** IPv6 → ses 8 groupes de 16 bits (forme pointée finale comprise), ou null. */
function _groupes6(s) {
    if (net.isIP(s) !== 6) return null;
    let t = s.toLowerCase();
    const pointee = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
    if (pointee) {
        const o = pointee[1].split('.').map(Number);
        t = t.slice(0, -pointee[1].length)
            + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
    }
    const [tete, queue] = t.includes('::') ? t.split('::') : [t, null];
    const a = tete ? tete.split(':') : [];
    const b = queue ? queue.split(':') : [];
    const manque = queue === null ? 0 : 8 - a.length - b.length;
    const g = [...a, ...Array(Math.max(0, manque)).fill('0'), ...b].map(x => parseInt(x || '0', 16));
    return g.length === 8 && g.every(x => x >= 0 && x <= 0xffff) ? g : null;
}

/** IPv4 mappée en IPv6 (``::ffff:a.b.c.d`` comme ``::ffff:c0a8:128``) → ``a.b.c.d`` ; sinon l'adresse telle quelle (sans crochets ni zone). */
export function normaliserIp(ip) {
    const s = String(ip || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
    const g = _groupes6(s);
    if (g && g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
        return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    }
    return s;
}

function _type(ip) {
    const v = net.isIP(ip);
    return v === 4 ? 'ipv4' : v === 6 ? 'ipv6' : null;
}

/** Analyse syntaxique : ``{ ok, motif, url, hote, vide }`` ; ``vide`` = page vide (about:blank), toujours permise. */
export function analyserUrl(brut) {
    const s = String(brut || '').trim();
    if (!s) return { ok: false, motif: 'empty address' };
    if (/^about:blank$/i.test(s)) return { ok: true, vide: true, url: 'about:blank' };
    let u;
    try { u = new URL(s); } catch (_) { return { ok: false, motif: 'malformed address' }; }
    const schema = u.protocol.replace(/:$/, '').toLowerCase();
    if (schema !== 'http' && schema !== 'https' && schema !== 'ws' && schema !== 'wss') {
        return { ok: false, motif: `scheme not allowed (${schema}:): only http and https are` };
    }
    const hote = normaliserIp(u.hostname.toLowerCase());
    if (!hote) return { ok: false, motif: 'address without a host' };
    return { ok: true, url: u.href, hote };
}

/** Message renvoyé au modèle (et à l'utilisateur) pour une adresse refusée. */
export function messageRefus(url, motif) {
    return `Address refused by the browser policy: ${motif}. `
         + `URL: ${String(url || '').slice(0, 200)}. `
         + 'The browser reaches only http(s) sites allowed by the sandbox network profile and sites served inside the sandbox (localhost).';
}

/** Hôte de la boucle locale : adresse 127.0.0.0/8 ou ::1 (littérale), `localhost` ou `*.localhost`. */
export function estBoucleLocale(hote) {
    const h = normaliserIp(String(hote || '').toLowerCase());
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    const t = _type(h);
    return Boolean(t && _BOUCLE.check(h, t));
}

/** Vérificateur du relais local : boucle locale du bac jointe directement, sans résolution DNS ; tout le reste part au relais de l'hôte (``amont``), qui résout, juge et injecte les secrets. */
export function verifierBac() {
    return async (hote) => {
        if (!estBoucleLocale(hote)) return { ok: true, amont: true };
        const ip = normaliserIp(hote);
        return { ok: true, adresse: _type(ip) ? ip : '127.0.0.1' };
    };
}
