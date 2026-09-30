// SPDX-License-Identifier: MIT
// ============================================================================
//  frontend/js/admin/llama_url.js — cohérence hôte/port ↔ URL complète du
//  moteur local (console › Modèles & services › Inférence).
// ============================================================================
//  L'URL complète (`llama.url`, repliée dans « Avancé ») prime sur l'hôte et
//  le port. Changer l'hôte ou le port sans elle laissait donc l'application
//  sur l'ANCIENNE adresse, pendant que l'écran affichait la nouvelle : deux
//  adresses, deux diagnostics (« injoignable » d'un côté, réponses de
//  l'autre). Quand l'URL complète pointait exactement sur l'ancien hôte:port,
//  elle suit le changement (schéma et chemin gardés). Une URL propre (autre
//  hôte, proxy, https sur un autre port…) n'est jamais réécrite : le badge
//  « URL complète active » le signale.
// ============================================================================
(function () {
    'use strict';

    function _hote(ip, port) {
        const h = String(ip || '').trim();
        const p = String(port === undefined || port === null ? '' : port).trim();
        if (!h) return '';
        const hh = h.includes(':') && !h.startsWith('[') ? '[' + h + ']' : h;   // IPv6 littérale
        return p ? hh + ':' + p : hh;
    }

    // URL complète recalée sur le nouvel hôte:port si elle visait l'ancien,
    // sinon renvoyée telle quelle.
    function suivreHotePort(url, ancienIp, ancienPort, nouvelIp, nouveauPort) {
        const u = String(url || '').trim();
        if (!u) return url;
        const avant = _hote(ancienIp, ancienPort), apres = _hote(nouvelIp, nouveauPort);
        if (!avant || !apres || avant === apres) return url;
        const m = u.match(/^(https?:\/\/)([^/?#]+)(.*)$/i);
        if (!m || m[2].toLowerCase() !== avant.toLowerCase()) return url;
        return m[1] + apres + m[3];
    }

    const api = { suivreHotePort };
    if (typeof window !== 'undefined') window.elpisLlamaUrl = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
