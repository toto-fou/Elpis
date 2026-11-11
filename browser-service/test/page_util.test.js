// SPDX-License-Identifier: MIT
// browser-service/test/page_util.test.js — zones modifiées d'un diff visuel (fonction exécutée dans la page, rejouée ici sans navigateur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionsModifiees, sourceDe } from '../page_util.js';

// Grille de cellules : `marques` = [[col, ligne, pixels]], chaque cellule marquée couvrant ses 16 × 16 px.
function grille(cols, rows, marques) {
    const n = cols * rows;
    const t = { compte: new Uint32Array(n), x0: new Uint32Array(n), y0: new Uint32Array(n), x1: new Uint32Array(n), y1: new Uint32Array(n) };
    for (const [c, r, p] of marques) {
        const k = r * cols + c;
        t.compte[k] = p; t.x0[k] = c * 16; t.y0[k] = r * 16; t.x1[k] = c * 16 + 15; t.y1[k] = r * 16 + 15;
    }
    return t;
}

test('regionsModifiees : zones séparées, voisinage diagonal fusionné, plus grosses d\'abord, plafond et boîte de l\'ensemble', () => {
    const g = grille(10, 10, [[0, 0, 5], [1, 1, 5], [8, 8, 40], [5, 0, 1]]);
    const r = regionsModifiees(10, 10, g.compte, g.x0, g.y0, g.x1, g.y1, 10);
    assert.equal(r.total, 3);
    assert.deepEqual(r.regions, [
        { x: 128, y: 128, w: 16, h: 16, pixels: 40 },
        { x: 0, y: 0, w: 32, h: 32, pixels: 10 },
        { x: 80, y: 0, w: 16, h: 16, pixels: 1 },
    ]);
    assert.deepEqual(r.bbox, { x: 0, y: 0, w: 144, h: 144 });
    const borne = regionsModifiees(10, 10, g.compte, g.x0, g.y0, g.x1, g.y1, 1);
    assert.equal(borne.regions.length, 1);
    assert.equal(borne.total, 3);
    assert.deepEqual(borne.bbox, r.bbox);
    const vide = grille(3, 3, []);
    assert.deepEqual(regionsModifiees(3, 3, vide.compte, vide.x0, vide.y0, vide.x1, vide.y1, 10), { regions: [], total: 0, bbox: null });
});

test('regionsModifiees reconstruite depuis sa source (comme dans la page) donne le même résultat', () => {
    const g = grille(4, 4, [[0, 0, 2], [3, 3, 7]]);
    const refaite = new Function(`return (${sourceDe(regionsModifiees)})`)();
    assert.deepEqual(refaite(4, 4, g.compte, g.x0, g.y0, g.x1, g.y1, 10), regionsModifiees(4, 4, g.compte, g.x0, g.y0, g.x1, g.y1, 10));
});
