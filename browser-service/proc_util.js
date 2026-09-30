// SPDX-License-Identifier: MIT
// ============================================================================
//  proc_util.js — choix des processus navigateur ORPHELINS (module pur).
// ============================================================================
//  Avant : tout renderer Chromium (ou processus de contenu Firefox) de plus de
//  20 min était tué, y compris ceux d'un onglet actif — une session longue
//  (formulaire, suivi d'une page) perdait sa page au bout de 20 min. On ne tue
//  plus que les processus de contenu dont le parent n'est PLUS un processus
//  navigateur principal (le navigateur qui les a lancés est mort).
//  Entrée : la sortie de ``ps -o pid=,ppid=,etimes=,args=`` ; aucune E/S ici.
// ============================================================================

// Processus « enfants » d'un navigateur : renderers, gpu-process, utilitaires,
// zygotes Chromium ; processus de contenu Firefox (y compris son serveur de
// fork, ``-contentproc -ipcHandle``). Ils ne sont jamais des principaux.
const _CONTENU = /(?:chrom(?:e|ium)[^ ]*.*--type=(?:renderer|gpu-process|utility|zygote)|firefox[^ ]*.*-contentproc)/i;
const _PRINCIPAL_CHROME = /chrom(?:e|ium)/i;
const _PRINCIPAL_FIREFOX = /firefox/i;

/** Lignes ``ps`` → ``[{pid, ppid, age, args}]`` (lignes illisibles ignorées). */
export function lirePs(texte) {
    const out = [];
    for (const ligne of String(texte || '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(ligne);
        if (!m) continue;
        out.push({ pid: +m[1], ppid: +m[2], age: +m[3], args: m[4] });
    }
    return out;
}

function _estPrincipal(p) {
    if (_CONTENU.test(p.args)) return false;
    if (_PRINCIPAL_CHROME.test(p.args)) return !/--type=/.test(p.args);
    if (_PRINCIPAL_FIREFOX.test(p.args)) return !/-contentproc/.test(p.args);
    return false;
}

/**
 * Vrai si ``p`` se rattache, en remontant ses parents À TRAVERS les processus
 * intermédiaires (zygote Chromium, serveur de fork Firefox, autres processus
 * de contenu), à un navigateur principal vivant (ou à un PID épargné).
 * Chromium : renderer/gpu → zygote → principal ; Firefox : contenu → serveur
 * de fork → principal.
 */
function _rattache(p, parPid, garde) {
    const vus = new Set();
    let cur = p;
    while (cur && !vus.has(cur.pid)) {
        vus.add(cur.pid);
        const parent = parPid.get(cur.ppid);
        if (!parent) return false;                        // parent mort
        if (garde.has(parent.pid) || _estPrincipal(parent)) return true;
        if (!_CONTENU.test(parent.args)) return false;    // init, systemd, autre
        cur = parent;
    }
    return false;
}

/**
 * PID des processus de contenu orphelins de plus de ``ageMinS`` secondes :
 * aucun navigateur principal vivant au bout de leur chaîne de parents.
 * ``epargner`` : PID à ne jamais tuer (le service lui-même…).
 */
export function orphelins(procs, { ageMinS = 1200, epargner = [] } = {}) {
    const parPid = new Map(procs.map(p => [p.pid, p]));
    const garde = new Set(epargner.filter(Boolean));
    const res = [];
    for (const p of procs) {
        if (!_CONTENU.test(p.args) || p.age < ageMinS || garde.has(p.pid)) continue;
        if (_rattache(p, parPid, garde)) continue;
        res.push(p.pid);
    }
    return res;
}
