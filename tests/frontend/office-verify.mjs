// SPDX-License-Identifier: MIT
// Vérif des aperçus Office / PDF de l'éditeur et de la garde binaire (2026-09-15) :
//   PERF_PORT=8950 node tests/frontend/office-server.mjs &
//   PERF_PORT=8950 node tests/frontend/office-verify.mjs
//
// Couvre : rendu Pages (visualiseur PDF natif) et grille xlsx virtualisée,
// aucune sauvegarde possible sur un visualiseur ou un binaire détecté, courses
// entre onglets, annulation silencieuse, erreurs lisibles + repli texte,
// revalidation sur modif disque, garde updateEditor, vue scindée, et
// stabilité mémoire sur cycles ouvrir/fermer (nœuds, listeners, observers).
// Cf. docs/editor-office-preview-design-2026-09-15.md
import { launch, gotoApp, BASE_URL, releveMemoire, penteParCycle, listenersOrphelins, observateursOrphelins } from '../perf/lib/harness.mjs';

const SHOTS_DIR = process.env.SHOTS_DIR || '/tmp';
const checks = [];
const ok = (name, cond, extra) => {
    checks.push([cond ? 'PASS' : 'FAIL', name]);
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined && !cond ? '  → ' + JSON.stringify(extra) : ''));
};

const { browser, page, cdp, errors } = await launch({ reducedMotion: 'reduce' });
const api = async (p) => (await fetch(BASE_URL + p)).json();
const tree = (name) => page.locator(`[role="treeitem"][aria-label="Fichier ${name}"]`).first();
const tab = (name) => page.locator(`[role="tab"]:has-text("${name}")`).first();
const overlay = () => page.locator('[role="region"][aria-label="Aperçu du document"]');
const monacoActive = () => page.evaluate(() => document.getElementById('monaco-editor').classList.contains('active'));
const vm = () => page.evaluate(() => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    return { active: p.activeTabPath, mode: p.activeFileViewMode, office: p.officeActive && { status: p.officeActive.status, view: p.officeActive.view, key: p.officeActive.key, url: p.officeActive.pdfUrl } };
});
const iframeSrc = () => page.locator('iframe[title="Pages"]').first().getAttribute('src').catch(() => null);
const toasts = () => page.evaluate(() => document.body.innerText);
async function open(name) {
    await tree(name).click();
    await page.waitForTimeout(700);
}
async function ctrlS() {
    await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
    await page.waitForTimeout(400);
}

