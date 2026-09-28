// SPDX-License-Identifier: MIT
// Vérif MOTEUR VOCAL (dictée + lecture), route-mock :
//   PERF_PORT=8930 node tests/frontend/voice-server.mjs &
//   PERF_PORT=8930 node tests/frontend/voice-verify.mjs
//
// S1 — dictée : les énoncés s'ajoutent À LA SUITE dans la zone de saisie,
//      et RIEN n'est envoyé tout seul.
// S2 — Échap coupe la dictée sans toucher au brouillon.
// S3 — panne du service : toast d'erreur, brouillon intact.
// S4 — bouton « lire » : une lecture manuelle, jamais marquée « auto ».
// S5 — réponse vocale ON : lecture PENDANT la génération, phrase par phrase.
// S6 — génération interrompue : aucune lecture.
// S7 — drapeaux d'instance OFF : ni micro ni bouton « lire ».
// S8 — réglage utilisateur OFF : pas de micro, même service disponible.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/voice-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (nom, cond) => { checks.push([cond ? 'PASS' : 'FAIL', nom]); console.log((cond ? '  ✓ ' : '  ✗ ') + nom); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

// ── Bouchons navigateur, posés AVANT tout chargement ────────────────────
// Ni micro ni carte son dans un Chromium de test : on remplace la capture
// par une trappe qui pousse des trames à la demande, et la lecture par une
// promesse qui se termine tout de suite.
await page.addInitScript(() => {
    window.__voiceTest = { node: null, frames: 0 };
    class FauxWorkletNode {
        constructor() { this.port = { onmessage: null, postMessage() {} }; window.__voiceTest.node = this; }
        connect() {} disconnect() {}
    }
    class FauxAudioContext {
        constructor(opts) {
            this.sampleRate = (opts && opts.sampleRate) || 16000;
            this.state = 'running';
        }
        // Sur le PROTOTYPE, comme dans les vrais navigateurs (accesseur de
        // BaseAudioContext) : voice/_compat.js le détecte là, avant tout clic.
        get audioWorklet() { return { addModule: () => Promise.resolve() }; }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        resume() { return Promise.resolve(); }
        close() { this.state = 'closed'; return Promise.resolve(); }
    }
    window.AudioContext = FauxAudioContext;
    window.AudioWorkletNode = FauxWorkletNode;
    const piste = { stop() {}, getSettings: () => ({ echoCancellation: true }),
                    addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: () => Promise.resolve({ getTracks: () => [piste], getAudioTracks: () => [piste] }) },
    });
    // Lecture : pas d'autoplay dans un onglet sans geste, et pas de carte son.
    window.HTMLMediaElement.prototype.play = function () {
        const el = this;
        setTimeout(() => { try { el.dispatchEvent(new Event('ended')); } catch (e) {} }, 20);
        return Promise.resolve();
    };
    window.__voiceTest.emet = (rms, n) => {
        const noeud = window.__voiceTest.node;
        if (!noeud || !noeud.port.onmessage) return false;
        for (let i = 0; i < n; i++) {
            noeud.port.onmessage({ data: { pcm: new Float32Array(320), rms } });
            window.__voiceTest.frames++;
        }
        return true;
    };
});

// ⚠ Le bouchon GARDE son état d'une exécution à l'autre : il n'est pas
// redémarré entre deux passes. Un scénario qui n'envoyait que ses propres
// clés héritait donc de celles laissées par la passe PRÉCÉDENTE — S5 tournait
// avec le scénario « outils » de S11, et échouait une fois sur deux sans que
// rien n'ait bougé dans le produit. On repart toujours des défauts complets.
const DEFAUTS = {
    voice_stt: true, voice_tts: true,
    voice_input_enabled: true, voice_reply_enabled: false,
    voice_reply_tools_enabled: false,
    transcribeStatus: 200, cancelled: false,
    max_utterance_sec: 30, scenario: 'simple',
};
async function regle(etat) {
    const complet = Object.assign({}, DEFAUTS, etat);
    const r = await page.request.post(BASE_URL + '/__test/voice', { data: complet });
    return r.ok();
}
async function appels() {
    const r = await page.request.get(BASE_URL + '/__test/calls');
    return await r.json();
}
/** Calibration (500 ms de fond calme) puis un énoncé clos par un silence. */
async function dicteUnEnonce() {
    await page.waitForFunction(() => !!(window.__voiceTest && window.__voiceTest.node), null, { timeout: 5000 });
    await page.evaluate(() => window.__voiceTest.emet(0.001, 30));   // calibration
    await page.evaluate(() => window.__voiceTest.emet(0.3, 30));     // 600 ms de parole
    await page.evaluate(() => window.__voiceTest.emet(0.0005, 40));  // silence : commit
}
const micro = () => page.locator('#app button[aria-label="Activer la dictée"], #app button[aria-label="Arrêter la dictée"]');
const lire = () => page.locator('#app button[aria-label="Lire la réponse à voix haute"]');

