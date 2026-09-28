// SPDX-License-Identifier: MIT
// Harnais de vérification VISUELLE des onglets du panneau terminal
// (refonte « style navigateur », 2026-08-08).
//
// Il sert une page minimale qui charge la VRAIE feuille de style de l'app
// (/static/css/style.css) et rend le MÊME balisage que
// frontend/includes/main/editor.html : classes .term-tabstrip / .term-tab /
// .term-tab-dot / .term-tab-close, posées sur une surface de la couleur du
// panneau terminal. On vérifie ainsi la géométrie réelle produite par le CSS
// (raccords à rayon inversé, fusion de l'onglet actif avec la surface) sans
// démarrer le backend ni Monaco.
//
// Lancement : PERF_PORT=8931 node tests/frontend/termtabs-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8931);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

// Onglets de démonstration : un par état de connexion possible, pour que la
// pastille soit vérifiable état par état.
const SESSIONS = [
    { id: 't_a', name: 'Terminal 1', state: 'open' },
    { id: 't_b', name: 'build',      state: 'reconnecting' },
    { id: 't_c', name: 'logs',       state: 'idle' },
    { id: 't_d', name: 'Terminal 4', state: 'closed' },
];

const PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>termtabs</title>
<!-- Tailwind AVANT style.css, comme dans index.html : la barre d'onglets
     s'appuie sur ses utilitaires de layout (flex/items-end/gap). Sans lui,
     les onglets s'empilent verticalement et la vérification de géométrie ne
     testerait pas le rendu réel. -->
<script src="/static/vendor/tailwind.js"></script>
<link rel="stylesheet" href="/static/vendor/src/regular/style.css">
<link rel="stylesheet" href="/static/css/style.css">
<style>
  /* Reproduit le contexte réel : panneau terminal sombre dans l'éditeur. */
  body { margin: 0; background: #181818; font-family: system-ui, sans-serif; }
  #panel { width: 900px; margin: 40px auto; background: #1e1e1e;
           border-radius: 0 8px 0 0; overflow: hidden; }
  #surface { height: 160px; background: #1e1e1e; color: #d4d4d4;
             font: 12px/1.5 monospace; padding: 8px 12px; }
  .no-scrollbar::-webkit-scrollbar { display: none; }
</style></head>
<body>
<div id="app">
  <div id="panel">
    <!-- ⚠ Doit rester le MÊME balisage que editor.html (mêmes classes). -->
    <div class="term-tabstrip flex items-end shrink-0 min-h-[30px] pt-1">
      <div class="flex items-end gap-0.5 flex-1 min-w-0 overflow-x-auto no-scrollbar px-2">
        <i class="ph ph-terminal-window text-green-400 text-xs shrink-0 mr-1 mb-1.5"></i>
        <div v-for="s in sessions" :key="s.id"
             :data-sid="s.id"
             @click="active = s.id"
             class="term-tab"
             :class="{ 'is-active': active === s.id }">
          <span class="term-tab-dot" :class="'is-' + s.state"></span>
          <span class="truncate">{{ s.name }}</span>
          <button class="term-tab-close" title="Fermer ce terminal">✕</button>
        </div>
        <button class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 shrink-0 ml-1 mb-0.5">+</button>
        <span class="text-[9px] font-mono text-amber-400/80 shrink-0 ml-1 mb-1.5 tabular-nums">{{ sessions.length }}/4</span>
      </div>
      <button class="text-slate-500 px-2 mb-1 rounded shrink-0">✕</button>
    </div>
    <div id="surface">mcp@sandbox:/work$ npm run build</div>
  </div>
</div>
<script src="/static/vendor/vue.global.prod.js"></script>
<script>
  const { createApp, ref } = Vue;
  createApp({
    setup() {
      return { sessions: ref(${JSON.stringify(SESSIONS)}), active: ref('t_a') };
    }
  }).mount('#app');
</script>
</body></html>`;

http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        return res.end(PAGE);
    }
    if (url === '/__sessions') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(SESSIONS));
    }
    if (url.startsWith('/static/')) {
        const f = path.join(ROOT, url.slice('/static/'.length));
        if (fs.existsSync(f) && fs.statSync(f).isFile()) {
            res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream');
            return res.end(fs.readFileSync(f));
        }
    }
    res.statusCode = 404;
    res.end('not found');
}).listen(PORT, '127.0.0.1', () => {
    console.log('[termtabs-server] http://127.0.0.1:' + PORT);
});
