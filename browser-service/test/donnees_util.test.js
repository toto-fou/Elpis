// SPDX-License-Identifier: MIT
// browser-service/test/donnees_util.test.js — données du service central hors du code (monté dans les bacs) : dossier 0700, données d'avant reprises du dossier du code, fusion sans écraser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DOSSIERS_DONNEES, preparerDonnees } from '../donnees_util.js';

test('données reprises du dossier du code dans un dossier 0700, le code sans données ensuite', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'donnees-'));
    try {
        const code = path.join(t, 'browser-service');
        const donnees = path.join(t, 'user_db', 'browser');
        for (const d of ['cookies', 'har', 'screenshots']) fs.mkdirSync(path.join(code, d), { recursive: true });
        fs.writeFileSync(path.join(code, 'server.js'), '');
        fs.writeFileSync(path.join(code, 'cookies', 'state_a.json'), 'a');
        fs.writeFileSync(path.join(code, 'har', 'h.har'), 'h');
        // Déjà présent dans les données : gardé, la copie du code reste (signalée).
        fs.mkdirSync(path.join(donnees, 'screenshots'), { recursive: true });
        fs.writeFileSync(path.join(donnees, 'screenshots', 'x.png'), 'neuf');
        fs.writeFileSync(path.join(code, 'screenshots', 'x.png'), 'ancien');
        fs.writeFileSync(path.join(code, 'screenshots', 'y.png'), 'y');
        const notes = [];
        const repris = preparerDonnees(code, donnees, (m) => notes.push(m));
        assert.deepEqual(repris.sort(), ['cookies', 'har', 'screenshots']);
        assert.equal(fs.statSync(donnees).mode & 0o777, 0o700);
        assert.equal(fs.readFileSync(path.join(donnees, 'cookies', 'state_a.json'), 'utf8'), 'a');
        assert.equal(fs.readFileSync(path.join(donnees, 'har', 'h.har'), 'utf8'), 'h');
        assert.equal(fs.readFileSync(path.join(donnees, 'screenshots', 'x.png'), 'utf8'), 'neuf');
        assert.equal(fs.readFileSync(path.join(donnees, 'screenshots', 'y.png'), 'utf8'), 'y');
        assert.deepEqual(fs.readdirSync(code).sort(), ['screenshots', 'server.js']);
        assert.equal(notes.length, 1);
        assert.ok(DOSSIERS_DONNEES.includes('traces'));
        // Relancé : rien à reprendre de plus, droits remis.
        fs.chmodSync(donnees, 0o755);
        assert.deepEqual(preparerDonnees(code, donnees), ['screenshots']);
        assert.equal(fs.statSync(donnees).mode & 0o777, 0o700);
    } finally {
        fs.rmSync(t, { recursive: true, force: true });
    }
});

test('mode bac : données dans le dossier courant, rien à reprendre', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'donnees-'));
    try {
        fs.mkdirSync(path.join(t, 'cookies'));
        assert.deepEqual(preparerDonnees(t, t), []);
        assert.ok(fs.existsSync(path.join(t, 'cookies')));
    } finally {
        fs.rmSync(t, { recursive: true, force: true });
    }
});
