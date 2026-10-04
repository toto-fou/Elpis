// SPDX-License-Identifier: MIT
// llm_core/tools/_office/echarts_ssr.cjs — rendu des graphiques côté serveur.
//
// Entrée (stdin)  : JSON [{option, width, height}, …] — options telles que
//                   stockées par les outils chart_* (jetons « @nom », _elpis…).
// Sortie (stdout) : JSON [{svg} | {error}, …], dans le même ordre.
//
// Jetons, thème et formateurs viennent de frontend/js/chat/_charts.js : le
// graphique d'un document est celui du chat (thème clair, sans animation).
'use strict';

const path = require('path');
const root = path.resolve(__dirname, '..', '..', '..');
const echarts = require(path.join(root, 'frontend', 'vendor', 'echarts.min.js'));
const charts = require(path.join(root, 'frontend', 'js', 'chat', '_charts.js'));

// Police sans guillemets : le SVG de rendu serveur ne les échappe pas dans
// l'attribut style (XML invalide, refusé par LibreOffice).
const FONT = 'Segoe UI, Liberation Sans, DejaVu Sans, Arial, sans-serif';
const theme = charts.themeObject(charts.TOKENS.light);
theme.textStyle = Object.assign({}, theme.textStyle, { fontFamily: FONT });
echarts.registerTheme('elpis-light', theme);

function renderOne(job) {
    const raw = job.option || {};
    const el = raw._elpis || {};
    // 640 px de large pour ~16 cm : le texte garde une taille lisible une
    // fois l'image posée dans la page (8 à 9 pt).
    const width = job.width || 640;
    const height = job.height || Math.round(width * (charts.HEIGHT[el.kind] || 360) / 640);
    const chart = echarts.init(null, 'elpis-light', { renderer: 'svg', ssr: true, width, height });
    try {
        const o = charts.prepare(raw, {});
        o.animation = false;
        delete o.dataZoom;                 // pas de curseur de zoom sur une image
        if (o.toolbox) delete o.toolbox;
        // Fond blanc explicite : une image collée dans Word n'a pas de surface.
        o.backgroundColor = charts.TOKENS.light.surface;
        chart.setOption(o);
        return { svg: chart.renderToSVGString() };
    } catch (e) {
        return { error: String((e && e.message) || e) };
    } finally {
        chart.dispose();
    }
}

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
    finir(JSON.stringify(jobs.map(renderOne)), 0);
});
