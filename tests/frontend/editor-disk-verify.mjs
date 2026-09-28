// SPDX-License-Identifier: MIT
// Éditeur ↔ disque (audit éditeur 2026-09-23) : Ctrl+S pendant un
// enregistrement, chemins canoniques, fins de ligne, latin-1, BOM,
// historique de session, tampons mis de côté.
//   PERF_PORT=8978 node tests/frontend/editor-disk-server.mjs &
//   PERF_PORT=8978 node tests/frontend/editor-disk-verify.mjs
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';
const cfg = (o) => fetch(BASE_URL + '/__cfg', { method: 'POST', body: JSON.stringify(o) }).then(r => r.json());
const log = () => fetch(BASE_URL + '/__savelog').then(r => r.json());
const checks = []; const ok = (n, c, extra) => { checks.push(!!c); console.log((c ? '  ✓ ' : '  ✗ ') + n + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); };
const lat1 = Buffer.from([0x63,0x61,0x66,0xe9,0x0a]).toString('base64');           // café latin-1
const bom = Buffer.from([0xef,0xbb,0xbf,0x68,0xc3,0xa9,0x0a]).toString('base64');   // BOM + hé
const mixed = Buffer.from('a\nb\r\nc\n').toString('base64');
await cfg({ saveDelay: 0, autoSave: 'off', diskMtime: {}, diskText: {}, diskB64: { 'fichier2.js': lat1, 'fichier3.js': bom, 'fichier1.js': mixed } });
const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
page.setDefaultTimeout(12000);
await gotoApp(page, '/');
const P = 'document.querySelector("#app")._vnode.component.proxy';
const ev = (code) => page.evaluate(new Function('return (async()=>{ const px=' + P + '; ' + code + '})()'));
await page.locator('button[title*="Éditeur"]:visible').first().click();
await page.waitForTimeout(900);

// E13 : ``work/x`` et ``x`` = un seul onglet, un seul modèle
await ev('await px.openFile("fichier4.js", true); return 1'); await page.waitForTimeout(400);
await ev('await px.updateEditor("work/fichier4.js", "par outil\\n"); return 1'); await page.waitForTimeout(400);
ok('chemins : un seul onglet pour work/x et x', (await ev('return px.openTabs.filter(t => t.path.endsWith("fichier4.js")).length')) === 1);
// E1 : Ctrl+S pendant un enregistrement en vol → repris avec la frappe
await cfg({ saveDelay: 1200 });
await ev('await px.openFile("fichier5.js", true); return 1'); await page.waitForTimeout(400);
await page.locator('.monaco-editor:visible').first().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('A');
ev('px.saveEditorContent(); return 1'); await page.waitForTimeout(150);
await page.keyboard.type('B');
await ev('await px.saveEditorContent(); return 1'); await page.waitForTimeout(300);
const ls = (await log()).log.map(e => e.content.slice(-2));
ok('Ctrl+S en vol : repris avec la frappe', ls.length === 2 && ls[1] === 'AB', ls);
await cfg({ saveDelay: 0, diskB64: { 'fichier2.js': lat1, 'fichier3.js': bom, 'fichier1.js': mixed } });

// E14 : fins mixtes → pas « modifié » à l'ouverture
await ev('await px.openFile("fichier1.js", true); return 1'); await page.waitForTimeout(500);
ok('EOL mixtes : onglet propre à l\'ouverture', !(await ev('return px.dirtyTabs.has("fichier1.js")')));
ok('EOL mixtes : signalé en barre d\'état', await ev('return px.statusEolMixed'));
// E3 : latin-1 → lecture seule + bandeau
await ev('await px.openFile("fichier2.js", true); return 1'); await page.waitForTimeout(500);
ok('latin-1 : bandeau encodage', (await ev('return px.activeBanner && px.activeBanner.kind')) === 'encoding');
ok('latin-1 : statut « Non UTF-8 »', (await ev('return px.statusEncoding')) === 'Non UTF-8');
await ev('await px.saveEditorContent({ path: "fichier2.js" }); return 1');
ok('latin-1 : aucun enregistrement envoyé', (await log()).log.length === 0);
// E15 : BOM réinjecté
await ev('await px.openFile("fichier3.js", true); return 1'); await page.waitForTimeout(500);
ok('BOM : statut « UTF-8 BOM »', (await ev('return px.statusEncoding')) === 'UTF-8 BOM');
await page.locator('.monaco-editor').first().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('x');
await ev('await px.saveEditorContent({ path: "fichier3.js" }); return 1'); await page.waitForTimeout(300);
const l1 = (await log()).log;
ok('BOM : réinjecté à l\'enregistrement', l1.length === 1 && l1[0].content.startsWith('﻿'), l1.map(e => e.content.slice(0, 3)));

// Historique : panneau, versions, comparer, restaurer
await ev('px.openHistoryPanel(); return 1'); await page.waitForTimeout(500);
const panel = page.locator('[data-history-panel]');
ok('historique : panneau visible', await panel.isVisible());
ok('historique : fichier listé', /fichier1\.js/.test(await panel.innerText()));
await panel.locator('button[aria-expanded]').first().click(); await page.waitForTimeout(500);
const txt = await panel.innerText();
ok('historique : original + 2 versions', /Original/.test(txt) && /Assistant/.test(txt) && /Vous/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 160));
await ev('await px.switchTab("fichier1.js"); return 1');
await panel.locator('button[aria-label="Comparer à l\'original"]').click({ force: true }); await page.waitForTimeout(800);
ok('historique : diff avec l\'original', await ev('return px.isDiffView && px.diffBase === "history"'));
await panel.locator('button[aria-label="Restaurer l\'original"]').click({ force: true }); await page.waitForTimeout(800);
ok('historique : original restauré dans l\'onglet (non enregistré)',
   (await ev('return px.models["fichier1.js"].getValue()')) === 'ORIGINAL\n' && await ev('return px.dirtyTabs.has("fichier1.js")'));
await cfg({ saveDelay: 0 });   // vide le journal
await ev('await px.saveEditorContent({ path: "fichier1.js", force: true }); return 1'); await page.waitForTimeout(300);
const l2 = (await log()).log;
ok('historique : enregistrement marqué « restore »', l2.length === 1 && l2[0].source === 'restore', l2.map(e => e.source));

// E2 : tampon mis de côté puis proposé après rechargement de page
await ev('px.isDiffView = false; return 1'); await page.waitForTimeout(400);
await page.locator('.monaco-editor:visible').first().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('SECOURS');
const n = await ev('return px.rescueDirtyBuffers()');
ok('mise de côté : 1 tampon', n === 1, n);
await page.reload(); await page.waitForTimeout(1500);
await page.locator('button[title*="Éditeur"]:visible').first().click();
await page.waitForTimeout(1500);
const dlg = page.locator('[role=dialog]').filter({ hasText: 'non enregistrées' });
ok('reconnexion : restauration proposée', await dlg.isVisible().catch(() => false));
await dlg.locator('button:has-text("Restaurer")').click(); await page.waitForTimeout(1200);
ok('reconnexion : contenu restauré, non enregistré',
   /SECOURS/.test(await ev('return px.models["fichier1.js"] ? px.models["fichier1.js"].getValue() : ""')) && await ev('return px.dirtyTabs.has("fichier1.js")'));
ok('aucune erreur JS', errors.length === 0, errors.slice(0, 3));
console.log(`\n${checks.filter(Boolean).length}/${checks.length} OK`);
await browser.close();
process.exit(checks.every(Boolean) ? 0 : 1);
