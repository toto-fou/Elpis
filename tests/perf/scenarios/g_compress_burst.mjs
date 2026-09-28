// SPDX-License-Identifier: MIT
// Scénario (g) — burst de COMPRESSION en plein stream : content →
// compression_start (pseudo-step + tick de progression 250 ms) → 3 s →
// compression_done (finalisation du step, stats) → suite du content.
// Mesure le coût UI du widget de compression (tick + patchs toolSteps)
// pendant qu'un stream est actif. Fenêtre : envoi → fin de stream.
import { launch, gotoApp, wrapLibs, configureServer, startWindow, stopWindow, requestsInWindow, sendAndWaitStream } from '../lib/harness.mjs';

export async function run({ reducedMotion, cpuRate, toks = 60 }) {
    await configureServer({ reply: 'compress', toks, chat: null });
    const h = await launch({ reducedMotion, cpuRate });
    try {
        await gotoApp(h.page);
        await wrapLibs(h.page);
        const win = await startWindow(h.page, h.cdp, { frames: true });
        await sendAndWaitStream(h.page, 'Continue le travail sur la longue tâche en cours.');
        const summary = await stopWindow(h.page, h.cdp, win);
        return { ...summary, requests: requestsInWindow(h.reqLog, summary), errors: h.errors, toks, reply: 'compress' };
    } finally {
        await h.browser.close();
    }
}
