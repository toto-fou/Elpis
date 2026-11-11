// SPDX-License-Identifier: MIT
// Scénario (j) — le coût d'un streaming ne doit pas dépendre de la LONGUEUR
// de la conversation.
//
// C'est l'invariant que la virtualisation existe pour tenir, et rien ne le
// vérifiait. Un `_vsEnsureTail` mal borné, un `v-memo` dont une dépendance
// change à chaque token, un `computed` qui repasse sur `messages.value`
// entier : chacun rendrait le streaming proportionnel à l'historique, et
// personne ne s'en apercevrait avant qu'un utilisateur ait une conversation
// de 400 messages.
//
// Ce qu'on relève, pour le MÊME flux, dans des conversations de tailles
// différentes : le nombre de lignes réellement rendues (la grandeur que la
// virtualisation borne) et le temps de mise en page, de script et de tâches.
//
// Mesuré le 2026-08-15, machine au repos, CPU ×4 :
//
//     conversation   lignes   layout   script   tâches   fps
//     40 messages       30     1,84 s   1,54 s   23,8 s   53
//     100 messages      30     1,84 s   1,55 s   22,8 s   55
//     400 messages      30     2,04 s   1,64 s   23,2 s   54
//
// ⚠ Le TBT n'entre PAS dans le verdict : sur ces courses il varie de 363 à
// 2307 ms d'un run à l'autre pour une charge identique. Ce sont les totaux
// CDP (layout, script, tâches) et le nombre de lignes qui sont stables.
import { launch, gotoApp, wrapLibs, configureServer, sendAndWaitStream,
         startWindow, stopWindow } from '../lib/harness.mjs';

export const TAILLES = ['long40', 'long400'];

export async function mesureUne({ chat = 'long40', reducedMotion = 'reduce',
                                  cpuRate = 4, toks = 60 } = {}) {
    const h = await launch({ reducedMotion, cpuRate });
    try {
        await configureServer({ reply: 'code200', toks, chat });
        await gotoApp(h.page);
        await wrapLibs(h.page);
        await h.page.locator('text=Chat long ' + chat.replace('long', '') + ' messages')
            .first().click();
        await h.page.waitForTimeout(2500);

        const win = await startWindow(h.page, h.cdp, { frames: true });
        // Le nombre de lignes est échantillonné DANS la page : un aller-retour
        // CDP par mesure coûterait plus cher que ce qu'on mesure.
        await h.page.evaluate(() => {
            window.__lignes = [];
            window.__lignesTimer = setInterval(
                () => window.__lignes.push(document.querySelectorAll('[data-vs-idx]').length), 500);
        });
        await sendAndWaitStream(h.page, 'Continue l\'analyse avec un exemple complet en Python.');
        const lignes = await h.page.evaluate(() => {
            clearInterval(window.__lignesTimer);
            return window.__lignes;
        });
        const s = await stopWindow(h.page, h.cdp, win);
        return {
            chat,
            lignesMax: lignes.length ? Math.max(...lignes) : 0,
            lignesMed: lignes.length ? [...lignes].sort((a, b) => a - b)[lignes.length >> 1] : 0,
            layout: s.cdp.LayoutDuration, style: s.cdp.RecalcStyleDuration,
            script: s.cdp.ScriptDuration, taches: s.cdp.TaskDuration,
            tbt: s.longTasks.tbtMs, fps: (s.fps && s.fps.mean) || 0,
            perdues: (s.fps && s.fps.droppedPct) || 0,
            dureeMs: s.durationMs, errors: h.errors,
        };
    } finally {
        await h.browser.close();
    }
}

export async function run({ reducedMotion = 'reduce', cpuRate = 4, toks = 60,
                            runs = 2, tailles = TAILLES } = {}) {
    const par = {};
    // Entrelacé : une taille après l'autre, plusieurs tours. Enchaîner tous les
    // runs d'une taille puis ceux de l'autre laisserait une dérive de la
    // machine se faire passer pour un effet de la taille.
    for (let i = 0; i < runs; i++) {
        for (const chat of tailles) {
            (par[chat] = par[chat] || []).push(await mesureUne({ chat, reducedMotion, cpuRate, toks }));
        }
    }
    const med = (v, k) => {
        const s = v.map((x) => x[k]).sort((a, b) => a - b);
        return s[s.length >> 1];
    };
    const resume = Object.fromEntries(Object.entries(par).map(([chat, v]) => [chat, {
        lignesMax: Math.max(...v.map((x) => x.lignesMax)),
        layout: med(v, 'layout'), script: med(v, 'script'), taches: med(v, 'taches'),
        fps: med(v, 'fps'), perdues: med(v, 'perdues'), tbt: v.map((x) => x.tbt),
    }]));
    const [petite, grande] = [tailles[0], tailles[tailles.length - 1]];
    const ratio = (k) => Math.round(resume[grande][k] / (resume[petite][k] || 1) * 100) / 100;
    return {
        resume,
        ratios: { layout: ratio('layout'), script: ratio('script'), taches: ratio('taches') },
        lignesMax: Math.max(...Object.values(resume).map((r) => r.lignesMax)),
        errors: Object.values(par).flat().flatMap((x) => x.errors),
    };
}
