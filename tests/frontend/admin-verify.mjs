// SPDX-License-Identifier: MIT
// Vérif de rendu de la console admin, route-mock sans backend.
//   PERF_PORT=8903 node tests/frontend/admin-server.mjs &
//   PERF_PORT=8903 node tests/frontend/admin-verify.mjs
//
// Refonte de la console (2026-09-27) : 5 entrées (Supervision, Modèles & services, Utilisateurs
// & accès, Sandbox, Système) dépliées en sous-pages, une page = une
// fonctionnalité, en-tête unique, liens profonds #<page> et alias des anciens
// identifiants, menu « Compte et apparence » dans le pied de la barre.
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const PORT = Number(process.env.PERF_PORT || 8903);
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
// Erreurs qu'un handler Vue avale (getter de watch, rendu) : journalisées en
// console, jamais remontées en ``pageerror``.
const vueErrors = [];
page.on('console', (m) => {
    if (m.type() === 'error' && /^(TypeError|ReferenceError|RangeError|SyntaxError)\b|before initialization|Unhandled error/.test(m.text())) vueErrors.push(m.text());
});
const txtVisible = (t) => page.locator(`button:has-text("${t}"):visible`).first().isVisible().catch(() => false);
const clickTxt = (t) => page.locator(`button:has-text("${t}"):visible`).first().click();
// Nav : sélecteurs SCOPÉS à la barre latérale (les libellés courts se
// retrouvent dans le contenu). Une entrée déplie ses sous-pages.
const entryVisible = (t) => page.locator(`aside .adm-nav__entry:has-text("${t}"):visible`).first().isVisible().catch(() => false);
const subVisible = (t) => page.locator(`aside .adm-nav__sub:has-text("${t}"):visible`).first().isVisible().catch(() => false);
async function goPage(entry, sub) {
    await page.locator(`aside .adm-nav__entry:has-text("${entry}"):visible`).first().click();
    await page.waitForTimeout(150);
    if (sub) await page.locator(`aside .adm-nav__sub:has-text("${sub}"):visible`).first().click();
    await page.waitForTimeout(550);
}
const bodyHas = async (re) => re.test(await page.locator('#app').innerText().catch(() => ''));
const headTitle = async () => (await page.locator('.adm-page-head__title').first().innerText().catch(() => '')).trim();
const headParent = async () => (await page.locator('.adm-page-head__parent').first().innerText().catch(() => '')).trim();
// Barre d'enregistrement : présente SEULEMENT quand la page est modifiée.
const saveBtn = () => page.locator('.adm-savebar button:has-text("Enregistrer")').first();
const pageClean = async () => !(await page.locator('.adm-savebar').isVisible().catch(() => false));
const dirtyCount = async () => (await page.locator('.adm-savebar__count').innerText().catch(() => '')).trim();
const choiceDlg = () => page.locator('div.z-\\[7000\\]');
const patchLog = async () => (await page.evaluate(() => fetch('/__config_patch_log').then(r => r.json()))).items;

