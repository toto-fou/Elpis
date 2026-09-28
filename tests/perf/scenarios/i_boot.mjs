// SPDX-License-Identifier: MIT
// Scénario (i) — coût du DÉMARRAGE, du premier octet au montage de Vue.
//
// Tous les autres scénarios commencent après `gotoApp` : ils mesurent une
// application déjà debout. Or l'ouverture de la page est le geste que
// l'utilisateur fait le plus souvent et le seul où il attend sans rien voir.
//
// Ce qu'on relève :
//   fcpMs / dclMs / montageMs  — premier pixel, DOM prêt, `v-cloak` retiré
//   requetes / octets          — ce que coûte une ouverture à froid
//   cpuParFichier              — où passe le temps processeur, par script
//   police                     — l'icône est en `font-display: block` : tant
//                                que la police n'est pas là, les icônes sont
//                                des trous. Son instant d'arrivée compte
//                                autant que le FCP.
//
// ⚠ Le serveur de harnais ne compresse pas : les octets relevés sont ceux du
// disque, pas ceux du réseau réel (Caddy compresse). À lire en RELATIF entre
// deux campagnes, jamais comme une empreinte de production.
import { launch, BASE_URL } from '../lib/harness.mjs';

export async function run({ reducedMotion = 'reduce', cpuRate = 4, page: cible = '/' } = {}) {
    const h = await launch({ reducedMotion, cpuRate });
    try {
        await h.cdp.send('Profiler.enable');
        await h.cdp.send('Profiler.setSamplingInterval', { interval: 100 });
        await h.cdp.send('Profiler.start');

        const t0 = Date.now();
        await h.page.goto(BASE_URL + cible);
        await h.page.waitForFunction(() => {
            const a = document.getElementById('app');
            return a && !a.hasAttribute('v-cloak');
        }, null, { timeout: 60000, polling: 100 });
        const montageMs = Date.now() - t0;
        const { profile } = await h.cdp.send('Profiler.stop');

        const nav = await h.page.evaluate(() => {
            const res = performance.getEntriesByType('resource').map((e) => ({
                url: e.name.replace(location.origin, '').split('?')[0],
                debutMs: Math.round(e.startTime),
                finMs: Math.round(e.responseEnd),
                octets: e.transferSize || e.encodedBodySize || 0,
            }));
            const n = performance.getEntriesByType('navigation')[0] || {};
            const p = performance.getEntriesByType('paint')
                .find((x) => x.name === 'first-contentful-paint');
            return { res, dclMs: Math.round(n.domContentLoadedEventEnd || 0),
                     loadMs: Math.round(n.loadEventEnd || 0),
                     fcpMs: Math.round((p && p.startTime) || 0) };
        });

        // Temps processeur par fichier applicatif ou vendor.
        const parId = new Map(profile.nodes.map((n) => [n.id, n]));
        const parUrl = new Map();
        for (const s of profile.samples) {
            const n = parId.get(s);
            if (!n) continue;
            const u = (n.callFrame.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
            if (!u.startsWith('/static/')) continue;
            parUrl.set(u, (parUrl.get(u) || 0) + 1);
        }
        const dureeProfil = (profile.endTime - profile.startTime) / 1000;
        const cpuParFichier = [...parUrl.entries()]
            .map(([url, n]) => ({ url, ms: Math.round(n * dureeProfil / profile.samples.length) }))
            .filter((x) => x.ms > 0)
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 15);

        const police = nav.res.find((r) => /\.woff2?$/.test(r.url)) || null;
        return {
            page: cible, montageMs, fcpMs: nav.fcpMs, dclMs: nav.dclMs, loadMs: nav.loadMs,
            requetes: nav.res.length,
            koTransferes: Math.round(nav.res.reduce((s, r) => s + r.octets, 0) / 1024),
            police: police && { url: police.url, debutMs: police.debutMs,
                                finMs: police.finMs, ko: Math.round(police.octets / 1024) },
            cpuParFichier,
            plusGros: [...nav.res].sort((a, b) => b.octets - a.octets).slice(0, 8)
                .map((r) => ({ url: r.url, ko: Math.round(r.octets / 1024) })),
            errors: h.errors,
        };
    } finally {
        await h.browser.close();
    }
}
