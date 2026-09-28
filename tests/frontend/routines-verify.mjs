// SPDX-License-Identifier: MIT
// Vérif de la page « Routines » — journal des exécutions (route-mock) :
//   PERF_PORT=8907 node tests/frontend/routines-server.mjs &
//   PERF_PORT=8907 node tests/frontend/routines-verify.mjs
// Couvre ce qui manquait au journal : la réponse de la routine était affichée en
// TEXTE BRUT (dièses, pipes de tableau et backticks visibles) et rien ne reliait
// un run aux fichiers qu'il avait écrits — il fallait ouvrir l'éditeur et
// fouiller. On vérifie donc : rendu Markdown des runs OK, erreurs laissées en
// brut (et échappées), puces de fichiers, et ouverture dans l'éditeur.
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';
import os from 'os';

const SHOTS = process.env.SHOTS_DIR || os.tmpdir();

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({});
const root = () => page.locator('.elpis-routines-page');
const bodyHas = async (re) => re.test(await root().innerText().catch(() => ''));
const htmlHas = async (re) => re.test(await root().innerHTML().catch(() => ''));

try {
    page.setDefaultTimeout(8000);
    await gotoApp(page, '/');

    // ── Ouverture de la page + sélection de la routine ──────────────────
    await page.locator('button[title="Routines"]:visible').first().click();
    await page.waitForTimeout(700);
    ok('page routines ouverte', await root().isVisible());
    ok('routine listée', await bodyHas(/Veille quotidienne/));

    await root().locator('button:has-text("Veille quotidienne")').first().click();
    await page.waitForTimeout(600);
    ok('journal : section Exécutions', await bodyHas(/Exécutions/));
    ok('journal : run réussi listé', await bodyHas(/Réussi/));

    // Compteur de fichiers visible SANS déplier (repérer un run productif).
    ok('ligne repliée : compteur de fichiers', await htmlHas(/fichier\(s\) écrit\(s\)/));

    // ── Run OK : la réponse est du MARKDOWN rendu ───────────────────────
    await root().locator('[data-run-row][data-run-status="ok"]').first().click();
    await page.waitForTimeout(500);
    ok('détail : conteneur markdown-body', await htmlHas(/markdown-body/));
    ok('détail : titre rendu en <h2>', await htmlHas(/<h2[^>]*>\s*Rapport de veille/));
    ok('détail : liste rendue en <li>', await htmlHas(/<li>/));
    ok('détail : tableau rendu en <table>', await htmlHas(/<table/));
    ok('détail : bloc de code rendu en <pre>', await htmlHas(/<pre/));
    // le markup brut ne doit PLUS apparaître comme texte
    ok('détail : plus de « ## » ni de pipes en texte',
       !(await bodyHas(/## Rapport/)) && !(await bodyHas(/\| Dépôt \|/)));

    // ── Fichiers produits : puces cliquables → éditeur ───────────────────
    ok('détail : section Fichiers produits', await bodyHas(/Fichiers produits/));
    ok('détail : nom de fichier affiché en base name',
       await bodyHas(/veille\.md/) && await bodyHas(/commits\.csv/));
    ok('détail : chemin complet en title',
       await htmlHas(/title="\/work\/rapports\/veille\.md"/));

    await root().locator('button[title="/work/rapports/veille.md"]').first().click();
    await page.waitForTimeout(900);
    const opened = await fetch(BASE_URL + '/__opened').then(r => r.json()).then(d => d.opened);
    ok('clic sur une puce : fichier ouvert dans l\'éditeur',
       opened.some(p => String(p).includes('veille.md')));
    ok('clic sur une puce : page routines quittée', !(await root().isVisible().catch(() => false)));

    // ── Run en ERREUR : brut, échappé, jamais passé par marked ──────────
    await page.locator('button[title="Routines"]:visible').first().click();
    await page.waitForTimeout(700);
    await root().locator('button:has-text("Veille quotidienne")').first().click();
    await page.waitForTimeout(600);
    await root().locator('[data-run-row][data-run-status="error"]').first().click();
    await page.waitForTimeout(400);
    ok('erreur : texte brut conservé', await bodyHas(/## pas un titre/));
    ok('erreur : HTML de la trace échappé (pas injecté)',
       !(await htmlHas(/<b>pas du html<\/b>/)) && await bodyHas(/<b>pas du html<\/b>/));

    // ── Refonte UX 2026-08-02 : pleine largeur + colonnes + toggles MCP ──
    ok('vue : résumé en colonne latérale (grille xl)', await htmlHas(/xl:grid-cols-\[minmax\(17rem,21rem\)_1fr\]/));
    ok('vue : conteneur élargi (max-w-6xl)', await htmlHas(/max-w-6xl/));
    await page.screenshot({ path: `${SHOTS}/routines_view.png` });

    await root().locator('button:has-text("Configurer")').first().click();
    await page.waitForTimeout(500);

    // Édition plein écran par GROUPES : liste masquée, menu d'onglets au header.
    ok('édition : liste de gauche MASQUÉE', (await root().locator('div.w-80').count()) === 0);
    const tabs = root().locator('[data-routine-tabs] button');
    ok('édition : menu de groupes dans le header (6 onglets)', (await tabs.count()) === 6);
    ok('édition : onglet « Nom » actif par défaut', (await tabs.first().getAttribute('aria-current')) === 'true');
    ok('édition : groupe Nom affiché, groupe MCP caché',
       await root().locator('input[placeholder="Veille quotidienne"]').isVisible()
       && !(await root().locator('[data-mcp-local]').isVisible()));
    await page.screenshot({ path: `${SHOTS}/routines_edit.png` });

    // Onglet MCP : toggles (plus de checkbox visible).
    await root().locator('[data-routine-tabs] button:has-text("MCP")').click();
    await page.waitForTimeout(300);
    const localToggles = await root().locator('[data-mcp-local] .set-switch-track').count();
    const localInputs  = await root().locator('[data-mcp-local] input[type="checkbox"].peer').count();
    ok('MCP locaux : 4 lignes à TOGGLE (plus de checkbox visible)', localToggles === 4 && localInputs === 4);
    ok('MCP externes : 1 toggle (le serveur non visible est filtré)',
       (await root().locator('[data-mcp-external] .set-switch-track').count()) === 1);

    // Interaction : cliquer la ligne bascule l'état (input plein-rang opacity-0).
    const fsRow   = root().locator('[data-mcp-local] label', { hasText: 'Fichiers' });
    const fsInput = fsRow.locator('input');
    const wasOn   = await fsInput.isChecked();
    await fsRow.click();
    await page.waitForTimeout(200);
    ok('toggle « Fichiers » : bascule au clic sur la ligne', (await fsInput.isChecked()) === !wasOn);

    // Onglet Skills : le groupe s'affiche, MCP se cache (v-show, état conservé).
    await root().locator('[data-routine-tabs] button:has-text("Skills")').click();
    await page.waitForTimeout(300);
    ok('onglet Skills : groupe affiché, MCP caché',
       await bodyHas(/Skills attachés à la tâche/) && !(await root().locator('[data-mcp-local]').isVisible()));

    // Bug 2026-09-08 « les skills individuels ne sont pas dans le menu » : les
    // sous-skills d'un paquet étaient REPLIÉS d'office derrière un chevron
    // discret. Désormais tout est déplié par défaut (comme la page Skills) ;
    // le chevron replie, et le skill perso individuel est listé.
    ok('skills : sous-skills VISIBLES sans aucun clic',
       await bodyHas(/ansible-write-playbook/) && await bodyHas(/ansible-debug-runs/));
    ok('skills : skill perso individuel listé', await bodyHas(/analyse-fichier/));
    ok('skills : learned exclu du sélecteur', !(await bodyHas(/brouillon-learned/)));
    const chevron = root().locator('button[aria-label="Sous-skills de ansible"]');
    ok('skills : chevron du paquet marqué déplié', (await chevron.getAttribute('aria-expanded')) === 'true');
    await chevron.click();
    await page.waitForTimeout(200);
    ok('skills : le chevron REPLIE le paquet', !(await bodyHas(/ansible-write-playbook/))
       && (await chevron.getAttribute('aria-expanded')) === 'false');
    await chevron.click();
    await page.waitForTimeout(200);
    ok('skills : …et le redéplie', await bodyHas(/ansible-write-playbook/));
    // Cocher un sous-skill précis (sans passer par le paquet).
    const subRow = root().locator('label', { hasText: 'ansible-debug-runs' }).first();
    await subRow.click();
    await page.waitForTimeout(200);
    ok('skills : un sous-skill se coche individuellement',
       await subRow.locator('input').isChecked() && await bodyHas(/1 sélectionné/));

    await root().locator('[data-routine-tabs] button:has-text("MCP")').click();
    await page.waitForTimeout(300);
    ok('retour MCP : état du toggle CONSERVÉ', (await fsInput.isChecked()) === !wasOn);

    ok('édition : journal NON dupliqué (pas de section Exécutions)', !(await bodyHas(/Exécutions/)));

    // Un seul groupe à l'écran ⇒ AUCUN débordement vertical (pas de scrollbar),
    // et le scroller est pleine largeur (barre éventuelle au bord du panneau).
    const editScroll = await root().locator('div.overflow-y-auto:has([data-mcp-local])').first().evaluate(el => ({
        sh: el.scrollHeight, ch: el.clientHeight, right: el.getBoundingClientRect().right }));
    ok('édition : aucune scrollbar (contenu ≤ viewport)', editScroll.sh <= editScroll.ch + 1);
    ok('édition : scroller pleine largeur (bord du panneau)', editScroll.right >= 1430);
    await page.screenshot({ path: `${SHOTS}/routines_edit_mcp.png` });

    // Onglet Agents : opt-in PAR ROUTINE, replié tant qu'il est OFF, et le
    // casting réel (intégrés + agents custom du compte) annoncé une fois coché.
    await root().locator('[data-routine-tabs] button:has-text("Agents")').click();
    await page.waitForTimeout(300);
    const agentsSwitch = root().locator('label', { hasText: 'Déléguer à des sous-agents' }).locator('input');
    ok('onglet Agents : toggle présent et OFF par défaut',
       (await agentsSwitch.count()) === 1 && !(await agentsSwitch.isChecked()));
    ok('onglet Agents : rien d\'annoncé tant que c\'est OFF',
       !(await bodyHas(/Agents disponibles pendant le run/)));
    await root().locator('label', { hasText: 'Déléguer à des sous-agents' }).click();
    await page.waitForTimeout(250);
    ok('onglet Agents : casting intégré listé une fois coché',
       await bodyHas(/Agents disponibles pendant le run/)
       && await bodyHas(/explore/) && await bodyHas(/implement/)
       && await bodyHas(/verify/) && await bodyHas(/\bpr\b/));
    ok('onglet Agents : agents custom du compte listés aussi',
       await bodyHas(/redacteur/));

    // ── Historique PAR ROUTINE (2026-09-08) : « impossible de limiter le récap »
    //    → onglet Nom : exécutions gardées, notifications (toutes/échecs/aucune),
    //    notifications gardées ; envoyés au PUT et relus dans la vue lecture. ──
    await root().locator('[data-routine-tabs] button:has-text("Nom")').click();
    await page.waitForTimeout(250);
    const hist = root().locator('[data-routine-history]');
    ok('historique : bloc présent dans l\'onglet Nom', await hist.isVisible());
    const runsKeep   = hist.locator('[data-history-runs-keep]');
    const notifyOn   = hist.locator('[data-history-notify-on]');
    const notifyKeep = hist.locator('[data-history-notify-keep]');
    ok('historique : défauts 0 / Toutes / 0',
       (await runsKeep.inputValue()) === '0' && (await notifyOn.inputValue()) === 'all'
       && (await notifyKeep.inputValue()) === '0');
    await notifyOn.selectOption('none');
    await page.waitForTimeout(150);
    ok('historique : « Aucune » désactive le compteur de notifications', await notifyKeep.isDisabled());
    await notifyOn.selectOption('error');
    await runsKeep.fill('25');
    await notifyKeep.fill('10');
    await root().locator('button:has-text("Enregistrer")').first().click();
    await page.waitForTimeout(700);
    const put = await fetch(BASE_URL + '/__last_put').then(r => r.json()).then(d => d.body);
    ok('historique : PUT porte runs_keep/notify_on/notify_keep',
       !!put && put.runs_keep === 25 && put.notify_on === 'error' && put.notify_keep === 10);
    ok('historique : le sous-skill coché est dans le payload (id qualifié)',
       !!put && Array.isArray(put.skills) && put.skills.includes('ansible/ansible-debug-runs'));
    ok('enregistrer → vue lecture', await bodyHas(/Exécutions/));
    ok('vue : récap Journal / Notifications à jour',
       await bodyHas(/25 dernières/) && await bodyHas(/Échecs seulement/) && await bodyHas(/10 gardées/));
    ok('vue : sous-skill ciblé affiché en puce', await bodyHas(/ansible\/ansible-debug-runs/));

    // ── Centre de notifications (« récap ») : une notif d'une routine SUPPRIMÉE
    //    ne doit plus ouvrir en silence le journal d'une AUTRE routine. ──
    const bell = page.locator('button[aria-pressed]').filter({ has: page.locator('i.ph-bell, i.ph-bell-ringing') }).first();
    await bell.click();
    await page.waitForTimeout(500);
    ok('notifications : le récap liste les routines', await page.locator('.elpis-notif-pop').innerText().then(t => /Veille quotidienne/.test(t) && /Ancienne/.test(t)));
    await page.locator('.elpis-notif-pop [role="button"]', { hasText: 'Ancienne' }).first().click();
    await page.waitForTimeout(700);
    ok('notifications : routine supprimée → message explicite', /Routine introuvable/.test(await page.locator('body').innerText()));

    await root().locator('button:has-text("Configurer")').first().click();
    await page.waitForTimeout(400);
    await root().locator('button:has-text("Annuler")').first().click();
    await page.waitForTimeout(400);
    ok('annuler → retour à la vue (journal visible)', await bodyHas(/Exécutions/));

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
