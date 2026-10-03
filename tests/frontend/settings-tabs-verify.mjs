// SPDX-License-Identifier: MIT
// Vérif de deux onglets de la modal Paramètres, route-mock, sans backend :
//   PERF_PORT=8942 node tests/frontend/settings-tabs-server.mjs &
//   PERF_PORT=8942 node tests/frontend/settings-tabs-verify.mjs
//
// U — « Utilisation » : le bloc Outils a disparu (retour user 2026-08-16) et la
//     page survit à un payload SANS clé « tools » ; le reste est intact.
// M — « Mémoire » : bouton Éditer → brouillon prérempli, compteur qui suit la
//     frappe, garde-fou de limite, PUT du SEUL magasin modifié, confirmation
//     avant de vider, Annuler qui n'écrit rien, refus serveur non destructif.
// P — « Prompts » : liste avec date, dépliage du contenu, tri (récent / ancien /
//     titre), recherche titre + contenu insensible aux accents.
// F — « Fonctionnalités » : les 3 modules tiennent leur bloc et RESTENT en tête
//     quand l'éditeur s'active ; ses réglages arrivent SOUS eux en deux groupes
//     nommés ; chaque contrôle est bien lié à sa clé.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/settings-tabs-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const puts = async () => (await (await fetch(BASE_URL + '/__puts')).json()).items;

async function openTab(label) {
    const open = await page.locator('div[aria-label="Paramètres"]').isVisible().catch(() => false);
    if (!open) await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.locator(`aside button:has-text("${label}")`).first().click();
    await page.waitForTimeout(350);
}

