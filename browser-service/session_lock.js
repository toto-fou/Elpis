// SPDX-License-Identifier: MIT
// session_lock.js — sérialisation FIFO des opérations par session Playwright.
//
// AUDIT 2026-06 (le constat n°1 du service) : AUCUN verrou n'existait — deux
// requêtes HTTP concurrentes sur le même session_id opéraient EN PARALLÈLE
// sur la même page Playwright (non réentrante) : click pendant un goto, état
// de page imprévisible, erreurs non reproductibles. Ce module fournit un
// mutex FIFO par session, intégré en UN SEUL point (middleware getSession),
// avec :
//   - file bornée (`maxWaiters`, défaut 8)        → 429 queue_full
//   - attente bornée (`waitMs`, défaut 90 s — au-delà du goto 60 s pour que
//     le client attende son tour plutôt qu'un rejet immédiat) → 423 busy
//   - release idempotent + filet de sécurité (`safetyMs`) si un handler ne
//     release jamais (la session ne reste pas verrouillée à vie)
//   - un waiter qui abandonne (timeout) « passe son tour » sans casser la
//     chaîne pour ceux qui suivent.
//
// Zéro dépendance (déploiement offline : pas d'async-mutex en node_modules).

/** Crée l'état de verrou d'une session. */
export function makeLock() {
    return { tail: Promise.resolve(), waiters: 0 };
}

/**
 * Acquiert le verrou (FIFO). Résout avec une fonction `release()` idempotente.
 * Rejette avec `err.code = 429` (file pleine) ou `423` (attente expirée).
 *
 * @param {{tail: Promise, waiters: number}} lock — état créé par makeLock()
 * @param {{waitMs?: number, maxWaiters?: number, safetyMs?: number}} opts
 */
export function acquireLock(lock, opts = {}) {
    const waitMs = opts.waitMs ?? 90000;
    const maxWaiters = opts.maxWaiters ?? 8;
    const safetyMs = opts.safetyMs ?? 120000;

    if (lock.waiters >= maxWaiters) {
        const err = new Error('queue_full');
        err.code = 429;
        return Promise.reject(err);
    }
    lock.waiters++;

    // Notre « tour » : le suivant dans la chaîne ne démarre que quand il est
    // résolu (par release(), par l'abandon, ou par le filet de sécurité).
    let releaseTurn;
    const turn = new Promise(r => { releaseTurn = r; });
    const prev = lock.tail;
    lock.tail = prev.then(() => turn);

    let abandoned = false;

    const acquired = prev.then(() => {
        if (abandoned) {
            // Le waiter est parti pendant l'attente : on passe le tour
            // immédiatement pour ne pas bloquer les suivants.
            releaseTurn();
            return null;
        }
        lock.waiters--;
        let done = false;
        const release = () => {
            if (done) return;
            done = true;
            clearTimeout(safety);
            releaseTurn();
        };
        // Filet : un handler qui ne release JAMAIS (bug, socket zombie) ne
        // doit pas verrouiller la session à vie. unref → n'empêche pas un
        // arrêt propre du process.
        const safety = setTimeout(release, safetyMs);
        if (safety.unref) safety.unref();
        return release;
    });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            abandoned = true;
            lock.waiters--;
            const err = new Error('session_busy');
            err.code = 423;
            reject(err);
        }, waitMs);
        acquired.then(release => {
            if (release) {
                clearTimeout(timer);
                resolve(release);
            }
            // release === null → déjà rejeté par le timer.
        });
    });
}