try {
    page.setDefaultTimeout(8000);
    // gotoApp ne rend la main QUE si #app perd v-cloak → preuve que les
    // templates Vue compilent (une référence non exportée throw au mount).
    await gotoApp(page, '/');
    ok('console admin montée (templates compilent)', true);
    // Le serveur de mock garde son état entre deux exécutions : on repart
    // explicitement de « Caddy absent, HTTP direct », sinon la passe
    // précédente fausserait les contrôles du panneau HTTPS désactivé.
    await page.evaluate(() => fetch('/__caddy_down'));

    // ─────────────────────────────────────────────────────────────────
    //  NAV — 6 entrées ; la Vue d'ensemble est la page d'arrivée
    // ─────────────────────────────────────────────────────────────────
    for (const label of ['Vue d’ensemble', 'Supervision', 'Modèles & services', 'Utilisateurs & accès', 'Sandbox', 'Système']) {
        ok(`nav : entrée ${label}`, await entryVisible(label));
    }
    // Les entrées de l'ancienne arborescence (par nature technique) ont disparu.
    for (const gone of ['Connexions', 'Comportement LLM', 'Maintenance', 'Base de données', 'Configuration']) {
        ok(`nav : « ${gone} » n'est plus une entrée`, !(await entryVisible(gone)));
    }
    ok('nav : page d\'arrivée = Vue d’ensemble (sans parent)',
       (await headTitle()) === 'Vue d’ensemble' && (await headParent()) === '');
    ok('nav : entrée à page unique annoncée (aria-current sur l’entrée)',
       (await page.locator('aside .adm-nav__entry[aria-current="page"]:visible').innerText()).includes('Vue d’ensemble'));
    ok('nav : sous-pages repliées sur la page d’arrivée', !(await subVisible('Compression')) && !(await subVisible('Rapport')));

    // ─────────────────────────────────────────────────────────────────
    //  VUE D'ENSEMBLE (lot 6) — À traiter, services, 24 h, installation
    // ─────────────────────────────────────────────────────────────────
    await page.waitForTimeout(400);
    const alertsTxt = await page.locator('.adm-ov__alerts').innerText().catch(() => '');
    ok('vue : « À traiter » liste les alertes', /Redémarrage nécessaire/.test(alertsTxt)
       && /RAG injoignable/.test(alertsTxt) && /Aucune sauvegarde/.test(alertsTxt));
    ok('vue : redémarrage — pages concernées nommées (Inférence, Entretien, autres)',
       /Inférence/.test(alertsTxt) && /Entretien/.test(alertsTxt) && /autres réglages/.test(alertsTxt));
    ok('vue : chaque alerte porte son geste',
       await page.locator('.adm-ov__alert[data-level] button:has-text("Redémarrer")').isVisible()
       && await page.locator('.adm-ov__alert button:has-text("Télécharger une sauvegarde")').isVisible()
       && await page.locator('.adm-ov__alert button[aria-label="Ouvrir : RAG injoignable"]').isVisible());
    ok('vue : compteur « À traiter » sur l’entrée de la barre latérale',
       (await page.locator('aside .adm-nav__count').innerText().catch(() => '')).startsWith('3'));
    const svcRows = page.locator('.adm-ov__svc tbody tr');
    ok('vue : inventaire des services (9 lignes)', (await svcRows.count()) === 9);
    ok('vue : état injoignable signalé en clair', /Injoignable/.test(await page.locator('.adm-status[data-state="down"]').innerText()));
    ok('vue : service désactivé neutre', (await page.locator('.adm-status[data-state="off"]').count()) === 1);
    ok('vue : dernières 24 h (actifs, tours, tokens, échecs, sauvegarde)',
       /Utilisateurs actifs\s*5/.test(await page.locator('.adm-ov__kpis').innerText())
       && /1,2 M/.test(await page.locator('.adm-ov__kpis').innerText())
       && /jamais/.test(await page.locator('.adm-ov__kpis').innerText()));
    ok('vue : fraîcheur annoncée dans l’en-tête', /Actualisé il y a/.test(await page.locator('.adm-page-head').innerText()));
    ok('vue : installation incomplète proposée (3 / 5)',
       /3 \/ 5/.test(await page.locator('.adm-ov__setup summary').innerText().catch(() => '')));
    ok('vue : pas de bandeau de redémarrage ici (il est dans « À traiter »)',
       !(await page.locator('.adm-restartbar').isVisible().catch(() => false)));
    // « Tout tester » force une tournée (admin seulement).
    const st0 = await page.evaluate(() => fetch('/__overview_stats').then(r => r.json()));
    await page.locator('button:has-text("Tout tester")').click();
    await page.waitForTimeout(300);
    const st1 = await page.evaluate(() => fetch('/__overview_stats').then(r => r.json()));
    ok('vue : « Tout tester » force une nouvelle tournée', st1.refresh === st0.refresh + 1);
    // Un service mène à la page qui le règle.
    await page.locator('button[aria-label="Régler : RAG"]').click();
    await page.waitForTimeout(500);
    ok('vue : un service ouvre sa page (RAG)', (await headTitle()) === 'RAG');
    ok('vue : ailleurs, bandeau « Redémarrage nécessaire » avec son geste',
       await page.locator('.adm-restartbar').isVisible()
       && /3 réglages en attente/.test(await page.locator('.adm-restartbar').innerText())
       && await page.locator('.adm-restartbar button:has-text("Redémarrer")').isVisible());
    // Le bouton Redémarrer demande confirmation, en annonçant ce qu'il applique.
    await page.locator('.adm-restartbar button:has-text("Redémarrer")').click();
    await page.waitForTimeout(200);
    ok('redémarrage : confirmation qui annonce les réglages appliqués',
       /Applique 3 réglages en attente/.test(await choiceDlg().innerText().catch(() => '')));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    await goPage('Supervision', 'Métriques');
    ok('nav : Supervision déplie ses sous-pages',
       await subVisible('Rapport') && await subVisible('Appels d’outils') && await subVisible('Journaux'));
    ok('nav : sous-pages des autres entrées repliées', !(await subVisible('Compression')));
    ok('nav : page courante annoncée (aria-current)',
       (await page.locator('aside .adm-nav__sub[aria-current="page"]:visible').innerText()).trim() === 'Métriques');
    ok('nav : un seul h1, le titre de la page',
       (await page.locator('h1:visible').count()) === 1);
    ok('nav : plus de badge « Admin » ni de barre d\'ancres',
       !(await page.locator('.adm-anchor, .adm-head').count()));
    ok('nav : pas de défilement horizontal',
       await page.evaluate(() => { const sc = document.querySelector('.adm-scroller');
           return document.documentElement.scrollWidth <= document.documentElement.clientWidth
               && (!sc || sc.scrollWidth <= sc.clientWidth); }));

    // ── Supervision › Métriques (lot 5) : barre = période + « ⋯ », tous les
    //    indicateurs groupés, couleur = anomalie, graphes résumés en texte ──
    await page.waitForTimeout(600);
    ok('métriques : groupes titrés (Activité, Volume)',
       await page.locator('.adm-kpis__label', { hasText: 'Activité' }).isVisible()
       && await page.locator('.adm-kpis__label', { hasText: 'Volume' }).isVisible());
    ok('métriques : plus d’onglets de catégorie', !(await page.locator('.adm-chip').count()));
    ok('métriques : tous les indicateurs d’un coup (Activité + Volume + Système)',
       await bodyHas(/Utilisateurs actifs/) && await bodyHas(/Tokens consommés/) && await bodyHas(/RAM/));
    // L'unité PORTE la fenêtre : le titre ne peut plus mentir en annonçant
    // « (24h) » quand le sélecteur est sur 30 j.
    ok('KPI : fenêtre annoncée dans l’unité', await bodyHas(/actifs \/ 30 j/));
    ok('KPI : détail affiché', await bodyHas(/hors 8h–19h/));
    ok('set curé : widget non curé masqué par défaut', !(await bodyHas(/Widget hors set curé/)));
    // Couleur : seul l'indicateur en anomalie (mock : RAM « warn ») se teinte.
    ok('KPI : anomalie signalée (RAM à surveiller), les autres neutres',
       (await page.locator('.adm-kpi--warn').count()) === 1
       && (await page.locator('.adm-kpi--danger').count()) === 0
       && /à surveiller/.test(await page.locator('.adm-kpi--warn').innerText()));
    ok('barre : période + un seul bouton d’options',
       await page.locator('.adm-dash__bar .adm-seg').isVisible()
       && (await page.locator('.adm-dash__bar > .relative > button').count()) === 1);
    ok('barre : plus de purge ni d’Auto-admin au premier niveau',
       !(await txtVisible('Réinitialiser')) && !(await bodyHas(/Auto-admin|Auto-chat/)));

    // ── Chargement paresseux de chart.js ──────────────────────────────────
    await page.waitForTimeout(600);
    ok('chart.js chargé à la demande par le dashboard',
       await page.evaluate(() => typeof window.Chart !== 'undefined'));
    ok('un graphique est réellement peint (canvas non vierge)',
       await page.evaluate(() => {
           const cv = document.querySelector('canvas[id^="chart_"]');
           if (!cv || !cv.width || !cv.height) return false;
           const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
           for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return true;
           return false;
       }));
    ok('graphe : résumé texte accessible sur le canvas',
       /Consommation par source\./.test(await page.locator('canvas#chart_usage_timeline').getAttribute('aria-label') || '')
       && (await page.locator('canvas#chart_usage_timeline').getAttribute('role')) === 'img');
    ok('graphe : action Réinitialiser présente',
       await page.locator('button[aria-label^="Réinitialiser"]:visible').first().isVisible().catch(() => false));
    ok('widget table rendu (pics par utilisateur)', await bodyHas(/Pics par utilisateur/));
    ok('table : lignes utilisateurs', await bodyHas(/bob/) && await bodyHas(/37\.8 k/));
    ok('table : fuseau rappelé', await bodyHas(/Heures en CEST/));

    // Menu « ⋯ » : widgets, export, collecte, cadences libellées.
    const dots = page.locator('button[aria-label="Options du tableau de bord"]');
    await dots.click(); await page.waitForTimeout(200);
    ok('options : cadences libellées (Indicateurs, Temps réel)',
       await bodyHas(/Actualisation/) && await bodyHas(/Temps réel/) && await bodyHas(/\d+ s/));
    await page.locator('.adm-dash__menu button:has-text("Widgets")').click(); await page.waitForTimeout(200);
    ok('sélecteur : marque « défaut »', (await page.locator('.adm-dash__menu .adm-tag:not(.adm-tag--soft)').count()) > 0);
    ok('sélecteur : widget non curé listé', await bodyHas(/Widget hors set curé/));
    ok('sélecteur : retour au défaut', await txtVisible('Défaut'));
    await page.locator('.adm-pop__back').click(); await page.waitForTimeout(150);
    await page.locator('.adm-dash__menu button:has-text("Collecte Prometheus")').click(); await page.waitForTimeout(400);
    ok('collecte : endpoint affiché', await bodyHas(/metrics\/prometheus/));
    ok('collecte : jeton affiché', await bodyHas(/scrape-demo-token/));
    ok('collecte : révocation proposée', await txtVisible('Révoquer'));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    ok('options : Échap referme le menu', !(await page.locator('.adm-dash__menu').count()));
    await dots.click(); await page.waitForTimeout(150);
    await page.locator('h1').click(); await page.waitForTimeout(150);
    ok('options : clic dehors referme le menu', !(await page.locator('.adm-dash__menu').count()));

    // ── Supervision : l'ancienne page « Outils » scindée en trois ──
    await goPage('Supervision', 'Appels d’outils');
    await page.waitForTimeout(300);
    ok('appels d’outils : titre', (await headTitle()) === 'Appels d’outils');
    ok('appels d’outils : top outils rendu', await bodyHas(/Top outils/));
    ok('appels d’outils : pas de journaux ici', !(await bodyHas(/Journaux en direct|échec réseau/)));
    await goPage('Supervision', 'Audit');
    ok('audit : titre et journal d’audit', (await headTitle()) === 'Audit' && await bodyHas(/Audit récent/));
    await goPage('Supervision', 'Journaux');
    ok('journaux : titre', (await headTitle()) === 'Journaux');
    ok('journaux : amorcés depuis le serveur', await bodyHas(/échec réseau/));

    await goPage('Supervision', 'Rapport');
    ok('Rapport du jour rendu', await bodyHas(/Rapport du jour/));
    // Le libellé du toggle est passé en rangée de réglage (« Envoi
    // automatique » + état), comme partout ailleurs dans la console.
    ok('toggle digest automatique présent', await bodyHas(/Envoi automatique/));

    // ─────────────────────────────────────────────────────────────────
    //  SYSTÈME › INSTANCE (ex-« Général »)
    // ─────────────────────────────────────────────────────────────────
    await goPage('Système', 'Instance');
    ok('instance : titre et parent', (await headTitle()) === 'Instance' && (await headParent()) === 'Système');
    ok('instance : section Identité', await bodyHas(/Nom de l’application|Identité/));
    ok('instance : chemins disque présents', await bodyHas(/Dossier des sandboxes/));
    ok('instance : les fonctionnalités sont parties dans Droits par défaut', !(await bodyHas(/OpenCode/)));
    ok('instance : plus de sous-onglets « Identité & branding »', !(await bodyHas(/Identité & branding/)));

    // ── Enregistrement par écran : barre en bas, seulement si modifié ──
    await page.evaluate(() => fetch('/__config_patch_reset'));
    ok('enregistrement : pas de barre sans modification', await pageClean());
    await page.locator('#cfg-app-name').fill('Elpis QA');
    await page.waitForTimeout(200);
    ok('enregistrement : barre après édition, « 1 modification »', (await dirtyCount()) === '1 modification');
    ok('enregistrement : Annuler et Enregistrer dans la barre',
       await page.locator('.adm-savebar button:has-text("Annuler")').isVisible() && await saveBtn().isVisible());
    // « Voir » : le champ, son libellé, l'ancienne et la nouvelle valeur.
    await page.locator('.adm-savebar button:has-text("Voir")').click();
    await page.waitForTimeout(150);
    const chg = await page.locator('#adm-changes').innerText().catch(() => '');
    ok('voir : libellé et valeurs (Elpis → Elpis QA)', /Nom/.test(chg) && /Elpis\s*→\s*Elpis QA/.test(chg));
    // Rétablir le champ depuis la liste : la page redevient propre.
    await page.locator('#adm-changes button[aria-label^="Rétablir"]').first().click();
    await page.waitForTimeout(200);
    ok('voir : rétablir un champ remet la page au propre',
       await pageClean() && (await page.locator('#cfg-app-name').inputValue()) === 'Elpis');

    // Enregistrer : un PATCH avec LE champ modifié et sa valeur lue sur disque.
    await page.locator('#cfg-app-name').fill('Elpis QA');
    await page.waitForTimeout(150);
    await saveBtn().click();
    await page.waitForTimeout(600);
    ok('enregistrement : toast de confirmation', await bodyHas(/Modifications enregistrées/));
    ok('enregistrement : barre disparue', await pageClean());
    let plog = await patchLog();
    ok('PATCH : seul le champ modifié part, avec sa valeur sur disque',
       plog.length === 1 && JSON.stringify(plog[0].changes) === JSON.stringify([{ path: 'app_info.name', to: 'Elpis QA', from: 'Elpis' }]));

    // Ctrl+S enregistre la page.
    await page.locator('#cfg-app-version').fill('2.0.0');
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(600);
    plog = await patchLog();
    ok('Ctrl+S : enregistre la page', await pageClean() && plog.length === 2
       && plog[1].changes[0].path === 'app_info.version' && plog[1].changes[0].to === '2.0.0');

    // Garde de sortie : Rester, puis Ignorer.
    await page.locator('#cfg-app-name').fill('Brouillon');
    await page.waitForTimeout(150);
    await goPage('Système', 'Données');
    ok('garde : dialogue à la sortie d’une page modifiée',
       await choiceDlg().locator('button:has-text("Rester")').isVisible().catch(() => false)
       && await choiceDlg().locator('button[data-choice="discard"]').isVisible().catch(() => false)
       && await choiceDlg().locator('button[data-choice="save"]').isVisible().catch(() => false));
    await choiceDlg().locator('button:has-text("Rester")').click();
    await page.waitForTimeout(250);
    ok('garde : « Rester » garde la page et la saisie',
       (await headTitle()) === 'Instance' && (await page.locator('#cfg-app-name').inputValue()) === 'Brouillon');
    await goPage('Système', 'Données');
    await choiceDlg().locator('button[data-choice="discard"]').click();
    await page.waitForTimeout(600);
    plog = await patchLog();
    ok('garde : « Ignorer » quitte sans rien envoyer', (await headTitle()) === 'Données' && plog.length === 2);

    // Garde : « Enregistrer » envoie puis quitte.
    await goPage('Système', 'Instance');
    await page.locator('#cfg-app-name').fill('Elpis prod');
    await page.waitForTimeout(150);
    await goPage('Système', 'Accès HTTPS');
    await choiceDlg().locator('button[data-choice="save"]').click();
    await page.waitForTimeout(900);
    plog = await patchLog();
    ok('garde : « Enregistrer » envoie puis quitte',
       (await headTitle()) === 'Accès HTTPS' && plog.length === 3 && plog[2].changes[0].to === 'Elpis prod');

    // Conflit : le champ a changé sur le serveur depuis l'ouverture de la page.
    // Deux champs modifiés, le premier en conflit : « Reprendre » adopte la
    // valeur du serveur ET envoie l'autre, sans signaler d'échec.
    await goPage('Système', 'Instance');
    await page.evaluate(() => fetch('/__config_conflict_next'));
    await page.locator('#cfg-app-name').fill('Mon nom');
    await page.locator('#cfg-app-team').fill('Équipe B');
    await page.waitForTimeout(150);
    const avantConflit = (await patchLog()).length;
    await saveBtn().click();
    await page.waitForTimeout(500);
    ok('conflit : dialogue « Modifié ailleurs entre-temps »', /Modifié ailleurs entre-temps/.test(await choiceDlg().innerText().catch(() => '')));
    await choiceDlg().locator('button[data-choice="reload"]').click();
    await page.waitForTimeout(600);
    ok('conflit : la valeur du serveur est reprise, page propre',
       (await page.locator('#cfg-app-name').inputValue()) === 'valeur-serveur' && await pageClean());
    plog = await patchLog();
    const renvoi = plog[plog.length - 1];
    ok('conflit : l\'autre modification est envoyée après « Reprendre »',
       plog.length === avantConflit + 2 && !renvoi.force
       && renvoi.changes.length === 1 && renvoi.changes[0].path === 'app_info.team_name'
       && renvoi.changes[0].to === 'Équipe B');
    ok('conflit : pas de faux échec signalé', !(await bodyHas(/Enregistrement échoué|échec : réglages/)));

    // ─────────────────────────────────────────────────────────────────
    //  MODÈLES & SERVICES — une fonctionnalité par page
    // ─────────────────────────────────────────────────────────────────
    await goPage('Modèles & services', 'Inférence');
    ok('inférence : titre et parent', (await headTitle()) === 'Inférence' && (await headParent()) === 'Modèles & services');
    ok('inférence : sous-pages du domaine',
       await subVisible('Compression') && await subVisible('RAG') && await subVisible('Vision & machines')
       && await subVisible('Voix') && await subVisible('Images') && await subVisible('Outils MCP') && await subVisible('Prompts'));
    // Sélecteur de moteur : intégré ↔ connecteur partagé.
    ok('inférence : sélecteur de moteur', await bodyHas(/Moteur à configurer/));
    // Réglages rares (URL complète, reprises, capacité) repliés dans « Avancé ».
    ok('inférence : réglages rares repliés dans Avancé', !(await bodyHas(/Capacité/)) && !(await bodyHas(/URL complète/)));
    await page.locator('#engine details.adm-details--rows > summary').click();
    await page.waitForTimeout(150);
    ok('inférence : Avancé déplie la capacité llama.cpp', await bodyHas(/Capacité/));
    // L'URL complète qui visait l'ancien hôte:port suit le nouvel hôte.
    await page.locator('#cnx-llama-url').fill('http://127.0.0.1:8080/v1/chat/completions');
    await page.locator('[data-field="config:llama.ip"]').fill('10.0.0.9');
    await page.waitForTimeout(200);
    ok('inférence : l\'URL complète suit l\'hôte',
       (await page.locator('#cnx-llama-url').inputValue()) === 'http://10.0.0.9:8080/v1/chat/completions');
    await page.locator('.adm-savebar button:has-text("Annuler")').click();
    await page.waitForTimeout(400);
    await page.evaluate(() => { const d = document.querySelector('#engine details.adm-details--rows'); if (d) d.open = true; });
    await page.waitForTimeout(150);
    await page.locator('#cnx-llama-engine').selectOption('vllm');
    await page.waitForTimeout(200);
    ok('inférence : vLLM masque les champs llama.cpp', !(await bodyHas(/Capacité/)));
    await page.locator('#cnx-llama-engine').selectOption('llamacpp');
    await page.waitForTimeout(200);
    const engineRows = page.locator('#engine [role="option"]');
    ok('inférence : moteurs listés (intégré + partagés)', (await engineRows.count()) >= 2);
    ok('inférence : adresse du connecteur visible dans la liste',
       /10\.0\.0\.5:8000\/v1/.test(await page.locator('#engine').innerText().catch(() => '')));
    await engineRows.nth(1).click();
    await page.waitForTimeout(300);
    // Connecteur : édité dans un tiroir (plus de carte dans la carte).
    const drawer = page.locator('.adm-drawer[role="dialog"]');
    ok('inférence : connecteur ouvert dans un tiroir', await drawer.isVisible()
       && /Adresse/.test(await drawer.innerText()));
    ok('inférence : le tiroir garde ses actions (Tester, Supprimer, Enregistrer)',
       await drawer.locator('button:has-text("Enregistrer")').isVisible()
       && await drawer.locator('button:has-text("Tester")').isVisible()
       && await drawer.locator('button:has-text("Supprimer")').isVisible());
    ok('inférence : focus déplacé dans le tiroir',
       await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.adm-drawer')));
    ok('inférence : ligne sélectionnée marquée',
       (await page.locator('#engine [role="option"][aria-selected="true"]').count()) === 1);
    ok('inférence : actions de ligne visibles sans survol',
       await page.locator('#engine button[aria-label="Tester la connexion"]').first().isVisible());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('inférence : Échap ferme le tiroir', !(await drawer.count()));
    // La planification vit avec le moteur qu'elle règle.
    ok('inférence : planification sur la même page', await bodyHas(/Planification/) && await bodyHas(/Optimisé/));
    ok('inférence : état propre au chargement', await pageClean());
    await page.locator('input[type=radio][value="optimized"]').first().check();
    await page.waitForTimeout(250);
    ok('inférence : 1 modification (planification)', (await dirtyCount()) === '1 modification');
    await saveBtn().click();
    await page.waitForTimeout(800);
    ok('inférence : enregistré', await bodyHas(/Modifications enregistrées/) && await pageClean());

    // Compression : adresse ET règles sur un seul écran (c'était le cas type
    // d'une fonctionnalité éclatée sur deux pages).
    await goPage('Modèles & services', 'Compression');
    ok('compression : titre', (await headTitle()) === 'Compression');
    ok('compression : service et règles ensemble',
       await page.locator('#compression-endpoint').isVisible().catch(() => false)
       && await page.locator('#compression-rules').isVisible().catch(() => false));
    ok('compression : plus de renvoi vers une autre page', !(await bodyHas(/Comportement LLM|Connexions/)));
    await page.locator('#llm-comp-max').fill('3');
    await page.waitForTimeout(250);
    ok('compression : 1 modification', (await dirtyCount()) === '1 modification');
    await saveBtn().click();
    await page.waitForTimeout(800);
    ok('compression : enregistrée', await pageClean());

    await goPage('Modèles & services', 'RAG');
    ok('rag : valeur chargée depuis config.json',
       (await page.locator('#cnx-rag-url').inputValue().catch(() => '')) === 'http://127.0.0.1:8000');
    await goPage('Modèles & services', 'Outils MCP');
    ok('mcp : commande chargée',
       (await page.locator('#cnx-mcp-cmd').inputValue().catch(() => '')) === 'python mcp_server.py');
    // Autorisation OAuth des clients MCP (EXT.4) : réglages + clients enregistrés.
    ok('mcp : carte OAuth (défauts du serveur)',
       await bodyHas(/Autorisation OAuth des clients MCP/)
       && await page.locator('#cnx-oa-on').isChecked().catch(() => false)
       && (await page.locator('#cnx-oa-ttl').inputValue().catch(() => '')) === '3600');
    ok('mcp : clients OAuth listés', await bodyHas(/Éditeur de recette/) && await bodyHas(/1 autorisation\b/));
    await goPage('Modèles & services', 'Vision & machines');
    ok('vision : annotation visuelle', await bodyHas(/Annotation visuelle/));
    ok('vision : machines de contrôle', /win-vm-01/.test(await page.locator('#desktop-targets').innerHTML().catch(() => '')));
    ok('vision : mémoire AX rattachée aux machines', await bodyHas(/Mémoire AX/) && await txtVisible('Effacer la mémoire AX'));
    await goPage('Modèles & services', 'Voix');
    const voxTxt = await page.locator('#app').innerText();
    ok('voix : voix proposées en liste (lues sur le serveur)',
       (await page.locator('select#cnx-voice-voix option').count()) === 2);
    ok('voix : voix vide pré-remplie avec celle chargée par le serveur',
       (await page.locator('select#cnx-voice-voix').inputValue().catch(() => '')) === 'fr_FR-upmc-medium');
    ok('voix : whisper.cpp — modèle non saisi',
       /Celui chargé au démarrage du serveur/.test(voxTxt) && (await page.locator('#cnx-voice-stt-model').count()) === 0);
    ok('voix : format piper-http proposé',
       (await page.locator('#cnx-voice-tts-fmt option[value="piper-http"]').count()) === 1);

    // Images : carte compacte en trois groupes, clé hors formulaire, test qui
    // ajuste les limites, groupes autorisés.
    await goPage('Modèles & services', 'Images');
    ok('images : titre et parent', (await headTitle()) === 'Images' && (await headParent()) === 'Modèles & services');
    ok('images : trois groupes (Connexion, Limites, Accès)',
       await bodyHas(/CONNEXION|Connexion/) && await bodyHas(/LIMITES|Limites/) && await bodyHas(/ACCÈS|Accès/));
    ok('images : adresse chargée depuis config.json',
       (await page.locator('#cnx-image-url').inputValue().catch(() => '')) === 'http://10.0.0.9:8084');
    ok('images : clé enregistrée signalée, jamais affichée',
       /Enregistrée/.test(await page.locator('#cnx-image-key').getAttribute('placeholder').catch(() => ''))
       && (await page.locator('#cnx-image-key').inputValue()) === '');
    await page.waitForTimeout(400);
    ok('images : modèle lu sur le serveur (sd-server)', await bodyHas(/Qwen-Image/));
    ok('images : groupes proposés (Tous + groupes)',
       await page.locator('#images [role="group"] button:has-text("Tous")').count() === 1
       && await page.locator('#images [role="group"] button:has-text("Équipe data")').count() === 1);
    ok('images : état propre au chargement', await pageClean());
    await page.locator('[data-image-test]').click();
    await page.waitForTimeout(500);
    ok('images : ligne d\'état du test',
       /✓ Qwen-Image · 42 ms · max 1536 · 2\/lot/.test(await page.locator('[data-image-test-result]').innerText().catch(() => '')));
    ok('images : limites ajustées au moteur (2 modifications)',
       (await page.locator('#cnx-image-maxside').inputValue()) === '1536' && (await dirtyCount()) === '2 modifications');
    await page.locator('#images [role="group"] button:has-text("Équipe data")').click();
    await page.waitForTimeout(200);
    ok('images : groupe coché (3 modifications)', (await dirtyCount()) === '3 modifications');
    await page.locator('#cnx-image-key').fill('sk-test');
    await page.locator('[data-image-key-save]').click();
    await page.waitForTimeout(400);
    const ilog = await page.evaluate(() => fetch('/__image_log').then(r => r.json()));
    ok('images : clé envoyée à part, champ vidé, formulaire inchangé',
       ilog.some((e) => e.kind === 'key' && e.present) && (await page.locator('#cnx-image-key').inputValue()) === ''
       && (await dirtyCount()) === '3 modifications');
    ok('images : clé liée à l\'adresse du formulaire',
       ilog.some((e) => e.kind === 'key' && e.present && e.url === 'http://10.0.0.9:8084'));
    ok('images : clé à jour, pas d\'état « À ressaisir »', await page.locator('[data-image-key-stale]').count() === 0);
    // Clé enregistrée pour une autre adresse : « À ressaisir » sur la ligne Clé.
    await page.evaluate(() => fetch('/__image_key', { method: 'POST', body: JSON.stringify({ has_key: false, stale: true }) }));
    await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.loadImageAdmin());
    await page.waitForTimeout(300);
    ok('images : clé d\'une autre adresse → « À ressaisir »',
       (await page.locator('[data-image-key-stale]').innerText().catch(() => '')).trim() === 'À ressaisir'
       && (await page.locator('[data-image-key-stale]').getAttribute('title')) === 'Clé enregistrée pour une autre adresse'
       && (await page.locator('#cnx-image-key').getAttribute('placeholder')) === 'À ressaisir');
    await page.evaluate(() => fetch('/__image_key', { method: 'POST', body: JSON.stringify({ has_key: true, stale: false }) }));
    await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.loadImageAdmin());
    await page.waitForTimeout(300);
    await saveBtn().click();
    await page.waitForTimeout(800);
    const iplog = await patchLog();
    const ichanges = (iplog[iplog.length - 1] || {}).changes || [];
    ok('images : enregistrement champ par champ, sans la clé',
       ichanges.some((c) => c.path === 'image.max_side' && c.to === 1536)
       && ichanges.some((c) => c.path === 'image.groups' && JSON.stringify(c.to) === '[5]')
       && !ichanges.some((c) => /api_key/.test(c.path)) && await pageClean());

    // Droits par défaut : ce que TOUS les comptes peuvent utiliser.
    await goPage('Utilisateurs & accès', 'Droits par défaut');
    ok('droits : titre', (await headTitle()) === 'Droits par défaut');
    ok('droits : fournisseurs autorisés', await bodyHas(/Fournisseurs autorisés/));
    ok('droits : sélecteur de modèle', await bodyHas(/Sélecteur de modèle/));
    ok('droits : fonctionnalités (OpenCode, aperçu Office)', await bodyHas(/OpenCode/) && await bodyHas(/Aperçu Office/));

    // ─────────────────────────────────────────────────────────────────
    //  SÉCURITÉ
    // ─────────────────────────────────────────────────────────────────
    await goPage('Utilisateurs & accès', 'Mots de passe & sessions');
    ok('sessions : titre', (await headTitle()) === 'Mots de passe & sessions');
    ok('sessions : politique de mot de passe', await bodyHas(/Longueur minimale/));
    ok('sessions : durée de connexion', await bodyHas(/Durée de connexion/));
    ok('sessions : révocation (action immédiate)', await txtVisible('Révoquer toutes les sessions'));
    await goPage('Système', 'Accès HTTPS');
    ok('https : titre', (await headTitle()) === 'Accès HTTPS');
    ok('https : état HTTP direct affiché', await bodyHas(/HTTP direct/));
    const httpsBtn = page.locator('#https button:has-text("Activer le HTTPS")').first();
    ok('https : bouton désactivé sans Caddy', await httpsBtn.isDisabled().catch(() => false));
    ok('https : aide install_caddy.sh', await bodyHas(/install_caddy\.sh/));

    // ─────────────────────────────────────────────────────────────────
    //  UTILISATEURS — comptes + groupes sur une page
    // ─────────────────────────────────────────────────────────────────
    await goPage('Utilisateurs & accès', 'Comptes');
    ok('comptes : titre', (await headTitle()) === 'Comptes');
    ok('comptes : filtre et création dans l’en-tête',
       await page.locator('.adm-page-head input[aria-label="Filtrer les comptes"]').isVisible().catch(() => false)
       && await page.locator('.adm-page-head button:has-text("Créer un compte")').isVisible().catch(() => false));
    // ── Refonte 2026-09-23 : table en lecture seule + éditeur en ligne ─────
    // La table résume les valeurs EFFECTIVES ; « Modifier » déplie un seul
    // formulaire (compte, inférence, sandbox, machines) ; Enregistrer n'envoie
    // QUE ce qui a changé.
    await page.evaluate(() => fetch('/__llm_access_reset'));
    ok('utilisateurs : colonnes résumées',
       await bodyHas(/Serveurs/) && await bodyHas(/Sandbox/) && await bodyHas(/Machines/));
    ok('utilisateurs : aucun contrôle éditable dans la table',
       (await page.locator('#accounts tbody tr:not([id]) select, #accounts tbody tr:not([id]) input').count()) === 0);
    const srvCells = page.locator('td[data-llm-servers]');
    const manCells = page.locator('td[data-llm-manage]');
    const dskCells = page.locator('td[data-desktop]');
    ok('accès : compte sans règle = « Tous » / « Oui »',
       (await srvCells.nth(0).innerText()).trim() === 'Tous' && (await manCells.nth(0).innerText()).trim() === 'Oui');
    ok('accès : liste propre = « 1 / 3 » (dénominateur = options)',
       (await srvCells.nth(1).innerText()).trim() === '1 / 3');
    ok('accès : gestion interdite = « Non »', (await manCells.nth(1).innerText()).trim() === 'Non');
    ok('accès : infobulle nomme la source et les serveurs',
       /Réglé sur le compte — Serveur intégré/.test(await srvCells.nth(1).getAttribute('title') || ''));
    ok('machines : alice 1 / 2, bob Toutes',
       (await dskCells.nth(0).innerText()).trim() === '1 / 2' && (await dskCells.nth(1).innerText()).trim() === 'Toutes');
    ok('réseau : profil imposé = cadenas', (await page.locator('#accounts td i.ph-lock-simple').count()) === 1);

    // Éditeur de bob : état chargé depuis sa ligne.
    const editBtn = (n) => page.locator('#accounts button[aria-controls^="user-edit-"]').nth(n);
    await editBtn(1).click();
    await page.waitForTimeout(350);
    const dlg = page.locator('[data-user-edit]');
    ok('éditeur : déplié sous la ligne', await dlg.isVisible().catch(() => false)
       && (await editBtn(1).getAttribute('aria-expanded')) === 'true');
    const pressed = async (group, label) => (await dlg.locator(`[role="group"][aria-label="${group}"] button:has-text("${label}")`)
        .first().getAttribute('aria-pressed')) === 'true';
    ok('éditeur : Enregistrer inactif sans changement',
       await dlg.locator('button[type=submit]').isDisabled());
    ok('accès : mode « Liste » pré-sélectionné', await pressed('Serveurs', 'Liste'));
    ok('accès : 3 serveurs proposés, intégré coché',
       (await dlg.locator('[data-llm-access-list] input[type=checkbox]').count()) === 3
       && await dlg.locator('[data-llm-access-list] input[value="builtin"]').isChecked());
    ok('accès : connecteur désactivé signalé', /désactivé/.test(await dlg.locator('[data-llm-access-list]').innerText()));
    ok('accès : gestion « Interdit » pré-sélectionnée', await pressed('Gérer les modèles', 'Interdit'));
    ok('machines : vm-prod cochée, vm-lab ouverte verrouillée',
       await dlg.locator('[data-desktop-access] input[value="vm-prod"]').isChecked()
       && (await dlg.locator('[data-desktop-access] input[disabled]').count()) === 1);
    await dlg.locator('[data-llm-access-list] input[value="builtin"]').uncheck();
    ok('accès : liste vide signalée', /aucun accès/.test(await dlg.innerText()));
    // Tous + Hérité → un seul PUT llm-access, rien d'autre.
    await dlg.locator('[role="group"][aria-label="Serveurs"] button:has-text("Tous")').click();
    await dlg.locator('[role="group"][aria-label="Gérer les modèles"] button:has-text("Hérité")').click();
    ok('accès : liste masquée hors mode « Liste »', (await dlg.locator('[data-llm-access-list]').count()) === 0);
    ok('éditeur : changement signalé', /non enregistrées/.test(await dlg.innerText()));
    await dlg.locator('button[type=submit]').click();
    await page.waitForTimeout(500);
    let log = (await page.evaluate(() => fetch('/__llm_access_log').then(r => r.json()))).items;
    ok('accès : seul le PUT llm-access est envoyé (Tous + Hérité)',
       log.length === 1 && log[0].url === '/api/admin/users/3/llm-access'
       && JSON.stringify(log[0].body) === JSON.stringify({ engine_keys: ['*'], can_manage_models: null }));
    ok('éditeur : refermé après enregistrement', !(await dlg.isVisible().catch(() => false)));

    // Alice : machine + quota → deux appels, dans l'ordre, rien d'autre.
    await page.evaluate(() => fetch('/__llm_access_reset'));
    await editBtn(0).click();
    await page.waitForTimeout(300);
    ok('accès : compte sans règle = « Hérité » des deux côtés',
       await pressed('Serveurs', 'Hérité') && await pressed('Gérer les modèles', 'Hérité'));
    await dlg.locator('[data-desktop-access] input[value="vm-prod"]').check();
    await dlg.locator('input[aria-label^="Quota"]').fill('2048');
    await dlg.locator('button[type=submit]').click();
    await page.waitForTimeout(500);
    log = (await page.evaluate(() => fetch('/__llm_access_log').then(r => r.json()))).items;
    ok('éditeur : quota puis machines, seuls envoyés',
       log.length === 2 && log[0].url === '/api/admin/users/2/sandbox-quota' && log[0].body.quota_mb === 2048
       && log[1].url === '/api/admin/users/2/desktop-targets'
       && JSON.stringify(log[1].body) === JSON.stringify({ targets: ['vm-prod'] }));

    // Échap referme sans rien envoyer.
    await page.evaluate(() => fetch('/__llm_access_reset'));
    await editBtn(0).click();
    await page.waitForTimeout(250);
    await dlg.locator('input[aria-label^="Quota"]').fill('10');
    await dlg.locator('input[aria-label^="Quota"]').press('Escape');
    await page.waitForTimeout(250);
    log = (await page.evaluate(() => fetch('/__llm_access_log').then(r => r.json()))).items;
    ok('éditeur : Échap referme sans envoyer', !(await dlg.isVisible().catch(() => false)) && log.length === 0);

    // Groupe : modale d'édition, règle chargée, ajout d'un serveur + interdit.
    await goPage('Utilisateurs & accès', 'Groupes');
    ok('groupes : titre', (await headTitle()) === 'Groupes');
    await page.evaluate(() => fetch('/__llm_access_reset'));
    await page.locator('button[title="Renommer Équipe data"]').click();
    await page.waitForTimeout(350);
    const gdlg = page.locator('[role="dialog"][aria-label="Modifier le groupe"]');
    const gpressed = async (group, label) => (await gdlg.locator(`[role="group"][aria-label="${group}"] button:has-text("${label}")`)
        .first().getAttribute('aria-pressed')) === 'true';
    ok('accès groupe : modale avec règle « Liste » chargée',
       await gdlg.isVisible().catch(() => false) && await gpressed('Serveurs', 'Liste')
       && await gdlg.locator('[data-llm-access-list] input[value="conn:7"]').isChecked());
    ok('accès groupe : défaut de gestion = « Libre »', await gpressed('Gérer les modèles', 'Libre'));
    await gdlg.locator('[data-llm-access-list] input[value="builtin"]').check();
    await gdlg.locator('[role="group"][aria-label="Gérer les modèles"] button:has-text("Interdit")').click();
    await gdlg.locator('button:has-text("Enregistrer")').click();
    await page.waitForTimeout(500);
    log = (await page.evaluate(() => fetch('/__llm_access_log').then(r => r.json()))).items;
    const gput = log.find(e => e.url === '/api/admin/groups/5/llm-access');
    ok('accès groupe : PUT envoyé (liste + interdit)',
       !!gput && JSON.stringify(gput.body) === JSON.stringify({ engine_keys: ['conn:7', 'builtin'], can_manage_models: false }));

    // ─────────────────────────────────────────────────────────────────
    //  PROMPTS
    // ─────────────────────────────────────────────────────────────────
    await goPage('Modèles & services', 'Prompts');
    ok('prompts : titre', (await headTitle()) === 'Prompts');
    ok('prompts groupés (Base chatbot)', await bodyHas(/Base chatbot/));
    ok('prompts : libellé humain', await bodyHas(/Identité du chatbot/));
    // Un seul titre de page : le bandeau local (titre + « Recharger ») a été
    // absorbé par l'en-tête partagé.
    ok('prompts : un seul titre de page', (await page.locator('h1:visible').count()) === 1);
    ok('prompts : « Recharger » dans l’en-tête',
       await page.locator('.adm-page-head button:has-text("Recharger")').first().isVisible().catch(() => false));

    // ─────────────────────────────────────────────────────────────────
    //  SANDBOX — même patron, sauvegarde unifiée
    // ─────────────────────────────────────────────────────────────────
    await goPage('Sandbox', 'Limites & politique');
    ok('sandbox : titre et parent', (await headTitle()) === 'Limites & politique' && (await headParent()) === 'Sandbox');
    ok('sandbox : sous-pages', await subVisible('Réseau') && await subVisible('Hôtes d’outils') && await subVisible('Containers'));
    ok('sandbox : plus de comparatif des modes',
       !(await bodyHas(/Comparatif des modes/)) && !(await bodyHas(/Mode dossier/)));
    ok('sandbox : bandeau environnement', await bodyHas(/elpis\/sandbox:1\.5\.0/));
    ok('sandbox : limites par container', await bodyHas(/Limites par container/));
    ok('sandbox : politique — forcer Docker', await bodyHas(/Forcer Docker pour tous/));
    ok('sandbox : politique — arrêt d’inactivité', await bodyHas(/Arrêt d'inactivité/));
    ok('sandbox : avancé replié par défaut', !(await bodyHas(/UID:GID/)));
    await page.locator('summary:has-text("Avancé")').first().click();
    await page.waitForTimeout(250);
    ok('sandbox : avancé — identité des exécutions', await bodyHas(/UID:GID/));
    ok('sandbox : avancé — runtime OCI', await bodyHas(/Runtime OCI/));
    ok('sandbox : avancé — flags docker run pré-remplis',
       (await page.locator('#sb-extra-args').inputValue().catch(() => '')) === '--shm-size=2g');
    // Enregistrement de la page Limites, avant de passer au réseau.
    await page.locator('#sb-mem').fill('4096');
    await page.waitForTimeout(250);
    ok('sandbox : barre après édition', (await dirtyCount()) === '1 modification');
    await saveBtn().click();
    await page.waitForTimeout(600);
    ok('sandbox : enregistré', await pageClean());

    await goPage('Sandbox', 'Réseau');
    ok('réseau : titre', (await headTitle()) === 'Réseau');
    ok('sandbox : profils — description éditable',
       (await page.locator('input[placeholder="Description vue par l\'utilisateur"]').nth(1).inputValue().catch(() => '')) === 'Accès au LAN.');
    // ── Profils réseau : cartes repliables + allowlist en puces (2026-08-05) ──
    ok('sandbox : une carte par profil, repliée',
       (await page.locator('.np-card').count()) === 2
       && (await page.locator('.np-card--open').count()) === 0
       && !(await page.locator('#np-ips-1').isVisible().catch(() => false)));
    ok('sandbox : badge de mode par profil',
       (await page.locator('.np-badge--block:has-text("Bloqué")').count()) === 1
       && (await page.locator('.np-badge--filter:has-text("Filtré")').count()) === 1);
    ok('sandbox : résumé des règles sans déplier',
       await bodyHas(/Aucune sortie réseau/) && await bodyHas(/1 réseau · 1 domaine · ports 443/));
    // Déplier le profil filtré pour l'éditer.
    await page.locator('.np-card').nth(1).locator('.np-card__toggle').click();
    await page.waitForTimeout(300);
    ok('sandbox : carte dépliée = éditeur visible',
       (await page.locator('.np-card--open').count()) === 1
       && await page.locator('#np-ips-1').isVisible().catch(() => false));
    ok('sandbox : mode en boutons (dont « Tout bloquer »)',
       (await page.locator('.np-seg__btn:has-text("Tout bloquer")').count()) === 2
       && (await page.locator('.np-seg__btn.np-seg__btn--block').count()) === 1);
    ok('sandbox : profil filtré — puces pré-remplies',
       (await page.locator('.np-chip:has-text("10.20.0.0/24")').count()) === 1
       && (await page.locator('.np-chip:has-text("github.com")').count()) === 1
       && (await page.locator('.np-chip:has-text("443")').count()) === 1);
    ok('sandbox : aucun emoji', !/🔒|🌐|📋|📁|📦/.test(await page.locator('#app').innerHTML()));
    ok('réseau : état propre au chargement', await pageClean());
    // Un brouillon EN COURS DE FRAPPE n'est pas une modification : il ne
    // vit que dans l'UI, il ne part pas au serveur.
    await page.locator('#np-ips-1').fill('10.0.0.0');
    await page.waitForTimeout(250);
    ok('sandbox : brouillon hors du calcul « non enregistré »',
       await pageClean());
    // Validation à la saisie : la valeur devient une puce, le champ se vide,
    // et LÀ la page est modifiée.
    await page.locator('#np-ips-1').fill('10.0.0.0/8');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    ok('sandbox : ajout d’une IP en puce',
       (await page.locator('.np-chip:has-text("10.0.0.0/8")').count()) === 1
       && (await page.locator('#np-ips-1').inputValue()) === ''
       && !(await pageClean()));
    // Saisie invalide : refusée SUR PLACE, gardée dans le champ, motif affiché.
    await page.locator('#np-ips-1').fill('10.0.0.300');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    ok('sandbox : IP invalide refusée à la saisie',
       (await bodyHas(/n'est ni une IP ni un CIDR/))
       && (await page.locator('#np-ips-1').inputValue()) === '10.0.0.300');
    await page.locator('#np-ips-1').fill('');
    // Retrait d'une puce.
    await page.locator('.np-chip:has-text("github.com") button').first().click();
    await page.waitForTimeout(250);
    ok('sandbox : retrait d’une puce',
       (await page.locator('.np-chip:has-text("github.com")').count()) === 0);
    await saveBtn().click();
    await page.waitForTimeout(600);
    ok('réseau : enregistré', await pageClean());

    await goPage('Sandbox', 'Containers');
    ok('containers : live', await bodyHas(/elpis-sb-alice/) && await bodyHas(/Up 2 hours/));
    ok('containers : action de recyclage', await txtVisible('Recycler les inactifs'));

    // ─────────────────────────────────────────────────────────────────
    //  SYSTÈME › ENTRETIEN et DONNÉES (ex-« Maintenance » + « Base de données »)
    // ─────────────────────────────────────────────────────────────────
    await goPage('Système', 'Entretien');
    ok('entretien : titre', (await headTitle()) === 'Entretien');
    ok('entretien : redémarrage', await txtVisible('Redémarrer'));
    ok('entretien : rétentions réglables (défauts du serveur)',
       (await page.locator('#upk-metrics_retention_days').inputValue()) === '90'
       && (await page.locator('#upk-hour').inputValue()) === '6');
    ok('entretien : plus de « Générer maintenant » en double du Rapport', !(await txtVisible('Générer maintenant')));
    ok('entretien : purge et redémarrage dans la Zone sensible, en fin de page',
       await page.evaluate(() => { const z = document.querySelector('.adm-zone');
           const all = [...document.querySelectorAll('.adm-page section.adm-card')];
           return !!z && all[all.length - 1] === z && /Remettre à zéro/.test(z.innerText) && /Redémarrer/.test(z.innerText); }));
    await page.locator('#upk-metrics_retention_days').fill('60');
    await page.waitForTimeout(150);
    ok('entretien : une rétention modifiée passe par la barre', (await dirtyCount()) === '1 modification');
    await page.locator('.adm-savebar button:has-text("Voir")').click();
    await page.waitForTimeout(150);
    ok('entretien : « Voir » marque le réglage pris en compte au redémarrage',
       (await page.locator('#adm-changes .adm-changes__restart').count()) === 1);
    await page.locator('.adm-savebar button:has-text("Voir")').click();
    await page.locator('.adm-savebar button:has-text("Annuler")').click();
    await page.waitForTimeout(150);
    ok('entretien : Annuler rétablit la page', await pageClean());
    await goPage('Système', 'Données');
    ok('données : titre', (await headTitle()) === 'Données');
    ok('données : sauvegarde distante', await bodyHas(/Sauvegarde distante/));
    ok('données : connecteur SFTP', await bodyHas(/SFTP/));
    ok('données : sauvegardes avant la base',
       await page.evaluate(() => { const a = document.getElementById('backup'), b = document.getElementById('db-state');
           return !!(a && b) && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }));
    ok('données : restauration dans la Zone sensible, dernier bloc',
       await page.evaluate(() => { const all = [...document.querySelectorAll('.adm-page section.adm-card')];
           const z = all[all.length - 1]; return !!z && z.classList.contains('adm-zone') && z.id === 'restore'; }));
    // Confirmation SAISIE : le bouton ne s'active qu'une fois le mot recopié.
    await page.locator('#restore-scope').selectOption('db');
    await page.locator('#restore button:has-text("Restaurer")').click();
    await page.waitForTimeout(200);
    const typed = page.locator('#app-modal-typed');
    const goBtn = page.locator('div.z-\\[7000\\] button:has-text("Choisir l")');
    ok('restauration : confirmation saisie, bouton inactif', await typed.isVisible() && await goBtn.isDisabled());
    ok('restauration : titre en clair (pas l’identifiant du périmètre)', await bodyHas(/Restauration de la base/));
    await typed.fill('restaurer');
    await page.waitForTimeout(100);
    ok('restauration : mot recopié → bouton actif', await goBtn.isEnabled());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    // Un SEUL input de restauration dans tout le DOM.
    ok('données : un seul #restore-file-input',
       (await page.locator('#restore-file-input').count()) === 1);

    // ── Sauvegarde distante par rsync + planification (2026-09-21) ──
    const conn = page.locator('#mnt-remote-conn');
    await conn.selectOption('rsync');
    await page.waitForTimeout(150);
    ok('rsync : option proposée', (await conn.inputValue()) === 'rsync');
    const portIn = page.locator('#backup-remote input[aria-label="Port"]');
    ok('rsync : port SSH par défaut (22)', (await portIn.inputValue()) === '22');
    ok('rsync : champs adresse, utilisateur, chemin cible, mot de passe',
       await page.locator('#mnt-remote-host').isVisible()
       && await page.locator('#backup-remote input[aria-label="Utilisateur"]').isVisible()
       && /Chemin cible/.test(await page.locator('#backup-remote').innerText())
       && (await page.locator('#mnt-remote-rsync-pwd').getAttribute('type')) === 'password');
    ok('rsync : ni transport, ni module, ni clé SSH',
       (await page.locator('#mnt-remote-rsync-tr, #mnt-remote-module').count()) === 0
       && !(await page.locator('#backup-remote').innerText()).includes('Clé privée SSH'));
    await page.locator('#backup-remote').evaluate(el => el.querySelector('input[type=checkbox]').checked || el.querySelector('input[type=checkbox]').click());
    await page.locator('#mnt-remote-host').fill('10.20.0.50');
    await page.locator('#backup-remote input[aria-label="Utilisateur"]').fill('backup');
    await page.locator('#mnt-remote-path').fill('/srv/sauvegardes');
    await page.locator('#mnt-remote-rsync-pwd').fill('s3cret');
    // Planification : toutes les 6 heures.
    ok('planif : intervalle grisé tant que désactivée', await page.locator('#mnt-remote-every').isDisabled());
    await page.locator('[data-remote-schedule-toggle]').evaluate(el => el.click());
    await page.waitForTimeout(100);
    await page.locator('#mnt-remote-every').fill('6');
    await page.locator('[data-remote-schedule] select').selectOption('hours');
    await page.locator('#backup-remote button:has-text("Enregistrer")').click();
    await page.waitForTimeout(500);
    const rlog = await (await fetch(`http://127.0.0.1:${PORT}/__remote_log`)).json();
    const cfgPost = rlog.filter(e => e.kind === 'config').pop();
    ok('rsync : config envoyée (connecteur, adresse, port 22, chemin)',
       !!cfgPost && cfgPost.body.connector === 'rsync' && cfgPost.body.host === '10.20.0.50'
       && Number(cfgPost.body.port) === 22 && cfgPost.body.remote_path === '/srv/sauvegardes');
    ok('planif : envoyée (activée, toutes les 6 heures)',
       !!cfgPost && cfgPost.body.schedule_enabled === true && Number(cfgPost.body.schedule_every) === 6
       && cfgPost.body.schedule_unit === 'hours');
    ok('rsync : mot de passe envoyé À PART, pas dans la config',
       rlog.some(e => e.kind === 'password' && e.present && e.length === 6)
       && !JSON.stringify(rlog.filter(e => e.kind === 'config')).includes('s3cret'));
    ok('rsync : champ vidé et « Enregistré » affiché',
       (await page.locator('#mnt-remote-rsync-pwd').inputValue()) === ''
       && /Enregistré/.test(await page.locator('[data-remote-rsync-password]').innerText()));
    ok('planif : prochain envoi affiché',
       /Prochain envoi : \d{2}\/\d{2}/.test(await page.locator('[data-remote-schedule]').innerText()));
    await page.screenshot({ path: '/tmp/admin-rsync.png', fullPage: false }).catch(() => {});
    await conn.selectOption('sftp');
    await page.waitForTimeout(150);
    ok('SFTP : clé SSH demandée, plus de mot de passe',
       (await page.locator('#backup-remote').innerText()).includes('Clé privée SSH')
       && (await page.locator('#mnt-remote-rsync-pwd').count()) === 0);

    // ── Sauvegarde : modale de transfert in-app, jamais d'event navigateur ──
    let popupSeen = false;
    page.on('popup', () => { popupSeen = true; });
    await page.locator('#backup button:has-text("Complète")').first().click();
    await page.waitForTimeout(1400);
    const tModal = page.locator('div[role="dialog"][aria-label^="Sauvegarde"]');
    ok('backup : modale de transfert affichée', await tModal.first().isVisible().catch(() => false));
    // Archive en construction côté serveur : roue + libellé + temps écoulé,
    // jamais le « 0 o » figé d'avant (2026-09-27).
    ok('backup : « Compression en cours… » pendant la construction',
       await tModal.getByText('Compression en cours…').first().isVisible().catch(() => false));
    ok('backup : roue qui tourne', await tModal.locator('.ph-spinner-gap.animate-spin').first().isVisible().catch(() => false));
    ok('backup : temps écoulé affiché', /\b1 s\b/.test(await tModal.innerText().catch(() => '')));
    ok('backup : pas de « 0 o » pendant l’attente', !/\b0 o\b/.test(await tModal.innerText().catch(() => '')));
    await tModal.getByText('Terminé').first().waitFor({ timeout: 5000 }).catch(() => {});
    ok('backup : transfert terminé', await tModal.getByText('Terminé').first().isVisible().catch(() => false));
    ok('backup : roue arrêtée une fois terminé', !(await tModal.locator('.animate-spin').count()));
    ok('backup : nom depuis Content-Disposition',
       await tModal.getByText('backup-test.zip').first().isVisible().catch(() => false));
    ok('backup : aucun popup navigateur', !popupSeen);
    await tModal.locator('button:has-text("Fermer")').click();
    await page.waitForTimeout(150);

    // ── Restauration (périmètre MCP → pas de reload) ──
    fs.writeFileSync('/tmp/admin-restore-test.zip', Buffer.alloc(64 * 1024, 3));
    await page.locator('#restore-scope').selectOption('mcp');
    await page.locator('#restore button:has-text("Restaurer")').click();
    await page.waitForTimeout(300);
    const confirmDlg = page.locator('div.z-\\[7000\\]');
    ok('restore : confirmation in-app',
       await confirmDlg.locator('button:has-text("Choisir l")').first().isVisible().catch(() => false));
    await page.locator('#app-modal-typed').fill('RESTAURER');
    await confirmDlg.locator('button:has-text("Choisir l")').first().click();
    await page.waitForTimeout(200);
    await page.locator('#restore-file-input').setInputFiles('/tmp/admin-restore-test.zip');
    await page.waitForTimeout(600);
    const rModal = page.locator('div[role="dialog"][aria-label^="Restauration"]');
    ok('restore : « Restauration en cours… » + roue pendant le traitement serveur',
       await rModal.getByText('Restauration en cours…').first().isVisible().catch(() => false)
       && await rModal.locator('.ph-spinner-gap.animate-spin').first().isVisible().catch(() => false));
    await rModal.getByText('Terminé').first().waitFor({ timeout: 5000 }).catch(() => {});
    ok('restore : modale upload terminée',
       await rModal.getByText('Terminé').first().isVisible().catch(() => false));
    ok('restore : toast « 3 fichiers restaurés »', await bodyHas(/3 fichiers restaurés/));
    ok('restore : toujours aucun popup navigateur', !popupSeen);
    await rModal.locator('button:has-text("Fermer")').click();
    await page.waitForTimeout(150);

    // ─────────────────────────────────────────────────────────────────
    //  RECHERCHE Ctrl+K (lot 7) — pages, réglages, actions
    // ─────────────────────────────────────────────────────────────────
    await goPage('Supervision', 'Journaux');
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    const pal = page.locator('.adm-palette');
    ok('ctrl+k : palette ouverte, saisie focalisée', await pal.isVisible()
       && await page.evaluate(() => !!(document.activeElement && document.activeElement.closest('.adm-palette'))));
    ok('ctrl+k : sans saisie, pages et actions (pas de réglages)',
       (await page.locator('.adm-palette__item').count()) > 20
       && await pal.locator('.adm-palette__item', { hasText: 'Redémarrer le serveur' }).isVisible()
       && !(await pal.locator('.adm-palette__kind', { hasText: 'Réglage' }).count()));
    await page.keyboard.type('compteurs');
    await page.waitForTimeout(200);
    const act = page.locator('.adm-palette__item.is-active');
    ok('ctrl+k : un réglage d’une page non affichée est trouvé',
       /Compteurs/.test(await act.innerText()) && /Entretien/.test(await act.innerText()));
    ok('ctrl+k : lettres trouvées surlignées', (await act.locator('mark').count()) > 0);
    ok('ctrl+k : option active annoncée (aria-activedescendant)',
       (await page.locator('.adm-palette__search input').getAttribute('aria-activedescendant')) === 'adm-pal-0');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    ok('ctrl+k : Entrée ouvre la page du réglage', (await headTitle()) === 'Entretien' && !(await pal.count()));
    ok('ctrl+k : le champ reçoit le focus et se signale',
       await page.evaluate(() => document.activeElement && document.activeElement.id === 'upk-metrics_retention_days')
       && (await page.locator('.adm-flash').count()) === 1);
    // Un réglage replié sous « Avancé » est déplié à l'arrivée.
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(150);
    await page.keyboard.type('capacité modèles simultanés');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    ok('ctrl+k : réglage sous « Avancé » : page ouverte, repli déplié',
       (await headTitle()) === 'Inférence'
       && await page.locator('#engine details.adm-details--rows').evaluate(d => d.open)
       && await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-field') === 'config:llama.max_models'));
    // Échap referme et rend le focus ; flèches pour choisir.
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(150);
    await page.keyboard.type('journ');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(100);
    ok('ctrl+k : flèches — la sélection suit', (await page.locator('.adm-palette__item.is-active').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok('ctrl+k : Échap referme', !(await pal.count()));
    // Action : « Tester toutes les connexions » relance la tournée de la Vue d'ensemble.
    const ovs0 = await page.evaluate(() => fetch('/__overview_stats').then(r => r.json()));
    await page.locator('aside .adm-rail__search').click();
    await page.waitForTimeout(150);
    ok('recherche : bouton de la barre latérale', await pal.isVisible());
    await page.keyboard.type('tester toutes');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const ovs1 = await page.evaluate(() => fetch('/__overview_stats').then(r => r.json()));
    ok('ctrl+k : action exécutée (Vue d’ensemble, sondes relancées)',
       (await headTitle()) === 'Vue d’ensemble' && ovs1.refresh === ovs0.refresh + 1);

    // ─────────────────────────────────────────────────────────────────
    //  DEEP-LINKS HISTORIQUES — les 4 ids retirés restent valides
    // ─────────────────────────────────────────────────────────────────
    // Le paramètre ``n`` force une vraie navigation de document : deux URL qui
    // ne diffèrent que par le fragment ne rechargent PAS la page, et le test
    // vérifierait alors l'onglet précédent au lieu de la résolution du hash.
    const legacyLinks = [['engines', 'Inférence'], ['config', 'Instance'], ['connections', 'Inférence'],
                         ['llm', 'Inférence'], ['maintenance', 'Entretien'], ['database', 'Données'],
                         ['users', 'Comptes'], ['ax', 'Vision & machines'], ['observability', 'Appels d’outils'],
                         ['compression', 'Compression'], ['groups', 'Groupes']];
    for (let i = 0; i < legacyLinks.length; i++) {
        const [hash, title] = legacyLinks[i];
        await gotoApp(page, `/?n=${i}#${hash}`);
        await page.waitForTimeout(400);
        ok(`lien profond #${hash} → ${title}`, (await headTitle()) === title);
    }
    // L'adresse suit la page, et Précédent reste dans la console.
    await gotoApp(page, '/?n=20#instance');
    await page.waitForTimeout(300);
    await goPage('Système', 'Accès HTTPS');
    ok('adresse : #https écrit à la navigation', await page.evaluate(() => location.hash) === '#https');
    await page.goBack();
    await page.waitForTimeout(500);
    ok('Précédent : retour à la page précédente dans la console', (await headTitle()) === 'Instance');

    // ── Menu « Compte et apparence » ──
    await page.locator('aside button[aria-label="Compte et apparence"]:visible').first().click();
    await page.waitForTimeout(200);
    const menu = page.locator('.adm-menu[role="dialog"]');
    ok('apparence : menu ouvert', await menu.isVisible().catch(() => false));
    ok('apparence : mode Système · Clair · Sombre',
       (await menu.locator('[role="radiogroup"][aria-label="Mode"] [role="radio"]').count()) === 3);
    // Les skins ACTIVÉS du registre (frontend/css/skins/skins.json) : Kiki est
    // désactivé par défaut.
    const nActifs = JSON.parse(fs.readFileSync(new URL('../../frontend/css/skins/skins.json', import.meta.url), 'utf8'))
        .skins.filter((s) => s.enabled_by_default !== false).length;
    ok(`apparence : ${nActifs} thèmes proposés`, (await menu.locator('.adm-swatch').count()) === nActifs);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok('apparence : Échap referme le menu', !(await menu.isVisible().catch(() => false)));

    // ─────────────────────────────────────────────────────────────────
    //  BASCULE HTTPS — le formulaire ne doit pas rester sur l'ancien état
    // ─────────────────────────────────────────────────────────────────
    // Panne de prod : ``toggleHttps`` écrivait security.https + https_only
    // côté serveur sans toucher à configForm, chargé à l'ouverture de
    // l'onglet. Le panneau passait en « HTTPS actif » pendant que la case
    // « Cookie Secure » de la MÊME page restait à Désactivé — et le prochain
    // enregistrement republiait cet ancien état, rouvrant les binds 0.0.0.0.
    // En dernier : le toggle arme une redirection à +8 s.
    await page.evaluate(() => fetch('/__caddy_up'));
    await gotoApp(page, '/?n=30#sessions');
    await page.waitForTimeout(400);
    // Le cookie chiffré est désormais un ÉTAT (lecture seule), dérivé de la
    // bascule : l'ancien interrupteur se laissait changer pour rien.
    const secureBox = page.locator('#sec-https-only');
    ok('cookie chiffré : état en lecture seule, pas un interrupteur',
       (await page.locator('input#sec-https-only').count()) === 0 && await secureBox.isVisible().catch(() => false));
    ok('bascule : cookie Secure à Inactif au départ',
       (await secureBox.getAttribute('data-state').catch(() => '')) === 'off');
    await goPage('Système', 'Accès HTTPS');
    const enableBtn = page.locator('#https button:has-text("Activer le HTTPS")').first();
    ok('bascule : bouton actif une fois Caddy détecté',
       (await enableBtn.isDisabled().catch(() => true)) === false);
    await enableBtn.click();
    const httpsDlg = page.locator('div.z-\\[7000\\]');
    ok('bascule : confirmation in-app',
       await httpsDlg.locator('button:has-text("Activer")').first().isVisible().catch(() => false));
    await httpsDlg.locator('button:has-text("Activer")').first().click();
    await page.waitForTimeout(600);
    ok('bascule : toast d\'activation', await bodyHas(/HTTPS activé/));
    await goPage('Utilisateurs & accès', 'Mots de passe & sessions');
    ok('bascule : cookie Secure réaligné dans le formulaire',
       (await secureBox.getAttribute('data-state').catch(() => '')) === 'on');

    // ── Base de données (lot E) : état, test, simulation ──
    await gotoApp(page, '/?n=31#data');
    await page.waitForTimeout(400);
    ok('bdd : page Données', (await headTitle()) === 'Données');
    ok('bdd : état affiché', await bodyHas(/SQLite 3\.46\.1/) && await bodyHas(/21 migrations/));
    ok('bdd : pas de barre d’enregistrement de page', await pageClean());
    ok('bdd : « Revenir à SQLite » masqué en SQLite', !(await txtVisible('Revenir à SQLite')));
    await page.locator('#db-connection button:has-text("Tester")').first().click();
    await page.waitForTimeout(400);
    ok('bdd : résultat du test', await bodyHas(/PostgreSQL 17\.11/));
    await page.locator('#db-transfer button:has-text("Simuler")').first().click();
    await page.waitForTimeout(400);
    ok('bdd : résultat de la simulation', await bodyHas(/2 tables, 43 lignes/));
    ok('bdd : champ db_path absent', !(await page.locator('#cfg-db-path').count()));

    // ── Supervision › Exécutions (L5.7) ──
    await goPage('Supervision', 'Exécutions');
    ok('exécutions : coût par compte', await bodyHas(/alice/) && await bodyHas(/512 Mio/));
    // Entrée (dont cache) et sortie (dont réflexion) séparées, temps découpé
    // prefill + génération (2026-10-03).
    ok('exécutions : entrée dont cache', await bodyHas(/14 k · 90 % cache/));
    ok('exécutions : sortie dont réflexion', await bodyHas(/1,4 k · 900 réflexion/));
    ok('exécutions : lecture + génération', await bodyHas(/1,5 s \+ 4,5 s/));
    ok('exécutions : liste', await bodyHas(/routine-b1|bob/));
    await page.locator('tr:has-text("alice"):visible').first().click();
    await page.waitForTimeout(400);
    ok('exécutions : filtre par compte',
       (await page.locator('.adm-card:has(th:has-text("Genre")) tbody tr:visible').count()) === 1
       && (await page.locator('.adm-card:has(th:has-text("Genre")) tbody tr:has-text("bob"):visible').count()) === 0);
    await page.locator('.adm-card:has(th:has-text("Genre")) tbody tr:visible').first().click();
    await page.waitForTimeout(500);
    ok('exécutions : chronologie en modale', await bodyHas(/Détails de l'exécution/) && await bodyHas(/execute_shell/));
    ok('détails : tuiles entrée / sortie', await bodyHas(/12,3 k \(cache 96 %\)/) && await bodyHas(/1,1 k \(réflexion 820\)/));
    ok('exécutions : export par la route admin',
       (await page.locator('a:has-text("Exporter")').first().getAttribute('href')) === '/api/admin/runs/chat-a1/export');
    await page.locator('[aria-label="Fermer"]:visible').first().click();
    await page.waitForTimeout(300);

    // Aucune erreur de page (render Vue, etc.).
    ok('aucune erreur JS de page', errors.length === 0);
    if (errors.length) console.log('  erreurs:', errors.slice(0, 5));
    ok('aucune erreur avalée par Vue', vueErrors.length === 0);
    if (vueErrors.length) console.log('  erreurs Vue:', vueErrors.slice(0, 5));
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