try {
    page.setDefaultTimeout(10000);
    await fetch(BASE_URL + '/__cfg');
    await gotoApp(page, '/');
    const modal = page.locator('div[aria-label="Paramètres"]');

    // ════ U — onglet Utilisation ════════════════════════════════════════
    await openTab('Utilisation');
    const usage = ((await modal.textContent()) || '').replace(/[\u202f\u00a0]/g, ' ');
    ok('U bloc Tokens et total compact', /Tokens/.test(usage) && /916 k/.test(usage));
    ok('U conversations + messages conservés',
       (await modal.getByText('Conversations').count()) > 0 &&
       (await modal.getByText('Messages').count()) > 0);
    ok('U routines conservées (activité > 0)', (await modal.getByText('exécutions').count()) > 0);
    // Une barre par type (2026-10-03), au sens des fournisseurs : l'entrée
    // contient le cache et les outils, la sortie contient la réflexion.
    const bars = await modal.evaluate(el => [...el.querySelectorAll('[role="listitem"]')]
        .map(r => (r.innerText || '').replace(/[\u202f\u00a0]/g, ' ').replace(/\s+/g, ' ').trim()));
    ok('U cinq barres, dans l’ordre', bars.length === 5
       && /^Entrée/.test(bars[0]) && /^Cache/.test(bars[1]) && /^Outils/.test(bars[2])
       && /^Sortie/.test(bars[3]) && /^Réflexion/.test(bars[4]), bars.join(' | '));
    ok('U entrée et part utile', /Entrée 820 k utile 82 k/.test(bars[0]));
    ok('U cache en % de l’entrée', /Cache 738 k 90 % de l'entrée/.test(bars[1]));
    ok('U outils estimés en % de l’entrée', /Outils 210 k ≈ 26 % de l'entrée/.test(bars[2]));
    ok('U sortie et réponse', /Sortie 96 k réponse 24 k/.test(bars[3]));
    ok('U réflexion en % de la SORTIE (pas du total)', /Réflexion 72 k 75 % de la sortie/.test(bars[4]));
    ok('U ventilation par origine', /Chat\s*700 k\s*120 tours/.test(usage) && /Routines\s*216 k/.test(usage));
    // Le cœur du changement.
    // Le bloc retiré listait les outils internes : seul le POSTE de tokens
    // « Outils » (part de l'entrée, 2026-10-03) porte désormais ce libellé.
    ok('U bloc « Outils » absent (seule la barre de tokens)',
       (await modal.getByText('Outils', { exact: true }).count()) === 1);
    ok('U aucun compteur d\'appels d\'outils', (await modal.getByText('appels').count()) === 0);
    ok('U aucun nom d\'outil interne affiché',
       (await modal.getByText('fs_read').count()) === 0 &&
       (await modal.getByText('read_file').count()) === 0);
    await page.screenshot({ path: `${SHOTS}/usage.png` }).catch(() => {});

    // ════ F — onglet Fonctionnalités ════════════════════════════════════
    await openTab('Fonctionnalités');
    const feat = modal.locator('div').filter({ has: page.locator('h3:has-text("Fonctionnalités")') }).last();
    const rowOf = (label) => modal.locator('.set-row').filter({ hasText: label }).first();
    const sw = (label) => rowOf(label).locator('input[type=checkbox]');

    ok('F les 3 modules sont listés',
       (await modal.locator('.set-row').filter({ hasText: 'Outils' }).count()) > 0 &&
       (await modal.locator('.set-row').filter({ hasText: 'RAG' }).count()) > 0 &&
       (await modal.locator('.set-row').filter({ hasText: 'Éditeur' }).count()) > 0);
    ok('F groupe « Modules » nommé', (await modal.getByText('Modules', { exact: true }).count()) > 0);
    // Éditeur coupé : AUCUN de ses réglages ne doit exister.
    ok('F éditeur coupé → aucun groupe de réglages',
       (await modal.locator('[data-feat-editor-display]').count()) === 0 &&
       (await modal.locator('[data-feat-editor-behavior]').count()) === 0);
    ok('F éditeur coupé → 3 rangées, pas 15',
       (await modal.locator('.set-row').count()) === 3);
    ok('F accordéon « Plus d\'options » supprimé',
       (await modal.getByText("Plus d'options").count()) === 0);
    ok('F renvoi vers les onglets Mémoire et Agents',
       (await modal.getByText('Mémoire et sous-agents').count()) > 0);
    ok('F le renvoi bascule réellement d\'onglet', await (async () => {
        await modal.locator('p button:has-text("Agents")').first().click();
        await page.waitForTimeout(300);
        const surAgents = (await modal.locator('h3:has-text("Agents")').count()) > 0;
        await page.locator('aside button:has-text("Fonctionnalités")').first().click();
        await page.waitForTimeout(300);
        return surAgents;
    })());

    // Avertissement contextuel : seulement quand les outils sont coupés.
    ok('F aucun avertissement tant que les outils sont actifs',
       (await modal.getByText("ne peut plus qu'écrire").count()) === 0);
    await sw('Shell, fichiers, git').click({ force: true });
    await page.waitForTimeout(200);
    ok('F outils coupés → conséquence annoncée',
       (await modal.getByText("ne peut plus qu'écrire").count()) > 0);
    await sw('Shell, fichiers, git').click({ force: true });
    await page.waitForTimeout(200);

    // Activation de l'éditeur : les modules NE bougent PAS, les réglages
    // arrivent dessous — c'était tout le défaut de l'ancienne liste unique.
    const yModulesAvant = (await rowOf('Panneau de code intégré').boundingBox()).y;
    await sw('Panneau de code intégré').click({ force: true });
    await page.waitForTimeout(300);
    const yModulesApres = (await rowOf('Panneau de code intégré').boundingBox()).y;
    ok('F activer l\'éditeur ne déplace pas les modules', yModulesAvant === yModulesApres);
    const display = modal.locator('[data-feat-editor-display]');
    const behavior = modal.locator('[data-feat-editor-behavior]');
    ok('F deux groupes de réglages nommés',
       (await display.getByText('Éditeur · affichage').count()) > 0 &&
       (await behavior.getByText('Éditeur · comportement').count()) > 0);
    ok('F les réglages sont SOUS les modules',
       (await display.boundingBox()).y > yModulesApres);
    // 13 depuis le 2026-09-19 : « Suivre le fichier ouvert » (comportement).
    ok('F les 13 réglages de l\'éditeur sont là',
       (await display.locator('.set-row').count()) === 7 &&
       (await behavior.locator('.set-row').count()) === 6);
    ok('F plus aucune rangée indentée (la hiérarchie passe par les en-têtes)',
       (await modal.locator('.set-row--sub').count()) === 0);

    // Chaque contrôle lit bien SA clé (fixtures non-défaut côté serveur).
    ok('F taille de police liée', (await modal.locator('input[type=range][aria-label="Taille de police de l\'éditeur"]').inputValue()) === '17');
    ok('F police liée', (await modal.locator('select[aria-label="Police de l\'éditeur"]').inputValue()) === 'Fira Code');
    ok('F retour à la ligne = select (3 radios remplacées)',
       (await modal.locator('select[aria-label="Retour à la ligne"]').inputValue()) === 'bounded' &&
       (await modal.locator('input[type=radio]').count()) === 0);
    ok('F indentation liée (largeur + caractère)',
       (await modal.locator('select[aria-label="Largeur d\'indentation"]').inputValue()) === '8' &&
       (await modal.locator('select[aria-label="Caractère d\'indentation"]').inputValue()) === 'false');
    ok('F sauvegarde automatique liée', (await modal.locator('select[aria-label="Sauvegarde automatique"]').inputValue()) === '1min');
    ok('F interrupteurs liés à leur clé',
       (await sw('Indépendant du mode sombre').isChecked()) &&
       !(await sw('Aperçu du fichier dans la marge').isChecked()) &&
       (await sw("Ouvre l'éditeur quand l'assistant écrit").isChecked()) &&
       !(await sw('Rouvre ceux de la dernière session').isChecked()));
    await page.screenshot({ path: `${SHOTS}/features.png` }).catch(() => {});

    // ════ P — onglet Prompts ════════════════════════════════════════════
    await openTab('Prompts');
    const items = modal.locator('[data-prompt-item]');
    const titres = async () => (await items.locator('.text-sm.truncate').allInnerTexts()).map(t => t.trim());
    const search = modal.locator('[data-prompt-search]');
    const sortSel = modal.locator('[data-prompt-sort]');

    ok('P une rangée par prompt', (await items.count()) === 3);
    ok('P date de sauvegarde affichée sur chaque rangée',
       (await modal.locator('[data-prompt-date]').count()) === 3 &&
       (await modal.locator('[data-prompt-date]').first().innerText()).trim().length > 0);
    ok('P date complète en infobulle',
       ((await modal.locator('[data-prompt-date]').first().getAttribute('title')) || '').includes('2025'));
    ok('P contenu replié par défaut', (await modal.locator('[data-prompt-body]').count()) === 0);

    // Dépliage.
    await items.first().locator('[role="button"]').click();
    await page.waitForTimeout(200);
    ok('P clic sur la rangée → contenu visible',
       (await modal.locator('[data-prompt-body]').count()) === 1 &&
       (await modal.locator('[data-prompt-body]').first().innerText()).includes('git bisect'));

    // Le Markdown NE DOIT PAS être interprété : un prompt est un texte source
    // qu'on réutilise tel quel. La fixture porte titre, gras, accents graves,
    // clôture de bloc et chevrons littéraux.
    const brut = await modal.locator('[data-prompt-body] pre').evaluate(el => ({
        texte: el.innerText, enfants: el.children.length, html: el.innerHTML,
    }));
    ok('P balises Markdown conservées telles quelles',
       brut.texte.includes('# Bug report') && brut.texte.includes('**Contexte**') &&
       brut.texte.includes('`git bisect`') && brut.texte.includes('```bash'));
    ok('P aucun élément rendu (rien n\'a été parsé)', brut.enfants === 0);
    ok('P chevrons littéraux préservés et échappés',
       brut.texte.includes('<résumé> & <details>') && brut.html.includes('&lt;résumé&gt;'));
    ok('P retours à la ligne et cases à cocher intacts',
       brut.texte.includes('- [ ] étapes') && brut.texte.includes('- [x] attendu'));

    // Copier : le presse-papier reçoit la source, pas le texte rendu.
    await page.evaluate(() => {
        window.__copie = null;
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: (t) => { window.__copie = t; return Promise.resolve(); } },
        });
    });
    await items.first().hover();
    await page.waitForTimeout(150);
    await items.first().locator('[data-prompt-copy]').click();
    await page.waitForTimeout(250);
    const copie = await page.evaluate(() => window.__copie);
    ok('P « Copier » met la SOURCE au presse-papier',
       typeof copie === 'string' && copie.startsWith('# Bug report') &&
       copie.includes('**Contexte**') && copie.includes('<résumé>'));
    ok('P copie confirmée par un toast',
       (await page.locator('#app').getByText('Prompt copié').count()) > 0);
    ok('P état déplié annoncé (aria-expanded)',
       (await items.first().locator('[role="button"]').getAttribute('aria-expanded')) === 'true');
    await items.first().locator('[role="button"]').click();
    await page.waitForTimeout(200);
    ok('P second clic → replié', (await modal.locator('[data-prompt-body]').count()) === 0);

    // Tri.
    ok('P tri par défaut : plus récents d\'abord',
       JSON.stringify(await titres()) === JSON.stringify(['Bug report', 'Analyse de logs', 'Résumé de réunion']));
    await sortSel.selectOption('ancien');
    await page.waitForTimeout(200);
    ok('P tri « plus anciens » inverse l\'ordre',
       JSON.stringify(await titres()) === JSON.stringify(['Résumé de réunion', 'Analyse de logs', 'Bug report']));
    await sortSel.selectOption('titre');
    await page.waitForTimeout(200);
    ok('P tri par titre A→Z',
       JSON.stringify(await titres()) === JSON.stringify(['Analyse de logs', 'Bug report', 'Résumé de réunion']));
    await sortSel.selectOption('recent');
    await page.waitForTimeout(200);

    // Recherche.
    await search.fill('bug');
    await page.waitForTimeout(250);
    ok('P recherche par titre', (await items.count()) === 1 &&
       (await titres())[0] === 'Bug report');
    ok('P compteur « N sur M »',
       (await modal.locator('[data-prompt-count]').innerText()).includes('1 sur 3'));
    await search.fill('journaux');
    await page.waitForTimeout(250);
    ok('P recherche dans le CONTENU', (await items.count()) === 1 &&
       (await titres())[0] === 'Analyse de logs');
    ok('P extrait centré sur la correspondance',
       (await modal.locator('[data-prompt-excerpt]').innerText()).includes('journaux'));
    // Accents : « recurrentes » doit trouver « récurrentes ».
    // (Pas « resume » : la fixture Markdown contient un ``<résumé>`` littéral,
    //  le terme remonterait DEUX prompts et ne prouverait plus l'unicité.)
    await search.fill('recurrentes');
    await page.waitForTimeout(250);
    ok('P recherche insensible aux accents', (await items.count()) === 1 &&
       (await titres())[0] === 'Analyse de logs');
    await search.fill('reunion');
    await page.waitForTimeout(250);
    ok('P accents aussi côté TITRE', (await items.count()) === 1 &&
       (await titres())[0] === 'Résumé de réunion');
    await search.fill('zzzz');
    await page.waitForTimeout(250);
    ok('P aucun résultat → état vide explicite',
       (await modal.locator('[data-prompt-empty]').count()) === 1 &&
       (await modal.locator('[data-prompt-empty]').innerText()).includes('zzzz'));
    await search.fill('');
    await page.waitForTimeout(250);
    ok('P vider la recherche restaure la liste', (await items.count()) === 3);

    // Les actions ne doivent pas déplier la rangée (@click.stop), et rester
    // inertes tant qu'elles sont invisibles.
    // ⚠ la souris est restée parquée sur la rangée depuis le dernier clic :
    // sans la déplacer, group-hover est actif et le test ne prouve rien.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    ok('P actions inertes hors survol',
       (await modal.locator('[data-prompt-item] .flex.gap-1').first()
            .evaluate(el => getComputedStyle(el).pointerEvents)) === 'none');
    await items.first().hover();
    await page.waitForTimeout(200);
    await items.first().locator('button[aria-label="Supprimer le prompt"]').click();
    await page.waitForTimeout(250);
    ok('P « Supprimer » ouvre la confirmation sans déplier la rangée',
       (await page.locator('#app').getByText('Supprimer ce prompt ?').count()) > 0 &&
       (await modal.locator('[data-prompt-body]').count()) === 0);
    await page.locator('div[role="dialog"][aria-modal="true"] button:has-text("Annuler")').first().click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/prompts.png` }).catch(() => {});

    // ════ M1 — lecture, puis passage en édition ═════════════════════════
    await openTab('Mémoire');
    ok('M1 entrées affichées en lecture', (await modal.getByText('Prénom : Alice').count()) > 0);
    const editBtn = modal.locator('[data-mem-edit]');
    ok('M1 bouton « Éditer » présent', await editBtn.isVisible().catch(() => false));
    ok('M1 aucun champ de saisie hors édition',
       (await modal.locator('[data-mem-entry-user]').count()) === 0);

    await editBtn.click();
    await page.waitForTimeout(250);
    const uEntries = modal.locator('[data-mem-entry-user]');
    const mEntries = modal.locator('[data-mem-entry-memory]');
    ok('M1 un champ par entrée de profil', (await uEntries.count()) === 2);
    ok('M1 un champ par entrée de notes', (await mEntries.count()) === 2);
    ok('M1 champs préremplis avec le contenu stocké',
       (await uEntries.nth(0).inputValue()) === 'Prénom : Alice' &&
       (await mEntries.nth(1).inputValue()) === 'Les tests passent par pytest');
    ok('M1 « Effacer tout » masqué en édition',
       (await modal.getByText('Effacer tout').count()) === 0);
    ok('M1 Enregistrer et Annuler proposés',
       (await modal.locator('[data-mem-save]').isVisible().catch(() => false)) &&
       (await modal.locator('[data-mem-cancel]').isVisible().catch(() => false)));

    // ════ M2 — le compteur suit la frappe, pas le disque ════════════════
    const countUser = modal.locator('[data-mem-count-user]');
    const before = (await countUser.innerText()).trim();
    await uEntries.nth(0).fill('Prénom : Alice Martin');
    await page.waitForTimeout(200);
    const after = (await countUser.innerText()).trim();
    ok('M2 compteur recalculé sur le brouillon', before !== after);
    ok('M2 compteur = longueur SÉRIALISÉE (séparateurs compris)',
       after.startsWith(String('Prénom : Alice Martin'.length + '\n§\n'.length + 'Travaille en français'.length)));

    // ════ M3 — Annuler n'écrit rien et restaure l'affichage ═════════════
    await modal.locator('[data-mem-cancel]').click();
    await page.waitForTimeout(250);
    ok('M3 retour en lecture', (await modal.locator('[data-mem-entry-user]').count()) === 0);
    ok('M3 contenu d\'origine réaffiché', (await modal.getByText('Prénom : Alice').count()) > 0);
    ok('M3 aucun PUT émis', (await puts()).length === 0);

    // ════ M4 — édition réelle : ajout, modification, suppression ════════
    await modal.locator('[data-mem-edit]').click();
    await page.waitForTimeout(250);
    await modal.locator('[data-mem-entry-memory]').nth(0).fill('Le dépôt vit dans /srv/devs');
    await modal.locator('[data-mem-add-memory]').click();
    await page.waitForTimeout(150);
    await modal.locator('[data-mem-entry-memory]').nth(2).fill('Nouvelle note ajoutée à la main');
    await modal.locator('[data-mem-save]').click();
    await page.waitForTimeout(600);
    let sent = await puts();
    ok('M4 un SEUL magasin envoyé (le profil est intact)',
       sent.length === 1 && sent[0].kind === 'memory');
    ok('M4 corps = liste complète et ordonnée',
       JSON.stringify(sent[0].entries) === JSON.stringify([
           'Le dépôt vit dans /srv/devs', 'Les tests passent par pytest',
           'Nouvelle note ajoutée à la main']));
    ok('M4 retour en lecture après enregistrement',
       (await modal.locator('[data-mem-entry-memory]').count()) === 0);
    ok('M4 affichage rechargé depuis le serveur',
       (await modal.getByText('Nouvelle note ajoutée à la main').count()) > 0);
    ok('M4 toast de confirmation', (await page.locator('#app').getByText('Mémoire enregistrée.').count()) > 0);

    // ════ M5 — vider un magasin demande confirmation ════════════════════
    await fetch(BASE_URL + '/__cfg');
    await page.reload();
    await gotoApp(page, '/');
    await openTab('Mémoire');
    await modal.locator('[data-mem-edit]').click();
    await page.waitForTimeout(250);
    const trash = modal.locator('button[aria-label="Supprimer cette entrée"]');
    await trash.nth(2).click();     // 2 entrées profil puis 2 notes → la 1re note
    await page.waitForTimeout(120);
    await modal.locator('button[aria-label="Supprimer cette entrée"]').nth(2).click();
    await page.waitForTimeout(120);
    ok('M5 les deux notes ont été retirées du brouillon',
       (await modal.locator('[data-mem-entry-memory]').count()) === 0);
    await modal.locator('[data-mem-save]').click();
    await page.waitForTimeout(300);
    ok('M5 confirmation demandée avant de vider',
       (await page.locator('#app').getByText('Vider ce que l\'assistant a retenu ?').count()) > 0);
    ok('M5 rien envoyé tant que la confirmation n\'est pas donnée', (await puts()).length === 0);
    await page.locator('button:has-text("Vider"):visible').last().click();
    await page.waitForTimeout(500);
    sent = await puts();
    ok('M5 liste vide envoyée après confirmation',
       sent.length === 1 && sent[0].kind === 'memory' && sent[0].entries.length === 0);
    ok('M5 bloc notes redevenu vide', (await modal.getByText('Rien pour l\'instant.').count()) > 0);

    // ════ M6 — garde-fou de limite (client) ═════════════════════════════
    await fetch(BASE_URL + '/__cfg');
    await page.reload();
    await gotoApp(page, '/');
    await openTab('Mémoire');
    await modal.locator('[data-mem-edit]').click();
    await page.waitForTimeout(250);
    await modal.locator('[data-mem-entry-user]').nth(0).fill('x'.repeat(1500));
    await page.waitForTimeout(250);
    ok('M6 compteur en rouge au-delà de la limite',
       (await countUser.getAttribute('class') || '').includes('text-red-500'));
    ok('M6 Enregistrer désactivé', await modal.locator('[data-mem-save]').isDisabled());
    ok('M6 aucun PUT tenté', (await puts()).length === 0);

    // ════ M7 — refus serveur : non destructif, on reste en édition ══════
    await fetch(BASE_URL + '/__cfg?reject=limit');
    await page.reload();
    await gotoApp(page, '/');
    await openTab('Mémoire');
    await modal.locator('[data-mem-edit]').click();
    await page.waitForTimeout(250);
    await modal.locator('[data-mem-entry-user]').nth(0).fill('Prénom : Alice Refusée');
    await modal.locator('[data-mem-save]').click();
    await page.waitForTimeout(600);
    ok('M7 message de refus affiché',
       (await modal.locator('[data-mem-error]').innerText().catch(() => '')).includes('limit'));
    ok('M7 toujours en édition', (await modal.locator('[data-mem-entry-user]').count()) === 2);
    ok('M7 le texte à corriger n\'a pas été perdu',
       (await modal.locator('[data-mem-entry-user]').nth(0).inputValue()) === 'Prénom : Alice Refusée');
    await page.screenshot({ path: `${SHOTS}/memory-edit.png` }).catch(() => {});

    // ════ M8 — un brouillon compte comme « non enregistré » ═════════════
    // L'éditeur persiste par sa PROPRE route : sans ce rattachement, Échap
    // jetait le brouillon sans un mot (settings.value, lui, n'a pas bougé).
    ok('M8 badge « Modifications non enregistrées »',
       (await page.locator('#app').getByText('Modifications non enregistrées').count()) > 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('M8 fermeture confirmée avant d\'abandonner le brouillon',
       (await page.locator('#app').getByText('Abandonner les modifications ?').count()) > 0);
    // ⚠ scoper au dialogue de confirmation : « Annuler » existe AUSSI dans le
    // panneau mémoire, derrière l'overlay z-[7000] qui intercepte les clics.
    const confirmDlg = page.locator('div[role="dialog"][aria-modal="true"]:has-text("Abandonner les modifications ?")');
    await confirmDlg.locator('button:has-text("Annuler")').first().click();
    await page.waitForTimeout(250);
    ok('M8 refus de fermer → toujours en édition',
       (await modal.locator('[data-mem-entry-user]').count()) === 2);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await page.locator('button:has-text("Abandonner"):visible').last().click();
    await page.waitForTimeout(400);
    ok('M8 modale fermée après abandon', !(await modal.isVisible().catch(() => false)));
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.locator('aside button:has-text("Mémoire")').first().click();
    await page.waitForTimeout(350);
    ok('M8 réouverture en LECTURE (pas de brouillon fantôme)',
       (await modal.locator('[data-mem-entry-user]').count()) === 0 &&
       (await modal.locator('[data-mem-edit]').isVisible().catch(() => false)));
} catch (e) {
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
