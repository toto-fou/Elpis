// SPDX-License-Identifier: MIT
// Scénario (f) — boucle AGENTIC : R rounds tool_call/tool_result (résultats
// 2-8 Ko, narration tool_thinking entre les rounds) puis réponse finale
// streamée. C'est le chemin réel dominant en usage outillé — coût côté
// front : un patch Vue par step (toolSteps recopié), parse JSON du result,
// flush preContent 40 ms. Fenêtre : envoi → fin de stream.
import { launch, gotoApp, wrapLibs, configureServer, startWindow, stopWindow, requestsInWindow, sendAndWaitStream } from '../lib/harness.mjs';

export async function run({ reducedMotion, cpuRate, toks = 60, rounds = 30 }) {
    await configureServer({ reply: 'tools', toks, chat: null, rounds });
    const h = await launch({ reducedMotion, cpuRate });
    try {
        await gotoApp(h.page);
        await wrapLibs(h.page);
        const win = await startWindow(h.page, h.cdp, { frames: true });
        await sendAndWaitStream(h.page, 'Analyse les modules du projet avec les outils disponibles.');
        const summary = await stopWindow(h.page, h.cdp, win);
        return { ...summary, requests: requestsInWindow(h.reqLog, summary), errors: h.errors, toks, rounds, reply: 'tools' };
    } finally {
        await h.browser.close();
    }
}
