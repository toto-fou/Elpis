// SPDX-License-Identifier: MIT
// ============================================================================
//  url_guard.js — destinations autorisées pour le navigateur (module PUR).
// ============================================================================
//  Le navigateur tourne sur l'hôte d'Elpis : ce qu'il peut joindre, l'hôte le
//  peut. Politique (décision D-A1) :
//    - schémas http/https seulement (plus about:blank, page vide) ;
//    - jamais la boucle locale, le lien-local (dont les services de
//      métadonnées), les adresses non spécifiées ou de diffusion, les
//      adresses de l'hôte lui-même, ni les réseaux de conteneurs de l'hôte ;
//    - le réseau local est autorisé par défaut ; une liste blanche
//      optionnelle (`browser.url_allowlist`) le restreint aux hôtes et
//      réseaux nommés ;
//    - un nom d'hôte est jugé sur les adresses qu'il RÉSOUT (un nom public
//      qui pointe vers la boucle locale est refusé comme elle).
//  Aucune dépendance hors Node : testable par `node --test`, la résolution
//  DNS et les interfaces de l'hôte sont injectées.
// ============================================================================
import net from 'net';

// Réseaux jamais joignables, quelle que soit la liste blanche.
const _TOUJOURS_REFUSES = [
    ['0.0.0.0', 8, 'ipv4'],          // « ce réseau », dont 0.0.0.0
    ['127.0.0.0', 8, 'ipv4'],        // boucle locale
    ['169.254.0.0', 16, 'ipv4'],     // lien-local, dont 169.254.169.254 (métadonnées)
    ['224.0.0.0', 4, 'ipv4'],        // multidiffusion
    ['240.0.0.0', 4, 'ipv4'],        // réservé, dont 255.255.255.255
    ['::', 128, 'ipv6'],             // non spécifiée
    ['::1', 128, 'ipv6'],            // boucle locale
    ['fe80::', 10, 'ipv6'],          // lien-local
    ['ff00::', 8, 'ipv6'],           // multidiffusion
    ['fd00:ec2::254', 128, 'ipv6'],  // métadonnées (IPv6)
];

// Réseaux « locaux » : autorisés par défaut, soumis à la liste blanche.
const _RESEAUX_LOCAUX = [
    ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
    ['100.64.0.0', 10, 'ipv4'],      // CGNAT
    ['fc00::', 7, 'ipv6'],           // adresses uniques locales
];

// Interfaces de conteneurs et de ponts virtuels : leurs sous-réseaux sont ceux
// des services de l'hôte (bases, sandboxes d'autres comptes…).
const _INTERFACES_CONTENEURS = /^(docker|br-|veth|virbr|cni|flannel|podman|lxc|lxd|incus|vnet|kube)/;

function _liste(reseaux) {
    const b = new net.BlockList();
    for (const [adr, pre, type] of reseaux) b.addSubnet(adr, pre, type);
    return b;
}
const _REFUSES = _liste(_TOUJOURS_REFUSES);
const _LOCAUX = _liste(_RESEAUX_LOCAUX);

