// SPDX-License-Identifier: MIT
// Vérif de l'onglet « Compaction » de la modal Paramètres, route-mock, sans
// backend :
//   PERF_PORT=8942 node tests/frontend/settings-tabs-server.mjs &
//   PERF_PORT=8942 node tests/frontend/compaction-threshold-verify.mjs
//
// L'onglet porte l'interrupteur de compaction automatique et le seuil
// « contexte max avant compaction », réglable en DEUX unités exclusives :
// pourcentage de la fenêtre, ou nombre de tokens.
//
// Ce que ces checks verrouillent :
//   1. les deux unités sont EXCLUSIVES — choisir l'une envoie l'autre à 0.
//      Sans ça un « 70 % » fantôme survit derrière un seuil en tokens et
//      ressurgit dès que celui-ci repasse à zéro ;
//   2. le PUT porte toujours le COUPLE des deux clés. En envoyer une seule
//      laisserait l'autre à sa valeur d'avant côté serveur ;
//   3. la persistance part au ``change`` (fin de geste), pas à l'``input`` :
//      un drag du curseur émettrait une quinzaine de PUT ;
//   4. le seuil disparaît quand l'automatique est coupé (il ne règle rien) ;
//   5. le PLAFOND de compactions par conversation (Auto / Nombre / Illimité)
//      part seul dans son PUT, se déduit de la valeur servie, et clampe à 200
//      à l'écran comme en base. Le seuil dit QUAND compacter, le plafond dit
//      COMBIEN DE FOIS : sur une mission de plusieurs heures c'est lui qui
//      décide si la conversation continue d'être résumée ou finit en tours
//      jetés.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/compaction-threshold-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const settingsPuts = async () =>
    (await (await fetch(BASE_URL + '/__settings_puts')).json()).items;

const MODAL = 'div[aria-label="Paramètres"]';
const modal = () => page.locator(MODAL);
// Scopé À LA MODALE : la sidebar de l'application porte elle aussi des entrées
// de navigation, DERRIÈRE l'overlay — un locator global cliquerait dans le vide.
const unite  = () => page.locator(`${MODAL} #set-compact-unit`);
const curseur = () => page.locator(`${MODAL} input[type="range"]`);
const champTokens = () => page.locator(`${MODAL} #set-compact-tokens`);
const rounds = () => page.locator(`${MODAL} #set-compact-rounds`);
const champRounds = () => page.locator(`${MODAL} #set-compact-rounds-n`);

async function openCompactionTab() {
    const open = await modal().isVisible().catch(() => false);
    if (!open) await page.locator('button[title="Paramètres"]:visible').first().click();
    await modal().waitFor({ state: 'visible' });
    await page.locator(`${MODAL} aside button:has-text("Compaction")`).first().click();
    await page.waitForTimeout(350);
}

async function choisirUnite(v) {
    await unite().selectOption(v);
    await page.waitForTimeout(400);
}

async function choisirRounds(v) {
    await rounds().selectOption(v);
    await page.waitForTimeout(400);
}

