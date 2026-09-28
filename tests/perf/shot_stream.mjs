// SPDX-License-Identifier: MIT
// Capture visuelle du rendu live : mi-stream (markdown formaté + code qui
// s'accumule) puis final. Sert à vérifier le « propre ».
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, gotoApp, configureServer, BASE_URL } from './lib/harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let server = null;
try { await fetch(`${BASE_URL}/__perf/config`); }
catch (_) { server = spawn('node', [path.join(__dirname, 'perf-server.mjs')], { stdio: 'ignore' }); await new Promise(r => setTimeout(r, 900)); }

await configureServer({ reply: 'code200', toks: 120, chat: null });
const h = await launch({ cpuRate: 1, reducedMotion: 'reduce' });
await gotoApp(h.page);
await h.page.locator('textarea[placeholder]').last().fill('Donne un exemple complet en Python.');
await h.page.locator('button:has(i.ph-paper-plane-right)').last().click();
await h.page.waitForFunction(() => !!document.querySelector('textarea[disabled]'), null, { timeout: 10000, polling: 50 });
// mi-stream : attendre qu'il y ait à la fois des blocs figés et du code en cours
await h.page.waitForFunction(() => {
    const el = document.querySelector('[aria-busy="true"]');
    return el && el.querySelector('p') && el.querySelector('pre');
}, null, { timeout: 20000, polling: 150 });
await h.page.waitForTimeout(300);
await h.page.screenshot({ path: '/tmp/stream_live_mid.png' });
console.log('capture mi-stream OK');
await h.page.waitForFunction(() => !document.querySelector('textarea[disabled]'), null, { timeout: 60000, polling: 200 });
await h.page.waitForTimeout(1200);
await h.page.screenshot({ path: '/tmp/stream_live_final.png' });
console.log('capture final OK');
await h.browser.close();
if (server) server.kill();