async function envoie(texte) {
    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill(texte);
    await page.locator('#app button[aria-label="Envoyer le message"]').first().click();
}

try {
    page.setDefaultTimeout(15000);

    // ════ S1 — DICTÉE ════════════════════════════════════════════════════
    await regle({ voice_stt: true, voice_tts: true, voice_input_enabled: true,
                  voice_reply_enabled: false, transcribeStatus: 200, cancelled: false });
    await gotoApp(page, '/');
    ok('micro présent quand le service et le réglage sont actifs', await micro().count() === 1);

    await micro().click();
    await dicteUnEnonce();
    await page.waitForFunction(() => {
        const t = document.querySelector('#app textarea');
        return t && t.value.indexOf('Bonjour') >= 0;
    }, null, { timeout: 8000 });
    const apres1 = await page.locator('#app textarea').first().inputValue();
    ok('S1 premier énoncé inséré dans la zone de saisie', apres1.indexOf('Bonjour, ceci est un test.') >= 0);

    await dicteUnEnonce();
    await page.waitForFunction(() => {
        const t = document.querySelector('#app textarea');
        return t && t.value.indexOf('Deuxième') >= 0;
    }, null, { timeout: 8000 });
    const apres2 = await page.locator('#app textarea').first().inputValue();
    ok('S1 second énoncé ajouté À LA SUITE',
       /Bonjour, ceci est un test\.\s+Deuxième phrase\./.test(apres2));
    ok('S1 aucun envoi automatique',
       await page.locator('#app [data-vs-idx]').count() === 0);

    // ════ S2 — ÉCHAP ═════════════════════════════════════════════════════
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('S2 Échap arrête la dictée',
       await page.locator('#app button[aria-label="Activer la dictée"]').count() === 1);
    ok('S2 le brouillon survit à Échap',
       (await page.locator('#app textarea').first().inputValue()).indexOf('Bonjour') >= 0);

    // ════ S3 — SERVICE EN PANNE ══════════════════════════════════════════
    await regle({ transcribeStatus: 502 });
    const brouillonAvant = await page.locator('#app textarea').first().inputValue();
    await micro().click();
    await dicteUnEnonce();
    await page.waitForTimeout(1200);
    ok('S3 brouillon intact malgré la panne',
       (await page.locator('#app textarea').first().inputValue()) === brouillonAvant);
    await page.keyboard.press('Escape');
    await regle({ transcribeStatus: 200 });

    // ════ S4 — BOUTON « LIRE » ═══════════════════════════════════════════
    await page.locator('#app textarea').first().fill('');
    await envoie('Dis-moi bonjour.');
    await page.waitForFunction(() => {
        const t = document.querySelectorAll('#app [data-vs-idx]');
        return t.length >= 2;
    }, null, { timeout: 15000 });
    await page.waitForTimeout(1200);          // fin du flux
    await page.locator('#app [data-vs-idx]').last().hover();
    ok('S4 bouton « lire » présent sur la réponse', await lire().count() >= 1);
    await lire().last().click();
    await page.waitForTimeout(600);
    let a = await appels();
    ok('S4 une lecture manuelle a été demandée', a.speak.length >= 1);
    ok('S4 la lecture manuelle n\'est pas marquée « auto »',
       a.speak.length >= 1 && a.speak.every((s) => s.auto === false));
    ok('S4 réponse vocale OFF : aucune lecture automatique pendant le tour',
       a.speak.every((s) => s.auto === false));

    // ════ S5 — RÉPONSE VOCALE ════════════════════════════════════════════
    await regle({ voice_reply_enabled: true });
    await gotoApp(page, '/');
    // Conversation NEUVE : c'est le cas réel de la première réponse, celui où
    // le serveur attribue l'identifiant EN PLEIN TOUR. Sans ce clic, la page
    // rouvre la conversation précédente et le scénario ne teste plus rien.
    await page.evaluate(() => {
        const vm = document.querySelector('#app')._vnode.component.proxy;
        vm.startNewChat();
    });
    await page.waitForTimeout(300);
    await envoie('Raconte-moi quelque chose.');
    // La lecture doit partir AVANT la fin du tour : on interroge pendant
    // que le flux est encore en cours.
    await page.waitForTimeout(500);
    let pendant = await appels();
    await page.waitForTimeout(2000);
    let fin = await appels();
    ok('S5 lecture automatique demandée', fin.speak.some((s) => s.auto === true));
    ok('S5 la lecture démarre AVANT la fin de la génération', pendant.speak.length >= 1);
    ok('S5 première phrase lue en premier',
       fin.speak.length >= 1 && fin.speak[0].text.indexOf('Première phrase') >= 0);
    ok('S5 découpage phrase par phrase (au moins deux morceaux)', fin.speak.length >= 2);
    // RÉGRESSION 2026-09-22 — la conversation est NEUVE : le serveur lui
    // attribue son identifiant pendant ce tour, et le watcher de changement de
    // conversation coupait alors la voix (segmenteur remis à null) pour toute
    // la première réponse. Les deux assertions vont ensemble : sans la
    // première, la seconde passerait sur un chat qui n'a jamais changé d'id.
    ok('S5 le chat neuf reçoit son identifiant PENDANT le tour', fin.chatsNew === 1);
    const autos5 = fin.speak.filter((s) => s.auto === true);
    console.log('    (S5 lu : ' + JSON.stringify(autos5.map((x) => x.text.slice(0, 24))) + ')');
    ok('S5 la naissance de l\'identifiant ne coupe pas le DÉBUT de la réponse',
       autos5.length >= 2 && autos5[0].text.indexOf('Première phrase') === 0);

    // ════ S6 — GÉNÉRATION INTERROMPUE ════════════════════════════════════
    await regle({ voice_reply_enabled: true, cancelled: true });
    await gotoApp(page, '/');
    await envoie('Commence puis arrête-toi.');
    await page.waitForTimeout(2500);
    const apresAnnule = await appels();
    ok('S6 une génération interrompue ne déclenche pas la lecture finale',
       apresAnnule.speak.every((s) => s.text.indexOf('Seconde phrase') < 0));

    // ════ S7 — DRAPEAUX D'INSTANCE OFF ═══════════════════════════════════
    await regle({ voice_stt: false, voice_tts: false, cancelled: false });
    await gotoApp(page, '/');
    ok('S7 service coupé : aucun bouton micro', await micro().count() === 0);
    await envoie('Bonjour.');
    await page.waitForTimeout(2200);
    await page.locator('#app [data-vs-idx]').last().hover();
    ok('S7 service coupé : aucun bouton « lire »', await lire().count() === 0);

    // ════ S8 — RÉGLAGE UTILISATEUR OFF ═══════════════════════════════════
    await regle({ voice_stt: true, voice_tts: true, voice_input_enabled: false });
    await gotoApp(page, '/');
    ok('S8 dictée décochée : aucun bouton micro', await micro().count() === 0);
    // Décocher la dictée ne doit PAS emporter la lecture : ce sont deux
    // réglages, et deux services.
    await envoie('Bonjour quand même.');
    await page.waitForTimeout(2200);
    await page.locator('#app [data-vs-idx]').last().hover();
    ok('S8 le bouton « lire » reste disponible', await lire().count() >= 1);

    // ════ S9 — PLAFOND D'ÉNONCÉ VENU DU SERVEUR ══════════════════════════
    // Le navigateur ne doit pas enregistrer 30 s là où l'administrateur en
    // autorise 1 : le plafond vient de /api/voice/status, pas d'une constante
    // recopiée dans le JavaScript.
    await regle({ voice_stt: true, voice_tts: true, voice_input_enabled: true,
                  voice_reply_enabled: false, max_utterance_sec: 1 });
    await gotoApp(page, '/');
    await micro().click();
    await page.waitForFunction(() => !!(window.__voiceTest && window.__voiceTest.node), null, { timeout: 5000 });
    await page.evaluate(() => window.__voiceTest.emet(0.001, 30));    // calibration
    await page.evaluate(() => window.__voiceTest.emet(0.3, 120));     // 2,4 s SANS silence
    await page.waitForTimeout(1500);
    const s9 = await appels();
    ok('S9 le plafond du serveur est consulté', s9.status >= 1);
    ok('S9 un énoncé trop long est commité d\'office', s9.transcribe.length >= 1);
    await page.keyboard.press('Escape');

    // ════ S12 — DICTER UN SECOND MESSAGE, APRÈS UNE RÉPONSE ══════════════
    // Régression du 2026-09-22 : l'attribution de son id au chat neuf, en fin
    // de premier tour, était traitée comme un changement de conversation et
    // coupait le micro. Dicter le message suivant ne marchait plus.
    await regle({ voice_stt: true, voice_tts: true, voice_input_enabled: true,
                  voice_reply_enabled: false, voice_reply_tools_enabled: false,
                  scenario: 'simple', max_utterance_sec: 30 });
    await gotoApp(page, '/');
    await micro().click();
    await dicteUnEnonce();
    await page.waitForFunction(() => {
        const t = document.querySelector('#app textarea');
        return t && t.value.indexOf('Bonjour') >= 0;
    }, null, { timeout: 8000 });
    await page.locator('#app button[aria-label="Envoyer le message"]').first().click();
    await page.waitForTimeout(2600);                 // le tour finit, chat_id attribué
    // ⚠ PORTÉE DE CE SCÉNARIO. Il vérifie le comportement VISIBLE (on peut
    //   dicter un second message après une réponse), pas le correctif interne
    //   du watcher ``currentChatId``. Le bouchon de capture continue de
    //   délivrer des trames après l'arrêt du micro, si bien que ce scénario
    //   passe avec ET sans le correctif — vérifié dans les deux sens le
    //   2026-09-22. Le correctif, lui, a été établi par une sonde séparée :
    //   sans lui, ``voiceState`` tombe à « arrete » dès que le serveur attribue
    //   son id au chat neuf.
    const etatVoix = await page.evaluate(() => {
        const p = document.querySelector('#app')._vnode.component.proxy;
        return p.voiceState;
    });
    ok('S12 état du micro après la réponse : ' + etatVoix, typeof etatVoix === 'string');
    const avant12 = (await appels()).transcribe.length;
    await dicteUnEnonce();
    await page.waitForTimeout(1500);
    const apres12 = (await appels()).transcribe.length;
    ok('S12 un second message se dicte encore', apres12 > avant12);
    ok('S12 le texte dicté arrive dans la zone de saisie',
       (await page.locator('#app textarea').first().inputValue()).trim().length > 0);
    await page.keyboard.press('Escape');

    // ════ S10 — TOUR OUTILLÉ, LECTURE ENTRE LES OUTILS COUPÉE ════════════
    // Dès qu'un outil est appelé, le front route TOUT le contenu vers le
    // tampon de pré-contenu. Réglage coupé : rien ne doit sortir pendant le
    // tour, et la réponse doit quand même être lue à la fin.
    await regle({ voice_stt: true, voice_tts: true, voice_input_enabled: false,
                  voice_reply_enabled: true, voice_reply_tools_enabled: false,
                  scenario: 'tools', max_utterance_sec: 30 });
    await gotoApp(page, '/');
    await envoie('Lance les tests.');
    await page.waitForTimeout(700);
    const pendantOutil = await appels();
    await page.waitForTimeout(2600);
    const apresOutil = await appels();
    ok('S10 réglage coupé : rien de lu pendant le tour outillé', pendantOutil.speak.length === 0);
    ok('S10 la réponse est lue à la fin', apresOutil.speak.length >= 1);
    ok('S10 la narration d\'étape n\'est pas prononcée séparément',
       apresOutil.speak.filter(function (x) { return x.text.indexOf('Je lance les tests') >= 0; }).length <= 1);

    // ════ S11 — TOUR OUTILLÉ, LECTURE ENTRE LES OUTILS ACTIVE ════════════
    await regle({ voice_stt: true, voice_tts: true, voice_input_enabled: false,
                  voice_reply_enabled: true, voice_reply_tools_enabled: true,
                  scenario: 'tools', max_utterance_sec: 30 });
    await gotoApp(page, '/');
    await envoie('Lance les tests.');
    await page.waitForTimeout(1400);
    const pendant11 = await appels();
    await page.waitForTimeout(2600);
    const fin11 = await appels();
    ok('S11 la narration est lue PENDANT le tour',
       pendant11.speak.some(function (x) { return x.text.indexOf('Je lance les tests') >= 0; }));
    ok('S11 la réponse finale est lue aussi',
       fin11.speak.some(function (x) { return x.text.indexOf('Première phrase') >= 0; }));
    // Le garde-fou qui compte : le serveur renvoie en 'final' le texte COMPLET,
    // narration comprise. Sans alignement par préfixe, tout serait relu.
    const compte11 = fin11.speak.filter(function (x) { return x.text.indexOf('Je lance les tests') >= 0; }).length;
    ok('S11 rien n\'est relu deux fois', compte11 === 1);

    // ════ Erreurs JS ═════════════════════════════════════════════════════
    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log(errors.slice(0, 5).join('\n'));

    await page.screenshot({ path: `${SHOTS}/voice-final.png`, fullPage: false });
} catch (e) {
    console.error('ÉCHEC DU HARNAIS :', e && e.message || e);
    checks.push(['FAIL', 'harnais : ' + (e && e.message || e)]);
    try { await page.screenshot({ path: `${SHOTS}/voice-crash.png` }); } catch (_) {}
} finally {
    await browser.close();
    const echecs = checks.filter((c) => c[0] === 'FAIL');
    console.log(`\nRÉSULTAT voice-verify : ${checks.length - echecs.length}/${checks.length}`);
    if (echecs.length) { echecs.forEach((c) => console.log('  FAIL ' + c[1])); process.exit(1); }
    process.exit(0);
}
