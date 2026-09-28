// SPDX-License-Identifier: MIT
// Vérif onglet Agents de la modal Paramètres (toggle sous-agents + CRUD des
// agents custom), route-mock, sans backend :
//   PERF_PORT=8917 node tests/frontend/agents-server.mjs &
//   PERF_PORT=8917 node tests/frontend/agents-verify.mjs
// S1 : onglet présent, toggle OFF par défaut, les 5 modèles livrés listés dans
//      la BANQUE (badge « modèle »), compteur des personnalisés à 0.
// S2 : toggle → PUT MONO-CLÉ {agents_enabled:true} + toast (persist immédiat
//      façon memory_enabled, indépendant du bouton Enregistrer).
// S3 : formulaire — picker rend TOUTES les catégories mockées ; validation
//      client (nom invalide / réservé) ; Ajouter → carte + badge dirty ;
//      Enregistrer → PUT du blob avec custom_agents normalisé.
// S4 : suppression avec confirm (openConfirm), carte retirée.
// S5 : les intégrés sont des MODÈLES surchargeables — édition pré-remplie
//      (persona, catégories, budget), nom verrouillé, PUT ne portant que les
//      ÉCARTS, badge « modifié », « Prompt livré », interrupteur Actif →
//      enabled:false, Réinitialiser → surcharge retirée, Dupliquer → variante.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/agents-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(10000);
    await fetch(BASE_URL + '/__cfg');
    await gotoApp(page, '/');

    // ════ S1 — onglet + défauts ═════════════════════════════════════════
    await page.locator('button[title="Paramètres"]:visible').first().click();
    const tab = page.locator('aside button:has-text("Agents")').first();
    await tab.waitFor({ state: 'visible' });
    ok('S1 onglet Agents présent dans la nav (section Données)', true);
    await tab.click();
    await page.waitForTimeout(300);
    const toggle = page.locator('label:has-text("Activer les sous-agents") input[type=checkbox]').first();
    await toggle.waitFor({ state: 'attached' });
    ok('S1 toggle sous-agents présent', true);
    ok('S1 toggle OFF par défaut (opt-in strict)', !(await toggle.isChecked()));
    const modal = page.locator('div[aria-label="Paramètres"]');
    for (const b of ['explore', 'implement', 'verify', 'web', 'pr']) {
        ok(`S1 modèle « ${b} » listé dans la banque`,
           await modal.locator(`[data-agent-row="${b}"]`).isVisible().catch(() => false));
    }
    ok('S1 les 5 modèles portent le badge « modèle »',
       await modal.locator('[data-agent-badge]').count() === 5
       && (await modal.locator('[data-agent-badge]').allInnerTexts()).every(t => t.trim() === 'modèle'));
    ok('S1 compteur 0 / 30 : les modèles ne comptent pas',
       await modal.getByText('0 / 30').first().isVisible().catch(() => false));
    ok('S1 aucune corbeille sur un modèle (il se réinitialise)',
       await modal.locator('button[aria-label="Supprimer l\'agent"]').count() === 0);

    // ════ S2 — toggle = persist immédiat mono-clé ═══════════════════════
    await toggle.click({ force: true });
    let puts = [];
    for (let i = 0; i < 40 && puts.length === 0; i++) {
        await page.waitForTimeout(150);
        puts = (await (await fetch(BASE_URL + '/__puts')).json()).items;
    }
    ok('S2 PUT mono-clé {agents_enabled: true} émis au basculement',
       puts.length === 1 && puts[0].agents_enabled === true && Object.keys(puts[0]).length === 1);
    ok('S2 toast « Sous-agents activés. »',
       await page.locator('#app').getByText('Sous-agents activés.').first().isVisible().catch(() => false));

    // ════ S3 — CRUD agent custom ════════════════════════════════════════
    await page.locator('button:has-text("Créer un agent"):visible').first().click();
    const nameInput = page.locator('input[placeholder="docs-writer"]').first();
    await nameInput.waitFor({ state: 'visible' });
    ok('S3 formulaire de création affiché', true);

    // Picker : toutes les catégories mockées rendues (memory jamais offerte).
    // ⚠ sélecteurs SCOPÉS à la modal : le panneau Outils (panel_mcp) rend des
    // labels de catégories homonymes DERRIÈRE l'overlay.
    const pickerCat = (lbl) => modal.locator('label:has(input[type=checkbox])').filter({ hasText: lbl }).first();
    const pickerLabels = ['Fichiers', 'Terminal', 'Git', 'Graphiques', 'Navigateur', "Contrôle d'écran", 'Skills'];
    let pickerOk = true;
    for (const lbl of pickerLabels) {
        const vis = await pickerCat(lbl).isVisible().catch(() => false);
        if (!vis) { pickerOk = false; console.log('   picker manquant: ' + lbl); }
    }
    ok('S3 picker rend les 7 catégories mockées', pickerOk);
    // Idiome maison : rangées à SWITCH (.set-switch-track), pas de checkbox native visible.
    ok('S3 pickers en rangées-switch (idiome panneau Outils)',
       await modal.locator('.set-switch-track').count() >= 9 &&
       await modal.locator('input[type=checkbox]:not(.sr-only)').count() === 0);
    // Serveurs MCP EXTERNES de l'utilisateur proposés dans le formulaire.
    ok('S3 picker Serveurs MCP : rangées Confluence + Jira',
       (await pickerCat('Confluence').isVisible().catch(() => false)) &&
       (await pickerCat('Jira').isVisible().catch(() => false)));

    // Gabarit de persona : proposé tant que le prompt est vide, insère le
    // squelette des agents intégrés, puis s'efface (le prompt n'est plus vide).
    const promptBox = modal.locator('textarea.set-textarea').first();
    const tplBtn = modal.locator('button:has-text("Gabarit")').first();
    ok('S3 bouton Gabarit proposé sur prompt vide',
       await tplBtn.isVisible().catch(() => false));
    await tplBtn.click();
    const tplTxt = await promptBox.inputValue();
    ok('S3 gabarit insère la structure des agents intégrés',
       ['# Role', '# Objective', '# Your tools', '# Method', '# Effort',
        '# Constraints', '# Report', '# Examples'].every(h => tplTxt.includes(h)));
    ok('S3 gabarit en anglais (prompts model-facing)',
       !/[éèêàçù]/.test(tplTxt));
    ok('S3 bouton Gabarit retiré une fois le prompt rempli',
       !(await tplBtn.isVisible().catch(() => false)));
    await promptBox.fill('');
    ok('S3 bouton Gabarit revient si le prompt est vidé',
       await tplBtn.isVisible().catch(() => false));

    // Validation client : nom invalide puis réservé.
    await nameInput.fill('Bad Name');
    await promptBox.fill('You are a test agent.');
    await page.locator('button:has-text("Ajouter"):visible').first().click();
    ok('S3 nom invalide bloqué (bandeau d\'erreur)',
       await page.locator('#app').getByText('Nom invalide').first().isVisible().catch(() => false));
    await nameInput.fill('task');
    await page.locator('button:has-text("Ajouter"):visible').first().click();
    ok('S3 nom réservé bloqué (« task »)',
       await page.locator('#app').getByText('nom réservé').first().isVisible().catch(() => false));
    // Un nom INTÉGRÉ n'est plus « réservé » : c'est un modèle, qui se modifie
    // dans la banque ou se duplique — le formulaire de création le dit.
    await nameInput.fill('explore');
    await page.locator('button:has-text("Ajouter"):visible').first().click();
    ok('S3 nom d\'un modèle : renvoyé vers la banque, pas « réservé »',
       await page.locator('#app').getByText('est un modèle livré').first().isVisible().catch(() => false));

    // Création valide : nom + description + prompt + 2 catégories.
    await nameInput.fill('docs-writer');
    await page.locator('input[placeholder*="documentation"]').first().fill('rédige la documentation du dépôt');
    await pickerCat('Fichiers').click();
    await pickerCat('Git').click();
    await pickerCat('Confluence').click();
    await page.locator('button:has-text("Ajouter"):visible').first().click();
    await page.waitForTimeout(200);
    ok('S3 carte de l\'agent créée (nom fon-mono)',
       await page.locator('#app').getByText('docs-writer', { exact: true }).first().isVisible().catch(() => false));
    ok('S3 chip MCP « Confluence » sur la carte',
       await modal.getByText('Confluence').first().isVisible().catch(() => false));
    // Depuis la passe design 2026-07-21, « Enregistrer »/« Ajouter » du
    // formulaire persiste IMMÉDIATEMENT (saveSettings(false), précédent :
    // toggles MCP) — plus de double-commit, donc plus de badge
    // « Modifications non enregistrées » attendu à cette étape.
    ok('S3 pas de double-commit (aucun badge « Modifications non enregistrées »)',
       !(await page.locator('#app').getByText('Modifications non enregistrées').first().isVisible().catch(() => false)));
    await page.screenshot({ path: `${SHOTS}/agents-card.png` }).catch(() => {});

    // Le PUT du blob (custom_agents normalisé) part sans clic supplémentaire.
    let putAgents = null;
    for (let i = 0; i < 40 && !putAgents; i++) {
        await page.waitForTimeout(150);
        const items = (await (await fetch(BASE_URL + '/__puts')).json()).items;
        putAgents = items.find(p => Array.isArray(p.custom_agents)) || null;
    }
    const entry = putAgents && putAgents.custom_agents[0] || {};
    ok('S3 PUT du blob : custom_agents présent', !!putAgents);
    ok('S3 agent normalisé (name/prompt/tool_categories fs+git)',
       entry.name === 'docs-writer' && /test agent/.test(entry.prompt || '') &&
       JSON.stringify(entry.tool_categories) === '["fs","git"]');
    ok('S3 serveur MCP retenu (mcp_server_ids = [srv_a])',
       JSON.stringify(entry.mcp_server_ids) === '["srv_a"]');

    // ════ S4 — suppression avec confirm ═════════════════════════════════
    // (saveSettings(false) du formulaire laisse la modal ouverte → fermeture
    //  propre par Échap — sans confirm d'abandon puisque tout est persisté —
    //  puis ré-entrée par l'onglet pour vérifier la re-lecture du blob.)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.locator('aside button:has-text("Agents")').first().click();
    await page.waitForTimeout(300);
    ok('S4 carte re-servie depuis le blob mocké après réouverture',
       await page.locator('#app').getByText('docs-writer', { exact: true }).first().isVisible().catch(() => false));
    await page.locator('button[aria-label="Supprimer l\'agent"]:visible').first().click();
    await page.waitForTimeout(200);
    ok('S4 confirm « Supprimer cet agent ? » affiché',
       await page.locator('#app').getByText('Supprimer cet agent ?').first().isVisible().catch(() => false));
    await page.locator('button:has-text("Supprimer"):visible').last().click();
    await page.waitForTimeout(200);
    ok('S4 carte retirée après confirmation',
       !(await page.locator('#app').getByText('docs-writer', { exact: true }).first().isVisible().catch(() => false)));

    // ════ S5 — les intégrés sont des MODÈLES surchargeables ═════════════
    const lastAgentsPut = async () => {
        const items = (await (await fetch(BASE_URL + '/__puts')).json()).items;
        const withAgents = items.filter(p => Array.isArray(p.custom_agents));
        return withAgents.length ? withAgents[withAgents.length - 1].custom_agents : null;
    };
    // ⚠ Le compteur de départ se relit À CHAQUE attente : figé une fois, la
    // deuxième attente rendait la main avant le PUT qu'elle guettait.
    const putCount = async () => (await (await fetch(BASE_URL + '/__puts')).json()).items.length;
    const waitPut = async (since) => {
        for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(150);
            if (await putCount() > since) return;
        }
    };

    await modal.locator('[data-agent-edit="explore"]').click();
    await page.waitForTimeout(250);
    ok('S5 modèle : le nom est verrouillé',
       (await modal.locator('[data-agent-name-locked]').innerText().catch(() => '')).trim() === 'explore'
       && await modal.locator('input[placeholder="docs-writer"]').count() === 0);
    const promptTpl = modal.locator('textarea.set-textarea').first();
    const tplValue = await promptTpl.inputValue();
    ok('S5 modèle : le prompt est PRÉ-REMPLI de la persona livrée',
       tplValue.startsWith('# Role') && /code explorer/.test(tplValue));
    ok('S5 modèle : « Prompt livré » absent tant que le prompt est celui du livré',
       await modal.locator('[data-agent-prompt-restore]').count() === 0);
    ok('S5 modèle : catégories du modèle pré-cochées (Fichiers + Git)',
       await pickerCat('Fichiers').locator('input').isChecked()
       && await pickerCat('Git').locator('input').isChecked()
       && !(await pickerCat('Terminal').locator('input').isChecked()));
    ok('S5 modèle : le budget du modèle en placeholder',
       await modal.locator('input[type=number][placeholder="60"]').count() === 1);
    ok('S5 modèle : le bouton dit « Enregistrer », pas « Ajouter »',
       await page.locator('button:has-text("Enregistrer"):visible').count() >= 1);

    // Écart : on retire Git. Le PUT ne porte QUE l'écart (prompt vide = livré).
    await pickerCat('Git').click();
    let since = await putCount();
    await page.locator('button:has-text("Enregistrer"):visible').first().click();
    await waitPut(since);
    let bank = await lastAgentsPut();
    let ov = (bank || []).find(a => a.name === 'explore') || null;
    ok('S5 PUT : la surcharge « explore » ne porte que les écarts',
       !!ov && JSON.stringify(ov.tool_categories) === '["fs"]' && (ov.prompt || '') === ''
       && !('max_iters' in ov) && !('enabled' in ov));
    ok('S5 badge « modifié » sur le modèle surchargé',
       (await modal.locator('[data-agent-row="explore"] [data-agent-badge]').innerText()).trim() === 'modifié');
    ok('S5 « Réinitialiser » proposé seulement sur un modèle modifié',
       await modal.locator('[data-agent-reset="explore"]').count() === 1
       && await modal.locator('[data-agent-reset="verify"]').count() === 0);

    // « Prompt livré » : rend la persona dès que le champ en diffère.
    await modal.locator('[data-agent-edit="explore"]').click();
    await page.waitForTimeout(250);
    await promptTpl.fill(tplValue + '\nMy extra rule.');
    ok('S5 « Prompt livré » apparaît quand le prompt diffère',
       await modal.locator('[data-agent-prompt-restore]').isVisible().catch(() => false));
    await modal.locator('[data-agent-prompt-restore]').click();
    ok('S5 « Prompt livré » rend la persona du modèle',
       (await promptTpl.inputValue()) === tplValue);
    await page.locator('button:has-text("Annuler"):visible').first().click();

    // Interrupteur Actif : un intégré désactivé sort du roster.
    since = await putCount();
    await modal.locator('[data-agent-enabled="pr"]').click({ force: true });
    await waitPut(since);
    bank = await lastAgentsPut();
    ov = (bank || []).find(a => a.name === 'pr') || null;
    ok('S5 désactiver un modèle → PUT {name:"pr", enabled:false}',
       !!ov && ov.enabled === false);
    ok('S5 rangée désactivée atténuée',
       /opacity-60/.test(await modal.locator('[data-agent-row="pr"]').getAttribute('class') || ''));

    // Réinitialiser : la surcharge disparaît, le modèle n'a jamais bougé.
    await modal.locator('[data-agent-reset="explore"]').click();
    await page.waitForTimeout(200);
    ok('S5 confirm « Réinitialiser cet agent ? »',
       await page.locator('#app').getByText('Réinitialiser cet agent ?').first().isVisible().catch(() => false));
    since = await putCount();
    // ⚠ Scopé à la boîte de confirmation : un autre « Réinitialiser » vit
    // dans la modale Paramètres, derrière l'overlay, et ``last()`` le prenait.
    await page.locator('[aria-labelledby="app-modal-title"] button:has-text("Réinitialiser")').click();
    await waitPut(since);
    bank = await lastAgentsPut();
    ok('S5 réinitialiser → la surcharge « explore » est retirée du PUT',
       Array.isArray(bank) && !bank.some(a => a.name === 'explore'));
    ok('S5 badge redevenu « modèle »',
       (await modal.locator('[data-agent-row="explore"] [data-agent-badge]').innerText()).trim() === 'modèle');

    // Dupliquer : une variante sous un autre nom, pré-remplie.
    await modal.locator('[data-agent-dup="verify"]').click();
    await page.waitForTimeout(250);
    ok('S5 dupliquer un modèle → nouvel agent « verify-2 » pré-rempli',
       (await modal.locator('input[placeholder="docs-writer"]').inputValue()) === 'verify-2'
       && /verifier/.test(await modal.locator('textarea.set-textarea').first().inputValue())
       && await pickerCat('Terminal').locator('input').isChecked());
    await page.locator('button:has-text("Annuler"):visible').first().click();

    // ════ S6 — banque entièrement désactivée : témoin (2026-09-21) ═══════
    // Le serveur n'expose plus l'outil task (enum vide = grammaire llama.cpp
    // invalide) ; l'onglet le dit au lieu de laisser l'outil disparaître.
    const NONE = '[data-agents-none-active]';
    ok('S6 témoin absent tant qu\'un agent est actif', (await modal.locator(NONE).count()) === 0);
    const rowNames = await modal.locator('[data-agent-row]').evaluateAll(els =>
        els.filter(el => !el.classList.contains('opacity-60')).map(el => el.getAttribute('data-agent-row')));
    for (const name of rowNames) {
        since = await putCount();
        await modal.locator(`[data-agent-enabled="${name}"]`).click({ force: true });
        await waitPut(since);
    }
    await modal.locator(NONE).waitFor({ timeout: 3000 }).catch(() => {});
    ok('S6 tous désactivés (interrupteur maître actif) → témoin « Aucun agent actif »',
       /Aucun agent actif/.test(await modal.locator(NONE).innerText().catch(() => '')));
    since = await putCount();
    await modal.locator(`[data-agent-enabled="${rowNames[0]}"]`).click({ force: true });
    await waitPut(since);
    ok('S6 un agent réactivé → témoin retiré', (await modal.locator(NONE).count()) === 0);

    await page.screenshot({ path: `${SHOTS}/agents-final.png` }).catch(() => {});
} catch (e) {
    await page.screenshot({ path: `${SHOTS}/agents-exception.png` }).catch(() => {});
    ok('exception inattendue : ' + (e && e.message), false);
} finally {
    const jsErrors = errors.filter(er => !/ResizeObserver|favicon/.test(er));
    ok('aucune erreur page JS', jsErrors.length === 0);
    if (jsErrors.length) console.log('   pageerror:', jsErrors.slice(0, 3));
    await browser.close();
    const failed = checks.filter(c => c[0] === 'FAIL');
    console.log(`\n${checks.length - failed.length}/${checks.length} OK`);
    process.exit(failed.length ? 1 : 0);
}
