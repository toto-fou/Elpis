// SPDX-License-Identifier: MIT
// Captures d'écran du Studio (route-mock) pour l'audit UX. Non un test.
//   STUDIO_PORT=8902 node tests/frontend/studio-server.mjs &
//   PERF_PORT=8902   node tests/frontend/studio-shots.mjs
import { launch, gotoApp } from '../perf/lib/harness.mjs';
import fs from 'fs';
import path from 'path';
const SHOTS = '/tmp/studio-ux';
fs.mkdirSync(SHOTS, { recursive: true });
const { browser, page } = await launch({ reducedMotion: 'reduce' });
const shot = (n) => page.screenshot({ path: path.join(SHOTS, n) }).catch(() => {});
try {
    page.setDefaultTimeout(8000);
    await gotoApp(page, '/');
    await page.locator('button[title*="Studio d"]:visible').first().click();
    await page.waitForSelector('[aria-label="Annotation Studio"]', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);
    await shot('01-empty.png');
    await page.locator('.elpis-studio-page button:has-text("Capturer"):visible').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.elpis-studio-page svg rect').length >= 3, null, { timeout: 8000, polling: 150 }).catch(() => {});
    await page.waitForTimeout(400);
    await shot('02-captured.png');
    await page.locator('.elpis-studio-page button:has-text("Arbre"):visible').first().click();
    await page.waitForTimeout(300); await shot('03-arbre.png');
    await page.locator('.elpis-studio-page button:has-text("Script"):visible').first().click();
    await page.waitForTimeout(300); await shot('04-script.png');
    // header seul (crop large en haut)
    await page.screenshot({ path: path.join(SHOTS, '05-header.png'), clip: { x: 0, y: 0, width: 1440, height: 120 } }).catch(() => {});
} finally { await browser.close().catch(() => {}); }
console.log('shots → ' + SHOTS);
