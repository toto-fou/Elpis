// SPDX-License-Identifier: MIT
// Scénario (c) — ouverture d'un chat long (100 messages). Fenêtre : clic →
// silence de long tasks pendant 1.2 s (rendu + highlight + settle terminés).
import { launch, gotoApp, wrapLibs, configureServer, startWindow, stopWindow, requestsInWindow } from '../lib/harness.mjs';

export async function run({ reducedMotion, cpuRate, chat = 'long100' }) {
    await configureServer({ reply: 'short', toks: 60, chat });
    const h = await launch({ reducedMotion, cpuRate });
    try {
        await gotoApp(h.page);
        await wrapLibs(h.page);
        const title = 'Chat long ' + String(chat).replace('long', '') + ' messages';
        const win = await startWindow(h.page, h.cdp, { frames: false });
        const t0 = Date.now();
        await h.page.locator('text=' + title).first().click();
        // Attendre le rendu initial puis le silence : pas de nouvelle long
        // task pendant 1.2 s (le settleScrollBottom s'étale sur ~2 s).
        await h.page.waitForSelector('[data-vs-idx]', { timeout: 15000 });
        // openMs = temps ABSOLU clic → premier rendu virtualisé. La fenêtre
        // de silence ci-dessous mesure la STABILITÉ, pas la vitesse — sur un
        // très long chat (long400) c'est openMs qui dit si l'ouverture rame.
        const openMs = Date.now() - t0;
        await h.page.waitForFunction(() => {
            const lt = window.__perf.lt;
            const lastEnd = lt.length ? lt[lt.length - 1][0] + lt[lt.length - 1][1] : 0;
            return performance.now() - lastEnd > 1200;
        }, null, { timeout: 30000, polling: 300 });
        const settleMs = Date.now() - t0;
        const summary = await stopWindow(h.page, h.cdp, win);
        return { ...summary, openMs, settleMs, requests: requestsInWindow(h.reqLog, summary), errors: h.errors, chat };
    } finally {
        await h.browser.close();
    }
}