try {
    page.setDefaultTimeout(10000);

    // ════ A — l'onglet existe et part en « Auto » ═══════════════════════
    await fetch(BASE_URL + '/__cfg');            // compaction ON, seuil auto
    await gotoApp(page, '/');
    await openCompactionTab();

    ok('A l\'onglet Compaction est atteignable depuis la nav',
       (await modal().locator('h3:has-text("Compaction")').count()) > 0);
    ok('A l\'interrupteur a suivi depuis l\'onglet Chat',
       (await modal().getByText('Compaction automatique').count()) > 0);
    ok('A le sélecteur d\'unité est visible', await unite().isVisible().catch(() => false));
    ok('A unité = Auto par défaut', (await unite().inputValue()) === 'auto');
    ok('A aucun contrôle de valeur en mode Auto',
       !(await curseur().isVisible().catch(() => false)) &&
       !(await champTokens().isVisible().catch(() => false)));
    ok('A les deux garanties sont dites (compaction en plein run, /compact)',
       (await modal().getByText(/entre deux appels d'outils/).count()) > 0 &&
       (await modal().getByText(/\/compact/).count()) > 0);
    ok('A aucun PUT tant que rien n\'est touché', (await settingsPuts()).length === 0);

    // ════ B — unité « Pourcentage » ═════════════════════════════════════
    await choisirUnite('pct');
    ok('B le curseur apparaît', await curseur().isVisible().catch(() => false));
    ok('B pas de champ tokens en mode %',
       !(await champTokens().isVisible().catch(() => false)));
    ok('B bornes du curseur : 30 → 95',
       (await curseur().getAttribute('min')) === '30' &&
       (await curseur().getAttribute('max')) === '95');
    let puts = await settingsPuts();
    ok('B changer d\'unité enregistre tout de suite', puts.length === 1);
    ok('B le PUT porte le COUPLE des deux clés',
       puts.length === 1 &&
       Object.keys(puts[0]).sort().join() ===
         'compression_threshold_pct,compression_threshold_tokens');
    ok('B tokens remis à 0 par le passage en %',
       puts.length === 1 && puts[0].compression_threshold_tokens === 0 &&
       puts[0].compression_threshold_pct === 70);

    await curseur().fill('50');
    await page.waitForTimeout(400);
    puts = await settingsPuts();
    ok('B la pastille suit le curseur',
       (await modal().getByText('50 %', { exact: true }).count()) > 0);
    ok('B valeur envoyée au relâchement = 50',
       puts.length === 2 && puts[1].compression_threshold_pct === 50);

    // ════ C — unité « Tokens » ══════════════════════════════════════════
    await choisirUnite('tokens');
    ok('C le champ tokens apparaît', await champTokens().isVisible().catch(() => false));
    ok('C plus de curseur en mode tokens',
       !(await curseur().isVisible().catch(() => false)));
    puts = await settingsPuts();
    ok('C le pourcentage est effacé par le passage aux tokens',
       puts.length === 3 && puts[2].compression_threshold_pct === 0 &&
       puts[2].compression_threshold_tokens === 80000);
    ok('C la pastille humanise la valeur (« 80k »)',
       (await modal().getByText('80k', { exact: true }).count()) > 0);

    await champTokens().fill('20000');
    await champTokens().blur();
    await page.waitForTimeout(400);
    puts = await settingsPuts();
    ok('C une saisie libre est enregistrée telle quelle',
       puts.length === 4 && puts[3].compression_threshold_tokens === 20000 &&
       puts[3].compression_threshold_pct === 0);
    ok('C pastille « 20k »',
       (await modal().getByText('20k', { exact: true }).count()) > 0);

    // Vider le champ met la valeur à 0 : l'unité dérivée retomberait sur
    // « Auto » et le champ disparaîtrait sous les doigts de qui efface pour
    // retaper. L'épingle d'unité existe pour ça.
    const avantVidage = (await settingsPuts()).length;
    await champTokens().fill('');
    await page.waitForTimeout(400);
    ok('C vider le champ ne fait pas disparaître le champ',
       await champTokens().isVisible().catch(() => false) &&
       (await unite().inputValue()) === 'tokens');
    ok('C …et n\'enregistre rien tant qu\'il est vide',
       (await settingsPuts()).length === avantVidage);

    // Valeur sous la borne : le serveur clampe à 2048 ; l'écran doit dire la
    // même chose, sinon il affiche 2 pendant que la base a 2048.
    await champTokens().fill('2');
    await champTokens().blur();
    await page.waitForTimeout(400);
    const putsClamp = await settingsPuts();
    ok('C une valeur sous la borne est remontée à 2048 des DEUX côtés',
       putsClamp[putsClamp.length - 1].compression_threshold_tokens === 2048 &&
       (await champTokens().inputValue()) === '2048');
    await champTokens().fill('20000');
    await champTokens().blur();
    await page.waitForTimeout(400);

    // ════ D — retour à « Auto » ═════════════════════════════════════════
    const avantAuto = (await settingsPuts()).length;
    await choisirUnite('auto');
    puts = await settingsPuts();
    const dernier = puts[puts.length - 1];
    ok('D « Auto » envoie les DEUX clés à 0',
       puts.length === avantAuto + 1 &&
       dernier.compression_threshold_pct === 0 &&
       dernier.compression_threshold_tokens === 0);

    // ════ E — « Compactions max » par conversation ══════════════════════
    // Le seuil dit QUAND compacter ; ce plafond dit COMBIEN DE FOIS. Sur une
    // mission de plusieurs heures c'est LUI le vrai mur : atteint, les tours
    // les plus anciens sont jetés au lieu d'être résumés. Trois états, un
    // sélecteur — même gabarit que le seuil juste au-dessus.
    await fetch(BASE_URL + '/__cfg');
    await gotoApp(page, '/');
    await openCompactionTab();

    ok('E le sélecteur de plafond est visible', await rounds().isVisible().catch(() => false));
    ok('E plafond = Auto par défaut', (await rounds().inputValue()) === 'auto');
    ok('E aucun champ de valeur en mode Auto',
       !(await champRounds().isVisible().catch(() => false)));
    ok('E aucun PUT tant que rien n\'est touché', (await settingsPuts()).length === 0);

    await choisirRounds('custom');
    ok('E « Nombre » fait apparaître le champ',
       await champRounds().isVisible().catch(() => false));
    ok('E bornes du champ : 1 → 200',
       (await champRounds().getAttribute('min')) === '1' &&
       (await champRounds().getAttribute('max')) === '200');
    let pr = await settingsPuts();
    ok('E le passage en « Nombre » enregistre une valeur de départ',
       pr.length === 1 && pr[0].compression_max_rounds === 24 &&
       (await champRounds().inputValue()) === '24');
    ok('E le PUT ne porte QUE le plafond (le seuil n\'est pas touché)',
       pr.length === 1 && Object.keys(pr[0]).join() === 'compression_max_rounds');

    await champRounds().fill('60');
    await champRounds().blur();
    await page.waitForTimeout(400);
    pr = await settingsPuts();
    ok('E une saisie libre part au change',
       pr.length === 2 && pr[1].compression_max_rounds === 60);

    // Au-dessus de la borne : le serveur clampe à 200, l'écran doit dire la
    // même chose — sinon il affiche 500 pendant que la base a 200.
    await champRounds().fill('500');
    await champRounds().blur();
    await page.waitForTimeout(400);
    pr = await settingsPuts();
    ok('E une valeur au-dessus de la borne est ramenée à 200 des DEUX côtés',
       pr[pr.length - 1].compression_max_rounds === 200 &&
       (await champRounds().inputValue()) === '200');

    // Même règle que le champ tokens : vider ne doit pas escamoter le champ
    // sous les doigts de qui efface pour retaper.
    const avantVidageR = (await settingsPuts()).length;
    await champRounds().fill('');
    await page.waitForTimeout(400);
    ok('E vider le champ ne le fait pas disparaître',
       await champRounds().isVisible().catch(() => false) &&
       (await rounds().inputValue()) === 'custom');
    ok('E …et n\'enregistre rien tant qu\'il est vide',
       (await settingsPuts()).length === avantVidageR);

    await choisirRounds('unlimited');
    pr = await settingsPuts();
    ok('E « Illimité » envoie le sentinelle -1 et retire le champ',
       pr[pr.length - 1].compression_max_rounds === -1 &&
       !(await champRounds().isVisible().catch(() => false)));

    await choisirRounds('auto');
    pr = await settingsPuts();
    ok('E « Auto » repasse à 0 (plafond de l\'instance)',
       pr[pr.length - 1].compression_max_rounds === 0);

    // Relecture : l'état du sélecteur est DÉDUIT de la valeur servie, il
    // n'est pas mémorisé côté client.
    await fetch(BASE_URL + '/__cfg?rounds=12');
    await gotoApp(page, '/');
    await openCompactionTab();
    ok('E un plafond chiffré relu ⇒ « Nombre » + la valeur',
       (await rounds().inputValue()) === 'custom' &&
       (await champRounds().inputValue()) === '12');

    await fetch(BASE_URL + '/__cfg?rounds=-1');
    await gotoApp(page, '/');
    await openCompactionTab();
    ok('E un -1 relu ⇒ « Illimité »', (await rounds().inputValue()) === 'unlimited');

    // ════ F — l'unité est déduite de ce que le serveur a enregistré ═════
    await fetch(BASE_URL + '/__cfg?seuil_tk=80000');
    await gotoApp(page, '/');
    await openCompactionTab();
    ok('F un seuil en tokens relu ⇒ unité « Tokens »',
       (await unite().inputValue()) === 'tokens' &&
       (await champTokens().inputValue()) === '80000');

    await fetch(BASE_URL + '/__cfg?seuil=60');
    await gotoApp(page, '/');
    await openCompactionTab();
    ok('F un seuil en % relu ⇒ unité « Pourcentage »',
       (await unite().inputValue()) === 'pct' &&
       (await curseur().inputValue()) === '60');

    // ════ G — compaction auto coupée : pas de seuil ═════════════════════
    await fetch(BASE_URL + '/__cfg?compaction=0');
    await gotoApp(page, '/');
    await openCompactionTab();
    ok('G le seuil disparaît quand l\'automatique est coupé',
       !(await unite().isVisible().catch(() => false)));
    ok('G le plafond disparaît lui aussi', !(await rounds().isVisible().catch(() => false)));
    ok('G l\'interrupteur, lui, reste',
       (await modal().getByText('Compaction automatique').count()) > 0);
    ok('G la garantie se tait (elle parlerait d\'un seuil absent)',
       (await modal().getByText(/entre deux appels d'outils/).count()) === 0);
    ok('G …mais le rappel /compact reste, c\'est là qu\'il sert le plus',
       (await modal().getByText(/\/compact/).count()) > 0);
    await page.screenshot({ path: `${SHOTS}/compaction-off.png` });

    // ════ H — l'onglet Chat ne porte plus le réglage ════════════════════
    await fetch(BASE_URL + '/__cfg');
    await gotoApp(page, '/');
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await modal().waitFor({ state: 'visible' });
    await page.locator(`${MODAL} aside button:has-text("Chat")`).first().click();
    await page.waitForTimeout(350);
    ok('H l\'onglet Chat ne duplique plus la compaction',
       (await modal().getByText('Compaction automatique').count()) === 0);
    ok('H …mais garde ses propres réglages',
       (await modal().getByText('Prompt système').count()) > 0);
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
