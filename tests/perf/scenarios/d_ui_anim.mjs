// SPDX-License-Identifier: MIT
// Scénario (d) — animations UI, une sous-fenêtre de mesure par interaction :
//   sidebar   : réduire/ouvrir le panneau (elpis-slide-panel, anime width)
//   settings  : ouverture/fermeture de la modale Paramètres
//   copyScroll: scroll d'un chat avec code (copy-btn sticky + backdrop-filter)
//   queueBar  : barre queueProgressFill (width animé sur est_ms)
// C'est LE scénario où reducedMotion reduce vs no-preference diverge.
import { launch, gotoApp, wrapLibs, configureServer, startWindow, stopWindow } from '../lib/harness.mjs';

async function subWindow(h, label, fn) {
    await h.page.waitForTimeout(500);
    const win = await startWindow(h.page, h.cdp, { frames: true });
    await fn();
    const summary = await stopWindow(h.page, h.cdp, win);
    delete summary.intervals;
    return { label, ...summary };
}

export async function run({ reducedMotion, cpuRate }) {
    await configureServer({ reply: 'queue', toks: 60, chat: 'long40' });
    const h = await launch({ reducedMotion, cpuRate });
    const subs = [];
    try {
        await gotoApp(h.page);
        await wrapLibs(h.page);

        const vis = (sel) => h.page.locator(sel).locator('visible=true').first();

        subs.push(await subWindow(h, 'sidebar', async () => {
            for (let i = 0; i < 3; i++) {
                await vis('button[title="Réduire le panneau"]').click();
                await h.page.waitForTimeout(700);
                await vis('button[title="Ouvrir le panneau"]').click();
                await h.page.waitForTimeout(700);
            }
        }));

        subs.push(await subWindow(h, 'settings', async () => {
            for (let i = 0; i < 2; i++) {
                await vis('button[title="Paramètres"]').click();
                await h.page.waitForTimeout(900);
                await h.page.keyboard.press('Escape');
                await h.page.waitForTimeout(600);
            }
        }));

        // Chat avec blocs de code : scroll + hover du copy-btn sticky.
        await h.page.locator('text=Chat long 40 messages').first().click();
        await h.page.waitForTimeout(2500);
        subs.push(await subWindow(h, 'copyScroll', async () => {
            const container = h.page.locator('[data-vs-idx]').first();
            const box = await container.boundingBox();
            const cx = box ? box.x + box.width / 2 : 700, cy = box ? box.y + 100 : 400;
            for (let i = 0; i < 12; i++) {
                await h.page.mouse.move(cx, cy + (i % 4) * 30);
                await h.page.mouse.wheel(0, i < 6 ? -400 : 400);
                await h.page.waitForTimeout(250);
            }
            const btn = h.page.locator('.copy-btn').first();
            if (await btn.count()) await btn.hover().catch(() => {});
            await h.page.waitForTimeout(400);
        }));

        // Barre de file d'attente : l'ENVOI est volontairement HORS fenêtre
        // (sinon son coût domine et masque l'animation). Le mock tient la
        // queue 6 s → fenêtre de 3,5 s sur la phase d'animation pure.
        const ta = h.page.locator('textarea[placeholder]').last();
        await ta.fill('Mesure de la barre de file d\'attente.');
        await h.page.locator('button:has(i.ph-paper-plane-right)').last().click();
        await h.page.waitForTimeout(1500);   // envoi + montage du widget
        subs.push(await subWindow(h, 'queueBar', async () => {
            await h.page.waitForTimeout(3500);
        }));
        // Laisser le stream court se terminer proprement.
        await h.page.waitForFunction(() => !document.querySelector('textarea[disabled]'),
            null, { timeout: 30000, polling: 500 }).catch(() => {});

        return { sub: subs, errors: h.errors };
    } finally {
        await h.browser.close();
    }
}
