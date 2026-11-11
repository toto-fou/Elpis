// SPDX-License-Identifier: MIT
// test/aides/garde_boucle_crochets.mjs — crochet de résolution des essais : l'import de url_guard.js par le service pointe vers url_guard_boucle.mjs.
const REEL = new URL('../../url_guard.js', import.meta.url).href;
const VARIANTE = new URL('./url_guard_boucle.mjs', import.meta.url).href;

// url_guard.js remplacé partout, sauf pour la variante qui l'enveloppe.
export async function resolve(specifier, context, nextResolve) {
    const r = await nextResolve(specifier, context);
    return r.url === REEL && context.parentURL !== VARIANTE ? { ...r, url: VARIANTE } : r;
}
