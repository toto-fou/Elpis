// SPDX-License-Identifier: MIT
// Scénario (h) — détection de fuites mémoire par cycles répétés.
//
// Principe : on répète N fois un geste utilisateur qui doit revenir au MÊME
// état, et on regarde si quelque chose reste. Un geste idempotent qui laisse
// une trace mesurable à chaque passage, c'est une fuite ; le reste est du
// bruit d'allocation.
//
// Quatre grandeurs relevées après ramasse-miettes forcé (cf. releveMemoire) :
//   tasMo      — tas JS retenu
//   noeuds     — nœuds DOM vivants (les détachés retenus par une référence
//                comptent ici : c'est la signature du DOM fantôme)
//   listeners  — écouteurs JS vivants (compteur du moteur, pas le nôtre)
//   intervalsVifs / timeoutsVifs — timers créés et jamais annulés
//
// Le verdict se lit sur la PENTE de la seconde moitié (penteParCycle) : le
// début de session alloue légitimement (caches LRU de rendu, langages hljs),
// et une mesure de bout en bout diagnostiquerait une fuite à chaque campagne.
//
// Le solde pose/retrait par (cible, événement) nomme le coupable quand la
// pente est positive : les compteurs du moteur disent QU'on fuit, `lis` dit OÙ.
//
// ⚠ `tasMo` est la grandeur la MOINS fiable des cinq, et il ne faut pas la lire
// seule. Le collecteur lui-même alimente le tas pendant la campagne : les
// PerformanceObserver retiennent leurs entrées (LayoutShift, DOMRectReadOnly,
// PerformanceResourceTiming — mesuré à ~2,9 Ko par cycle de génération), et V8
// continue de compiler du code au fil des tours. Une pente de tas sans pente de
// nœuds ni d'écouteurs ne prouve donc RIEN. Ce sont les compteurs entiers
// (nœuds, écouteurs, timers) qui tranchent : eux ne bougent pas pour rien.
import {
    launch, gotoApp, wrapLibs, configureServer, sendAndWaitStream,
    releveMemoire, penteParCycle, listenersOrphelins, observateursOrphelins,
} from '../lib/harness.mjs';

const GESTES = {
    // TÉMOIN — fuite délibérée et calibrée. Un détecteur qui ne trouve rien
    // n'a de valeur que s'il est capable de trouver quelque chose : ce mode
    // pose à chaque cycle 99 nœuds détachés mais retenus, un écouteur global
    // et un intervalle. Si la campagne le rate, ce sont les VERDICTS des
    // autres modes qui sont faux, pas l'application qui est saine.
    async temoin(page) {
        await page.evaluate(() => {
            const w = window;
            w.__fuiteTemoin = w.__fuiteTemoin || { retenu: [], n: 0 };
            const d = document.createElement('div');
            d.innerHTML = '<span>x</span>'.repeat(49);   // 1 + 49 + 49 = 99 nœuds
            w.__fuiteTemoin.retenu.push(d);              // détaché mais RETENU
            w.addEventListener('resize', function ecouteurTemoin() { w.__fuiteTemoin.n++; });
            setInterval(() => { w.__fuiteTemoin.n++; }, 60000);
        });
        await page.waitForTimeout(150);
    },
    // CONTRÔLE NÉGATIF — un cycle qui ne fait rien. Donne le PLANCHER de
    // l'instrument : ce que la seule mesure fait bouger (relevés CDP, GC,
    // parcours de l'arbre). Toute pente inférieure ou égale à celle-ci n'est
    // pas une fuite de l'application, quelle que soit sa régularité.
    async repos(page) {
        await page.waitForTimeout(1500);
    },
    // CONTRÔLE DE SAISIE — le piège qui a failli produire un faux verdict.
    // Écrire dans le composeur, SANS rien envoyer, fait monter le compteur de
    // nœuds de +1 à chaque frappe : c'est la comptabilité du navigateur autour
    // du shadow DOM du placeholder d'un <textarea>, pas l'application.
    // Tout geste qui passe par le composeur hérite donc d'une pente de +1/cycle
    // qu'il ne faut PAS lui imputer — d'où ce mode, à comparer à `stream`.
    async saisie(page) {
        const ta = page.locator('textarea[placeholder]').last();
        await ta.fill('');
        await ta.fill('contrôle de saisie');
        await page.waitForTimeout(150);
    },
    // Alternance de conversations : c'est le geste le plus courant d'une
    // session longue, et celui qui remonte/démonte le plus de DOM.
    async chats(page) {
        for (const titre of ['Chat long 40 messages', 'Chat long 100 messages']) {
            await page.locator(`text=${titre}`).first().click();
            await page.waitForTimeout(900);
        }
    },
    // Modale Paramètres + repli du panneau : montage/démontage de composants
    // avec écouteurs globaux (Escape, clic extérieur, redimensionnement).
    async modals(page) {
        const vis = (sel) => page.locator(sel).locator('visible=true').first();
        await vis('button[title="Paramètres"]').click();
        await page.waitForTimeout(700);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await vis('button[title="Réduire le panneau"]').click();
        await page.waitForTimeout(500);
        await vis('button[title="Ouvrir le panneau"]').click();
        await page.waitForTimeout(500);
    },
    // Un tour de génération complet, puis retour à un chat neuf : le chemin
    // qu'une journée de travail répète des dizaines de fois.
    async stream(page) {
        await sendAndWaitStream(page, 'Mesure de fuite : réponds normalement.');
        await page.waitForTimeout(400);
        const neuf = page.locator('button[title^="Nouveau chat"]').locator('visible=true').first();
        if (await neuf.count()) { await neuf.click(); await page.waitForTimeout(500); }
    },
};