try {
    page.setDefaultTimeout(15000);
    await api('/__reset');
    await gotoApp(page, '/');
    ok('app montée', true);
    await page.locator('button[title*="Éditeur"]:visible').first().click();
    await page.waitForTimeout(900);
    await page.locator('[role="treeitem"][aria-label="Dossier docs"]').first().click();
    await page.waitForTimeout(300);

    // ── 1. docx → Pages (PDF natif) ──────────────────────────────────────
    await open('rapport.docx');
    await page.waitForTimeout(1200);
    ok('docx : overlay d\'aperçu visible', await overlay().isVisible().catch(() => false));
    const src1 = await iframeSrc();
    ok('docx : iframe Pages sur /api/sandbox/office/pdf/<clé>/rapport.pdf', !!src1 && /\/api\/sandbox\/office\/pdf\/[0-9a-f]{40}\/rapport\.pdf#view=FitH$/.test(src1), src1);
    ok('docx : calque Monaco inactif', !(await monacoActive()));
    ok('docx : pas d\'attribut sandbox sur l\'iframe (visualiseur natif)',
       (await page.locator('iframe[title="Pages"]').first().getAttribute('sandbox')) === null);
    const pdfRendered = page.frames().some((f) => f.url().startsWith('chrome-extension://'));
    console.log('    (visualiseur PDF natif chargé dans l\'iframe : ' + pdfRendered + ')');
    let log = await api('/__log');
    ok('docx : un seul prepare, aucun download texte', log.prepare.filter((p) => p.path === 'docs/rapport.docx').length === 1
       && !log.download.some((d) => d.path === 'docs/rapport.docx'), log);
    await ctrlS();
    log = await api('/__log');
    ok('docx : Ctrl+S n\'envoie aucun POST /save', log.save.length === 0, log.save);
    await page.screenshot({ path: SHOTS_DIR + '/office-docx.png' });

    // ── 2. PDF ───────────────────────────────────────────────────────────
    await open('doc.pdf');
    await page.waitForTimeout(800);
    const srcPdf = await iframeSrc();
    ok('pdf : iframe Pages', !!srcPdf && srcPdf.includes('/doc.pdf#view=FitH'), srcPdf);

    // ── 3. xlsx → grille virtualisée ─────────────────────────────────────
    await open('classeur.xlsx');
    await page.waitForTimeout(1200);
    const grid = page.locator('[role="grid"]').first();
    ok('xlsx : grille visible', await grid.isVisible().catch(() => false));
    ok('xlsx : en-tête de colonne A', await page.locator('[role="columnheader"]:text-is("A")').first().isVisible().catch(() => false));
    ok('xlsx : cellule R0C0 affichée', await page.locator('[role="gridcell"]:has-text("R0C0")').first().isVisible().catch(() => false));
    const cells0 = await page.locator('[role="gridcell"]').count();
    await grid.evaluate((el) => { el.scrollTop = 4000 * 22; });
    await page.waitForTimeout(900);
    ok('xlsx : cellule R4000C0 après défilement', await page.locator('[role="gridcell"]:has-text("R4000C0")').first().isVisible().catch(() => false));
    const cells1 = await page.locator('[role="gridcell"]').count();
    ok('xlsx : DOM borné (cellules rendues < 1500 à la ligne 4000)', cells1 < 1500 && cells0 < 1500, { cells0, cells1 });
    const num = await page.locator('[role="gridcell"]:has-text("40000")').first().getAttribute('class').catch(() => '');
    ok('xlsx : nombres alignés à droite', /justify-end/.test(num || ''), num);
    await grid.evaluate((el) => { el.scrollLeft = 5000; });
    await page.waitForTimeout(400);
    ok('xlsx : virtualisation horizontale (colonne AD visible)', await page.locator('[role="columnheader"]:text-is("AD")').first().isVisible().catch(() => false));
    log = await api('/__log');
    const chunks = [...new Set(log.sheet.map((s) => s.sheet + ':' + s.chunk))];
    ok('xlsx : seuls les morceaux utiles demandés (< 6 sur 25)', chunks.length > 0 && chunks.length < 6, chunks);
    await page.locator('[role="tab"]:has-text("Masquée")').first().click();
    await page.waitForTimeout(700);
    ok('xlsx : onglet de feuille masquée → contenu', await page.locator('[role="gridcell"]:has-text("secret 0")').first().isVisible().catch(() => false));
    await page.locator('button[aria-pressed]:has-text("Pages")').first().click();
    await page.waitForTimeout(900);
    log = await api('/__log');
    ok('xlsx : « Pages » demande view=pages', log.prepare.some((p) => p.path === 'docs/classeur.xlsx' && p.view === 'pages'), log.prepare);
    ok('xlsx : « Pages » affiche l\'iframe', !!(await iframeSrc()));
    await page.locator('button[aria-pressed]:has-text("Grille")').first().click();
    await page.waitForTimeout(700);
    ok('xlsx : retour à la grille', await page.locator('[role="grid"]').first().isVisible().catch(() => false));
    await page.screenshot({ path: SHOTS_DIR + '/office-xlsx.png' });

    // ── 4. Binaire détecté à l'ouverture (.txt avec NUL) ─────────────────
    await open('binaire.txt');
    await page.waitForTimeout(800);
    const bodyText = await toasts();
    ok('binaire : visualiseur hex (« Fichier binaire — 9 011 octets »)', /Fichier binaire — 9\s011 octets/.test(bodyText));
    ok('binaire : calque Monaco inactif', !(await monacoActive()));
    await ctrlS();
    log = await api('/__log');
    ok('binaire : Ctrl+S n\'envoie aucun POST /save', log.save.length === 0, log.save);
    ok('binaire : 4 Ko lus par Range', log.download.some((d) => d.path === 'docs/binaire.txt' && d.range === 'bytes=0-4095'), log.download);
    const noModel = await page.evaluate(() => !window.monaco.editor.getModels().some((m) => m.uri.path.endsWith('binaire.txt')));
    ok('binaire : aucun modèle Monaco', noModel);

    // ── 5. Texte normal toujours éditable ────────────────────────────────
    await open('script.py');
    await page.waitForTimeout(900);
    ok('script.py : Monaco actif', await monacoActive());

    // ── 6. Course : prepare lent puis autre onglet ───────────────────────
    await api('/__reset');
    await tree('lent.docx').click();
    await page.waitForTimeout(150);
    await tree('doc.pdf').click();
    await page.waitForTimeout(2600);
    const race = await vm();
    const srcRace = await iframeSrc();
    ok('course : l\'onglet actif reste doc.pdf', race.active === 'docs/doc.pdf', race);
    ok('course : l\'iframe montre doc.pdf, pas lent.docx', !!srcRace && srcRace.includes('/doc.pdf'), srcRace);

    // ── 7. Fermer un onglet en cours de conversion : silencieux ──────────
    await api('/__reset');
    await tree('lent.docx').click();
    await page.waitForTimeout(250);
    await page.evaluate(() => {
        const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
        p.closeTab('docs/lent.docx', null, true);
    });
    await page.waitForTimeout(2300);
    const after7 = await toasts();
    ok('fermeture pendant conversion : pas de toast « Erreur réseau »', !/Erreur réseau/.test(after7));
    ok('fermeture pendant conversion : aucune entrée d\'aperçu résiduelle',
       await page.evaluate(() => !Object.keys(document.getElementById('app').__vue_app__._container._vnode.component.proxy.officeActive || {}).length
           || document.getElementById('app').__vue_app__._container._vnode.component.proxy.activeTabPath !== 'docs/lent.docx'));

    // ── 8. Erreurs lisibles + repli texte ────────────────────────────────
    await open('occupe.docx');
    await page.waitForTimeout(800);
    ok('erreur busy : message « Conversions occupées »', await page.locator('[role="alert"]:has-text("Conversions occupées")').first().isVisible().catch(() => false));
    ok('erreur busy : bouton Réessayer', await page.locator('[role="alert"] button:has-text("Réessayer")').first().isVisible().catch(() => false));
    ok('erreur busy : pas de bouton Texte', !(await page.locator('[role="alert"] button:has-text("Texte")').first().isVisible().catch(() => false)));
    await open('sans-lo.docx');
    await page.waitForTimeout(800);
    const texte = page.locator('[role="alert"] button:has-text("Texte")').first();
    ok('LibreOffice absent : bouton Texte', await texte.isVisible().catch(() => false));
    await texte.click();
    await page.waitForTimeout(1200);
    ok('repli texte : Monaco actif sur l\'extraction', await monacoActive());
    ok('repli texte : badge Lecture seule (.docx)', await page.locator('text=Lecture seule (.docx)').first().isVisible().catch(() => false));
    log = await api('/__log');
    ok('repli texte : read-docx appelé', log.readDocx.some((r) => r.path === 'docs/sans-lo.docx'), log.readDocx);
    await page.screenshot({ path: SHOTS_DIR + '/office-texte.png' });

    await open('disparu.docx');
    await page.waitForTimeout(900);
    ok('fichier disparu : onglet retiré', !(await tab('disparu.docx').isVisible().catch(() => false)));

    // ── 9. Modif disque de l'onglet actif → reconversion silencieuse ─────
    await open('rapport.docx');
    await page.waitForTimeout(900);
    const before9 = await iframeSrc();
    await api('/__bump?path=' + encodeURIComponent('docs/rapport.docx'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1500);
    const after9 = await iframeSrc();
    ok('modif disque : nouvelle clé dans l\'iframe', !!before9 && !!after9 && before9 !== after9, { before9, after9 });
    ok('modif disque : pas de toast « Re-cliquez »', !/Re-cliquez/.test(await toasts()));

    // ── 10. updateEditor (résultat d'outil) sur un docx ──────────────────
    await page.evaluate(async () => {
        const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
        await p.updateEditor('docs/slides.pptx', 'PK contenu binaire décodé');
    });
    await page.waitForTimeout(1200);
    const st10 = await vm();
    ok('updateEditor(pptx) : ouvre l\'aperçu, pas de modèle Monaco',
       st10.active === 'docs/slides.pptx' && st10.mode === 'office'
       && await page.evaluate(() => !window.monaco.editor.getModels().some((m) => m.uri.path.endsWith('slides.pptx'))), st10);
    ok('pptx : iframe en #view=Fit', ((await iframeSrc()) || '').endsWith('#view=Fit'));

    // ── 11. Vue scindée : un visualiseur s'ouvre à gauche ────────────────
    await open('script.py');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
        p.enterSplit(); p.activePane = 'right';
    });
    await page.waitForTimeout(600);
    await tab('rapport.docx').click();
    await page.waitForTimeout(900);
    const st11 = await page.evaluate(() => {
        const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
        return { active: p.activeTabPath, pane: p.activePane, right: p.splitTabPath };
    });
    ok('vue scindée : docx activé à gauche, focus basculé', st11.active === 'docs/rapport.docx' && st11.pane === 'left' && st11.right !== 'docs/rapport.docx', st11);
    await page.evaluate(() => document.getElementById('app').__vue_app__._container._vnode.component.proxy.exitSplit());
    await page.waitForTimeout(400);

    // ── 12. Menu « + » : actions sans objet masquées sur un aperçu ───────
    await page.locator('button[title="Plus d\'actions"][aria-haspopup="menu"]:visible').first().click();
    await page.waitForTimeout(250);
    const menu = page.locator('[role="menu"][aria-label="Actions de l\'éditeur"]');
    ok('menu + : « Sauvegarder » masqué', !(await menu.locator('button:has-text("Sauvegarder")').first().isVisible().catch(() => false)));
    ok('menu + : « Mode diff » masqué', !(await menu.locator('button:has-text("Mode diff")').first().isVisible().catch(() => false)));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    // ── 13. Fuites : cycles ouvrir xlsx / défiler / docx / fermer ────────
    const closeAll = () => page.evaluate(() => {
        const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
        [...p.openTabs].forEach((t) => p.closeTab(t.path, null, true));
    });
    await closeAll();
    await page.waitForTimeout(600);
    const releves = [];
    const CYCLES = 16;
    for (let i = 0; i < CYCLES; i++) {
        await tree('classeur.xlsx').click();
        await page.waitForTimeout(500);
        await page.locator('[role="grid"]').first().evaluate((el) => { el.scrollTop = 2000 * 22; });
        await page.waitForTimeout(250);
        await tree('rapport.docx').click();
        await page.waitForTimeout(450);
        await tree('binaire.txt').click();
        await page.waitForTimeout(300);
        await closeAll();
        await page.waitForTimeout(350);
        releves.push(await releveMemoire(page, cdp));
    }
    const first = releves[0], last = releves[releves.length - 1];
    const serie = (k) => releves.map((r) => r[k]);
    console.log('    nœuds     : ' + serie('noeuds').join(' '));
    console.log('    listeners : ' + serie('listeners').join(' '));
    console.log('    tas (Mo)  : ' + serie('tasMo').join(' '));
    // Régime établi = seconde moitié (les premiers cycles allouent légitimement :
    // widgets Monaco, conteneur de toasts, caches) — cf. penteParCycle.
    const pNoeuds = penteParCycle(serie('noeuds'));
    const pLis = penteParCycle(serie('listeners'));
    const pTas = penteParCycle(serie('tasMo'));
    ok('fuites : pente nœuds DOM en régime ≤ 2/cycle', pNoeuds.pente <= 2, pNoeuds);
    ok('fuites : pente listeners en régime ≤ 0,5/cycle', pLis.pente <= 0.5, pLis);
    ok('fuites : pente tas JS en régime ≤ 0,2 Mo/cycle', pTas.pente <= 0.2, pTas);
    ok('fuites : intervals vifs stables', (last.intervalsVifs || 0) <= (releves[Math.floor(CYCLES / 2)].intervalsVifs || 0), { first: first.intervalsVifs, last: last.intervalsVifs });
    const obs = observateursOrphelins(last._leak).filter((o) => o.nom === 'ResizeObserver');
    const obs0 = observateursOrphelins(releves[Math.floor(CYCLES / 2)]._leak).filter((o) => o.nom === 'ResizeObserver');
    ok('fuites : ResizeObserver de la grille déconnectés', (obs[0] ? obs[0].solde : 0) <= (obs0[0] ? obs0[0].solde : 0), { obs0, obs });
    const lis = listenersOrphelins(last._leak).filter((l) => /office/i.test(l.site));
    ok('fuites : aucun listener orphelin posé par le code office', lis.length === 0, lis.slice(0, 3));

    const errs = errors.filter((e) => !/ResizeObserver|favicon/.test(e));
    ok('aucune erreur JS', errs.length === 0, errs);
} catch (e) {
    ok('exécution sans exception : ' + (e && e.message ? e.message.split('\n')[0] : e), false);
}

await browser.close();
const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
