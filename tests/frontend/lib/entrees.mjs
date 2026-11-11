// SPDX-License-Identifier: MIT
// tests/frontend/lib/entrees.mjs — balises des entrées Vite (`<!-- @entree main -->`) pour les faux serveurs, comme apps/core/src/interface/pages.ts (prérequis : npm run build -w @elpis/web).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANIFESTE = fileURLToPath(new URL('../../../frontend/dist/.vite/manifest.json', import.meta.url));
const ENTREE = /<!--\s*@entree\s+(\S+)\s*-->/g;

function balises(manifeste, nom) {
    const entree = manifeste[`src/entries/${nom}.ts`];
    if (!entree) throw new Error(`entrée Vite absente du manifeste : ${nom} (npm run build -w @elpis/web)`);
    const css = new Set();
    const precharges = new Set();
    const vus = new Set();
    const visiter = (m) => {
        for (const f of m.css || []) css.add(f);
        for (const cle of m.imports || []) {
            if (vus.has(cle) || !manifeste[cle]) continue;
            vus.add(cle);
            precharges.add(manifeste[cle].file);
            visiter(manifeste[cle]);
        }
    };
    visiter(entree);
    return [
        ...[...css].map((f) => `<link rel="stylesheet" href="static/dist/${f}">`),
        ...[...precharges].map((f) => `<link rel="modulepreload" href="static/dist/${f}">`),
        `<script type="module" src="static/dist/${entree.file}"></script>`,
    ].join('\n');
}

/** Remplace chaque marqueur `@entree` par les balises du build ; échoue clairement si le frontend n'est pas construit. */
export function appliquerEntrees(html) {
    if (!/<!--\s*@entree\s/.test(html)) return html;
    if (!fs.existsSync(MANIFESTE)) throw new Error('frontend non construit : npm run build -w @elpis/web');
    const manifeste = JSON.parse(fs.readFileSync(MANIFESTE, 'utf8'));
    return html.replace(ENTREE, (_m, nom) => balises(manifeste, nom));
}