export async function run({ reducedMotion = 'reduce', cpuRate = 1,
                            mode = 'chats', cycles = 12 } = {}) {
    const geste = GESTES[mode];
    if (!geste) throw new Error(`mode inconnu : ${mode}`);
    await configureServer({
        reply: 'short', toks: 60,
        chat: 'long40', chats: ['long40', 'long100'],
    });
    const h = await launch({ reducedMotion, cpuRate });
    try {
        await gotoApp(h.page);
        await wrapLibs(h.page);

        // Deux tours à blanc : ils paient les caches (rendu markdown, hljs,
        // fixtures) sans être comptés. Le relevé 0 est donc déjà en régime.
        for (let i = 0; i < 2; i++) await geste(h.page);
        const releves = [await releveMemoire(h.page, h.cdp)];
        const dureesMs = [];

        for (let i = 0; i < cycles; i++) {
            const t0 = Date.now();
            await geste(h.page);
            dureesMs.push(Date.now() - t0);
            releves.push(await releveMemoire(h.page, h.cdp));
        }

        const serie = (cle) => penteParCycle(releves.map((r) => r[cle]));
        const dernier = releves[releves.length - 1];
        return {
            mode, cycles,
            pentes: {
                tasMo: serie('tasMo'),
                noeuds: serie('noeuds'),
                noeudsAttaches: serie('noeudsAttaches'),
                noeudsDetaches: serie('noeudsDetaches'),
                listeners: serie('listeners'),
                intervalsVifs: serie('intervalsVifs'),
                timeoutsVifs: serie('timeoutsVifs'),
            },
            dureeCycleMs: { premier: dureesMs[0], dernier: dureesMs[dureesMs.length - 1],
                            median: [...dureesMs].sort((a, b) => a - b)[dureesMs.length >> 1] },
            listenersOrphelins: listenersOrphelins(dernier._leak).slice(0, 15),
            observateursOrphelins: observateursOrphelins(dernier._leak),
            fluxOuverts: { es: dernier._leak.es, ws: dernier._leak.ws },
            releves: releves.map(({ _leak, ...r }) => r),
            errors: h.errors,
        };
    } finally {
        await h.browser.close();
    }
}
