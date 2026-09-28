// SPDX-License-Identifier: MIT
// Vérif de la logique PER-CHAT des toggles MCP (panneau Outils), route-mock :
//   PERF_PORT=8922 node tests/frontend/mcptoggles-server.mjs &
//   PERF_PORT=8922 node tests/frontend/mcptoggles-verify.mjs
// Bug corrigé : les serveurs EXTERNES suivaient un état GLOBAL
// (settings.active_mcp_ids persisté via saveSettings) — jamais mémorisés par
// chat et « collants » sur les nouveaux chats. Attendu désormais : même
// logique que les catégories locales — restore par chat (entrées ``ext:<id>``
// de meta_json["tools"]), PUT /tools débouncé au toggle, reset au nouveau
// chat, hydratation legacy des settings IGNORÉE.
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

// Panneau Outils : rangée par libellé → son input (sr-only, :checked lisible).
const row   = (label) => page.locator('.elpis-slide-panel label', { hasText: label }).first();
const isOn  = async (label) => await row(label).locator('input').isChecked();
const getPuts = () => fetch(BASE_URL + '/__puts').then(r => r.json());

try {
    page.setDefaultTimeout(45000);
    await gotoApp(page, '/');
    page.setDefaultTimeout(8000);

    // Ouvre le panneau Outils (bouton sidebar ph-plug).
    await page.locator('button:has(i.ph-plug):visible').first().click();
    await page.waitForTimeout(400);

    // ── Boot, aucun chat chargé : l'hydratation LEGACY (settings.active_mcp_ids
    //    = ['srv1']) ne doit PLUS allumer le serveur externe. ──
    ok('boot : serveur externe OFF malgré settings.active_mcp_ids legacy', !(await isOn('Qdrant distant')));
    ok('boot : serveur non visible absent du panneau', (await page.locator('.elpis-slide-panel label', { hasText: 'Caché' }).count()) === 0);

    // ── Chat c1 (tools: ["fs","ext:srv1"]) : restore per-chat des DEUX types ──
    await page.locator('text=Chat outillé').first().click();
    await page.waitForTimeout(800);
    ok('c1 : catégorie locale « Fichiers » restaurée ON', await isOn('Fichiers'));
    ok('c1 : externe « Qdrant distant » restauré ON (ext:srv1)', await isOn('Qdrant distant'));
    ok('c1 : « Terminal » resté OFF', !(await isOn('Terminal')));

    // ── Chat c2 (tools: []) : TOUT décoché — l'externe ne « colle » plus ──
    await page.locator('text=Chat nu').first().click();
    await page.waitForTimeout(800);
    ok('c2 : externe OFF (état per-chat, ne colle pas depuis c1)', !(await isOn('Qdrant distant')));
    ok('c2 : locale OFF', !(await isOn('Fichiers')));

    // ── Toggle de l'externe sur c2 → PUT /tools du chat avec ``ext:srv1`` ──
    await row('Qdrant distant').click();
    await page.waitForTimeout(1000);   // debounce 600 ms
    let d = await getPuts();
    ok('toggle externe : PUT /tools per-chat avec « ext:srv1 »',
       d.puts.some(p => p.chatId === 'c2' && Array.isArray(p.tools) && p.tools.includes('ext:srv1')));
    ok('toggle externe : AUCUN PUT /api/settings (plus d\'état global)', d.settingsPuts.length === 0);

    // ── Retour c1 puis c2 : chaque chat retrouve SON état ──
    await page.locator('text=Chat outillé').first().click();
    await page.waitForTimeout(800);
    ok('retour c1 : externe ON (son propre état)', await isOn('Qdrant distant'));
    // NB : le mock GET c2 renvoie toujours tools:[] (pas de vraie DB) — le
    // point vérifié est la NON-contamination entre chats, pas le round-trip.
    await page.locator('text=Chat nu').first().click();
    await page.waitForTimeout(800);
    ok('retour c2 : état re-seedé depuis le serveur (OFF)', !(await isOn('Qdrant distant')));

    // ── Nouveau chat : reset COMPLET (locaux + externes) ──
    await page.locator('text=Chat outillé').first().click();   // c1 : tout ON
    await page.waitForTimeout(800);
    await page.locator('button:has-text("Nouveau chat")').first().click();
    await page.waitForTimeout(500);
    ok('nouveau chat : externe OFF (ne reste plus activé)', !(await isOn('Qdrant distant')));
    ok('nouveau chat : locale OFF', !(await isOn('Fichiers')));

    // ── Cases à cocher PAR OUTIL (2026-09-12) ───────────────────────────
    // Chat c3 : « Fichiers » cochée, ``-edit_file`` dans meta_json["tools"].
    await page.locator('text=Chat filtré').first().click();
    await page.waitForTimeout(800);
    ok('c3 : catégorie « Fichiers » restaurée ON', await isOn('Fichiers'));
    // Déplier la catégorie : le chevron ne doit PAS basculer la catégorie.
    await row('Fichiers').locator('[title="Choisir les outils"]').click();
    await page.waitForTimeout(300);
    ok('déplier : la catégorie reste ON', await isOn('Fichiers'));
    const caseOutil = (titre) => page.locator('.elpis-slide-panel label', { hasText: titre })
                                     .first().locator('input[type=checkbox]');
    ok('c3 : « Lire un fichier » coché par défaut', await caseOutil('Lire un fichier').isChecked());
    ok('c3 : « Modifier un fichier » DÉcoché (restauré depuis -edit_file)',
       !(await caseOutil('Modifier un fichier').isChecked()));
    ok('c3 : compteur « 1/2 » affiché', (await row('Fichiers').textContent()).includes('1/2'));

    // Recocher l'outil → le PUT du chat ne porte plus l'exclusion.
    await caseOutil('Modifier un fichier').click();
    await page.waitForTimeout(1000);   // debounce 600 ms
    let d3 = await getPuts();
    const dernier = (id) => [...d3.puts].reverse().find(p => p.chatId === id);
    ok('recocher : PUT /tools sans « -edit_file »',
       !!dernier('c3') && !dernier('c3').tools.includes('-edit_file'));
    ok('recocher : la catégorie « fs » reste dans le PUT', dernier('c3').tools.includes('fs'));

    // Décocher un outil → l'exclusion part dans le PUT.
    await caseOutil('Lire un fichier').click();
    await page.waitForTimeout(1000);
    d3 = await getPuts();
    ok('décocher : PUT /tools avec « -read_file »', dernier('c3').tools.includes('-read_file'));

    // ── Fiche d'un outil (bouton « i ») ─────────────────────────────────
    const ligneOutil = (titre) => page.locator('.elpis-slide-panel label', { hasText: titre }).first();
    ok('aucune icône « œil » muette dans le panneau',
       (await page.locator('.elpis-slide-panel i.ph-eye').count()) === 0);
    const avant = await caseOutil('Lire un fichier').isChecked();
    await ligneOutil('Lire un fichier').locator('[title="Détail de l\'outil"]').click();
    await page.waitForTimeout(300);
    ok('« i » : la fiche s\'ouvre', await page.locator('[role=dialog][aria-label="Détail de l\'outil"]').isVisible());
    ok('« i » : la description du registre est affichée',
       (await page.locator('[role=dialog][aria-label="Détail de l\'outil"]').textContent())
           .includes('Lecteur de fichiers'));
    ok('« i » : la case n\'a PAS basculé au passage',
       (await caseOutil('Lire un fichier').isChecked()) === avant);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('« i » : Échap referme la fiche',
       (await page.locator('[role=dialog][aria-label="Détail de l\'outil"]').count()) === 0);

    // ── « Tout » recoche la catégorie ; pas de « Aucun » en face ────────
    ok('pas de bouton « Aucun »',
       (await page.locator('.elpis-slide-panel button', { hasText: 'Aucun' }).count()) === 0);
    ok('« Tout » proposé tant qu\'il manque un outil',
       (await page.locator('.elpis-slide-panel button', { hasText: 'Tout' }).count()) === 1);
    await page.locator('.elpis-slide-panel button', { hasText: 'Tout' }).first().click();
    await page.waitForTimeout(1000);
    ok('« Tout » : tous les outils recochés', await caseOutil('Modifier un fichier').isChecked()
                                              && await caseOutil('Lire un fichier').isChecked());
    ok('« Tout » disparaît quand plus rien ne manque',
       (await page.locator('.elpis-slide-panel button', { hasText: 'Tout' }).count()) === 0);

    // Décocher la CATÉGORIE : ses exclusions n'ont plus rien à dire. On en
    // repose une d'abord, sinon la vérif passerait sur un état déjà vide.
    await caseOutil('Modifier un fichier').click();
    await page.waitForTimeout(1000);
    d3 = await getPuts();
    ok('re-décoché : « -edit_file » de retour dans le PUT',
       dernier('c3').tools.includes('-edit_file'));
    await row('Fichiers').click();
    await page.waitForTimeout(1000);
    d3 = await getPuts();
    ok('catégorie éteinte : plus aucune exclusion dans le PUT',
       !dernier('c3').tools.some(x => x.startsWith('-')));

    // Nouveau chat : aucune exclusion ne survit.
    await page.locator('button:has-text("Nouveau chat")').first().click();
    await page.waitForTimeout(500);
    await page.locator('text=Chat filtré').first().click();
    await page.waitForTimeout(800);
    ok('retour c3 : catégorie re-seedée depuis le serveur', await isOn('Fichiers'));
    ok('retour c3 : « Modifier un fichier » de nouveau décoché (-edit_file)',
       !(await caseOutil('Modifier un fichier').isChecked()));
    ok('retour c3 : « Lire un fichier » de nouveau coché',
       await caseOutil('Lire un fichier').isChecked());

    ok('aucune erreur JS de page', errors.length === 0);
    if (errors.length) console.log('  erreurs:', errors.slice(0, 5));
} catch (e) {
    ok('exécution sans exception', false);
    console.log('  ! ' + String(e && e.message || e).split('\n')[0]);
} finally {
    await browser.close();
}

const pass = checks.filter(c => c[0] === 'PASS').length;
console.log(`\n${pass}/${checks.length} checks PASS`);
checks.forEach(([s, n]) => console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}`));
process.exit(pass === checks.length ? 0 : 1);
