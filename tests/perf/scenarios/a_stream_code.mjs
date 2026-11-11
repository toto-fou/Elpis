// SPDX-License-Identifier: MIT
// Scénario (a) — streaming d'une longue réponse avec gros bloc de code,
// chat neuf. Mesure la fenêtre complète du stream (envoi → fin).
import { launch, gotoApp, wrapLibs, configureServer, startWindow, stopWindow, requestsInWindow, sendAndWaitStream } from '../lib/harness.mjs';

export async function run({ reducedMotion, cpuRate, toks = 60, reply = 'code200' }) {
    await configureServer({ reply, toks, chat: null });
    const h = await launch({ reducedMotion, cpuRate });
    try {
        await gotoApp(h.page);
        await wrapLibs(h.page);
        const win = await startWindow(h.page, h.cdp, { frames: true });
        await sendAndWaitStream(h.page, 'Explique le pipeline de mesure avec un exemple complet en Python.');
        const summary = await stopWindow(h.page, h.cdp, win);
        return { ...summary, requests: requestsInWindow(h.reqLog, summary), errors: h.errors, toks, reply };
    } finally {
        await h.browser.close();
    }
}
