// SPDX-License-Identifier: MIT
// Scénario (b) — streaming DANS un chat long (40 messages → virtualisation
// active, seuil 30). Mesure le surcoût _vsEnsureTail + scroll par flush.
import { launch, gotoApp, wrapLibs, configureServer, startWindow, stopWindow, requestsInWindow, sendAndWaitStream } from '../lib/harness.mjs';

export async function run({ reducedMotion, cpuRate, toks = 60 }) {
    await configureServer({ reply: 'code200', toks, chat: 'long40' });
    const h = await launch({ reducedMotion, cpuRate });
    try {
        await gotoApp(h.page);
        await wrapLibs(h.page);
        await h.page.locator('text=Chat long 40 messages').first().click();
        await h.page.waitForTimeout(2500);   // rendu + settleScrollBottom
        const win = await startWindow(h.page, h.cdp, { frames: true });
        await sendAndWaitStream(h.page, 'Continue l\'analyse avec un exemple complet en Python.');
        const summary = await stopWindow(h.page, h.cdp, win);
        return { ...summary, requests: requestsInWindow(h.reqLog, summary), errors: h.errors, toks };
    } finally {
        await h.browser.close();
    }
}
