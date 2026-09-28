// SPDX-License-Identifier: MIT
// La virtualisation doit rendre le streaming INDÉPENDANT de la longueur de la
// conversation.
//
//   node tests/perf/perf-server.mjs &          (port 8901, ou PERF_PORT)
//   node tests/frontend/stream-scale-verify.mjs
//
// Compte ~5 minutes : quatre streams complets, entrelacés.
//
// Pourquoi ce test
// ================
// C'est la promesse que `_virtual_scroll.js` existe pour tenir, et rien ne la
// vérifiait. Trois façons de la casser sans que personne ne le voie :
//   • un `_vsEnsureTail` mal borné qui rend toute la conversation ;
//   • une dépendance du `v-memo` des lignes qui change à chaque token, ce qui
//     re-rendrait les ~30 lignes visibles 25 fois par seconde ;
//   • un `computed` qui reparcourt `messages.value` entier par flush.
// Chacune rendrait le streaming proportionnel à l'historique. Le symptôme
// n'apparaîtrait que chez un utilisateur ayant une longue conversation.
//
// Ce qui fait verdict
// ===================
// 1. Le NOMBRE DE LIGNES rendues, borné quelle que soit la taille du chat.
//    C'est l'assertion crispe : déterministe, insensible à la charge machine.
// 2. Les totaux CDP (layout, script, tâches), avec des seuils larges — ils
//    servent à attraper une régression d'un ordre de grandeur, pas à mesurer
//    finement. ⚠ Le TBT est volontairement HORS verdict : sur ces courses il
//    varie de 363 à 2307 ms pour une charge identique.
//
// Référence (2026-08-15, machine au repos, CPU ×4) : 30 lignes rendues à 40,
// 100 et 400 messages ; layout 1,84 / 1,84 / 2,04 s ; tâches 23,8 / 22,8 / 23,2 s.
import { run } from '../perf/scenarios/j_stream_scale.mjs';

// VS_BUFFER * 3 = 30 lignes forcées en queue pendant un stream, plus une marge
// pour un viewport inhabituellement grand. Au-delà, la fenêtre n'est plus bornée.
const LIGNES_MAX = 45;
// Larges à dessein : perdre la virtualisation multiplierait ces coûts par un
// ordre de grandeur (400 messages contre 40), pas de 60 %.
const RATIO_MAX = { layout: 1.8, script: 1.8, taches: 1.6 };

const checks = [];
const ok = (n, c, detail = '') => {
    checks.push([c ? 'PASS' : 'FAIL', n]);
    if (!c) console.log('  ✗ ' + n + (detail ? '  — ' + detail : ''));
};

const r = await run({ runs: 2 });

console.log('conversation   lignes   layout   script   tâches    fps  perdues   TBT');
for (const [chat, v] of Object.entries(r.resume)) {
    console.log(`${chat.padEnd(13)} ${String(v.lignesMax).padStart(5)}  `
        + `${String(v.layout).padStart(7)}s ${String(v.script).padStart(7)}s `
        + `${String(v.taches).padStart(7)}s ${String(v.fps).padStart(6)} `
        + `${String(v.perdues).padStart(7)}  ${v.tbt.join('/')}`);
}
console.log('ratios grande/petite :', JSON.stringify(r.ratios), '\n');

ok(`la fenêtre rendue reste bornée (${r.lignesMax} ≤ ${LIGNES_MAX} lignes)`,
   r.lignesMax > 0 && r.lignesMax <= LIGNES_MAX, `mesuré ${r.lignesMax}`);
for (const [k, seuil] of Object.entries(RATIO_MAX)) {
    ok(`${k} : la conversation longue ne coûte pas plus de ×${seuil}`,
       r.ratios[k] <= seuil, `ratio ${r.ratios[k]}`);
}
ok('aucune erreur de page pendant les streams', r.errors.length === 0,
   r.errors.slice(0, 2).join(' | '));

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(fails.length ? 1 : 0);
