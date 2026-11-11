// SPDX-License-Identifier: MIT
// tests/frontend/mention-verify.mjs — menu « @ » du composeur : ouverture sur « @ », filtre, cascade clavier, ligne active
// gardée visible, insertion en pièce jointe, Échap, priorité sur le menu « / ». Faux serveur de l'éditeur (arbre du bac) :
//   PERF_PORT=8908 node tests/frontend/editor-server.mjs &
//   PERF_PORT=8908 node tests/frontend/mention-verify.mjs
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const res = [];
const ok = (nom, cond, detail = '') => {
    res.push(!!cond);
    console.log(`  ${cond ? '✓' : '✗'} ${nom}${!cond && detail ? '  — ' + detail : ''}`);
};

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
try {
    await gotoApp(page, '/');
    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    const menu = page.locator('#mention-list');
    const lignes = page.locator('li[data-mention-row]');

    await ta.click();
    await ta.pressSequentially('Regarde @');
    await menu.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const n = await lignes.count();
    ok('« @ » ouvre la liste des fichiers du bac', n >= 2, String(n));
    ok('le menu « / » reste fermé', (await page.locator('#slash-list').count()) === 0);
    const actif = () => page.evaluate(() => [...document.querySelectorAll('li[data-mention-row]')].findIndex((l) => l.classList.contains('bg-blue-50')));
    ok('première ligne active', (await actif()) === 0);
    await ta.press('ArrowDown');
    ok('Flèche bas : ligne suivante', (await actif()) === 1);
    await ta.press('ArrowUp');
    ok('Flèche haut : retour', (await actif()) === 0);

    await ta.pressSequentially('util');
    await page.waitForTimeout(200);
    const filtre = await lignes.allInnerTexts();
    ok('la saisie filtre la liste', filtre.length >= 1 && filtre.every((t) => t.toLowerCase().includes('util')), filtre.join(' | '));
    await ta.press('Enter');
    await page.waitForTimeout(500);
    const puce = await page.evaluate(() => [...document.querySelectorAll('.file-chip-mention')].map((c) => c.parentElement.textContent.replace(/\s+/g, ' ').trim()));
    ok('Entrée insère le fichier en pièce jointe', puce.length === 1 && /util/.test(puce[0]) && (await menu.count()) === 0, JSON.stringify(puce));
    ok('le fragment « @util » est retiré du texte', !(await ta.inputValue()).includes('@util'), await ta.inputValue());

    await ta.pressSequentially(' @');
    await menu.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await ta.press('Escape');
    await page.waitForTimeout(200);
    ok('Échap ferme la liste sans vider la saisie', (await menu.count()) === 0 && (await ta.inputValue()).startsWith('Regarde'));
    ok('aucune erreur JS', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
    ok('harnais : ' + (e && e.message || e), false);
} finally {
    await browser.close();
}
const ko = res.filter((x) => !x).length;
console.log(`mention-verify : ${res.length - ko}/${res.length} ${ko ? 'FAIL' : 'PASS'}`);
process.exit(ko ? 1 : 0);
