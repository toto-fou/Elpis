// SPDX-License-Identifier: MIT
// Vérif de la passe UX de l'éditeur (2026-09-19), route-mock sans backend :
//   PERF_PORT=8951 node tests/frontend/editor-ux2-server.mjs &
//   PERF_PORT=8951 node tests/frontend/editor-ux2-verify.mjs
// Cf. docs/editeur-ux-design-2026-09-19.md. Sections :
//   A. ne plus perdre de travail (précondition, conflit, rechargement, fermeture,
//      création, copie de secours quand l'assistant écrit)
//   B. arbre (Localiser, dossiers mémorisés, Tout replier, Dupliquer, sélection
//      multiple, clavier)
//   C. onglets et navigation (épingler, Alt+W, homonymes, récents, Ctrl+B)
//   D. recherche et remplacement
//   E. Git (pastilles, branche, marge, diff par rapport à HEAD)
//   F. confort (aperçu Markdown à côté, SVG en code, zoom image, barre d'état,
//      problèmes, formatage, action IA en diff, chemin cliquable du chat,
//      Échap dans une recherche en plein écran)
//   T. onglets à la largeur du nom (2026-09-20) : lisibles en entier, coupure au
//      milieu au plafond, indice de dossier entier, onglet actif toujours en vue
import path from 'path';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp';
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };
const api = (p) => fetch(BASE_URL + p).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, ctx, page, errors } = await launch({ reducedMotion: 'reduce' });
// Scope du composant racine : en build de prod, ``__vue_app__._instance``
// est nul — on passe par le vnode racine monté sur #app.
await page.addInitScript(() => {
    window.__px = () => {
        const el = document.getElementById('app');
        const vn = el && el._vnode;
        return (vn && vn.component && vn.component.proxy)
            || (el && el.__vue_app__ && el.__vue_app__._instance && el.__vue_app__._instance.proxy);
    };
});

// Accès au scope du composant racine (fonctions et refs exposées au gabarit).
const call = (fn, ...args) => page.evaluate(([f, a]) => {
    const px = window.__px();
    const r = px[f](...a);
    return (r && typeof r.then === 'function') ? r.then(() => true) : true;
}, [fn, args]);
const val = (expr) => page.evaluate((e) => {
    const px = window.__px();
    // eslint-disable-next-line no-new-func
    return new Function('px', 'return (' + e + ');')(px);
}, expr);
const modelText = () => page.evaluate(() => {
    const px = window.__px();
    const m = px.monacoRef.instance && px.monacoRef.instance.getModel();
    return m ? m.getValue() : null;
});
const treeRow = (label) => page.locator(`[role="treeitem"][aria-label="${label}"]`).first();
const tabs = () => page.locator('[role="tablist"] [role="tab"]');
const choice = (id) => page.locator(`[data-choice="${id}"]`).first();

async function openEditor() {
    await page.locator('button[title*="Éditeur"]:visible').first().click();
    await page.waitForTimeout(1200);
}
async function typeInEditor(text) {
    await page.locator('#monaco-editor .monaco-editor').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(text);
    await page.waitForTimeout(250);
}
async function focusEvent() {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(700);
}

