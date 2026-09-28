// SPDX-License-Identifier: MIT
// Scénario (e) — repos absolu 30 s : objectif 0 long task, inventaire des
// timers récurrents (setInterval) et des requêtes réseau périodiques.
// Variante --admin : admin.html (polls live 2 s / dashboard 5 s).
import { launch, gotoApp, configureServer, startWindow, stopWindow, requestsInWindow } from '../lib/harness.mjs';

export async function run({ reducedMotion, cpuRate, admin = false, idleMs = 30000 }) {
    await configureServer({ reply: 'short', toks: 60, chat: null });
    const h = await launch({ reducedMotion, cpuRate });
    try {
        await gotoApp(h.page, admin ? '/admin.html' : '/');
        await h.page.waitForTimeout(5000);   // stabilisation post-chargement
        const win = await startWindow(h.page, h.cdp, { frames: false });
        await h.page.waitForTimeout(idleMs);
        const summary = await stopWindow(h.page, h.cdp, win);
        return { ...summary, requests: requestsInWindow(h.reqLog, summary), errors: h.errors, admin };
    } finally {
        await h.browser.close();
    }
}
