// SPDX-License-Identifier: MIT
// llm_core/tools/_office/echarts_ssr.cjs — rendu des graphiques côté serveur.
//
// Entrée (stdin)  : JSON [{option, width, height}, …] — options telles que
//                   stockées par les outils chart_* (jetons « @nom », _elpis…).
// Sortie (stdout) : JSON [{svg} | {error}, …], dans le même ordre.
//
// Jetons, thème et formateurs viennent du bundle `frontend/dist/echarts-ssr.cjs`
// (construit avec le frontend, présent aussi dans la release : web/ = frontend/dist) :
// le graphique d'un document est celui du chat (thème clair, sans animation).
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..', '..');
const bundle = process.env.ELPIS_ECHARTS_SSR || path.join(root, 'frontend', 'dist', 'echarts-ssr.cjs');
if (!fs.existsSync(bundle)) {
    process.stderr.write('echarts_ssr: bundle introuvable (' + bundle + ') — construire le frontend (npm run build -w @elpis/web)\n');
    process.exit(3);
}
const { renderOne } = require(bundle);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
// zrender garde des minuteries : on sort explicitement, mais SEULEMENT une
// fois la sortie vidée — vers un tube, ``write`` est asynchrone et un
// ``exit`` immédiat la couperait (64 Kio), donc tout graphique un peu riche.
function finir(texte, code) {
    process.stdout.write(texte, () => process.exit(code));
}

process.stdin.on('end', () => {
    let jobs;
    try { jobs = JSON.parse(input || '[]'); } catch (e) {
        finir(JSON.stringify({ error: 'bad input: ' + e.message }), 2);
        return;
    }
    finir(JSON.stringify(jobs.map((j) => renderOne(j))), 0);
});