try {
    page.setDefaultTimeout(12000);
    await api('/__reset');
    await gotoApp(page, '/');
    ok('app montée', true);
    await openEditor();
    ok('arbre chargé', await treeRow('Dossier src').isVisible().catch(() => false));

    // ════ B1. Localiser + dossiers mémorisés + Tout replier ═════════════
    await call('openFile', 'src/deep/inner/b.py', true);
    await page.waitForTimeout(800);
    ok('b.py ouvert (onglet)', (await tabs().count()) === 1);
    ok('fichier profond non visible avant Localiser', !(await treeRow('Fichier b.py').isVisible().catch(() => false)));
    await page.locator('button[aria-label="Localiser le fichier ouvert"]').click();
    await page.waitForTimeout(500);
    ok('Localiser : ligne visible', await treeRow('Fichier b.py').isVisible().catch(() => false));
    ok('Localiser : ligne surlignée (aria-selected)', (await treeRow('Fichier b.py').getAttribute('aria-selected')) === 'true');
    const openStored = await page.evaluate(() => localStorage.getItem('elpis.tree.open.1'));
    ok('dossiers dépliés mémorisés', /src\/deep\/inner/.test(openStored || ''));
    await page.locator('button[aria-label="Tout replier"]').click();
    await page.waitForTimeout(300);
    ok('Tout replier', !(await treeRow('Fichier b.py').isVisible().catch(() => false)));
    await page.locator('nav[aria-label="Chemin du fichier"] button:has-text("b.py")').click();
    await page.waitForTimeout(400);
    ok('fil d\'Ariane : clic sur le fichier = Localiser', await treeRow('Fichier b.py').isVisible().catch(() => false));
    await page.locator('#monaco-editor .monaco-editor').first().click();
    await page.locator('button[aria-label="Tout replier"]').click();
    await page.locator('#monaco-editor .monaco-editor').first().click();
    await page.keyboard.press('Alt+l');
    await page.waitForTimeout(400);
    ok('Alt+L localise', await treeRow('Fichier b.py').isVisible().catch(() => false));

    // ════ A1. Ctrl+S alors que le disque a bougé → 412 → fenêtre ════════
    await call('openFile', 'src/util.py', true);
    await page.waitForTimeout(700);
    await typeInEditor('\n# local');
    await api('/__touch?path=src/util.py&content=' + encodeURIComponent('# terminal\n'));
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(700);
    ok('conflit : fenêtre Écraser / Comparer / Recharger', await choice('overwrite').isVisible().catch(() => false)
        && await choice('compare').isVisible().catch(() => false) && await choice('reload').isVisible().catch(() => false));
    let fsState = await api('/__fs');
    ok('conflit : le disque n\'a PAS été écrasé', fsState.files['src/util.py'] === '# terminal\n');
    ok('conflit : /save portait expected_mtime', fsState.log.some((l) => l.op === 'save' && typeof l.expected === 'number'));
    await choice('compare').click();
    await page.waitForTimeout(700);
    ok('Comparer : diff affiché', await page.locator('#monaco-diff-editor.active').isVisible().catch(() => false));
    ok('Comparer : bandeau « modifié sur le disque »', await page.locator('.elpis-editor-banner:has-text("Modifié sur le disque")').isVisible().catch(() => false));
    await page.locator('.elpis-editor-banner button:has-text("Écraser")').click();
    await page.waitForTimeout(700);
    fsState = await api('/__fs');
    ok('Écraser : mon contenu est sur le disque', /# local/.test(fsState.files['src/util.py']));
    ok('Écraser : bandeau retiré', !(await page.locator('.elpis-editor-banner').isVisible().catch(() => false)));
    // Précondition au fil de l'eau : un second Ctrl+S passe sans conflit.
    await typeInEditor('\n# encore');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(600);
    fsState = await api('/__fs');
    ok('enregistrement suivant sans faux conflit', /# encore/.test(fsState.files['src/util.py']) && !(await choice('overwrite').isVisible().catch(() => false)));

    // ════ A2. Disque modifié, onglet PROPRE → rechargement silencieux ══
    await api('/__touch?path=src/util.py&content=' + encodeURIComponent('# nouveau contenu disque\n'));
    await focusEvent();
    ok('onglet propre rechargé en silence', (await modelText()) === '# nouveau contenu disque\n');
    ok('aucun bandeau pour un onglet propre', !(await page.locator('.elpis-editor-banner').isVisible().catch(() => false)));

    // ════ A3. Disque modifié, onglet MODIFIÉ → bandeau, rien d'écrasé ══
    await typeInEditor('\n# à moi');
    await api('/__touch?path=src/util.py&content=' + encodeURIComponent('# autre\n'));
    await focusEvent();
    ok('onglet modifié : bandeau Recharger / Comparer / Écraser', await page.locator('.elpis-editor-banner:has-text("Modifié sur le disque")').isVisible().catch(() => false));
    ok('onglet modifié : mes modifications intactes', /# à moi/.test(await modelText()));

    // ════ A4. Clic dans l'arbre sur un onglet modifié : rien de perdu ═══
    await call('revealActiveInTree');
    await page.waitForTimeout(300);
    await treeRow('Fichier util.py').click();
    await page.waitForTimeout(700);
    ok('clic arbre sur onglet modifié : modifications gardées', /# à moi/.test(await modelText()));
    await page.locator('.elpis-editor-banner button:has-text("Recharger")').click();
    await page.waitForTimeout(400);
    await choice('overwrite').isVisible().catch(() => false);
    // Recharger demande confirmation (perte des modifs locales).
    const confirmBtn = page.locator('.fixed.inset-0.z-\\[7000\\] button:has-text("Recharger")').last();
    if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
    await page.waitForTimeout(600);
    ok('Recharger : contenu disque', (await modelText()) === '# autre\n');

    // ════ A5. Fermer un onglet modifié : Enregistrer / Ne pas enregistrer
    await typeInEditor('\n# à garder');
    await page.keyboard.press('Alt+w');
    await page.waitForTimeout(500);
    ok('fermeture : choix « Enregistrer » proposé', await choice('save').isVisible().catch(() => false));
    await choice('save').click();
    await page.waitForTimeout(700);
    fsState = await api('/__fs');
    ok('Enregistrer puis fermer : contenu sur disque', /# à garder/.test(fsState.files['src/util.py']));
    ok('Enregistrer puis fermer : onglet fermé', !(await page.locator('[role="tab"]:has-text("util.py")').count()));

    // ════ A6. Nouveau fichier au nom existant : jamais vidé ════════════
    await page.locator('button[aria-label="Nouveau fichier"]').click();
    await page.waitForTimeout(300);
    await page.locator('.fixed.inset-0.z-\\[7000\\] input').fill('notes.md');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    ok('nom existant : fenêtre « existe déjà »', await page.locator('text=Ce fichier existe déjà').isVisible().catch(() => false));
    fsState = await api('/__fs');
    ok('nom existant : contenu intact', fsState.files['notes.md'] === 'foo bar\nFoo\n');
    await choice('open').click();
    await page.waitForTimeout(700);
    ok('« Ouvrir » ouvre le fichier existant', (await modelText()) === 'foo bar\nFoo\n');

    // ════ A7. L'assistant écrit dans un onglet modifié : copie gardée ══
    await call('openFile', 'src/app.py', true);
    await page.waitForTimeout(700);
    await typeInEditor('\n# travail non enregistré');
    await call('updateEditor', 'src/app.py', 'import os\nx = 2\nprint(x)\n');
    await page.waitForTimeout(600);
    ok('assistant : bandeau « vos modifications gardées »', await page.locator('.elpis-editor-banner:has-text("Réécrit par l\'assistant")').isVisible().catch(() => false));
    ok('assistant : onglet = version de l\'assistant', (await modelText()) === 'import os\nx = 2\nprint(x)\n');
    await page.locator('.elpis-editor-banner button:has-text("Restaurer")').click();
    await page.waitForTimeout(400);
    ok('Restaurer : mes modifications reviennent', /# travail non enregistré/.test(await modelText()));
    ok('Restaurer : onglet marqué non enregistré', await page.locator('[role="tab"] span[title="Modifications non sauvegardées"]').first().isVisible().catch(() => false));
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(600);
    ok('Ctrl+S après restauration : pas de faux conflit', !(await choice('overwrite').isVisible().catch(() => false)));

    // ════ E. Git : pastilles, branche, marge ════════════════════════════
    await page.waitForTimeout(1200);
    await call('revealActiveInTree');
    await page.waitForTimeout(400);
    ok('pastille M sur src/app.py', (await treeRow('Fichier app.py').locator('span:text-is("M")').count()) === 1);
    ok('pastille U sur notes.md', (await treeRow('Fichier notes.md').locator('span:text-is("U")').count()) === 1);
    ok('barre d\'état : branche main', await page.locator('button[title^="Branche Git"]:has-text("main")').isVisible().catch(() => false));
    await page.waitForTimeout(600);
    ok('marge Git : ligne modifiée marquée', (await page.locator('#monaco-editor .elpis-scm-modified').count()) > 0);
    ok('marge Git : lignes ajoutées marquées', (await page.locator('#monaco-editor .elpis-scm-added').count()) > 0);
    await call('toggleDiffMode', 'head');
    await page.waitForTimeout(600);
    ok('diff depuis le dernier commit', await page.locator('#monaco-diff-editor.active').isVisible().catch(() => false)
        && (await val("px.diffBase")) === 'head');
    await call('toggleDiffMode', 'head');
    await page.waitForTimeout(300);

    // ════ F. Barre d'état, problèmes, formatage ═════════════════════════
    ok('barre d\'état : UTF-8 et LF', await page.locator('span[title="Encodage · fin de ligne"]:has-text("UTF-8 · LF")').isVisible().catch(() => false));
    await typeInEditor(' ');
    await page.waitForTimeout(1400);                    // lint débouncé 800 ms pendant la frappe
    ok('problèmes : 1 erreur (lint pendant la frappe)', (await val('px.problemCounts.errors')) === 1);
    await page.locator('button[title="Problèmes du fichier"]').click();
    await page.waitForTimeout(200);
    ok('problèmes : liste avec le message', await page.locator('[role="listbox"][aria-label="Problèmes"]:has-text("imported but unused")').isVisible().catch(() => false));
    await page.locator('[role="listbox"][aria-label="Problèmes"] [role="option"]').first().click();
    await call('openFile', 'src/deep/inner/b.py', true);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const px = window.__px();
        px.monacoRef.instance.getModel().setValue('b=2\nc=3\n');
    });
    // Entrée « Formater le document » (le raccourci Maj+Alt+F de Monaco ne
    // tire pas sous Chromium headless — limitation connue du harnais).
    await call('editorCtxFormatDoc');
    await page.waitForTimeout(800);
    ok('Formater (Python) : ruff format appliqué', (await modelText()) === 'b = 2\nc = 3\n');

    // ════ F. Action IA : proposition en diff ═════════════════════════════
    await page.evaluate(() => {
        const px = window.__px();
        const ed = px.monacoRef.instance;
        ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 });
        px.editorCtxMenu.hasSelection = true;
        px.editorCtxMenu.selectionText = 'b = 2';
    });
    await page.evaluate(() => { const px = window.__px(); px.availableModels = ['m1']; px.activeModelIds = ['m1']; });
    await call('editorCtxRunAI', 'refactor');
    await page.waitForTimeout(900);
    ok('action IA : diff + bandeau Accepter / Rejeter', await page.locator('.elpis-editor-banner button:has-text("Accepter")').isVisible().catch(() => false)
        && await page.locator('#monaco-diff-editor.active').isVisible().catch(() => false));
    ok('action IA : fichier inchangé tant que non accepté', (await modelText()) === 'b = 2\nc = 3\n');
    await page.locator('.elpis-editor-banner button:has-text("Accepter")').click();
    await page.waitForTimeout(500);
    ok('Accepter : modification appliquée', (await modelText()) === 'y = 99\nc = 3\n');

    // ════ C. Onglets : épingler, homonymes, Alt+PgSuiv, Ctrl+B ═════════
    await call('openFile', 'a/index.js', true);
    await call('openFile', 'b/index.js', true);
    await page.waitForTimeout(600);
    ok('homonymes : dossier affiché', await page.locator('[role="tab"][data-path="a/index.js"]:has-text("a")').isVisible().catch(() => false)
        && (await val('px.tabHints["b/index.js"]')) === 'b');
    await page.locator('[role="tab"][data-path="a/index.js"]').click({ button: 'right' });
    await page.locator('button:has-text("Épingler")').click();
    await page.waitForTimeout(200);
    ok('épinglé : premier onglet', (await tabs().first().getAttribute('data-path')) === 'a/index.js');
    await page.locator('[role="tab"][data-path="b/index.js"]').click({ button: 'right' });
    await page.locator('button:has-text("Fermer les autres")').click();
    // Les onglets modifiés demandent quoi faire (fenêtre à trois issues).
    for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(400);
        if (!(await choice('discard').isVisible().catch(() => false))) break;
        await choice('discard').click();
    }
    await page.waitForTimeout(500);
    const left = await page.locator('[role="tablist"] [role="tab"]').evaluateAll((els) => els.map((e) => e.dataset.path));
    ok('« Fermer les autres » épargne l\'onglet épinglé', left.length === 2 && left.includes('a/index.js') && left.includes('b/index.js'));
    await page.locator('#monaco-editor .monaco-editor').first().click();
    const before = await val('px.activeTabPath');
    await page.keyboard.press('Alt+PageDown');
    await page.waitForTimeout(400);
    ok('Alt+PgSuiv : onglet suivant', (await val('px.activeTabPath')) !== before);
    await page.locator('#monaco-editor .monaco-editor').first().click();
    const exp0 = await val('px.showExplorer');
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(200);
    ok('Ctrl+B : explorateur basculé', (await val('px.showExplorer')) === !exp0);
    await page.keyboard.press('Control+b');

    // Ctrl+P sans saisie : récents d'abord
    await page.keyboard.press('Control+p');
    await page.waitForTimeout(300);
    const firstQuick = await page.locator('#elpis-quickopen-input').isVisible().catch(() => false)
        ? await val('px.quickOpenResults[0]') : null;
    ok('Ctrl+P : fichier récent en tête', ['b/index.js', 'a/index.js'].includes(firstQuick));
    ok('Ctrl+P : étiquette « récent »', await page.locator('text=récent').first().isVisible().catch(() => false));
    await page.keyboard.press('Escape');

    // ════ B2. Dupliquer, sélection multiple ══════════════════════════════
    await call('revealActiveInTree', 'src/util.py');
    await page.waitForTimeout(300);
    await treeRow('Fichier util.py').click({ button: 'right' });
    await page.locator('#custom-context-menu button:has-text("Dupliquer")').click();
    await page.waitForTimeout(800);
    fsState = await api('/__fs');
    ok('Dupliquer : « util copie.py » créé', 'src/util copie.py' in fsState.files);
    ok('Dupliquer : la copie est ouverte', (await val('px.activeTabPath')) === 'src/util copie.py');
    // Clic simple = sélection d'une ligne ; Ctrl+clic = ajout.
    await treeRow('Fichier fichier1.js').click();
    await page.waitForTimeout(400);
    await treeRow('Fichier fichier2.js').click({ modifiers: ['Control'] });
    await page.waitForTimeout(200);
    await treeRow('Fichier fichier2.js').click({ button: 'right' });
    await page.waitForTimeout(200);
    ok('sélection multiple : menu « 2 éléments »', await page.locator('#custom-context-menu:has-text("2 éléments")').isVisible().catch(() => false));
    await page.locator('#custom-context-menu button:has-text("Supprimer")').click();
    await page.waitForTimeout(300);
    await page.locator('.fixed.inset-0.z-\\[7000\\] button:has-text("Supprimer")').last().click();
    await page.waitForTimeout(800);
    fsState = await api('/__fs');
    ok('sélection multiple : les deux supprimés, le 3e intact',
       !('fichier1.js' in fsState.files) && !('fichier2.js' in fsState.files) && ('fichier3.js' in fsState.files));
    // Clavier dans l'arbre
    await treeRow('Dossier docs').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    ok('clavier : → ouvre le dossier', await treeRow('Fichier readme.md').isVisible().catch(() => false));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.dataset.path);
    ok('clavier : ↓ descend dans le dossier', focused === 'docs/readme.md');

    // ════ D. Recherche (casse, filtre) + remplacement avec aperçu ═══════
    await page.locator('#elpis-file-search-input').fill('foo');
    await page.waitForTimeout(700);
    ok('recherche : 2 occurrences (insensible à la casse)', (await val('px.sandboxSearchResults.length')) === 2);
    await page.locator('button[title="Respecter la casse"]').click();
    await page.waitForTimeout(600);
    ok('Aa : 1 occurrence', (await val('px.sandboxSearchResults.length')) === 1);
    ok('occurrence surlignée', await page.locator('mark.elpis-search-hit').first().isVisible().catch(() => false));
    await page.locator('button[title="Remplacer dans les fichiers"]').click();
    await page.locator('input[aria-label="Texte de remplacement"]').fill('baz');
    await page.locator('button:has-text("Aperçu")').click();
    await page.waitForTimeout(600);
    ok('aperçu du remplacement : avant / après', await page.locator('text=− foo bar').isVisible().catch(() => false)
        && await page.locator('text=+ baz bar').isVisible().catch(() => false));
    fsState = await api('/__fs');
    ok('aperçu : rien d\'écrit', fsState.files['notes.md'] === 'foo bar\nFoo\n');
    await page.locator('button:has-text("Remplacer"):not([title])').last().click();
    await page.waitForTimeout(300);
    await page.locator('.fixed.inset-0.z-\\[7000\\] button:has-text("Remplacer")').last().click();
    await page.waitForTimeout(900);
    fsState = await api('/__fs');
    ok('remplacement appliqué (casse respectée)', fsState.files['notes.md'] === 'baz bar\nFoo\n');
    await page.locator('#elpis-file-search-input').fill('');

    // ════ F. Aperçu Markdown à côté, SVG en code, zoom image ════════════
    await call('openFile', 'docs/readme.md', true);
    await page.waitForTimeout(600);
    await call('toggleSplitRender');
    await page.waitForTimeout(600);
    ok('aperçu Markdown à côté (sans plein écran)', await page.locator('.markdown-body h1:has-text("Titre")').isVisible().catch(() => false)
        && !(await val('px.editorFullscreen')));
    await typeInEditor('\n## Ajout en direct');
    await page.waitForTimeout(600);
    ok('aperçu Markdown en direct', await page.locator('.markdown-body h2:has-text("Ajout en direct")').isVisible().catch(() => false));
    await call('openFile', 'docs/logo.svg', true);
    await page.waitForTimeout(700);
    ok('SVG ouvert en CODE', (await val('px.activeFileViewMode')) === 'monaco' && /<svg/.test(await modelText()));
    ok('aperçu SVG à côté', (await page.locator('.elpis-svg-preview-wrap svg').count()) > 0);
    await call('exitSplit');
    await call('openFile', 'img/photo.png', true);
    await page.waitForTimeout(700);
    ok('image : barre de zoom', await page.locator('button[title="Zoomer"]').isVisible().catch(() => false));
    await page.locator('button[title="Taille réelle (100 %)"]').click();
    await page.locator('button[title="Zoomer"]').click();
    await page.waitForTimeout(200);
    ok('image : zoom 125 %', (await val('px.imageZoomLabel')) === '125 %');

    // ════ F. Échap dans une recherche Monaco en plein écran ═════════════
    await call('openFile', 'src/app.py', false);
    await page.waitForTimeout(500);
    await call('toggleEditorFullscreen');
    await page.waitForTimeout(500);
    await page.locator('#monaco-editor .monaco-editor').first().click();
    await page.keyboard.press('Control+f');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    ok('Échap ferme la recherche SANS quitter le plein écran', (await val('px.editorFullscreen')) === true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    ok('Échap suivant quitte le plein écran', (await val('px.editorFullscreen')) === false);

    // ════ E2. Vue Git : clic sur un fichier modifié = son diff vs HEAD ══
    await call('gitOpenChange', 'src/app.py', 'M');
    await page.waitForTimeout(900);
    ok('Git : fichier modifié → diff depuis le dernier commit', (await val('px.diffBase')) === 'head'
        && await page.locator('#monaco-diff-editor.active').isVisible().catch(() => false));
    await call('toggleDiffMode', 'head');
    await page.waitForTimeout(300);

    // ════ C2. Précédent / Suivant (Alt+← / Alt+→) ═════════════════════
    await call('openFile', 'src/util.py', false);
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__px().monacoRef.instance.setPosition({ lineNumber: 2, column: 3 }); });
    await call('openFile', 'notes.md', false);
    await page.waitForTimeout(500);
    await call('navBack');
    await page.waitForTimeout(500);
    ok('Précédent : retour au fichier ET à la ligne', (await val('px.activeTabPath')) === 'src/util.py'
        && (await val('px.monacoRef.instance.getPosition().lineNumber')) === 2);
    await call('navForward');
    await page.waitForTimeout(500);
    ok('Suivant : de nouveau notes.md', (await val('px.activeTabPath')) === 'notes.md');

    // ════ E3. Éditeur → chat : sélection et fichier joint ═══════════════
    await call('openFile', 'src/util.py', false);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const px = window.__px();
        const ed = px.monacoRef.instance;
        const sel = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 14 };
        ed.setSelection(sel);
        px.editorCtxMenu.hasSelection = true;
        px.editorCtxMenu.selectionText = ed.getModel().getValueInRange(sel);
    });
    await call('askChatAboutSelection');
    await page.waitForTimeout(400);
    const draft = await val('px.inputMessage');
    ok('« Demander au chat » : chemin, lignes et bloc de code dans le prompt',
       /`src\/util\.py` \(lignes 1-2\)/.test(draft) && /```python\n/.test(draft));
    await call('attachToChat', 'notes.md');
    await page.waitForTimeout(700);
    ok('« Joindre au chat » : fichier joint au message', await val('(px.attachedFiles || []).some(f => f.name === "notes.md")'));
    await page.evaluate(() => { const px = window.__px(); px.inputMessage = ''; px.attachedFiles = []; });

    // ════ E. Chemin cliquable dans le chat ═══════════════════════════════
    // Le plein écran a masqué la barre latérale : on la rouvre.
    await page.evaluate(() => { window.__px().showSidebar = true; });
    await page.waitForTimeout(400);
    await page.locator('text=Chemins').first().click();
    await page.waitForTimeout(1200);
    const link = page.locator('code.elpis-path-link:has-text("src/util.py:2")').first();
    ok('chat : chemin rendu cliquable', await link.isVisible().catch(() => false));
    ok('chat : « os.path » n\'est pas un lien', (await page.locator('code.elpis-path-link:has-text("os.path")').count()) === 0);
    await link.click();
    await page.waitForTimeout(1200);
    ok('chat : clic → fichier ouvert dans l\'éditeur', (await val('px.activeTabPath')) === 'src/util.py');
    ok('chat : curseur à la ligne 2', (await val('px.statusCursor.line')) === 2);

    // ════ R. Constats de la relecture du 2026-09-19 ═══════════════════════
    // R1. Rechargement silencieux d'une PURE insertion / suppression de lignes :
    //     l'ancienne édition minimale corrompait le tampon (ligne perdue).
    await api('/__touch?path=src/util.py&content=' + encodeURIComponent('x\ny\nz\n'));
    await call('openFile', 'src/util.py', true);
    await page.waitForTimeout(700);
    ok('R1 base chargée', (await modelText()) === 'x\ny\nz\n');
    await api('/__touch?path=src/util.py&content=' + encodeURIComponent('x\ny\nNEW\nz\n'));
    await focusEvent();
    ok('R1 insertion pure venue du disque : tampon EXACT', (await modelText()) === 'x\ny\nNEW\nz\n');
    await api('/__touch?path=src/util.py&content=' + encodeURIComponent('x\nz\n'));
    await focusEvent();
    ok('R1 suppression pure venue du disque : tampon EXACT', (await modelText()) === 'x\nz\n');
    ok('R1 onglet resté propre (rien à enregistrer de faux)', (await val('px.isEditorDirty')) === false);
    await api('/__touch?path=src/util.py&content=' + encodeURIComponent('x\nz\nfin'));
    await focusEvent();
    ok('R1 ajout après la dernière ligne : tampon EXACT', (await modelText()) === 'x\nz\nfin');

    // R2. « Écraser » dans la FENÊTRE de conflit (Ctrl+S) écrit vraiment.
    await typeInEditor('\n# mien');
    await api('/__touch?path=src/util.py&content=' + encodeURIComponent('# autre processus\n'));
    await page.keyboard.press('Control+s');
    await choice('overwrite').waitFor();
    await choice('overwrite').click();
    await page.waitForTimeout(800);
    fsState = await api('/__fs');
    ok('R2 Écraser (fenêtre) : mon contenu est sur le disque', /# mien/.test(fsState.files['src/util.py']));
    ok('R2 Écraser (fenêtre) : onglet propre, plus de conflit',
        (await val('px.isEditorDirty')) === false && !(await page.locator('.elpis-editor-banner').isVisible().catch(() => false)));
    await typeInEditor('\n# suite');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(600);
    fsState = await api('/__fs');
    ok('R2 le fichier n\'est pas resté verrouillé', /# suite/.test(fsState.files['src/util.py']));

    // R3. Après un RENOMMAGE, l'enregistrement garde sa protection.
    const renamed = page.evaluate(() => window.__px().renameItem('src/util.py'));
    await page.locator('input[placeholder="nouveau nom"]').fill('renomme.py');
    await page.keyboard.press('Enter');
    await renamed;
    await page.waitForTimeout(600);
    ok('R3 onglet renommé', (await val('px.activeTabPath')) === 'src/renomme.py');
    await typeInEditor('\n# après renommage');
    await api('/__touch?path=src/renomme.py&content=' + encodeURIComponent('# écrit par le terminal\n'));
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(800);
    fsState = await api('/__fs');
    ok('R3 Ctrl+S après renommage : précondition envoyée',
        fsState.log.some((l) => l.op === 'save' && l.path === 'src/renomme.py' && typeof l.expected === 'number'));
    ok('R3 le disque n\'a PAS été écrasé en silence', fsState.files['src/renomme.py'] === '# écrit par le terminal\n');
    ok('R3 fenêtre de conflit proposée', await choice('reload').isVisible().catch(() => false));
    await choice('reload').click();
    await page.waitForTimeout(700);
    ok('R3 Recharger : tampon = disque', (await modelText()) === '# écrit par le terminal\n');

    // R4. Ctrl+B dans un champ de saisie ne bascule pas l'explorateur.
    await page.evaluate(() => { window.__px().showExplorer = true; });
    await page.waitForTimeout(200);
    const searchBox = page.locator('[data-editor-root] input[type="text"]:visible, [data-editor-root] input:not([type]):visible').first();
    if (await searchBox.count()) {
        await searchBox.click();
        await page.keyboard.press('Control+b');
        await page.waitForTimeout(200);
        ok('R4 Ctrl+B dans un champ : explorateur inchangé', (await val('px.showExplorer')) === true);
    }
    await page.locator('#monaco-editor .monaco-editor').first().click();
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(200);
    ok('R4 Ctrl+B dans le code : explorateur basculé', (await val('px.showExplorer')) === false);
    await page.evaluate(() => { window.__px().showExplorer = true; });

    // ════ T. Onglets à la largeur du nom (2026-09-20) ═══════════════════
    const tabEl = (p) => page.locator(`[role="tablist"] [role="tab"][data-path="${p}"]`).first();
    const tabW = (p) => tabEl(p).evaluate((el) => el.getBoundingClientRect().width);
    const headCut = (p) => tabEl(p).locator('.elpis-editor-tab-head').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    const tailOf = (p) => tabEl(p).locator('.elpis-editor-tab-tail').innerText();
    const LONG36 = 'src/configuration_serveur_principal.yaml';
    const LONG69 = 'src/rapport_de_verification_des_onglets_avec_un_nom_vraiment_tres_long.md';
    await call('openFile', LONG36, true);
    await page.waitForTimeout(500);
    const w36 = await tabW(LONG36);
    ok('T1 nom de 36 caractères lisible en entier (' + Math.round(w36) + ' px)', w36 > 200 && !(await headCut(LONG36))
        && (await tabEl(LONG36).evaluate((el) => el.textContent)).includes('configuration_serveur_principal.yaml'));
    await call('openFile', LONG69, true);
    await page.waitForTimeout(500);
    const w69 = await tabW(LONG69);
    ok('T2 nom de 69 caractères : plafond de 360 px (' + Math.round(w69) + ' px)', w69 > 300 && w69 <= 361);
    ok('T2 coupé au MILIEU : tête en ellipse, extension visible', (await headCut(LONG69)) && (await tailOf(LONG69)) === 'long.md');
    ok('T2 infobulle = chemin complet', (await tabEl(LONG69).getAttribute('title')) === LONG69);
    // Homonymes : l'indice de dossier n'est plus dans le texte coupé.
    await call('openFile', 'a/index.js', true);
    await call('openFile', 'b/index.js', true);
    await page.waitForTimeout(500);
    const hint = tabEl('b/index.js').locator('.elpis-editor-tab-hint');
    ok('T3 homonymes : indice de dossier entier', (await hint.innerText()).trim() === 'b'
        && await hint.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    // L'onglet actif est ramené dans la vue, quel que soit le chemin de bascule.
    // (fichier1/2.js ont été supprimés en B2 : on ouvre des fichiers existants)
    for (const f of ['src/app.py', 'src/deep/inner/b.py', 'fichier3.js', 'notes.md', 'docs/readme.md']) await call('openFile', f, true);
    await page.waitForTimeout(600);
    const inView = (p) => page.evaluate((path) => {
        const strip = document.querySelector('[role="tablist"]');
        const el = strip.querySelector(`[role="tab"][data-path="${path}"]`);
        const r = el.getBoundingClientRect(), b = strip.getBoundingClientRect();
        return r.left >= b.left - 1 && r.right <= b.right + 1;
    }, p);
    ok('T4 préalable : la barre déborde', await page.evaluate(() => { const s = document.querySelector('[role="tablist"]'); return s.scrollWidth > s.clientWidth + 1; }));
    const firstTab = await tabs().first().getAttribute('data-path');
    await page.evaluate(() => { document.querySelector('[role="tablist"]').scrollLeft = 99999; });
    await page.waitForTimeout(150);
    ok('T4 préalable : premier onglet hors de vue', !(await inView(firstTab)));
    await call('switchTab', firstTab);
    await page.waitForTimeout(400);
    ok('T4 bascule programmée : onglet actif ramené dans la vue', await inView(firstTab));
    ok('T4 badge « +N » cohérent après le défilement', (await val('px.hiddenTabsCount')) > 0);
    const nTabs = await tabs().count();
    await tabEl(firstTab).focus();
    for (let i = 0; i < nTabs - 1; i++) { await page.keyboard.press('Control+PageDown'); await page.waitForTimeout(120); }
    const lastActive = await val('px.activeTabPath');
    ok('T4 Ctrl+PageDown jusqu\'au dernier onglet : actif en vue', lastActive === (await tabs().last().getAttribute('data-path')) && await inView(lastActive));
    // Épinglé : compact, extension gardée.
    await call('togglePinTab', LONG69);
    await page.waitForTimeout(300);
    const wPin = await tabW(LONG69);
    ok('T5 épinglé : compact (' + Math.round(wPin) + ' px), extension gardée', wPin <= 151 && (await tailOf(LONG69)) === 'long.md');
    await call('togglePinTab', LONG69);
    await page.waitForTimeout(300);
    ok('T5 après épingler/désépingler : onglet actif toujours en vue', await inView(await val('px.activeTabPath')));
    // T6. Fermer un onglet à GAUCHE de l'actif : l'actif reste en vue.
    await call('switchTab', LONG36);
    await page.waitForTimeout(300);
    await page.evaluate((p) => {
        const strip = document.querySelector('[role="tablist"]');
        const el = strip.querySelector(`[role="tab"][data-path="${p}"]`);
        strip.scrollLeft += el.getBoundingClientRect().left - strip.getBoundingClientRect().left;
    }, LONG36);
    await page.waitForTimeout(150);
    ok('T6 préalable : onglet actif calé au bord gauche', await inView(LONG36));
    await call('closeTab', firstTab, null, true);
    await page.waitForTimeout(400);
    ok('T6 fermer un onglet à gauche : onglet actif toujours en vue', (await val('px.activeTabPath')) === LONG36 && await inView(LONG36));
    ok('T6 aucun message d\'erreur affiché', (await page.locator('text=Fichier introuvable').count()) === 0);
    await page.screenshot({ path: path.join(SHOTS, 'ux2-tabs.png') });

    await page.screenshot({ path: path.join(SHOTS, 'ux2-final.png') });
    ok('aucune erreur JS page', errors.length === 0);
    if (errors.length) console.log('   erreurs :', errors.slice(0, 5));
} catch (e) {
    ok('exécution sans exception : ' + String(e && e.message || e).split('\n')[0], false);
    try { await page.screenshot({ path: path.join(SHOTS, 'ux2-crash.png') }); } catch (_) {}
} finally {
    await browser.close();
}

const failed = checks.filter(([s]) => s === 'FAIL');
console.log(`\n${checks.length - failed.length}/${checks.length} PASS`);
process.exit(failed.length ? 1 : 0);
