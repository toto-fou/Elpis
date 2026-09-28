// SPDX-License-Identifier: MIT
// Vérif du ROUTAGE DU CONTENU STREAMÉ dans un tour à outils (correctif
// 2026-09-02). Symptôme corrigé : la narration pré-appel streamait dans le
// CORPS markdown (faux message pleine taille) puis disparaissait dans
// l'accordéon « Travail de l'assistant » au tool_call — à chaque round.
//
//   PERF_PORT=8921 node tests/frontend/pretool-server.mjs &
//   PERF_PORT=8921 node tests/frontend/pretool-verify.mjs
//
// Barrières (cf. pretool-server.mjs) : à chaque état intermédiaire, on
// constate PUIS on relâche le flux.
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond, detail = '') => {
    checks.push([cond ? 'PASS' : 'FAIL', name]);
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (!cond && detail ? '  — ' + detail : ''));
};
const NARR1 = 'Je vais lire le fichier de configuration.';
const NARR2 = 'Le fichier est lu, je corrige maintenant.';
const FINAL = 'Voilà, la configuration est corrigée.';

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const release = (g) => fetch(`${BASE_URL}/__gate/${g}`, { method: 'POST' }).then((r) => r.json());
// État de rendu : texte dans le CORPS (markdown-body HORS conteneur), dans le
// CONTENEUR (accordéon), dans son summary, et libellé de la pill de statut.
const state = () => page.evaluate(() => {
    const pipe = document.querySelector('details[data-pipeline]');
    const inPipe = (el) => !!el && !!el.closest('details[data-pipeline]');
    // (passe 8, F8) la ligne live est rendue SOUS le conteneur : ni corps, ni conteneur.
    const inLive = (el) => !!el && !!el.closest('[data-live-narration]');
    const bodies = [...document.querySelectorAll('.markdown-body')].filter((el) => !inPipe(el) && !inLive(el));
    const body = bodies.map((el) => el.textContent || '').join('\n');
    const status = [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent || '').join(' | ');
    const liveEl = document.querySelector('[data-live-narration]');
    return {
        body,
        live: liveEl ? (liveEl.textContent || '') : '',
        liveInPipe: !!document.querySelector('details[data-pipeline] [data-live-narration]'),
        pipe: pipe ? (pipe.textContent || '') : '',
        summary: pipe ? ((pipe.querySelector(':scope > summary') || {}).textContent || '') : '',
        pipeOpen: !!(pipe && pipe.open),
        // Segments FIGÉS seulement (la ligne live porte data-live-narration).
        worklogs: [...document.querySelectorAll('.markdown-body--worklog:not([data-live-narration])')].map((el) => (el.textContent || '').trim()),
        // Ligne live : rendue en markdown (blocs/actif), pas en texte brut.
        liveMd: !!document.querySelector('[data-live-narration] p, [data-live-narration] li, [data-live-narration] h1, [data-live-narration] h2, [data-live-narration] strong'),
        status,
    };
});
const settle = (ms = 250) => page.waitForTimeout(ms);

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée', true);

    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Corrige la configuration.');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // ── Barrière 1 : narration du round 1 streamée — destination inconnue,
    //    elle est dans le corps (comportement assumé : la plupart des tours
    //    sont sans outil, on ne retarde pas la réponse).
    await page.waitForFunction((t) => (document.getElementById('app') || {}).textContent.includes(t), NARR1);
    await settle();
    let s = await state();
    ok('R1 narration streamée dans le corps (avant tout signal d\'appel)', s.body.includes(NARR1), s.body.slice(0, 120));
    ok('R1 pas encore de conteneur « Travail de l\'assistant »', !s.pipe);
    await release('r1_narr');

    // ── Barrière 2 : 1er tool_call_delta reçu → bascule ANTICIPÉE dans la
    //    ligne live (AVANT le tool_call, sans attendre les args). (passe 8, F8)
    //    la ligne live est SOUS le conteneur (qui n'existe pas encore : rien
    //    de figé) ; (F7) pill « Appel d'outil · read_file… » pendant les args.
    await page.waitForFunction((t) => {
        const p = document.querySelector('[data-live-narration]');
        return !!p && (p.textContent || '').includes(t);
    }, NARR1);
    await settle();
    s = await state();
    ok('R1 delta : narration basculée dans la ligne live (worklog)', s.live.includes(NARR1) && !s.liveInPipe);
    ok('R1 delta : corps VIDÉ (plus de faux message)', !s.body.includes(NARR1), s.body.slice(0, 120));
    ok('R1 delta : pas encore de conteneur (rien de figé)', !s.pipe, s.pipe.slice(0, 80));
    ok('R1 delta : pill « Appel d\'outil · read_file… » (F7), pas « Réflexion… »',
       /Appel d'outil · read_file…/.test(s.status) && !/Réflexion…/.test(s.status), s.status);
    await release('r1_delta');

    // ── Barrière 3 : round 2 — narration streamée EN PHASE OUTILS : jamais
    //    dans le corps ; dans la ligne live SOUS le conteneur (F8).
    await page.waitForFunction((t) => {
        const p = document.querySelector('[data-live-narration]');
        return !!p && (p.textContent || '').includes(t);
    }, NARR2);
    await settle();
    s = await state();
    ok('R2 narration dans la ligne live, sous le conteneur', s.live.includes(NARR2) && !s.liveInPipe && !s.pipe.includes(NARR2));
    ok('R2 ligne live rendue en MARKDOWN (pas en texte brut)', s.liveMd);
    ok('R2 ligne live SANS curseur de streaming (demande user 2026-09-02)',
       await page.evaluate(() => !document.querySelector('[data-live-narration] .elpis-stream-caret')));
    ok('R2 narration JAMAIS dans le corps', !s.body.includes(NARR2) && !s.body.includes('Le fichier est lu'), s.body.slice(0, 120));
    ok('R2 narration du round 1 figée en worklog (segment)', s.worklogs.some((t) => t.includes(NARR1)), JSON.stringify(s.worklogs));
    ok('R2 summary = dernière narration FIGÉE (pas la ligne live)', s.summary.includes('Je vais lire') && !s.summary.includes('Le fichier est lu'), s.summary);
    ok('R2 pas de pill pendant la rédaction visible (même règle que le corps)', !/Rédaction…|Réflexion…/.test(s.status), s.status);
    await release('r2_narr');

    // ── Barrière 4 : réponse finale en cours (phase outils) — elle streame
    //    dans la ligne live ; le corps reste vide jusqu'au 'final'. Le round
    //    2 (tool_call SANS delta) a rejoint son segment.
    await page.waitForFunction((t) => {
        const p = document.querySelector('[data-live-narration]');
        return !!p && (p.textContent || '').includes(t);
    }, FINAL);
    await settle();
    s = await state();
    ok('FIN(live) réponse finale dans la ligne live SOUS le conteneur, corps vide (F8)',
       s.live.includes(FINAL) && !s.liveInPipe && !s.pipe.includes(FINAL) && !s.body.includes(FINAL), s.body.slice(0, 120));
    ok('FIN(live) narration round 2 figée en worklog', s.worklogs.some((t) => t.includes(NARR2)), JSON.stringify(s.worklogs));
    ok('FIN(live) 2 outils comptés dans les segments',
       await page.evaluate(() => document.querySelectorAll('details[class*="toolwrap"]').length === 2));
    await release('final_narr');

    // ── Après 'final' : corps = réponse (data.assistant), conteneur = 2
    //    narrations + 2 groupes, AUCUNE duplication.
    await page.waitForFunction((t) => {
        const inPipe = (el) => !!el.closest('details[data-pipeline]');
        return [...document.querySelectorAll('.markdown-body')].some((el) => !inPipe(el) && (el.textContent || '').includes(t));
    }, FINAL);
    await page.waitForFunction(() => !document.querySelector('button[title="Arrêter la génération"]'));
    await settle();
    s = await state();
    ok('FINAL réponse dans le corps', s.body.includes(FINAL));
    ok('FINAL réponse PAS dans le conteneur', !s.pipe.includes(FINAL), s.pipe.slice(0, 160));
    ok('FINAL narrations PAS dans le corps', !s.body.includes(NARR1) && !s.body.includes(NARR2), s.body.slice(0, 160));
    ok('FINAL 2 narrations en worklog, dans l\'ordre',
       s.worklogs.length === 2 && s.worklogs[0].includes(NARR1) && s.worklogs[1].includes(NARR2), JSON.stringify(s.worklogs));
    ok('FINAL summary agrégé : 2 outils', /2\s*outils/.test(s.summary), s.summary);
    ok('FINAL plus de pill de statut', !/Rédaction…|Réflexion…/.test(s.status), s.status);
    ok('FINAL ligne live vidée (plus de curseur)',
       await page.evaluate(() => !document.querySelector('[data-live-narration], .elpis-stream-caret')));

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\npretool-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
