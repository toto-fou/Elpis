// SPDX-License-Identifier: MIT
// test/aides/url_guard_boucle.mjs — url_guard.js des essais : 127.0.0.1 (pages d'essai locales) permise, tout le reste jugé par la vraie garde.
import { analyserUrl, motifIp as motifIpReel, motifUrl as motifUrlReel } from '../../url_guard.js';

export * from '../../url_guard.js';

const BOUCLE = '127.0.0.1';

// Motif de refus d'une adresse IP, sauf pour la boucle locale des essais.
export function motifIp(ip, options) {
    return ip === BOUCLE ? null : motifIpReel(ip, options);
}

// Motif de refus d'une URL, sauf vers la boucle locale des essais.
export async function motifUrl(brut, options) {
    const a = analyserUrl(brut);
    return a.ok && a.hote === BOUCLE ? null : motifUrlReel(brut, options);
}