/** ``::ffff:a.b.c.d`` → ``a.b.c.d`` ; sinon l'adresse telle quelle. */
export function normaliserIp(ip) {
    const s = String(ip || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
    const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
    return m ? m[1] : s;
}

function _type(ip) {
    const v = net.isIP(ip);
    return v === 4 ? 'ipv4' : v === 6 ? 'ipv6' : null;
}

function _cidr(entree) {
    const m = /^(.+)\/(\d{1,3})$/.exec(entree);
    if (!m) return null;
    const adr = normaliserIp(m[1]);
    const type = _type(adr);
    const pre = parseInt(m[2], 10);
    if (!type || pre > (type === 'ipv4' ? 32 : 128)) return null;
    return [adr, pre, type];
}

/**
 * Adresses et réseaux de l'hôte, à partir de ``os.networkInterfaces()``.
 * → ``{ adresses: Set<string>, reseaux: BlockList }`` : les adresses de
 * TOUTES les interfaces, et les sous-réseaux des interfaces de conteneurs.
 */
export function hoteDepuisInterfaces(interfaces) {
    const adresses = new Set();
    const reseaux = new net.BlockList();
    for (const [nom, liste] of Object.entries(interfaces || {})) {
        for (const i of liste || []) {
            const adr = normaliserIp(i && i.address);
            const type = _type(adr);
            if (!type) continue;
            adresses.add(adr);
            if (_INTERFACES_CONTENEURS.test(nom) && i.cidr) {
                const c = _cidr(i.cidr);
                if (c) { try { reseaux.addSubnet(c[0], c[1], c[2]); } catch (_) { /* masque invalide */ } }
            }
        }
    }
    return { adresses, reseaux };
}

/**
 * Liste blanche du réseau local : noms d'hôte exacts, suffixes (``*.lan`` ou
 * ``.lan``), adresses et réseaux (``192.168.1.0/24``). Vide = tout le réseau
 * local est autorisé.
 */
export function analyserListeBlanche(entrees) {
    const hotes = new Set();
    const suffixes = [];
    const reseaux = new net.BlockList();
    let vide = true;
    const brut = Array.isArray(entrees) ? entrees
        : String(entrees || '').split(/[\s,]+/);
    for (const e0 of brut) {
        const e = String(e0 || '').trim().toLowerCase();
        if (!e) continue;
        vide = false;
        const c = _cidr(e);
        if (c) { reseaux.addSubnet(c[0], c[1], c[2]); continue; }
        const ip = normaliserIp(e);
        const t = _type(ip);
        if (t) { reseaux.addAddress(ip, t); continue; }
        if (e.startsWith('*.')) suffixes.push(e.slice(1));
        else if (e.startsWith('.')) suffixes.push(e);
        else hotes.add(e);
    }
    return { vide, hotes, suffixes, reseaux };
}

/**
 * Motif de refus d'une ADRESSE IP, ou ``null``. ``nomHote`` : nom demandé
 * (pour la liste blanche par nom) ; ``hote`` : adresses et réseaux de l'hôte ;
 * ``listeBlanche`` : résultat d'``analyserListeBlanche``.
 */
export function motifIp(ip0, { hote = null, listeBlanche = null, nomHote = '' } = {}) {
    const ip = normaliserIp(ip0);
    const type = _type(ip);
    if (!type) return 'adresse invalide';
    if (_REFUSES.check(ip, type)) return `adresse réservée à l'hôte ou au réseau local de la machine (${ip})`;
    if (hote && hote.adresses && hote.adresses.has(ip)) return `adresse de la machine qui héberge Elpis (${ip})`;
    if (hote && hote.reseaux && hote.reseaux.check(ip, type)) return `réseau interne de la machine qui héberge Elpis (${ip})`;
    if (listeBlanche && !listeBlanche.vide && _LOCAUX.check(ip, type)) {
        const n = String(nomHote || '').toLowerCase();
        const parNom = n && (listeBlanche.hotes.has(n) || listeBlanche.suffixes.some(s => n.endsWith(s)));
        if (!parNom && !listeBlanche.reseaux.check(ip, type)) {
            return `hôte du réseau local absent de la liste autorisée (${nomHote || ip})`;
        }
    }
    return null;
}

/**
 * Analyse syntaxique : ``{ ok, motif, url, hote, vide }``. ``vide`` = page
 * vide (about:blank), toujours permise. Les noms ``localhost`` et
 * ``*.localhost`` sont refusés sans résolution.
 */
export function analyserUrl(brut) {
    const s = String(brut || '').trim();
    if (!s) return { ok: false, motif: 'adresse vide' };
    if (/^about:blank$/i.test(s)) return { ok: true, vide: true, url: 'about:blank' };
    let u;
    try { u = new URL(s); } catch (_) { return { ok: false, motif: 'adresse mal formée' }; }
    const schema = u.protocol.replace(/:$/, '').toLowerCase();
    if (schema !== 'http' && schema !== 'https' && schema !== 'ws' && schema !== 'wss') {
        return { ok: false, motif: `schéma non autorisé (${schema}:) — seuls http et https le sont` };
    }
    const hote = normaliserIp(u.hostname.toLowerCase());
    if (!hote) return { ok: false, motif: 'adresse sans hôte' };
    if (hote === 'localhost' || hote.endsWith('.localhost')) {
        return { ok: false, motif: `adresse réservée à l'hôte ou au réseau local de la machine (${hote})` };
    }
    return { ok: true, url: u.href, hote };
}

/**
 * Motif de refus d'une URL, ou ``null`` si elle est permise. ``resoudre`` :
 * ``async (nom) => [adresses]`` (``dns.promises.lookup(nom, {all:true})``
 * adapté) ; un nom qui ne résout pas n'est PAS refusé ici (le navigateur
 * échouera de lui-même, avec son propre message).
 */
export async function motifUrl(brut, { resoudre = null, hote = null, listeBlanche = null } = {}) {
    const a = analyserUrl(brut);
    if (!a.ok) return a.motif;
    if (a.vide) return null;
    if (_type(a.hote)) return motifIp(a.hote, { hote, listeBlanche, nomHote: a.hote });
    if (typeof resoudre !== 'function') return null;
    let adresses;
    try { adresses = await resoudre(a.hote); } catch (_) { return null; }
    for (const ip of adresses || []) {
        const m = motifIp(ip, { hote, listeBlanche, nomHote: a.hote });
        if (m) return m;
    }
    return null;
}

/** Message renvoyé au modèle (et à l'utilisateur) pour une adresse refusée. */
export function messageRefus(url, motif) {
    return `Adresse refusée par la politique du navigateur : ${motif}. `
         + `URL : ${String(url || '').slice(0, 200)}. `
         + `Le navigateur ne peut joindre que des sites http/https hors de la machine qui héberge Elpis.`;
}

/**
 * Cache des verdicts par nom d'hôte (sous-ressources : une page charge des
 * dizaines d'URL du même hôte). ``ttlMs`` court : un changement de DNS est
 * pris en compte rapidement.
 */
export function makeCache({ ttlMs = 30000, max = 2000 } = {}) {
    const m = new Map();
    return {
        get(k, now = Date.now()) {
            const e = m.get(k);
            if (!e) return undefined;
            if (now - e.t > ttlMs) { m.delete(k); return undefined; }
            return e.v;
        },
        set(k, v, now = Date.now()) {
            if (m.size >= max) m.delete(m.keys().next().value);
            m.set(k, { v, t: now });
        },
        size() { return m.size; },
    };
}
